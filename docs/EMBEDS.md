# Vídeo, embeds e Three.js

Três tipos de nó de mídia além dos efeitos ([EFEITOS.md](EFEITOS.md)): `video` (arquivo ou URL de vídeo), `embed` (Lottie, Rive, YouTube, iframe e Three.js) e `effect`. Os esquemas estão em `packages/core/src/media.ts`.

## Nó `video`

`node.video`:

| Campo      | Tipo     | Descrição                                                                                             |
| ---------- | -------- | ----------------------------------------------------------------------------------------------------- |
| `src`      | string   | Caminho relativo a `assets/` (ex.: `videos/demo.mp4`) ou URL http(s). Obrigatório.                    |
| `poster`   | string   | Imagem de capa: caminho em `assets/`, URL http(s) ou data URL de imagem (PNG, JPEG, GIF, WebP, AVIF). |
| `autoplay` | booleano | Toca sozinho.                                                                                         |
| `loop`     | booleano | Repete.                                                                                               |
| `muted`    | booleano | Sem som.                                                                                              |
| `controls` | booleano | Mostra os controles do player.                                                                        |
| `time`     | número   | Instante inicial em segundos (a partir de 0), usado na captura quando nenhum `time` é pedido.         |

Padrões ao inserir (MCP): `muted`, `loop` e `autoplay` ligados, `controls` desligado, `640px` x `360px` com `object-fit: cover`. Navegadores só tocam sozinho se estiver mudo. No export, o nó vira `<video>` com `playsinline`.

### Inserir

- **MCP**: `insert_video(parentId, source, poster?, autoplay?, loop?, muted?, controls?, styles?, name?, index?)`.
  - `source` local: caminho **absoluto** de mp4, m4v, mov, webm ou ogg. O tipo é validado pelos primeiros bytes (não pela extensão) e o arquivo é **copiado** para `assets/videos/` com nome seguro, sem sobrescrever (`-1`, `-2`...). Ogg é gravado como `.ogv`. Limite de **500 MB**.
  - `source` em URL http(s): referenciada direto, sem baixar; só toca com rede.
  - Documento sem caminho em disco não tem `assets/`: só aceita URL (salve o documento antes).
  - `poster`: caminho, URL ou data URL; vai para `assets/`. Sem pasta de assets, só cabe como data URL de até 2 MB.
- **Editor**: menu Mídia (ícone de claquete) > "Inserir vídeo...". O seletor aceita `.mp4`, `.webm`, `.mov` e `.m4v`; o arquivo é enviado ao daemon (`assets/videos/`) e o nó nasce `640x360` no centro da tela, dentro do contêiner sob ele (ou num frame novo, se não houver). Uma URL de vídeo colada em "Embed por URL..." também cria um nó `video`.
- Para mudar opções depois: `update_media(nodeId, autoplay?, loop?, muted?, controls?, poster?, time?)`. `poster: ""` remove. Não troca o arquivo: insira outro vídeo.

### Poster e screenshot

A página de render tem uma regra para o poster:

- `get_screenshot` **sem** `time` e vídeo **com** `poster`: mostra o poster e não baixa o vídeo.
- `get_screenshot` **com** `time` (inclusive `0`): descarta o poster, posiciona o vídeo naquele instante (com `loop`, em `t` módulo a duração; sem `loop`, limitado ao fim) e espera o quadro ficar pronto.
- Vídeo sem poster: sem `time`, usa `video.time` (ou 0).

O export animado (mp4/webm/gif) sempre passa `time`, então mostra os quadros do vídeo, não o poster.

## Nó `embed`

`node.embed`: `provider` (`lottie`, `rive`, `youtube`, `three` ou `iframe`) mais:

| Provedor  | Campos exigidos | Observação                                                                                                                                                                     |
| --------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `lottie`  | `src`           | Arquivo em `assets/lottie/` ou URL http(s).                                                                                                                                    |
| `rive`    | `src`           | Arquivo em `assets/rive/` ou URL http(s).                                                                                                                                      |
| `youtube` | `url`           | URL de vídeo do YouTube (`watch?v=`, `youtu.be/`, `/embed/`, `/shorts/`, `/live/`, `/v/`, de `youtube.com`, `m.`, `music.` ou `youtube-nocookie.com`). O id tem 11 caracteres. |
| `iframe`  | `url`           | Qualquer URL http(s).                                                                                                                                                          |
| `three`   | `code`          | Corpo de função (até 200.000 caracteres). Veja a seção Three.js.                                                                                                               |

