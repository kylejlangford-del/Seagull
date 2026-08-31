# Seagull Lab — combined deploy package

This package contains:

- `/` — Seagull Lab homepage
- `/ac40-geometry/` — latest AC40 Geometry build (v4-11)
- `/start-geometry/` — Start Geometry calculator

## Start Geometry calculation

The 90° TWA speed table used is:

TWS 7,8,9,10,11,12,13,14,15,16,17 kn
BS 25.8,27.5,29.0,30.5,31.8,32.9,34.0,34.9,35.7,36.3,36.9 kn

Linear interpolation is used between table rows.
Time is calculated from distance / boat speed with 1 kn = 0.514444 m/s.
