# Tokens e temas

O design system de um documento é um conjunto de variáveis CSS (tokens), metadados opcionais (grupo e descrição) e temas que sobrescrevem tokens em frames inteiros. Tudo é CSS real: o que o editor mostra é o que o export entrega.

## Modelo

Três campos do `Document` (tipos em `packages/core/src/types.ts`):

| Campo       | Tipo                                           | Descrição                                                                            |
| ----------- | ---------------------------------------------- | ------------------------------------------------------------------------------------ |
| `tokens`    | `Record<string,string>`                        | Tokens base, equivalentes a `:root { --nome: valor }`.                               |
| `tokenMeta` | `Record<string,{ group?, description? }>`      | Grupo e descrição por token. Opcional; sem grupo, ele é deduzido do nome.            |
| `themes`    | `{ name, overrides: Record<string,string> }[]` | Temas. `overrides` são os tokens sobrescritos, equivalentes a `[data-theme="x"] {}`. |

O tema de um frame é o atributo HTML `data-theme` do nó (constante `THEME_ATTR`), em `node.attrs`. Vale para o nó e todos os descendentes; o tema do ancestral mais próximo vence. Nomes de token seguem `--[A-Za-z0-9_-]+`; nomes de tema, letras, dígitos, `-` e `_` (até 64 caracteres, começando por letra ou dígito).

```json
{
  "tokens": {
    "--blue-600": "#2563eb",
    "--slate-900": "#0f172a",
    "--color-primary": "var(--blue-600)",
    "--color-primary-hover": "color-mix(in oklch, var(--color-primary), black 15%)",
    "--color-surface": "#ffffff",
    "--space-4": "16px",
    "--space-card": "calc(var(--space-4) * 1.5)"
  },
  "tokenMeta": {
    "--color-primary": { "group": "color", "description": "Ação principal" }
  },
  "themes": [
    {
      "name": "dark",
      "overrides": { "--color-surface": "var(--slate-900)", "--blue-600": "#60a5fa" }
    }
  ]
}
```

E num frame escuro: `{ "attrs": { "data-theme": "dark" } }`.

## Grupos

Os grupos embutidos (`TOKEN_GROUPS`) são `color` (Cores), `typography` (Tipografia), `spacing` (Espaçamento), `radius` (Raio), `shadow` (Sombra) e `other` (Outros). `tokenMeta[nome].group` aceita também um nome livre, que aparece com o próprio nome.

Sem grupo explícito, `inferTokenGroup` decide pelo prefixo do nome e, se não houver prefixo conhecido, pelo valor:

- `color`/`colors`, `bg`, `background`, `fg`, `foreground`, `surface`, `border-color`, `accent`, `brand`: cor.
- `shadow`, `elevation`, `drop-shadow`, `inset-shadow`: sombra.
- `radius`, `radii`, `rounded`, `corner`: raio.
- `font`, `text`, `leading`, `tracking`, `line-height`, `letter-spacing`, `typography`, `type`: tipografia.
- `space`, `spacing`, `spacer`, `gap`, `size`, `padding`, `margin`, `inset`, `container`: espaçamento.
- Sem prefixo: hex, `rgb()`/`oklch()`/`color-mix()` ou cor nomeada viram cor; comprimento com unidade vira espaçamento; `0 4px 12px #0003` vira sombra; o resto é "Outros".

## Resolução

A semântica é a do CSS: uma variável é resolvida no elemento onde é declarada.

- **Escopo**: o `:root` resolve `tokens`. Um nó dentro de `data-theme="x"` vê os tokens base com as sobrescritas do tema; custom properties declaradas nos estilos dos ancestrais valem para os descendentes.
- **Aliases acompanham o tema**: `--color-primary: var(--blue-600)` muda sozinho quando o tema sobrescreve `--blue-600`. Para isso o CSS do tema redeclara também os tokens base que dependem (direta ou indiretamente) de um token sobrescrito, com o valor base, de modo que sejam resolvidos dentro do tema. Sobrescrever o próprio alias no tema também funciona.
- **Ciclos**: todas as variáveis do laço ficam sem valor (como no CSS) e aparecem como problema.
- **Fallback**: `var(--x, 8px)` usa o fallback se `--x` não existe. Sem fallback, a referência fica no texto e entra em `broken` do relatório.

### calc() e color-mix()

