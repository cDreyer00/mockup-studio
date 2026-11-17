/** Formatting of parameter validation errors and unknown-tool errors, in English. */

/** Subset of `z.core.$ZodIssue` that we use (loosely typed to cover all variants). */
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
  string: 'text (string)',
  number: 'number',
  int: 'integer',
  boolean: 'boolean',
  array: 'list (array)',
  object: 'objeto (object)',
  record: 'objeto (object)',
  null: 'null',
};

const typeName = (t: string | undefined): string => (t ? (TYPE_NAMES[t] ?? t) : 'valid value');

function getAt(value: unknown, path: PropertyKey[]): unknown {
  let cur = value;
  for (const k of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<PropertyKey, unknown>)[k];
  }
  return cur;
}

function fieldOf(path: PropertyKey[]): string {
  if (!path.length) return '(arguments)';
  return path.reduce<string>(
    (acc, k) => (typeof k === 'number' ? `${acc}[${k}]` : acc ? `${acc}.${String(k)}` : String(k)),
    '',
  );
}

/** Describes the received value: its type and, for short primitives, the value itself. */
function describeReceived(v: unknown): string {
  if (v === undefined) return 'missing';
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'list (array)';
  if (typeof v === 'string')
    return `text (string) ${JSON.stringify(v.length > 40 ? `${v.slice(0, 39)}…` : v)}`;
  if (typeof v === 'number') return `number ${v}`;
  if (typeof v === 'boolean') return `boolean ${v}`;
  return 'objeto (object)';
}

const list = (vals: unknown[]): string => vals.map((v) => JSON.stringify(v)).join(', ');

function bound(i: InputIssue, kind: 'min' | 'max'): string {
  const n = String(kind === 'min' ? i.minimum : i.maximum);
  const incl = i.inclusive !== false;
  const origin = i.origin ?? 'number';
  if (origin === 'array' || origin === 'set') {
    return kind === 'min'
      ? `the list must have at least ${n} item(s)`
      : `the list must have at most ${n} item(s)`;
  }
  if (origin === 'string') {
    return kind === 'min'
      ? `the text must have at least ${n} character(s)`
      : `the text must have at most ${n} character(s)`;
  }
  if (kind === 'min')
    return incl
      ? `the value must be greater than or equal to ${n}`
      : `the value must be greater than ${n}`;
  return incl ? `the value must be less than or equal to ${n}` : `the value must be less than ${n}`;
}

function describeIssue(i: InputIssue, args: unknown): string {
  const received = getAt(args, i.path);
  switch (i.code) {
    case 'invalid_type':
      return received === undefined
        ? `required and missing (expected: ${typeName(i.expected)})`
        : `wrong type: expected ${typeName(i.expected)}, received ${describeReceived(received)}`;
    case 'invalid_value': {
      const vals = i.values ?? [];
      return `invalid value (received ${received === undefined ? 'missing' : JSON.stringify(received)}); use ${vals.length > 1 ? 'one of' : ''}: ${list(vals)}`.replace(
        '; use : ',
        '; use ',
      );
    }
    case 'too_small':
      return bound(i, 'min');
    case 'too_big':
      return bound(i, 'max');
    case 'unrecognized_keys':
      return `unknown parameter(s): ${(i.keys ?? []).join(', ')}`;
    case 'invalid_union': {
      const branches = (i.errors ?? []).flat();
      const literals = branches
        .filter((b) => b.code === 'invalid_value')
        .flatMap((b) => b.values ?? []);
      if (branches.length && literals.length === branches.length) {
        return `invalid value (received ${received === undefined ? 'missing' : JSON.stringify(received)}); use one of: ${list(literals)}`;
      }
      const types = [
        ...new Set(
          branches.filter((b) => b.code === 'invalid_type').map((b) => typeName(b.expected)),
        ),
      ];
      if (types.length) {
        return received === undefined
          ? `required and missing (expected: ${types.join(' or ')})`
          : `wrong type: expected ${types.join(' or ')}, received ${describeReceived(received)}`;
      }
      return i.message;
    }
    default:
      return i.message;
  }
}

/** Parameter error message: one item per field and an example call. */
export function formatToolInputError(
  tool: string,
  issues: readonly InputIssue[],
  args: unknown,
  example: Record<string, unknown> | undefined,
): string {
  const lines = issues.map((i) => `- ${fieldOf(i.path)}: ${describeIssue(i, args)}.`);
  return [
    `Invalid parameters in ${tool}:`,
    ...lines,
    `Example: ${tool}(${JSON.stringify(example ?? {})})`,
  ].join('\n');
}

/** Simple edit distance (to suggest similar tool names). */
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
  return `Tool "${name}" does not exist.${
    scored.length ? ` Similar tools: ${scored.join(', ')}.` : ''
  } See the server's tool list or get_guide('getting-started').`;
}
