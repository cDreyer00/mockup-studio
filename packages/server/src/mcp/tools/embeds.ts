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
import { detectImage, writeAsset } from '../../assets.js';
import { MAX_ANIMATION_BYTES, MAX_VIDEO_BYTES, sanitizeAssetName } from '../../http.js';
import { detectVideo, fetchAnimation, validateAnimation } from '../../mediaBytes.js';
import { ToolError, WRITE, docIdField, type ToolContext } from '../context.js';
import { MAX_DATA_URL_BYTES, loadSource } from './images.js';

export { detectVideo, lottieKind } from '../../mediaBytes.js';

const kb = (n: number): string => `${Math.max(1, Math.round(n / 1024))} KB`;
const isUrl = (s: string): boolean => /^https?:\/\//i.test(s);

const paramsField = z
  .record(z.string(), z.union([z.number(), z.boolean(), z.string()]))
  .optional()
  .describe('Params (number, text or boolean), e.g. { "color": "#ff0066" }.');

const stylesField = z
  .record(z.string(), z.string())
  .optional()
  .describe('CSS styles, e.g. { "width": "640px", "border-radius": "12px" }.');

const indexField = z
  .number()
  .int()
  .min(0)
  .optional()
  .describe('Position among the children, e.g. 0 (default: end).');

/** Writes `src` to `dir/name` without overwriting (copies on disk, without loading the file). */
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
  throw new Error(`Could not copy to ${dir}: names exhausted.`);
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
    throw new ToolError(`File not found: ${file}`);
  }
  if (!st.isFile()) throw new ToolError(`"${file}" is not a file.`);
  if (st.size > max)
    throw new ToolError(`${what} exceeds the ${Math.round(max / 1024 / 1024)} MB limit.`);
  return st;
}

