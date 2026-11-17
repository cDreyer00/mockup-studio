# Assets e imagens

Imagens e fontes de um documento ficam em `assets/`, ao lado do `.mockup.json`. O daemon serve esses arquivos, dá a cada um um **link direto estável** (CDN local endereçado por conteúdo), mantém uma **biblioteca** global, conta onde cada asset é usado e otimiza imagens. Tudo funciona offline.

## Onde ficam os arquivos

| Local                          | Conteúdo                                                                                                            |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `<pasta do documento>/assets/` | Assets do documento (imagens, `fonts/`, `placeholders/`). Os nós usam caminhos relativos a ela.                     |
| `<pasta de dados>/cdn/`        | CDN local e biblioteca: `<hash>.<ext>` por conteúdo e `index.json` com nome, tipo, tamanho, dimensões, data e tags. |

`hash` são os 32 primeiros caracteres hexadecimais do SHA-256 dos bytes. O mesmo conteúdo dá sempre o mesmo link, em qualquer documento, com o documento fechado e depois de reiniciar o daemon. Sem pasta de dados (testes), o CDN usa uma pasta temporária do processo.

Link `/cdn` usado direto como `src` (ou em `url(...)` e nos dados de repetidores) funciona no canvas e no screenshot enquanto o daemon roda. No `export` de código (html, tailwind, react), os links do próprio daemon (`127.0.0.1`/`localhost`, ou `/cdn/...` relativo) que a biblioteca conhece viram `assets/cdn/<hash>.<ext>` e o arquivo é copiado para `<saída>/assets/cdn/`; o documento não muda. Para o mockup não depender da biblioteca, prefira `src` relativo a `assets/` (`upload_asset` sem `library`).

## Referências e uso

`collectAssetRefs(doc)` (core, `assetRefs.ts`) encontra onde cada arquivo é usado:

- `src` de nós `img` (`src`);
- `url(assets/...)` em estilos (`style`), por exemplo `background-image`;
- arquivos de `doc.fonts` (`font`);
- `src` vindos dos dados de repetidores (`data`, ver [DADOS.md](DADOS.md)).

É isso que alimenta o contador de usos, "remover não usados" e a reescrita de referências na otimização (`rewriteAssetRefsOps`: `setSrc`, `updateStyles`, `setData` e `setFonts` numa só entrada de undo). Arquivos citados por `dataSource.path` de repetidores também são mantidos.

## HTTP

