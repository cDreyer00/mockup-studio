import { describe, expect, it } from 'vitest';
import { applyOp, applyOps } from './apply.js';
import { createDocument, createNode, findNode } from './document.js';
import { htmlToNodes, nodesToHtml } from './html.js';
import { History } from './history.js';
import {
  DEFAULT_THREE_CODE,
  EMBED_PROVIDERS,
  EmbedSpecSchema,
  MAX_THREE_CODE,
  createEffectNode,
  createEmbedNode,
  createVideoNode,
  detectEmbedProvider,
  loopbackUrlProblem,
  mediaAssetRefs,
  mediaRefProblem,
  youtubeEmbedUrl,
  youtubeId,
  youtubeStart,
} from './media.js';
import { OpSchema } from './ops.schema.js';
import { parseDocument, serializeDocument, validateDocument } from './schema.js';
import { getDocumentSummary, summarizeNode } from './summary.js';
import type { Document, EmbedSpec, Node } from './types.js';

function strip(doc: Document): unknown {
  const c = structuredClone(doc);
  c.meta.updatedAt = '';
  return c;
}

/** Documento com um frame contendo um nó de cada tipo de mídia. */
function fixture(): Document {
  const doc = createDocument('Mídia', { id: 'doc_media001' });
  const kids: Node[] = [
    createEffectNode('mesh-gradient', { speed: 2, color1: '#ff0000' }),
    createVideoNode({ src: 'clip.mp4', poster: 'poster.png', autoplay: true, loop: true }),
    createEmbedNode({ provider: 'youtube', url: 'https://youtu.be/dQw4w9WgXcQ?t=30' }),
    createEmbedNode({ provider: 'lottie', src: 'anim.json', params: { loop: true } }),
    createEmbedNode({ provider: 'rive', src: 'anim.riv', params: { artboard: 'Main' } }),
    createEmbedNode({ provider: 'three', code: DEFAULT_THREE_CODE, params: { color: '#7c5cff' } }),
    createEmbedNode({ provider: 'iframe', url: 'https://example.com/page' }),
  ];
  kids[0]!.id = 'fx_aaaaaaaa';
  kids[1]!.id = 'vd_aaaaaaaa';
  kids[2]!.id = 'eb_youtube1';
  kids[3]!.id = 'eb_lottie01';
  kids[4]!.id = 'eb_rive0001';
  kids[5]!.id = 'eb_three001';
  kids[6]!.id = 'eb_iframe01';
  const frame = createNode({
    tag: 'div',
    type: 'frame',
    id: 'fr_aaaaaaaa',
    name: 'Tela',
    style: { width: '400px', height: '300px' },
    children: kids,
  });
  doc.pages[0].frames.push(frame);
  return doc;
}

type RawDoc = { pages: { frames: { children: Record<string, unknown>[] }[] }[] };

/** Documento cru (JSON) com o primeiro filho do frame (fx_aaaaaaaa) substituído. */
function rawWith(patch: Record<string, unknown>, type = 'effect'): RawDoc {
  const raw = JSON.parse(serializeDocument(fixture())) as RawDoc;
  const node = raw.pages[0]!.frames[0]!.children[0]!;
  delete node.effect;
  node.type = type;
  Object.assign(node, patch);
  return raw;
}

describe('createNode de mídia', () => {
  it('effect: div com type effect e cópia dos params', () => {
    const params = { speed: 1 };
    const n = createEffectNode('grain', params);
    expect(n.type).toBe('effect');
    expect(n.tag).toBe('div');
    expect(n.id).toMatch(/^fx_/);
    expect(n.effect).toEqual({ kind: 'grain', params: { speed: 1 } });
    params.speed = 9;
    expect(n.effect!.params.speed).toBe(1);
    expect(n.children).toEqual([]);
  });

  it('video: tag video com type video e id vd_', () => {
    const n = createVideoNode({ src: 'a.mp4', muted: true });
    expect(n.type).toBe('video');
    expect(n.tag).toBe('video');
    expect(n.id).toMatch(/^vd_/);
    expect(n.video).toEqual({ src: 'a.mp4', muted: true });
    expect(n.name).toBe('Vídeo');
  });

  it('embed: nome padrão por provedor e id eb_', () => {
    const nomes = EMBED_PROVIDERS.map((provider) => {
      const n = createEmbedNode({ provider, url: 'https://example.com', src: 'a.json', code: '' });
      expect(n.type).toBe('embed');
      expect(n.tag).toBe('div');
      expect(n.id).toMatch(/^eb_/);
      return n.name;
    });
    expect(nomes).toEqual(['Lottie', 'Rive', 'YouTube', 'Three.js', 'Iframe']);
  });

  it('opções: name, styles e position', () => {
    const n = createEffectNode(
      'glass',
      {},
      { name: 'Fundo', styles: { width: '10px' }, position: { x: 1, y: 2 } },
    );
    expect(n.name).toBe('Fundo');
    expect(n.style).toEqual({ width: '10px' });
    expect(n.position).toEqual({ x: 1, y: 2 });
  });

  it('mediaAssetRefs lista só caminhos de assets/ (sem URLs)', () => {
    const doc = fixture();
    const refs = (id: string) => mediaAssetRefs(findNode(doc, id)!.node);
    expect(refs('vd_aaaaaaaa')).toEqual(['clip.mp4', 'poster.png']);
    expect(refs('eb_lottie01')).toEqual(['anim.json']);
    expect(refs('eb_youtube1')).toEqual([]);
    expect(refs('fx_aaaaaaaa')).toEqual([]);
    const url = createVideoNode({ src: 'https://example.com/v.mp4' });
    expect(mediaAssetRefs(url)).toEqual([]);
  });
});

