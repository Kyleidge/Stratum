// Third-party licence notices for the desktop app. The Vite plugin records
// every npm package whose code is rendered into dist-desktop (renderer and
// worker), adds the main process's runtime packages, and writes
// dist-desktop/THIRD_PARTY_NOTICES.txt. Packaging ships that file.
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('..', import.meta.url));
// Packages the main process loads from node_modules at run time.
export const RUNTIME_DEPENDENCIES = ['electron-updater'];
// Stylesheets that app/globals.css compiles into the bundled CSS; Vite does
// not report them as rendered modules.
export const STYLE_DEPENDENCIES = ['tailwindcss', 'tw-animate-css', 'shadcn'];
export const NOTICES_FILE = 'THIRD_PARTY_NOTICES.txt';

/** The installed directory of `name` as Node would resolve it from `from`. */
export function findPackage(name, from) {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json')))
      return realpathSync(candidate);
    if (dirname(dir) === dir)
      throw new Error(`Cannot find package ${name} from ${from}`);
  }
}

export function readManifest(dir) {
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
}

/**
 * The transitive production dependency tree of the main process's runtime
 * packages, each with the dependent that required it (for nested placement).
 */
export function runtimePackages(names = RUNTIME_DEPENDENCIES) {
  const found = [];
  const seen = new Set();
  const queue = names.map((name) => ({ name, from: repository, parent: null }));
  while (queue.length) {
    const { name, from, parent } = queue.shift();
    const dir = findPackage(name, from);
    const key = `${parent ?? ''}>${dir}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const manifest = readManifest(dir);
    found.push({ name, version: manifest.version, dir, parent });
    for (const dependency of Object.keys(manifest.dependencies ?? {}))
      queue.push({ name: dependency, from: dir, parent: dir });
  }
  return found;
}

/** The package directory that owns a bundled module ID, if it is a package. */
export function packageRoot(id) {
  // Rollup marks virtual modules with a leading NUL character.
  const real = id.startsWith('\0') ? id.slice(1) : id;
  const path = real.split('?')[0].replaceAll('\\', '/');
  const marker = '/node_modules/';
  const at = path.lastIndexOf(marker);
  if (at < 0) return undefined;
  const rest = path.slice(at + marker.length).split('/');
  const name = rest[0].startsWith('@') ? rest.slice(0, 2).join('/') : rest[0];
  const dir = path.slice(0, at + marker.length) + name;
  return existsSync(join(dir, 'package.json')) ? resolve(dir) : undefined;
}

const LICENCE_FILE = /^(licen[cs]e|copying|notice)([.-].*)?$/i;

function licenceTexts(dir) {
  return readdirSync(dir)
    .filter((file) => LICENCE_FILE.test(file))
    .sort()
    .map((file) => readFileSync(join(dir, file), 'utf8').trim());
}

const MIT = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

// Packages that declare MIT without shipping its text get the standard text.
function fallbackText(manifest, licence) {
  const author =
    typeof manifest.author === 'string'
      ? manifest.author
      : manifest.author?.name;
  if (licence !== 'MIT')
    return `No licence text is included in this package; it is ${licence}.`;
  return `MIT License\n\nCopyright (c) ${author ?? `the ${manifest.name} authors`}\n\n${MIT}`;
}

/** Plain-text notices for the given package directories. */
export function noticesText(dirs) {
  const packages = new Map();
  for (const dir of dirs) {
    const manifest = readManifest(dir);
    packages.set(`${manifest.name}@${manifest.version}`, { dir, manifest });
  }
  const sorted = [...packages.entries()].sort(([a], [b]) => a.localeCompare(b));
  const sections = sorted.map(([id, { dir, manifest }]) => {
    const licence =
      typeof manifest.license === 'string'
        ? manifest.license
        : (manifest.license?.type ?? 'See package');
    const texts = licenceTexts(dir);
    return [
      `${id} (${licence})`,
      ...(texts.length ? texts : [fallbackText(manifest, licence)]),
    ].join('\n\n');
  });
  const rule = '-'.repeat(78);
  return `${[
    'Stratum third-party notices',
    'Stratum includes the following open-source packages. Each is distributed ' +
      'under its own licence, reproduced below.\n\nThe Electron runtime ' +
      '(including Chromium and Node.js) ships its licences beside the ' +
      'application as LICENSE.electron.txt and LICENSES.chromium.html.',
    ...sections,
  ].join(`\n\n${rule}\n\n`)}\n`;
}

/** Vite plugin: one shared instance per build, for the app and its workers. */
export function licenseNotices() {
  const bundled = new Set();
  const collect = (bundle) => {
    for (const output of Object.values(bundle))
      if (output.type === 'chunk')
        for (const [id, module] of Object.entries(output.modules ?? {})) {
          const dir = module.renderedLength > 0 ? packageRoot(id) : undefined;
          if (dir) bundled.add(dir);
        }
  };
  return {
    // Workers are bundled before the application chunks are generated.
    worker: {
      name: 'stratum-worker-notices',
      generateBundle: (_, b) => collect(b),
    },
    app: {
      name: 'stratum-license-notices',
      generateBundle(_options, bundle) {
        collect(bundle);
        const runtime = runtimePackages().map(({ dir }) => dir);
        const styles = STYLE_DEPENDENCIES.map((name) =>
          findPackage(name, repository),
        );
        this.emitFile({
          type: 'asset',
          fileName: NOTICES_FILE,
          source: noticesText([...bundled, ...styles, ...runtime]),
        });
      },
    },
  };
}
