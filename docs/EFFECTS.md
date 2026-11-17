# Efeitos

Efeitos são fundos e blocos animados desenhados em `<canvas>`: sete efeitos prontos (seis shaders WebGL e um de partículas), cada um com parâmetros e presets. Vídeo, Lottie, Rive, YouTube, iframe e Three.js estão em [EMBEDS.md](EMBEDS.md).

Os shaders são **GLSL próprios** do projeto (fragment shaders GLSL ES 1.0, WebGL 1), escritos em `packages/core/src/effects/shaders.ts`; não há biblioteca de terceiros. As partículas são canvas 2D. O catálogo (`packages/core/src/effects/catalog.ts`) é a fonte única para o editor, a página de render, o MCP (`list_effects`) e os exportadores.

Um efeito é um nó `type: 'effect'` com `effect: { kind, params }`:

```json
{ "kind": "mesh-gradient", "params": { "color1": "#0d1b4c", "speed": 0.5 } }
```

- `params` guarda só o que foi alterado; o que falta usa o padrão do catálogo.
- Números fora da faixa são limitados a `min`/`max` ao resolver; pelo MCP, valores fora da faixa, de tipo errado ou de parâmetro inexistente são **recusados** com a lista de problemas.
- Cores aceitas: `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()`, `rgba()` e `transparent`.
- No shader, cada parâmetro vira o uniform `u_<nome>` (cores em `vec4`, `select` como o índice da opção), mais `u_resolution` e `u_time` (já multiplicado por `speed`).

## Catálogo

Todos os efeitos aceitam `speed` (número, 0 a 4, passo 0,05, padrão 1; 0 deixa o efeito estático), exceto onde indicado.

| `kind`          | Categoria   | O que faz                                                                         |
| --------------- | ----------- | --------------------------------------------------------------------------------- |
| `mesh-gradient` | `shader`    | Degradê de quatro cores com manchas suaves deformadas por ruído, torção e grão.   |
| `grain`         | `shader`    | Ruído de filme animado sobre um degradê de duas cores.                            |
| `halftone`      | `shader`    | Pontos, quadrados ou linhas de meio-tom que variam de tamanho sobre um gradiente. |
| `waves`         | `shader`    | Linhas fluidas onduladas com degradê entre duas cores sobre fundo sólido.         |
| `liquid-metal`  | `shader`    | Metal líquido cromado com reflexos procedurais em movimento.                      |
| `glass`         | `shader`    | Vidro canelado refrativo sobre um degradê em movimento, com desfoque e reflexos.  |
| `particles`     | `particles` | Partículas em canvas 2D, determinísticas: posição é função de (seed, índice, t).  |

### Parâmetros e presets

Formato: `nome` tipo, padrão, faixa. Cores não têm faixa.

**`mesh-gradient`**

| Parâmetro    | Tipo   | Padrão    | Faixa |
| ------------ | ------ | --------- | ----- |
| `color1`     | cor    | `#0d1b4c` |       |
| `color2`     | cor    | `#00c2a8` |       |
| `color3`     | cor    | `#7b2ff7` |       |
| `color4`     | cor    | `#12d8fa` |       |
| `speed`      | número | 1         | 0 a 4 |
| `distortion` | número | 0,5       | 0 a 1 |
| `swirl`      | número | 0,3       | 0 a 1 |
| `grain`      | número | 0,15      | 0 a 1 |

Presets: `aurora`, `sunset`, `ocean`, `candy`.

**`grain`**

| Parâmetro   | Tipo   | Padrão    | Faixa   |
| ----------- | ------ | --------- | ------- |
| `color1`    | cor    | `#1b1b1f` |         |
| `color2`    | cor    | `#4a4a55` |         |
| `intensity` | número | 0,55      | 0 a 1   |
| `size`      | número | 1,5       | 0,5 a 6 |
| `speed`     | número | 1         | 0 a 4   |

Presets: `film`, `warm`, `cool`, `paper`. `size` é em px a 720 de altura.

**`halftone`**

| Parâmetro    | Tipo   | Padrão                                | Faixa  |
| ------------ | ------ | ------------------------------------- | ------ |
| `color`      | cor    | `#111111`                             |        |
| `background` | cor    | `#f4efe6`                             |        |
| `dotSize`    | número | 22                                    | 6 a 60 |
| `angle`      | número | 45                                    | 0 a 90 |
| `speed`      | número | 1                                     | 0 a 4  |
| `shape`      | select | `circle` (`circle`, `square`, `line`) |        |