describe('serialização de documento com mídia', () => {
  it('passa na validação do schema', () => {
    const r = validateDocument(fixture());
    expect(r.ok).toBe(true);
  });

  it('round-trip JSON é idêntico e estável', () => {
    const doc = fixture();
    const json = serializeDocument(doc);
    const back = parseDocument(JSON.parse(JSON.stringify(JSON.parse(json))));
    expect(back).toEqual(doc);
    expect(serializeDocument(back)).toBe(json);
    expect(findNode(back, 'eb_three001')!.node.embed!.code).toBe(DEFAULT_THREE_CODE);
    expect(findNode(back, 'vd_aaaaaaaa')!.node.video).toEqual({
      src: 'clip.mp4',
      poster: 'poster.png',
      autoplay: true,
      loop: true,
    });
  });

  it('effect sem params recebe {} por padrão', () => {
    const doc = parseDocument(rawWith({ effect: { kind: 'grain' } }));
    expect(findNode(doc, 'fx_aaaaaaaa')!.node.effect).toEqual({ kind: 'grain', params: {} });
  });

  it('recusa nó sem o campo do seu tipo', () => {
    const raw = rawWith({});
    const r = validateDocument(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toContain('nó effect sem o campo effect');
  });

  it('recusa filhos em nós de mídia', () => {
    const raw = rawWith({ effect: { kind: 'grain', params: {} } });
    const child = raw.pages[0]!.frames[0]!.children[1]!;
    raw.pages[0]!.frames[0]!.children[0]!.children = [child];
    const r = validateDocument(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toContain('não têm filhos');
  });

  it.each([
    ['provider desconhecido', { embed: { provider: 'vimeo', url: 'https://vimeo.com/1' } }],
    ['lottie sem src', { embed: { provider: 'lottie' } }],
    [
      'youtube com url de outro site',
      { embed: { provider: 'youtube', url: 'https://example.com' } },
    ],
    ['iframe com javascript:', { embed: { provider: 'iframe', url: 'javascript:alert(1)' } }],
    ['iframe sem url', { embed: { provider: 'iframe' } }],
    ['three sem code', { embed: { provider: 'three' } }],
    [
      'three acima de MAX_THREE_CODE',
      { embed: { provider: 'three', code: 'x'.repeat(MAX_THREE_CODE + 1) } },
    ],
    ['param com nome inválido', { embed: { provider: 'three', code: '', params: { 'a-b': 1 } } }],
    [
      'param com tipo inválido (objeto)',
      { embed: { provider: 'three', code: '', params: { a: { x: 1 } } } },
    ],
    ['param de texto com aspas', { embed: { provider: 'three', code: '', params: { a: 'x"y' } } }],
  ])('recusa embed: %s', (_nome, patch) => {
    expect(validateDocument(rawWith(patch, 'embed')).ok).toBe(false);
  });

  it('aceita three com exatamente MAX_THREE_CODE caracteres', () => {
    const embed = { provider: 'three', code: 'x'.repeat(MAX_THREE_CODE) };
    expect(validateDocument(rawWith({ embed }, 'embed')).ok).toBe(true);
  });

  it.each([
    ['src javascript:', { video: { src: 'javascript:alert(1)' } }],
    ['src data:', { video: { src: 'data:text/html;base64,AAAA' } }],
    ['src com ..', { video: { src: '../segredo.mp4' } }],
    ['src absoluto', { video: { src: '/etc/passwd' } }],
    ['src vazio', { video: { src: '' } }],
    ['poster javascript:', { video: { src: 'a.mp4', poster: 'javascript:alert(1)' } }],
    ['time negativo', { video: { src: 'a.mp4', time: -1 } }],
    ['autoplay não booleano', { video: { src: 'a.mp4', autoplay: 'sim' } }],
  ])('recusa video: %s', (_nome, patch) => {
    expect(validateDocument(rawWith(patch, 'video')).ok).toBe(false);
  });

  it('aceita poster data:image e src http(s)', () => {
    const video = { src: 'https://example.com/a.mp4', poster: 'data:image/png;base64,iVBORw0=' };
    expect(validateDocument(rawWith({ video }, 'video')).ok).toBe(true);
  });

  it.each([
    ['kind com maiúscula', { effect: { kind: 'Mesh' } }],
    ['kind vazio', { effect: { kind: '' } }],
    ['param com valor nulo', { effect: { kind: 'grain', params: { speed: null } } }],
    ['param de texto com caractere proibido', { effect: { kind: 'grain', params: { a: 'x<y' } } }],
  ])('recusa effect: %s', (_nome, patch) => {
    expect(validateDocument(rawWith(patch)).ok).toBe(false);
  });
});

describe('mediaRefProblem', () => {
  it('aceita caminho relativo e URL http(s)', () => {
    expect(mediaRefProblem('a/b.mp4')).toBeNull();
    expect(mediaRefProblem('https://example.com/a.mp4?x=1')).toBeNull();
    expect(mediaRefProblem('HTTP://example.com/a')).toBeNull();
  });

  it('recusa esquemas perigosos, caminhos fugitivos e caracteres de injeção', () => {
    for (const ref of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      'data:text/html,x',
      'file:///etc/passwd',
      'a/../b.mp4',
      '/abs.mp4',
      'a//b.mp4',
      "a'b.mp4",
      'a"b.mp4',
      'a<b.mp4',
      'a\\b.mp4',
      'x'.repeat(501),
      '',
    ]) {
      expect(mediaRefProblem(ref), ref).not.toBeNull();
    }
  });

  it('data:image só com allowDataImage', () => {
    const d = 'data:image/png;base64,iVBORw0=';
    expect(mediaRefProblem(d)).not.toBeNull();
    expect(mediaRefProblem(d, { allowDataImage: true })).toBeNull();
    expect(
      mediaRefProblem('data:image/svg+xml;base64,AAAA', { allowDataImage: true }),
    ).not.toBeNull();
  });
});

describe('YouTube e detecção de provedor', () => {
  it.each([
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://youtu.be/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/embed/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://youtube.com/shorts/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/watch?v=curto', null],
    ['https://evil.com/watch?v=dQw4w9WgXcQ', null],
    ['https://notyoutube.com/watch?v=dQw4w9WgXcQ', null],
    ['não é url', null],
  ])('youtubeId(%s)', (url, id) => {
    expect(youtubeId(url)).toBe(id);
  });

  it('youtubeStart entende segundos e 1m30s', () => {
    expect(youtubeStart('https://youtu.be/dQw4w9WgXcQ?t=90')).toBe(90);
    expect(youtubeStart('https://youtu.be/dQw4w9WgXcQ?t=1m30s')).toBe(90);
    expect(youtubeStart('https://youtu.be/dQw4w9WgXcQ?start=5')).toBe(5);
    expect(youtubeStart('https://youtu.be/dQw4w9WgXcQ')).toBeUndefined();
  });

  it('youtubeEmbedUrl: sem cookies, autoplay força mute, loop usa playlist', () => {
    const u = youtubeEmbedUrl('dQw4w9WgXcQ', { autoplay: true, loop: true, controls: false });
    expect(u.startsWith('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?')).toBe(true);
    expect(u).toContain('autoplay=1');
    expect(u).toContain('mute=1');
    expect(u).toContain('loop=1');
    expect(u).toContain('playlist=dQw4w9WgXcQ');
    expect(u).toContain('controls=0');
  });

  it('detectEmbedProvider', () => {
    expect(detectEmbedProvider('https://youtu.be/dQw4w9WgXcQ')).toBe('youtube');
    expect(detectEmbedProvider('anim.json')).toBe('lottie');
    expect(detectEmbedProvider('anim.lottie?x=1')).toBe('lottie');
    expect(detectEmbedProvider('a.riv')).toBe('rive');
    expect(detectEmbedProvider('a.MP4')).toBe('video');
    expect(detectEmbedProvider('https://example.com/x')).toBe('iframe');
    expect(detectEmbedProvider('')).toBeNull();
    expect(detectEmbedProvider('algo-sem-extensao')).toBeNull();
  });
});

describe('op setMedia', () => {
  it('aplica effect, video e embed e o inverso restaura (imutável)', () => {
    const doc = fixture();
    const before = structuredClone(doc);
    const op = {
      type: 'setMedia' as const,
      changes: [
        { nodeId: 'fx_aaaaaaaa', effect: { kind: 'waves', params: { lines: 5 } } },
        { nodeId: 'vd_aaaaaaaa', video: { src: 'novo.mp4', muted: true } },
        { nodeId: 'eb_iframe01', embed: { provider: 'iframe' as const, url: 'https://a.dev/' } },
      ],
    };
    const r = applyOp(doc, op);
    expect(strip(doc)).toEqual(strip(before));
    expect(findNode(r.doc, 'fx_aaaaaaaa')!.node.effect).toEqual({
      kind: 'waves',
      params: { lines: 5 },
    });
    expect(findNode(r.doc, 'vd_aaaaaaaa')!.node.video).toEqual({ src: 'novo.mp4', muted: true });
    expect(findNode(r.doc, 'eb_iframe01')!.node.embed!.url).toBe('https://a.dev/');
    const back = applyOps(r.doc, r.inverse);
    expect(strip(back.doc)).toStrictEqual(strip(doc));
  });

  it('não compartilha referência com a op (deepClone)', () => {
    const effect = { kind: 'grain', params: { speed: 1 } };
    const r = applyOp(fixture(), {
      type: 'setMedia',
      changes: [{ nodeId: 'fx_aaaaaaaa', effect }],
    });
    effect.params.speed = 99;
    expect(findNode(r.doc, 'fx_aaaaaaaa')!.node.effect!.params.speed).toBe(1);
  });

  it('exige exatamente um campo e que case com o tipo do nó', () => {
    const doc = fixture();
    const effect = { kind: 'grain', params: {} };
    const video = { src: 'a.mp4' };
    const run = (c: Record<string, unknown>) =>
      applyOp(doc, { type: 'setMedia', changes: [c as never] });
    expect(() => run({ nodeId: 'fx_aaaaaaaa' })).toThrow(/exatamente um/);
    expect(() => run({ nodeId: 'fx_aaaaaaaa', effect, video })).toThrow(/exatamente um/);
    expect(() => run({ nodeId: 'vd_aaaaaaaa', effect })).toThrow(/só vale em nós effect/);
    expect(() => run({ nodeId: 'fr_aaaaaaaa', effect })).toThrow(/é frame/);
    expect(() => run({ nodeId: 'nao_existe', effect })).toThrow(/não encontrado/i);
  });

  it('mudanças múltiplas no mesmo nó desfazem em ordem inversa', () => {
    const doc = fixture();
    const r = applyOp(doc, {
      type: 'setMedia',
      changes: [
        { nodeId: 'fx_aaaaaaaa', effect: { kind: 'grain', params: {} } },
        { nodeId: 'fx_aaaaaaaa', effect: { kind: 'glass', params: {} } },
      ],
    });
    expect(findNode(r.doc, 'fx_aaaaaaaa')!.node.effect!.kind).toBe('glass');
    const back = applyOps(r.doc, r.inverse);
    expect(findNode(back.doc, 'fx_aaaaaaaa')!.node.effect).toEqual({
      kind: 'mesh-gradient',
      params: { speed: 2, color1: '#ff0000' },
    });
  });

  it('History: undo restaura o estado anterior e redo reaplica', () => {
    const h = new History(fixture());
    const original = structuredClone(h.doc);
    h.apply(
      [
        {
          type: 'setMedia',
          changes: [{ nodeId: 'eb_three001', embed: { provider: 'three', code: 'return {};' } }],
        },
      ],
      'trocar three',
    );
    expect(findNode(h.doc, 'eb_three001')!.node.embed).toEqual({
      provider: 'three',
      code: 'return {};',
    });
    expect(h.undo()).not.toBeNull();
    expect(strip(h.doc)).toEqual(strip(original));
    expect(h.redo()).not.toBeNull();
    expect(findNode(h.doc, 'eb_three001')!.node.embed!.code).toBe('return {};');
  });

  it('createNode com nó de mídia + inverso remove o nó', () => {
    const doc = fixture();
    const node = createVideoNode({ src: 'x.mp4' });
    const r = applyOp(doc, { type: 'createNode', parentId: 'fr_aaaaaaaa', node });
    expect(findNode(r.doc, node.id)!.node.video).toEqual({ src: 'x.mp4' });
    const back = applyOps(r.doc, r.inverse);
    expect(findNode(back.doc, node.id)).toBeUndefined();
  });

  it('OpSchema valida setMedia e recusa mídia inválida', () => {
    const ok = OpSchema.safeParse({
      type: 'setMedia',
      changes: [{ nodeId: 'fx_aaaaaaaa', effect: { kind: 'grain', params: { speed: 1 } } }],
    });
    expect(ok.success).toBe(true);
    const ruins = [
      { nodeId: 'vd_aaaaaaaa', video: { src: 'javascript:alert(1)' } },
      { nodeId: 'eb_x', embed: { provider: 'vimeo' } },
      { nodeId: 'eb_x', embed: { provider: 'three', code: 'x'.repeat(MAX_THREE_CODE + 1) } },
      { nodeId: 'fx_x', effect: { kind: 'grain', params: { speed: { a: 1 } } } },
    ];
    for (const c of ruins) {
      const r = OpSchema.safeParse({ type: 'setMedia', changes: [c] });
      expect(r.success, JSON.stringify(c)).toBe(false);
    }
  });
});

describe('summary', () => {
  it('resume cada tipo de mídia com seu campo', () => {
    const doc = fixture();
    const sum = (id: string) => summarizeNode(findNode(doc, id)!.node);
    expect(sum('fx_aaaaaaaa')).toContain('effect:mesh-gradient');
    expect(sum('vd_aaaaaaaa')).toContain('video:clip.mp4');
    expect(sum('eb_youtube1')).toContain('embed:youtube https://youtu.be/dQw4w9WgXcQ');
    expect(sum('eb_lottie01')).toContain('embed:lottie anim.json');
    expect(sum('eb_three001')).toContain('embed:three');
    expect(sum('eb_three001')).not.toContain('return');
  });

  it('árvore do documento lista os nós de mídia', () => {
    const tree = getDocumentSummary(fixture(), 3);
    expect(tree).toContain('effect:mesh-gradient');
    expect(tree).toContain('embed:iframe https://example.com/page');
  });
});

describe('loopbackUrlProblem', () => {
  it.each([
    'http://localhost:5173/',
    'http://app.localhost/x',
    'http://127.0.0.1:4747/',
    'http://127.5.6.7/',
    'http://0.0.0.0/',
    'http://[::1]:4747/',
    'http://[::]/',
    'http://[::ffff:127.0.0.1]/',
    'http://LOCALHOST./',
  ])('recusa %s', (url) => {
    expect(loopbackUrlProblem(url)).toMatch(/loopback/);
  });

  it.each(['https://example.com/', 'https://128.0.0.1/', 'https://notlocalhost.com/'])(
    'aceita %s',
    (url) => {
      expect(loopbackUrlProblem(url)).toBeNull();
    },
  );

  it('EmbedSpecSchema recusa loopback em iframe e YouTube', () => {
    expect(
      EmbedSpecSchema.safeParse({ provider: 'iframe', url: 'http://127.0.0.1:4747/' }).success,
    ).toBe(false);
    expect(
      EmbedSpecSchema.safeParse({ provider: 'iframe', url: 'https://example.com' }).success,
    ).toBe(true);
  });
});

describe('ida e volta de embeds por HTML', () => {
  const specs: EmbedSpec[] = [
    { provider: 'lottie', src: 'lottie/anim.json', params: { loop: false } },
    { provider: 'rive', src: 'rive/a.riv', params: { artboard: 'Main', stateMachine: 'SM' } },
    { provider: 'three', code: 'const s = "a & b";\nreturn { scene: s, update(t) {} };' },
    { provider: 'iframe', url: 'https://example.com/page?a=1&b=2' },
    { provider: 'youtube', url: 'https://youtu.be/dQw4w9WgXcQ?t=42', params: { start: 42 } },
  ];

  it.each(specs)('nó embed $provider → html → nó com a mesma spec', (spec) => {
    const node = createEmbedNode(spec, { styles: { width: '300px', height: '200px' } });
    const { html, css } = nodesToHtml([node], { mode: 'inline' });
    expect(html).not.toContain('<iframe');
    const [back] = htmlToNodes(html, { css });
    expect(back!.type).toBe('embed');
    expect(back!.embed).toEqual(spec);
    expect(back!.style).toMatchObject({ width: '300px', height: '200px' });
  });

  it('embed com url de loopback ou inválida no HTML é ignorado como embed', () => {
    const [n] = htmlToNodes(
      '<div data-mockup-embed="iframe" data-url="http://127.0.0.1:4747/"></div>',
    );
    expect(n!.type).not.toBe('embed');
  });
});