`params` (opcional): até 64 pares; nome `[a-zA-Z][a-zA-Z0-9_]{0,39}`; valor número, booleano ou texto de até 300 caracteres sem `< > { } ; " \`` nem `\`. Os que têm efeito:

| Provedor  | `params`                                                                                                     |
| --------- | ------------------------------------------------------------------------------------------------------------ |
| `youtube` | `start` (s; o `?t=` da URL vence), `autoplay`, `loop`, `muted` (padrão `false`), `controls` (padrão `true`). |
| `lottie`  | `autoplay`, `loop` (padrão `true`).                                                                          |
| `rive`    | `autoplay` (padrão `true`), `artboard` e `stateMachine` (texto).                                             |
| `three`   | Qualquer um; chegam ao código em `params`.                                                                   |

### Detecção por URL

`detectEmbedProvider` (usada pelo MCP e pelo diálogo do editor) decide pela URL ou caminho:

1. URL http(s) de YouTube com id válido: `youtube`.
2. Termina em `.json` ou `.lottie` (ignorando `?` e `#`), ou contém `lottiefiles.com`: `lottie`.
3. Termina em `.riv`: `rive`.
4. Termina em `.mp4`, `.webm`, `.mov`, `.m4v` ou `.ogv`: vídeo (use `insert_video`; o editor cria um nó `video`).
5. Qualquer outra URL http(s): `iframe`.
6. Caso contrário: não reconhecida. No MCP, `provider` força o provedor.

O YouTube usa `?t=` ou `?start=` (`90`, `1m30s`, `1h2m3s`) como início.

### Inserir

- **MCP**: `insert_embed(parentId, url?, provider?, src?, params?, styles?, name?, index?)`. `url` pode ser URL ou caminho absoluto de `.json`/`.lottie`/`.riv`; `src` é a alternativa para Lottie/Rive. Tamanhos padrão: `480x320` (YouTube: `560x315`).
  - **Lottie e Rive** são validados e **copiados** (de caminho ou baixados de URL, timeout de 20 s) para `assets/lottie/` ou `assets/rive/`. JSON Lottie precisa de `v`, `fr` e `layers`; `.lottie` é um zip; arquivo Rive começa com `RIVE`. Limite de **50 MB**. Uma referência já relativa (`lottie/loader.json`) é aceita se o arquivo existir em `assets/`.
  - **YouTube e iframe** guardam só a URL.
  - Para Three.js use `insert_three`; `insert_embed` com `provider: 'three'` é recusado.
- **Editor** (menu Mídia): "Inserir Lottie/Rive de arquivo..." (`.json`, `.lottie`, `.riv`; vai para `assets/` pelo upload do daemon; `400x400`); "Embed por URL..." (mostra o provedor detectado ao digitar; YouTube e iframe nascem `640x360`); "Ilha Three.js" (`480x320`, já abre o editor de código). Uma URL de Lottie/Rive colada no diálogo é **referenciada**, não copiada: precisa de rede.
- `update_media(nodeId, url?, src?, code?, params?)`: `params` são mesclados nos atuais; `src` (só Lottie/Rive) é importado do mesmo jeito que na inserção.

### Onde ficam os arquivos

Dentro de `assets/`, ao lado do `*.mockup.json`:

| Pasta            | Conteúdo                              | Limite |
| ---------------- | ------------------------------------- | ------ |
| `assets/videos/` | Vídeos (mp4, m4v, mov, webm, ogv)     | 500 MB |
| `assets/lottie/` | Animações Lottie (`.json`, `.lottie`) | 50 MB  |
| `assets/rive/`   | Animações Rive (`.riv`)               | 50 MB  |
| `assets/`        | Posters e outras imagens              | 20 MB  |

Os limites valem também para o upload do editor ao daemon (por extensão). O `export` html/tailwind/react copia para a pasta de saída os arquivos de `assets/` que o nó usa, incluindo vídeo, poster, Lottie e Rive.

## Ilha Three.js

Uma ilha é um embed `three` cujo `code` é o **corpo de uma função**. O host cria o `WebGLRenderer` (com `alpha: true` e `antialias: true`, então o fundo é transparente) e chama o código com estas variáveis:

