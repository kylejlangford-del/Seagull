# Seagull Lab · Live Race Tool

The start-review tracker, taken out of the review page and rebuilt as a live
tool. One screen, two modes, and the same code behind both: watch a race happen
and read your numbers while there is still time to do something about them.

It runs **offline first, on purpose**. Everything here is driven by an archived
race released sample by sample at wall-clock rate, so the tool has never seen
data from the future — which is the only way to know it will still work when the
data really is arriving one second at a time. Swapping in a real feed is a URL
parameter, not a rewrite.

## Running it

Static site, no build step, but it must be *served* — opening `index.html` off
the filesystem fails, because the browser blocks the `fetch` calls that load the
data.

```
python3 -m http.server 8000     # then open http://localhost:8000
```

| URL | what it does |
|---|---|
| `/` | **REPLAY** — an archived race at wall-clock rate, with play / pause / scrub |
| `/?tab=live` | **LIVE** — connect a socket, or run the mock feed |
| `/?live=wss://host/…` | open straight onto a live socket |
| `/?race=sassnitz-2026-08-23-1512` | open one race directly |

Run the mock feed first. It is the live pipeline in full — the message protocol,
meta-before-samples ordering, the wall-clock gun countdown, the LAG readout,
reconnect handling — with only the transport faked. If a change survives mock
live, it will survive live.

## The screen

**Two tabs, one page.** LIVE and REPLAY are the same tracker; the tab decides
which feed is attached and whether the scrubber and the archive picker are on
screen. There is no second page to keep in step — the difference is nine lines
of CSS and one branch in `setTab()`.

**The map is everything that is left over.** The layout is a full-viewport grid,
not a scrolling page: the header, the rail and the bottom bar take what they
need and the map gets everything else. Its height is measured from the
DOM each time the window changes and handed to the renderer, so the tracker is
always as big as the screen allows.

**The rail on the right** is the readouts on top — MY BOAT, then the fleet — and
the function menu underneath, scrolling. Every control on it is one entry in the
`PANELS` array in `app.js`, and it arrives with its label, its widget and its
wiring. Adding the tenth control costs what adding the second one cost:

```js
{ kind: 'toggle', label: 'MY NEW THING',
  get: () => THING.on, set: v => THING.on = v,
  dep:  () => SOMETHING_ELSE.on,          // optional: hide the row while off
  hint: 'what it draws, in one short line.' },
```

`kind` is `toggle`, `num` (with ± steppers), `select` or `button`. That is the
whole API.

#### Making thirty-eight controls navigable

Ten sections and thirty-eight controls is past the size where a list is a menu.
Four rules do the work, and none of them is "write less":

**A control that depends on another is not drawn.** `dep()` hides the row
outright rather than dimming it — BASEMAP FADE with no basemap, DAMPING on a
source that has nothing to damp, MARK ZONE with the course limits off. Ten of
the thirty-eight are conditional, so the rail with everything switched off shows
twenty-eight rows and the rail with everything on shows thirty-six. You are
never scrolling past a control that cannot do anything.

**Every section carries its own state in its header.** `PRESETS · 4`,
`BOATS · 30s · colours · 15s`, `ROUTE · this leg · next`, `WIND · off`. The rail
reads shut, which is the state it is in most of the time, so opening a section
is something you do to change a setting rather than to find out what it is.

**A filter box, because ten sections is short enough to scan and long enough
that "which section owns DAMPING" is a real question.** Type three letters and
only matching rows survive, in only the sections that have one; the sections it
opens are forced open for the duration and the remembered open-set is untouched,
so clearing the box puts the rail back exactly as it was. Filtering is
presentational only — nothing is disabled — so a filtered rail cannot change
what the map draws. A row its own `dep()` has switched off does not count as a
match, or you get a section that opens onto nothing.

**The prose is behind a switch.** Every control still carries its one-line
explanation; it shows as a hover tooltip always, and inline under the control
when HELP is on. Off by default. The explanations were the right thing to write
and the wrong thing to leave in the column you are trying to scan.

**Sections fold.** Click a heading to open it, click it again to shut it; ⇱
collapses the lot. What you leave open is remembered in the browser, and
everything but VIEW starts shut.

### Presets

Thirty-eight settings and climbing, against a race that is really only four or
five moments. A **preset** is one of those moments — every setting at once, one
click — and they sit on a thin bar across the top of the tracker with the
switches worth reaching for mid-race beside them.

A preset **is** the PANELS array. There is no second list of what a preset
contains, because a second list goes stale the first time a control is added and
nobody remembers to update it. Every control that can be read and written is in,
keyed `PANEL/LABEL` — which is why CROSSWIND and LAYLINES can both own a control
called WIND FROM without colliding. ZOOM opts out: it is transient and it pairs
with a pan the presets do not carry, so restoring one without the other would
land you somewhere you had never been.

**Chips light by comparison, not by memory.** A preset is lit while the settings
match it and goes out the moment you change one — nothing to keep in sync, and
it cannot tell you that you are in PRE-START when you are not. Change a setting
and every chip goes dark; change it back and the chip returns.

The **PRESETS** panel at the top of the rail does the rest: click a name to
apply it, SAVE to overwrite it with the settings as they are now, RENAME (an
inline field, not a `prompt()` — a modal dialog blocks the page and is a poor
thing to meet mid-race), × to delete, and a name box with SAVE CURRENT to add
one. All of it in `localStorage`, so it is per-browser and survives a reload.

Four ship, and they are seeded as small **overrides on the app's own defaults**
rather than as full snapshots, so a seed never has to be rewritten when a
control is added — it simply inherits the new default:

  *PRE-START* — start geometry always on, the wave, the projection, the fleet
  in frame. *RACING* — crosswind rung and laylines to the next mark, the
  boat-offset camera, start geometry retired. *FLEET* — the whole course with
  the overlays off and long trails. *WIND* — the field and the live readings
  with 45 s of drift, over the whole course.

Renaming a section renames its keys, so the rail's reorganisation would have
emptied every preset anyone had saved. `PRESET_RENAMES` carries the old key to
the new one on load and writes it back under the new name; and a key a stored
preset has simply never heard of is now skipped rather than counted as a
mismatch, to match what `applyPreset` already did with it — otherwise adding one
control would darken every chip a user had ever saved, applied correctly and
reported as not applied.

Verified end to end: every key unique; every preset round-trips exactly and
lights only its own chip; one setting changed puts every chip out and undoing it
brings the chip back; save, rename, delete and add all work through the UI and
survive a reload.

The bar's right-hand end carries **CROSSWIND**, **ROUTE**, **NEXT LEG** and
**WIND FIELD** as switches. The wind-field one remembers which sources you had chosen —
marks, boats or all — and puts that back rather than jumping to *all sources*
every time it is switched on.

### The route

On a stadium course the beat is not a free choice of when to tack — it is a
corridor. You sail your target angle until the boundary stops you, tack, cross,
tack again, and the only real decision is when you leave the corridor for the
layline. So the useful picture of the next leg is exactly that: **the track you
would sail bouncing boundary to boundary at your target angle, taking the layline
when it comes.**

It is a route, not a forecast. Nothing in it knows about the wind shifting, the
other boats, or what you will actually decide. What it does say honestly is the
*shape* of the leg — how many tacks it costs, where they fall, which side runs
out first, and how far off the corner the layline really is. That is the thing a
pair of laylines cannot show you.

**Two switches, two legs.** **ROUTE** is the leg you are on: from the boat to
the mark it is sailing to, drawn solid. **NEXT LEG ROUTE** is the one after:
from the mark you round to the one beyond it, drawn dashed in the same colour —
the dash says *and then*, not *something else*. They are separate because they
answer separate questions, and because the second is only worth looking at once
you have settled the first. Either can be on alone.

**It forks at the boat: HOLD, or switch now.** The decision you are actually
making is not which gate mark — that is minutes away — it is whether to hold
this gybe out to the boundary or swap onto the other one right now. So the
current leg draws both: **HOLD** in green carries on and turns where the water
runs out, **GYBE NOW** (or TACK NOW, named for the leg) turns immediately and
takes the other side. The switch is charged the manoeuvre it costs, so the two
totals are comparable. Each branch ends at whichever gate mark *it* lays for
less and the label says which — `HOLD · R · 1682 m`. No turn count here: on the
leg you are already sailing the question is which way to go, not what it costs
to arrive, and the number was one more thing to read past. Across race 5 both
branches drew at all 297 moments and differed materially at 245 of them.

**It runs to a real mark, not to the middle of a gate.** You do not sail to the
midpoint of a gate — you sail to one of its marks, and the layline and the
corridor are different for each. Aiming at the midpoint ended the route where
there is nothing to round, up to **110 m** from either mark on a 220 m gate, and
bent the whole approach to suit it. Each branch now runs to whichever mark of
the destination it lays for less: **501 and 581 branches across two races, every
one ending on a real mark, none on a midpoint.**

