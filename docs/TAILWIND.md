# Tailwind CSS v4 nativo

O Mockup Studio aceita Tailwind CSS v4 como forma de escrever o design: o agente (ou o usuário,
colando HTML) escreve markup com classes Tailwind, o canvas renderiza o resultado e a exportação
devolve Tailwind idiomático. O modelo do documento continua sendo **CSS real por nó**
(`node.style`); as classes são traduzidas pelo compilador oficial do Tailwind.

## Visão geral

```
 classes Tailwind (write_html, import_component, set_classes, colar, painel "Classes")
        |  @mockup/core/tailwind  (compilador oficial `tailwindcss` v4)
        v
 node.style  +  node.states { hover, dark, md, md:hover, ... }  +  node.classes (dica)
        |  render (canvas, screenshot)          |  exportação
        v                                       v
 resolveStateStyle(node, frame, tema, prévia)   engine.nodeClasses(node) → classes canonicalizadas
```

## Onde roda o compilador

- O pacote `tailwindcss` v4 é JavaScript puro, sem dependências e sem APIs de Node ou DOM (é o
  mesmo núcleo do `@tailwindcss/browser`). Por isso o motor fica **no core**, no subpacote
  `@mockup/core/tailwind` (`packages/core/src/tailwind/`), e roda igual no daemon, no editor, no
  Electron e nos testes. Não usamos `@tailwindcss/node`: ele depende de `fs`/`lightningcss` nativo
  e só serviria no daemon.
- O subpacote fica **fora do índice principal** do core: o editor o carrega sob demanda
  (`import('@mockup/core/tailwind')`), num chunk separado, para não pesar no canvas.
- A API usada é o design system do compilador (`__unstable__loadDesignSystem`): `candidatesToAst`
  (classe → regras CSS), `parseCandidate`/`printCandidate` (variantes), `getClassOrder` (ordem da
  cascata), `canonicalizeCandidates` (`p-[16px]` → `p-4`, `mt-2 mb-2` → `my-2`) e `getClassList`
  (autocomplete). A API é marcada como instável pelo Tailwind: a versão fica fixada (exata,
  `4.3.5`) no `package.json` do core, os testes de round-trip pegam mudanças de comportamento e
  um teste em `canonicalize.test.ts` falha com mensagem clara se mudar a forma de
  `utilities.keys`/`getClassList`/`canonicalizeCandidates`, que o motor sobrescreve no design
  system leve. Ao atualizar o `tailwindcss`, rode esse teste primeiro.
- O tema padrão (`tailwindcss/theme.css`) é embutido em `theme.generated.ts` pelo script
  `packages/core/scripts/sync-tailwind-theme.mjs` (rode-o ao atualizar o `tailwindcss`; um teste
  falha se o arquivo gerado estiver desatualizado), porque o core não lê arquivos.

### Motor por documento e cache

`getTailwindEngine(doc)` cria (assíncrono, ~20 ms) um motor com:

- o tema padrão do Tailwind como `@theme default inline` — os valores entram no nó já resolvidos
  (`p-4` → `padding: 1rem`, `bg-blue-500` → `oklch(62.3% 0.214 259.815)`);
- os tokens do documento que caem num namespace de tema (`--color-*`, `--font-*`, `--text-*`,
  `--radius-*`, `--shadow-*`, `--spacing`, `--breakpoint-*`...) como `@theme` comum — o nó fica
  **ligado ao token** (`bg-primary` → `background-color: var(--color-primary)`), então trocar o
  token ou o tema muda o render;
- `@custom-variant dark (&:where([data-theme=dark], [data-theme=dark] *))` e as variantes
  `theme-<nome>` dos temas do documento.

O cache é chaveado pelos tokens que entram no `@theme` (e pelos nomes de tema): mudar um token
gera uma chave nova e um motor novo na próxima chamada, sem invalidação manual. Guarda os 8
últimos motores. Depois de criado, tudo é síncrono e com cache por classe. Ao criar um motor, o
cache agenda `engine.warmup()` em ocioso (`requestIdleCallback` no editor, `setTimeout(0)` no
daemon, depois de responder; `getTailwindEngine(doc, { warmup: false })` desliga), para o
primeiro "Mostrar como Tailwind" e o primeiro `get_code` não travarem. Caminhos sem Tailwind
(`get_code`/`export` com `styles: 'inline'`) não carregam o motor.

