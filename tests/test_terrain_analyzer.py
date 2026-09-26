"""
Tests for Terrain Analyzer
"""

import pytest
import numpy as np
from src.terrain_analyzer import TerrainAnalyzer


class TestTerrainAnalyzer:
    """Test suite for the TerrainAnalyzer class."""

    def test_initialization(self):
        """Test default initialization."""
        analyzer = TerrainAnalyzer()
        assert analyzer.cell_size == 30.0

    def test_compute_slope_flat(self):
        """Test slope of perfectly flat terrain is zero."""
        analyzer = TerrainAnalyzer()
        flat_dem = np.full((10, 10), 100.0)
        slope = analyzer.compute_slope(flat_dem)
        assert np.allclose(slope, 0, atol=0.01)

    def test_compute_slope_tilted(self):
        """Test slope of uniformly tilted terrain."""
        analyzer = TerrainAnalyzer(cell_size_m=1.0)
        dem = np.zeros((10, 10))
        for i in range(10):
            dem[i, :] = i * 10
        slope = analyzer.compute_slope(dem)
        # Interior cells should have consistent slope
        assert np.all(slope[1:-1, 1:-1] > 0)

    def test_compute_aspect(self, sample_dem):
        """Test aspect returns values in valid range."""
        analyzer = TerrainAnalyzer()
        aspect = analyzer.compute_aspect(sample_dem)
        assert np.all(aspect >= 0)
        assert np.all(aspect <= 360)

    def test_compute_twi(self, sample_dem):
        """Test TWI computation returns reasonable values."""
        analyzer = TerrainAnalyzer()
        twi = analyzer.compute_twi(sample_dem)
        assert np.all(twi >= 0)
        assert np.all(twi <= 25)

    def test_classify_terrain(self, sample_dem):
        """Test terrain classification returns all required fields."""
        analyzer = TerrainAnalyzer()
        report = analyzer.classify_terrain(sample_dem)

        assert "elevation" in report
        assert "slope" in report
        assert "aspect_dominant" in report
        assert "terrain_class_distribution" in report

        assert report["elevation"]["min"] <= report["elevation"]["max"]
        assert report["slope"]["min"] <= report["slope"]["max"]
        assert report["aspect_dominant"] in ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]

    def test_drainage_density(self, sample_dem):
        """Test drainage density is non-negative."""
        analyzer = TerrainAnalyzer()
        density = analyzer.compute_drainage_density(sample_dem, threshold=5)
        assert density >= 0

    def test_extract_transect(self, sample_dem):
        """Test transect extraction."""
        analyzer = TerrainAnalyzer()
        transect = analyzer.extract_transect(sample_dem, (0, 0), (19, 19), num_points=10)
        assert len(transect) == 10
        assert all("distance_m" in p and "elevation_m" in p for p in transect)

    def test_dem_shape_consistency(self):
        """Test that output shapes match input DEM."""
        analyzer = TerrainAnalyzer()
        dem = np.random.rand(15, 20) * 500
        slope = analyzer.compute_slope(dem)
        aspect = analyzer.compute_aspect(dem)
        assert slope.shape == dem.shape
        assert aspect.shape == dem.shape
