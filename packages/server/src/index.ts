export { startDaemon } from './daemon.js';
export type { DaemonHandle, DaemonOptions } from './daemon.js';
export { DocumentStore, StoreError } from './store.js';
export {
  DEFAULT_PORT,
  DOCUMENT_EXT,
  normalizeDocumentPath,
  getDataDir,
  readDaemonInfo,
  readRecent,
  addRecent,
  removeDaemonInfo,
  resolvePort,
  writeDaemonInfo,
} from './paths.js';
export type { DaemonInfo } from './paths.js';
export type { DaemonMode, HealthInfo } from './http.js';
export { checkHealth } from './health.js';
export { listSystemFonts } from './fonts.js';
export type { SystemFont } from './fonts.js';
export { listOpenDocuments, requestShutdown, takeOverDaemon, waitForShutdown } from './control.js';
export type { TakeoverResult } from './control.js';
export { isAllowedHost } from './http.js';
export { isAllowedOrigin } from './ws.js';
export { RENDER_UNAVAILABLE, renderUnavailableMessage } from './render.js';
export type {
  CaptureRequest,
  CaptureResult,
  RenderFormat,
  RenderProvider,
  RenderScale,
  RenderTarget,
} from './render.js';
