import { packager } from '@electron/packager';
import { mkdir, copyFile, cp, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const staging = fileURLToPath(
  new URL('../build/desktop-stage/', import.meta.url),
);
await mkdir(`${staging}/desktop`, { recursive: true });
await cp(
  fileURLToPath(new URL('../dist-desktop/', import.meta.url)),
  `${staging}/dist-desktop`,
  { recursive: true },
);
await copyFile(
  fileURLToPath(new URL('./main.mjs', import.meta.url)),
  `${staging}/desktop/main.mjs`,
);
await writeFile(
  `${staging}/package.json`,
  JSON.stringify({
    name: 'stratus',
    productName: 'Stratus',
    version: '0.1.0',
    type: 'module',
    main: 'desktop/main.mjs',
  }),
);
const paths = await packager({
  dir: staging,
  name: 'Stratus',
  out: fileURLToPath(new URL('../build/releases/', import.meta.url)),
  overwrite: true,
  asar: true,
  prune: false,
});
process.stdout.write(`${paths.join('\n')}\n`);
