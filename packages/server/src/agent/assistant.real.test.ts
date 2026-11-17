import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createDocument,
  createNodeFromTag,
  findNode,
  serializeDocument,
  type Node,
} from '@mockup/core';
import { startDaemon, type DaemonHandle } from '../index.js';
import { ClaudeCliBackend } from './cli.js';

/**
 * Teste de ponta a ponta com o Claude Code REAL da máquina (usa a conta logada: custa cota e leva
 * alguns segundos). Só roda com `MOCKUP_REAL_AGENT=1`; o CI e `npm test` o ignoram.
 *
 *   MOCKUP_REAL_AGENT=1 npx vitest run packages/server/src/agent/assistant.real.test.ts
 */
const enabled = process.env.MOCKUP_REAL_AGENT === '1';

describe.skipIf(!enabled)('Assistente com o Claude Code real', () => {
  let dir: string;
  let daemon: DaemonHandle;
  let docId: string;
  let buttonId: string;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mockup-real-'));
    const button: Node = createNodeFromTag('button', {
      name: 'Primário',
      text: 'Comprar',
      styles: {
        background: '#2563eb',
        color: '#ffffff',
        padding: '12px 24px',
        'border-radius': '8px',
      },
    });
    buttonId = button.id;
    const frame = createNodeFromTag('div', {
      isRoot: true,
      name: 'Home',
      styles: { width: '800px', height: '400px', background: '#ffffff', padding: '32px' },
      position: { x: 0, y: 0 },
      children: [button],
    });
    const doc = createDocument('Real');
    doc.pages[0]!.frames.push(frame);
    const file = path.join(dir, 'real.mockup.json');
    fs.writeFileSync(file, serializeDocument(doc), 'utf8');
    daemon = await startDaemon({
      port: 0,
      dataDir: path.join(dir, 'data'),
      writeInfo: false,
      openFiles: [file],
      agentBackends: [new ClaudeCliBackend()],
    });
    docId = daemon.store.list()[0]!.docId;
  });
  afterEach(async () => {
    await daemon.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const styleOf = () => ({ ...findNode(daemon.store.get(docId), buttonId)!.node.style });

  it('"deixe o botão primário mais destacado" muda o nó selecionado e um undo desfaz o turno', async () => {
    const before = styleOf();
    daemon.store.setSelection(docId, [buttonId], 'editor');

    const msg = await daemon.services.assistant.runTurn(
      docId,
      'deixe o botão primário mais destacado',
      { selection: [buttonId] },
    );

    expect(msg.status).toBe('done');
    expect(msg.opsCount).toBeGreaterThan(0);
    expect(msg.tools?.some((t) => t.name === 'update_styles')).toBe(true);
    expect(styleOf()).not.toEqual(before);

    // um único Ctrl+Z desfaz o turno inteiro, mesmo com várias ferramentas
    expect(daemon.store.undo(docId, 'editor')).not.toBeNull();
    expect(styleOf()).toEqual(before);
    expect(daemon.store.undo(docId, 'editor')).toBeNull();
  }, 180_000);
});
