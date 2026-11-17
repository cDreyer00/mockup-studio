/**
 * Gera build/icon.png (512) e build/icon.ico (multi-tamanho, entradas PNG) a partir de build/icon.svg.
 * Usa o próprio Electron para rasterizar: `npm run icons -w @mockup/desktop`.
 */
import { app, BrowserWindow, nativeImage } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const svg = fs.readFileSync(path.join(root, 'build', 'icon.svg'), 'utf8');
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

/** Rasteriza o SVG em 512x512 (uma única janela; os demais tamanhos saem de nativeImage.resize). */
async function rasterize(size) {
  const win = new BrowserWindow({
    show: false,
    width: size,
    height: size,
    useContentSize: true,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { sandbox: true, offscreen: true },
  });
  const html = `<html><body style="margin:0;background:transparent;overflow:hidden">
    <img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}" width="${size}" height="${size}"></body></html>`;
  const painted = new Promise((resolve) => {
    let last;
    win.webContents.on('paint', (_e, _dirty, image) => {
      last = image;
      clearTimeout(win.__t);
      win.__t = setTimeout(() => resolve(last), 400); // espera a pintura estabilizar
    });
  });
  const tmp = path.join(os.tmpdir(), `mockup-icon-${process.pid}.html`);
  fs.writeFileSync(tmp, html);
  await win.loadFile(tmp);
  fs.rmSync(tmp, { force: true });
  const img = await painted;
  win.destroy();
  return img.getSize().width === size
    ? img.toPNG()
    : img.resize({ width: size, height: size, quality: 'best' }).toPNG();
}

function buildIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2); // tipo: ícone
  header.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + dir.length;
  entries.forEach(({ size, png }, i) => {
    const o = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, o);
    dir.writeUInt8(size >= 256 ? 0 : size, o + 1);
    dir.writeUInt16LE(1, o + 4); // planos
    dir.writeUInt16LE(32, o + 6); // bits por pixel
    dir.writeUInt32LE(png.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += png.length;
  });
  return Buffer.concat([header, dir, ...entries.map((e) => e.png)]);
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  try {
    const png512 = await rasterize(512);
    fs.writeFileSync(path.join(root, 'build', 'icon.png'), png512);
    const big = nativeImage.createFromBuffer(png512);
    const entries = ICO_SIZES.map((size) => ({
      size,
      png: big.resize({ width: size, height: size, quality: 'best' }).toPNG(),
    }));
    fs.writeFileSync(path.join(root, 'build', 'icon.ico'), buildIco(entries));
    console.log('icons generated in build/ (icon.png 512, icon.ico', ICO_SIZES.join('/') + ')');
    app.exit(0);
  } catch (e) {
    console.error('failed to generate icons:', e);
    app.exit(1);
  }
});
