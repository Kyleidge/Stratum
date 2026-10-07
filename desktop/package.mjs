import { packager } from '@electron/packager';
import {
  mkdir,
  mkdtemp,
  readFile,
  copyFile,
  cp,
  writeFile,
} from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const build = fileURLToPath(new URL('../build/', import.meta.url));
await mkdir(build, { recursive: true });
const staging = await mkdtemp(`${build}/desktop-stage-`);
const manifest = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8'),
);
await mkdir(`${staging}/desktop`, { recursive: true });
await cp(
  fileURLToPath(new URL('../dist-desktop/', import.meta.url)),
  `${staging}/dist-desktop`,
  { recursive: true },
);
// The main process, its file bridge and the sandboxed preload.
for (const file of [
  'main.mjs',
  'files.mjs',
  'backup-files.mjs',
  'backup-smoke.mjs',
  'preload.cjs',
])
  await copyFile(
    fileURLToPath(new URL(`./${file}`, import.meta.url)),
    `${staging}/desktop/${file}`,
  );
await writeFile(
  `${staging}/package.json`,
  JSON.stringify({
    name: 'stratum',
    productName: 'Stratum',
    version: manifest.version,
    type: 'module',
    main: 'desktop/main.mjs',
  }),
);
const paths = await packager({
  dir: staging,
  name: 'Stratum',
  out: fileURLToPath(new URL('../build/releases/', import.meta.url)),
  overwrite: true,
  asar: true,
  prune: false,
});
process.stdout.write(`${paths.join('\n')}\n`);
