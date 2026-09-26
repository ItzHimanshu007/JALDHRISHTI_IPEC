/**
 * Jal Drishti - AI Narrative Service (central client)
 * ---------------------------------------------------------------------------
 * The ONE place in the frontend that asks Sarvam's LLM to narrate an
 * already-generated report. Mirrors voice-service.js's role for the TTS
 * pipeline: nothing else calls /api/report/narrate directly, and the
 * Sarvam key never appears in browser code.
 *
 * Callers pass a structured data object (real, already-computed values -
 * see buildFloodRiskNarrationPayload / buildDeploymentNarrationPayload in
 * enhanced.js) - never free text, never a request to "fill in" anything.
 * The backend (src/llm_service.py) enforces the same rule server-side with
 * a strict system prompt and a best-effort numeric-grounding check on the
 * result, both of which are returned here unchanged.
 */
(function (global) {
    'use strict';

    /**
     * @param {Object} structuredData - real, already-computed report fields only
     * @returns {Promise<{narrative: string, model: string, validation: {ok: boolean, flagged_numbers: string[]}} | null>}
     *   Resolves to null on failure (after showing a toast), never throws.
     */
    async function generateNarrative(structuredData) {
        if (!structuredData || Object.keys(structuredData).length === 0) {
            console.warn('[JalDrishtiNarrative] No structured data provided.');
            return null;
        }

        let response;
        try {
            response = await fetch('/api/report/narrate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ data: structuredData })
            });
        } catch (err) {
            console.error('[JalDrishtiNarrative] Request failed:', err);
            if (typeof global.showToast === 'function') {
                global.showToast('Narrative Unavailable', 'Could not reach the AI narrative service. Is the API server (main.py) running?', 'error');
            }
            return null;
        }

        if (!response.ok) {
            let detail = `HTTP ${response.status}`;
            try {
                const body = await response.json();
                detail = body.detail || detail;
            } catch (_) { /* ignore parse failure */ }
            console.error('[JalDrishtiNarrative] Service error:', detail);
            if (typeof global.showToast === 'function') {
                global.showToast('Narrative Error', detail, 'error');
            }
            return null;
        }

        return response.json();
    }

    global.JalDrishtiNarrative = { generateNarrative };
})(window);
