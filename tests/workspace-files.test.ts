import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import 'fake-indexeddb/auto';
import { SignalEngine, WORKSPACE_SCHEMA_VERSION } from '../lib/signal-engine';
import {
  ARCHIVE_VERSION,
  ChunkedWriter,
  STREAM_CHUNK,
  archiveLines,
} from '../lib/workspace-archive';
import { APP_VERSION } from '../lib/app-version';
import {
  BACKUP_PATTERN,
  backupFileName,
  backupsToRemove,
  rotateBackups,
  safeFileName,
  writeFileAtomic,
} from '../desktop/backup-files.mjs';

/** Rows spanning several 16,384-sample chunks, with gaps and a µ unit. */
function csv(rows: number) {
  const lines = ['t,Torque [N·m],Current [µA]'];
  for (let i = 0; i < rows; i++)
    lines.push(`${i / 100},${i % 97 === 0 ? '' : Math.sin(i / 50)},${i * 0.5}`);
  return lines.join('\n');
}
async function fixture(rows = 40000) {
  const engine = new SignalEngine(undefined, crypto.randomUUID());
  await engine.open();
  await engine.initializeWorkflow();
  const source = await engine.importCsv(
    new File([csv(rows)], 'Prüfstand ✓.csv'),
  );
  const scaled = await engine.derive(source.channels[0], 'scale', 2);
  await engine.calculateValues([scaled.id], 'maximum');
  await engine.rename(scaled.id, 'Doppelt µ ✓');
  return { engine, source, scaled };
}
async function target() {
  const engine = new SignalEngine(undefined, crypto.randomUUID());
  await engine.open();
  await engine.initializeWorkflow();
  return engine;
}
async function samples(engine: SignalEngine, id: string) {
  const values: number[] = [];
  for await (const chunk of engine.evaluate(id))
    for (let i = 0; i < chunk.time.length; i++)
      values.push(chunk.time[i], chunk.values[i]);
  return values;
}
/** Collects a streamed backup, checking one write at a time. */
async function streamedBackup(engine: SignalEngine) {
  const chunks: Uint8Array[] = [];
  let writing = false;
  const bytes = await engine.writeBackup(async (chunk) => {
    assert.ok(!writing, 'The writer must wait for each write.');
    writing = true;
    await new Promise((resolve) => setTimeout(resolve, 0));
    chunks.push(chunk);
    writing = false;
  });
  return { chunks, bytes };
}
function join8(chunks: Uint8Array[]) {
  return new Uint8Array(Buffer.concat(chunks));
}
/** A byte stream that re-splits `bytes` at the given sizes, cycling. */
function stream(bytes: Uint8Array, sizes: number[]) {
  let offset = 0,
    turn = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      const size = sizes[turn++ % sizes.length];
      controller.enqueue(bytes.slice(offset, offset + size));
      offset += size;
    },
  });
}

void test('a streamed backup is written in bounded chunks and restores exactly from any chunking', async () => {
  const { engine, source, scaled } = await fixture();
  try {
    const { chunks, bytes } = await streamedBackup(engine);
    const archive = join8(chunks);
    assert.equal(archive.length, bytes);
    assert.ok(chunks.length > 1, 'A large backup must be written in pieces.');
    const longest = Math.max(
      ...new TextDecoder()
        .decode(archive)
        .split('\n')
        .map((line) => Buffer.byteLength(line) + 1),
    );
    for (const chunk of chunks)
      assert.ok(chunk.length < STREAM_CHUNK + longest, 'Chunk too large');
    // The Blob path produces the same archive apart from its creation time.
    const blob = new Uint8Array(
      await (await engine.backupWorkspace()).arrayBuffer(),
    );
    const withoutTime = (text: string) =>
      text.replace(/"createdAt":"[^"]+"/, '');
    assert.equal(
      withoutTime(new TextDecoder().decode(blob)),
      withoutTime(new TextDecoder().decode(archive)),
    );
    const header = JSON.parse(
      new TextDecoder().decode(archive).split('\n', 1)[0],
    ) as Record<string, unknown>;
    assert.equal(header.format, 'stratus-workspace');
    assert.equal(header.version, ARCHIVE_VERSION);
    assert.equal(header.app, APP_VERSION);
    assert.equal(header.schema, WORKSPACE_SCHEMA_VERSION);
    assert.ok(!Number.isNaN(Date.parse(header.createdAt as string)));
    // Odd sizes split lines, numbers and multi-byte characters.
    for (const sizes of [[1, 2, 3, 5, 7, 4093], [65536], [STREAM_CHUNK * 3]]) {
      const restored = await target();
      try {
        await restored.restoreWorkspace(stream(archive, sizes));
        assert.deepEqual(
          await samples(restored, scaled.id),
          await samples(engine, scaled.id),
        );
        assert.deepEqual(
          await samples(restored, source.channels[1]),
          await samples(engine, source.channels[1]),
        );
        assert.equal(restored.project.labels?.[scaled.id], 'Doppelt µ ✓');
        assert.equal(restored.undoLabel, 'Restore workspace backup');
      } finally {
        restored.close();
      }
    }
  } finally {
    engine.close();
  }
});

