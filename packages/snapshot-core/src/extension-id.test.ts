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

describe('fixed extension id', () => {
  it('MOCKUP_EXTENSION_ID is the id derived from the key in manifest.json', () => {
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as { key?: string };
    expect(manifest.key, 'manifest.json with a key').toBeTypeOf('string');
    // Chrome id: sha256 of the public key (DER), first 32 hex digits mapped 0-f → a-p
    const hex = createHash('sha256').update(Buffer.from(manifest.key!, 'base64')).digest('hex');
    const id = [...hex.slice(0, 32)].map((h) => String.fromCharCode(97 + parseInt(h, 16))).join('');
    expect(id).toBe(MOCKUP_EXTENSION_ID);
  });
});
