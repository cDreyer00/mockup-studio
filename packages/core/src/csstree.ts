/**
 * css-tree pelo bundle pré-montado (`dist/csstree.esm.js`): o mesmo arquivo roda no navegador, no
 * Node e dentro dos bundles do Electron e do CLI. O ponto de entrada padrão (`lib/`) carrega os
 * dados do mdn-data com `createRequire`, que quebra quando o código é empacotado.
 */
import * as csstree from 'css-tree/dist/csstree.esm';

export const { parse, lexer, generate, walk } = csstree;