void test('truncated, corrupt, foreign and newer backups are rejected before replacing the workspace', async () => {
  const { engine, scaled } = await fixture(20000);
  const restored = await target();
  try {
    const archive = join8((await streamedBackup(engine)).chunks);
    const text = new TextDecoder().decode(archive);
    const lines = text.trimEnd().split('\n');
    await restored.restoreWorkspace(stream(archive, [99991]));
    const before = structuredClone(restored.project);
    const expected = await samples(restored, scaled.id);
    const header = JSON.parse(lines[0]) as Record<string, unknown>;
    const encode = (value: string) => new TextEncoder().encode(value);
    const cases: [Uint8Array, RegExp][] = [
      // Missing completion record, then cut inside a sample record.
      [encode(lines.slice(0, -1).join('\n')), /truncated/],
      [
        archive.slice(0, Math.floor(archive.length * 0.6)),
        /valid workspace backup|truncated/,
      ],
      // Invalid UTF-8 inside a record.
      [
        new Uint8Array([
          ...encode(lines[0] + '\n{"sourceId":"'),
          0xff,
          0xfe,
          ...encode('"}\n'),
        ]),
        /valid workspace backup/,
      ],
      [
        encode(JSON.stringify({ ...header, format: 'other' }) + '\n'),
        /not a Stratum workspace backup/,
      ],
      [
        encode(
          [
            JSON.stringify({ ...header, version: ARCHIVE_VERSION + 1 }),
            ...lines.slice(1),
          ].join('\n'),
        ),
        new RegExp(
          `newer version of Stratum \\(backup format ${ARCHIVE_VERSION + 1}\\)`,
        ),
      ],
      [
        encode(JSON.stringify({ ...header, version: '1' }) + '\n'),
        /version is not supported/,
      ],
      [
        encode([lines[0], lines[1], lines[1], ...lines.slice(2)].join('\n')),
        /Duplicate/,
      ],
      [encode([...lines, '{"extra":true}'].join('\n')), /extra/],
    ];
    for (const [bytes, message] of cases) {
      await assert.rejects(
        () => restored.restoreWorkspace(stream(bytes, [4096])),
        message,
      );
      assert.deepEqual(restored.project, before);
      assert.deepEqual(await samples(restored, scaled.id), expected);
    }
  } finally {
    engine.close();
    restored.close();
  }
});

void test('archive limits apply to browser Blobs and oversized records, not native streams', async () => {
  await assert.rejects(async () => {
    for await (const _ of archiveLines(new Blob(['{}\n'.repeat(40)]), 100)) {
      // Drain.
    }
  }, /limited to 128 MiB/);
  // An explicit limit also caps a stream as it is read.
  await assert.rejects(async () => {
    for await (const _ of archiveLines(
      stream(new TextEncoder().encode('{}\n'.repeat(400)), [64]),
      200,
    )) {
      // Drain.
    }
  }, /limited to 128 MiB/);
  // A single record larger than 32 MiB is refused without reading further.
  const block = new TextEncoder().encode('x'.repeat(1024 * 1024));
  let pulled = 0;
  const endless = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled++;
      controller.enqueue(block);
    },
  });
  await assert.rejects(async () => {
    for await (const _ of archiveLines(endless)) {
      // Drain.
    }
  }, /too large/);
  assert.ok(pulled < 40, 'Reading must stop at the record limit.');
  // ChunkedWriter enforces a byte limit and flushes in order.
  const written: string[] = [];
  const writer = new ChunkedWriter(
    (bytes) => {
      written.push(new TextDecoder().decode(bytes));
    },
    10,
    'Too big.',
    4,
  );
  await writer.write('abc');
  await writer.write('def');
  await assert.rejects(() => writer.write('ghijk'), /Too big/);
  assert.deepEqual(written, ['abcdef']);
});

