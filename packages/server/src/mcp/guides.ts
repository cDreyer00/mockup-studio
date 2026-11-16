export const GUIDE_TOPICS = [
  'getting-started',
  'layout',
  'responsive',
  'tokens',
  'screenshot-loop',
  'export',
] as const;
export type GuideTopic = (typeof GUIDE_TOPICS)[number];

export const GUIDES: Record<GuideTopic, string> = {
  'getting-started': `# Começando com o Mockup Studio

O documento é uma árvore de nós HTML/CSS reais: páginas > frames (artboards) > elementos.
Cada nó tem um id estável (ex.: \`fr_ab12cd34\`, \`el_...\`, \`tx_...\`).

## Fluxo típico

1. \`open_document(path)\` ou \`create_document(path, name)\` — abre ou cria o arquivo \`.mockup.json\`.
2. \`get_basic_info\` — veja páginas, frames, documentos abertos e a seleção atual.
3. \`create_frame(name, width, height)\` — cria um frame raiz (ex.: "Desktop", 1440x900).
4. \`write_html(html, css?, parentId?)\` — crie conteúdo inteiro de uma vez com HTML + CSS.
5. \`get_screenshot(nodeId?)\` — VEJA o resultado e corrija o que estiver errado (veja \`get_guide('screenshot-loop')\`).
6. \`get_tree_summary(nodeId?, depth?)\` — confira a estrutura; use \`get_html\` para ver o código.
7. Refine com \`update_styles\`, \`set_text\`, \`move_nodes\`, \`duplicate_nodes\`; use \`undo\` se errar.
8. Ao terminar, chame \`finish_working\` para limpar o indicador "IA" no editor.

## Dicas

- Prefira \`write_html\` a muitas chamadas \`create_node\`: é mais rápido e mais legível.
- Sem \`parentId\`, o conteúdo vai para o nó selecionado ou para o primeiro frame.
- O salvamento em disco é automático; \`save_document\` força a gravação.
- Imagens, ícones e fontes: \`insert_image\`, \`insert_icon\` (\`search_icons\`), \`add_font\` (\`list_fonts\`).
- Veja também: \`get_guide('layout')\`, \`get_guide('responsive')\`, \`get_guide('tokens')\`, \`get_guide('screenshot-loop')\`, \`get_guide('export')\`.
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
- \`fill\`: use \`flex:1\` (ou \`flex-grow:1\`) para preencher o eixo principal.
- Limites: \`max-width:1200px; min-height:400px\`.

## Posição absoluta

- No filho: \`position:absolute; top:..; left:..\` e o pai com \`position:relative\`.
- Para posicionar no canvas, \`set_position(nodeId, x, y)\` (frames raiz e filhos absolutos).

## Boas práticas

- Espaçamento com \`gap\` e \`padding\`, evite margens soltas.
- Frames raiz têm largura/altura fixas (ex.: 1440x900); o conteúdo interno deve fluir.
- Use \`get_styles([ids])\` para ver os estilos efetivos de um nó.
`,
  responsive: `# Responsivo com frames

No Mockup Studio, cada frame raiz é um breakpoint/artboard na mesma página.

## Fluxo

1. Crie o frame desktop: \`create_frame("Desktop", 1440, 900)\` e monte o conteúdo.
2. Duplique o frame: \`duplicate_nodes([frameId])\` — o clone aparece no canvas.
3. Renomeie e redimensione: \`rename_nodes\` e \`update_styles({ width: "390px" })\`.
4. Adapte o clone: troque \`flex-direction:row\` por \`column\`, reduza \`padding\` e fontes.
5. Posicione com \`set_position(frameId, x, y)\` para não sobrepor frames.

## Larguras comuns

- Desktop 1440, Tablet 768, Mobile 390.

## Dicas

- Mantenha os mesmos nomes de camadas entre frames para facilitar comparações.
- Prefira \`width:100%\` e \`max-width\` dentro dos frames em vez de larguras fixas.
- Use \`get_basic_info\` para listar frames com tamanho e posição.
`,
  tokens: `# Tokens (variáveis CSS)

Tokens são variáveis CSS do documento, guardadas em \`tokens\` (ex.: \`--color-primary\`).

## Uso

- Defina: \`set_tokens({ "--color-primary": "#6c5ce7", "--space-4": "16px" })\`.
- Remova: \`set_tokens({}, ["--old"])\` (segundo parâmetro \`unset\`).
- Consulte: \`get_tokens\`.
- Aplique em estilos: \`update_styles(["el_x"], { background: "var(--color-primary)", padding: "var(--space-4)" })\`.
- Também funciona no HTML: \`<button style="background:var(--color-primary)">\`.

## Convenções

- Nomes com prefixo \`--\`: \`--color-*\`, \`--space-*\`, \`--radius-*\`, \`--font-*\`.
- Alterar o valor de um token atualiza todos os nós que o usam.
- \`get_styles\` devolve os valores resolvidos (com os tokens substituídos).
`,
  'screenshot-loop': `# Ciclo de screenshot

Não confie só na estrutura: depois de cada conjunto de mudanças, olhe o resultado.

## Ciclo

1. Crie ou edite (\`write_html\`, \`update_styles\`, \`insert_image\`...).
2. \`get_screenshot(nodeId)\` — confira a imagem.
3. Corrija o que estiver errado e repita o 2.
4. Ao terminar, \`finish_working\` para limpar o indicador "IA" no editor.

## Checklist visual

- Alinhamento e espaçamento consistentes (gap, padding, margens).
- Nada cortado nem vazando do frame (overflow); imagens com proporção correta.
- Contraste suficiente entre texto e fundo.
- Textos quebrando em lugares ruins (títulos em muitas linhas, botões com texto em duas linhas).
- Hierarquia: tamanhos e pesos de fonte coerentes; elementos repetidos idênticos.

## Economize contexto

- Prefira \`scale: 1\` e use \`maxWidth\` (ex.: 800) em frames grandes; \`scale: 2\` só para detalhes.
- Capture o nó que mudou (uma seção), não o frame inteiro, quando possível.
- \`format: "jpg"\` gera imagens menores.

## Medidas exatas

\`get_layout(nodeId, depth?)\` lista \`id "nome" tag x,y wxh\` (px, relativos ao frame) e o texto das linhas.
Use para verificar alinhamento, espaçamento e overflow com números.

## Disponibilidade

Screenshot e \`get_layout\` exigem o motor de render (app desktop ou Electron headless). Num daemon Node puro,
as ferramentas avisam; use \`get_tree_summary\` e \`get_html\` para conferir a estrutura.
`,
  export: `# Exportação

## get_code x export

- \`get_code(nodeId, format)\` — devolve o código na resposta, sem gravar arquivos. Bom para ler/colar.
- \`export(nodeIds, format, outputDir?)\` — grava arquivos, um por nó, e copia os assets usados.

## Formatos

- \`png\` / \`jpg\` (\`scale\` 1-3): imagem do nó; exige render.
- \`svg\`: vetor do nó (com render usa as medidas reais; sem render, um fallback com foreignObject).
- \`html\`: documento HTML com CSS em classes.
- \`tailwind\`: HTML com classes Tailwind v4 (\`<nome>.tailwind.html\`).
- \`react\`: componente \`<Nome>.tsx\` (\`styles\`: "tailwind" ou "inline"); se houver CSS, \`theme.css\` ou \`<Nome>.css\`.

## Pasta de saída

- Padrão: \`<pasta do documento>/exports/\`. Documento sem caminho exige \`outputDir\` (absoluto).
- Os arquivos usam o nome do nó em slug (\`Desktop 1440\` vira \`desktop-1440.png\`).
- Para html/tailwind/react, imagens e fontes usadas são copiadas para \`<outputDir>/assets/\`.

## Dicas

- Dê nomes claros às camadas (\`rename_nodes\`): viram nomes de arquivo e de componente.
- Exporte um nó por componente; use \`get_screenshot\` antes para conferir o visual.
`,
};
