#!/usr/bin/env python3
"""Build data/coast.json — the shoreline, and nothing else.

Why this exists
---------------
Every raster basemap worth having draws more than a coastline. OpenStreetMap
puts maritime and reserve boundaries across open water as long straight lines;
Esri's canvas layers carry roads and administrative borders; CARTO's clean
rendering now wants an API key. On a race course all of that reads as a grid
laid over the water, and none of it is information anybody is racing on.

What a sailor actually wants under a course is the edge of the land. So this
ships that and only that: Natural Earth's 1:10m coastline, cut to boxes round
the venues, simplified to a tolerance finer than anyone can see at racing zoom,
and drawn as plain lines by the renderer. No tiles, no key, no network, and it
works with the aeroplane mode on.

COASTLINES, NOT LAND POLYGONS. A filled polygon clipped to a box gains straight
edges along the cut, which is exactly the artefact this file exists to remove.
An open linestring clipped to a box simply stops.

WHY GSHHG AND NOT NATURAL EARTH. The obvious source, Natural Earth 1:10m, is
built for world maps: around these venues its shoreline carries a vertex about
every 1.3 km, so at a scale bar of 200 m the coast would be drawn as a handful
of long straight segments — which is the artefact this file exists to remove,
reintroduced by the fix. GSHHG at full resolution is the shoreline dataset the
oceanographic world uses, roughly a vertex every 100 m, and it ships inside the
pip package basemap-data-hires.

Run: pip install basemap-data-hires --break-system-packages
     python3 build/coast.py
"""
import json, math, os, struct
import numpy as np

SRC = 'pip install basemap-data-hires'      # ships GSHHG full resolution
GSHHS = '/usr/local/lib/python3.11/dist-packages/mpl_toolkits/basemap_data/'
OUT = 'data/coast.json'

# Half-width of the box kept around each venue, in degrees of latitude.
# 0.75° is about 83 km — far more water than any course, and cheap.
PAD = 0.75

# Simplification tolerance in degrees. 1e-4° is ~11 m of latitude — under half a
# boat length, and finer than the line it is drawn with at any zoom this tool
# offers. It is here to drop collinear runs, not to lose shape.
TOL = 1e-4

# GSHHG levels: 1 land/ocean, 2 lake, 3 island in lake. Lakes are in because
# Geneva is a venue and its shoreline IS a lake shore.
LEVELS = {'1', '2'}

# Every venue in the manifest. Coarse centres — they only have to be within a
# box's width of the real thing, and the box is 83 km.
VENUES = {
    'abu-dhabi':     (24.51, 54.36),
    'sydney':        (-33.85, 151.24),
    'christchurch':  (-43.60, 172.72),
    'bermuda':       (32.30, -64.79),
    'canada':        (46.24, -63.13),
    'new-york':      (40.69, -74.03),
    'san-francisco': (37.81, -122.42),
    'dubai':         (25.09, 55.14),
    'auckland':      (-36.84, 174.77),
    'los-angeles':   (33.73, -118.27),
    'portsmouth':    (50.78, -1.10),
    'sassnitz':      (54.51, 13.66),
    'st-tropez':     (43.27, 6.64),
    'geneva':        (46.21, 6.16),
    'cadiz':         (36.53, -6.29),
    'perth':         (-31.98, 115.84),
    'rio':           (-22.91, -43.16),
    'halifax':       (44.65, -63.57),
    'taranto':       (40.47, 17.24),
    'singapore':     (1.26, 103.83),
    'copenhagen':    (55.68, 12.60),
    'plymouth':      (50.36, -4.14),
    'chicago':       (41.88, -87.61),
    'saint-tropez':  (43.27, 6.64),
}


def boxes():
    out = []
    for lat, lon in VENUES.values():
        # a degree of longitude shrinks with latitude; keep the box square in km
        k = max(0.2, math.cos(math.radians(lat)))
        out.append((lat - PAD, lat + PAD, lon - PAD / k, lon + PAD / k))
    return out


def inside(p, b):
    return b[0] <= p[1] <= b[1] and b[2] <= p[0] <= b[3]


def clip(line, b):
    """Every run of points inside the box, each kept with one point of overhang
    so a shore that leaves the box still leaves it cleanly rather than stopping
    short of the edge."""
    runs, cur = [], []
    for i, p in enumerate(line):
        if inside(p, b):
            if not cur and i:
                cur.append(line[i - 1])
            cur.append(p)
        else:
            if cur:
                cur.append(p)
                runs.append(cur)
                cur = []
    if cur:
        runs.append(cur)
    return [r for r in runs if len(r) > 1]


def simplify(pts, tol):
    """Douglas-Peucker, iterative so a long shoreline cannot blow the stack."""
    if len(pts) < 3:
        return pts
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        if b <= a + 1:
            continue
        ax, ay = pts[a]
        bx, by = pts[b]
        dx, dy = bx - ax, by - ay
        den = math.hypot(dx, dy)
        worst, wi = -1.0, -1
        for i in range(a + 1, b):
            px, py = pts[i]
            d = (abs(dy * px - dx * py + bx * ay - by * ax) / den) if den else \
                math.hypot(px - ax, py - ay)
            if d > worst:
                worst, wi = d, i
        if worst > tol:
            keep[wi] = True
            stack.append((a, wi))
            stack.append((wi, b))
    return [p for p, k in zip(pts, keep) if k]


def main():
    meta = GSHHS + 'gshhsmeta_f.dat'
    if not os.path.exists(meta):
        raise SystemExit('no GSHHG data — run: ' + SRC)
    bs = boxes()
    latlo = min(b[0] for b in bs)
    lathi = max(b[1] for b in bs)

    lines, pts_in, pts_out = [], 0, 0
    fh = open(GSHHS + 'gshhs_f.dat', 'rb')
    for row in open(meta):
        c = row.split()
        if c[0] not in LEVELS:
            continue
        south, north, off, nb = float(c[3]), float(c[4]), int(c[5]), int(c[6])
        # cheap reject on latitude alone: the meta carries no longitude bounds
        if north < latlo or south > lathi:
            continue
        fh.seek(off)
        part = np.frombuffer(fh.read(nb), dtype='<f4').reshape(-1, 2).tolist()
        pts_in += len(part)
        for b in bs:
            if north < b[0] or south > b[1]:
                continue
            for run in clip(part, b):
                s = simplify(run, TOL)
                if len(s) > 1:
                    lines.append([[round(x, 5), round(y, 5)] for x, y in s])
                    pts_out += len(s)
    fh.close()

    json.dump({'note': 'GSHHG full-resolution shoreline (public domain), '
                       'clipped to venue boxes and simplified',
               'tolDeg': TOL, 'lines': lines},
              open(OUT, 'w'), separators=(',', ':'))
    kb = os.path.getsize(OUT) // 1024
    print(f'{len(lines)} lines, {pts_out} points (from {pts_in}) -> {OUT}, {kb} KB')


if __name__ == '__main__':
    main()
