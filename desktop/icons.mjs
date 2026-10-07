// Renders desktop/icons/stratum.svg into the committed app icons:
// icon.ico (Windows installer, executable and taskbar) and icon.png (window
// icon elsewhere). Run `pnpm desktop:icons` after editing the SVG.
import sharp from 'sharp';
import { readFile, writeFile } from 'node:fs/promises';

const folder = new URL('./icons/', import.meta.url);
const svg = await readFile(new URL('stratum.svg', folder));
const render = (size) =>
  sharp(svg, { density: (72 * size * 4) / 1024 })
    .resize(size, size)
    .png({ compressionLevel: 9 })
    .toBuffer();

// An ICO of PNG-compressed images, which Windows has read since Vista.
const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const images = await Promise.all(sizes.map(render));
const header = Buffer.alloc(6 + 16 * sizes.length);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
sizes.forEach((size, i) => {
  const entry = 6 + 16 * i;
  header.writeUInt8(size % 256, entry);
  header.writeUInt8(size % 256, entry + 1);
  header.writeUInt16LE(1, entry + 4);
  header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(images[i].length, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  offset += images[i].length;
});
await writeFile(
  new URL('icon.ico', folder),
  Buffer.concat([header, ...images]),
);
await writeFile(new URL('icon.png', folder), await render(512));
process.stdout.write('Wrote desktop/icons/icon.ico and icon.png\n');
