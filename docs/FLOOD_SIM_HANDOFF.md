# Flood simulation + dashboard redesign — handoff (work in progress)

## Done
- `scripts/build_sim_terrain.py` — bakes real SRTM terrain (AWS Terrarium z13) per village into
  `dashboard/data/sim/<village>_terrain.json` (smoothed, pits filled, D8 flow accumulation).
- `dashboard/js/flood-sim-solver.js` — LISFLOOD-FP style local-inertial shallow-water solver
  (same scheme as Nagar Naadi), Froude cap, infiltration, inflows, stage boundary, debris pulses,
  sediment tracer, closed/open sides. Runs in a Web Worker. Verified in Node: exact mass balance,
  8-21 s for a full 24 h run.
- `dashboard/js/flood-scenarios.js` — three different synthetic scenarios:
  - Meppadi: orographic bursts + infinite-slope stability -> debris flow from the scarp above
    Punchirimattam down through Mundakkai / Chooralmala (fails from ~120 mm storm).
  - Darbhanga: river stage from upstream rain -> embankment breach at Khutwara (sustained > DL),
    widening weir outflow, east/north sides closed (embankment), sluices close -> waterlogging.
  - Dhemaji: flash tributary surges from the north (silt laden) + Brahmaputra backwater on the
    south boundary -> sheet flooding.
- `dashboard/js/flood-sim.js` — runtime: worker, frames, clock (play/pause/seek/speed), exposure,
  facility status, gauge, event detection, alert level, `riskAt()` for routing, report lines.
- `dashboard/js/flood-render.js` — canvas source draped on the terrain: depth/sediment colouring,
  flow-map ripples, white water, flow particles, unstable-slope hatch, rain overlay, event markers.
- `dashboard/index.html` + `dashboard/css/ops.css` — new non-glassmorphism layout. Live forecast
  (day/hour panel, LIVE FORECAST button, Current Conditions weather card) removed from the page.

## Left to do
1. Write `dashboard/js/ops-ui.js` (index.html already loads it). It must expose
   `window.OpsUI = { start(map), onVillageChange(id) }` and:
   - `FloodSim.init({ getPopulation: () => appState.apiData.population })`, `FloodRender.init(map)`,
     `FloodSim.setStorm(200)`, `FloodSim.setVillage(appState.currentVillageId)`.
   - On `FloodSim.on('time')`: fill `#opsClockT`, `#opsClockLocal` (`scenario.clock(t)`),
     `#opsAlert[data-level]` + `#opsAlertText`, KPIs into `#opsKpis` (inundated km², people >30 cm,
     at risk to life, deepest water, rain now / so far, facilities affected), gauge chart on
     `#opsGaugeChart` (rain bars + gauge line + dashed thresholds + time cursor), timeline canvas
     `#opsTimeline` (rain bars, computed range, event ticks, playhead; click to seek), event log
     `#opsLog` (events with t <= now, newest first) and `#opsUpcoming` (next 2 events),
     `#opsSettlements` (derived.perCluster) and `#opsFacilities` (derived.facilities).
     Also sync `appState.currentTimeStep = TIME_STEPS[Math.round(t / 14400)]`.
   - On `'scenario'`: `#opsFloodType`, `#opsScenarioNote`, `#opsGaugeTitle`; hide `#layerSlope`
     unless `scenario.landslide`.
   - Controls: `#masterPlayBtn` (toggle `.playing`), `#opsSpeed` (data-speed = sim s per real s),
     `#rainfallSlider` + `#stormPresets` (set `appState.rainfallAmount`, debounce `FloodSim.setStorm`),
     layer rows `#layerWater/#layerFlow/#layerRain/#layerSlope` -> `FloodRender.set(key, bool)`,
     `#waterStyle` -> `FloodRender.set('style', 'natural'|'depth')` + swap legends,
     `#opsExposureTabs`, `#btnHidePanels` (toggle `.panels-hidden` on `#hud`), map click ->
     `FloodSim.sample()` readout into `#simInspector`.
2. `dashboard/js/enhanced.js`:
   - In `run()`: after `init3DMap()` call `OpsUI.start(appState.map)`; remove `initWeatherTimePanel`.
   - In `bindEvents()`: delete the old play button / `.tick` / `rainfallSlider` blocks (ops-ui owns
     them); in the village `change` handler replace `loadWeatherForVillage` with
     `OpsUI.onVillageChange(id)`.
   - Delete `fetchLiveWeather`, `generateSyntheticForecast`, `renderShortTermForecast`,
     `renderEnhancedCharts`, `updateSyntheticData` (forecast / weather code).
   - `estimateFloodRiskAtPoint`: at the top, `const r = window.FloodSim?.riskAt(lng, lat, appState.riskHorizonH || 6); if (r !== null && r !== undefined) return r;`
     and set `appState.riskHorizonH = 24` inside `optimizeAllocation()`.
   - Default `appState.rainfallAmount` to 200; risk grid layer starts off (button no longer `.active`).
   - Strip emojis from generated markup (toggleRescueMode labels, mission cards, recommendations,
     rescue panel) and drop the fake 6.5 s solver stages in `optimizeAllocation`.
   - `generateTextReport`: append `FloodSim.reportLines()`.
3. Delete `dashboard/js/weather-time-panel.js` (no longer loaded).
4. Test: `python3 -m http.server 8001` in `dashboard/` and open `index.html`.
