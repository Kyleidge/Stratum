import { test } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { SignalEngine } from '../lib/signal-engine';
import {
  isRecordingName,
  openRecording,
  recordingFormat,
} from '../lib/formats/index';
import type { RecordingFile } from '../lib/formats/recording';

async function all(recording: RecordingFile, table = 0) {
  const time: number[] = [];
  const values: number[][] = recording.tables[table].channels.map(() => []);
  for await (const block of recording.read(table)) {
    time.push(...block.time);
    block.values.forEach((column, c) => values[c].push(...column));
  }
  return { time, values };
}

/** A canonical or WAVE_FORMAT_EXTENSIBLE header followed by `data`. */
function wav(
  tag: number,
  channels: number,
  rate: number,
  bits: number,
  data: Uint8Array,
  extensible = false,
) {
  const fmtSize = extensible ? 40 : 16;
  const bytes = new Uint8Array(12 + 8 + fmtSize + 8 + data.length + 10);
  const view = new DataView(bytes.buffer);
  const text = (at: number, value: string) =>
    value.split('').forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  text(0, 'RIFF');
  view.setUint32(4, bytes.length - 8, true);
  text(8, 'WAVE');
  // An odd-sized chunk before fmt checks word alignment.
  text(12, 'fmt ');
  view.setUint32(16, fmtSize, true);
  view.setUint16(20, extensible ? 0xfffe : tag, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, (rate * channels * bits) / 8, true);
  view.setUint16(32, (channels * bits) / 8, true);
  view.setUint16(34, bits, true);
  if (extensible) {
    view.setUint16(36, 22, true);
    view.setUint16(44, tag, true);
  }
  const data0 = 20 + fmtSize;
  text(data0, 'data');
  view.setUint32(data0 + 4, data.length, true);
  bytes.set(data, data0 + 8);
  return bytes;
}

void test('formats are recognised by content first, then by extension', async () => {
  const id = async (bytes: BlobPart, name: string) =>
    (await recordingFormat(new File([bytes], name))).id;
  assert.equal(await id('MDF     4.10    ', 'renamed.csv'), 'mdf');
  assert.equal(await id('TDSm', 'data.bin'), 'tdms');
  assert.equal(await id('t,a\n0,1\n', 'log.dat'), 'delimited');
  assert.equal(await id('t;a\n0;1\n', 'export'), 'delimited');
  assert.equal(await id('PK\u0003\u0004', 'book.xlsx'), 'xlsx');
  await assert.rejects(id('t,a', 'plot.png'), /\.png files are not supported/);
  await assert.rejects(
    id('not an MDF', 'log.mf4'),
    /contents do not match the \.mf4 extension/,
  );
  await assert.rejects(id('MATLAB 7.3 MAT-file', 'v73.mat'), /-v7/);
  await assert.rejects(id('TDSh', 'a.tdms_index'), /matching \.tdms/);
  assert.ok(isRecordingName('Run 1.MF4'));
  assert.ok(isRecordingName('a.tdms'));
  assert.ok(!isRecordingName('a.tdms_index'));
  assert.ok(!isRecordingName('notes.docx'));
});

void test('WAV PCM and float samples scale to full scale on a sample-rate clock', async () => {
  const pcm16 = new Uint8Array(
    new Int16Array([0, -32768, 16384, 32767]).buffer,
  );
  const stereo = await openRecording(
    new File([wav(1, 2, 4, 16, pcm16)], 'mic.wav'),
  );
  assert.equal(stereo.format, 'WAV PCM 16-bit, 4 Hz');
  assert.deepEqual(stereo.tables[0].channels, [
    { name: 'Channel 1', unit: 'FS' },
    { name: 'Channel 2', unit: 'FS' },
  ]);
  assert.deepEqual(await all(stereo), {
    time: [0, 0.25],
    values: [
      [0, 0.5],
      [-1, 32767 / 32768],
    ],
  });
  const pcm24 = new Uint8Array([0x00, 0x00, 0x80, 0xff, 0xff, 0x7f, 1, 0, 0]);
  const mono24 = await openRecording(
    new File([wav(1, 1, 1000, 24, pcm24, true)], 'accel.wav'),
  );
  assert.deepEqual((await all(mono24)).values, [
    [-1, 8388607 / 8388608, 1 / 8388608],
  ]);
  const float = new Uint8Array(new Float32Array([0.25, -2, 1.5]).buffer);
  const floats = await openRecording(
    new File([wav(3, 1, 2, 32, float)], 'probe.wav'),
  );
  assert.deepEqual(floats.tables[0].channels, [{ name: 'Audio', unit: '—' }]);
  assert.deepEqual(await all(floats), {
    time: [0, 0.5, 1],
    values: [[0.25, -2, 1.5]],
  });
  await assert.rejects(
    openRecording(
      new File([wav(2, 1, 8000, 4, new Uint8Array(8))], 'adpcm.wav'),
    ),
    /Only uncompressed PCM or floating-point WAV/,
  );
});

void test('imported WAV recordings keep their samples and clock', async (t) => {
  const e = new SignalEngine(undefined, crypto.randomUUID());
  await e.open();
  t.after(() => e.close());
  const samples = Int16Array.from({ length: 40000 }, (_, i) => (i % 200) - 100);
  const source = await e.importCsv(
    new File([wav(1, 1, 10000, 16, new Uint8Array(samples.buffer))], 'v.wav'),
  );
  assert.equal(source.name, 'v.wav');
  assert.equal(source.rows, 40000);
  assert.equal(source.chunks, 3);
  assert.deepEqual([source.start, source.end], [0, 3.9999]);
  const output: number[] = [];
  for await (const chunk of e.evaluate(source.channels[0]))
    output.push(...chunk.values);
  assert.equal(output.length, 40000);
  assert.equal(output[16384], ((16384 % 200) - 100) / 32768);
});

void test('a failed import names the file and publishes nothing', async (t) => {
  const e = new SignalEngine(undefined, crypto.randomUUID());
  await e.open();
  t.after(() => e.close());
  await assert.rejects(
    e.importCsv(new File([wav(1, 1, 1, 16, new Uint8Array(2))], 'one.wav')),
    /one\.wav: A recording needs at least two data rows\./,
  );
  await assert.rejects(
    e.importCsv(new File(['x'], 'scan.pdf')),
    /scan\.pdf: \.pdf files are not supported/,
  );
  assert.equal(e.project.sources.length, 0);
});
