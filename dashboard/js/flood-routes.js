/**
 * Jal Drishti - evacuation routes on the flood model
 * ---------------------------------------------------------------------------
 * Two views share one routing engine:
 *
 *   Evacuation plan  every high- or severe-risk hexagon of the risk grid gets
 *                    a route from where its people are to the nearest safe
 *                    place, drawn together as one network and listed by
 *                    people at risk. It is redrawn when the timeline stops.
 *   Point routes     a click anywhere plans up to three routes from that
 *                    point to different safe places.
 *
 * Safe places are listed facilities (shelters, hospitals, high ground, rescue
 * bases) that stay dry in the model for the rest of the run, and raised ground
 * found on a 1 km (hills) / 3 km (plains) lattice that never floods; on the
 * Bihar plain that picks out the embankment crests.
 *
 * Travel time uses Tobler's hiking function for slope, slowed in shallow
 * water and in high (x0.6) and severe (x0.4) risk cells, so routes leave the
 * danger zones by the quickest way out. On foot, water deeper than wading
 * depth and fast water (depth x speed) are impassable, and permanent river
 * channels cost the time to find a bridge. Where nobody can walk out, the
 * route is planned for a rescue boat through deep slack water and on foot
 * from where it lands.
 *
 * The plan uses one multi-source Dijkstra run backwards from every safe place,
 * which gives each cell its travel time and next step to safety, so routing
 * every zone costs about as much as one route (plus a second field for
 * boats). Point routes use a forward Dijkstra from the clicked cell. Paths are
 * straightened where the straight line is no worse (string pulling) and
 * rounded by Chaikin corner cutting.
 *
 *   FloodRoutes.startPlan() / stopPlan()   evacuation plan on / off
 *   FloodRoutes.plan(lng, lat) -> result    point routes; FloodRoutes.show(result)
 *   FloodRoutes.select(i), selectZone(k), clear()
 */
