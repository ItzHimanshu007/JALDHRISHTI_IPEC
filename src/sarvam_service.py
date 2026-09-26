"""
Jal Drishti - Sarvam AI Voice Service
=============================================
Single, central integration point for Sarvam AI's Translate and
Text-to-Speech APIs. Every voice-related frontend feature (report reading,
simulation-grid reading) goes through this one service via the
/api/voice/speak route in api_server.py - nothing calls Sarvam directly
from the browser, and the API key never leaves the server process.

Sarvam API reference used (verified against docs.sarvam.ai, not guessed):
  POST {base_url}/translate         - mayura:v1, max 1000 chars/request
  POST {base_url}/text-to-speech    - bulbul:v3, max 2500 chars/request,
                                       returns base64-encoded WAV clips.
Both endpoints share the same 11-language set: English (en-IN), Hindi,
Bengali, Tamil, Telugu, Kannada, Malayalam, Marathi, Gujarati, Punjabi,
and Odia - see SARVAM_SUPPORTED_LANGUAGES in config.py.
"""

import asyncio
import logging
from typing import List

import httpx  # already a project dependency (requirements.txt)

from .config import SARVAM_CONFIG, SARVAM_SUPPORTED_LANGUAGES

logger = logging.getLogger(__name__)

SUPPORTED_LANGUAGE_CODES = {lang["code"] for lang in SARVAM_SUPPORTED_LANGUAGES}


class SarvamConfigError(Exception):
    """Raised when the Sarvam API key/config is missing - a setup problem,
    not a runtime failure, so callers can surface a clear 503 instead of a
    generic 500."""


class SarvamAPIError(Exception):
    """Raised when Sarvam's API itself returns an error response."""


def _chunk_text(text: str, max_chars: int) -> List[str]:
    """
    Splits text into chunks no longer than max_chars, breaking on sentence/
    line boundaries where possible so playback/translation doesn't cut a
    word in half. Pure text formatting - does not alter the actual content.
    """
    text = text.strip()
    if len(text) <= max_chars:
        return [text] if text else []

    # Prefer splitting on paragraph/line breaks, then sentence boundaries.
    raw_parts = [p.strip() for p in text.replace("\r\n", "\n").split("\n") if p.strip()]
    chunks: List[str] = []
    current = ""

    def flush():
        nonlocal current
        if current.strip():
            chunks.append(current.strip())
        current = ""

    for part in raw_parts:
        # A single line/paragraph can itself exceed max_chars (long
        # sentences) - break it further on ". " boundaries.
        segments = [part] if len(part) <= max_chars else [
            s.strip() + "." for s in part.split(". ") if s.strip()
        ]
        for seg in segments:
            candidate = f"{current} {seg}".strip() if current else seg
            if len(candidate) <= max_chars:
                current = candidate
            else:
                flush()
                # A single segment longer than max_chars on its own (rare) -
                # hard-split it as a last resort.
                if len(seg) > max_chars:
                    for i in range(0, len(seg), max_chars):
                        chunks.append(seg[i:i + max_chars])
                else:
                    current = seg
    flush()
    return chunks


class SarvamService:
    """Thin async client wrapping the two Sarvam endpoints this app needs."""

    def __init__(self):
        self.api_key = SARVAM_CONFIG["api_key"]
        self.base_url = SARVAM_CONFIG["base_url"].rstrip("/")
        self.tts_model = SARVAM_CONFIG["tts_model"]
        self.translate_model = SARVAM_CONFIG["translate_model"]
        self.speaker = SARVAM_CONFIG["tts_speaker"]
        self.tts_max_chars = SARVAM_CONFIG["tts_max_chars"]
        self.translate_max_chars = SARVAM_CONFIG["translate_max_chars"]

    def _require_key(self):
        if not self.api_key:
            raise SarvamConfigError(
                "SARVAM_API_KEY is not configured on the server. "
                "Set it in your environment (see .env.example) to enable voice output."
            )

    async def translate(self, text: str, target_language_code: str) -> str:
        """Translates English text into the target language via Sarvam's
        /translate endpoint (mayura:v1), chunked to its documented 1000
        character limit, then rejoined in order."""
        self._require_key()
        chunks = _chunk_text(text, self.translate_max_chars)
        if not chunks:
            return ""

        async def translate_one(client: httpx.AsyncClient, chunk: str) -> str:
            resp = await client.post(
                f"{self.base_url}/translate",
                headers={
                    "api-subscription-key": self.api_key,
                    "Content-Type": "application/json",
                },
                json={
                    "input": chunk,
                    "source_language_code": "en-IN",
                    "target_language_code": target_language_code,
                    "model": self.translate_model,
                    "mode": "formal",
                },
            )
            if resp.status_code != 200:
                raise SarvamAPIError(
                    f"Sarvam /translate failed ({resp.status_code}): {resp.text[:300]}"
                )
            return resp.json().get("translated_text", "")

        # Chunks are independent - fire them concurrently rather than one at
        # a time. A long report can be 10+ chunks; sequential awaits could
        # take long enough to blow past a serverless platform's per-request
        # time limit (e.g. Vercel's 10s Hobby-tier default). gather()
        # preserves input order in its results, so playback order is intact.
        async with httpx.AsyncClient(timeout=30.0) as client:
            translated_parts = await asyncio.gather(*(translate_one(client, c) for c in chunks))

        return " ".join(p for p in translated_parts if p)

    async def synthesize(self, text: str, language_code: str) -> List[str]:
        """Converts text to speech via Sarvam's /text-to-speech endpoint
        (bulbul:v3), chunked to its documented 2500 character limit.
        Returns a list of base64-encoded WAV clips, in playback order -
        the frontend plays them back-to-back rather than this service
        splicing audio binaries together."""
        self._require_key()
        chunks = _chunk_text(text, self.tts_max_chars)
        if not chunks:
            return []

        async def synthesize_one(client: httpx.AsyncClient, chunk: str) -> List[str]:
            resp = await client.post(
                f"{self.base_url}/text-to-speech",
                headers={
                    "api-subscription-key": self.api_key,
                    "Content-Type": "application/json",
                },
                json={
                    "text": chunk,
                    "language_code": language_code,
                    "speaker": self.speaker,
                    "model": self.tts_model,
                },
            )
            if resp.status_code != 200:
                raise SarvamAPIError(
                    f"Sarvam /text-to-speech failed ({resp.status_code}): {resp.text[:300]}"
                )
            return resp.json().get("audios", [])

        # Same reasoning as translate(): run all chunk requests concurrently
        # so total wall-clock time stays well under serverless timeouts.
        async with httpx.AsyncClient(timeout=60.0) as client:
            results = await asyncio.gather(*(synthesize_one(client, c) for c in chunks))

        audio_clips: List[str] = []
        for clip_list in results:
            audio_clips.extend(clip_list)
        return audio_clips

    async def speak(self, text: str, language_code: str) -> dict:
        """
        Full pipeline for one piece of content: translate (only if the
        requested language isn't English - the app's source text is always
        English) then synthesize speech in the requested language.
        """
        if language_code not in SUPPORTED_LANGUAGE_CODES:
            raise ValueError(f"Unsupported language_code: {language_code}")

        was_translated = False
        speech_text = text
        if language_code != "en-IN":
            speech_text = await self.translate(text, language_code)
            was_translated = True

        audio_chunks = await self.synthesize(speech_text, language_code)

        return {
            "language_code": language_code,
            "translated": was_translated,
            "audio_format": "wav_base64",
            "audio_chunks": audio_chunks,
        }
