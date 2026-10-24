// The persisted format versions a build writes (docs/file-format-stability.md):
// a build that raises one leaves data that earlier builds refuse. Packaging
// records them in the app's package.json and pull request test builds in
// their release notes, so the app can warn before switching builds.
//
//   node desktop/format-versions.mjs     prints them as JSON
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Each format: its source file and constant. */
export const FORMAT_SOURCES = {
  workspace: ['lib/signal-engine.ts', 'WORKSPACE_SCHEMA_VERSION'],
  backup: ['lib/workspace-archive.ts', 'ARCHIVE_VERSION'],
  workflow: ['lib/workflow-recipe.ts', 'WORKFLOW_VERSION'],
};

/** `read(path)` returns a repository file's text. */
export function formatVersions(read) {
  return Object.fromEntries(
    Object.entries(FORMAT_SOURCES).map(([format, [file, name]]) => {
      const match = new RegExp(`export const ${name} = (\\d+);`).exec(
        read(file),
      );
      if (!match) throw new Error(`${file} no longer declares ${name}.`);
      return [format, Number(match[1])];
    }),
  );
}

export const repositoryFormatVersions = () =>
  formatVersions((file) =>
    readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'),
  );

if (process.argv[1] === fileURLToPath(import.meta.url))
  process.stdout.write(`${JSON.stringify(repositoryFormatVersions())}\n`);
