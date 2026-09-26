"""
Jal Drishti - Shared Utilities
================================
Common utility functions used across the backend modules.
"""

import json
import logging
import time
from functools import wraps
from pathlib import Path
from typing import Tuple, List, Dict, Any

import numpy as np

logger = logging.getLogger(__name__)


# =============================================
# Coordinate Utilities
# =============================================

def haversine_distance(coord1: Tuple[float, float], coord2: Tuple[float, float]) -> float:
    """
    Calculate the great-circle distance between two points on Earth.

    Parameters
    ----------
    coord1, coord2 : tuple of (lat, lon) in degrees

    Returns
    -------
    float
        Distance in meters
    """
    R = 6371000  # Earth radius in meters
    lat1, lon1 = np.radians(coord1)
    lat2, lon2 = np.radians(coord2)

    dlat = lat2 - lat1
    dlon = lon2 - lon1

    a = np.sin(dlat / 2) ** 2 + np.cos(lat1) * np.cos(lat2) * np.sin(dlon / 2) ** 2
    c = 2 * np.arctan2(np.sqrt(a), np.sqrt(1 - a))
    return R * c


def bbox_to_polygon(bbox: Tuple[float, float, float, float]) -> List[List[float]]:
    """
    Convert a bounding box to a polygon coordinate ring.

    Parameters
    ----------
    bbox : tuple
        (min_lon, min_lat, max_lon, max_lat)

    Returns
    -------
    list
        Polygon ring [[lon, lat], ...]
    """
    min_lon, min_lat, max_lon, max_lat = bbox
    return [
        [min_lon, min_lat],
        [max_lon, min_lat],
        [max_lon, max_lat],
        [min_lon, max_lat],
        [min_lon, min_lat],
    ]


def latlon_to_grid(lat: float, lon: float, bbox: Tuple, grid_size: int) -> Tuple[int, int]:
    """
    Convert lat/lon to grid cell indices.
    """
    min_lon, min_lat, max_lon, max_lat = bbox
    col = int((lon - min_lon) / (max_lon - min_lon) * grid_size)
    row = int((lat - min_lat) / (max_lat - min_lat) * grid_size)
    return (
        max(0, min(grid_size - 1, row)),
        max(0, min(grid_size - 1, col)),
    )


def grid_to_latlon(row: int, col: int, bbox: Tuple, grid_size: int) -> Tuple[float, float]:
    """
    Convert grid cell indices to lat/lon (cell center).
    """
    min_lon, min_lat, max_lon, max_lat = bbox
    lat = min_lat + (row + 0.5) / grid_size * (max_lat - min_lat)
    lon = min_lon + (col + 0.5) / grid_size * (max_lon - min_lon)
    return (lat, lon)


# =============================================
# GeoJSON Utilities
# =============================================

def create_feature(geometry_type: str, coordinates, properties: Dict = None) -> Dict:
    """Create a GeoJSON Feature."""
    return {
        "type": "Feature",
        "geometry": {
            "type": geometry_type,
            "coordinates": coordinates,
        },
        "properties": properties or {},
    }


def create_feature_collection(features: List[Dict]) -> Dict:
    """Create a GeoJSON FeatureCollection."""
    return {
        "type": "FeatureCollection",
        "features": features,
    }


def save_geojson(data: Dict, output_path: str):
    """Save a GeoJSON object to file."""
    path = Path(output_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        json.dump(data, f, indent=2)
    logger.info(f"Saved GeoJSON to {path} ({len(data.get('features', []))} features)")


# =============================================
# Performance Utilities
# =============================================

def timer(func):
    """Decorator to log function execution time."""
    @wraps(func)
    def wrapper(*args, **kwargs):
        start = time.perf_counter()
        result = func(*args, **kwargs)
        elapsed = time.perf_counter() - start
        logger.debug(f"{func.__name__} executed in {elapsed:.3f}s")
        return result
    return wrapper


def chunk_list(lst: List, chunk_size: int) -> List[List]:
    """Split a list into chunks of given size."""
    return [lst[i : i + chunk_size] for i in range(0, len(lst), chunk_size)]


# =============================================
# Risk Score Utilities
# =============================================

def classify_risk_label(score: float) -> str:
    """Convert numeric risk score (0-1) to label."""
    if score >= 0.70:
        return "extreme"
    elif score >= 0.50:
        return "high"
    elif score >= 0.30:
        return "medium"
    return "low"


def risk_color(level: str) -> str:
    """Get color hex for a risk level."""
    colors = {
        "extreme": "#7f1d1d",
        "high": "#dc2626",
        "medium": "#f59e0b",
        "low": "#10b981",
    }
    return colors.get(level, "#6b7280")


def compute_population_at_risk(
    population: int, flood_probability: float, risk_score: float
) -> int:
    """
    Estimate population exposed to flood risk.
    """
    exposure_factor = flood_probability * (1 + risk_score)
    return int(min(population, population * exposure_factor))
