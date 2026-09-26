/**
 * Jal Drishti - shallow-water solver for the rain-flood simulation
 * ---------------------------------------------------------------------------
 * Same numerical scheme as the Nagar Naadi storm-water model: the "local
 * inertial" form of the 2D shallow-water equations used by LISFLOOD-FP
 * (Bates, Horritt & Fewtrell 2010; stability treatment after de Almeida et
 * al. 2012), on a regular grid. Per time step, for every cell face:
 *
 *     q <- (q - g*hf*dt*d(eta)/dx) / (1 + g*dt*n^2*|q| / hf^(7/3))
 *     h <- h + dt*(rain - losses) + dt*(inflow - outflow)/dx
 *
 * plus a Froude cap (|q| <= Fr*hf*sqrt(g*hf)) so the scheme stays stable on
 * the steep Western Ghats slopes, a positivity limiter, Horton infiltration,
 * point inflows (river breaches, tributaries), an imposed-stage boundary
 * (backwater) and timed volume releases (landslide debris). A passive
 * tracer carries sediment concentration so debris and silt-laden river water
 * can be told apart from ponded rain on the map.
 *
 * Everything the solver needs arrives in one message; it never touches the
 * DOM, so flood-sim.js runs it in a Web Worker built from this function's
 * source (works from file:// too), or on the main thread as a fallback.
 * Frames (depth, velocity, tracer) are posted back as they are produced so
 * playback can start before the run finishes.
 */
