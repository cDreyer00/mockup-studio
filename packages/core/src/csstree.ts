/**
 * css-tree through the prebuilt bundle (`dist/csstree.esm.js`): the same file runs in the browser, in
 * Node and inside the Electron and CLI bundles. The default entry point (`lib/`) loads the
 * mdn-data data with `createRequire`, which breaks when the code is bundled.
 */
import * as csstree from 'css-tree/dist/csstree.esm';

export const { parse, lexer, generate, walk } = csstree;
