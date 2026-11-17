export const GUIDE_TOPICS = [
  'getting-started',
  'design-system',
  'layout',
  'responsive',
  'screenshot-loop',
  'export',
  'troubleshooting',
  'setup',
  'assets',
  'data',
] as const;
export type GuideTopic = (typeof GUIDE_TOPICS)[number];

/** Título e descrição curta de cada guia (usados nos resources `guide://<topic>`). */
export const GUIDE_INFO: Record<GuideTopic, { title: string; description: string }> = {
  'getting-started': {
    title: 'Guia: começando',
    description: 'Fluxo em 6 passos para criar um mockup do zero, dicas e lista de guias.',
  },
  'design-system': {
    title: 'Guia: design system e tokens',
    description: 'Tokens como variáveis CSS, escalas de espaço e tipografia, cores com contraste.',
  },
  layout: {
    title: 'Guia: layout',
    description: 'Flexbox, tamanhos, posição absoluta e boas práticas de espaçamento.',
  },
  responsive: {
    title: 'Guia: responsivo',
    description:
      'Um frame por breakpoint (Mobile, Tablet, Desktop): duplicar, adaptar e posicionar.',
  },
  'screenshot-loop': {
    title: 'Guia: ciclo de screenshot',
    description:
      'Criar, conferir com get_screenshot, corrigir; checklist visual e economia de contexto.',
  },
  export: {
    title: 'Guia: exportação',
    description:
      'get_code x export, formatos (png, svg, html, tailwind, react), pasta de saída e assets.',
  },
  troubleshooting: {
    title: 'Guia: solução de problemas',
    description:
      'Render indisponível, nó não encontrado, porta ocupada, overflow, logs e erros de parâmetro.',
  },
  setup: {
    title: 'Guia: instalação e registro do MCP',
    description: 'Instalar o CLI mockup e registrar o MCP no Claude Code, Codex, Cursor e VS Code.',
  },
  assets: {
    title: 'Guia: assets, imagens e placeholders',
    description:
      'Assets do documento x biblioteca/CDN, upload, links estáveis, otimizar, set_image e generate_placeholder.',
  },
  data: {
    title: 'Guia: dados reais e repetidores',
    description:
      'Template com {{campo}}, bind_data com JSON/CSV/URL, select, mapping, refresh_data e limites.',
  },
};

