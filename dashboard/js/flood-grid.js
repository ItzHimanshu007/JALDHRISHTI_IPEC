/**
 * Jal Drishti - hexagonal risk grid
 * ---------------------------------------------------------------------------
 * Divides each village's administrative area into ~220 equal hexagons
 * (hexagons have equal neighbour distances, so water spreading reads evenly)
 * and aggregates the simulation per hexagon at the clock time:
 *
 *   water accumulated (m³), mean / max depth, % of the hexagon under water,
 *   residents and people in water over 30 cm, people in deep or fast water,
 *   rain received so far, peak flow speed, and a risk class + index.
 *
 * Hexagons are drawn on the map (fill by risk class, outline), with a hover
 * card; ops-ui.js shows the full readout on click and a ranked list.
 */
(function (global) {
    'use strict';

    const TARGET_HEXES = 220;
    const PREFIX = { wayanad_meppadi: 'MPD', darbhanga: 'DBG', dhemaji: 'DMJ' };
    // Safe / Low = green, Moderate = yellow, High = red, Severe = dark red
    const RISK = ['Safe', 'Low', 'Moderate', 'High', 'Severe'];
    const RISK_COLOR = ['#2f9e57', '#56b84f', '#f2c12e', '#e0352b', '#7a0c12'];
    const SQ3 = Math.sqrt(3);

    let map = null;
    let grid = null;          // { hexes, cellHex, R, ... }
    let statsKey = '';
    let appliedKey = '';
    let stats = [];
    let visible = true;
    let hoverId = null;
    let labels = [];
    let columns = true;           // 3D risk columns on/off              // HTML markers with hexagon IDs, shown when zoomed in
    let popup = null;

    function rowLabel(n) {
        let s = '';
        n += 1;
        while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
        return s;
    }

    function build() {
        const st = FloodSim.state, t = st.terrain, sc = st.scenario;
        if (!t) return;
        const [w, s, e, n] = t.bounds;
        const lat0 = (s + n) / 2;
        const kx = 111.32 * Math.cos(lat0 * Math.PI / 180), ky = 110.57;
        const N = t.nx * t.ny;
        let inside = 0;
        for (let i = 0; i < N; i++) if (t.mask[i]) inside++;
        const areaKm2 = inside * t.cellKm2;
        const hexArea = areaKm2 / TARGET_HEXES;
        const R = Math.sqrt(2 * hexArea / (3 * SQ3));          // circumradius, km

        const byKey = new Map();
        const cellHex = new Int32Array(N).fill(-1);
        const tmp = [];
        for (let i = 0; i < N; i++) {
            if (!t.mask[i]) continue;
            const [lng, lat] = t.toLngLat(i);
            const x = (lng - w) * kx, y = (lat - s) * ky;
            // pointy-top axial coordinates, cube rounding
            const qf = (SQ3 / 3 * x - y / 3) / R, rf = (2 / 3 * y) / R;
            let q = Math.round(qf), r = Math.round(rf), c = Math.round(-qf - rf);
            const dq = Math.abs(q - qf), dr = Math.abs(r - rf), dc = Math.abs(c + qf + rf);
            if (dq > dr && dq > dc) q = -r - c; else if (dr > dc) r = -q - c;
            const key = q + ',' + r;
            let h = byKey.get(key);
            if (!h) { h = { q, r, cells: [] }; byKey.set(key, h); }
            h.cells.push(i);
            tmp.push([i, h]);
        }
        // Keep hexagons that are at least a quarter inside the boundary.
        const cellsPerHex = hexArea / t.cellKm2;
        const hexes = [...byKey.values()].filter(h => h.cells.length >= cellsPerHex * 0.25);
        const rs = hexes.map(h => h.r), rMax = Math.max(...rs);
        const cols = hexes.map(h => h.q + Math.floor(h.r / 2)), cMin = Math.min(...cols);
        const prefix = PREFIX[sc.villageId] || 'HEX';
        const gis = cellGis(t, sc);
        hexes.forEach((h, idx) => {
            h.idx = idx;
            h.row = rMax - h.r;                                  // A = northernmost row
            h.col = h.q + Math.floor(h.r / 2) - cMin + 1;
            h.id = `${prefix}-${rowLabel(h.row)}${String(h.col).padStart(2, '0')}`;
            const cx = R * SQ3 * (h.q + h.r / 2), cy = R * 1.5 * h.r;
            h.center = [w + cx / kx, s + cy / ky];
            h.ring = [];
            for (let k = 0; k <= 6; k++) {
                const a = Math.PI / 180 * (60 * (k % 6) - 30);
                h.ring.push([w + (cx + R * Math.cos(a)) / kx, s + (cy + R * Math.sin(a)) / ky]);
            }
            h.cells.forEach(i => { cellHex[i] = idx; });
            h.areaKm2 = h.cells.length * t.cellKm2;
            let pop = 0, zsum = 0, wsum = 0, zmin = Infinity, zmax = -Infinity, ssum = 0, hsum = 0, dmin = Infinity, unstable = 0;
            h.cells.forEach(i => {
                pop += st.cellPop[i]; zsum += t.z[i]; wsum += sc.rainWeight[i];
                if (t.z[i] < zmin) zmin = t.z[i];
                if (t.z[i] > zmax) zmax = t.z[i];
                ssum += t.slope[i]; hsum += gis.hand[i];
                if (gis.dist[i] < dmin) dmin = gis.dist[i];
                unstable += gis.unstable[i];
            });
            const nC = h.cells.length;
            h.zMin = zmin; h.zMax = zmax;
            h.slope = ssum / nC;
            h.hand = hsum / nC;                      // mean height above the nearest drainage line
            h.riverKm = dmin / 1000;
            h.unstablePct = unstable / nC * 100;
            h.terrain = terrainClass(sc.villageId, h);
            h.susceptibility = susceptibility(sc.villageId, h);
            // floor at a third of the district's rural density: no inhabited hexagon reads zero
            const ambient = (typeof DISTRICT_AMBIENT_DENSITY_PER_KM2 !== 'undefined' && DISTRICT_AMBIENT_DENSITY_PER_KM2[sc.villageId]) || 250;
            h.population = Math.max(pop, h.areaKm2 * ambient * 0.33);
            h.elevation = zsum / h.cells.length;
            h.rainWeight = wsum / h.cells.length;
        });
        labels.forEach(l => l.marker.remove());
        labels = [];
        const chan = new Uint8Array(N);
        if (sc.initialDepth) for (let i = 0; i < N; i++) if (sc.initialDepth[i] > 0) chan[i] = 1;
        hexes.forEach(h => { h.channelCells = h.cells.reduce((a, i) => a + chan[i], 0); });
        grid = { hexes, cellHex, R, hexArea, chan };
        statsKey = ''; appliedKey = '';
        ensureLayers();
    }

    // ---------------------------------------------------------------- static GIS
    /**
     * Per model cell: drainage lines (from flow accumulation), distance to the
     * nearest one and height above it (HAND, a standard flood-susceptibility
     * terrain index), via a two-pass chamfer transform that carries the
     * nearest drainage cell. Meppadi also gets cells that would fail when the
     * soil is saturated (infinite-slope model).
     */
    function cellGis(t, sc) {
        const nx = t.nx, ny = t.ny, N = nx * ny;
        const drainKm2 = t.dx < 150 ? 1.5 : 40;
        const dist = new Float32Array(N).fill(Infinity);
        const src = new Int32Array(N).fill(-1);
        for (let i = 0; i < N; i++) if (t.acc[i] * t.cellKm2 >= drainKm2) { dist[i] = 0; src[i] = i; }
        const dd = Math.hypot(t.dx, t.dy);
        const relax = (i, j, w) => { if (dist[j] + w < dist[i]) { dist[i] = dist[j] + w; src[i] = src[j]; } };
        for (let r = 0; r < ny; r++) for (let c = 0; c < nx; c++) {
            const i = r * nx + c;
            if (c > 0) relax(i, i - 1, t.dx);
            if (r > 0) { relax(i, i - nx, t.dy); if (c > 0) relax(i, i - nx - 1, dd); if (c < nx - 1) relax(i, i - nx + 1, dd); }
        }
        for (let r = ny - 1; r >= 0; r--) for (let c = nx - 1; c >= 0; c--) {
            const i = r * nx + c;
            if (c < nx - 1) relax(i, i + 1, t.dx);
            if (r < ny - 1) { relax(i, i + nx, t.dy); if (c < nx - 1) relax(i, i + nx + 1, dd); if (c > 0) relax(i, i + nx - 1, dd); }
        }
        const hand = new Float32Array(N), unstable = new Uint8Array(N);
        const slopeModel = !!sc.landslide;
        for (let i = 0; i < N; i++) {
            hand[i] = src[i] >= 0 ? Math.max(0, t.z[i] - t.z[src[i]]) : 0;
            if (slopeModel && t.slope[i] >= 26 && FloodScenarios.factorOfSafety(t.slope[i], 1) < 1) unstable[i] = 1;
        }
        return { dist, hand, unstable };
    }

    function terrainClass(vid, h) {
        if (vid === 'wayanad_meppadi') {
            if (h.slope >= 22) return 'Steep hillside';
            if (h.hand < 8) return 'Valley floor / stream corridor';
            if (h.slope >= 12) return 'Hill slopes';
            return 'Plateau, gentle slopes';
        }
        if (h.slope >= 4) return 'Foothills';
        if (h.hand < 0.8) return 'Active floodplain';
        if (h.hand < 2.5) return 'Low-lying plain';
        if (h.hand < 5) return 'Plain';
        return 'Raised ground';
    }

    /** Baseline (pre-storm) flood susceptibility from terrain alone: 0-100 + class. */
    function susceptibility(vid, h) {
        const hills = vid === 'wayanad_meppadi';
        const handN = Math.min(1, h.hand / (hills ? 40 : 5));
        const distN = Math.min(1, h.riverKm / (hills ? 1 : 6));
        const flatN = Math.min(1, h.slope / (hills ? 25 : 3));
        let score = 100 * (0.5 * (1 - handN) + 0.3 * (1 - distN) + 0.2 * (1 - flatN));
        if (hills) score = Math.max(score, Math.min(100, h.unstablePct * 1.6));   // landslide-prone slopes
        score = Math.round(score);
        return { score, label: score >= 65 ? 'High' : score >= 40 ? 'Medium' : 'Low' };
    }

    function ensureLayers() {
        if (!map || !grid) return;
        const fc = {
            type: 'FeatureCollection',
            features: grid.hexes.map(h => ({ type: 'Feature', id: h.idx, properties: { hex: h.id }, geometry: { type: 'Polygon', coordinates: [h.ring] } }))
        };
        if (map.getSource('flood-grid-src')) {
            map.getSource('flood-grid-src').setData(fc);
        } else {
            map.addSource('flood-grid-src', { type: 'geojson', data: fc });
            const firstWater = map.getStyle().layers.find(l => l.id.startsWith('flood-sim-'));
            const before = ['village-boundary-layer', 'village-boundary-glow'].find(id => map.getLayer(id));
            map.addLayer({
                id: 'flood-grid-fill', type: 'fill', source: 'flood-grid-src',
                paint: {
                    'fill-color': ['match', ['coalesce', ['feature-state', 'risk'], 0], 1, RISK_COLOR[1], 2, RISK_COLOR[2], 3, RISK_COLOR[3], 4, RISK_COLOR[4], RISK_COLOR[0]],
                    // strong at district scale, light when zoomed in so the water shows through
                    'fill-opacity': ['interpolate', ['linear'], ['zoom'],
                        9, ['case', ['boolean', ['feature-state', 'hover'], false], 0.85,
                            ['match', ['coalesce', ['feature-state', 'risk'], 0], 0, 0.32, 1, 0.4, 2, 0.6, 3, 0.66, 0.78]],
                        10.8, ['case', ['boolean', ['feature-state', 'hover'], false], 0.7,
                            ['match', ['coalesce', ['feature-state', 'risk'], 0], 0, 0.18, 1, 0.24, 2, 0.42, 3, 0.48, 0.58]],
                        13, ['case', ['boolean', ['feature-state', 'hover'], false], 0.4,
                            ['match', ['coalesce', ['feature-state', 'risk'], 0], 0, 0.03, 1, 0.06, 2, 0.14, 3, 0.18, 0.24]]]
                }
            }, firstWater ? firstWater.id : before);
            map.addLayer({
                id: 'flood-grid-line', type: 'line', source: 'flood-grid-src',
                paint: {
                    'line-color': ['case', ['boolean', ['feature-state', 'hover'], false], '#ffffff', 'rgba(20,24,28,0.55)'],
                    'line-width': ['interpolate', ['linear'], ['zoom'], 9, ['case', ['boolean', ['feature-state', 'hover'], false], 2.2, 0.6], 13, ['case', ['boolean', ['feature-state', 'hover'], false], 3, 1.2]]
                }
            }, before);
            // 3D risk columns: moderate-and-worse hexagons rise with their risk index,
            // so the flood reads in 3D even on the flat Bihar / Assam plains
            map.addLayer({
                id: 'flood-grid-3d', type: 'fill-extrusion', source: 'flood-grid-src',
                layout: { visibility: visible && columns ? 'visible' : 'none' },
                paint: {
                    'fill-extrusion-color': ['match', ['coalesce', ['feature-state', 'risk'], 0], 2, RISK_COLOR[2], 3, RISK_COLOR[3], 4, RISK_COLOR[4], RISK_COLOR[1]],
                    'fill-extrusion-height': ['coalesce', ['feature-state', 'h'], 0],
                    'fill-extrusion-base': 0,
                    'fill-extrusion-opacity': 0.78,
                    'fill-extrusion-vertical-gradient': true
                }
            });
            map.on('zoomend', syncLabels);
            map.on('mousemove', 'flood-grid-fill', onHover);
            map.on('mouseleave', 'flood-grid-fill', onLeave);
        }
        setVisible(visible);
        refresh(true);
    }

    // ---------------------------------------------------------------- stats
    function compute() {
        const st = FloodSim.state, sc = st.scenario;
        if (!grid || !sc || !st.frames.length) return stats;
        const k = Math.max(0, Math.min(st.frames.length - 1, Math.round(st.t / sc.frameEvery)));
        const key = `${st.runId}:${k}:${st.frames.length > k}`;
        if (key === statsKey) return stats;
        statsKey = key;
        const f = st.frames[k], t = st.terrain, cellArea = t.dx * t.dy;
        const cum = FloodScenarios.seriesValueAt(sc.cumRain, sc.tStart, f.t);
        const chan = grid.chan;
        stats = grid.hexes.map(h => {
            let vol = 0, sum = 0, max = 0, wet = 0, atRisk = 0, life = 0, vmax = 0, sed = 0, n = 0;
            for (const i of h.cells) {
                const d = f.depth[i] / 1000;
                vol += d * cellArea;
                if (d > 0.02 && !chan[i]) { sum += d; n++; sed += f.conc[i]; }
                if (!chan[i] && d > max) max = d;             // flood depth on land, not in the river bed
                if (d > 0.15 && !chan[i]) wet++;
                const sp = Math.hypot(f.u[i], f.v[i]) / 10;
                if (sp > vmax && d > 0.05) vmax = sp;
                if (d >= 0.3) atRisk += st.cellPop[i];
                if (d >= 1.5 || d * sp > 1) life += st.cellPop[i];
            }
            const land = h.cells.length - h.channelCells;
            const wetFrac = land > 0 ? wet / land : 0;
            const popFrac = atRisk / Math.max(1, h.population), lifeFrac = life / Math.max(1, h.population);
            // classes are relative to the hexagon (share flooded, share of residents in water)
            let risk = 0;
            if ((max >= 2 && wetFrac >= 0.35) || lifeFrac >= 0.12) risk = 4;
            else if ((max >= 1 && wetFrac >= 0.2) || wetFrac >= 0.5 || popFrac >= 0.25) risk = 3;
            else if ((max >= 0.5 && wetFrac >= 0.05) || wetFrac >= 0.12 || popFrac >= 0.06) risk = 2;
            else if (wetFrac > 0.02) risk = 1;
            const index = Math.round(100 * Math.min(1, 0.4 * Math.min(1, max / 2.5) + 0.35 * wetFrac + 0.25 * Math.min(1, popFrac * 3)));
            return {
                volume: vol, meanDepth: n ? sum / n : 0, maxDepth: max, wetFrac, atRisk, lifeRisk: life,
                maxSpeed: vmax, sediment: n ? sed / n / 255 : 0, rainMm: cum * h.rainWeight, risk, index, t: f.t
            };
        });
        return stats;
    }

    function refresh(force) {
        if (!map || !grid || !map.getSource('flood-grid-src')) return;
        compute();
        if (!force && appliedKey === statsKey) return;
        appliedKey = statsKey;
        // column height: proportional to the risk index, scaled to the hexagon size
        const hMax = grid.R * 1000 * 1.4;
        stats.forEach((s, idx) => map.setFeatureState({ source: 'flood-grid-src', id: idx },
            { risk: s.risk, h: s.risk >= 2 && s.t > 0 ? Math.max(0.05, Math.pow(s.index / 100, 1.6)) * hMax * (s.risk === 2 ? 0.55 : 1) : 0 }));
        labels.forEach(l => { const r = stats[l.idx] ? stats[l.idx].risk : 0; if (l.el.dataset.risk !== String(r)) l.el.dataset.risk = r; });
        if (labels.length) syncLabels();
        if (window.FloodRender) FloodRender.invalidate();
        if (hoverId !== null && popup) popup.setHTML(card(hoverId, true));
    }

    // ---------------------------------------------------------------- hover
    const fmt = (n) => Math.round(n).toLocaleString('en-IN');
    function fmtVol(m3) { return m3 >= 1e6 ? `${(m3 / 1e6).toFixed(2)} M m³` : `${fmt(m3)} m³`; }

    function card(idx, compact) {
        const h = grid.hexes[idx], s = stats[idx];
        if (!h) return '';
        const sim = s && s.t > 0;
        const lvl = sim ? s.risk : 0;
        const vid = FloodSim.state.scenario ? FloodSim.state.scenario.villageId : '';
        const gisRows = [
            ['Residents (est.)', fmt(h.population)],
            ['Ground elevation', `${Math.round(h.elevation)} m <span class="dim">(${Math.round(h.zMin)}–${Math.round(h.zMax)})</span>`],
            ['Mean slope', `${h.slope.toFixed(1)}°`],
            ['Height above river', `${h.hand.toFixed(1)} m`],
            ['Nearest river / stream', h.riverKm < 0.05 ? 'runs through cell' : `${h.riverKm.toFixed(1)} km`],
            ['Terrain', h.terrain],
            ...(vid === 'wayanad_meppadi' ? [['Unstable when saturated', `${Math.round(h.unstablePct)} % of area`]] : []),
            ...(compact ? [] : [['Hexagon area', `${h.areaKm2.toFixed(2)} km²`]])
        ];
        const simRows = sim ? [
            ['Water accumulated', fmtVol(s.volume)],
            ['Depth mean / max', `${s.meanDepth.toFixed(2)} / ${s.maxDepth.toFixed(2)} m`],
            ['Area under water', `${Math.round(s.wetFrac * 100)} %`],
            ['People in water > 30 cm', fmt(s.atRisk)]
        ] : null;
        const dl = (rows) => `<dl class="readout">${rows.map(([k, v]) => `<dt>${k}</dt><dd class="mono">${v}</dd>`).join('')}</dl>`;
        const tLabel = sim ? `T+${String(Math.floor(s.t / 3600)).padStart(2, '0')}:${String(Math.floor(s.t % 3600 / 60)).padStart(2, '0')}` : '';
        return `<div class="grid-card">
            <div class="grid-card__head"><span class="mono">${h.id}</span><span class="risk-chip" data-risk="${lvl}">${sim ? `${RISK[lvl]} · ${s.index}` : 'Before storm'}</span></div>
            <div class="grid-card__sec">Terrain &amp; people</div>${dl(gisRows)}
            ${simRows ? `<div class="grid-card__sec">Flood at ${tLabel}</div>${dl(simRows)}` : '<div class="grid-card__note">Play the scenario to see water in this cell.</div>'}
        </div>`;
    }

    function onHover(e) {
        const f = e.features && e.features[0];
        if (!f) return;
        map.getCanvas().style.cursor = 'pointer';
        if (hoverId !== f.id) {
            if (hoverId !== null) map.setFeatureState({ source: 'flood-grid-src', id: hoverId }, { hover: false });
            hoverId = f.id;
            map.setFeatureState({ source: 'flood-grid-src', id: hoverId }, { hover: true });
            if (window.FloodRender) FloodRender.invalidate();
        }
        if (!popup) popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, className: 'grid-popup', maxWidth: '280px', offset: 14 });
        popup.setLngLat(e.lngLat).setHTML(card(hoverId, true)).addTo(map);
    }

    function onLeave() {
        map.getCanvas().style.cursor = '';
        if (hoverId !== null) map.setFeatureState({ source: 'flood-grid-src', id: hoverId }, { hover: false });
        hoverId = null;
        if (window.FloodRender) FloodRender.invalidate();
        if (popup) popup.remove();
    }

    // IDs appear from zoom 10.8 (only moderate+ hexagons) and for all from 12.
    function syncLabels() {
        if (!map || !grid) return;
        const z = map.getZoom();
        if (visible && z >= 10.8 && !labels.length) {
            labels = grid.hexes.map(h => {
                const el = document.createElement('div');
                el.className = 'hex-label';
                el.textContent = h.id.replace(/^[A-Z]+-/, '');
                el.title = h.id;
                return { idx: h.idx, el, marker: new maplibregl.Marker({ element: el }).setLngLat(h.center).addTo(map) };
            });
            refresh(true);
        }
        labels.forEach(l => {
            const r = stats[l.idx] ? stats[l.idx].risk : 0;
            const show = visible && (z >= 12.3 || (z >= 10.8 && r >= 2));
            l.el.style.display = show ? '' : 'none';
        });
    }

    function setVisible(v) {
        visible = v;
        syncLabels();
        ['flood-grid-fill', 'flood-grid-line'].forEach(id => { if (map && map.getLayer(id)) map.setLayoutProperty(id, 'visibility', v ? 'visible' : 'none'); });
        if (map && map.getLayer('flood-grid-3d')) map.setLayoutProperty('flood-grid-3d', 'visibility', v && columns ? 'visible' : 'none');
        if (!v) onLeave();
    }

    global.FloodGrid = {
        RISK, RISK_COLOR,
        init(m) {
            map = m;
            let pending = false;
            FloodSim.on('scenario', () => { grid = null; stats = []; pending = true; });
            const loop = () => {
                if (pending && map.isStyleLoaded() && FloodSim.state.terrain) { pending = false; build(); }
                refresh(false);
                requestAnimationFrame(loop);
            };
            requestAnimationFrame(loop);
        },
        setVisible,
        setColumns(on) {
            columns = on;
            if (map && map.getLayer('flood-grid-3d')) map.setLayoutProperty('flood-grid-3d', 'visibility', visible && on ? 'visible' : 'none');
        },
        get visible() { return visible; },
        /** Hexagon index at a point, or -1. */
        hexAt(lng, lat) {
            if (!grid) return -1;
            const i = FloodSim.state.terrain.toCell(lng, lat);
            return i < 0 ? -1 : grid.cellHex[i];
        },
        card(idx) { compute(); return card(idx, false); },
        hex(idx) { return grid ? grid.hexes[idx] : null; },
        /** Hexagons ranked by risk, then by people in water. */
        ranked(n) {
            if (!grid) return [];
            compute();
            return stats.map((s, idx) => ({ idx, hex: grid.hexes[idx], s }))
                .filter(r => r.s.risk > 0)
                .sort((a, b) => b.s.risk - a.s.risk || b.s.atRisk - a.s.atRisk || b.s.volume - a.s.volume)
                .slice(0, n || 12);
        },
        summary() {
            if (!grid) return null;
            compute();
            const counts = [0, 0, 0, 0, 0];
            stats.forEach(s => counts[s.risk]++);
            return { total: grid.hexes.length, counts, hexArea: grid.hexArea };
        }
    };
})(window);
