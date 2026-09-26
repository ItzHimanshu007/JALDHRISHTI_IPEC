/**
 * Jal Drishti - operations panels
 * ---------------------------------------------------------------------------
 * Binds the flood simulation (flood-sim.js / flood-render.js) to the
 * dashboard: top-bar clock and alert level, situation KPIs, gauge chart,
 * scenario player (timeline, speed, storm total), layer switches, event
 * log, settlement / facility exposure and the click-to-inspect readout.
 */
(function (global) {
    'use strict';

    const HOUR = 3600;
    const $ = (id) => document.getElementById(id);
    const LEVEL_NAME = { green: 'Green', yellow: 'Yellow', orange: 'Orange', red: 'Red' };
    const LEVEL_COLOR = { green: '#3f9d6a', yellow: '#d8b638', orange: '#e0832f', red: '#d44b45', info: '#5aa9d6' };

    let map = null;
    let lastUi = 0;
    let lastLogKey = '';
    let lastListKey = '';
    let inspectLngLat = null;
    let inspectMarker = null;
    let stormTimer = null;

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
            kpi('Deepest water', d ? d.maxDepth.toFixed(1) : '0.0', 'm', null),
            kpi('Rain now', s.rainNow.toFixed(1), 'mm/h', null, s.rainNow >= 35 ? 'orange' : null)
                .replace('</div></div>', `</div><div class="kpi__delta">${Math.round(s.rainSoFar)} mm since T+0</div></div>`),
            kpi('Facilities affected', `${affected}/${fac.length}`, '', null, affected ? 'orange' : null)
        ].join('');
        const cs = $('opsComputeState');
        if (s.done) cs.textContent = 'model run complete';
        else if (s.computedUntil >= 0) cs.textContent = `computed to ${fmtT(s.computedUntil)}${s.buffering ? ' · waiting' : ''}`;
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

    function renderGauge(s) {
        const sc = s.scenario;
        const cv = $('opsGaugeChart');
        if (!sc || !cv.clientWidth) return;
        const { ctx, w, h } = setupCanvas(cv);
        const L = 30, R = 50, T = 8, B = 18;
        const pw = w - L - R, ph = h - T - B;
        const X = (t) => L + t / sc.tEnd * pw;

        // rain bars (hourly means)
        let rmax = 5;
        const bars = [];
        for (let hh = 0; hh < 24; hh++) {
            let sum = 0;
            for (let k = 0; k < 6; k++) sum += FloodScenarios.seriesValueAt(sc.rain, sc.tStart, (hh + k / 6) * HOUR);
            bars.push(sum / 6); rmax = Math.max(rmax, sum / 6);
        }
        rmax = Math.ceil(rmax / 10) * 10;
        ctx.fillStyle = 'rgba(90,169,214,0.28)';
        bars.forEach((v, i) => { const bh = v / rmax * ph * 0.55; ctx.fillRect(X(i * HOUR) + 1, T, pw / 24 - 2, bh); });

        // gauge line
        const pts = gaugeSeries(sc);
        const ths = sc.gauge.thresholds;
        let lo = Math.min(...ths.map(t => t.v)), hi = Math.max(...ths.map(t => t.v));
        pts.forEach(p => { lo = Math.min(lo, p[1]); hi = Math.max(hi, p[1]); });
        if (sc.gauge.kind === 'depth') lo = 0;
        const pad = (hi - lo) * 0.12 || 0.5;
        lo -= sc.gauge.kind === 'depth' ? 0 : pad; hi += pad;
        const Y = (v) => T + ph - (v - lo) / (hi - lo) * ph;

        ctx.font = '10px IBM Plex Mono, monospace';
        ths.forEach(th => {
            ctx.strokeStyle = LEVEL_COLOR[th.level];
            ctx.setLineDash([4, 3]); ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(L, Y(th.v)); ctx.lineTo(L + pw, Y(th.v)); ctx.stroke();
            ctx.setLineDash([]);
            ctx.fillStyle = LEVEL_COLOR[th.level];
            ctx.fillText(th.label.slice(0, 7), L + pw + 3, Y(th.v) + 3);
        });

        ctx.strokeStyle = '#d9e0e8'; ctx.lineWidth = 1.6;
        ctx.beginPath();
        pts.forEach((p, i) => { const x = X(p[0]), y = Y(p[1]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
        ctx.stroke();

        // axes
        ctx.fillStyle = '#748291';
        for (let hh = 0; hh <= 24; hh += 6) ctx.fillText(`${hh}h`, X(hh * HOUR) - 6, h - 4);
        ctx.fillText(`${rmax}`, 2, T + 8);
        ctx.fillText('mm/h', 2, T + 19);
        

        // cursor
        const cx = X(s.t);
        ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(cx, T); ctx.lineTo(cx, T + ph); ctx.stroke();
        let cur = null;
        if (sc.gauge.kind === 'series') cur = FloodScenarios.seriesValueAt(sc.gauge.series, sc.tStart, s.t);
        else if (s.derived) cur = s.derived.gauge;
        if (cur !== null) {
            ctx.fillStyle = '#fff';
            ctx.beginPath(); ctx.arc(cx, Y(cur), 3, 0, Math.PI * 2); ctx.fill();
            $('opsGaugeValue').textContent = `${cur.toFixed(2)} ${sc.gauge.unit}`;
        }
        $('opsGaugeLegend').innerHTML = `<span><i style="background:rgba(90,169,214,.6)"></i>rain, mm/h</span>
            <span><i style="background:#d9e0e8"></i>${esc(sc.gauge.unit)}</span>` +
            ths.map(t => `<span><i style="background:${LEVEL_COLOR[t.level]}"></i>${esc(t.label)} ${t.v.toFixed(sc.gauge.kind === 'depth' ? 1 : 2)}</span>`).join('');
    }

    function renderAxis() {
        $('opsTimelineAxis').innerHTML = [0, 3, 6, 9, 12, 15, 18, 21, 24].map(h => `<span style="left:${h / 24 * 100}%">${h}h</span>`).join('');
    }

    function renderTimeline(s) {
        const sc = s.scenario;
        const cv = $('opsTimeline');
        if (!sc || !cv.clientWidth) return;
        const { ctx, w, h } = setupCanvas(cv);
        const X = (t) => t / sc.tEnd * w;
        ctx.fillStyle = '#1a222d'; ctx.fillRect(0, 0, w, h);
        const cu = s.done ? sc.tEnd : Math.max(0, s.computedUntil);
        ctx.fillStyle = '#212c39'; ctx.fillRect(0, 0, X(cu), h);
        // rain bars
        let rmax = 1;
        const n = 96;
        const vals = [];
        for (let i = 0; i < n; i++) { const v = FloodScenarios.seriesValueAt(sc.rain, sc.tStart, (i + 0.5) / n * sc.tEnd); vals.push(v); rmax = Math.max(rmax, v); }
        ctx.fillStyle = 'rgba(90,169,214,0.55)';
        vals.forEach((v, i) => { const bh = v / rmax * (h - 14); ctx.fillRect(i / n * w + 0.5, h - 12 - bh, w / n - 1, bh); });
        // elapsed
        ctx.fillStyle = 'rgba(255,255,255,0.05)'; ctx.fillRect(0, 0, X(s.t), h);
        // events
        FloodSim.state.events.forEach(e => {
            ctx.fillStyle = LEVEL_COLOR[e.level] || '#748291';
            const x = X(e.t);
            ctx.beginPath(); ctx.moveTo(x, h - 9); ctx.lineTo(x - 4, h - 1); ctx.lineTo(x + 4, h - 1); ctx.closePath(); ctx.fill();
        });
        // playhead
        ctx.fillStyle = '#fff'; ctx.fillRect(X(s.t) - 1, 0, 2, h);
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

    // ------------------------------------------------------------ exposure lists
    function renderLists(s, force) {
        const d = s.derived;
        const key = `${FloodSim.state.runId}:${d ? d.t : -1}:${FloodSim.state.facilityCells.length}`;
        if (!force && key === lastListKey) return;
        lastListKey = key;
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
        body.innerHTML = `
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
            <div class="empty-note mono">${inspectLngLat.lat.toFixed(4)}, ${inspectLngLat.lng.toFixed(4)}</div>`;
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
        $('masterPlayBtn').addEventListener('click', () => FloodSim.toggle());

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
        tl.addEventListener('pointerdown', (e) => { dragging = true; tl.setPointerCapture(e.pointerId); seekAt(e); });
        tl.addEventListener('pointermove', (e) => { if (dragging) seekAt(e); });
        tl.addEventListener('pointerup', () => { dragging = false; });

        const slider = $('rainfallSlider');
        const setStorm = (mm, immediate) => {
            slider.value = mm;
            $('rainfallValue').textContent = `${mm} mm`;
            [...$('stormPresets').children].forEach(b => b.classList.toggle('active', Number(b.dataset.mm) === Number(mm)));
            clearTimeout(stormTimer);
            stormTimer = setTimeout(() => {
                appState.rainfallAmount = Number(mm);
                FloodSim.setStorm(Number(mm));
                if ($('btnLayerRisk')?.classList.contains('active')) updateMapVision(appState.data.villages[appState.currentVillageId]);
            }, immediate ? 0 : 350);
        };
        slider.addEventListener('input', () => setStorm(Number(slider.value)));
        $('stormPresets').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setStorm(Number(b.dataset.mm), true); });

        ['layerWater', 'layerFlow', 'layerRain', 'layerSlope'].forEach(id => {
            $(id).addEventListener('click', () => {
                const on = !$(id).classList.contains('active');
                $(id).classList.toggle('active', on);
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
            if (e.code === 'Space') { e.preventDefault(); FloodSim.toggle(); }
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
            FloodSim.on('scenario', onScenario);
            FloodSim.on('time', onTime);
            FloodSim.on('frame', () => { if (!FloodSim.state.playing) onTime(FloodSim.snapshot()); });
            FloodSim.on('done', () => renderAll(FloodSim.snapshot(), true));
            FloodSim.on('play', () => renderAll(FloodSim.snapshot()));
            FloodSim.on('error', (e) => { $('opsComputeState').textContent = e.message; });
            bindControls();
            renderAxis();
            // If the last tile request fails, MapLibre may never render again and
            // so never fire 'load' (which builds the risk/boundary layers). Nudge it.
            let loaded = false;
            map.once('load', () => { loaded = true; });
            const nudge = setInterval(() => { if (loaded) clearInterval(nudge); else map.triggerRepaint(); }, 1000);
            const mm = Number($('rainfallSlider').value);
            appState.rainfallAmount = mm;
            FloodSim.state.storm = mm;
            FloodSim.setVillage(appState.currentVillageId);
        },
        onVillageChange(id) {
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
