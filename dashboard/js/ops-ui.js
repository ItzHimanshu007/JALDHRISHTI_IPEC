/**
 * Jal Drishti - operations panels
 * ---------------------------------------------------------------------------
 * Binds the flood simulation (flood-sim.js / flood-render.js) to the
 * dashboard: top-bar clock and alert level, situation KPIs, gauge chart,
 * scenario player (timeline, speed, water accumulated), layer switches, event
 * log, settlement / facility exposure and the click-to-inspect readout.
 */
(function (global) {
    'use strict';

    const HOUR = 3600;
    const $ = (id) => document.getElementById(id);
    const LEVEL_NAME = { green: 'Green', yellow: 'Yellow', orange: 'Orange', red: 'Red' };
    const LEVEL_COLOR = { green: '#3f9d6a', yellow: '#d8b638', orange: '#e0832f', red: '#d44b45', info: '#5aa9d6' };

    let map = null;
    let terrainOn = true;
    // camera + relief per area: steep Ghats need little exaggeration, the flat
    // Bihar plain needs a lot before its levees and river beds read at all
    const VIEW = {
        wayanad_meppadi: { exaggeration: 1.4, pitch: 58, bearing: -18 },
        darbhanga: { exaggeration: 6, pitch: 45, bearing: -8 },
        dhemaji: { exaggeration: 2.2, pitch: 48, bearing: 0 },
        default: { exaggeration: 1.5, pitch: 50, bearing: 0 }
    };
    let lastUi = 0;
    let lastLogKey = '';
    let lastListKey = '';
    let inspectLngLat = null;
    let inspectMarker = null;

    const fmtInt = (n) => Math.round(n).toLocaleString('en-IN');
    function fmtT(t) {
        const m = Math.max(0, Math.round(t / 60));
        return `T+${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    }
    function fmtDur(s) {
        const m = Math.max(0, Math.round(s / 60));
        return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} m` : `${m} min`;
    }
    function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

    function flyTo(lngLat, zoom) {
        if (map && lngLat) map.flyTo({ center: lngLat, zoom: zoom || 14.2, essential: true, duration: 1400 });
    }

    // ------------------------------------------------------------ scenario
    function onScenario(sc) {
        $('opsFloodType').textContent = sc.flood_type;
        $('opsScenarioNote').textContent = sc.summary;
        $('opsScenarioNote').title = sc.summary;
        $('opsGaugeTitle').textContent = sc.gauge.name;
        $('layerSlope').hidden = !sc.landslide;
        $('opsComputeState').textContent = 'running model…';
        lastLogKey = ''; lastListKey = '';
        $('opsLog').innerHTML = '';
        renderAxis();
        renderAll(FloodSim.snapshot(), true);
    }

    // ------------------------------------------------------------ top bar + KPIs
    function renderClock(s) {
        $('opsClockT').textContent = fmtT(s.t);
        $('opsClockLocal').textContent = s.scenario ? s.scenario.clock(s.t) + ' IST' : '--:--';
        const a = $('opsAlert');
        a.dataset.level = s.alert;
        $('opsAlertText').textContent = LEVEL_NAME[s.alert];
    }

    function kpi(label, value, unit, delta, level) {
        let d = '';
        if (delta !== null && delta !== undefined && isFinite(delta)) {
            const cls = delta > 0.0001 ? 'up' : (delta < -0.0001 ? 'down' : '');
            d = `<div class="kpi__delta ${cls}">${delta > 0 ? '+' : ''}${delta} in 1 h</div>`;
        }
        return `<div class="kpi" ${level ? `data-level="${level}"` : ''}><div class="kpi__label">${label}</div>
            <div class="kpi__value">${value}${unit ? `<small>${unit}</small>` : ''}</div>${d}</div>`;
    }

    function renderKpis(s) {
        const d = s.derived, p = s.derivedHourAgo;
        const fac = FloodSim.facilities || [];
        const affected = d ? d.facilities.filter(f => f.status !== 'ok').length : 0;
        const r1 = (x) => Math.round(x * 10) / 10;
        $('opsKpis').innerHTML = [
            kpi('Inundated area', d ? d.wetKm2.toFixed(1) : '0.0', 'km²', d && p ? r1(d.wetKm2 - p.wetKm2) : null),
            kpi('People in water > 30 cm', d ? fmtInt(d.exposed) : '0', '', d && p ? d.exposed - p.exposed : null, d && d.exposed >= 1000 ? 'orange' : null),
            kpi('At risk to life', d ? fmtInt(d.lifeRisk) : '0', '', null, d && d.lifeRisk > 0 ? 'red' : null),
            (() => {
                const g = window.FloodGrid && FloodGrid.summary();
                const hi = g ? g.counts[3] + g.counts[4] : 0;
                return kpi('Grid cells high / severe', g ? `${hi}/${g.total}` : '--', '', null, g && g.counts[4] ? 'red' : (hi ? 'orange' : null))
                    .replace('</div></div>', `</div><div class="kpi__delta">deepest water ${d ? d.maxDepth.toFixed(1) : '0.0'} m</div></div>`);
            })(),
            kpi('Rain now', s.rainNow.toFixed(1), 'mm/h', null, s.rainNow >= 35 ? 'orange' : null)
                .replace('</div></div>', `</div><div class="kpi__delta">${Math.round(s.rainSoFar)} mm since T+0</div></div>`),
            kpi('Facilities affected', `${affected}/${fac.length}`, '', null, affected ? 'orange' : null)
        ].join('');
        const cs = $('opsComputeState');
        if (s.done) cs.textContent = 'model ready · 24 h';
        else if (s.computedUntil >= 0) cs.textContent = `${s.buffering ? 'catching up · ' : 'preparing model · '}${Math.round(s.computedUntil / s.scenario.tEnd * 100)}%`;
    }

    // ------------------------------------------------------------ canvases
    function setupCanvas(cv) {
        const dpr = window.devicePixelRatio || 1;
        const w = cv.clientWidth, h = cv.clientHeight;
        if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
        const ctx = cv.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);
        return { ctx, w, h };
    }

    function gaugeSeries(sc) {
        const st = FloodSim.state;
        const pts = [];
        if (sc.gauge.kind === 'series') {
            for (let t = 0; t <= sc.tEnd; t += 600) pts.push([t, FloodScenarios.seriesValueAt(sc.gauge.series, sc.tStart, t)]);
        } else {
            st.derived.forEach(d => { if (d) pts.push([d.t, d.gauge]); });
        }
        return pts;
    }

    function gaugeNow(s) {
        const sc = s.scenario;
        if (sc.gauge.kind === 'series') return FloodScenarios.seriesValueAt(sc.gauge.series, sc.tStart, s.t);
        // interpolate between the two frames around the clock time, like the map does
        const b = FloodSim.frameBracket(s.t);
        const d0 = b && FloodSim.state.derived[b.f0.k], d1 = b && FloodSim.state.derived[b.f1.k];
        if (!d0) return null;
        return d1 ? d0.gauge * (1 - b.a) + d1.gauge * b.a : d0.gauge;
    }

    /**
     * Gauge chart: the gauge reading (solid up to the clock time, the model's
     * forecast dashed after it) over the rain falling on the area (bars, past
     * bright / future dim). Everything is read from the running simulation.
     */
    function renderGauge(s) {
        const sc = s.scenario;
        const cv = $('opsGaugeChart');
        if (!sc || !cv.clientWidth) return;
        const { ctx, w, h } = setupCanvas(cv);
        const L = 34, R = 8, T = 10, RAIN_H = 34, GAP = 8, B = 16;
        const pw = w - L - R;
        const gTop = T, gH = h - T - RAIN_H - GAP - B;       // gauge panel
        const rTop = gTop + gH + GAP;                         // rain panel
        const X = (t) => L + t / sc.tEnd * pw;
        const cx = X(s.t);
        ctx.font = '10px IBM Plex Mono, monospace';
        ctx.textBaseline = 'middle';

        // --- gauge panel
        const pts = gaugeSeries(sc);
        const ths = sc.gauge.thresholds;
        let lo = Infinity, hi = -Infinity;
        ths.forEach(t => { lo = Math.min(lo, t.v); hi = Math.max(hi, t.v); });
        pts.forEach(p => { lo = Math.min(lo, p[1]); hi = Math.max(hi, p[1]); });
        if (!isFinite(lo)) { lo = 0; hi = 1; }
        if (sc.gauge.kind === 'depth') lo = 0;
        const pad = Math.max((hi - lo) * 0.12, 0.2);
        if (sc.gauge.kind !== 'depth') lo -= pad;
        hi += pad;
        const Y = (v) => gTop + gH - (v - lo) / (hi - lo) * gH;
        ctx.fillStyle = '#141b24'; ctx.fillRect(L, gTop, pw, gH);
        // axis ticks
        ctx.fillStyle = '#748291'; ctx.textAlign = 'right';
        [lo + pad * (sc.gauge.kind === 'depth' ? 0 : 1), (lo + hi) / 2, hi - pad].forEach(v => {
            ctx.fillText(v.toFixed(sc.gauge.kind === 'depth' ? 1 : 1), L - 4, Y(v));
            ctx.fillStyle = 'rgba(255,255,255,0.04)'; ctx.fillRect(L, Y(v), pw, 1); ctx.fillStyle = '#748291';
        });
        // thresholds
        ctx.textAlign = 'left';
        ths.forEach(th => {
            const y = Y(th.v);
            ctx.strokeStyle = LEVEL_COLOR[th.level]; ctx.setLineDash([4, 3]); ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(L + pw, y); ctx.stroke(); ctx.setLineDash([]);
            ctx.fillStyle = LEVEL_COLOR[th.level];
            ctx.fillText(th.label, L + 4, y - 6);
        });
        // forecast (after the clock), then observed (up to the clock)
        const past = pts.filter(p => p[0] <= s.t), future = pts.filter(p => p[0] >= s.t);
        const line = (arr, style, width, dash) => {
            if (arr.length < 2) return;
            ctx.strokeStyle = style; ctx.lineWidth = width; ctx.setLineDash(dash || []);
            ctx.beginPath(); arr.forEach((p, i) => (i ? ctx.lineTo(X(p[0]), Y(p[1])) : ctx.moveTo(X(p[0]), Y(p[1])))); ctx.stroke();
            ctx.setLineDash([]);
        };
        const cur = gaugeNow(s);
        if (cur !== null) { past.push([s.t, cur]); future.unshift([s.t, cur]); }
        if (s.done || sc.gauge.kind === 'series') line(future, 'rgba(217,224,232,0.35)', 1.2, [3, 3]);
        // observed area fill
        if (past.length > 1) {
            ctx.fillStyle = 'rgba(90,169,214,0.14)';
            ctx.beginPath(); ctx.moveTo(X(past[0][0]), gTop + gH);
            past.forEach(p => ctx.lineTo(X(p[0]), Y(p[1])));
            ctx.lineTo(X(past[past.length - 1][0]), gTop + gH); ctx.closePath(); ctx.fill();
        }
        line(past, '#e6edf3', 1.8);

        // --- rain panel
        let rmax = 5;
        const bars = [];
        for (let k = 0; k < 48; k++) {
            let sum = 0;
            for (let j = 0; j < 3; j++) sum += FloodScenarios.seriesValueAt(sc.rain, sc.tStart, (k + j / 3 + 1 / 6) * 1800);
            bars.push(sum / 3); rmax = Math.max(rmax, sum / 3);
        }
        rmax = Math.ceil(rmax / 5) * 5;
        bars.forEach((v, k) => {
            const t0 = k * 1800, bh = v / rmax * RAIN_H;
            ctx.fillStyle = t0 + 1800 <= s.t ? 'rgba(90,169,214,0.85)' : (t0 <= s.t ? 'rgba(90,169,214,0.85)' : 'rgba(90,169,214,0.28)');
            ctx.fillRect(X(t0) + 0.5, rTop + RAIN_H - bh, Math.max(1, pw / 48 - 1), bh);
        });
        ctx.fillStyle = '#748291'; ctx.textAlign = 'right';
        ctx.fillText(String(rmax), L - 4, rTop + 4);
        ctx.fillText('mm/h', L - 4, rTop + RAIN_H - 4);

        // --- time axis + cursor
        ctx.textAlign = 'center'; ctx.fillStyle = '#748291';
        for (let hh = 0; hh <= 24; hh += 6) ctx.fillText(`${hh}h`, X(hh * HOUR), h - 7);
        ctx.fillStyle = 'rgba(255,255,255,0.85)'; ctx.fillRect(cx - 0.5, gTop, 1, rTop + RAIN_H - gTop);
        if (cur !== null) {
            const cy = Y(cur);
            ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(cx, cy, 3.5, 0, Math.PI * 2); ctx.fill();
            // value callout, kept inside the plot
            const label = `${cur.toFixed(2)} m`;
            ctx.font = '600 11px IBM Plex Mono, monospace';
            const tw = ctx.measureText(label).width + 10;
            let bx = cx + 8; if (bx + tw > L + pw) bx = cx - 8 - tw;
            const by = Math.min(Math.max(cy - 9, gTop), gTop + gH - 18);
            ctx.fillStyle = 'rgba(11,15,20,0.92)'; ctx.fillRect(bx, by, tw, 18);
            ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.strokeRect(bx + 0.5, by + 0.5, tw - 1, 17);
            ctx.fillStyle = '#fff'; ctx.textAlign = 'left'; ctx.fillText(label, bx + 5, by + 9.5);
            $('opsGaugeValue').textContent = `${cur.toFixed(2)} ${sc.gauge.unit}`;
        }
        const lvl = cur === null ? null : ths.slice().reverse().find(th => cur >= th.v);
        $('opsGaugeLegend').innerHTML =
            `<span><i style="background:#e6edf3"></i>${esc(sc.gauge.unit)} (model)</span>` +
            `<span><i style="background:rgba(217,224,232,.45)"></i>forecast</span>` +
            `<span><i style="background:rgba(90,169,214,.85)"></i>rain ${s.rainNow.toFixed(1)} mm/h</span>` +
            (lvl ? `<span style="color:${LEVEL_COLOR[lvl.level]}">above ${esc(lvl.label)}</span>` : '<span>below warning</span>');
    }

    function renderAxis() {
        $('opsTimelineAxis').innerHTML = [0, 3, 6, 9, 12, 15, 18, 21, 24].map(h => `<span style="left:${h / 24 * 100}%">${h}h</span>`).join('');
    }

    /** Scenario timeline: static rain profile; only the playhead moves, and only when playing or scrubbing. */
    function renderTimeline(s) {
        const sc = s.scenario;
        const cv = $('opsTimeline');
        if (!sc || !cv.clientWidth) return;
        const { ctx, w, h } = setupCanvas(cv);
        const X = (t) => t / sc.tEnd * w;
        ctx.fillStyle = '#1a222d'; ctx.fillRect(0, 0, w, h);
        let rmax = 1;
        const n = 96, vals = [];
        for (let i = 0; i < n; i++) { const v = FloodScenarios.seriesValueAt(sc.rain, sc.tStart, (i + 0.5) / n * sc.tEnd); vals.push(v); rmax = Math.max(rmax, v); }
        vals.forEach((v, i) => {
            const bh = v / rmax * (h - 14);
            ctx.fillStyle = (i + 0.5) / n * sc.tEnd <= s.t ? 'rgba(90,169,214,0.8)' : 'rgba(90,169,214,0.35)';
            ctx.fillRect(i / n * w + 0.5, h - 12 - bh, w / n - 1, bh);
        });
        // events that have happened so far
        FloodSim.state.events.forEach(e => {
            if (e.t > s.t) return;
            ctx.fillStyle = LEVEL_COLOR[e.level] || '#748291';
            const x = X(e.t);
            ctx.beginPath(); ctx.moveTo(x, h - 9); ctx.lineTo(x - 4, h - 1); ctx.lineTo(x + 4, h - 1); ctx.closePath(); ctx.fill();
        });
        ctx.fillStyle = '#fff'; ctx.fillRect(X(s.t) - 1, 0, 2, h);
    }

    // ------------------------------------------------------------ water accumulated
    /** Floodwater volume at the clock time, interpolated between frames like the map. */
    function floodVolAt(t) {
        const b = FloodSim.frameBracket(t);
        const der = FloodSim.state.derived;
        const d0 = b && der[b.f0.k], d1 = b && der[b.f1.k];
        if (!d0) return null;
        return d1 ? d0.floodVol * (1 - b.a) + d1.floodVol * b.a : d0.floodVol;
    }

    function fmtVolume(m3) {
        if (m3 >= 1e5) return `${(m3 / 1e6).toFixed(2)}<small> million m³</small>`;
        return `${fmtInt(m3)}<small> m³</small>`;
    }

    function renderAccum(s) {
        const sc = s.scenario;
        const v = floodVolAt(s.t) || 0;
        const vAgo = s.t >= HOUR ? floodVolAt(s.t - HOUR) : 0;
        $('accumValue').innerHTML = fmtVolume(v);
        // 1 crore litres = 10,000 m³
        const crore = v / 1e4;
        $('accumAlt').textContent = v > 0 ? `${crore >= 100 ? fmtInt(crore) : crore.toFixed(1)} crore litres` : '';
        const dl = $('accumDelta');
        if (vAgo !== null && s.t > 0) {
            const dv = v - vAgo;
            dl.textContent = `${dv >= 0 ? '+' : '−'}${Math.abs(dv) >= 1e5 ? (Math.abs(dv) / 1e6).toFixed(2) + ' M' : fmtInt(Math.abs(dv))} m³ in 1 h`;
            dl.classList.toggle('up', dv > 0);
        } else { dl.textContent = `${Math.round(s.rainSoFar)} mm rain so far`; dl.classList.remove('up'); }

        // sparkline: volume over the 24 h run, solid up to the clock time
        const cv = $('accumSpark');
        if (!cv.clientWidth) return;
        const { ctx, w, h } = setupCanvas(cv);
        const der = FloodSim.state.derived.filter(Boolean);
        if (!der.length) return;
        let vmax = 1;
        der.forEach(d => { vmax = Math.max(vmax, d.floodVol); });
        const X = (t) => t / sc.tEnd * w, Y = (x) => h - 1 - x / vmax * (h - 3);
        const path = (pts) => { ctx.beginPath(); ctx.moveTo(X(pts[0].t), h); pts.forEach(d => ctx.lineTo(X(d.t), Y(d.floodVol))); ctx.lineTo(X(pts[pts.length - 1].t), h); ctx.closePath(); };
        path(der);
        ctx.fillStyle = 'rgba(90,169,214,0.16)'; ctx.fill();
        const past = der.filter(d => d.t <= s.t);
        if (past.length) {
            past.push({ t: s.t, floodVol: v });
            path(past);
            ctx.fillStyle = 'rgba(90,169,214,0.55)'; ctx.fill();
        }
        ctx.fillStyle = '#fff'; ctx.fillRect(X(s.t) - 0.5, 0, 1, h);
    }

    // ------------------------------------------------------------ events
    function renderEvents(s) {
        const evs = FloodSim.state.events;
        const past = evs.filter(e => e.t <= s.t);
        const future = evs.filter(e => e.t > s.t && e.t <= Math.max(s.computedUntil, 0) + (e.kind === 'breach' || e.kind === 'landslide' || e.kind === 'gauge' || e.kind === 'surge' ? 1e9 : 0));
        $('opsEventCount').textContent = `${past.length} of ${evs.length}`;
        const key = past.length + ':' + FloodSim.state.runId;
        if (key !== lastLogKey) {
            const fresh = lastLogKey && lastLogKey.split(':')[1] === String(FloodSim.state.runId) ? past.length - Number(lastLogKey.split(':')[0]) : 0;
            lastLogKey = key;
            if (fresh > 0 && s.playing) onNewEvents(past.slice(-fresh));
            $('opsLog').innerHTML = past.slice().reverse().map((e, i) => `
                <li class="event ${i < fresh ? 'is-new' : ''}" data-level="${e.level}" data-idx="${evs.indexOf(e)}">
                    <span class="event__time">${fmtT(e.t).slice(2)}</span>
                    <span class="event__title">${esc(e.title)}</span>
                    <span class="event__detail">${esc(e.detail || '')}</span>
                </li>`).join('') || '<li class="empty-note">No events yet. Press play to run the scenario.</li>';
        }
        const next = future.slice(0, 2);
        $('opsUpcoming').innerHTML = next.length ? '<div class="upcoming__label">Model expects</div>' + next.map(e => `
            <div class="upcoming__item" data-idx="${evs.indexOf(e)}"><span>${esc(e.title)}</span><span class="mono">in ${fmtDur(e.t - s.t)}</span></div>`).join('') : '';
    }

    // ------------------------------------------------------------ event banner + guided replay
    const RANK = { info: 0, green: 0, yellow: 1, orange: 2, red: 3 };
    let bannerTimer = null;
    const tour = { active: false, busy: false, timers: [] };

    function showBanner(e, ms) {
        const b = $('eventBanner');
        b.dataset.level = e.level;
        $('eventBannerTime').textContent = fmtT(e.t);
        $('eventBannerTitle').textContent = e.title;
        $('eventBannerDetail').textContent = e.detail || '';
        b.hidden = false;
        b.style.animation = 'none'; void b.offsetWidth; b.style.animation = '';
        clearTimeout(bannerTimer);
        bannerTimer = setTimeout(() => { b.hidden = true; }, ms || 6000);
    }

    function onNewEvents(list) {
        const top = list.slice().sort((a, b) => RANK[b.level] - RANK[a.level])[0];
        if (!top || RANK[top.level] < 1) return;
        showBanner(top);
        if (tour.active && !tour.busy && top.lngLat && RANK[top.level] >= 2) focusEvent(top);
    }

    function later(fn, ms) { tour.timers.push(setTimeout(fn, ms)); }

    function focusEvent(e) {
        tour.busy = true;
        FloodSim.pause();
        map.flyTo({ center: e.lngLat, zoom: FloodSim.state.terrain && FloodSim.state.terrain.dx > 200 ? 11.6 : 13.4, pitch: 50, bearing: 0, duration: 2200, essential: true });
        showBanner(e, 5200);
        later(() => { if (!tour.active) return; global.OpsUI.fitArea(appState.currentVillageId); }, 5000);
        later(() => { if (!tour.active) return; tour.busy = false; FloodSim.play(); }, 6900);
    }

    function startTour() {
        tour.active = true; tour.busy = false;
        $('btnTour').classList.add('active');
        $('btnTour').textContent = 'Stop replay';
        FloodSim.seek(0);
        FloodSim.setSpeed(3600);
        [...$('opsSpeed').children].forEach(x => x.classList.toggle('active', x.dataset.speed === '3600'));
        global.OpsUI.fitArea(appState.currentVillageId);
        later(() => { if (tour.active) FloodSim.play(); }, 1900);
    }

    function stopTour() {
        if (!tour.active) return;
        tour.active = false; tour.busy = false;
        tour.timers.forEach(clearTimeout); tour.timers = [];
        $('btnTour').classList.remove('active');
        $('btnTour').textContent = 'Guided replay';
    }

    // ------------------------------------------------------------ exposure lists
    function renderLists(s, force) {
        const d = s.derived;
        const key = `${FloodSim.state.runId}:${d ? d.t : -1}:${FloodSim.state.facilityCells.length}`;
        if (!force && key === lastListKey) return;
        lastListKey = key;
        if (window.FloodGrid) {
            const ranked = FloodGrid.ranked(15);
            $('opsGridList').innerHTML = ranked.length ? ranked.map(r => `
                <div class="xrow" data-hex="${r.idx}">
                    <span class="xrow__name mono">${r.hex.id}</span><span class="risk-chip" data-risk="${r.s.risk}">${FloodGrid.RISK[r.s.risk]} · ${r.s.index}</span>
                    <span class="xrow__sub">${r.s.maxDepth.toFixed(1)} m max · ${Math.round(r.s.wetFrac * 100)}% flooded · ${(r.s.volume / 1e6).toFixed(2)} M m³</span>
                    <span class="xrow__sub mono">${fmtInt(r.s.atRisk)} at risk</span>
                </div>`).join('') : '<div class="empty-note">No grid cell has standing water yet.</div>';
        }
        const rows = d ? Object.entries(d.perCluster).sort((a, b) => b[1].people - a[1].people).slice(0, 10) : [];
        const top = rows.length ? rows[0][1].people : 1;
        $('opsSettlements').innerHTML = rows.length ? rows.map(([name, c]) => `
            <div class="xrow" data-cluster="${esc(name)}">
                <span class="xrow__name">${esc(name)}</span><span class="xrow__val">${fmtInt(c.people)}</span>
                <span class="xrow__sub">in water up to ${c.maxDepth.toFixed(1)} m</span><span class="xrow__sub">people</span>
                <span class="xrow__bar"><span style="width:${Math.max(4, c.people / top * 100)}%"></span></span>
            </div>`).join('') : '<div class="empty-note">No settlement has water over 30 cm at this time.</div>';

        const fac = FloodSim.state.facilityCells;
        const STATUS = { ok: 'Operational', access: 'Access cut', inundated: 'Inundated' };
        $('opsFacilities').innerHTML = fac.length ? fac.map((f, i) => {
            const st = d ? d.facilities[i] : { status: 'ok', depth: 0 };
            return `<div class="xrow" data-fac="${i}">
                <span class="xrow__name">${esc(f.name)}</span><span class="status status--${st.status}">${STATUS[st.status]}</span>
                <span class="xrow__sub">${esc(String(f.type).replace(/_/g, ' '))}${f.capacity ? ` · capacity ${fmtInt(f.capacity)}` : ''}</span>
                <span class="xrow__sub mono">${st.depth.toFixed(2)} m</span></div>`;
        }).join('') : '<div class="empty-note">No facilities mapped for this area.</div>';
    }

    // ------------------------------------------------------------ inspector
    function renderInspector() {
        if (!inspectLngLat) return;
        const r = FloodSim.sample(inspectLngLat.lng, inspectLngLat.lat);
        const body = $('simInspectorBody');
        const hexIdx = window.FloodGrid ? FloodGrid.hexAt(inspectLngLat.lng, inspectLngLat.lat) : -1;
        const hexHtml = hexIdx >= 0 ? `<div class="inspector-section"><div class="inspector-section__title">Grid cell</div>${FloodGrid.card(hexIdx)}</div>` : '';
        $('simInspectorTitle').textContent = hexIdx >= 0 ? `Readout · ${FloodGrid.hex(hexIdx).id}` : 'Point readout';
        if (!r) {
            body.innerHTML = '<div class="empty-note">Outside the simulated area.</div>';
            return;
        }
        const type = r.depth < 0.02 ? '—' : (r.conc > 0.7 ? 'Debris / mud flow' : (r.conc > 0.35 ? 'Silt-laden river water' : 'Rain runoff'));
        let advice, cls = '';
        if (r.depth > 1.2 || r.depth * r.speed > 1) { advice = 'Not passable on foot or by vehicle. Boat or air access only.'; cls = 'callout--red'; }
        else if (r.depth >= 0.3) { advice = 'Unsafe for pedestrians and cars. High-clearance vehicles and boats only.'; cls = 'callout--orange'; }
        else if (r.depth >= 0.05) advice = 'Shallow water. Passable with care; watch for open drains.';
        else advice = r.peakDepth >= 0.3 ? 'Dry now, but the model floods this point later.' : 'Dry in this scenario so far.';
        const vid = appState.currentVillageId;
        const t = FloodSim.state.terrain;
        const people = typeof estimateAmbientPopulationDensity === 'function' ? estimateAmbientPopulationDensity(inspectLngLat.lng, inspectLngLat.lat, vid) * t.cellKm2 : null;
        body.innerHTML = hexHtml + `<div class="inspector-section"><div class="inspector-section__title">This point (${Math.round(t.dx)} m model cell)</div>
            <dl class="readout">
                <dt>Water depth now</dt><dd class="mono">${r.depth.toFixed(2)} m</dd>
                <dt>Flow speed</dt><dd class="mono">${r.speed.toFixed(1)} m/s</dd>
                <dt>Water type</dt><dd>${type}</dd>
                <dt>Peak depth${r.complete ? '' : ' (so far)'}</dt><dd class="mono">${r.peakDepth.toFixed(2)} m${r.peakT !== null && r.peakDepth > 0.02 ? ` at ${fmtT(r.peakT).slice(2)}` : ''}</dd>
                <dt>Over 30 cm from</dt><dd class="mono">${r.arrival !== null ? fmtT(r.arrival).slice(2) : '—'}</dd>
                <dt>Ground elevation</dt><dd class="mono">${Math.round(r.elevation)} m</dd>
                <dt>Slope</dt><dd class="mono">${r.slope.toFixed(0)}°</dd>
                ${people !== null ? `<dt>Residents in cell</dt><dd class="mono">~${fmtInt(people)}</dd>` : ''}
            </dl>
            <div class="callout ${cls}">${advice}</div>
            <div class="empty-note mono">${inspectLngLat.lat.toFixed(4)}, ${inspectLngLat.lng.toFixed(4)}</div></div>`;
    }

    function openInspector(lngLat) {
        inspectLngLat = lngLat;
        $('simInspector').hidden = false;
        if (!inspectMarker) {
            const el = document.createElement('div');
            el.className = 'sim-marker';
            el.innerHTML = '<span class="sim-marker__dot" style="background:#fff"></span>';
            inspectMarker = new maplibregl.Marker({ element: el }).setLngLat(lngLat).addTo(map);
        } else inspectMarker.setLngLat(lngLat).addTo(map);
        renderInspector();
    }

    function closeSimInspector() {
        inspectLngLat = null;
        $('simInspector').hidden = true;
        if (inspectMarker) inspectMarker.remove();
    }

    // ------------------------------------------------------------ render loop
    function renderAll(s, force) {
        renderClock(s);
        if (!s.scenario) return;
        renderKpis(s);
        renderAccum(s);
        renderGauge(s);
        renderTimeline(s);
        renderEvents(s);
        renderLists(s, force);
        if (inspectLngLat) renderInspector();
        const pb = $('masterPlayBtn');
        pb.classList.toggle('playing', s.playing);
        pb.setAttribute('aria-label', s.playing ? 'Pause' : 'Play');
        syncTimeStep(s.t);
    }

    function syncTimeStep(t) {
        if (typeof TIME_STEPS === 'undefined') return;
        const step = TIME_STEPS[Math.max(0, Math.min(TIME_STEPS.length - 1, Math.round(t / (4 * HOUR))))];
        if (appState.currentTimeStep === step) return;
        appState.currentTimeStep = step;
        if (document.getElementById('btnLayerRisk')?.classList.contains('active')) {
            updateMapVision(appState.data.villages[appState.currentVillageId]);
        }
    }

    function onTime(s) {
        const now = performance.now();
        if (now - lastUi < 90 && s.playing) return;
        lastUi = now;
        renderAll(s);
    }

    // ------------------------------------------------------------ controls
    function bindControls() {
        $('masterPlayBtn').addEventListener('click', () => { stopTour(); FloodSim.toggle(); });
        $('btnTour').addEventListener('click', () => (tour.active ? stopTour() : startTour()));

        $('opsSpeed').addEventListener('click', (e) => {
            const b = e.target.closest('button'); if (!b) return;
            [...$('opsSpeed').children].forEach(x => x.classList.toggle('active', x === b));
            FloodSim.setSpeed(Number(b.dataset.speed));
        });

        const tl = $('opsTimeline');
        let dragging = false;
        const seekAt = (e) => {
            const sc = FloodSim.state.scenario; if (!sc) return;
            const r = tl.getBoundingClientRect();
            FloodSim.seek(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * sc.tEnd);
        };
        tl.addEventListener('pointerdown', (e) => { stopTour(); dragging = true; tl.setPointerCapture(e.pointerId); seekAt(e); });
        tl.addEventListener('pointermove', (e) => { if (dragging) seekAt(e); });
        tl.addEventListener('pointerup', () => { dragging = false; });

        $('layerTerrain').addEventListener('click', () => {
            terrainOn = !terrainOn;
            $('layerTerrain').classList.toggle('active', terrainOn);
            global.OpsUI.applyTerrain(appState.currentVillageId);
            map.easeTo({ pitch: terrainOn ? (VIEW[appState.currentVillageId] || VIEW.default).pitch : 0, duration: 900 });
        });
        $('btnResetView').addEventListener('click', () => global.OpsUI.fitArea(appState.currentVillageId));
        map.addControl(new maplibregl.NavigationControl({ visualizePitch: true, showZoom: true, showCompass: true }), 'bottom-right');

        ['layerWater', 'layerFlow', 'layerRain', 'layerSlope', 'layerGrid'].forEach(id => {
            $(id).addEventListener('click', () => {
                const on = !$(id).classList.contains('active');
                $(id).classList.toggle('active', on);
                if (id === 'layerGrid') { FloodGrid.setVisible(on); $('gridLegend').hidden = !on; $('mapLegendGrid').hidden = !on; return; }
                FloodRender.set($(id).dataset.layer, on);
                if (id === 'layerWater') $('waterLegend').hidden = !on;
            });
        });
        $('waterStyle').addEventListener('click', (e) => {
            const b = e.target.closest('button'); if (!b) return;
            [...$('waterStyle').children].forEach(x => x.classList.toggle('active', x === b));
            FloodRender.set('style', b.dataset.style);
            $('legendNatural').hidden = b.dataset.style !== 'natural';
            $('legendDepth').hidden = b.dataset.style !== 'depth';
        });

        $('opsExposureTabs').addEventListener('click', (e) => {
            const b = e.target.closest('button'); if (!b) return;
            [...$('opsExposureTabs').children].forEach(x => x.classList.toggle('active', x === b));
            $('opsSettlements').hidden = b.dataset.tab !== 'settlements';
            $('opsGridList').hidden = b.dataset.tab !== 'grid';
            $('opsFacilities').hidden = b.dataset.tab !== 'facilities';
        });

        const eventClick = (e) => {
            const el = e.target.closest('[data-idx]'); if (!el) return;
            const ev = FloodSim.state.events[Number(el.dataset.idx)];
            if (ev && ev.lngLat) flyTo(ev.lngLat);
        };
        $('opsLog').addEventListener('click', eventClick);
        $('opsUpcoming').addEventListener('click', eventClick);
        $('opsSettlements').addEventListener('click', (e) => {
            const el = e.target.closest('[data-cluster]'); if (!el) return;
            const p = FloodSim.state.popPoints.find(pp => pp.cluster === el.dataset.cluster);
            if (p) flyTo(FloodSim.state.terrain.toLngLat(p.cell), 15);
        });
        $('opsGridList').addEventListener('click', (e) => {
            const el = e.target.closest('[data-hex]'); if (!el) return;
            const h = FloodGrid.hex(Number(el.dataset.hex));
            if (h) { flyTo(h.center, 12.5); openInspector({ lng: h.center[0], lat: h.center[1] }); }
        });
        $('opsFacilities').addEventListener('click', (e) => {
            const el = e.target.closest('[data-fac]'); if (!el) return;
            const f = FloodSim.state.facilityCells[Number(el.dataset.fac)];
            if (f) flyTo(f.lngLat, 15.5);
        });

        $('simInspectorClose').addEventListener('click', closeSimInspector);

        const hud = $('hud');
        const togglePanels = () => {
            const mobile = window.innerWidth <= 900;
            const cls = mobile ? 'panels-shown' : 'panels-hidden';
            hud.classList.toggle(cls);
            const hidden = mobile ? !hud.classList.contains('panels-shown') : hud.classList.contains('panels-hidden');
            $('btnHidePanels').textContent = hidden ? 'Show panels' : 'Map only';
        };
        if (window.innerWidth <= 900) $('btnHidePanels').textContent = 'Show panels';
        $('btnHidePanels').addEventListener('click', togglePanels);

        document.addEventListener('keydown', (e) => {
            if (e.target.closest('input, select, textarea')) return;
            if (e.code === 'Space') { e.preventDefault(); stopTour(); FloodSim.toggle(); }
            else if (e.key === 'h' || e.key === 'H') togglePanels();
            else if (e.key === 'ArrowRight') FloodSim.seek(FloodSim.state.t + 1800);
            else if (e.key === 'ArrowLeft') FloodSim.seek(FloodSim.state.t - 1800);
        });

        map.on('click', (e) => {
            if (appState.rescueMode) return;
            if (FloodSim.sample(e.lngLat.lng, e.lngLat.lat)) openInspector(e.lngLat);
        });

        window.addEventListener('resize', () => renderAll(FloodSim.snapshot(), true));
    }

    // ------------------------------------------------------------ public
    global.OpsUI = {
        start(m) {
            map = m;
            FloodSim.init({ getPopulation: () => appState.apiData && appState.apiData.population });
            FloodRender.init(map);
            FloodGrid.init(map);
            FloodSim.on('scenario', onScenario);
            FloodSim.on('time', onTime);
            FloodSim.on('frame', () => { if (!FloodSim.state.playing) onTime(FloodSim.snapshot()); });
            FloodSim.on('done', () => renderAll(FloodSim.snapshot(), true));
            FloodSim.on('play', (p) => { if (!p && tour.active && !tour.busy && FloodSim.state.t >= FloodSim.state.scenario.tEnd) stopTour(); });
            FloodSim.on('play', () => renderAll(FloodSim.snapshot()));
            FloodSim.on('error', (e) => { $('opsComputeState').textContent = e.message; });
            bindControls();
            renderAxis();
            // If the last tile request fails, MapLibre may never render again and
            // so never fire 'load' (which builds the risk/boundary layers). Nudge it.
            let loaded = false;
            map.once('load', () => { loaded = true; });
            const nudge = setInterval(() => { if (loaded) clearInterval(nudge); else map.triggerRepaint(); }, 1000);
            // one storm for the demo: steady monsoon rain for the full 24 h
            appState.rainfallAmount = FloodSim.state.storm;
            FloodSim.setVillage(appState.currentVillageId);
        },
        /** Vertical exaggeration per area: enough to read the relief, not so much that SRTM noise shows. */
        terrainExaggeration(id) { return terrainOn ? (VIEW[id] || VIEW.default).exaggeration : 0; },
        applyTerrain(id) {
            if (!map || !map.getSource('terrainSource')) return;
            map.setTerrain({ source: 'terrainSource', exaggeration: global.OpsUI.terrainExaggeration(id) });
            if (global.FloodRender) FloodRender.invalidate();
        },
        /** Frame the whole village / district in 3D, leaving room for the side panels. */
        fitArea(id) {
            const cfg = typeof SIMULATION_CONFIG !== 'undefined' && SIMULATION_CONFIG[id];
            if (!map || !cfg) return false;
            global.OpsUI.applyTerrain(id);
            const v = VIEW[id] || VIEW.default;
            const [w, s, e, n] = cfg.bbox;
            const narrow = window.innerWidth <= 900;
            // frame the area top-down, then tilt in: a tilted fitBounds leaves it tiny in the middle
            const padding = narrow ? { top: 110, bottom: 150, left: 20, right: 20 } : { top: 70, bottom: 110, left: 350, right: 335 };
            // zoom that fits the bounds top-down in the space between the panels (512 px tiles)
            const my = (lat) => (1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2;
            const availW = Math.max(200, window.innerWidth - padding.left - padding.right);
            const availH = Math.max(200, window.innerHeight - padding.top - padding.bottom);
            const zx = Math.log2(availW / ((e - w) / 360 * 512));
            const zy = Math.log2(availH / ((my(s) - my(n)) * 512));
            map.flyTo({
                center: [(w + e) / 2, (s + n) / 2], zoom: Math.min(zx, zy) + (terrainOn ? (zx < zy ? 0.1 : 0.3) : 0),
                pitch: terrainOn ? v.pitch : 0, bearing: terrainOn ? v.bearing : 0, duration: 2000, essential: true,
                padding
            });
            return true;
        },
        onVillageChange(id) {
            stopTour();
            closeSimInspector();
            FloodSim.setVillage(id);
        },
        /** Short spoken/printed summary of the current situation. */
        summary() {
            const s = FloodSim.snapshot();
            if (!s.scenario || !s.derived) return '';
            return `${s.scenario.flood_type}. ${fmtT(s.t)}. Alert ${LEVEL_NAME[s.alert]}. ${s.derived.wetKm2.toFixed(1)} square kilometres under water; ${fmtInt(s.derived.exposed)} people in water over 30 centimetres.`;
        }
    };
})(window);
