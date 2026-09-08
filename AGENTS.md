# Stratum: instructions for Codex

## Current purpose and scope

Stratum is currently a Sites web-app starter. The homepage renders a responsive
placeholder with "Your site is taking shape"; product-specific features are not
implemented yet. Do not infer business requirements from the project name.
There are no API routes, domain models, application persistence, or test suites.

## Architecture

- React 19 and strict TypeScript, with Next-style App Router conventions supplied
  by vinext. Use the existing vinext/Vite commands rather than replacing the stack.
- `app/page.tsx`: homepage; `app/layout.tsx`: root document, metadata, Geist fonts.
- `app/globals.css`: Tailwind CSS v4 imports and semantic light/dark theme tokens.
- `components/ui/`: reusable Base UI/shadcn primitives with Lucide icons.
- `lib/utils.ts`: `cn()` combines clsx and tailwind-merge.
- `hooks/use-mobile.ts`: shared mobile breakpoint hook (768px).
- `vite.config.ts`: vinext, Sites, Tailwind/PostCSS, Cloudflare Workers integration.
- `.openai/hosting.json`: portable, non-secret hosting configuration imported by
  Vite. Keep it tracked. Both D1 and R2 are currently null. Do not put credentials
  or actual environment values in it. Use Sites skills for future site work.
- `next.config.ts`, `tsconfig.json`, and `components.json`: framework compatibility,
  strict TypeScript with the `@/` root alias, and component generator configuration.

## Install and run

Use a local checkout on each computer. Windows network shares can reject pnpm
symlinks; do not share a working tree or node_modules between computers.

Prerequisites: Node.js >=22.13.0, Git, and pnpm 11.19.0 (pinned in package.json).
Install that pnpm version with `npm install --global pnpm@11.19.0` if necessary.
Run commands from the repository root:

- `pnpm install --frozen-lockfile`: install the committed dependency resolution.
- `pnpm dev`: start vinext; use the local URL printed by the development server.
- `pnpm build`: produce the Cloudflare-compatible build in dist/.
- `pnpm start`: preview the completed build with Wrangler, using
  dist/server/wrangler.json. Run the build first.

The first install can require pnpm approval for esbuild, sharp, and workerd native
build scripts. Use `pnpm approve-builds` to review pending scripts; do not disable
the dependency script policy globally. After approval, rerun the frozen install
and commit any resulting project policy file so it is shared across computers.

No application secrets or external service configuration are currently required.
Preserve package versions and pnpm-lock.yaml unless a requested change needs a
package update. For intentional dependency updates, run `pnpm install` and commit
package.json and pnpm-lock.yaml together. Do not introduce competing lockfiles.

## Validation

- `pnpm lint`: oxlint, including configured type-aware and typechecking checks.
- `pnpm typecheck`: TypeScript without emitting JavaScript.
- `pnpm exec oxfmt --check`: verify formatting without rewriting files.
- `pnpm format`: format files; keep formatting changes scoped to the task.
- `pnpm build`: check production compilation when application code changes.

Initial Git setup validation: TypeScript passed; oxlint reported 19 pre-existing
issues in the starter UI components and mobile hook. No app behavior was changed
to address those issues during repository setup.

There is no automated test runner or test script yet. Do not claim tests passed
when only lint, types, or a build ran. Add meaningful tests when implementing
behavior that warrants them, and document new test commands here. Report actual
validation failures and environmental blockers rather than hiding them.

## Development conventions

- Use function components, explicit TypeScript types, and the existing `@/` alias.
- Add 'use client' only where browser APIs, hooks, or interactive state need it.
- Reuse components/ui and cn(); preserve accessibility, keyboard behavior,
  data-slot attributes, and established class-variance-authority variants.
- Prefer semantic Tailwind theme tokens and keep light/dark themes consistent.
- Oxfmt uses single quotes and an 80-character print width.
- Follow .oxlintrc.json, including hook rules, prefer-const, and no explicit any.
- Keep Cloudflare server code compatible with Workers and ESM.
- Keep Wrangler logs and Miniflare state project-local, as configured in Vite.
- Preserve existing app behavior and dependencies unless the task needs a change.

