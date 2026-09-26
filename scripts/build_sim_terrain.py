"""Bake the terrain grids the dashboard's rain-flood simulator runs on.

For each village this mosaics AWS Terrarium elevation tiles (the same SRTM
terrain the dashboard's 3D map drapes the satellite imagery over), resamples
them onto a regular lat/lon grid covering the village's simulation domain,
applies standard hydrological conditioning (light smoothing, then filling
noise pits shallower than a threshold with a priority-flood), and computes
D8 flow accumulation so the browser knows where the drainage lines are.

Output: dashboard/data/sim/<village>_terrain.json, read by
dashboard/js/flood-sim.js. Only terrain is real; all rainfall, river
inflow and failure events in the dashboard are synthetic scenarios.

    python scripts/build_sim_terrain.py            # all villages
    python scripts/build_sim_terrain.py darbhanga  # one village
"""

import base64
import heapq
import io
import json
import math
import sys
import urllib.request
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "dashboard" / "data" / "sim"
CACHE = ROOT / ".cache" / "terrarium"
TILE_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
ZOOM = 13
PAD = 0.35          # drainage context around each domain, as a fraction of its size

# Simulation domains (lon/lat bounds) and grid resolution per village.
# smooth: Gaussian sigma in cells; pit_m: depressions shallower than this are
# SRTM noise and get filled (deeper basins such as chaurs/beels are kept).
DOMAINS = {
    "wayanad_meppadi": {"bounds": [76.100, 11.462, 76.192, 11.572], "cell_m": 75, "smooth": 0.8, "pit_m": 25.0},
    "darbhanga": {"bounds": [85.815, 26.085, 85.995, 26.205], "cell_m": 100, "smooth": 1.6, "pit_m": 0.6},
    "dhemaji": {"bounds": [94.480, 27.405, 94.650, 27.545], "cell_m": 100, "smooth": 1.4, "pit_m": 0.6},
}


def lonlat_to_tile_px(lon, lat, z):
    n = 256 * 2 ** z
    x = (lon + 180) / 360 * n
    y = (1 - math.log(math.tan(math.radians(lat)) + 1 / math.cos(math.radians(lat))) / math.pi) / 2 * n
    return x, y


def fetch_tile(z, x, y):
    path = CACHE / str(z) / str(x) / f"{y}.png"
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        with urllib.request.urlopen(TILE_URL.format(z=z, x=x, y=y), timeout=60) as r:
            path.write_bytes(r.read())
    rgb = np.asarray(Image.open(io.BytesIO(path.read_bytes())).convert("RGB")).astype(np.float64)
    return rgb[:, :, 0] * 256 + rgb[:, :, 1] + rgb[:, :, 2] / 256 - 32768


