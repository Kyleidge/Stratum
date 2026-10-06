/**
 * WAV (RIFF/RF64) recordings from acoustic and vibration acquisition: PCM
 * integers of 8–32 bits and 32/64-bit floats. Integer samples are scaled to
 * full scale (−1…1); time is the sample number divided by the sample rate.
 */
import { BLOCK_ROWS, BlobBytes, MAX_RECORDING_CHANNELS } from './recording';
import type { RecordingBlock, RecordingFile } from './recording';

const PCM = 1;
const FLOAT = 3;
const EXTENSIBLE = 0xfffe;

export async function openWav(file: Blob): Promise<RecordingFile> {
  const bytes = new BlobBytes(file, 65536);
  const riff = await bytes.view(0, 12);
  const rf64 = riff.getUint32(0) === 0x52463634;
  let dataSize64: number | undefined;
  let format:
    | { tag: number; channels: number; rate: number; bits: number }
    | undefined;
  let data: { offset: number; size: number } | undefined;
  // Chunks are word-aligned; a damaged size stops at the end of the file.
  for (let offset = 12; offset + 8 <= bytes.size;) {
    const header = await bytes.view(offset, 8);
    const id = String.fromCharCode(
      ...[0, 1, 2, 3].map((i) => header.getUint8(i)),
    );
    let size = header.getUint32(4, true);
    const body = offset + 8;
    if (id === 'ds64') {
      const ds64 = await bytes.view(body, 16);
      dataSize64 = Number(ds64.getBigUint64(8, true));
    } else if (id === 'fmt ') {
      const fmt = await bytes.view(body, Math.min(size, 40));
      let tag = fmt.getUint16(0, true);
      if (tag === EXTENSIBLE && size >= 26) tag = fmt.getUint16(24, true);
      format = {
        tag,
        channels: fmt.getUint16(2, true),
        rate: fmt.getUint32(4, true),
        bits: fmt.getUint16(14, true),
      };
    } else if (id === 'data') {
      if (rf64 && size === 0xffffffff && dataSize64 !== undefined)
        size = dataSize64;
      data = { offset: body, size: Math.min(size, bytes.size - body) };
      break;
    }
    offset = body + size + (size % 2);
  }
  if (!format) throw new Error('The WAV file has no format description.');
  if (!data) throw new Error('The WAV file has no audio data.');
  const { tag, channels, rate, bits } = format;
  const integer = tag === PCM && [8, 16, 24, 32].includes(bits);
  const float = tag === FLOAT && (bits === 32 || bits === 64);
  if (!integer && !float)
    throw new Error(
      'Only uncompressed PCM or floating-point WAV files can be imported.',
    );
  if (!channels || !rate) throw new Error('The WAV format is damaged.');
  if (channels > MAX_RECORDING_CHANNELS)
    throw new Error(
      `The WAV file has ${channels.toLocaleString()} channels; a recording can have at most ${MAX_RECORDING_CHANNELS.toLocaleString()}.`,
    );
  const width = bits / 8;
  const frame = width * channels;
  const rows = Math.floor(data.size / frame);
  const sample = (view: DataView, at: number) => {
    if (float)
      return bits === 32
        ? view.getFloat32(at, true)
        : view.getFloat64(at, true);
    if (bits === 8) return (view.getUint8(at) - 128) / 128;
    if (bits === 16) return view.getInt16(at, true) / 32768;
    if (bits === 24)
      return (
        (view.getUint8(at) |
          (view.getUint8(at + 1) << 8) |
          (view.getInt8(at + 2) << 16)) /
        8388608
      );
    return view.getInt32(at, true) / 2147483648;
  };
  const names = Array.from({ length: channels }, (_, c) =>
    channels === 1 ? 'Audio' : `Channel ${c + 1}`,
  );

  async function* read(): AsyncGenerator<RecordingBlock> {
    for (let first = 0; first < rows; first += BLOCK_ROWS) {
      const count = Math.min(BLOCK_ROWS, rows - first);
      const view = await bytes.view(
        data!.offset + first * frame,
        count * frame,
      );
      const time = new Float64Array(count);
      const values = names.map(() => new Float64Array(count));
      for (let r = 0; r < count; r++) {
        time[r] = (first + r) / rate;
        for (let c = 0; c < channels; c++)
          values[c][r] = sample(view, r * frame + c * width);
      }
      yield { time, values, progress: (first + count) / rows };
    }
  }

  return {
    format: `WAV ${float ? 'float' : 'PCM'} ${bits}-bit, ${rate.toLocaleString()} Hz`,
    tables: [
      {
        name: '',
        channels: names.map((name) => ({ name, unit: integer ? 'FS' : '—' })),
        rows,
        start: 0,
        end: (rows - 1) / rate,
      },
    ],
    notes: integer
      ? [
          'Samples are scaled to full scale (FS, −1 to 1); apply your sensor calibration with Derive.',
        ]
      : [],
    read,
  };
}
