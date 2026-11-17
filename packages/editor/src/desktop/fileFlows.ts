/** File flows (new/open/save as/close), with a native dialog on desktop or a typed path. */
import { daemon } from '../client/daemon';
import { selectActiveInfo, useDoc } from '../state/docStore';
import { ui } from '../state/uiStore';
import { prompt } from '../ui/overlays';
import { getDesktop } from './bridge';

const DOC_EXT_RE = /\.mockup\.json$/i;

export function fileNameOf(path: string | null | undefined): string {
  return path ? (path.split(/[/\\]/).pop() ?? path) : '';
}

/** File name without the `.mockup.json` extension. */
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
      const path = await desktop.showSaveDialog({ title: 'New document' });
      if (!path) return;
      await daemon.newDoc(path, baseNameOf(path) || 'Untitled');
      return;
    }
    const r = await prompt({
      title: 'New document',
      confirmLabel: 'Create',
      fields: [
        { name: 'path', label: 'Path', placeholder: 'C:\\projects\\site' },
        { name: 'name', label: 'Name', placeholder: 'My site' },
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
          title: 'Open document',
          confirmLabel: 'Open',
          fields: [{ name: 'path', label: 'Path', placeholder: 'C:\\projects\\site.mockup.json' }],
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
        title: 'Save as',
        ...(info.path ? { defaultPath: info.path } : {}),
      });
    } else {
      const r = await prompt({
        title: 'Save as',
        confirmLabel: 'Save',
        fields: [
          {
            name: 'path',
            label: 'New path',
            placeholder: 'C:\\projects\\copy.mockup.json',
            value: info.path ?? '',
          },
        ],
      });
      target = r?.path?.trim();
    }
    if (!target) return;
    const saved = await daemon.saveAs(target);
    ui.toast(`Saved to ${saved.path ?? target}`);
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
