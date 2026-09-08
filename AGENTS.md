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

## Git and working across computers

- The main branch is `main`. Use a separate local clone on each computer and use
  GitHub to exchange commits; do not edit the same shared network checkout.
- Before work: inspect `git status`, switch to the intended branch, and run
  `git pull --ff-only` when the working tree is clean and an upstream exists.
- Before switching computers: review the diff, commit the intended files, and
  push. On the other computer, pull and install with the frozen lockfile.
- For parallel work, use different feature branches. If a fast-forward pull
  fails, inspect the divergence; do not reset, clean, force-push, or discard work.
- Keep .env files, credentials, dependencies, builds, caches, logs, and
  machine-specific configuration out of commits. Review staged files for secrets.
- Keep secrets separately configured on each computer; do not send them via Git.
- .gitattributes normalizes text to LF to prevent line-ending churn.
- Never store authentication tokens in tracked files, Git remote URLs, or docs.
