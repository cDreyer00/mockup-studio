/**
 * Atributo `sandbox` do embed iframe. Páginas externas mantêm `allow-same-origin` (muitas precisam
 * de localStorage/cookies próprios). Se a URL é de loopback ou da própria origem do editor, a
 * página sem `allow-same-origin` ganha origem opaca e não alcança o daemon (`/api`, `/mcp`, WS) nem
 * o localStorage do editor, mas continua renderizando (ex.: pré-visualizar um dev server local).
 */
const BASE = 'allow-scripts allow-popups';

/** Hostname de loopback: localhost, *.localhost, 127.0.0.0/8, 0.0.0.0, ::1 (e IPv4 mapeado). */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '0.0.0.0' || h === '::1' || h === '::') return true;
  const v4 = /^(\d+)\.\d+\.\d+\.\d+$/.exec(h);
  if (v4) return Number(v4[1]) === 127;
  // ::ffff:7f00:1 (forma normalizada de ::ffff:127.0.0.1) e ::ffff:127.x.y.z
  if (/^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(h)) return true;
  return /^::ffff:127\./.test(h);
}

/** Valor de `sandbox` para `url`, dado `origin` (`window.location.origin`). */
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
