# Scripts

Scripts em JavaScript para automatizar edições do documento: renomear 10 nós, trocar a cor de todos os botões, reorganizar espaçamentos, tirar screenshots. O script roda numa **sandbox** (worker + `node:vm`) que só enxerga a API `doc`; tudo o que ele muda entra num **único undo**.

Código em `packages/server/src/scripts/`:

| Arquivo            | Papel                                                                                          |
| ------------------ | ---------------------------------------------------------------------------------------------- |
| `sandbox.ts`       | Cria o worker, o RPC síncrono, o timeout e os limites; `runInSandbox(code, handler, opts)`.    |
| `worker-source.ts` | Textos do worker e do bootstrap (JavaScript em string, ver Segurança).                         |
| `host.ts`          | Lado do daemon da API (`ScriptHost`): valida os argumentos e aplica as ops no `DocumentStore`. |
| `selector.ts`      | Mini-seletor de nós (`doc.select("...")`).                                                     |
| `service.ts`       | `ScriptService`: execução, biblioteca `scripts/*.js` e geração com IA.                         |
| `prompt.ts`        | Prompt de sistema e extração do código na geração com IA.                                      |

Ferramentas MCP em `mcp/tools/scripts.ts` (`run_script`, `list_scripts`); guia `get_guide('scripts')` em `mcp/guide-scripts.ts`.

## Como um script roda

O código é o **corpo de uma `async function`** em strict mode: `await` e `return` funcionam e o valor devolvido (serializado em JSON) volta em `result`.

```js
const botoes = doc.select('button');
botoes.forEach((b) => {
  b.style.background = '#2563eb';
});
console.log(botoes.length, 'botões atualizados');
return botoes.map((b) => b.id);
```

Não existem `require`, `import`, `process`, `fetch`, `setTimeout`, `eval` nem `Function`: só a API abaixo e o JavaScript padrão (Array, Map, JSON, Math, RegExp, Promise, Intl...). Também não há `ArrayBuffer`, arrays tipados nem `WebAssembly` (veja Segurança).

## API

### `doc`

| Membro                                                                         | Descrição                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `doc.id`, `doc.name`                                                           | Id e nome do documento.                                                                                                                                                                                                                                                                                             |
| `doc.pages()`                                                                  | `[{ id, name, frameIds }]`.                                                                                                                                                                                                                                                                                         |
| `doc.frames(pageId?)`                                                          | Nós dos frames raiz (todas as páginas, ou só a indicada).                                                                                                                                                                                                                                                           |
| `doc.get(id)`                                                                  | Nó (`NodeHandle`) ou `null`. Aceita também um nó.                                                                                                                                                                                                                                                                   |
| `doc.select(consulta)`                                                         | Todos os nós que casam, em ordem de documento.                                                                                                                                                                                                                                                                      |
| `doc.selectOne(consulta)`                                                      | O primeiro ou `null`.                                                                                                                                                                                                                                                                                               |
| `doc.selection()`                                                              | Nós selecionados no editor (ou a `selection` passada na execução); ids que não existem mais são ignorados.                                                                                                                                                                                                          |
| `doc.apply(op \| op[])`                                                        | Aplica ops do editor na hora (ver `packages/core/src/ops.ts`). Devolve um resultado por op (ex.: `{ idMap }` em `duplicateNodes`). Op inválida lança `Error`. Um array é atômico.                                                                                                                                   |
| `doc.create(pai \| null, { tag, name, text, style, attrs, children, index? })` | Cria um nó (e os filhos) e devolve o handle. `pai` é um id ou nó; `null` cria um frame na primeira página. Extra do painel, atalho para `createNode`.                                                                                                                                                               |
| `doc.screenshot(nodeId?, { scale?, format? })`                                 | Renderiza o nó (padrão: o primeiro selecionado ou o primeiro frame). Devolve `{ nodeId, width, height, mime }` (tamanho do nó em px CSS); a imagem vai em `result.images`. `scale` 1, 2 ou 3; `format` `png` ou `jpg`. Sem motor de render lança `Error` com a mensagem de render indisponível. Até 8 por execução. |
| `doc.tokens()`                                                                 | `{ "--nome": "valor" }` (tokens base).                                                                                                                                                                                                                                                                              |
| `doc.setTokens(obj)`                                                           | Define tokens (o prefixo `--` é opcional; `null` remove). Devolve os tokens atuais.                                                                                                                                                                                                                                 |
| `console.log/info/warn/error`                                                  | Uma linha de log por chamada (objetos viram JSON; `warn` e `error` ganham prefixo `[warn]`/`[error]`).                                                                                                                                                                                                              |