## Classes → estilo

`engine.classesToStyles(classes)`:

1. Cada classe é lida pelo próprio Tailwind (`parseCandidate`). As variantes são separadas da
   utilidade; a utilidade sem variantes é compilada (`candidatesToAst`).
2. As declarações são aplicadas na **ordem da cascata do Tailwind** (`getClassOrder` da lista
   inteira de classes, por estado), não na ordem do atributo (`p-4 px-2` e `px-2 p-4` dão o
   mesmo resultado, como no navegador: `px-2` vem depois de `p-4` no CSS e vence no eixo
   horizontal; idem `border border-b-0`, `rounded-lg rounded-t-none`, `hover:p-1 hover:px-8`);
   `!important` vence declarações comuns e é gravado como `valor !important`.
3. As variáveis internas (`--tw-shadow`, `--tw-ring-color`, `--tw-border-style`,
   `--tw-gradient-*`...) são **resolvidas no próprio nó**, com os `initial-value` dos `@property`
   e os fallbacks — o estilo gravado é CSS comum, editável no painel:
   `shadow-md` → `box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)`;
   `ring-2 ring-blue-500` → `box-shadow: 0 0 0 2px oklch(...)`. Camadas vazias de sombra
   (`0 0 #0000`) saem; `calc()` sem `var()` é avaliado (`calc(0.25rem * 4)` → `1rem`).
4. Variáveis do documento (tokens) ficam como `var(...)`.

Resultado: `{ style, states, children?, applied, unknown, unsupported }`.

### Variantes → `node.states`

| Variante do Tailwind                                                          | Onde fica               | Quando vale no canvas/screenshot                                                  |
| ----------------------------------------------------------------------------- | ----------------------- | --------------------------------------------------------------------------------- |
| `hover:`, `focus:`, `focus-visible:`, `focus-within:`, `active:`, `disabled:` | `states.hover` etc.     | Na prévia de estado do editor e em `get_screenshot(state)`                        |
| `dark:`                                                                       | `states.dark`           | Dentro de um frame/nó com tema `dark` (`data-theme="dark"`) ou na prévia `dark`   |
| `sm:` `md:` `lg:` `xl:` `2xl:`                                                | `states.md` etc.        | Quando a **largura do frame raiz** é ≥ breakpoint (640, 768, 1024, 1280, 1536 px) |
| Combinações (`md:hover:`, `dark:hover:`, `lg:dark:focus:`)                    | `states["md:hover"]`... | Quando todas as partes valem                                                      |

- A chave é canônica (`breakpoint:dark:pseudo`); `hover:md:` vira `md:hover`.
- Cada estado guarda só o que muda em relação ao estilo base (inclusive propriedades
  recalculadas por variáveis: `hover:ring-red-500` grava o `box-shadow` inteiro do estado).
- Ordem de aplicação (como a especificidade do CSS gerado): base, breakpoints em ordem
  crescente, `dark`, e por último os estados com pseudo-classe.
- `dark:` corresponde ao tema `dark` do documento (fase de tokens): o mesmo `data-theme` que
  troca os tokens ativa as classes `dark:`. Na exportação Tailwind sai a mesma `@custom-variant`.
- Prévia `dark` (editor e `get_screenshot(state: 'dark')`): se o documento tem um tema chamado
  `dark`, o frame raiz renderizado ganha `data-theme="dark"` (só no DOM; o documento não muda),
  então os tokens trocam junto com as variantes `dark:`, como em `get_styles(state: 'dark')`.
  Sem tema `dark`, só as variantes `dark:` são aplicadas.
- Dark aninhado: `dark:` vale em toda a subárvore de um nó dark, mesmo dentro de um descendente
  com `data-theme="light"` (os tokens desse descendente voltam ao tema claro, mas as variantes
  `dark:` continuam ligadas). É o que o CSS exportado faz (`[data-theme=dark] *`), e o canvas
  segue a mesma regra.

### Breakpoints e frames

