/**
 * Jal Drishti - synthetic rain-flood scenarios, one per village
 * ---------------------------------------------------------------------------
 * The three villages flood for different physical reasons, so each gets its
 * own scenario on top of its real terrain (dashboard/data/sim/*_terrain.json,
 * baked from SRTM by scripts/build_sim_terrain.py). Only the terrain is real.
 * Rainfall, river flows, breach and slope-failure timings are synthetic,
 * scaled by the storm total the operator sets.
 *
 *   Meppadi (Wayanad)  FLASH FLOOD + DEBRIS FLOW. Orographic monsoon bursts
 *                      over steep Western Ghats slopes. Infinite-slope
 *                      stability (Mohr-Coulomb, pore pressure from
 *                      cumulative rain) decides if and when the slope above
 *                      Punchirimattam fails; the released debris volume is
 *                      routed down the real Punnapuzha valley through
 *                      Mundakkai and Chooralmala.
 *
 *   Darbhanga (Bihar)  EMBANKMENT BREACH + DRAINAGE CONGESTION. Rain upstream
 *                      (Nepal catchment) raises the river; when stage sits
 *                      above Danger Level long enough the embankment breaches
 *                      at Khutwara and a widening breach (broad-crested weir
 *                      flow) spreads water west across the flat plain. Once
 *                      the river is above the city's outfalls the sluices
 *                      close, so local rain can no longer drain.
 *
 *   Dhemaji (Assam)    FLASH TRIBUTARIES + BACKWATER SHEET FLOOD. Rain on the
 *                      Arunachal foothills sends sediment-laden flash surges
 *                      down the north-bank rivers while a slowly rising
 *                      Brahmaputra holds the southern boundary up, so water
 *                      cannot drain and spreads as wide, shallow sheets.
 *
 * All builders return plain data for flood-sim-solver.js plus the scripted
 * events and gauges the dashboard shows.
 */
