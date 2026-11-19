import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ Menu: {} }));

import { planFullScreen } from './main/fullscreen.js';
import { buildMenuTemplate, type MenuDeps } from './main/menu.js';

function deps(send = vi.fn()): MenuDeps {
  return {
    send,
    recent: [],
    openMcpDocs: vi.fn(),
    openExportDocs: vi.fn(),
    showAbout: vi.fn(),
    quit: vi.fn(),
  };
}

describe('View menu presentation entries', () => {
  it('lists both entries first, display-only, and sends the actions', () => {
    const send = vi.fn();
    const view = buildMenuTemplate(deps(send)).find((m) => m.label === 'View');
    const items = view?.submenu as Array<Record<string, unknown>>;
    expect(items[0]).toMatchObject({
      label: 'Present from first frame',
      accelerator: 'F5',
      registerAccelerator: false,
    });
    expect(items[1]).toMatchObject({
      label: 'Present from selected frame',
      accelerator: 'Shift+F5',
      registerAccelerator: false,
    });
    expect(items[2]).toMatchObject({ type: 'separator' });
    (items[0]!.click as () => void)();
    (items[1]!.click as () => void)();
    expect(send).toHaveBeenNthCalledWith(1, 'presentFromStart');
    expect(send).toHaveBeenNthCalledWith(2, 'presentFromCurrent');
  });
});

describe('planFullScreen', () => {
  it('enters and remembers the previous state', () => {
    expect(planFullScreen(undefined, true, false)).toEqual({ target: true, remember: false });
    expect(planFullScreen(undefined, true, true)).toEqual({ target: true, remember: true });
  });
  it('keeps the original memory when entering twice', () => {
    expect(planFullScreen(false, true, true)).toEqual({ target: true, remember: false });
  });
  it('leaves only if it was not full screen before', () => {
    expect(planFullScreen(false, false, true)).toEqual({ target: false, remember: undefined });
    expect(planFullScreen(true, false, true)).toEqual({ target: true, remember: undefined });
  });
  it('leaving without a presentation changes nothing', () => {
    expect(planFullScreen(undefined, false, true)).toEqual({ target: true, remember: undefined });
    expect(planFullScreen(undefined, false, false)).toEqual({ target: false, remember: undefined });
  });
});
