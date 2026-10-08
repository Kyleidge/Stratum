# Releasing Stratum

Stratum ships as a Windows (x64) desktop app: an NSIS installer that installs
for the current user, adds Start-menu and desktop shortcuts and an
uninstaller, and updates itself from this public repository's GitHub
releases.

## One-time setup

The update feed needs no setup: the Release workflow publishes to this
repository with its own `GITHUB_TOKEN`, and installed apps read the releases
anonymously, so no token is ever embedded in the app. The repository must stay
public for that; a private one would need a token in every installed copy.

**Optional: code signing.** Unsigned installers work, but Windows
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
2. Tag the commit with `v` and that version, and push the tag:

   ```powershell
   git tag v1.0.0
   git push origin v1.0.0
   ```

3. The **Release** workflow (`.github/workflows/release.yml`) runs on
   `windows-latest`: install, typecheck, tests, `desktop:build`, then
   `node desktop/package.mjs --publish`. It fails if the tag does not match
   `package.json`.
4. electron-builder uploads `Stratum-Setup-<version>.exe`, its `.blockmap`
   and `latest.yml` to a **draft** release in this repository. Check the
   draft (install it on a clean Windows account), add release notes from the
   changelog, and publish it. Installed copies only see published releases.

### Beta releases

Test builds use a `beta` prerelease version, such as `1.1.0-beta.1` (tag
`v1.1.0-beta.1`). The workflow marks their drafts as prereleases; keep that
box ticked when publishing. Then:

- Stable installs never see betas: they read only GitHub's latest full
  release.
- A beta install updates to the newest published release, beta or stable,
  so testers move on to `1.1.0` when it ships.

Use `beta` (or `alpha`) only. electron-updater treats any other name, such as
`preview`, as a separate channel whose installs never move to a stable
release. Number betas below the release they lead to: `1.1.0-beta.1` comes
before `1.1.0`.

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
`desktop/package.mjs` uses a GitHub provider on `Kyleidge/Stratum` unless
these environment variables (repository variables in CI) say otherwise:

| Variable               | Effect                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------ |
| `STRATUM_UPDATE_OWNER` | GitHub owner of the releases repository                                                    |
| `STRATUM_UPDATE_REPO`  | Name of the releases repository                                                            |
| `STRATUM_UPDATE_URL`   | Use a generic HTTPS folder instead (upload the installer, blockmap and `latest.yml` there) |

A feed in another GitHub repository also needs a `RELEASES_TOKEN` Actions
secret: a fine-grained token limited to that repository with **Contents: read
and write**. The workflow then can't mark beta drafts there as prereleases, so
tick the box yourself. Never point the feed at a private repository: reading it
would require a token inside every installed copy.

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
