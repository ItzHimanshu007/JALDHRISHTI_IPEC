/**
 * Jal Drishti - evacuation routes on the flood model
 * ---------------------------------------------------------------------------
 * Routes are planned on the simulation's own terrain grid, against the water
 * the model expects over the next couple of hours, and they only ever end at
 * a safe place:
 *
 *   - listed facilities (shelters, hospitals, high ground, rescue bases) that
 *     stay dry in the model for the rest of the run, and
 *   - raised ground next to each named settlement: the highest gentle, dry
 *     cell within walking distance that the model keeps dry to T+24 h.
 *
 * Travel time uses Tobler's hiking function for slope, slowed in shallow
 * water. On foot, water deeper than wading depth and fast water (depth x
 * speed) are impassable, and permanent river channels can only be crossed at
 * a heavy cost (finding a bridge). If the start is already in deep water, or
 * no walking route exists, the route is planned for a rescue boat through
 * deep but slow water and on foot from where it lands. One Dijkstra search from the start gives the
 * time to every candidate; the three quickest distinct ones become routes.
 * Paths are then straightened where the straight line is no worse (string
 * pulling) and rounded with Chaikin corner cutting, so they read as routes
 * rather than grid staircases.
 *
 *   FloodRoutes.plan(lng, lat) -> { status, routes[], excluded, t } | { status:'failed', message }
 *   FloodRoutes.show(result)   draws routes, markers and the route panel
 *   FloodRoutes.select(i)      makes route i the active one
 *   FloodRoutes.clear()
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

    const TYPE_LABEL = {
        hospital: 'Hospital', shelter: 'Relief shelter', high_ground: 'High ground',
        ndrf: 'NDRF base', sdrf: 'SDRF base', army: 'Army relief camp', fire_station: 'Fire station', ngo: 'Relief centre',
        raised: 'Raised ground'
    };

    let map = null;
    let current = null;          // last plan result
    let active = 0;
    let markers = [];
    let fitToken = 0;

    // ---------------------------------------------------------------- hazard field
    function hazardField() {
        const st = FloodSim.state, t = st.terrain, sc = st.scenario;
        const N = t.nx * t.ny;
        const k0 = Math.max(0, Math.min(st.frames.length - 1, Math.floor(st.t / sc.frameEvery)));
        const kH = Math.min(st.frames.length - 1, k0 + Math.round(LOOKAHEAD_H * HOUR / sc.frameEvery));
        const kEnd = st.frames.length - 1;
        const base = st.frames[0].depth;
        const near = new Float32Array(N);    // worst floodwater (m) over the next LOOKAHEAD_H
        const later = new Float32Array(N);   // worst floodwater for the rest of the computed run
        const fast = new Uint8Array(N);
        for (let k = k0; k <= kEnd; k++) {
            const f = st.frames[k];
            if (!f) continue;
            for (let i = 0; i < N; i++) {
                const e = f.depth[i] > base[i] ? (f.depth[i] - base[i]) / 1000 : 0;
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
        return { near, later, fast, channel, k0, kEnd, complete: st.done || kEnd * sc.frameEvery >= sc.tEnd };
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
        if (!best || bd > 8) return `${what}, ${ll[1].toFixed(3)}°N ${ll[0].toFixed(3)}°E`;
        if (bd < 1) return `${what} at ${best.name}`;
        const ang = Math.atan2((ll[1] - best.lat) * 111, (ll[0] - best.lng) * 111 * Math.cos(best.lat * Math.PI / 180));
        const dir = ['E', 'NE', 'N', 'NW', 'W', 'SW', 'S', 'SE'][((Math.round(ang / (Math.PI / 4)) % 8) + 8) % 8];
        return `${what} ${Math.round(bd)} km ${dir} of ${best.name}`;
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
        return { list: out, excluded };
    }

    // ---------------------------------------------------------------- search
    function tobler(slope) { return 6 * Math.exp(-3.5 * Math.abs(slope + 0.05)); }     // km/h

    function dijkstra(hz, startCell, targets, boat) {
        const st = FloodSim.state, t = st.terrain, sc = st.scenario, z = sc.z || t.z;
        const N = t.nx * t.ny, nx = t.nx, ny = t.ny;
        const cost = new Float64Array(N).fill(Infinity);
        const prev = new Int32Array(N).fill(-1);
        const done = new Uint8Array(N);
        const want = new Map(targets.map((c, k) => [c.cell, k]));
        let remaining = want.size;
        const heap = new Heap();
        cost[startCell] = 0;
        heap.push(startCell, 0);
        const sr = Math.floor(startCell / nx), scc = startCell % nx;
        const DIRS = [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [-1, 1], [1, -1], [1, 1]];
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
                const d = hz.near[j];
                const stepKm = Math.hypot(dr * t.dy, dc * t.dx) / 1000;
                let v;
                if (hz.fast[j] && !nearStart(j)) continue;             // fast water: nobody crosses it
                if (d > WADE_M || (boat && hz.channel[j])) {
                    if (!boat) continue;                               // too deep to wade
                    v = BOAT_KMH;
                } else {
                    v = tobler((z[j] - z[i]) / (stepKm * 1000)) * (d > 0.05 ? 1 - 0.75 * d / WADE_M : 1);
                    if (hz.channel[j]) v = Math.min(v, 0.35);          // crossing a river on foot: find a bridge
                }
                const cj = ci + stepKm / Math.max(0.05, v);
                if (cj < cost[j]) { cost[j] = cj; prev[j] = i; heap.push(j, cj); }
            }
        }
        return { cost, prev };
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
    function stringPull(cells, hz) {
        const t = FloodSim.state.terrain, nx = t.nx;
        const rc = (i) => [Math.floor(i / nx), i % nx];
        const penalty = (i) => (hz.channel[i] ? 3 : 0) + hz.near[i] * 4 + t.slope[i] / 12;
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

    // ---------------------------------------------------------------- plan
    function plan(lng, lat) {
        const st = window.FloodSim && FloodSim.state;
        if (!st || !st.terrain || !st.frames.length) return { status: 'failed', message: 'The flood model is still loading. Try again in a moment.' };
        const t = st.terrain, sc = st.scenario, z = sc.z || t.z;
        const start = t.toCell(lng, lat);
        if (start < 0) return { status: 'failed', message: 'That point is outside the modelled area.' };

        const hz = hazardField();
        const { list, excluded } = candidates(hz);
        if (!list.length) return { status: 'failed', message: 'No place in the model stays dry. Move to the highest floor available.' };
        let boat = hz.near[start] > WADE_M;
        let { cost, prev } = dijkstra(hz, start, list, boat);
        if (!boat && !list.some(c => isFinite(cost[c.cell]))) {
            boat = true;                                              // cut off on foot: plan for a boat
            ({ cost, prev } = dijkstra(hz, start, list, true));
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
            // split into boat and foot legs, shape each leg on its own
            const legs = [];
            cells.forEach((i, k) => {
                const mode = byBoat(i) ? 'boat' : 'foot';
                const leg = legs[legs.length - 1];
                if (!leg || leg.mode !== mode) { legs.push({ mode, cells: leg ? [leg.cells[leg.cells.length - 1], i] : [i] }); }
                else leg.cells.push(i);
            });
            legs.forEach((leg, n) => {
                const pulled = stringPull(leg.cells, hz);
                const first = n === 0 ? [lng, lat] : legs[n - 1].coords[legs[n - 1].coords.length - 1];
                const last = n === legs.length - 1 ? c.lngLat : t.toLngLat(leg.cells[leg.cells.length - 1]);
                leg.coords = chaikin([first, ...pulled.slice(1, -1).map(i => t.toLngLat(i)), last], 3);
                leg.km = lineKm(leg.coords);
            });
            let climb = 0, wet = 0, crosses = false;
            for (let k = 1; k < cells.length; k++) { const dz = z[cells[k]] - z[cells[k - 1]]; if (dz > 0 && !byBoat(cells[k])) climb += dz; }
            cells.forEach(i => { if (!byBoat(i) && hz.near[i] > wet) wet = hz.near[i]; if (hz.channel[i] && !byBoat(i)) crosses = true; });
            const boatKm = legs.filter(l => l.mode === 'boat').reduce((a, l) => a + l.km, 0);
            return {
                dest: c, legs, coords: legs.flatMap(l => l.coords), km: legs.reduce((a, l) => a + l.km, 0),
                min: Math.max(1, Math.round(cost[c.cell] * 60)), boatKm,
                climb: Math.round(climb), maxWater: wet, crossesRiver: crosses,
                startWater: hz.near[start]
            };
        });
        return { status: 'success', routes, excluded, start: [lng, lat], t: st.t, complete: hz.complete, boat };
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
        if (!map.getSource('evac-routes')) map.addSource('evac-routes', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
        if (!map.hasImage('evac-chevron')) map.addImage('evac-chevron', chevronImage(), { pixelRatio: 2 });
        const alt = ['!=', ['get', 'active'], true], act = ['==', ['get', 'active'], true];
        const add = (layer) => { if (!map.getLayer(layer.id)) map.addLayer(layer); };
        add({ id: 'evac-alt-casing', type: 'line', source: 'evac-routes', filter: alt, layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: { 'line-color': '#0b1016', 'line-opacity': 0.55, 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 4, 14, 7] } });
        add({ id: 'evac-alt-line', type: 'line', source: 'evac-routes', filter: alt, layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: { 'line-color': '#b8c3ce', 'line-opacity': 0.9, 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 2, 14, 3.5], 'line-dasharray': [1.6, 1.4] } });
        add({ id: 'evac-casing', type: 'line', source: 'evac-routes', filter: act, layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: { 'line-color': '#0b1016', 'line-opacity': 0.8, 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 7, 14, 12] } });
        add({ id: 'evac-line', type: 'line', source: 'evac-routes', filter: ['all', act, ['!=', ['get', 'mode'], 'boat']], layout: { 'line-cap': 'round', 'line-join': 'round' },
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
    }
    function onAltClick(e) { const f = e.features && e.features[0]; if (f) { e.preventDefault && e.preventDefault(); select(f.properties.rank); } }
    function onEnter() { map.getCanvas().style.cursor = 'pointer'; }
    function onLeave() { map.getCanvas().style.cursor = app() && app().rescueMode ? 'crosshair' : ''; }
    // appState is a top-level const in enhanced.js, so not a property of window
    function app() { return typeof appState !== 'undefined' ? appState : null; }

    function render() {
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
    const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

    function show(result) {
        map = app() && app().map;
        if (!map || !result || result.status !== 'success') return;
        clear();
        current = result;
        active = 0;
        ensureLayers();
        addMarker(result.start, '<span class="evac-pin__dot"></span>', 'evac-pin--start');
        result.routes.forEach((r, k) => addMarker(r.dest.lngLat,
            `<span class="evac-pin__label"><b>${esc(r.dest.name)}</b><span>${fmtKm(r.km)} · ${fmtMin(r.min)}</span></span><span class="evac-pin__stem"></span>`,
            'evac-pin--dest', k, `Route ${k + 1}: ${r.dest.name}, ${fmtKm(r.km)}, ${fmtMin(r.min)}`));
        render();
        fit();
    }

    function select(k) {
        if (!current || k < 0 || k >= current.routes.length) return;
        active = k;
        render();
    }

    /** Frame the start and every route, clear of the side panels and the route panel. */
    function fit() {
        if (!current || !map) return;
        let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
        current.routes.forEach(r => r.coords.forEach(([x, y]) => { w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y); }));
        const narrow = window.innerWidth <= 900;
        const hidden = !!document.querySelector('#hud.panels-hidden');
        const padding = narrow ? { top: 120, bottom: 170, left: 20, right: 20 }
            : { top: 110, bottom: 150, left: hidden ? 60 : 370, right: hidden ? 370 : 700 };
        // zoom that fits the routes top-down in the free space (512 px tiles); fitBounds
        // picks far too low a zoom once the map is tilted and rotated
        const my = (lat) => (1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2;
        const availW = Math.max(160, window.innerWidth - padding.left - padding.right);
        const availH = Math.max(160, window.innerHeight - padding.top - padding.bottom);
        const zx = Math.log2(availW / (Math.max(e - w, 1e-4) / 360 * 512));
        const zy = Math.log2(availH / (Math.max(my(s) - my(n), 1e-6) * 512));
        const zoom = Math.max(8, Math.min(14.5, Math.min(zx, zy) - 0.35));
        map.flyTo({ center: [(w + e) / 2, (s + n) / 2], zoom, padding, duration: 1100, essential: true });
        // With 3D terrain the camera settles on the ground surface, which moves
        // high-ground routes off the planned spot. Measure where they actually
        // are on screen and bring them into the free area.
        const token = ++fitToken;
        map.once('moveend', () => {
            if (token !== fitToken || !current) return;
            let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
            current.routes.forEach(r => r.coords.forEach(c => {
                const q = map.project(c);
                x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y);
            }));
            const tx = padding.left + availW / 2, ty = padding.top + availH / 2;
            const scale = Math.max((x1 - x0) / availW, (y1 - y0) / availH);
            const dx = (x0 + x1) / 2 - tx, dy = (y0 + y1) / 2 - ty;
            if (Math.abs(dx) < 20 && Math.abs(dy) < 20 && scale <= 1) return;
            map.panBy([dx, dy], { duration: 450 });
            if (scale > 1) map.once('moveend', () => { if (token === fitToken) map.easeTo({ zoom: map.getZoom() - Math.log2(scale) - 0.15, around: map.unproject([tx, ty]), duration: 450 }); });
        });
    }

    function clear() {
        markers.forEach(m => m.marker.remove());
        markers = [];
        current = null;
        const panel = document.getElementById('evacPanel');
        if (panel) panel.hidden = true;
        if (map && map.getSource('evac-routes')) map.getSource('evac-routes').setData({ type: 'FeatureCollection', features: [] });
    }

    // ---------------------------------------------------------------- panel
    function renderPanel() {
        let panel = document.getElementById('evacPanel');
        if (!panel) {
            panel = document.createElement('section');
            panel.id = 'evacPanel';
            panel.className = 'panel evac-panel';
            document.body.appendChild(panel);
            panel.addEventListener('click', (e) => {
                const row = e.target.closest('[data-rank]');
                if (row) select(Number(row.dataset.rank));
                if (e.target.closest('[data-act="close"]') && typeof toggleRescueMode === 'function' && app() && app().rescueMode) toggleRescueMode();
                else if (e.target.closest('[data-act="close"]')) clear();
            });
        }
        const c = current, r = c.routes[active];
        const [lng, lat] = c.start;
        const water = (m) => m < 0.05 ? 'dry' : `${m < 0.3 ? 'up to ' : ''}${m.toFixed(1)} m of water`;
        const rows = c.routes.map((x, k) => `
            <button type="button" class="evac-row ${k === active ? 'is-active' : ''}" data-rank="${k}">
                <span class="evac-row__n">${k + 1}</span>
                <span class="evac-row__main"><span class="evac-row__name">${esc(x.dest.name)}</span>
                    <span class="evac-row__meta">${esc(x.dest.label)}${x.dest.listed ? '' : ' · model'}${x.boatKm > 0.05 ? ' · boat + foot' : ''}</span></span>
                <span class="evac-row__time mono">${fmtMin(x.min)}<small>${fmtKm(x.km)}</small></span>
            </button>`).join('');
        const facts = [
            ...(r.boatKm > 0.05
                ? [['By boat', fmtKm(r.boatKm)], ['On foot', fmtKm(Math.max(0, r.km - r.boatKm))], ['Time', `about ${fmtMin(r.min)} once a boat reaches you`]]
                : [['Walk', `${fmtKm(r.km)}, about ${fmtMin(r.min)}`]]),
            ['Climb', `${r.climb} m`],
            ['Wading', r.maxWater < 0.05 ? 'None, dry on foot' : `${water(r.maxWater)} at worst`],
            ['River crossing', r.crossesRiver ? 'Yes: use a bridge or boat' : 'None'],
            ['Destination', r.dest.listed
                ? `${esc(r.dest.label)}${r.dest.capacity ? `, holds ${r.dest.capacity}` : ''}; dry in the model to T+24 h`
                : `${esc(r.dest.label)}${r.dest.rise < 10 ? `, ${r.dest.rise.toFixed(1)} m above the land around it` : ' above the flood'}; dry in the model to T+24 h`]
        ];
        const warn = [];
        if (r.startWater > WADE_M) warn.push(`The start point is under ${r.startWater.toFixed(1)} m of water. People here need a boat; the dashed part of the route is the boat leg.`);
        else if (r.boatKm > 0.05) warn.push('Every way out on foot is cut by deep water. The dashed part of the route needs a boat.');
        if (c.excluded.length) warn.push(`${c.excluded.length} listed ${c.excluded.length === 1 ? 'place was' : 'places were'} left out because the model floods ${c.excluded.length === 1 ? 'it' : 'them'}: ${c.excluded.map(x => esc(x.name)).join(', ')}.`);
        if (!c.complete) warn.push('The model run is not finished yet; destinations are checked against the part computed so far.');
        panel.innerHTML = `
            <div class="panel__head"><h2>Evacuation routes</h2>
                <button type="button" class="evac-close" data-act="close" aria-label="Close routes">Close</button></div>
            <div class="evac-sub mono">From ${lat.toFixed(4)}°N ${lng.toFixed(4)}°E · planned at ${fmtT(c.t)}</div>
            <div class="evac-list">${rows}</div>
            <dl class="readout evac-facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
            ${warn.map(w => `<p class="evac-warn">${w}</p>`).join('')}
            <p class="evac-note">Walking times use slope and water depth (Tobler's hiking function); boats are taken at ${BOAT_KMH} km/h. Routes avoid fast water, and on foot any water deeper than ${WADE_M} m, expected in the next ${LOOKAHEAD_H} h. Click the map to plan from another point.</p>`;
        panel.hidden = false;
    }

    global.FloodRoutes = { plan, show, select, clear, get current() { return current; } };
})(window);