*What the API actually says.* Njord's `RaceCourse` carries more than the ordered
element list this tool was inferring from, and it is worth writing down what was
checked rather than assumed. `coord1` is documented as the **port** coordinate
and `coord2` the **starboard** one, so the sides are declared rather than
guessed — the geometric left/right this tool computes from the boat's approach
agrees with that declaration on **1086 of 1086** branches across three races, so
the inference was right but it no longer has to be. `legs === elements − 1`
holds on all 32 courses at the event, which is the mapping the leg-aware code
depends on. `markZoneRadius` and every field of `RaceCourseSettings` —
including `boundaryWidth` — are **null on all 32**, so the 50 m mark zone and the
80 m boundary band remain the tool's own defaults rather than the course's real
figures. `boundaryPrestart` and `lineSegments` are null too. `dashedLineSegments`
is populated on all 32 and is **not drawn** — two large polygons well outside the
racing boundary, likely the overall area limits, and the bundles do not carry
them yet. The schema also has an `Offset` element type, unused at this event and
unhandled here.

**The next leg runs from BOTH gate marks, on opposite tacks, crossing.** You
round from *inside* the gate and out: you sail between the marks, turn up around
the one you picked, and that turn puts you heading back **across** the course
rather than away from it. So the two branches cross over each other out of the
gate — blue off the left mark leaving on **port**, violet off the right mark
leaving on **starboard** — each bouncing off the boundary in its own right, each
labelled with the turns it costs. Fanning them outwards, which is what taking
the tack at face value gives you, is the one thing a gate rounding never does.

**A clock on the first board.** Rounding a mark, the number you are counting
down is not how long the leg takes — it is how long you are on this board before
the corridor makes you turn. So each next-leg branch carries the seconds from
the mark to its first turn, drawn large at that turn. Distance over the boat's
own target speed for the mode: `TARG_BOAT_SPEED` rides along beside
`TARG_TWA` in the same channel, so the same table that says what to steer says
how fast it goes — this boat, this wind, rather than a guess. Race 5 gives 56.2
km/h upwind and 71.1 downwind at the median. Checked over 501 branches: **every
one exactly `first run ÷ target speed`, worst error 0.000000000 s.** A branch
whose first run ends at the mark rather than at a turn shows no clock, because
there is no board to count down.

**Before the gun it looks past M1.** There is no leg number yet, but there is no
doubt about the course either: everyone is sailing leg 1, and the leg *after* it
is the one worth thinking about while you still have time to think. So the
pre-start default is leg 1 — this leg to M1, next leg M1 to the gate beyond it —
and it holds until the boat's own leg count takes over at the rounding. Verified
at T−140, −90, −40 and −5: drawn every time, this leg ending at M1 and the next
at the gate after it.

**The rounding sets the exit tack, everywhere.** A turning mark is rounded to
port — a left turn, every time, the way these courses are laid — so you come out
of it on **starboard**. Only a gate has a choice in it, and there the two marks
turn you opposite ways: left mark to port, right mark to starboard. Letting a
turning mark simply continue on whatever tack it arrived on was wrong, and drew
M1 exits on port that would never be sailed. Checked across two races: **402
branches out of a turning mark, every one leaving on starboard, none on port**,
and 983 of 983 tack labels matching the heading actually drawn, gates included.

Whether that first board runs to the boundary or straight to the mark is then
pure leg geometry, and the two single marks at Sassnitz land on opposite sides
of it: leg 1 out of M1 runs **179° off the wind against a 143° target**, dead
downwind, so it gybes every time — 5 of 5. Leg 5 out of M2 to the finish runs
**121° against a 129° target**, inside the band, a genuine reach, so it sails
straight — 81 of 101.

**Each leg is named after its own manoeuvre.** Beat or run is asked separately
for this leg and the next, because they are usually opposites — 272 of the 279
leg pairs in race 4 have different modes. A run into a beat is *gybe now*
followed by some number of **tacks**, and naming the second lot after the first
was simply wrong.

Checked separately for upwind and downwind next legs, across three full races:

| next leg | moments | both marks | opposite tacks | word | bounced | on the layline angle |
| --- | --- | --- | --- | --- | --- | --- |
| upwind | 362 | 362 | 362 | 362 ✓ 0 ✗ | 724 / 724 | 2326 ✓ 0 ✗ |
| downwind | 333 | 333 | 329 | 333 ✓ 0 ✗ | 660 / 666 | 1649 ✓ 0 ✗ |

Nothing mislabelled in either mode, every gate drawing both marks, and every
target-angle segment exactly on the layline. The four downwind gates without
opposite tacks and the six straight branches are the same handful of fetches —
one clear run to the mark, no turns, so no tack is claimed. Two things were wrong before. It drew only the mark this leg happened to
favour, which threw away the entire point of looking a leg ahead — seeing what
*each* gate gives you. And it took the exit tack from how the boat *arrived*,
which had both branches leaving on the same one: not a choice at all. The tack
you leave on is set by which mark you round, and by the fact that you round it
from inside the gate outwards — which is the whole reason a gate is a decision,
and why the two branches cross.

Checked over race 5: of 152 moments approaching a gate, **all 152 drew both
marks**, all 304 next legs began exactly on a gate mark, **298 left on the tack
their label claims with none wrong**, and **148 of 152 gates put the two
branches on opposite tacks with none on the same tack**. The remaining few are
legs that are simply fetched — one straight run, no turns — where there is no
tack being sailed, so the label does not claim one rather than printing STBD
over a rhumb line. This leg is the
green/amber pair and the next the blue/violet, so four lines on one map never
have to be told apart by dash alone.

**The route sails the layline angle, exactly.** They were a few degrees apart,
and in the worst case a hundred, because the two used different rules: the
laylines took the mode from the leg's approach bearing while the route took it
from the bearing from the boat, and they tested it against different thresholds.
Both now use the same bearing, the same test and the same wind, so the number is
the same by construction and the route's run into a mark lies along that mark's
layline rather than near it. **Both stages**, measured over three full races:

| | target-angle segments | off the layline angle | worst |
| --- | --- | --- | --- |
| current leg | 3777 | 8 | 0.30° |
| next leg | 4276 | 0 | 0.0000° |

The next leg is exact because it starts at a mark, so its geometry is the plain
leg case. The current leg starts wherever the boat happens to be, and its eight
exceptions are fetches sitting a fraction outside the classifier's tolerance
rather than segments at the wrong angle. Neither stage ever failed to produce a
route across the three races.

**Fetching, and why the boundary decides it.** A leg you could lay directly at
an angle you would sail anyway needs no tacks — but only if the straight line
stays in the water. A boundary across that line is exactly why you tack: not
because the angle is wrong, but because the course runs out first. Leave that
second test out and almost everything becomes a fetch, since the band between
the upwind and downwind targets is nearly ninety degrees wide and a mark rarely
sits outside it — which is the difference between a route and a rhumb line. With
it, race 5 draws 980 target-angle segments against 130 fetches. And if the
corridor is exhausted without laying the mark, that branch draws nothing rather
than a straight line at an angle nobody would sail. Drawing the
midpoint answers a question nobody asks. So both branches are drawn — **LEFT**
in green and **RIGHT** in amber, each labelled with the tacks and the distance
it costs, the cheaper one bold. Left and right are the *boat's*, from the cross
product of its approach with each mark's offset from the gate centre, because
"go left at the gate" means the one on your left as you come at it — not the
screen's left and not the wind's. Only the first gate forks; beyond it each
branch takes midpoints, since forking every gate doubles the picture at every
mark and the second decision is not one you are making yet.

**The angles come from the boat's own CSV, not the polar.** The harvest carries
`TARG_TWA_deg` beside `TWS` at every sample, so each race already contains this
boat's target angle paired with the wind it was measured in — hundreds of
readings, in both modes, from its own onboard tables. One sample is not enough,
because `targTwa` only describes whatever the boat is doing at that instant; but
across a race the two modes separate cleanly at 90°, so both curves fall out of
the same channel. Read back as the median of every reading within a few km/h of
the wind you are in right now, widened until there is enough to be worth a
median — robust to the handful logged mid-manoeuvre. For AUS in race 4 that is
455 upwind and 241 downwind samples, and the curve behaves the way it should:

| TWS | upwind | downwind |
| --- | --- | --- |
| 20 km/h | 51.4° | 139.2° |
| 32 km/h | 50.7° | 141.4° |
| 44 km/h | 49.0° | 144.8° |

Tighter upwind and deeper downwind as it builds. The polar stands in only where
the harvest carried no targets at all — the 2024–25 events, and any race
predating the channel.

**The wind is its own setting, and it is live.** The route defaults to the
boat's masthead damped over **10 seconds**, not the race average: a route is
about the water in front of you now, and a shift you are already in should bend
the corridor. Ten seconds is short enough to follow a real shift and long enough
that the corridor does not shimmer — measured, the route's TWD sits between −5.4°
and +10.5° of the race average through race 4, and moves at 0.13°/s at the median
and 0.48°/s at its worst, so it tracks without twitching. It runs through the
same fault gate and settling as everything else, so a bad window walks it back to
the race TWD rather than throwing the whole corridor sideways. Both this and the
crosswind rung now ask one shared `settledWind` function with their own source
and damping, so they can never disagree about what the wind is doing.

