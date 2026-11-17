// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { actions } from '../actions';
import { canvasApi } from '../canvas/canvasApi';
import { daemon } from '../client/daemon';
import { useDoc } from '../state/docStore';
import type { DesktopMenuAction, MockupDesktopApi } from './bridge';
import { baseNameOf, newDocument, openDocument, saveDocumentAs } from './fileFlows';
import { runDesktopMenu, syncDocumentState } from './useDesktop';

type Bridge = MockupDesktopApi & { menu?: (a: DesktopMenuAction, arg?: string) => void };

function fakeBridge(over: Partial<MockupDesktopApi> = {}): Bridge {
  const b: Bridge = {
    isDesktop: true,
    platform: 'win32',
    showOpenDialog: vi.fn(async () => 'C:\\p\\a.mockup.json'),
    showSaveDialog: vi.fn(async () => 'C:\\p\\new.mockup.json'),
    onMenu: vi.fn((cb) => {
      b.menu = cb;
      return () => undefined;
    }),
    setDocumentState: vi.fn(),
    ...over,
  };
  return b;
}

const info = {
  docId: 'd1',
  name: 'Doc',
  path: 'C:\\p\\doc.mockup.json',
  dirty: false,
  revision: 0,
};

describe('desktop bridge', () => {
  beforeEach(() => {
    useDoc.setState({ documents: [info], activeDocId: 'd1' });
  });
  afterEach(() => {
    delete window.mockupDesktop;
    vi.restoreAllMocks();
  });

  it('baseNameOf strips the document extension', () => {
    expect(baseNameOf('C:\\p\\my site.mockup.json')).toBe('my site');
    expect(baseNameOf('/p/x.json')).toBe('x');
  });

  it('New uses the save dialog and creates with the file name', async () => {
    const b = fakeBridge();
    window.mockupDesktop = b;
    const spy = vi.spyOn(daemon, 'newDoc').mockResolvedValue(info);
    await newDocument();
    expect(b.showSaveDialog).toHaveBeenCalledWith({ title: 'New document' });
    expect(spy).toHaveBeenCalledWith('C:\\p\\new.mockup.json', 'new');
  });

  it('cancelled New does not create', async () => {
    window.mockupDesktop = fakeBridge({ showSaveDialog: vi.fn(async () => null) });
    const spy = vi.spyOn(daemon, 'newDoc');
    await newDocument();
    expect(spy).not.toHaveBeenCalled();
  });

  it('Open uses the native dialog', async () => {
    window.mockupDesktop = fakeBridge();
    const spy = vi.spyOn(daemon, 'openDoc').mockResolvedValue(info);
    await openDocument();
    expect(spy).toHaveBeenCalledWith('C:\\p\\a.mockup.json');
  });

  it('Save as uses defaultPath from the current path and doc:saveAs', async () => {
    const b = fakeBridge();
    window.mockupDesktop = b;
    const spy = vi
      .spyOn(daemon, 'saveAs')
      .mockResolvedValue({ ...info, path: 'C:\\p\\new.mockup.json' });
    await saveDocumentAs();
    expect(b.showSaveDialog).toHaveBeenCalledWith({
      title: 'Save as',
      defaultPath: info.path,
    });
    expect(spy).toHaveBeenCalledWith('C:\\p\\new.mockup.json');
  });

  it('menu actions call the existing flows', () => {
    window.mockupDesktop = fakeBridge();
    const save = vi.spyOn(actions, 'save').mockResolvedValue();
    const undo = vi.spyOn(actions, 'undo').mockResolvedValue();
    const open = vi.spyOn(daemon, 'openDoc').mockResolvedValue(info);
    const close = vi.spyOn(daemon, 'closeDoc').mockResolvedValue({});
    const zoomIn = vi.spyOn(canvasApi, 'zoomIn').mockImplementation(() => undefined);
    const zoomTo = vi.spyOn(canvasApi, 'zoomTo').mockImplementation(() => undefined);
    const fit = vi.spyOn(canvasApi, 'fitAll').mockImplementation(() => undefined);
    runDesktopMenu('save');
    runDesktopMenu('undo');
    runDesktopMenu('openRecent', 'C:\\r.mockup.json');
    runDesktopMenu('close');
    runDesktopMenu('zoomIn');
    runDesktopMenu('zoomReset');
    runDesktopMenu('zoomFit');
    expect(save).toHaveBeenCalled();
    expect(undo).toHaveBeenCalled();
    expect(open).toHaveBeenCalledWith('C:\\r.mockup.json');
    expect(close).toHaveBeenCalledWith('d1');
    expect(zoomIn).toHaveBeenCalled();
    expect(zoomTo).toHaveBeenCalledWith(1);
    expect(fit).toHaveBeenCalled();
  });

  it('undo/redo in an editable field use execCommand', () => {
    const exec = vi.fn(() => true);
    document.execCommand = exec;
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    const undo = vi.spyOn(actions, 'undo').mockResolvedValue();
    runDesktopMenu('undo');
    runDesktopMenu('redo');
    expect(exec).toHaveBeenCalledWith('undo');
    expect(exec).toHaveBeenCalledWith('redo');
    expect(undo).not.toHaveBeenCalled();
    input.remove();
  });

  it('reports the document state when name/path/dirty change', () => {
    const b = fakeBridge();
    window.mockupDesktop = b;
    const stop = syncDocumentState();
    expect(b.setDocumentState).toHaveBeenLastCalledWith({
      title: 'Doc',
      path: info.path,
      dirty: false,
    });
    useDoc.setState({ documents: [{ ...info, dirty: true }] });
    expect(b.setDocumentState).toHaveBeenLastCalledWith({
      title: 'Doc',
      path: info.path,
      dirty: true,
    });
    const n = vi.mocked(b.setDocumentState).mock.calls.length;
    useDoc.setState({ documents: [{ ...info, dirty: true, revision: 5 }] });
    expect(vi.mocked(b.setDocumentState).mock.calls.length).toBe(n);
    stop();
  });
});
