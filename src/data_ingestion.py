"""
Data Ingestion Pipeline
========================
ETL pipeline for loading, validating, and transforming spatial data
from various sources (GeoJSON, CSV, DEM rasters).
"""

import json
import os
import logging
from pathlib import Path
from typing import Dict, List, Optional

import numpy as np

logger = logging.getLogger(__name__)


class DataIngestionPipeline:
    """
    Handles loading and validation of all spatial data required
    by the flood simulation engine.
    """

    SUPPORTED_FORMATS = [".geojson", ".json", ".csv", ".tif", ".png"]

    def __init__(self, data_dir: str):
        """
        Parameters
        ----------
        data_dir : str
            Root directory containing raw and processed data folders
        """
        self.data_dir = Path(data_dir)
        self.raw_dir = self.data_dir / "raw"
        self.processed_dir = self.data_dir / "processed"
        self._cache = {}

    def load_boundary(self, village_id: str) -> Optional[Dict]:
        """
        Load village boundary GeoJSON.

        Parameters
        ----------
        village_id : str
            Village identifier (e.g., 'wayanad_meppadi')

        Returns
        -------
        dict or None
            GeoJSON FeatureCollection
        """
        path = self.raw_dir / "boundaries" / f"{village_id}_boundary.geojson"
        return self._load_geojson(path)

    def load_buildings(self, village_id: str) -> Optional[Dict]:
        """Load building footprints for a village."""
        path = self.raw_dir / "buildings" / f"{village_id}_buildings.geojson"
        return self._load_geojson(path)

    def load_safe_havens(self, village_id: Optional[str] = None) -> List[Dict]:
        """
        Load safe haven locations, optionally filtered by village.
        """
        data = self._load_geojson(self.raw_dir / "infrastructure" / "safe_havens.geojson")
        if data is None:
            return []

        features = data.get("features", [])
        if village_id:
            features = [
                f for f in features
                if f.get("properties", {}).get("village_id") == village_id
            ]
        return features

    def load_rescue_centers(self, village_id: Optional[str] = None) -> List[Dict]:
        """
        Load rescue center locations with resource inventories.
        """
        data = self._load_geojson(
            self.raw_dir / "infrastructure" / "rescue_centers.geojson"
        )
        if data is None:
            return []

        features = data.get("features", [])
        if village_id:
            features = [
                f for f in features
                if f.get("properties", {}).get("village_id") == village_id
            ]
        return features

    def load_population_clusters(self, village_id: Optional[str] = None) -> List[Dict]:
        """Load pre-computed population cluster data."""
        path = self.processed_dir / "population_clusters.json"
        data = self._load_json(path)
        if data is None:
            return []

        clusters = data.get("clusters", [])
        if village_id:
            clusters = [c for c in clusters if c.get("village_id") == village_id]
        return clusters

    def load_elevation_profile(self, village_id: str) -> Optional[Dict]:
        """Load pre-computed elevation profile for a village."""
        path = self.processed_dir / "elevation_profile.json"
        data = self._load_json(path)
        if data is None:
            return None
        return data.get("profiles", {}).get(village_id)

    def load_risk_zones(self, village_id: Optional[str] = None) -> List[Dict]:
        """Load pre-computed risk zone polygons."""
        data = self._load_geojson(self.processed_dir / "risk_zones_sample.geojson")
        if data is None:
            return []

        features = data.get("features", [])
        if village_id:
            features = [
                f for f in features
                if f.get("properties", {}).get("village_id") == village_id
            ]
        return features

    def validate_dataset(self, village_id: str) -> Dict:
        """
        Check completeness of all required data files for a village.

        Returns
        -------
        dict
            Validation report with file status
        """
        checks = {
            "boundary": self.raw_dir / "boundaries" / f"{village_id}_boundary.geojson",
            "buildings": self.raw_dir / "buildings" / f"{village_id}_buildings.geojson",
            "safe_havens": self.raw_dir / "infrastructure" / "safe_havens.geojson",
            "rescue_centers": self.raw_dir / "infrastructure" / "rescue_centers.geojson",
            "population_clusters": self.processed_dir / "population_clusters.json",
            "elevation_profile": self.processed_dir / "elevation_profile.json",
            "risk_zones": self.processed_dir / "risk_zones_sample.geojson",
        }

        report = {"village_id": village_id, "files": {}, "complete": True}
        for name, path in checks.items():
            exists = path.exists()
            report["files"][name] = {
                "path": str(path),
                "exists": exists,
                "size_bytes": path.stat().st_size if exists else 0,
            }
            if not exists:
                report["complete"] = False

        return report

    def _load_geojson(self, path: Path) -> Optional[Dict]:
        """Load and validate a GeoJSON file."""
        if str(path) in self._cache:
            return self._cache[str(path)]

        if not path.exists():
            logger.warning(f"GeoJSON file not found: {path}")
            return None

        try:
            with open(path, "r") as f:
                data = json.load(f)

            if data.get("type") != "FeatureCollection":
                logger.error(f"Invalid GeoJSON (not FeatureCollection): {path}")
                return None

            self._cache[str(path)] = data
            logger.info(f"Loaded {len(data.get('features', []))} features from {path.name}")
            return data
        except json.JSONDecodeError as e:
            logger.error(f"JSON decode error in {path}: {e}")
            return None

    def _load_json(self, path: Path) -> Optional[Dict]:
        """Load a generic JSON file."""
        if str(path) in self._cache:
            return self._cache[str(path)]

        if not path.exists():
            logger.warning(f"JSON file not found: {path}")
            return None

        try:
            with open(path, "r") as f:
                data = json.load(f)
            self._cache[str(path)] = data
            return data
        except json.JSONDecodeError as e:
            logger.error(f"JSON decode error in {path}: {e}")
            return None

    def clear_cache(self):
        """Clear the internal file cache."""
        self._cache.clear()
