"""
Risk Zone Generator
====================
Generates flood risk zone GeoJSON from simulation results.

Usage:
    python scripts/generate_risk_zones.py --village wayanad_meppadi --rainfall 250
"""

import argparse
import json
import logging
import sys
from pathlib import Path
from datetime import datetime, timezone

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from src.config import VILLAGES, PROCESSED_DATA_DIR
from src.flood_model import FloodSimulationModel
from src.utils import classify_risk_label, create_feature, create_feature_collection, save_geojson

logging.basicConfig(level=logging.INFO, format="%(asctime)s | %(levelname)s | %(message)s")
logger = logging.getLogger(__name__)


def generate_risk_zones(village_id, rainfall_mm, output_dir):
    """Generate risk zone GeoJSON for a village."""
    village = VILLAGES.get(village_id)
    if not village:
        logger.error(f"Unknown village: {village_id}")
        return

    logger.info(f"Generating risk zones for {village['name']}: {rainfall_mm}mm rainfall")

    model = FloodSimulationModel(grid_resolution=40, time_steps=7)
    result = model.simulate(
        terrain_type=village["terrain_type"],
        bbox=tuple(village["bbox"]),
        rainfall_mm=rainfall_mm,
    )

    # Use the peak time step (12h for hilly, 20h for plains)
    peak_key = "12h" if "hilly" in village["terrain_type"] else "20h"
    peak_data = result["time_steps"].get(peak_key, list(result["time_steps"].values())[-1])

    bbox = village["bbox"]
    grid_size = result["metadata"]["grid_size"]
    risk_grid = np.array(peak_data["risk_grid"])
    water_depth = np.array(peak_data["water_depth"])

    # Convert grid cells to GeoJSON polygons
    features = []
    cell_lon = (bbox[2] - bbox[0]) / grid_size
    cell_lat = (bbox[3] - bbox[1]) / grid_size

    for i in range(grid_size):
        for j in range(grid_size):
            score = risk_grid[i, j]
            depth = water_depth[i, j]

            if score < 20:  # Skip low-risk cells for efficiency
                continue

            min_lon = bbox[0] + j * cell_lon
            min_lat = bbox[1] + i * cell_lat

            feature = create_feature(
                "Polygon",
                [[
                    [min_lon, min_lat],
                    [min_lon + cell_lon, min_lat],
                    [min_lon + cell_lon, min_lat + cell_lat],
                    [min_lon, min_lat + cell_lat],
                    [min_lon, min_lat],
                ]],
                {
                    "grid_id": f"{village_id[:2].upper()}-{i:03d}-{j:03d}",
                    "village_id": village_id,
                    "risk_level": classify_risk_label(score / 100),
                    "risk_score": round(score / 100, 2),
                    "water_depth_m": round(float(depth), 2),
                },
            )
            features.append(feature)

    collection = create_feature_collection(features)
    collection["metadata"] = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "rainfall_mm": rainfall_mm,
        "peak_time_step": peak_key,
        "model_version": "v2.1",
    }

    output_path = Path(output_dir) / f"{village_id}_risk_zones_{int(rainfall_mm)}mm.geojson"
    save_geojson(collection, str(output_path))

    logger.info(f"Generated {len(features)} risk zone polygons")
    logger.info(f"  Extreme: {sum(1 for f in features if f['properties']['risk_level'] == 'extreme')}")
    logger.info(f"  High:    {sum(1 for f in features if f['properties']['risk_level'] == 'high')}")
    logger.info(f"  Medium:  {sum(1 for f in features if f['properties']['risk_level'] == 'medium')}")


def main():
    parser = argparse.ArgumentParser(description="Generate flood risk zone GeoJSON")
    parser.add_argument("--village", type=str, default="all")
    parser.add_argument("--rainfall", type=float, default=250.0)
    parser.add_argument("--output", type=str, default="output/risk_zones")
    args = parser.parse_args()

    villages = list(VILLAGES.keys()) if args.village == "all" else [args.village]
    for vid in villages:
        generate_risk_zones(vid, args.rainfall, args.output)


if __name__ == "__main__":
    main()
