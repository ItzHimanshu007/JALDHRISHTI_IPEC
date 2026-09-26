"""
Jal Drishti - Sarvam LLM Report Narration Service
=============================================
Turns an already-computed, structured report (flood risk report or resource
allocation / deployment report) into a readable narrative using Sarvam's
sarvam-105b chat model.

This is a NARRATION layer, never a data source: the model only ever sees
the exact real numbers this app already computed (built by the frontend
from the same values used to build the deterministic .txt report - see
enhanced.js), and it is instructed never to invent, estimate, or alter any
of them. A field this app doesn't have for a given report is simply absent
from the JSON payload rather than sent as a placeholder for the model to
"fill in" - there is no fixed schema the model can assume, only whatever
keys are actually present.

The original deterministic report text/data is never replaced by this -
callers (reports-store.js) keep both side by side.
"""

import json
import logging
import re
from typing import Any, Dict, List

import httpx  # already a project dependency (requirements.txt)

from .config import SARVAM_CONFIG

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Strict system prompt - the core guardrail against invented facts/numbers.
# ---------------------------------------------------------------------------
STRICT_SYSTEM_PROMPT = """You are a report-writing assistant for a flood disaster-response system.

You will be given a JSON object containing REAL, already-computed data. \
Nothing in it is a placeholder, an example, or a suggestion - every value \
is a real measurement, count, or result from the system's own simulation \
and allocation engine.

You must follow these rules exactly:
1. Rewrite the JSON into a clear, professional narrative a human responder \
can read or listen to quickly - plain prose paragraphs, no markdown \
headers, no tables, no bullet symbols, so it reads naturally aloud.
2. Do NOT invent, estimate, guess, extrapolate, or materially alter any \
number, name, date, or fact that is not explicitly present in the JSON.
3. Every number you state must be traceable to a number already present \
in the JSON (you may reformat it - e.g. spell out "two hundred" for 200, \
or write "18%" for a value already given as a percentage - but you may \
not change its meaning or magnitude).
4. If a field is absent from the JSON, do not mention it and do not guess \
a value for it. Simply omit it - never write "unknown", "TBD", or a made-up \
placeholder.
5. Do not add recommendations, risk assessments, or facts beyond exactly \
what the JSON contains.
6. Keep it concise: a few short paragraphs, not an exhaustive restatement \
of every field.
7. Output only the narrative itself - no preamble like "Here is the report", \
no closing remarks."""


class LLMConfigError(Exception):
    """Raised when the Sarvam API key/config is missing."""


class LLMAPIError(Exception):
    """Raised when Sarvam's chat completion API itself returns an error."""


# ---------------------------------------------------------------------------
# Numeric grounding check - "validate the output doesn't introduce
# unsupported numerical claims, where practical". This is a best-effort
# static check (numbers can legitimately be reworded, e.g. "a fifth" for
# 20%), not a guarantee, so results are surfaced to the caller as a
# transparency flag rather than used to silently block the narrative.
# ---------------------------------------------------------------------------

_NUMBER_RE = re.compile(r'-?\d[\d,]*\.?\d*')


def _extract_numbers(value: Any) -> List[float]:
    """Recursively pulls every numeric value out of a JSON-like structure
    (including numbers embedded in strings, e.g. "45m" or "12.3mm")."""
    numbers: List[float] = []
    if isinstance(value, bool):
        return numbers
    if isinstance(value, (int, float)):
        numbers.append(float(value))
    elif isinstance(value, dict):
        for v in value.values():
            numbers.extend(_extract_numbers(v))
    elif isinstance(value, list):
        for v in value:
            numbers.extend(_extract_numbers(v))
    elif isinstance(value, str):
        for match in _NUMBER_RE.findall(value):
            try:
                numbers.append(float(match.replace(',', '')))
            except ValueError:
                pass
    return numbers


def _expand_allowed_numbers(numbers: List[float]) -> set:
    """Builds the set of numeric values the narrative may state: each real
    number plus reasonable equivalent forms of the SAME value (rounded to
    an integer, and the x100 / /100 fraction<->percentage correspondence,
    since the source data mixes both forms) - never a new number."""
    allowed = set()
    for n in numbers:
        allowed.add(round(n, 2))
        allowed.add(round(n))
        allowed.add(round(n * 100, 2))
        allowed.add(round(n / 100, 4))
    # Small numbers that show up in ordinary connective prose ("a single
    # zone", "one recommendation") rather than as a data claim.
    allowed.update({0.0, 1.0})
    return allowed


