# Recording file formats

Stratum imports recordings from the files below. Everything is read locally in
the signal worker; no file leaves the device. Readers live in `lib/formats/`
and share one contract (`lib/formats/recording.ts`): a file holds one or more
**tables**, each with a single time axis in seconds and one or more numeric
channels. Each imported table becomes one recording.

| Format                 | Extensions                  | Recognised by                     |
| ---------------------- | --------------------------- | --------------------------------- |
| CSV and delimited text | `.csv` `.tsv` `.tab` `.txt` | extension (also unsigned `.dat`)  |
| ASAM MDF 4 and 3       | `.mf4` `.mdf` `.dat`        | `MDF     ` / `UnFinMF ` signature |
| NI TDMS                | `.tdms`                     | `TDSm` signature                  |
| MATLAB MAT v4–v7       | `.mat`                      | v5 header text; v4 by extension   |
| WAV                    | `.wav`                      | `RIFF`/`RF64` … `WAVE`            |
| Excel workbook         | `.xlsx` `.xlsm`             | extension                         |

Content signatures win over extensions, so a renamed MDF file still opens.
MATLAB v7.3 files are HDF5 and are rejected with a hint to save with `-v7`;
TDMS index files (`.tdms_index`) point to their `.tdms` file.

## Importing

- Delimited text always opens **Import _file_** to set up its columns (below).
  Other single-table files import at once unless a unit needs fixing.
- **Units are checked.** Every signal needs a unit Stratum recognises
  (`lib/units.ts`: registered units such as `rpm`, `Nm`, `°C`, SI-prefixed
  units such as `kN` or `mbar`, and compounds such as `m/s²`, `g/kWh` or
  `W/(m²·K)`), **No unit**, or a label the user keeps as a **custom unit**,
  which never converts. Units that are missing or not recognised are listed
  in the dialog with suggestions (`C` → `°C`, `KPA` → `kPa`, `-` → No unit);
  Import stays disabled until each is fixed, and the engine checks the units
  again before publishing. Recognised labels keep the file's spelling (`Nm`
  stays `Nm`); `sameUnit` treats spellings of one unit as equal. For binary
  files one fix covers every signal with the same unrecognised label; signals
  without a unit are fixed one by one or all at once with No unit.
- A file with several tables (MDF channel groups, TDMS groups or time bases,
  MAT variables of different lengths, workbook sheets) opens **Import
  _file_**, listing each group with its signal count, samples, time span and
  notes. Up to 16 groups start chosen; larger files start empty so a bus log
  with hundreds of messages does not flood History. Each chosen group becomes a
  recording named `file · group`; the whole import is one Undo step. Use
  **Compare & align** to bring groups onto one time base.
- Batch runs import one group per item: pre-flight chooses the group that
  binds the most workflow inputs and shows its name beside the file. Batch
  runs never ask about units: units are kept as the file states them, and a
  channel without a unit takes the unit the workflow expects of it.
- Times must be finite and strictly increasing. The engine checks every
  sample and names the group and sample number when they are not. Infinite
  samples are stored as missing (NaN), like empty CSV cells.
- Readers never load a whole file. Metadata is read with bounded random-access
  reads; samples stream in blocks of at most 65,536 rows (one compressed block
  at a time), so cancellation stays responsive and memory stays bounded.
- A recording holds at most 1,024 signals. Channels a reader cannot represent
  as numbers are skipped and listed in a note after the import, never guessed.

## Delimited text

The first row holds headers. Headers such as `Torque [Nm]` give the unit. The
import dialog lists every column with its first values and lets the user make
it a **time axis**, a **signal on** one of the time axes, or **skip** it,
rename it, and type or fix each signal's unit. Names must be filled in and
differ (ignoring case) among the signals on one time axis; with several time
axes, a time column's name names its recording. Each time axis with signals becomes one
recording, named `file · time column` when there are several. A time axis may
be in any unit of time (`s`, `ms`, `µs`, `min`, `h`); it is converted to
seconds. A time axis tells **elapsed time**, **Unix time** (numbers in its
unit since 1970-01-01 UTC) or **date and time** text; the last two keep the
recording's clock time, with the zone and day/month order chosen in the
dialog (see `docs/time-bases.md`). The column layout
(`lib/formats/delimited-layout.ts`) is suggested as follows, and batch runs
use the suggestion:

- The first column is a time axis (seconds unless its header names a unit).
  Dates and times of day in it make it a date-and-time axis; numbers that can
  only be Unix time (2000–2100 in s, ms, µs or ns) or a name such as
  `Unix time` or `epoch_ms` make it a Unix-time axis. `Time [UTC]` reads text
  without a zone as UTC; otherwise it is read in this computer's zone.
- A later column is another time axis when its name reads as time (`Time 2`,
  `t2`, `ECU time`, `Time_B`, `Zeit`, `Timestamp`, `Date` …) and it holds
  dates or times of day, or its unit (if any) is a unit of time and its
  values strictly increase in the first 200 rows. Signals use the nearest
  time axis to their left.
- Other columns with text in the first rows are skipped with a note.