### Consultas

`doc.select`, `doc.selectOne` e `node.select` (esta só olha os descendentes do nó) aceitam três formas.

**1. String (mini-seletor CSS)**, avaliada no daemon sobre o documento real (instâncias de componente **não** são expandidas):

| Sintaxe                                                 | Casa com                                                                                                                                     |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `*`                                                     | Qualquer nó.                                                                                                                                 |
| `frame`, `element`, `text`, `image`, `svg`, `instance`  | O tipo do nó.                                                                                                                                |
| `button`, `h1`, `a`...                                  | A tag (sem diferenciar maiúsculas).                                                                                                          |
| `#id`                                                   | O id do nó.                                                                                                                                  |
| `.classe`                                               | Classe Tailwind escrita no nó (`node.classes`).                                                                                              |
| `[name="x"]`, `[name=x]`                                | Nome igual a `x`.                                                                                                                            |
| `[name^=x]`, `[name*=x]`, `[name$=x]`                   | Começa com, contém, termina com.                                                                                                             |
| `[text*=x]`, `[tag=x]`, `[type=x]`, `[src]`, `[hidden]` | Outros campos: `id`, `name`, `tag`, `type`, `text`, `src`, `classes`, `component`, `hidden`, `locked`. `[campo]` sem valor testa a presença. |
| `[style.color]`, `[style.color="red"]`                  | Propriedade de estilo (kebab-case ou camelCase).                                                                                             |
| `[attrs.href^=http]`                                    | Atributo HTML.                                                                                                                               |
| `A B`, `A > B`                                          | `B` descendente / filho direto de `A`.                                                                                                       |
| `A, B`                                                  | União.                                                                                                                                       |

Combinam-se no mesmo nó: `section.hero > button[style.background="red"]`. Seletor inválido lança `Error: Seletor inválido "...": motivo (posição N)`.

**2. Função** `(node) => boolean`, executada no script sobre o **snapshot JSON** do nó:

```js
doc.select((n) => n.tag === 'button' && n.style.background === 'red');
```

O snapshot tem `id, type, tag, name, text, attrs, style, classes, position, hidden, locked, src (até 200 caracteres), componentId, props, parentId, childIds, frameId, pageId`. Mudar o snapshot não muda o documento.

**3. Objeto** `{ type?, tag?, name?, text?, within? }`: `name` e `text` aceitam **string (igualdade exata)** ou **RegExp**; `within` é o id (ou nó) cujos descendentes são pesquisados.

```js
doc.select({ type: 'text', text: /comprar/i, within: header.id });
```

### Nó (`NodeHandle`)

Um objeto que guarda só o id: **cada leitura busca o estado atual** e cada escrita aplica uma op. Compare nós pelo `id` (`a.id === b.id`).

