/**
 * Recording formats Stratum can import. Each entry recognises its files by
 * content where possible and by extension otherwise; parsers load lazily so
 * the application bundle only carries the readers a session actually uses.
 */
import type { DelimitedLayout } from './delimited-layout';
import type { RecordingFile } from './recording';

type Opener = (file: Blob) => Promise<RecordingFile>;
export type RecordingFormat = {
  id: string;
  /** Short name for menus and messages. */
  label: string;
  /** Lower-case extensions including the dot. */
  extensions: readonly string[];
  /** Content signature, checked before extensions; absent for plain text. */
  sniff?: (head: Uint8Array) => boolean;
  load: () => Promise<Opener>;
};

const ascii = (head: Uint8Array, offset: number, text: string) =>
  text.length + offset <= head.length &&
  text.split('').every((c, i) => head[offset + i] === c.charCodeAt(0));

export const RECORDING_FORMATS: readonly RecordingFormat[] = [
  {
    id: 'delimited',
    label: 'CSV and delimited text',
    extensions: ['.csv', '.tsv', '.tab', '.txt'],
    load: async () => (await import('./delimited')).openDelimited,
  },
  {
    id: 'mdf',
    label: 'ASAM MDF 4 and 3',
    extensions: ['.mf4', '.mdf', '.dat'],
    sniff: (head) => ascii(head, 0, 'MDF     ') || ascii(head, 0, 'UnFinMF '),
    load: async () => (await import('./mdf')).openMdf,
  },
  {
    id: 'tdms',
    label: 'NI TDMS',
    extensions: ['.tdms'],
    sniff: (head) => ascii(head, 0, 'TDSm'),
    load: async () => (await import('./tdms')).openTdms,
  },
  {
    id: 'mat',
    label: 'MATLAB MAT',
    extensions: ['.mat'],
    sniff: (head) => ascii(head, 0, 'MATLAB 5.0 MAT-file'),
    load: async () => (await import('./mat')).openMat,
  },
  {
    id: 'wav',
    label: 'WAV audio',
    extensions: ['.wav'],
    sniff: (head) =>
      (ascii(head, 0, 'RIFF') || ascii(head, 0, 'RF64')) &&
      ascii(head, 8, 'WAVE'),
    load: async () => (await import('./wav')).openWav,
  },
  {
    id: 'xlsx',
    label: 'Excel workbook',
    extensions: ['.xlsx', '.xlsm'],
    load: async () => (await import('./xlsx')).openXlsx,
  },
];

/** The file input `accept` list for every supported recording. */
export const RECORDING_ACCEPT = [
  ...RECORDING_FORMATS.flatMap((format) => format.extensions),
  'text/csv',
].join(',');

/** A sentence naming the supported formats, for messages and help text. */
export const RECORDING_FORMAT_LIST =
  'CSV, TSV or TXT text, MDF 4/3 (.mf4, .mdf, .dat), TDMS, MATLAB .mat, WAV and Excel .xlsx';

const extension = (name: string) => {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot).toLowerCase();
};

/** True when a file name has an extension Stratum may be able to import. */
export function isRecordingName(name: string) {
  const ext = extension(name);
  return RECORDING_FORMATS.some((format) => format.extensions.includes(ext));
}

/** Content signatures win over extensions, so a renamed MDF still opens. */
export async function recordingFormat(
  file: Blob & { name?: string },
): Promise<RecordingFormat> {
  const head = new Uint8Array(await file.slice(0, 4096).arrayBuffer());
  const signed = RECORDING_FORMATS.find((format) => format.sniff?.(head));
  if (signed) return signed;
  const ext = extension(file.name ?? '');
  if (ascii(head, 0, 'MATLAB 7.3 MAT-file'))
    throw new Error(
      'This is a MATLAB v7.3 (HDF5) file. Save it in MATLAB with save(…, "-v7") and import it again.',
    );
  if (ext === '.tdms_index')
    throw new Error(
      'This is a TDMS index file. Import the matching .tdms file instead.',
    );
  const named = RECORDING_FORMATS.find((format) =>
    format.extensions.includes(ext),
  );
  // MAT v4 has no signature; an unsigned .dat is treated as text.
  if (named && (!named.sniff || named.id === 'mat')) return named;
  if (ext === '.dat' || !ext)
    return RECORDING_FORMATS.find((format) => format.id === 'delimited')!;
  if (named)
    throw new Error(
      `The contents do not match the ${ext} extension. The file may be damaged, or saved in another format.`,
    );
  throw new Error(
    `${ext} files are not supported. Import ${RECORDING_FORMAT_LIST}.`,
  );
}

/**
 * Reads a file's metadata (tables, channels, notes) without its samples. A
 * column layout applies to delimited text only; other formats ignore it.
 */
export async function openRecording(
  file: Blob & { name?: string },
  options: { layout?: DelimitedLayout } = {},
): Promise<RecordingFile & { formatId: string }> {
  const format = await recordingFormat(file);
  const recording =
    format.id === 'delimited'
      ? await (await import('./delimited')).openDelimited(file, options.layout)
      : await (
          await format.load()
        )(file);
  return Object.assign(recording, { formatId: format.id });
}