Os frames são os viewports do design. Um `md:flex-row` vale num frame de 1280 px e não num de
375 px: o mesmo markup responsivo renderiza "mobile" ou "desktop" conforme o frame onde está. Para
ver as duas versões, duplique o frame e mude a largura (o guia `responsive` do MCP já recomenda
frames Mobile/Tablet/Desktop). Na exportação, as classes `md:` voltam como estão e passam a valer
pelo viewport do navegador, como em qualquer projeto Tailwind.

As larguras vêm dos tokens `--breakpoint-sm` … `--breakpoint-2xl` do documento (px ou rem; os
ausentes usam o padrão do Tailwind), por um único helper (`breakpointsOf(doc)`): com
`--breakpoint-md: 900px`, `md:` ativa a partir de 900 px no canvas, no screenshot, no
`get_styles`, no `@media` do export HTML e no Tailwind compilado. `get_styles(state: 'md')`
simula a largura mínima do `md` do documento mesmo num frame mais estreito.

### O que não vira estilo

| Caso                                                                                                                   | Tratamento                                                                                                                                                                                   |
| ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Classe que o Tailwind não conhece (`group`, `peer`, `minha-classe`)                                                    | `unknown`: fica em `node.classes`, sem efeito, e volta igual na exportação                                                                                                                   |
| Variante sem equivalente (`group-hover:`, `peer-*:`, `aria-*:`, `data-*:`, `before:`, `[&_svg]:`, `max-md:`, `has-*:`) | `unsupported` (com o motivo): fica em `node.classes` e volta igual na exportação                                                                                                             |
| Utilidade com `@media` próprio ou seletor de pseudo-elemento (`container`, `placeholder:*`)                            | `unsupported`                                                                                                                                                                                |
| Classes de filhos (`space-y-2`, `space-x-*`, `divide-y`, `*:p-2`)                                                      | O CSS vai para os filhos (abaixo das classes deles); a classe do pai não é reexportada. Tirar a classe (`remove`/`replace`) desfaz o que ela gravou nos filhos que ainda têm o valor gravado |
| `animate-*`                                                                                                            | `animation` é gravada, mas os `@keyframes` não existem no canvas (não anima)                                                                                                                 |

`write_html`/`import_component` informam as classes `unknown`/`unsupported` na resposta.

## `node.classes`: a dica de round-trip

`node.classes` guarda as classes **como foram escritas**. O render nunca usa esse campo (usa
`style`/`states`); ele serve para a exportação devolver as classes do autor:

- `engine.nodeClasses(node)` compila `node.classes` e, para cada classe, confere se as
  propriedades que ela produz (inclusive via variáveis `--tw-*`: `from-red-500` afeta o
  `background-image` de `bg-linear-to-r`) **ainda batem** com o estilo atual do nó, por estado.
  As que batem são reaproveitadas na ordem original; as demais propriedades geram classes novas.
- Editou o padding no painel? `p-4` deixa de bater e sai `p-6` (ou o que corresponder); o resto
  continua como o autor escreveu. Renomeou um token? `renameToken` reescreve também as classes
  (`bg-brand`, `hover:bg-brand/90`, `bg-[var(--color-brand)]` → `accent`) quando origem e destino
  estão no mesmo namespace; o undo devolve as classes antigas.
- Classes `unknown`/`unsupported` voltam sempre (o modelo não sabe conferir).
- No load do arquivo, classes com caracteres proibidos (`<`, `{`, `}`, `;`, `"`, crase) são
  descartadas e as válidas ficam: a mesma regra da op `setClasses` e do import de HTML.
- Os usos de tokens em `node.states` (ex.: `hover:bg-hov`) contam no relatório de tokens
  (`get_tokens`): não aparecem como não usados, e referências quebradas num estado saem com
  `property: 'state:hover:background-color'`.

**Por que um campo próprio e não `attrs.class`:** `attrs` é documentado como "sem `style` e sem
`class`" e vários pontos (sanitização do import, exportadores, `setAttrs`, render) removem ou
recusam `class`; no canvas, um `class="hidden flex"` real colidiria com o CSS da interface do
editor. Um campo separado deixa claro que é uma dica, não CSS aplicado.

## Estilo → classes (exportação idiomática)

`engine.stylesToClasses(style)`:

