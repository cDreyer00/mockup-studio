/** Estado dos diálogos de mídia (embed por URL e editor de código Three.js). */
import { create } from 'zustand';

interface MediaDialogs {
  embedUrlOpen: boolean;
  /** Nó embed three cujo código está em edição. */
  threeNodeId: string | null;
}

export const useMediaDialogs = create<MediaDialogs>(() => ({
  embedUrlOpen: false,
  threeNodeId: null,
}));

export const mediaDialogs = {
  openEmbedUrl: () => useMediaDialogs.setState({ embedUrlOpen: true }),
  closeEmbedUrl: () => useMediaDialogs.setState({ embedUrlOpen: false }),
  openThree: (nodeId: string) => useMediaDialogs.setState({ threeNodeId: nodeId }),
  closeThree: () => useMediaDialogs.setState({ threeNodeId: null }),
};
