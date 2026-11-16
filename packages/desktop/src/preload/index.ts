/**
 * Preload (sandbox, CJS): expõe `window.mockupDesktop` ao editor. Só é exposto quando a página é
 * servida pelo daemon local (127.0.0.1/localhost); qualquer outra origem não recebe a ponte.
 */
import { contextBridge, ipcRenderer } from 'electron';

export type DesktopMenuAction =
  | 'new'
  | 'open'
  | 'openRecent'
  | 'save'
  | 'saveAs'
  | 'close'
  | 'undo'
  | 'redo'
  | 'zoomIn'
  | 'zoomOut'
  | 'zoomReset'
  | 'zoomFit';

export interface MockupDesktopApi {
  readonly isDesktop: true;
  readonly platform: string;
  showOpenDialog(): Promise<string | null>;
  showSaveDialog(opts?: { title?: string; defaultPath?: string }): Promise<string | null>;
  onMenu(cb: (action: DesktopMenuAction, arg?: string) => void): () => void;
  setDocumentState(state: { title: string; path: string | null; dirty: boolean }): void;
}

const isLocalOrigin =
  location.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(location.hostname);

if (isLocalOrigin) {
  const api: MockupDesktopApi = {
    isDesktop: true,
    platform: process.platform,
    showOpenDialog: () => ipcRenderer.invoke('desktop:openDialog'),
    showSaveDialog: (opts) =>
      ipcRenderer.invoke('desktop:saveDialog', {
        title: typeof opts?.title === 'string' ? opts.title : undefined,
        defaultPath: typeof opts?.defaultPath === 'string' ? opts.defaultPath : undefined,
      }),
    onMenu(cb) {
      const handler = (_e: unknown, action: DesktopMenuAction, arg?: string): void =>
        cb(action, arg);
      ipcRenderer.on('desktop:menu', handler);
      return () => {
        ipcRenderer.off('desktop:menu', handler);
      };
    },
    setDocumentState(state) {
      ipcRenderer.send('desktop:docState', {
        title: String(state?.title ?? ''),
        path: typeof state?.path === 'string' ? state.path : null,
        dirty: !!state?.dirty,
      });
    },
  };
  contextBridge.exposeInMainWorld('mockupDesktop', api);
}
