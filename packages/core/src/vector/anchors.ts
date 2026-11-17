/**
 * Modelo de pontos âncora (caneta e edição de pontos): cada âncora tem posição e alças Bézier
 * absolutas opcionais (`in` = alça que chega, `out` = alça que sai).
 */

export interface VectorPoint {
  x: number;
  y: number;
}

export interface PathAnchor {
  x: number;
  y: number;
  /** Alça de entrada (controle do segmento que chega nesta âncora). Ausente = canto. */
  in?: VectorPoint;
  /** Alça de saída (controle do segmento que sai desta âncora). Ausente = canto. */
  out?: VectorPoint;
}

export interface Subpath {
  anchors: PathAnchor[];
  closed: boolean;
}

/**
 * Converte `d` em subpaths de âncoras. Segmentos retos viram âncoras sem alças; C vira alças;
 * Q é elevado a cúbica. Num subpath fechado, o último ponto igual ao primeiro é fundido.
 */
export function pathToSubpaths(d: string): Subpath[] {
  void d;
  throw new Error('não implementado');
}

/**
 * Converte subpaths em `d`: segmento sem alças (out da origem e in do destino ausentes) = L,
 * senão C (alça ausente = o próprio ponto). Fechado termina com o segmento de volta e Z.
 */
export function subpathsToPath(subpaths: Subpath[], precision = 3): string {
  void subpaths;
  void precision;
  throw new Error('não implementado');
}
