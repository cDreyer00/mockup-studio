/** Native menu in English. Actions go to the renderer via IPC (`desktop:menu`). */
import path from 'node:path';
import { Menu, type MenuItemConstructorOptions } from 'electron';

export type MenuAction =
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

export interface MenuDeps {
  /** Sends the action to the focused window's renderer. */
  send(action: MenuAction, arg?: string): void;
  recent: string[];
  openMcpDocs(): void;
  openExportDocs(): void;
  showAbout(): void;
  quit(): void;
}

/**
 * Shortcuts the editor ALREADY handles on the keyboard (Ctrl+S/Z/Y, Ctrl+Shift+S/Z, +, -, Shift+0/1) use
 * `registerAccelerator: false`: the menu shows the key but does not intercept it (avoids double firing).
 */
const displayOnly = { registerAccelerator: false } as const;

export function buildMenuTemplate(d: MenuDeps): MenuItemConstructorOptions[] {
  const recent: MenuItemConstructorOptions[] = d.recent.length
    ? d.recent.map((p) => ({
        label: `${path.basename(p)}  —  ${path.dirname(p)}`,
        click: () => d.send('openRecent', p),
      }))
    : [{ label: 'No recent documents', enabled: false }];
  return [
    {
      label: 'File',
      submenu: [
        { label: 'New', accelerator: 'CmdOrCtrl+N', click: () => d.send('new') },
        { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: () => d.send('open') },
        { label: 'Open recent', submenu: recent },
        { type: 'separator' },
        {
          label: 'Save',
          accelerator: 'CmdOrCtrl+S',
          ...displayOnly,
          click: () => d.send('save'),
        },
        {
          label: 'Save as…',
          accelerator: 'CmdOrCtrl+Shift+S',
          ...displayOnly,
          click: () => d.send('saveAs'),
        },
        { type: 'separator' },
        { label: 'Close document', accelerator: 'CmdOrCtrl+W', click: () => d.send('close') },
        { type: 'separator' },
        { label: 'Quit', accelerator: 'Alt+F4', registerAccelerator: false, click: () => d.quit() },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        {
          label: 'Undo',
          accelerator: 'CmdOrCtrl+Z',
          ...displayOnly,
          click: () => d.send('undo'),
        },
        {
          label: 'Redo',
          accelerator: 'CmdOrCtrl+Shift+Z',
          ...displayOnly,
          click: () => d.send('redo'),
        },
        { type: 'separator' },
        { label: 'Cut', role: 'cut' },
        { label: 'Copy', role: 'copy' },
        { label: 'Paste', role: 'paste' },
        { label: 'Select all', role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Present from first frame',
          accelerator: 'F5',
          ...displayOnly,
          click: () => d.send('presentFromStart'),
        },
        {
          label: 'Present from selected frame',
          accelerator: 'Shift+F5',
          ...displayOnly,
          click: () => d.send('presentFromCurrent'),
        },
        { type: 'separator' },
        {
          label: 'Zoom in',
          accelerator: 'Shift+Plus',
          ...displayOnly,
          click: () => d.send('zoomIn'),
        },
        {
          label: 'Zoom out',
          accelerator: '-',
          ...displayOnly,
          click: () => d.send('zoomOut'),
        },
        {
          label: 'Zoom 100%',
          accelerator: 'Shift+0',
          ...displayOnly,
          click: () => d.send('zoomReset'),
        },
        {
          label: 'Zoom to fit',
          accelerator: 'Shift+1',
          ...displayOnly,
          click: () => d.send('zoomFit'),
        },
        { type: 'separator' },
        { label: 'Reload', role: 'reload' },
        { label: 'Developer tools', role: 'toggleDevTools' },
        { type: 'separator' },
        { label: 'Toggle full screen', role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        { label: 'MCP documentation', click: () => d.openMcpDocs() },
        { label: 'Export documentation', click: () => d.openExportDocs() },
        { type: 'separator' },
        { label: 'About Mockup Studio', click: () => d.showAbout() },
      ],
    },
  ];
}

export function applyMenu(d: MenuDeps): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate(d)));
}
