/**
 * Jal Drishti - flood simulation rendering
 * ---------------------------------------------------------------------------
 * Draws the simulated water onto the existing map without touching the
 * basemap, terrain or camera:
 *
 *   - Water surface: a MapLibre canvas source draped on the 3D terrain. Each
 *     pixel is bilinearly interpolated in space and between solver frames in
 *     time, coloured by depth and by sediment (clear rain water vs silt-laden
 *     river water vs debris), with soft shorelines and a flow-map ripple
 *     texture that moves with the local velocity, plus white water where the
 *     flow is fast.
 *   - Flow streaks: particles advected by the simulated velocity field.
 *   - Slope failure hatch (Meppadi): cells whose infinite-slope factor of
 *     safety has dropped below 1 at the current rainfall.
 *   - Rain: a screen-space overlay whose density follows the scenario's
 *     rain intensity at the clock time.
 *   - Event markers: breach / landslide / gauge pins on the map.
 */
(function (global) {
    'use strict';

    const SCALE = 3;               // canvas pixels per model cell
    const PARTICLES = 1400;
    const layerState = { water: true, flow: true, rain: true, slope: true, style: 'natural' };

    let map = null;
    let canvas = null, ctx = null, img = null;
    let sourceBounds = null;
    let noise = null;
    let field = null;              // per-cell interpolated fields for the current time
    let fieldKey = '';
    let particles = [];
    let spawnCells = [];
    let critWet = null;            // per-cell wetness at which FS drops to 1 (Meppadi)
    let markers = [];
    let rainCanvas = null, rainCtx = null, drops = [];
    let lastDraw = 0;

    // ---------------------------------------------------------------- noise
    function makeNoise(size) {
        const g = new Float32Array(size * size);
        let s = 12345;
        const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
        const oct = (cell, amp) => {
            const n = size / cell, lat = new Float32Array(n * n);
            for (let i = 0; i < lat.length; i++) lat[i] = rnd();
            for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
                const fx = x / cell, fy = y / cell, x0 = Math.floor(fx), y0 = Math.floor(fy);
                const tx = fx - x0, ty = fy - y0, sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
                const a = lat[(y0 % n) * n + (x0 % n)], b = lat[(y0 % n) * n + ((x0 + 1) % n)];
                const c = lat[((y0 + 1) % n) * n + (x0 % n)], d = lat[((y0 + 1) % n) * n + ((x0 + 1) % n)];
                g[y * size + x] += amp * ((a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy);
            }
        };
        oct(16, 0.55); oct(8, 0.3); oct(4, 0.15);
        return g;
    }

    // ---------------------------------------------------------------- setup
    function ensureLayer() {
        const st = FloodSim.state;
        if (!map || !st.terrain) return;
        const t = st.terrain;
        const [w, s, e, n] = t.bounds;
        const W = t.nx * SCALE, H = t.ny * SCALE;
        if (!canvas || canvas.width !== W || canvas.height !== H) {
            canvas = canvas || document.createElement('canvas');
            canvas.width = W; canvas.height = H;
            ctx = canvas.getContext('2d');
            img = ctx.createImageData(W, H);
        }
        const coords = [[w, n], [e, n], [e, s], [w, s]];
        const key = coords.join();
        if (map.getSource('flood-sim-src')) {
            if (sourceBounds !== key) map.getSource('flood-sim-src').setCoordinates(coords);
        } else {
            map.addSource('flood-sim-src', { type: 'canvas', canvas, coordinates: coords, animate: true });
            const before = ['village-boundary-layer', 'village-boundary-glow'].find(id => map.getLayer(id));
            map.addLayer({
                id: 'flood-sim-water', type: 'raster', source: 'flood-sim-src',
                paint: { 'raster-opacity': 1, 'raster-fade-duration': 0, 'raster-resampling': 'linear' }
            }, before);
        }
        sourceBounds = key;
        map.setLayoutProperty('flood-sim-water', 'visibility', layerState.water ? 'visible' : 'none');
    }

    function onScenario() {
        field = null; fieldKey = '';
        particles = []; spawnCells = [];
        ensureLayer();
        buildSlopeCriticals();
        buildMarkers();
    }

    function buildSlopeCriticals() {
        const st = FloodSim.state, t = st.terrain, sc = st.scenario;
        critWet = null;
        if (!sc || !sc.landslide) return;
        critWet = new Float32Array(t.nx * t.ny).fill(2);
        for (let i = 0; i < critWet.length; i++) {
            if (t.slope[i] < 22) continue;
            if (FloodScenarios.factorOfSafety(t.slope[i], 1) >= 1) continue;
            let lo = 0, hi = 1;                          // bisection: wetness where FS = 1
            for (let k = 0; k < 14; k++) { const mid = (lo + hi) / 2; if (FloodScenarios.factorOfSafety(t.slope[i], mid) < 1) hi = mid; else lo = mid; }
            critWet[i] = hi;
        }
    }

    // ---------------------------------------------------------------- per-cell fields
    function updateField(tSec) {
        const st = FloodSim.state;
        const b = FloodSim.frameBracket(tSec);
        if (!b) { field = null; return; }
        const key = `${st.runId}:${b.f0.k}:${b.f1.k}:${b.a.toFixed(3)}`;
        if (key === fieldKey && field) return;
        fieldKey = key;
        const N = st.terrain.nx * st.terrain.ny;
        if (!field || field.d.length !== N) field = { d: new Float32Array(N), u: new Float32Array(N), v: new Float32Array(N), c: new Float32Array(N) };
        const a = b.a, ia = 1 - a, f0 = b.f0, f1 = b.f1;
        spawnCells = [];
        for (let i = 0; i < N; i++) {
            const d = (f0.depth[i] * ia + f1.depth[i] * a) / 1000;
            field.d[i] = d;
            field.u[i] = (f0.u[i] * ia + f1.u[i] * a) / 10;
            field.v[i] = (f0.v[i] * ia + f1.v[i] * a) / 10;
            field.c[i] = (f0.conc[i] * ia + f1.conc[i] * a) / 255;
            if (d > 0.08 && field.u[i] * field.u[i] + field.v[i] * field.v[i] > 0.02) spawnCells.push(i);
        }
    }

    // ---------------------------------------------------------------- water pixels
    const CLEAR_SHALLOW = [96, 170, 196], CLEAR_DEEP = [16, 58, 96];
    const MUD_SHALLOW = [168, 138, 92], MUD_DEEP = [92, 68, 42];
    const DEPTH_CLASSES = [[0.15, [170, 220, 245]], [0.5, [100, 180, 235]], [1, [45, 130, 215]], [2, [25, 80, 180]], [99, [30, 40, 130]]];

    function drawWater(timeSec) {
        const st = FloodSim.state, t = st.terrain;
        const W = canvas.width, H = canvas.height, nx = t.nx, ny = t.ny;
        const data = img.data;
        data.fill(0);
        if (!field) { ctx.putImageData(img, 0, 0); return; }
        const { d, u, v, c } = field;
        const NZ = 256;
        const period = 3.2, ph = (timeSec / period) % 1, ph2 = (ph + 0.5) % 1;
        const wA = 1 - Math.abs(2 * ph - 1), wB = 1 - wA;
        const flowK = 14;                                   // noise pixels travelled per (m/s) per phase
        const depthMode = layerState.style === 'depth';
        const sc = st.scenario;
        let wetNow = null;
        if (layerState.slope && critWet && sc) {
            const cum = FloodScenarios.seriesValueAt(sc.cumRain, sc.tStart, st.t);
            wetNow = cum / FloodScenarios.SLOPE_MODEL.saturationMm;
        }
        const drift = timeSec * 1.5;

        for (let py = 0; py < H; py++) {
            const gy = (py + 0.5) / SCALE - 0.5;
            let r0 = Math.floor(gy); const fy = gy - r0;
            let r1 = r0 + 1;
            if (r0 < 0) r0 = 0; if (r1 > ny - 1) r1 = ny - 1;
            for (let px = 0; px < W; px++) {
                const gx = (px + 0.5) / SCALE - 0.5;
                let c0 = Math.floor(gx); const fx = gx - c0;
                let c1 = c0 + 1;
                if (c0 < 0) c0 = 0; if (c1 > nx - 1) c1 = nx - 1;
                const i00 = r0 * nx + c0, i01 = r0 * nx + c1, i10 = r1 * nx + c0, i11 = r1 * nx + c1;
                const w00 = (1 - fx) * (1 - fy), w01 = fx * (1 - fy), w10 = (1 - fx) * fy, w11 = fx * fy;
                const D = d[i00] * w00 + d[i01] * w01 + d[i10] * w10 + d[i11] * w11;
                const o = (py * W + px) * 4;

                // landslide hatch (independent of water)
                if (wetNow !== null) {
                    const ci = (Math.round(gy) < 0 ? 0 : Math.min(ny - 1, Math.round(gy))) * nx + Math.min(nx - 1, Math.max(0, Math.round(gx)));
                    if (wetNow * st.scenario.rainWeight[ci] >= critWet[ci] && ((px + py) % 7) < 2) {
                        data[o] = 220; data[o + 1] = 60; data[o + 2] = 50; data[o + 3] = 170;
                    }
                }
                if (D < 0.02) continue;

                const U = u[i00] * w00 + u[i01] * w01 + u[i10] * w10 + u[i11] * w11;
                const V = v[i00] * w00 + v[i01] * w01 + v[i10] * w10 + v[i11] * w11;
                const C = c[i00] * w00 + c[i01] * w01 + c[i10] * w10 + c[i11] * w11;
                const speed = Math.sqrt(U * U + V * V);

                // flow-map ripples: two phases of the same noise, advected with the flow
                const ax = (px + drift - U * ph * flowK) & (NZ - 1), ay = (py + drift * 0.6 - V * ph * flowK) & (NZ - 1);
                const bx = (px + 97 + drift - U * ph2 * flowK) & (NZ - 1), by = (py + 41 + drift * 0.6 - V * ph2 * flowK) & (NZ - 1);
                const nz = noise[ay * NZ + ax] * wA + noise[by * NZ + bx] * wB;

                let R, Gc, B;
                if (depthMode) {
                    let k = 0; while (D > DEPTH_CLASSES[k][0]) k++;
                    [R, Gc, B] = DEPTH_CLASSES[k][1];
                } else {
                    const td = Math.sqrt(Math.min(1, D / 3));
                    const cr = CLEAR_SHALLOW[0] + (CLEAR_DEEP[0] - CLEAR_SHALLOW[0]) * td;
                    const cg = CLEAR_SHALLOW[1] + (CLEAR_DEEP[1] - CLEAR_SHALLOW[1]) * td;
                    const cb = CLEAR_SHALLOW[2] + (CLEAR_DEEP[2] - CLEAR_SHALLOW[2]) * td;
                    const mr = MUD_SHALLOW[0] + (MUD_DEEP[0] - MUD_SHALLOW[0]) * td;
                    const mg = MUD_SHALLOW[1] + (MUD_DEEP[1] - MUD_SHALLOW[1]) * td;
                    const mb = MUD_SHALLOW[2] + (MUD_DEEP[2] - MUD_SHALLOW[2]) * td;
                    const m = Math.min(1, C * 1.25);
                    R = cr + (mr - cr) * m; Gc = cg + (mg - cg) * m; B = cb + (mb - cb) * m;
                }
                // ripple shading, stronger in moving water
                const amp = 0.14 + Math.min(0.35, speed * 0.18);
                let shade = 1 + (nz - 0.5) * 2 * amp;
                R *= shade; Gc *= shade; B *= shade;
                // specular glints and white water
                const glint = nz > 0.72 ? (nz - 0.72) * 3.2 : 0;
                const foam = speed > 1.2 ? Math.min(1, (speed - 1.2) * 0.6) * (nz > 0.52 ? 1 : 0.25) : 0;
                const wLift = Math.max(glint * 0.55, foam * 0.75);
                R += (235 - R) * wLift; Gc += (240 - Gc) * wLift; B += (240 - B) * wLift;
                // soft shoreline: shallow edges fade in, with a faint wet rim
                const edge = D < 0.3 ? (D - 0.02) / 0.28 : 1;
                const alpha = (depthMode ? 0.78 : 0.62 + 0.3 * Math.min(1, D / 1.5)) * edge * edge * (3 - 2 * edge);
                data[o] = R > 255 ? 255 : R; data[o + 1] = Gc > 255 ? 255 : Gc; data[o + 2] = B > 255 ? 255 : B;
                data[o + 3] = Math.max(data[o + 3], alpha * 255);
            }
        }
        ctx.putImageData(img, 0, 0);
    }

    // ---------------------------------------------------------------- particles
    function drawParticles(dtReal) {
        if (!layerState.flow || !field || !spawnCells.length) { particles.length = 0; return; }
        const t = FloodSim.state.terrain, nx = t.nx, ny = t.ny;
        const target = Math.min(PARTICLES, spawnCells.length * 3);
        while (particles.length < target) particles.push(spawn());
        if (particles.length > target) particles.length = target;
        ctx.lineCap = 'round';
        ctx.lineWidth = 1.1;
        for (const p of particles) {
            const c = Math.min(nx - 1, Math.max(0, Math.round(p.x))), r = Math.min(ny - 1, Math.max(0, Math.round(p.y)));
            const i = r * nx + c;
            const U = field.u[i], V = field.v[i], sp = Math.hypot(U, V);
            p.age += dtReal;
            if (field.d[i] < 0.06 || sp < 0.08 || p.age > p.life) { Object.assign(p, spawn()); continue; }
            const k = 1.6 * dtReal;                        // cells per (m/s) per real second
            p.x += U * k * 100 / t.dx; p.y += V * k * 100 / t.dy;
            const len = Math.min(3.5, 0.9 + sp * 0.9);
            const ex = p.x * SCALE + SCALE / 2, ey = p.y * SCALE + SCALE / 2;
            const fade = Math.min(1, p.age / 0.4, (p.life - p.age) / 0.4);
            ctx.strokeStyle = `rgba(235,244,250,${(0.25 + Math.min(0.45, sp * 0.2)) * fade})`;
            ctx.beginPath();
            ctx.moveTo(ex - U / sp * len * SCALE, ey - V / sp * len * SCALE);
            ctx.lineTo(ex, ey);
            ctx.stroke();
        }
    }

    function spawn() {
        const t = FloodSim.state.terrain;
        const i = spawnCells[Math.floor(Math.random() * spawnCells.length)] || 0;
        return { x: (i % t.nx) + Math.random() - 0.5, y: Math.floor(i / t.nx) + Math.random() - 0.5, age: 0, life: 1.5 + Math.random() * 2.5 };
    }

    // ---------------------------------------------------------------- rain overlay
    function ensureRainCanvas() {
        if (rainCanvas) return;
        rainCanvas = document.createElement('canvas');
        rainCanvas.id = 'rainOverlay';
        document.body.appendChild(rainCanvas);
        rainCtx = rainCanvas.getContext('2d');
        const resize = () => { rainCanvas.width = innerWidth; rainCanvas.height = innerHeight; };
        resize();
        addEventListener('resize', resize);
    }

    function drawRain(dtReal) {
        ensureRainCanvas();
        const snap = FloodSim.snapshot();
        const rate = layerState.rain && FloodSim.state.scenario ? snap.rainNow : 0;
        const W = rainCanvas.width, H = rainCanvas.height;
        rainCtx.clearRect(0, 0, W, H);
        if (rate < 0.5) { drops.length = 0; return; }
        const target = Math.min(1600, Math.round(rate * 26));
        while (drops.length < target) drops.push({ x: Math.random() * W, y: Math.random() * H, s: 900 + Math.random() * 700, l: 10 + Math.random() * 16 });
        if (drops.length > target) drops.length = target;
        rainCtx.fillStyle = `rgba(8,14,22,${Math.min(0.22, rate / 180)})`;
        rainCtx.fillRect(0, 0, W, H);
        const slant = 0.18;
        rainCtx.strokeStyle = 'rgba(190,205,220,0.28)';
        rainCtx.lineWidth = 1;
        rainCtx.beginPath();
        for (const p of drops) {
            p.y += p.s * dtReal; p.x += p.s * slant * dtReal;
            if (p.y > H) { p.y = -p.l; p.x = Math.random() * (W + 200) - 200; }
            rainCtx.moveTo(p.x, p.y);
            rainCtx.lineTo(p.x - p.l * slant, p.y - p.l);
        }
        rainCtx.stroke();
    }

    // ---------------------------------------------------------------- markers
    function buildMarkers() {
        markers.forEach(m => m.marker.remove());
        markers = [];
        const sc = FloodSim.state.scenario;
        if (!map || !sc) return;
        const add = (lngLat, label, kind, showFrom) => {
            const el = document.createElement('div');
            el.className = `sim-marker sim-marker--${kind}`;
            el.innerHTML = `<span class="sim-marker__dot"></span><span class="sim-marker__label">${label}</span>`;
            const marker = new maplibregl.Marker({ element: el, anchor: 'left' }).setLngLat(lngLat).addTo(map);
            markers.push({ marker, el, showFrom });
        };
        if (sc.gauge.cell !== undefined) add(FloodSim.state.terrain.toLngLat(sc.gauge.cell), 'Gauge · ' + sc.gauge.name, 'gauge', -1);
        if (sc.breach && sc.breach.t !== null) add(sc.breach.lngLat, 'Embankment breach', 'breach', sc.breach.t);
        else if (sc.breach) add(sc.breach.lngLat, 'Gauge · ' + sc.gauge.name, 'gauge', -1);
        sc.events.filter(e => e.kind === 'landslide').forEach(e => add(e.lngLat, e.title.replace(' above Punchirimattam', ''), 'landslide', e.t));
        sc.inflows.filter(i => i.name !== 'Breach').forEach(i => add(FloodSim.state.terrain.toLngLat(i.cells[0]), i.name, 'river', -1));
        syncMarkers();
    }

    function syncMarkers() {
        const t = FloodSim.state.t;
        markers.forEach(m => { m.el.style.display = layerState.water && t >= m.showFrom ? '' : 'none'; });
    }

    // ---------------------------------------------------------------- loop
    function frame(now) {
        const dt = lastDraw ? Math.min(0.1, (now - lastDraw) / 1000) : 0.016;
        lastDraw = now;
        const st = FloodSim.state;
        if (map && st.terrain && canvas && map.getSource('flood-sim-src')) {
            if (layerState.water) {
                updateField(st.t);
                drawWater(now / 1000);
                drawParticles(dt);
            }
            syncMarkers();
        }
        drawRain(dt);
        requestAnimationFrame(frame);
    }

    global.FloodRender = {
        init(m) {
            map = m;
            noise = makeNoise(256);
            FloodSim.on('scenario', () => { if (map.isStyleLoaded()) onScenario(); else map.once('idle', onScenario); });
            requestAnimationFrame(frame);
        },
        set(key, value) {
            layerState[key] = value;
            if (key === 'water' && map && map.getLayer('flood-sim-water')) map.setLayoutProperty('flood-sim-water', 'visibility', value ? 'visible' : 'none');
            if (key === 'style' || key === 'slope') fieldKey = '';
        },
        get(key) { return layerState[key]; }
    };
})(window);
