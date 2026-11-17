<!-- Cole este bloco no ~/.codex/AGENTS.md (global) ou no AGENTS.md do projeto. Requer o servidor MCP `mockup-studio` registrado (`mockup setup codex`). -->

## Mockup Studio (mockups visuais)

Use o servidor MCP `mockup-studio` quando o usuário pedir mockup, wireframe, protótipo de tela, landing page ou UI visual. Se as ferramentas não existirem, rode `mockup setup codex` e `mockup doctor`.

### Fluxo

1. `get_guide('getting-started')` na primeira vez da sessão.
2. `create_document` (ou `open_document`) num caminho do projeto, como `design/<nome>.mockup.json`.
3. `set_tokens` primeiro: cores, espaçamento, raio, fonte.
4. `create_frame` por breakpoint: `Desktop` 1440x900, `Tablet` 768x1024, `Mobile` 390x844.
5. `write_html(html, css, parentId)` uma seção por vez, com CSS real (flex e `gap`).
6. `get_screenshot(nodeId)` depois de cada seção. Confira alinhamento, cortes, contraste e quebras de texto.
7. Corrija com `update_styles`, `set_text`, `move_nodes`. Use `get_layout` para medidas.
8. `export(nodeIds, format)` em `html`, `tailwind` ou `react` quando pedirem código.
9. `finish_working` ao terminar.

### Regras de qualidade

- Espaçamento em múltiplos de 4 e 8 px; hierarquia tipográfica clara; contraste AA.
- Conteúdo realista, sem lorem ipsum.
- `insert_image` para imagens; `search_icons` e `insert_icon` para ícones.
- Nomes de camadas claros com `rename_nodes`; cores via tokens (`var(--color-primary)`).

### Economia de contexto

- Screenshot com `scale: 1`, `maxWidth: 800` e `format: "jpg"`.
- `get_tree_summary` com `depth` pequeno.
- Sem screenshot disponível: `mockup doctor` e `get_guide('troubleshooting')`.
