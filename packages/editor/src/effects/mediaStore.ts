/** State of the media dialogs (URL embed and Three.js code editor). */
import { create } from 'zustand';

interface MediaDialogs {
  embedUrlOpen: boolean;
  /** Three embed node whose code is being edited. */
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
