/** Guia `get_guide('scripts')`: API de scripts do documento (run_script, painel de scripts). */
export const SCRIPTS_GUIDE = `# Scripts: automatizar edições em lote

\`run_script\` executa JavaScript numa sandbox com acesso SÓ à API do documento (\`doc\`). Use para edições repetitivas ou em lote (renomear 10 nós, trocar a cor de todos os botões, ajustar espaçamentos) em vez de dezenas de chamadas de ferramentas. Tudo o que o script muda entra num único undo.

\`\`\`
run_script({ code: "doc.select('button').forEach(b => b.style.background = '#2563eb'); return doc.select('button').length;" })
\`\`\`

O código roda como o corpo de uma \`async function\` em strict mode: \`await\` e \`return\` funcionam; o valor devolvido (JSON) volta no resultado. Também há \`run_script({ name: "meu-script" })\` para um script salvo em \`scripts/\` ao lado do documento (veja \`list_scripts\`).

## API

\`\`\`
doc.id, doc.name
doc.pages()                 -> [{ id, name, frameIds }]
doc.frames(pageId?)         -> nós dos frames raiz
doc.get(id)                 -> nó ou null
doc.select(consulta)        -> nós (ordem do documento)
doc.selectOne(consulta)     -> primeiro nó ou null
doc.selection()             -> nós selecionados no editor
doc.apply(op | op[])        -> resultados (aplica já; op inválida lança Error)
doc.create(pai | null, { tag, name, text, style, attrs, children })  -> nó criado (pai null = novo frame)
doc.screenshot(nodeId?, { scale?: 1|2|3, format?: 'png'|'jpg' })     -> { nodeId, width, height, mime }
doc.tokens()                -> { "--nome": "valor" }
doc.setTokens({ "--nome": "valor" })   -> tokens atuais (null remove um token)
console.log / info / warn / error      -> linhas de log devolvidas ao final
\`\`\`

### Consultas (select, selectOne, node.select)

- **string** (mini-seletor CSS): \`*\`, tipos (\`frame\`, \`element\`, \`text\`, \`image\`, \`svg\`, \`instance\`), tags (\`button\`, \`h1\`), \`#id\`, \`.classe\`, atributos \`[name="x"]\`, \`[name^=x]\`, \`[name*=x]\`, \`[name$=x]\`, \`[text*=x]\`, \`[tag=x]\`, \`[style.color]\`, \`[style.color="red"]\`, \`[attrs.href^=http]\`, combinadores descendente (espaço) e filho (\`>\`), lista com vírgula. Ex.: \`"section.hero > button, h1"\`.
- **função** \`(node) => boolean\`: recebe o snapshot JSON do nó ({ id, type, tag, name, text, attrs, style, classes, position, parentId, childIds, frameId, hidden, locked }).
- **objeto** \`{ type?, tag?, name?, text?, within? }\`: \`name\` e \`text\` aceitam string (igualdade exata) ou RegExp; \`within\` é o id de um nó (só descendentes).

Instâncias de componente NÃO são expandidas: uma instância é um nó \`instance\`; para mudar o texto de dentro dela use \`set_instance_override\` ou edite o principal (get_guide('components')).

### Nó (NodeHandle)

Cada leitura busca o estado atual; cada escrita aplica uma op.

\`\`\`
node.id, node.type, node.tag, node.classes (leitura)
node.name = "Novo"                     // renameNodes
node.text = "Olá"                      // setText
node.style.color = "red"               // updateStyles; ler: node.style.color; apagar: delete node.style.color
node.style.backgroundColor = "#fff"    // camelCase ou kebab-case (node.style['background-color'])
node.setStyle({ padding: "8px", margin: null })   // vários de uma vez (null ou "" remove)
node.attrs.href = "/contato"           // setAttrs; delete node.attrs.title remove
node.position                          // { x, y } (atribuível)
node.parent, node.children, node.frame // nós (parent é null num frame raiz)
node.select(consulta)                  // só descendentes
node.remove()                          // deleteNodes
node.duplicate()                       // devolve o clone
node.toJSON()                          // snapshot (JSON.stringify(node) usa)
\`\`\`

Compare nós pelo \`id\` (\`a.id === b.id\`). Depois de \`remove()\`, ler o nó lança "não existe mais".

### Ops (doc.apply)

Aceita qualquer op do editor, por exemplo:

\`\`\`
{ type: "updateStyles", nodeIds: [id], styles: { gap: "16px" }, unset: ["margin"] }
{ type: "renameNodes", changes: [{ nodeId, name }] }
{ type: "setText", changes: [{ nodeId, text }] }
{ type: "moveNodes", nodeIds: [id], parentId, index }
{ type: "setNodeFlags", changes: [{ nodeId, hidden: true }] }
\`\`\`

Um array é aplicado de forma atômica (tudo ou nada); op inválida lança Error com o motivo.

## Exemplos

Renomear os 10 primeiros itens de uma lista:

\`\`\`js
const itens = doc.select("section.lista > div").slice(0, 10);
itens.forEach((n, i) => { n.name = "Item " + (i + 1); });
return itens.length;
\`\`\`

Trocar a cor de todos os botões (e avisar se não achou nenhum):

\`\`\`js
const botoes = doc.select("button");
if (!botoes.length) throw new Error("Nenhum botão encontrado");
for (const b of botoes) { b.style.background = "var(--color-primary)"; b.style.color = "#fff"; }
console.log(botoes.length + " botões atualizados");
return botoes.map((b) => b.id);
\`\`\`

Screenshot do frame (a imagem volta no resultado do run_script):

\`\`\`js
const frame = doc.frames()[0];
const info = doc.screenshot(frame, { scale: 1 });
return info;
\`\`\`

## Limites e comportamento

- Sem \`require\`, \`import\`, \`process\`, \`fetch\`, \`setTimeout\`, \`eval\`/\`Function\`: só a API acima e o JavaScript padrão. A palavra "import" é recusada em qualquer lugar do código.
- Timeout de 10 s (\`timeoutMs\` até 60000): o script é interrompido, mesmo em laços infinitos. Memória limitada (128 MB): estourar vira erro, nunca derruba o servidor.
- Logs: até 500 linhas; resultado (\`return\`) até 1 MB em JSON; até 8 screenshots por execução (precisam do app desktop/render).
- Todas as ops da execução formam UM grupo de undo (um \`undo\` desfaz o script inteiro; dentro de um turno do assistente, entra no undo do turno).
- Se o script falhar no meio, as ops já feitas continuam aplicadas (e no mesmo undo); o resultado diz quantas. Confira com get_tree_summary / get_screenshot.
- \`list_scripts\` lista a biblioteca (\`scripts/*.js\` ao lado do .mockup.json).
`;
