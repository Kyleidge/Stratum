// Packages the desktop app with electron-builder (see docs/releasing.md).
//
//   pnpm desktop:package               Windows: NSIS installer and unpacked
//                                      folder (x64); elsewhere: an unpacked
//                                      folder for the current platform
//   pnpm desktop:package --dir         unpacked folder only
//   pnpm desktop:package --win         Windows targets from another platform
//   pnpm desktop:package --publish     also upload the installer, blockmap
//                                      and latest.yml to the update feed
//
// The renderer is pre-bundled in dist-desktop, so electron-builder packages a
// minimal staged app: the main-process modules, dist-desktop, the icon and
// only the runtime packages the main process loads (copied out of pnpm's
// symlinked store), never the repository or its dev dependencies.
import { build, Platform, Arch } from 'electron-builder';
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  NOTICES_FILE,
  RUNTIME_DEPENDENCIES,
  findPackage,
  readManifest,
  runtimePackages,
} from './notices.mjs';

const path = (relative) => fileURLToPath(new URL(relative, import.meta.url));
const repository = path('../');
const args = new Set(process.argv.slice(2));
const env = process.env;
const manifest = readManifest(repository);
const notices = path(`../dist-desktop/${NOTICES_FILE}`);
if (!existsSync(notices))
  throw new Error('Run pnpm desktop:build before packaging.');

// Build-time scripts that the packaged app never loads.
const BUILD_ONLY = new Set(['package.mjs', 'icons.mjs', 'notices.mjs']);

async function stage() {
  // Outside the checkout, so electron-builder cannot mistake the staged app
  // for a member of the repository's pnpm workspace and pack its packages.
  const staging = await mkdtemp(join(tmpdir(), 'stratum-stage-'));
  await mkdir(join(staging, 'desktop', 'icons'), { recursive: true });
  for (const file of await readdir(path('./')))
    if (/\.(mjs|cjs)$/.test(file) && !BUILD_ONLY.has(file))
      await cp(path(`./${file}`), join(staging, 'desktop', file));
  await cp(
    path('./icons/icon.png'),
    join(staging, 'desktop', 'icons', 'icon.png'),
  );
  await cp(path('../dist-desktop/'), join(staging, 'dist-desktop'), {
    recursive: true,
  });
  // Hoist each runtime package unless another version already holds its
  // name; then nest it under the package that needs it, as Node resolves.
  const placed = new Map();
  const claimed = new Map();
  for (const { name, dir, parent } of runtimePackages()) {
    const owner = claimed.get(name);
    if (owner === dir) continue;
    const target = owner
      ? join(placed.get(parent), 'node_modules', name)
      : join(staging, 'node_modules', name);
    if (!owner) claimed.set(name, dir);
    if (!existsSync(target))
      await cp(dir, target, { recursive: true, dereference: true });
    if (!placed.has(dir)) placed.set(dir, target);
  }
  await writeFile(
    join(staging, 'package.json'),
    JSON.stringify(
      {
        name: 'stratum',
        productName: 'Stratum',
        version: manifest.version,
        description: 'Signal workflow workbench',
        author: 'Kyle Webb',
        license: manifest.license,
        type: 'module',
        main: 'desktop/main.mjs',
        dependencies: Object.fromEntries(
          RUNTIME_DEPENDENCIES.map((name) => [
            name,
            manifest.dependencies[name],
          ]),
        ),
      },
      null,
      2,
    ),
  );
  return staging;
}

/**
 * The update feed baked into resources/app-update.yml. The source repository
 * is private, so installed apps read a public, releases-only repository (or
 * any static HTTPS folder) and never need a token.
 */
function updateFeed() {
  if (env.STRATUM_UPDATE_URL)
    return { provider: 'generic', url: env.STRATUM_UPDATE_URL };
  return {
    provider: 'github',
    owner: env.STRATUM_UPDATE_OWNER || 'Kyleidge',
    repo: env.STRATUM_UPDATE_REPO || 'stratum-releases',
    // Uploads land in a draft release; publishing it releases the update.
    releaseType: 'draft',
  };
}

