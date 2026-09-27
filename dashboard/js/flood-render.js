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

    let SCALE = 3;                 // canvas pixels per model cell (set per grid so the canvas stays ~350k px)
    const PARTICLES = 1400;
    const layerState = { water: true, flow: true, rain: true, slope: true, style: 'natural' };

    let map = null;
    let canvas = null, ctx = null, img = null;
    let noise = null;
    let field = null;              // per-cell interpolated fields for the current time
    let fieldKey = '';
    let particles = [];
    let spawnCells = [];
    let critWet = null;            // per-cell wetness at which FS drops to 1 (Meppadi)
    let markers = [];
    let rainCanvas = null, rainCtx = null, drops = [];
    let lastDraw = 0;
    let lastWater = 0;
    let tiles = [];               // per-map-tile canvas sources the water is copied into
    let pendingScenario = false;

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

    /** Permanent river channels (water at T+0 by design, not flooding). */
    let rivMask = null, rivFor = null;
    function riverMask() {
        const sc = FloodSim.state.scenario;
        if (rivFor === sc && rivMask) return rivMask;
        const N = FloodSim.state.terrain.nx * FloodSim.state.terrain.ny;
        rivMask = new Uint8Array(N);
        if (sc && sc.initialDepth) for (let i = 0; i < N; i++) if (sc.initialDepth[i] > 0) rivMask[i] = 1;
        rivFor = sc;
        return rivMask;
    }

    // ---------------------------------------------------------------- setup
    function ensureLayer() {
        const st = FloodSim.state;
        if (!map || !st.terrain) return;
        const t = st.terrain;
        const [w, s, e, n] = t.bounds;
        SCALE = Math.max(1, Math.min(4, Math.floor(Math.sqrt(350000 / (t.nx * t.ny)))));
        const W = t.nx * SCALE, H = t.ny * SCALE;
        if (!canvas || canvas.width !== W || canvas.height !== H) {
            canvas = canvas || document.createElement('canvas');
            canvas.width = W; canvas.height = H;
            ctx = canvas.getContext('2d');
            img = ctx.createImageData(W, H);
        }
        buildTiles(t);
    }

    // With 3D terrain on, MapLibre pins each image/canvas source to a single
    // map tile and clips whatever falls outside it, so one canvas spanning a
    // district gets cut along tile lines. The water is therefore drawn once
    // into the offscreen domain canvas and copied into one canvas source per
    // web-mercator tile the domain touches, each covering that tile exactly.
    function tileBounds(x, y, z) {
        const n2 = Math.pow(2, z);
        const lon = (xx) => xx / n2 * 360 - 180;
        const lat = (yy) => Math.atan(Math.sinh(Math.PI * (1 - 2 * yy / n2))) * 180 / Math.PI;
        return { w: lon(x), e: lon(x + 1), n: lat(y), s: lat(y + 1) };
    }

    function buildTiles(t) {
        tiles.forEach(tl => {
            if (map.getLayer(tl.layer)) map.removeLayer(tl.layer);
            if (map.getSource(tl.source)) map.removeSource(tl.source);
        });
        tiles = [];
        const [w, s, e, n] = t.bounds;
        const z = Math.max(1, Math.floor(Math.log2(360 / (e - w))) + 1);   // 2-3 tiles across the domain
        const n2 = Math.pow(2, z);
        const tx = (lon) => Math.floor((lon + 180) / 360 * n2);
        const ty = (lat) => Math.floor((1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * n2);
        // water sits above the risk-grid fill (so it is never hidden by it) and below the grid outlines
        const before = ['flood-grid-line', 'village-boundary-layer', 'village-boundary-glow'].find(id => map.getLayer(id));
        const pxPerDegX = canvas.width / (e - w), pxPerDegY = canvas.height / (n - s);
        for (let y = ty(n); y <= ty(s); y++) {
            for (let x = tx(w); x <= tx(e); x++) {
                const b = tileBounds(x, y, z);
                const el = document.createElement('canvas');
                const fw = (b.e - b.w) * pxPerDegX, fh = (b.n - b.s) * pxPerDegY;
                const k = Math.min(1, 1024 / Math.max(fw, fh));
                el.width = Math.max(2, Math.round(fw * k)); el.height = Math.max(2, Math.round(fh * k));
                const id = `flood-sim-${z}-${x}-${y}`;
                map.addSource(id, { type: 'canvas', canvas: el, animate: true, coordinates: [[b.w, b.n], [b.e, b.n], [b.e, b.s], [b.w, b.s]] });
                map.addLayer({ id: id + '-water', type: 'raster', source: id,
                    paint: { 'raster-opacity': 1, 'raster-fade-duration': 0, 'raster-resampling': 'linear' },
                    layout: { visibility: layerState.water ? 'visible' : 'none' } }, before);
                tiles.push({ source: id, layer: id + '-water', el, ctx: el.getContext('2d'), b });
            }
        }
    }

    /** Copy the domain canvas into each tile canvas. */
    function blitTiles() {
        const [w, s, e, n] = FloodSim.state.terrain.bounds;
        const W = canvas.width, H = canvas.height;
        for (const tl of tiles) {
            const { el, b } = tl;
            tl.ctx.clearRect(0, 0, el.width, el.height);
            // domain pixels covered by this tile, and where they land in the tile canvas
            const sx0 = Math.max(0, (b.w - w) / (e - w) * W), sx1 = Math.min(W, (b.e - w) / (e - w) * W);
            const sy0 = Math.max(0, (n - b.n) / (n - s) * H), sy1 = Math.min(H, (n - b.s) / (n - s) * H);
            if (sx1 <= sx0 || sy1 <= sy0) continue;
            const kx = el.width / (b.e - b.w), ky = el.height / (b.n - b.s);
            const dx0 = (w + sx0 / W * (e - w) - b.w) * kx, dx1 = (w + sx1 / W * (e - w) - b.w) * kx;
            const dy0 = (b.n - (n - sy0 / H * (n - s))) * ky, dy1 = (b.n - (n - sy1 / H * (n - s))) * ky;
            tl.ctx.drawImage(canvas, sx0, sy0, sx1 - sx0, sy1 - sy0, dx0, dy0, dx1 - dx0, dy1 - dy0);
        }
    }

    function onScenario() {
        field = null; fieldKey = '';
        particles = []; spawnCells = [];
        ensureLayer();
        ensureArrowLayers();
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
        if (!field || field.d.length !== N) field = { d: new Float32Array(N), raw: new Float32Array(N), show: new Float32Array(N), u: new Float32Array(N), v: new Float32Array(N), c: new Float32Array(N) };
        const a = b.a, ia = 1 - a, f0 = b.f0, f1 = b.f1;
        // What is drawn is what the grid and the figures count: floodwater above
        // the level at T+0. River channels keep their full depth, so the rivers
        // show before the storm; water the spin-up spread onto the land does not.
        const base = st.frames[0].depth, riv = riverMask();
        spawnCells = [];
        for (let i = 0; i < N; i++) {
            const d = (f0.depth[i] * ia + f1.depth[i] * a) / 1000;
            field.raw[i] = d;
            field.show[i] = riv[i] ? d : Math.max(0, d - base[i] / 1000);
            field.u[i] = (f0.u[i] * ia + f1.u[i] * a) / 10;
            field.v[i] = (f0.v[i] * ia + f1.v[i] * a) / 10;
            field.c[i] = (f0.conc[i] * ia + f1.conc[i] * a) / 255;
            if (field.show[i] > 0.1 && field.u[i] * field.u[i] + field.v[i] * field.v[i] > 0.02) spawnCells.push(i);
        }
        // ---- display fields (physics untouched)
        const t = st.terrain, nx = t.nx, ny = t.ny, raw = field.raw, show = field.show, dd = field.d;
        const hilly = t.dx < 150;                                  // Meppadi's fine hill grid
        if (!field.trace || field.trace.length !== N) {
            field.trace = new Float32Array(N); field.shade = new Float32Array(N);
            field.steep = new Float32Array(N); field.thr = new Float32Array(N);
        }
        // terrain steepness: thin runoff sheets on hillsides are not "flood",
        // only water gathered into gullies and streams is drawn there
        if (field.steepFor !== st.runId) {
            field.steepFor = st.runId;
            for (let i = 0; i < N; i++) {
                const sd = Math.max(0, Math.min(1, (t.slope[i] - 6) / 24));
                field.steep[i] = sd * sd * (3 - 2 * sd);
                field.thr[i] = (t.dx < 150 ? 0.1 : 0.25) * field.steep[i];
            }
        }
        const peak = f0.peak;
        const dx = t.dx, dy = t.dy;
        const SUN_X = -0.5, SUN_Y = -0.5, SUN_Z = 0.707;      // light from the north-west, 45° up
        for (let r = 0; r < ny; r++) {
            for (let c = 0; c < nx; c++) {
                const i = r * nx + c;
                let m = 0, sum = 0, n = 0;
                for (let rr = Math.max(0, r - 1); rr <= Math.min(ny - 1, r + 1); rr++) {
                    for (let cc = Math.max(0, c - 1); cc <= Math.min(nx - 1, c + 1); cc++) {
                        const v = show[rr * nx + cc];
                        sum += v; n++;
                        if (v > m) m = v;
                    }
                }
                // blend with the 3x3 mean: isolated puddles fade, connected sheets stay;
                // deep channels widen a little so rivers read at district scale
                let v = 0.35 * show[i] + 0.65 * sum / n;
                if (hilly) {
                    // 100 m hill grid: streams are one or two cells wide, so never
                    // average a wet cell away, and let deeper streams spill a little
                    v = Math.max(v, show[i]);
                    if (m > 0.5) v = Math.max(v, 0.4 * m);
                } else if (m > 1) v = Math.max(v, 0.45 * m);
                dd[i] = Math.max(0, v - field.thr[i]);          // hillside sheet flow drops out
                field.trace[i] = peak ? (riv[i] ? peak[i] : Math.max(0, peak[i] - base[i])) / 1000 : 0;
                // light the water surface (ground + water) with the sun: sheets on
                // slopes and water in shadowed valleys read with the terrain
                const cl = c > 0 ? i - 1 : i, cr = c < nx - 1 ? i + 1 : i;
                const ru = r > 0 ? i - nx : i, rd = r < ny - 1 ? i + nx : i;
                const gx = ((t.z[cr] + raw[cr]) - (t.z[cl] + raw[cl])) / ((cr - cl) * dx || 1);
                const gy = ((t.z[rd] + raw[rd]) - (t.z[ru] + raw[ru])) / (((rd - ru) / nx) * dy || 1);
                const len = Math.sqrt(gx * gx + gy * gy + 1);
                const lam = (-gx * SUN_X - gy * SUN_Y + SUN_Z) / len;   // 0.707 for flat water
                field.shade[i] = Math.max(0.55, Math.min(1.25, lam / 0.707));
            }
        }
    }

    // ---------------------------------------------------------------- water pixels
    // Realistic floodwater seen from above: shallow water is murky and lets the
    // ground show through, deeper water turns slate blue; river, breach and
    // debris water carries silt. Calm water on the plains picks up a soft sky
    // sheen; fast water in steep channels breaks white. Land that flooded and
    // has drained keeps a faint silt stain.
    const WATER_RAMP = [                      // [depth m, r, g, b, alpha]
        [0.05, 112, 128, 118, 0.42],
        [0.3, 86, 114, 118, 0.62],
        [1.0, 54, 88, 110, 0.8],
        [2.5, 30, 60, 88, 0.9],
        [99, 22, 46, 72, 0.93]
    ];
    const SILT = [124, 104, 74];
    const DEPTH_CLASSES = [[0.15, [170, 220, 245]], [0.5, [100, 180, 235]], [1, [45, 130, 215]], [2, [25, 80, 180]], [99, [30, 40, 130]]];

    function rampAt(D) {
        let k = 0;
        while (k < WATER_RAMP.length - 1 && D > WATER_RAMP[k + 1][0]) k++;
        const a = WATER_RAMP[k], b = WATER_RAMP[Math.min(WATER_RAMP.length - 1, k + 1)];
        const f = b === a ? 0 : Math.max(0, Math.min(1, (D - a[0]) / (b[0] - a[0])));
        return [a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, a[3] + (b[3] - a[3]) * f, a[4] + (b[4] - a[4]) * f];
    }

    function drawWater(timeSec) {
        const st = FloodSim.state, t = st.terrain;
        const W = canvas.width, H = canvas.height, nx = t.nx, ny = t.ny;
        const data = img.data;
        data.fill(0);
        if (!field) { ctx.putImageData(img, 0, 0); return; }
        const { d, u, v, c, trace, shade, steep } = field;
        const mask = t.mask;
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
                const inside = mask[(fy < 0.5 ? r0 : r1) * nx + (fx < 0.5 ? c0 : c1)];

                // landslide hatch (independent of water)
                if (wetNow !== null) {
                    const ci = (Math.round(gy) < 0 ? 0 : Math.min(ny - 1, Math.round(gy))) * nx + Math.min(nx - 1, Math.max(0, Math.round(gx)));
                    if (wetNow * st.scenario.rainWeight[ci] >= critWet[ci] && t.slope[ci] >= 26 && ((px + py) % 6) === 0) {
                        data[o] = 235; data[o + 1] = 80; data[o + 2] = 60; data[o + 3] = 150;
                    }
                }
                if (D < 0.1 || (!inside && D < 0.3)) {
                    // drained flood trace: silt and wet ground where water stood
                    if (inside && !depthMode) {
                        const T = trace[i00] * w00 + trace[i01] * w01 + trace[i10] * w10 + trace[i11] * w11;
                        if (T > 0.2 && data[o + 3] === 0) {
                            const a = Math.min(0.3, (T - 0.2) * 0.35) * (1 - D / 0.1);
                            data[o] = SILT[0]; data[o + 1] = SILT[1]; data[o + 2] = SILT[2]; data[o + 3] = a * 255;
                        }
                    }
                    continue;
                }

                const U = u[i00] * w00 + u[i01] * w01 + u[i10] * w10 + u[i11] * w11;
                const V = v[i00] * w00 + v[i01] * w01 + v[i10] * w10 + v[i11] * w11;
                const C = c[i00] * w00 + c[i01] * w01 + c[i10] * w10 + c[i11] * w11;
                const SH = shade[i00] * w00 + shade[i01] * w01 + shade[i10] * w10 + shade[i11] * w11;
                const ST = steep[i00] * w00 + steep[i01] * w01 + steep[i10] * w10 + steep[i11] * w11;
                const speed = Math.sqrt(U * U + V * V);

                // flow-map ripples: two phases of the same noise, advected with the flow
                const ax = (px + drift - U * ph * flowK) & (NZ - 1), ay = (py + drift * 0.6 - V * ph * flowK) & (NZ - 1);
                const bx = (px + 97 + drift - U * ph2 * flowK) & (NZ - 1), by = (py + 41 + drift * 0.6 - V * ph2 * flowK) & (NZ - 1);
                const nz = noise[ay * NZ + ax] * wA + noise[by * NZ + bx] * wB;

                let R, Gc, B, alpha;
                if (depthMode) {
                    let k = 0; while (D > DEPTH_CLASSES[k][0]) k++;
                    [R, Gc, B] = DEPTH_CLASSES[k][1];
                    alpha = 0.85;
                } else {
                    const col = rampAt(D);
                    const m = Math.min(0.7, C * 0.85);             // silt / debris load
                    R = col[0] + (SILT[0] - col[0]) * m;
                    Gc = col[1] + (SILT[1] - col[1]) * m;
                    B = col[2] + (SILT[2] - col[2]) * m;
                    alpha = col[3];
                    // terrain-lit surface
                    R *= SH; Gc *= SH; B *= SH;
                    // calm, deeper water reflects a pale sky, broken up by slow ripples
                    const calm = Math.max(0, 1 - speed / 0.8) * Math.min(1, (D - 0.2) / 0.8) * (1 - ST);
                    if (calm > 0) {
                        const sheen = calm * (0.1 + 0.12 * nz);
                        R += (176 - R) * sheen; Gc += (192 - Gc) * sheen; B += (204 - B) * sheen;
                    }
                }
                // ripple shading, stronger in moving water
                const amp = 0.05 + Math.min(0.22, speed * 0.12);
                const shadeR = 1 + (nz - 0.5) * 2 * amp;
                R *= shadeR; Gc *= shadeR; B *= shadeR;
                // white water: fast flow, especially in steep channels
                // white water only as streaks in the fastest, steepest reaches
                const rough = speed * (0.3 + 1.2 * ST);             // lowland rivers never break white
                const foam = inside && rough > 2.4 ? Math.min(1, (rough - 2.4) * 0.3) * (nz > 0.62 ? 1 : 0.12) : 0;
                const glint = inside && D > 0.5 && nz > 0.84 ? (nz - 0.84) * 1.2 * (1 - ST) : 0;
                const wLift = Math.max(glint * 0.35, foam * 0.5);
                R += (228 - R) * wLift; Gc += (232 - Gc) * wLift; B += (228 - B) * wLift;
                if (foam > 0) alpha = Math.max(alpha, 0.5 + 0.25 * foam);
                // soft shoreline
                const edge = D < 0.2 ? (D - 0.1) / 0.1 : 1;
                alpha *= (0.35 + 0.65 * edge * edge * (3 - 2 * edge)) * (inside ? 1 : 0.3);
                data[o] = R > 255 ? 255 : R; data[o + 1] = Gc > 255 ? 255 : Gc; data[o + 2] = B > 255 ? 255 : B;
                data[o + 3] = Math.max(data[o + 3], alpha * 255);
            }
        }
        ctx.putImageData(img, 0, 0);
    }

    // ---------------------------------------------------------------- flow arrows
    // Crisp arrows on a lattice (a map symbol layer, so they stay sharp at any
    // zoom and lie flat on the 3D terrain). Each shows the depth-weighted mean
    // flow of its block; size and opacity grow with speed. Coarser lattices
    // show when zoomed out, finer ones are added as you zoom in.
    const ARROW_LEVELS = ['flood-flow-arrows-0', 'flood-flow-arrows-1', 'flood-flow-arrows-2'];
    let arrowSteps = null, lastArrows = 0, arrowKey = '';

    function arrowImage() {
        const S = 40, cv = document.createElement('canvas');
        cv.width = cv.height = S;
        const g = cv.getContext('2d');
        const path = () => { g.beginPath(); g.moveTo(20, 35); g.lineTo(20, 15); g.moveTo(11, 19); g.lineTo(20, 6); g.lineTo(29, 19); };
        g.lineCap = 'round'; g.lineJoin = 'round';
        g.strokeStyle = 'rgba(8, 14, 20, 0.85)'; g.lineWidth = 8; path(); g.stroke();
        g.strokeStyle = '#ffffff'; g.lineWidth = 3.6; path(); g.stroke();
        return g.getImageData(0, 0, S, S);
    }

    function ensureArrowLayers() {
        const t = FloodSim.state.terrain;
        if (!map || !t) return;
        const s0 = Math.max(4, Math.round(Math.sqrt(t.nx * t.ny / 1000)));
        arrowSteps = [s0, Math.max(1, Math.round(s0 / 2)), Math.max(1, Math.round(s0 / 4))];
        const [w, , e] = t.bounds;
        const z0 = Math.log2(1200 / ((e - w) / 360 * 512));          // zoom that shows the whole domain
        if (!map.hasImage('flood-flow-arrow')) map.addImage('flood-flow-arrow', arrowImage(), { pixelRatio: 1.1 });
        if (!map.getSource('flood-flow-arrows')) map.addSource('flood-flow-arrows', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
        ARROW_LEVELS.forEach((id, lvl) => {
            if (map.getLayer(id)) map.removeLayer(id);
            map.addLayer({
                id, type: 'symbol', source: 'flood-flow-arrows', filter: ['==', ['get', 'l'], lvl],
                minzoom: lvl ? z0 + 0.8 * lvl + 0.4 : 0,
                layout: {
                    visibility: layerState.flow ? 'visible' : 'none',
                    'icon-image': 'flood-flow-arrow', 'icon-rotate': ['get', 'b'],
                    'icon-rotation-alignment': 'map', 'icon-pitch-alignment': 'viewport',   // point along the flow, stay readable when tilted
                    'icon-allow-overlap': true, 'icon-ignore-placement': true,
                    // zoom must be the outermost input of a layout expression
                    'icon-size': ['interpolate', ['linear'], ['zoom'],
                        z0 - 1.5, ['*', ['get', 'k'], 0.35], z0, ['*', ['get', 'k'], 0.8], z0 + 3, ['*', ['get', 'k'], 1.1]]
                },
                paint: { 'icon-opacity': ['get', 'o'] }
            });
        });
        arrowKey = '';
    }

    function updateArrows(now) {
        if (!layerState.flow || !field || !arrowSteps || !map.getSource('flood-flow-arrows')) return;
        if (arrowKey === fieldKey || now - lastArrows < 250) return;
        arrowKey = fieldKey; lastArrows = now;
        const t = FloodSim.state.terrain, nx = t.nx, ny = t.ny, [s0, s1, s2] = arrowSteps;
        const feats = [];
        const h = Math.max(1, Math.floor(s2 / 2));
        for (let r = h; r < ny; r += s2) {
            for (let c = h; c < nx; c += s2) {
                const i0 = r * nx + c;
                if (!t.mask[i0]) continue;
                // depth-weighted mean flow over the block
                let su = 0, sv = 0, sd = 0, wet = 0, n = 0;
                const b = Math.max(1, Math.ceil(s2 / 2));
                for (let rr = Math.max(0, r - b); rr <= Math.min(ny - 1, r + b); rr++) {
                    for (let cc = Math.max(0, c - b); cc <= Math.min(nx - 1, c + b); cc++) {
                        const i = rr * nx + cc, d = field.d[i];
                        n++;
                        if (d < 0.1) continue;
                        wet++; su += field.u[i] * d; sv += field.v[i] * d; sd += d;
                    }
                }
                if (!sd || wet < 2 || wet / n < 0.2) continue;       // narrow hill streams still count
                const U = su / sd, V = sv / sd, sp = Math.hypot(U, V);
                if (sp < 0.04) continue;                               // still water: no arrow
                const l = (r - h) % s0 === 0 && (c - h) % s0 === 0 ? 0 : ((r - h) % s1 === 0 && (c - h) % s1 === 0 ? 1 : 2);
                const q = Math.min(1, sp / 1.2);
                feats.push({ type: 'Feature', geometry: { type: 'Point', coordinates: t.toLngLat(i0) },
                    properties: { l, b: Math.round(Math.atan2(U, -V) * 180 / Math.PI), k: +(0.55 + 0.45 * q).toFixed(2), o: +(0.6 + 0.4 * Math.min(1, sp / 0.5)).toFixed(2) } });
            }
        }
        map.getSource('flood-flow-arrows').setData({ type: 'FeatureCollection', features: feats });
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
            if (field.d[i] < 0.1 || sp < 0.08 || p.age > p.life) { Object.assign(p, spawn()); continue; }
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
        const target = Math.min(900, Math.round(rate * 14));
        while (drops.length < target) drops.push({ x: Math.random() * W, y: Math.random() * H, s: 900 + Math.random() * 700, l: 10 + Math.random() * 16 });
        if (drops.length > target) drops.length = target;
        rainCtx.fillStyle = `rgba(8,14,22,${Math.min(0.08, rate / 400)})`;
        rainCtx.fillRect(0, 0, W, H);
        const slant = 0.18;
        rainCtx.strokeStyle = 'rgba(200,214,228,0.22)';
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
            markers.push({ marker, el, showFrom, kind });
        };
        const t = FloodSim.state.terrain;
        const sites = sc.breachSites || [];
        if (sc.gauge.cell !== undefined && !sites.some(b => b.cell === sc.gauge.cell)) add(t.toLngLat(sc.gauge.cell), 'Gauge · ' + sc.gauge.name, 'gauge', () => -1);
        // embankment watch points turn into breach markers when the embankment fails
        sites.forEach(b => {
            add(b.lngLat, 'Embankment · ' + b.label, 'gauge', () => -1);
            const m = markers[markers.length - 1];
            m.site = b;
        });
        sc.events.filter(e => e.kind === 'landslide').forEach(e => add(e.lngLat, e.title.replace(' above Punchirimattam', ''), 'landslide', () => e.t));
        sc.inflows.filter(i => !/^River \d+$|^Breach$/.test(i.name)).forEach(i => add(t.toLngLat(i.cells[0]), i.name, 'river', () => -1));
        syncMarkers();
    }

    function syncMarkers() {
        const t = FloodSim.state.t;
        markers.forEach(m => {
            const zoomOk = m.kind !== 'river' || map.getZoom() >= 10.3;
            m.el.style.display = layerState.water && zoomOk && t >= m.showFrom() ? '' : 'none';
            if (m.site) {
                const broken = m.site.t !== null && t >= m.site.t;
                if (broken !== !!m.broken) {
                    m.broken = broken;
                    m.el.className = `sim-marker sim-marker--${broken ? 'breach' : 'gauge'}`;
                    m.el.querySelector('.sim-marker__label').textContent = (broken ? 'Breach · ' : 'Embankment · ') + m.site.label;
                }
            }
        });
    }

    // With 3D terrain, MapLibre renders draped layers (raster, fill, line) into
    // a per-terrain-tile texture and caches it until tiles load or the style
    // changes, so animated canvases and feature-state colours would freeze.
    // freeRtt() is the same invalidation MapLibre runs on style changes.
    function invalidateTerrain() {
        const tr = map && map.terrain;
        if (tr && tr.sourceCache && typeof tr.sourceCache.freeRtt === 'function') {
            tr.sourceCache.freeRtt();
            map.triggerRepaint();
        }
    }

    // ---------------------------------------------------------------- loop
    function frame(now) {
        const dt = lastDraw ? Math.min(0.1, (now - lastDraw) / 1000) : 0.016;
        lastDraw = now;
        const st = FloodSim.state;
        if (pendingScenario && map && map.isStyleLoaded()) { pendingScenario = false; onScenario(); }
        if (map && st.terrain && canvas && tiles.length) {
            // ~20 fps is plenty for the water, and with 3D terrain every redraw
            // means re-rendering the draped terrain textures
            if (layerState.water && now - lastWater >= 50) {
                const wdt = lastWater ? Math.min(0.15, (now - lastWater) / 1000) : 0.05;
                lastWater = now;
                updateField(st.t);
                drawWater(now / 1000);
                drawParticles(wdt);
                blitTiles();
                invalidateTerrain();
                updateArrows(now);
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
            // Attach as soon as the style can take sources; checked every animation frame.
            FloodSim.on('scenario', () => { pendingScenario = true; });
            requestAnimationFrame(frame);
        },
        set(key, value) {
            layerState[key] = value;
            if (key === 'water' && map) tiles.forEach(tl => { if (map.getLayer(tl.layer)) map.setLayoutProperty(tl.layer, 'visibility', value ? 'visible' : 'none'); });
            if (key === 'style' || key === 'slope') fieldKey = '';
            if (key === 'flow' && map) { ARROW_LEVELS.forEach(id => { if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', value ? 'visible' : 'none'); }); arrowKey = ''; }
        },
        get(key) { return layerState[key]; },
        invalidate: invalidateTerrain
    };
})(window);
