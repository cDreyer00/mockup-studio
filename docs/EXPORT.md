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

## CSS base do documento

`documentBaseCss` (`packages/core/src/base.ts`) é a fonte única do CSS base: o canvas, a página de render (screenshot) e o código exportado usam o mesmo, então os três saem idênticos. O CSS da interface do editor não vaza no design. Ele define:

- `box-sizing: border-box` e `margin: 0` em tudo (`*`, `::before`, `::after`);
- controles (`button`, `input`, `select`, `textarea`) herdam fonte, cor e `letter-spacing`;
- tipografia padrão da raiz (`body` no código exportado): fonte do sistema (`system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif`), 16px, `line-height: normal`, texto preto.

Nos formatos html, react com estilos inline e svg ele entra como CSS (`BASE_CSS`). No Tailwind o preflight já cobre o reset e os controles, então só a tipografia da raiz vira `@layer base { body { ... } }` no `theme.css` (`TAILWIND_BASE_CSS`, dentro de `tailwindThemeCss`).

## html

```ts
exportHtml(doc, { pageId?, nodeIds?, title?, mode?: 'classes' | 'inline', fragment?: boolean }): string
```

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
exportTailwind(doc, { pageId?, nodeIds?, title?, fragment?: boolean, cdn?: boolean }): string
cssToTailwind(style, { tokens? }): { classes: string[]; rest: Record<string, string> }
tailwindThemeCss(doc, { import?: boolean }): string
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
`--text-<tamanho>--line-height: inherit;` para cada tamanho nomeado usado.

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

- `styles: 'tailwind'` (padrão): `className` com as classes acima; `css` traz `tailwindThemeCss(doc)`
  (coloque num `.css` importado pelo app, com o Tailwind v4 instalado).
- `styles: 'inline'`: `style={{ backgroundColor: 'var(--color-bg)' }}` (camelCase, tudo string com
  unidade). Os tokens do documento viram custom properties no `style` do elemento **raiz**
  (`{ '--color-bg': '#0f1115', ... } as CSSProperties`, com `import type { CSSProperties } from 'react'`).
  `css` traz o CSS base do documento e os `@font-face`.
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

## Imagens e `assets/`

`src` de nós `image` é relativo a `assets/` (ou data URL). Em html/tailwind/react o `src` exportado é
`assets/<arquivo>` — copie a pasta `assets/` do documento ao lado do arquivo exportado (React:
`assetsBase` muda o prefixo, ex. `/img/`). Em SVG as imagens só ficam autocontidas se `resolveImage`
devolver data URLs; sem ele o `src` original é mantido. As fontes embutidas (`fonts[]` com
`source: 'file'`) viram `@font-face` com `assets/<arquivo>` (html/tailwind/react) ou data URL (svg).

## Limitações conhecidas

- Tailwind: o mapeamento é por declaração; seletores, pseudo-classes, `@media` e estados não existem no
  modelo e, portanto, não são exportados. Propriedades de shorthand com formas raras (`border-radius`
  com `/`, `border-color` com 4 valores, `margin` com 5+ valores) caem em classe arbitrária ou `rest`.
  Não rodamos o compilador do Tailwind nos testes: as classes seguem a documentação do v4.
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
