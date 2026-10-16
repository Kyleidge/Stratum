'use client';
import { useState } from 'react';
import type { SignalEngineState } from '@/hooks/use-signal-engine';
import {
  needsImportSetup,
  plainImportSetup,
  type ImportSetup,
} from '@/components/workflow-import-dialog';
import { importError } from '@/lib/csv-import-messages';
import { openRecording } from '@/lib/formats/index';
import type { RecordingFile } from '@/lib/formats/recording';
import type { Project } from '@/lib/signal-types';

/**
 * Imports recordings one at a time. Files that need setup (text columns,
 * several groups or units to fix) wait in `importChoice` for the import
 * dialog; notes about what was kept are announced once all are imported.
 */
export function useRecordingImport({
  project,
  engine,
  reveal,
  setSourceId,
  announceChange,
}: {
  project: Project;
  engine: SignalEngineState;
  /** Selects the newest step after each import. */
  reveal: (next: Project) => void;
  setSourceId: (id: string) => void;
  announceChange: (message: string) => void;
}) {
  // A multi-group file waits here until its groups are chosen.
  const [importChoice, setImportChoice] = useState<{
    file: File;
    recording: RecordingFile;
    resolve: (setup?: ImportSetup) => void;
  } | null>(null);
  function importFiles(selected: File[]) {
    if (!selected.length) return;
    void (async () => {
      const notes = new Set<string>();
      let known = new Set(project.sources.map((source) => source.id));
      let added = 0;
      for (const item of selected) {
        // Metadata only: text columns, several groups or units to fix ask first.
        let recording: RecordingFile;
        try {
          recording = await openRecording(item);
        } catch (error) {
          const named = importError(error, item.name);
          engine.setError(
            named instanceof Error ? named.message : String(named),
          );
          continue;
        }
        const setup = needsImportSetup(recording)
          ? await new Promise<ImportSetup | undefined>((resolve) =>
              setImportChoice({ file: item, recording, resolve }),
            )
          : plainImportSetup(recording);
        if (!setup) continue;
        const next = await engine.mutate(
          { type: 'import', file: item, ...setup },
          `Importing ${item.name}…`,
        );
        reveal(next);
        for (const note of recording.notes ?? []) notes.add(note);
        if (!setup.layout)
          for (const index of setup.tables)
            for (const note of recording.tables[index]?.notes ?? [])
              notes.add(note);
        if (setup.custom.length)
          notes.add(
            `Kept as custom units, which never convert: ${setup.custom.join(', ')}.`,
          );
        added += next.sources.filter((s) => !known.has(s.id)).length;
        known = new Set(next.sources.map((source) => source.id));
      }
      if (added > 1) setSourceId('all');
      // Gentle hints, not errors: the recordings imported correctly.
      if (notes.size) announceChange(`Imported. ${[...notes].join(' ')}`);
    })().catch(() => {});
  }
  return { importChoice, setImportChoice, importFiles };
}
