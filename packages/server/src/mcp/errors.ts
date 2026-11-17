/** Formatação, em português, dos erros de validação de parâmetros e de ferramenta inexistente. */

/** Subconjunto de `z.core.$ZodIssue` que usamos (tipado frouxo para cobrir todas as variantes). */
export interface InputIssue {
  code: string;
  path: PropertyKey[];
  message: string;
  expected?: string;
  values?: unknown[];
  origin?: string;
  minimum?: number | bigint;
  maximum?: number | bigint;
  inclusive?: boolean;
  keys?: string[];
  errors?: InputIssue[][];
}

const TYPE_NAMES: Record<string, string> = {
  string: 'texto (string)',
  number: 'número (number)',
  int: 'número inteiro (integer)',
  boolean: 'booleano (boolean)',
  array: 'lista (array)',
  object: 'objeto (object)',
  record: 'objeto (object)',
  null: 'null',
};

const typeName = (t: string | undefined): string => (t ? (TYPE_NAMES[t] ?? t) : 'valor válido');

function getAt(value: unknown, path: PropertyKey[]): unknown {
  let cur = value;
  for (const k of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<PropertyKey, unknown>)[k];
  }
  return cur;
}

function fieldOf(path: PropertyKey[]): string {
  if (!path.length) return '(argumentos)';
  return path.reduce<string>(
    (acc, k) => (typeof k === 'number' ? `${acc}[${k}]` : acc ? `${acc}.${String(k)}` : String(k)),
    '',
  );
}

/** Descreve o valor recebido: tipo e, para primitivos curtos, o próprio valor. */
function describeReceived(v: unknown): string {
  if (v === undefined) return 'ausente';
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'lista (array)';
  if (typeof v === 'string')
    return `texto (string) ${JSON.stringify(v.length > 40 ? `${v.slice(0, 39)}…` : v)}`;
  if (typeof v === 'number') return `número (number) ${v}`;
  if (typeof v === 'boolean') return `booleano (boolean) ${v}`;
  return 'objeto (object)';
}

const list = (vals: unknown[]): string => vals.map((v) => JSON.stringify(v)).join(', ');

function bound(i: InputIssue, kind: 'min' | 'max'): string {
  const n = String(kind === 'min' ? i.minimum : i.maximum);
  const incl = i.inclusive !== false;
  const origin = i.origin ?? 'number';
  if (origin === 'array' || origin === 'set') {
    return kind === 'min'
      ? `a lista deve ter pelo menos ${n} item(ns)`
      : `a lista deve ter no máximo ${n} item(ns)`;
  }
  if (origin === 'string') {
    return kind === 'min'
      ? `o texto deve ter pelo menos ${n} caractere(s)`
      : `o texto deve ter no máximo ${n} caractere(s)`;
  }
  if (kind === 'min')
    return incl ? `o valor deve ser maior ou igual a ${n}` : `o valor deve ser maior que ${n}`;
  return incl ? `o valor deve ser menor ou igual a ${n}` : `o valor deve ser menor que ${n}`;
}

function describeIssue(i: InputIssue, args: unknown): string {
  const received = getAt(args, i.path);
  switch (i.code) {
    case 'invalid_type':
      return received === undefined
        ? `obrigatório e ausente (esperado: ${typeName(i.expected)})`
        : `tipo incorreto: esperado ${typeName(i.expected)}, recebido ${describeReceived(received)}`;
    case 'invalid_value': {
      const vals = i.values ?? [];
      return `valor inválido (recebido ${received === undefined ? 'ausente' : JSON.stringify(received)}); use ${vals.length > 1 ? 'um de' : ''}: ${list(vals)}`.replace(
        '; use : ',
        '; use ',
      );
    }
    case 'too_small':
      return bound(i, 'min');
    case 'too_big':
      return bound(i, 'max');
    case 'unrecognized_keys':
      return `parâmetro(s) desconhecido(s): ${(i.keys ?? []).join(', ')}`;
    case 'invalid_union': {
      const branches = (i.errors ?? []).flat();
      const literals = branches
        .filter((b) => b.code === 'invalid_value')
        .flatMap((b) => b.values ?? []);
      if (branches.length && literals.length === branches.length) {
        return `valor inválido (recebido ${received === undefined ? 'ausente' : JSON.stringify(received)}); use um de: ${list(literals)}`;
      }
      const types = [
        ...new Set(
          branches.filter((b) => b.code === 'invalid_type').map((b) => typeName(b.expected)),
        ),
      ];
      if (types.length) {
        return received === undefined
          ? `obrigatório e ausente (esperado: ${types.join(' ou ')})`
          : `tipo incorreto: esperado ${types.join(' ou ')}, recebido ${describeReceived(received)}`;
      }
      return i.message;
    }
    default:
      return i.message;
  }
}

/** Mensagem de erro de parâmetros: um item por campo e uma chamada de exemplo. */
export function formatToolInputError(
  tool: string,
  issues: readonly InputIssue[],
  args: unknown,
  example: Record<string, unknown> | undefined,
): string {
  const lines = issues.map((i) => `- ${fieldOf(i.path)}: ${describeIssue(i, args)}.`);
  return [
    `Parâmetros inválidos em ${tool}:`,
    ...lines,
    `Exemplo: ${tool}(${JSON.stringify(example ?? {})})`,
  ].join('\n');
}

/** Distância de edição simples (para sugerir nomes de ferramenta parecidos). */
function distance(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]!;
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j]!;
      dp[j] = Math.min(dp[j]! + 1, dp[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length]!;
}

export function notFoundToolMessage(name: string, available: string[]): string {
  const words = name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2);
  const scored = available
    .map((n) => {
      const hits = words.filter((w) => n.includes(w)).length;
      return { n, score: hits * 10 - distance(name.toLowerCase(), n) };
    })
    .filter((x) => x.score > -6)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((x) => x.n);
  return `Ferramenta "${name}" não existe.${
    scored.length ? ` Ferramentas parecidas: ${scored.join(', ')}.` : ''
  } Veja a lista de ferramentas do servidor ou get_guide('getting-started').`;
}
