/**
 * Ponte com o app desktop (Electron). O preload expõe `window.mockupDesktop`; no navegador ela não
 * existe e o editor usa diálogos com caminho digitado.
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
  | 'zoomFit';

export interface MockupDesktopApi {
  readonly isDesktop: true;
  readonly platform: string;
  /** Diálogo nativo "Abrir"; devolve o caminho escolhido ou null. */
  showOpenDialog(): Promise<string | null>;
  /** Diálogo nativo "Salvar"; devolve o caminho (já com .mockup.json) ou null. */
  showSaveDialog(opts?: { title?: string; defaultPath?: string }): Promise<string | null>;
  /** Ações do menu nativo; `arg` é o caminho em 'openRecent'. Devolve a função para remover o ouvinte. */
  onMenu(cb: (action: DesktopMenuAction, arg?: string) => void): () => void;
  /** Informa título/estado para a janela (título e indicador de não salvo). */
  setDocumentState(state: { title: string; path: string | null; dirty: boolean }): void;
}

declare global {
  interface Window {
    mockupDesktop?: MockupDesktopApi;
  }
}

/** A ponte do desktop, ou `undefined` no navegador. */
export function getDesktop(): MockupDesktopApi | undefined {
  return typeof window === 'undefined' ? undefined : window.mockupDesktop;
}
