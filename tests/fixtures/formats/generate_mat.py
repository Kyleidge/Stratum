"""Writes the MATLAB MAT-file fixtures used by tests/formats-mat.test.ts.

Run from the repository root with scipy and numpy installed:
    python tests/fixtures/formats/generate_mat.py
"""

from pathlib import Path

import numpy as np
from scipy.io import savemat

HERE = Path(__file__).parent


def simulink(n, signals):
    """A Simulink "Structure with time" log with a signals struct array."""
    dtype = [('values', 'O'), ('dimensions', 'O'), ('label', 'O'), ('blockName', 'O')]
    array = np.zeros((1, len(signals)), dtype=dtype)
    for k, (values, label, block) in enumerate(signals):
        array[0, k] = (values, values.shape[1], label, block)
    return {'time': np.arange(n) * 0.01, 'signals': array, 'blockName': 'model'}


def level5():
    n = 200
    t = np.arange(n) * 0.001
    return {
        't': t,
        'speed': np.sin(2 * np.pi * 5 * t).reshape(n, 1),
        'torque': (10 + t).astype(np.float32).reshape(1, n),
        'counts': np.arange(n, dtype=np.int16) - 100,
        'valid': (np.arange(n) % 2 == 0).reshape(n, 1),
        'ticks': np.arange(n, dtype=np.uint64) * 1000,
        'accel': np.column_stack([t, 2 * t, 3 * t]),
        'gain': 2.5,
        'description': 'motor test',
        'parts': np.array([['a', 'b']], dtype=object),
        'z': (t + 1j * t).reshape(n, 1),
        'cfg': {
            'rate': 1000.0,
            'offsets': np.full((n, 1), 0.5),
            'inner': {'deep': np.linspace(-1, 1, n).reshape(n, 1)},
        },
        'logsout': simulink(
            50,
            [
                (np.linspace(1, 2, 50).reshape(50, 1), 'Pressure [bar]', 'model/P'),
                (np.column_stack([np.ones(50), np.zeros(50)]), '', 'model/Flow'),
            ],
        ),
        'slog': {
            'time': np.arange(30) * 0.1,
            'signals': {
                'values': np.arange(30.0).reshape(30, 1),
                'label': 'Temp [degC]',
                'dimensions': 1.0,
            },
        },
    }


def main():
    data = level5()
    savemat(HERE / 'mat-v5.mat', data, do_compression=False, oned_as='column')
    savemat(HERE / 'mat-v7.mat', data, do_compression=True, oned_as='column')
    n = 100
    savemat(
        HERE / 'mat-v4.mat',
        {
            'time': np.arange(n) * 0.5,
            'x': np.cos(np.arange(n) / 10.0).reshape(n, 1),
            'm': np.column_stack([np.arange(n), -np.arange(n)]).astype(np.float64),
            'label': 'text',
            'k': 3.0,
        },
        format='4',
        oned_as='column',
    )


if __name__ == '__main__':
    main()