Presets: `ink`, `pop`, `blueprint`, `scanlines`. `dotSize` é o lado da célula em px a 720 de altura; `angle` é em graus.

**`waves`**

| Parâmetro    | Tipo   | Padrão    | Faixa    |
| ------------ | ------ | --------- | -------- |
| `color1`     | cor    | `#22d3ee` |          |
| `color2`     | cor    | `#e879f9` |          |
| `background` | cor    | `#07070f` |          |
| `frequency`  | número | 4         | 0,5 a 12 |
| `amplitude`  | número | 1         | 0 a 2    |
| `lines`      | número | 14        | 1 a 40   |
| `speed`      | número | 1         | 0 a 4    |

Presets: `neon`, `silk`, `deep`, `mint`.

**`liquid-metal`**

| Parâmetro   | Tipo   | Padrão    | Faixa   |
| ----------- | ------ | --------- | ------- |
| `tint`      | cor    | `#c9ced8` |         |
| `highlight` | cor    | `#ffffff` |         |
| `contrast`  | número | 1,4       | 0,5 a 3 |
| `speed`     | número | 1         | 0 a 4   |
| `scale`     | número | 1         | 0,3 a 3 |

Presets: `chrome`, `gold`, `rose`, `obsidian`.

**`glass`**

| Parâmetro    | Tipo   | Padrão    | Faixa  |
| ------------ | ------ | --------- | ------ |
| `color1`     | cor    | `#6d5dfc` |        |
| `color2`     | cor    | `#ff8ab3` |        |
| `ribs`       | número | 24        | 4 a 80 |
| `refraction` | número | 1         | 0 a 2  |
| `blur`       | número | 0,25      | 0 a 1  |
| `speed`      | número | 1         | 0 a 4  |

Presets: `prism`, `dusk`, `lime`, `frost`.

**`particles`**

| Parâmetro    | Tipo     | Padrão                                         | Faixa     |
| ------------ | -------- | ---------------------------------------------- | --------- |
| `count`      | número   | 120                                            | 10 a 2000 |
| `color`      | cor      | `#ffffff`                                      |           |
| `background` | cor      | `#0b1020` (`transparent` deixa o canvas vazio) |           |
| `size`       | número   | 2,5 (raio médio em px)                         | 0,5 a 12  |
| `speed`      | número   | 1                                              | 0 a 4     |
| `direction`  | select   | `up` (`up`, `down`, `left`, `right`, `random`) |           |
| `twinkle`    | número   | 0,5                                            | 0 a 1     |
| `links`      | booleano | `false` (linhas entre partículas vizinhas)     |           |
| `seed`       | número   | 1 (mesma semente, mesmo desenho)               | 0 a 9999  |

Presets: `stars`, `snow`, `embers`, `network`, `fireflies` (este com fundo `transparent`).

Aplicar um preset define só os parâmetros que ele lista; os demais ficam nos padrões do efeito.

## No editor

- **Botão Efeitos** (ícone de brilho) na barra: abre uma galeria agrupada em Shaders e Partículas, com uma miniatura por preset (desenhada pelo próprio runtime). Clique insere o efeito como **fundo** do frame selecionado (ou do contêiner selecionado; sem seleção, do primeiro frame da página). Alt+clique ou botão direito insere como **camada** (filho comum).
- Como fundo, o efeito vira o primeiro filho, com `position: absolute; inset: 0; width/height: 100%; z-index: -1; pointer-events: none`, e o pai ganha `position: relative` e `isolation: isolate` na mesma operação (um desfazer reverte tudo). Alvo travado ou sem frame mostra um aviso.
- **Seção Efeito** nas propriedades de um nó de efeito: tipo, chips de preset (o preset ativo fica marcado), um controle por parâmetro (slider com campo numérico para números, seletor de cor, caixa para booleanos, lista para `select`) e "Restaurar padrões". Trocar o tipo descarta os parâmetros antigos. Arrastar um slider só envia a alteração ao soltar, então um arrasto é um passo de desfazer. Com vários efeitos do mesmo `kind` selecionados, a edição vale para todos.
- **Pausa e play**: o botão de play/pausa da barra (ou **Shift+Espaço**) congela e retoma todas as animações do canvas (efeitos, partículas, vídeo, Lottie, Rive e Three.js), continuando de onde parou. Espaço sozinho continua sendo o pan.
- Se o WebGL não estiver disponível ou o shader não compilar, o efeito mostra um fundo CSS aproximado (o mesmo usado nos exports estáticos) e um aviso no canto.

