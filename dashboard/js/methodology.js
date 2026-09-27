/**
 * Jal Drishti - methodology page
 * Figure 1 (factor of safety vs slope, drawn with the model's own
 * FloodScenarios.factorOfSafety) and the contents highlight.
 */
(function () {
    'use strict';

    const SVGNS = 'http://www.w3.org/2000/svg';
    const el = (tag, attrs, parent) => {
        const n = document.createElementNS(SVGNS, tag);
        Object.entries(attrs || {}).forEach(([k, v]) => n.setAttribute(k, v));
        if (parent) parent.appendChild(n);
        return n;
    };

    // ------------------------------------------------------------ figure 1
    function drawFs() {
        const host = document.getElementById('fsChart');
        if (!host || !window.FloodScenarios) return;
        const fs = window.FloodScenarios.factorOfSafety;
        const series = [
            { key: 'dry', name: 'Dry soil', color: '#4a97c4', m: 0 },
            { key: 'sat', name: 'Saturated soil', color: '#d0782a', m: 1 }
        ];
        const X0 = 10, X1 = 60, Y1 = 3;
        const pts = [];
        for (let a = X0; a <= X1; a += 0.5) pts.push({ a, dry: fs(a, 0), sat: fs(a, 1) });
        // slope angle where each curve crosses FS = 1
        series.forEach(s => {
            s.cross = null;
            for (let i = 1; i < pts.length; i++) {
                const p0 = pts[i - 1][s.key], p1 = pts[i][s.key];
                if (p0 >= 1 && p1 < 1) { s.cross = pts[i - 1].a + 0.5 * (p0 - 1) / (p0 - p1); break; }
            }
        });

        const W = 720, H = 300, m = { l: 44, r: 104, t: 12, b: 38 };
        const pw = W - m.l - m.r, ph = H - m.t - m.b;
        const x = (a) => m.l + (a - X0) / (X1 - X0) * pw;
        const y = (v) => m.t + (1 - Math.min(v, Y1) / Y1) * ph;
        const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, 'aria-hidden': 'true' }, host);

        const grid = el('g', { class: 'grid' }, svg), axis = el('g', { class: 'axis' }, svg);
        for (let v = 0; v <= Y1; v += 0.5) {
            el('line', { x1: m.l, x2: m.l + pw, y1: y(v), y2: y(v) }, grid);
            el('text', { x: m.l - 8, y: y(v) + 4, 'text-anchor': 'end' }, axis).textContent = v.toFixed(1);
        }
        for (let a = X0; a <= X1; a += 10) {
            el('text', { x: x(a), y: m.t + ph + 18, 'text-anchor': 'middle' }, axis).textContent = a + '°';
        }
        el('text', { class: 'axis-title', x: m.l + pw / 2, y: H - 4, 'text-anchor': 'middle' }, svg).textContent = 'Slope angle';
        el('text', { class: 'axis-title', x: 12, y: m.t + ph / 2, transform: `rotate(-90 12 ${m.t + ph / 2})`, 'text-anchor': 'middle' }, svg).textContent = 'Factor of safety';

        // FS = 1 threshold
        el('line', { class: 'thr', x1: m.l, x2: m.l + pw, y1: y(1), y2: y(1), 'stroke-width': 1 }, svg);
        el('text', { class: 'thr-lbl', x: m.l + 8, y: y(1) + 16 }, svg).textContent = 'Below FS = 1 the slope fails';

        series.forEach(s => {
            const d = pts.filter(p => p[s.key] <= Y1 + 0.3).map((p, i) => `${i ? 'L' : 'M'}${x(p.a).toFixed(1)},${y(p[s.key]).toFixed(1)}`).join('');
            el('path', { d, fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, svg);
            const last = pts[pts.length - 1];
            el('text', { class: 'end-lbl', x: m.l + pw + 8, y: y(last[s.key]) + (s.key === 'dry' ? -2 : 12) }, svg).textContent = s.name;
            if (s.cross) {
                el('circle', { cx: x(s.cross), cy: y(1), r: 4.5, fill: s.color, stroke: '#121820', 'stroke-width': 2 }, svg);
                el('text', { class: 'lbl', x: x(s.cross), y: y(1) - 10, 'text-anchor': 'middle' }, svg).textContent = `${Math.round(s.cross)}°`;
            }
        });

        // hover: crosshair + tooltip
        const xh = el('line', { class: 'xh', y1: m.t, y2: m.t + ph, visibility: 'hidden' }, svg);
        const dots = series.map(s => el('circle', { r: 4, fill: s.color, stroke: '#121820', 'stroke-width': 2, visibility: 'hidden' }, svg));
        const tip = document.createElement('div');
        tip.className = 'tip'; tip.hidden = true; host.appendChild(tip);
        const hit = el('rect', { x: m.l, y: m.t, width: pw, height: ph, fill: 'transparent' }, svg);
        const move = (ev) => {
            const r = svg.getBoundingClientRect();
            const sx = (ev.clientX - r.left) / r.width * W;
            const a = Math.max(X0, Math.min(X1, X0 + (sx - m.l) / pw * (X1 - X0)));
            const p = pts[Math.round((a - X0) / 0.5)];
            xh.setAttribute('x1', x(p.a)); xh.setAttribute('x2', x(p.a)); xh.setAttribute('visibility', 'visible');
            series.forEach((s, i) => {
                const v = p[s.key];
                dots[i].setAttribute('cx', x(p.a)); dots[i].setAttribute('cy', y(v));
                dots[i].setAttribute('visibility', v <= Y1 ? 'visible' : 'hidden');
            });
            tip.innerHTML = `<div class="k">Slope ${p.a.toFixed(1)}°</div>` + series.map(s =>
                `<div><i style="background:${s.color}"></i>${s.name}: <b>${p[s.key].toFixed(2)}</b>${p[s.key] < 1 ? ' · fails' : ''}</div>`).join('');
            tip.hidden = false;
            tip.style.left = (x(p.a) / W * r.width) + 'px';
            tip.style.top = (y(Math.min(Y1, (p.dry + p.sat) / 2)) / H * r.height) + 'px';
            if (x(p.a) / W > 0.62) tip.style.transform = 'translate(calc(-100% - 12px), -50%)';
            else tip.style.transform = '';
        };
        const leave = () => { tip.hidden = true; xh.setAttribute('visibility', 'hidden'); dots.forEach(d => d.setAttribute('visibility', 'hidden')); };
        hit.addEventListener('pointermove', move);
        hit.addEventListener('pointerleave', leave);

        // text that depends on the computed crossings
        const sat = series[1].cross, dry = series[0].cross;
        if (sat && dry) {
            host.setAttribute('aria-label', `Factor of safety falls as slopes get steeper. Saturated soil drops below 1 at about ${Math.round(sat)} degrees, dry soil at about ${Math.round(dry)} degrees.`);
        }

        // values table
        const rows = [15, 20, 25, 30, 35, 40, 45, 50, 55].map(a => `<tr><td class="r">${a}°</td><td class="r">${fs(a, 0).toFixed(2)}</td><td class="r">${fs(a, 1).toFixed(2)}</td></tr>`).join('');
        const tbl = document.getElementById('fsTable');
        if (tbl) tbl.innerHTML = `<table class="tbl"><thead><tr><th class="r">Slope</th><th class="r">FS, dry</th><th class="r">FS, saturated</th></tr></thead><tbody>${rows}</tbody></table>`;
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

    document.addEventListener('DOMContentLoaded', () => { drawFs(); tocHighlight(); });
})();
