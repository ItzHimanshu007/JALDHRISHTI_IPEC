/**
 * Jal Drishti - Reports Store
 * ---------------------------------------------------------------------------
 * The existing report generation flow (generateReport() / generateTextReport()
 * for the flood-risk report, generateDeploymentReport() for the tactical
 * deployment report - both in enhanced.js) only ever built a text string in
 * memory and immediately downloaded it as a .txt file; nothing about a
 * generated report was ever retained, so there was no existing "report
 * history" to reuse.
 *
 * For the Settings > Reports section to have anything real to list, the
 * moment of generation needs to be recorded somewhere that survives a full
 * page navigation (Settings is a separate HTML page). This module is that
 * minimal addition: it does NOT change what the existing report functions
 * generate or how they download - it only saves the exact same
 * already-generated text plus real metadata (actual village name, actual
 * generation timestamp) so Settings can list and read them back.
 *
 * Nothing here invents report content; enhanced.js calls saveReport() with
 * the exact string it already built for the download.
 */
(function (global) {
    'use strict';

    const STORAGE_KEY = 'jaldrishti_reports';
    const MAX_STORED_REPORTS = 50;

    function readAll() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            const parsed = raw ? JSON.parse(raw) : [];
            return Array.isArray(parsed) ? parsed : [];
        } catch (e) {
            console.warn('[ReportsStore] Could not read stored reports:', e);
            return [];
        }
    }

    function writeAll(reports) {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(reports));
        } catch (e) {
            console.warn('[ReportsStore] Could not persist reports:', e);
        }
    }

    function makeId() {
        if (global.crypto && typeof global.crypto.randomUUID === 'function') {
            return global.crypto.randomUUID();
        }
        return `rpt_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    }

    /**
     * @param {Object} report
     * @param {string} report.type - 'flood_risk' | 'deployment' (which existing generator produced this)
     * @param {string} report.title - real, human-readable title (e.g. village name + report type)
     * @param {string} report.villageId
     * @param {string} report.content - the actual, already-generated report text (verbatim)
     * @param {Object} [report.structuredData] - the same real, already-computed values as
     *   `content`, as a plain object rather than formatted text - this is what gets sent
     *   to the AI narrative endpoint (see narrative-service.js). Optional: only reports
     *   built with a structured payload can offer "Generate AI Narrative".
     */
    function saveReport(report) {
        if (!report || !report.content || !report.content.trim()) {
            console.warn('[ReportsStore] Refusing to save an empty report.');
            return null;
        }
        const entry = {
            id: makeId(),
            type: report.type || 'report',
            title: report.title || 'Jal Drishti Report',
            villageId: report.villageId || null,
            villageName: report.villageName || null,
            createdAt: report.createdAt || new Date().toISOString(),
            content: report.content,
            structuredData: report.structuredData || null,
            // Populated later by updateReportNarrative() once/if the user
            // asks for an AI narrative - the original `content` above is
            // never touched or replaced.
            narrative: null,
            narrativeValidation: null,
            narrativeModel: null
        };

        const all = readAll();
        all.unshift(entry); // newest first
        if (all.length > MAX_STORED_REPORTS) all.length = MAX_STORED_REPORTS;
        writeAll(all);
        document.dispatchEvent(new CustomEvent('jaldrishti:reports-changed'));
        return entry;
    }

    function getAllReports() {
        return readAll();
    }

    function getReportById(id) {
        return readAll().find(r => r.id === id) || null;
    }

    /**
     * Caches a generated AI narrative onto an existing report entry, so it
     * doesn't have to be re-generated (and re-billed) every time the user
     * revisits Settings. The original deterministic `content` is untouched -
     * this only adds fields alongside it.
     */
    function updateReportNarrative(id, { narrative, validation, model }) {
        const all = readAll();
        const entry = all.find(r => r.id === id);
        if (!entry) return null;
        entry.narrative = narrative;
        entry.narrativeValidation = validation || null;
        entry.narrativeModel = model || null;
        writeAll(all);
        document.dispatchEvent(new CustomEvent('jaldrishti:reports-changed'));
        return entry;
    }

    global.ReportsStore = { saveReport, getAllReports, getReportById, updateReportNarrative };
})(window);
