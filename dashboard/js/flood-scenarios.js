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
        const [w, s, e, n] = doc.bounds;
        const t = {
            id: doc.village_id, nx, ny, dx: doc.dx_m, dy: doc.dy_m, bounds: doc.bounds, z, acc,
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
            let v = th >= 0 ? base : 0;
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
            manning[i] = opts.nLand * (1 - chan) + opts.nChannel * chan;
            infilMul[i] = 1 - 0.7 * chan;
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
        const rain = hyetograph(tStart, stormMm, 0.35, [
            { t: 2.5, sd: 1.0, w: 0.9 }, { t: 6.5, sd: 1.3, w: 2.2 }, { t: 7.8, sd: 0.6, w: 1.6 },
            { t: 13, sd: 1.5, w: 0.8 }, { t: 18, sd: 1.2, w: 0.4 }
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
            tStart, rain, rainWeight, rainConc: 0.12,
            infil: { f0: 28 / 1000 / HOUR, fc: 7 / 1000 / HOUR, Fk: 0.045 },
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
    // Darbhanga: embankment breach + drainage congestion
    // ------------------------------------------------------------------
    function buildDarbhanga(t, stormMm) {
        const tStart = -1 * HOUR;
        // Local rain is a fraction of the catchment storm (the flood wave is born upstream in Nepal).
        const rain = hyetograph(tStart, stormMm * 0.6, 0.4, [
            { t: 2, sd: 1.5, w: 1.0 }, { t: 7, sd: 2, w: 1.3 }, { t: 13, sd: 1.2, w: 0.7 }
        ]);
        const catchRain = hyetograph(tStart, stormMm, 0.3, [{ t: 1.5, sd: 2, w: 1.4 }, { t: 6, sd: 2.5, w: 1.2 }]);
        const N = t.nx * t.ny;
        const noise = valueNoise(t.nx, t.ny, 30, 11);
        const rainWeight = new Float32Array(N);
        for (let i = 0; i < N; i++) rainWeight[i] = 0.85 + 0.3 * noise[i];
        const urban = [
            { lng: 85.8995, lat: 26.1570, radiusKm: 1.6, drainMmH: 14 },
            { lng: 85.8976, lat: 26.1188, radiusKm: 1.1, drainMmH: 12 }
        ];
        const f = baseFields(t, { nLand: 0.05, nChannel: 0.035, channelKm2: 6, urban });

        // River (Kamla-Balan side, east of the city) stage above the country-side ground at the breach site.
        const n = seriesLen(tStart);
        const riverQ = riverResponse(catchRain, 9, 16, 300, 380);    // m3/s
        const stageAboveGround = new Float32Array(n);
        for (let k = 0; k < n; k++) stageAboveGround[k] = 0.15 * Math.pow(riverQ[k], 0.42) - 0.6;
        const WL = 2.1, DL = 2.8, HFL = 3.9;

        const breachLL = [85.9790, 26.1690];
        const breachCell = t.toCell(breachLL[0], breachLL[1]);
        const gGround = t.z[breachCell];
        const events = [];
        let tWL = null, tDL = null, tBreach = null, above = 0;
        for (let k = 0; k < n; k++) {
            const tt = seriesTime(tStart, k);
            if (tt < 0) continue;
            if (tWL === null && stageAboveGround[k] >= WL) tWL = tt;
            if (tDL === null && stageAboveGround[k] >= DL) tDL = tt;
            above = stageAboveGround[k] >= DL + 0.25 ? above + SERIES_STEP : 0;
            if (tBreach === null && above >= 1.5 * HOUR) tBreach = tt;   // piping after sustained load
        }
        const ll = t.toLngLat(breachCell);
        if (tWL !== null) events.push({ t: tWL, level: 'yellow', kind: 'gauge', lngLat: ll, title: 'River above Warning Level at Khutwara', detail: `Stage ${(gGround + WL).toFixed(2)} m. Embankment patrols to be alerted.` });
        if (tDL !== null) events.push({ t: tDL, level: 'orange', kind: 'gauge', lngLat: ll, title: 'River above Danger Level at Khutwara', detail: `Stage ${(gGround + DL).toFixed(2)} m. City sluice gates closed; outfalls blocked.` });

        const drainSeries = new Float32Array(n);
        for (let k = 0; k < n; k++) drainSeries[k] = stageAboveGround[k] >= DL ? 0.15 : 1;

        const inflows = [];
        if (tBreach !== null && tBreach < SIM_END - HOUR) {
            const series = new Float32Array(n);
            for (let k = 0; k < n; k++) {
                const tt = seriesTime(tStart, k);
                if (tt < tBreach) continue;
                const width = Math.min(160, 20 + (tt - tBreach) / HOUR * 45);     // breach widens over ~3 h
                const head = Math.max(0, stageAboveGround[k] - 0.3);
                series[k] = 1.7 * width * Math.pow(head, 1.5) * 0.55;             // broad-crested weir, partial drowning
            }
            inflows.push({ name: 'Breach', cells: neighbours(t, breachCell, 1), series, conc: 0.65 });
            events.push({ t: tBreach, level: 'red', kind: 'breach', lngLat: ll, title: 'Embankment breach at Khutwara',
                detail: 'West embankment failed after sustained load above Danger Level. Breach ~20 m wide and widening.' });
            events.push({ t: tBreach + 3 * HOUR, level: 'red', kind: 'breach', lngLat: ll, title: 'Breach widened to ~150 m', detail: `Outflow ~${Math.round(Math.max(...series))} m³/s into the countryside.` });
        } else {
            events.push({ t: 12 * HOUR, level: 'info', kind: 'note', lngLat: ll, title: 'Embankments holding', detail: 'River stays below the sustained-overload threshold at this rainfall.' });
        }

        const stageAbs = new Float32Array(n);
        for (let k = 0; k < n; k++) stageAbs[k] = gGround + stageAboveGround[k];

        return {
            flood_type: 'Embankment breach · drainage congestion',
            summary: 'Rain on the upstream catchment raises the Kamla-Balan. Sustained load above Danger Level breaches the west embankment at Khutwara; water spreads west across the flat plain while closed sluices stop the city from draining local rain.',
            startHour: 6,
            tStart, rain, rainWeight, rainConc: 0.1, drainSeries,
            infil: { f0: 10 / 1000 / HOUR, fc: 2 / 1000 / HOUR, Fk: 0.025 },
            ...f, inflows, pulses: [], stage: null,
            closedSides: ['north', 'east'],       // the river embankment runs along the east edge
            gauge: {
                name: 'Kamla-Balan at Khutwara', kind: 'series', unit: 'm stage', series: stageAbs,
                thresholds: [{ v: gGround + WL, label: 'Warning', level: 'yellow' }, { v: gGround + DL, label: 'Danger', level: 'orange' }, { v: gGround + HFL, label: 'HFL', level: 'red' }]
            },
            watchPoints: [{ name: 'Breach site', cell: breachCell, lngLat: ll }],
            breach: { cell: breachCell, lngLat: ll, t: tBreach },
            events
        };
    }

    // ------------------------------------------------------------------
    // Dhemaji: flash tributaries + Brahmaputra backwater sheet flooding
    // ------------------------------------------------------------------
    function buildDhemaji(t, stormMm) {
        const tStart = -3 * HOUR;           // spin-up so the rivers are flowing at T+0
        const rain = hyetograph(tStart, stormMm, 0.3, [
            { t: 1.5, sd: 1, w: 1.0 }, { t: 6, sd: 1.4, w: 1.5 }, { t: 11.5, sd: 1.2, w: 1.0 }, { t: 17.5, sd: 1, w: 0.5 }
        ]);
        const N = t.nx * t.ny;
        const noise = valueNoise(t.nx, t.ny, 26, 23);
        const rainWeight = new Float32Array(N);
        for (let r = 0; r < t.ny; r++) {
            for (let c = 0; c < t.nx; c++) {
                const i = r * t.nx + c;
                rainWeight[i] = (0.7 + 0.7 * (1 - r / t.ny)) * (0.85 + 0.3 * noise[i]);   // heavier toward the foothills
            }
        }
        const f = baseFields(t, { nLand: 0.045, nChannel: 0.03, channelKm2: 8,
            urban: [{ lng: 94.5630, lat: 27.4764, radiusKm: 0.8, drainMmH: 8 }] });

        // Tributaries entering along the northern edge: local maxima of drainage area.
        const cand = [];
        for (let c = 2; c < t.nx - 2; c++) {
            const i = 1 * t.nx + c;
            if (t.acc[i] * t.cellKm2 < 3) continue;
            if (t.acc[i] >= t.acc[i - 1] && t.acc[i] >= t.acc[i + 1]) cand.push(i);
        }
        cand.sort((a, b) => t.acc[b] - t.acc[a]);
        const entries = [];
        for (const i of cand) {
            if (entries.every(j => Math.abs((j % t.nx) - (i % t.nx)) > 18)) entries.push(i);
            if (entries.length === 3) break;
        }
        const n = seriesLen(tStart);
        const names = ['Jiadhal', 'Kumotiya', 'Gainadi'];
        const inflows = entries.map((i, k) => {
            const areaKm2 = t.acc[i] * t.cellKm2 * 3.5;          // catchment continues into the Arunachal hills
            const series = riverResponse(rain, 1.6 + k * 0.4, 5, 0.15 * areaKm2, 4 + areaKm2 * 0.05);
            return { name: names[k] || `Tributary ${k + 1}`, cells: neighbours(t, i + 2 * t.nx, 1), series, conc: 0.75, areaKm2 };
        });

        // Southern boundary held up by the Brahmaputra (backwater).
        let zSouth = Infinity;
        const southCells = [];
        for (let c = 0; c < t.nx; c++) { const i = (t.ny - 1) * t.nx + c; southCells.push(i); zSouth = Math.min(zSouth, t.z[i]); }
        const rise = 0.8 + Math.min(2.7, stormMm / 300 * 2.7);
        const stageSeries = new Float32Array(n);
        for (let k = 0; k < n; k++) {
            const th = seriesTime(tStart, k) / HOUR;
            stageSeries[k] = zSouth - 0.4 + rise * smoothstep(2, 20, th);
        }
        const DL = zSouth + 0.6, HFL = zSouth + 1.5;
        const events = [];
        for (const inf of inflows) {
            let kPk = 0;
            for (let k = 0; k < n; k++) if (inf.series[k] > inf.series[kPk]) kPk = k;
            events.push({ t: Math.max(0, seriesTime(tStart, kPk) - 40 * 60), level: 'orange', kind: 'surge', lngLat: t.toLngLat(inf.cells[0]),
                title: `Flash surge on the ${inf.name}`, detail: `Peak ~${Math.round(inf.series[kPk])} m³/s from the foothills, sand and silt laden.` });
        }
        let tDL = null, tHFL = null;
        for (let k = 0; k < n; k++) {
            const tt = seriesTime(tStart, k);
            if (tt < 0) continue;
            if (tDL === null && stageSeries[k] >= DL) tDL = tt;
            if (tHFL === null && stageSeries[k] >= HFL) tHFL = tt;
        }
        const southLL = t.toLngLat(southCells[Math.floor(t.nx / 2)]);
        if (tDL !== null) events.push({ t: tDL, level: 'orange', kind: 'gauge', lngLat: southLL, title: 'Brahmaputra backwater above Danger Level', detail: 'Tributary outfalls drowned; floodwater can no longer drain south.' });
        if (tHFL !== null) events.push({ t: tHFL, level: 'red', kind: 'gauge', lngLat: southLL, title: 'Backwater above highest flood level', detail: 'Sheet flooding spreading north into the Dhemaji plain.' });

        // Channels already flowing at the start of spin-up.
        const initialDepth = new Float32Array(N);
        for (let i = 0; i < N; i++) {
            const km2 = t.acc[i] * t.cellKm2;
            if (km2 > 10) initialDepth[i] = Math.min(1.2, 0.25 * Math.log10(km2));
        }

        return {
            flood_type: 'Flash tributaries · backwater sheet flood',
            summary: 'Rain on the Arunachal foothills sends silt-laden flash surges down the north-bank tributaries while the rising Brahmaputra holds the southern boundary up, so floodwater spreads as wide, shallow sheets across the plain.',
            startHour: 4,
            tStart, rain, rainWeight, rainConc: 0.1,
            infil: { f0: 30 / 1000 / HOUR, fc: 8 / 1000 / HOUR, Fk: 0.05 },
            ...f, inflows, pulses: [], initialDepth, initialConc: 0.5,
            stage: { cells: southCells, series: stageSeries, conc: 0.55 },
            gauge: {
                name: 'Brahmaputra backwater (south edge)', kind: 'series', unit: 'm stage', series: stageSeries,
                thresholds: [{ v: DL, label: 'Danger', level: 'orange' }, { v: HFL, label: 'HFL', level: 'red' }]
            },
            watchPoints: inflows.map(inf => ({ name: inf.name, cell: inf.cells[0], lngLat: t.toLngLat(inf.cells[0]) })),
            events
        };
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
        sc.frameEvery = 600;
        sc.events.sort((a, b) => a.t - b.t);
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
