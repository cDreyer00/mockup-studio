/** Guia `get_guide('assistant')`: o assistente de IA do editor e como o agente trabalha dentro de um turno. */
export const ASSISTANT_GUIDE = `# Guia assistant

O Mockup Studio tem um **assistente de IA** no editor: um painel de chat por documento. O usuário escreve o pedido ("deixe esse card mais compacto"), o daemon abre um subprocesso da CLI de agente instalada (Claude Code ou Codex) e essa CLI edita o canvas pelas ferramentas MCP deste mesmo servidor. Não há chave de API própria: vale a conta já logada na CLI.

## Como você (o agente) é chamado

- Cada pedido do usuário é um **turno**. Sua sessão MCP abre com um token de turno (\`/mcp?turn=<token>\`), que o daemon gera só para esse turno.
- **Todas as suas alterações no turno formam um único grupo de undo**: o usuário desfaz o turno inteiro com um Ctrl+Z no editor. Vale também para run_script e remix chamados no turno.
- Dentro de um turno \`undo\` e \`redo\` são **recusados**. Corrija um erro com as ferramentas de edição (update_styles, set_text, delete_nodes...), nunca desfazendo.
- Quando o turno termina (ou o usuário cancela), o token deixa de valer: novas escritas são recusadas com a mensagem "O turno do assistente ... já terminou". Pare ao receber esse erro; o que já foi feito continua desfazível num único passo.
- O prompt traz o documento (nome e docId), a seleção do usuário com o resumo da árvore e, quando há render, um screenshot da seleção. A seleção pode ter mudado desde então: confirme com get_selection se importar.

## Boas práticas dentro de um turno

1. **Passe docId explícito** em toda ferramenta (o do prompt). O documento ativo pode mudar.
2. **Trabalhe sobre a seleção.** Sem seleção, o pedido vale para o documento: veja os frames com get_tree_summary antes de editar.
3. **Edite pouco e confira**: aplique, chame get_screenshot do nó alterado e corrija. Prefira poucas chamadas grandes (write_html, update_styles com vários nodeIds) a muitas pequenas.
4. Use os tokens de design e componentes do documento (get_guide('tokens'), get_guide('components')) em vez de valores soltos.
5. **Não use ferramentas fora do mockup-studio** (shell, arquivos, web): a CLI roda sem elas.
6. Chame finish_working ao terminar, para o editor apagar o selo de "agente trabalhando".
7. **Responda curto, em português do Brasil**: 1 a 3 frases dizendo o que mudou. O texto aparece no chat do usuário.
8. Se o pedido for ambíguo, escolha a interpretação mais conservadora, faça e diga o que assumiu; o usuário pode desfazer e pedir de novo.

## Remix

\`remix(nodeId, kind, count?, prompt?)\` gera variações de um nó (tudo num único grupo de undo):

- \`color-scale\`: escala de 10 tons a partir da cor do nó.
- \`font-pairs\`: pares de fontes (título e corpo).
- \`spacing\`: escala de espaçamento 4/8.
- \`layout\`: 3 rearranjos do flex (direção, alinhamento, distribuição).
- \`ai\`: variações livres a partir de \`prompt\` (usa um turno do assistente).

## Scripts

\`run_script\` executa JavaScript contra o documento (API \`doc\`), também num único grupo de undo. Detalhes e exemplos em get_guide('scripts').
`;
