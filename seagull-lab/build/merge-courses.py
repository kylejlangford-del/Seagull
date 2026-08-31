#!/usr/bin/env python3
"""merge-courses.py — put the full course into the 2026 bundles.

The archive was harvested to answer questions about starts, so each race carries
three marks: the two line ends and M1. That is everything a start needs and
nothing a race needs — no gates, no finish, and boundaries only for the handful
of days a course XML happened to exist for.

All of it is in Njord, on `race(key).course`: every element in course order, and
the boundary polygon. This script writes that into the bundles the tracker
already reads, so the whole course draws without touching the track harvest.

    python3 build/merge-courses.py            # all 2026 bundles
    python3 build/merge-courses.py --dry-run  # report, change nothing

Joined on the gun. Njord's `race.startTime` IS the gun time, and every bundle
race carries `gunTs`; matching on that rather than on names means an event whose
bundle is labelled by season rather than by date still lines up, and a race that
does not match is left exactly as it was rather than being guessed at.

What it adds per race:

    course: { legs, elements: [ {type, coord1, coord2}, ... ] }
    raceEndTs                     when the race actually finished
    limits.Boundary               replaced where Njord has one

`raceEndTs` is the number the full-race harvest needs and the reason to write it
now: it is what turns "gun − 150 s to gun + 90 s" into "gun − 150 s to the
finish". Nothing reads it yet.
"""

import gzip
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
COURSES = HERE / 'courses-by-gun.json'
DRY = '--dry-run' in sys.argv


def main():
    if not COURSES.exists():
        sys.exit(f'missing {COURSES} — the course export from Njord')
    bygun = json.load(COURSES.open())
    print(f'{len(bygun)} Njord races with a course\n')

    bundles = sorted((ROOT / 'data' / 'events').glob('*-2026.json.gz'))
    if not bundles:
        sys.exit('no 2026 bundles found under data/events/')

    tot = hit = bnd = 0
    for p in bundles:
        with gzip.open(p) as f:
            d = json.load(f)
        n = h = b = 0
        for race in d.values():
            n += 1
            c = bygun.get(str(race.get('gunTs')))
            if not c:
                continue
            h += 1
            race['course'] = {'legs': c['legs'], 'elements': c['elements']}
            race['raceEndTs'] = c['endTime']
            if c['boundary']:
                race.setdefault('limits', {})['Boundary'] = c['boundary']
                b += 1
        tot += n; hit += h; bnd += b
        flag = '' if h == n else f'   ({n - h} unmatched)'
        print(f'  {p.name:<26} {h:>3}/{n:<3} courses, {b:>3} boundaries{flag}')
        if not DRY and h:
            with gzip.open(p, 'wt') as f:
                json.dump(d, f)

    print(f'\n{hit}/{tot} races matched, {bnd} boundaries written')
    if DRY:
        print('dry run — nothing written')
    else:
        print('bundles rewritten in place')


if __name__ == '__main__':
    main()