The rest is pieces already there: the boat's `Leg` for which mark, and the
boundary polygon — the *inside* edge, the last water you
may sail, which is exactly the right thing to bounce off. A leg you can lay at
an angle you would sail anyway is a reach, and gets the rhumb line rather than
an invented tack. HOW FAR chains it mark to mark, each leg starting on the tack
the one before it finished on, up to the rest of the course.

Drawn solid (and dashed for the next leg) where the laylines are short-dashed
and the rungs long-dashed, with a dot at each tack — several overlays can be on
at once and each has to be identifiable without a legend. Each branch's label is
anchored at the **gate mark that distinguishes it**, not at the end of its
route: with NEXT LEG on, both branches finish at the same mark, so labelling the
tail puts two long strings at one point. It sits outward from that mark — left
of the left one, right of the right one — and carries the totals over whichever
stages are actually on screen, because judging a gate choice by a leg you are
not looking at would be a strange thing to do.

Checked across every boat and every 10 s of race 4: **293 zigzag segments, every
one sailed at a target angle to within 0.0000°**, and **0 of 93 route corners
outside the boundary**. Of 294 sampled moments it called 142 beats, 94 runs and
58 reaches — leg 1 at Sassnitz coming out as a reach with no tacks, which is what
a SailGP first leg is. Of 197 moments approaching a gate, **all 197 drew both
branches and all 394 branch labels matched an independent cross-product check,
with none wrong**; the 97 single-mark moments each drew one route. And the fork
is worth drawing: across 32 sampled gate approaches the two branches differ in
tack count 9 times, with the distance between them reaching **121 m**.

