/** Pure logic of the assets panel: filtering, sorting and formatting. */
import type { AssetInfo } from '../client/api';

export interface AssetFilter {
  query: string;
  unusedOnly: boolean;
}

function fold(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** Filters by name/path (accent- and case-insensitive) and by "unused"; sorts by path. */
export function filterAssets(assets: readonly AssetInfo[], f: AssetFilter): AssetInfo[] {
  const q = fold(f.query.trim());
  return assets
    .filter((a) => (!f.unusedOnly || a.uses === 0) && (!q || fold(a.path).includes(q)))
    .sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
}

/** "1.2 MB", "340 KB", "12 B". */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Before/after KB text for the optimizer toast. */
export function optimizeSummary(
  results: readonly { before: number; after: number }[],
  skipped: number,
): string {
  if (!results.length) return 'Nothing to optimize.';
  const before = results.reduce((s, r) => s + r.before, 0);
  const after = results.reduce((s, r) => s + r.after, 0);
  const kb = (n: number) => `${Math.round(n / 1024)} KB`;
  const n = results.length;
  const ignored = skipped ? ` (${skipped} skipped)` : '';
  return `${n} ${n === 1 ? 'image optimized' : 'images optimized'}: ${kb(before)} → ${kb(after)}${ignored}`;
}
