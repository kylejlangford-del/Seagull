#!/usr/bin/env python3
"""Regenerate the measured tables inside js/accel.js — v2, fleet-wide source.

js/accel.js owns its own prose and runtime code (accelAt, accelAtCfg,
accelRun, ttlRun); this script owns only the NUMBERS. It splices fresh table
literals between the /*GEN:...*/ ... /*GEN:END*/ markers, so a re-run can
never lose a hand edit to the code around them.

SOURCE (v2): /home/claude/ingest/samples.parquet — every boat at every event
of the 2025 and 2026 seasons, pulled from Njord (832 boat-days, ~7.7M 1 Hz
samples), mined by /home/claude/ingest/mine.py. This replaced the four local
race bundles (~122k samples) on 2026-08-30; the physics is unchanged:

  acceleration        centred difference of SOG over the neighbouring seconds
  straight-line only  |rate of turn| > 3 deg/s dropped (except DECEL, below)
  p75 / p90           top of the cell's full distribution — most samples are a
                      boat NOT trying to accelerate, so the achievable rate
                      lives at the top

  ACCEL_P75 / P90     pooled [speed decade][wind band][angle band]; thin cells
                      fall back speed x wind -> speed x angle -> speed row.

  ACCEL_CFG           per POLAR (keys 'm15', 'm8', ... — the mNN prefix of the
                      rig config string, which is the POLAR_SELECTION channel
                      id): [speed decade][TWA 15-degree bin x12]. null under
                      60 samples -> runtime falls back to the pooled table.
                      v1 keyed four full config names with 4 coarse angle
                      bands; the fleet-wide pull supports all 15 polars the
                      fleet sailed and the finer angle axis.

  ACCEL_DECEL         magnitude of the 10th percentile of every DECELERATING
                      sample per speed decade — NO rate-of-turn filter,
                      deliberately: killing speed is done with the rudder as
                      much as the sheets.

If samples.parquet is missing, re-run the ingestion (manifest + AGENT.md in
/home/claude/ingest) and mine.py first.
"""
import math
from pathlib import Path
import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent.parent
SRC = Path('/home/claude/ingest/samples.parquet')
ROT_MAX = 3.0
TWS_BANDS = [(0, 20), (20, 28), (28, 36), (36, 60)]
TWA_BANDS = [(30, 60), (60, 90), (90, 120), (120, 180)]
V_STEP, NV = 10, 10
NA = 12                      # 15-degree TWA bins for the per-polar tables
MIN_CELL, MIN_MARG, MIN_CFG = 120, 60, 60
MIN_POLAR = 10000            # polars thinner than this stay pooled-only

df = pd.read_parquet(SRC)
ok = df.dv.notna() & (df.sog >= 0) & (df.sog <= 100)
dec_samples = df[ok & (df.dv < 0)]
d = df[ok & (df.rot <= ROT_MAX)].copy()
d['vb'] = (d.sog // V_STEP).clip(0, NV - 1).astype(int)


def band_idx(x, bands):
    out = np.full(len(x), -1)
    for i, (lo, hi) in enumerate(bands):
        out[(x >= lo) & (x < hi)] = i
    return out


d['wb'] = band_idx(d.tws.to_numpy(), TWS_BANDS)
d['ab'] = band_idx(d.twa.to_numpy(), TWA_BANDS)
d['ab12'] = (d.twa // 15).clip(0, NA - 1).astype(int)
d['pid'] = d.polar.fillna(-1).round().astype(int)

pool = d[(d.wb >= 0) & (d.ab >= 0)]
cell = pool.groupby(['vb', 'wb', 'ab']).dv
mv_w = pool.groupby(['vb', 'wb']).dv
mv_a = pool.groupby(['vb', 'ab']).dv
mv = pool.groupby('vb').dv


def q(g, key, frac):
    try:
        x = g.get_group(key)
    except KeyError:
        return None, 0
    return float(x.quantile(frac)), len(x)


def pooled(frac):
    allq = float(pool.dv.quantile(frac))
    rows = []
    for vb in range(NV):
        cols = []
        for wb in range(4):
            vals = []
            for ab in range(4):
                v, n = q(cell, (vb, wb, ab), frac)
                if n < MIN_CELL: v, n = q(mv_w, (vb, wb), frac)
                if n < MIN_MARG: v, n = q(mv_a, (vb, ab), frac)
                if n < MIN_MARG: v, n = q(mv, vb, frac)
                if n < MIN_MARG: v = allq
                vals.append(max(0.05, v))
            cols.append('[' + ','.join(f'{v:.2f}' for v in vals) + ']')
        rows.append(f'  /* {vb*10:>2}-{vb*10+10:<3} */ [' + ', '.join(cols) + '],')
    return '\n'.join(rows)


def cfg_block():
    counts = d[d.pid >= 0].pid.value_counts()
    pids = sorted(int(p) for p, n in counts.items() if n >= MIN_POLAR)
    out = []
    for pid in pids:
        sub = d[d.pid == pid]
        g = sub.groupby(['vb', 'ab12']).dv.agg(
            n='size', p75=lambda x: x.quantile(.75), p90=lambda x: x.quantile(.90))
        parts = []
        for name in ('p75', 'p90'):
            rows = []
            for vb in range(NV):
                vals = []
                for ab in range(NA):
                    if (vb, ab) in g.index and g.loc[(vb, ab), 'n'] >= MIN_CFG:
                        vals.append(f'{max(.05, float(g.loc[(vb, ab), name])):.2f}')
                    else:
                        vals.append('null')
                rows.append('    [' + ','.join(vals) + '],')
            parts.append(f'   {name}: [\n' + '\n'.join(rows) + '\n   ]')
        out.append(f"  'm{pid}': {{  // {counts[pid]:,} samples\n" + ',\n'.join(parts) + ' },')
    return '\n'.join(out), pids


ds = dec_samples.assign(vb=(dec_samples.sog // V_STEP).clip(0, NV - 1).astype(int))
dg = ds.groupby('vb').dv
decel = ', '.join(
    f'{-float(dg.get_group(vb).quantile(.10)):.2f}' if vb in dg.groups else '1.00'
    for vb in range(NV))

path = HERE / 'js/accel.js'
s = path.read_text()


def splice(s, tag, body):
    a = s.index(f'/*GEN:{tag}*/') + len(f'/*GEN:{tag}*/')
    b = s.index('/*GEN:END*/', a)
    return s[:a] + '\n' + body + '\n' + s[b:]


cfg_body, pids = cfg_block()
s = splice(s, 'P75', pooled(.75))
s = splice(s, 'P90', pooled(.90))
s = splice(s, 'CFG', cfg_body)
a = s.index('/*GEN:DECEL*/') + len('/*GEN:DECEL*/')
b = s.index('/*GEN:END*/', a)
s = s[:a] + decel + s[b:]
path.write_text(s)
print(f'js/accel.js regenerated: {len(pool):,} pooled samples, '
      f'{len(pids)} polar tables ({pids}), {len(dec_samples):,} decel samples')
