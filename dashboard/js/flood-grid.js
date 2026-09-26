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
    let labels = [];              // HTML markers with hexagon IDs, shown when zoomed in
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
            let pop = 0, zsum = 0, wsum = 0;
            h.cells.forEach(i => { pop += st.cellPop[i]; zsum += t.z[i]; wsum += sc.rainWeight[i]; });
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
                if (d > 0.02) { sum += d; n++; sed += f.conc[i]; }
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
        stats.forEach((s, idx) => map.setFeatureState({ source: 'flood-grid-src', id: idx }, { risk: s.risk }));
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
        const lvl = s ? s.risk : 0;
        const rows = s ? [
            ['Water accumulated', fmtVol(s.volume)],
            ['Depth mean / max', `${s.meanDepth.toFixed(2)} / ${s.maxDepth.toFixed(2)} m`],
            ['Area under water', `${Math.round(s.wetFrac * 100)} %`],
            ['Residents (est.)', fmt(h.population)],
            ['People in water > 30 cm', fmt(s.atRisk)],
            ['In deep or fast water', fmt(s.lifeRisk)],
            ['Rain received', `${Math.round(s.rainMm)} mm`],
            ...(compact ? [] : [
                ['Peak flow speed', `${s.maxSpeed.toFixed(1)} m/s`],
                ['Water type', s.meanDepth < 0.02 ? '—' : (s.sediment > 0.6 ? 'Debris / mud' : s.sediment > 0.35 ? 'Silt-laden river water' : 'Rain runoff')],
                ['Mean ground level', `${Math.round(h.elevation)} m`],
                ['Hexagon area', `${h.areaKm2.toFixed(2)} km²`]
            ])
        ] : [['Residents (est.)', fmt(h.population)]];
        return `<div class="grid-card">
            <div class="grid-card__head"><span class="mono">${h.id}</span><span class="risk-chip" data-risk="${lvl}">${RISK[lvl]}${s ? ` · ${s.index}` : ''}</span></div>
            <dl class="readout">${rows.map(([k, v]) => `<dt>${k}</dt><dd class="mono">${v}</dd>`).join('')}</dl></div>`;
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
