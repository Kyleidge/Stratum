# Releasing Stratum

Stratum ships as a Windows (x64) desktop app: an NSIS installer that installs
for the current user, adds Start-menu and desktop shortcuts and an
uninstaller, and updates itself from a public releases feed. The source
repository stays private.

## One-time setup

Create these before the first release. Nothing in this repository creates
them.

1. **A public releases repository**, by default `Kyleidge/stratum-releases`.
   It holds only release assets (installer, blockmap and `latest.yml`), never
   source. Initialise it with a README so it has a default branch for release
   tags. Installed apps read its releases anonymously, so no token is ever
   embedded in the app.
2. **A publishing token** stored as the `RELEASES_TOKEN` Actions secret in
   this (source) repository: a fine-grained personal access token limited to
   the releases repository with **Contents: read and write**. Rotate it before
   it expires.
3. **Optional: code signing.** Unsigned installers work, but Windows
   SmartScreen warns about them until they build reputation. Choose one:
   - **Azure Trusted Signing** (usually the cheaper option, a monthly
     subscription without a hardware token). Create a Trusted Signing account
     and certificate profile, and an Entra ID app registration with the
     _Trusted Signing Certificate Profile Signer_ role. Then add the secrets
     `AZURE_TENANT_ID`, `AZURE_CLIENT_ID` and `AZURE_CLIENT_SECRET`, and the
     repository variables `AZURE_SIGNING_ENDPOINT` (for example
     `https://weu.codesigning.azure.net`), `AZURE_SIGNING_ACCOUNT`,
     `AZURE_SIGNING_PROFILE` and `AZURE_SIGNING_PUBLISHER` (the certificate's
     subject common name, exactly).
   - **A code-signing certificate file** (`.pfx`) from a certificate
     authority: add the secrets `CSC_LINK` (the file base64-encoded, or an
     HTTPS URL) and `CSC_KEY_PASSWORD`. Certificates issued on hardware tokens
     cannot be used from a hosted runner.

   Without these secrets the build is unsigned; nothing else changes. Keep a
   release line on one signing identity: electron-updater checks that an
   update is signed by the same publisher as the installed app.

## Cut a release

1. Update `version` in `package.json` and move the `CHANGELOG.md` entry from
   "Unreleased" to the release date. Commit to `main`.
2. Tag the commit and push the tag:

   ```powershell
   git tag v1.0.0
   git push origin v1.0.0
   ```

3. The **Release** workflow (`.github/workflows/release.yml`) runs on
   `windows-latest`: install, typecheck, tests, `desktop:build`, then
   `node desktop/package.mjs --publish`. It fails if the tag does not match
   `package.json`.
4. electron-builder uploads `Stratum-Setup-<version>.exe`, its `.blockmap`
   and `latest.yml` to a **draft** release in the releases repository. Check
   the draft (install it on a clean Windows account), add release notes from
   the changelog, and publish it. Installed copies only see published
   releases.

Pull requests that touch packaging files and manual runs (**Run workflow**)
build the installer without publishing and
attach it as the `stratum-windows-installer` workflow artifact.

## Build locally

```powershell
pnpm desktop:package           # Windows: installer and build/releases/win-unpacked
pnpm desktop:package --dir     # unpacked folder only
```

On macOS or Linux the same command produces an unpacked folder for that
platform, useful for checking the packaged app; `--win --dir` builds
`win-unpacked` from Linux, but the NSIS installer needs Windows (or Wine).
Output goes to `build/releases/` (ignored by Git).

`desktop/package.mjs` stages a minimal app in a temporary folder: every
`desktop/*.mjs` and `*.cjs` module except the build scripts, `dist-desktop/`,
the window icon, and only the main process's runtime packages
(`electron-updater` and its dependencies, copied out of pnpm's store). It
then runs electron-builder with the configuration in that file: app ID
`com.kyleidge.stratum`, ASAR packaging, `LICENSE.txt` and
`THIRD_PARTY_NOTICES.txt` in `resources/`.

## User data

Workspaces live in the Electron profile `%APPDATA%\Stratus` under the
`stratus://app` origin, from before the rename to Stratum. `desktop/main.mjs`
pins that folder before the app starts, so the installer, unpacked copies and
development runs all open the same workspace whatever the product name;
`tests/desktop-packaging.test.ts` guards it. Never change the folder, scheme
or origin without a migration. Uninstalling keeps the folder.

## Update feed

The feed is fixed at packaging time in `resources/app-update.yml`.
`desktop/package.mjs` uses a GitHub provider on `Kyleidge/stratum-releases`
unless these environment variables (repository variables in CI) say
otherwise:

| Variable               | Effect                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------ |
| `STRATUM_UPDATE_OWNER` | GitHub owner of the releases repository                                                    |
| `STRATUM_UPDATE_REPO`  | Name of the releases repository                                                            |
| `STRATUM_UPDATE_URL`   | Use a generic HTTPS folder instead (upload the installer, blockmap and `latest.yml` there) |

Do not point the feed at the private source repository: reading it would
require a token inside every installed copy.

At run time (`desktop/updater.mjs`) the installed app checks quietly ten
seconds after startup and from **Help → Check for updates…**, downloads in the
background, then asks to restart. Choosing **Later** installs the update when
Stratum quits. Updates are off for development runs, smoke tests, the report
mockup, non-Windows builds and copies without the installer's uninstaller
(such as `win-unpacked`).

## Licence notices

`pnpm desktop:build` writes `dist-desktop/THIRD_PARTY_NOTICES.txt`
(`desktop/notices.mjs`): the licence of every npm package whose code ends up
in the renderer or worker bundles, the stylesheets compiled into the CSS, and
the main process's runtime packages. Electron ships its own
`LICENSE.electron.txt` and `LICENSES.chromium.html` beside the executable.
**Help → Third-party notices** opens the file. Check new dependencies'
licences when adding them.

## Icon

`desktop/icons/stratum.svg` is the source. `pnpm desktop:icons` renders the
committed `icon.ico` (16–256 px, installer, executable and taskbar) and
`icon.png` (512 px window icon). Commit all three.
