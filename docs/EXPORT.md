# Exportação de código

Os exportadores vivem em `packages/core/src/export/` e são funções puras sobre o `Document`
(nada de DOM, nada de I/O). Todos exportam a partir de `@mockup/core`.

| Formato    | Função                                       | Saída                                                  |
| ---------- | -------------------------------------------- | ------------------------------------------------------ |
| `html`     | `exportHtml(doc, opts)`                      | documento (ou fragmento) HTML + CSS em `<style>`       |
| `tailwind` | `exportTailwind(doc, opts)`, `cssToTailwind` | HTML com classes Tailwind v4 (+ tema em `@theme`)      |
| `react`    | `exportReact(doc, opts)`                     | componente `.tsx` (+ `css` do tema)                    |
| `svg`      | `exportSvg(doc, opts)`                       | SVG standalone (geometria medida ou `<foreignObject>`) |
| `png/jpg`  | motor de render (servidor)                   | não passam pelo core                                   |

Regras comuns a todos os formatos:

- Frames são artboards: a posição no canvas (`node.position` do frame) **não** vai para o código.
  O frame raiz mantém `width` e o `height` vira `min-height` (o conteúdo pode crescer). Em `svg`
  com layout o tamanho é o medido.
- Filhos com `position: absolute` usam `node.position` como `left`/`top` quando o estilo não define.
- Nós `hidden` não são exportados.
- Declarações CSS com nome ou valor inseguro (`{`, `}`, `;` fora de aspas/parênteses, `</style`,
  comentários, aspas ou parênteses desbalanceados) são **descartadas** no export, mesmo em arquivos
  antigos. Na edição (`updateStyles`, `normalizeStyles`) elas são **recusadas** com mensagem; na leitura
  de arquivo (`parseDocument`) só a declaração ruim é descartada.
- Atributos `on*`, `style`, `class`, `srcdoc` e URLs `javascript:`/`data:` não-imagem são removidos.
  SVG inline passa por `sanitizeSvg`.