(function (global) {
    'use strict';

    const HOUR = 3600;
    const WADE_M = 0.45;          // deepest floodwater an adult can walk through
    const FAST_M2S = 0.5;         // depth x speed above which people lose footing
    const LOOKAHEAD_H = 2;        // water expected while walking out
    const CHANNEL_M = 0.3;        // water at T+0 deeper than this is a river channel
    const START_WADE_KM = 0.3;    // fast water right at the start point can still be left
    const BOAT_KMH = 6;           // rescue boat through slack floodwater
    const MAX_ROUTES = 3;
    const MAX_ZONES = 60;
    const RISK_SPEED = [1, 1, 1, 0.6, 0.4];      // walking speed factor by hexagon class
    const RISK_NAME = ['Safe', 'Low', 'Moderate', 'High', 'Severe'];
    const RISK_DOT = ['#2f9e57', '#56b84f', '#f2c12e', '#e0352b', '#a3121c'];

    const TYPE_LABEL = {
        hospital: 'Hospital', shelter: 'Relief shelter', high_ground: 'High ground',
        ndrf: 'NDRF base', sdrf: 'SDRF base', army: 'Army relief camp', fire_station: 'Fire station', ngo: 'Relief centre',
        raised: 'Raised ground'
    };

    let map = null;
    let current = null;          // point routes
    let active = 0;
    let markers = [];            // point-route markers
    let zoneMarkers = [];        // selected-zone markers
    let fitToken = 0;
    let planOn = false, planData = null, selZone = 0, view = 'plan';
    let replanTimer = null, bound = false;

    // appState is a top-level const in enhanced.js, so not a property of window
    function app() { return typeof appState !== 'undefined' ? appState : null; }

    // ---------------------------------------------------------------- hazard field
    function hazardField() {
        const st = FloodSim.state, t = st.terrain, sc = st.scenario;
        const N = t.nx * t.ny;
        const k0 = Math.max(0, Math.min(st.frames.length - 1, Math.floor(st.t / sc.frameEvery)));
        const kH = Math.min(st.frames.length - 1, k0 + Math.round(LOOKAHEAD_H * HOUR / sc.frameEvery));
        const kEnd = st.frames.length - 1;
        const base = st.frames[0].depth;
        const now = new Float32Array(N);     // floodwater now (m)
        const near = new Float32Array(N);    // worst floodwater over the next LOOKAHEAD_H
        const later = new Float32Array(N);   // worst floodwater for the rest of the computed run
        const fast = new Uint8Array(N);
        for (let k = k0; k <= kEnd; k++) {
            const f = st.frames[k];
            if (!f) continue;
            for (let i = 0; i < N; i++) {
                const e = f.depth[i] > base[i] ? (f.depth[i] - base[i]) / 1000 : 0;
                if (k === k0) now[i] = e;
                if (e > later[i]) later[i] = e;
                if (k <= kH) {
                    if (e > near[i]) near[i] = e;
                    const d = f.depth[i] / 1000;
                    if (d > 0.1 && d * Math.hypot(f.u[i], f.v[i]) / 10 > FAST_M2S) fast[i] = 1;
                }
            }
        }
        const channel = new Uint8Array(N);
        for (let i = 0; i < N; i++) if (base[i] / 1000 > CHANNEL_M) channel[i] = 1;
        return { now, near, later, fast, channel, k0, kEnd, complete: st.done || kEnd * sc.frameEvery >= sc.tEnd };
    }

    /** Risk class of every cell from the hexagon grid at the clock time, and the high/severe zones. */
    function riskField() {
        const t = FloodSim.state.terrain, N = t.nx * t.ny;
        const cls = new Uint8Array(N);
        const zones = [];
        if (!global.FloodGrid) return { cls, zones };
        FloodGrid.ranked(100000).forEach(r => {
            r.hex.cells.forEach(i => { cls[i] = r.s.risk; });
            if (r.s.risk >= 3) zones.push(r);
        });
        return { cls, zones };
    }

    // ---------------------------------------------------------------- safe places
    function settlements(vid) {
        try {
            if (typeof VILLAGE_POP_CONFIGS !== 'undefined' && VILLAGE_POP_CONFIGS[vid]) {
                return VILLAGE_POP_CONFIGS[vid].clusters.filter(c => !/Scattered/i.test(c.name));
            }
        } catch (e) { /* not loaded */ }
        return [];
    }

    function dryAround(hz, t, cell, r) {
        const r0 = Math.floor(cell / t.nx), c0 = cell % t.nx;
        let worst = 0;
        for (let rr = Math.max(0, r0 - r); rr <= Math.min(t.ny - 1, r0 + r); rr++)
            for (let cc = Math.max(0, c0 - r); cc <= Math.min(t.nx - 1, c0 + r); cc++) worst = Math.max(worst, hz.later[rr * t.nx + cc]);
        return worst;
    }

    /** "Raised ground 3 km NW of Kansi" / "Embankment at Khutwara". */
    function placeName(what, ll, towns) {
        let best = null, bd = Infinity;
        towns.forEach(s => { const d = distKm(ll, [s.lng, s.lat]); if (d < bd) { bd = d; best = s; } });
        if (!best || bd > 8) {
            // nothing named nearby: fall back to the grid cell, which the operators use anyway
            const h = typeof FloodGrid !== 'undefined' ? FloodGrid.hex(FloodGrid.hexAt(ll[0], ll[1])) : null;
            return h ? `${what} in ${h.id}` : `${what}, ${ll[1].toFixed(3)}°N ${ll[0].toFixed(3)}°E`;
        }
        if (bd < 0.3) return `${what} at ${best.name}`;
        const ang = Math.atan2((ll[1] - best.lat) * 111, (ll[0] - best.lng) * 111 * Math.cos(best.lat * Math.PI / 180));
        const dir = ['E', 'NE', 'N', 'NW', 'W', 'SW', 'S', 'SE'][((Math.round(ang / (Math.PI / 4)) % 8) + 8) % 8];
        const d = bd < 1 ? `${Math.round(bd * 10) * 100} m` : `${Math.round(bd)} km`;
        return `${what} ${d} ${dir} of ${best.name}`;
    }

    function candidates(hz) {
        const st = FloodSim.state, t = st.terrain, sc = st.scenario, z = sc.z || t.z;
        const out = [], excluded = [];
        (FloodSim.facilities || []).forEach(f => {
            if (f.cell < 0) return;
            const worst = dryAround(hz, t, f.cell, 1);
            const item = { name: f.name, kind: f.type, label: TYPE_LABEL[f.type] || 'Facility', cell: f.cell, lngLat: f.lngLat,
                capacity: f.capacity, listed: true, worst };
            if (worst >= 0.15 || hz.channel[f.cell]) excluded.push(item); else out.push(item);
        });
        // Raised ground everywhere: the highest gentle cell of every block
        // (1 km in the hills, 3 km on the plains) that stays dry for the rest
        // of the run and stands clearly above its block. On the Bihar plain the
        // modelled embankment crests qualify, as they do in real floods.
        const hilly = t.dx < 150;
        const B = Math.max(3, Math.round((hilly ? 1.0 : 3.0) * 1000 / t.dx));
        const maxSlope = hilly ? 14 : 4, minRise = hilly ? 15 : 1;
        const towns = settlements(st.villageId);
        for (let br = 0; br < t.ny; br += B) {
            for (let bc = 0; bc < t.nx; bc += B) {
                let best = -1, zmin = Infinity;
                for (let r = br; r < Math.min(t.ny - 1, br + B); r++) {
                    for (let c = bc; c < Math.min(t.nx - 1, bc + B); c++) {
                        const i = r * t.nx + c;
                        if (z[i] < zmin) zmin = z[i];
                        if (r < 1 || c < 1 || !t.mask[i] || hz.channel[i] || t.slope[i] > maxSlope) continue;
                        if (best >= 0 && z[i] <= z[best]) continue;
                        if (dryAround(hz, t, i, 1) > 0.02) continue;
                        best = i;
                    }
                }
                if (best < 0 || z[best] - zmin < minRise) continue;
                const ll = t.toLngLat(best);
                if (out.some(o => distKm(o.lngLat, ll) < (hilly ? 0.5 : 1.2))) continue;
                const embankment = !!sc.z && sc.z[best] - t.z[best] > 1;
                out.push({ name: placeName(embankment ? 'Embankment' : 'Raised ground', ll, towns), kind: 'raised',
                    label: embankment ? 'Embankment crest' : TYPE_LABEL.raised, cell: best, lngLat: ll, listed: false,
                    rise: z[best] - zmin, worst: 0 });
            }
        }
        // two spots can still share a name; number the repeats
        const seen = new Map();
        out.forEach(o => { const n = (seen.get(o.name) || 0) + 1; seen.set(o.name, n); if (n > 1) o.name += ` (${n})`; });
        return { list: out, excluded };
    }

    // ---------------------------------------------------------------- search
    function tobler(slope) { return 6 * Math.exp(-3.5 * Math.abs(slope + 0.05)); }     // km/h
    const DIRS = [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [-1, 1], [1, -1], [1, 1]];

    /**
     * Speed (km/h) for a step from cell `a` into cell `b`, or 0 if it cannot
     * be taken. On foot: slope, wading, river crossing, risk zone. By boat:
     * deep water and channels at boat speed.
     */
    function stepSpeed(hz, z, cls, a, b, stepKm, boat) {
        const d = hz.near[b];
        if (d > WADE_M || (boat && hz.channel[b])) return boat ? BOAT_KMH : 0;
        let v = tobler((z[b] - z[a]) / (stepKm * 1000)) * (d > 0.05 ? 1 - 0.75 * d / WADE_M : 1) * RISK_SPEED[cls[b]];
        if (hz.channel[b]) v = Math.min(v, 0.35);                     // crossing a river on foot: find a bridge
        return v;
    }

    function dijkstra(hz, cls, startCell, targets, boat) {
        const st = FloodSim.state, t = st.terrain, sc = st.scenario, z = sc.z || t.z;
        const N = t.nx * t.ny, nx = t.nx, ny = t.ny;
        const cost = new Float64Array(N).fill(Infinity);
        const prev = new Int32Array(N).fill(-1);
        const done = new Uint8Array(N);
        const want = new Set(targets.map(c => c.cell));
        let remaining = want.size;
        const heap = new Heap();
        cost[startCell] = 0;
        heap.push(startCell, 0);
        const sr = Math.floor(startCell / nx), scc = startCell % nx;
        const nearStart = (i) => Math.hypot((Math.floor(i / nx) - sr) * t.dy, (i % nx - scc) * t.dx) / 1000 <= START_WADE_KM;
        while (heap.size && remaining) {
            const [i, ci] = heap.pop();
            if (done[i]) continue;
            done[i] = 1;
            if (want.has(i)) remaining--;
            if (ci > 12) break;                                        // nothing reachable within 12 h
            const r = Math.floor(i / nx), c = i % nx;
            for (const [dr, dc] of DIRS) {
                const rr = r + dr, cc = c + dc;
                if (rr < 0 || rr >= ny || cc < 0 || cc >= nx) continue;
                const j = rr * nx + cc;
                if (done[j]) continue;
                if (hz.fast[j] && !nearStart(j)) continue;             // fast water: nobody crosses it
                const stepKm = Math.hypot(dr * t.dy, dc * t.dx) / 1000;
                const v = stepSpeed(hz, z, cls, i, j, stepKm, boat);
                if (!v) continue;
                const cj = ci + stepKm / Math.max(0.05, v);
                if (cj < cost[j]) { cost[j] = cj; prev[j] = i; heap.push(j, cj); }
            }
        }
        return { cost, prev };
    }

    /**
     * Backwards from every safe place at once: for each cell, the travel time
     * to the nearest safe place, the next cell on the way and which place it is.
     */
    function reverseField(hz, cls, cands, boat) {
        const st = FloodSim.state, t = st.terrain, sc = st.scenario, z = sc.z || t.z;
        const N = t.nx * t.ny, nx = t.nx, ny = t.ny;
        const cost = new Float64Array(N).fill(Infinity);
        const next = new Int32Array(N).fill(-1);
        const dest = new Int32Array(N).fill(-1);
        const done = new Uint8Array(N);
        const heap = new Heap();
        cands.forEach((c, k) => { cost[c.cell] = 0; dest[c.cell] = k; heap.push(c.cell, 0); });
        while (heap.size) {
            const [i, ci] = heap.pop();
            if (done[i]) continue;
            done[i] = 1;
            if (ci > 12) break;
            if (hz.fast[i] && ci > 0) continue;                        // nobody passes through fast water
            const r = Math.floor(i / nx), c = i % nx;
            for (const [dr, dc] of DIRS) {
                const rr = r + dr, cc = c + dc;
                if (rr < 0 || rr >= ny || cc < 0 || cc >= nx) continue;
                const j = rr * nx + cc;
                if (done[j]) continue;
                const stepKm = Math.hypot(dr * t.dy, dc * t.dx) / 1000;
                const v = stepSpeed(hz, z, cls, j, i, stepKm, boat);   // the traveller steps j -> i
                if (!v) continue;
                const cj = ci + stepKm / Math.max(0.05, v);
                if (cj < cost[j]) { cost[j] = cj; next[j] = i; dest[j] = dest[i]; heap.push(j, cj); }
            }
        }
        return { cost, next, dest };
    }

    class Heap {
        constructor() { this.i = []; this.k = []; }
        get size() { return this.i.length; }
        push(i, k) {
            const I = this.i, K = this.k;
            I.push(i); K.push(k);
            let n = I.length - 1;
            while (n > 0) {
                const p = (n - 1) >> 1;
                if (K[p] <= K[n]) break;
                [I[p], I[n]] = [I[n], I[p]]; [K[p], K[n]] = [K[n], K[p]];
                n = p;
            }
        }
        pop() {
            const I = this.i, K = this.k;
            const top = [I[0], K[0]];
            const li = I.pop(), lk = K.pop();
            if (I.length) {
                I[0] = li; K[0] = lk;
                let n = 0;
                for (;;) {
                    const a = 2 * n + 1, b = a + 1;
                    let m = n;
                    if (a < I.length && K[a] < K[m]) m = a;
                    if (b < I.length && K[b] < K[m]) m = b;
                    if (m === n) break;
                    [I[m], I[n]] = [I[n], I[m]]; [K[m], K[n]] = [K[n], K[m]];
                    n = m;
                }
            }
            return top;
        }
    }

    // ---------------------------------------------------------------- path shaping
    /** Drop grid corners where the straight line crosses nothing worse than the original path. */
    function stringPull(cells, hz, cls) {
        const t = FloodSim.state.terrain, nx = t.nx;
        const rc = (i) => [Math.floor(i / nx), i % nx];
        const penalty = (i) => (hz.channel[i] ? 3 : 0) + hz.near[i] * 4 + t.slope[i] / 12 + (cls[i] >= 3 ? cls[i] - 2 : 0);
        const out = [cells[0]];
        let a = 0;
        while (a < cells.length - 1) {
            let worst = 0, best = a + 1;
            for (let b = a + 1; b < cells.length && b - a <= 60; b++) {
                worst = Math.max(worst, penalty(cells[b]));
                const [r0, c0] = rc(cells[a]), [r1, c1] = rc(cells[b]);
                const n = Math.ceil(Math.hypot(r1 - r0, c1 - c0) * 2);
                let ok = true;
                for (let s = 1; s < n && ok; s++) {
                    const r = Math.round(r0 + (r1 - r0) * s / n), c = Math.round(c0 + (c1 - c0) * s / n);
                    const i = r * nx + c;
                    if (hz.near[i] > WADE_M || hz.fast[i] || penalty(i) > worst + 0.35) ok = false;
                }
                if (ok) best = b;
            }
            out.push(cells[best]);
            a = best;
        }
        return out;
    }

    function chaikin(pts, iter) {
        let p = pts;
        for (let n = 0; n < iter; n++) {
            if (p.length < 3) return p;
            const q = [p[0]];
            for (let i = 0; i < p.length - 1; i++) {
                const [x0, y0] = p[i], [x1, y1] = p[i + 1];
                q.push([0.75 * x0 + 0.25 * x1, 0.75 * y0 + 0.25 * y1], [0.25 * x0 + 0.75 * x1, 0.25 * y0 + 0.75 * y1]);
            }
            q.push(p[p.length - 1]);
            p = q;
        }
        return p;
    }

    function distKm(a, b) {
        const R = 6371, toR = Math.PI / 180;
        const dLat = (b[1] - a[1]) * toR, dLng = (b[0] - a[0]) * toR;
        const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * toR) * Math.cos(b[1] * toR) * Math.sin(dLng / 2) ** 2;
        return 2 * R * Math.asin(Math.sqrt(h));
    }

    function lineKm(coords) { let s = 0; for (let i = 1; i < coords.length; i++) s += distKm(coords[i - 1], coords[i]); return s; }

    /** Cell path -> boat / foot legs shaped into smooth lines, plus the route facts. */
    function shape(cells, startLL, endLL, byBoat, hz, cls) {
        const t = FloodSim.state.terrain, sc = FloodSim.state.scenario, z = sc.z || t.z;
        const legs = [];
        cells.forEach(i => {
            const mode = byBoat(i) ? 'boat' : 'foot';
            const leg = legs[legs.length - 1];
            if (!leg || leg.mode !== mode) legs.push({ mode, cells: leg ? [leg.cells[leg.cells.length - 1], i] : [i] });
            else leg.cells.push(i);
        });
        legs.forEach((leg, n) => {
            const pulled = stringPull(leg.cells, hz, cls);
            const first = n === 0 ? startLL : legs[n - 1].coords[legs[n - 1].coords.length - 1];
            const last = n === legs.length - 1 ? endLL : t.toLngLat(leg.cells[leg.cells.length - 1]);
            leg.coords = chaikin([first, ...pulled.slice(1, -1).map(i => t.toLngLat(i)), last], 3);
            leg.km = lineKm(leg.coords);
        });
        let climb = 0, wet = 0, crosses = false;
        for (let k = 1; k < cells.length; k++) { const dz = z[cells[k]] - z[cells[k - 1]]; if (dz > 0 && !byBoat(cells[k])) climb += dz; }
        cells.forEach(i => { if (!byBoat(i) && hz.near[i] > wet) wet = hz.near[i]; if (hz.channel[i] && !byBoat(i)) crosses = true; });
        return {
            legs, coords: legs.flatMap(l => l.coords), km: legs.reduce((a, l) => a + l.km, 0),
            boatKm: legs.filter(l => l.mode === 'boat').reduce((a, l) => a + l.km, 0),
            climb: Math.round(climb), maxWater: wet, crossesRiver: crosses
        };
    }

    function ready() {
        const st = global.FloodSim && FloodSim.state;
        return st && st.terrain && st.frames.length && st.scenario;
    }

    // ---------------------------------------------------------------- point routes
    function plan(lng, lat) {
        if (!ready()) return { status: 'failed', message: 'The flood model is still loading. Try again in a moment.' };
        const st = FloodSim.state, t = st.terrain;
        const start = t.toCell(lng, lat);
        if (start < 0) return { status: 'failed', message: 'That point is outside the modelled area.' };

        const hz = hazardField();
        const { cls } = riskField();
        const { list, excluded } = candidates(hz);
        if (!list.length) return { status: 'failed', message: 'No place in the model stays dry. Move to the highest floor available.' };
        let boat = hz.near[start] > WADE_M;
        let { cost, prev } = dijkstra(hz, cls, start, list, boat);
        if (!boat && !list.some(c => isFinite(cost[c.cell]))) {
            boat = true;                                              // cut off on foot: plan for a boat
            ({ cost, prev } = dijkstra(hz, cls, start, list, true));
        }
        const byBoat = (i) => boat && (hz.near[i] > WADE_M || hz.channel[i]);

        const reach = list.filter(c => isFinite(cost[c.cell])).sort((a, b) => cost[a.cell] - cost[b.cell]);
        const chosen = [];
        for (const c of reach) {
            if (chosen.some(o => distKm(o.lngLat, c.lngLat) < 0.8)) continue;   // alternatives must go somewhere else
            chosen.push(c);
            if (chosen.length === MAX_ROUTES) break;
        }
        if (!chosen.length) return { status: 'failed', message: 'Every way out is under deep or fast water in the model. Stay on the highest ground or floor and wait for a boat.' };

        const routes = chosen.map(c => {
            const cells = [];
            for (let i = c.cell; i >= 0; i = prev[i]) cells.push(i);
            cells.reverse();
            return Object.assign({ dest: c, min: Math.max(1, Math.round(cost[c.cell] * 60)), startWater: hz.near[start] },
                shape(cells, [lng, lat], c.lngLat, byBoat, hz, cls));
        });
        return { status: 'success', routes, excluded, start: [lng, lat], t: st.t, complete: hz.complete, boat, startRisk: cls[start] };
    }

    // ---------------------------------------------------------------- evacuation plan
    /**
     * Where the people of a hexagon are: the cell with most residents in water,
     * preferring cells they can still wade out of; people in deep water only
     * win when most of the hexagon is deep.
     */
    function zoneStart(hex, hz) {
        const st = FloodSim.state, t = st.terrain, pop = st.cellPop;
        let best = -1, bs = -1;
        hex.cells.forEach(i => {
            if (!t.mask[i] || hz.channel[i]) return;
            const w = (hz.now[i] >= 0.3 ? 1 : (hz.now[i] >= 0.1 ? 0.5 : 0.05)) * (hz.near[i] > WADE_M ? 0.25 : 1);
            const s = (pop ? pop[i] : 1) * w;
            if (s > bs) { bs = s; best = i; }
        });
        return best >= 0 ? best : t.toCell(hex.center[0], hex.center[1]);
    }

    function buildPlan() {
        if (!ready()) return null;
        const st = FloodSim.state, t = st.terrain;
        const t0 = performance.now();
        const hz = hazardField();
        const { cls, zones } = riskField();
        const { list, excluded } = candidates(hz);
        const out = { t: st.t, villageId: st.villageId, zones: [], excluded, complete: hz.complete, places: list.length };
        if (!zones.length || !list.length) { out.ms = Math.round(performance.now() - t0); return out; }
        const walk = reverseField(hz, cls, list, false);
        let boatF = null;
        zones.sort((a, b) => b.s.atRisk - a.s.atRisk || b.s.risk - a.s.risk);
        zones.slice(0, MAX_ZONES).forEach(r => {
            const start = zoneStart(r.hex, hz);
            const zone = { idx: r.idx, id: r.hex.id, risk: r.s.risk, people: Math.round(r.s.atRisk), life: Math.round(r.s.lifeRisk),
                residents: Math.round(r.hex.population), start, startLL: t.toLngLat(start), startWater: hz.near[start] };
            let field = null, boat = false;
            if (hz.near[start] <= WADE_M && isFinite(walk.cost[start])) field = walk;
            else {
                boatF = boatF || reverseField(hz, cls, list, true);
                if (isFinite(boatF.cost[start])) { field = boatF; boat = true; }
            }
            if (!field) { zone.mode = 'cut'; out.zones.push(zone); return; }
            const cells = [start];
            for (let i = start, guard = 0; field.next[i] >= 0 && guard < 20000; guard++) { i = field.next[i]; cells.push(i); }
            const dest = list[field.dest[start]];
            const byBoat = (i) => boat && (hz.near[i] > WADE_M || hz.channel[i]);
            Object.assign(zone, { dest, min: Math.max(1, Math.round(field.cost[start] * 60)) },
                shape(cells, zone.startLL, dest.lngLat, byBoat, hz, cls));
            zone.mode = zone.boatKm > 0.05 ? 'boat' : 'walk';
            out.zones.push(zone);
        });
        out.more = Math.max(0, zones.length - MAX_ZONES);
        out.ms = Math.round(performance.now() - t0);
        return out;
    }

    function startPlan() {
        map = app() && app().map;
        if (!map) return;
        planOn = true; view = 'plan'; selZone = 0;
        bindEvents();
        clearPoint();
        replan(true);
    }

    function stopPlan() {
        planOn = false; planData = null;
        clearTimeout(replanTimer);
        zoneMarkers.forEach(m => m.marker.remove());
        zoneMarkers = [];
        if (map && map.getSource('evac-plan')) map.getSource('evac-plan').setData({ type: 'FeatureCollection', features: [] });
    }

    function replan(refit) {
        if (!planOn) return;
        const keep = planData && planData.zones[selZone] ? planData.zones[selZone].idx : null;
        planData = buildPlan();
        if (!planData) { renderPanel(); return; }
        const k = keep === null ? -1 : planData.zones.findIndex(z => z.idx === keep);
        selZone = k >= 0 ? k : 0;
        ensureLayers();
        renderPlan();
        if (view === 'plan') renderPanel();
        if (refit) {
            const lines = planData.zones.filter(z => z.coords).map(z => z.coords);
            if (lines.length) fitCoords(lines, closeZoom() - 0.5);
        }
    }

    /** Keep the plan in step with the clock: redraw once the timeline stops moving. */
    function bindEvents() {
        if (bound || !global.FloodSim) return;
        bound = true;
        const maybe = () => {
            if (!planOn || !ready()) return;
            clearTimeout(replanTimer);
            replanTimer = setTimeout(() => {
                if (!planOn || FloodSim.state.playing) { if (view === 'plan' && planData) renderPanel(); return; }
                if (!planData || Math.abs(FloodSim.state.t - planData.t) >= 900 || (!planData.complete && FloodSim.state.done)) replan(false);
            }, 450);
        };
        FloodSim.on('time', maybe);
        FloodSim.on('play', maybe);
        FloodSim.on('done', maybe);
        FloodSim.on('scenario', () => { if (planOn) { planData = null; clearPoint(); zoneMarkers.forEach(m => m.marker.remove()); zoneMarkers = []; } });
    }

    function selectZone(k) {
        if (!planData || k < 0 || k >= planData.zones.length) return;
        selZone = k;
        if (view !== 'plan') backToPlan(); else { renderPlan(); renderPanel(); }
        const z = planData.zones[k];
        fitCoords(z.coords ? [z.coords] : [[z.startLL, z.startLL]], z.coords ? closeZoom() : closeZoom() - 1.5);
    }

    function backToPlan() {
        clearPoint();
        view = 'plan';
        renderPlan();
        renderPanel();
    }

    // ---------------------------------------------------------------- drawing
    function chevronImage() {
        const s = 24, cv = document.createElement('canvas');
        cv.width = cv.height = s;
        const g = cv.getContext('2d');
        g.strokeStyle = '#0b1016'; g.lineWidth = 3.2; g.lineCap = 'round'; g.lineJoin = 'round';
        g.beginPath(); g.moveTo(9, 6); g.lineTo(16, 12); g.lineTo(9, 18); g.stroke();
        return g.getImageData(0, 0, s, s);
    }

    function ensureLayers() {
        if (!map.hasImage('evac-chevron')) map.addImage('evac-chevron', chevronImage(), { pixelRatio: 2 });
        const add = (layer) => { if (!map.getLayer(layer.id)) map.addLayer(layer); };
        const lineLayout = { 'line-cap': 'round', 'line-join': 'round' };
        // evacuation plan network (below the point routes)
        if (!map.getSource('evac-plan')) map.addSource('evac-plan', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
        const isLine = ['==', ['geometry-type'], 'LineString'];
        const sel = ['==', ['get', 'sel'], true];
        add({ id: 'evac-plan-casing', type: 'line', source: 'evac-plan', filter: isLine, layout: lineLayout,
            paint: { 'line-color': '#0b1016', 'line-opacity': 0.6, 'line-width': ['interpolate', ['linear'], ['zoom'], 9, ['case', sel, 6, 3.5], 14, ['case', sel, 11, 6]] } });
        add({ id: 'evac-plan-line', type: 'line', source: 'evac-plan', filter: ['all', isLine, ['!=', ['get', 'mode'], 'boat']], layout: lineLayout,
            paint: { 'line-color': ['case', sel, '#f3f6f9', '#cfd8e1'], 'line-opacity': ['case', sel, 1, 0.85],
                'line-width': ['interpolate', ['linear'], ['zoom'], 9, ['case', sel, 3, 1.5], 14, ['case', sel, 6, 3]] } });
        add({ id: 'evac-plan-boat', type: 'line', source: 'evac-plan', filter: ['all', isLine, ['==', ['get', 'mode'], 'boat']], layout: { 'line-cap': 'butt', 'line-join': 'round' },
            paint: { 'line-color': ['case', sel, '#f3f6f9', '#cfd8e1'], 'line-dasharray': [2, 1.2],
                'line-width': ['interpolate', ['linear'], ['zoom'], 9, ['case', sel, 3, 1.5], 14, ['case', sel, 6, 3]] } });
        add({ id: 'evac-plan-chev', type: 'symbol', source: 'evac-plan', filter: ['all', isLine, sel],
            layout: { 'symbol-placement': 'line', 'symbol-spacing': 70, 'icon-image': 'evac-chevron', 'icon-size': ['interpolate', ['linear'], ['zoom'], 9, 0.5, 14, 0.85],
                'icon-rotation-alignment': 'map', 'icon-allow-overlap': true, 'icon-ignore-placement': true } });
        add({ id: 'evac-plan-dest', type: 'circle', source: 'evac-plan', filter: ['==', ['get', 'kind'], 'dest'],
            paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 3.5, 14, 6], 'circle-color': '#f3f6f9', 'circle-stroke-color': '#0b1016', 'circle-stroke-width': 2 } });
        add({ id: 'evac-plan-origin', type: 'circle', source: 'evac-plan', filter: ['==', ['get', 'kind'], 'origin'],
            // zoom has to be the outermost input of these expressions
            paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, ['case', sel, 7, 4.5], 14, ['case', sel, 10, 7]],
                'circle-color': ['match', ['get', 'risk'], 4, RISK_DOT[4], RISK_DOT[3]], 'circle-stroke-color': '#ffffff', 'circle-stroke-width': ['case', sel, 2.5, 1.5] } });
        // point routes
        if (!map.getSource('evac-routes')) map.addSource('evac-routes', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
        const alt = ['!=', ['get', 'active'], true], act = ['==', ['get', 'active'], true];
        add({ id: 'evac-alt-casing', type: 'line', source: 'evac-routes', filter: alt, layout: lineLayout,
            paint: { 'line-color': '#0b1016', 'line-opacity': 0.55, 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 4, 14, 7] } });
        add({ id: 'evac-alt-line', type: 'line', source: 'evac-routes', filter: alt, layout: lineLayout,
            paint: { 'line-color': '#b8c3ce', 'line-opacity': 0.9, 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 2, 14, 3.5], 'line-dasharray': [1.6, 1.4] } });
        add({ id: 'evac-casing', type: 'line', source: 'evac-routes', filter: act, layout: lineLayout,
            paint: { 'line-color': '#0b1016', 'line-opacity': 0.8, 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 7, 14, 12] } });
        add({ id: 'evac-line', type: 'line', source: 'evac-routes', filter: ['all', act, ['!=', ['get', 'mode'], 'boat']], layout: lineLayout,
            paint: { 'line-color': '#f3f6f9', 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 3.5, 14, 7] } });
        // boat legs: same white, broken into dashes over the water
        add({ id: 'evac-boat', type: 'line', source: 'evac-routes', filter: ['all', act, ['==', ['get', 'mode'], 'boat']], layout: { 'line-cap': 'butt', 'line-join': 'round' },
            paint: { 'line-color': '#f3f6f9', 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 3.5, 14, 7], 'line-dasharray': [2, 1.2] } });
        add({ id: 'evac-chevrons', type: 'symbol', source: 'evac-routes', filter: act,
            layout: { 'symbol-placement': 'line', 'symbol-spacing': 70, 'icon-image': 'evac-chevron', 'icon-size': ['interpolate', ['linear'], ['zoom'], 9, 0.55, 14, 0.9],
                'icon-rotation-alignment': 'map', 'icon-allow-overlap': true, 'icon-ignore-placement': true } });
        ['evac-alt-line', 'evac-alt-casing'].forEach(id => {
            map.off('click', id, onAltClick); map.on('click', id, onAltClick);
            map.off('mouseenter', id, onEnter); map.on('mouseenter', id, onEnter);
            map.off('mouseleave', id, onLeave); map.on('mouseleave', id, onLeave);
        });
        map.off('click', 'evac-plan-origin', onOriginClick); map.on('click', 'evac-plan-origin', onOriginClick);
        map.off('mouseenter', 'evac-plan-origin', onEnter); map.on('mouseenter', 'evac-plan-origin', onEnter);
        map.off('mouseleave', 'evac-plan-origin', onLeave); map.on('mouseleave', 'evac-plan-origin', onLeave);
    }
    function onAltClick(e) { const f = e.features && e.features[0]; if (f) select(f.properties.rank); }
    function onOriginClick(e) { const f = e.features && e.features[0]; if (f) selectZone(f.properties.z); }
    function onEnter() { map.getCanvas().style.cursor = 'pointer'; }
    function onLeave() { map.getCanvas().style.cursor = app() && app().rescueMode ? 'crosshair' : ''; }

    function renderPlan() {
        const src = map && map.getSource('evac-plan');
        if (!src) return;
        const feats = [];
        const dests = new Map();
        const dim = view !== 'plan';
        (planData ? planData.zones : []).forEach((z, k) => {
            const s = !dim && k === selZone;
            if (z.legs) z.legs.forEach(l => feats.push({ type: 'Feature', properties: { z: k, sel: s, mode: l.mode }, geometry: { type: 'LineString', coordinates: l.coords } }));
            if (z.dest) dests.set(z.dest.cell, z.dest.lngLat);
            feats.push({ type: 'Feature', properties: { kind: 'origin', z: k, risk: z.risk, sel: s }, geometry: { type: 'Point', coordinates: z.startLL } });
        });
        dests.forEach(ll => feats.push({ type: 'Feature', properties: { kind: 'dest' }, geometry: { type: 'Point', coordinates: ll } }));
        // the selected route draws on top
        feats.sort((a, b) => Number(a.properties.sel) - Number(b.properties.sel));
        src.setData({ type: 'FeatureCollection', features: feats });
        ['evac-plan-casing', 'evac-plan-line', 'evac-plan-boat', 'evac-plan-dest', 'evac-plan-origin'].forEach(id => {
            if (!map.getLayer(id)) return;
            const prop = id.endsWith('dest') || id.endsWith('origin') ? 'circle-opacity' : 'line-opacity';
            map.setPaintProperty(id, prop, dim ? 0.3 : (id === 'evac-plan-casing' ? 0.6 : (id === 'evac-plan-line' ? ['case', ['==', ['get', 'sel'], true], 1, 0.85] : 1)));
            if (prop === 'circle-opacity') map.setPaintProperty(id, 'circle-stroke-opacity', dim ? 0.3 : 1);
        });
        // labels for the selected zone
        zoneMarkers.forEach(m => m.marker.remove());
        zoneMarkers = [];
        const z = planData && !dim ? planData.zones[selZone] : null;
        if (z) {
            zoneMarkers.push(pin(z.startLL, `<span class="evac-pin__label"><b>${esc(z.id)}</b><span>${fmtInt(z.people)} in water</span></span><span class="evac-pin__stem"></span>`, 'evac-pin--dest is-active evac-pin--zone'));
            if (z.dest) zoneMarkers.push(pin(z.dest.lngLat, `<span class="evac-pin__label"><b>${esc(z.dest.name)}</b><span>${fmtKm(z.km)} · ${fmtMin(z.min)}${z.mode === 'boat' ? ' · boat' : ''}</span></span><span class="evac-pin__stem"></span>`, 'evac-pin--dest is-active'));
        }
        if (global.FloodRender) FloodRender.invalidate();
    }

    function pin(lngLat, html, cls) {
        const el = document.createElement('div');
        el.className = `evac-pin ${cls}`;
        el.innerHTML = html;
        return { el, marker: new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat(lngLat).addTo(map) };
    }

    function renderPoint() {
        const src = map.getSource('evac-routes');
        if (!src || !current) return;
        src.setData({
            type: 'FeatureCollection',
            // inactive routes first so the active one draws on top
            features: current.routes.flatMap((r, k) => r.legs.map(l => ({ type: 'Feature', properties: { rank: k, active: k === active, mode: l.mode }, geometry: { type: 'LineString', coordinates: l.coords } })))
                .sort((a, b) => Number(a.properties.active) - Number(b.properties.active))
        });
        markers.forEach(m => {
            if (m.rank === undefined) return;
            m.el.classList.toggle('is-active', m.rank === active);
            m.el.style.zIndex = m.rank === active ? 3 : 2;
        });
        renderPanel();
        if (global.FloodRender) FloodRender.invalidate();
    }

    function addMarker(lngLat, html, cls, rank, title) {
        const el = document.createElement('div');
        el.className = `evac-pin ${cls}`;
        if (title) el.title = title;
        el.innerHTML = html;
        if (rank !== undefined) el.addEventListener('click', (e) => { e.stopPropagation(); select(rank); });
        const marker = new maplibregl.Marker({ element: el, anchor: cls === 'evac-pin--start' ? 'center' : 'bottom' }).setLngLat(lngLat).addTo(map);
        markers.push({ marker, el, rank });
    }

    function fmtKm(km) { return km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km`; }
    function fmtMin(m) { return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`; }
    function fmtT(t) { const m = Math.round(t / 60); return `T+${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; }
    const fmtInt = (n) => Math.round(n).toLocaleString('en-IN');
    const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

    function show(result) {
        map = app() && app().map;
        if (!map || !result || result.status !== 'success') return;
        clearPoint();
        current = result;
        active = 0;
        view = 'point';
        ensureLayers();
        if (planOn) renderPlan();                                       // dim the plan underneath
        addMarker(result.start, '<span class="evac-pin__dot"></span>', 'evac-pin--start');
        result.routes.forEach((r, k) => addMarker(r.dest.lngLat,
            `<span class="evac-pin__label"><b>${esc(r.dest.name)}</b><span>${fmtKm(r.km)} · ${fmtMin(r.min)}</span></span><span class="evac-pin__stem"></span>`,
            'evac-pin--dest', k, `Route ${k + 1}: ${r.dest.name}, ${fmtKm(r.km)}, ${fmtMin(r.min)}`));
        renderPoint();
        fitCoords(current.routes.map(r => r.coords), closeZoom());
    }

    function select(k) {
        if (!current || k < 0 || k >= current.routes.length) return;
        active = k;
        renderPoint();
    }

    /**
     * Frame lines in the free space between the panels. fitBounds picks far
     * too low a zoom once the map is tilted and rotated, so the zoom is
     * worked out top-down.
     */
    /** Closest the camera goes for one route: the plains' 3 km cells need more context. */
    function closeZoom() { return FloodSim.state.terrain && FloodSim.state.terrain.dx >= 150 ? 13 : 14; }

    function fitCoords(lines, maxZoom) {
        if (!map || !lines.length) return;
        let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
        lines.forEach(cs => cs.forEach(([x, y]) => { w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y); }));
        const narrow = window.innerWidth <= 900;
        const hidden = !!document.querySelector('#hud.panels-hidden');
        const padding = narrow ? { top: 120, bottom: 170, left: 20, right: 20 }
            : { top: 110, bottom: 150, left: hidden ? 60 : 370, right: hidden ? 370 : 700 };
        const my = (lat) => (1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2;
        const availW = Math.max(160, window.innerWidth - padding.left - padding.right);
        const availH = Math.max(160, window.innerHeight - padding.top - padding.bottom);
        const zx = Math.log2(availW / (Math.max(e - w, 1e-4) / 360 * 512));
        const zy = Math.log2(availH / (Math.max(my(s) - my(n), 1e-6) * 512));
        const zoom = Math.max(8, Math.min(maxZoom || 14.5, Math.min(zx, zy) - 0.35));
        const want = [(w + e) / 2, (s + n) / 2];
        map.flyTo({ center: want, zoom, padding, duration: 1100, essential: true });
        // With 3D terrain, MapLibre re-anchors the centre on the ground at the
        // end of every animated move by reading back the terrain depth buffer.
        // Where that read-back is unreliable (seen on software rendering) it
        // throws the camera kilometres off on high ground such as Meppadi. If
        // the camera did not settle where planned, put it there with an
        // instant jump, which does not re-anchor.
        const token = ++fitToken;
        map.once('moveend', () => {
            if (token !== fitToken) return;
            const c = map.getCenter();
            const px = Math.pow(2, zoom) * 512 / 360;                          // pixels per degree of longitude
            const off = Math.hypot((want[0] - c.lng) * px, (want[1] - c.lat) * px);
            if (off > 25 || Math.abs(map.getZoom() - zoom) > 0.15) map.jumpTo({ center: want, zoom, padding });
        });
    }

    function clearPoint() {
        markers.forEach(m => m.marker.remove());
        markers = [];
        current = null;
        if (map && map.getSource('evac-routes')) map.getSource('evac-routes').setData({ type: 'FeatureCollection', features: [] });
    }

    function clear() {
        clearPoint();
        stopPlan();
        const panel = document.getElementById('evacPanel');
        if (panel) panel.hidden = true;
    }

    // ---------------------------------------------------------------- panel
    function panelEl() {
        let panel = document.getElementById('evacPanel');
        if (!panel) {
            panel = document.createElement('section');
            panel.id = 'evacPanel';
            panel.className = 'panel evac-panel';
            document.body.appendChild(panel);
            panel.addEventListener('click', (e) => {
                const row = e.target.closest('[data-rank]');
                if (row) select(Number(row.dataset.rank));
                const zrow = e.target.closest('[data-zone]');
                if (zrow) selectZone(Number(zrow.dataset.zone));
                if (e.target.closest('[data-act="back"]')) backToPlan();
                if (e.target.closest('[data-act="close"]')) {
                    if (typeof toggleRescueMode === 'function' && app() && app().rescueMode) toggleRescueMode();
                    else clear();
                }
            });
        }
        return panel;
    }

    function renderPanel() {
        const panel = panelEl();
        panel.innerHTML = view === 'point' && current ? pointPanel() : planPanel();
        panel.hidden = false;
    }

    function routeFacts(r) {
        const water = (m) => m < 0.05 ? 'dry' : `${m < 0.3 ? 'up to ' : ''}${m.toFixed(1)} m of water`;
        return [
            ...(r.boatKm > 0.05
                ? [['By boat', fmtKm(r.boatKm)], ['On foot', fmtKm(Math.max(0, r.km - r.boatKm))], ['Time', `about ${fmtMin(r.min)} once a boat is there`]]
                : [['Walk', `${fmtKm(r.km)}, about ${fmtMin(r.min)}`]]),
            ['Climb', `${r.climb} m`],
            ['Wading', r.maxWater < 0.05 ? 'None, dry on foot' : `${water(r.maxWater)} at worst`],
            ['River crossing', r.crossesRiver ? 'Yes: use a bridge or boat' : 'None'],
            ['Destination', r.dest.listed
                ? `${esc(r.dest.label)}${r.dest.capacity ? `, holds ${r.dest.capacity}` : ''}; dry in the model to T+24 h`
                : `${esc(r.dest.label)}${r.dest.rise < 10 ? `, ${r.dest.rise.toFixed(1)} m above the land around it` : ' above the flood'}; dry in the model to T+24 h`]
        ];
    }
    const dl = (rows) => `<dl class="readout evac-facts">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`;

    function planPanel() {
        const head = `<div class="panel__head"><h2>Evacuation plan</h2>
            <button type="button" class="evac-close" data-act="close" aria-label="Close evacuation plan">Close</button></div>`;
        if (!planData) return head + '<p class="evac-note">The flood model is still loading. The plan appears as soon as it is ready.</p>';
        const p = planData;
        const playing = FloodSim.state.playing;
        const stale = Math.abs(FloodSim.state.t - p.t) >= 900;
        const sub = `<div class="evac-sub mono">High-risk cells at ${fmtT(p.t)}${stale ? (playing ? ' · pause to update' : ' · updating') : ''}</div>`;
        if (!p.zones.length) {
            return head + sub + `<p class="evac-note">No grid cell is rated high or severe at ${fmtT(p.t)}. Move the timeline on, or click any point on the map to plan routes from there.</p>`;
        }
        const zs = p.zones;
        const walk = zs.filter(z => z.mode === 'walk').length, boat = zs.filter(z => z.mode === 'boat').length, cut = zs.filter(z => z.mode === 'cut').length;
        const people = zs.reduce((a, z) => a + z.people, 0);
        const places = new Set(zs.filter(z => z.dest).map(z => z.dest.cell)).size;
        const sum = [
            ['High / severe cells', `${zs.filter(z => z.risk === 3).length} high, ${zs.filter(z => z.risk === 4).length} severe${p.more ? ` (+${p.more} not shown)` : ''}`],
            ['People in water there', fmtInt(people)],
            ['Walk out', `${walk} cells`],
            ['Need a boat', `${boat} cells`],
            ...(cut ? [['Cut off', `${cut} cells: airlift or shelter in place`]] : []),
            ['Safe places used', `${places}`]
        ];
        const rows = zs.map((z, k) => `
            <button type="button" class="evac-row evac-zone ${k === selZone ? 'is-active' : ''}" data-zone="${k}">
                <span class="evac-risk" style="background:${RISK_DOT[z.risk]}" title="${RISK_NAME[z.risk]}"></span>
                <span class="evac-row__main"><span class="evac-row__name">${esc(z.id)} <span class="evac-row__meta">· ${fmtInt(z.people)} in water</span></span>
                    <span class="evac-row__meta">${z.dest ? `to ${esc(z.dest.name)}` : 'no way out: airlift or shelter in place'}</span></span>
                <span class="evac-row__time mono">${z.dest ? fmtMin(z.min) : '—'}<small>${z.mode === 'boat' ? 'boat' : (z.mode === 'walk' ? fmtKm(z.km) : '')}</small></span>
            </button>`).join('');
        const z = zs[selZone];
        let detail = '';
        if (z) {
            const facts = z.dest ? routeFacts(z) : [['Route', 'None: every way out is deep or fast water']];
            detail = `<div class="evac-detail"><div class="evac-detail__title">${esc(z.id)} · ${RISK_NAME[z.risk]} · ${fmtInt(z.residents)} residents, ${fmtInt(z.people)} in water${z.life ? `, ${fmtInt(z.life)} at risk to life` : ''}</div>${dl(facts)}</div>`;
        }
        const warn = [];
        if (p.excluded.length) warn.push(`${p.excluded.length} listed ${p.excluded.length === 1 ? 'place is' : 'places are'} not used because the model floods ${p.excluded.length === 1 ? 'it' : 'them'}: ${p.excluded.map(x => esc(x.name)).join(', ')}.`);
        if (!p.complete) warn.push('The model run is not finished; destinations are checked against the part computed so far.');
        return head + sub + dl(sum) + `<div class="evac-list evac-list--zones">${rows}</div>` + detail +
            warn.map(w => `<p class="evac-warn">${w}</p>`).join('') +
            `<p class="evac-note">Each high or severe cell is routed from where most of its people are to the nearest place the model keeps dry, avoiding other high-risk cells where it can. Click a cell in the list or on the map to follow its route, or click anywhere else for alternatives from that point.</p>`;
    }

    function pointPanel() {
        const c = current, r = c.routes[active];
        const [lng, lat] = c.start;
        const rows = c.routes.map((x, k) => `
            <button type="button" class="evac-row ${k === active ? 'is-active' : ''}" data-rank="${k}">
                <span class="evac-row__n">${k + 1}</span>
                <span class="evac-row__main"><span class="evac-row__name">${esc(x.dest.name)}</span>
                    <span class="evac-row__meta">${esc(x.dest.label)}${x.dest.listed ? '' : ' · model'}${x.boatKm > 0.05 ? ' · boat + foot' : ''}</span></span>
                <span class="evac-row__time mono">${fmtMin(x.min)}<small>${fmtKm(x.km)}</small></span>
            </button>`).join('');
        const warn = [];
        if (r.startWater > WADE_M) warn.push(`The start point is under ${r.startWater.toFixed(1)} m of water. People here need a boat; the dashed part of the route is the boat leg.`);
        else if (r.boatKm > 0.05) warn.push('Every way out on foot is cut by deep water. The dashed part of the route needs a boat.');
        if (c.startRisk >= 3) warn.push(`The start point is in a ${RISK_NAME[c.startRisk].toLowerCase()}-risk cell; the routes leave it by the quickest way out.`);
        if (c.excluded.length) warn.push(`${c.excluded.length} listed ${c.excluded.length === 1 ? 'place was' : 'places were'} left out because the model floods ${c.excluded.length === 1 ? 'it' : 'them'}: ${c.excluded.map(x => esc(x.name)).join(', ')}.`);
        if (!c.complete) warn.push('The model run is not finished yet; destinations are checked against the part computed so far.');
        return `
            <div class="panel__head"><h2>Routes from this point</h2>
                <span class="evac-head-actions">${planOn ? '<button type="button" class="evac-close" data-act="back">Back to plan</button>' : ''}
                <button type="button" class="evac-close" data-act="close" aria-label="Close routes">Close</button></span></div>
            <div class="evac-sub mono">${lat.toFixed(4)}°N ${lng.toFixed(4)}°E · planned at ${fmtT(c.t)}</div>
            <div class="evac-list">${rows}</div>
            ${dl(routeFacts(r))}
            ${warn.map(w => `<p class="evac-warn">${w}</p>`).join('')}
            <p class="evac-note">Walking times use slope and water depth (Tobler's hiking function) and are slower through high-risk cells; boats are taken at ${BOAT_KMH} km/h. Routes avoid fast water, and on foot any water deeper than ${WADE_M} m, expected in the next ${LOOKAHEAD_H} h.</p>`;
    }

    global.FloodRoutes = {
        plan, show, select, clear, startPlan, stopPlan, selectZone,
        get current() { return current; },
        get planData() { return planData; },
        get planActive() { return planOn; }
    };
})(window);