`getComputedLike(doc, nodeId, { theme?, evaluate? })` resolve o tema (o do nó ou o forçado em `theme`) e avalia `calc()` e `color-mix()` quando possível (ex.: `calc(var(--space-4) * 2)` vira `32px`; `color-mix(in oklch, #2563eb, black 15%)` vira uma cor). Com `evaluate: false` o texto é mantido. O CSS exportado mantém `calc()`/`color-mix()` como foram escritos.

### Validação

`validateTokenValue(name, value, { group, vars })` devolve `null` ou um problema:

- `error`: sintaxe inválida (parênteses/aspas desbalanceados, valor que escapa da declaração, vazio). O MCP recusa a chamada inteira.
- `warning`: aceito, mas suspeito (referência a token inexistente, ou o tipo não bate com o grupo, como uma cor num token de espaçamento). Entra na resposta.

A conferência de tipo resolve as `var()` e usa o lexer do css-tree por propriedade (`color`, `box-shadow`, `font-family`...).

**Por que css-tree**: é JavaScript puro e síncrono, com cerca de 200 KB no bundle `dist/csstree.esm`, que roda no navegador, no Node e nos bundles do Electron e do CLI. O lexer valida valores por propriedade, inclusive `color-mix()`. O `lightningcss-wasm` exigiria inicialização assíncrona e um binário WASM de vários MB, e é um transformador de CSS, não um validador por propriedade.

## Operações

Em `packages/core/src/ops.ts`, todas com inverso exato (um undo cada):

| Op              | Campos                            | Efeito                                                                                                         |
| --------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `setTokens`     | `set?`, `unset?`, `theme?`        | Define/remove tokens da base ou, com `theme`, das sobrescritas daquele tema (que precisa existir).             |
| `setTokenMeta`  | `set?`, `unset?`                  | Define (substitui por inteiro) ou remove grupo/descrição.                                                      |
| `setThemes`     | `themes`                          | Substitui a lista de temas (criar, remover, renomear, reordenar).                                              |
| `replaceTokens` | `tokens`, `tokenMeta?`, `themes?` | Troca o sistema inteiro; usado por importação e pelos inversos.                                                |
| `renameToken`   | `from`, `to`                      | Renomeia a chave (base, meta, temas) e todas as `var(--antigo)`. Resultado: `{ from, to, nodes, references }`. |

Os planejadores `planDeleteTokens`, `planApplyToken`, `planCreateTheme`, `planDeleteTheme`, `planRenameTheme`, `planSetFrameTheme` e `planImportTokens` montam as ops compostas (por exemplo, apagar um tema também tira o `data-theme` dos nós). `getTokenReport(doc)` devolve tokens com grupo, valor, valor resolvido (base e por tema), usos, problema, mais temas com seus frames, tokens não usados e referências quebradas.

## Ferramentas MCP

Toda ferramenta de escrita gera ops e aplica numa única chamada (uma entrada de undo, o mesmo caminho do editor). `get_guide('tokens')` traz o fluxo recomendado.

| Ferramenta        | Parâmetros                                                                 | Descrição                                                                                                 |
| ----------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `get_tokens`      | `group?`, `theme?`, `format?` (`text`/`json`), `docId?`                    | Tokens por grupo (valor, resolvido, descrição, usos, não usado, problema), temas e referências quebradas. |
| `set_tokens`      | `tokens?`, `unset?`, `theme?`, `groups?`, `descriptions?`, `docId?`        | Define/remove tokens, na base ou num tema; grava grupo e descrição.                                       |
| `rename_token`    | `from`, `to`, `docId?`                                                     | Renomeia e atualiza todas as referências.                                                                 |
| `apply_token`     | `nodeIds`, `property`, `token`, `docId?`                                   | Grava `propriedade: var(--token)` nos nós.                                                                |
| `create_theme`    | `name`, `overrides?`, `copyFrom?`, `docId?`                                | Cria um tema.                                                                                             |
| `delete_theme`    | `name`, `docId?`                                                           | Remove o tema e o `data-theme` dos frames.                                                                |
| `rename_theme`    | `from`, `to`, `docId?`                                                     | Renomeia o tema e o `data-theme` dos frames.                                                              |
| `set_frame_theme` | `nodeIds`, `theme` (nome ou `null`), `docId?`                              | Define o tema dos frames; `null` volta aos tokens base.                                                   |
| `import_tokens`   | `content`, `format?` (`css`/`json`), `mode?` (`merge`/`replace`), `docId?` | Importa CSS ou DTCG; devolve contagens e avisos.                                                          |
| `export_tokens`   | `format` (`css`/`json`/`tailwind`), `docId?`                               | Devolve o texto.                                                                                          |

