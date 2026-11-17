# Componentes

Componentes reutilizáveis do documento: um **principal** (`ComponentDef`, na biblioteca `doc.components`) e **instâncias** (`type: 'instance'`) espalhadas pelas páginas. Editar o principal propaga para todas as instâncias; cada instância tem **props**, **slots** e **overrides** próprios. Há um kit padrão (`kits/shadcn-like.mockup.json`) importável em qualquer documento.

Tipos em `packages/core/src/types.ts`; lógica em `packages/core/src/components/`.

## Modelo

### ComponentDef

| Campo         | Tipo                 | Descrição                                                                                     |
| ------------- | -------------------- | --------------------------------------------------------------------------------------------- |
| `id`          | string               | `cp_xxxxxxxx` (kits usam ids estáveis próprios, ex. `cp_sbutton1`).                           |
| `name`        | string               | Nome (PascalCase recomendado: vira o nome do componente React). Único no documento.           |
| `description` | string (opcional)    | Descrição para agentes e para o painel.                                                       |
| `kit`         | string (opcional)    | Kit de origem (`shadcn-like`). Referência `kit/Nome` no MCP (`shadcn-like/Button`).           |
| `props`       | `PropDef[]`          | Propriedades, na ordem de exibição.                                                           |
| `root`        | `Node`               | Árvore do principal (nunca `type: 'frame'`; sem `position`). Ids únicos no documento inteiro. |
| `variants`    | `ComponentVariant[]` | Sobrescritas condicionais pelas props (ver Variantes).                                        |

`doc.components` fica ausente quando vazio: documentos antigos continuam válidos sem migração.

### PropDef

| Campo         | Tipo                                                               | Descrição                                   |
| ------------- | ------------------------------------------------------------------ | ------------------------------------------- |
| `name`        | string                                                             | Identificador (`label`, `variant`, `open`). |
| `type`        | `'string' \| 'number' \| 'boolean' \| 'enum' \| 'color' \| 'slot'` | Tipo, define o controle no painel.          |
| `default`     | `string \| number \| boolean` (opcional)                           | Valor padrão (slots não têm).               |
| `options`     | `string[]` (opcional)                                              | Opções de `enum`.                           |
| `description` | string (opcional)                                                  |                                             |

Como cada tipo age na árvore:

- **string, number, color**: por **placeholder** `{{nome}}` em `text`, valores de `attrs`, valores de `style` e `states`, `src` e props (string) de instâncias aninhadas. Ex.: texto `{{label}}`, estilo `background: {{color}}`. O valor é convertido para string e substituído literalmente.
- **boolean e enum**: por **variantes** (`when: { variant: 'outline' }`, `when: { disabled: true }`). Também valem em placeholders.
- **slot**: o contêiner do principal com o atributo `data-slot="<nome>"` (e uma prop `slot` com esse nome) é o ponto onde entra o conteúdo da instância. Os filhos do contêiner no principal são o conteúdo padrão.

### Variantes

```ts
interface ComponentVariant {
  when: Record<string, PropValue>; // todas as props precisam bater (comparação por String())
  overrides: Record<string, NodeOverride>; // chave '' = raiz do principal
}
```

As variantes que batem são aplicadas na ordem da lista (a última ganha). Ex.: o Button do kit tem `variant` (enum `default | secondary | outline | ghost | destructive`) e uma variante por opção que troca `background`, `color`, `border` e o `hover`.

### Instância

Um nó `type: 'instance'`:

| Campo                                 | Descrição                                                                                                           |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `id`                                  | `in_xxxxxxxx`.                                                                                                      |
| `componentId`                         | Id do principal.                                                                                                    |
| `props`                               | Valores das props (só os que diferem do padrão).                                                                    |
| `overrides`                           | `Record<caminho, NodeOverride>`: sobrescritas por nó do principal.                                                  |
| `style`, `attrs`, `states`, `classes` | Sobrescrevem a **raiz** do principal (mesclados por cima). `position`, `name`, `hidden`, `locked` são da instância. |
| `tag`                                 | Ignorada na expansão (vale a tag da raiz do principal); guardada igual à do principal.                              |
| `children`                            | Só **contêineres de slot** (ver Slots).                                                                             |

### Slots

O conteúdo de cada slot fica nos **filhos reais** do nó instância: um contêiner por slot, `{ type: 'element', tag: 'div', name: 'Slot <nome>', attrs: { 'data-slot': '<nome>' } }`, cujos filhos são o conteúdo. Assim todas as ops existentes (`createNode`, `moveNodes`, `deleteNodes`, `setText`...), o painel de camadas, `findNode` e a seleção funcionam no conteúdo de slot sem código novo.