/**
 * Signs only when credentials are present; otherwise the build is unsigned.
 * A certificate file uses electron-builder's CSC_LINK/CSC_KEY_PASSWORD;
 * Azure Trusted Signing uses these variables plus AZURE_TENANT_ID,
 * AZURE_CLIENT_ID and AZURE_CLIENT_SECRET.
 */
function azureSigning() {
  if (!env.AZURE_SIGNING_ENDPOINT) return {};
  for (const name of [
    'AZURE_SIGNING_PUBLISHER',
    'AZURE_SIGNING_ACCOUNT',
    'AZURE_SIGNING_PROFILE',
  ])
    if (!env[name]) throw new Error(`Azure Trusted Signing needs ${name}.`);
  return {
    azureSignOptions: {
      publisherName: env.AZURE_SIGNING_PUBLISHER,
      endpoint: env.AZURE_SIGNING_ENDPOINT,
      codeSigningAccountName: env.AZURE_SIGNING_ACCOUNT,
      certificateProfileName: env.AZURE_SIGNING_PROFILE,
    },
  };
}

// CI passes absent secrets as empty strings; those mean "do not sign".
for (const [name, value] of Object.entries(env))
  if (value === '' && /^(WIN_)?CSC_|^AZURE_/.test(name)) delete env[name];
const publish = args.has('--publish');
if (publish && !env.STRATUM_UPDATE_URL && !env.GH_TOKEN)
  throw new Error('Publishing to the GitHub releases feed needs GH_TOKEN.');
process.stdout.write(
  `Signing: ${env.CSC_LINK || env.WIN_CSC_LINK ? 'certificate' : env.AZURE_SIGNING_ENDPOINT ? 'Azure Trusted Signing' : 'none (unsigned build)'}\n`,
);

const windows = args.has('--win') || process.platform === 'win32';
const directoryOnly = args.has('--dir');
const platform = windows ? Platform.WINDOWS : Platform.current();
const targets = platform.createTarget(
  windows && !directoryOnly ? ['nsis', 'dir'] : ['dir'],
  windows ? Arch.x64 : Arch[process.arch],
);

// The staged node_modules is a plain npm layout, whatever ran this script.
delete env.npm_config_user_agent;
delete env.npm_execpath;
const staging = await stage();
try {
  const files = await build({
    projectDir: staging,
    targets,
    publish: publish ? 'always' : 'never',
    config: {
      appId: 'com.kyleidge.stratum',
      productName: 'Stratum',
      copyright: 'Copyright (c) 2026 Kyle Webb',
      electronVersion: readManifest(findPackage('electron', repository))
        .version,
      directories: {
        output: path('../build/releases/'),
        buildResources: path('./icons/'),
      },
      asar: true,
      npmRebuild: false,
      nodeGypRebuild: false,
      extraResources: [
        { from: path('../LICENSE'), to: 'LICENSE.txt' },
        { from: notices, to: NOTICES_FILE },
      ],
      win: {
        icon: path('./icons/icon.ico'),
        ...azureSigning(),
      },
      nsis: {
        // Per-user, no administrator rights; Start-menu and desktop
        // shortcuts and an uninstaller. Uninstalling keeps the workspace.
        oneClick: true,
        perMachine: false,
        createStartMenuShortcut: true,
        shortcutName: 'Stratum',
        deleteAppDataOnUninstall: false,
        artifactName: 'Stratum-Setup-${version}.${ext}',
      },
      linux: { icon: path('./icons/icon.png'), category: 'Science' },
      publish: updateFeed(),
    },
  });
  process.stdout.write(
    `Packaged into build/releases/\n${files.map((file) => `${file}\n`).join('')}`,
  );
} finally {
  await rm(staging, { recursive: true, force: true });
}