## Git workflow

Apply this workflow automatically for every task. The user authorizes committing
and pushing the relevant changes from successful tasks; do not ask again solely
for those routine Git operations. Follow the active Codex permission controls and
report any authentication or approval blocker. AGENTS.md does not override them.

### At the beginning of every task

1. Check `git status` and the current branch before making changes. Note existing
   staged, unstaged, and untracked work so it stays separate from the task.
2. If the working tree is clean and an `origin` remote exists, fetch from origin
   and pull/rebase the current branch onto its corresponding remote branch before
   editing. Use the current branch's configured origin upstream when present;
   otherwise check for the same-named branch on origin. Never guess a different
   branch or silently switch branches. If no remote branch exists yet, keep the
   local branch and establish its upstream with the first push. If HEAD is
   detached or the upstream mapping is ambiguous, report it before syncing.
3. Never discard, overwrite, reset, or stash existing local changes just to
   perform a pull. Disable automatic stashing for pull/rebase operations, even if
   a machine's Git configuration enables it.
4. If local uncommitted changes make syncing unsafe, preserve them, skip the
   pull/rebase, and tell the user. Continue only task work that can safely coexist
   with those changes.

### At the end of every successful task that changed files

1. Run the project's tests/checks appropriate to the change. Read the current
   package scripts rather than assuming an old command is still correct. For a
   documentation-only change, check the edited document and `git diff --check`;
   application changes need the applicable tests, lint, types, and build checks.
   Report failures or checks that could not run; do not claim they passed.
2. Review both the working diff and the exact staged diff. Ensure the commit has
   no secrets, .env files, credentials, temporary files, build output, dependencies,
   machine-specific files, or unrelated changes. Stage only the task's relevant
   files or hunks; preserve any pre-existing staged work without committing it.
3. Commit the relevant changes with a concise descriptive commit message. Do not
   make an empty commit for a task that leaves no changes.
4. Before pushing, fetch from origin again. Fetching remote references is safe
   with a dirty working tree; it does not authorize pulling or rebasing that tree.
5. Check the fetched remote branch against the current branch. If the remote has
   moved and is not already an ancestor of the local branch, rebase safely onto
   that remote branch before pushing. Rebase only with a clean working tree and
   automatic stashing disabled. If unrelated local changes prevent rebasing, keep
   them and the task commit, stop before pushing, and tell the user. After a rebase,
   review the result and rerun checks appropriate to any affected changes.
6. Push the current branch to origin, using the verified remote branch mapping.
   Set its upstream on the first push. If origin is missing or authentication or
   permissions prevent pushing, retain the local commit and report the blocker.
   If the push is rejected because the remote moved again, fetch and repeat the
   same safe checks; never bypass them.
7. Never force-push unless the user explicitly asks. This includes force-with-lease.
8. If a merge/rebase conflict cannot be resolved confidently, stop and tell the
   user rather than guessing. Do not discard work to make the operation succeed.

Afterwards, tell the user what was committed, the final commit hash (after any
rebase), and whether the push succeeded. If no commit or push was made, state why.
Mention any local changes that remain uncommitted and therefore were not synced.

### Working across computers

- The main branch is `main`. Use a separate local clone on each computer and use
  GitHub to exchange commits; do not edit the same shared network checkout.
- Follow the start/end sync workflow above when changing computers. Uncommitted
  changes do not travel through GitHub. Install dependencies from the committed
  lockfile on each computer instead of sharing node_modules.
- Use separate feature branches for parallel work. Do not reset, clean, or
  discard someone else's work when reconciling branch history.
- Keep secrets separately configured on each computer; never store credentials
  in tracked files, Git remote URLs, or documentation.
- .gitattributes normalizes text to LF to prevent line-ending churn.