function floodSolverProgram(self) {
    'use strict';

    const G = 9.81;
    const H_MIN = 1e-3;        // faces with less flow depth than this carry no flux
    const CFL = 0.7;
    const MAX_DT = 30;         // s
    const FROUDE_MAX = 1.0;
    let activeRun = 0;

    self.onmessage = (ev) => {
        const msg = ev.data || {};
        if (msg.type === 'run') start(msg);
        if (msg.type === 'cancel') activeRun = -1;
    };

    function seriesAt(series, stepSec, t0, t) {
        // Piecewise-linear lookup in a series sampled every stepSec from t0.
        const x = (t - t0) / stepSec;
        if (x <= 0) return series[0];
        const i = Math.floor(x);
        if (i >= series.length - 1) return series[series.length - 1];
        const a = x - i;
        return series[i] * (1 - a) + series[i + 1] * a;
    }

    function start(p) {
        const runId = p.runId;
        activeRun = runId;

        const nx = p.nx, ny = p.ny, dx = p.dx, dy = p.dy, N = nx * ny;
        const z = p.z, man = p.manning, rainW = p.rainWeight;
        const h = new Float64Array(N);
        const m = new Float64Array(N);          // tracer mass (conc x depth)
        const F = new Float64Array(N);          // cumulative infiltration (m)
        const qx = new Float64Array(ny * (nx + 1));
        const qy = new Float64Array((ny + 1) * nx);
        const scale = new Float64Array(N);
        const infMul = p.infilMul;              // per-cell infiltration multiplier
        const drain = p.drainRate;              // per-cell constant sink (m/s), scaled by drainSeries
        const f0 = p.infil.f0, fc = p.infil.fc, Fk = p.infil.Fk;

        // Open sides let water leave the domain; closed sides (an embankment
        // or a ridge line) hold it in.
        const closed = new Set(p.closedSides || []);
        const isEdge = new Uint8Array(N);
        for (let c = 0; c < nx; c++) {
            if (!closed.has('north')) isEdge[c] = 1;
            if (!closed.has('south')) isEdge[(ny - 1) * nx + c] = 1;
        }
        for (let r = 0; r < ny; r++) {
            if (!closed.has('west')) isEdge[r * nx] = 1;
            if (!closed.has('east')) isEdge[r * nx + nx - 1] = 1;
        }
        const stageCells = p.stage ? p.stage.cells : [];
        for (const i of stageCells) isEdge[i] = 2;

        let initialVol = 0;
        if (p.initialDepth) {
            for (let i = 0; i < N; i++) { h[i] = p.initialDepth[i]; m[i] = h[i] * (p.initialConc || 0); initialVol += h[i]; }
        }

        const pulses = (p.pulses || []).map(pl => ({ ...pl, done: 0 }));
        const tEnd = p.tEnd, frameEvery = p.frameEvery;
        let t = p.tStart;
        let nextFrame = 0;
        let steps = 0;
        let frameIndex = 0;
        const cellArea = dx * dy;
        const vol = { rain: 0, inflow: initialVol * cellArea, loss: 0, boundary: 0 };

        function emitFrame() {
            const depth = new Uint16Array(N);
            const u = new Int8Array(N);
            const v = new Int8Array(N);
            const conc = new Uint8Array(N);
            let wet = 0, maxD = 0, volume = 0;
            for (let r = 0; r < ny; r++) {
                for (let c = 0; c < nx; c++) {
                    const i = r * nx + c;
                    const d = h[i];
                    depth[i] = Math.min(65535, Math.round(d * 1000));
                    if (d > 0.02) {
                        const ux = 0.5 * (qx[r * (nx + 1) + c] + qx[r * (nx + 1) + c + 1]) / Math.max(d, 0.05);
                        const vy = 0.5 * (qy[r * nx + c] + qy[(r + 1) * nx + c]) / Math.max(d, 0.05);
                        u[i] = Math.max(-127, Math.min(127, Math.round(ux * 10)));
                        v[i] = Math.max(-127, Math.min(127, Math.round(vy * 10)));
                        conc[i] = Math.max(0, Math.min(255, Math.round(m[i] / d * 255)));
                    }
                    if (d > 0.1) wet++;
                    if (d > maxD) maxD = d;
                    volume += d;
                }
            }
            self.postMessage({
                type: 'frame', runId, k: frameIndex, t: nextFrame,
                depth, u, v, conc,
                stats: { wetCells: wet, maxDepth: maxD, volume: volume * cellArea, steps }
            }, [depth.buffer, u.buffer, v.buffer, conc.buffer]);
            frameIndex++;
            nextFrame += frameEvery;
        }

        function step(dt) {
            // ---- momentum: x faces (between cell c-1 and c on row r)
            for (let r = 0; r < ny; r++) {
                const row = r * nx, frow = r * (nx + 1);
                for (let c = 1; c < nx; c++) {
                    const a = row + c - 1, b = a + 1, f = frow + c;
                    const za = z[a], zb = z[b];
                    const ea = za + h[a], eb = zb + h[b];
                    const hf = (ea > eb ? ea : eb) - (za > zb ? za : zb);
                    if (hf > H_MIN) {
                        let q = qx[f];
                        const n = 0.5 * (man[a] + man[b]);
                        q = (q - G * hf * dt * (eb - ea) / dx) / (1 + G * dt * n * n * Math.abs(q) / Math.pow(hf, 7 / 3));
                        const qmax = FROUDE_MAX * hf * Math.sqrt(G * hf);
                        qx[f] = q > qmax ? qmax : (q < -qmax ? -qmax : q);
                    } else {
                        qx[f] = 0;
                    }
                }
            }
            // ---- momentum: y faces (between row r-1 and r on column c)
            for (let r = 1; r < ny; r++) {
                const rowA = (r - 1) * nx, rowB = r * nx, frow = r * nx;
                for (let c = 0; c < nx; c++) {
                    const a = rowA + c, b = rowB + c, f = frow + c;
                    const za = z[a], zb = z[b];
                    const ea = za + h[a], eb = zb + h[b];
                    const hf = (ea > eb ? ea : eb) - (za > zb ? za : zb);
                    if (hf > H_MIN) {
                        let q = qy[f];
                        const n = 0.5 * (man[a] + man[b]);
                        q = (q - G * hf * dt * (eb - ea) / dy) / (1 + G * dt * n * n * Math.abs(q) / Math.pow(hf, 7 / 3));
                        const qmax = FROUDE_MAX * hf * Math.sqrt(G * hf);
                        qy[f] = q > qmax ? qmax : (q < -qmax ? -qmax : q);
                    } else {
                        qy[f] = 0;
                    }
                }
            }

            // ---- positivity limiter: a cell can't send out more water than it holds
            for (let r = 0; r < ny; r++) {
                for (let c = 0; c < nx; c++) {
                    const i = r * nx + c;
                    const fl = r * (nx + 1) + c, fr = fl + 1;
                    const fu = r * nx + c, fd = (r + 1) * nx + c;
                    const out = ((qx[fr] > 0 ? qx[fr] : 0) + (qx[fl] < 0 ? -qx[fl] : 0)) * dt / dx
                        + ((qy[fd] > 0 ? qy[fd] : 0) + (qy[fu] < 0 ? -qy[fu] : 0)) * dt / dy;
                    scale[i] = out > h[i] ? h[i] / out : 1;
                }
            }

            // ---- continuity + tracer (upwind concentration)
            for (let r = 0; r < ny; r++) {
                const row = r * nx, frow = r * (nx + 1);
                for (let c = 1; c < nx; c++) {
                    const f = frow + c;
                    let q = qx[f];
                    if (q === 0) continue;
                    const a = row + c - 1, b = a + 1;
                    const src = q > 0 ? a : b;
                    q *= scale[src];
                    qx[f] = q;
                    const dh = q * dt / dx;
                    const cs = h[src] > 1e-9 ? m[src] / h[src] : 0;
                    h[a] -= dh; h[b] += dh;
                    m[a] -= dh * cs; m[b] += dh * cs;
                }
            }
            for (let r = 1; r < ny; r++) {
                const rowA = (r - 1) * nx, rowB = r * nx, frow = r * nx;
                for (let c = 0; c < nx; c++) {
                    const f = frow + c;
                    let q = qy[f];
                    if (q === 0) continue;
                    const a = rowA + c, b = rowB + c;
                    const src = q > 0 ? a : b;
                    q *= scale[src];
                    qy[f] = q;
                    const dh = q * dt / dy;
                    const cs = h[src] > 1e-9 ? m[src] / h[src] : 0;
                    h[a] -= dh; h[b] += dh;
                    m[a] -= dh * cs; m[b] += dh * cs;
                }
            }

            // ---- sources and sinks
            const rain = seriesAt(p.rain, p.seriesStep, p.tStart, t) / 1000 / 3600;   // m/s
            const drainMul = p.drainSeries ? seriesAt(p.drainSeries, p.seriesStep, p.tStart, t) : 1;
            const rainConc = p.rainConc || 0;
            let rainVol = 0, lossVol = 0;
            for (let i = 0; i < N; i++) {
                const add = rain * rainW[i] * dt;
                rainVol += add;
                let hi = h[i] + add;
                let mi = m[i] + add * rainConc;
                if (hi > 0) {
                    const cap = (fc + (f0 - fc) * Math.exp(-F[i] / Fk)) * infMul[i] * dt;
                    const inf = cap < hi ? cap : hi;
                    F[i] += inf;
                    hi -= inf;
                    const dr = Math.min(hi, drain[i] * drainMul * dt);
                    hi -= dr;
                    const lost = inf + dr;
                    lossVol += lost;
                    if (hi > 1e-9) mi *= hi / (hi + lost); else { hi = 0; mi = 0; }
                }
                h[i] = hi > 0 ? hi : 0;
                m[i] = mi > 0 ? mi : 0;
            }
            vol.rain += rainVol * cellArea;
            vol.loss += lossVol * cellArea;

            for (const inf of (p.inflows || [])) {
                const Q = seriesAt(inf.series, p.seriesStep, p.tStart, t);
                if (Q <= 0) continue;
                const dh = Q * dt / cellArea / inf.cells.length;
                for (const i of inf.cells) { h[i] += dh; m[i] += dh * inf.conc; }
                vol.inflow += Q * dt;
            }

            for (const pl of pulses) {
                if (t + dt <= pl.t || pl.done >= 1) continue;
                const dur = pl.duration || 600;
                const frac = Math.min(1 - pl.done, dt / dur);
                pl.done += frac;
                const dh = pl.volume * frac / cellArea / pl.cells.length;
                for (const i of pl.cells) { h[i] += dh; m[i] += dh * pl.conc; }
                vol.inflow += pl.volume * frac;
            }

            // ---- boundaries: imposed stage (backwater) or free outflow
            const stage = p.stage ? seriesAt(p.stage.series, p.seriesStep, p.tStart, t) : null;
            for (let i = 0; i < N; i++) {
                const e = isEdge[i];
                if (!e) continue;
                if (e === 2) {
                    const target = stage - z[i];
                    const nh = target > 0 ? target : 0;
                    vol.boundary += (h[i] - nh) * cellArea;
                    h[i] = nh; m[i] = nh * p.stage.conc;
                } else {
                    vol.boundary += h[i] * cellArea;
                    h[i] = 0; m[i] = 0;
                }
            }
        }

        function stableDt() {
            let hmax = 0.05;
            for (let i = 0; i < N; i++) if (h[i] > hmax) hmax = h[i];
            return Math.min(MAX_DT, CFL * Math.min(dx, dy) / Math.sqrt(G * hmax));
        }

        function chunk() {
            if (activeRun !== runId) return;
            const t0 = Date.now();
            while (t < tEnd && Date.now() - t0 < 40) {
                if (t >= nextFrame - 1e-6 && nextFrame <= tEnd) emitFrame();
                let dt = stableDt();
                if (t < nextFrame && t + dt > nextFrame) dt = nextFrame - t;
                if (t + dt > tEnd) dt = tEnd - t;
                if (dt <= 0) dt = 1e-3;
                step(dt);
                t += dt;
                steps++;
            }
            if (t >= tEnd) {
                if (nextFrame <= tEnd + 1e-6) emitFrame();
                let stored = 0;
                for (let i = 0; i < N; i++) stored += h[i];
                self.postMessage({
                    type: 'done', runId, steps,
                    massBalance: {
                        rain_m3: Math.round(vol.rain), inflow_m3: Math.round(vol.inflow),
                        losses_m3: Math.round(vol.loss), boundary_m3: Math.round(vol.boundary),
                        stored_m3: Math.round(stored * cellArea)
                    }
                });
                return;
            }
            setTimeout(chunk, 0);
        }
        chunk();
    }
}

if (typeof module !== 'undefined' && module.exports) module.exports = floodSolverProgram;
