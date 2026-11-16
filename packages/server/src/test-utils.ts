import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDocument, createNodeFromTag, serializeDocument } from '@mockup/core';

/** Cria uma pasta temporária com um documento mínimo (1 frame) e devolve os caminhos. */
export function makeWorkspace(): {
  dir: string;
  dataDir: string;
  file: string;
  frameId: string;
  cleanup(): void;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mockup-'));
  const dataDir = path.join(dir, 'data');
  fs.mkdirSync(dataDir);
  const doc = createDocument('Teste');
  const frame = createNodeFromTag('div', {
    isRoot: true,
    name: 'Desktop',
    styles: { width: '1440px', height: '900px', background: '#ffffff' },
    position: { x: 0, y: 0 },
  });
  doc.pages[0]!.frames.push(frame);
  const file = path.join(dir, 'teste.mockup.json');
  fs.writeFileSync(file, serializeDocument(doc), 'utf8');
  return {
    dir,
    dataDir,
    file,
    frameId: frame.id,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}