Where time axes have different lengths, a row whose time cell is empty is
skipped for that axis only when its signals are empty too; a value without a
time is an error naming the row and column. The delimiter is detected from the header row
(comma, semicolon, tab or vertical bar; `.tsv`/`.tab` are always tabs). When
the delimiter is not a comma, decimal commas (`0,5`) are read as numbers. UTF-8
(with or without BOM), UTF-16 with a BOM (Excel's “Unicode text”) and
Windows-1252 text are accepted; non-UTF-8 text adds a note. Messages name the
row and cause of a problem.

## ASAM MDF 4 and 3

Each channel group with numeric channels is a table, named by its acquisition
name, then its source name, then `Group n`. Time is the master channel after
its conversion; an angle, distance or index master is used as the axis with a
note, and a group without a master uses the sample number. Tables timed by a
time master keep the header's start time as their clock time (time 0); a zero
start time means none.

- **MDF 4:** DT, DL, DZ (deflate and transposed deflate) and HL data blocks;
  sorted and unsorted groups with 1–8 byte record IDs and VLSD records;
  invalidation bits (invalid samples are missing); bit fields in either byte
  order; integers to 64 bits and 16/32/64-bit floats; virtual master and data
  channels. Conversions: identity, linear, rational, algebraic (a safe formula
  evaluator, never `eval`), value-to-value tables with and without
  interpolation and value-range tables. Unfinalized (`UnFinMF`) files are read
  as far as their data blocks reach, with a note. The start time is UTC shown
  at `hd_tz_offset_min` + `hd_dst_offset_min` when the offsets are flagged
  valid, UTC shown as UTC when not, and local wall time read in this device's
  zone when flagged local.
- **MDF 3:** record IDs before and after records, all integer and IEEE types in
  either byte order, bit offsets, long names, and linear, tabular, polynomial,
  exponential, logarithmic, rational and formula conversions (exponential and
  logarithmic follow the MDF 3 specification). The start time is the 3.20
  local time stamp less its UTC offset in hours (shown at that offset), else
  the header's date and time text read as wall time in this device's zone.
- **Skipped with a note:** strings, byte arrays, MIME and CANopen date/time
  channels, VLSD and sync channels, structures and arrays, VAX floats.
  Text conversions (value-to-text, text tables, bitfields) keep the raw number
  and say so.
- **Not yet:** ZSTD/LZ4 compression and column-oriented storage from MDF 4.2/4.3
  give a clear error; events, attachments and sample-reduction blocks are not
  used.

## NI TDMS

Every segment is read: incremental metadata, new object lists, reused raw-data
indexes, repeated and partial chunks, an incomplete final segment, contiguous
or interleaved data in either byte order. Numeric types (I8–U64, SGL, DBL, also
with units) and Booleans (0/1) are channels; text, timestamp, complex and
extended-precision channels are skipped with a note while their layout is still
honoured. DAQmx raw data is decoded through its format-changing and digital-line
scalers and scaled with the stored NI scaling (linear, polynomial, chained by
input source); channels whose scaling cannot be applied are skipped, never
shown unscaled.

Within each TDMS group, channels sharing a length and timing form a table. Time
comes from waveform timing (`wf_start_offset` + i · `wf_increment`), else from a
numeric time channel (`Time`, `t`, `Zeit` …; ms, µs, ns, min and h convert to
seconds), else from a timestamp channel as seconds since its first sample (to
sub-microsecond precision), else the sample number. Channel units come from
`unit_string`. Waveform tables keep `wf_start_time` as their clock time (time 0,
before `wf_start_offset`; the first channel's when they differ, with a note),
and timestamp-timed tables their first timestamp. TDMS times are UTC and are
shown in this device's zone; 1904-01-01 00:00 means unset. Start times of
channels without waveform timing are noted, not applied.

## MATLAB MAT

Level 5/v6/v7 (uncompressed and zlib-compressed, either byte order) and Level 4
files. Numeric and logical arrays become channels; struct fields flatten to
`struct.field` (four levels), and Simulink “Structure with time” logs use their
signal labels. Vectors of one length form a table: time is a strictly
increasing vector named like time (`t`, `time`, `tout` …), else an increasing
first matrix column (noted), else the sample number. Matrix columns are named
`name(:,k)`. Text, cell, sparse, complex, N-D, function-handle and object
(timeseries, timetable) variables are skipped with a note. A single variable may
be up to 512 MiB uncompressed. v7.3 (HDF5) files are rejected with a hint.

## Excel workbook

Each worksheet with numeric data is a table named after the sheet. The first
non-empty row holds headers (`Torque [Nm]` gives the unit) and column A holds
time in seconds; date/time-formatted time becomes seconds since the first row,
with a note, and the first row sets the clock time: serials are wall-clock days
(the 1900 or the workbook's `date1904` system) read in this device's zone, and
values below one day are times of day without a date. Empty and error cells are missing; text cells in number columns are
missing; rows without a time are skipped. Columns that hold only
text in the first 100 rows are left out. Sheets stream through a small XML
scanner, so large sheets never sit in memory whole. Old `.xls`, `.xlsb` and
password-protected workbooks are rejected with a hint to save as `.xlsx`.

## WAV

Uncompressed PCM (8, 16, 24 and 32 bit) and IEEE float (32 and 64 bit),
including `WAVE_FORMAT_EXTENSIBLE` and RF64. Time is the sample number divided
by the sample rate. Integer samples are scaled to full scale (unit `FS`, −1 to
1); apply a sensor calibration with Derive. Compressed WAV (ADPCM, µ-law …) is
rejected.

## Fixtures and tests

`tests/formats*.test.ts` cover every reader. Fixtures in
`tests/fixtures/formats/` are written by its `generate_*.py` scripts with the
reference libraries (asammdf, nptdms, scipy, openpyxl/XlsxWriter), which also
record the expected values in JSON sidecars; layouts those libraries cannot
write are built byte by byte inside the tests. Regenerate with a Python
environment holding those packages, for example
`python tests/fixtures/formats/generate_mdf.py`.