The two stages were checked the same way, over 294 moments: **0 faults in stage
one** (it starts at the boat and ends on a mark of the current leg's element),
and of 473 branches carrying a next leg, **all 473 begin exactly where stage one
ends, none at the wrong mark**. The two branches' next legs differ by 69 m — the
same figure every time, which is right: with the next leg a rhumb line from
either gate mark to the same following mark, the difference is fixed geometry
rather than anything that varies with the moment.

The **VIEW** and **LOOK** panels hold the camera and the palette. Boats are drawn at **true F50 scale** — 15.0 m by
8.8 m — so two boats a length apart are a length apart on screen and a hull over
the line really is over the line. Zoomed out far enough 15 m is a few pixels, and
rather than quietly inflating the boat (which would make every distance on the
map a lie) the hull stays true and gets a locator ring. There was an
exaggeration multiplier; it is gone. A map you can read a distance off is worth
more than a boat you can see from further out, and one setting silently turning
every distance on screen into a lie is not a trade worth offering.

**ORIENTATION** decides which way is up. Every coordinate the renderer touches
already lives in the frame's rotated space — start line vertical, windward up —
which is the course's own orientation and the right default, but not the only
one worth having:

  *aligned with course* — the racetrack upright, the way it has always been
  drawn.

  *aligned with wind* — the wind straight down the screen, so a shift shows up
  as the course leaning rather than as a number changing.

  *target boat heading* — MY BOAT pointing up, the way the crew sees it. The
  heading is a short circular mean of course-over-ground rather than the
  instantaneous value: an F50 yaws several degrees a second, and a map hung off
  a raw heading is unreadable and faintly sickening.

  *north up* — the world's orientation, for placing the racetrack in it.

**It is one rotation, applied in one place: the point transform.** Everything
downstream — laylines, routes, hulls, wind arrows, the boundary band, the
basemap — goes through that transform and turns for free. The canvas itself is
never rotated, which is the whole reason for doing it this way: labels, plates
and the scale bar stay upright, and a tilted caption over an upright plate never
arises.

Three things had to follow it rather than being rotated by it. **Bearings**: a
compass bearing B appears at screen angle B − rot, so it becomes B − rot − φ —
one term, added at four sites. **The viewport fits**: a bounding box has to be
measured along the *screen* axes or a rotated course overflows its own frame, so
points go forward through the rotation, the box is taken there, and the centre
comes back out — which is exactly consistent with a transform that rotates about
that centre. **Pan**: a drag is a screen movement, so it comes back through the
rotation before it moves the centre, or dragging right slides the map off at
whatever angle the frame happens to sit at.

Checked in all four orientations: the bearing at the top of the screen is the
one the mode names (the frame's own 253.4°, TWD 256.1°, the boat's damped
204.2°, and 000.0°); the screen bearing of a known course leg matches
`true − up` to **0.000000°**; the transform preserves distance to **0** — pixels
per metre equals the viewport scale exactly, so it is a rigid rotation and not a
shear; a 120 × 60 px drag moves the content by exactly 120 × 60 px in every
orientation; and the crosswind rung stays square to the wind on screen to
**0.000000°** in all four.

**VIEWPORT** has four:

  *follow fleet* — the boats, and the start line with them until the gun, after
  which the line is allowed to leave the frame behind the fleet. Before the gun
  it is the fleet fit clamped so it never zooms in tighter than the line, which
  gives the pull-in for free and cannot lose a boat by construction.

  *whole course* — every mark, gate and the finish, with the fleet wherever it
  is on the track.

  *target boat* — a camera on MY BOAT, centred. Verified: the boat is 0.000000 m
  off centre at every sample of a race.

  *target boat offset* — MY BOAT a third of the way in from the trailing edge,
  so two thirds of the screen is the water it is sailing into rather than the
  water it has crossed. The offset follows the bearing to the mark its leg says
  it is sailing to, so the view swings round at every rounding by itself.
  Measured across 96 frames on every leg: the boat lands at 0.3333 of the screen
  from the trailing edge — min, median and max — on a bearing 0.000002° off the
  bearing to its next mark.

Both boat cameras hold a **fixed** piece of water rather than taking the fleet
fit's scale. A camera centred on you that also zooms with the spread of the
fleet is moving for two reasons at once and neither is legible; these hold still
(scale constant to 4 decimal places across a race, against the fleet fit's
0.92–6.05) and let the boats come and go across the frame. The piece is sized
from the course itself, once per race, so a big course gets a big view without a
hard-coded metre count that happens to suit Sassnitz.

**THEME** turns the whole player over, light or dark, and **WATER** now offers
eleven shades from black through to white. The chrome is entirely CSS variables,
so light mode is eleven values redefined and nothing else; the canvas is not CSS
and is told separately.

The map is not just recoloured, it **inverts**. Every ink here was picked to sit
on near-black water: pale labels, near-black haloes behind them, a grid drawn as
a faint lift. Put white water underneath and all three reverse meaning — a pale
label on a pale sea with a black halo is a smear. So the background colour is
the switch: its luminance flips the halo to near-white, the grid from a lift to
a shade, the compass rose and captions to their darker twins, and the hull rule
from *raising* dark team colours off black to *holding bright ones down* on
white. Measured: a navy hull that gets lifted to `rgb(31,117,255)` on black is
left alone at `rgb(11,42,92)` on paper, while a bright yellow that passes
untouched on black is pulled from `rgb(255,225,77)` to `rgb(186,164,56)`. One
derived value, one place to set it, no second palette to keep in step.

Switching theme carries the water with it, because pale labels on a pale sea is
not a theme but a bug — unless the water already suits, so a deliberate choice
of white water in dark mode survives. The choice is remembered per browser.

**BASEMAP** puts OpenStreetMap under the course, so the racetrack sits somewhere
in the world instead of in a black void. Off by default: it needs the network,
and every ink on this map was picked against near-black water. BASEMAP FADE
controls how strongly the world shows through — the course has to stay the thing
you are reading.

The awkward part is that this tool does not work in latitude and longitude at
all. Everything lives in a local metric frame rotated so the start line stands
vertical; tiles are Web Mercator, north up. Rather than convert the course into
Mercator, the tiles are drawn under a canvas transform that maps Mercator pixels
onto the map — one linear map, built by pushing the two Mercator basis vectors
through the very same chain every mark goes through: pixels to metres, metres
east/north into the rotated frame, rotated frame to screen. Whatever that chain
does the tiles do too, rotation included, so they cannot drift out of register
with the course by construction. The frame now carries the origin it was
measured from, without which the rotation is one-way and nothing can be
projected back out to a latitude and longitude.

Checked by taking every mark's true position, pushing it through the basemap
transform, and comparing against where the renderer's own `tX`/`tY` put it:
**0.41 px at worst**, and the frame inverse round-trips to **0 m**. The residual
is the frame's flat-earth approximation against Mercator's conformal one, which
over a 2 km course is a fraction of a pixel. It picks the zoom whose tiles come
out nearest 1:1 with the map — zoom 15 at Sassnitz, 1.10 tile pixels per map
pixel — caches tiles, caps them at a viewport's worth and six in flight, and
draws the OpenStreetMap credit whenever the layer is on, which their tile policy
requires rather than merely appreciates.

Also here: WATER, LABELS, FLEET BRIGHTNESS, SMOOTHING, TRAILS and ZOOM
(down to 0.1×).

**LAYLINES** draws back from a mark on the boat's target angle — **starboard
green, port red**, the tack you would be on to sail it. The wind behind them is a
choice, because the two answers differ and the difference is the point: the
masthead of the boat you are watching says what *it* is sailing in, the marks say
what is waiting up there. Both are damped over 1–60 s, because an undamped 1 Hz
TWD swings a layline several degrees a second and a layline that dances is worse
than none.

**Where they go: the two gates you are about to round, and only those.** There
was a DRAW TO menu here — next mark, next two marks, every mark — and the only
two you ever want are the two you are laying, so the menu is gone and the rule
is the one rule.

Picking *which* two took a second pass to get right. A SailGP course carries
three gates and rounds them in a set order, so "the bottom gate" is not a fixed
piece of water: the one you round on lap one is a different mark pair from the
one you round on lap two, and both sit on the map at once. Choosing them by
projecting every gate onto the wind axis gave a single answer for the whole
race — and on the leg after M1 it drew the leeward laylines to the *other*
leeward gate, half the course away, while the route beside it ran correctly to
the gate actually being sailed to.

So the laylines now read the leg the same way the route does: **the next two
gates in course order from the element you are sailing to.** On a
windward-leeward course that is one leeward and one windward, and they roll
forward by themselves at every rounding. Each carries the bearing of the leg
into it, which is what decides beat-or-run, and is named TOP or BOTTOM by that
rather than by where it sits on the screen. Past the last gate there is nothing
left to call a top or a bottom, so the final leg gets the mark it is actually
sailing to instead of a gate rounded a lap ago.

Checked over 2,773 moments across four races and every boat: **the first target
is the correct next gate 2,773 times out of 2,773**, and wherever two are drawn
they are one TOP and one BOTTOM, 1,227 of 1,227.

**One pair per mark, not per gate.** A gate is two marks and you round one of
them; a layline to the middle of a gate is a line to a place there is nothing to
round, up to half a gate away from either mark. At Sassnitz the gates are 212–220
m wide, so that is a hundred metres of error in exactly the decision the line
exists to serve. Each mark now gets its own port and starboard layline — four
per gate, eight on the map — and because the two marks' lines on a given tack are
parallel, one caption serves both, on whichever of the pair has more line under
it to carry it.

**They stop at the boundary.** They used to run past it on purpose: a layline is
a line you want to see coming from a long way out, so the length was the boundary
box's diagonal plus a fifth, which provably left the course whatever the mark and
whatever the bearing. That was the right call for two long lines and the wrong
one for eight — eight lines crossing the whole racetrack is a cat's cradle, not a
picture. The boundary is also the honest place to stop, because water outside it
is water you may not sail in, so the part of a layline beyond it is not a line
you could ever be on. Each ray is now cast at the boundary and cut at the first
crossing. Measured across four races and every boat: **8,474 layline ends, 8,474
of them on the boundary**, none anywhere else, and none starting from a gate
midpoint. Median length 750 m against the 3,405 m they used to draw. The angle
label sits half way along, capped, so a line cut short by a near boundary keeps
its caption on top of itself rather than out in the red zone.

**WIDEN trims the angle by hand.** The target angle is derived from TWS, and TWS
is the least reliable channel on the boat — a masthead reading low hands back an
angle that is wrong in exactly the place it matters, and no amount of damping
fixes a bias. So the angle can be nudged: **+ opens the two laylines away from
each other, − pulls them in**, ±20°.

"Wider" has to mean the same thing at both ends of the course, and that is not
the same arithmetic. Upwind the laylines sit at TWA θ either side of the wind and
separate as θ grows; downwind they sit at θ from the wind with the run between
them, so their gap is 180 − θ and they separate as θ *shrinks*. One number,
opposite signs. At +10° on race 5 the top gate's cone opens 104.2° → 124.2° and
the bottom gate's 79.4° → 99.4° — both wider, which is what the control says.

**It moves the route with them.** The two were deliberately made to agree — the
route's last stretch into a mark lies along that mark's layline — and a trim that
shifted only the dashed lines would pull them apart again. So it is applied in
`nextLegAngles`, the single place the route, the next-leg route and the laylines
all read their angles from, and the target *speeds* are left alone: the trim
corrects a bad angle, not a bad speed. Checked at −7°, 0° and +7° across four
races: **every route segment still lands exactly on the trimmed target angle**,
and every branch still leaves its gate mark on the tack its label claims. The map
prints the trim next to the angle — `TOP P 55° +8` — so the number on screen is
never a claim about the boat's targets that the boat's targets do not make.

**A mark's laylines belong to its own leg, not to what the boat is doing.** Two
things were getting that wrong, and they compounded.

*Which mode.* Every target now carries the bearing you approach it on — the
direction of the leg into that mark, from the element before it in sailing
order — and that is what picks upwind or downwind angles. A leeward gate is
approached downwind *always*, so it takes downwind angles and its laylines run
**above it**, because upwind is where you come from; a windward gate takes
upwind angles and its laylines run **below it**. Decide by the bearing from the
boat instead and a boat sitting under the leeward gate is looking upwind at it,
gets beat angles, and its laylines land on the wrong side of the mark entirely.
Where the fallback has no element order to read, the wind supplies it: the
windward gate is reached sailing towards the wind, the leeward one away from it.
Checked over every target in every scope, including from a boat 300 m below the
leeward gate: **14 of 14 on the correct side, none wrong.**

*Which angle.* Getting the mode right was not enough, because the angle was
still `targTwa` — one number describing whatever the boat is doing at this
instant. Running down the course that handed 145° to the windward gate as well,
which put its laylines above it however the mode was decided. The angle now
comes from `boatTargets`, the same pair of curves the route uses: both modes,
built from the whole race, keyed to the wind speed you are in. So the windward
gate gets the beat angle and the leeward gate the run angle, whatever the boat
happens to be sailing. At Sassnitz in 26 km/h that reads **TOP 49° with the
laylines below the mark, BOTTOM 144° with them above** — which is the picture.


**CROSSWIND** draws the **ladder rung**: the line square to the wind through MY
BOAT — the VMG line, the line of equal progress up or down the course. Anyone
standing on it is level with you no matter how far across the course they are,
and the gap between two rungs is the only honest answer to "am I ahead?" —
bow-to-bow and distance-to-mark both flatter whoever is nearer the middle, and
both move when two boats converge without either having gained a metre.

**WIND FROM defaults to the race TWD** — the number on the compass rose — and
that is deliberate. A rung is a line you are asked to read a metre off, and a
masthead TWD at 1 Hz swings it several degrees a second: over 160 s of race 4 the
boat's own wind moves the rung through **13.4°** while the race TWD moves it
through **0.0°**. The line was moving more than the boats were. The live sources
are still there with their own damping, but they are a choice now rather than
the default.

On a live source the rung is also gated (see *When the masthead lies* below).
Where the window is mostly rejected the rung falls back to the race TWD and
**says so on its own tag** — `AUS · RACE TWD` rather than `AUS`. A rung quietly
drawn off a different wind from the one you selected is the one failure of this
overlay you would never catch by looking at it.

**AUTO CROSS** picks who to measure against: the boat closest to **your rung** on
your own leg. That is the boat you are level with, and therefore the boat you are
about to meet — picking the laterally nearest boat instead answers a different
question and usually lands on someone half a leg up the course. Checked
exhaustively against a brute-force search: **643 of 643** frames pick the same
boat. The gap goes on the map between the two boats in metres, **green ahead, red
behind**, on a plate so it reads over hulls, tracks and the wind wash alike.

**On opposite tacks the plate also carries the seconds to the cross** — where the
two current courses intersect, at current speeds, and how long until you are on
their track. A crossing astern of either boat, parallel courses, and anything
further off than 300 s all return nothing rather than a number, and same-tack
pairs never get one: 89 of 211 opposite-tack frames in race 4 have a real cross
ahead, and 0 same-tack frames produce a number. The maths was checked by flying
both boats forward at constant velocity to the reported time — my projected
position lands **0.0000 m** off their projected track, median and max.

It is a bare number, deliberately: it sits under a figure that already carries
its unit, and it is neutral rather than green or red because a clock is not a
gain and colouring it would call the cross good or bad before it happens.

**Same leg only.** A boat a leg behind is sailing a different piece of course
towards a different mark; its rung answers a different question and the metres
between the two rungs are not a gain over anybody. If nobody is on your leg there
is no comparison rather than a wrong one — the rung stays, the number does not
appear. Where no leg is known at all (before the gun, after the finish, or a race
harvested before `Leg` was carried) every boat reads null, they all match, and
the fleet is in scope: the honest best available, rather than a filter quietly
failing open on some boats and not others.

Ahead is signed by the **leg**, not by the wind: upwind is ahead on a beat and
behind on a run, and the leg number says which this is. Checked against the
truth it is meant to predict — who reaches the next mark first — the sign agrees
**87.9%** of the time across every boat and every 10 s of race 4, and the
breakdown is the interesting part:

| gap between the rungs | agrees with who rounds first |
| --- | --- |
| 0–10 m | 68.8% |
| 10–25 m | 73.3% |
| 25–50 m | 90.2% |
| 50–100 m | 98.6% |
| over 100 m | 95.7% |

That is the shape you want. Given a real gap the rung is right essentially
always; within 10 m of level it is near a coin toss, because at 10 m the outcome
genuinely is not decided yet and a metric claiming otherwise would be lying. The
headline figure is lower than the 93.7% an earlier build scored only because
AUTO CROSS now picks the boat *closest* on the ladder — median gap 47 m — so it
is being asked a harder question than when it picked whoever was nearest across
the course.

The rungs use a long dash where the laylines use a short one, and tag themselves
with the team where they leave the frame — mine above the line, theirs below,
because AUTO CROSS picks the boat closest to my rung and the two lines are
usually nearly on top of each other.

**MARK ZONE** puts a light red no-go circle round every mark, gate mark and
finish buoy — 50 m by default. It is drawn in a pass of its own, before the
course: the marks themselves are drawn with skips and special cases (M1 belongs
to `drawM1`, a gate is two buoys and a line, the finish is neither), so hanging
the zone off each of them would inherit every one of those exceptions. One pass,
one rule, and the buoys land on top of their own zones rather than under them.
The radius goes through the same transform as everything else, so it is 50 m at
every zoom rather than a fixed number of pixels meaning a different distance each
time — checked at 1×, 2× and 4×, converting back to 50.0000 m at each. The start
line is excluded; it has its own geometry and the pre-start view is busy enough.

**COURSE LIMITS** draws the boundary as the **band** it is. What the course file
carries is the *inside* edge of the boundary zone — the last water you may sail —
and a boat approaching it needs to see the thing it must not enter, not just the
line where trouble starts. A second edge is offset outwards (BOUNDARY BAND, 80 m
by default) and the water between the two is shaded red.

The offset is a real polygon offset, not the shape scaled about its centre —
which is a different operation and wrong everywhere the boundary is not a circle.
Each vertex moves along the bisector of its two edge normals by
`d / cos(half the turn)`, which is exactly what puts both offset edges `d` from
their originals; the winding comes from the signed area, so a polygon stored
clockwise offsets outwards just the same as one stored anticlockwise. Measured on
the Sassnitz boundary: every offset edge sits **80.000000 m** from its original,
median and max error alike, the outer ring encloses the inner one, and every
original vertex falls inside it. Both rings are built from the same
duplicate-stripped vertex list, so they correspond one to one — course files
routinely repeat the first point to close the ring, and skipping it in one ring
but not the other would put the band out of step for every vertex after it.

**MY BOAT** is split: your numbers on the left, the **nearest boat on your own
tack and your own leg** on the right, row for row — speed, TWA, TWS, VMG.

Tack alone was not enough, and the card was making an unfair comparison with a
straight face. Tack is only a sign: a boat beating at TWA 65° and a boat running
at 116° are both on starboard, and the card would set 29 km/h against 44 km/h,
colour the difference green, and say the running boat was going better when it
was simply going downwind. The VMG row was worse — +12.6 upwind against −19.4
downwind, compared as though one beat the other. The leg says which of those two
things you are doing, so it is the filter that makes the row mean anything, and
it is the same rule AUTO CROSS uses for the same reason. Where no leg is known
at all it falls back to tack alone, the honest best available.

Measured across two races: **every pairing is now same-tack and same-leg** —
1,314 of 1,314 and 2,147 of 2,147 — and the median difference in TWA between the
two boats being compared is 11.6°. At T+300 in race 3 it swapped a boat running
at 116° for one beating at 76° against your own 65°.

**The bottom bar** carries the scrubber and the archive picker, both of which are
replay-only, plus MY BOAT, which is not. The scrubber carries **the gun** as a
red mark on its track, so the one instant the whole tool is built around is
visible while you drag rather than only readable off the clock after you stop.

The mark is placed from each race's own time range, not assumed to be centred —
a 240 s start window puts the gun at 62.5% and a full race at 15–21% — and it hides
itself rather than clamping to an end if a window ever arrives with no gun in
it. It is also offset by half the slider thumb at each end, because the track a
thumb can travel is the element minus its own width; a mark at a plain
percentage drifts further from the value it claims to mark the closer it gets to
either end. Checked by measurement: it lands within 0.01 px of where the thumb
sits at T+0.

The ratio time-series that used to run along the bottom is gone, and the map is
118 px taller for it. `drawRatioStrip` is still in `render.js` if it is ever
wanted back — as a rail panel rather than a permanent strip, on the evidence
that the map wanted the space more.

**The wave, past the gun.** With a target ratio set, the shading is the *band*
between the 1.00 front and the target front — the water in front of the target,
toward the line, is left open. Canvas cannot subtract paths and the region is
forty overlapping fans that only union under one nonzero fill, so it is composed
on an offscreen layer: fill the outer region, erase the inner one, blit.

**Zoom and pan.** Wheel over the map to zoom, drag to pan, double-click to
reset. Zoom anchors on the cursor, not the centre — centre-anchored zoom pushes
whatever you were looking at off the edge, which is precisely when you were
looking at it. The renderer had always accepted `zoom`, `panX` and `panY`;
nothing had ever offered them to anyone.

**The clock** runs off the gun, not off the last sample. Through a telemetry
dropout it keeps counting and the boats visibly stop, and the gap between the two
shows in the header as LAG. That is the difference between "the feed is down" and
"the fleet is parked", and only one of them is your problem.

### Gate bias

A gate is two marks and they are almost never square to the wind. Rounding the
favoured one puts you further along the next leg before you have sailed a metre
of it, and that head start is worth knowing at the top of the leg rather than
working out on the approach. **GATE BIAS** writes it outside each live gate:
`L31m` means the left-hand mark, by thirty-one metres.

The measure is the one sailors use — project both marks onto the axis of the leg
you are about to sail and take the difference. A leeward gate leads to a beat,
so the mark further **upwind** wins; a windward gate leads to a run, so the mark
further **downwind** wins. Nothing in it is about where the boat currently is:
the bias belongs to the gate and the wind, and it moves when the wind does.

**Left and right are named from the boat, not from the screen.** Coming down to
a leeward gate you are facing down the course, so the mark on the *left* of the
screen is your *right*-hand mark — which is what a crew means when they call it
the right gate. At the windward gate, approached the other way, screen-left is
your left. One cross product against the leg's own approach bearing covers both
cases, and it is the same rule the next-leg route uses to label its branches, so
the two overlays cannot disagree about which mark is which. Checked over 2,141
gate readings across two races: **the side matches the on-screen rule 2,141
times out of 2,141**, including the flip between the two ends of the course.

Which gates count is the same question the laylines answer, so it is asked in
the same place — `laylineTargets()` gives the live pair by the leg, and each
target carries its element so both marks can be reached. One rule, one answer,
and the bias and the laylines can never end up on different gates.

**The wind behind it has a wider choice than the other overlays**, because a
gate's bias is a fact about the water *at* the gate. The mark boats sitting on
it are the best witnesses there are — but mark wind is thin in this archive, so
the sets are offered separately and together: the marks, the boat you are
watching, both, or every masthead in the fleet. All four go through the same
fault gate, the same robust circular mean and the same settling as everything
else, so changing source changes the evidence and not the method. Damping is
1–120 s: a gate bias is a few tens of metres either way, and an undamped 1 Hz
TWD moves it faster than you can read it. Where a window has nothing usable in
it the race average stands in, and the number says `held` underneath rather than
blinking out.

For scale: the three gates at Sassnitz are 212–220 m wide and set 3–9° off
square to the race-average wind, which puts the bias at 12–35 m on the average
and further either way as the breeze swings — the reason it is worth a live
number rather than a note from the briefing.

### TTK / RATIO AT BOUNDARY

The pre-start is run out on port and back, and the turn at the far end is not a
free choice — the boundary makes it for you. So on the way out the question that
matters is not *what is my ratio now*; it is **what will my ratio be when I am
made to turn**, because that is the state you actually have to start solving
from. It sits under the boat's own numbers in MY BOAT.

Hold the current speed and course to the first boundary the ray meets, and
evaluate the same ratio arithmetic there, at the time you would arrive. It moves
continuously as you steer, which is the point: bear away and the ray finds a
further piece of boundary, so the arrival is later and the ratio falls; luff and
it finds a nearer one. Same `ratioAtPoint()` the live ratio and the projection
use, so the three cannot drift apart under a later edit.

**Port only**, as asked — on starboard the boat is coming back to the line and
the boundary is behind the problem rather than in front of it.

**It is coloured by whether you will be late, not against the ratio target.** The
target comparison is the right rule for the live ratio, where the question is how
much time is left to burn. It is the wrong rule here: at the boundary the
question is binary — from that point, at that time, can you still make the line
on the gun. A TTK of −8.5 s answers no, and colouring it green because 0.27 sits
under a target of 1.80 would say the opposite of what the number means.

**The block is always drawn pre-gun, dashes and all**, with the reason in place
of the time: *the gun goes first*, *on starboard*, *no boundary ahead*,
*stopped*. One that appeared and vanished with the tack would shuffle everything
above it twice a lap, and a readout that jumps under your eye in the last minute
of a start is worse than one that sometimes says nothing. The commonest reason is
the most useful one: over race 5, of 1,192 evaluable moments 267 carry numbers,
333 say *the gun goes first* — holding that course does not end at the boundary,
it ends at the start.

Checked by re-deriving every live reading independently — flying the boat forward
from the sample and re-running the arithmetic: **0 mismatches in 267**, the hit
point on a boundary segment to 1e-6 m, and the flight time and ratio identical to
the last digit.

### LAST TACK

Running out from the entry the ratio falls the whole way: the time you have is
draining while the time you need is growing. There is a moment on that course
after which you can no longer get back to the line for the gun, and the number
worth having is how many seconds away it is. Hold past it and you are late, and
no amount of sailing well afterwards fixes it. It sits under the boundary block
in MY BOAT: **6.1 · s before you cannot make the line**.

**The threshold is a ratio, and it is not 1.00.** 1.00 is the point at which a
boat already pointing at the line and already up to speed would just make it —
and at the moment of the tack you are none of those things. The turn costs
seconds and metres and comes out slow. **LAST TACK RATIO** in the START panel is
that margin, 1.20 by default, and it is the one number in this calculation that
is a judgement rather than a measurement, which is why it is a control and not a
constant.

Found by scanning forward along the projected course and bisecting the first
crossing, not by solving it. The ratio is not guaranteed monotonic — a course
angled back towards the line has the time you *need* falling as well as the time
you *have* — so anything assuming a single downward slope would find the wrong
root on exactly the boats doing something interesting. Every one of the 226 live
readings in race 5 was checked for a real crossing (ratio above the threshold a
tenth of a second before, at or below it a tenth after): **226 of 226**.

**It runs only while the computed ratio exists, and that is a real limit worth
knowing.** `timeToLine` returns zero on the course side of the line — you are
already at it — so the ratio is undefined there, and in this archive the fleet
spends most of the first hundred seconds on that side, running out beyond the
pin before coming back. The countdown therefore lights up from about T−50 across
the fleet, and the blank says *over the line* rather than something vaguer:

| window | samples | on the pre-start side | countdown live |
| --- | --- | --- | --- |
| T−15 → T−0 | 52 | 52 | 52 |
| T−30 → T−15 | 60 | 45 | 45 |
| T−45 → T−30 | 60 | 26 | 26 |
| T−60 → T−45 | 60 | 3 | 3 |
| earlier | 424 | 0 | 0 |

The boats' own performance computers do report a ratio while over the line — the
headline in MY BOAT shows it — so this could be extended, but only by changing
what `timeToLine` means on the course side, and the wave, the fast point and the
advantage curve are all built on that same function.

Where it does run, it behaves the way it should. AUS through the last twenty
seconds of race 5: ratio 4.42 → last tack 7.9 s, ratio 3.14 → 5.3 s, ratio
2.00 → 3.2 s.

### OUT AND BACK

How long the pin-end escape takes: from the lower start mark, out to the boundary
at 90° TWA, and back. It is the length of the loop you commit to when you go down
there, and in seconds it tells you whether there is room for it before the gun.
It sits beside LAST TACK in MY BOAT.

**90° is the whole trick.** A reciprocal course out and back is 90° TWA in *both*
directions — turn a beam reach through 180° and it is a beam reach on the other
tack — so one speed off the polar covers both legs and the distance is the same
each way. Any other angle out would come back at a different one. Verified across
four races: the outbound and return legs are 90.0000° and 90.0000° every time.

Which of the two beam reaches: the one running **away from the other end of the
line**. The line sits square-ish to the wind, so a 90° heading runs along it, and
the useful direction is out past the pin rather than back up towards the boat
end. Checked as a property rather than assumed — in all four races the far end of
the loop is further from the windward mark than the pin is.

**The tack in the middle is not free, and the polar has nothing to say about it.**
A turn through 180° costs seconds no table models, so OUT AND BACK TACK adds a
flat allowance, 8 s by default. It is an allowance, not a measurement, which is
why it is a control.

The wind is the race average, deliberately: this sits beside the ratio and the
time-to-line, which are built on the same one, and a loop timed off a different
wind from the numbers next to it would not be comparable with them.

Verified end to end on four races: the far end of the loop lies on a boundary
segment to **0 m**, the sail time is exactly twice the distance over the polar
speed, and the total is exactly the sail time plus the allowance. The answer is a
fact about the course rather than about any boat, and it varies with the course:
Sassnitz race 5 puts the boundary 260 m off the pin — 31.7 s for the loop — while
races 1, 3 and 4 put it 855–909 m away, which is 84–92 s, most of a pre-start.

### The legs to M1

The one comparison a start is actually about. The line has two ends and they are
not equal: one is closer to M1, the other usually gets a better angle out of it,
and which of those wins is the whole argument. **LINE TO M1** draws a leg from
each end to the mark and puts three numbers on it — the TWA, the distance, and
the seconds.

The seconds are the number that settles it. Distance is a straight line; the time
comes from the polar's best speed **made good** on that bearing, so a leg you
cannot lay in one go is costed at what tacking or gybing it really makes rather
than at the boat's speed through the water. It is the same function the fast
point on the line is found with, so the three figures on this map cannot disagree
with each other — checked at Sassnitz race 5, where the two ends read 22.9 s and
23.2 s against `fastPoint`'s own 22.90 and 23.24, and the fast point sits between
them at 22.6 s.

That venue is a good illustration of why the distance alone is not the answer:
the windward end is **15 m further** from M1 and still **0.3 s quicker**, because
the angle out of it is 107° against the pin's 87°.

**The wind behind the angles is a choice** — the race TWD, the course marks, the
boat you are watching, the boat and the marks together, or every source on the
water — with its own damping. Pre-start the mark boats are sitting on the line
and the fleet is milling about beside it, so which witness you believe is a real
question, and the TWA to M1 is exactly the number it moves: at T−46 in race 5 the
race average gives 107°/87° and the marks give 104°/84°. The seconds follow the
same wind rather than a different one, because speed made good on a bearing
depends on where the wind is, and quoting a time off one wind and an angle off
another would be two halves of different answers.

The static `M1 87°` chip that used to sit beside each end mark is suppressed
while this is on: it is the same quantity computed from the race average alone,
and two numbers for one thing that are allowed to disagree is worse than either.

The **FAST POINT** chip now sits across the line on the course side, placed off
the frame's own normal rather than a hardcoded offset — so it stays across the
line whichever way a venue faces and whichever way the map is turned. It used to
be pinned to the right of the diamond, which at Sassnitz put it on the pre-start
side, on top of the fleet, in the last minute before the gun.

### At the gun, it changes subject

Before the gun, everything on the map is a way of asking *where should I be at
T+0*: the ratio wave, the target-ratio front, the laylines, the advantage curve,
the fast point on the line. After it, none of them mean anything, and holding
the start line in frame while the fleet sails away from it is exactly the wrong
picture.

So at T+0 the start geometry retires, the viewport starts following the boats and
lets the line leave the frame, the boats take their team colours instead of their
positions at Mark 1, and MY BOAT switches from ratio and time-to-kill to speed
against the polar, VMG and TWA. `OVERLAYS` in the START panel overrides all
of it — reviewing a start with the clock past the gun is a real thing to want.

## Covering the whole race

Two things stand between this and a full race, and only one of them is code.

**The archive mostly stops at T+90.** Except for the five races listed below,
every bundle in `data/` holds a 240-second window, T−150 to T+90 — `tRange` says
so in every race object — because the ingest was
built to answer questions about starts. Nothing in the tracker imposes that
limit: the clock, the scrubber and the buffer all take their span from whatever
the feed hands them. Re-harvest with each race's own start and end times and this
page plays the whole race with no edit here at all. That is a change to
`build/plan.py` and `build/harvest.py` in the parent repo, not to this one.

**The course past Mark 1 — done.** Njord serves the whole course on
`race(key).course`: every element in course order and the boundary polygon.
`build/merge-courses.py` writes it into the 2026 bundles, joined on the gun
(Njord's `race.startTime` is the gun; every bundle race carries `gunTs`), and
143 of 144 races matched. So the marks, the gates and the finish now draw, and
boundaries cover all of 2026 rather than the 16 days a course XML existed for —
the Google Drive XMLs are no longer needed for it.

That merge also writes `raceEndTs` per race. Nothing reads it yet; it is the
number the track harvest needs, and it is what turns "gun − 150 s to gun + 90 s"
into "gun − 150 s to the finish".

**The tracks — started.** `build/merge-tracks.py` replaces a race's 240 s of
track with the full window, gun − 150 s to the finish, from Njord `get_data`
CSVs. Five Sassnitz 2026 races are done, including the whole of 23 August:

    sassnitz-2026-08-19-1615   T−150..T+550    700 s
    sassnitz-2026-08-23-1408   T−150..T+907   1057 s
    sassnitz-2026-08-23-1428   T−150..T+467    617 s
    sassnitz-2026-08-23-1441   T−150..T+545    695 s
    sassnitz-2026-08-23-1512   T−150..T+842    992 s

Nothing has to be named or ordered for that script: every CSV carries its own
boat key and its own timestamps, so it works out which boat and which race it
belongs to by matching its first sample against every gun time in the bundle,
and reports anything that matches nothing rather than guessing.

The rest of the archive is the same loop — one `get_data` call per boat per
race, gun − 150 s to `raceEndTs` + 30 s at 1 Hz, then this script. Roughly 110
calls per event.

**Wind through the whole race** comes from the fleet's own mastheads. Set WIND
or FIELD to `boats` and the interpolated field follows the boats around the
course, because those channels ride along in the same extended tracks. Mark
wind still only spans the start window: it comes from the Course_Marks log,
not from Njord — this account has no wind stations (`allWindStations` is
empty) — so extending it needs that log rather than an API call.

**The field moves with the wind, not with the fleet — DRIFT.** Taken at one
instant the field is six masthead readings at six boat positions. Advance the
clock and the pattern does not travel down the course; it is glued to the boats,
because the only thing that moved was the boats. A gust the leader sailed
through a minute ago has simply gone, when in fact it is now somewhere near the
bottom gate — which is exactly the thing a live tool is being asked.

So the field is built from the last `DRIFT` seconds of readings as well as this
instant's, and each one is carried from where it was measured to where that air
*is now*: downwind, at its own measured speed, for as long as it has been
travelling. That is frozen Taylor's hypothesis — the standard assumption that
over a minute or so a wind pattern is transported by the mean flow faster than
it evolves. Measured against the mechanism it claims: at DRIFT 45 every carried
reading lands exactly `tws ÷ 3.6 × age` metres from where it was taken, on a
bearing 0.00° off dead downwind.

It also fills the water in, because a boat's last minute of track seeds a line of
readings instead of a point. The share of the course the field will speak for at
all goes **8.3% → 18.5% at DRIFT 45 → 25.8% at DRIFT 90**.

Age is not free, so each carried reading keeps a credibility that decays with how
long it has been drifting: it counts for less in the blend *and* claims less
water, through the same coverage test that already fades the field out where
nothing is near enough to say. The source rings still mark only the live
readings — an advected copy is not a place anyone measured anything. DRIFT 0
reduces the whole thing exactly to the instantaneous field.

One honest limit: air drifts downwind, so this fills in *behind* the fleet, not
ahead of it. Nothing here can tell you about a gust that has not reached anybody
yet.

### The arrows, and the shift

Every wind arrow — the readings at each source and the field's grid — points
**into** the wind, at where it is coming from. That is the direction a masthead
fly reads and the direction the number beside the arrow names; an arrow flying
downwind means the same thing and reads as the opposite one. Both layers were
flipped together, because two arrow conventions on one map are worse than
either. Verified against the frame's own bearing transform: the arrow vector
matches bearing TWD to **0.000000000**, and sits a full 180° from the old
convention.

The compass rose in the corner still shows the wind *blowing*, which is the
usual thing for a rose and is a legend rather than a reading on the water — say
the word and it flips too.

**Colour is the shift.** A single reading says almost nothing on its own; what
you want off a mark boat is not "251 degrees" but *further left than it has been
for the last minute*. Each source carries the vector mean of its **own** last
60 s, and its arrow is **red when the reading is left of that** and **green when
it is right** — so a shift arriving across the course shows as the arrows
changing colour one after another. Each source is judged against itself rather
than against the fleet, because that is what tells you the shift has reached
*this* piece of water, and the same fault gate applies so a bad patch inside the
minute cannot drag the reference with it. A 1.5° dead band keeps it from
flickering at zero.

The speed ramp stays on the numbers, so each element carries one meaning: the
arrow is direction and shift, the figure beside it is speed. Checked over race
4: **692 of 692 readings carry a 60 s reference and 692 of 692 colour to the
correct side**, splitting 195 left, 199 right and 298 inside the dead band —
oscillating, as a real breeze does, rather than stuck one way.

### When the masthead lies

An F50 does 60–90 km/h. Solving true wind from apparent at that speed is a small
difference between two large vectors, and when the solution degrades what comes
out is not noisy wind — it is apparent wind wearing a TWD label. The direction
swings towards the boat's own course and the speed climbs towards the boat's own
speed. Drawn as a ladder rung, that is a line square to a wind that is not
there, and it was: AUS's rung in race 5 was **90° out**, because the wind handed
to it was **141° out**.

The archive says how common this is. Across the six full-length races, the 99th
percentile of |reading − race TWD| is 12–48° in five of them and **nothing at all
exceeds 60°**. Race 5 on 23 August is the exception: **8.9%** of its masthead
samples sit more than 60° off and **6.2%** more than 90°, with speeds up to
**2.2×** the race mean, on three of its four boats at once.

So there is a gate, applied where readings enter the tool — the wind field, the
live arrows, the laylines and the crosswind rung. A reading more than 60° off
the race TWD, or outside 0.4–2.0× the race TWS, is not wind. Because the race
figures are whole-race means they are the one reference every reading can be
checked against without circularity, and the threshold is set where the data
separates rather than where it felt right: it discards **0.00%** of the five good
races and catches the bad one whole. Held-frame rates with the boat masthead
selected are 0%, 0%, 0%, 2.6% and — race 5 — **15.1%**.

This is a fault detector, not a smoother. Real shifts pass untouched: with the
gate in, the live rung still tracks the wind through a −49° to +51° range across
the archive, which is far more than any gust veer. A gate tight enough to
flatten a shift would be worse than no gate at all.

MY BOAT's TWS row reads `km/h · suspect`, dimmed, whenever the boat's own reading
fails the gate — the panel still shows what the instrument said, which is the
honest thing for a raw channel to do, but it no longer shows it as though it
were true.

### Nothing is allowed to step

The first version of that gate was a boolean, and it made the overlays worse in a
new way. A sample crossing a threshold joined or left the averaged population
instantly, so the answer stepped: the rung's wind could move **50° in one
second**. Nothing else on the map moves like that, which is exactly why it was
the thing you noticed. Three separate hard edges were doing it, and all three had
to go.

**The gate became a weight.** Full credibility out to 40° from the race TWD and
zero by 60°, smoothstep between, and the same in the speed channel. A reading now
fades out of the average instead of vanishing from it.

**The median became an IRLS centre.** A weighted median is robust but it is an
*order statistic* — it is whichever sample the cumulative weight crosses half at
— so with the readings in two clusters it hops the whole gap the moment the mass
shifts. That was still worth 12–16° in a second. Iteratively reweighted least
squares with a Tukey biweight is robust *and* smooth: start at the weighted mean,
measure the spread, downweight by distance from the current centre on a curve
that reaches zero smoothly, repeat three times. No sorting, no jumps, and a
cluster of nonsense still carries essentially no weight by the third pass.

**A thin window stopped being a cliff.** GER's track in race 4 has a genuine
**101-second hole** in it, and on the far side the window held exactly one
sample. Treated as a 30-second average, that one reading moved the line **16.5°
in a single frame**. Now the estimate is eased towards the race TWD by how much
the window is actually *worth* — credibility times taper, summed, against the
~sec/2 a full 1 Hz window carries — so one second of evidence barely moves it and
the rung walks back out to the live wind over the next half minute as the window
refills. The same easing covers a window that is thin because its readings are
bad rather than because they are missing, so the fallback to the race TWD is a
walk rather than a switch.

Frame-to-frame motion of the rung's wind, worst case in a single second, with the
boat masthead selected:

| race | before | after |
| --- | --- | --- |
| 23 Aug race 2 | 16.5°/s | 2.9°/s |
| 23 Aug race 4 (clean) | 0.45°/s | 0.47°/s |
| 23 Aug race 5 (bad data) | 54.8°/s | 7.1°/s |

The clean race is untouched to within a fiftieth of a degree, which is the test
that matters most: none of this is smoothing away real motion, it is removing
discontinuities that were never in the wind.

One thing worth recording because it was the obvious guess and it was wrong:
**rate of turn does not predict any of this.** Binned across 21,321 samples, the
95th percentile of |reading − race TWD| is 41° at under 1°/s of turn and 30° at
over 15°/s — flat, and if anything *better* while turning. A manoeuvre mask would
have thrown away good data and fixed nothing.

Worth adding once the data is there: rank and delta to the boat ahead, distance
and time to the next mark rather than always to M1, and a leg-by-leg gain/loss
strip.

## Going live

Point the page at a socket that speaks this, all JSON, one message per frame:

```jsonc
{ "type": "meta", "raceId": "…", "gunTs": 1787148900000, "serverNow": 1787148840000,
  "marks":  { "windward": {"lat":54.5083,"lon":13.6543},
              "leeward":  {"lat":54.5089,"lon":13.6573},
              "M1":       {"lat":54.5043,"lon":13.6588} },
  "wind":   { "twd": 245.3, "tws": 35.1, "confidence": "HIGH" },
  "limits": { "Boundary": [[54.5119,13.6658], …] },
  "configs": ["m15_HAW_HSB2_HSRW2"], "pinEnd": "leeward" }

{ "type": "sample", "team": "ITA", "t": -63.2,
  "lat": 54.5083, "lon": 13.6543, "sog": 68.2, "hdg": 212, "cog": 214,
  "twd": 245, "tws": 35, "twa": -41, "dtl": 180, "linePct": 62,
  "pcRatio": 1.84, "pcTtk": 12.1, "pcTts": 6.6 }

{ "type": "samples", "rows": [ … ] }        // a batch, same fields
{ "type": "wind", "name": "CM1", "lat": …, "lon": …, "t": -60, "twd": …, "tws": … }
{ "type": "gun",  "ts": 1787148900000 }     // the gun moved
```

`t` is seconds from the gun, negative before it, and it is not bounded — send
T+400 and the tool draws T+400. A sender that only knows epoch milliseconds can
send `ts` instead and it is converted against the gun.

Meta must arrive before the first sample — without a line there is nothing to
measure against. Everything else may arrive in any order, late, or twice: the
buffer drops what it cannot use rather than corrupting the arrays.

**Speeds are km/h and angles are degrees true**, throughout, because that is what
the polars are in. A feed in knots must convert before sending.

The minimum a sample needs to draw a boat is `lat` and `lon`. Everything else
degrades: no `pcRatio` and the ratio falls back to the polar; no `twd`/`tws` and
the wind comes from the meta; no polar for the configuration and the laylines,
the wave and the fast point go dark rather than wrong.

### Still to do before a real feed

- **Wind live.** `meta.wind` is a fixed estimate. Live, TWD should be recomputed
  on a rolling window from the fleet's own readings, the way `build/run.py` does
  it after the fact.
- **The gun.** It comes from the race committee, not from the boats. Until there
  is a signal for it, `?live=` needs the gun time handed to it.
- **Reconnect state.** The socket reconnects with back-off, but the buffer keeps
  what it had. A reconnect that lands in a *different* race needs to clear it —
  the `meta` handler is where that goes.
- **Boundaries.** Course boundary polygons come from the SailGP course XML, which
  Njord does not carry. Live, they would come with the meta.

## How it works

```
feed  ──▶  StartBuffer  ──▶  buildRace(raw, {live:true})  ──▶  drawFrame(canvas, rd, t)
             grows only        ~5x a second, 1–7 ms          at the last instant
             forwards          on a nine-boat fleet          there is data for
```

The trick is that there is no live-only geometry. `buildRace()` already turns a
race into everything the renderer reads; run it against a buffer that stops at
the present and it does the same job on a race that is still happening. So a
number on screen live is the same number the review page shows afterwards,
computed by the same line of code — and there is no second, thinner
implementation quietly drifting out of step with the real one.

What live mode skips, and why, is written down in `buildRace`: exclusions (they
are decided from each boat's position at the gun), entry detection (it scans a
fixed window in one pass), the start summary and the order at Mark 1. Those
fields come back empty rather than half-computed, and the renderer already guards
every one of them.

## The files

```
index.html            the page
css/app.css           the look, and the full-viewport grid
js/vendor.js          F50 polar tables            ┐
js/geom.js            the start-line frame        │ extracted from start-review
js/polar.js           polar interpolation, VMC    │ by build/extract.py —
js/metrics.js         ratio, line geometry, stats │ do not hand-edit
js/render.js          the whole canvas renderer   │
js/ratio.js           ratio-target colouring      ┘
js/feed.js            the feed contract, ReplayFeed, LiveFeed   ← the live layer
js/mock-live.js       a socket that is not a socket
js/app.js             the tracker: tabs, loop, control rail, HUD
build/extract.py      re-extract the six files above
build/merge-courses.py  write Njord's courses + boundaries into the bundles
build/courses-by-gun.json  169 race courses, keyed by gun time
data/                 manifest, 28 event bundles
_not-needed/          start-review's metrics.json — 3 MB this tool never opens.
                      Delete the folder before pushing.
```

Six of the nine JavaScript files are **extracted, not forked**. A fix made in
start-review reaches this tool by re-running the script, not by hand-merging two
diverged copies of an 1800-line renderer:

```
python3 build/extract.py ../start-review/index.html
```

There are twelve patches in that script and each carries the reason it exists —
live mode, the racing viewport, team colours, hull scaling, trail weight, the
post-gun blanking. A patch whose anchor stops matching is a hard error, not a
silent fall back to the unpatched original.

`js/feed.js`, `js/mock-live.js` and `js/app.js` are this tool's own and are never
touched by the script.

## Publishing

It ships as a folder inside the hub repo:

```
RebullITA/
  index.html                 the homescreen
  performance.html
  wind.html
  starting.html
  seagull-lab/               <- this directory, dropped in whole
    index.html  css/  js/  build/  data/
```

Nothing in the page changes. Every path it asks for is relative, so it resolves
under `/RebullITA/seagull-lab/` exactly as it does at a repo root — checked by
serving it from that path and confirming the data requests come back as
`/RebullITA/seagull-lab/data/…` rather than off the domain root.

It is then live at
`https://kylejlangford-del.github.io/RebullITA/seagull-lab/`.

**Delete `_not-needed/` before you push.** It is 3 MB of start-review's
`metrics.json` that this tool never opens, and it is going into the hub repo now
rather than sitting in a folder of its own.

### The tab on the homescreen

The tool opens in its own browser tab and carries no back link, so that tab *is*
the way back. Which means the link has to say so.

Easiest is to copy the Starting card in the hub's `index.html` and change four
things:

```html
<a href="seagull-lab/" target="_blank" rel="noopener">
  … Seagull Lab …
  … Open the live race tool → …
</a>
```

- `href` → `seagull-lab/` — relative; the other cards use absolute URLs and
  either works
- the title → Seagull Lab
- add `target="_blank" rel="noopener"`
- change "View reports →", which promises a list of reports and this is not one

`rel="noopener"` is not decoration. Without it the new tab gets a `window.opener`
handle back onto the hub; with it, nothing. It costs a word.

The one thing to weigh: this puts 18 MB of track data into a repo that is
otherwise flat HTML reports. That is what the bundling was for — 42 files, well
inside the GitHub web uploader's 100-file cap, so it can still go up without a
git client.

Both numbers are inherited from start-review and both are deliberate:
the tracks were once 328 files and 74 MB, which GitHub's browser uploader rejects
twice over — it caps at 100 files per upload and chokes on the payload. Bundling
by event fixed the count; gzipping fixed the size. It can be published from the
GitHub website with no git client at all.

The bundles are gzipped **on disk**, not in transit: Pages will not serve a `.gz`
with `Content-Encoding` set, so the browser gets raw bytes and unpacks them with
`DecompressionStream` (Chrome 80+, Safari 16.4+, Firefox 113+).

## Known limits

Inherited from the data, not from this tool:

- **Most of the archive is 240 seconds per race**, T−150 to T+90; five Sassnitz
  2026 races run to the finish. See *Covering the whole race* above.
- **The basemap is still unverified against real tiles.** The layer is live —
  `drawBasemap` runs, the frame carries its origin, and the page issues the tile
  requests (94 of them in the last check) — but this container's egress blocks
  `tile.openstreetmap.org` and every one of them fails, so no imagery has ever
  been seen under the course from here. The projection itself is measured and
  exact to 0.41 px. It should work from a browser with ordinary internet access;
  if it does not, that is where to look first.
- **Race 5 on 23 August has bad masthead wind** for roughly a sixth of its
  frames — the true-wind solution failing at speed, not a bug in this tool. The
  gate above catches it and the overlays fall back to the race TWD, but the
  underlying wind for that race is genuinely not trustworthy at those moments.
- **Leg-aware laylines and the crosswind sign need `Leg`**, which only the five
  re-harvested Sassnitz 2026 races carry. Everywhere else the laylines fall back
  to the top and bottom gate and the crosswind sign falls back to Mark 1, which
  is right for a start and a guess after it.
- **Polars cover half the archive.** 163 of 328 races — every 2026 event and the
  2025 events on mode 16. The 2024–25 events run modes 1–10, which have no table,
  so laylines, the wave, the advantage curve, the fast point and the speed-against
  -polar readout are all dark there. Adding those polar files lights them up with
  no code change.
- **Boundaries and courses cover 2026** — 143 races, from Njord. 2024–25 still
  have the start line, M1 and whatever boundary the original XMLs carried; run
  `merge-courses.py` against those seasons' events to fill them in the same way.
- **Track coverage is about 75%.** Telemetry uploads are frequently truncated.
  Live, this shows up as LAG and as boats that stop moving.
- **Njord holds no training-session starts.**
