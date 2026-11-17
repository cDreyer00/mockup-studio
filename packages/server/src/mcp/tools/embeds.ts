import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  DEFAULT_THREE_CODE,
  EmbedSpecSchema,
  MAX_THREE_CODE,
  VideoSpecSchema,
  createEmbedNode,
  createVideoNode,
  detectEmbedProvider,
  mediaRefProblem,
  youtubeId,
  youtubeStart,
  type EmbedProvider,
  type EmbedSpec,
  type MediaParamValue,
  type VideoSpec,
} from '@mockup/core';
import { detectImage, fetchBytes, writeAsset } from '../../assets.js';
import { MAX_ANIMATION_BYTES, MAX_VIDEO_BYTES, sanitizeAssetName } from '../../http.js';
import { ToolError, WRITE, docIdField, type ToolContext } from '../context.js';
import { MAX_DATA_URL_BYTES, loadSource } from './images.js';

const kb = (n: number): string => `${Math.max(1, Math.round(n / 1024))} KB`;
const isUrl = (s: string): boolean => /^https?:\/\//i.test(s);

const paramsField = z
  .record(z.string(), z.union([z.number(), z.boolean(), z.string()]))
  .optional()
  .describe('Parâmetros (número, texto ou booleano), ex.: { "color": "#ff0066" }.');

const stylesField = z
  .record(z.string(), z.string())
  .optional()
  .describe('Estilos CSS, ex.: { "width": "640px", "border-radius": "12px" }.');

const indexField = z
  .number()
  .int()
  .min(0)
  .optional()
  .describe('Posição entre os filhos, ex.: 0 (padrão: final).');

type VideoKind = { ext: '.mp4' | '.m4v' | '.mov' | '.webm' | '.ogv'; mime: string };

/** Detecta vídeo pelos primeiros bytes: mp4/m4v/mov (ftyp), webm/mkv (EBML) e ogg. */
export function detectVideo(head: Buffer): VideoKind | null {
  if (head.length >= 12 && head.toString('ascii', 4, 8) === 'ftyp') {
    const brand = head.toString('ascii', 8, 12);
    if (/^(avif|avis|heic|heix|hevc|mif1|msf1)/.test(brand)) return null;
    if (brand === 'qt  ') return { ext: '.mov', mime: 'video/quicktime' };
    if (brand === 'M4V ' || brand === 'M4VH' || brand === 'M4VP')
      return { ext: '.m4v', mime: 'video/x-m4v' };
    return { ext: '.mp4', mime: 'video/mp4' };
  }
  if (
    head.length >= 4 &&
    head[0] === 0x1a &&
    head[1] === 0x45 &&
    head[2] === 0xdf &&
    head[3] === 0xa3
  )
    return { ext: '.webm', mime: 'video/webm' };
  if (head.length >= 4 && head.toString('ascii', 0, 4) === 'OggS')
    return { ext: '.ogv', mime: 'video/ogg' };
  return null;
}

/** Valida um arquivo Lottie (JSON com v, fr, layers, ou .lottie zip). */
export function lottieKind(bytes: Buffer): '.json' | '.lottie' | string {
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b) return '.lottie';
  let json: unknown;
  try {
    json = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
  } catch {
    return 'O arquivo não é um JSON válido de Lottie.';
  }
  const o = json as Record<string, unknown> | null;
  if (!o || typeof o !== 'object' || !('v' in o) || !('fr' in o) || !Array.isArray(o['layers']))
    return 'O JSON não parece uma animação Lottie (esperado: campos "v", "fr" e "layers").';
  return '.json';
}

