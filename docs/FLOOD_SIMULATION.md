# Rain-flood simulation

The dashboard runs a 2D shallow-water model live in the browser. Terrain is
real (SRTM via AWS Terrarium tiles); rainfall, river flows, breach and slope-
failure timings are **synthetic** and scale with the storm total set in the
player bar.

## Pieces

| File | Role |
|---|---|
| `scripts/build_sim_terrain.py` | Bakes each village's terrain grid (smoothing, pit filling, D8 flow accumulation) into `dashboard/data/sim/<village>_terrain.json`. Re-run only if a domain changes. |
| `dashboard/js/flood-sim-solver.js` | Local-inertial shallow-water solver (Bates et al. 2010, LISFLOOD-FP; same scheme as Nagar Naadi) with Froude cap, Horton infiltration, urban drains, point inflows, imposed-stage boundary, debris pulses and a sediment tracer. Runs in a Web Worker. |
| `dashboard/js/flood-scenarios.js` | One scenario per village (below). |
| `dashboard/js/flood-sim.js` | Runtime: worker, frames, scenario clock, exposure / facility / gauge stats, event detection, alert level, `riskAt()` used by evacuation routing and deployment planning. |
| `dashboard/js/flood-render.js` | Water surface draped on the 3D terrain (depth + sediment colour, flow-advected ripples, white water), flow streaks, unstable-slope hatch, rain overlay, map pins. |
| `dashboard/js/ops-ui.js` | Panels: KPIs, gauge chart, timeline, event log, settlements / facilities, point readout, layer switches. |

## Scenarios

- **Meppadi (Wayanad): flash flood + debris flow.** Orographic bursts over the
  Ghats. An infinite-slope stability model (c' 9 kPa, φ' 34°, 2.5 m soil,
  pore pressure from cumulative rain) decides whether the scarp above
  Punchirimattam fails (from about 120 mm/24 h). The debris volume is routed
  down the real valley through Mundakkai and Chooralmala.
- **Darbhanga: embankment breach + drainage congestion.** Upstream rain raises
  the Kamla-Balan through a unit hydrograph. After 1.5 h above Danger Level + 0.25 m
  the west embankment breaches at Khutwara; outflow is a widening broad-crested
  weir. The east and north sides are closed (embankment), and city drains drop to
  15 % once the river is above its outfalls.
- **Dhemaji: flash tributaries + backwater.** Three north-bank tributaries are
  found from drainage area on the northern edge and carry silt-laden flash
  surges. The southern boundary is held up by a rising Brahmaputra stage.

## Checks

Each run reports a mass balance (rain + inflow = losses + boundary outflow +
storage); it closes to < 0.01 %. A full 24 h run takes roughly 8–20 s in a
worker, and frames stream in so playback starts immediately.

## Controls

Space: play/pause · ←/→: ±30 min · H: hide panels · click the map for a point readout.
