/**
 * Entry of the injectable IIFE bundle (`dist/snapshot.iife.js`): exposes `globalThis.MockupSnapshot`.
 * Used by the extension (content script) and by headless Electron (`executeJavaScript`).
 */
import { captureElement, captureSelector } from './browser.js';
import { SNAPSHOT_VERSION } from './format.js';

const api = { version: SNAPSHOT_VERSION, captureElement, captureSelector };

declare global {
  var MockupSnapshot: typeof api | undefined;
}

globalThis.MockupSnapshot = api;
