/**
 * Media nodes: effects (`type: 'effect'`), video (`type: 'video'`) and embeds (`type: 'embed'`).
 * Zod schemas for the `effect`/`video`/`embed` fields, provider detection by URL and node factories.
 * No DOM and no Node.
 */
import { z } from 'zod';
import { createNode } from './document.js';
import type {
  EffectSpec,
  EmbedProvider,
  EmbedSpec,
  MediaParamValue,
  Node,
  Position,
  VideoSpec,
} from './types.js';

export const EMBED_PROVIDERS = ['lottie', 'rive', 'youtube', 'three', 'iframe'] as const;

/** Maximum size of a Three.js island's code. */
export const MAX_THREE_CODE = 200_000;

// Text that goes into attributes, CSS and exported code: no < > { } ; " ` \ or control characters.
// eslint-disable-next-line no-control-regex
const SAFE_TEXT = /^[^<>{};"`\\\u0000-\u001f\u007f]*$/;
const PARAM_NAME = /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/;
const HTTP_URL = /^https?:\/\/[^\s"'<>`\\]+$/i;

export const MediaParamValueSchema: z.ZodType<MediaParamValue, unknown> = z.union([
  z.number().finite(),
  z.boolean(),
  z.string().max(300).regex(SAFE_TEXT, { error: 'text with invalid characters' }),
]);

export const MediaParamsSchema = z
  .record(
    z.string().regex(PARAM_NAME, { error: 'invalid param name (use letters and digits)' }),
    MediaParamValueSchema,
  )
  .refine((p) => Object.keys(p).length <= 64, { error: 'too many params (max 64)' });

/** Path relative to `assets/` (no `..`, no leading slash, no scheme) or an http(s) URL. */
export function mediaRefProblem(
  ref: string,
  opts: { allowDataImage?: boolean } = {},
): string | null {
  if (!ref) return 'empty';
  if (
    opts.allowDataImage &&
    /^data:image\/(png|jpeg|gif|webp|avif);base64,[a-z0-9+/=]+$/i.test(ref)
  )
    return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(ref)) {
    return HTTP_URL.test(ref) ? null : 'use a path relative to assets/ or an http(s) URL';
  }
  if (ref.length > 500) return 'path too long';
  if (!SAFE_TEXT.test(ref) || ref.includes("'")) return 'path with invalid characters';
  if (ref.startsWith('/') || ref.split('/').some((s) => s === '..' || s === ''))
    return 'the path must be relative to assets/, with no ".." or empty segments';
  return null;
}

const refSchema = (allowDataImage = false) =>
  z.string().superRefine((v, ctx) => {
    const p = mediaRefProblem(v, { allowDataImage });
    if (p) ctx.addIssue({ code: 'custom', message: p });
  });

/**
 * Error message if the URL points to loopback (localhost, 127.0.0.0/8, 0.0.0.0, ::1, ::),
 * otherwise null. The editor and the render page are served by the daemon on 127.0.0.1: an iframe
 * to that origin would give access to the daemon API.
 */
export function loopbackUrlProblem(url: string): string | null {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  host = host.replace(/\.$/, '');
  let loop =
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '0.0.0.0' ||
    /^127\.\d+\.\d+\.\d+$/.test(host) ||
    host === '::1' ||
    host === '::';
  if (!loop && host.includes(':')) {
    // IPv4-mapped: the URL normalizes ::ffff:127.0.0.1 to ::ffff:7f00:1.
    const m = host.match(/^::ffff:(?:(\d+)\.\d+\.\d+\.\d+|([0-9a-f]{1,4}):[0-9a-f]{1,4})$/);
    if (m) {
      loop = m[1] !== undefined ? m[1] === '127' || m[1] === '0' : /^(7f..|0|0000)$/.test(m[2]!);
    }
  }
  return loop
    ? 'URLs pointing to loopback (localhost/127.0.0.1) are not accepted in iframe/YouTube: they would give access to the Mockup Studio daemon'
    : null;
}

const httpUrlSchema = z
  .string()
  .max(2000)
  .regex(HTTP_URL, { error: 'invalid URL (use http:// or https://)' })
  .superRefine((v, ctx) => {
    const p = loopbackUrlProblem(v);
    if (p) ctx.addIssue({ code: 'custom', message: p });
  });

export const EffectSpecSchema: z.ZodType<EffectSpec, unknown> = z.object({
  kind: z
    .string()
    .regex(/^[a-z][a-z0-9-]{0,40}$/, { error: 'invalid kind (e.g. "mesh-gradient")' }),
  params: MediaParamsSchema.default({}),
});

export const VideoSpecSchema: z.ZodType<VideoSpec, unknown> = z.object({
  src: refSchema(),
  poster: refSchema(true).optional(),
  autoplay: z.boolean().optional(),
  loop: z.boolean().optional(),
  muted: z.boolean().optional(),
  controls: z.boolean().optional(),
  time: z.number().finite().min(0).optional(),
});

export const EmbedSpecSchema: z.ZodType<EmbedSpec, unknown> = z
  .object({
    provider: z.enum(EMBED_PROVIDERS),
    src: refSchema().optional(),
    url: httpUrlSchema.optional(),
    code: z.string().max(MAX_THREE_CODE).optional(),
    params: MediaParamsSchema.optional(),
  })
  .superRefine((e, ctx) => {
    const need = (ok: boolean, message: string) => {
      if (!ok) ctx.addIssue({ code: 'custom', message });
    };
    if (e.provider === 'lottie' || e.provider === 'rive')
      need(!!e.src, `embed ${e.provider} requires src (file in assets/ or http(s) URL)`);
    if (e.provider === 'youtube')
      need(!!e.url && !!youtubeId(e.url), 'embed youtube requires a YouTube video url');
    if (e.provider === 'iframe') need(!!e.url, 'embed iframe requires an http(s) url');
    if (e.provider === 'three') need(typeof e.code === 'string', 'embed three requires code');
  });

/** Media field expected for each node type. */
export const MEDIA_FIELD = { effect: 'effect', video: 'video', embed: 'embed' } as const;
export type MediaType = keyof typeof MEDIA_FIELD;

export function isMediaType(type: string): type is MediaType {
  return type === 'effect' || type === 'video' || type === 'embed';
}

/* ---------------- Provider detection ---------------- */

/** 11-character id from a YouTube URL (watch, youtu.be, embed, shorts, live) or null. */
export function youtubeId(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^(www\.|m\.|music\.)/, '');
  const ok = (id: string | null | undefined) => (id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null);
  if (host === 'youtu.be') return ok(u.pathname.slice(1).split('/')[0]);
  if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (u.pathname === '/watch') return ok(u.searchParams.get('v'));
    const m = u.pathname.match(/^\/(embed|shorts|live|v)\/([^/?#]+)/);
    if (m) return ok(m[2]);
  }
  return null;
}

/** Start time in seconds from a YouTube URL (`t=90`, `t=1m30s`, `start=90`) or undefined. */
export function youtubeStart(url: string): number | undefined {
  try {
    const u = new URL(url);
    const t = u.searchParams.get('t') ?? u.searchParams.get('start');
    if (!t) return undefined;
    if (/^\d+$/.test(t)) return Number(t);
    const m = t.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
    if (!m) return undefined;
    return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
  } catch {
    return undefined;
  }
}

/** Embed URL (cookie-free) of a YouTube video. */
export function youtubeEmbedUrl(
  id: string,
  opts: {
    start?: number;
    autoplay?: boolean;
    loop?: boolean;
    muted?: boolean;
    controls?: boolean;
  } = {},
): string {
  const q = new URLSearchParams();
  if (opts.start) q.set('start', String(Math.floor(opts.start)));
  if (opts.autoplay) q.set('autoplay', '1');
  if (opts.muted || opts.autoplay) q.set('mute', '1');
  if (opts.loop) {
    q.set('loop', '1');
    q.set('playlist', id);
  }
  if (opts.controls === false) q.set('controls', '0');
  q.set('rel', '0');
  q.set('playsinline', '1');
  return `https://www.youtube-nocookie.com/embed/${id}?${q.toString()}`;
}

/**
 * Embed provider from a URL or path: YouTube, `.json`/`.lottie` (Lottie),
 * `.riv` (Rive), video files (`video`) or any other http(s) URL (`iframe`).
 */
export function detectEmbedProvider(urlOrPath: string): EmbedProvider | 'video' | null {
  const s = urlOrPath.trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s) && youtubeId(s)) return 'youtube';
  const pathPart = s.split(/[?#]/)[0]!.toLowerCase();
  if (/\.(json|lottie)$/.test(pathPart) || /lottiefiles\.com/i.test(s)) return 'lottie';
  if (/\.riv$/.test(pathPart)) return 'rive';
  if (/\.(mp4|webm|mov|m4v|ogv)$/.test(pathPart)) return 'video';
  if (/^https?:\/\//i.test(s)) return 'iframe';
  return null;
}

/* ---------------- Factories ---------------- */

export interface MediaNodeOptions {
  name?: string;
  styles?: Record<string, string>;
  position?: Position;
}

/** Style of an effect used as a background: covers the parent, behind the in-flow content. */
export const EFFECT_BACKGROUND_STYLE: Readonly<Record<string, string>> = {
  position: 'absolute',
  inset: '0',
  width: '100%',
  height: '100%',
  'z-index': '-1',
  'pointer-events': 'none',
};

export function createEffectNode(
  kind: string,
  params: Record<string, MediaParamValue> = {},
  opts: MediaNodeOptions = {},
): Node {
  const node = createNode({
    tag: 'div',
    type: 'effect',
    name: opts.name ?? 'Effect',
    style: opts.styles ?? {},
    position: opts.position,
  });
  node.effect = { kind, params: { ...params } };
  return node;
}

export function createVideoNode(spec: VideoSpec, opts: MediaNodeOptions = {}): Node {
  const node = createNode({
    tag: 'video',
    type: 'video',
    name: opts.name ?? 'Video',
    style: opts.styles ?? {},
    position: opts.position,
  });
  node.video = { ...spec };
  return node;
}

export function createEmbedNode(spec: EmbedSpec, opts: MediaNodeOptions = {}): Node {
  const names: Record<EmbedProvider, string> = {
    lottie: 'Lottie',
    rive: 'Rive',
    youtube: 'YouTube',
    three: 'Three.js',
    iframe: 'Iframe',
  };
  const node = createNode({
    tag: 'div',
    type: 'embed',
    name: opts.name ?? names[spec.provider],
    style: opts.styles ?? {},
    position: opts.position,
  });
  node.embed = { ...spec, ...(spec.params ? { params: { ...spec.params } } : {}) };
  return node;
}

/** `assets/` references of a media node (video src/poster, lottie/rive src), excluding URLs. */
export function mediaAssetRefs(node: Node): string[] {
  const out: string[] = [];
  const add = (r: string | undefined) => {
    if (r && !/^[a-z][a-z0-9+.-]*:/i.test(r)) out.push(r);
  };
  if (node.video) {
    add(node.video.src);
    add(node.video.poster);
  }
  if (node.embed) add(node.embed.src);
  return out;
}

/** Default code of a Three.js island (function body; see docs/EMBEDS.md). */
export const DEFAULT_THREE_CODE = `// Variables: THREE, renderer, canvas, width, height, params.
// Return { scene, camera, update(t) } (t in seconds).
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100);
camera.position.set(0, 0, 6);
const geometry = new THREE.TorusKnotGeometry(1.2, 0.38, 220, 32);
const material = new THREE.MeshStandardMaterial({ color: params.color ?? '#7c5cff', metalness: 0.6, roughness: 0.25 });
const mesh = new THREE.Mesh(geometry, material);
scene.add(mesh);
scene.add(new THREE.AmbientLight(0xffffff, 0.4));
const light = new THREE.DirectionalLight(0xffffff, 2.2);
light.position.set(3, 4, 5);
scene.add(light);
return {
  scene,
  camera,
  update(t) {
    mesh.rotation.x = t * 0.4;
    mesh.rotation.y = t * 0.6;
  },
};
`;
