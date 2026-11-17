export const GUIDE_TOPICS = [
  'getting-started',
  'design-system',
  'layout',
  'grid',
  'vectors',
  'responsive',
  'screenshot-loop',
  'export',
  'troubleshooting',
  'setup',
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
  grid: {
    title: 'Guia: CSS Grid',
    description:
      'Grid com write_html ou set_grid, posicionar filhos com place_in_grid, áreas nomeadas e get_layout.',
  },
  vectors: {
    title: 'Guia: vetores e formas',
    description:
      'create_shape, insert_svg, set_path, set_vector_paint, boolean_op, flatten e text_to_outlines.',
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

\`design-system\`, \`layout\`, \`grid\`, \`vectors\`, \`responsive\`, \`screenshot-loop\`, \`export\`, \`troubleshooting\`, \`setup\` — use \`get_guide(topic)\`.
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
- Grades em duas dimensões: \`get_guide('grid')\` (\`set_grid\`, \`place_in_grid\`). Formas e SVG: \`get_guide('vectors')\`.
`,
  grid: `# CSS Grid

Use grid para layouts em duas dimensões (cards, dashboards, galerias, formulários); flex continua melhor para uma linha ou coluna só.

## Com write_html

\`\`\`html
<section class="cards">
  <article class="card">A</article>
  <article class="card wide">B</article>
  <article class="card">C</article>
</section>
\`\`\`

css: \`.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:24px}.wide{grid-column:span 2}\`

## Com ferramentas

- \`set_grid(nodeId, columns, rows?, gap?, columnGap?, rowGap?, areas?, placeItems?, justifyItems?, alignItems?)\` — \`columns\` aceita número (\`3\` = três colunas 1fr), texto CSS (\`"1fr 200px minmax(100px, 1fr)"\`, \`"repeat(auto-fill, minmax(200px, 1fr))"\`) ou lista (\`["200px", "1fr"]\`).
- \`place_in_grid(nodeIds, column, row, span?)\` — célula (começa em 1); \`span\` é número (colunas) ou \`{ columns: 2, rows: 1 }\`; \`area: "header"\` usa uma área nomeada. O pai precisa ser grid.

Exemplo de dashboard:

\`\`\`
set_grid({ nodeId: "el_main", columns: "240px 1fr", rows: "64px 1fr", gap: 16, areas: ["side top", "side content"] })
place_in_grid({ nodeIds: ["el_sidebar"], area: "side" })
place_in_grid({ nodeIds: ["el_topbar"], area: "top" })
\`\`\`

## Dicas

- Prefira \`fr\` e \`minmax()\` a larguras fixas; \`repeat(auto-fill, minmax(220px, 1fr))\` cria grades responsivas sem breakpoint.
- Cada nome em \`areas\` precisa formar um retângulo; use \`.\` para célula vazia.
- \`get_layout(nodeId)\` mostra as trilhas medidas (tamanhos e linhas de coluna/linha) quando há render; use para conferir se os filhos caíram nas células certas.
- Filho com \`position:absolute\` sai do grid. Itens fora das trilhas declaradas criam trilhas implícitas (\`grid-auto-rows\` controla a altura).
- O código exportado (html, tailwind, react) mantém \`display:grid\`, as trilhas e o posicionamento.
`,
  vectors: `# Vetores e formas

Formas e ícones são nós \`svg\`. Os criados por estas ferramentas têm um modelo vetorial editável (paths, viewBox, tinta); \`get_svg(nodeId)\` mostra o markup e os paths.

## Criar

- \`create_shape({ parentId, shape: "rect"|"ellipse"|"line"|"polygon"|"star", x?, y?, width?, height?, sides?, points?, styles? })\` — estilos de tinta (\`fill\`, \`stroke\`, \`stroke-width\`...) vão para o vetor. Com x/y fica absoluto (o pai precisa ser frame ou position:relative).
- \`insert_svg({ parentId, svg, width?, height? })\` — importa markup SVG; o original é preservado até a primeira edição. Se o SVG usa filtros, máscaras, texto ou opacidade parcial, ele aparece mas não é editável (a resposta avisa).
- \`insert_icon\` (Lucide) também gera nós svg; \`set_vector_paint\` e \`get_svg\` funcionam neles.

## Editar

- \`set_path({ nodeId, d, pathId?, fit? })\` — troca o \`d\` (ex.: \`"M 0 0 L 100 0 L 50 80 Z"\`); \`fit: true\` ajusta o viewBox e a caixa do nó.
- \`set_vector_paint({ nodeId, pathIds?, fill?, stroke?, strokeWidth?, linecap?, linejoin?, dasharray?, opacity? })\` — \`fill\`/\`stroke\` aceitam cor ou gradiente: \`{ type: "linear", stops: [{ offset: 0, color: "#f00" }, { offset: 1, color: "#00f" }], x1: 0, y1: 0, x2: 1, y2: 0 }\`.
- \`boolean_op({ nodeIds, op: "union"|"subtract"|"intersect"|"exclude" })\` — entre 2+ svgs irmãos; o de baixo é o "primeiro" do subtract; curvas são achatadas.
- \`flatten({ nodeIds })\` — junta os paths num só nó/path.
- \`text_to_outlines({ nodeIds })\` — texto vira contornos com a fonte do documento ou do sistema; deixa de ser editável como texto.

## Dicas

- Em ícones simples a cor sai do \`stroke\`/\`fill\` dos paths (\`currentColor\` acompanha a cor de texto do pai).
- Confira com \`get_screenshot\`; tudo se desfaz com \`undo\`.
- Um svg vindo de \`write_html\` é legado: \`get_svg\` infere os paths e a primeira edição cria o vetor.
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
};