| Membro              | Leitura                          | Escrita                                                                |
| ------------------- | -------------------------------- | ---------------------------------------------------------------------- |
| `id`, `type`, `tag` | sim                              | não                                                                    |
| `name`              | nome da camada                   | `node.name = "x"` (`renameNodes`)                                      |
| `text`              | texto (ou `undefined`)           | `node.text = "x"` (`setText`; `null` remove)                           |
| `style`             | objeto-proxy: `node.style.color` | `node.style.color = "red"`, `delete node.style.color` (`updateStyles`) |
| `attrs`             | objeto-proxy: `node.attrs.href`  | `node.attrs.href = "/"`, `delete node.attrs.title` (`setAttrs`)        |
| `classes`           | string de classes Tailwind       | não (use `doc.apply({ type: 'setClasses', ... })`)                     |
| `position`          | `{ x, y }` ou `undefined`        | `node.position = { x, y }` (`setPosition`)                             |
| `parent`            | nó ou `null` (frame raiz)        | não                                                                    |
| `children`          | nós filhos                       | não                                                                    |
| `frame`             | frame raiz que contém o nó       | não                                                                    |

Métodos: `setStyle(obj)` (vários estilos numa op; `null` ou `""` remove), `remove()`, `duplicate()` (devolve o clone), `select(consulta)`, `toJSON()` (o snapshot; `JSON.stringify(node)` e `return node` o usam).

`style` e `attrs` se comportam como objetos: `Object.keys(node.style)`, `"color" in node.style` e `JSON.stringify(node.style)` funcionam. Em `style`, chaves camelCase viram kebab-case (`borderRadius` = `border-radius`); `--custom` fica como está. Atribuir `null`, `undefined` ou `""` a um estilo o remove. Atribuir o objeto inteiro (`node.style = {...}`) lança um erro que aponta `setStyle`.

Ler um nó que foi removido lança `Error: O nó "..." não existe mais`.

### Exemplos

Renomear 10 nós:

```js
const itens = doc.select('section.lista > div').slice(0, 10);
itens.forEach((n, i) => {
  n.name = `Item ${i + 1}`;
});
return itens.length;
```

Trocar a cor de todos os botões:

```js
const botoes = doc.select('button');
if (!botoes.length) throw new Error('Nenhum botão encontrado');
for (const b of botoes) b.setStyle({ background: 'var(--color-primary)', color: '#fff' });
return botoes.length;
```

Criar um card com filhos e tirar um screenshot:

```js
const card = doc.create(doc.frames()[0], {
  tag: 'section',
  name: 'Card',
  style: { padding: '16px', background: '#fff', 'border-radius': '12px' },
  children: [
    { tag: 'h2', text: 'Título' },
    { tag: 'p', text: 'Descrição curta.' },
  ],
});
return doc.screenshot(card, { scale: 2 });
```

Ops direto (qualquer op do editor):

```js
doc.apply([
  { type: 'updateStyles', nodeIds: [a.id, b.id], styles: { gap: '16px' }, unset: ['margin'] },
  { type: 'moveNodes', nodeIds: [b.id], parentId: a.id },
]);
```

Tokens:

```js
doc.setTokens({ '--color-primary': '#2563eb', '--radius': '8px' });
return doc.tokens();
```

## Undo por execução

Todas as ops de uma execução usam **um único grupo de undo** (`opts.group` ou `script:<uuid>` novo): um `undo` desfaz o script inteiro, seja ele de 1 ou de 1000 ops. Ao fim, o serviço fecha o grupo que criou; um grupo recebido de fora (o de um turno do assistente, por exemplo) continua dele, então `run_script` dentro de um turno entra no undo do turno.

`opsCount` conta as ops aplicadas.

**Erro no meio:** não há rollback automático. As ops anteriores ao erro (ou ao timeout) **continuam aplicadas, no mesmo grupo**: o resultado vem com `ok: false`, o `error` e o `opsCount`, e um undo as desfaz. Para tudo-ou-nada, junte as mudanças num único `doc.apply([...])` (atômico) ou desfaça com undo. Um `doc.apply` que lança (op inválida) não aplica nenhuma op daquele lote.

A origem das ops (`source`) é `editor` quando o painel executa e `mcp` no `run_script`.

## Segurança e limites

O script é código não confiável (às vezes escrito por uma IA). Camadas:

