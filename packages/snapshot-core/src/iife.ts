/**
 * Entrada do bundle IIFE injetável (`dist/snapshot.iife.js`): expõe `globalThis.MockupSnapshot`.
 * Usado pela extensão (content script) e pelo Electron headless (`executeJavaScript`).
 */
import { captureElement, captureSelector } from './browser.js';
import { SNAPSHOT_VERSION } from './format.js';

const api = { version: SNAPSHOT_VERSION, captureElement, captureSelector };

declare global {
  var MockupSnapshot: typeof api | undefined;
}

globalThis.MockupSnapshot = api;