1. Mapeamento estático do MVP (`cssToTailwind`: escala de spacing, cores do tema e tokens do
   documento, tipografia, bordas, sombras, flex/grid, `[prop:valor]` como último recurso).
2. **Canonicalização** pelo próprio Tailwind (`canonicalizeCandidates`, com `rem: 16` e
   `collapse`): `p-[16px]` → `p-4`, `bg-[#6c5ce7]` → `bg-primary` (se o token existe),
   `pt-4 pb-4` → `py-4`, `text-sm leading-[1.25]` → `text-sm/tight`.
3. **Conferência**: as classes resultantes são compiladas de novo e comparadas com o estilo
   (valores normalizados: rem ↔ px, cores em hex). Classe que não reproduz o valor vira
   `[prop:valor]`; classes redundantes (ex.: `border-solid` junto de `border`) saem.

**Custo da canonicalização:** na primeira chamada de cada motor, `canonicalizeCandidates`
calcula a assinatura de todas as classes do `getClassList()` (~23 mil) e, para cada valor
arbitrário novo, testa todas as raízes funcionais. O motor usa um design system "leve", sem as
classes e raízes `mask-*`, `scroll-*` e `scrollbar-*` (só declaram propriedades
`mask*`/`scroll*`, logo nunca têm a assinatura de outra classe), e só recorre à lista completa
quando a entrada toca nessas propriedades: o resultado é idêntico (teste em
`canonicalize.test.ts`). Resultados ficam em cache por motor; `engine.warmup()` adianta o
aquecimento. Landing: primeira exportação a frio 2,4 s → 1,2 s; depois de `warmup()` ~0,3 s;
repetida ~15 ms.

A saída é, portanto, sempre fiel ao render, e idiomática sempre que o Tailwind tem um nome para
o valor. Os estados saem com o prefixo da variante (`hover:`, `md:`, `dark:`, `md:hover:`).
`style=""` só leva valores que não podem virar classe arbitrária segura (com `{`, `}`, `;`, `<`,
`>` ou crase); qualquer outra propriedade sai como `[prop:valor]`, então um estilo inline nunca
anula um `hover:`/`md:` da mesma propriedade.

`text-*` e `line-height`: nós escritos em CSS costumam ter só `font-size` (altura de linha
herdada). Quando algum nó usa um tamanho nomeado sem o `line-height` padrão do Tailwind, o tema
exportado neutraliza aquele tamanho (`--text-sm--line-height: inherit`) e a conferência leva isso
em conta. Nós importados de Tailwind já trazem o par `font-size` + `line-height` e dispensam a
neutralização.

## CSS base (`cssBase`)

Tailwind pressupõe o preflight (reset de margens, bordas `0 solid`, títulos sem tamanho próprio,
botões sem fundo, listas sem marcador, `img` em bloco). O documento ganha `cssBase: 'tailwind'`:

- o CSS base do documento (`documentBaseCss`, o mesmo no canvas, no render e no código) passa a
  incluir o preflight do Tailwind v4 (`TAILWIND_PREFLIGHT`, escopado no canvas) e a raiz
  tipográfica do Tailwind (fonte `--font-sans`, `line-height: 1.5`);
- `write_html`, `import_component` e colar no editor ligam a base automaticamente no primeiro
  import Tailwind (na mesma op, um undo), avisando na resposta;
- `set_css_base('default' | 'tailwind')` no MCP e o seletor "CSS base" no painel do documento
  ligam/desligam. Trocar a base afeta todos os nós do documento (ex.: `h1` sem tamanho próprio).

## shadcn/ui e componentes colados

Componentes do shadcn/ui usam cores semânticas (`bg-primary`, `text-muted-foreground`,
`border-input`) que só existem com as variáveis do tema do shadcn. `import_component(html)`:

- detecta classes que usam essas cores (`usesShadcnColor`) e cria os tokens que faltam do preset
  "neutral" do shadcn v4 (`--color-background`, `--color-primary`, `--color-card`, `--color-border`,
  `--radius` e `--radius-sm..xl` relativos, etc.) e o tema `dark` com as sobrescritas
  (`planShadcnTokens`); tokens já definidos não são tocados;