| Variável   | O que é                                       |
| ---------- | --------------------------------------------- |
| `THREE`    | A biblioteca Three.js.                        |
| `renderer` | O `WebGLRenderer` já criado.                  |
| `canvas`   | O `<canvas>` do nó.                           |
| `width`    | Largura do nó em px.                          |
| `height`   | Altura do nó em px.                           |
| `params`   | Os `params` do nó (objeto; pode estar vazio). |

O código **devolve** `{ scene, camera, update(t) }`: `scene` e `camera` são obrigatórios para desenhar; `update` é opcional e recebe `t` em **segundos**. A cada quadro o host chama `update(t)` e depois `renderer.render(scene, camera)`; não chame `render` nem crie o renderer. Câmeras em perspectiva têm `aspect` atualizado quando o nó é redimensionado.

Código padrão (`insert_three` sem `code`, ou o menu do editor): um nó de toro (`TorusKnotGeometry`) metálico girando, com luz ambiente e direcional e a cor vinda de `params.color` (padrão `#7c5cff`):

```js
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100);
camera.position.set(0, 0, 6);
const mesh = new THREE.Mesh(
  new THREE.TorusKnotGeometry(1.2, 0.38, 220, 32),
  new THREE.MeshStandardMaterial({
    color: params.color ?? '#7c5cff',
    metalness: 0.6,
    roughness: 0.25,
  }),
);
scene.add(mesh);
scene.add(new THREE.AmbientLight(0xffffff, 0.4));
const light = new THREE.DirectionalLight(0xffffff, 2.2);
light.position.set(3, 4, 5);
scene.add(light);
return {
  scene,
  camera,
  update(t) {
    mesh.rotation.x = t * 0.4;
    mesh.rotation.y = t * 0.6;
  },
};
```

Escreva `update` como função **pura do tempo** (posição = f(t), sem acumular estado entre quadros): o screenshot com `time` e o export mp4/webm/gif chamam `update(t)` em instantes escolhidos, não em sequência contínua.

MCP: `insert_three(parentId, code?, params?, styles?, name?, index?)` (código até 200.000 caracteres). Mudar depois: `update_media(nodeId, code?, params?)`.

### Sandbox no editor

No editor e na página de render o código roda dentro de um `<iframe sandbox="allow-scripts" srcdoc>` **sem** `allow-same-origin`: a origem do iframe é opaca, então o código não toca no documento do editor, em cookies, no `localStorage` nem no daemon, e só se comunica com a página por `postMessage` (`init`, `time`, `play`, `resize` do pai; `ready`, `error`, `drawn` do filho; cada lado confere `event.source`). A biblioteca vem do próprio daemon (`/vendor/three.iife.js`), sem CDN, então funciona offline. Erros do código ou do WebGL aparecem numa faixa vermelha sobre o nó.

O sandbox isola a origem; ele **não** instala uma política de conteúdo que bloqueie a rede, então não confie nele para impedir que um código de terceiros tente enviar dados. Revise o código antes de usar um que você não escreveu.

### Editor de código

O menu Mídia > "Ilha Three.js" insere a ilha e abre o diálogo "Ilha Three.js". Hoje o diálogo só abre nesse momento; para editar o código de uma ilha existente use `update_media(nodeId, code)` pelo MCP. Ele tem o código no **CodeMirror** (JavaScript, tema escuro, numeração e demais recursos do `basicSetup`) à esquerda e uma **prévia ao vivo** à direita, que se atualiza 600 ms depois da última tecla. **Ctrl+Enter** (ou Aplicar) grava o código no nó (um passo de desfazer, e nada acontece se o código não mudou); **Esc** (ou Fechar) descarta. Se o nó some (desfazer, exclusão remota), o diálogo fecha.

## Offline

