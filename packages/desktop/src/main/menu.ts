/** Menu nativo em português. Ações vão ao renderer por IPC (`desktop:menu`). */
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
  | 'zoomFit';

export interface MenuDeps {
  /** Envia a ação ao renderer da janela em foco. */
  send(action: MenuAction, arg?: string): void;
  recent: string[];
  openMcpDocs(): void;
  openExportDocs(): void;
  showAbout(): void;
  quit(): void;
}

/**
 * Atalhos que o editor JÁ trata no teclado (Ctrl+S/Z/Y, Ctrl+Shift+S/Z, +, -, Shift+0/1) usam
 * `registerAccelerator: false`: o menu mostra a tecla mas não a intercepta (evita disparo duplo).
 */
const displayOnly = { registerAccelerator: false } as const;

export function buildMenuTemplate(d: MenuDeps): MenuItemConstructorOptions[] {
  const recent: MenuItemConstructorOptions[] = d.recent.length
    ? d.recent.map((p) => ({
        label: `${path.basename(p)}  —  ${path.dirname(p)}`,
        click: () => d.send('openRecent', p),
      }))
    : [{ label: 'Nenhum documento recente', enabled: false }];
  return [
    {
      label: 'Arquivo',
      submenu: [
        { label: 'Novo', accelerator: 'CmdOrCtrl+N', click: () => d.send('new') },
        { label: 'Abrir…', accelerator: 'CmdOrCtrl+O', click: () => d.send('open') },
        { label: 'Abrir recente', submenu: recent },
        { type: 'separator' },
        {
          label: 'Salvar',
          accelerator: 'CmdOrCtrl+S',
          ...displayOnly,
          click: () => d.send('save'),
        },
        {
          label: 'Salvar como…',
          accelerator: 'CmdOrCtrl+Shift+S',
          ...displayOnly,
          click: () => d.send('saveAs'),
        },
        { type: 'separator' },
        { label: 'Fechar documento', accelerator: 'CmdOrCtrl+W', click: () => d.send('close') },
        { type: 'separator' },
        { label: 'Sair', accelerator: 'Alt+F4', registerAccelerator: false, click: () => d.quit() },
      ],
    },
    {
      label: 'Editar',
      submenu: [
        {
          label: 'Desfazer',
          accelerator: 'CmdOrCtrl+Z',
          ...displayOnly,
          click: () => d.send('undo'),
        },
        {
          label: 'Refazer',
          accelerator: 'CmdOrCtrl+Shift+Z',
          ...displayOnly,
          click: () => d.send('redo'),
        },
        { type: 'separator' },
        { label: 'Recortar', role: 'cut' },
        { label: 'Copiar', role: 'copy' },
        { label: 'Colar', role: 'paste' },
        { label: 'Selecionar tudo', role: 'selectAll' },
      ],
    },
    {
      label: 'Ver',
      submenu: [
        {
          label: 'Aumentar zoom',
          accelerator: 'Shift+Plus',
          ...displayOnly,
          click: () => d.send('zoomIn'),
        },
        {
          label: 'Diminuir zoom',
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
          label: 'Ajustar à tela',
          accelerator: 'Shift+1',
          ...displayOnly,
          click: () => d.send('zoomFit'),
        },
        { type: 'separator' },
        { label: 'Recarregar', role: 'reload' },
        { label: 'Ferramentas do desenvolvedor', role: 'toggleDevTools' },
        { type: 'separator' },
        { label: 'Tela cheia', role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Ajuda',
      submenu: [
        { label: 'Documentação do MCP', click: () => d.openMcpDocs() },
        { label: 'Documentação de exportação', click: () => d.openExportDocs() },
        { type: 'separator' },
        { label: 'Sobre o Mockup Studio', click: () => d.showAbout() },
      ],
    },
  ];
}

export function applyMenu(d: MenuDeps): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate(d)));
}
