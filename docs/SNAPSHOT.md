# Snapshot de sites

Traz seções de sites reais para o canvas como **nós editáveis** (HTML/CSS reais, não imagem). Há três entradas, todas pelo mesmo pipeline do daemon:

| Entrada                        | Quem usa | Como                                                                                                               |
| ------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------ |
| Extensão de navegador (MV3)    | Usuário  | Seleciona a seção sob o cursor em qualquer aba e envia ao app (ou copia para colar com Ctrl+V no editor).          |
| `import_url` / Importar de URL | Agente   | O app abre a página num Electron headless isolado, roda a captura no seletor e cria o frame. Precisa do render.    |
| `import_html`                  | Agente   | HTML completo (com `<style>`/`<link>`) renderizado da mesma forma; sem render cai na conversão HTML → nós do core. |

## Como funciona

1. **Captura** (`@mockup/snapshot-core`, roda no navegador): percorre a subárvore do elemento e, para cada nó, lê `getComputedStyle` de uma lista curada de propriedades. Só fica o que difere do padrão (o padrão de cada tag é medido num iframe oculto com o mesmo CSS base do documento do canvas, `documentBaseCss`); propriedades herdadas só aparecem quando mudam em relação ao pai, e a raiz recebe a tipografia explícita. Tamanhos: `width`/`height` em px só quando o elemento não tem tamanho automático (testado trocando por `auto` e medindo, com o `style` original restaurado), sempre na raiz e em elementos substituídos. `::before`/`::after` com conteúdo viram nós reais; `fixed` vira `absolute` relativo à raiz, `sticky` vira `relative`. Imagens (`<img>`, `background-image`) e fontes (`@font-face` usados) viram assets, embutidos como data URL quando a página permite ler os bytes. Limites: 3000 nós, 40 níveis (`stats.truncated` avisa).
2. **Formato** (`SnapshotPayload`, `packages/snapshot-core/src/format.ts`): o nó raiz no formato do core, com referências `asset:<id>` no `src` das imagens e em `url("asset:<id>")` nos estilos, a lista de assets (URL original e, se houver, a data URL), as fontes, a captura de referência e avisos.
3. **Importação** (daemon, `packages/server/src/snapshot/`): valida o payload, troca os ids, transforma a raiz em frame (posição à direita do último frame da página), grava as imagens em `assets/` (documento não salvo: data URL), embute imagens de fundo como data URL (até 2 MB; o canvas não resolve `url()` relativos em estilos), grava as fontes em `assets/fonts/` e as registra em `doc.fonts`, e cria ao lado um frame oculto **"Referência — <nome>"** com a captura de tela. Tudo numa única entrada do histórico (um undo desfaz).
4. **Simplificação** (`planCleanup`, mesma lógica no MCP e no editor): remove wrappers vazios, desembrulha wrappers neutros com um único filho e deixa tamanhos fluidos (`width` em px igual à largura de conteúdo do pai vira auto; `height` em px de blocos com conteúdo vira `min-height`).

## Extensão (Chrome e Edge)

### Instalar (modo desenvolvedor)

1. `npm run build` (ou só `npm run build -w @mockup/snapshot-core -w @mockup/extension`).
2. Abra `chrome://extensions` (ou `edge://extensions`) e ligue o **Modo do desenvolvedor**.
3. **Carregar sem compactação** e escolha a pasta `packages/extension/dist`.
4. Fixe o ícone "Mockup Studio — Capturar seção" na barra.

Depois de um novo build, clique em "Recarregar" no cartão da extensão.

### Usar

1. Deixe o Mockup Studio aberto (app desktop ou `mockup serve`) com um documento ativo. Salve o documento para as imagens e fontes irem para `assets/`.
2. Na aba do site, clique no ícone da extensão. Escolha o destino: **Enviar ao Mockup Studio** (padrão) ou **Copiar para colar (Ctrl+V)**. A porta do daemon (padrão 4747) fica salva no popup; o popup mostra se o app está no ar.
3. **Selecionar seção**: o contorno segue o cursor e o rótulo mostra tag, classes e tamanho. **↑** sobe para o elemento pai, **↓** volta ao filho, **Esc** cancela, clique captura.
4. Enviado: o frame aparece no canvas (toast "Enviado ao Mockup Studio (N nós)"). Se o app não responder, o snapshot é copiado e basta colar no editor com Ctrl+V.

A captura de referência usa `chrome.tabs.captureVisibleTab`: só a parte visível do elemento entra na imagem.

### Permissões

`activeTab` (acesso à aba só depois do clique no ícone), `scripting` (injetar o seletor) e `clipboardWrite` (copiar). Sem `host_permissions` e sem telemetria: o POST para `http://127.0.0.1:<porta>/api/snapshot` sai do service worker com `Origin: chrome-extension://<id>`, e o daemon aceita essa origem **só nessa rota** (com CORS e preflight); as demais rotas continuam recusando origens de extensão.

## Colar no editor

O formato de clipboard é o JSON do payload em texto puro (começa com `{"format":"mockup-snapshot"`). No editor, Ctrl+V com esse conteúdo envia o snapshot ao daemon (`POST /api/snapshot`), centraliza o frame na viewport, seleciona e mostra "Seção importada (N nós)" com os avisos, se houver.