- Instâncias são criadas com um contêiner para cada prop `slot` (vazio = usa o conteúdo padrão do principal).
- Na expansão, o contêiner `data-slot` do principal é renderizado com o **id do contêiner da instância**, o estilo do principal mesclado com o `overrides[id do contêiner do principal]` e por cima o `style` do contêiner da instância; os filhos são os do contêiner da instância (ou, se ele estiver vazio, o conteúdo padrão do principal).
- A instância só aceita filhos que sejam contêineres de slot: `createNode`/`moveNodes` com `parentId` da instância é recusado ("insira dentro de um slot").
- Inserir num contêiner de slot virtual (id expandido do principal) cria o contêiner real da instância (id determinístico) e insere nele.

Decisão: o enunciado original previa `slots: Record<string, Node[]>`; guardar os slots como filhos reais evita duplicar a lógica de árvore (busca, ops, camadas, clipboard) para um segundo lugar onde nós moram.

### Overrides (NodeOverride)

```ts
interface NodeOverride {
  style?: Record<string, string>; // mesclado
  unsetStyle?: string[]; // remove do principal
  text?: string;
  attrs?: Record<string, string>; // mesclado
  hidden?: boolean;
  classes?: string;
  states?: Record<string, Record<string, string>>; // mesclado por variante de estado
  src?: string;
  svg?: string;
  props?: Record<string, PropValue>; // props de instância aninhada
}
```

**Caminho**: ids dos nós do principal separados por `/`. Um nó direto do principal é `el_label01`; um nó dentro de uma instância aninhada no principal é `<id da instância aninhada no principal>/<id do nó no principal dela>` (ex. `in_okbtn001/tx_label01`). Ids são estáveis: inserir ou reordenar nós no principal não invalida overrides (overrides de nós que deixaram de existir são ignorados).

## Expansão

`expandInstance(doc, instance)` devolve a árvore concreta da instância; `expandDocument(doc)` devolve o documento com todas as instâncias expandidas (mesmos objetos onde não há instância; cache por documento). Render do canvas, página de render (screenshot), `get_layout` e os exportadores HTML/Tailwind/SVG usam a árvore expandida. O React gera um componente por principal (ver Exportação).

Ordem de aplicação, para a instância `I` do componente `C`:

1. Clona `C.root`.
2. Props efetivas = padrões de `C.props` + `I.props`.
3. Variantes de `C` cujo `when` bate, na ordem.
4. Placeholders `{{prop}}`.
5. `I.overrides` (depois das variantes: o que a instância mudou ganha).
6. Raiz: `I.style`, `I.attrs`, `I.states`, `I.classes` mesclados sobre a raiz; `position`, `name`, `hidden`, `locked` da instância.
7. Slots (ver acima).
8. Instâncias aninhadas são expandidas recursivamente, recebendo os overrides de `I` com o prefixo do seu caminho.

### Ids expandidos

- A raiz expandida tem o id da instância e mantém `componentId` e `props` como marcador (o tipo vira o da raiz do principal).
- Nós vindos da árvore de um principal recebem id **virtual** `<id da instância>/<caminho>` (ex. `in_ab12cd34/tx_label01`, aninhado `in_ab12cd34/in_okbtn001/tx_label01`). `isVirtualId(id)` = contém `/`.
- Nós reais (contêineres de slot e conteúdo de slot de uma instância da página) mantêm o id.
- Componente inexistente, ciclo ou profundidade > 16: a instância vira um contêiner de aviso (borda tracejada, texto "Componente ausente") com o id da instância.

### Edição pelo id expandido (roteamento de ops)

`applyOp` roteia ops cujos alvos não são nós reais das páginas:

- **Id virtual de instância** (`in_x/caminho`): `updateStyles`, `setText`, `setAttrs`, `setNodeFlags` (`hidden`), `setClasses`, `setStates`, `setSrc`, `setSvg` e `setInstanceProps` (instância aninhada) viram `setInstanceOverrides` na instância dona. Estrutura (`createNode` fora de slot, `deleteNodes`, `moveNodes`, `duplicateNodes`, `setTag`) é recusada com mensagem pedindo para editar o principal ou destacar.
- **Nó da árvore de um principal** (id real dentro de `doc.components[].root`): qualquer op de nó é aplicada a um documento temporário com a raiz do principal e vira `updateComponent { root }`. É assim que o editor (modo de edição do principal) e o MCP (`update_styles` com ids do principal) editam o principal.
- Inverso exato (o da op roteada), então undo/redo funcionam igual.

## Ops

Primitivas (em `ops.ts`, com inverso exato):

