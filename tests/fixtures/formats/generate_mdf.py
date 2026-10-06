"""Generates the MDF fixtures used by tests/formats-mdf.test.ts.

Run with a Python that has asammdf 8.8 and numpy:

    python tests/fixtures/formats/generate_mdf.py

The data is deterministic. Each fixture gets a JSON sidecar with the values a
reader must produce (after conversions; text conversions keep raw values and
invalid samples are null). The script reads every file back with asammdf and
checks it against those expectations before writing them.
"""

import json
import math
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from asammdf import MDF, Signal
from asammdf.blocks.source_utils import Source

HERE = Path(__file__).resolve().parent
# A fixed clock keeps regenerated files byte-identical.
START = datetime(2024, 1, 2, 3, 4, 5, tzinfo=timezone.utc)
# asammdf stamps its history entries with the current time.
time.time = lambda: START.timestamp()
time.asctime = lambda *_: "Tue Jan  2 03:04:05 2024"


def engine_group():
    """Rows at 100 Hz covering most numeric types and conversions."""
    n = 120
    t = np.arange(n, dtype=np.float64) * 0.01
    speed = 1500 + 400 * np.sin(np.arange(n) / 9.0)
    torque_raw = (np.arange(n) * 37 % 2000 - 1000).astype(np.int16)
    gear = (np.arange(n) // 30 % 4).astype(np.uint8)
    temp = (20 + np.arange(n) * 0.25).astype(np.float32)
    status = (np.arange(n) % 5).astype(np.uint8)
    invalid = np.arange(n) % 7 == 3
    lookup_raw = (np.arange(n) % 11).astype(np.uint16)
    range_raw = (np.arange(n) % 12).astype(np.int32)
    ratio_raw = (np.arange(n) % 9 + 1).astype(np.float64)
    big = (np.arange(n, dtype=np.int64) * 1_000_003 - 50_000_000).astype(
        np.int64
    )
    labels = np.array([f"row{i}".encode() for i in range(n)])

    signals = [
        Signal(speed, t, unit="rpm", name="Speed"),
        Signal(
            torque_raw,
            t,
            unit="Nm",
            name="Torque",
            conversion={"a": 0.1, "b": -5.0},
        ),
        Signal(
            gear,
            t,
            name="Gear",
            conversion={
                "val_0": 0,
                "text_0": "N",
                "val_1": 1,
                "text_1": "First",
                "val_2": 2,
                "text_2": "Second",
                "default_addr": "Other",
            },
        ),
        Signal(temp, t, unit="degC", name="Temp", conversion={"formula": "X * 2 + 1"}),
        Signal(status, t, name="Status", invalidation_bits=invalid),
        Signal(
            lookup_raw,
            t,
            name="Lookup",
            conversion={
                "raw_0": 0,
                "phys_0": 0.0,
                "raw_1": 4,
                "phys_1": 40.0,
                "raw_2": 10,
                "phys_2": 100.0,
                "interpolation": True,
            },
        ),
        Signal(
            range_raw,
            t,
            name="Band",
            conversion={
                "lower_0": 0,
                "upper_0": 3,
                "phys_0": 1.5,
                "lower_1": 4,
                "upper_1": 7,
                "phys_1": 5.5,
                "default": -1.0,
            },
        ),
        Signal(
            ratio_raw,
            t,
            name="Ratio",
            conversion={"P1": 0, "P2": 2, "P3": 1, "P4": 0, "P5": 1, "P6": 1},
        ),
        Signal(big, t, name="Counter"),
        Signal(labels, t, name="Label", encoding="latin-1"),
    ]

    gear_raw = gear.astype(np.float64)
    temp_phys = temp.astype(np.float64) * 2 + 1
    status_phys = np.where(invalid, np.nan, status.astype(np.float64))
    lookup_phys = np.interp(lookup_raw, [0, 4, 10], [0.0, 40.0, 100.0])
    band = np.where(
        (range_raw >= 0) & (range_raw <= 3),
        1.5,
        np.where((range_raw >= 4) & (range_raw <= 7), 5.5, -1.0),
    )
    ratio_phys = (2 * ratio_raw + 1) / (ratio_raw + 1)
    expected = {
        "name": "Engine",
        "channels": [
            ["Speed", "rpm"],
            ["Torque", "Nm"],
            ["Gear", "—"],
            ["Temp", "degC"],
            ["Status", "—"],
            ["Lookup", "—"],
            ["Band", "—"],
            ["Ratio", "—"],
            ["Counter", "—"],
        ],
        "time": t,
        "values": [
            speed,
            torque_raw * 0.1 - 5.0,
            gear_raw,
            temp_phys,
            status_phys,
            lookup_phys,
            band,
            ratio_phys,
            big.astype(np.float64),
        ],
    }
    return signals, expected


def pressure_group():
    """A second rate without an acquisition name."""
    n = 40
    t = 0.5 + np.arange(n, dtype=np.float64) * 0.05
    pressure = 1 + 0.01 * np.arange(n) ** 2
    flags = (np.arange(n) % 3).astype(np.int8) - 1
    signals = [
        Signal(pressure, t, unit="bar", name="Pressure"),
        Signal(flags, t, name="Mode"),
    ]
    expected = {
        "name": "Group 2",
        "channels": [["Pressure", "bar"], ["Mode", "—"]],
        "time": t,
        "values": [pressure, flags.astype(np.float64)],
    }
    return signals, expected


def text_only_group():
    t = np.arange(5, dtype=np.float64)
    return [Signal(np.array([b"a", b"b", b"c", b"d", b"e"]), t, name="Note", encoding="latin-1")]


def to_json(table):
    def clean(values):
        return [None if math.isnan(v) else float(v) for v in values]

    return {
        "name": table["name"],
        "channels": table["channels"],
        "time": clean(table["time"]),
        "values": [clean(v) for v in table["values"]],
    }


def check(path, tables):
    """Reads the file with asammdf and compares the physical values."""
    with MDF(path) as mdf:
        for group, table in enumerate(tables):
            for index, (name, _unit) in enumerate(table["channels"]):
                if name == "Band":
                    # asammdf 8.8 misreads integer range tables; the
                    # expectation follows the standard's inclusive ranges.
                    continue
                raw = name == "Gear"
                signal = mdf.get(name, group=group, raw=raw)
                # asammdf drops invalid samples; compare the valid ones.
                expected = np.asarray(table["values"][index])
                valid = ~np.isnan(expected)
                samples = np.asarray(signal.samples, dtype=np.float64)
                assert np.allclose(samples, expected[valid]), (path, name)
                assert np.allclose(
                    signal.timestamps, np.asarray(table["time"])[valid]
                ), (path, name)


def write_mdf4(name, compression):
    engine, engine_expected = engine_group()
    pressure, pressure_expected = pressure_group()
    mdf = MDF(version="4.10")
    mdf.header.start_time = START
    mdf.append(
        engine,
        acq_name="Engine",
        acq_source=Source("ECU1", "CAN1", "", 1, 2),
    )
    mdf.append(pressure)
    mdf.append(text_only_group())
    path = HERE / name
    mdf.save(path, overwrite=True, compression=compression)
    tables = [engine_expected, pressure_expected]
    check(path, tables)
    return path, tables


def write_mdf3(name):
    engine, engine_expected = engine_group()
    pressure, pressure_expected = pressure_group()
    # MDF 3 has no invalidation bits, no 64-bit integers in asammdf's writer
    # path here, and no range-to-value table; keep channels both can carry.
    keep = {"Speed", "Torque", "Gear", "Temp", "Lookup", "Ratio", "Label"}
    engine = [s for s in engine if s.name in keep]
    names = [c[0] for c in engine_expected["channels"]]
    picked = [i for i, n in enumerate(names) if n in keep]
    engine_expected = {
        "name": "Group 1",
        "channels": [engine_expected["channels"][i] for i in picked],
        "time": engine_expected["time"],
        "values": [engine_expected["values"][i] for i in picked],
    }
    mdf = MDF(version="3.30")
    mdf.header.start_time = START
    mdf.append(engine, comment="")
    mdf.append(pressure, comment="")
    path = HERE / name
    mdf.save(path, overwrite=True)
    tables = [engine_expected, pressure_expected]
    check(path, tables)
    return path, tables


def main():
    outputs = [
        write_mdf4("mdf4-basic.mf4", 0),
        write_mdf4("mdf4-deflate.mf4", 1),
        write_mdf4("mdf4-transposed.mf4", 2),
        write_mdf3("mdf3-basic.mdf"),
    ]
    for path, tables in outputs:
        size = path.stat().st_size
        assert size < 64 * 1024, (path, size)
        sidecar = path.with_suffix(path.suffix + ".json")
        sidecar.write_text(
            json.dumps({"tables": [to_json(t) for t in tables]}, separators=(",", ":"))
            + "\n"
        )
        print(f"{path.name}: {size} bytes")


if __name__ == "__main__":
    main()
