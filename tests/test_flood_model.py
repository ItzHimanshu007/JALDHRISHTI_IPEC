"""
Tests for Flood Simulation Model
"""

import pytest
import numpy as np
from src.flood_model import FloodSimulationModel


class TestFloodSimulationModel:
    """Test suite for the FloodSimulationModel class."""

    def test_initialization_defaults(self):
        """Test model initializes with default parameters."""
        model = FloodSimulationModel()
        assert model.grid_resolution == 40
        assert model.time_steps == 7

    def test_initialization_custom(self):
        """Test model accepts custom parameters."""
        model = FloodSimulationModel(grid_resolution=20, time_steps=5)
        assert model.grid_resolution == 20
        assert model.time_steps == 5

    @pytest.mark.parametrize("terrain_type", [
        "hilly_ghats",
        "riverine_plain",
        "brahmaputra_floodplain",
    ])
    def test_simulate_all_terrains(self, terrain_type):
        """Test simulation runs for all terrain types."""
        model = FloodSimulationModel(grid_resolution=100, time_steps=3)
        # Real bbox from OSM relation 11312337 (Meppadi Grama Panchayat, admin_level=8)
        bbox = (76.0646, 11.4514, 76.2002, 11.6241)
        result = model.simulate(terrain_type, bbox, rainfall_mm=100)

        assert "metadata" in result
        assert "time_steps" in result
        assert len(result["time_steps"]) == 3
        assert result["metadata"]["terrain_type"] == terrain_type

    def test_zero_rainfall(self):
        """Test that zero rainfall produces minimal flooding."""
        model = FloodSimulationModel(grid_resolution=200, time_steps=3)
        # Real bbox from OSM relation 11312337 (Meppadi Grama Panchayat)
        result = model.simulate("hilly_ghats", (76.0646, 11.4514, 76.2002, 11.6241), 0)
        for ts_data in result["time_steps"].values():
            assert ts_data["stats"]["max_depth_m"] == 0.0

    def test_max_rainfall(self):
        """Test that maximum rainfall produces significant flooding."""
        model = FloodSimulationModel(grid_resolution=200, time_steps=3)
        # Real bbox from OSM relation 11312337 (Meppadi Grama Panchayat)
        result = model.simulate("hilly_ghats", (76.0646, 11.4514, 76.2002, 11.6241), 500)
        # Later time steps should have flooding
        last_key = list(result["time_steps"].keys())[-1]
        assert result["time_steps"][last_key]["stats"]["cells_flooded"] > 0

    def test_intensity_monotonicity(self):
        """Test that higher rainfall produces more flooding."""
        model = FloodSimulationModel(grid_resolution=200, time_steps=3)
        # Real bbox from OSM relation 1568263 (Darbhanga District, admin_level=6)
        bbox = (85.6767, 25.7196, 86.4161, 26.4464)

        result_low = model.simulate("riverine_plain", bbox, 50)
        result_high = model.simulate("riverine_plain", bbox, 200)

        last_key = list(result_high["time_steps"].keys())[-1]
        assert (
            result_high["time_steps"][last_key]["stats"]["max_depth_m"]
            >= result_low["time_steps"][last_key]["stats"]["max_depth_m"]
        )

    def test_risk_grid_shape(self):
        """Test risk grid has correct shape."""
        model = FloodSimulationModel(grid_resolution=200, time_steps=2)
        # Real bbox from OSM relation 11312337 (Meppadi Grama Panchayat)
        result = model.simulate("hilly_ghats", (76.0646, 11.4514, 76.2002, 11.6241), 100)
        grid_size = result["metadata"]["grid_size"]
        first_key = list(result["time_steps"].keys())[0]
        risk_grid = result["time_steps"][first_key]["risk_grid"]
        assert len(risk_grid) == grid_size
        assert len(risk_grid[0]) == grid_size

    def test_temporal_curve_progression(self):
        """Test that flood intensity follows temporal curve."""
        model = FloodSimulationModel(grid_resolution=500, time_steps=7)
        # Real bbox from OSM relation 11312337 (Meppadi Grama Panchayat)
        result = model.simulate("hilly_ghats", (76.0646, 11.4514, 76.2002, 11.6241), 200)
        keys = list(result["time_steps"].keys())

        # First time step (0h) should have less flooding than peak
        assert (
            result["time_steps"][keys[0]]["stats"]["max_depth_m"]
            <= result["time_steps"][keys[3]]["stats"]["max_depth_m"]
        )
