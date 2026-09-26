"""
Terrain Analyzer
=================
Utilities for DEM processing, slope calculation, and terrain classification.
Supports raster input from SRTM/AWS Terrarium tiles.
"""

import numpy as np
from typing import Dict, Tuple, Optional


class TerrainAnalyzer:
    """
    Analyze Digital Elevation Models (DEMs) to extract terrain features
    used by the flood simulation engine.
    """

    TERRAIN_CLASSES = {
        "flat_plain": {"slope_max": 2, "description": "Flat agricultural/urban land"},
        "gentle_slope": {"slope_max": 8, "description": "Gentle rolling terrain"},
        "moderate_slope": {"slope_max": 15, "description": "Moderate hills"},
        "steep_slope": {"slope_max": 30, "description": "Steep mountain terrain"},
        "cliff": {"slope_max": 90, "description": "Near-vertical cliff faces"},
    }

    def __init__(self, cell_size_m: float = 30.0):
        """
        Parameters
        ----------
        cell_size_m : float
            DEM cell resolution in meters (default SRTM 30m)
        """
        self.cell_size = cell_size_m

    def compute_slope(self, dem: np.ndarray) -> np.ndarray:
        """
        Calculate slope in degrees from a DEM raster.

        Parameters
        ----------
        dem : ndarray
            2D elevation array in meters

        Returns
        -------
        ndarray
            Slope values in degrees
        """
        dy, dx = np.gradient(dem, self.cell_size)
        slope_rad = np.arctan(np.sqrt(dx**2 + dy**2))
        return np.degrees(slope_rad)

    def compute_aspect(self, dem: np.ndarray) -> np.ndarray:
        """
        Calculate aspect (facing direction) from DEM.

        Returns
        -------
        ndarray
            Aspect in degrees (0-360, 0=North, 90=East)
        """
        dy, dx = np.gradient(dem, self.cell_size)
        aspect = np.degrees(np.arctan2(-dx, dy))
        aspect[aspect < 0] += 360
        return aspect

    def compute_twi(self, dem: np.ndarray) -> np.ndarray:
        """
        Compute Topographic Wetness Index (TWI).
        TWI = ln(a / tan(β)) where a = upslope area, β = slope

        Returns
        -------
        ndarray
            TWI values (higher = wetter / more flood-prone)
        """
        slope = self.compute_slope(dem)
        slope_rad = np.radians(np.maximum(slope, 0.1))  # avoid division by zero

        # Simplified flow accumulation (pixel count proxy)
        flow_accum = self._simple_flow_accumulation(dem)
        specific_area = flow_accum * self.cell_size

        twi = np.log(specific_area / np.tan(slope_rad))
        return np.clip(twi, 0, 25)

    def compute_ruggedness(self, dem: np.ndarray, window: int = 3) -> np.ndarray:
        """
        Terrain Ruggedness Index (TRI) using a moving window.
        """
        from scipy.ndimage import generic_filter

        def _tri(values):
            center = values[len(values) // 2]
            return np.sqrt(np.mean((values - center) ** 2))

        return generic_filter(dem, _tri, size=window)

    def classify_terrain(self, dem: np.ndarray) -> Dict:
        """
        Generate a full terrain classification report.

        Returns
        -------
        dict
            Terrain statistics and classifications
        """
        slope = self.compute_slope(dem)
        aspect = self.compute_aspect(dem)

        # Classify each cell
        classifications = np.zeros_like(slope, dtype=int)
        thresholds = [2, 8, 15, 30]
        for i, threshold in enumerate(thresholds):
            classifications[slope > threshold] = i + 1

        # Dominant aspect
        aspect_bins = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]
        aspect_idx = ((aspect + 22.5) // 45).astype(int) % 8
        aspect_counts = np.bincount(aspect_idx.ravel(), minlength=8)
        dominant_aspect = aspect_bins[np.argmax(aspect_counts)]

        return {
            "elevation": {
                "min": float(np.min(dem)),
                "max": float(np.max(dem)),
                "mean": float(np.mean(dem)),
                "std": float(np.std(dem)),
            },
            "slope": {
                "min": float(np.min(slope)),
                "max": float(np.max(slope)),
                "mean": float(np.mean(slope)),
            },
            "aspect_dominant": dominant_aspect,
            "terrain_class_distribution": {
                name: float(np.sum(classifications == i) / classifications.size * 100)
                for i, name in enumerate(
                    ["flat_plain", "gentle_slope", "moderate_slope", "steep_slope", "cliff"]
                )
            },
        }

    def compute_drainage_density(
        self, dem: np.ndarray, threshold: float = 100.0
    ) -> float:
        """
        Estimate drainage density (km of channels per km² of area).
        """
        flow_accum = self._simple_flow_accumulation(dem)
        channel_cells = np.sum(flow_accum > threshold)
        total_area_km2 = (dem.size * self.cell_size**2) / 1e6
        channel_length_km = (channel_cells * self.cell_size) / 1000
        return channel_length_km / max(total_area_km2, 0.01)

    def extract_transect(
        self,
        dem: np.ndarray,
        start: Tuple[int, int],
        end: Tuple[int, int],
        num_points: int = 20,
    ) -> list:
        """
        Extract elevation transect along a line.
        """
        slope = self.compute_slope(dem)
        rows = np.linspace(start[0], end[0], num_points).astype(int)
        cols = np.linspace(start[1], end[1], num_points).astype(int)

        # Clip to valid range
        rows = np.clip(rows, 0, dem.shape[0] - 1)
        cols = np.clip(cols, 0, dem.shape[1] - 1)

        transect = []
        for i, (r, c) in enumerate(zip(rows, cols)):
            distance_m = i * self.cell_size * np.sqrt(
                ((end[0] - start[0]) / num_points) ** 2
                + ((end[1] - start[1]) / num_points) ** 2
            )
            transect.append({
                "distance_m": round(distance_m, 1),
                "elevation_m": round(float(dem[r, c]), 1),
                "slope_deg": round(float(slope[r, c]), 1),
            })

        return transect

    def _simple_flow_accumulation(self, dem: np.ndarray) -> np.ndarray:
        """
        Simplified D8 flow accumulation algorithm.
        For production, use richdem or pysheds.
        """
        rows, cols = dem.shape
        flow_accum = np.ones_like(dem)

        # Sort cells by elevation (highest first)
        flat_indices = np.argsort(dem.ravel())[::-1]

        d8_offsets = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]

        for idx in flat_indices:
            r, c = divmod(idx, cols)
            min_elev = dem[r, c]
            min_r, min_c = r, c

            for dr, dc in d8_offsets:
                nr, nc = r + dr, c + dc
                if 0 <= nr < rows and 0 <= nc < cols:
                    if dem[nr, nc] < min_elev:
                        min_elev = dem[nr, nc]
                        min_r, min_c = nr, nc

            if (min_r, min_c) != (r, c):
                flow_accum[min_r, min_c] += flow_accum[r, c]

        return flow_accum
