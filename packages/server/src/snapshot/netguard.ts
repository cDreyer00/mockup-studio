/**
 * SSRF protection for asset downloads during import: the daemon downloads URLs coming from the payload
 * (extension, clipboard, capture window), so local-network destinations are rejected, except those of
 * the same origin as the imported page (`trustedOrigin`, e.g. a dev server on localhost).
 * The check happens at the connection's own DNS resolution (`lookup` option), leaving no window for
 * DNS rebinding, and at every redirect.
 */
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

export const MAX_REDIRECTS = 5;

/** IPv4 address as 4 octets, or `null` if the text is not a valid IPv4. */
function parseV4(ip: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  return o.every((n) => n <= 255) ? o : null;
}

function isPrivateV4(o: number[]): boolean {
  const [a, b, c] = o as [number, number, number, number];
  return (
    a === 0 || // 0.0.0.0/8
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64/10
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0) || // 192.0.0.0/24
    (a === 192 && b === 0 && c === 2) || // documentation
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224 // multicast and reserved (includes 255.255.255.255)
  );
}

/** Expands an IPv6 into 8 groups of 16 bits (accepts `::` and trailing IPv4); `null` if invalid. */
function parseV6(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (tail) {
    const v4 = parseV4(tail[1]!);
    if (!v4) return null;
    const hex = (a: number, b: number): string => ((a << 8) | b).toString(16);
    s = `${s.slice(0, -tail[1]!.length)}${hex(v4[0]!, v4[1]!)}:${hex(v4[2]!, v4[3]!)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...rest];
  if (groups.length !== 8) return null;
  const out = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return out.some(Number.isNaN) ? null : out;
}

function isPrivateV6(g: number[]): boolean {
  const g0 = g[0]!;
  const embeddedV4 = (hi: number, lo: number): number[] => [hi >> 8, hi & 255, lo >> 8, lo & 255];
  if (g.slice(0, 5).every((x) => x === 0)) {
    if (g[5] === 0xffff) return isPrivateV4(embeddedV4(g[6]!, g[7]!)); // ::ffff:a.b.c.d
    if (g[5] === 0) return true; // :: , ::1 and IPv4-compatible (obsolete)
  }
  // NAT64 (64:ff9b::/96): the embedded IPv4 applies
  if (g0 === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
    return isPrivateV4(embeddedV4(g[6]!, g[7]!));
  }
  return (
    (g0 & 0xfe00) === 0xfc00 || // fc00::/7 (ULA)
    (g0 & 0xffc0) === 0xfe80 || // fe80::/10 (link-local)
    (g0 & 0xffc0) === 0xfec0 || // fec0::/10 (site-local, obsolete)
    (g0 & 0xff00) === 0xff00 || // multicast
    (g0 === 0x2001 && g[1] === 0x0db8) // documentation
  );
}

/** `true` for loopback, private networks, link-local, CGNAT, multicast, reserved and mapped IPv4. */
export function isPrivateAddress(ip: string): boolean {
  const host = ip.startsWith('[') && ip.endsWith(']') ? ip.slice(1, -1) : ip;
  const v4 = parseV4(host);
  if (v4) return isPrivateV4(v4);
  const v6 = parseV6(host);
  // text that is not an IP: treated as blocked for safety
  return v6 ? isPrivateV6(v6) : true;
}

const blockedMessage = (host: string): string => `local-network destination blocked: ${host}`;

const hostnameOf = (u: URL): string =>
  u.hostname.startsWith('[') ? u.hostname.slice(1, -1) : u.hostname;

function originOf(url: string): string | null {
  try {
    const o = new URL(url).origin;
    return o === 'null' ? null : o;
  } catch {
    return null;
  }
}

/** `lookup` for `net.connect`: resolves all addresses and rejects if any is private. */
function guardedLookup(
  hostname: string,
  options: dns.LookupOptions,
  cb: (
    err: NodeJS.ErrnoException | null,
    address: string | dns.LookupAddress[],
    family?: number,
  ) => void,
): void {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return cb(err, '', 0);
    const bad = addresses.find((a) => isPrivateAddress(a.address));
    if (bad) return cb(new Error(blockedMessage(hostname)), '', 0);
    if (options.all) return cb(null, addresses);
    const first = addresses[0];
    if (!first) return cb(new Error(`no address for ${hostname}`), '', 0);
    cb(null, first.address, first.family);
  });
}

export interface GuardedFetchOptions {
  maxBytes: number;
  timeoutMs?: number;
  /** Origin (protocol+host+port) allowed to point to the local network, e.g. the imported page's. */
  trustedOrigin?: string;
}

export interface GuardedFetchResult {
  bytes: Buffer;
  contentType: string;
}

interface Hop {
  status: number;
  location?: string;
  contentType: string;
  body: Buffer;
}

function requestOnce(
  url: URL,
  guard: boolean,
  opts: { maxBytes: number; deadline: number },
): Promise<Hop> {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const remaining = Math.max(1, opts.deadline - Date.now());
    const tooBig = new Error(
      `the file exceeds the limit of ${Math.round(opts.maxBytes / 1024 / 1024)} MB`,
    );
    const req = lib.request(
      url,
      { method: 'GET', ...(guard ? { lookup: guardedLookup } : {}), timeout: remaining },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = res.headers.location;
        if (status >= 300 && status < 400 && location) {
          res.resume();
          resolve({ status, location, contentType: '', body: Buffer.alloc(0) });
          return;
        }
        if (status < 200 || status >= 300) {
          res.resume();
          reject(new Error(`HTTP ${status}`));
          return;
        }
        if (Number(res.headers['content-length'] ?? 0) > opts.maxBytes) {
          res.destroy();
          reject(tooBig);
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        res.on('data', (c: Buffer) => {
          total += c.length;
          if (total > opts.maxBytes) {
            res.destroy();
            reject(tooBig);
            return;
          }
          chunks.push(c);
        });
        res.on('end', () =>
          resolve({
            status,
            contentType: String(res.headers['content-type'] ?? '')
              .split(';')[0]!
              .trim()
              .toLowerCase(),
            body: Buffer.concat(chunks),
          }),
        );
        res.on('error', reject);
        res.on('aborted', () => reject(new Error('connection interrupted')));
      },
    );
    req.on('timeout', () => req.destroy(new Error('download timed out')));
    req.on('error', reject);
    req.end();
  });
}

/**
 * Downloads an http(s) URL rejecting local-network destinations (except the trusted origin), following up to
 * `MAX_REDIRECTS` redirects (each hop is checked again), with a byte limit and timeout.
 */
export async function guardedFetchBytes(
  rawUrl: string,
  opts: GuardedFetchOptions,
): Promise<GuardedFetchResult> {
  const deadline = Date.now() + (opts.timeoutMs ?? 20_000);
  const trusted = opts.trustedOrigin ? originOf(opts.trustedOrigin) : null;
  let current: URL;
  try {
    current = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (current.protocol !== 'http:' && current.protocol !== 'https:')
      throw new Error('only http(s) can be downloaded');
    const isTrusted = trusted !== null && current.origin === trusted;
    const host = hostnameOf(current);
    // A literal IP does not go through `lookup`: check it here
    if (!isTrusted && net.isIP(host) && isPrivateAddress(host)) {
      throw new Error(blockedMessage(host));
    }
    const r = await requestOnce(current, !isTrusted, { maxBytes: opts.maxBytes, deadline });
    if (r.location) {
      try {
        current = new URL(r.location, current);
      } catch {
        throw new Error('redirect with invalid URL');
      }
      continue;
    }
    return { bytes: r.body, contentType: r.contentType };
  }
  throw new Error(`too many redirects (max ${MAX_REDIRECTS})`);
}