## Via MCP

`get_guide('effects')` traz um resumo para o agente (veja [MCP.md](MCP.md)). Ferramentas:

| Ferramenta      | Parâmetros                                                                                                               | Descrição                                                                                                                                                                                                               |
| --------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_effects`  | nenhum                                                                                                                   | Efeitos com categoria, descrição, parâmetros (`nome:tipo faixa=padrão`) e presets.                                                                                                                                      |
| `add_effect`    | `nodeId`, `kind` (obrig.), `params`, `preset`, `placement` (`background` \| `child`), `name`, `styles`, `index`, `docId` | Cria o efeito. `background` (padrão) o põe como primeiro filho de `nodeId`; `child` insere um filho comum (padrão `100%` x `240px`, aceita `index`). `nodeId` deve ser um contêiner (não texto, imagem, svg nem mídia). |
| `update_effect` | `nodeId` (obrig.), `params`, `kind`, `preset`, `reset`, `docId`                                                          | Mescla `params` nos atuais; `preset` é aplicado antes dos `params`; `kind` troca o efeito (parâmetros antigos descartados); `reset: true` volta aos padrões antes de aplicar preset e params.                           |

Os `params` do `add_effect` são mesclados sobre o preset (`{ ...preset, ...params }`). Preset inexistente, parâmetro desconhecido, tipo errado ou valor fora da faixa devolvem `isError` listando os problemas e os efeitos válidos.

Fundo animado para um frame inteiro:

```json
{
  "name": "add_effect",
  "arguments": {
    "nodeId": "fr_ab12cd34",
    "kind": "mesh-gradient",
    "preset": "aurora",
    "params": { "speed": 0.5 }
  }
}
```

Ajustar depois (o id do efeito vem na resposta de `add_effect` ou de `get_tree_summary`):

```json
{
  "name": "update_effect",
  "arguments": { "nodeId": "ef_ab12cd34", "params": { "speed": 1.2, "grain": 0.3 } }
}
```

Trocar de efeito:

```json
{
  "name": "update_effect",
  "arguments": { "nodeId": "ef_ab12cd34", "kind": "particles", "preset": "stars" }
}
```

Conferir o resultado em dois instantes:

```json
{ "name": "get_screenshot", "arguments": { "nodeId": "fr_ab12cd34", "time": 0 } }
{ "name": "get_screenshot", "arguments": { "nodeId": "fr_ab12cd34", "time": 2 } }
```

`time` (segundos, a partir de 0) renderiza o quadro de **todas** as animações naquele instante: efeitos, partículas, Lottie, Rive, Three.js e vídeo. Sem `time`, o render usa 0; a única diferença é o vídeo com `poster`, que mostra o poster quando `time` não é informado (veja [EMBEDS.md](EMBEDS.md)).

## Como o render captura

As animações do editor correm em tempo real; a página de render (screenshot e export) usa um **relógio manual** para o resultado ser determinístico:

1. `get_screenshot` com `time: t` chama `__mockupRender.render({ ..., time: t })`. A página fixa o relógio das animações em `t` (sem `time`, em 0) em vez de deixar o tempo correr.
2. Cada componente de mídia registra uma pendência quando começa a carregar ou quando o tempo muda, e a libera depois de desenhar aquele instante. A página **espera todas as pendências** (limite de 10 s no total; cada pendência se libera sozinha em 15 s no máximo, para um componente com falha não travar a captura), mais dois `requestAnimationFrame`, e só então mede e captura.
3. Para quadros em sequência, o motor chama `setTime(t)`, espera do mesmo modo e tira a captura de cada quadro. A cache de screenshots inclui `time` na chave.

O WebGL dos shaders precisa estar disponível na janela de render. No app desktop, se não houver GPU o Chromium cai no **SwiftShader** (WebGL por software, flag `enable-unsafe-swiftshader`); `MOCKUP_RENDER_GL=swiftshader` força o software, útil em VM ou CI (veja `packages/desktop/README.md`). Software é mais lento, mas gera o mesmo desenho.

## Exportação

O `kind` e os parâmetros resolvidos de cada efeito vão para o código exportado.

| Formato     | Efeito                                                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------------------------------------- |
| `html`      | `<canvas data-mockup-effect='{...}'>` com fundo CSS de fallback e um `<script>` que embute o runtime e os shaders usados. |
| `tailwind`  | Igual ao `html`, com as classes Tailwind.                                                                                 |
| `svg`       | Sem JavaScript: o efeito vira o gradiente/cor de fallback do catálogo (`effectFallbackCss`).                              |
| `react`     | Opção `effects`: `live` (padrão) ou `static`. Veja abaixo.                                                                |
| `png`/`jpg` | Captura do render (relógio em `time` 0, ou o `time` do screenshot).                                                       |

- **Runtime**: o mesmo código roda no editor e no export. Respeita `prefers-reduced-motion: reduce` (desenha só o quadro 0), acompanha o tamanho do canvas com `ResizeObserver` e, se o WebGL falhar, o fundo CSS de fallback continua visível.
- **React `effects: 'live'`** (padrão): cada efeito vira `<MockupEffect spec={...} />`, um componente embutido no `.tsx` que monta um `<canvas>` e chama `playEffect(canvas, spec)` (devolve `{ stop() }`, chamado no cleanup do `useEffect`). A `spec` fica numa constante tipada (`EffectMount`) no topo do arquivo. O runtime vai em `mockup-effects.js` + `mockup-effects.d.ts`, ao lado do `.tsx`, com os shaders de todo o catálogo, então o mesmo arquivo serve a todos os componentes exportados na pasta. O fundo CSS de fallback continua na `className`/`style` do canvas.
- **React `effects: 'static'`**: grava um PNG de cada nó de efeito (capturado em `time: 0`) em `assets/effects/<id-do-efeito>.png`, e o efeito vira `<img src="assets/effects/<id>.png" alt="">`, sem runtime. Exige o motor de render. Só no `export`: o `get_code` sempre devolve a versão `live` e cita `mockup-effects.js` sem colar o runtime.
- O fallback CSS também serve quando o HTML é aberto sem JavaScript.

### Export animado: mp4, webm e gif

`export` renderiza os quadros (a partir de `start`, um a cada `1/fps` s), envia os PNGs ao ffmpeg e grava `<slug-do-nó>.mp4`, `.webm` ou `.gif` em `outputDir` (padrão: `<pasta do documento>/exports/`).

```json
{
  "name": "export",
  "arguments": {
    "nodeIds": ["fr_ab12cd34"],
    "format": "mp4",
    "fps": 30,
    "duration": 3,
    "maxWidth": 1280
  }
}
```

| Parâmetro  | Valor                                                                                              |
| ---------- | -------------------------------------------------------------------------------------------------- |
| `format`   | `mp4`, `webm` ou `gif`.                                                                            |
| `fps`      | Inteiro de 1 a 60. Padrão 30; no `gif` padrão 15 e máximo 30 (valores maiores são reduzidos a 30). |
| `duration` | Segundos, maior que 0 e até 30. Padrão 3.                                                          |
| `start`    | Instante inicial das animações, em segundos. Padrão 0.                                             |
| `scale`    | 1 (padrão), 2 ou 3.                                                                                |
| `maxWidth` | Largura máxima em px (mínimo 16); reduz mantendo a proporção. Use no `gif` para arquivos menores.  |

- O total de quadros é `duration x fps`, com teto de **1800** quadros.
- **mp4**: H.264 (`libx264`, `yuv420p`, `+faststart`), largura e altura ajustadas para números pares. É o mais compatível.
- **webm**: VP9 (`libvpx-vp9`, `crf 34`), em geral menor que o mp4.
- **gif**: paleta gerada por `palettegen`/`paletteuse`, em loop infinito. Bom para README; reduza com `maxWidth` e `fps`.
- Não há som; o resultado é só o que o canvas mostra.
- Exige o motor de render com captura de quadros (app desktop atualizado) e o **ffmpeg**, localizado nesta ordem: variável de ambiente `MOCKUP_FFMPEG` (caminho do executável), pacote `ffmpeg-static` e `ffmpeg` no `PATH`. No app empacotado o binário vai em `resources/ffmpeg/` e `MOCKUP_FFMPEG` aponta para ele. Sem ffmpeg o erro explica como instalar. Se a codificação falha, o arquivo parcial é apagado.
- A resposta informa quadros, fps, duração e tamanho do arquivo. Os assets não são copiados nos formatos animados.

Mais sobre os formatos de código em [EXPORT.md](EXPORT.md).