| Tipo                          | Editor e render                                                                                                                                          | Código exportado                                                                    |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Efeitos                       | Funciona offline.                                                                                                                                        | Funciona offline (runtime embutido no arquivo).                                     |
| Vídeo local                   | Funciona offline.                                                                                                                                        | Funciona offline (arquivo copiado para `assets/`).                                  |
| Lottie e Rive locais          | Funcionam offline (`lottie-web` e o wasm do Rive saem do pacote, nunca de CDN).                                                                          | Carregam a biblioteca de **CDN** (tabela abaixo); o arquivo `.json`/`.riv` é local. |
| Three.js                      | Funciona offline (biblioteca servida pelo daemon).                                                                                                       | Carrega o Three.js de **CDN** no HTML; no React, importa o pacote `three`.          |
| YouTube                       | O editor mostra o player e **precisa de rede**; o render mostra a miniatura (`i.ytimg.com`) com botão de play e, sem rede, um quadro "YouTube" após 5 s. | Precisa de rede.                                                                    |
| iframe                        | **Precisa de rede** (o render espera o carregamento por até 5 s).                                                                                        | Precisa de rede.                                                                    |
| Vídeo, Lottie ou Rive por URL | Precisam de rede.                                                                                                                                        | Precisam de rede.                                                                   |

Bibliotecas de CDN no HTML e no Tailwind exportados (constantes em `packages/core/src/export/media.ts`):

| Uso      | URL                                                                          |
| -------- | ---------------------------------------------------------------------------- |
| Lottie   | `https://cdn.jsdelivr.net/npm/lottie-web@5/build/player/lottie_light.min.js` |
| Rive     | `https://unpkg.com/@rive-app/canvas@2`                                       |
| Three.js | `https://cdn.jsdelivr.net/npm/three@0.187/build/three.module.js` (módulo ES) |

Só entram os scripts dos recursos que o documento usa. O Lottie é montado com o renderer SVG. Quando o `export` (MCP) consegue ler o arquivo de `assets/` e ele é um `.json` de até **512 KB**, o JSON vai **embutido** no HTML (`<script type="application/json">` com `<`, U+2028 e U+2029 escapados) e o HTML abre direto por `file://`. Nos demais casos (JSON acima de 512 KB, `.lottie`, qualquer Rive `.riv`, ou HTML gerado sem acesso a `assets/`, como `get_html`) o runtime lê o arquivo por `data-src`, e navegadores bloqueiam essa leitura a partir de `file://` (CORS): sirva a pasta de saída por um servidor HTTP, por exemplo `npx serve`. No HTML exportado, o código do Three.js roda direto na página, **sem** o sandbox do editor, e anima com o relógio real (`performance.now`).

## Exportação

- **html e tailwind**: vídeo vira `<video>` (com `poster`, se houver, e `playsinline`); YouTube vira `<iframe>` em `youtube-nocookie.com/embed/<id>` com `allow="autoplay; encrypted-media; picture-in-picture"`, `allowfullscreen` e `loading="lazy"`; iframe vira `<iframe sandbox="allow-scripts allow-same-origin allow-popups" loading="lazy">`; Lottie, Rive e Three.js viram `div`/`canvas` com `data-mockup-embed` e os scripts de CDN acima. Valores com caracteres perigosos são descartados ou escapados (`</script>` dentro do código Three.js vira `<\/script>`).
- **svg**: embeds viram placeholders (vídeo mostra o poster ou um retângulo escuro; embed mostra o nome do provedor), sem scripts.
- **react**: vídeo vira `<video ... autoPlay loop muted playsInline />`; YouTube e iframe viram `<iframe>` com as mesmas props do HTML (`allowFullScreen`, `sandbox`). Lottie vira `<MockupLottie src=... />` (usa o pacote `lottie-web`), Rive vira `<MockupRive src=... artboard=... stateMachine=... />` (usa `@rive-app/canvas`). Esses componentes ficam embutidos no `.tsx`. Cada ilha Three.js gera `<slug>-three-<n>.js` + `.d.ts` ao lado do `.tsx` (com `import * as THREE from 'three'`) e vira `<ThreeIsland setup={setupThreeN} params={...} />`. O projeto precisa instalar `lottie-web`, `@rive-app/canvas` e `three` conforme o que usar. Os caminhos `assets/...` são relativos à página: num projeto Vite, ponha a pasta em `public/` ou use `assetsBase: '/assets/'`.
- **Animado (mp4, webm, gif)**: renderiza o nó com o relógio manual, então vídeo, Lottie, Rive e Three.js entram quadro a quadro. YouTube e iframe aparecem como no render (miniatura ou conteúdo carregado no momento). Detalhes em [EFEITOS.md](EFEITOS.md#export-animado-mp4-webm-e-gif).

Formatos de código em [EXPORT.md](EXPORT.md); ferramentas em [MCP.md](MCP.md).