`get_styles` aceita `theme` para mostrar os valores como se o nó estivesse naquele tema.

```js
set_tokens({
  tokens: {
    '--blue-600': '#2563eb',
    '--color-primary': 'var(--blue-600)',
    '--color-primary-hover': 'color-mix(in oklch, var(--color-primary), black 15%)',
    '--space-4': '16px',
  },
  groups: { '--blue-600': 'color' },
  descriptions: { '--color-primary': 'Ação principal' },
});
create_theme({ name: 'dark', overrides: { '--blue-600': '#60a5fa' } });
set_frame_theme({ nodeIds: ['fr_ab12cd34'], theme: 'dark' });
get_styles({ nodeIds: ['el_ab12cd34'], theme: 'dark' });
rename_token({ from: '--color-brand', to: '--color-primary' });
```

Regras do `set_tokens`: nomes sem `--` ganham o prefixo; `unset` sem `theme` remove da base, dos metadados e de todos os temas (`planDeleteTokens`); com `theme`, só das sobrescritas. Erro de valor recusa a chamada inteira; aviso entra na resposta. `groups` e `descriptions` mesclam com o meta existente (descrição vazia apaga).

## Importar e exportar

| Formato    | Importação                                                                                      | Exportação                                                                                                                                                                  |
| ---------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `css`      | `:root { ... }` para a base e `[data-theme="x"] { ... }` para temas; também lê `@theme`.        | `:root` e um `[data-theme="x"]` por tema (com os aliases dependentes redeclarados).                                                                                         |
| `json`     | W3C Design Tokens (DTCG): grupos aninhados, `$value`, `$type`, `$description`, aliases `{a.b}`. | Os mesmos campos; o grupo do Mockup Studio e os valores por tema ficam em `$extensions["mockup-studio"]`.                                                                   |
| `tailwind` | (use `css`; `@theme` é lido)                                                                    | Tailwind v4: `@theme { ... }` para os namespaces de tema, `:root` para o resto, regras de tema e `@custom-variant theme-<nome>` (mais `dark` quando existe um tema `dark`). |

`import_tokens` com `mode: "merge"` (padrão) mantém o que existe e sobrescreve nomes repetidos (temas são mesclados por nome); `replace` troca tokens, metadados e temas. O resultado traz `warnings` (regras ignoradas, valores descartados).

## Exportadores de código

Os exportadores de projeto (ver [EXPORT.md](EXPORT.md)) usam o mesmo sistema:

- **HTML**: `:root { ... }` com os tokens e `[data-theme="x"] { ... }` por tema; os frames mantêm o atributo `data-theme`.
- **Tailwind**: o bloco acima (`@theme`, regras de tema e `@custom-variant`).
- **React inline**: os estilos inline mantêm `var(--token)` e o CSS de tokens vem junto.

## Editor

Detalhes e gestos em [EDITOR.md](EDITOR.md#tokens-e-temas). Toda ação do painel gera as mesmas ops das ferramentas MCP (mesmo undo).

| No editor                                              | Ferramenta MCP                                    |
| ------------------------------------------------------ | ------------------------------------------------- |
| Aba **Tokens**: criar, editar valor, grupo e descrição | `set_tokens` (`tokens`, `groups`, `descriptions`) |
| Renomear (duplo clique no nome)                        | `rename_token`                                    |
| Excluir token                                          | `set_tokens` com `unset`                          |
| Tema em edição + editar valor / remover sobrescrita    | `set_tokens` com `theme` (e `unset`)              |
| Criar, renomear e excluir tema                         | `create_theme`, `rename_theme`, `delete_theme`    |
| Importar (colar CSS ou JSON) e Exportar                | `import_tokens`, `export_tokens`                  |
| Ícone "ligar a token" nos inputs de propriedades       | `apply_token`                                     |
| Linha **Tema** do frame no painel de propriedades      | `set_frame_theme`                                 |
| Avisos de não usado e de quebrado                      | `get_tokens` (`unused`, `broken`, `problem`)      |

O canvas e a página de render (screenshot) injetam as regras de tema com o escopo `.cv-world `, então o que o agente vê em `get_screenshot` é o mesmo CSS do HTML exportado.
