/**
 * Jal Drishti - Sarvam Voice Service (central client)
 * ---------------------------------------------------------------------------
 * The ONE place in the frontend that talks to the Sarvam voice pipeline.
 * Everything else (grid-click reading in enhanced.js, report reading in
 * settings-page.js) calls JalDrishtiVoice.speak(text) - nothing calls the
 * backend /api/voice/* routes directly, and the Sarvam API key never
 * appears in browser code (it lives server-side in src/sarvam_service.py).
 *
 * Data flow (matches the architecture requested):
 *   Voice Settings (selected language, voice-settings.js)
 *        -> JalDrishtiVoice.speak(text)
 *        -> POST /api/voice/speak { text, language_code }   [src/api_server.py]
 *        -> Sarvam translate (if needed) + text-to-speech    [src/sarvam_service.py]
 *        -> base64 WAV chunks
 *        -> played back sequentially through one <audio> element
 *
 * Concurrency: only one utterance may play at a time. Calling speak() again
 * cancels any in-flight request and stops any currently-playing audio before
 * starting the new one, so rapid grid re-selection never overlaps audio.
 */
(function (global) {
    'use strict';

    let currentRequestToken = 0;
    let currentAbortController = null;
    let audioEl = null;
    let audioQueue = [];
    let indicatorEl = null;
    let indicatorTextEl = null;

    function getAudioEl() {
        if (!audioEl) {
            audioEl = new Audio();
            audioEl.addEventListener('ended', playNextInQueue);
        }
        return audioEl;
    }

    function ensureIndicator() {
        if (indicatorEl) return;
        indicatorEl = document.createElement('div');
        indicatorEl.id = 'jdVoiceIndicator';
        indicatorEl.className = 'jd-voice-indicator';
        indicatorEl.hidden = true;
        indicatorEl.innerHTML = '<span class="jd-voice-dot"></span><span id="jdVoiceIndicatorText">Speaking…</span>';
        document.body.appendChild(indicatorEl);
        indicatorTextEl = indicatorEl.querySelector('#jdVoiceIndicatorText');
    }

    function showIndicator(text) {
        ensureIndicator();
        if (indicatorTextEl) indicatorTextEl.textContent = text;
        indicatorEl.hidden = false;
    }

    function hideIndicator() {
        if (indicatorEl) indicatorEl.hidden = true;
    }

    function playNextInQueue() {
        const el = getAudioEl();
        if (audioQueue.length === 0) {
            hideIndicator();
            return;
        }
        const nextBase64 = audioQueue.shift();
        el.src = `data:audio/wav;base64,${nextBase64}`;
        el.play().catch(err => {
            console.warn('[JalDrishtiVoice] Playback failed:', err);
            hideIndicator();
        });
    }

    /** Stops any current playback and discards any queued/in-flight speech. */
    function stop() {
        currentRequestToken++; // invalidates any in-flight fetch's response
        if (currentAbortController) {
            currentAbortController.abort();
            currentAbortController = null;
        }
        audioQueue = [];
        if (audioEl) {
            audioEl.pause();
            audioEl.removeAttribute('src');
        }
        hideIndicator();
    }

    /**
     * Speaks `text` (always English source content) in the language
     * currently selected in Settings. Cancels any previous speech first, so
     * only the most recently requested utterance ever plays.
     */
    async function speak(text) {
        stop(); // cancel whatever was playing/in-flight before starting this one
        const myToken = ++currentRequestToken;

        const cleanText = (text || '').trim();
        if (!cleanText) return;

        const languageCode = (global.VoiceSettings && global.VoiceSettings.getSelectedLanguage())
            ? global.VoiceSettings.getSelectedLanguage()
            : 'en-IN';

        currentAbortController = new AbortController();
        showIndicator('Generating voice…');

        let response;
        try {
            response = await fetch('/api/voice/speak', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: cleanText, language_code: languageCode }),
                signal: currentAbortController.signal
            });
        } catch (err) {
            if (myToken !== currentRequestToken) return; // superseded, stay silent
            hideIndicator();
            if (err.name === 'AbortError') return; // cancelled by a newer speak() call
            console.error('[JalDrishtiVoice] Voice request failed:', err);
            if (typeof global.showToast === 'function') {
                global.showToast('Voice Unavailable', 'Could not reach the voice service. Is the API server (main.py) running?', 'error');
            }
            return;
        }

        if (myToken !== currentRequestToken) return; // a newer speak() call has since started

        if (!response.ok) {
            hideIndicator();
            let detail = `HTTP ${response.status}`;
            try {
                const body = await response.json();
                detail = body.detail || detail;
            } catch (_) { /* ignore parse failure */ }
            console.error('[JalDrishtiVoice] Voice service error:', detail);
            if (typeof global.showToast === 'function') {
                global.showToast('Voice Error', detail, 'error');
            }
            return;
        }

        const data = await response.json();
        if (myToken !== currentRequestToken) return; // superseded while awaiting JSON

        if (!data.audio_chunks || data.audio_chunks.length === 0) {
            hideIndicator();
            return;
        }

        audioQueue = data.audio_chunks.slice();
        showIndicator('🔊 Speaking…');
        playNextInQueue();
    }

    global.JalDrishtiVoice = { speak, stop };
})(window);