void test('a backup refuses metadata that would not restore, and samples stream like the Blob export', async () => {
  const { engine, source, scaled } = await fixture(20000);
  try {
    const streamed: Uint8Array[] = [];
    await engine.writeSamples([scaled.id, source.channels[1]], (bytes) => {
      streamed.push(bytes);
    });
    assert.equal(
      new TextDecoder().decode(join8(streamed)),
      await (
        await engine.exportSamples([scaled.id, source.channels[1]])
      ).text(),
    );
    const node = engine.project.nodes.find((item) => item.id === scaled.id)!;
    node.parameters.value = Number.NaN;
    await assert.rejects(
      () => engine.writeBackup(() => {}),
      /cannot be backed up/,
    );
  } finally {
    engine.close();
  }
});

void test('automatic backup names, safe file names and rotation keep only the newest backups', async () => {
  const name = backupFileName(new Date(2026, 9, 7, 9, 5, 3));
  assert.equal(name, 'Stratum-backup-2026-10-07_09-05-03.stratum');
  assert.match(name, BACKUP_PATTERN);
  assert.equal(
    backupFileName(new Date(2026, 9, 7, 9, 5, 3), new Set([name])),
    'Stratum-backup-2026-10-07_09-05-03-2.stratum',
  );
  assert.equal(safeFileName('a/b\\c:d*?.csv', 'csv'), 'c_d__.csv');
  assert.equal(safeFileName('CON', 'stratum'), 'Stratum-CON.stratum');
  assert.equal(safeFileName('report. ', 'csv'), 'report.csv');
  assert.equal(safeFileName('', 'csv'), 'Stratum.csv');
  assert.ok(safeFileName('x'.repeat(400), 'csv').length <= 180);
  assert.deepEqual(
    backupsToRemove(
      [
        { name: 'Stratum-backup-2026-01-01_00-00-01.stratum', mtimeMs: 3 },
        { name: 'Stratum-backup-2026-01-01_00-00-02.stratum', mtimeMs: 1 },
        { name: 'Stratum-backup-2026-01-01_00-00-03.stratum', mtimeMs: 2 },
        { name: 'My own backup.stratum', mtimeMs: 0 },
      ],
      2,
    ),
    ['Stratum-backup-2026-01-01_00-00-02.stratum'],
  );

  const folder = await mkdtemp(join(tmpdir(), 'stratum-rotation-'));
  try {
    const start = Date.now() / 1000 - 1000;
    for (let i = 0; i < 13; i++) {
      const file = join(folder, backupFileName(new Date(2026, 0, 1, 0, 0, i)));
      await writeFile(file, String(i));
      await utimes(file, start + i, start + i);
    }
    await writeFile(join(folder, 'notes.txt'), 'keep');
    const stale = join(
      folder,
      '.Stratum-backup-2026-01-01_00-00-00.stratum.0123456789ab.partial',
    );
    const active = join(
      folder,
      '.Stratum-backup-2026-01-01_00-00-01.stratum.ba9876543210.partial',
    );
    const fresh = join(
      folder,
      '.Stratum-backup-2026-01-01_00-00-02.stratum.aaaaaaaaaaaa.partial',
    );
    for (const file of [stale, active, fresh]) await writeFile(file, 'partial');
    const old = Date.now() / 1000 - 2 * 3600;
    await utimes(stale, old, old);
    await utimes(active, old, old);
    const removed = await rotateBackups(folder, 10, new Set([active]));
    assert.equal(removed.length, 4);
    const left = (await readdir(folder)).sort();
    assert.equal(left.filter((item) => BACKUP_PATTERN.test(item)).length, 10);
    assert.ok(!left.includes('Stratum-backup-2026-01-01_00-00-00.stratum'));
    assert.ok(left.includes('Stratum-backup-2026-01-01_00-00-12.stratum'));
    assert.ok(left.includes('notes.txt'));
    assert.ok(!left.some((item) => item.includes('0123456789ab')));
    assert.ok(left.some((item) => item.includes('ba9876543210')));
    assert.ok(left.some((item) => item.includes('aaaaaaaaaaaa')));

    // Atomic writes replace the target and leave no temporary file.
    const target = join(folder, 'settings.json');
    await writeFileAtomic(target, Buffer.from('one'));
    await writeFileAtomic(target, Buffer.from('two'));
    assert.equal(await readFile(target, 'utf8'), 'two');
    assert.ok(
      !(await readdir(folder)).some((item) => item.startsWith('.settings')),
    );
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
