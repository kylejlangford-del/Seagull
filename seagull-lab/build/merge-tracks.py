#!/usr/bin/env python3
"""merge-tracks.py — extend races from the start window to the finish.

The archive was harvested to answer questions about starts, so every race holds
exactly 240 seconds: T−150 to T+90. Races run 550 s on average, so the tracker
draws the boats stopping dead 90 seconds after the gun.

This replaces a race's boat tracks with the full window — gun − 150 s to the
finish — from Njord `get_data` CSVs. Point it at a directory of them:

    python3 build/merge-tracks.py data/events/sassnitz-2026.json.gz /path/to/csvs
    python3 build/merge-tracks.py <bundle> <dir> --dry-run

Nothing has to be named or ordered. Each CSV carries its own boat key and its
own timestamps, so the script works out which boat and which race it belongs to
by matching its first sample against every race's gun time in the bundle. A CSV
that matches no race is reported and skipped rather than guessed at.

It accepts either raw `.csv` files or the `.txt`/`.json` tool-result envelopes
the MCP writes (`[{type, text}]`), taking the largest text block — the small one
is a metadata echo that also names the columns and would otherwise be mistaken
for a CSV with no rows.

Two things worth knowing about the arithmetic:

  * Times are ROUNDED to whole seconds, not truncated. Njord's resample grid is
    anchored to the requested window rather than to the gun, so samples land on
    x.000 offsets from an arbitrary start; truncating would put half of them a
    second early and shear every track against the others.

  * `tRange` is rewritten from the merged data. It is what the tracker takes its
    clock and its scrubber from, so leaving it at the old 240 s window would
    load full tracks and still refuse to play past T+90.
"""

import csv
import glob
import gzip
import io
import json
import os
import re
import sys

# Njord's column names -> the bundle's channel names, so a merged race is
# indistinguishable from a harvested one.
COLS = {
    'Lat': 'lat', 'Lon': 'lon', 'SOG': 'sog', 'Heading': 'hdg', 'COG': 'cog',
    'TWD': 'twd', 'TWS': 'tws', 'TWA': 'twa', 'Rate_Of_Turn': 'rot',
    'PC_DTL_m': 'dtl', 'PC_START_LINE_PER_pct': 'linePct',
    'PC_START_RATIO_unk': 'pcRatio', 'PC_TTK_s': 'pcTtk', 'PC_TTS_s': 'pcTts',
    # Carried when a harvest includes them; the laylines use the boat's own
    # target angle in preference to the polar, and leg-aware laylines need Leg.
    'TARG_TWA_deg': 'targTwa', 'TARG_BOAT_SPEED_km_h_1': 'targSog',
    'Leg': 'leg',
}

# The SailGP fleet, by Njord boat key. Extend when a team is added.
TEAMS = {
    'Boat_e353ac44-ae5c-4adc-a92e-fbd8a8c2311a': 'AUS',
    'Boat_47821892-574b-4114-a9e9-506126792fb3': 'BRA',
    'Boat_6f7e371a-249c-4211-934d-df65077534b1': 'CAN',
    'Boat_d1babdba-11f3-43bb-8500-035d76e5ee6e': 'DEN',
    'Boat_11dcbb09-a929-446d-a26a-1f66c68133c3': 'ESP',
    'Boat_a3f1ebbd-6c49-4c02-8a57-240869421e1a': 'FRA',
    'Boat_28154dd4-5034-4278-a231-23c71e703aca': 'GBR',
    'Boat_747fef5e-830d-47b2-a53f-8f11b4ba94c2': 'GER',
    'Boat_7c6f8ecf-e875-478d-8829-df891f0904fb': 'ITA',
    'Boat_64512519-65fa-4e75-9280-dc301eadd72d': 'JPN',
    'Boat_689469a1-f465-4c14-b6d8-bb9f8b1323eb': 'NZL',
    'Boat_ea0aaec5-cdf6-4e20-ba32-099fd9e45949': 'SUI',
    'Boat_d2f8f89f-2496-4459-8066-41180c65f17b': 'SWE',
    'Boat_1ad2c9c9-8cf2-4646-9d1b-38adc117207f': 'USA',
}