export function registerEmbedTools(ctx: ToolContext): void {
  const { tool, store, requireNode, apply, summaryOf } = ctx;

  const needAssets = (id: string, what: string): string => {
    const dir = store.assetsDir(id);
    if (!dir)
      throw new ToolError(
        `The document has no path on disk yet, so there is no assets/ folder to store ${what}. Save the document (create_document or Save as) and try again.`,
      );
    return dir;
  };

  /** Video: local path (copied to assets/videos/) or http(s) URL (referenced directly). */
  const importVideo = async (
    id: string,
    source: string,
  ): Promise<{ src: string; note: string }> => {
    const s = source.trim();
    if (isUrl(s)) {
      const problem = mediaRefProblem(s);
      if (problem) throw new ToolError(`Invalid video URL: ${problem}.`);
      return { src: s, note: 'URL referenced directly (the video only plays online)' };
    }
    if (!path.isAbsolute(s))
      throw new ToolError(`source must be an absolute path or an http(s) video URL; got "${s}".`);
    const st = await statFile(s, MAX_VIDEO_BYTES, 'The video');
    const kind = detectVideo(await readHead(s, 16));
    if (!kind)
      throw new ToolError(
        'The file is not a recognized video (mp4, m4v, mov, webm or ogg). Check the file.',
      );
    const assets = needAssets(id, 'the video');
    const stem = path.basename(s).replace(/\.[^.]*$/, '') || 'video';
    const safe = sanitizeAssetName(`${stem}${kind.ext}`);
    const file = await copyUnique(path.join(assets, 'videos'), `${safe.base}${safe.ext}`, s);
    return { src: `videos/${file}`, note: `copied to assets/videos/${file} (${kb(st.size)})` };
  };

  /** Poster image: copies to assets/ (or a data URL of up to 2 MB without an assets folder). */
  const importPoster = async (id: string, source: string): Promise<string> => {
    const { bytes, hint } = await loadSource(source);
    const info = detectImage(bytes);
    if (!info || info.ext === '.svg')
      throw new ToolError('The poster must be a PNG, JPEG, GIF, WebP or AVIF image.');
    const assets = store.assetsDir(id);
    if (assets) {
      const stem = hint.replace(/\.[^.]*$/, '') || 'poster';
      const safe = sanitizeAssetName(`${stem}${info.ext}`);
      return await writeAsset(assets, `${safe.base}${safe.ext}`, bytes);
    }
    if (bytes.length > MAX_DATA_URL_BYTES)
      throw new ToolError(
        'The document has no path on disk yet and the poster is over 2 MB to embed. Save the document and try again.',
      );
    return `data:${info.mime};base64,${bytes.toString('base64')}`;
  };

  /** Lottie/Rive: copies/downloads to assets/lottie or assets/rive after validating the content. */
  const importAnimation = async (
    id: string,
    provider: 'lottie' | 'rive',
    source: string,
  ): Promise<{ src: string; note: string }> => {
    const s = source.trim();
    const dir = provider;
    // reference already relative to assets/ (e.g. "lottie/loader.json")
    if (!isUrl(s) && !path.isAbsolute(s)) {
      const problem = mediaRefProblem(s);
      const assets = store.assetsDir(id);
      if (problem || !assets || !fs.existsSync(path.join(assets, s)))
        throw new ToolError(
          `"${s}" is not an absolute path, an http(s) URL or an existing file in assets/. Pass the absolute path of the ${provider === 'rive' ? '.riv' : '.json/.lottie'} file.`,
        );
      return { src: s, note: `existing file assets/${s}` };
    }
    let bytes: Buffer;
    let hint: string;
    let ext: string;
    if (isUrl(s)) {
      try {
        ({ bytes, hint, ext } = await fetchAnimation(s, provider));
      } catch (e) {
        throw new ToolError(e instanceof Error ? e.message : String(e));
      }
    } else {
      await statFile(s, MAX_ANIMATION_BYTES, 'The file');
      bytes = await fs.promises.readFile(s);
      hint = path.basename(s);
      const v = validateAnimation(bytes, provider);
      if (!v.startsWith('.')) throw new ToolError(v);
      ext = v;
    }
    const assets = needAssets(
      id,
      provider === 'rive' ? 'the Rive animation' : 'the Lottie animation',
    );
    const stem = hint.replace(/\.[^.]*$/, '') || provider;
    const safe = sanitizeAssetName(`${stem}${ext}`);
    const file = await writeAsset(path.join(assets, dir), `${safe.base}${safe.ext}`, bytes);
    return { src: `${dir}/${file}`, note: `saved to assets/${dir}/${file} (${kb(bytes.length)})` };
  };

  tool(
    'insert_video',
    {
      title: 'Insert video',
      description:
        'Inserts a video into parentId. source: absolute path (mp4, m4v, mov, webm, ogv; up to 500 MB; copied to assets/videos/) or http(s) URL (only plays online). poster shows in get_screenshot without time. Defaults: muted, loop, autoplay, no controls, 640x360.',
      example: {
        parentId: 'fr_ab12cd34',
        source: 'C:/videos/demo.mp4',
        poster: 'C:/videos/demo.png',
        styles: { width: '480px', height: '270px' },
      },
      inputSchema: {
        parentId: z.string().describe('Parent id, e.g. "fr_ab12cd34".'),
        source: z
          .string()
          .describe('Absolute path of the video or http(s) URL, e.g. "C:/videos/demo.mp4".'),
        poster: z
          .string()
          .optional()
          .describe('Cover image: absolute path, http(s) URL or data URL.'),
        autoplay: z.boolean().optional().describe('Plays on its own (default true).'),
        loop: z.boolean().optional().describe('Repeats (default true).'),
        muted: z
          .boolean()
          .optional()
          .describe('No sound (default true; browsers only autoplay muted).'),
        controls: z.boolean().optional().describe('Shows the controls (default false).'),
        styles: stylesField,
        name: z.string().optional().describe('Layer name, e.g. "Hero video".'),
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
      return `Video inserted: ${node.id} in ${parentId}; ${v.note}.\n${summaryOf(r.doc, [parentId])}`;
    },
  );

  tool(
    'insert_embed',
    {
      title: 'Insert embed (YouTube, Lottie, Rive, iframe)',
      description:
        'Inserts an embed into parentId with the provider detected from the URL: YouTube (start from ?t=), .json/.lottie (Lottie), .riv (Rive), any other http(s) (iframe). Lottie and Rive (absolute path or URL, up to 50 MB) are copied to assets/ and work offline; YouTube and iframe need a network.',
      example: { parentId: 'fr_ab12cd34', url: 'https://youtu.be/dQw4w9WgXcQ?t=42' },
      inputSchema: {
        parentId: z.string().describe('Parent id, e.g. "fr_ab12cd34".'),
        url: z
          .string()
          .optional()
          .describe(
            'http(s) URL (YouTube, Lottie/Rive, page) or absolute path of a .json/.lottie/.riv file.',
          ),
        provider: z
          .enum(['lottie', 'rive', 'youtube', 'iframe', 'three'])
          .optional()
          .describe('Forces the provider (default: detected from url/src).'),
        src: z
          .string()
          .optional()
          .describe('Lottie/Rive: absolute path or URL of the file (alternative to url).'),
        params: paramsField,
        styles: stylesField,
        name: z.string().optional().describe('Layer name, e.g. "Loading animation".'),
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
          'Provide url (or src for Lottie/Rive). E.g. url: "https://youtu.be/dQw4w9WgXcQ".',
        );
      const detected = detectEmbedProvider(ref);
      if (detected === 'video' && !provider)
        throw new ToolError('This is a video file: use insert_video(parentId, source).');
      const kind: EmbedProvider | null = provider ?? (detected === 'video' ? null : detected);
      if (!kind)
        throw new ToolError(
          `Unrecognized "${ref}". Pass an http(s) URL, an absolute path of a .json/.lottie/.riv file or set provider.`,
        );
      if (kind === 'three')
        throw new ToolError('For a Three.js scene use insert_three(parentId, code?, params?).');

      let spec: EmbedSpec;
      let size = { width: '480px', height: '320px' };
      let note = '';
      if (kind === 'youtube') {
        if (!isUrl(ref) || !youtubeId(ref))
          throw new ToolError(
            'Invalid YouTube URL. E.g.: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" or "https://youtu.be/dQw4w9WgXcQ".',
          );
        const p: Record<string, MediaParamValue> = { ...(params ?? {}) };
        const start = youtubeStart(ref);
        if (start !== undefined && p['start'] === undefined) p['start'] = start;
        spec = { provider: 'youtube', url: ref, ...(Object.keys(p).length ? { params: p } : {}) };
        size = { width: '560px', height: '315px' };
        note = 'needs a network to play';
      } else if (kind === 'iframe') {
        if (!isUrl(ref))
          throw new ToolError('iframe requires an http(s) URL. E.g. "https://example.com/widget".');
        spec = { provider: 'iframe', url: ref, ...(params ? { params } : {}) };
        note = 'needs a network to load';
      } else {
        const a = await importAnimation(id, kind, ref);
        spec = { provider: kind, src: a.src, ...(params ? { params } : {}) };
        note = a.note;
      }
      const parsed = EmbedSpecSchema.safeParse(spec);
      if (!parsed.success)
        throw new ToolError(
          `Invalid embed: ${parsed.error.issues.map((i) => i.message).join('; ')}.`,
        );
      const node = createEmbedNode(spec, { name, styles: { ...size, ...(styles ?? {}) } });
      const r = apply(id, [{ type: 'createNode', parentId, node, index }], 'insert_embed');
      return `Embed ${kind} inserted: ${node.id} in ${parentId}; ${note}.\n${summaryOf(r.doc, [parentId])}`;
    },
  );

  tool(
    'insert_three',
    {
      title: 'Insert Three.js scene',
      description:
        'Inserts a Three.js island into parentId. code is the BODY of a function with THREE, renderer, canvas, width, height and params that returns { scene, camera, update(t) } (t in s; no code = a torus knot). Runs in a sandboxed iframe with no access to the document; get_screenshot(time) advances t.',
      example: {
        parentId: 'fr_ab12cd34',
        params: { color: '#ff6b6b' },
        styles: { width: '480px', height: '320px' },
      },
      inputSchema: {
        parentId: z.string().describe('Parent id, e.g. "fr_ab12cd34".'),
        code: z
          .string()
          .optional()
          .describe(
            'Function body: uses THREE, renderer, canvas, width, height, params; returns { scene, camera, update(t) }. Default: spinning torus.',
          ),
        params: paramsField,
        styles: stylesField,
        name: z.string().optional().describe('Layer name, e.g. "3D scene".'),
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
        throw new ToolError(`The code exceeds the ${MAX_THREE_CODE} character limit.`);
      const spec: EmbedSpec = { provider: 'three', code: body, ...(params ? { params } : {}) };
      const node = createEmbedNode(spec, {
        name,
        styles: { width: '480px', height: '320px', ...(styles ?? {}) },
      });
      const r = apply(id, [{ type: 'createNode', parentId, node, index }], 'insert_three');
      return `Three.js scene inserted: ${node.id} in ${parentId} (${code ? 'custom code' : 'default code'}).\n${summaryOf(r.doc, [parentId])}`;
    },
  );

  tool(
    'update_media',
    {
      title: 'Update video or embed',
      description:
        'Changes a video node (autoplay, loop, muted, controls, poster, time) or embed (url, src, code, params merged into the current ones). Does not swap a video file: insert another with insert_video for that. Fields not provided are kept.',
      example: { nodeId: 'vd_ab12cd34', loop: false, controls: true },
      inputSchema: {
        nodeId: z.string().describe('Id of the video or embed node, e.g. "vd_ab12cd34".'),
        autoplay: z.boolean().optional().describe('Video: plays on its own.'),
        loop: z.boolean().optional().describe('Video: repeats.'),
        muted: z.boolean().optional().describe('Video: no sound.'),
        controls: z.boolean().optional().describe('Video: shows controls.'),
        poster: z
          .string()
          .optional()
          .describe('Video: new cover image (path, URL or data URL); "" removes it.'),
        time: z.number().min(0).optional().describe('Video: start time in seconds, e.g. 2.5.'),
        url: z.string().optional().describe('Embed youtube/iframe: new http(s) URL.'),
        src: z
          .string()
          .optional()
          .describe('Embed lottie/rive: new file (absolute path or URL; it is copied).'),
        code: z.string().optional().describe('Embed three: new code.'),
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
            `Invalid video: ${parsed.error.issues.map((i) => i.message).join('; ')}.`,
          );
        const r = apply(
          id,
          [{ type: 'setMedia', changes: [{ nodeId, video: next }] }],
          'update_media',
        );
        return `Video ${nodeId} updated.\n${summaryOf(r.doc, [nodeId])}`;
      }
      if (node.type === 'embed' && node.embed) {
        const next: EmbedSpec = { ...node.embed };
        if (url !== undefined) {
          next.url = url;
          if (next.provider === 'youtube') {
            // the start comes from the new URL (?t=/start=); without it, the old one no longer applies
            const p: Record<string, MediaParamValue> = { ...(next.params ?? {}) };
            delete p['start'];
            const start = youtubeStart(url);
            if (start !== undefined) p['start'] = start;
            if (Object.keys(p).length) next.params = p;
            else delete next.params;
          }
        }
        if (code !== undefined) {
          if (code.length > MAX_THREE_CODE)
            throw new ToolError(`The code exceeds the ${MAX_THREE_CODE} character limit.`);
          next.code = code;
        }
        if (src !== undefined) {
          if (next.provider !== 'lottie' && next.provider !== 'rive')
            throw new ToolError(
              `src only applies to lottie and rive embeds (this one is ${next.provider}).`,
            );
          next.src = (await importAnimation(id, next.provider, src)).src;
        }
        if (params) next.params = { ...(next.params ?? {}), ...params };
        const parsed = EmbedSpecSchema.safeParse(next);
        if (!parsed.success)
          throw new ToolError(
            `Invalid embed: ${parsed.error.issues.map((i) => i.message).join('; ')}.`,
          );
        const r = apply(
          id,
          [{ type: 'setMedia', changes: [{ nodeId, embed: next }] }],
          'update_media',
        );
        return `Embed ${nodeId} updated (${next.provider}).\n${summaryOf(r.doc, [nodeId])}`;
      }
      throw new ToolError(
        `${nodeId} is ${node.type}, not a video or an embed. For effects use update_effect; see get_tree_summary.`,
      );
    },
  );
}