| Op                     | Campos                                                                 | Inverso                                      |
| ---------------------- | ---------------------------------------------------------------------- | -------------------------------------------- |
| `addComponent`         | `component`, `index?`                                                  | `deleteComponent` (`force`)                  |
| `deleteComponent`      | `componentId` (recusa se houver instâncias)                            | `addComponent` na posição original           |
| `updateComponent`      | `componentId`, `name?`, `description?`, `props?`, `variants?`, `root?` | `updateComponent` com os valores anteriores  |
| `replaceNode`          | `nodeId`, `node` (troca o nó no lugar; ids novos validados)            | `replaceNode` de volta                       |
| `setInstanceProps`     | `changes[{ nodeId, set?, unset? }]`                                    | `setInstanceProps` com os valores anteriores |
| `setInstanceOverrides` | `changes[{ nodeId, overrides \| null }]` (substitui o mapa)            | `setInstanceOverrides` com o mapa anterior   |

Planejadores (em `components/plan.ts`, devolvem `Op[]` aplicadas como uma entrada de histórico):

| Função                                                | Ops                                                                                                                                  |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `createComponentOps(doc, nodeId, { name, props })`    | `replaceNode` (nó → instância) + `addComponent` (raiz = o nó, mesmos ids, livres depois da troca)                                    |
| `instanceNodeFor(doc, componentId, { props, slots })` | (nó) instância pronta para `createNode`, com os contêineres de slot                                                                  |
| `detachInstanceOps(doc, nodeId)`                      | `replaceNode` (instância → árvore concreta com ids novos; conteúdo de slot mantém os ids; instâncias aninhadas continuam instâncias) |
| `pushOverridesToMainOps(doc, nodeId)`                 | `updateComponent` (overrides gravados no principal) + `setInstanceOverrides` (limpa)                                                 |
| `resetInstanceOps(doc, nodeId)`                       | `setInstanceOverrides` null                                                                                                          |
| `importKitOps(doc, kit, kitName)`                     | `addComponent`/`updateComponent` por componente do kit + tokens e tema `dark` que faltam                                             |

`createComponent` recusa frames raiz, nós dentro de instâncias (ids virtuais) e nós já dentro de um principal que gerariam ciclo.

## Kits

Um kit é um documento `*.mockup.json` com `components` e os tokens que eles usam (e, opcionalmente, uma página de vitrine). O padrão é `kits/shadcn-like.mockup.json` (estética shadcn/ui, MIT; sem código copiado), com os tokens do preset shadcn da Fase 3 (`--color-*`, `--radius*`, tema `dark`).

| Componente | Props                                                                                          | Slots               |
| ---------- | ---------------------------------------------------------------------------------------------- | ------------------- |
| Button     | `variant` (default, secondary, outline, ghost, destructive), `size` (sm, default, lg), `label` | —                   |
| Input      | `placeholder`, `value`, `type`                                                                 | —                   |
| Card       | `title`, `description`                                                                         | `content`, `footer` |
| Navbar     | `brand`                                                                                        | `links`, `actions`  |
| Tabs       | `tab1`, `tab2`, `tab3`, `active` (enum 1..3)                                                   | `content`           |
| Dialog     | `title`, `description`                                                                         | `content`, `footer` |
| Table      | `caption`                                                                                      | `rows`              |
| List       | —                                                                                              | `items`             |

`import_kit` copia os componentes (com `kit` preenchido; ids estáveis do kit, então importar de novo atualiza em vez de duplicar) e cria só os tokens que faltam.

## Ícones

Dois kits empacotados offline: **Lucide** (`lucide-static`) e **Heroicons** (`@iconify-json/heroicons`, MIT). `search_icons(query, kit?)` busca nos dois (ou num só) e devolve `kit/nome`; `insert_icon(name)` aceita `lucide/arrow-right`, `heroicons/arrow-right` ou o nome sem kit (Lucide primeiro).

## MCP