/** Grava `src` em `dir/name` sem sobrescrever (copiando em disco, sem carregar o arquivo). */
async function copyUnique(dir: string, name: string, src: string): Promise<string> {
  await fs.promises.mkdir(dir, { recursive: true });
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  for (let i = 0; i < 1000; i++) {
    const finalName = i === 0 ? name : `${base}-${i}${ext}`;
    try {
      await fs.promises.copyFile(src, path.join(dir, finalName), fs.constants.COPYFILE_EXCL);
      return finalName;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
  }
  throw new Error(`Não foi possível copiar para ${dir}: nomes esgotados.`);
}

async function readHead(file: string, n: number): Promise<Buffer> {
  const fh = await fs.promises.open(file, 'r');
  try {
    const buf = Buffer.alloc(n);
    const { bytesRead } = await fh.read(buf, 0, n, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

async function statFile(file: string, max: number, what: string): Promise<fs.Stats> {
  let st: fs.Stats;
  try {
    st = await fs.promises.stat(file);
  } catch {
    throw new ToolError(`Arquivo não encontrado: ${file}`);
  }
  if (!st.isFile()) throw new ToolError(`"${file}" não é um arquivo.`);
  if (st.size > max)
    throw new ToolError(`${what} passa do limite de ${Math.round(max / 1024 / 1024)} MB.`);
  return st;
}

export function registerEmbedTools(ctx: ToolContext): void {
  const { tool, store, requireNode, apply, summaryOf } = ctx;

  const needAssets = (id: string, what: string): string => {
    const dir = store.assetsDir(id);
    if (!dir)
      throw new ToolError(
        `O documento ainda não tem caminho em disco, então não há pasta assets/ para guardar ${what}. Salve o documento (create_document ou Salvar como) e tente de novo.`,
      );
    return dir;
  };

  /** Vídeo: caminho local (copiado para assets/videos/) ou URL http(s) (referenciada direto). */
  const importVideo = async (
    id: string,
    source: string,
  ): Promise<{ src: string; note: string }> => {
    const s = source.trim();
    if (isUrl(s)) {
      const problem = mediaRefProblem(s);
      if (problem) throw new ToolError(`URL de vídeo inválida: ${problem}.`);
      return { src: s, note: 'URL referenciada direto (o vídeo só toca com rede)' };
    }
    if (!path.isAbsolute(s))
      throw new ToolError(
        `source deve ser um caminho absoluto ou URL http(s) do vídeo; recebido "${s}".`,
      );
    const st = await statFile(s, MAX_VIDEO_BYTES, 'O vídeo');
    const kind = detectVideo(await readHead(s, 16));
    if (!kind)
      throw new ToolError(
        'O arquivo não é um vídeo reconhecido (mp4, m4v, mov, webm ou ogg). Confira o arquivo.',
      );
    const assets = needAssets(id, 'o vídeo');
    const stem = path.basename(s).replace(/\.[^.]*$/, '') || 'video';
    const safe = sanitizeAssetName(`${stem}${kind.ext}`);
    const file = await copyUnique(path.join(assets, 'videos'), `${safe.base}${safe.ext}`, s);
    return { src: `videos/${file}`, note: `copiado para assets/videos/${file} (${kb(st.size)})` };
  };

  /** Imagem de poster: copia para assets/ (ou data URL de até 2 MB sem pasta de assets). */
  const importPoster = async (id: string, source: string): Promise<string> => {
    const { bytes, hint } = await loadSource(source);
    const info = detectImage(bytes);
    if (!info || info.ext === '.svg')
      throw new ToolError('O poster deve ser uma imagem PNG, JPEG, GIF, WebP ou AVIF.');
    const assets = store.assetsDir(id);
    if (assets) {
      const stem = hint.replace(/\.[^.]*$/, '') || 'poster';
      const safe = sanitizeAssetName(`${stem}${info.ext}`);
      return await writeAsset(assets, `${safe.base}${safe.ext}`, bytes);
    }
    if (bytes.length > MAX_DATA_URL_BYTES)
      throw new ToolError(
        'O documento ainda não tem caminho em disco e o poster passa de 2 MB para embutir. Salve o documento e tente de novo.',
      );
    return `data:${info.mime};base64,${bytes.toString('base64')}`;
  };

  /** Lottie/Rive: copia/baixa para assets/lottie ou assets/rive depois de validar o conteúdo. */
  const importAnimation = async (
    id: string,
    provider: 'lottie' | 'rive',
    source: string,
  ): Promise<{ src: string; note: string }> => {
    const s = source.trim();
    const dir = provider;
    // referência já relativa a assets/ (ex.: "lottie/loader.json")
    if (!isUrl(s) && !path.isAbsolute(s)) {
      const problem = mediaRefProblem(s);
      const assets = store.assetsDir(id);
      if (problem || !assets || !fs.existsSync(path.join(assets, s)))
        throw new ToolError(
          `"${s}" não é um caminho absoluto, uma URL http(s) nem um arquivo existente em assets/. Passe o caminho absoluto do arquivo ${provider === 'rive' ? '.riv' : '.json/.lottie'}.`,
        );
      return { src: s, note: `arquivo existente assets/${s}` };
    }
    let bytes: Buffer;
    let hint: string;
    if (isUrl(s)) {
      try {
        const r = await fetchBytes(s, { maxBytes: MAX_ANIMATION_BYTES, timeoutMs: 20_000 });
        bytes = r.bytes;
        hint = path.basename(new URL(r.finalUrl).pathname) || provider;
      } catch (e) {
        throw new ToolError(e instanceof Error ? e.message : String(e));
      }
    } else {
      await statFile(s, MAX_ANIMATION_BYTES, 'O arquivo');
      bytes = await fs.promises.readFile(s);
      hint = path.basename(s);
    }
    let ext: string;
    if (provider === 'rive') {
      if (bytes.toString('ascii', 0, 4) !== 'RIVE')
        throw new ToolError(
          'O arquivo não é um Rive válido (deve começar com "RIVE"). Use um .riv exportado do Rive.',
        );
      ext = '.riv';
    } else {
      const k = lottieKind(bytes);
      if (k !== '.json' && k !== '.lottie') throw new ToolError(k);
      ext = k;
    }
    const assets = needAssets(id, provider === 'rive' ? 'a animação Rive' : 'a animação Lottie');
    const stem = hint.replace(/\.[^.]*$/, '') || provider;
    const safe = sanitizeAssetName(`${stem}${ext}`);
    const file = await writeAsset(path.join(assets, dir), `${safe.base}${safe.ext}`, bytes);
    return { src: `${dir}/${file}`, note: `salvo em assets/${dir}/${file} (${kb(bytes.length)})` };
  };

  tool(
    'insert_video',
    {
      title: 'Inserir vídeo',
      description:
        'Insere um vídeo (nó video) em parentId. source: caminho absoluto (mp4, m4v, mov, webm ou ogg, até 500 MB; validado pelos bytes e copiado para assets/videos/) ou URL http(s) (referenciada direto, sem baixar: só toca com rede). Documento sem caminho em disco exige URL. poster: imagem (caminho, URL ou data URL) mostrada antes de tocar e no get_screenshot sem time. Padrões: muted, loop e autoplay ligados, controls desligado, 640x360 object-fit cover.',
      example: {
        parentId: 'fr_ab12cd34',
        source: 'C:/videos/demo.mp4',
        poster: 'C:/videos/demo.png',
        styles: { width: '480px', height: '270px' },
      },
      inputSchema: {
        parentId: z.string().describe('Id do pai, ex.: "fr_ab12cd34".'),
        source: z
          .string()
          .describe('Caminho absoluto do vídeo ou URL http(s), ex.: "C:/videos/demo.mp4".'),
        poster: z
          .string()
          .optional()
          .describe('Imagem de capa: caminho absoluto, URL http(s) ou data URL.'),
        autoplay: z.boolean().optional().describe('Toca sozinho (padrão true).'),
        loop: z.boolean().optional().describe('Repete (padrão true).'),
        muted: z
          .boolean()
          .optional()
          .describe('Sem som (padrão true; navegadores só tocam sozinho mudo).'),
        controls: z.boolean().optional().describe('Mostra os controles (padrão false).'),
        styles: stylesField,
        name: z.string().optional().describe('Nome da camada, ex.: "Vídeo do hero".'),
        index: indexField,
        docId: docIdField,
      },
      annotations: WRITE,
    },
    async ({
      parentId,
      source,
      poster,
      autoplay,
      loop,
      muted,
      controls,
      styles,
      name,
      index,
      docId,
    }) => {
      const id = store.resolveDocId(docId);
      requireNode(store.get(id), parentId);
      const v = await importVideo(id, source);
      const spec: VideoSpec = {
        src: v.src,
        autoplay: autoplay ?? true,
        loop: loop ?? true,
        muted: muted ?? true,
        controls: controls ?? false,
      };
      if (poster) spec.poster = await importPoster(id, poster);
      const node = createVideoNode(spec, {
        name,
        styles: { width: '640px', height: '360px', 'object-fit': 'cover', ...(styles ?? {}) },
      });
      const r = apply(id, [{ type: 'createNode', parentId, node, index }], 'insert_video');
      return `Vídeo inserido: ${node.id} em ${parentId}; ${v.note}.\n${summaryOf(r.doc, [parentId])}`;
    },
  );

  tool(
    'insert_embed',
    {
      title: 'Inserir embed (YouTube, Lottie, Rive, iframe)',
      description:
        'Insere conteúdo incorporado (nó embed) em parentId. O provedor é detectado: URL do YouTube (youtube, com start do ?t=), .json/.lottie (lottie), .riv (rive), outra URL http(s) (iframe). Lottie e Rive aceitam caminho absoluto ou URL e são COPIADOS para assets/lottie ou assets/rive (funcionam offline; JSON Lottie com v/fr/layers, Rive começa com RIVE; até 50 MB). YouTube e iframe precisam de rede. Para vídeo em arquivo use insert_video; para Three.js, insert_three.',
      example: { parentId: 'fr_ab12cd34', url: 'https://youtu.be/dQw4w9WgXcQ?t=42' },
      inputSchema: {
        parentId: z.string().describe('Id do pai, ex.: "fr_ab12cd34".'),
        url: z
          .string()
          .optional()
          .describe(
            'URL http(s) (YouTube, Lottie/Rive, página) ou caminho absoluto de .json/.lottie/.riv.',
          ),
        provider: z
          .enum(['lottie', 'rive', 'youtube', 'iframe', 'three'])
          .optional()
          .describe('Força o provedor (padrão: detectado pela url/src).'),
        src: z
          .string()
          .optional()
          .describe('Lottie/Rive: caminho absoluto ou URL do arquivo (alternativa a url).'),
        params: paramsField,
        styles: stylesField,
        name: z.string().optional().describe('Nome da camada, ex.: "Animação de carregamento".'),
        index: indexField,
        docId: docIdField,
      },
      annotations: WRITE,
    },
    async ({ parentId, url, provider, src, params, styles, name, index, docId }) => {
      const id = store.resolveDocId(docId);
      requireNode(store.get(id), parentId);
      const ref = (url ?? src)?.trim();
      if (!ref)
        throw new ToolError(
          'Informe url (ou src para Lottie/Rive). Ex.: url: "https://youtu.be/dQw4w9WgXcQ".',
        );
      const detected = detectEmbedProvider(ref);
      if (detected === 'video' && !provider)
        throw new ToolError('Isto é um arquivo de vídeo: use insert_video(parentId, source).');
      const kind: EmbedProvider | null = provider ?? (detected === 'video' ? null : detected);
      if (!kind)
        throw new ToolError(
          `Não reconheci "${ref}". Passe uma URL http(s), um caminho absoluto de .json/.lottie/.riv ou informe provider.`,
        );
      if (kind === 'three')
        throw new ToolError('Para uma cena Three.js use insert_three(parentId, code?, params?).');

      let spec: EmbedSpec;
      let size = { width: '480px', height: '320px' };
      let note = '';
      if (kind === 'youtube') {
        if (!isUrl(ref) || !youtubeId(ref))
          throw new ToolError(
            'URL do YouTube inválida. Ex.: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" ou "https://youtu.be/dQw4w9WgXcQ".',
          );
        const p: Record<string, MediaParamValue> = { ...(params ?? {}) };
        const start = youtubeStart(ref);
        if (start !== undefined && p['start'] === undefined) p['start'] = start;
        spec = { provider: 'youtube', url: ref, ...(Object.keys(p).length ? { params: p } : {}) };
        size = { width: '560px', height: '315px' };
        note = 'precisa de rede para tocar';
      } else if (kind === 'iframe') {
        if (!isUrl(ref))
          throw new ToolError('iframe exige uma URL http(s). Ex.: "https://exemplo.com/widget".');
        spec = { provider: 'iframe', url: ref, ...(params ? { params } : {}) };
        note = 'precisa de rede para carregar';
      } else {
        const a = await importAnimation(id, kind, ref);
        spec = { provider: kind, src: a.src, ...(params ? { params } : {}) };
        note = a.note;
      }
      const parsed = EmbedSpecSchema.safeParse(spec);
      if (!parsed.success)
        throw new ToolError(
          `Embed inválido: ${parsed.error.issues.map((i) => i.message).join('; ')}.`,
        );
      const node = createEmbedNode(spec, { name, styles: { ...size, ...(styles ?? {}) } });
      const r = apply(id, [{ type: 'createNode', parentId, node, index }], 'insert_embed');
      return `Embed ${kind} inserido: ${node.id} em ${parentId}; ${note}.\n${summaryOf(r.doc, [parentId])}`;
    },
  );

  tool(
    'insert_three',
    {
      title: 'Inserir cena Three.js',
      description:
        'Insere uma ilha Three.js (nó embed) em parentId. O code é o CORPO de uma função com as variáveis THREE, renderer, canvas, width, height e params, e deve devolver { scene, camera, update(t) } (t em segundos; chame sem code para ver o exemplo padrão do torus). Roda isolada num iframe sandbox, sem rede nem acesso ao documento; o render do get_screenshot e do export animado avança o relógio t.',
      example: {
        parentId: 'fr_ab12cd34',
        params: { color: '#ff6b6b' },
        styles: { width: '480px', height: '320px' },
      },
      inputSchema: {
        parentId: z.string().describe('Id do pai, ex.: "fr_ab12cd34".'),
        code: z
          .string()
          .optional()
          .describe(
            'Corpo da função: usa THREE, renderer, canvas, width, height, params; devolve { scene, camera, update(t) }. Padrão: torus giratório.',
          ),
        params: paramsField,
        styles: stylesField,
        name: z.string().optional().describe('Nome da camada, ex.: "Cena 3D".'),
        index: indexField,
        docId: docIdField,
      },
      annotations: WRITE,
    },
    ({ parentId, code, params, styles, name, index, docId }) => {
      const id = store.resolveDocId(docId);
      requireNode(store.get(id), parentId);
      const body = code ?? DEFAULT_THREE_CODE;
      if (body.length > MAX_THREE_CODE)
        throw new ToolError(`O código passa do limite de ${MAX_THREE_CODE} caracteres.`);
      const spec: EmbedSpec = { provider: 'three', code: body, ...(params ? { params } : {}) };
      const node = createEmbedNode(spec, {
        name,
        styles: { width: '480px', height: '320px', ...(styles ?? {}) },
      });
      const r = apply(id, [{ type: 'createNode', parentId, node, index }], 'insert_three');
      return `Cena Three.js inserida: ${node.id} em ${parentId} (${code ? 'código próprio' : 'código padrão'}).\n${summaryOf(r.doc, [parentId])}`;
    },
  );

  tool(
    'update_media',
    {
      title: 'Atualizar vídeo ou embed',
      description:
        'Altera um nó video (autoplay, loop, muted, controls, poster, time) ou embed (url, src, code, params mesclados nos atuais). Não troca o arquivo de um vídeo: para isso insira outro com insert_video. Campos não informados são mantidos.',
      example: { nodeId: 'vd_ab12cd34', loop: false, controls: true },
      inputSchema: {
        nodeId: z.string().describe('Id do nó de vídeo ou embed, ex.: "vd_ab12cd34".'),
        autoplay: z.boolean().optional().describe('Vídeo: toca sozinho.'),
        loop: z.boolean().optional().describe('Vídeo: repete.'),
        muted: z.boolean().optional().describe('Vídeo: sem som.'),
        controls: z.boolean().optional().describe('Vídeo: mostra controles.'),
        poster: z
          .string()
          .optional()
          .describe('Vídeo: nova imagem de capa (caminho, URL ou data URL); "" remove.'),
        time: z
          .number()
          .min(0)
          .optional()
          .describe('Vídeo: instante inicial em segundos, ex.: 2.5.'),
        url: z.string().optional().describe('Embed youtube/iframe: nova URL http(s).'),
        src: z
          .string()
          .optional()
          .describe('Embed lottie/rive: novo arquivo (caminho absoluto ou URL; é copiado).'),
        code: z.string().optional().describe('Embed three: novo código.'),
        params: paramsField,
        docId: docIdField,
      },
      annotations: WRITE,
    },
    async ({
      nodeId,
      autoplay,
      loop,
      muted,
      controls,
      poster,
      time,
      url,
      src,
      code,
      params,
      docId,
    }) => {
      const id = store.resolveDocId(docId);
      const { node } = requireNode(store.get(id), nodeId);
      if (node.type === 'video' && node.video) {
        const next: VideoSpec = { ...node.video };
        if (autoplay !== undefined) next.autoplay = autoplay;
        if (loop !== undefined) next.loop = loop;
        if (muted !== undefined) next.muted = muted;
        if (controls !== undefined) next.controls = controls;
        if (time !== undefined) next.time = time;
        if (poster !== undefined) {
          if (poster === '') delete next.poster;
          else next.poster = await importPoster(id, poster);
        }
        const parsed = VideoSpecSchema.safeParse(next);
        if (!parsed.success)
          throw new ToolError(
            `Vídeo inválido: ${parsed.error.issues.map((i) => i.message).join('; ')}.`,
          );
        const r = apply(
          id,
          [{ type: 'setMedia', changes: [{ nodeId, video: next }] }],
          'update_media',
        );
        return `Vídeo ${nodeId} atualizado.\n${summaryOf(r.doc, [nodeId])}`;
      }
      if (node.type === 'embed' && node.embed) {
        const next: EmbedSpec = { ...node.embed };
        if (url !== undefined) next.url = url;
        if (code !== undefined) {
          if (code.length > MAX_THREE_CODE)
            throw new ToolError(`O código passa do limite de ${MAX_THREE_CODE} caracteres.`);
          next.code = code;
        }
        if (src !== undefined) {
          if (next.provider !== 'lottie' && next.provider !== 'rive')
            throw new ToolError(`src só vale em embeds lottie e rive (este é ${next.provider}).`);
          next.src = (await importAnimation(id, next.provider, src)).src;
        }
        if (params) next.params = { ...(next.params ?? {}), ...params };
        const parsed = EmbedSpecSchema.safeParse(next);
        if (!parsed.success)
          throw new ToolError(
            `Embed inválido: ${parsed.error.issues.map((i) => i.message).join('; ')}.`,
          );
        const r = apply(
          id,
          [{ type: 'setMedia', changes: [{ nodeId, embed: next }] }],
          'update_media',
        );
        return `Embed ${nodeId} atualizado (${next.provider}).\n${summaryOf(r.doc, [nodeId])}`;
      }
      throw new ToolError(
        `${nodeId} é ${node.type}, não um vídeo nem um embed. Para efeitos use update_effect; veja get_tree_summary.`,
      );
    },
  );
}
