# Stratum

A React/TypeScript Sites starter using vinext, Vite, Tailwind CSS v4, and
Cloudflare Workers. The current homepage is a placeholder; application features
have not yet been implemented. See AGENTS.md for architecture and conventions.

## Local setup

Install Git, Node.js >=22.13.0, and pnpm 11.19.0. If pnpm is not installed:

```sh
npm install --global pnpm@11.19.0
```

From the project directory:

```sh
pnpm install --frozen-lockfile
pnpm dev
```

On the first install, pnpm may report `ERR_PNPM_IGNORED_BUILDS` for the native
packages esbuild, sharp, and workerd. Run `pnpm approve-builds`, review the pending
packages, and select those three if you approve their installation scripts. Then
rerun `pnpm install --frozen-lockfile`. Keep any resulting project build-approval
configuration in Git so both computers use the reviewed policy. Do not enable
all dependency scripts globally.

Open the local URL printed by the development server. No application secrets are
currently required. Keep any future .env or .dev.vars files local and untracked.

```sh
pnpm lint
pnpm typecheck
pnpm exec oxfmt --check
pnpm build
pnpm start
```

`pnpm start` previews the completed build with Wrangler; build first. There is
currently no automated test suite. `pnpm format` rewrites formatting.

Initial setup validation: TypeScript passed. Oxlint reported 19 existing issues
in the starter components and mobile hook. These remain to be addressed during
application development; the Git setup does not change the app's behavior.

## Working on two computers

Use a separate local clone on each computer, such as a folder under your user
profile. The original project lives on a network share, which rejects pnpm's
symlinks. Install dependencies in each local clone rather than sharing them.

Install GitHub CLI for the following commands. After the private GitHub repository
has been created, sign in to GitHub CLI on
each computer with an account that can access it:

```sh
gh auth login --hostname github.com --git-protocol https --web
gh repo clone OWNER/Stratum
cd Stratum
pnpm install --frozen-lockfile
```

Replace OWNER with the actual GitHub repository owner. Clone into a new local
folder; preserve the original folder until all work is committed and pushed.

Before starting work in a clean checkout:

```sh
git status
git switch main
git pull --ff-only
pnpm install --frozen-lockfile
```

Before changing computers, review and commit the intended files, then push:

```sh
git diff
git add <files-you-changed>
git diff --cached
git commit -m "Describe the change"
git push
```

Uncommitted files do not travel through GitHub. Pull on the other computer before
editing. Use separate feature branches for simultaneous work. If a fast-forward
pull fails, reconcile the branches without discarding work or force-pushing.

Commit dependency changes with pnpm-lock.yaml. Keep credentials on each computer
outside Git. The tracked .openai/hosting.json contains non-secret configuration
required by Vite, so preserve it in clones.