| Ferramenta                    | Descrição                                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `list_components`             | Biblioteca do documento (id, nome, kit, props, nº de instâncias) e kits disponíveis.                          |
| `get_component`               | Props, variantes, árvore do principal com ids (para editar por `update_styles` etc.) e HTML.                  |
| `create_component`            | Transforma um nó em componente (o nó vira a primeira instância).                                              |
| `update_component`            | Nome, descrição, props e variantes.                                                                           |
| `update_component_html`       | Substitui a árvore do principal por HTML (Tailwind aceito; `{{prop}}` e `data-slot`).                         |
| `delete_component`            | Remove o principal (recusa com instâncias, a menos que `detach_instances`).                                   |
| `insert_component`            | Insere uma instância (`componentId`, nome ou `kit/Nome`; importa o kit se preciso) com props e HTML por slot. |
| `set_instance_props`          | Define/remove props de instâncias.                                                                            |
| `set_instance_override`       | Sobrescreve um nó da instância por caminho (estilo, texto, atributos, oculto).                                |
| `reset_instance`              | Remove os overrides.                                                                                          |
| `detach_instance`             | Destaca: a instância vira nós comuns.                                                                         |
| `push_overrides_to_main`      | Grava os overrides da instância no principal.                                                                 |
| `go_to_main`                  | Seleciona/enquadra o principal no editor e devolve sua árvore.                                                |
| `import_kit`                  | Importa um kit pelo nome (`shadcn-like`) ou caminho absoluto de um `.mockup.json`.                            |
| `search_icons`, `insert_icon` | Ampliados com vários kits.                                                                                    |

Parâmetros finais (tabela completa em [MCP.md](MCP.md#componentes)): `insert_component(component, parentId?, props?, slots?, index?, name?, styles?)`, `get_component(component)`, `create_component(nodeId, name?, description?, props?)` (props com `bind: { nodeId, target }`), `update_component(componentId, name?, description?, props?, variants?)` (listas substituem), `set_instance_override(nodeId, path, style?, unset_style?, text?, attrs?, hidden?)`, `import_kit(name)`. Os ids virtuais (`in_x/caminho`) e os nós de um principal valem nas ferramentas de leitura (`get_html`, `get_styles`, `get_tree_summary`, `get_screenshot`, `get_code`...), e `get_screenshot('cp_...')` renderiza o principal numa instância padrão.

Kits: a pasta `kits/` é achada por `MOCKUP_KITS_DIR`, por `resources/kits` (app empacotado) ou subindo da pasta do código até a raiz do repositório (desenvolvimento e bundle do daemon). HTTP: `GET /api/kits` (`{ kits: [{ name, components: [{ id, name, description, props }] }] }`) e `GET /api/kits/:name` (o documento do kit).

Guia: `get_guide('components')`.

## Editor

Detalhes em [EDITOR.md](EDITOR.md#componentes).

- O editor trabalha sobre a **visão expandida** (`expandDocument` do documento do daemon): canvas, camadas, seleção e propriedades veem instâncias como árvores concretas; os planejadores recebem o documento real.
- Aba **Componentes** no painel esquerdo: biblioteca do documento (clique edita o principal; arrastar ou + insere) e os kits do daemon (`GET /api/kits`; clique ou arrastar insere, importando o kit na mesma chamada).
- **Criar componente** da seleção: Ctrl+Alt+K (também no menu de contexto, com "Ir para principal" e "Destacar instância").
- Instâncias com indicador roxo (contorno, alças e ícone nas camadas); nós internos em roxo-claro; contêiner de slot com ícone próprio.
- Nós internos: estilo, texto, atributos e ocultar viram overrides; mover, duplicar, agrupar e excluir são bloqueados com aviso.
- Painel de propriedades da instância: controles por tipo de prop, slots, "Ir para principal", "Destacar", "Restaurar" (overrides) e "Enviar ao principal".
- **Edição do principal** em modo isolado (página sintética `COMPONENT_EDIT_PAGE_ID`, raiz num quadro não editável com a largura da instância de origem): as edições usam os ids reais e propagam para as instâncias; a seção Componente edita nome, descrição e props. `go_to_main` do MCP entra no modo. Esc (sem seleção) ou "Concluir" volta e seleciona a instância de origem.
- Slots editáveis no canvas: o conteúdo de slot é nó real (selecionar, editar texto, inserir, arrastar).

## Exportação

Detalhes por formato em `EXPORT.md` (seção Componentes).

- HTML, Tailwind e SVG: instâncias expandidas (o resultado é o mesmo do canvas); ids virtuais (`in_x/...`) também são exportáveis.
- React: um componente por principal usado (`export function Button({ variant = 'default', label = 'Botão', ... }: ButtonProps)`), com props tipadas (`enum` vira união de literais, `slot` vira `ReactNode`; o primeiro slot também aceita `children`; todo componente aceita `className` e `style`, mesclados na raiz), variantes como estilos ou classes condicionais (uma cadeia de ternários por propriedade) e instâncias como `<Button variant="outline" label="Salvar" />`. Instâncias com overrides em nós internos (ou `attrs`/`classes`/`states`, slot customizado, prop fora do tipo) saem expandidas no lugar, com o comentário `{/* instância de Button com overrides */}`. O `style` da instância (posição, margem) vai inline na tag do componente.
