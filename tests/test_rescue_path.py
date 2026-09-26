"""
Tests for Rescue Path Finder
"""

import pytest
import numpy as np
from src.rescue_path import RescuePathFinder


class TestRescuePathFinder:
    """Test suite for the RescuePathFinder class."""

    def test_initialization(self):
        """Test path finder initializes correctly."""
        finder = RescuePathFinder()
        assert finder.dem_path is None
        assert finder.risk_map_path is None

    def test_initialization_with_paths(self):
        """Test path finder accepts DEM and risk map paths."""
        finder = RescuePathFinder(dem_path="/data/dem.tif", risk_map_path="/data/risk.tif")
        assert finder.dem_path == "/data/dem.tif"
        assert finder.risk_map_path == "/data/risk.tif"

    def test_find_path_same_point(self):
        """Test path from a point to itself (uses real Meppadi centre)."""
        finder = RescuePathFinder()
        # Real centre of Meppadi Grama Panchayat (OSM rel 11312337)
        result = finder.find_path((11.5378, 76.1324), (11.5378, 76.1324))
        assert result["statistics"]["distance_m"] == 0.0
        assert result["statistics"]["time_min"] == 0.0

    def test_find_path_valid_coords(self):
        """Test path between two realistic coordinates."""
        finder = RescuePathFinder()
        start = (11.553, 76.132)
        end = (11.558, 76.141)
        result = finder.find_path(start, end)

        assert "path" in result
        assert "statistics" in result
        assert result["statistics"]["distance_m"] > 0
        assert result["statistics"]["time_min"] > 0
        assert len(result["path"]) == 2

    def test_path_distance_symmetry(self):
        """Test that distance A->B equals distance B->A (inside real Meppadi boundary)."""
        finder = RescuePathFinder()
        # Both points inside real Meppadi boundary
        a = (11.5378, 76.1324)
        b = (11.5560, 76.1480)

        result_ab = finder.find_path(a, b)
        result_ba = finder.find_path(b, a)

        assert abs(result_ab["statistics"]["distance_m"] - result_ba["statistics"]["distance_m"]) < 0.1

    def test_path_distance_reasonable(self):
        """Test that calculated distance is geographically reasonable."""
        finder = RescuePathFinder()
        # ~0.01 degree apart ≈ ~1.1 km
        result = finder.find_path((11.55, 76.13), (11.56, 76.13))
        distance = result["statistics"]["distance_m"]
        assert 1000 < distance < 1500  # Should be roughly ~1.1km

    def test_path_time_positive(self):
        """Test that travel time is always positive for non-zero distance (real Darbhanga district)."""
        finder = RescuePathFinder()
        # Inside real Darbhanga district boundary (OSM rel 1568263)
        result = finder.find_path((26.0830, 86.0464), (26.1000, 86.0600))
        assert result["statistics"]["time_min"] > 0
