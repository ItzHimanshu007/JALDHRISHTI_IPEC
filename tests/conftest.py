"""
Pytest Fixtures for Jal Drishti Test Suite
"""

import pytest
import numpy as np
import sys
from pathlib import Path

# Add project root to path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


@pytest.fixture
def sample_villages():
    """Sample village configuration data."""
    return {
        "wayanad_meppadi": {
            "terrain_type": "hilly_ghats",
            # Real bbox from OSM relation 11312337 (Meppadi Grama Panchayat, admin_level=8)
            "bbox": (76.0646, 11.4514, 76.2002, 11.6241),
            "population": 50000,
            "coordinates": {"lat": 11.5378, "lon": 76.1324},
        },
        "darbhanga": {
            "terrain_type": "riverine_plain",
            # Real bbox from OSM relation 1568263 (Darbhanga District, admin_level=6)
            "bbox": (85.6767, 25.7196, 86.4161, 26.4464),
            "population": 100000,
            "coordinates": {"lat": 26.0830, "lon": 86.0464},
        },
        "dhemaji": {
            "terrain_type": "brahmaputra_floodplain",
            # Real bbox from OSM relation 2026407 (Dhemaji District, admin_level=6)
            "bbox": (94.2110, 27.3097, 95.5153, 27.8797),
            "population": 75000,
            "coordinates": {"lat": 27.5947, "lon": 94.8632},
        },
    }


@pytest.fixture
def sample_dem():
    """Generate a 20x20 synthetic DEM for testing."""
    dem = np.zeros((20, 20))
    for i in range(20):
        for j in range(20):
            dem[i, j] = 100 + np.sin(i * 0.3) * 20 + np.cos(j * 0.4) * 15
    return dem


@pytest.fixture
def sample_clusters():
    """Sample population cluster data."""
    return [
        # Sample clusters inside real Meppadi boundary
        {"cluster_id": "C01", "lat": 11.538, "lng": 76.132, "population": 4200},
        {"cluster_id": "C02", "lat": 11.556, "lng": 76.148, "population": 3800},
        {"cluster_id": "C03", "lat": 11.510, "lng": 76.115, "population": 1800},
    ]


@pytest.fixture
def sample_rescue_centers():
    """Sample rescue center coordinate tuples."""
    return [
        # Inside real Meppadi boundary
        (11.565, 76.140),
        (11.505, 76.125),
    ]


@pytest.fixture
def data_dir():
    """Path to the test data directory."""
    return Path(__file__).resolve().parent.parent / "dashboard" / "data"
