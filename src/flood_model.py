"""
Flood Simulation Model
=======================
Multi-criteria flood risk assessment engine.

Implements the core simulation logic for generating flood risk grids
based on terrain type, rainfall intensity, and elevation data.
"""

import numpy as np
from typing import Dict, Tuple, Optional, List


class FloodSimulationModel:
    """
    Generates time-stepped flood risk grids using terrain-specific algorithms.

    Supports three terrain profiles:
    - hilly_ghats: Flash flood with landslide corridors (Wayanad)
    - riverine_plain: Embankment breach and river overflow (Darbhanga)
    - brahmaputra_floodplain: Sheet flooding with braided channels (Dhemaji)
    """

    RISK_WEIGHTS = {
        "water_depth": 0.40,
        "slope": 0.25,
        "flow_accumulation": 0.25,
        "proximity": 0.10,
    }

    RISK_LABELS = {
        (0, 30): "low",
        (30, 50): "medium",
        (50, 70): "high",
        (70, 100): "extreme",
    }

    def __init__(self, grid_resolution: int = 40, time_steps: int = 7):
        """
        Parameters
        ----------
        grid_resolution : int
            Grid cell size in meters (default 40m)
        time_steps : int
            Number of simulation time steps (default 7 = 0h to 24h)
        """
        self.grid_resolution = grid_resolution
        self.time_steps = time_steps
        self._risk_cache = {}

    def simulate(
        self,
        terrain_type: str,
        bbox: Tuple[float, float, float, float],
        rainfall_mm: float,
        elevation_data: Optional[np.ndarray] = None,
    ) -> Dict:
        """
        Run full flood simulation for a given terrain and rainfall.

        Parameters
        ----------
        terrain_type : str
            One of 'hilly_ghats', 'riverine_plain', 'brahmaputra_floodplain'
        bbox : tuple
            Bounding box (min_lon, min_lat, max_lon, max_lat)
        rainfall_mm : float
            Rainfall in millimeters (0-500)
        elevation_data : ndarray, optional
            DEM raster array. If None, synthetic elevation is generated.

        Returns
        -------
        dict
            Simulation results with risk grids per time step
        """
        intensity = min(rainfall_mm / 200.0, 1.0)
        grid_size = self._compute_grid_size(bbox)

        if elevation_data is None:
            elevation_data = self._generate_synthetic_dem(terrain_type, grid_size)

        results = {
            "metadata": {
                "terrain_type": terrain_type,
                "bbox": bbox,
                "rainfall_mm": rainfall_mm,
                "grid_resolution_m": self.grid_resolution,
                "grid_size": grid_size,
            },
            "time_steps": {},
        }

        for t in range(self.time_steps):
            time_label = f"{t * 4}h"
            time_intensity = intensity * self._temporal_curve(t, terrain_type)
            flood_grid = self._generate_flood_grid(
                terrain_type, grid_size, time_intensity
            )
            risk_grid = self._classify_risk(flood_grid, elevation_data)

            results["time_steps"][time_label] = {
                "water_depth": flood_grid.tolist(),
                "risk_grid": risk_grid.tolist(),
                "stats": {
                    "max_depth_m": float(np.max(flood_grid)),
                    "mean_depth_m": float(np.mean(flood_grid[flood_grid > 0])) if np.any(flood_grid > 0) else 0.0,
                    "cells_flooded": int(np.sum(flood_grid > 0.1)),
                    "cells_extreme": int(np.sum(risk_grid >= 70)),
                    "cells_high": int(np.sum((risk_grid >= 50) & (risk_grid < 70))),
                },
            }

        return results

    def _compute_grid_size(self, bbox: Tuple) -> int:
        """Compute grid dimensions from bounding box."""
        lon_range = abs(bbox[2] - bbox[0]) * 111000  # degrees to meters
        return max(10, int(lon_range / self.grid_resolution))

    def _temporal_curve(self, time_step: int, terrain_type: str) -> float:
        """
        Returns intensity multiplier for a given time step.
        Different terrain types have different flood response curves.
        """
        curves = {
            "hilly_ghats": [0.0, 0.3, 0.7, 1.0, 0.9, 0.6, 0.3],
            "riverine_plain": [0.0, 0.1, 0.3, 0.5, 0.8, 1.0, 0.9],
            "brahmaputra_floodplain": [0.0, 0.2, 0.5, 0.7, 0.9, 1.0, 0.95],
        }
        curve = curves.get(terrain_type, curves["riverine_plain"])
        return curve[min(time_step, len(curve) - 1)]

    def _generate_flood_grid(
        self, terrain_type: str, grid_size: int, intensity: float
    ) -> np.ndarray:
        """Dispatch to terrain-specific flood generator."""
        generators = {
            "hilly_ghats": self._hilly_flood,
            "riverine_plain": self._riverine_flood,
            "brahmaputra_floodplain": self._floodplain_flood,
        }
        generator = generators.get(terrain_type, self._riverine_flood)
        return generator(grid_size, intensity)

    def _hilly_flood(self, grid_size: int, intensity: float) -> np.ndarray:
        """Western Ghats: Flash flood with narrow valley accumulation."""
        grid = np.zeros((grid_size, grid_size))
        for x in range(grid_size):
            for y in range(grid_size):
                dx = x - grid_size / 2
                dy = y - grid_size / 2
                dist = np.sqrt(dx**2 + dy**2) / (grid_size / 2.5)
                valley = np.exp(-(dy - dx * 0.4) ** 2 / 4)
                noise = np.sin(x * 0.123 + y * 0.456) * 0.3
                value = max(0, (1.5 - dist) * (valley + noise) * intensity * 7.5)
                grid[x, y] = value
        return grid

    def _riverine_flood(self, grid_size: int, intensity: float) -> np.ndarray:
        """Gangetic Plain: River channel overflow with embankment breach."""
        grid = np.zeros((grid_size, grid_size))
        cx, cy = grid_size / 2, grid_size / 2
        for x in range(grid_size):
            for y in range(grid_size):
                meander = np.sin(y * 0.12) * 5
                river_dist = abs(x - cx - meander)
                river = np.exp(-river_dist**2 / 18)
                waterlog = np.sin(x * 0.15 + y * 0.15) * 0.3
                value = max(0, (river * 3.0 + waterlog) * intensity * 4.0)
                grid[x, y] = value
        return grid

    def _floodplain_flood(self, grid_size: int, intensity: float) -> np.ndarray:
        """Brahmaputra: Wide-area sheet flooding with braided channels."""
        grid = np.zeros((grid_size, grid_size))
        cx = grid_size / 2
        for x in range(grid_size):
            for y in range(grid_size):
                channel = np.exp(-(x - cx - np.sin(y * 0.1) * 8) ** 2 / 60)
                sheet = max(0, 1 - abs(x - cx) / (grid_size * 0.6)) * 0.8
                micro = np.sin(x * 0.08 + y * 0.08) * 0.3
                value = max(0, (channel + sheet + micro) * intensity * 3.8)
                grid[x, y] = value
        return grid

    def _generate_synthetic_dem(
        self, terrain_type: str, grid_size: int
    ) -> np.ndarray:
        """Generate a synthetic DEM based on terrain type."""
        base_elevations = {
            "hilly_ghats": 800,
            "riverine_plain": 50,
            "brahmaputra_floodplain": 70,
        }
        base = base_elevations.get(terrain_type, 100)
        dem = np.full((grid_size, grid_size), base, dtype=float)
        for x in range(grid_size):
            for y in range(grid_size):
                dem[x, y] += np.sin(x * 0.05) * 20 + np.cos(y * 0.07) * 15
        return dem

    def _classify_risk(
        self, flood_grid: np.ndarray, elevation: np.ndarray
    ) -> np.ndarray:
        """Compute composite risk score (0-100) from multi-criteria analysis."""
        depth_score = np.clip(flood_grid / 4.0, 0, 1) * 100 * self.RISK_WEIGHTS["water_depth"]
        slope_score = np.clip(1 - np.gradient(elevation)[0] / 20, 0, 1) * 100 * self.RISK_WEIGHTS["slope"]
        accum_score = np.clip(flood_grid * 0.25, 0, 1) * 100 * self.RISK_WEIGHTS["flow_accumulation"]
        prox_score = np.full_like(flood_grid, 50) * self.RISK_WEIGHTS["proximity"]
        return depth_score + slope_score + accum_score + prox_score