1. **Worker thread** (`worker_threads`, `eval: true` a partir de uma string, porque o daemon é empacotado num único arquivo). `env: {}`, sem stdin/stdout, `resourceLimits` (heap 128 MB, geração jovem 16 MB, pilha 4 MB). Estourar a memória encerra só o worker e vira um erro legível.
2. **Timeout no thread principal**: `worker.terminate()` depois de 10 s (`timeoutMs`, máximo 60 s). Mata `while (true) {}`, laços depois de `await`, regex catastrófica e a espera de uma chamada lenta. Os logs coletados até ali são devolvidos.
3. **Contexto `node:vm` isolado**: `vm.createContext(vm.constants.DONT_CONTEXTIFY, { codeGeneration: { strings: false, wasm: false } })`. Só existem os builtins do JavaScript: sem `process`, `require`, `Buffer`, timers, `fetch`, `URL`. `eval`, `new Function` e `WebAssembly` não existem; `SharedArrayBuffer`, `Atomics`, `WeakRef` e `FinalizationRegistry` foram removidos. `ArrayBuffer`, `DataView` e os arrays tipados também: eles alocam **fora do heap** e o limite de memória não os enxergaria.
4. **Ponte JSON**: a única coisa que o contexto recebe do host é uma função `(method, argsJson) => string` guardada numa closure do bootstrap (avaliado dentro do contexto). Nenhum objeto, função ou erro do realm do worker chega ao código do usuário (senão `x.constructor.constructor('return process')()` escapa): os dados atravessam como strings JSON, a ponte nunca lança, e qualquer erro capturado do lado de lá é descartado e relançado como `Error` do próprio contexto. A API (`doc`, handles, `console`) é montada com objetos do contexto, congelada e instalada como global não gravável. Chamadas síncronas usam `MessageChannel` + `SharedArrayBuffer`/`Atomics.wait` no worker e `receiveMessageOnPort`.
5. **Defesas extras**: `Error.prepareStackTrace` travado (não gravável e não configurável; sem callsites com `getThis`/`getFunction`) e o código do usuário começa numa microtask, sem frames do worker na pilha; os argumentos de cada chamada são validados no daemon (`parseOp` em cada op, limites de tamanho e de quantidade); expressões regulares do usuário nunca rodam no thread principal (a busca por objeto/função roda no worker; o mini-seletor não usa regex do usuário).
6. **`import` recusado**: `import()` num contexto `vm` sem loader rejeita com um erro **do realm do worker**, e dele se chega ao `process`. Como `eval`/`Function` não existem, a única forma de escrever `import(...)` é o token no texto do script: a palavra `import` (`/\bimport\b/`) é recusada em qualquer lugar do código, inclusive em comentários e strings (falso positivo aceito; reescreva o texto).

Limites (`SANDBOX_LIMITS` em `sandbox.ts`):

| Limite                      | Valor                                                                          |
| --------------------------- | ------------------------------------------------------------------------------ |
| Timeout                     | 10 s padrão, 50 ms a 60 s                                                      |
| Heap do worker              | 128 MB (+ 16 MB geração jovem), pilha 4 MB                                     |
| Código do script            | 500.000 caracteres                                                             |
| Logs                        | 500 linhas, 2.000 caracteres por linha, 256 KB                                 |
| Resultado (`return`)        | 1.000.000 caracteres de JSON (acima disso `ok: false`; as ops já feitas ficam) |
| Argumento de uma chamada    | 4.000.000 caracteres de JSON                                                   |
| Chamadas à API por execução | 200.000                                                                        |
| Ops por `doc.apply`         | 20.000                                                                         |
| Nós por `doc.create`        | 2.000 (profundidade 24)                                                        |
| Screenshots por execução    | 8                                                                              |
| Execuções simultâneas       | 4 (as demais esperam)                                                          |

