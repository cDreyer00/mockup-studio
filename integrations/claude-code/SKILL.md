---
name: mockup-studio
description: Use quando o usuário pedir mockup, wireframe, protótipo de tela, landing page ou UI visual; cria e itera designs no Mockup Studio via MCP com screenshot.
---

# Mockup Studio

Cria mockups no Mockup Studio pelo servidor MCP `mockup-studio`, vê o resultado em screenshot e itera até ficar bom.

## Pré-requisito

- O servidor MCP `mockup-studio` precisa estar registrado e conectado (`claude mcp list`).
- Se as ferramentas (`create_frame`, `write_html`, `get_screenshot`...) não aparecerem, rode `mockup setup claude` e reinicie o Claude Code.
- Se o screenshot falhar, rode `mockup doctor` (veja o fim deste arquivo).

## Fluxo de trabalho

1. Entenda o pedido: objetivo da tela, público, seções, tom visual. Pergunte só o que bloqueia.
2. Chame `get_guide('getting-started')` na primeira vez da sessão.
3. Crie ou abra o documento num caminho sensato do projeto do usuário, por exemplo `design/<nome>.mockup.json`: `create_document(path, name)` ou `open_document(path)`.
4. Defina os tokens antes do conteúdo com `set_tokens`: cores (`--color-primary`, `--color-bg`, `--color-text`), espaçamento (`--space-4`), raio (`--radius-md`), fonte (`--font-sans`).
5. Crie um frame por breakpoint com `create_frame`:
   - `Desktop` 1440x900
   - `Tablet` 768x1024
   - `Mobile` 390x844
6. Monte o conteúdo por seção com `write_html(html, css, parentId)`: CSS real, `display:flex` e `gap`. Uma seção por chamada (header, hero, recursos, rodapé).
7. Depois de cada seção, `get_screenshot(nodeId)` e confira:
   - alinhamento e espaçamento consistentes
   - nada cortado nem vazando do frame
   - contraste e textos que quebram em lugares ruins
   - hierarquia tipográfica e elementos repetidos idênticos
8. Corrija com `update_styles`, `set_text`, `move_nodes`, `set_tag`. Use `undo` se errar.
9. Use `get_layout(nodeId)` quando precisar de medidas exatas (posição, tamanho, overflow).
10. Para os outros breakpoints, `duplicate_nodes([frameId])`, `rename_nodes`, ajuste a largura e adapte o layout (`column`, menos `padding`).
11. Quando o usuário pedir código, `export(nodeIds, format)` com `html`, `tailwind` ou `react` (`get_code` só lê, não grava arquivos).
12. Ao terminar, chame `finish_working` e diga ao usuário onde está o arquivo.

## Regras de qualidade

- Espaçamento em múltiplos de 4 e 8 px.
- Hierarquia tipográfica clara: um título dominante, subtítulos, corpo de 16 px ou mais, no máximo 2 famílias.
- Contraste AA: 4,5:1 para texto normal, 3:1 para texto grande.
- Conteúdo realista (nomes, preços, frases de produto), nunca lorem ipsum.
- Imagens com `insert_image`; ícones com `search_icons` e `insert_icon` (Lucide).
- Nomes de camadas claros com `rename_nodes` ("Hero", "Botão primário", "Card de plano").
- Use tokens via `var(--color-primary)` em vez de cores soltas repetidas.
- Prefira `write_html` a muitas chamadas `create_node`.

## Economia de contexto

- `get_screenshot` com `scale: 1`, `maxWidth: 800` e `format: "jpg"`; `scale: 2` só para detalhes.
- Capture a seção que mudou, não o frame inteiro.
- `get_tree_summary(nodeId, depth)` com `depth` pequeno (1 ou 2); `get_html` só do nó necessário.

## Se o screenshot estiver indisponível

- A ferramenta avisa que o motor de render não está ativo (daemon Node sem Electron).
- Rode `mockup doctor`: ele mostra o modo do daemon, se o Electron foi encontrado e a porta 4747.
- Abra o app Mockup Studio, ou rode `mockup stop` e deixe o `mockup mcp` subir de novo.
- Enquanto isso, confira a estrutura com `get_tree_summary` e `get_html` e avise o usuário que não viu o resultado.
- Mais detalhes: `get_guide('troubleshooting')`.
