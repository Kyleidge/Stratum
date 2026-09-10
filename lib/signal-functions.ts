import type { Operation } from './signal-types';

export type FunctionSpec = {
  operation: Operation | 'segment';
  name: string;
  category: string;
  description: string;
  parameter: string;
  defaultValue: number;
  unit: string;
  min?: number;
  max?: number;
  step?: number;
};
export const FUNCTIONS: FunctionSpec[] = [
  {
    operation: 'add',
    name: 'Add signals',
    category: 'Math',
    description:
      'Add matching samples: A + B. Both inputs must have the same unit label.',
    parameter: '',
    defaultValue: 0,
    unit: '',
  },
  {
    operation: 'subtract',
    name: 'Subtract signals',
    category: 'Math',
    description:
      'Subtract B from each selected input A. Both inputs must have the same unit label.',
    parameter: '',
    defaultValue: 0,
    unit: '',
  },
  {
    operation: 'multiply',
    name: 'Multiply signals',
    category: 'Math',
    description:
      'Multiply matching samples: A × B. Output units combine the two input units.',
    parameter: '',
    defaultValue: 0,
    unit: '',
  },
  {
    operation: 'divide',
    name: 'Divide signals',
    category: 'Math',
    description:
      'Divide each selected input A by B. Division by zero and missing samples produce missing values.',
    parameter: '',
    defaultValue: 0,
    unit: '',
  },
  {
    operation: 'min-max',
    name: 'Min / Max',
    category: 'Calculation',
    description:
      'Find the minimum and maximum finite values, retaining their original timestamps as extrema samples. Missing samples are excluded.',
    parameter: '',
    defaultValue: 0,
    unit: '',
  },
  {
    operation: 'segment',
    name: 'Segment signals',
    category: 'Segmentation',
    description:
      'Create branches from signal crossings, explicit time ranges, or fixed-duration windows.',
    parameter: '',
    defaultValue: 0,
    unit: '',
  },
  {
    operation: 'smooth',
    name: 'Moving average',
    category: 'Filtering',
    description:
      'A trailing sample window reduces noise. Missing samples are excluded from the mean.',
    parameter: 'Window size',
    defaultValue: 25,
    unit: 'samples',
    min: 1,
    max: 100000,
    step: 1,
  },
  {
    operation: 'median',
    name: 'Median filter',
    category: 'Filtering',
    description:
      'Reject spikes with a trailing window of 1–1,001 samples. Uses available samples at the start and excludes missing values, filling gaps while the window has data.',
    parameter: 'Window size',
    defaultValue: 5,
    unit: 'samples',
    min: 1,
    max: 1001,
    step: 1,
  },
  {
    operation: 'exponential',
    name: 'Exponential smoothing',
    category: 'Filtering',
    description:
      'Weight each new sample by alpha (0 < alpha ≤ 1). Smaller values smooth more; 1 leaves values unchanged. Restarts after missing samples.',
    parameter: 'Smoothing factor',
    defaultValue: 0.2,
    unit: 'α',
    min: 0,
    max: 1,
    step: 0.05,
  },
  {
    operation: 'low-pass',
    name: 'Low-pass RC filter',
    category: 'Filtering',
    description:
      'Reduce fast changes with a first-order RC filter using actual sample intervals. Starts at the input value and restarts after missing samples. Cutoff must be positive.',
    parameter: 'Cutoff frequency',
    defaultValue: 5,
    unit: 'Hz',
    min: 0,
  },
  {
    operation: 'high-pass',
    name: 'High-pass RC filter',
    category: 'Filtering',
    description:
      'Remove slow changes and DC offset with a first-order RC filter using actual sample intervals. Starts at zero and restarts after missing samples. Cutoff must be positive.',
    parameter: 'Cutoff frequency',
    defaultValue: 1,
    unit: 'Hz',
    min: 0,
  },
  {
    operation: 'scale',
    name: 'Scale signal',
    category: 'Calculation',
    description: 'Multiply every sample by a constant factor.',
    parameter: 'Scale factor',
    defaultValue: 1.1,
    unit: '×',
  },
  {
    operation: 'offset',
    name: 'Offset signal',
    category: 'Calculation',
    description: 'Add a constant to every sample in the selected signal.',
    parameter: 'Value offset',
    defaultValue: 10,
    unit: 'units',
  },
  {
    operation: 'absolute',
    name: 'Absolute value',
    category: 'Calculation',
    description:
      'Create the magnitude of each sample, retaining its time axis.',
    parameter: '',
    defaultValue: 0,
    unit: '',
  },
  {
    operation: 'derivative',
    name: 'Differentiate',
    category: 'Calculation',
    description:
      'First-order backward difference using actual sample times. The first sample is undefined.',
    parameter: '',
    defaultValue: 0,
    unit: '',
  },
  {
    operation: 'integral',
    name: 'Integrate',
    category: 'Calculation',
    description:
      'Cumulative trapezoidal integration. Missing intervals are skipped; output units include seconds.',
    parameter: '',
    defaultValue: 0,
    unit: '',
  },
  {
    operation: 'zero-time',
    name: 'Align to zero',
    category: 'Time manipulation',
    description:
      'Start the selected signal at t = 0. Source timestamps remain unchanged.',
    parameter: '',
    defaultValue: 0,
    unit: '',
  },
  {
    operation: 'time-shift',
    name: 'Shift time',
    category: 'Time manipulation',
    description:
      'Move the entire time axis by a fixed offset, including negative offsets.',
    parameter: 'Time offset',
    defaultValue: 5,
    unit: 's',
  },
  {
    operation: 'resample',
    name: 'Resample',
    category: 'Time manipulation',
    description:
      'Linear interpolation on a uniform grid. Gaps above 5 initial source intervals stay empty. Filter before downsampling.',
    parameter: 'Output rate',
    defaultValue: 50,
    unit: 'Hz',
    min: 0.01,
    max: 10000,
  },
];