Valores não serializáveis no `return` e nos logs viram string (função, símbolo, `BigInt`, erro, RegExp); `Map` vira `{ map: [[k, v]...] }` e `Set` `{ set: [...] }`; referência circular vira `String(valor)`.

## Biblioteca `scripts/*.js`

Scripts salvos ficam na pasta `scripts/` **ao lado do arquivo do documento** (`<pasta do .mockup.json>/scripts/`), um arquivo `.js` por script com o corpo da função (como no painel). Documento sem arquivo: `dir: null`, lista vazia e erro claro ao salvar.

- Nomes: letras (inclusive acentuadas), números, espaço, `_`, `.` e `-`, até 100 caracteres; `.js` é acrescentado. Barras, `..`, nomes que começam com `.` ou terminam em espaço/ponto e nomes reservados do Windows (`con`, `nul`...) são recusados (path traversal).
- `list` ordena por nome e ignora o que não é `.js` válido.
- Mensagens WebSocket (`script:*`, em `packages/core/src/protocol.ts`): `script:run` (`ScriptRunResult`), `script:list` (`{ dir, scripts }`), `script:read` (`{ name, code }`), `script:save` (`{ name }`), `script:delete`, `script:generate` (`{ code }`).

## Gerar com IA

`script:generate` (`ScriptService.generate`) pede o código ao assistente (`generateText`, sem ferramentas e sem MCP) com um prompt de sistema que descreve esta API e exige só o código JavaScript, mais o resumo do documento e a seleção. Se a resposta vier em um bloco de código com cerca de três crases (`js`), só o conteúdo dele é usado. A geração **não executa** o código: o painel mostra o script para o usuário revisar e rodar. Sem assistente no daemon: erro claro.

## MCP

`run_script({ code? , name?, docId?, timeoutMs? })`: executa `code` ou o script salvo `name` (um dos dois). Usa `ctx.group()` como grupo de undo, então dentro de um turno do assistente o script entra no mesmo undo do turno. Devolve um texto com `Script ok: N op(s)`, os logs, o `Resultado`, as imagens de `doc.screenshot()` (como imagens da resposta, antes do texto) e o resumo da árvore dos nós alterados. Se o script falha, a resposta é um erro (`isError`) com a mensagem (e a linha), os logs e quantas ops já tinham sido aplicadas.

`list_scripts({ docId? })`: nome, tamanho e data dos scripts da biblioteca, e o caminho da pasta (um agente pode criar `.js` ali com as próprias ferramentas de arquivo).

O guia está em `get_guide('scripts')`.

## Limitações conhecidas

- **`import` é um token proibido** em qualquer parte do texto (veja Segurança): `// import tudo` também é recusado.
- **Sem `setTimeout`, `fetch`, arquivos, `ArrayBuffer`** e afins; `await` só espera as chamadas da própria API e promessas locais. Uma promessa que nunca resolve termina a execução com um erro explicativo.
- **Estritamente síncrona por dentro**: cada leitura de um nó é uma ida e volta ao daemon. Para muitos nós, prefira `doc.select(...)` (uma chamada) e `doc.apply([...])` (uma op atômica) a laços com `node.style.x = ...`; ambos funcionam, mas o segundo gera uma op por atribuição.
- **Instâncias de componente não são expandidas** na busca: `doc.select('button')` não vê botões dentro de uma instância; use `set_instance_override`/`set_instance_props` (via `doc.apply`) ou edite o principal.
- **Sem rollback**: um erro no meio deixa as ops anteriores aplicadas (desfaça com um undo).
- **Heap, não RSS**: o limite de memória é o do heap do worker; a execução também é limitada pelo timeout.
- A sandbox é **defesa em profundidade, não uma garantia absoluta**: `node:vm` não é um limite de segurança por si só. As camadas acima fecham os vetores conhecidos (cobertos por testes em `sandbox.test.ts`), mas não rode scripts de origem desconhecida num daemon exposto na rede.
