// Regenerates the end-of-line example recordings and workflow in this folder.
// Run from the repository root: pnpm examples:eol
import { writeFile } from 'node:fs/promises';
import {
  componentRecording,
  EOL_COMPONENTS,
  EOL_WORKFLOW,
  EOL_WORKFLOW_NAME,
} from '../../lib/eol-example';

const folder = new URL('./', import.meta.url);
for (const component of EOL_COMPONENTS) {
  const { name, text } = componentRecording(
    component.serial,
    component.variant,
  );
  await writeFile(new URL(name, folder), text);
}
await writeFile(new URL(EOL_WORKFLOW_NAME, folder), EOL_WORKFLOW);
process.stdout.write(
  `Wrote ${EOL_COMPONENTS.length} recordings and ${EOL_WORKFLOW_NAME}.\n`,
);