(function (global) {
    'use strict';

    const HOUR = 3600;
    const SERIES_STEP = 300;            // every input series is sampled every 5 min
    const SIM_END = 24 * HOUR;

    function b64ToTyped(b64, Type) {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return new Type(bytes.buffer);
    }

    /** Decode the baked terrain JSON into typed arrays and helpers. */
    function decodeTerrain(doc) {
        const { nx, ny } = doc;
        const zq = b64ToTyped(doc.z_u16_b64, Uint16Array);
        const accq = b64ToTyped(doc.acc_u8_b64, Uint8Array);
        const z = new Float32Array(nx * ny);
        const acc = new Float32Array(nx * ny);
        for (let i = 0; i < nx * ny; i++) {
            z[i] = doc.z_min + zq[i] * doc.z_scale;
            acc[i] = Math.pow(2, accq[i] / 12);
        }
        const mask = doc.mask_u8_b64 ? b64ToTyped(doc.mask_u8_b64, Uint8Array) : new Uint8Array(nx * ny).fill(1);
        const [w, s, e, n] = doc.bounds;
        const t = {
            id: doc.village_id, nx, ny, dx: doc.dx_m, dy: doc.dy_m, bounds: doc.bounds, z, acc, mask,
            cellKm2: doc.dx_m * doc.dy_m / 1e6,
            toCell(lng, lat) {
                const c = Math.floor((lng - w) / (e - w) * nx);
                const r = Math.floor((n - lat) / (n - s) * ny);
                if (c < 0 || c >= nx || r < 0 || r >= ny) return -1;
                return r * nx + c;
            },
            toLngLat(i) {
                const r = Math.floor(i / nx), c = i % nx;
                return [w + (c + 0.5) / nx * (e - w), n - (r + 0.5) / ny * (n - s)];
            }
        };
        // slope (degrees) from central differences
        t.slope = new Float32Array(nx * ny);
        for (let r = 0; r < ny; r++) {
            for (let c = 0; c < nx; c++) {
                const i = r * nx + c;
                const zl = z[r * nx + Math.max(0, c - 1)], zr = z[r * nx + Math.min(nx - 1, c + 1)];
                const zu = z[Math.max(0, r - 1) * nx + c], zd = z[Math.min(ny - 1, r + 1) * nx + c];
                const gx = (zr - zl) / (2 * t.dx), gy = (zd - zu) / (2 * t.dy);
                t.slope[i] = Math.atan(Math.hypot(gx, gy)) * 180 / Math.PI;
            }
        }
        return t;
    }

    // Smooth deterministic value noise so rain cells aren't perfectly uniform.
    function valueNoise(nx, ny, cell, seed) {
        const gw = Math.ceil(nx / cell) + 2, gh = Math.ceil(ny / cell) + 2;
        const g = new Float32Array(gw * gh);
        let s = seed >>> 0;
        for (let i = 0; i < g.length; i++) { s = (s * 1664525 + 1013904223) >>> 0; g[i] = s / 4294967296; }
        const out = new Float32Array(nx * ny);
        for (let r = 0; r < ny; r++) {
            for (let c = 0; c < nx; c++) {
                const x = c / cell, y = r / cell, x0 = Math.floor(x), y0 = Math.floor(y);
                const fx = x - x0, fy = y - y0;
                const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
                const v00 = g[y0 * gw + x0], v10 = g[y0 * gw + x0 + 1], v01 = g[(y0 + 1) * gw + x0], v11 = g[(y0 + 1) * gw + x0 + 1];
                out[r * nx + c] = (v00 * (1 - sx) + v10 * sx) * (1 - sy) + (v01 * (1 - sx) + v11 * sx) * sy;
            }
        }
        return out;
    }

    function smoothstep(a, b, x) {
        const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
        return t * t * (3 - 2 * t);
    }

    /**
     * Rain intensity series (mm/h, every 5 min from tStart to SIM_END) made of
     * Gaussian bursts on a steady monsoon base, scaled so the 0-24 h total
     * equals `totalMm`.
     */
    function hyetograph(tStart, totalMm, base, bursts) {
        const n = Math.round((SIM_END - tStart) / SERIES_STEP) + 1;
        const s = new Float32Array(n);
        let sum = 0;
        for (let k = 0; k < n; k++) {
            const th = (tStart + k * SERIES_STEP) / HOUR;
            // steady monsoon rain all day (gently varying), with heavier bursts on top
            let v = th >= -1 ? base * (1 + 0.25 * Math.sin(th * 2 * Math.PI / 5.3) + 0.12 * Math.sin(th * 2 * Math.PI / 2.1 + 1)) : 0;
            for (const b of bursts) v += b.w * Math.exp(-0.5 * Math.pow((th - b.t) / b.sd, 2));
            s[k] = v;
            if (th >= 0 && th < 24) sum += v * SERIES_STEP / HOUR;
        }
        const f = sum > 0 ? totalMm / sum : 0;
        for (let k = 0; k < n; k++) s[k] *= f;
        return s;
    }

    function seriesLen(tStart) { return Math.round((SIM_END - tStart) / SERIES_STEP) + 1; }
    function seriesTime(tStart, k) { return tStart + k * SERIES_STEP; }

    function cumulative(series, tStart) {
        const out = new Float32Array(series.length);
        let acc = 0;
        for (let k = 0; k < series.length; k++) {
            if (seriesTime(tStart, k) >= 0) acc += series[k] * SERIES_STEP / HOUR;
            out[k] = acc;
        }
        return out;
    }

    /** Snap a point to the strongest drainage line within `radiusM`. */
    function snapToChannel(t, lng, lat, radiusM) {
        const i0 = t.toCell(lng, lat);
        if (i0 < 0) return -1;
        const r0 = Math.floor(i0 / t.nx), c0 = i0 % t.nx;
        const rr = Math.ceil(radiusM / t.dy), rc = Math.ceil(radiusM / t.dx);
        let best = i0, bestAcc = -1;
        for (let r = Math.max(0, r0 - rr); r <= Math.min(t.ny - 1, r0 + rr); r++) {
            for (let c = Math.max(0, c0 - rc); c <= Math.min(t.nx - 1, c0 + rc); c++) {
                const i = r * t.nx + c;
                if (t.acc[i] > bestAcc) { bestAcc = t.acc[i]; best = i; }
            }
        }
        return best;
    }

    function neighbours(t, i, radius) {
        const r0 = Math.floor(i / t.nx), c0 = i % t.nx, out = [];
        for (let r = r0 - radius; r <= r0 + radius; r++) {
            for (let c = c0 - radius; c <= c0 + radius; c++) {
                if (r > 0 && r < t.ny - 1 && c > 0 && c < t.nx - 1) out.push(r * t.nx + c);
            }
        }
        return out;
    }

    /** Steepest cell inside a lon/lat box, above minZ. */
    function steepestInBox(t, box, minZ) {
        let best = -1;
        for (let i = 0; i < t.nx * t.ny; i++) {
            const [lng, lat] = t.toLngLat(i);
            if (lng < box[0] || lng > box[2] || lat < box[1] || lat > box[3] || t.z[i] < minZ) continue;
            if (best < 0 || t.slope[i] > t.slope[best]) best = i;
        }
        return best < 0 ? t.toCell((box[0] + box[2]) / 2, (box[1] + box[3]) / 2) : best;
    }

    /**
     * River flow (m3/s) responding to rain through a triangular unit
     * hydrograph: Q = baseFlow + gain x (UH-weighted rain intensity, mm/h).
     */
    function riverResponse(rain, lagH, baseH, gain, baseFlow) {
        const uh = [];
        let uhSum = 0;
        const tb = lagH + baseH;
        for (let k = 0; k * SERIES_STEP / HOUR <= tb; k++) {
            const th = k * SERIES_STEP / HOUR;
            const v = th <= lagH ? th / lagH : Math.max(0, (tb - th) / baseH);
            uh.push(v); uhSum += v;
        }
        const out = new Float32Array(rain.length);
        for (let k = 0; k < rain.length; k++) {
            let q = 0;
            for (let j = 0; j < uh.length && j <= k; j++) q += rain[k - j] * uh[j];
            out[k] = baseFlow + gain * q / uhSum;
        }
        return out;
    }

    function fmtClock(startHour, tSec) {
        const mins = Math.round(startHour * 60 + tSec / 60);
        const d = Math.floor(mins / 1440);
        const hh = Math.floor((mins % 1440) / 60), mm = mins % 60;
        return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}${d ? ' +' + d + 'd' : ''}`;
    }

    // ------------------------------------------------------------------
    // Common per-cell fields
    // ------------------------------------------------------------------
    function baseFields(t, opts) {
        const N = t.nx * t.ny;
        const manning = new Float32Array(N);
        const infilMul = new Float32Array(N);
        const drainRate = new Float32Array(N);
        const chanCells = opts.channelKm2 / t.cellKm2;
        for (let i = 0; i < N; i++) {
            const chan = smoothstep(chanCells * 0.5, chanCells * 2, t.acc[i]);
            // Terrain-dependent land surface: steep (forested / plantation)
            // hillsides are rough and slow runoff down; their soils are thin and
            // fill quickly, while valley floors and plains soak in more.
            const steep = smoothstep(8, 32, t.slope[i]);
            const nLand = opts.nLand + 0.05 * steep;
            manning[i] = nLand * (1 - chan) + opts.nChannel * chan;
            infilMul[i] = (1 - 0.7 * chan) * (1 - 0.45 * steep);
        }
        for (const u of (opts.urban || [])) {
            for (let i = 0; i < N; i++) {
                const [lng, lat] = t.toLngLat(i);
                const dKm = Math.hypot((lng - u.lng) * 111 * Math.cos(lat * Math.PI / 180), (lat - u.lat) * 111);
                const w = Math.exp(-0.5 * Math.pow(dKm / u.radiusKm, 2));
                if (w < 0.05) continue;
                manning[i] = manning[i] * (1 - w) + 0.09 * w;       // buildings obstruct flow
                infilMul[i] = Math.min(infilMul[i], 1 - 0.8 * w);  // sealed surfaces
                drainRate[i] = Math.max(drainRate[i], u.drainMmH / 1000 / HOUR * w);
            }
        }
        return { manning, infilMul, drainRate };
    }

    // ------------------------------------------------------------------
    // Meppadi: flash flood + debris flow
    // ------------------------------------------------------------------
    const SLOPE_MODEL = { cohesionKPa: 9, phiDeg: 34, soilDepthM: 2.5, gammaSoil: 19, gammaW: 9.81, saturationMm: 170 };

    /** Factor of safety of an infinite slope for a given wetness (0-1). */
    function factorOfSafety(slopeDeg, wetness) {
        const b = slopeDeg * Math.PI / 180;
        if (b < 0.05) return 99;
        const S = SLOPE_MODEL, zs = S.soilDepthM;
        const normal = (S.gammaSoil - wetness * S.gammaW) * zs * Math.cos(b) * Math.cos(b);
        return (S.cohesionKPa + normal * Math.tan(S.phiDeg * Math.PI / 180)) / (S.gammaSoil * zs * Math.sin(b) * Math.cos(b));
    }

    function buildMeppadi(t, stormMm) {
        const tStart = -1 * HOUR;
        const rain = hyetograph(tStart, stormMm, 1.1, [
            { t: 2.5, sd: 1.0, w: 0.9 }, { t: 6.5, sd: 1.3, w: 2.0 }, { t: 7.8, sd: 0.6, w: 1.4 },
            { t: 13, sd: 1.5, w: 1.0 }, { t: 18.5, sd: 1.4, w: 0.9 }
        ]);
        const N = t.nx * t.ny;
        let zlo = Infinity, zhi = -Infinity;
        for (let i = 0; i < N; i++) { if (t.z[i] < zlo) zlo = t.z[i]; if (t.z[i] > zhi) zhi = t.z[i]; }
        const noise = valueNoise(t.nx, t.ny, 22, 7);
        const rainWeight = new Float32Array(N);
        for (let i = 0; i < N; i++) {
            const oro = 0.65 + 0.9 * (t.z[i] - zlo) / (zhi - zlo);   // orographic lift on the Ghats
            rainWeight[i] = oro * (0.8 + 0.4 * noise[i]);
        }
        const f = baseFields(t, { nLand: 0.07, nChannel: 0.04, channelKm2: 1.5,
            urban: [{ lng: 76.1320, lat: 11.5529, radiusKm: 0.6, drainMmH: 8 }] });

        // Landslide source: the steepest hillside in the valley head above
        // Punchirimattam (the 2024 initiation zone, 1,150 m+).
        const mundakkai = snapToChannel(t, 76.1557, 11.4865, 350);
        const chooralmala = snapToChannel(t, 76.1599, 11.4992, 350);
        const source = steepestInBox(t, [76.140, 11.464, 76.165, 11.478], 1150);
        const sourceSlope = t.slope[source];
        const cum = cumulative(rain, tStart);
        const w = rainWeight[source];
        let tFail = null, fsAtPeak = 99;
        for (let k = 0; k < cum.length; k++) {
            const wet = Math.min(1, cum[k] * w / SLOPE_MODEL.saturationMm);
            const fs = factorOfSafety(sourceSlope, wet);
            fsAtPeak = Math.min(fsAtPeak, fs);
            if (fs < 1 && tFail === null && seriesTime(tStart, k) >= 0) tFail = seriesTime(tStart, k) + 20 * 60;
        }
        const pulses = [];
        const events = [];
        const [sLng, sLat] = t.toLngLat(source);
        if (tFail !== null && tFail < SIM_END - HOUR) {
            const volume = Math.min(2.6e6, 0.5e6 + stormMm * 7000);
            pulses.push({ t: tFail, duration: 900, volume, conc: 1, cells: neighbours(t, source, 2) });
            events.push({ t: tFail, level: 'red', kind: 'landslide', lngLat: [sLng, sLat],
                title: 'Slope failure above Punchirimattam',
                detail: `Factor of safety fell below 1.0 on a ${Math.round(sourceSlope)}° slope. ~${(volume / 1e6).toFixed(1)} M m³ of debris entering the Punnapuzha.` });
            // second, smaller failure on an adjacent slope if the storm is extreme
            if (stormMm >= 260) {
                const s2 = steepestInBox(t, [76.125, 11.466, 76.140, 11.480], 1150);
                if (s2 !== source) {
                    pulses.push({ t: tFail + 50 * 60, duration: 600, volume: volume * 0.35, conc: 1, cells: neighbours(t, s2, 1) });
                    events.push({ t: tFail + 50 * 60, level: 'red', kind: 'landslide', lngLat: t.toLngLat(s2),
                        title: 'Secondary slope failure', detail: 'Retrogressive failure on the adjoining spur; second debris pulse.' });
                }
            }
        } else {
            events.push({ t: 12 * HOUR, level: 'info', kind: 'note', lngLat: [sLng, sLat],
                title: 'Slopes holding above Punchirimattam',
                detail: `Minimum factor of safety ${fsAtPeak.toFixed(2)} at the valley head. Debris flow not expected at this rainfall.` });
        }

        return {
            flood_type: 'Flash flood · debris flow',
            summary: 'Orographic monsoon bursts on the Western Ghats. Slope stability (infinite-slope model) decides whether the valley head above Punchirimattam fails; debris is routed down the Punnapuzha through Mundakkai and Chooralmala.',
            startHour: 20,
            tStart, z: t.z, rain, rainWeight, rainConc: 0.12,
            infil: { f0: 16 / 1000 / HOUR, fc: 3.5 / 1000 / HOUR, Fk: 0.035 },
            ...f, inflows: [], pulses, stage: null,
            gauge: {
                name: 'Punnapuzha at Chooralmala', cell: chooralmala, kind: 'depth', unit: 'm depth',
                thresholds: [{ v: 1.5, label: 'Warning', level: 'yellow' }, { v: 3.0, label: 'Bridge deck', level: 'red' }]
            },
            watchPoints: [
                { name: 'Mundakkai', cell: mundakkai, lngLat: [76.1557, 11.4865] },
                { name: 'Chooralmala', cell: chooralmala, lngLat: [76.1599, 11.4992] }
            ],
            landslide: { source, slopeDeg: sourceSlope },
            events
        };
    }

    // ------------------------------------------------------------------
    // River network helpers (plains)
    // ------------------------------------------------------------------
    /**
     * Rivers entering the domain: edge cells that are local maxima of drainage
     * area and whose largest inward neighbour carries more (i.e. flow runs in).
     */
    function findEntries(t, sides, minKm2, count, minSepCells) {
        const cand = [];
        const edge = [];
        if (sides.includes('north')) for (let c = 1; c < t.nx - 1; c++) edge.push([1, c, 1, 0]);
        if (sides.includes('south')) for (let c = 1; c < t.nx - 1; c++) edge.push([t.ny - 2, c, -1, 0]);
        if (sides.includes('west')) for (let r = 1; r < t.ny - 1; r++) edge.push([r, 1, 0, 1]);
        if (sides.includes('east')) for (let r = 1; r < t.ny - 1; r++) edge.push([r, t.nx - 2, 0, -1]);
        for (const [r, c, dr, dc] of edge) {
            const i = r * t.nx + c;
            if (t.acc[i] * t.cellKm2 < minKm2) continue;
            let inward = 0;
            for (let k = -1; k <= 1; k++) {
                const rr = r + dr + (dc ? k : 0), cc = c + dc + (dr ? k : 0);
                if (rr >= 0 && rr < t.ny && cc >= 0 && cc < t.nx) inward = Math.max(inward, t.acc[rr * t.nx + cc]);
            }
            if (inward >= t.acc[i]) cand.push(i);       // >= : stored drainage areas are quantised
        }
        cand.sort((a, b) => t.acc[b] - t.acc[a]);
        const out = [];
        for (const i of cand) {
            const r = Math.floor(i / t.nx), c = i % t.nx;
            if (out.every(j => Math.hypot(Math.floor(j / t.nx) - r, (j % t.nx) - c) > minSepCells)) out.push(i);
            if (out.length === count) break;
        }
        return out;
    }

    /** Follow drainage downstream (always to the neighbour with the most flow). */
    function traceDownstream(t, start) {
        const path = [start];
        const seen = new Set(path);
        let i = start;
        for (let guard = 0; guard < 4000; guard++) {
            const r = Math.floor(i / t.nx), c = i % t.nx;
            // stored drainage areas are quantised, so accept ties and break them by elevation
            let next = -1, best = t.acc[i] * 0.999, bestZ = Infinity;
            for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
                if (!dr && !dc) continue;
                const rr = r + dr, cc = c + dc;
                if (rr < 0 || rr >= t.ny || cc < 0 || cc >= t.nx) continue;
                const j = rr * t.nx + cc;
                if (seen.has(j) || t.acc[j] < best) continue;
                if (t.acc[j] > best * 1.001 || t.z[j] < bestZ) { best = t.acc[j]; bestZ = t.z[j]; next = j; }
            }
            if (next < 0) break;
            path.push(next); seen.add(next); i = next;
            if (r === 0 || c === 0 || r === t.ny - 1 || c === t.nx - 1) break;
        }
        return path;
    }

    function distKm(a, b) {
        return Math.hypot((a[0] - b[0]) * 111 * Math.cos(a[1] * Math.PI / 180), (a[1] - b[1]) * 111);
    }

    /** Named places from the dashboard's settlement list (enhanced.js), if loaded. */
    function places(villageId) {
        try {
            if (typeof VILLAGE_POP_CONFIGS !== 'undefined' && VILLAGE_POP_CONFIGS[villageId]) {
                return VILLAGE_POP_CONFIGS[villageId].clusters.filter(c => !/Scattered|Urban Core|Campus|Complex|Colony$/.test(c.name));
            }
        } catch (e) { /* not loaded */ }
        return [];
    }

    function nearestPlace(villageId, lngLat) {
        let best = null, bd = Infinity;
        places(villageId).forEach(p => { const d = distKm(lngLat, [p.lng, p.lat]); if (d < bd) { bd = d; best = p; } });
        return best ? { name: best.name, km: bd } : null;
    }

    function placeLabel(villageId, lngLat) {
        const p = nearestPlace(villageId, lngLat);
        return p ? (p.km < 3 ? p.name : `${Math.round(p.km)} km from ${p.name}`) : `${lngLat[1].toFixed(3)}°N ${lngLat[0].toFixed(3)}°E`;
    }

    // ------------------------------------------------------------------
    // Darbhanga: embanked rivers, breach, drainage congestion
    // ------------------------------------------------------------------
    function buildDarbhanga(t, stormMm) {
        const vid = 'darbhanga';
        const tStart = -6 * HOUR;               // spin-up so the rivers are flowing at T+0
        const N = t.nx * t.ny;
        const z = Float32Array.from(t.z);
        // Local rain is a fraction of the catchment storm (the flood wave is born upstream in Nepal).
        const rain = hyetograph(tStart, stormMm * 0.85, 1.1, [
            { t: 2, sd: 1.5, w: 1.0 }, { t: 7, sd: 2, w: 1.3 }, { t: 13, sd: 1.2, w: 0.9 }, { t: 19, sd: 1.5, w: 0.7 }
        ]);
        const catchRain = hyetograph(tStart, stormMm, 0.9, [{ t: -1, sd: 2, w: 1.4 }, { t: 5, sd: 2.5, w: 1.2 }, { t: 14, sd: 3, w: 0.8 }]);
        const noise = valueNoise(t.nx, t.ny, 28, 11);
        const rainWeight = new Float32Array(N);
        for (let i = 0; i < N; i++) rainWeight[i] = 0.8 + 0.4 * noise[i];
        const urban = [
            { lng: 85.8995, lat: 26.1570, radiusKm: 2.0, drainMmH: 14 },
            { lng: 85.8976, lat: 26.1188, radiusKm: 1.3, drainMmH: 12 }
        ];
        const f = baseFields(t, { nLand: 0.05, nChannel: 0.033, channelKm2: 400, urban });

        // Rivers from the Nepal side enter along the north and west edges.
        const entries = findEntries(t, ['north', 'west'], 250, 4, 12);
        const rivers = entries.map(e => ({ entry: e, path: traceDownstream(t, e), km2: t.acc[e] * t.cellKm2 }));
        // Water moves through cell faces, so diagonal steps get a connecting
        // cell (the lower of the two) or the embankments would dam the channel.
        rivers.forEach(rv => {
            const full = [];
            rv.path.forEach((i, k) => {
                if (k) {
                    const a = rv.path[k - 1];
                    const ra = Math.floor(a / t.nx), ca = a % t.nx, rb = Math.floor(i / t.nx), cb = i % t.nx;
                    if (ra !== rb && ca !== cb) {
                        const j1 = ra * t.nx + cb, j2 = rb * t.nx + ca;
                        full.push(t.z[j1] <= t.z[j2] ? j1 : j2);
                    }
                }
                full.push(i);
            });
            rv.path = full;
        });
        const onPath = new Uint8Array(N);
        rivers.forEach(rv => rv.path.forEach(i => { onPath[i] = 1; }));

        // Carve a channel and build embankments on both banks of every river.
        const bank = new Float32Array(N);
        const levee = new Uint8Array(N);
        const LEVEE_H = 3.6, CARVE = 2.0;
        rivers.forEach(rv => rv.path.forEach(i => {
            const r = Math.floor(i / t.nx), c = i % t.nx;
            for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
                const rr = r + dr, cc = c + dc;
                if (rr < 0 || rr >= t.ny || cc < 0 || cc >= t.nx) continue;
                const j = rr * t.nx + cc;
                if (!onPath[j]) { levee[j] = 1; bank[j] = t.z[j]; }
            }
        }));
        for (let i = 0; i < N; i++) {
            if (onPath[i]) { z[i] = t.z[i] - CARVE; f.manning[i] = 0.03; f.infilMul[i] = 0.2; }
            else if (levee[i]) z[i] = t.z[i] + LEVEE_H;
        }

        const n = seriesLen(tStart);
        const inflows = rivers.map((rv, k) => {
            const areaKm2 = rv.km2 * 6;                         // the catchment continues far into Nepal
            const base = 40 + areaKm2 * 0.012;
            const series = riverResponse(catchRain, 5 + k * 0.5, 14, areaKm2 * 0.09, base);
            return { name: `River ${k + 1}`, cells: [rv.entry], series, conc: 0.6, areaKm2 };
        });

        // Breach sites: on the river passing closest to Darbhanga town, the reach
        // nearest the town (town-side bank); on every other river crossing the
        // district, the weakest (lowest) bank in the middle of its reach.
        const town = [85.8995, 26.1570];
        const sites = [];
        rivers.forEach((rv, k) => {
            const inside = rv.path.filter((i, pos) => t.mask[i] && pos > 4 && pos < rv.path.length - 4);
            if (inside.length < 15) return;
            let near = null;
            inside.forEach(i => { const d = distKm(t.toLngLat(i), town); if (d > 3 && (!near || d < near.d)) near = { d, i }; });
            sites.push({ k, i: near.i, dTown: near.d, inside });
        });
        sites.sort((a, b) => a.dTown - b.dTown);
        sites.forEach((st, n) => {
            if (n === 0) return;                                             // town site already chosen
            const mid = st.inside.slice(Math.floor(st.inside.length * 0.3), Math.ceil(st.inside.length * 0.7));
            st.i = mid.reduce((a, j) => t.z[j] < t.z[a] ? j : a, mid[0]);
        });
        const breaches = [], events = [];
        events.dynamic = {};
        let gauge = null, breachInfo = null;
        const breachSites = [];
        sites.forEach((st, n) => {
            const w = st.i, wr = Math.floor(w / t.nx), wc = w % t.nx;
            const tl = t.toLngLat(w);
            const target = n === 0 ? town : null;
            const cells = [], lowerTo = [];
            // town-side bank for the town site; for the others the lower bank
            let side = null;
            if (!target) {
                let sa = 0, sb = 0;
                for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) {
                    const j = (wr + dr) * t.nx + (wc + dc);
                    if (!levee[j]) continue;
                    if (dr + dc >= 0) sa += t.z[j]; else sb += t.z[j];
                }
                side = sa <= sb ? 1 : -1;
            }
            for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) {
                const j = (wr + dr) * t.nx + (wc + dc);
                if (!levee[j]) continue;
                if (target && dc * (town[0] - tl[0]) + dr * (tl[1] - town[1]) < 0) continue;
                if (side && (dr + dc) * side < 0) continue;
                cells.push(j); lowerTo.push(t.z[j] - 0.3);
            }
            if (!cells.length) return;
            let bk = 0; cells.forEach(j => { bk += bank[j]; }); bk /= cells.length;
            const WL = bk + 0.6, DL = bk + 1.3, HFL = bk + 2.4;
            const label = placeLabel(vid, tl);
            const id = 'breach' + n;
            breaches.push({ id, watch: w, cells, lowerTo, trigger: DL + 0.2, sustain: HOUR });
            breachSites.push({ id, cell: w, lngLat: tl, t: null, label });
            events.dynamic[id] = { level: 'red', kind: 'breach', lngLat: tl, title: `Embankment breach near ${label}`,
                detail: n === 0 ? 'Town-side embankment failed after an hour above Danger Level. Floodwater heading for Darbhanga town.'
                    : 'Embankment failed after an hour above Danger Level. Floodwater spreading over the countryside.' };
            if (n === 0) {
                breachInfo = breachSites[0];
                gauge = {
                    name: `River stage near ${label.replace(/^\d+ km from /, '')}`, kind: 'stage', cell: w, unit: 'm stage',
                    thresholds: [{ v: WL, label: 'Warning', level: 'yellow' }, { v: DL, label: 'Danger', level: 'orange' }, { v: HFL, label: 'HFL', level: 'red' }]
                };
            }
        });
        const watchPoints = breachSites.map(b => ({ name: b.label, cell: b.cell, lngLat: b.lngLat }));

        const initialDepth = new Float32Array(N);
        for (let i = 0; i < N; i++) if (onPath[i]) initialDepth[i] = 2.0;

        const drainSeries = new Float32Array(n).fill(1);
        for (let k = 0; k < n; k++) if (seriesTime(tStart, k) > 6 * HOUR) drainSeries[k] = 0.2;   // sluices shut as rivers rise
        events.push({ t: 6 * HOUR, level: 'yellow', kind: 'note', lngLat: town, title: 'Sluice gates closed at town outfalls', detail: 'Rivers above outfall level: local rain can no longer drain out of the embanked basins.' });

        return {
            flood_type: 'Embankment breach · drainage congestion',
            summary: 'Rain over the Nepal catchment sends flood waves down the embanked rivers of the district. Sustained load above Danger Level breaches the embankment nearest Darbhanga town, while rain trapped between embankments ponds across the plain.',
            startHour: 6,
            tStart, z, rain, rainWeight, rainConc: 0.1, drainSeries,
            infil: { f0: 10 / 1000 / HOUR, fc: 2 / 1000 / HOUR, Fk: 0.025 },
            ...f, inflows, pulses: [], stage: null, breaches, initialDepth, initialConc: 0.5,
            gauge: gauge || { name: 'River', kind: 'depth', cell: entries[0], unit: 'm depth', thresholds: [] },
            watchPoints, breach: breachInfo, breachSites, rivers: rivers.map(rv => rv.path), events
        };
    }

    // ------------------------------------------------------------------
    // Dhemaji: Brahmaputra + flashy north-bank tributaries
    // ------------------------------------------------------------------
    function buildDhemaji(t, stormMm) {
        const vid = 'dhemaji';
        const tStart = -8 * HOUR;
        const N = t.nx * t.ny;
        const rain = hyetograph(tStart, stormMm, 1.1, [
            { t: 1.5, sd: 1, w: 1.0 }, { t: 6, sd: 1.4, w: 1.5 }, { t: 11.5, sd: 1.2, w: 1.1 }, { t: 17.5, sd: 1.2, w: 0.9 }
        ]);
        let zlo = Infinity, zhi = -Infinity;
        for (let i = 0; i < N; i++) { zlo = Math.min(zlo, t.z[i]); zhi = Math.max(zhi, t.z[i]); }
        const noise = valueNoise(t.nx, t.ny, 30, 23);
        const rainWeight = new Float32Array(N);
        for (let i = 0; i < N; i++) {
            const oro = 0.8 + 0.9 * Math.min(1, (t.z[i] - zlo) / 400);      // foothills catch more
            rainWeight[i] = oro * (0.85 + 0.3 * noise[i]);
        }
        const f = baseFields(t, { nLand: 0.045, nChannel: 0.03, channelKm2: 300,
            urban: [{ lng: 94.5630, lat: 27.4764, radiusKm: 1.0, drainMmH: 8 }, { lng: 94.7256, lat: 27.5894, radiusKm: 1.0, drainMmH: 8 }] });

        const n = seriesLen(tStart);
        // Brahmaputra: the largest river entering on the east edge, spread across its low belt.
        const eastEntry = findEntries(t, ['east'], 500, 1, 5)[0];
        const inflows = [];
        const events = [];
        if (eastEntry !== undefined) {
            const r0 = Math.floor(eastEntry / t.nx), c0 = eastEntry % t.nx;
            const belt = [];
            for (let dr = -3; dr <= 3; dr++) {
                const r = r0 + dr;
                if (r < 1 || r >= t.ny - 1) continue;
                const j = r * t.nx + c0;
                if (t.z[j] <= t.z[eastEntry] + 2) belt.push(j);
            }
            const q = new Float32Array(n);
            for (let k = 0; k < n; k++) {
                const th = seriesTime(tStart, k) / HOUR;
                q[k] = 16000 + stormMm * 80 * smoothstep(-4, 16, th);
            }
            inflows.push({ name: 'Brahmaputra', cells: belt.length ? belt : [eastEntry], series: q, conc: 0.55, areaKm2: 0 });
        }
        // Tributaries off the Arunachal foothills along the north edge.
        const trib = findEntries(t, ['north'], 60, 6, 15);
        const town = [94.5630, 27.4764];
        let jiadhal = null;
        trib.forEach(i => {
            const path = traceDownstream(t, i);
            let dmin = Infinity;
            path.forEach(j => { dmin = Math.min(dmin, distKm(t.toLngLat(j), town)); });
            if (!jiadhal || dmin < jiadhal.d) jiadhal = { i, d: dmin, path };
        });
        // Inject each tributary where it leaves the hills (a 400 m grid cannot
        // resolve the gorges above that, and water would pile up in them).
        const plainZ = zlo + 45;
        const outlets = trib.map(i => {
            const path = traceDownstream(t, i);
            return path.find(j => t.z[j] <= plainZ) || path[path.length - 1];
        });
        trib.forEach((i0, k) => {
            const i = outlets[k];
            const areaKm2 = t.acc[i0] * t.cellKm2 * 2.5;
            const series = riverResponse(rain, 1.8 + (k % 3) * 0.4, 6, 0.22 * areaKm2, 3 + areaKm2 * 0.04);
            const near = nearestPlace(vid, t.toLngLat(i));
            let name = jiadhal && jiadhal.i === i0 ? 'Jiadhal' : (near && near.km < 12 ? `River near ${near.name}` : `North-bank river ${k + 1}`);
            if (inflows.some(x => x.name === name)) name = `North-bank river ${k + 1}`;
            inflows.push({ name, cells: neighbours(t, i, 0).length ? [i] : [i0], series, conc: 0.75, areaKm2 });
        });
        inflows.forEach(inf => {
            if (inf.name === 'Brahmaputra') return;
            let kPk = 0;
            for (let k = 0; k < n; k++) if (inf.series[k] > inf.series[kPk]) kPk = k;
            if (inf.series[kPk] < 60) return;
            events.push({ t: Math.max(0, seriesTime(tStart, kPk) - 60 * 60), level: 'orange', kind: 'surge', lngLat: t.toLngLat(inf.cells[0]),
                title: `Flash surge on the ${inf.name}`, detail: `Peak ~${Math.round(inf.series[kPk])} m³/s leaving the foothills, sand and silt laden.` });
        });
        const bq = inflows.find(i => i.name === 'Brahmaputra');
        if (bq) {
            events.push({ t: 10 * HOUR, level: 'orange', kind: 'gauge', lngLat: t.toLngLat(bq.cells[0]), title: 'Brahmaputra rising above Danger Level',
                detail: `Inflow ~${fmtK(FloodScenariosValue(bq.series, tStart, 10 * HOUR))} m³/s. Tributary outfalls drowned: backwater into the north-bank plain.` });
        }

        // Gauge: the Jiadhal where it passes Dhemaji town.
        // gauge: the main channel of the Jiadhal within 8 km of Dhemaji town
        const nearTown = jiadhal ? jiadhal.path.filter(j => t.mask[j] && distKm(t.toLngLat(j), town) < 8) : [];
        let gcell = nearTown.length ? nearTown.reduce((a, j) => t.acc[j] > t.acc[a] ? j : a, nearTown[0])
            : (jiadhal ? jiadhal.path[Math.floor(jiadhal.path.length / 2)] : trib[0]);
        const initialDepth = new Float32Array(N);
        for (let i = 0; i < N; i++) {
            const km2 = t.acc[i] * t.cellKm2;
            if (km2 > 200) initialDepth[i] = Math.min(4, 0.6 * Math.log10(km2));
        }
        return {
            flood_type: 'Flash tributaries · Brahmaputra backwater',
            summary: 'Rain on the Arunachal foothills sends silt-laden flash surges down the north-bank rivers (Jiadhal and its neighbours) while a rising Brahmaputra drowns their outfalls, so water spreads as wide, shallow sheets across the district.',
            startHour: 4,
            tStart, z: t.z, rain, rainWeight, rainConc: 0.1,
            infil: { f0: 20 / 1000 / HOUR, fc: 5 / 1000 / HOUR, Fk: 0.04 },
            ...f, inflows, pulses: [], initialDepth, initialConc: 0.5, stage: null,
            gauge: {
                name: nearTown.length ? 'Jiadhal at Dhemaji' : 'Jiadhal, mid reach', kind: 'depth', cell: gcell, unit: 'm depth',
                thresholds: [{ v: 1.5, label: 'Warning', level: 'yellow' }, { v: 2.5, label: 'Danger', level: 'orange' }]
            },
            watchPoints: [],
            events
        };
    }

    function fmtK(v) { return Math.round(v).toLocaleString('en-IN'); }
    function FloodScenariosValue(series, tStart, t) {
        const x = (t - tStart) / SERIES_STEP;
        const i = Math.max(0, Math.min(series.length - 1, Math.round(x)));
        return series[i];
    }

    const BUILDERS = { wayanad_meppadi: buildMeppadi, darbhanga: buildDarbhanga, dhemaji: buildDhemaji };

    function buildScenario(terrain, villageId, stormMm) {
        const build = BUILDERS[villageId];
        if (!build) return null;
        const sc = build(terrain, stormMm);
        sc.villageId = villageId;
        sc.stormMm = stormMm;
        sc.seriesStep = SERIES_STEP;
        sc.tEnd = SIM_END;
        sc.frameEvery = terrain.nx * terrain.ny > 45000 ? 900 : 600;
        sc.dynamicEvents = sc.events.dynamic || {};
        sc.events = sc.events.slice().sort((a, b) => a.t - b.t);
        sc.cumRain = cumulative(sc.rain, sc.tStart);
        sc.clock = (tSec) => fmtClock(sc.startHour, tSec);
        return sc;
    }

    global.FloodScenarios = {
        HOUR, SERIES_STEP, SIM_END, decodeTerrain, buildScenario, factorOfSafety, SLOPE_MODEL,
        seriesValueAt(series, tStart, t) {
            const x = (t - tStart) / SERIES_STEP;
            const i = Math.max(0, Math.min(series.length - 1, Math.floor(x)));
            const j = Math.min(series.length - 1, i + 1), a = Math.max(0, Math.min(1, x - i));
            return series[i] * (1 - a) + series[j] * a;
        }
    };
})(typeof window !== 'undefined' ? window : globalThis);
