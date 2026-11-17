/** Guia `effects`: efeitos visuais, vídeo, embeds, Three.js e export animado. */
export const EFFECTS_GUIDE = `# Efeitos, vídeo, embeds e export animado

## Efeitos como fundo
- \`list_effects()\` mostra os efeitos (shaders WebGL e partículas), parâmetros e presets.
- \`add_effect(nodeId, kind, preset?, params?)\` cria o efeito como PRIMEIRO filho do contêiner (\`placement: 'background'\`, padrão), cobrindo-o atrás do conteúdo. O pai ganha \`position: relative\` e \`isolation: isolate\` no mesmo passo (um \`undo\` desfaz tudo).
- Ex.: \`add_effect('fr_ab12cd34', 'mesh-gradient', preset: 'aurora')\` dá um fundo animado ao frame inteiro; o conteúdo existente continua por cima.
- \`placement: 'child'\` insere um filho comum (padrão 100% x 240px) para usar como bloco decorativo.
- \`update_effect(nodeId, params?, preset?, kind?, reset?)\` mescla parâmetros; \`kind\` troca o efeito.
- Parâmetros inválidos voltam com a lista de problemas: confira \`list_effects\`.

## Conferir o resultado
- \`get_screenshot(nodeId, time)\` renderiza o quadro das animações no instante \`time\` (s): efeitos, partículas, Lottie, Rive, Three.js e vídeo. Compare \`time: 0\` e \`time: 2\`.
- Vídeo com \`poster\` mostra o poster no screenshot quando \`time\` não é informado.

## Vídeo
- \`insert_video(parentId, source, poster?)\`: \`source\` é um caminho absoluto (mp4, m4v, mov, webm, ogv; até 500 MB; copiado para \`assets/videos/\`) ou uma URL http(s) (referenciada direto; só toca com rede). Documento sem caminho em disco só aceita URL.
- Padrões: mudo, em loop, autoplay, sem controles, 640x360 com \`object-fit: cover\`. \`update_media\` altera as opções.

## Embeds
- \`insert_embed(parentId, url)\` detecta o provedor: YouTube (usa o \`?t=\` como início), \`.json\`/\`.lottie\` (Lottie), \`.riv\` (Rive) e qualquer outra URL (iframe).
- Offline: Lottie e Rive são copiados para \`assets/lottie/\` e \`assets/rive/\` e funcionam sem rede. YouTube e iframe PRECISAM de rede.
- \`update_media\` troca url, src, code ou parâmetros de um embed.

## Ilha Three.js
- \`insert_three(parentId, code?, params?)\`. O código é o corpo de uma função com \`THREE, renderer, canvas, width, height, params\` e devolve \`{ scene, camera, update(t) }\` (t em segundos). Sem \`code\`, usa um nó de toro giratório.
- Roda isolada num iframe sandbox, sem acesso ao documento (o sandbox não bloqueia a rede). Parâmetros chegam em \`params\`.

## Export animado
- \`export(nodeIds, format: 'mp4' | 'webm' | 'gif', fps?, duration?, start?, maxWidth?, scale?)\`: renderiza os quadros e codifica com ffmpeg. Padrões: 30 fps (gif 15, máximo 30), 3 s, \`start\` 0; duração até 30 s. Exige render e ffmpeg (\`MOCKUP_FFMPEG\` ou o ffmpeg embutido).
- mp4 é o mais compatível, webm é menor, gif serve para README (use \`maxWidth\` para reduzir).
- \`export(format: 'react', effects: 'live' | 'static')\`: com \`live\` (padrão) o componente recria os efeitos animados; com \`static\` grava um PNG de cada efeito em \`assets/effects/\` (exige render).
`;