- aplica a regra base do shadcn `* { border-color: var(--color-border) }` como `border-color` nos
  nós com borda e sem cor (em qualquer escrita Tailwind, quando o documento tem os tokens
  `--color-border` e `--color-primary` do preset);
- nomeia as camadas pelo `data-slot` (`Card header`, `Card title`...).

Colar no editor segue a mesma regra do `import_component`: cria os tokens shadcn que faltam (nas
mesmas ops da colagem, um undo, com um aviso na tela) e aplica a borda padrão
`var(--color-border)`. `write_html` só cria os tokens com `tokens: 'auto'`.

## Ferramentas e interface

| Interface (editor)                               | MCP                                                                                         |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| Colar HTML com classes Tailwind                  | `write_html` (detecção automática, `tailwind: 'on'`, `css: 'tailwind'`), `import_component` |
| Campo "Classes" no painel de propriedades        | `set_classes(nodeIds, classes, mode)`                                                       |
| Autocomplete do campo de classes                 | `suggest_classes(query)`                                                                    |
| "Mostrar como Tailwind"                          | `get_classes(nodeIds)`, `get_code(format: 'tailwind')`                                      |
| Prévia de estado (hover, focus, active, dark...) | `get_screenshot(state)`, `get_styles(state)`                                                |
| Lista de estados do nó (remover um estado)       | `get_node_info`, `update_styles(state, unset)`, `set_classes(mode: 'remove')`               |
| Classes `hover:`/`md:`/`dark:` no campo          | `set_classes`, `update_styles(state)` (grava o CSS direto no estado)                        |
| Seletor "CSS base" do documento                  | `set_css_base`, `get_tailwind_config`                                                       |
| Exportar Tailwind/React                          | `export`, `get_code`                                                                        |

Guia para agentes: `get_guide('tailwind')`. Detalhes de cada ferramenta em [MCP.md](MCP.md), da
interface em [EDITOR.md](EDITOR.md) e da exportação em [EXPORT.md](EXPORT.md).

## Limitações conhecidas

- Variantes de grupo/irmão/atributo (`group-hover:`, `peer-*`, `aria-*`, `data-*`, `has-*`),
  pseudo-elementos (`before:`, `after:`, `placeholder:`), variantes arbitrárias (`[&_svg]:`) e
  `max-*:` não afetam o render; ficam preservadas na classe.
- No editor, os estados são editados pelo campo de classes (`hover:bg-...`); os campos de estilo
  do painel (tamanho, tipografia...) editam sempre o estilo base, mesmo com a prévia ativa. O MCP
  grava CSS direto num estado com `update_styles(state)`.
- O campo de classes aplica em modo `replace`: as classes passam a ser o estilo do nó (apagar as
  classes de um nó limpa o estilo gerado por elas). Num nó sem `node.classes` o campo abre com as
  classes equivalentes ao estilo atual (`engine.nodeClasses`). O `replace` (campo e
  `set_classes`) mantém o posicionamento (`position`, `left`, `top`, `right`, `bottom`,
  `z-index`) e o CSS sem classe equivalente quando as classes novas não definem essas
  propriedades; para removê-los, use `update_styles(unset)`.
- A prévia de estado do editor é global (vale para todos os nós e não muda ao trocar de
  documento).
- Sem a dica `node.classes`, alguns valores saem como classe arbitrária equivalente em vez da forma
  idiomática (`shadow-sm`, `ring-*`, `bg-blue-500/50`, gradientes `bg-linear-*`): a saída recompila
  para o mesmo estilo, só é menos legível.
- HTML e React inline não levam o CSS das classes que o modelo não representa (`aria-*:`,
  `has-[...]:`, `[&_svg]:`, `group-hover:`); a exportação Tailwind as devolve como estão.
- `animate-*` não anima no canvas; transições não são simuladas na prévia.
- A exportação React com `styles: 'inline'` e o SVG não levam os estados.
- Breakpoints personalizados (`--breakpoint-*` nos tokens) mudam a largura de `sm` … `2xl`, mas
  nomes novos (`--breakpoint-3xl`) só entram no compilador: os estados do nó reconhecem apenas
  `sm`, `md`, `lg`, `xl` e `2xl`.
