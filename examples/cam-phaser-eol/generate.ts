// Regenerates the cam phaser example recordings and workflow in this folder.
// Run from the repository root: pnpm examples:phaser
import { writeFile } from 'node:fs/promises';
import {
  PHASER_UNITS,
  PHASER_WORKFLOW,
  PHASER_WORKFLOW_NAME,
  phaserRecording,
} from '../../lib/cam-phaser-example';

const folder = new URL('./', import.meta.url);
for (const unit of PHASER_UNITS) {
  const { name, text } = phaserRecording(unit.serial, unit.variant);
  await writeFile(new URL(name, folder), text);
}
await writeFile(new URL(PHASER_WORKFLOW_NAME, folder), PHASER_WORKFLOW);
process.stdout.write(
  `Wrote ${PHASER_UNITS.length} recordings and ${PHASER_WORKFLOW_NAME}.\n`,
);