- Fontes (`doc.fonts`): família e arquivos têm charset restrito (sem `< > { } ; " \`, quebras, `..`), estilos só `normal|italic|oblique` e pesos inteiros de 1 a 1000; o schema recusa o resto e `fontFaceCss` descarta entradas inválidas.

## Fontes no SVG

O SVG embute as fontes registradas em `doc.fonts` como `@font-face` com `src:url("data:font/woff2;base64,...")` num `<style>` (escapado para XML), para o arquivo abrir com a tipografia correta sem `assets/`. O servidor resolve cada arquivo de `assets/` para data URL (`resolveImage`); fontes sem arquivo resolvível (ou `local`) não geram regra.

## CSS base do documento

`documentBaseCss` (`packages/core/src/base.ts`) é a fonte única do CSS base: o canvas, a página de render (screenshot) e o código exportado usam o mesmo, então os três saem idênticos. O CSS da interface do editor não vaza no design. Ele define:

- `box-sizing: border-box` e `margin: 0` em tudo (`*`, `::before`, `::after`);
- controles (`button`, `input`, `select`, `textarea`) herdam fonte, cor e `letter-spacing`;
- tipografia padrão da raiz (`body` no código exportado): fonte do sistema (`system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif`), 16px, `line-height: normal`, texto preto.

Nos formatos html, react com estilos inline e svg ele entra como CSS (`documentBaseCssFor(doc)`). No Tailwind o preflight já cobre o reset e os controles, então só a tipografia da raiz vira `@layer base { body { ... } }` no `theme.css` (`tailwindBaseCssFor(doc)`, dentro de `tailwindThemeCss`).

`doc.cssBase` escolhe a base (op `setCssBase`):

- ausente (padrão): a base acima;
- `'tailwind'`: o preflight do Tailwind v4 (reset de `padding`/`border`, `h1..h6` sem tamanho, imagens `display: block`, listas sem marcador...) e a raiz tipográfica do Tailwind (fonte do sistema do v4, `line-height: 1.5`). No html, react inline e svg o preflight entra no CSS; no Tailwind só o `body` da camada base muda (o `@import "tailwindcss"` já traz o preflight). `BASE_CSS` e `TAILWIND_BASE_CSS` continuam exportados como as constantes da base padrão.

## html

```ts
exportHtml(doc, { pageId?, nodeIds?, title?, mode?: 'classes' | 'inline', fragment?: boolean }): string
```

Os estados (`node.states`) saem como regras do `<style>` logo após a regra base do nó:
`.slug:hover { ... }`, `@media (min-width: 768px) { .slug { ... } }` (`sm` 640, `md` 768, `lg` 1024,
`xl` 1280, `2xl` 1536), `.slug:where([data-theme="dark"], [data-theme="dark"] *) { ... }` para `dark` e
as combinações (o `@media` envolve o seletor com a pseudo-classe). Ver "Estados e variantes" na seção
Tailwind.

- `mode: 'classes'` (padrão): uma classe por nó, com o **slug do nome da camada** (`Hero Title` →
  `.hero-title`; acentos removidos; repetidos ganham `-2`, `-3`). `mode: 'inline'`: `style=""` em cada tag.
- `fragment: true`: só `<style>` + markup, sem `<!doctype>`/`<head>`.
- Tokens vão em `:root { --x: ... }`, depois o CSS base do documento (reset, controles e tipografia da raiz) e os
  `@font-face` das fontes embutidas (`assets/<arquivo>`).
- Padrão sem `nodeIds`: todos os frames da página (`pageId` ou a primeira).

Navbar do Desktop 1440 (`nodeIds: ['el_dsk00007'], fragment: true`, trecho):

```html
<style>
  :root {
    --color-surface: #181b22;
    --radius: 12px;
    /* ... */
  }
  * {
    box-sizing: border-box;
    margin: 0;
  }
  .navbar {
    display: flex;
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
    padding: 20px 64px;
    background-color: var(--color-surface);
  }
  .botao-entrar {
    background: var(--color-primary);
    color: #ffffff;
    padding: 10px 20px;
    border-radius: var(--radius);
    border: none;
    font-size: 15px;
    font-weight: 600;
  }
</style>
<header class="navbar">
  <div class="logo">Mockup</div>
  <nav class="links">
    <a class="produto" href="#">Produto</a>
    <!-- ... -->
  </nav>
  <button class="botao-entrar">Entrar</button>
</header>
```

## tailwind

```ts
exportTailwind(doc, { pageId?, nodeIds?, title?, fragment?: boolean, cdn?: boolean, tailwind?: TailwindEngine }): string
cssToTailwind(style, { tokens? }): { classes: string[]; rest: Record<string, string> }
tailwindThemeCss(doc, { import?: boolean }): string
neutralLeadingSizes(doc): Set<string>
```

Tailwind **v4**. O documento completo (padrão) inclui

```html
<script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>
<style type="text/tailwindcss">
  @theme { ... } :root { ... } @font-face { ... }
</style>
```

`cdn: false` remove o `<script>` (o tema continua). `fragment: true` devolve só o markup
(use `tailwindThemeCss(doc)` para o CSS de tema do seu projeto: `@import "tailwindcss";` + `@theme`

- `:root` + `@font-face`).

Navbar (mesmo nó, `fragment: true`):

```html
<header class="flex flex-row items-center justify-between py-5 px-16 bg-surface">
  <div class="text-[22px] font-bold text-text">Mockup</div>
  <nav class="flex gap-8">
    <a class="text-muted text-base no-underline" href="#">Produto</a>
    <!-- ... -->
  </nav>
  <button
    class="bg-primary text-white py-2.5 px-5 rounded-(--radius) border-none text-[15px] font-semibold"
  >
    Entrar
  </button>
</header>
```

### Mapeamento (resumo)

| CSS                                                                            | Classe                                                                                                                                                        |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `display: flex`, `flex-direction: column`                                      | `flex`, `flex-col`                                                                                                                                            |
| `align-items`/`justify-content`: `center`, `space-between`, `flex-end`         | `items-center`, `justify-between`, `justify-end`                                                                                                              |
| `flex: 1`, `flex-grow: 1`, `flex-shrink: 0`                                    | `flex-1`, `grow`, `shrink-0`                                                                                                                                  |
| `grid-template-columns: repeat(3, 1fr)` / outro                                | `grid-cols-3` / `grid-cols-[200px_1fr]`                                                                                                                       |
| `gap: 24px`, `gap: 8px 16px`                                                   | `gap-6`, `gap-y-2 gap-x-4`                                                                                                                                    |
| `padding: 16px`, `20px 64px`, `6px`, `13px`                                    | `p-4`, `py-5 px-16`, `p-1.5`, `p-[13px]` (escala v4: 4px = 1, meio passo ok)                                                                                  |
| `margin: 0 auto`, `margin-top: -8px`                                           | `my-0 mx-auto`, `-mt-2`                                                                                                                                       |
| `width`/`height`                                                               | `w-full`, `h-screen`, `w-1/2`, `w-auto`, `w-[1440px]`; iguais → `size-10`                                                                                     |
| `min-height: 900px`, `max-width`                                               | `min-h-[900px]`, `max-w-md` (256–1280px nomeados) ou `max-w-[800px]`                                                                                          |
| `font-size` 12…128px                                                           | `text-xs` … `text-9xl`; senão `text-[17px]`                                                                                                                   |
| `font-weight` 100…900                                                          | `font-thin` … `font-black`; senão `font-[550]`                                                                                                                |
| `line-height`                                                                  | `leading-none/tight/snug/normal/relaxed/loose`, `leading-7`, `leading-[1.4]`                                                                                  |
| `letter-spacing`                                                               | `tracking-tighter` … `tracking-widest`, `tracking-[2px]`                                                                                                      |
| `text-align`, `text-transform`, `font-style`, `text-decoration`, `white-space` | `text-center`, `uppercase`, `italic`, `underline`/`no-underline`, `whitespace-pre-wrap`                                                                       |
| `color`/`background-color`/`border-color`                                      | `text-`/`bg-`/`border-` + `[#6c5ce7]`, `white`, `transparent`, `[rgba(0,0,0,0.5)]`, tema                                                                      |
| `background: linear-gradient(...)`                                             | `bg-[linear-gradient(90deg,#000,#fff)]`                                                                                                                       |
| `border: 1px solid c`, `border-top`, `border-width: 4px`                       | `border border-solid border-c`, `border-t border-t-c`, `border-4`                                                                                             |
| `border-radius`                                                                | 2/4/6/8/12/16/24/32px → `rounded-xs` … `rounded-4xl`; ≥9999 → `rounded-full`; `0` → `rounded-none`; senão `rounded-[10px]`; 2–4 valores → `rounded-tl-*` etc. |
| `box-shadow`                                                                   | `shadow-[0_2px_4px_rgba(0,0,0,0.2)]` (espaços viram `_`), `shadow-none`                                                                                       |
| `opacity: 0.5`                                                                 | `opacity-50`                                                                                                                                                  |
| `overflow`, `position`, `top/left/...`, `z-index`                              | `overflow-hidden`, `absolute`, `left-3`/`left-[13px]`, `z-10`/`z-[7]`                                                                                         |
| `object-fit`, `cursor`, `aspect-ratio`                                         | `object-cover`, `cursor-pointer`, `aspect-video`                                                                                                              |
| `!important`                                                                   | sufixo `!` (`p-4!`)                                                                                                                                           |
| qualquer outra propriedade                                                     | classe arbitrária `[prop:valor]` (`[transition:all_0.2s_ease]`, `[--x:#f00]`)                                                                                 |

Se nem a classe arbitrária for segura (valor com `<`, `>`, `{`, `}`, `;`, crases), a declaração vai
para `rest` e o exportador a emite em `style=""`.

Detalhe do `line-height`: `text-sm` etc. trazem um `line-height` padrão no Tailwind. Para que o
espaçamento de linha continue o do documento, `tailwindThemeCss` acrescenta ao `@theme`
`--text-<tamanho>--line-height: inherit;` só para os tamanhos nomeados usados por algum nó (base ou
estado) cujo `line-height` **não** é o padrão do Tailwind para aquele tamanho (ou que não tem
`line-height`). Nós importados de Tailwind (`font-size: 0.875rem` + `line-height: 1.4286`, ou `20px`)
dispensam a neutralização; `neutralLeadingSizes(doc)` devolve esse conjunto. Um nó com o padrão que
convive com um nó fora do padrão no mesmo tamanho recebe um `leading-*` explícito para não mudar.

### Motor do documento (`options.tailwind`)

Com `tailwind: await getTailwindEngine(doc)` (de `@mockup/core/tailwind`, que roda o compilador
oficial do Tailwind v4) as classes de cada nó vêm de `engine.nodeClasses(node, { neutralLeading })`
em vez de `cssToTailwind`:

- **dica `node.classes`**: as classes que o autor escreveu (import de HTML Tailwind, `set_classes`) são
  reaproveitadas, na ordem original, enquanto ainda reproduzem o estilo atual do nó; o que foi editado
  depois é gerado de novo. Classes que o modelo não representa (`group`, `group-hover:x`,
  `[&_svg]:size-4`, `has-[>svg]:px-3`, `aria-invalid:...`) e as desconhecidas saem como estão;
- **canonicalização + conferência**: o que não vem da dica passa pelo mapeamento estático, é
  canonicalizado pelo Tailwind (`p-[16px]` vira `p-4`, `mt-2 mb-2` vira `my-2`) e conferido contra o
  compilador (comparação independente de shorthand: `padding: 8px 16px` bate com `py-2 px-4`). Se não
  reproduz o estilo, cai para `[prop:valor]`;
- o que não vira classe continua indo para `style=""` (`rest`).

Sem o motor o mapeamento é o estático de sempre (saída idêntica à anterior).

### Estados e variantes

`node.states` (`hover`, `focus`, `focus-visible`, `focus-within`, `active`, `disabled`, `dark`,
`sm|md|lg|xl|2xl` e combinações como `md:hover`) são exportados como classes com prefixo de variante
(`hover:bg-[#5b4bd6]`, `md:px-6`, `dark:bg-[#222]`, `md:hover:...`). Com o motor, `nodeClasses` já
faz isso (e reaproveita `hover:bg-primary/90` do autor); sem o motor, `cssToTailwind` do estado com
o prefixo (propriedades sem classe nem forma arbitrária segura são descartadas, pois `style=""` não
tem variantes). Quando algum nó tem estado `dark`, o tema exportado inclui
`@custom-variant dark (&:where([data-theme=dark], [data-theme=dark] *));` (o tema `dark` do
documento, via `data-theme`).

### Tokens e `@theme`

Um token cujo nome cai num namespace de tema do Tailwind v4 vira variável de `@theme` e a classe usa
o nome curto:

| Token                         | Uso no CSS                         | Classe                               |
| ----------------------------- | ---------------------------------- | ------------------------------------ |
| `--color-primary`             | `background: var(--color-primary)` | `bg-primary` (`text-`, `border-`...) |
| `--radius-card`               | `border-radius`                    | `rounded-card`                       |
| `--font-sans`                 | `font-family`                      | `font-sans`                          |
| `--font-weight-heavy`         | `font-weight`                      | `font-heavy`                         |
| `--text-hero`                 | `font-size`                        | `text-hero`                          |
| `--shadow-soft`               | `box-shadow`                       | `shadow-soft`                        |
| `--spacing-gutter`            | `padding`, `gap`, `width`...       | `p-gutter`, `gap-gutter`             |
| `--leading-*`, `--tracking-*` | `line-height`, `letter-spacing`    | `leading-*`, `tracking-*`            |

Tokens **fora** dos namespaces (`--radius`, `--font` do exemplo) ficam em `:root { ... }` e usam a
sintaxe de variável do v4 com parênteses, escolhida por ser a forma curta documentada do Tailwind v4:

| CSS                            | Classe                      |
| ------------------------------ | --------------------------- |
| `border-radius: var(--radius)` | `rounded-(--radius)`        |
| `font-family: var(--font)`     | `font-(family-name:--font)` |
| `background: var(--surface)`   | `bg-(color:--surface)`      |
| `padding: var(--pad)`          | `p-(--pad)`                 |
| `font-size: var(--size)`       | `text-(length:--size)`      |

Um `var(--color-x)` cujo token não existe no documento (quando `tokens` é informado a
`cssToTailwind`) também usa a forma `(color:--color-x)`. `var(--x, fallback)` vira `[color:var(--x,#fff)]`.

## react

```ts
exportReact(doc, {
  nodeId, styles?: 'tailwind' | 'inline', componentName?, extractRepeats?: boolean, assetsBase?: string,
}): { componentName: string; code: string; css?: string }
```

Gera um componente funcional TSX (`export function Nome()` + `export default Nome`) que compila com
`tsc --strict` e `noUnusedLocals` num template Vite React TS (os testes compilam a saída com o
compilador do TypeScript). O nome é o PascalCase do nome do nó (acentos removidos).

- `styles: 'tailwind'` (padrão): `className` com as classes acima (com `options.tailwind` as do motor,
  incluindo as variantes de `node.states`); `css` traz `tailwindThemeCss(doc)` (coloque num `.css`
  importado pelo app, com o Tailwind v4 instalado). Irmãos só são extraídos em `map(...)` se também
  têm os mesmos estados.
- `styles: 'inline'`: `style={{ backgroundColor: 'var(--color-bg)' }}` (camelCase, tudo string com
  unidade). Os tokens do documento viram custom properties no `style` do elemento **raiz**
  (`{ '--color-bg': '#0f1115', ... } as CSSProperties`, com `import type { CSSProperties } from 'react'`).
  `css` traz o CSS base do documento e os `@font-face`. **Estados não são exportados** neste modo
  (`style={{}}` não tem `:hover` nem `@media`); use `styles: 'tailwind'` para levá-los.
- Atributos: `for` → `htmlFor`, `tabindex` → `tabIndex={0}`, `readonly` → `readOnly`, booleanos sem
  valor (`disabled`), `aria-*`/`data-*` mantidos, `value` de campo vira `defaultValue`, tags void
  auto-fechadas. Só atributos HTML conhecidos entram (os demais são descartados para o TSX compilar).
- Texto como filho; `{`, `}`, `<`, `>` escapados (`{'{'}`), `&` → `&amp;`; espaços nas bordas viram
  `{' texto '}`. Quebra de linha: `{'\n'}` quando o `white-space` preserva, `<br />` caso contrário.
- Imagens: `src="assets/arquivo.png"` (prefixo configurável por `assetsBase`; data URL passa) e `alt`.
- SVG: o markup sanitizado vira JSX (`stroke-width` → `strokeWidth`, `class` → `className`,
  `xlink:href` → `xlinkHref`, `style="a: b"` → `style={{ a: 'b' }}`; nomes de elementos como
  `linearGradient`/`clipPath` normalizados; elementos desconhecidos descartados).

### Repetições em `map`

Com `extractRepeats` (padrão), irmãos consecutivos (≥ 2) com a **mesma estrutura** (tags, tipos,
estilos, atributos e árvore iguais; diferindo só em texto, `src`, `alt` e `href`) viram um array
fora do componente e um `map`. Só entram no array os campos que **variam** entre os itens. Os
campos vêm do nome da camada em camelCase (`Título do card` → `tituloDoCard`, `src` →
`fotoSrc`); se os nomes das camadas diferem entre os itens, `text1`, `text2`... O array se chama
`<nome comum dos itens, ou nome do pai>Items`. A `key` é o índice.

Cards do Desktop 1440 (`nodeId: 'el_dsk00026'`, tailwind):

```tsx
const cardItems = [
  {
    icone: '🎨',
    tituloDoCard: 'Design livre',
    textoDoCard: 'Posicione frames no canvas e ajuste cada propriedade CSS.',
  },
  // ...
];

export function Cards() {
  return (
    <section className="flex flex-row gap-6 pt-8 pb-24 px-16">
      {cardItems.map((item, index) => (
        <div key={index} className="flex flex-col gap-3 p-8 flex-1 bg-surface rounded-(--radius)">
          <div className="text-[32px]">{item.icone}</div>
          <h3 className="text-[22px] font-bold text-text">{item.tituloDoCard}</h3>
          <p className="text-base leading-normal text-muted">{item.textoDoCard}</p>
        </div>
      ))}
    </section>
  );
}

export default Cards;
```

## svg

```ts
exportSvg(doc, { nodeId, layout?: LayoutNode, resolveImage?: (src) => string | undefined }): string
```

O SVG é uma imagem estática: `node.states` (hover, dark, breakpoints) são ignorados.

**Com `layout`** (geometria medida pela página de render, `measure(nodeId)`): `<svg>` com
`width`/`height`/`viewBox` do nó raiz medido; coordenadas relativas a ele. Para cada nó visível
(`display: none`, `opacity: 0` e `visibility: hidden` são ignorados):

- fundo: `<rect>` com `fill` (rgba vira `rgb()` + `fill-opacity`); raios iguais → `rx`, diferentes → `<path>`;
- `background-image: linear-gradient(...)` → `<linearGradient>` (só linear; outros são ignorados);
- borda uniforme → `stroke` recuado de meia largura (`dashed`/`dotted` com `stroke-dasharray`);
  bordas diferentes → uma faixa preenchida por lado;
- `box-shadow` → `<filter>` com `feDropShadow` (só a primeira sombra externa; `inset` é ignorada);
- `opacity` → `<g opacity>`; `overflow: hidden|clip|auto|scroll` → `<clipPath>` com o rect (e raio) do nó aplicado aos filhos;
- texto: um `<text>` por linha medida, em `x`, `y + baseline`, com `font-family/size/weight/style`,
  `letter-spacing`, `text-decoration`, `text-transform` aplicado e `fill`;
- imagem: `<image href>` com `resolveImage(src)` (ou o `src` original) e `preserveAspectRatio`
  (`cover` → `xMidYMid slice`, `contain` → `meet`, `fill` → `none`), com clip se houver raio;
- nós `svg`: `<svg x y width height viewBox>` aninhado com o markup sanitizado (`color` do nó em `color`);
- fontes embutidas: `<style>` com `@font-face` quando `resolveImage` devolve a data URL do arquivo da fonte.

**Sem `layout`**: `<svg><foreignObject>` com o HTML exportado (XHTML, estilos inline, tokens no
`<div>` wrapper e reset em `<style>`), com o tamanho declarado em `width`/`height` do estilo do nó
(px; padrão 100x100) e `height` preservado.

Navbar com um layout medido à mão (fundo com sombra, logo e botão com raio):

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="71" viewBox="0 0 1440 71">
<defs>
<filter id="shadow1" x="-50%" y="-50%" width="200%" height="200%" color-interpolation-filters="sRGB"><feDropShadow dx="0" dy="2" stdDeviation="4" flood-color="rgb(0,0,0)" flood-opacity="0.2"/></filter>
</defs>
<rect x="0" y="0" width="1440" height="71" fill="rgb(24,27,34)" filter="url(#shadow1)"/>
<text x="64" y="44" font-family="Inter, system-ui, sans-serif" font-size="22" font-weight="700" fill="rgb(232,232,238)">Mockup</text>
<rect x="1316" y="16" width="60" height="39" rx="12" fill="rgb(108,92,231)"/>
<text x="1326" y="41" font-family="Inter" font-size="15" font-weight="600" fill="rgb(255,255,255)">Entrar</text>
</svg>
```

## Componentes

Documentos com componentes principais (`doc.components`, ver `COMPONENTES.md`) exportam assim:

| Formato  | Instâncias                                                                                          |
| -------- | --------------------------------------------------------------------------------------------------- |
| html     | Expandidas (`expandDocument`): o resultado é igual ao do canvas. `data-slot` dos slots é mantido. |
| tailwind | Expandidas, como no html.                                                                           |
| svg      | Expandidas; o layout (com `layout`) e o fallback `<foreignObject>` usam a árvore concreta.         |
| react    | Um componente por principal usado; instâncias viram JSX.                                            |

Em html, tailwind e svg, `nodeIds`/`nodeId` aceitam também ids **virtuais** (`in_x/tx_label01`, nós de
dentro de uma instância); o React também aceita, e exporta o nó já expandido.

### React

Para cada principal usado pelas raízes exportadas (inclusive os usados por outros principais) o arquivo
traz, antes do componente da tela:

```tsx
export interface ButtonProps {
  /** Estilo visual do botão. */
  variant?: 'default' | 'secondary' | 'outline' | 'ghost' | 'destructive';
  size?: 'sm' | 'default' | 'lg';
  /** Texto do botão. */
  label?: string;
  className?: string;
  style?: CSSProperties;
}

export function Button({ variant = 'default', size = 'default', label = 'Botão', className, style }: ButtonProps) {
  return (
    <button
      className={[
        'inline-flex ... rounded-md',
        variant === 'outline' ? 'border' : 'border-0', // variantes: uma cadeia por propriedade
        variant === 'secondary' ? 'bg-secondary' : variant === 'outline' ? 'bg-background' : 'bg-primary',
        className,
      ].filter(Boolean).join(' ')}
      style={style}
    >
      <span>{label}</span>
    </button>
  );
}
```

- **Props**: `string`/`color` viram `string`, `number` e `boolean` mantêm o tipo, `enum` vira a união de
  literais (as opções mais o padrão) e `slot` vira `ReactNode` (importado de `react`). O primeiro slot
  também aceita `children`. Toda prop é opcional, com o padrão do principal na desestruturação (só as
  props usadas no corpo são desestruturadas, o `tsc --noUnusedParameters` continua passando). Todo
  componente aceita `className` e `style`, mesclados na raiz (o `style` por último).
- **Placeholders**: `{{prop}}` vira `{label}` em texto, `title={`Selo ${texto}`}` em atributo e
- **URLs de props**: `{{prop}}` em `href`, `src`, `action`, `formaction`, `xlink:href` ou `srcdoc` sai como
  `href={safeUrl(url)}`; o arquivo ganha uma vez o helper `safeUrl` (`javascript:`, `vbscript:` e `data:`
  que não seja imagem viram `#`, ignorando espaços, controles e maiúsculas).
  `width: `calc(${largura}px + 2px)`` em estilo (nunca vira classe Tailwind). Num estado (`hover` etc.)
  o placeholder fica com o valor padrão.
- **Variantes**: cada propriedade de estilo (e de estado, no Tailwind) alterada por variantes vira uma
  cadeia de ternários `cond2 ? v2 : cond1 ? v1 : base`, na ordem das variantes (a última que bate ganha,
  como na expansão); no modo Tailwind a cadeia escolhe classes (`variant === 'outline' ? 'border' : 'border-0'`,
  sem conflito de classes), no inline escolhe valores do `style`. `text` de variante também vira ternário.
- **Slots**: o contêiner `data-slot` vira `{content ?? children ?? (<>conteúdo padrão</>)}`.
- **Instâncias**: `<Button variant="outline" label="Salvar" />`; o `style` da instância (posição, margem,
  largura) vai sempre inline em `style={{...}}` (ganha das classes do componente). Slots preenchidos: o
  primeiro como filhos JSX, os demais como prop (`footer={<Button label="Confirmar" />}`).
- **Expandida no lugar** (com o comentário `{/* instância de Button com overrides */}`): instância com
  `overrides`, `attrs`, `classes` ou `states`, contêiner de slot customizado (estilo, atributos), props não
  declaradas ou com valor fora do tipo (enum desconhecido, número inválido) e componente ausente.
- Nomes em PascalCase únicos: se o principal colide com o componente da tela (ou com outro), vira
  `Button2` / `Button2Props`.

Limitações: variantes que mudam `attrs`, `hidden`, `classes`, `src`, `svg` ou `props` de aninhadas não são
exportadas (o componente leva um comentário `// Nota:` listando os nós); `states` de uma instância e
condições de variante fora do tipo da prop são ignoradas ou expandidas; repetições em `map` não são
extraídas dentro do corpo dos componentes.

## Imagens e `assets/`

`src` de nós `image` é relativo a `assets/` (ou data URL). Em html/tailwind/react o `src` exportado é
`assets/<arquivo>` — copie a pasta `assets/` do documento ao lado do arquivo exportado (React:
`assetsBase` muda o prefixo, ex. `/img/`). Num projeto Vite, coloque a pasta em `public/assets/`
para o `src="assets/..."` resolver sem import. Em SVG as imagens só ficam autocontidas se `resolveImage`
devolver data URLs; sem ele o `src` original é mantido. As fontes embutidas (`fonts[]` com
`source: 'file'`) viram `@font-face` com `assets/<arquivo>` (html/tailwind/react) ou data URL (svg).

## Limitações conhecidas

- Tailwind: o mapeamento é por declaração. Seletores arbitrários e variantes que o modelo não
  representa (`group-hover:`, `has-[...]:`, `aria-*:`, `[&_svg]:`) só sobrevivem como texto em
  `node.classes` (com o motor saem verbatim no Tailwind), sem o CSS correspondente nos outros formatos.
  Propriedades de shorthand com formas raras (`border-radius` com `/`, `border-color` com 4 valores,
  `margin` com 5+ valores) caem em classe arbitrária ou `rest`. Sem o motor as classes seguem a
  documentação do v4; com ele o compilador oficial confere cada uma. Mesmo com o motor, `shadow-sm`,
  opacidade de cor (`bg-blue-500/50`), gradientes e `ring-*` saem, sem a dica `node.classes`, como
  classe arbitrária equivalente (`shadow-[...]`, `bg-[color-mix(...)]`) e não na forma idiomática.
- Estados: no HTML viram regras no `<style>` (`.slug:hover`, `@media (min-width: 768px)`,
  `.slug:where([data-theme="dark"], [data-theme="dark"] *)`; breakpoints valem pela largura da janela,
  não do frame). No modo `inline` o estilo base fica em `style=""` e os nós com estados ganham uma
  classe só para as regras dos estados, que saem com `!important` (o `style` inline venceria a
  cascata). Estados não são exportados no React inline nem no SVG.
- React: só atributos HTML conhecidos são emitidos; tags customizadas (`my-element`) precisam de
  declaração de tipos no projeto; `selected`/`value` em `option` podem gerar avisos do React.
  Extração de repetições é só para irmãos **consecutivos** e não aninha (dentro de um item, filhos
  repetidos ficam expandidos).
- SVG com layout: `transform`, `z-index`, `inset box-shadow`, sombras múltiplas, gradientes
  radiais/cônicos, `border-radius` elíptico e bordas por lado com raio não são reproduzidos; o texto
  usa a baseline aproximada medida e depende de a fonte existir onde o SVG for aberto (embuta a fonte
  ou converta em outlines).
- SVG sem layout: precisa de navegador com suporte a `foreignObject` (não funciona em vários editores
  vetoriais) e a altura é a declarada, não a medida.
- Quebras de linha de `text` sem `white-space` que preserve: no HTML/Tailwind seguem o CSS (viram
  espaço); no React viram `<br />`.
