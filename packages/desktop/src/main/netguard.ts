/**
 * Classification of network destinations for the capture window (pure functions, no Electron). The main
 * navigation may go to any http(s) (including the user's dev server on localhost), but a page's
 * subrequests may only reach local/private addresses when they are from the SAME
 * origin as the main page.
 */

/** Protocols with no network (or local to the document): always allowed. */
const LOCAL_PROTOCOLS = new Set(['data:', 'blob:', 'about:']);
/** Network protocols evaluated by the guard (ws/wss count as http/https when comparing origins). */
const NET_PROTOCOLS = new Set(['http:', 'https:', 'ws:', 'wss:']);

export type SubrequestDecision = 'allow' | 'block' | 'resolve';

function parseIPv4(s: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const p = m.slice(1).map(Number);
  return p.every((n) => n <= 255) ? p : null;
}

/** Expands an IPv6 (with `::`, zone and/or trailing IPv4) into 8 groups of 16 bits. */
function parseIPv6(raw: string): number[] | null {
  let s = raw.replace(/^\[|\]$/g, '');
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  if (!s.includes(':')) return null;
  const tail = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (tail) {
    const v4 = parseIPv4(tail[1]!);
    if (!v4) return null;
    const hex = (a: number, b: number): string => ((a << 8) | b).toString(16);
    s = s.slice(0, tail.index) + `${hex(v4[0]!, v4[1]!)}:${hex(v4[2]!, v4[3]!)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const toGroups = (part: string): number[] | null => {
    if (part === '') return [];
    const out: number[] = [];
    for (const g of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = toGroups(halves[0]!);
  if (!head) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const rest = toGroups(halves[1]!);
  if (!rest || head.length + rest.length > 7) return null;
  return [...head, ...new Array<number>(8 - head.length - rest.length).fill(0), ...rest];
}

function isPrivateIPv4(p: number[]): boolean {
  const [a, b] = [p[0]!, p[1]!];
  return (
    a === 127 || // loopback
    a === 10 ||
    a === 0 || // 0.0.0.0/8
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) || // link-local
    (a === 100 && b >= 64 && b <= 127) // CGNAT 100.64/10
  );
}

/** Classifies an IP literal (v4 or v6, with or without brackets): loopback/private/link-local/etc. */
export function isPrivateAddress(addr: string): boolean {
  const v4 = parseIPv4(addr);
  if (v4) return isPrivateIPv4(v4);
  const g = parseIPv6(addr);
  if (!g) return false;
  // Embedded IPv4: ::a.b.c.d / ::ffff:a.b.c.d (mapped) / 64:ff9b::a.b.c.d (NAT64). The 96 high
  // bits being zero also cover `::` and `::1` (they become 0.0.0.x).
  const embedded = [g[6]! >> 8, g[6]! & 255, g[7]! >> 8, g[7]! & 255];
  const zeros = g.slice(0, 5).every((x) => x === 0);
  if (zeros && (g[5] === 0 || g[5] === 0xffff)) return isPrivateIPv4(embedded);
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0))
    return isPrivateIPv4(embedded);
  if ((g[0]! & 0xfe00) === 0xfc00) return true; // fc00::/7 (ULA)
  if ((g[0]! & 0xffc0) === 0xfe80) return true; // fe80::/10 (link-local)
  return false;
}

/** `true` for `localhost` and `*.localhost` (Chromium resolves these names to loopback). */
export function isLocalhostName(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return h === 'localhost' || h.endsWith('.localhost');
}

/** Normalized origin (`http://host:port`); ws/wss count as http/https. `null` if invalid. */
export function originOf(rawUrl: string): string | null {
  try {
    const u = new URL(rawUrl);
    if (!NET_PROTOCOLS.has(u.protocol)) return null;
    const secure = u.protocol === 'https:' || u.protocol === 'wss:';
    return `${secure ? 'https' : 'http'}://${u.hostname.toLowerCase()}:${u.port || (secure ? '443' : '80')}`;
  } catch {
    return null;
  }
}

/**
 * Decision for a SUBREQUEST (image, CSS, font, fetch, iframe, websocket...).
 * - `allow`: allowed; `block`: cancel; `resolve`: apparently public hostname, must resolve the
 *   DNS and block if any address is private (see `isPrivateAddress`).
 * `trustedOrigin` is the main page's origin: private destinations only pass if they are from that origin.
 */
export function subrequestDecision(
  rawUrl: string,
  trustedOrigin: string | null,
): SubrequestDecision {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return 'block';
  }
  if (LOCAL_PROTOCOLS.has(u.protocol)) return 'allow';
  if (!NET_PROTOCOLS.has(u.protocol)) return 'block';
  if (trustedOrigin && originOf(rawUrl) === trustedOrigin) return 'allow';
  const host = u.hostname;
  if (isLocalhostName(host)) return 'block';
  if (host.startsWith('[') || parseIPv4(host)) return isPrivateAddress(host) ? 'block' : 'allow';
  return 'resolve';
}
