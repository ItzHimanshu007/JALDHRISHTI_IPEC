/**
 * Jal Drishti - rain-flood simulation runtime
 * ---------------------------------------------------------------------------
 * Loads a village's terrain, builds its scenario (flood-scenarios.js), runs
 * the shallow-water solver (flood-sim-solver.js) in a Web Worker and keeps
 * the frames it streams back. Owns the scenario clock (play / pause / seek /
 * speed) and derives everything the operations panels show from the frames:
 * inundated area, people in water, facility status, gauge readings and the
 * event log. Rendering lives in flood-render.js, panels in ops-ui.js.
 *
 *   FloodSim.init({ getPopulation, facilitiesUrl })
 *   FloodSim.setVillage(id) / setStorm(mm) / seek(tSec) / play() / pause() / setSpeed(x)
 *   FloodSim.on('time' | 'frame' | 'scenario' | 'done' | 'play', cb)
 *   FloodSim.sample(lng, lat)      -> depth/velocity/conc at the clock time
 *   FloodSim.riskAt(lng, lat, hH)  -> 0-1 risk from the worst depth in the next hH hours
 */
(function (global) {
    'use strict';

    const S = global.FloodScenarios;
    const HOUR = 3600;
    const EXPOSED_M = 0.3;       // people standing in water deeper than this are counted as exposed
    const LIFE_RISK_M = 1.5;     // ... and at risk to life above this, or in fast water (d*v > 1)
    const WET_M = 0.15;          // area counted as inundated

    const listeners = {};
    const terrainCache = {};
    let worker = null;
    let workerFailed = false;
    let runSeq = 0;
    let opts = {};
    let facilities = [];

    const state = {
        villageId: null,
        storm: 200,
        terrain: null,
        scenario: null,
        frames: [],
        done: false,
        runId: 0,
        t: 0,
        playing: false,
        speed: 3600,           // sim seconds per real second
        events: [],
        derived: [],           // per-frame stats
        popPoints: [],
        facilityCells: [],
        massBalance: null
    };

    function emit(name, data) { (listeners[name] || []).forEach(cb => { try { cb(data); } catch (e) { console.error(e); } }); }
    function on(name, cb) { (listeners[name] = listeners[name] || []).push(cb); }

    // ------------------------------------------------------------------ worker
    function makeWorker() {
        if (worker || workerFailed) return worker;
        try {
            const src = `(${global.floodSolverProgram.toString()})(self);`;
            worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'application/javascript' })));
            worker.onmessage = (ev) => onSolverMessage(ev.data);
            worker.onerror = (e) => { console.warn('[FloodSim] worker error, falling back to main thread', e); worker = null; workerFailed = true; };
        } catch (e) {
            console.warn('[FloodSim] Web Worker unavailable, running solver on the main thread', e);
            workerFailed = true;
            worker = null;
        }
        return worker;
    }

    let mainThreadSolver = null;
    function postToSolver(msg) {
        const w = makeWorker();
        if (w) { w.postMessage(msg); return; }
        if (!mainThreadSolver) {
            mainThreadSolver = { postMessage: (m) => setTimeout(() => onSolverMessage(m), 0) };
            global.floodSolverProgram(mainThreadSolver);
        }
        mainThreadSolver.onmessage({ data: msg });
    }

    // ------------------------------------------------------------------ loading
    async function loadTerrain(vid) {
        if (terrainCache[vid]) return terrainCache[vid];
        const res = await fetch(`data/sim/${vid}_terrain.json`);
        if (!res.ok) throw new Error(`terrain ${vid}: HTTP ${res.status}`);
        terrainCache[vid] = S.decodeTerrain(await res.json());
        return terrainCache[vid];
    }

    async function loadFacilities() {
        const urls = ['data/raw/infrastructure/safe_havens.geojson', 'data/raw/infrastructure/rescue_centers.geojson'];
        const out = [];
        for (const u of urls) {
            try {
                const doc = await (await fetch(u)).json();
                doc.features.forEach(f => out.push({
                    name: f.properties.name, type: f.properties.type, villageId: f.properties.village_id,
                    capacity: f.properties.capacity || null, lngLat: f.geometry.coordinates
                }));
            } catch (e) { console.warn('[FloodSim] facilities not loaded', u, e); }
        }
        facilities = out;
    }

    function preparePopulation() {
        const t = state.terrain;
        const pop = opts.getPopulation ? opts.getPopulation() : null;
        state.popPoints = [];
        if (!pop || !pop.features) return;
        pop.features.forEach(f => {
            const [lng, lat] = f.geometry.coordinates;
            const cell = t.toCell(lng, lat);
            if (cell >= 0) state.popPoints.push({ cell, pop: f.properties.population || 0, cluster: f.properties.cluster_name || 'Unmapped' });
        });
    }

    /** Residents per model cell inside the village boundary (density model from enhanced.js). */
    function prepareCellPopulation() {
        const t = state.terrain, N = t.nx * t.ny, sc = state.scenario;
        if (!(state.cellPopBase && state.cellPopFor === state.villageId)) {
            state.cellPopBase = densityPopulation(t);
            state.cellPopFor = state.villageId;
        }
        const pop = Float32Array.from(state.cellPopBase);
        // River channels: a quarter of the modelled density (people live on
        // banks, embankments and char islands, but not in the channel itself).
        if (sc.initialDepth) for (let i = 0; i < N; i++) if (sc.initialDepth[i] > 0) pop[i] *= 0.25;
        state.cellPop = pop;
    }

    function densityPopulation(t) {
        const N = t.nx * t.ny;
        const pop = new Float32Array(N);
        const dens = typeof global.estimateAmbientPopulationDensity === 'function' ? global.estimateAmbientPopulationDensity
            : (typeof estimateAmbientPopulationDensity === 'function' ? estimateAmbientPopulationDensity : null);
        for (let i = 0; i < N; i++) {
            if (!t.mask[i]) continue;
            const [lng, lat] = t.toLngLat(i);
            pop[i] = (dens ? dens(lng, lat, state.villageId) : 300) * t.cellKm2;
        }
        return pop;
    }

    function prepareFacilities() {
        const t = state.terrain;
        state.facilityCells = facilities
            .filter(f => f.villageId === state.villageId)
            .map(f => ({ ...f, cell: t.toCell(f.lngLat[0], f.lngLat[1]) }));
    }

    // ------------------------------------------------------------------ run
    async function start() {
        const vid = state.villageId;
        const seq = ++runSeq;
        let terrain;
        try { terrain = await loadTerrain(vid); } catch (e) {
            console.error('[FloodSim] terrain unavailable', e);
            emit('error', { message: 'Terrain for this village could not be loaded.' });
            return;
        }
        if (seq !== runSeq) return;
        if (!facilities.length) await loadFacilities();
        state.terrain = terrain;
        state.scenario = S.buildScenario(terrain, vid, state.storm);
        state.frames = [];
        state.derived = [];
        state.done = false;
        state.massBalance = null;
        state.runId = seq;
        state.derivedEvents = [];
        state.flags = {};
        prepareCellPopulation();
        preparePopulation();
        prepareFacilities();
        rebuildEvents();
        emit('scenario', state.scenario);

        const sc = state.scenario;
        const msg = {
            type: 'run', runId: seq, nx: terrain.nx, ny: terrain.ny, dx: terrain.dx, dy: terrain.dy, z: terrain.z,
            tStart: sc.tStart, tEnd: sc.tEnd, frameEvery: sc.frameEvery, seriesStep: sc.seriesStep,
            z: sc.z || terrain.z, breaches: sc.breaches || [],
            rain: sc.rain, rainWeight: sc.rainWeight, rainConc: sc.rainConc, drainSeries: sc.drainSeries || null,
            infil: sc.infil, manning: sc.manning, infilMul: sc.infilMul, drainRate: sc.drainRate,
            inflows: sc.inflows.map(i => ({ cells: i.cells, series: i.series, conc: i.conc })),
            pulses: sc.pulses, stage: sc.stage, closedSides: sc.closedSides || [],
            initialDepth: sc.initialDepth || null, initialConc: sc.initialConc || 0
        };
        postToSolver({ type: 'cancel' });
        postToSolver(msg);
    }

    function onSolverMessage(m) {
        if (!m || m.runId !== state.runId) return;
        if (m.type === 'frame') {
            state.frames[m.k] = m;
            state.derived[m.k] = deriveFrame(m);
            detectEvents(m.k);
            emit('frame', { k: m.k, t: m.t, computedUntil: computedUntil() });
            if (m.k === 0 || Math.abs(m.t - state.t) < 700) emit('time', snapshot());
        } else if (m.type === 'event') {
            const sc = state.scenario;
            const tpl = sc.dynamicEvents && sc.dynamicEvents[m.id];
            if (tpl) pushDerived({ ...tpl, t: m.t });
            (sc.breachSites || []).forEach(b => { if (b.id === m.id) b.t = m.t; });
            if (sc.breach && sc.breach.id === m.id) sc.breach.t = m.t;
            rebuildEvents();
            emit('breach', { id: m.id, t: m.t });
        } else if (m.type === 'done') {
            state.done = true;
            state.massBalance = m.massBalance;
            addPeakEvent();
            emit('done', { massBalance: m.massBalance });
            emit('time', snapshot());
        }
    }

    function computedUntil() {
        const n = state.frames.length;
        return n ? state.frames[n - 1].t : -1;
    }

    // ------------------------------------------------------------------ derived stats
    function deriveFrame(f) {
        const t = state.terrain;
        const d = f.depth;
        // area and people inside the village boundary
        let wet = 0, exposed = 0, lifeRisk = 0, maxIn = 0;
        const mask = t.mask, cp = state.cellPop;
        for (let i = 0; i < d.length; i++) {
            if (!mask[i]) continue;
            const di = d[i];
            if (di > WET_M * 1000) wet++;
            if (di > maxIn) maxIn = di;
            if (di < EXPOSED_M * 1000) continue;
            exposed += cp[i];
            const dm = di / 1000, sp = Math.hypot(f.u[i], f.v[i]) / 10;
            if (dm > LIFE_RISK_M || dm * sp > 1) lifeRisk += cp[i];
        }
        // named settlements (population points from enhanced.js)
        const perCluster = {};
        for (const p of state.popPoints) {
            const dm = d[p.cell] / 1000;
            if (dm < EXPOSED_M) continue;
            const c = perCluster[p.cluster] || (perCluster[p.cluster] = { people: 0, maxDepth: 0 });
            c.people += p.pop;
            c.maxDepth = Math.max(c.maxDepth, dm);
        }
        const fac = state.facilityCells.map(fc => {
            const dm = fc.cell >= 0 ? maxAround(d, fc.cell, 1) / 1000 : 0;
            return { depth: dm, status: dm >= 0.5 ? 'inundated' : (dm >= 0.15 ? 'access' : 'ok') };
        });
        const sc = state.scenario;
        let gauge = null;
        if (sc.gauge.kind === 'depth') gauge = d[sc.gauge.cell] / 1000;
        else if (sc.gauge.kind === 'stage') gauge = (sc.z || t.z)[sc.gauge.cell] + d[sc.gauge.cell] / 1000;
        else gauge = S.seriesValueAt(sc.gauge.series, sc.tStart, f.t);
        return {
            t: f.t, wetKm2: wet * t.cellKm2, maxDepth: maxIn / 1000, volume: f.stats.volume,
            exposed: Math.round(exposed), lifeRisk: Math.round(lifeRisk), perCluster, facilities: fac, gauge,
            watch: (sc.watchPoints || []).map(w => ({ depth: d[w.cell] / 1000, conc: f.conc[w.cell] / 255 }))
        };
    }

    function maxAround(arr, cell, r) {
        const t = state.terrain, r0 = Math.floor(cell / t.nx), c0 = cell % t.nx;
        let m = 0;
        for (let rr = Math.max(0, r0 - r); rr <= Math.min(t.ny - 1, r0 + r); rr++)
            for (let cc = Math.max(0, c0 - r); cc <= Math.min(t.nx - 1, c0 + r); cc++) m = Math.max(m, arr[rr * t.nx + cc]);
        return m;
    }

    const LEVEL_RANK = { info: 0, green: 0, yellow: 1, orange: 2, red: 3 };

    function pushDerived(ev) { state.derivedEvents.push(ev); }

    function detectEvents(k) {
        const cur = state.derived[k];
        const prev = k > 0 ? state.derived[k - 1] : null;
        if (!cur || (k > 0 && !prev)) return;
        const sc = state.scenario, fl = state.flags;
        const t = cur.t;

        // heavy rain onset
        const rainNow = S.seriesValueAt(sc.rain, sc.tStart, t);
        if (!fl.heavyRain && rainNow >= 15) {
            fl.heavyRain = true;
            pushDerived({ t, level: 'yellow', kind: 'rain', title: 'Heavy rain over the area', detail: `${rainNow.toFixed(1)} mm/h and rising. Drains and low-lying roads will start to pond.` });
        }
        if (!fl.veryHeavyRain && rainNow >= 35) {
            fl.veryHeavyRain = true;
            pushDerived({ t, level: 'orange', kind: 'rain', title: 'Very heavy rain', detail: `${rainNow.toFixed(1)} mm/h. Flash-flood response times are now under an hour.` });
        }

        // settlements taking water
        Object.entries(cur.perCluster).forEach(([name, c]) => {
            const key = 'cluster:' + name;
            if (!fl[key] && c.people >= 150) {
                fl[key] = true;
                const pt = state.popPoints.find(p => p.cluster === name);
                pushDerived({ t, level: c.maxDepth > 1 ? 'orange' : 'yellow', kind: 'settlement',
                    lngLat: pt ? state.terrain.toLngLat(pt.cell) : null,
                    title: `Water entering ${name}`, detail: `~${fmtInt(c.people)} people in water over 30 cm, up to ${c.maxDepth.toFixed(1)} m deep.` });
            }
        });
        [[1000, 'orange'], [10000, 'red']].forEach(([th, lvl]) => {
            const key = 'exposed:' + th;
            if (!fl[key] && cur.exposed >= th) {
                fl[key] = true;
                pushDerived({ t, level: lvl, kind: 'exposure', title: `More than ${fmtInt(th)} people in floodwater`, detail: `${fmtInt(cur.exposed)} people in water over 30 cm; ${fmtInt(cur.lifeRisk)} in deep or fast water.` });
            }
        });

        // facilities
        cur.facilities.forEach((f, i) => {
            const fc = state.facilityCells[i];
            const key = 'fac:' + i;
            const before = fl[key] || 'ok';
            if (LEVEL_RANK[statusLevel(f.status)] > LEVEL_RANK[statusLevel(before)]) {
                fl[key] = f.status;
                pushDerived({ t, level: f.status === 'inundated' ? 'orange' : 'yellow', kind: 'facility', lngLat: fc.lngLat,
                    title: f.status === 'inundated' ? `${fc.name} inundated` : `${fc.name}: access road under water`,
                    detail: `${f.depth.toFixed(2)} m of water at the site.${fc.capacity ? ` Capacity ${fmtInt(fc.capacity)} to be re-routed.` : ''}` });
            }
        });

        // Meppadi: debris surge arrival at watch points
        (sc.watchPoints || []).forEach((w, i) => {
            const key = 'watch:' + i;
            const v = cur.watch[i];
            if (sc.villageId === 'wayanad_meppadi' && !fl[key] && v && v.depth > 1.2 && v.conc > 0.45) {
                fl[key] = true;
                pushDerived({ t, level: 'red', kind: 'surge', lngLat: w.lngLat, title: `Debris surge reaches ${w.name}`, detail: `${v.depth.toFixed(1)} m of mud-laden flow in the channel.` });
            }
        });

        // gauge crossings for depth gauges
        if ((sc.gauge.kind === 'depth' || sc.gauge.kind === 'stage') && prev && sc.gauge.thresholds.length) {
            sc.gauge.thresholds.forEach((th, i) => {
                const key = 'gauge:' + i;
                if (!fl[key] && cur.gauge >= th.v) {
                    fl[key] = true;
                    pushDerived({ t, level: th.level, kind: 'gauge', lngLat: state.terrain.toLngLat(sc.gauge.cell),
                        title: `${sc.gauge.name}: above ${th.label === 'HFL' ? 'highest flood level' : th.label.toLowerCase() + ' level'}`, detail: sc.gauge.kind === 'stage' ? `Stage ${cur.gauge.toFixed(2)} m (${th.label} ${th.v.toFixed(2)} m).` : `${cur.gauge.toFixed(2)} m of water (${th.label} ${th.v} m).` });
                }
            });
        }
        rebuildEvents();
    }

    function statusLevel(s) { return s === 'inundated' ? 'orange' : (s === 'access' ? 'yellow' : 'green'); }

    function addPeakEvent() {
        let best = null;
        state.derived.forEach(d => { if (d && (!best || d.wetKm2 > best.wetKm2)) best = d; });
        if (best && best.wetKm2 > 0.5) {
            pushDerived({ t: best.t, level: 'info', kind: 'peak', title: `Peak inundation: ${best.wetKm2.toFixed(1)} km²`,
                detail: `${fmtInt(best.exposed)} people in water over 30 cm at the peak.` });
            rebuildEvents();
        }
    }

    function rebuildEvents() {
        const sc = state.scenario;
        state.events = [...(sc ? sc.events : []), ...(state.derivedEvents || [])].sort((a, b) => a.t - b.t);
    }

    // ------------------------------------------------------------------ clock
    let lastTick = null;
    function tick(now) {
        if (state.playing) {
            const dt = lastTick ? Math.min(0.1, (now - lastTick) / 1000) : 0;
            const limit = state.done ? state.scenario.tEnd : Math.max(0, computedUntil());
            const next = Math.min(state.t + dt * state.speed, limit);
            if (next >= state.scenario.tEnd) { state.t = state.scenario.tEnd; setPlaying(false); }
            else state.t = next;
            state.buffering = !state.done && state.t >= limit - 1;
            emit('time', snapshot());
        }
        lastTick = now;
        requestAnimationFrame(tick);
    }

    function setPlaying(p) {
        if (p && state.scenario && state.t >= state.scenario.tEnd) state.t = 0;
        state.playing = p;
        emit('play', p);
    }

    // ------------------------------------------------------------------ sampling
    function frameBracket(t) {
        const sc = state.scenario;
        if (!sc || !state.frames.length) return null;
        const x = t / sc.frameEvery;
        const n = state.frames.length;
        const k0 = Math.max(0, Math.min(n - 1, Math.floor(x)));
        const k1 = Math.min(n - 1, k0 + 1);
        return { f0: state.frames[k0], f1: state.frames[k1] || state.frames[k0], a: Math.max(0, Math.min(1, x - k0)), k0 };
    }

    function sample(lng, lat, t) {
        const tr = state.terrain;
        if (!tr) return null;
        const i = tr.toCell(lng, lat);
        if (i < 0) return null;
        const b = frameBracket(t === undefined ? state.t : t);
        const out = { cell: i, elevation: tr.z[i], slope: tr.slope[i], depth: 0, speed: 0, conc: 0 };
        if (!b) return out;
        const L = (arr) => arr === null ? 0 : b.f0[arr][i] * (1 - b.a) + b.f1[arr][i] * b.a;
        out.depth = L('depth') / 1000;
        out.speed = Math.hypot(L('u'), L('v')) / 10;
        out.conc = L('conc') / 255;
        // history at this cell
        let peak = 0, peakT = null, arrival = null;
        state.frames.forEach(f => {
            const d = f.depth[i] / 1000;
            if (d > peak) { peak = d; peakT = f.t; }
            if (arrival === null && d >= EXPOSED_M) arrival = f.t;
        });
        out.peakDepth = peak; out.peakT = peakT; out.arrival = arrival;
        out.complete = state.done;
        return out;
    }

    /** Risk 0-1 from the worst simulated depth at a point over the next `horizonH` hours. */
    function riskAt(lng, lat, horizonH) {
        const tr = state.terrain;
        if (!tr || !state.frames.length || !state.scenario || state.scenario.villageId !== state.villageId) return null;
        const i = tr.toCell(lng, lat);
        if (i < 0) return 0.05;
        const sc = state.scenario;
        const k0 = Math.max(0, Math.floor(state.t / sc.frameEvery));
        const k1 = Math.min(state.frames.length - 1, k0 + Math.round((horizonH || 6) * HOUR / sc.frameEvery));
        let d = 0;
        for (let k = k0; k <= k1; k++) { const f = state.frames[k]; if (f && f.depth[i] > d) d = f.depth[i]; }
        d /= 1000;
        if (d < 0.05) return 0.03;
        return Math.min(1, 0.12 + d / 1.3);
    }

    function derivedAt(t) {
        const sc = state.scenario;
        if (!sc || !state.derived.length) return null;
        const k = Math.max(0, Math.min(state.derived.length - 1, Math.floor(t / sc.frameEvery)));
        return state.derived[k] || null;
    }

    function alertLevel(t) {
        const d = derivedAt(t);
        const sc = state.scenario;
        let lvl = 'green';
        const bump = (l) => { if (LEVEL_RANK[l] > LEVEL_RANK[lvl]) lvl = l; };
        state.events.forEach(e => { if (e.t <= t && e.level !== 'info') bump(e.level === 'red' ? 'orange' : e.level); });
        if (sc && S.seriesValueAt(sc.rain, sc.tStart, t) >= 15) bump('yellow');
        if (d) {
            if (d.exposed > 0) bump('yellow');
            if (d.exposed >= 1000 || d.lifeRisk > 0) bump('orange');
            if (d.lifeRisk >= 250 || d.exposed >= 10000) bump('red');
        }
        if (state.events.some(e => e.t <= t && e.level === 'red' && (e.kind === 'landslide' || e.kind === 'breach' || e.kind === 'surge'))) bump('red');
        return lvl;
    }

    function snapshot() {
        const sc = state.scenario;
        return {
            t: state.t, playing: state.playing, buffering: !!state.buffering, done: state.done,
            computedUntil: computedUntil(), scenario: sc,
            derived: derivedAt(state.t), derivedHourAgo: derivedAt(Math.max(0, state.t - HOUR)),
            rainNow: sc ? S.seriesValueAt(sc.rain, sc.tStart, state.t) : 0,
            rainSoFar: sc ? S.seriesValueAt(sc.cumRain, sc.tStart, state.t) : 0,
            alert: sc ? alertLevel(state.t) : 'green'
        };
    }

    function fmtInt(n) { return Math.round(n).toLocaleString('en-IN'); }

    // ------------------------------------------------------------------ public API
    const api = {
        state, on, sample, riskAt, snapshot, frameBracket, derivedAt,
        get facilities() { return state.facilityCells; },
        init(o) {
            opts = o || {};
            requestAnimationFrame(tick);
        },
        setVillage(vid) {
            if (!S || !global.floodSolverProgram) return;
            state.villageId = vid;
            state.t = 0;
            setPlaying(false);
            start();
        },
        setStorm(mm) {
            state.storm = mm;
            if (state.villageId) start();
        },
        refreshPopulation() {
            if (!state.terrain) return;
            preparePopulation();
            state.frames.forEach((f, k) => { if (f) state.derived[k] = deriveFrame(f); });
            emit('time', snapshot());
        },
        seek(t) {
            if (!state.scenario) return;
            state.t = Math.max(0, Math.min(state.scenario.tEnd, t));
            emit('time', snapshot());
        },
        play() { setPlaying(true); },
        pause() { setPlaying(false); },
        toggle() { setPlaying(!state.playing); },
        setSpeed(s) { state.speed = s; },
        /** Lines for the downloadable report. */
        reportLines() {
            const sc = state.scenario;
            if (!sc) return [];
            let peak = null;
            state.derived.forEach(d => { if (d && (!peak || d.wetKm2 > peak.wetKm2)) peak = d; });
            const lines = [
                `Scenario: ${sc.flood_type} (synthetic storm, ${sc.stormMm} mm in 24 h)`,
                `Model: local-inertial shallow-water solver on SRTM terrain, ${state.terrain.nx}x${state.terrain.ny} cells at ~${Math.round(state.terrain.dx)} m`,
                peak ? `Peak inundation: ${peak.wetKm2.toFixed(1)} km² at T+${(peak.t / HOUR).toFixed(1)} h` : 'Peak inundation: run incomplete',
                peak ? `People in water over 30 cm at peak: ${fmtInt(peak.exposed)} (density-model estimate)` : '',
                '', 'Event log:'
            ];
            state.events.forEach(e => lines.push(`  T+${String(Math.floor(e.t / HOUR)).padStart(2, '0')}:${String(Math.floor(e.t % HOUR / 60)).padStart(2, '0')}  [${e.level.toUpperCase()}] ${e.title}`));
            return lines;
        }
    };

    global.FloodSim = api;
})(window);
