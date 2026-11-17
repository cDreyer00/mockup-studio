/** Guia MCP do tópico `import` (importação de sites); fica aqui para não inflar `mcp/guides.ts`. */

export const IMPORT_GUIDE_INFO = {
  title: 'Guia: importar sites',
  description:
    'Extensão x import_url x import_html, seletor e largura, frame Referência, cleanup_imported, tokens e limitações.',
};

export const IMPORT_GUIDE = `# Importar sites para o canvas

Transforma uma página (ou uma seção) de um site existente num frame editável: nós HTML/CSS reais com estilos computados, imagens em \`assets/\` e fontes registradas no documento.

## Qual caminho usar

- **Extensão do navegador** — o usuário abre o site já logado, escolhe o elemento e envia ao Mockup Studio. É o único caminho para páginas atrás de login, paywall ou com estado (menus abertos, abas).
- \`import_url({ url, selector?, width? })\` — o daemon abre a URL numa janela isolada e captura. Exige o motor de render (app desktop ou \`mockup serve --render\`); sem ele a ferramenta explica e você usa \`import_html\`.
- \`import_html({ html, css?, assets_base_url? })\` — para HTML que você já tem (trecho colado, arquivo local). Com render captura como o import_url; sem render faz uma conversão simples, menos fiel (sem estilos computados nem fontes), e o frame ganha a altura do viewport: ajuste-a.

## Seletor e largura

- \`selector\` limita a captura a um elemento (\`"header"\`, \`"#pricing"\`, \`".hero"\`); sem ele vem a página inteira. Seções separadas dão árvores menores e mais fáceis de editar.
- \`width\` escolhe o breakpoint do site (320 a 3840; padrão 1440). Para o mesmo site em vários tamanhos, importe uma vez por largura (ex.: 1440, 768, 390) e nomeie cada frame com \`name\`.

## Depois de importar

1. O resultado traz o id do frame (\`fr_...\`), contagens e avisos. Confira com \`get_screenshot(frameId)\`.
2. Compare com o original: a captura vem junto num frame oculto chamado "Referência — <nome>", à direita. Para ver, \`set_node_flags\` com \`hidden:false\` nesse frame e use \`get_screenshot\` (oculte ou apague depois). \`reference:false\` não anexa a referência.
3. \`cleanup_imported(frameId)\` simplifica a árvore: remove wrappers vazios, desembrulha divs sem estilo troca width em px igual ao do pai por auto e height em px de blocos com conteúdo por min-height, para o conteúdo poder crescer (\`remove_empty\`, \`unwrap\` e \`fluid\` ligam e desligam cada regra). É uma entrada de histórico: \`undo\` desfaz. Confira o screenshot de novo.
4. Tokens: cores e espaçamentos repetidos viram variáveis. Leia com \`get_html\`/\`get_styles\`, agrupe os valores que mais aparecem (cor de marca, texto, fundo, raio) e defina com \`set_tokens\`; depois troque os valores por \`var(--...)\` com \`update_styles\` (veja \`get_guide('design-system')\`).

## Onde as imagens e fontes vão

- Documento salvo: imagens e fontes ficam em \`assets/\` e \`assets/fonts\`. Documento sem caminho: imagens são embutidas (data URL) e as fontes são puladas (salve o documento e importe de novo).
- Fundos \`url()\` são embutidos até ~2 MB; acima disso o estilo aponta para a URL original (aviso).

## Limitações

- Páginas com login/paywall: use a extensão (o import_url abre uma janela sem sessão).
- \`canvas\`, \`video\`, \`iframe\` e mapas viram placeholders; conteúdo carregado por scripts depois da captura pode faltar. O seletor é esperado até 5 s depois do load (1 s no \`import_html\` sem \`assets_base_url\`, em que o JS fica desligado); se não aparecer, a importação falha com "Seletor ... não encontrado".
- URL que responde 4xx/5xx é importada assim mesmo (vem a página de erro) com o aviso "A página respondeu HTTP <status>": confira a URL antes de seguir.
- Fontes de outro domínio sem CORS podem não vir nos bytes da captura; o daemon tenta baixar pela URL e avisa quando falha (a família cai no fallback do sistema).
- Animações, hover e estados dinâmicos viram o quadro capturado; \`position: sticky\`/\`fixed\` e vídeos de fundo ficam estáticos.
- Limite de ~5000 nós por importação: use \`selector\` para seções menores.
`;
