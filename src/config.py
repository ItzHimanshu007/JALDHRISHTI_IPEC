"""
Jal Drishti - Configuration Module
====================================
Central configuration for all backend services, paths, and constants.
"""

import os
from pathlib import Path
from dotenv import load_dotenv

# Loads .env (if present) into the process environment *before* any of the
# os.getenv() calls below run - this is what makes "copy .env.example to
# .env and fill in your key" actually work. Previously nothing in this app
# loaded .env automatically, so a real key pasted there was silently
# ignored unless exported in the shell by hand.
load_dotenv(Path(__file__).resolve().parent.parent / ".env")

# =============================================
# Path Configuration
# =============================================

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "dashboard" / "data"
RAW_DATA_DIR = DATA_DIR / "raw"
PROCESSED_DATA_DIR = DATA_DIR / "processed"
OUTPUT_DIR = BASE_DIR / "output"

# =============================================
# Village Configuration
# =============================================

VILLAGES = {
    "wayanad_meppadi": {
        "name": "Meppadi",
        "state": "Kerala",
        "district": "Wayanad",
        "terrain_type": "hilly_ghats",
        # Centre derived from OSM relation 11312337 (Meppadi Grama Panchayat, admin_level=8)
        "coordinates": {"lat": 11.5378, "lon": 76.1324},
        # Real bounding box from OSM — replaces old hand-drawn approximate rectangle
        "bbox": [76.0646, 11.4514, 76.2002, 11.6241],
        "population": 50000,
        "dem_source": "SRTM_30m",
        "boundary_file": "wayanad_meppadi_boundary.geojson",
        "buildings_file": "wayanad_meppadi_buildings.geojson",
    },
    "darbhanga": {
        "name": "Darbhanga",
        "state": "Bihar",
        "district": "Darbhanga",
        "terrain_type": "riverine_plain",
        # Centre derived from OSM relation 1568263 (Darbhanga District, admin_level=6)
        "coordinates": {"lat": 26.0830, "lon": 86.0464},
        # Real bounding box from OSM — replaces old hand-drawn approximate rectangle
        "bbox": [85.6767, 25.7196, 86.4161, 26.4464],
        "population": 100000,
        "dem_source": "SRTM_30m",
        "boundary_file": "darbhanga_boundary.geojson",
        "buildings_file": "darbhanga_buildings.geojson",
    },
    "dhemaji": {
        "name": "Dhemaji",
        "state": "Assam",
        "district": "Dhemaji",
        "terrain_type": "brahmaputra_floodplain",
        # Centre derived from OSM relation 2026407 (Dhemaji District, admin_level=6)
        "coordinates": {"lat": 27.5947, "lon": 94.8632},
        # Real bounding box from OSM — replaces old hand-drawn approximate rectangle
        "bbox": [94.2110, 27.3097, 95.5153, 27.8797],
        "population": 75000,
        "dem_source": "SRTM_30m",
        "boundary_file": "dhemaji_boundary.geojson",
        "buildings_file": "dhemaji_buildings.geojson",
    },
}

# =============================================
# Simulation Parameters
# =============================================

SIMULATION = {
    "grid_resolution_m": 40,
    "time_steps_hours": [0, 4, 8, 12, 16, 20, 24],
    "default_rainfall_mm": 50,
    "max_rainfall_mm": 500,
    "risk_thresholds": {
        "low": 0.0,
        "medium": 0.30,
        "high": 0.50,
        "extreme": 0.70,
    },
    "pathfinding": {
        "danger_threshold": 0.70,
        "risk_weight_multiplier": 25,
        "max_safe_havens": 5,
    },
}

# =============================================
# API Configuration
# =============================================

API_CONFIG = {
    "host": os.getenv("API_HOST", "0.0.0.0"),
    "port": int(os.getenv("API_PORT", "8000")),
    "cors_origins": [
        "http://localhost:8000",
        "http://localhost:8001",
        "*",  # Allow all origins in production (served from same domain)
    ],
    "rate_limit": 100,  # requests per minute
}

# =============================================
# Weather API
# =============================================

WEATHER_API = {
    "provider": "open-meteo",
    "base_url": "https://api.open-meteo.com/v1/forecast",
    "forecast_days": 7,
    "cache_ttl_seconds": 600,
}

# =============================================
# Model Configuration
# =============================================

MODEL_CONFIG = {
    "risk_scorer": {
        "version": "v2.1",
        "weights": {
            "water_depth": 0.40,
            "slope": 0.25,
            "flow_accumulation": 0.25,
            "proximity": 0.10,
        },
        "accuracy": 0.92,
    },
    "population_clustering": {
        "method": "DBSCAN",
        "eps_km": 0.5,
        "min_samples": 10,
    },
}

# =============================================
# Sarvam AI Voice Configuration
# =============================================
# Credentials are read from the environment only - never hardcode a real key
# here. Copy .env.example to .env and set SARVAM_API_KEY, or export it in
# your shell/deployment environment. See src/sarvam_service.py for the
# client that uses this config.
SARVAM_CONFIG = {
    "api_key": os.getenv("SARVAM_API_KEY", ""),
    "base_url": os.getenv("SARVAM_BASE_URL", "https://api.sarvam.ai"),
    "tts_model": os.getenv("SARVAM_TTS_MODEL", "bulbul:v3"),
    "translate_model": os.getenv("SARVAM_TRANSLATE_MODEL", "mayura:v1"),
    # Sarvam speaker names are lowercase (verified live against the API -
    # "Shubh" 400s, "shubh" works).
    "tts_speaker": os.getenv("SARVAM_TTS_SPEAKER", "shubh"),
    # Real limits from Sarvam's documented API (bulbul:v3 / mayura:v1) -
    # not arbitrary guesses. Text longer than these is chunked before sending.
    "tts_max_chars": 2500,
    "translate_max_chars": 1000,
    # Chat model used only to turn already-computed report data into a
    # narrative (src/llm_service.py) - never a data source itself.
    "chat_model": os.getenv("SARVAM_CHAT_MODEL", "sarvam-105b"),
}

# Sarvam's actually-supported languages for both /translate (mayura:v1) and
# /text-to-speech (bulbul:v3) - the intersection of the two, since a voice
# selection must work for both pipelines. Do not add a language here unless
# it is confirmed supported by both Sarvam endpoints.
SARVAM_SUPPORTED_LANGUAGES = [
    {"code": "en-IN", "label": "English (India)"},
    {"code": "hi-IN", "label": "Hindi"},
    {"code": "bn-IN", "label": "Bengali"},
    {"code": "ta-IN", "label": "Tamil"},
    {"code": "te-IN", "label": "Telugu"},
    {"code": "kn-IN", "label": "Kannada"},
    {"code": "ml-IN", "label": "Malayalam"},
    {"code": "mr-IN", "label": "Marathi"},
    {"code": "gu-IN", "label": "Gujarati"},
    {"code": "pa-IN", "label": "Punjabi"},
    {"code": "od-IN", "label": "Odia"},
]

# =============================================
# Logging
# =============================================

LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO")
LOG_FORMAT = "%(asctime)s | %(levelname)-8s | %(name)s | %(message)s"
