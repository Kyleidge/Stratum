# Signal filters

Choose a filter in **Function library → Filtering**, select a raw or derived
input, set its parameter, then **Apply function**. Each result records its parent,
operation, parameter, and version; raw data remains unchanged. Filters preserve
the input timestamps and units and can be chained or used for segmentation.

All filters are causal: they use only current and earlier samples. Their state
continues across storage chunks and restarts for each complete evaluation.
Filtering a crop starts a new filter at the crop boundary; cropping an already
filtered signal retains the preceding filter history.

| Filter                | Parameter               | Behavior                                                                                             |
| --------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------- |
| Moving average        | 1–100,000 whole samples | Existing trailing mean.                                                                              |
| Median filter         | 1–1,001 whole samples   | Trailing median to suppress isolated spikes. Even counts average the middle two values.              |
| Exponential smoothing | `0 < alpha ≤ 1`         | `y = alpha × x + (1 − alpha) × previous_y`. Smaller alpha smooths more; alpha of 1 preserves values. |
| Low-pass RC filter    | Positive cutoff in Hz   | Attenuates fast changes. Starts at the first input value.                                            |
| High-pass RC filter   | Positive cutoff in Hz   | Attenuates slow changes and DC offset. Starts at zero.                                               |
| Butterworth low-pass  | Cutoff below Nyquist    | Second order: flat passband, −3 dB at the cutoff, −40 dB per decade above it. Starts at the input.   |
| Butterworth high-pass | Cutoff below Nyquist    | Second order: removes slow changes and DC offset, −40 dB per decade below the cutoff. Starts at 0.   |

Window filters use available samples during startup. Missing samples occupy a
window position but are excluded from the statistic; a missing input can therefore
produce a finite output while its window still contains data. An entirely missing
window produces a missing output. Exponential and RC filters preserve missing
samples and restart at the next finite input, without joining across that gap.

RC filters use a time constant `tau = 1 / (2 × pi × cutoff)` and actual elapsed
time `dt` between samples, so uneven sample intervals are supported. They use
backward Euler discretization:

- Low-pass: `a = dt / (tau + dt)`; `y = a × x + (1 − a) × previous_y`.
- High-pass: `b = tau / (tau + dt)`; `y = b × (previous_y + x − previous_x)`.

The cutoff is the analog RC parameter; the discrete response approximates it best
when the sample rate is well above the cutoff. These are first-order causal
filters, so they introduce phase shift and do not provide a sharp frequency
boundary. Exponential smoothing uses samples rather than elapsed time.

Butterworth filters are second-order sections designed with the bilinear
transform (cutoff prewarped, Q = 1/√2), so the cutoff is exact at −3 dB. They
assume a regular sample interval: the nominal rate is the median interval of
the input's first samples, recorded with the step, and the cutoff must be
below half that rate. A missing sample, or an interval more than 1 % away from
the nominal one (such as a timestamp gap), restarts the filter at the next
sample in its steady state. Like every filter here they are causal, so they
delay the signal; for zero-phase smoothing use the anti-alias filter in
**Compare & align** (see [time bases](time-bases.md)). Apply a filter twice
for a steeper, fourth-order response.

No additional packages or stored numeric columns are needed. Median filtering
keeps at most 1,001 values plus a sorted window; recursive filters keep constant
state. All processing runs through the existing signal worker on the local device.
