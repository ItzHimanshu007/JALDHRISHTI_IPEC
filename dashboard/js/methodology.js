/**
 * Jal Drishti - methodology note
 * Figure 2: factor of safety against slope, drawn with the model's own
 *           FloodScenarios.factorOfSafety.
 * Figure 3: flooded area through the storm in each area, from the model runs
 *           used by the dashboard (hourly output of flood-sim-solver.js,
 *           Meppadi 400 mm, Darbhanga and Dhemaji 200 mm).
 * Plus the contents highlight.
 */
(function () {
    'use strict';

    const SVGNS = 'http://www.w3.org/2000/svg';
    const BLUE = '#2f6f9f', ORANGE = '#b85a24';
    const el = (tag, attrs, parent) => {
        const n = document.createElementNS(SVGNS, tag);
        Object.entries(attrs || {}).forEach(([k, v]) => n.setAttribute(k, v));
        if (parent) parent.appendChild(n);
        return n;
    };
    const txt = (node, s) => { node.textContent = s; return node; };

    // hourly model output inside each boundary: flooded area (km², water > 0.10 m above
    // the T+0 level) and floodwater volume (million m³), T+0 ... T+24 h
    const RESULTS = [
        {
            name: 'Meppadi', storm: '400 mm',
            area: [0, 0.5, 7.7, 10.8, 11.9, 12.7, 13.0, 14.4, 13.7, 13.6, 13.4, 13.3, 13.6, 13.7, 13.4, 13.5, 13.8, 13.7, 13.4, 13.7, 13.8, 13.7, 13.4, 13.8, 13.8],
            vol: [0, 1.38, 3.18, 4.8, 6.22, 7.22, 7.86, 10.75, 9.61, 8.98, 8.81, 8.76, 8.87, 8.97, 8.91, 8.89, 9.03, 9.05, 8.95, 8.97, 9.11, 9.08, 8.97, 9.04, 9.15],
            events: [[6.8, 'Slope failures']]
        },
        {
            name: 'Darbhanga', storm: '200 mm',
            area: [0, 0, 0, 2.4, 6.2, 18.3, 23.1, 27.9, 37.8, 57.9, 84.6, 117.6, 162, 220.2, 286.7, 355.3, 420.9, 472.3, 524.5, 570.3, 608.3, 636.0, 665.9, 694.2, 719.6],
            vol: [0, 0.69, 1.44, 3.99, 11.15, 21.84, 32.61, 45.48, 60.2, 75.8, 92.0, 110.9, 132.0, 152.9, 174.2, 196.4, 218.5, 239.6, 260.9, 283.2, 305.3, 326.8, 349.3, 372.4, 394.9],
            events: [[5.6, 'Breach'], [8.6, 'Breach'], [12.7, 'Town-side breach']]
        },
        {
            name: 'Dhemaji', storm: '200 mm',
            area: [0, 8.5, 27.7, 55.6, 83.0, 106.0, 133.7, 173.5, 214.0, 242.3, 274.7, 308.8, 344.6, 377.4, 405.5, 429.0, 457.3, 478.6, 505.8, 532.8, 562.7, 593.4, 622.4, 648.6, 677.7],
            vol: [0, 4.36, 11.4, 24.36, 40.62, 56.5, 74.0, 95.4, 116.8, 137.6, 159.1, 181.3, 203.9, 227.8, 253.1, 278.8, 304.3, 330.5, 357.7, 383.8, 408.7, 433.9, 458.7, 481.7, 503.7],
            events: [[3.7, 'Flash surges'], [10, 'Brahmaputra above danger']]
        }
    ];

    function niceMax(v) {
        const p = Math.pow(10, Math.floor(Math.log10(v)));
        for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
        return 10 * p;
    }
    const fmt = (v) => v >= 100 ? Math.round(v).toLocaleString('en-IN') : (v >= 10 ? v.toFixed(1) : v.toFixed(2));

    function tooltip(host) {
        const tip = document.createElement('div');
        tip.className = 'tip'; tip.hidden = true; host.appendChild(tip);
        return tip;
    }

    // ------------------------------------------------------------ figure 2
    function drawFs() {
        const host = document.getElementById('fsChart');
        if (!host || !window.FloodScenarios) return;
        const fs = window.FloodScenarios.factorOfSafety;
        const series = [
            { key: 'dry', name: 'Dry soil', color: BLUE },
            { key: 'sat', name: 'Saturated soil', color: ORANGE }
        ];
        const X0 = 10, X1 = 60, Y1 = 3;
        const pts = [];
        for (let a = X0; a <= X1; a += 0.5) pts.push({ a, dry: fs(a, 0), sat: fs(a, 1) });
        series.forEach(s => {
            s.cross = null;
            for (let i = 1; i < pts.length; i++) {
                const p0 = pts[i - 1][s.key], p1 = pts[i][s.key];
                if (p0 >= 1 && p1 < 1) { s.cross = pts[i - 1].a + 0.5 * (p0 - 1) / (p0 - p1); break; }
            }
        });

        const W = 700, H = 290, m = { l: 44, r: 100, t: 10, b: 40 };
        const pw = W - m.l - m.r, ph = H - m.t - m.b;
        const x = (a) => m.l + (a - X0) / (X1 - X0) * pw;
        const y = (v) => m.t + (1 - Math.min(v, Y1) / Y1) * ph;
        const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, 'aria-hidden': 'true' }, host);
        const grid = el('g', { class: 'grid' }, svg), axis = el('g', { class: 'axis' }, svg);
        for (let v = 0; v <= Y1; v += 0.5) {
            el('line', { x1: m.l, x2: m.l + pw, y1: y(v), y2: y(v) }, grid);
            txt(el('text', { x: m.l - 8, y: y(v) + 4, 'text-anchor': 'end' }, axis), v.toFixed(1));
        }
        for (let a = X0; a <= X1; a += 10) txt(el('text', { x: x(a), y: m.t + ph + 18, 'text-anchor': 'middle' }, axis), a + '°');
        txt(el('text', { class: 'axis-title', x: m.l + pw / 2, y: H - 4, 'text-anchor': 'middle' }, svg), 'Slope angle');
        txt(el('text', { class: 'axis-title', x: 12, y: m.t + ph / 2, transform: `rotate(-90 12 ${m.t + ph / 2})`, 'text-anchor': 'middle' }, svg), 'Factor of safety');
        el('line', { class: 'thr', x1: m.l, x2: m.l + pw, y1: y(1), y2: y(1) }, svg);
        txt(el('text', { class: 'thr-lbl', x: m.l + 8, y: y(1) + 16 }, svg), 'Below 1 the slope fails');

        series.forEach(s => {
            const d = pts.filter(p => p[s.key] <= Y1 + 0.3).map((p, i) => `${i ? 'L' : 'M'}${x(p.a).toFixed(1)},${y(p[s.key]).toFixed(1)}`).join('');
            el('path', { d, fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, svg);
            const last = pts[pts.length - 1];
            txt(el('text', { class: 'end-lbl', x: m.l + pw + 8, y: y(last[s.key]) + (s.key === 'dry' ? -3 : 12) }, svg), s.name);
            if (s.cross) {
                el('circle', { cx: x(s.cross), cy: y(1), r: 4.5, fill: s.color, stroke: '#fcfbf8', 'stroke-width': 2 }, svg);
                txt(el('text', { class: 'lbl', x: x(s.cross), y: y(1) - 10, 'text-anchor': 'middle' }, svg), `${Math.round(s.cross)}°`);
            }
        });

        const xh = el('line', { class: 'xh', y1: m.t, y2: m.t + ph, visibility: 'hidden' }, svg);
        const dots = series.map(s => el('circle', { r: 4, fill: s.color, stroke: '#fcfbf8', 'stroke-width': 2, visibility: 'hidden' }, svg));
        const tip = tooltip(host);
        const hit = el('rect', { x: m.l, y: m.t, width: pw, height: ph, fill: 'transparent' }, svg);
        hit.addEventListener('pointermove', (ev) => {
            const r = svg.getBoundingClientRect();
            const a = Math.max(X0, Math.min(X1, X0 + ((ev.clientX - r.left) / r.width * W - m.l) / pw * (X1 - X0)));
            const p = pts[Math.round((a - X0) / 0.5)];
            xh.setAttribute('x1', x(p.a)); xh.setAttribute('x2', x(p.a)); xh.setAttribute('visibility', 'visible');
            series.forEach((s, i) => {
                dots[i].setAttribute('cx', x(p.a)); dots[i].setAttribute('cy', y(p[s.key]));
                dots[i].setAttribute('visibility', p[s.key] <= Y1 ? 'visible' : 'hidden');
            });
            tip.innerHTML = `<div class="k">Slope ${p.a.toFixed(1)}°</div>` + series.map(s =>
                `<div><i style="background:${s.color}"></i>${s.name}: <b>${p[s.key].toFixed(2)}</b>${p[s.key] < 1 ? ', fails' : ''}</div>`).join('');
            tip.hidden = false;
            tip.style.left = (x(p.a) / W * r.width) + 'px';
            tip.style.top = (y(Math.min(Y1, (p.dry + p.sat) / 2)) / H * r.height) + 'px';
            tip.style.transform = x(p.a) / W > 0.6 ? 'translate(calc(-100% - 12px), -50%)' : '';
        });
        hit.addEventListener('pointerleave', () => { tip.hidden = true; xh.setAttribute('visibility', 'hidden'); dots.forEach(d => d.setAttribute('visibility', 'hidden')); });

        const rows = [15, 20, 25, 30, 35, 40, 45, 50, 55].map(a => `<tr><td class="r">${a}°</td><td class="r">${fs(a, 0).toFixed(2)}</td><td class="r">${fs(a, 1).toFixed(2)}</td></tr>`).join('');
        const tbl = document.getElementById('fsTable');
        if (tbl) tbl.innerHTML = `<table class="tbl"><thead><tr><th class="r">Slope</th><th class="r">Dry</th><th class="r">Saturated</th></tr></thead><tbody>${rows}</tbody></table>`;
    }

    // ------------------------------------------------------------ figure 3
    function drawResults() {
        const host = document.getElementById('resultsChart');
        if (!host) return;
        RESULTS.forEach(res => {
            const cell = document.createElement('div');
            host.appendChild(cell);
            const W = 240, H = 200, m = { l: 36, r: 10, t: 40, b: 26 };
            const pw = W - m.l - m.r, ph = H - m.t - m.b;
            const ymax = niceMax(Math.max(...res.area) * 1.05);
            const x = (h) => m.l + h / 24 * pw;
            const y = (v) => m.t + (1 - v / ymax) * ph;
            const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img',
                'aria-label': `${res.name}: flooded area reaches ${fmt(res.area[24])} square kilometres by T+24 hours.` }, cell);
            txt(el('text', { class: 'panel-title', x: 0, y: 14 }, svg), res.name);
            txt(el('text', { class: 'panel-sub', x: 0, y: 30 }, svg), `km² flooded, ${res.storm} storm`);
            const grid = el('g', { class: 'grid' }, svg), axis = el('g', { class: 'axis' }, svg);
            [0, 0.5, 1].forEach(f => {
                el('line', { x1: m.l, x2: m.l + pw, y1: y(ymax * f), y2: y(ymax * f) }, grid);
                txt(el('text', { x: m.l - 6, y: y(ymax * f) + 4, 'text-anchor': 'end' }, axis), fmt(ymax * f).replace(/\.0+$/, ''));
            });
            [0, 6, 12, 18, 24].forEach(h => txt(el('text', { x: x(h), y: m.t + ph + 16, 'text-anchor': 'middle' }, axis), h + ' h'));
            // events
            res.events.forEach(([h, label], k) => {
                el('line', { class: 'ev-line', x1: x(h), x2: x(h), y1: m.t - 2, y2: m.t + ph }, svg);
                if (k === 0 || h - res.events[k - 1][0] > 2.5) {
                    txt(el('text', { class: 'ev-lbl', x: x(h) + 3, y: m.t + 8 + (k % 2) * 12 }, svg), label.length > 14 ? label.split(' ')[0] : label);
                }
            });
            const line = res.area.map((v, h) => `${h ? 'L' : 'M'}${x(h).toFixed(1)},${y(v).toFixed(1)}`).join('');
            el('path', { d: `${line}L${x(24)},${y(0)}L${x(0)},${y(0)}Z`, fill: BLUE, 'fill-opacity': 0.1 }, svg);
            el('path', { d: line, fill: 'none', stroke: BLUE, 'stroke-width': 2, 'stroke-linejoin': 'round' }, svg);
            el('circle', { cx: x(24), cy: y(res.area[24]), r: 3.5, fill: BLUE }, svg);

            const xh = el('line', { class: 'xh', y1: m.t, y2: m.t + ph, visibility: 'hidden' }, svg);
            const dot = el('circle', { r: 4, fill: BLUE, stroke: '#fcfbf8', 'stroke-width': 2, visibility: 'hidden' }, svg);
            const tip = tooltip(cell);
            const hit = el('rect', { x: m.l, y: m.t, width: pw, height: ph, fill: 'transparent' }, svg);
            hit.addEventListener('pointermove', (ev) => {
                const r = svg.getBoundingClientRect();
                const h = Math.max(0, Math.min(24, Math.round(((ev.clientX - r.left) / r.width * W - m.l) / pw * 24)));
                xh.setAttribute('x1', x(h)); xh.setAttribute('x2', x(h)); xh.setAttribute('visibility', 'visible');
                dot.setAttribute('cx', x(h)); dot.setAttribute('cy', y(res.area[h])); dot.setAttribute('visibility', 'visible');
                tip.innerHTML = `<div class="k">T+${h} h</div><div><b>${fmt(res.area[h])}</b> km² flooded</div><div>${fmt(res.vol[h])} million m³</div>`;
                tip.hidden = false;
                tip.style.left = (x(h) / W * r.width) + 'px';
                tip.style.top = (y(res.area[h]) / H * r.height) + 'px';
                tip.style.transform = x(h) / W > 0.55 ? 'translate(calc(-100% - 12px), -50%)' : '';
            });
            hit.addEventListener('pointerleave', () => { tip.hidden = true; xh.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); });
        });

        const tbl = document.getElementById('resultsTable');
        if (tbl) {
            const hours = [0, 3, 6, 9, 12, 15, 18, 21, 24];
            tbl.innerHTML = `<table class="tbl"><thead><tr><th>Hour</th>${RESULTS.map(r => `<th class="r">${r.name}, km²</th><th class="r">million m³</th>`).join('')}</tr></thead><tbody>` +
                hours.map(h => `<tr><td>T+${h}</td>${RESULTS.map(r => `<td class="r">${fmt(r.area[h])}</td><td class="r">${fmt(r.vol[h])}</td>`).join('')}</tr>`).join('') + '</tbody></table>';
        }
    }

    // ------------------------------------------------------------ contents highlight
    function tocHighlight() {
        const links = [...document.querySelectorAll('.toc a')];
        const byId = new Map(links.map(a => [a.getAttribute('href').slice(1), a]));
        const secs = [...document.querySelectorAll('main section[id]')];
        if (!('IntersectionObserver' in window) || !secs.length) return;
        const visible = new Set();
        const io = new IntersectionObserver((entries) => {
            entries.forEach(e => { if (e.isIntersecting) visible.add(e.target.id); else visible.delete(e.target.id); });
            const cur = secs.find(s => visible.has(s.id));
            links.forEach(a => a.classList.remove('is-current'));
            if (cur && byId.get(cur.id)) byId.get(cur.id).classList.add('is-current');
        }, { rootMargin: '-60px 0px -60% 0px' });
        secs.forEach(s => io.observe(s));
    }

    document.addEventListener('DOMContentLoaded', () => { drawFs(); drawResults(); tocHighlight(); });
})();
