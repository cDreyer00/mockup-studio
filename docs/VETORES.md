# Vetores

Formas, ícones e SVG importados são nós `svg`. O que torna um nó svg editável (pontos, tinta, booleanas) é o campo `Node.vector`.

## Modelo

```ts
interface Vector {
  viewBox: { x; y; width; height };
  paths: VectorPath[]; // id, d, fill, stroke, strokeWidth, opacity, linecap, linejoin, dasharray, fillRule
  raw?: string; // markup original sanitizado
  attrs?: Record<string, string>; // atributos extras do <svg> raiz
}
```

- `node.svg` é sempre o markup renderizado e exportado. Com `node.vector`, `node.svg === vectorToSvg(vector)`.
- **raw x paths**: ao importar um SVG (`insert_svg`, colar markup no editor), o markup sanitizado fica em `raw`, intacto, e os `paths` são extraídos quando o SVG é simples. Enquanto `raw` existe, o markup exibido é o original.
- **Quando é editável**: só com `paths` não vazio. O SVG é "simples" se usa apenas `svg`, `g`, `path`, `rect`, `circle`, `ellipse`, `line`, `polyline`, `polygon` e gradientes linear/radial com `stop`. Filtros, máscaras, `clipPath`, `use`, texto, imagens, `fill-opacity`, opacidade de grupo e marcadores deixam `paths` vazio: o SVG continua sendo exibido e exportado, mas não é editável.
- **Regeneração**: qualquer edição de paths, viewBox ou tinta remove `raw`; o markup passa a ser gerado a partir dos paths (`<svg viewBox width="100%" height="100%">` com um `<path>` por item e gradientes em `<defs>`).
- Nós svg antigos (de `write_html` ou `insert_icon`) não têm `vector`; ele é criado na primeira edição (e `get_svg` infere os paths sem gravar).
- A op `setVector` valida o vetor e atualiza `node.svg`; o desfazer restaura o anterior.

## Formas

`rect`, `ellipse`, `line`, `polygon` (3 a 64 lados) e `star` (3 a 64 pontas, `innerRatio` de 0.05 a 0.95). Cada uma é um path `p1` no viewBox `0 0 w h` (a linha ganha folga de metade do traço para não ser cortada). Tinta padrão: `fill #d9d9d9`; linha `stroke #111111` com 2 de largura.

## Booleanas e achatar

`union`, `subtract` (o nó mais ao fundo menos os de cima), `intersect` e `exclude` (xor), entre 2 ou mais svgs irmãos. As curvas são achatadas em segmentos antes da operação (tolerância 0,25), então o resultado é poligonal. O resultado fica no lugar do primeiro nó, com a tinta do primeiro path dele, e os originais são removidos. `flatten` junta os paths de um nó num só, ou combina vários svgs irmãos num nó que mantém a tinta de cada path.

## Texto em contornos

Converte nós de texto em svg com os glifos como paths (opentype.js; WOFF2 via `woff2-encoder`). A fonte vem primeiro das fontes do documento (`assets/fonts`), depois das fontes instaladas no sistema; fontes variáveis respeitam o peso. O texto deixa de ser editável como texto. O resultado traz notas (fonte usada, quebras de linha, glifos ausentes). Desfazer devolve o texto.

## Ferramentas MCP

`create_shape`, `set_path`, `insert_svg`, `get_svg`, `set_vector_paint`, `boolean_op`, `flatten`, `text_to_outlines` (detalhes em `docs/MCP.md`, seção "Vetores e grid"). Ícones Lucide (`insert_icon`) também aceitam `get_svg` e `set_vector_paint`. Exemplo:

```
create_shape({ parentId: "fr_ab12cd34", shape: "star", x: 40, y: 40, width: 120, height: 120, styles: { fill: "#f5c518" } })
set_vector_paint({ nodeId: "sv_ab12cd34", stroke: "#111111", strokeWidth: 2 })
boolean_op({ nodeIds: ["sv_aaaa1111", "sv_bbbb2222"], op: "subtract" })
```

## Atalhos do editor

| Atalho                  | Ação                                                                         |
| ----------------------- | ---------------------------------------------------------------------------- |
| `P`                     | Caneta: clique para pontos retos, arraste para curvas; Enter/duplo clique conclui |
| `O`                     | Elipse (Shift: círculo)                                                      |
| `L`                     | Linha (Shift: múltiplos de 45°)                                              |
| Polígono (barra de ferramentas) | Polígono; Alt ao soltar cria estrela                                 |
| Duplo clique / `Enter`  | Edita os pontos do vetor selecionado (Esc sai)                               |
| `Ctrl+Shift+O`          | Texto em contornos                                                           |

Booleanas, achatar e texto em contornos também estão no menu do painel de vetor.