No editor também há:

- **Importar de URL** (ícone de globo na barra): URL, seletor CSS (vazio = página inteira), largura do viewport (padrão 1440) e "Anexar imagem de referência". Precisa do motor de render (app desktop ou `mockup serve --render`).
- **Simplificar importação** (menu de contexto de um nó com filhos, no canvas ou nas camadas): aplica o `planCleanup` numa única entrada do histórico.

## MCP

| Ferramenta         | Uso                                                                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `import_url`       | `url` http(s), `selector` (padrão `body`), `width`/`height` do viewport (padrão 1440x900), `timeout_ms` (padrão 20000, até 60000).         |
| `import_html`      | `html`, `css`, `assets_base_url` (resolve URLs relativas), `selector`, `width`/`height`. Sem render: conversão do core (fidelidade menor). |
| `cleanup_imported` | `nodeId` e as regras `remove_empty`, `unwrap`, `fluid` (todas ligadas por padrão).                                                         |

As de importação aceitam também `name`, `reference`, `pageId`, `x`, `y` e `docId`. Fluxo sugerido (`get_guide('import')`): importar, `get_screenshot` do frame e comparar com o frame "Referência", `cleanup_imported`, extrair tokens de cores repetidas com `set_tokens`. Detalhes em [MCP.md](MCP.md#importação-de-sites).

## HTTP

| Rota                    | Corpo                                                                          | Notas                                                         |
| ----------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| `POST /api/snapshot`    | `{ payload, docId?, pageId?, x?, y?, reference?, name? }` (ou o payload puro)  | Aceita Origin local e `chrome-extension://`. Corpo até 64 MB. |
| `POST /api/import/url`  | `{ url, selector?, viewport?: { width, height }, timeoutMs?, ...posição }`     | 503 sem motor de render.                                      |
| `POST /api/import/html` | `{ html, css?, assetsBaseUrl?, selector?, viewport?, timeoutMs?, ...posição }` | Sem render usa a conversão do core (`method: 'html'`).        |

Respondem `SnapshotImportResult` (`docId`, `pageId`, `frameId`, `referenceId?`, `nodes`, `images`, `fonts`, `warnings`, `method`). Erros: 400 corpo/URL inválidos, 404 documento ou página inexistente, 409 nenhum documento aberto, 502 falha na captura, 503 sem render.

## Captura headless (app desktop)

O `RenderProvider.snapshot` do app (`packages/desktop/src/main/snapshot.ts`) abre **uma janela nova por importação**, numa sessão em memória própria (`mockup-snapshot`), e a destrói no fim:

- rede: só `http`, `https`, `data`, `blob` e `about`; `file://` e requisições para o próprio daemon são canceladas; permissões, downloads, popups e navegações depois da inicial são negados; áudio mudo;
- viewport exato via CDP; espera o seletor, `document.fonts.ready` e as imagens (até 3 s);
- a captura roda num mundo isolado (o JS da página não interfere); a referência sai do `Page.captureScreenshot` com o retângulo do elemento;
- prazo total `timeout_ms` (padrão 20 s): estourou, a janela é destruída e a ferramenta responde com erro.

## Limitações

- Páginas atrás de login só pela extensão (o `import_url` abre uma sessão limpa, sem cookies).
- `canvas`, `video`, `iframe`, `object` e `embed` viram placeholders cinza do mesmo tamanho.
- Imagens e fontes de outra origem sem CORS: a extensão não lê os bytes e o daemon os baixa da URL original; se o servidor exigir cookies ou bloquear, a imagem fica vazia (com aviso). Folhas de estilo de outra origem sem CORS podem esconder `@font-face` (a fonte cai no fallback).
- Valores ficam resolvidos no viewport da captura: porcentagens, `vw`, `fr` e `clamp()` viram px. Para outro breakpoint, importe de novo com outra largura.
- Animações, transições, `:hover` e estados não entram; só o estado no momento da captura.
- `counter()` em pseudo-elementos é ignorado; `list-style-image` e `border-image` com `url()` não são importados.
- A captura de referência da extensão só cobre a parte visível do elemento.
- `cleanup_imported` é heurístico: confira o screenshot depois (undo desfaz).

## Testes

- `packages/snapshot-core/test/capture.test.ts`: captura real no Chromium do Playwright das fixtures em `packages/snapshot-core/test/fixtures/` (header com nav, hero com imagem, botão com pseudo-elemento; fontes; casos extras).
- `packages/server/src/snapshot.*.test.ts`: pipeline, rotas (origem da extensão) e ferramentas MCP com render falso.
- `packages/desktop/src/snapshot.integration.test.ts`: `import_url` via MCP no Electron headless real contra uma página local, medindo o tempo (< 10 s).
- `packages/editor/e2e/snapshot-extension.spec.ts`: a extensão carregada no Chromium do Playwright captura a seção da fixture, o frame aparece editável no canvas e o screenshot é comparado ao original com tolerância. O teste copia `dist` e acrescenta `host_permissions: ["<all_urls>"]` só na cópia, porque o Playwright não clica no ícone da barra (o que concederia o `activeTab`).
- `packages/editor/e2e/snapshot-paste.spec.ts`: colar snapshot, simplificar e o diálogo de importar URL.
