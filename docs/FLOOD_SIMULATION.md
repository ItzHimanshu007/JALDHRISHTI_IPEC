# Rain-flood simulation

The dashboard runs a 2D shallow-water model live in the browser over each
village's **whole administrative area** (Meppadi panchayat at 100 m cells;
Darbhanga and Dhemaji districts, ~2,500 km² each, at 320 m / 400 m cells).
Terrain is real (SRTM via AWS Terrarium tiles); rainfall, river flows, breach
and slope-failure timings are **synthetic** and scale with the storm total set
in the player bar.

## Pieces

| File | Role |
|---|---|
| `scripts/build_sim_terrain.py` | Bakes each village's terrain grid (smoothing, pit filling, D8 flow accumulation) into `dashboard/data/sim/<village>_terrain.json`. Re-run only if a domain changes. |
| `dashboard/js/flood-sim-solver.js` | Local-inertial shallow-water solver (Bates et al. 2010, LISFLOOD-FP; same scheme as Nagar Naadi) with Froude cap, Horton infiltration, urban drains, point inflows, imposed-stage boundary, debris pulses and a sediment tracer. Runs in a Web Worker. |
| `dashboard/js/flood-scenarios.js` | One scenario per village (below). |
| `dashboard/js/flood-sim.js` | Runtime: worker, frames, scenario clock, exposure / facility / gauge stats, event detection, alert level, `riskAt()` used by evacuation routing and deployment planning. |
| `dashboard/js/flood-render.js` | Water surface draped on the 3D terrain (depth + sediment colour, flow-advected ripples, white water), flow streaks, unstable-slope hatch, rain overlay, map pins. |
| `dashboard/js/flood-grid.js` | Hexagonal risk grid (~220 hexagons per area, IDs like `DBG-F12`, A = northernmost row): water accumulated, mean/max depth, % flooded, residents, people in water > 30 cm and in deep/fast water, rain received, risk class and index. Hover card on the map; full readout on click; ranked list in the Grid cells tab. |
| `dashboard/js/ops-ui.js` | Panels: KPIs, gauge chart, timeline, event log, settlements / facilities, point readout, layer switches. |

## Scenarios

- **Meppadi (Wayanad): flash flood + debris flow.** Orographic bursts over the
  Ghats. An infinite-slope stability model (c' 9 kPa, φ' 34°, 2.5 m soil,
  pore pressure from cumulative rain) decides whether the scarp above
  Punchirimattam fails (from about 120 mm/24 h). The debris volume is routed
  down the real valley through Mundakkai and Chooralmala.
- **Darbhanga: embanked rivers, breaches, drainage congestion.** Rivers entering
  from the Nepal side are found from drainage area on the north/west edges and
  traced downstream; each gets a carved channel and embankments on both banks.
  Every major river has a breach site (the reach nearest Darbhanga town, and the
  weakest bank elsewhere) that fails **dynamically inside the solver** after an
  hour above Danger Level. Sluices close at T+6 h, so rain trapped between
  embankments ponds across the plain.
- **Dhemaji: Brahmaputra + flash tributaries.** The Brahmaputra enters from the
  east edge and rises through the day; north-bank tributaries are injected
  where they leave the foothills and carry silt-laden flash surges. Drowned
  outfalls spread water in wide sheets.

Population per cell comes from the dashboard's density model (district census
density plus named settlements); permanent river channels hold no residents.

## Checks

Each run reports a mass balance (rain + inflow = losses + boundary outflow +
storage); it closes to < 0.01 %. A full 24 h run takes roughly 8–20 s in a
worker, and frames stream in so playback starts immediately.

## Controls

Space: play/pause · ←/→: ±30 min · H: hide panels · click the map for a point readout.
