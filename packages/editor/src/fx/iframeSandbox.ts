/**
 * `sandbox` attribute of the iframe embed. External pages keep `allow-same-origin` (many need
 * their own localStorage/cookies). If the URL is loopback or from the editor's own origin, the
 * page without `allow-same-origin` gets an opaque origin and cannot reach the daemon (`/api`, `/mcp`, WS) or
 * the editor's localStorage, but still renders (e.g. previewing a local dev server).
 */
const BASE = 'allow-scripts allow-popups';

/** Loopback hostname: localhost, *.localhost, 127.0.0.0/8, 0.0.0.0, ::1 (and mapped IPv4). */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '0.0.0.0' || h === '::1' || h === '::') return true;
  const v4 = /^(\d+)\.\d+\.\d+\.\d+$/.exec(h);
  if (v4) return Number(v4[1]) === 127;
  // ::ffff:7f00:1 (normalized form of ::ffff:127.0.0.1) and ::ffff:127.x.y.z
  if (/^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(h)) return true;
  return /^::ffff:127\./.test(h);
}

/** `sandbox` value for `url`, given `origin` (`window.location.origin`). */
export function iframeSandbox(url: string, origin: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return BASE;
  }
  if (isLoopbackHost(u.hostname) || u.origin === origin) return BASE;
  return 'allow-scripts allow-same-origin allow-popups';
}
