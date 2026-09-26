/**
 * Jal Drishti - Shared Top Navigation
 * ---------------------------------------------------------------------------
 * This is a static multi-page app (index.html / methodology.html /
 * settings.html), so "dynamic navigation" is implemented as: one canonical
 * page order, rendered into each page's existing #main-nav-links container
 * with the current page filtered out. Because the container is a flex
 * container (see .nav-links in styles.css / methodology.css) and links are
 * appended/removed rather than hidden in place, the remaining buttons
 * reflow naturally - no reserved gaps, no absolute positioning.
 *
 * Canonical order: Dashboard, Methodology, Settings.
 *   - Filter out "dashboard"   -> Methodology, Settings
 *   - Filter out "methodology" -> Dashboard, Settings
 *   - Filter out "settings"    -> Dashboard, Methodology
 * This single rule produces exactly the three required combinations without
 * hardcoding three separate link lists.
 */
(function (global) {
    'use strict';

    const PAGES = [
        { id: 'dashboard', href: 'index.html', label: 'Dashboard' },
        { id: 'methodology', href: 'methodology.html', label: 'Methodology' },
        { id: 'settings', href: 'settings.html', label: 'Settings' }
    ];

    /**
     * @param {string} containerSelector - CSS selector for the existing nav-links container
     * @param {string} currentPageId - 'dashboard' | 'methodology' | 'settings'
     * @param {string} [linkClass='nav-link'] - existing class used for each link, so hover/transition CSS applies unchanged
     */
    function renderNav(containerSelector, currentPageId, linkClass) {
        const container = document.querySelector(containerSelector);
        if (!container) return;

        const cls = linkClass || 'nav-link';
        container.innerHTML = PAGES
            .filter(p => p.id !== currentPageId)
            .map(p => `<a href="${p.href}" class="${cls}">${p.label}</a>`)
            .join('');
    }

    global.JalDrishtiNav = { renderNav, PAGES };
})(window);
