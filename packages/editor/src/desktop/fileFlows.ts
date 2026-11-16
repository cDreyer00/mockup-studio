/** Fluxos de arquivo (novo/abrir/salvar como/fechar), com diálogo nativo no desktop ou caminho digitado. */
import { daemon } from '../client/daemon';
import { selectActiveInfo, useDoc } from '../state/docStore';
import { ui } from '../state/uiStore';
import { prompt } from '../ui/overlays';
import { getDesktop } from './bridge';

const DOC_EXT_RE = /\.mockup\.json$/i;

export function fileNameOf(path: string | null | undefined): string {
  return path ? (path.split(/[/\\]/).pop() ?? path) : '';
}

/** Nome do arquivo sem a extensão `.mockup.json`. */
export function baseNameOf(path: string): string {
  return fileNameOf(path)
    .replace(DOC_EXT_RE, '')
    .replace(/\.json$/i, '');
}

function reportError(e: unknown): void {
  ui.toast(e instanceof Error ? e.message : String(e), 'error');
}

export async function newDocument(): Promise<void> {
  const desktop = getDesktop();
  try {
    if (desktop) {
      const path = await desktop.showSaveDialog({ title: 'Novo documento' });
      if (!path) return;
      await daemon.newDoc(path, baseNameOf(path) || 'Sem título');
      return;
    }
    const r = await prompt({
      title: 'Novo documento',
      confirmLabel: 'Criar',
      fields: [
        { name: 'path', label: 'Caminho', placeholder: 'C:\\projetos\\site' },
        { name: 'name', label: 'Nome', placeholder: 'Meu site' },
      ],
    });
    if (!r?.path?.trim()) return;
    await daemon.newDoc(r.path.trim(), r.name?.trim() || fileNameOf(r.path.trim()));
  } catch (e) {
    reportError(e);
  }
}

export async function openDocument(path?: string): Promise<void> {
  try {
    let target = path;
    if (!target) {
      const desktop = getDesktop();
      if (desktop) {
        target = (await desktop.showOpenDialog()) ?? undefined;
      } else {
        const r = await prompt({
          title: 'Abrir documento',
          confirmLabel: 'Abrir',
          fields: [
            { name: 'path', label: 'Caminho', placeholder: 'C:\\projetos\\site.mockup.json' },
          ],
        });
        target = r?.path?.trim();
      }
    }
    if (!target) return;
    await daemon.openDoc(target);
  } catch (e) {
    reportError(e);
  }
}

export async function saveDocumentAs(): Promise<void> {
  const info = selectActiveInfo(useDoc.getState());
  if (!info) return;
  try {
    const desktop = getDesktop();
    let target: string | null | undefined;
    if (desktop) {
      target = await desktop.showSaveDialog({
        title: 'Salvar como',
        ...(info.path ? { defaultPath: info.path } : {}),
      });
    } else {
      const r = await prompt({
        title: 'Salvar como',
        confirmLabel: 'Salvar',
        fields: [
          {
            name: 'path',
            label: 'Novo caminho',
            placeholder: 'C:\\projetos\\copia.mockup.json',
            value: info.path ?? '',
          },
        ],
      });
      target = r?.path?.trim();
    }
    if (!target) return;
    const saved = await daemon.saveAs(target);
    ui.toast(`Salvo em ${saved.path ?? target}`);
  } catch (e) {
    reportError(e);
  }
}

export async function closeActiveDocument(): Promise<void> {
  const id = useDoc.getState().activeDocId;
  if (!id) return;
  try {
    await daemon.closeDoc(id);
  } catch (e) {
    reportError(e);
  }
}
