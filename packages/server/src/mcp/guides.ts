export const GUIDE_TOPICS = ['getting-started', 'layout', 'responsive', 'tokens'] as const;
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
5. \`get_tree_summary(nodeId?, depth?)\` — confira a estrutura; use \`get_html\` para ver o código.
6. Refine com \`update_styles\`, \`set_text\`, \`move_nodes\`, \`duplicate_nodes\`; use \`undo\` se errar.

## Dicas

- Prefira \`write_html\` a muitas chamadas \`create_node\`: é mais rápido e mais legível.
- Sem \`parentId\`, o conteúdo vai para o nó selecionado ou para o primeiro frame.
- O salvamento em disco é automático; \`save_document\` força a gravação.
- Veja também: \`get_guide('layout')\`, \`get_guide('responsive')\`, \`get_guide('tokens')\`.
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
};