def sample_dem(bounds, nx, ny):
    w, s, e, n = bounds
    x0, y0 = lonlat_to_tile_px(w, n, ZOOM)
    x1, y1 = lonlat_to_tile_px(e, s, ZOOM)
    tx0, ty0, tx1, ty1 = int(x0 // 256), int(y0 // 256), int(x1 // 256), int(y1 // 256)
    mosaic = np.vstack([np.hstack([fetch_tile(ZOOM, tx, ty) for tx in range(tx0, tx1 + 1)])
                        for ty in range(ty0, ty1 + 1)])
    lons = w + (np.arange(nx) + 0.5) / nx * (e - w)
    lats = n - (np.arange(ny) + 0.5) / ny * (n - s)          # row 0 = north
    px = np.array([lonlat_to_tile_px(lo, lats[0], ZOOM)[0] for lo in lons]) - tx0 * 256
    py = np.array([lonlat_to_tile_px(lons[0], la, ZOOM)[1] for la in lats]) - ty0 * 256
    return ndimage.map_coordinates(mosaic, np.meshgrid(py, px, indexing="ij"), order=1, mode="nearest")


def priority_flood(z):
    """Fill every depression to its spill level (Barnes et al. 2014)."""
    ny, nx = z.shape
    filled = z.copy()
    done = np.zeros(z.shape, dtype=bool)
    heap = []
    for r in range(ny):
        for c in range(nx):
            if r in (0, ny - 1) or c in (0, nx - 1):
                heapq.heappush(heap, (filled[r, c], r, c))
                done[r, c] = True
    while heap:
        e, r, c = heapq.heappop(heap)
        for dr in (-1, 0, 1):
            for dc in (-1, 0, 1):
                rr, cc = r + dr, c + dc
                if (dr or dc) and 0 <= rr < ny and 0 <= cc < nx and not done[rr, cc]:
                    done[rr, cc] = True
                    if filled[rr, cc] < e:
                        filled[rr, cc] = e + 1e-4
                    heapq.heappush(heap, (filled[rr, cc], rr, cc))
    return filled


def condition(dem, sigma, pit_m):
    z = ndimage.gaussian_filter(dem, sigma, mode="nearest") if sigma > 0 else dem.copy()
    filled = priority_flood(z)
    depth = filled - z
    labels, n = ndimage.label(depth > 1e-3)
    if n:
        max_depth = ndimage.maximum(depth, labels, index=np.arange(1, n + 1))
        shallow = np.zeros(n + 1, dtype=bool)
        shallow[1:] = max_depth < pit_m
        z = np.where(shallow[labels], filled, z)
    return z


def flow_accumulation(z):
    """D8 flow accumulation (cells draining through each cell) on a filled DEM."""
    f = priority_flood(z)
    ny, nx = f.shape
    order = np.argsort(-f, axis=None)
    acc = np.ones(ny * nx)
    ff = f.ravel()
    nbrs = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]
    for k in order:
        r, c = divmod(int(k), nx)
        best, bk = 0.0, -1
        for dr, dc in nbrs:
            rr, cc = r + dr, c + dc
            if 0 <= rr < ny and 0 <= cc < nx:
                drop = (ff[k] - ff[rr * nx + cc]) / (1.414 if dr and dc else 1.0)
                if drop > best:
                    best, bk = drop, rr * nx + cc
        if bk >= 0:
            acc[bk] += acc[k]
    return acc.reshape(ny, nx)


def b64(a):
    return base64.b64encode(np.ascontiguousarray(a).tobytes()).decode()


def build(vid):
    d = DOMAINS[vid]
    w, s, e, n = d["bounds"]
    lat_c = (s + n) / 2
    width_m = (e - w) * 111320 * math.cos(math.radians(lat_c))
    height_m = (n - s) * 110574
    nx, ny = round(width_m / d["cell_m"]), round(height_m / d["cell_m"])
    # Drainage is traced over a padded area so rivers that enter the domain
    # from upstream arrive with their real upstream catchment size.
    px_, py_ = round(nx * PAD), round(ny * PAD)
    fx, fy = (e - w) / nx, (n - s) / ny
    padded = [w - px_ * fx, s - py_ * fy, e + px_ * fx, n + py_ * fy]
    raw = sample_dem(padded, nx + 2 * px_, ny + 2 * py_)
    zp = condition(raw, d["smooth"], d["pit_m"])
    acc = flow_accumulation(zp)[py_:py_ + ny, px_:px_ + nx]
    z = zp[py_:py_ + ny, px_:px_ + nx]
    zmin = float(np.floor(z.min()))
    zq = np.clip(np.round((z - zmin) * 20), 0, 65535).astype("<u2")         # 5 cm steps
    accq = np.clip(np.round(np.log2(acc) * 12), 0, 255).astype("u1")         # log2 x 12
    doc = {
        "village_id": vid,
        "source": "AWS Terrarium (SRTM) z13, Gaussian-smoothed, shallow pits filled",
        "bounds": d["bounds"], "nx": nx, "ny": ny,
        "dx_m": round(width_m / nx, 2), "dy_m": round(height_m / ny, 2),
        "z_min": zmin, "z_scale": 0.05, "z_u16_b64": b64(zq),
        "acc_scale": "log2(cells) * 12", "acc_u8_b64": b64(accq),
    }
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / f"{vid}_terrain.json").write_text(json.dumps(doc, separators=(",", ":")))
    print(f"{vid}: {nx}x{ny} cells, {doc['dx_m']:.0f} m, z {z.min():.1f}-{z.max():.1f} m, "
          f"max acc {acc.max():.0f} cells")
    return z, acc


if __name__ == "__main__":
    for vid in (sys.argv[1:] or DOMAINS):
        build(vid)
