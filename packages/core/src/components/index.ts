/** Componentes: expansão, ops primitivas, roteamento e planejadores (ver docs/COMPONENTES.md). */
export * from './expand.js';
export {
  assertComponentInsertion,
  assertFreshNodeIds,
  assertInstanceChildren,
  documentNodeIds,
  normalizeOverride,
  normalizeOverridesMap,
  normalizePropValue,
  slotNames,
} from './ops.js';
export {
  COMPONENT_EDIT_PAGE_ID,
  componentNodeById,
  derivedNodeId,
  isComponentNodeId,
  routeComponentOp,
  slotContainerId,
  slotContainerNode,
} from './route.js';
export * from './plan.js';
