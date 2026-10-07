// Drive the signal engine directly, without the UI or a browser: run the
// end-of-line batch example through SignalEngine (in-memory IndexedDB) and
// check every item's status. Run from the repository root:
//   "$NODE" --import ./tests/typescript-loader.mjs .claude/skills/run-stratum/engine-smoke.mjs
import 'fake-indexeddb/auto';

const lib = new URL('../../../lib/', import.meta.url);
const { SignalEngine } = await import(new URL('signal-engine.ts', lib).href);
const { EOL_COMPONENTS, EOL_WORKFLOW, componentFiles } = await import(
  new URL('eol-example.ts', lib).href
);
const { parseWorkflow, itemIdFromFileName } = await import(
  new URL('workflow-recipe.ts', lib).href
);
const { liveRunStatus, runProblems } = await import(
  new URL('workflow-checks.ts', lib).href
);

const recipe = parseWorkflow(EOL_WORKFLOW);
const engine = new SignalEngine(undefined, crypto.randomUUID());
await engine.open();
await engine.initializeWorkflow();
const batchId = crypto.randomUUID();
const started = performance.now();
for (const file of componentFiles())
  await engine.runWorkflow({
    recipe: EOL_WORKFLOW,
    batchId,
    batchName: 'Engine smoke',
    itemId: itemIdFromFileName(recipe, file.name),
    file,
  });
await engine.finishBatch(batchId, 'complete');
const steps = new Map(
  engine.project.workflowSteps.map((step) => [step.id, step]),
);
let failures = 0;
for (const run of engine.project.workflowBatches[0].runs) {
  const expected = EOL_COMPONENTS.find(
    (item) => item.serial === run.itemId,
  ).expected;
  const status = liveRunStatus(run, steps);
  if (status !== expected) failures++;
  const problem = runProblems(run, steps)[0]?.message ?? '';
  console.log(
    `${status === expected ? 'ok  ' : 'BAD '} ${run.itemId} ${status.padEnd(7)} ${problem}`,
  );
}
await engine.travel('undo');
console.log(
  `${engine.project.workflowBatches?.length ?? 0} batches after one Undo · ` +
    `${Math.round(performance.now() - started)} ms`,
);
engine.close();
process.exitCode = failures ? 1 : 0;
