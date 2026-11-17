/**
 * Componentes no export React (ver `docs/COMPONENTES.md`, seção Exportação, e `docs/EXPORT.md`).
 *
 * Cada principal usado pelas raízes exportadas vira `export interface XProps` + `export function X`,
 * com as props tipadas, as variantes como estilos/classes condicionais e os slots como
 * `ReactNode`. As instâncias viram JSX (`<Button variant="outline" label="Salvar" />`). Instância com
 * overrides em nós internos (ou qualquer coisa que as props não expressem) sai expandida no lugar.
 *
 * Este módulo é chamado pelo `react.ts` por ganchos em `RenderCtx` (`components` e `scope`) e usa os
 * helpers de emissão dele (há um ciclo de import só entre funções, resolvido em tempo de chamada).
 */
import { expandInstance, getComponent, resolveProps, SLOT_ATTR } from '../components/expand.js';
import { cssValueProblem } from '../styles.js';
import type { ComponentDef, Document, Node, PropDef, PropValue } from '../types.js';
import { prepareTree } from './common.js';
import {
  RESERVED,
  attrValue,
  componentIdent,
  emitElement,
  fieldIdent,
  jsString,
  pad,
  reactStyleKey,
  renderChildren,
  renderNode,
  styleParts,
  styleProp,
  textChildren,
} from './react.js';
import type { RenderCtx } from './react.js';

/** Ganchos usados pelo `renderNode` enquanto renderiza o corpo de um principal. */
export interface ScopeHooks {
  /** `className`/`style` do nó (props mescladas na raiz, variantes e `{{prop}}`). */
  styleProps(node: Node, ctx: RenderCtx): string[];
  /** Valor de atributo (`"literal"` ou `{expressão}`) para um texto que pode ter `{{prop}}`. */
  attrValue(v: string): string;
  hasPlaceholder(v: string): boolean;
  /** Filhos de texto do nó; `undefined` quando o texto é estático. */
  textChildren(node: Node, pre: boolean): string[] | undefined;
  /** Filhos de um contêiner de slot (`{content ?? ...}`); `undefined` se o nó não é contêiner. */
  slotChildren(node: Node, depth: number, ctx: RenderCtx, pre: boolean): string[][] | undefined;
  /** Expressão JS de um valor de estilo que pode ter `{{prop}}`. */
  valueExpr(v: string): string;
}

export interface ComponentSupport {
  renderInstance(
    node: Node,
    depth: number,
    ctx: RenderCtx,
    pre: boolean,
    isRoot: boolean,
    extraProps: string[],
  ): string[];
  /** Código (interface + função) de cada principal usado, incluindo os usados por outros principais. */
  renderAll(): string[];
}

/* ====================================================================== */
/* Props                                                                   */
/* ====================================================================== */

const PLACEHOLDER_RE = /\{\{\s*([A-Za-z_][\w-]*)\s*\}\}/g;

/** Nomes que não servem de prop gerada (colidem com o que o componente já declara ou com JS). */
const EXTRA_BAD_PROP_NAMES = [
  'className',
  'style',
  'children',
  'key',
  'ref',
  'props',
  'arguments',
  'eval',
  'undefined',
  'NaN',
  'Infinity',
  'String',
  'Boolean',
];

interface PropInfo {
  def: PropDef;
  /** Identificador JS (nome da prop no JSX e variável no corpo). */
  ident: string;
  /** Valores aceitos de um enum (opções + padrão). */
  options: string[];
  /** Padrão tipado (ausente em slots). */
  fallback?: PropValue;
}

function propIdent(name: string, taken: Set<string>): string {
  let base = /^[A-Za-z_$][\w$]*$/.test(name)
    ? name
    : (fieldIdent(name.replace(/[-_]+/g, ' ')) ?? 'prop');
  if (RESERVED.has(base) || EXTRA_BAD_PROP_NAMES.includes(base)) base = `${base}Prop`;
  let ident = base;
  for (let n = 2; taken.has(ident); n++) ident = `${base}${n}`;
  taken.add(ident);
  return ident;
}