export const GUIDES: Record<GuideTopic, string> = {
  'getting-started': `# Começando com o Mockup Studio

O documento é uma árvore de nós HTML/CSS reais: páginas > frames (artboards) > elementos.
Cada nó tem um id estável (ex.: \`fr_ab12cd34\`, \`el_...\`, \`tx_...\`).

## Fluxo em 6 passos

1. \`create_document(path, name)\` ou \`open_document(path)\`, depois \`get_basic_info\` — veja páginas, frames, documentos abertos e seleção.
2. \`set_tokens({...})\` — defina o design system primeiro: cores, espaçamentos, raios, fontes (veja \`get_guide('design-system')\`).
3. \`create_frame(name, width, height)\` — crie o artboard raiz (ex.: "Desktop", 1440x900).
4. \`write_html(html, css?, parentId?)\` — escreva HTML + CSS de uma vez, seção por seção (header, hero, features, rodapé), usando \`var(--...)\` dos tokens.
5. \`get_screenshot(nodeId)\` — VEJA o resultado e corrija com \`update_styles\`, \`set_text\` ou \`undo\`; repita até ficar bom (veja \`get_guide('screenshot-loop')\`).
6. \`export\` (arquivos) ou \`get_code\` (código na resposta) e, por fim, \`finish_working\` para limpar o indicador "IA" no editor.

## Dicas

- Prefira \`write_html\` a muitas chamadas \`create_node\`: é mais rápido e mais legível.
- Sem \`parentId\`, o conteúdo vai para o nó selecionado ou para o primeiro frame; passe \`parentId\` para ter certeza.
- \`get_tree_summary\` mostra a estrutura; \`get_html\` e \`get_styles\` mostram o código e os estilos efetivos.
- O salvamento em disco é automático; \`save_document\` força a gravação.
- Imagens, ícones e fontes: \`insert_image\`, \`insert_icon\` (\`search_icons\`), \`add_font\` (\`list_fonts\`).
- \`docId\` é opcional (vale o documento ativo), exceto em \`close_document\`.

## Guias

\`design-system\`, \`layout\`, \`responsive\`, \`screenshot-loop\`, \`export\`, \`troubleshooting\`, \`setup\`, \`assets\`, \`data\` — use \`get_guide(topic)\`.
`,
  'design-system': `# Design system e tokens

Defina os tokens ANTES de desenhar. Tokens são variáveis CSS do documento; mudar um valor atualiza todos os nós que o usam.

## Uso

- Defina: \`set_tokens({ tokens: { "--color-primary": "#2563eb", "--space-4": "16px" } })\` (o prefixo \`--\` é acrescentado se faltar).
- Remova: \`set_tokens({ tokens: {}, unset: ["--old"] })\`.
- Consulte: \`get_tokens\`. \`get_styles\` devolve os valores já resolvidos.
- Aplique no CSS: \`var(--color-primary)\`, tanto em \`write_html\` quanto em \`update_styles\`.

## Nomes

\`--color-*\`, \`--space-*\`, \`--radius-*\`, \`--font-*\`, \`--shadow-*\`. Nomeie pelo papel (\`--color-surface\`), não pelo valor (\`--color-gray-100\`).

## Espaçamento

Escala múltipla de 4/8: 4, 8, 12, 16, 24, 32, 48, 64. Use só esses valores em \`gap\`, \`padding\` e margens.

## Tipografia

- Escala: 12, 14, 16, 20, 24, 32, 48 px, com line-height ~1.5 no texto corrido e ~1.2 em títulos.
- Use 1–2 famílias no máximo (ex.: uma para títulos, uma para texto). \`list_fonts\` mostra as disponíveis; \`add_font\` registra/embute outra (ex.: Google Fonts).
- Pesos: 400 (texto), 600/700 (títulos e botões).

## Cores e contraste (WCAG AA)

- Texto normal: contraste mínimo 4.5:1 com o fundo. Texto grande (>= 24px, ou 19px em negrito) e ícones: 3:1.
- Paleta pequena: primária, superfície (fundo), texto, texto secundário, borda e estados (sucesso, erro).
- Não use cor como única indicação de estado.

## Raio e sombra

Escolha 2–3 raios (ex.: 4, 8, 16, 999) e 2–3 sombras e reaproveite; evite valores soltos por componente.

## Exemplo completo

\`\`\`js
set_tokens({
  tokens: {
    "--color-primary": "#2563eb",
    "--color-primary-contrast": "#ffffff",
    "--color-surface": "#ffffff",
    "--color-surface-alt": "#f1f5f9",
    "--color-text": "#0f172a",
    "--color-text-muted": "#475569",
    "--color-border": "#cbd5e1",
    "--color-success": "#15803d",
    "--color-danger": "#b91c1c",
    "--space-1": "4px", "--space-2": "8px", "--space-3": "12px", "--space-4": "16px",
    "--space-6": "24px", "--space-8": "32px", "--space-12": "48px", "--space-16": "64px",
    "--radius-sm": "4px", "--radius-md": "8px", "--radius-lg": "16px",
    "--font-sans": "Inter, system-ui, sans-serif",
    "--shadow-sm": "0 1px 2px rgba(15,23,42,0.08)",
    "--shadow-md": "0 4px 12px rgba(15,23,42,0.12)"
  }
})
\`\`\`
`,
  layout: `# Layout

Os nós usam CSS real. Use flexbox para quase tudo.

## Flex

- Container: \`display:flex; flex-direction:column; gap:16px; padding:24px;\`
- Alinhamento: \`align-items:center; justify-content:space-between;\`
- Quebra de linha: \`flex-wrap:wrap\`. Filho que ocupa o espaço restante: \`flex:1\`.

## Tamanhos

- \`auto\`: ajusta ao conteúdo (padrão).
- \`100%\`: ocupa toda a largura/altura do pai (ex.: \`width:100%\`).
- Preencher o eixo principal: \`flex:1\` (ou \`flex-grow:1\`).
- Limites: \`max-width:1200px; min-height:400px\`.

## Posição absoluta

- No filho: \`position:absolute; top:..; left:..\`, com o pai em \`position:relative\`.
- Para posicionar frames no canvas, use \`set_position(nodeId, x, y)\` (frames raiz e filhos absolutos).

## Boas práticas

- Espaçamento com \`gap\` e \`padding\` (valores dos tokens \`--space-*\`); evite margens soltas.
- Frames raiz têm largura/altura fixas (ex.: 1440x900); o conteúdo interno deve fluir (\`width:100%\`, \`max-width\`).
- Monte por seções: um \`write_html\` por bloco, cada um com um container flex próprio.
- \`get_styles(nodeIds)\` mostra os estilos efetivos; \`get_layout(nodeId)\` mostra posição e tamanho reais (precisa de render).
`,
  responsive: `# Responsivo com frames

No Mockup Studio, cada frame raiz é um breakpoint (artboard) na mesma página. Use estes nomes e tamanhos:

- \`Mobile\` — 390x844
- \`Tablet\` — 768x1024
- \`Desktop\` — 1440x900

Com várias telas no mesmo documento (login, painel, detalhe...), nomeie \`<Tela> - <Breakpoint>\`: \`Login - Desktop\`, \`Login - Mobile\`, \`Painel - Desktop\`. Coloque cada tela numa linha (mesmo \`y\`) e os breakpoints lado a lado (\`set_position\`).

## Fluxo

1. Monte primeiro o \`Desktop\`: \`create_frame({ name: "Desktop", width: 1440, height: 900 })\` e o conteúdo com \`write_html\`.
2. \`duplicate_nodes({ nodeIds: [desktopId] })\` — o clone aparece no canvas; o resultado traz o id novo.
3. \`rename_nodes({ nodeIds: [cloneId], names: ["Tablet"] })\` e \`update_styles({ nodeIds: [cloneId], styles: { width: "768px", height: "1024px" } })\`. Repita para \`Mobile\` (390x844).
   Se o layout do Mobile for muito diferente (barra de abas, cards empilhados), é mais rápido criar o frame e escrever o HTML dele com \`write_html\` do que adaptar o clone.
4. Adapte cada clone: \`flex-direction: column\` no lugar de \`row\`, \`padding\` e fontes menores, grades com menos colunas (use \`update_styles\` nos containers).
5. \`set_position(frameId, x, y)\` para dispor lado a lado sem sobrepor: x do próximo = x anterior + largura + 100.
6. \`get_screenshot\` de cada frame e corrija.

## Dicas

- Mantenha os mesmos nomes de camadas entre frames: facilita comparar e editar.
- Prefira \`width:100%\` e \`max-width\` dentro dos frames em vez de larguras fixas.
- Alvos de toque no Mobile com pelo menos 44px de altura.
- \`get_basic_info\` lista frames com tamanho e posição.
`,
  'screenshot-loop': `# Ciclo de screenshot

Não confie só na estrutura: depois de cada conjunto de mudanças, olhe o resultado.

## Ciclo

1. Crie ou edite (\`write_html\`, \`update_styles\`, \`insert_image\`...).
2. \`get_screenshot(nodeId)\` — confira a imagem.
3. Corrija o que estiver errado (\`update_styles\`, \`set_text\`, \`undo\`) e repita o 2.
4. Ao terminar, \`finish_working\` para limpar o indicador "IA" no editor.

## Checklist visual

- Alinhamento e espaçamento consistentes (gap, padding).
- Nada cortado nem vazando do frame (overflow); imagens com proporção correta.
- Conteúdo mais alto que o frame: com altura fixa o flexbox espreme os blocos (\`flex-shrink\`) e o screenshot parece caber, mas o código exportado (altura mínima) fica maior. Some as alturas com \`get_layout\` ou dê altura explícita aos blocos (num \`<svg>\` use \`set_attrs\` com \`height\` ou \`update_styles\`).
- Contraste suficiente entre texto e fundo (4.5:1 no texto normal).
- Textos quebrando em lugares ruins (títulos em muitas linhas, botões com texto em duas linhas).
- Hierarquia: tamanhos e pesos coerentes; elementos repetidos idênticos.

## Economize contexto

- Prefira \`scale: 1\` e use \`maxWidth\` (ex.: 800) em frames grandes; \`scale: 2\` só para detalhes.
- Capture o nó que mudou (uma seção), não o frame inteiro, quando possível.
- \`format: "jpg"\` gera imagens menores.

## Medidas exatas

\`get_layout(nodeId, depth?)\` lista \`id "nome" tag x,y wxh\` (px, relativos ao frame) e o texto das linhas.
Use para verificar alinhamento, espaçamento e overflow com números.

## Disponibilidade

Screenshot e \`get_layout\` exigem o motor de render (app desktop ou Electron headless). Num daemon Node puro
as ferramentas avisam como habilitar (veja \`get_guide('troubleshooting')\`); enquanto isso use \`get_tree_summary\` e \`get_html\`.
`,
  export: `# Exportação

## get_code x export

- \`get_code(nodeId, format)\` — devolve o código na resposta, sem gravar arquivos. Bom para ler/colar.
- \`export(nodeIds, format, outputDir?)\` — grava um arquivo por nó e copia os assets usados.

## Formatos

- \`png\` / \`jpg\` (\`scale\` 1-3): imagem do nó; exige render.
- \`svg\`: vetor do nó (com render usa as medidas reais; sem render, um fallback com foreignObject).
- \`html\`: documento HTML com CSS em classes.
- \`tailwind\`: HTML com classes Tailwind v4 (\`<nome>.tailwind.html\`).
- \`react\`: componente \`<Nome>.tsx\` (\`styles\`: "tailwind" ou "inline"); se houver CSS, \`theme.css\` ou \`<Nome>.css\`.

## Pasta de saída

- Padrão: \`<pasta do documento>/exports/\`. Documento sem caminho exige \`outputDir\` (absoluto).
- Os arquivos usam o nome do nó em slug (\`Desktop 1440\` vira \`desktop-1440.png\`).
- Arquivos de mesmo nome são SOBRESCRITOS (marcados "(substituído)"); use outro \`outputDir\` para preservar versões.
- Para html/tailwind/react, imagens e fontes usadas são copiadas para \`<outputDir>/assets/\`.
- A resposta do \`export\` lista os arquivos e só repete o código até 20 KB no total; para ler o código de um nó use \`get_code\`.
- React num projeto Vite: copie \`assets/\` para \`public/assets/\` e exporte com \`assetsBase: "/assets/"\` (imagens e fontes passam a usar caminhos absolutos que o bundler resolve).

## Dicas

- Dê nomes claros às camadas (\`rename_nodes\`): viram nomes de arquivo e de componente.
- Exporte um nó por componente; use \`get_screenshot\` antes para conferir o visual.
`,
  troubleshooting: `# Solução de problemas

## "Render indisponível" / get_screenshot falha

O daemon está rodando em Node puro, sem o Electron que desenha os nós. Rode \`mockup doctor\` para ver o diagnóstico.
Opções: abra o app desktop; ou \`mockup stop\` e reconecte o cliente MCP (o CLI sobe um daemon com render); ou \`mockup serve --render\`.
Se o executável do app não for achado, defina \`MOCKUP_DESKTOP_EXE\` com o caminho dele. Sem render, siga com \`get_tree_summary\` e \`get_html\`.

## "Nó não encontrado"

O id não existe (ou foi removido/regerado, ex.: após \`write_html\` com mode "replace"). Use \`get_tree_summary\` para listar ids atuais.

## "Nenhum documento aberto"

Use \`list_documents\`; se vazio, \`open_document(path)\` ou \`create_document(path, name)\`.

## "MCP tool call requires approval, but approval policy is never" (Codex)

O Codex bloqueia as ferramentas que gravam quando roda sem aprovação interativa (\`codex exec\`). O usuário precisa liberar o servidor no \`~/.codex/config.toml\` (\`[mcp_servers.mockup-studio]\` com \`default_tools_approval_mode = "approve"\`) ou rodar com \`-c 'mcp_servers.mockup-studio.default_tools_approval_mode="approve"'\`. Avise o usuário em vez de contornar escrevendo o HTML à mão.

## Porta 4747 ocupada

Outro processo usa a porta. Libere-a ou escolha outra com a variável \`MOCKUP_PORT\` (ex.: \`MOCKUP_PORT=4848\`) e ajuste a URL do cliente HTTP.

## O conteúdo foi parar no lugar errado

Sem \`parentId\`, \`write_html\` usa o nó selecionado (\`get_selection\`) ou o primeiro frame. Passe sempre \`parentId\` e confira com \`get_tree_summary\`. Use \`undo\` para desfazer e \`move_nodes\` para reposicionar.

## Texto cortado ou overflow

Rode \`get_layout(nodeId)\` e compare tamanhos: um filho maior que o pai indica overflow. Ajuste \`width:100%\`, \`flex-wrap:wrap\`, \`min-width:0\` ou aumente a altura do frame.

## Erros de parâmetro

A mensagem lista o campo com problema (obrigatório ausente, tipo errado, valor fora das opções) e termina com "Exemplo: ferramenta({...})". Corrija o campo e chame de novo.

## Logs

O daemon grava em \`<pasta de dados>/daemon.log\` (\`mockup doctor\` mostra o caminho).
`,
  setup: `# Instalação e registro do MCP

## Instalar o CLI

- No repositório: \`npm run build\` e \`npm link -w @mockup/cli\`.
- Ou use o instalador do app, que coloca \`mockup.cmd\` em \`%LOCALAPPDATA%\\MockupStudio\\bin\` no PATH do usuário.

## Verificar e registrar

- \`mockup doctor\` — confere instalação, daemon e render.
- Registro automático: \`mockup setup claude\`, \`mockup setup codex\` ou \`mockup setup all\` (com \`--skill\` instala também a skill do Claude Code). Não recria registro igual e preserva a config do Codex; \`--force\` recria do zero. No Codex, \`--approve\` libera as ferramentas que gravam (necessário no \`codex exec\`) e \`--agents\` instala o trecho no \`~/.codex/AGENTS.md\`.

## Claude Code

- stdio: \`claude mcp add --scope user mockup-studio -- mockup mcp\`
- HTTP: \`claude mcp add --scope user --transport http mockup-studio http://127.0.0.1:4747/mcp\`
- Conferir: \`claude mcp list\` ou \`/mcp\`.

## Codex

\`codex mcp add mockup-studio -- mockup mcp\`, ou em \`~/.codex/config.toml\`:

\`\`\`toml
[mcp_servers.mockup-studio]
command = "mockup"
args = ["mcp"]
\`\`\`

## Outros clientes

Cursor, Claude Desktop:

\`\`\`json
{ "mcpServers": { "mockup-studio": { "command": "mockup", "args": ["mcp"] } } }
\`\`\`

VS Code (\`.vscode/mcp.json\`):

\`\`\`json
{ "servers": { "mockup-studio": { "type": "stdio", "command": "mockup", "args": ["mcp"] } } }
\`\`\`

## Windows

Se o cliente não achar \`mockup\` (shim \`.cmd\`), use o caminho absoluto impresso por \`mockup doctor\`.

Detalhes em \`docs/INTEGRACAO.md\`.
`,
  assets: `# Assets, imagens e placeholders

## Onde ficam os arquivos

- **Assets do documento**: a pasta \`assets/\` ao lado do \`.mockup.json\`. É o que o mockup realmente usa (\`src\` das imagens, fundos, fontes). Documento sem caminho em disco embute imagens como data URL.
- **Biblioteca / CDN**: arquivos guardados por conteúdo, fora de qualquer documento, reaproveitáveis em vários mockups.

## Ferramentas

- \`upload_asset(source, name?, library?)\` — traz um arquivo (caminho absoluto, URL ou data URL) para os assets do documento ou para a biblioteca.
- \`list_assets(scope?, query?, unused?)\` — lista os arquivos com tamanho, dimensões e quantos nós usam cada um.
- \`get_asset_url(id)\` — link direto \`/cdn/<hash>.<ext>\`, estável por conteúdo: o mesmo arquivo dá sempre o mesmo link.
- \`optimize_assets(paths?, maxWidth?, format?, quality?)\` — reduz e converte imagens (webp) e atualiza as referências.
- \`remove_unused_assets(dryRun?)\` — remove o que nenhum nó usa; rode antes com \`dryRun: true\`.
- \`insert_image(parentId, source)\` — cria um nó img a partir de uma imagem.

## Ajustar uma imagem: \`set_image\`

Uma chamada, um undo:

\`\`\`
set_image({ nodeId, fit: 'cover', position: 'top-left',
  filters: { grayscale: 100, blur: 2 },   // null volta ao neutro; drop-shadow existente é preservado
  crop: { top: 10, bottom: 10 },           // % de cada lado (object-view-box)
  clipPath: 'circle' })                    // circle, ellipse, rounded, triangle, diamond, pentagon, hexagon, star, arrow ou 'none'
\`\`\`

Também troca a imagem (\`source\`: caminho, URL, data URL ou um arquivo já em \`assets/\`) e o \`alt\`.

## Imagens de exemplo: \`generate_placeholder\`

\`generate_placeholder(nodeId, kind, seed?)\` com kind \`avatar\`, \`product\`, \`landscape\` ou \`logo\`. Em um nó image troca o src; em um contêiner cria uma imagem filha. É offline e determinístico: a mesma seed dá o mesmo arquivo (\`assets/placeholders/\`). Varie a seed (nome da pessoa, id do produto) para listas com imagens diferentes.

## Dicas

- Prefira imagens reais do usuário quando existirem; placeholders são para preencher.
- Em \`src\`, prefira o caminho relativo de \`assets/\` ao link \`/cdn\`: o link só funciona com o daemon rodando (o \`export\` de código copia os links \`/cdn\` do daemon para \`assets/cdn/\`).
- Confira o resultado com \`get_screenshot\`.
`,
  data: `# Dados reais e repetidores

Um **repetidor** repete o seu conteúdo (o template) uma vez por item de uma lista. Render, screenshot e export (html, tailwind, react, svg) já saem com os dados.

## Fluxo

1. Escreva UM item de exemplo com \`write_html\`, dentro de um contêiner, usando \`{{campo}}\`:
   \`<div class="lista"><article class="card"><img src="{{foto}}" alt="{{nome}}"><h3>{{nome}}</h3><p>{{preco | a combinar}}</p></article></div>\`
2. \`bind_data(nodeId: <id da div .lista>, ...)\` com UMA origem. O contêiner vira um repetidor (o id muda, os filhos mantêm os ids).
3. \`get_screenshot\` para conferir; ajuste o template com as ferramentas de sempre e use \`get_data\` para ver colunas e linhas.

## Bindings

\`{{campo}}\`, \`{{a.b}}\` (caminho aninhado, \`{{itens.0.nome}}\`), \`{{campo | padrão}}\` (usa o padrão se faltar) e especiais: \`{{$index}}\` (0, 1, ...), \`{{$number}}\` (1, 2, ...), \`{{$item}}\` (o item inteiro, para lista de textos). Valem em textos, \`src\` e atributos.

## Origens de \`bind_data\`

- \`data\`: lista direta (\`[{ "nome": "Ana" }]\`).
- \`text\` + \`format\` (\`json\` ou \`csv\`): conteúdo colado.
- \`path\`: arquivo absoluto \`.json\`, \`.csv\` ou \`.tsv\` (até 5 MB; o separador do CSV é detectado: vírgula, ponto e vírgula, tab).
- \`url\`: http(s) que devolve JSON ou CSV (até 5 MB, 20 s).
- \`select\`: caminho da lista dentro do JSON (\`data.items\`); sem ele o servidor acha a primeira lista.
- \`mapping\`: \`{ "nome": "user.fullName" }\` liga o campo do template a outro caminho do item sem reescrever o template.
- \`limit\`: só os primeiros N itens.

A resposta lista as colunas, os campos do template e avisa de campos sem coluna correspondente.

## Atualizar e conferir

- \`refresh_data(nodeId)\` relê o arquivo ou a URL de origem (dados colados não têm origem para reler).
- \`get_data(nodeId, limit?)\` mostra origem, colunas, campos do template e as primeiras linhas.
- Rodar \`bind_data\` de novo no repetidor só troca os dados. Um \`undo\` desfaz a conversão.

## Reescrever um repetidor com HTML

\`get_html\` devolve só o template do repetidor, marcado com \`data-mockup-repeat="<id>"\` (e \`data-repeat="<itens>"\`, informativo). Mantenha esse atributo no HTML enviado a \`write_html\` (ex.: \`mode: "replace"\`): o elemento volta como repetidor com os dados e a origem do original (id novo). Sem a marca ele vira um contêiner comum e a resposta avisa que os dados foram perdidos (\`undo\` restaura). Para mudar só o card, prefira editar os nós do template.

## Limites

Até 1000 itens e 2 MB de dados por repetidor; passou disso, use \`limit\` ou \`select\`. Contêiner sem filhos não vira repetidor (crie o template antes); frame raiz também não (coloque o template numa div dentro dele).
`,
};
