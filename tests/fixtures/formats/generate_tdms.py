"""Generates the TDMS fixtures for tests/formats-tdms.test.ts.

Ordinary files are written with nptdms; DAQmx and interleaved big-endian
files, which nptdms cannot write, are assembled byte by byte. Every file is
then read back with nptdms and its scaled channel values are stored in
tdms-expected.json, so the TypeScript reader is checked against nptdms.

Run with a Python that has nptdms (1.12) and numpy installed:
    python tests/fixtures/formats/generate_tdms.py
"""

import json
import struct
from pathlib import Path

import numpy as np
from nptdms import ChannelObject, GroupObject, RootObject, TdmsFile, TdmsWriter

HERE = Path(__file__).resolve().parent


def basic(path):
    n = 200
    i = np.arange(n)
    wave = {
        'wf_increment': 0.001,
        'wf_start_offset': 0.5,
        'wf_start_time': np.datetime64('2024-03-01T12:00:00'),
    }
    engine = {
        'Speed': (1000 + 10 * np.sin(i / 7.0), {'unit_string': 'rpm'}),
        'Torque': ((i * 0.25 - 3).astype(np.float32), {'unit_string': 'Nm'}),
        'Count': (i.astype(np.int32) - 50, {}),
        'Running': (i % 3 == 0, {}),
        'Gear': ((i // 40).astype(np.uint8), {}),
        'Label': (np.array(['s%d' % v for v in i]), {}),
        'Stamp': (
            np.datetime64('2024-03-01T12:00:00') + i.astype('timedelta64[ms]'),
            {},
        ),
    }
    slow = 1.5 * np.arange(30.0)
    bench_time = np.arange(50) * 20.0
    bench = {
        'Time [ms]': (bench_time, {}),
        'Pressure': (
            (np.arange(50) * 3 - 70).astype(np.int16),
            {'NI_UnitDescription': 'bar'},
        ),
        "Valve 'A'": ((np.arange(50) % 5).astype(np.uint16), {}),
    }
    # The only timestamp channel in its group, so it becomes the time axis.
    # nptdms writes timestamps to the microsecond.
    start = np.datetime64('2024-03-01T12:00:00.123456', 'us')
    log = {
        'Logged': (start + np.arange(60) * np.timedelta64(1_501, 'us'), {}),
        'Level': ((np.arange(60) * 0.5).astype(np.float32), {'unit_string': 'm'}),
    }
    plain = {
        'A': (np.arange(40, dtype=np.uint64) * 2 ** 40, {}),
        'B': (np.arange(40, dtype=np.int64) - 2 ** 33, {}),
        'C': (np.arange(40, dtype=np.uint32) * 100000, {}),
        'D': ((np.arange(40) - 20).astype(np.int8), {}),
        'E': ((np.arange(40) * 1000).astype(np.uint16), {}),
    }

    def objects(group, channels, part, timed):
        out = []
        for name, (data, props) in channels.items():
            half = len(data) // 2
            chunk = data[:half] if part == 0 else data[half:]
            props = dict(props, **(wave if timed else {})) if part == 0 else {}
            out.append(ChannelObject(group, name, chunk, properties=props))
        return out

    with TdmsWriter(path) as writer:
        writer.write_segment(
            RootObject({'name': 'Basic fixture'}),
            GroupObject('Engine', {'rig': 3}),
            objects('Engine', engine, 0, True),
            objects('Bench', bench, 0, False),
            objects('Plain', plain, 0, False),
            objects('Log', log, 0, False),
        )
        writer.write_segment(
            objects('Engine', engine, 1, True),
            ChannelObject(
                'Engine', 'Slow', slow, properties={'wf_increment': 0.01}
            ),
            objects('Bench', bench, 1, False),
            objects('Plain', plain, 1, False),
            objects('Log', log, 1, False),
        )


def string(text):
    data = text.encode('utf-8')
    return struct.pack('<I', len(data)) + data


def props(items):
    out = struct.pack('<I', len(items))
    for name, kind, value in items:
        out += string(name) + struct.pack('<I', kind)
        if kind == 0x20:
            out += string(value)
        elif kind == 3:
            out += struct.pack('<i', value)
        elif kind == 7:
            out += struct.pack('<I', value)
        elif kind == 10:
            out += struct.pack('<d', value)
    return out


def segment(toc, metadata, data, objects=None):
    meta = b'' if metadata is None else struct.pack('<I', objects) + metadata
    return (
        b'TDSm'
        + struct.pack('<iiQQ', toc, 4713, len(meta) + len(data), len(meta))
        + meta
        + data
    )


META, NEW_LIST, RAW, INTERLEAVED, BIG, DAQMX = 2, 4, 8, 32, 64, 128


def daqmx(path):
    """Two DAQmx buffers: one of 8-byte rows, one of digital line bytes."""
    widths = struct.pack('<III', 2, 8, 1)

    def channel(name, scalers, prop_items, digital=False):
        body = struct.pack('<IIQI', 0xFFFFFFFF, 1, rows, len(scalers))
        for type_id, buffer, offset, scale_id in scalers:
            if digital:
                body += struct.pack('<IIIBI', type_id, buffer, offset, 0, scale_id)
            else:
                body += struct.pack('<IIIII', type_id, buffer, offset, 0, scale_id)
        header = 0x126A if digital else 0x1269
        return (
            string("/'DAQ'/'%s'" % name)
            + struct.pack('<I', header)
            + body
            + widths
            + props(prop_items)
        )

    rows = 6
    linear = [
        ('NI_Scaling_Status', 0x20, 'unscaled'),
        ('NI_Number_Of_Scales', 7, 2),
        ('NI_Scale[1]_Scale_Type', 0x20, 'Linear'),
        ('NI_Scale[1]_Linear_Slope', 10, 0.5),
        ('NI_Scale[1]_Linear_Y_Intercept', 10, 1.0),
        ('NI_Scale[1]_Linear_Input_Source', 7, 0),
        ('unit_string', 0x20, 'V'),
        ('wf_increment', 10, 0.0001),
    ]
    chained = [
        ('NI_Scaling_Status', 0x20, 'unscaled'),
        ('NI_Number_Of_Scales', 7, 3),
        ('NI_Scale[1]_Scale_Type', 0x20, 'Polynomial'),
        ('NI_Scale[1]_Polynomial_Coefficients_Size', 7, 3),
        ('NI_Scale[1]_Polynomial_Coefficients[0]', 10, 1.0),
        ('NI_Scale[1]_Polynomial_Coefficients[1]', 10, 0.1),
        ('NI_Scale[1]_Polynomial_Coefficients[2]', 10, 0.001),
        ('NI_Scale[1]_Polynomial_Input_Source', 7, 0),
        ('NI_Scale[2]_Scale_Type', 0x20, 'Linear'),
        ('NI_Scale[2]_Linear_Slope', 10, 2.0),
        ('NI_Scale[2]_Linear_Y_Intercept', 10, -1.0),
        ('NI_Scale[2]_Linear_Input_Source', 7, 1),
        ('unit_string', 0x20, 'ustrain'),
        ('wf_increment', 10, 0.0001),
    ]
    timing = [('wf_increment', 10, 0.0001)]
    # Scale 0 has no type: it is the DAQmx scaler itself.
    line = [('NI_Number_Of_Scales', 7, 1)] + timing
    metadata = (
        string('/')
        + struct.pack('<I', 0xFFFFFFFF)
        + props([])
        + string("/'DAQ'")
        + struct.pack('<I', 0xFFFFFFFF)
        + props([])
        # DAQmx type codes: 3 = I16, 4 = U32, 0 = U8.
        + channel('Voltage', [(3, 0, 0, 0)], linear)
        + channel('Strain', [(4, 0, 2, 0)], chained)
        + channel('Raw', [(3, 0, 6, 0)], timing)
        + channel('Line', [(0, 1, 3, 0)], line, digital=True)
    )

    def chunk(start):
        data = b''
        for r in range(start, start + rows):
            data += struct.pack('<hIh', r * 100 - 300, r * 7, -r)
        for r in range(start, start + rows):
            data += struct.pack('<B', (r * 37) & 0xFF)
        return data

    toc = META | NEW_LIST | RAW | DAQMX
    same = b''.join(
        string("/'DAQ'/'%s'" % name) + struct.pack('<I', 0) + props([])
        for name in ('Voltage', 'Strain', 'Raw', 'Line')
    )
    with open(path, 'wb') as f:
        f.write(segment(toc, metadata, chunk(0) + chunk(6), 6))
        # Raw data indexes "same as before" without a new object list.
        f.write(segment(META | RAW | DAQMX, same, chunk(12), 4))
        # No metadata at all: reuse the previous segment's layout.
        f.write(segment(RAW | DAQMX, None, chunk(18) + chunk(24)))


def interleaved_big_endian(path):
    def be_string(text):
        data = text.encode('utf-8')
        return struct.pack('>I', len(data)) + data

    def channel(name, type_id, unit):
        return (
            be_string("/'Rig'/'%s'" % name)
            + struct.pack('>IIIQ', 20, type_id, 1, 10)
            + struct.pack('>I', 3)
            + be_string('unit_string')
            + struct.pack('>I', 0x20)
            + be_string(unit)
            + be_string('wf_increment')
            + struct.pack('>Id', 10, 0.002)
            + be_string('wf_start_offset')
            + struct.pack('>Id', 10, -0.01)
        )

    metadata = (
        be_string("/'Rig'")
        + struct.pack('>II', 0xFFFFFFFF, 0)
        + channel('Pressure', 9, 'bar')
        + channel('Flow', 2, 'l/min')
        + channel('Valve', 0x21, '')
    )

    def rows(start, count):
        return b''.join(
            struct.pack('>fh?', 1.5 + r * 0.25, 1000 - r * 33, r % 4 == 1)
            for r in range(start, start + count)
        )

    meta = struct.pack('>I', 4) + metadata
    toc = META | NEW_LIST | RAW | INTERLEAVED | BIG
    data = rows(0, 30)
    first = (
        b'TDSm'
        + struct.pack('<i', toc)
        + struct.pack('>iQQ', 4713, len(meta) + len(data), len(meta))
        + meta
        + data
    )
    # Two and a half chunks plus a partial row: the reader keeps 25 rows.
    data = rows(30, 25) + b'\x01\x02\x03'
    second = (
        b'TDSm'
        + struct.pack('<i', RAW | INTERLEAVED | BIG)
        + struct.pack('>iQQ', 4713, len(data), 0)
        + data
    )
    with open(path, 'wb') as f:
        f.write(first + second)


def expected(path):
    out = {}
    with TdmsFile.open(path, raw_timestamps=True) as tdms:
        for group in tdms.groups():
            channels = {}
            for channel in group.channels():
                try:
                    data = channel[:]
                except ValueError:
                    # nptdms refuses DAQmx data without scaling information.
                    channels[channel.name] = None
                    continue
                if data.dtype.names == ('second_fractions', 'seconds'):
                    # Seconds since the first sample, from exact integers.
                    s0, f0 = int(data['seconds'][0]), int(data['second_fractions'][0])
                    channels[channel.name] = [
                        (int(s) - s0) + (int(f) - f0) / 2 ** 64
                        for s, f in zip(data['seconds'], data['second_fractions'])
                    ]
                    continue
                if data.dtype.kind not in 'biuf':
                    continue
                channels[channel.name] = [
                    float(v) for v in np.asarray(data, dtype=np.float64)
                ]
            out[group.name] = channels
    return out


def main():
    builders = {
        'tdms-basic.tdms': basic,
        'tdms-daqmx.tdms': daqmx,
        'tdms-interleaved-be.tdms': interleaved_big_endian,
    }
    result = {}
    for name, build in builders.items():
        path = HERE / name
        build(str(path))
        result[name] = expected(str(path))
    with open(HERE / 'tdms-expected.json', 'w') as f:
        json.dump(result, f, indent=1, sort_keys=True)
        f.write('\n')


if __name__ == '__main__':
    main()
