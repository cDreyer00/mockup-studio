/** Lógica pura do painel de assets: filtro, ordenação e formatação. */
import type { AssetInfo } from '../client/api';

export interface AssetFilter {
  query: string;
  unusedOnly: boolean;
}

function fold(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** Filtra por nome/caminho (sem acento nem caixa) e por "não usados"; ordena por caminho. */
export function filterAssets(assets: readonly AssetInfo[], f: AssetFilter): AssetInfo[] {
  const q = fold(f.query.trim());
  return assets
    .filter((a) => (!f.unusedOnly || a.uses === 0) && (!q || fold(a.path).includes(q)))
    .sort((a, b) => a.path.localeCompare(b.path, 'pt-BR', { numeric: true }));
}

/** "1,2 MB", "340 KB", "12 B". */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
}

/** Texto de KB antes/depois para o toast do otimizador. */
export function optimizeSummary(
  results: readonly { before: number; after: number }[],
  skipped: number,
): string {
  if (!results.length) return 'Nada para otimizar.';
  const before = results.reduce((s, r) => s + r.before, 0);
  const after = results.reduce((s, r) => s + r.after, 0);
  const kb = (n: number) => `${Math.round(n / 1024)} KB`;
  const n = results.length;
  const ignored = skipped ? ` (${skipped} ignorada${skipped === 1 ? '' : 's'})` : '';
  return `${n} ${n === 1 ? 'imagem otimizada' : 'imagens otimizadas'}: ${kb(before)} → ${kb(after)}${ignored}`;
}