function typedDefault(p: PropDef, resolved: PropValue | undefined): PropValue | undefined {
  switch (p.type) {
    case 'slot':
      return undefined;
    case 'number': {
      const n = Number(resolved);
      return Number.isFinite(n) ? n : 0;
    }
    case 'boolean':
      return resolved === true || resolved === 'true';
    default:
      return String(resolved ?? '');
  }
}

function literalOf(v: PropValue): string {
  return typeof v === 'string' ? jsString(v) : String(v);
}

/** `abre a, b fecha` numa linha; se passar de 90 colunas, um item por linha (o `emitElement` recua). */
function listProp(open: string, items: string[], close: string, spaced = false): string {
  const flat = `${open}${spaced ? ' ' : ''}${items.join(', ')}${spaced ? ' ' : ''}${close}`;
  if (flat.length <= 90) return flat;
  return `${open}\n${items.map((i) => `  ${i},`).join('\n')}\n${close}`;
}

const jsDoc = (text: string, indent = '  '): string =>
  `${indent}/** ${text
    .replace(/\*\//g, '* /')
    .replace(/\s*\n\s*/g, ' ')
    .trim()} */`;

/** Textos de `{{prop}}`: pedaços literais e props conhecidas (placeholders desconhecidos ficam literais). */
type Part = { lit: string } | { prop: PropInfo };

function splitParts(value: string, props: Map<string, PropInfo>): Part[] {
  const parts: Part[] = [];
  let last = 0;
  const pushLit = (s: string): void => {
    if (s === '') return;
    const prev = parts[parts.length - 1];
    if (prev && 'lit' in prev) prev.lit += s;
    else parts.push({ lit: s });
  };
  for (const m of value.matchAll(PLACEHOLDER_RE)) {
    const info = props.get(m[1]);
    pushLit(value.slice(last, m.index));
    if (info && info.def.type !== 'slot') parts.push({ prop: info });
    else pushLit(m[0]);
    last = (m.index ?? 0) + m[0].length;
  }
  pushLit(value.slice(last));
  return parts;
}

function templateLiteral(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$\{/g, '\\${')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .split(String.fromCharCode(0x2028))
    .join(String.fromCharCode(92) + 'u2028')
    .split(String.fromCharCode(0x2029))
    .join(String.fromCharCode(92) + 'u2029');
}

/* ====================================================================== */
/* Variantes                                                               */
/* ====================================================================== */

interface ChainItem {
  when: Record<string, PropValue>;
  /** `undefined` remove a propriedade (`unsetStyle`). */
  value: string | undefined;
}

/** Sobrescritas de variante de um nó do principal, por propriedade, na ordem das variantes. */
interface NodePlan {
  style: Map<string, ChainItem[]>;
  /** estado → propriedade → cadeia. */
  states: Map<string, Map<string, ChainItem[]>>;
  text: ChainItem[];
}

function push<K, V>(map: Map<K, V[]>, key: K, item: V): void {
  const list = map.get(key);
  if (list) list.push(item);
  else map.set(key, [item]);
}

/* ====================================================================== */
/* Registro dos componentes                                                */
/* ====================================================================== */

interface CompInfo {
  def: ComponentDef;
  name: string;
  propsName: string;
  props: PropInfo[];
  byName: Map<string, PropInfo>;
  slots: PropInfo[];
  /** Árvore do principal já preparada (sem ocultos, estilos seguros). */
  tree: Node;
  /** Nós do principal fora de instâncias aninhadas, por id. */
  own: Map<string, Node>;
  /** Contêiner de slot (id do nó) → slot. */
  slotNodes: Map<string, PropInfo>;
  plans: Map<string, NodePlan>;
  /** Avisos de overrides de variante que a exportação não representa. */
  ignored: string[];
}

