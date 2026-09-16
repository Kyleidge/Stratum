# Example recordings

These are deterministic **synthetic** signals created for exploring Stratum.
They are not measurements from real equipment. Import each CSV with **Import CSV**;
the first column is time in seconds and blank cells mean missing samples.

| File                                     | Samples / rate | What to try                                                   |
| ---------------------------------------- | -------------- | ------------------------------------------------------------- |
| [motor-runs.csv](motor-runs.csv)         | 1,801 / 10 Hz  | Three repeatable runs, segmentation and per-run values        |
| [motor-logger-b.csv](motor-logger-b.csv) | 1,801 / 10 Hz  | A second clock, explicit alignment and cross-file comparisons |
| [vibration.csv](vibration.csv)           | 4,001 / 200 Hz | Filtering, missing intervals and a single spike               |
| [thermal-step.csv](thermal-step.csv)     | 241 / 1 Hz     | Delayed responses, derivatives and time averages              |

## Compare the three runs

1. Import `motor-runs.csv` and select **Torque** in History.
2. Open the scissors icon (**Segment**), choose **Time ranges**, and enter:

   ```text
   10, 50
   65, 105
   120, 160
   ```

3. Create the segments. Drag any segment onto **New plot** to include all three.
4. Turn on **Δt · Align starts at 0** to compare each run from its start.
5. Drag the segmentation operation onto **Calculate value** (the hash icon) to
   calculate one value per segment. Drag an individual segment to process only it.

For trigger segmentation, use **Run trigger** for both edges: rising at 2.5 V
to start and falling at 2.5 V to end, with zero offsets. The 5 V gate is high at
10–50, 65–105 and 120–160 s, excluding each end. Threshold interpolation places
crossings halfway between the samples around each edge (9.95–49.95 s, etc.).
The explicit ranges above use the intended nominal run boundaries.

## Compare two clocks

Import both motor files. Logger B represents the same physical samples with
timestamps **2.5 seconds later**. Its speed is multiplied by 1.003; its torque is
multiplied by 0.985 then increased by 2 Nm. Keep either speed plot and drag the
other speed onto it. Separate recording clocks initially use separate axes.
The plot's Δt option compares relative starts without creating data.

For reusable aligned signals, check both speeds, open **Compare & align**, and
align each recording by its first sample. This creates explicit time references
in workflow history. Apply the same recording-wide alignment to torque channels
when comparing those. See [time bases](../docs/time-bases.md).

## Explore noisy and missing data

`vibration.csv` contains a 2 Hz, 1 g amplitude reference sine wave. The measured
channel adds a 0.25 g, 18 Hz sine wave plus deterministic 37 Hz and 61 Hz components
(amplitudes 0.04 g and 0.02 g; the 37 Hz component has a 0.4 radian phase shift).
Measured samples are blank for **8 ≤ t < 8.5 s** (100 samples), and the sample
at **12 s** has an additional **3 g** spike. Try a low-pass filter and compare
its result with the reference. Missing samples remain missing; zero is valid data.

## Explore a thermal response

`thermal-step.csv` starts at 22 °C. The heater switches to 100% at 30 s and
off at 150 s. Sensor A rises exponentially toward a 48 °C increase with a
28 s time constant. Sensor B begins eight seconds later, approaches a 44 °C
increase with a 35 s time constant, and begins cooling eight seconds later too.
Both cool exponentially toward ambient with a 55 s time constant. Compare the
temperature traces, derive their rates of change, or segment heating and cooling.

All signals use fixed grids and values rounded to six decimal places. The motor
runs sweep from 1,200 toward 6,000 rpm over 40 s with sinusoidal ripple; torque
uses a smooth half-sine load profile, a per-run offset and sinusoidal ripple.
No random-number generator or external data source is used.
