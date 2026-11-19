/**
 * Bridge to the desktop app (Electron). The preload exposes `window.mockupDesktop`; in the browser it does not
 * exist and the editor uses dialogs with a typed path.
 */
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
  | 'zoomFit'
  | 'presentFromStart'
  | 'presentFromCurrent';

export interface MockupDesktopApi {
  readonly isDesktop: true;
  readonly platform: string;
  /** Native "Open" dialog; returns the chosen path or null. */
  showOpenDialog(): Promise<string | null>;
  /** Native "Save" dialog; returns the path (already with .mockup.json) or null. */
  showSaveDialog(opts?: { title?: string; defaultPath?: string }): Promise<string | null>;
  /** Native menu actions; `arg` is the path in 'openRecent'. Returns the function that removes the listener. */
  onMenu(cb: (action: DesktopMenuAction, arg?: string) => void): () => void;
  /** Reports title/state to the window (title and unsaved indicator). */
  setDocumentState(state: { title: string; path: string | null; dirty: boolean }): void;
  /**
   * Presentation mode: enters/leaves the window's full screen. Resolves with whether the window is
   * full screen afterwards. Missing in older desktop builds.
   */
  setPresentationFullScreen?(on: boolean): Promise<boolean>;
  /** The window left full screen (e.g. the user pressed Esc in the desktop app). Missing in older builds. */
  onLeaveFullScreen?(cb: () => void): () => void;
}

declare global {
  interface Window {
    mockupDesktop?: MockupDesktopApi;
  }
}

/** The desktop bridge, or `undefined` in the browser. */
export function getDesktop(): MockupDesktopApi | undefined {
  return typeof window === 'undefined' ? undefined : window.mockupDesktop;
}