function isSlotContainer(n: Node): string | undefined {
  return n.attrs?.[SLOT_ATTR];
}

export function createComponentSupport(doc: Document, base: RenderCtx): ComponentSupport {
  const infos = new Map<string, CompInfo>();
  const order: CompInfo[] = [];

  /** Nome único do componente (e de `XProps`) entre os nomes já usados no arquivo. */
  function allocName(def: ComponentDef): { name: string; propsName: string } {
    const stem = componentIdent(def.name);
    let name = stem;
    for (let n = 2; base.usedNames.has(name) || base.usedNames.has(`${name}Props`); n++) {
      name = `${stem}${n}`;
    }
    base.usedNames.add(name);
    base.usedNames.add(`${name}Props`);
    return { name, propsName: `${name}Props` };
  }

  function register(def: ComponentDef): CompInfo {
    const hit = infos.get(def.id);
    if (hit) return hit;
    const taken = new Set<string>();
    const resolved = resolveProps(def);
    const props: PropInfo[] = def.props.map((p) => {
      const options = p.type === 'enum' ? [...(p.options ?? [])] : [];
      const fallback = typedDefault(p, resolved[p.name]);
      if (p.type === 'enum' && typeof fallback === 'string' && !options.includes(fallback)) {
        options.push(fallback);
      }
      return { def: p, ident: propIdent(p.name, taken), options, fallback };
    });
    const tree = prepareTree(
      def.root.type === 'instance' ? expandInstance(doc, def.root) : def.root,
    );
    const own = new Map<string, Node>();
    const slotNodes = new Map<string, PropInfo>();
    const slotProps = new Map(
      props.filter((p) => p.def.type === 'slot').map((p) => [p.def.name, p]),
    );
    const walk = (n: Node, isRoot: boolean): void => {
      own.set(n.id, n);
      if (n.type === 'instance') return; // filhos de instância são conteúdo de slot dela
      const s = isRoot ? undefined : isSlotContainer(n);
      const p = s === undefined ? undefined : slotProps.get(s);
      if (p && ![...slotNodes.values()].includes(p)) slotNodes.set(n.id, p);
      for (const c of n.children) walk(c, false);
    };
    walk(tree, true);
    const { name, propsName } = allocName(def);
    const info: CompInfo = {
      def,
      name,
      propsName,
      props,
      byName: new Map(props.map((p) => [p.def.name, p])),
      slots: props.filter((p) => p.def.type === 'slot'),
      tree,
      own,
      slotNodes,
      plans: new Map(),
      ignored: [],
    };
    buildPlans(info);
    infos.set(def.id, info);
    order.push(info);
    return info;
  }

  function buildPlans(info: CompInfo): void {
    const plan = (id: string): NodePlan => {
      let p = info.plans.get(id);
      if (!p) {
        p = { style: new Map(), states: new Map(), text: [] };
        info.plans.set(id, p);
      }
      return p;
    };
    for (const v of info.def.variants) {
      for (const [key, ov] of Object.entries(v.overrides)) {
        const id = key === '' ? info.tree.id : key;
        if (!info.own.has(id)) {
          if (key !== '') info.ignored.push(key);
          continue;
        }
        const when = v.when;
        const np = plan(id);
        for (const k of ov.unsetStyle ?? []) push(np.style, k, { when, value: undefined });
        for (const [k, val] of Object.entries(ov.style ?? {})) {
          if (cssValueProblem(val) === null) push(np.style, k, { when, value: val });
        }
        for (const [st, decls] of Object.entries(ov.states ?? {})) {
          let m = np.states.get(st);
          if (!m) np.states.set(st, (m = new Map()));
          for (const [k, val] of Object.entries(decls)) {
            if (cssValueProblem(val) === null) push(m, k, { when, value: val });
          }
        }
        if (ov.text !== undefined) np.text.push({ when, value: ov.text });
        if (
          ov.attrs ||
          ov.hidden !== undefined ||
          ov.classes !== undefined ||
          ov.src !== undefined ||
          ov.svg !== undefined ||
          ov.props
        ) {
          info.ignored.push(key === '' ? '(raiz)' : key);
        }
      }
    }
  }

  /* ------------------------------ corpo ------------------------------ */

  function makeScope(info: CompInfo): {
    hooks: ScopeHooks;
    used: Set<string>;
    usesChildren: () => boolean;
  } {
    const used = new Set<string>();
    let usesChildren = false;
    const firstSlot = info.slots[0];

    const ref = (p: PropInfo): string => {
      used.add(p.ident);
      return p.ident;
    };
    const hasPlaceholder = (v: string): boolean =>
      splitParts(v, info.byName).some((p) => 'prop' in p);
    /** Expressão de string do valor: literal, a própria prop (string) ou template literal. */
    const strExpr = (v: string, numberAsString: boolean): string => {
      const parts = splitParts(v, info.byName);
      if (!parts.some((p) => 'prop' in p)) return jsString(v);
      if (parts.length === 1 && 'prop' in parts[0]) {
        const p = parts[0].prop;
        if (p.def.type === 'string' || p.def.type === 'color' || p.def.type === 'enum')
          return ref(p);
        return numberAsString ? `String(${ref(p)})` : `\`\${${ref(p)}}\``;
      }
      return (
        '`' +
        parts.map((p) => ('lit' in p ? templateLiteral(p.lit) : `\${${ref(p.prop)}}`)).join('') +
        '`'
      );
    };

    /** Condição de uma variante; `null` se ela cita props que não existem ou valores fora do tipo. */
    const cond = (when: Record<string, PropValue>): string | null => {
      const terms: string[] = [];
      const touched: PropInfo[] = [];
      for (const [k, val] of Object.entries(when)) {
        const p = info.byName.get(k);
        if (!p || p.def.type === 'slot') return null;
        let lit: string;
        if (p.def.type === 'enum') {
          if (!p.options.includes(String(val))) return null;
          lit = jsString(String(val));
        } else if (p.def.type === 'number') {
          const n = Number(val);
          if (!Number.isFinite(n)) return null;
          lit = String(n);
        } else if (p.def.type === 'boolean') {
          if (val !== true && val !== false && val !== 'true' && val !== 'false') return null;
          lit = String(val === true || val === 'true');
        } else lit = jsString(String(val));
        touched.push(p);
        terms.push(`${p.ident} === ${lit}`);
      }
      if (terms.length === 0) return null;
      touched.forEach(ref);
      return terms.join(' && ');
    };

    /** `c2 ? v2 : c1 ? v1 : base` (a última variante que bate ganha, como na expansão). */
    const chain = (
      items: ChainItem[],
      baseValue: string | undefined,
      fmt: (v: string | undefined) => string,
    ): string => {
      let expr = fmt(baseValue);
      for (const it of items) {
        const c = cond(it.when);
        if (c !== null) expr = `${c} ? ${fmt(it.value)} : ${expr}`;
      }
      return expr;
    };

    const hasUsableCond = (items: ChainItem[]): ChainItem[] =>
      items.filter((it) => validCond(info, it.when));

    const styleProps = (node: Node, ctx: RenderCtx): string[] => {
      const isCompRoot = node.id === info.tree.id;
      const plan = info.own.get(node.id) === node ? info.plans.get(node.id) : undefined;
      const style = { ...node.style };
      const dyn: [string, string][] = [];
      const classExprs: string[] = [];
      const bare = (n: Node): Node => ({ ...n, children: [], classes: undefined });

      // chaves com variantes (só as que alguma variante utilizável altera)
      const styleChains = new Map<string, ChainItem[]>();
      for (const [k, items] of plan?.style ?? []) {
        const usable = hasUsableCond(items);
        if (usable.length > 0) styleChains.set(k, usable);
      }
      const stateChains = new Map<string, Map<string, ChainItem[]>>();
      for (const [st, props] of plan?.states ?? []) {
        for (const [k, items] of props) {
          const usable = hasUsableCond(items);
          if (usable.length === 0) continue;
          let m = stateChains.get(st);
          if (!m) stateChains.set(st, (m = new Map()));
          m.set(k, usable);
        }
      }

      // `{{prop}}` no estilo base: expressão inline (nunca vira classe)
      for (const k of Object.keys(style)) {
        if (!styleChains.has(k) && hasPlaceholder(style[k])) {
          dyn.push([k, strExpr(style[k], true)]);
          delete style[k];
        }
      }
      // estados: placeholders ficam com o valor padrão; propriedades com variante saem do estado base
      let states: Record<string, Record<string, string>> | undefined;
      if (node.states) {
        states = {};
        for (const [st, decls] of Object.entries(node.states)) {
          const out: Record<string, string> = {};
          for (const [k, v] of Object.entries(decls)) {
            if (stateChains.get(st)?.has(k)) continue;
            out[k] = defaultsOf(info, v);
          }
          if (Object.keys(out).length > 0) states[st] = out;
        }
        if (Object.keys(states).length === 0) states = undefined;
      }

      const tailwind = ctx.mode === 'tailwind';
      const partsOf = (n: Node): { classes: string[]; style: Record<string, string> } =>
        styleParts({ ...bare(n), style: n.style, states: n.states }, ctx, false);

      for (const [k, items] of styleChains) {
        const baseValue = style[k];
        delete style[k];
        const values = [baseValue, ...items.map((i) => i.value)];
        const classable =
          tailwind &&
          values.every(
            (v) =>
              v === undefined ||
              (!hasPlaceholder(v) &&
                Object.keys(partsOf({ ...node, style: { [k]: v }, states: undefined }).style)
                  .length === 0),
          );
        if (classable) {
          classExprs.push(
            chain(items, baseValue, (v) =>
              jsString(
                v === undefined
                  ? ''
                  : partsOf({ ...node, style: { [k]: v }, states: undefined }).classes.join(' '),
              ),
            ),
          );
        } else {
          dyn.push([
            k,
            chain(items, baseValue, (v) => (v === undefined ? 'undefined' : strExpr(v, true))),
          ]);
        }
      }
      if (tailwind) {
        for (const [st, props] of stateChains) {
          for (const [k, items] of props) {
            const baseValue = node.states?.[st]?.[k];
            const cls = (v: string | undefined): string =>
              v === undefined
                ? jsString('')
                : jsString(
                    partsOf({
                      ...node,
                      style: {},
                      states: { [st]: { [k]: defaultsOf(info, v) } },
                    }).classes.join(' '),
                  );
            classExprs.push(chain(items, baseValue, cls));
          }
        }
      }

      const { classes, style: staticStyle } = partsOf({ ...node, style, states });

      const out: string[] = [];
      const cls: string[] = [];
      if (classes.length > 0) cls.push(jsString(classes.join(' ')));
      cls.push(...classExprs);
      if (isCompRoot) cls.push('className');
      if (cls.length === 1 && !isCompRoot && classExprs.length === 0) {
        out.push(`className=${attrValue(classes.join(' '))}`);
      } else if (cls.length === 1) out.push(`className={${cls[0]}}`);
      else if (cls.length > 1) {
        out.push(listProp('className={[', cls, "].filter(Boolean).join(' ')}"));
      }

      const entries = Object.entries(staticStyle).map(
        ([k, v]) => `${reactStyleKey(k)}: ${jsString(v)}`,
      );
      for (const [k, e] of dyn) entries.push(`${reactStyleKey(k)}: ${e}`);
      if (isCompRoot) entries.push('...style');
      if (entries.length > 0) {
        if (!isCompRoot && dyn.length === 0) out.push(styleProp(staticStyle, ctx.usage));
        else if (entries.length === 1 && isCompRoot) out.push('style={style}');
        else {
          // valores vindos de props podem ser `string` onde o CSSProperties espera uma união de literais
          ctx.usage.cssProperties = true;
          out.push(listProp('style={{', entries, '} as CSSProperties}', true));
        }
      }
      return out;
    };

    const hooks: ScopeHooks = {
      styleProps,
      hasPlaceholder,
      valueExpr: (v) => strExpr(v, true),
      attrValue: (v) => {
        if (!hasPlaceholder(v)) return attrValue(v);
        return `{${strExpr(v, false)}}`;
      },
      textChildren: (node, pre) => {
        const plan = info.own.get(node.id) === node ? info.plans.get(node.id) : undefined;
        const items = hasUsableCond(plan?.text ?? []);
        const text = node.text ?? '';
        if (items.length > 0) {
          return [`{${chain(items, text, (v) => strExpr(v ?? '', true))}}`];
        }
        const parts = splitParts(text, info.byName);
        if (!parts.some((p) => 'prop' in p)) return undefined;
        const out: string[] = [];
        for (const p of parts) {
          if ('lit' in p) out.push(...textChildren(p.lit, pre));
          else
            out.push(
              p.prop.def.type === 'boolean' ? `{String(${ref(p.prop)})}` : `{${ref(p.prop)}}`,
            );
        }
        return out;
      },
      slotChildren: (node, depth, ctx, pre) => {
        const p = info.slotNodes.get(node.id);
        if (!p || info.own.get(node.id) !== node) return undefined;
        const names = [ref(p)];
        if (p === firstSlot) {
          usesChildren = true;
          names.push('children');
        }
        if (node.children.length === 0) return [[`${pad(depth)}{${names.join(' ?? ')}}`]];
        const kids = renderChildren(node.children, depth + 2, ctx, pre, node).flat();
        return [
          [
            `${pad(depth)}{${names.join(' ?? ')} ?? (`,
            `${pad(depth + 1)}<>`,
            ...kids,
            `${pad(depth + 1)}</>`,
            `${pad(depth)})}`,
          ],
        ];
      },
    };
    return { hooks, used, usesChildren: () => usesChildren };
  }

  function generate(info: CompInfo): string {
    const { hooks, used, usesChildren } = makeScope(info);
    const ctx: RenderCtx = { ...base, extractRepeats: false, slots: undefined, scope: hooks };
    ctx.usage.cssProperties = true; // `style?: CSSProperties` em todo componente
    const body = renderNode(info.tree, 2, ctx, false, false);
    const children = usesChildren();

    const out: string[] = [];
    if (info.ignored.length > 0) {
      out.push(
        `// Nota: overrides de variante não exportados (atributos, ocultar, classes, imagem/svg ou props de aninhadas) em: ${[...new Set(info.ignored)].join(', ')}.`,
      );
    }
    out.push(`export interface ${info.propsName} {`);
    for (const p of info.props) {
      if (p.def.description) out.push(jsDoc(p.def.description));
      let type: string;
      switch (p.def.type) {
        case 'slot':
          base.usage.reactNode = true;
          type = 'ReactNode';
          break;
        case 'number':
          type = 'number';
          break;
        case 'boolean':
          type = 'boolean';
          break;
        case 'enum':
          type = p.options.length > 0 ? p.options.map(jsString).join(' | ') : 'string';
          break;
        default:
          type = 'string';
      }
      out.push(`  ${p.ident}?: ${type};`);
    }
    if (info.slots.length > 0) {
      base.usage.reactNode = true;
      out.push(jsDoc(`Atalho para o slot "${info.slots[0].def.name}".`), '  children?: ReactNode;');
    }
    out.push('  className?: string;', '  style?: CSSProperties;', '}', '');

    const fields: string[] = [];
    for (const p of info.props) {
      if (!used.has(p.ident)) continue;
      fields.push(p.def.type === 'slot' ? p.ident : `${p.ident} = ${literalOf(p.fallback ?? '')}`);
    }
    if (children) fields.push('children');
    fields.push('className', 'style');
    const oneLine = `export function ${info.name}({ ${fields.join(', ')} }: ${info.propsName}) {`;
    if (oneLine.length <= 100) out.push(oneLine);
    else
      out.push(
        `export function ${info.name}({`,
        ...fields.map((f) => `  ${f},`),
        `}: ${info.propsName}) {`,
      );
    out.push('  return (', ...body, '  );', '}');
    return out.join('\n');
  }

  /* --------------------------- instâncias ---------------------------- */

  /** Atributo JSX de uma prop da instância; `null` se o valor não cabe no tipo da prop. */
  function propAttr(p: PropInfo, value: PropValue, ctx: RenderCtx): string | null {
    if (typeof value === 'string' && ctx.scope?.hasPlaceholder(value)) {
      return p.def.type === 'string' || p.def.type === 'color'
        ? `${p.ident}=${ctx.scope.attrValue(value)}`
        : null;
    }
    switch (p.def.type) {
      case 'string':
      case 'color':
        return `${p.ident}=${attrValue(String(value))}`;
      case 'enum':
        return p.options.includes(String(value)) ? `${p.ident}=${attrValue(String(value))}` : null;
      case 'number': {
        const n = Number(value);
        return typeof value !== 'boolean' && Number.isFinite(n) && String(value).trim() !== ''
          ? `${p.ident}={${n}}`
          : null;
      }
      case 'boolean':
        if (value === true || value === 'true') return p.ident;
        if (value === false || value === 'false') return `${p.ident}={false}`;
        return null;
      default:
        return null;
    }
  }

  interface InstancePlan {
    info: CompInfo;
    attrs: string[];
    /** Conteúdo por slot (apenas os preenchidos). */
    slots: { prop: PropInfo; node: Node }[];
  }

  /** Plano da instância como JSX, ou `null` se ela precisa sair expandida. */
  function planInstance(node: Node, ctx: RenderCtx): InstancePlan | null {
    const def = getComponent(doc, node.componentId);
    if (!def) return null;
    if (Object.keys(node.overrides ?? {}).length > 0) return null;
    if (Object.keys(node.attrs).length > 0) return null;
    if (node.classes) return null;
    if (node.states && Object.keys(node.states).length > 0) return null;
    const info = register(def);
    const attrs: string[] = [];
    for (const k of Object.keys(node.props ?? {})) {
      const p = info.byName.get(k);
      if (!p || p.def.type === 'slot') return null; // prop não declarada: só a expansão a aplica
    }
    for (const p of info.props) {
      if (p.def.type === 'slot' || !node.props || !(p.def.name in node.props)) continue;
      const a = propAttr(p, node.props[p.def.name], ctx);
      if (a === null) return null;
      attrs.push(a);
    }
    const slots: InstancePlan['slots'] = [];
    for (const c of node.children) {
      const s = isSlotContainer(c);
      const p = s === undefined ? undefined : info.byName.get(s);
      if (!p || p.def.type !== 'slot' || slots.some((x) => x.prop === p)) continue;
      const custom =
        Object.keys(c.style).length > 0 ||
        (c.states && Object.keys(c.states).length > 0) ||
        c.classes ||
        c.hidden ||
        Object.keys(c.attrs).some((k) => k !== SLOT_ATTR);
      if (custom) return null;
      if (c.children.length > 0) slots.push({ prop: p, node: c });
    }
    return { info, attrs, slots };
  }

  function instanceStyle(node: Node, ctx: RenderCtx, isRoot: boolean): string[] {
    // o estilo da instância vai sempre inline: ganha das classes do componente (ex. `w-full` x `width`)
    const { style } = styleParts(
      { ...node, children: [], states: undefined, classes: undefined },
      { ...ctx, mode: 'inline' },
      isRoot && ctx.mode === 'inline',
    );
    const entries = Object.entries(style);
    if (entries.length === 0) return [];
    if (!ctx.scope || !entries.some(([, v]) => ctx.scope!.hasPlaceholder(v))) {
      return [styleProp(style, ctx.usage)];
    }
    ctx.usage.cssProperties = true;
    const body = entries
      .map(([k, v]) => `${reactStyleKey(k)}: ${ctx.scope!.valueExpr(v)}`)
      .join(', ');
    return [`style={{ ${body} } as CSSProperties}`];
  }

  function slotPropValue(node: Node, ctx: RenderCtx, pre: boolean, name: string): string {
    // linhas relativas à prop; o `emitElement` recua as continuações
    const entries = renderChildren(node.children, 1, ctx, pre, node);
    const single = entries.length === 1 && !entries[0][0].trimStart().startsWith('{');
    const lines = single
      ? entries[0]
      : [`${pad(1)}<>`, ...entries.flat().map((l) => `  ${l}`), `${pad(1)}</>`];
    return `${name}={\n${lines.join('\n')}\n}`;
  }

  function expandInPlace(
    node: Node,
    depth: number,
    ctx: RenderCtx,
    pre: boolean,
    isRoot: boolean,
    extraProps: string[],
  ): string[] {
    const def = getComponent(doc, node.componentId);
    const expanded = prepareTree(expandInstance(doc, node));
    // `componentId`/`props` ficam como marcador na raiz expandida; o tipo já é o da raiz do principal
    const lines = renderNode(expanded, depth, ctx, pre, isRoot, extraProps);
    if (isRoot || extraProps.length > 0 || !def) return lines;
    return [
      `${pad(depth)}{/* instância de ${def.name.replace(/\*\//g, '* /')} com overrides */}`,
      ...lines,
    ];
  }

  const support: ComponentSupport = {
    renderInstance(node, depth, ctx, pre, isRoot, extraProps) {
      const plan = planInstance(node, ctx);
      if (!plan) return expandInPlace(node, depth, ctx, pre, isRoot, extraProps);
      const { info } = plan;
      const props = [...extraProps, ...plan.attrs];
      const kids: string[][] = [];
      for (const s of plan.slots) {
        if (s.prop === info.slots[0]) {
          kids.push(...renderChildren(s.node.children, depth + 1, ctx, pre, s.node));
        } else props.push(slotPropValue(s.node, ctx, pre, s.prop.ident));
      }
      props.push(...instanceStyle(node, ctx, isRoot));
      return emitElement(info.name, props, kids, depth);
    },
    renderAll() {
      const out: string[] = [];
      // `order` cresce enquanto os principais registram os que usam
      for (let i = 0; i < order.length; i++) out.push(generate(order[i]));
      return out;
    },
  };
  return support;
}

/** Valor com os `{{prop}}` trocados pelo padrão do componente (estados, que não aceitam expressão). */
function defaultsOf(info: CompInfo, v: string): string {
  return v.replace(PLACEHOLDER_RE, (m, name: string) => {
    const p = info.byName.get(name);
    return p && p.def.type !== 'slot' ? String(p.fallback ?? '') : m;
  });
}

/** A condição da variante cita só props existentes e valores do tipo (mesmas regras do `cond`). */
function validCond(info: CompInfo, when: Record<string, PropValue>): boolean {
  const entries = Object.entries(when);
  if (entries.length === 0) return false;
  return entries.every(([k, val]) => {
    const p = info.byName.get(k);
    if (!p) return false;
    switch (p.def.type) {
      case 'slot':
        return false;
      case 'enum':
        return p.options.includes(String(val));
      case 'number':
        return Number.isFinite(Number(val));
      case 'boolean':
        return val === true || val === false || val === 'true' || val === 'false';
      default:
        return true;
    }
  });
}
