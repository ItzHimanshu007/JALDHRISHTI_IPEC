/**
 * Jal Drishti - Voice Settings (shared across Dashboard, Methodology, Settings)
 * ---------------------------------------------------------------------------
 * Single source of truth for the selected Sarvam AI voice language. Stored
 * in localStorage (not appState) because this is a static multi-page app -
 * each page is a full reload, so an in-memory JS object can't carry the
 * selection from Settings to the Dashboard. localStorage is the one thing
 * that's genuinely shared across all three pages on the same origin.
 *
 * The language list itself matches src/config.py's SARVAM_SUPPORTED_LANGUAGES
 * exactly (Sarvam's real translate+TTS language set - see sarvam_service.py).
 * If the backend is reachable, voice-service.js refreshes this list from
 * GET /api/voice/languages so the two never drift; this local copy is the
 * fallback used before that call resolves (or if the backend isn't running).
 */
(function (global) {
    'use strict';

    const STORAGE_KEY = 'jaldrishti_voice_language';
    const CHANGE_EVENT = 'jaldrishti:voice-language-changed';

    // Must match SARVAM_SUPPORTED_LANGUAGES in src/config.py.
    const DEFAULT_LANGUAGES = [
        { code: 'en-IN', label: 'English (India)' },
        { code: 'hi-IN', label: 'Hindi' },
        { code: 'bn-IN', label: 'Bengali' },
        { code: 'ta-IN', label: 'Tamil' },
        { code: 'te-IN', label: 'Telugu' },
        { code: 'kn-IN', label: 'Kannada' },
        { code: 'ml-IN', label: 'Malayalam' },
        { code: 'mr-IN', label: 'Marathi' },
        { code: 'gu-IN', label: 'Gujarati' },
        { code: 'pa-IN', label: 'Punjabi' },
        { code: 'od-IN', label: 'Odia' }
    ];

    let currentLanguages = DEFAULT_LANGUAGES.slice();

    function getLanguages() {
        return currentLanguages.slice();
    }

    function setLanguages(list) {
        if (Array.isArray(list) && list.length > 0) {
            currentLanguages = list;
        }
    }

    function isSupported(code) {
        return currentLanguages.some(l => l.code === code);
    }

    function getSelectedLanguage() {
        try {
            const stored = localStorage.getItem(STORAGE_KEY);
            if (stored) return stored;
        } catch (e) {
            // localStorage unavailable (private mode etc.) - fall through to default
        }
        return 'en-IN';
    }

    function setSelectedLanguage(code) {
        if (!isSupported(code)) {
            console.warn(`[VoiceSettings] Ignoring unsupported language code: ${code}`);
            return false;
        }
        try {
            localStorage.setItem(STORAGE_KEY, code);
        } catch (e) {
            console.warn('[VoiceSettings] Could not persist language selection:', e);
        }
        document.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: { code } }));
        return true;
    }

    function getLanguageLabel(code) {
        const found = currentLanguages.find(l => l.code === code);
        return found ? found.label : code;
    }

    global.VoiceSettings = {
        STORAGE_KEY,
        CHANGE_EVENT,
        getLanguages,
        setLanguages,
        isSupported,
        getSelectedLanguage,
        setSelectedLanguage,
        getLanguageLabel
    };
})(window);
