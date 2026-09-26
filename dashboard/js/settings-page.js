/**
 * Jal Drishti - Settings Page
 * ---------------------------------------------------------------------------
 * Wires up the two Settings sections:
 *  1. Voice Language  - populates the dropdown from the languages Sarvam
 *     actually supports (fetched from the backend, falling back to the
 *     local list in voice-settings.js if the backend isn't reachable), and
 *     persists the selection via VoiceSettings.setSelectedLanguage().
 *  2. Reports         - lists whatever ReportsStore already has (real
 *     reports generated from the Dashboard - never invented), and reads the
 *     selected one aloud via JalDrishtiVoice.speak() through the same
 *     text-preparation helper used for grid readings.
 */
(function () {
    'use strict';

    let selectedReportId = null;

    // ---------------------------------------------------------------
    // Voice Language section
    // ---------------------------------------------------------------
    function populateLanguageDropdown() {
        const select = document.getElementById('voiceLanguageSelect');
        if (!select) return;

        const languages = window.VoiceSettings.getLanguages();
        const current = window.VoiceSettings.getSelectedLanguage();

        select.innerHTML = languages
            .map(l => `<option value="${l.code}">${l.label}</option>`)
            .join('');
        select.value = current;

        const statusEl = document.getElementById('voiceLanguageStatus');
        if (statusEl) {
            statusEl.textContent = `Currently applied everywhere: ${window.VoiceSettings.getLanguageLabel(current)}`;
        }
    }

    async function refreshLanguagesFromBackend() {
        try {
            const res = await fetch('/api/voice/languages');
            if (!res.ok) return;
            const data = await res.json();
            if (data.languages && data.languages.length > 0) {
                window.VoiceSettings.setLanguages(data.languages);
                populateLanguageDropdown();
            }
        } catch (e) {
            // Backend not reachable (e.g. static-only dev server) - the local
            // fallback list in voice-settings.js already covers the dropdown.
            console.warn('[Settings] Could not refresh language list from backend:', e);
        }
    }

    function bindLanguageSelect() {
        const select = document.getElementById('voiceLanguageSelect');
        if (!select) return;
        select.addEventListener('change', () => {
            const ok = window.VoiceSettings.setSelectedLanguage(select.value);
            const statusEl = document.getElementById('voiceLanguageStatus');
            if (statusEl) {
                statusEl.textContent = ok
                    ? `Currently applied everywhere: ${window.VoiceSettings.getLanguageLabel(select.value)}`
                    : 'Could not save that language selection.';
            }
        });
    }

    // ---------------------------------------------------------------
    // Reports section
    // ---------------------------------------------------------------
    const TYPE_LABELS = {
        flood_risk: 'Flood Risk Report',
        deployment: 'Tactical Deployment Report'
    };

    function formatTimestamp(iso) {
        try {
            return new Date(iso).toLocaleString();
        } catch (e) {
            return iso;
        }
    }

    function renderReportsList() {
        const listEl = document.getElementById('reportsList');
        const emptyEl = document.getElementById('reportsEmptyState');
        const listenBtn = document.getElementById('btnListenToReport');
        const narrativeBtn = document.getElementById('btnGenerateNarrative');
        if (!listEl) return;

        const reports = window.ReportsStore.getAllReports();

        if (reports.length === 0) {
            listEl.innerHTML = '';
            if (emptyEl) emptyEl.hidden = false;
            if (listenBtn) listenBtn.disabled = true;
            if (narrativeBtn) narrativeBtn.disabled = true;
            selectedReportId = null;
            renderNarrativePanel(null);
            return;
        }

        if (emptyEl) emptyEl.hidden = true;

        // Keep the current selection if it still exists, else default to newest.
        if (!selectedReportId || !reports.some(r => r.id === selectedReportId)) {
            selectedReportId = reports[0].id;
        }

        listEl.innerHTML = reports.map(r => `
            <button type="button" class="report-item ${r.id === selectedReportId ? 'selected' : ''}" data-report-id="${r.id}">
                <span class="report-item-title">${escapeHtml(r.title)}</span>
                <span class="report-item-meta">${escapeHtml(TYPE_LABELS[r.type] || 'Report')} &bull; ${escapeHtml(formatTimestamp(r.createdAt))}</span>
            </button>
        `).join('');

        listEl.querySelectorAll('.report-item').forEach(btn => {
            btn.addEventListener('click', () => {
                selectedReportId = btn.getAttribute('data-report-id');
                renderReportsList();
            });
        });

        const selectedReport = reports.find(r => r.id === selectedReportId);
        if (listenBtn) listenBtn.disabled = false;
        if (narrativeBtn) {
            // Only reports saved with a structured payload can be narrated -
            // older reports from before this feature won't have one.
            narrativeBtn.disabled = !selectedReport?.structuredData;
            narrativeBtn.textContent = selectedReport?.narrative ? '✨ Regenerate AI Narrative' : '✨ Generate AI Narrative';
        }
        renderNarrativePanel(selectedReport);
    }

    /**
     * Shows the cached narrative (if any) for the given report, including
     * the numeric-grounding validation warning when the backend flagged
     * anything - see llm_service.py's _find_unsupported_numbers(). Hidden
     * entirely if this report has no narrative yet.
     */
    function renderNarrativePanel(report) {
        const panel = document.getElementById('narrativePanel');
        if (!panel) return;

        if (!report || !report.narrative) {
            panel.hidden = true;
            return;
        }

        panel.hidden = false;
        document.getElementById('narrativeText').textContent = report.narrative;
        document.getElementById('narrativeModelBadge').textContent = report.narrativeModel ? `(${report.narrativeModel})` : '';

        const warningEl = document.getElementById('narrativeValidationWarning');
        const flagged = report.narrativeValidation?.flagged_numbers || [];
        if (!report.narrativeValidation?.ok && flagged.length > 0) {
            warningEl.hidden = false;
            warningEl.textContent = `⚠ This AI narrative mentions ${flagged.length === 1 ? 'a number' : 'numbers'} ` +
                `we couldn't verify against the source data (${flagged.join(', ')}). ` +
                `The original report above is unaffected - verify this narrative before relying on it.`;
        } else {
            warningEl.hidden = true;
        }
    }

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str == null ? '' : String(str);
        return div.innerHTML;
    }

    /**
     * Strips the report's decorative ASCII borders and table rules (===,
     * ---, box-drawing runs - both whole separator lines AND inline
     * decoration like "── SECTION 1 ──" or multi-column table rule rows)
     * so Sarvam doesn't try to read punctuation runs aloud. This only
     * reformats the existing text for speech - it does not add, remove, or
     * alter any actual data in the report.
     */
    function prepareReportTextForSpeech(rawText) {
        const DECORATION_RUN = /[=\-─═_]{3,}/g;

        return rawText
            .split('\n')
            .map(line => line
                .replace(DECORATION_RUN, ' ')   // drop dash/box-drawing runs anywhere in the line
                .replace(/[│┃|]/g, ' ')          // table column separators
                .trim()
            )
            // A line made ENTIRELY of decoration (or now empty after
            // stripping it) carries no information - drop it rather than
            // leave a stray period.
            .filter(line => line.length > 0)
            .join('. ')
            .replace(/\.\s*\.+/g, '.')
            .replace(/\s{2,}/g, ' ')
            .trim();
    }

    function bindListenButton() {
        const btn = document.getElementById('btnListenToReport');
        if (!btn) return;
        btn.addEventListener('click', () => {
            if (!selectedReportId) return;
            const report = window.ReportsStore.getReportById(selectedReportId);
            if (!report) return;
            const speechText = prepareReportTextForSpeech(report.content);
            window.JalDrishtiVoice.speak(speechText);
        });
    }

    function bindListenToNarrativeButton() {
        const btn = document.getElementById('btnListenToNarrative');
        if (!btn) return;
        btn.addEventListener('click', () => {
            if (!selectedReportId) return;
            const report = window.ReportsStore.getReportById(selectedReportId);
            if (!report?.narrative) return;
            // The narrative is already plain prose (see llm_service.py's
            // system prompt: "no markdown, no bullet symbols"), but run it
            // through the same cleanup defensively in case a stray
            // decoration character slips through.
            window.JalDrishtiVoice.speak(prepareReportTextForSpeech(report.narrative));
        });
    }

    function bindGenerateNarrativeButton() {
        const btn = document.getElementById('btnGenerateNarrative');
        if (!btn) return;
        btn.addEventListener('click', async () => {
            if (!selectedReportId) return;
            const report = window.ReportsStore.getReportById(selectedReportId);
            if (!report?.structuredData) return;

            const originalLabel = btn.textContent;
            btn.disabled = true;
            btn.textContent = '✨ Generating…';

            const result = await window.JalDrishtiNarrative.generateNarrative(report.structuredData);

            btn.textContent = originalLabel;
            btn.disabled = false;

            if (!result) return; // narrative-service.js already showed an error toast

            window.ReportsStore.updateReportNarrative(report.id, {
                narrative: result.narrative,
                validation: result.validation,
                model: result.model
            });
            renderReportsList(); // re-renders the narrative panel with the new content
        });
    }

    document.addEventListener('DOMContentLoaded', () => {
        populateLanguageDropdown();
        bindLanguageSelect();
        refreshLanguagesFromBackend();

        renderReportsList();
        bindListenButton();
        bindGenerateNarrativeButton();
        bindListenToNarrativeButton();

        // Another tab/page generated a report while this page was open.
        document.addEventListener('jaldrishti:reports-changed', renderReportsList);
    });
})();
