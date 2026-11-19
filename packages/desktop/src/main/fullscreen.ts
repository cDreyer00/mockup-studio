/** Remember/restore logic for the presentation's full-screen request (pure, no Electron). */

export interface FullScreenPlan {
  /** Full-screen state the window must be in. */
  target: boolean;
  /** What to remember for the window afterwards (`undefined` = clear). */
  remember: boolean | undefined;
}

/**
 * @param wasFullScreen what was remembered when the presentation started (`undefined` = not presenting)
 * @param on            whether the editor asks to enter (true) or leave (false) the presentation full screen
 * @param isFullScreen  the window's current state
 */
export function planFullScreen(
  wasFullScreen: boolean | undefined,
  on: boolean,
  isFullScreen: boolean,
): FullScreenPlan {
  if (on) return { target: true, remember: wasFullScreen ?? isFullScreen };
  // Leaving: only exit full screen if the window was not full screen before the presentation.
  return {
    target: wasFullScreen === undefined ? isFullScreen : wasFullScreen,
    remember: undefined,
  };
}
