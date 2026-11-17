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

/** Document with a frame containing one node of each media type. */
function fixture(): Document {
  const doc = createDocument('Media', { id: 'doc_media001' });
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
    name: 'Screen',
    style: { width: '400px', height: '300px' },
    children: kids,
  });
  doc.pages[0].frames.push(frame);
  return doc;
}

type RawDoc = { pages: { frames: { children: Record<string, unknown>[] }[] }[] };

/** Raw document (JSON) with the frame's first child (fx_aaaaaaaa) replaced. */
function rawWith(patch: Record<string, unknown>, type = 'effect'): RawDoc {
  const raw = JSON.parse(serializeDocument(fixture())) as RawDoc;
  const node = raw.pages[0]!.frames[0]!.children[0]!;
  delete node.effect;
  node.type = type;
  Object.assign(node, patch);
  return raw;
}

describe('createNode for media', () => {
  it('effect: div with type effect and a copy of the params', () => {
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

  it('video: video tag with type video and vd_ id', () => {
    const n = createVideoNode({ src: 'a.mp4', muted: true });
    expect(n.type).toBe('video');
    expect(n.tag).toBe('video');
    expect(n.id).toMatch(/^vd_/);
    expect(n.video).toEqual({ src: 'a.mp4', muted: true });
    expect(n.name).toBe('Video');
  });

  it('embed: default name per provider and eb_ id', () => {
    const names = EMBED_PROVIDERS.map((provider) => {
      const n = createEmbedNode({ provider, url: 'https://example.com', src: 'a.json', code: '' });
      expect(n.type).toBe('embed');
      expect(n.tag).toBe('div');
      expect(n.id).toMatch(/^eb_/);
      return n.name;
    });
    expect(names).toEqual(['Lottie', 'Rive', 'YouTube', 'Three.js', 'Iframe']);
  });

  it('options: name, styles and position', () => {
    const n = createEffectNode(
      'glass',
      {},
      { name: 'Background', styles: { width: '10px' }, position: { x: 1, y: 2 } },
    );
    expect(n.name).toBe('Background');
    expect(n.style).toEqual({ width: '10px' });
    expect(n.position).toEqual({ x: 1, y: 2 });
  });

  it('mediaAssetRefs lists only assets/ paths (no URLs)', () => {
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

describe('document serialization with media', () => {
  it('passes schema validation', () => {
    const r = validateDocument(fixture());
    expect(r.ok).toBe(true);
  });

  it('JSON round-trip is identical and stable', () => {
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

  it('effect without params defaults to {}', () => {
    const doc = parseDocument(rawWith({ effect: { kind: 'grain' } }));
    expect(findNode(doc, 'fx_aaaaaaaa')!.node.effect).toEqual({ kind: 'grain', params: {} });
  });

  it('rejects a node without the field for its type', () => {
    const raw = rawWith({});
    const r = validateDocument(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toContain('effect node without the effect field');
  });

  it('rejects children on media nodes', () => {
    const raw = rawWith({ effect: { kind: 'grain', params: {} } });
    const child = raw.pages[0]!.frames[0]!.children[1]!;
    raw.pages[0]!.frames[0]!.children[0]!.children = [child];
    const r = validateDocument(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toContain('have no children');
  });

  it.each([
    ['unknown provider', { embed: { provider: 'vimeo', url: 'https://vimeo.com/1' } }],
    ['lottie without src', { embed: { provider: 'lottie' } }],
    [
      'youtube with a url from another site',
      { embed: { provider: 'youtube', url: 'https://example.com' } },
    ],
    ['iframe with javascript:', { embed: { provider: 'iframe', url: 'javascript:alert(1)' } }],
    ['iframe without url', { embed: { provider: 'iframe' } }],
    ['three without code', { embed: { provider: 'three' } }],
    [
      'three above MAX_THREE_CODE',
      { embed: { provider: 'three', code: 'x'.repeat(MAX_THREE_CODE + 1) } },
    ],
    ['param with invalid name', { embed: { provider: 'three', code: '', params: { 'a-b': 1 } } }],
    [
      'param with invalid type (object)',
      { embed: { provider: 'three', code: '', params: { a: { x: 1 } } } },
    ],
    ['text param with quotes', { embed: { provider: 'three', code: '', params: { a: 'x"y' } } }],
  ])('rejects embed: %s', (_name, patch) => {
    expect(validateDocument(rawWith(patch, 'embed')).ok).toBe(false);
  });

  it('accepts three with exactly MAX_THREE_CODE characters', () => {
    const embed = { provider: 'three', code: 'x'.repeat(MAX_THREE_CODE) };
    expect(validateDocument(rawWith({ embed }, 'embed')).ok).toBe(true);
  });

  it.each([
    ['src javascript:', { video: { src: 'javascript:alert(1)' } }],
    ['src data:', { video: { src: 'data:text/html;base64,AAAA' } }],
    ['src with ..', { video: { src: '../secret.mp4' } }],
    ['absolute src', { video: { src: '/etc/passwd' } }],
    ['empty src', { video: { src: '' } }],
    ['poster javascript:', { video: { src: 'a.mp4', poster: 'javascript:alert(1)' } }],
    ['negative time', { video: { src: 'a.mp4', time: -1 } }],
    ['non-boolean autoplay', { video: { src: 'a.mp4', autoplay: 'yes' } }],
  ])('rejects video: %s', (_name, patch) => {
    expect(validateDocument(rawWith(patch, 'video')).ok).toBe(false);
  });

  it('accepts data:image poster and http(s) src', () => {
    const video = { src: 'https://example.com/a.mp4', poster: 'data:image/png;base64,iVBORw0=' };
    expect(validateDocument(rawWith({ video }, 'video')).ok).toBe(true);
  });

  it.each([
    ['kind with uppercase', { effect: { kind: 'Mesh' } }],
    ['empty kind', { effect: { kind: '' } }],
    ['param with null value', { effect: { kind: 'grain', params: { speed: null } } }],
    ['text param with forbidden character', { effect: { kind: 'grain', params: { a: 'x<y' } } }],
  ])('rejects effect: %s', (_name, patch) => {
    expect(validateDocument(rawWith(patch)).ok).toBe(false);
  });
});

describe('mediaRefProblem', () => {
  it('accepts relative path and http(s) URL', () => {
    expect(mediaRefProblem('a/b.mp4')).toBeNull();
    expect(mediaRefProblem('https://example.com/a.mp4?x=1')).toBeNull();
    expect(mediaRefProblem('HTTP://example.com/a')).toBeNull();
  });

  it('rejects dangerous schemes, escaping paths and injection characters', () => {
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

  it('data:image only with allowDataImage', () => {
    const d = 'data:image/png;base64,iVBORw0=';
    expect(mediaRefProblem(d)).not.toBeNull();
    expect(mediaRefProblem(d, { allowDataImage: true })).toBeNull();
    expect(
      mediaRefProblem('data:image/svg+xml;base64,AAAA', { allowDataImage: true }),
    ).not.toBeNull();
  });
});

describe('YouTube and provider detection', () => {
  it.each([
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://youtu.be/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/embed/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://youtube.com/shorts/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/watch?v=short', null],
    ['https://evil.com/watch?v=dQw4w9WgXcQ', null],
    ['https://notyoutube.com/watch?v=dQw4w9WgXcQ', null],
    ['not a url', null],
  ])('youtubeId(%s)', (url, id) => {
    expect(youtubeId(url)).toBe(id);
  });

  it('youtubeStart understands seconds and 1m30s', () => {
    expect(youtubeStart('https://youtu.be/dQw4w9WgXcQ?t=90')).toBe(90);
    expect(youtubeStart('https://youtu.be/dQw4w9WgXcQ?t=1m30s')).toBe(90);
    expect(youtubeStart('https://youtu.be/dQw4w9WgXcQ?start=5')).toBe(5);
    expect(youtubeStart('https://youtu.be/dQw4w9WgXcQ')).toBeUndefined();
  });

  it('youtubeEmbedUrl: cookie-free, autoplay forces mute, loop uses playlist', () => {
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
    expect(detectEmbedProvider('something-without-extension')).toBeNull();
  });
});

describe('op setMedia', () => {
  it('applies effect, video and embed and the inverse restores (immutable)', () => {
    const doc = fixture();
    const before = structuredClone(doc);
    const op = {
      type: 'setMedia' as const,
      changes: [
        { nodeId: 'fx_aaaaaaaa', effect: { kind: 'waves', params: { lines: 5 } } },
        { nodeId: 'vd_aaaaaaaa', video: { src: 'new.mp4', muted: true } },
        { nodeId: 'eb_iframe01', embed: { provider: 'iframe' as const, url: 'https://a.dev/' } },
      ],
    };
    const r = applyOp(doc, op);
    expect(strip(doc)).toEqual(strip(before));
    expect(findNode(r.doc, 'fx_aaaaaaaa')!.node.effect).toEqual({
      kind: 'waves',
      params: { lines: 5 },
    });
    expect(findNode(r.doc, 'vd_aaaaaaaa')!.node.video).toEqual({ src: 'new.mp4', muted: true });
    expect(findNode(r.doc, 'eb_iframe01')!.node.embed!.url).toBe('https://a.dev/');
    const back = applyOps(r.doc, r.inverse);
    expect(strip(back.doc)).toStrictEqual(strip(doc));
  });

  it('does not share references with the op (deepClone)', () => {
    const effect = { kind: 'grain', params: { speed: 1 } };
    const r = applyOp(fixture(), {
      type: 'setMedia',
      changes: [{ nodeId: 'fx_aaaaaaaa', effect }],
    });
    effect.params.speed = 99;
    expect(findNode(r.doc, 'fx_aaaaaaaa')!.node.effect!.params.speed).toBe(1);
  });

  it('requires exactly one field and that it matches the node type', () => {
    const doc = fixture();
    const effect = { kind: 'grain', params: {} };
    const video = { src: 'a.mp4' };
    const run = (c: Record<string, unknown>) =>
      applyOp(doc, { type: 'setMedia', changes: [c as never] });
    expect(() => run({ nodeId: 'fx_aaaaaaaa' })).toThrow(/exactly one/);
    expect(() => run({ nodeId: 'fx_aaaaaaaa', effect, video })).toThrow(/exactly one/);
    expect(() => run({ nodeId: 'vd_aaaaaaaa', effect })).toThrow(/only applies to effect nodes/);
    expect(() => run({ nodeId: 'fr_aaaaaaaa', effect })).toThrow(/is frame/);
    expect(() => run({ nodeId: 'does_not_exist', effect })).toThrow(/not found/i);
  });

  it('multiple changes on the same node undo in reverse order', () => {
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

  it('History: undo restores the previous state and redo reapplies', () => {
    const h = new History(fixture());
    const original = structuredClone(h.doc);
    h.apply(
      [
        {
          type: 'setMedia',
          changes: [{ nodeId: 'eb_three001', embed: { provider: 'three', code: 'return {};' } }],
        },
      ],
      'swap three',
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

  it('createNode with a media node + inverse removes the node', () => {
    const doc = fixture();
    const node = createVideoNode({ src: 'x.mp4' });
    const r = applyOp(doc, { type: 'createNode', parentId: 'fr_aaaaaaaa', node });
    expect(findNode(r.doc, node.id)!.node.video).toEqual({ src: 'x.mp4' });
    const back = applyOps(r.doc, r.inverse);
    expect(findNode(back.doc, node.id)).toBeUndefined();
  });

  it('OpSchema validates setMedia and rejects invalid media', () => {
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
  it('summarizes each media type with its field', () => {
    const doc = fixture();
    const sum = (id: string) => summarizeNode(findNode(doc, id)!.node);
    expect(sum('fx_aaaaaaaa')).toContain('effect:mesh-gradient');
    expect(sum('vd_aaaaaaaa')).toContain('video:clip.mp4');
    expect(sum('eb_youtube1')).toContain('embed:youtube https://youtu.be/dQw4w9WgXcQ');
    expect(sum('eb_lottie01')).toContain('embed:lottie anim.json');
    expect(sum('eb_three001')).toContain('embed:three');
    expect(sum('eb_three001')).not.toContain('return');
  });

  it('document tree lists the media nodes', () => {
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
  ])('rejects %s', (url) => {
    expect(loopbackUrlProblem(url)).toMatch(/loopback/);
  });

  it.each(['https://example.com/', 'https://128.0.0.1/', 'https://notlocalhost.com/'])(
    'accepts %s',
    (url) => {
      expect(loopbackUrlProblem(url)).toBeNull();
    },
  );

  it('EmbedSpecSchema rejects loopback on iframe and YouTube', () => {
    expect(
      EmbedSpecSchema.safeParse({ provider: 'iframe', url: 'http://127.0.0.1:4747/' }).success,
    ).toBe(false);
    expect(
      EmbedSpecSchema.safeParse({ provider: 'iframe', url: 'https://example.com' }).success,
    ).toBe(true);
  });
});

describe('embeds HTML round trip', () => {
  const specs: EmbedSpec[] = [
    { provider: 'lottie', src: 'lottie/anim.json', params: { loop: false } },
    { provider: 'rive', src: 'rive/a.riv', params: { artboard: 'Main', stateMachine: 'SM' } },
    { provider: 'three', code: 'const s = "a & b";\nreturn { scene: s, update(t) {} };' },
    { provider: 'iframe', url: 'https://example.com/page?a=1&b=2' },
    { provider: 'youtube', url: 'https://youtu.be/dQw4w9WgXcQ?t=42', params: { start: 42 } },
  ];

  it.each(specs)('embed node $provider → html → node with the same spec', (spec) => {
    const node = createEmbedNode(spec, { styles: { width: '300px', height: '200px' } });
    const { html, css } = nodesToHtml([node], { mode: 'inline' });
    expect(html).not.toContain('<iframe');
    const [back] = htmlToNodes(html, { css });
    expect(back!.type).toBe('embed');
    expect(back!.embed).toEqual(spec);
    expect(back!.style).toMatchObject({ width: '300px', height: '200px' });
  });

  it('embed with a loopback or invalid url in the HTML is ignored as an embed', () => {
    const [n] = htmlToNodes(
      '<div data-mockup-embed="iframe" data-url="http://127.0.0.1:4747/"></div>',
    );
    expect(n!.type).not.toBe('embed');
  });
});

describe('setMedia with a nonexistent effect kind', () => {
  it('rejects and lists valid kinds', () => {
    const doc = fixture();
    expect(() =>
      applyOp(doc, {
        type: 'setMedia',
        changes: [{ nodeId: 'fx_aaaaaaaa', effect: { kind: 'does-not-exist', params: {} } }],
      }),
    ).toThrow(/Unknown effect "does-not-exist".*mesh-gradient/);
  });
});