| Rota                                      | Descrição                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /cdn/:hash.:ext`                     | Arquivo pelo conteúdo. `Cache-Control: public, max-age=31536000, immutable`, a CSP dos assets (`default-src 'none'`, `sandbox`), `nosniff` e `inline` para SVG (abre na aba sem rodar script). 404 para hash inexistente, extensão diferente da registrada ou nome inválido.                                                                                                                    |
| `GET /api/assets/:docId`                  | `{ assets }`: cada arquivo de `assets/` (recursivo, sem ocultos e temporários) com `path`, `name`, `ext`, `kind` (`image`/`font`/`other`), `mime`, `size`, dimensões, `mtime`, `hash`, `cdnUrl`, `uses`, `nodeIds` e `refKinds`. Só lê: `cdnUrl` vem vazio para arquivo ainda não registrado no CDN (upload, link, `get_asset_url` e otimização registram). Documento sem caminho: lista vazia. |
| `POST /api/assets/:docId?name=`           | Upload (corpo binário cru, até 20 MB) → `{ src }`. Já existia.                                                                                                                                                                                                                                                                                                                                  |
| `DELETE /api/assets/:docId?path=&force=1` | Remove um arquivo. 409 se estiver em uso e sem `force`.                                                                                                                                                                                                                                                                                                                                         |
| `POST /api/assets/:docId/remove-unused`   | `{ dryRun? }` → `{ removed, kept }`. Só imagens e fontes sem referência.                                                                                                                                                                                                                                                                                                                        |
| `POST /api/assets/:docId/link`            | `{ path }` → `{ hash, url, cdnPath }`: o link direto ("Copiar link").                                                                                                                                                                                                                                                                                                                           |
| `POST /api/assets/:docId/optimize`        | `{ paths?, maxWidth?, format?, quality? }` → `{ results: [{ path, newPath, before, after }], skipped: [{ path, reason }] }`.                                                                                                                                                                                                                                                                    |
| `GET /api/library?query=`                 | `{ assets }` da biblioteca (`hash`, `ext`, `name`, `mime`, `size`, dimensões, `addedAt`, `tags`, `url`). Busca sem acento por nome e tag.                                                                                                                                                                                                                                                       |
| `POST /api/library?name=`                 | Envia bytes para a biblioteca → o item.                                                                                                                                                                                                                                                                                                                                                         |
| `POST /api/library/:hash/import`          | `{ docId }` → `{ src }`: copia para `assets/` do documento, sem sobrescrever (fontes em `fonts/`).                                                                                                                                                                                                                                                                                              |
| `DELETE /api/library/:hash`               | Remove da biblioteca.                                                                                                                                                                                                                                                                                                                                                                           |

## Otimização (sharp)

`optimize_assets` e a rota `/optimize` usam [sharp](https://sharp.pixelplumbing.com/), dependência **opcional** do `@mockup/server`, carregada com `import()` dinâmico:

- reduz para `maxWidth` sem ampliar; converte para WebP (padrão) ou mantém o formato (`format: 'keep'`), `quality` padrão 82;
- ignora SVG, GIF e imagens animadas;
- grava `nome.webp` (ou `nome-otimizado.<ext>`), sem sobrescrever, e só troca as referências se o resultado ficar menor;
- não apaga os originais: depois use `remove_unused_assets`.

Sem o módulo, a ferramenta responde com erro explicando como instalar (`npm install sharp -w @mockup/server`). O sharp fica fora dos bundles do app desktop e do CLI empacotado (é nativo): em desenvolvimento ele é resolvido pelo `node_modules` do repositório; no app instalado ele vai copiado, com as dependências e o binário da plataforma do build (`@img/sharp-win32-x64`), em `resources/native/node_modules` (`extraResources` do `electron-builder.yml`), onde o server o procura quando o `import()` normal falha (também via `MOCKUP_NATIVE_MODULES`).

## Ajustes de imagem

Tudo em CSS real no nó `img` (core, `image.ts`), o mesmo no canvas, no screenshot e no código exportado:

| Ajuste        | Propriedade       | Valores                                                                                                                                                                                                 |
| ------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Enquadramento | `object-fit`      | `cover`, `contain`, `fill`, `none`, `scale-down`.                                                                                                                                                       |
| Posição       | `object-position` | Presets `center`, `top`, `bottom`, `left`, `right`, `top-left`... ou CSS (`30% 70%`).                                                                                                                   |
| Filtros       | `filter`          | `blur` (px), `brightness`, `contrast`, `saturate` (%; 100 = neutro), `hue-rotate` (deg), `sepia`, `grayscale`, `invert` (%), `opacity` (%). Funções desconhecidas (ex.: `drop-shadow`) são preservadas. |
| Recorte       | `object-view-box` | `inset(t% r% b% l%)` sobre a imagem original. Suportado no Chromium (canvas, render, Electron); outros navegadores ignoram a propriedade e mostram a imagem inteira.                                    |
| Máscara       | `clip-path`       | Formas prontas: `circle`, `ellipse`, `rounded`, `triangle`, `diamond`, `pentagon`, `hexagon`, `star`, `arrow`, ou qualquer `clip-path` CSS.                                                             |

## Placeholders

`generate_placeholder` (e o botão **Gerar** da seção Imagem) cria SVGs localmente, sem rede, **determinísticos pela semente** (`placeholders.ts`, PRNG mulberry32 sobre FNV-1a): `avatar` (pessoa ou iniciais com `label`), `product` (garrafa, caixa ou sacola), `landscape` (céu, sol e montanhas) e `logo` (marca geométrica + nome). Com documento salvo, o arquivo vai para `assets/placeholders/<tipo>-<semente>-<L>x<A>.svg` (reutilizado se o conteúdo for igual); sem caminho, entra como data URL.

## Editor

- **Aba Assets** (painel esquerdo, ao lado de Camadas): grade com miniaturas, busca, filtro "Não usados", contador de usos (clicar seleciona os nós), envio por arrastar ou pelo botão **Enviar**, **Inserir** (no nó selecionado ou no contêiner no centro da tela) e arrastar para o canvas, **Copiar link** (URL `/cdn`), **Remover**, **Remover não usados** (com a lista antes de confirmar), **Otimizar** (WebP, largura máxima opcional) e a seção **Biblioteca** (buscar, importar, enviar e remover).
- **Seção Imagem** (propriedades): trocar imagem, enquadramento, posição (grade 3×3 e campo livre), filtros com sliders (prévia ao vivo e uma entrada de undo ao soltar), máscara, recorte e placeholder.
- **Recorte visual**: botão **Recortar** ou duplo clique na imagem selecionada. A imagem aparece inteira com a área de fora escurecida e um retângulo com 8 alças; arrastar dentro move o recorte. Enter, **Aplicar** ou clicar fora confirmam; Esc cancela. Grava `object-view-box` numa única op. Com `object-fit` diferente de `cover`/`fill`, o cálculo usa `fill` e o painel avisa.

## MCP

Ferramentas em [MCP.md](MCP.md#assets-cdn-e-biblioteca) e [MCP.md](MCP.md#ajustes-de-imagem-e-placeholders); guia `get_guide('assets')`.