def _find_unsupported_numbers(narrative: str, allowed: set, tolerance: float = 0.02) -> List[str]:
    """Returns the distinct numeric substrings in `narrative` that don't
    correspond - within a small rounding tolerance - to any real number
    from the source data."""
    flagged: List[str] = []
    seen = set()
    for match in _NUMBER_RE.findall(narrative):
        if match in seen:
            continue
        seen.add(match)
        try:
            value = float(match.replace(',', ''))
        except ValueError:
            continue
        is_supported = any(
            abs(value - a) <= max(abs(a), 1.0) * tolerance
            for a in allowed
        )
        if not is_supported:
            flagged.append(match)
    return flagged


class SarvamLLMService:
    """Thin async client for Sarvam's Chat Completions API, scoped to one
    job: narrating already-computed report data."""

    def __init__(self):
        self.api_key = SARVAM_CONFIG["api_key"]
        self.base_url = SARVAM_CONFIG["base_url"].rstrip("/")
        self.model = SARVAM_CONFIG["chat_model"]

    def _require_key(self):
        if not self.api_key:
            raise LLMConfigError(
                "SARVAM_API_KEY is not configured on the server. "
                "Set it in your environment (see .env.example) to enable AI narrative generation."
            )

    async def narrate(self, structured_data: Dict[str, Any]) -> Dict[str, Any]:
        """
        Sends `structured_data` (already-computed, real values only, built
        by the frontend from the same fields used in the deterministic
        report) to Sarvam's chat model and returns a narrative version of
        it, plus a best-effort numeric-grounding check.
        """
        self._require_key()

        if not structured_data:
            raise ValueError("No structured report data provided.")

        payload_json = json.dumps(structured_data, ensure_ascii=False, indent=2)
        user_message = (
            "Here is the report data (JSON). Write the narrative now, "
            "following all the rules exactly.\n\n" + payload_json
        )

        async with httpx.AsyncClient(timeout=45.0) as client:
            resp = await client.post(
                f"{self.base_url}/v1/chat/completions",
                headers={
                    "api-subscription-key": self.api_key,
                    "Content-Type": "application/json",
                },
                json={
                    "model": self.model,
                    "messages": [
                        {"role": "system", "content": STRICT_SYSTEM_PROMPT},
                        {"role": "user", "content": user_message},
                    ],
                    "temperature": 0.2,  # low temperature - favor faithful restatement over creative flourish
                    # sarvam-105b spends a substantial, size-dependent chunk
                    # of its token budget on internal chain-of-thought
                    # (reasoning_content) even at reasoning_effort "low" -
                    # observed ~4,300 completion tokens total for a ~10-field
                    # input during testing (of which ~15,700 chars were
                    # reasoning, not narrative). max_tokens has to leave
                    # generous headroom after that reasoning pass, or
                    # `content` comes back empty (the actual failure mode we
                    # hit while building this). Keep the payload sent here
                    # summary-scoped (see build*NarrationPayload on the
                    # frontend) rather than the full detailed report, both to
                    # keep this bounded and because a "few short paragraphs"
                    # narrative shouldn't need the full mission-by-mission
                    # detail anyway.
                    "max_tokens": 6000,
                    "reasoning_effort": "low",
                },
            )

        if resp.status_code != 200:
            raise LLMAPIError(
                f"Sarvam chat completion failed ({resp.status_code}): {resp.text[:300]}"
            )

        data = resp.json()
        choices = data.get("choices") or []
        if not choices:
            raise LLMAPIError("Sarvam chat completion returned no choices.")

        narrative = ((choices[0].get("message") or {}).get("content") or "").strip()
        if not narrative:
            raise LLMAPIError("Sarvam chat completion returned an empty narrative.")

        allowed_numbers = _expand_allowed_numbers(_extract_numbers(structured_data))
        flagged = _find_unsupported_numbers(narrative, allowed_numbers)

        return {
            "narrative": narrative,
            "model": self.model,
            "validation": {
                "ok": len(flagged) == 0,
                "flagged_numbers": flagged,
            },
        }