# How far a CSV's first sample may sit from gun − 150 s and still be that race.
MATCH_TOL_S = 90


def num(v):
    if v in ('', None):
        return None
    try:
        f = float(v)
    except ValueError:
        return None
    return None if f != f else f          # NaN -> null


def payload(path):
    """(boat key, csv text) from a raw CSV or an MCP tool-result envelope."""
    raw = open(path).read()
    text = raw
    if raw.lstrip().startswith('['):
        try:
            blocks = json.loads(raw)
            text = max((b.get('text') or '' for b in blocks), key=len)
        except Exception:
            pass
    if 'ISODateTimeUTC' not in text:
        return None, None
    m = re.search(r'(Boat_[0-9a-f-]{36})', text)
    return (m.group(1) if m else None), text[text.index('ISODateTimeUTC'):]


def read_rows(text, gun_ms):
    out = {'t': [], 'manoeuvres': [], 'speedCheck': None, 'config': None}
    for c in COLS.values():
        out[c] = []
    for row in csv.DictReader(io.StringIO(text)):
        t = round(float(row['SecondsSince1970']) - gun_ms / 1000)
        if out['t'] and t <= out['t'][-1]:
            continue
        out['t'].append(t)
        for src, dst in COLS.items():
            out[dst].append(num(row.get(src)))
    return out


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    dry = '--dry-run' in sys.argv
    if len(args) != 2:
        sys.exit('usage: merge-tracks.py <bundle.json.gz> <csv-dir> [--dry-run]')
    bundle, folder = args

    with gzip.open(bundle) as f:
        d = json.load(f)

    # first-sample epoch -> race, for matching a CSV to the race it covers
    races = [(r['gunTs'], rid, r) for rid, r in d.items() if r.get('gunTs')]

    files = sorted(f for f in glob.glob(os.path.join(folder, '*'))
                   if os.path.isfile(f))
    touched, skipped = {}, []
    for path in files:
        key, text = payload(path)
        if not text:
            continue
        team = TEAMS.get(key)
        if not team:
            skipped.append((os.path.basename(path), f'unknown boat {key}'))
            continue
        first = float(next(csv.DictReader(io.StringIO(text)))['SecondsSince1970'])
        best = min(races, key=lambda r: abs((r[0] - 150000) / 1000 - first))
        if abs((best[0] - 150000) / 1000 - first) > MATCH_TOL_S:
            skipped.append((os.path.basename(path), 'matches no race in this bundle'))
            continue
        gun, rid, race = best
        if team not in race['boats']:
            skipped.append((os.path.basename(path), f'{team} did not sail {rid}'))
            continue
        b = read_rows(text, gun)
        if not b['t']:
            skipped.append((os.path.basename(path), 'no rows'))
            continue
        was = len(race['boats'][team]['t'])
        race['boats'][team] = b
        touched.setdefault(rid, []).append((team, was, len(b['t'])))

    for rid in sorted(touched):
        race = d[rid]
        lo = min(b['t'][0] for b in race['boats'].values() if b['t'])
        hi = max(b['t'][-1] for b in race['boats'].values() if b['t'])
        race['tRange'] = [lo, hi]
        merged = ' '.join(f'{t}({a}->{b})' for t, a, b in sorted(touched[rid]))
        print(f'{rid}  T{lo:+d}..T{hi:+d} ({hi - lo}s)\n    {merged}')

    for name, why in skipped:
        print(f'  skipped {name}: {why}')

    if not touched:
        sys.exit('\nnothing merged')
    if dry:
        print('\ndry run — nothing written')
    else:
        with gzip.open(bundle, 'wt') as f:
            json.dump(d, f)
        print(f'\n{len(touched)} races extended, {bundle} rewritten')


if __name__ == '__main__':
    main()
