"""
DEM Preprocessing Script
==========================
Downloads and processes SRTM/Terrarium DEM tiles for the target villages.
Outputs elevation arrays and derived terrain features.

Usage:
    python scripts/preprocess_dem.py --village wayanad_meppadi --output output/
"""

import argparse
import json
import logging
import os
import sys
from pathlib import Path

import numpy as np

# Add project root to path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from src.config import VILLAGES, PROCESSED_DATA_DIR
from src.terrain_analyzer import TerrainAnalyzer

logging.basicConfig(level=logging.INFO, format="%(asctime)s | %(levelname)s | %(message)s")
logger = logging.getLogger(__name__)


def generate_synthetic_dem(bbox, resolution_m=30):
    """
    Generate a synthetic DEM from bounding box.
    In production, this would download SRTM tiles from NASA/USGS.
    """
    lon_range = (bbox[2] - bbox[0]) * 111000  # degrees to meters
    lat_range = (bbox[3] - bbox[1]) * 111000
    cols = int(lon_range / resolution_m)
    rows = int(lat_range / resolution_m)

    logger.info(f"Generating synthetic DEM: {rows}x{cols} cells at {resolution_m}m resolution")

    dem = np.zeros((rows, cols))
    for i in range(rows):
        for j in range(cols):
            dem[i, j] = 100 + np.sin(i * 0.02) * 50 + np.cos(j * 0.03) * 30
            dem[i, j] += np.random.normal(0, 2)  # Add noise

    return dem


def process_village(village_id, output_dir):
    """Process DEM for a single village."""
    village = VILLAGES.get(village_id)
    if not village:
        logger.error(f"Unknown village: {village_id}")
        return

    logger.info(f"Processing DEM for {village['name']} ({village_id})")

    # Generate/load DEM
    dem = generate_synthetic_dem(village["bbox"])

    # Analyze terrain
    analyzer = TerrainAnalyzer(cell_size_m=30.0)
    report = analyzer.classify_terrain(dem)

    # Extract transect
    mid_row = dem.shape[0] // 2
    transect = analyzer.extract_transect(dem, (0, mid_row), (dem.shape[0] - 1, mid_row))

    # Compute drainage density
    drainage_density = analyzer.compute_drainage_density(dem, threshold=50)

    # Build output
    profile = {
        "village_id": village_id,
        "dem_shape": list(dem.shape),
        "resolution_m": 30,
        **report,
        "drainage_density_km_per_sqkm": round(drainage_density, 2),
        "transect": transect,
    }

    # Save
    output_path = Path(output_dir) / f"{village_id}_terrain_profile.json"
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w") as f:
        json.dump(profile, f, indent=2)

    logger.info(f"Saved terrain profile to {output_path}")
    logger.info(f"  Elevation: {report['elevation']['min']:.0f}m - {report['elevation']['max']:.0f}m")
    logger.info(f"  Max Slope: {report['slope']['max']:.1f}°")
    logger.info(f"  Drainage: {drainage_density:.2f} km/km²")


def main():
    parser = argparse.ArgumentParser(description="Preprocess DEM data for Jal Drishti")
    parser.add_argument("--village", type=str, default="all", help="Village ID or 'all'")
    parser.add_argument("--output", type=str, default="output/terrain", help="Output directory")
    args = parser.parse_args()

    villages = list(VILLAGES.keys()) if args.village == "all" else [args.village]

    for vid in villages:
        process_village(vid, args.output)

    logger.info(f"Done. Processed {len(villages)} village(s).")


if __name__ == "__main__":
    main()
