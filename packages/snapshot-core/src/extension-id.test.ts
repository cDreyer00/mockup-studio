import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MOCKUP_EXTENSION_ID } from './api.js';

const manifestFile = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../extension/manifest.json',
);

describe('id fixo da extensão', () => {
  it('MOCKUP_EXTENSION_ID é o id derivado da key do manifest.json', () => {
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as { key?: string };
    expect(manifest.key, 'manifest.json com key').toBeTypeOf('string');
    // id do Chrome: sha256 da chave pública (DER), 32 primeiros dígitos hex mapeados 0-f → a-p
    const hex = createHash('sha256').update(Buffer.from(manifest.key!, 'base64')).digest('hex');
    const id = [...hex.slice(0, 32)].map((h) => String.fromCharCode(97 + parseInt(h, 16))).join('');
    expect(id).toBe(MOCKUP_EXTENSION_ID);
  });
});
