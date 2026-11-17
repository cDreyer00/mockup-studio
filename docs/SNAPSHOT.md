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

A captura de referência usa `chrome.tabs.captureVisibleTab`: só a parte visível do elemento entra na imagem (ver [Referência recortada](#referência-recortada-pela-viewport)).

### Roteiro de teste manual da extensão

1. `npm run build -w @mockup/extension` (monta `packages/extension/dist`).
2. `chrome://extensions` > **Modo do desenvolvedor** > **Carregar sem compactação** > `packages/extension/dist`. Confira que o id é `agjagmcpikghnfnnapjbicplkmommmkn` (fixo, vem da `key` do manifest; é o único que o daemon aceita).
3. Com o Mockup Studio aberto e um documento ativo, abra um site e clique no ícone da extensão. O popup deve mostrar "Mockup Studio no ar".
4. Escolha **Enviar** (ou **Copiar**) e clique em **Selecionar seção**: o contorno segue o cursor; teste **hover**, **↑**, **↓** e **Esc** (cancela); clique na seção.
5. Modo Enviar: toast "Enviado ao Mockup Studio (N nós)" e o frame (mais o oculto "Referência") aparece no editor. Modo Copiar: toast "Copiado", e Ctrl+V no canvas do editor cria o frame.
6. Feche o app e repita no modo Enviar: o toast diz que o app não respondeu e que a captura foi **copiada**; abra o app e cole com Ctrl+V.
7. Selecione uma seção maior que a janela (ou reduza a janela): o frame importado leva o aviso "A imagem de referência cobre só a parte visível da seção...".
8. Seção enorme (milhares de imagens grandes): o toast de erro pede uma seção menor (ver limites abaixo).

### Limites de tamanho

- O content script captura com `maxInlineTotalBytes` de 32 MiB (soma do tamanho das data URLs embutidas, em caracteres: ~4/3 dos bytes; o padrão do core é 40 MiB). O que passa do limite fica só com a URL e o daemon tenta baixar.
- O snapshot vai ao service worker por `chrome.runtime.sendMessage`, que o Chrome limita a ~64 MiB por mensagem. A extensão mede o JSON (inclusive a referência) e, acima de 48 MiB, remove a `dataUrl` dos maiores assets até caber (o daemon baixa pela URL) e acrescenta um aviso em `stats.warnings`; uma referência que sozinha passa de 24 MiB é removida (com aviso). Se nem assim couber, o toast de erro diz que a seção é grande demais e sugere uma menor.
- Mensagens ao usuário: app fora do ar (sem resposta) copia para o clipboard e avisa; erro HTTP do daemon (400, 403, 413...) mostra um toast de erro com o status e a mensagem `{ error }` e **não** copia; falha de tamanho do `sendMessage` mostra a mensagem de seção grande demais.

### Referência recortada pela viewport

A imagem de referência é o `captureVisibleTab` recortado no retângulo da seção, limitado à parte visível da aba. Quando o retângulo passa da viewport (qualquer lado), a extensão acrescenta em `stats.warnings` "A imagem de referência cobre só a parte visível da seção (WxH de W2xH2 px); role a página ou use import_url para a captura inteira." (se nada da seção está visível, não há referência e o aviso diz isso). `reference.width`/`height` são o tamanho do recorte, coerentes com a imagem. O frame editável sempre traz a seção inteira; só a referência é parcial.

### O que o e2e cobre e o que não cobre

`packages/editor/e2e/snapshot-extension.spec.ts` tem dois blocos:

- **activeTab simulado** (cópia de `dist` com `host_permissions: ["<all_urls>"]`, mesmo id): id fixo, envio e fidelidade no canvas (dimensões e pixels), edição inline, modo copiar + colar, referência recortada com aviso, app fora do ar (copia) e erro HTTP do daemon (não copia). O início do seletor é chamado direto no service worker.
- **manifesto real** (`dist` sem alteração: sem `host_permissions`, com `key`): id fixo, popup com status "no ar" (ping), POST do service worker passando na Origin do id fixo e no CORS, recusa da injeção sem o gesto do usuário (o popup mostra "Não foi possível iniciar nesta página.") e o fluxo completo: o CDP `Extensions.triggerAction` (Chromium 159 do Playwright) faz o papel do clique no ícone, abre o popup real e concede o `activeTab` à aba; o popup é dirigido por `Runtime.evaluate`.

Não cobre: o clique físico no ícone da barra (UI do navegador), o menu "fixar extensão", o Edge, a leitura dos toasts (ficam num shadow root fechado) e sites reais (CSP, cookies, iframes).

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

- rede: só `http`, `https`, `ws`, `wss`, `data`, `blob` e `about`; `file://` é cancelado; permissões, downloads, popups e navegações depois da inicial são negados; áudio mudo. O isolamento de rede local está detalhado em [Isolamento da janela de captura](#isolamento-da-janela-de-captura);
- viewport exato via CDP; depois do load espera o seletor aparecer (até 5 s em `import_url` e `import_html` com `assets_base_url`, em que o JS da página pode montar o DOM; até 1 s em `import_html` sem base, HTML estático com JS desligado), depois `document.fonts.ready` e as imagens (até 3 s). Seletor que não aparece dá o erro `Seletor "..." não encontrado ... (esperou N s após o carregamento)`;
- status HTTP da navegação principal (`import_url`) 4xx/5xx **não** é erro: a página de erro é importada (pode ser o que se quer, ex.: o design de um 404) e o resultado leva o aviso `A página respondeu HTTP <status>: ...`. Falha de rede (DNS, conexão recusada) continua sendo erro;
- a captura roda num mundo isolado (o JS da página não interfere); a referência sai do `Page.captureScreenshot` com o retângulo do elemento;
- prazo total `timeout_ms` (padrão 20 s): estourou, a janela é destruída e a ferramenta responde com erro.

### Isolamento da janela de captura

A página importada é código não confiável; a janela impede que ela use a máquina do usuário como ponte (`packages/desktop/src/main/netguard.ts`, aplicado em `snapshot.ts`):

- **Daemon sempre bloqueado:** qualquer requisição (navegação principal inclusive) para a origem do daemon (127.0.0.1/localhost/`[::1]` na porta dele) é cancelada.
- **Navegação principal livre:** a URL importada pode ser qualquer `http(s)`, inclusive `localhost` e a rede local (o dev server do usuário). A origem dela (protocolo, host e porta) vira a **origem confiável** da importação e é atualizada se o servidor redirecionar. No `import_html` com `assets_base_url`, a origem confiável é a do `assets_base_url`; sem ele, nenhuma origem privada é confiável.
- **Subrequisições** (imagens, CSS, fontes, `fetch`/XHR, iframes, websockets...) para loopback (`127/8`, `::1`, `localhost`, `*.localhost`), redes privadas (`10/8`, `172.16/12`, `192.168/16`, `fc00::/7`), link-local (`169.254/16`, `fe80::/10`), `0/8`, CGNAT (`100.64/10`) e IPv4 mapeado em IPv6 são **bloqueadas**, a menos que a origem seja igual à origem confiável. Uma página em `http://127.0.0.1:5173` carrega seus assets, mas não alcança `http://localhost:5173` nem `http://127.0.0.1:3000`.
- **DNS:** para nomes de host (não IP) a janela resolve com `dns.lookup` (todos os endereços) antes de liberar e bloqueia se algum for privado; falha na resolução também bloqueia. O resultado fica em cache por 30 s por host.
- **JavaScript desligado no `import_html` sem `assets_base_url`:** o HTML recebe uma CSP `script-src 'none'` (via `<meta>` logo após o doctype), então `<script>`, handlers `on*=` e `javascript:` da página não executam. A captura não é afetada porque roda num mundo isolado, que ignora a CSP da página. `webPreferences.javascript: false` foi testado e **não serve**: desliga também o mundo isolado e a importação estoura o prazo. Com `assets_base_url` (e no `import_url`) a página é "de verdade" e o JS roda normalmente.
- **Risco residual:** o resolvedor do Chromium é independente do `dns.lookup` do Node (cache próprio, DNS seguro/DoH, `/etc/hosts` e resolvedores do sistema podem responder diferente), e há uma janela entre a checagem e a conexão (DNS rebinding). Por isso o bloqueio por nome é uma segunda linha; a primeira são os literais IP/`localhost`, avaliados sem DNS. O download dos assets pelo daemon tem sua própria checagem na conexão (ver abaixo).

## Segurança e limites

- **Origin da extensão:** `POST /api/snapshot` só aceita `chrome-extension://<id fixo>` (o id vem da `key` do manifest, `MOCKUP_EXTENSION_ID` em `@mockup/snapshot-core`); qualquer outra extensão recebe 403. Quem empacotar a extensão com outra chave libera o id novo pela variável de ambiente `MOCKUP_EXTENSION_IDS` do daemon (lista separada por vírgula ou espaço, ids de 32 letras a-p, lida a cada requisição).
- **Rede local no download de assets:** as URLs de imagens e fontes do payload (que pode vir da extensão, do clipboard ou da janela de captura) são baixadas pelo daemon com um cliente próprio que recusa destinos em loopback (`127/8`, `::1`), redes privadas (`10/8`, `172.16/12`, `192.168/16`, `fc00::/7`), link-local (`169.254/16`, `fe80::/10`), `0/8`, CGNAT (`100.64/10`), multicast/reservados e IPv4 mapeado em IPv6. A checagem é feita na resolução de DNS da própria conexão (sem janela para DNS rebinding) e a cada redirecionamento (até 5). **Exceção:** URLs com a mesma origem (protocolo, host e porta) de `source.url`, a página importada; assim importar de um dev server em `localhost` baixa os assets dele. A falha vira um aviso da importação ("destino na rede local bloqueado: ...") e o asset fica sem arquivo.
- **URLs perigosas:** valores `javascript:` e `data:` que não sejam imagem em `href`, `src`, `action`, `formaction` e `xlink:href` (e no `src` das imagens) são removidos e entram no aviso "Itens removidos por segurança".
- **Orçamento por importação:** a soma dos bytes de imagens e fontes carregados (data URL decodificada ou baixada) é limitada a 150 MB (`MAX_IMPORT_TOTAL_BYTES`), além de 20 MB por arquivo. Ao estourar, um aviso único informa e os assets restantes ficam sem arquivo.
- **Viewport:** largura de 320 a 3840 px e altura de 200 a 4000 px (`IMPORT_VIEWPORT_LIMITS`), os mesmos no editor, nas rotas e no MCP.

## Limitações

- Páginas atrás de login só pela extensão (o `import_url` abre uma sessão limpa, sem cookies).
- `canvas`, `video`, `iframe`, `object` e `embed` viram placeholders cinza do mesmo tamanho.
- Imagens e fontes de outra origem sem CORS: a extensão não lê os bytes e o daemon os baixa da URL original; se o servidor exigir cookies ou bloquear, a imagem fica vazia (com aviso). Folhas de estilo de outra origem sem CORS podem esconder `@font-face` (a fonte cai no fallback).
- Valores ficam resolvidos no viewport da captura: porcentagens, `vw`, `fr` e `clamp()` viram px. Para outro breakpoint, importe de novo com outra largura.
- Animações, transições, `:hover` e estados não entram; só o estado no momento da captura.
- `counter()` em pseudo-elementos é ignorado; `list-style-image` e `border-image` com `url()` não são importados.
- A captura de referência da extensão só cobre a parte visível do elemento (a extensão avisa; use `import_url` para a captura inteira).
- `cleanup_imported` é heurístico: confira o screenshot depois (undo desfaz).

## Testes

- `packages/snapshot-core/test/capture.test.ts`: captura real no Chromium do Playwright das fixtures em `packages/snapshot-core/test/fixtures/` (header com nav, hero com imagem, botão com pseudo-elemento; fontes; casos extras).
- `packages/server/src/snapshot.*.test.ts`: pipeline, rotas (origem da extensão) e ferramentas MCP com render falso.
- `packages/desktop/src/snapshot.integration.test.ts`: `import_url` via MCP no Electron headless real contra uma página local, medindo o tempo (< 10 s).
- `packages/editor/e2e/snapshot-extension.spec.ts`: a extensão carregada no Chromium do Playwright, em dois blocos (activeTab simulado com `host_permissions` só na cópia; e o manifesto real, com popup, Origin/CORS, recusa sem gesto e fluxo completo via CDP `Extensions.triggerAction`). Detalhes em [O que o e2e cobre e o que não cobre](#o-que-o-e2e-cobre-e-o-que-não-cobre).
- `packages/editor/e2e/snapshot-paste.spec.ts`: colar snapshot, simplificar e o diálogo de importar URL.
