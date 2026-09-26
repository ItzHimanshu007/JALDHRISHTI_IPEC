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

# Each village is simulated over its whole administrative boundary
# (dashboard/data/raw/boundaries/<village>_boundary.geojson) plus a small
# margin. cell_m: grid resolution; zoom: Terrarium zoom to sample (finer than
# the grid); smooth: Gaussian sigma in cells; pit_m: depressions shallower
# than this are SRTM noise and get filled (deeper basins are kept).
DOMAINS = {
    "wayanad_meppadi": {"cell_m": 100, "zoom": 12, "smooth": 0.7, "pit_m": 25.0, "margin": 0.01},
    "darbhanga": {"cell_m": 320, "zoom": 11, "smooth": 1.0, "pit_m": 1.0, "margin": 0.03},
    "dhemaji": {"cell_m": 400, "zoom": 11, "smooth": 0.8, "pit_m": 1.0, "margin": 0.03, "hill_z": 150},
}
BOUNDARIES = ROOT / "dashboard" / "data" / "raw" / "boundaries"


def boundary_rings(vid):
    doc = json.loads((BOUNDARIES / f"{vid}_boundary.geojson").read_text())
    rings = []
    for f in doc["features"]:
        g = f["geometry"]
        polys = g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]
        for poly in polys:
            rings.append(poly[0])          # outer ring only
    return rings


def boundary_mask(rings, bounds, nx, ny):
    """Rasterise the boundary onto the grid (1 = inside the village)."""
    from PIL import ImageDraw
    w, s, e, n = bounds
    img = Image.new("L", (nx, ny), 0)
    draw = ImageDraw.Draw(img)
    for ring in rings:
        draw.polygon([((lo - w) / (e - w) * nx, (n - la) / (n - s) * ny) for lo, la in ring], fill=1)
    return np.asarray(img, dtype=np.uint8)


def lonlat_to_tile_px(lon, lat, z=None):
    z = ZOOM if z is None else z
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


def sample_dem(bounds, nx, ny, zoom=None):
    global ZOOM
    if zoom:
        ZOOM = zoom
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


def priority_flood(z, conn4=False):
    """Fill every depression to its spill level (Barnes et al. 2014).
    conn4: only face neighbours count as outlets (the solver's connectivity)."""
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
                if conn4 and dr and dc:
                    continue
                if (dr or dc) and 0 <= rr < ny and 0 <= cc < nx and not done[rr, cc]:
                    done[rr, cc] = True
                    if filled[rr, cc] < e:
                        filled[rr, cc] = e + 1e-4
                    heapq.heappush(heap, (filled[rr, cc], rr, cc))
    return filled


def condition(dem, sigma, pit_m, hill_z=None):
    z = ndimage.gaussian_filter(dem, sigma, mode="nearest") if sigma > 0 else dem.copy()
    filled = priority_flood(z)
    depth = filled - z
    labels, n = ndimage.label(depth > 1e-3)
    if n:
        max_depth = ndimage.maximum(depth, labels, index=np.arange(1, n + 1))
        shallow = np.zeros(n + 1, dtype=bool)
        shallow[1:] = max_depth < pit_m
        if hill_z is not None:           # every pit in the hills is an SRTM artefact
            shallow[1:] |= ndimage.maximum(filled, labels, index=np.arange(1, n + 1)) > hill_z
        z = np.where(shallow[labels], filled, z)
    return z


def refill_crop(z, pit_m, hill_z=None, deep_m=6.0):
    filled = priority_flood(z, conn4=True)
    depth = filled - z
    labels, n = ndimage.label(depth > 1e-3)
    if not n:
        return z
    idx = np.arange(1, n + 1)
    max_depth = ndimage.maximum(depth, labels, index=idx)
    fill = np.zeros(n + 1, dtype=bool)
    fill[1:] = (max_depth < pit_m) | (max_depth > deep_m)
    if hill_z is not None:
        fill[1:] |= ndimage.maximum(filled, labels, index=idx) > hill_z
    return np.where(fill[labels], filled, z)


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
    rings = boundary_rings(vid)
    xs = [p[0] for r in rings for p in r]
    ys = [p[1] for r in rings for p in r]
    m = d["margin"]
    w, s, e, n = min(xs) - m, min(ys) - m, max(xs) + m, max(ys) + m
    bounds = [round(w, 5), round(s, 5), round(e, 5), round(n, 5)]
    lat_c = (s + n) / 2
    width_m = (e - w) * 111320 * math.cos(math.radians(lat_c))
    height_m = (n - s) * 110574
    nx, ny = round(width_m / d["cell_m"]), round(height_m / d["cell_m"])
    # Drainage is traced over a padded area so rivers that enter the domain
    # from upstream arrive with a realistic upstream catchment.
    px_, py_ = round(nx * PAD), round(ny * PAD)
    fx, fy = (e - w) / nx, (n - s) / ny
    padded = [w - px_ * fx, s - py_ * fy, e + px_ * fx, n + py_ * fy]
    raw = sample_dem(padded, nx + 2 * px_, ny + 2 * py_, d["zoom"])
    zp = condition(raw, d["smooth"], d["pit_m"], d.get("hill_z"))
    acc = flow_accumulation(zp)[py_:py_ + ny, px_:px_ + nx]
    # Re-condition the cropped grid: depressions that only drained through
    # the padding, and any deeper than 6 m (no real wetland at this scale),
    # are artefacts that would trap water forever.
    z = refill_crop(zp[py_:py_ + ny, px_:px_ + nx], d["pit_m"], d.get("hill_z"))
    mask = boundary_mask(rings, bounds, nx, ny)
    zmin = float(np.floor(z.min()))
    zq = np.clip(np.round((z - zmin) * 20), 0, 65535).astype("<u2")         # 5 cm steps
    accq = np.clip(np.round(np.log2(acc) * 12), 0, 255).astype("u1")         # log2 x 12
    doc = {
        "village_id": vid,
        "source": f"AWS Terrarium (SRTM) z{d['zoom']}, Gaussian-smoothed, shallow pits filled",
        "bounds": bounds, "nx": nx, "ny": ny,
        "dx_m": round(width_m / nx, 2), "dy_m": round(height_m / ny, 2),
        "z_min": zmin, "z_scale": 0.05, "z_u16_b64": b64(zq),
        "acc_scale": "log2(cells) * 12", "acc_u8_b64": b64(accq),
        "mask_u8_b64": b64(mask),
    }
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / f"{vid}_terrain.json").write_text(json.dumps(doc, separators=(",", ":")))
    print(f"{vid}: {nx}x{ny} cells, {doc['dx_m']:.0f} m, z {z.min():.1f}-{z.max():.1f} m, "
          f"inside boundary {mask.sum() * doc['dx_m'] * doc['dy_m'] / 1e6:.0f} km2, max acc {acc.max():.0f} cells")
    return z, acc


if __name__ == "__main__":
    for vid in (sys.argv[1:] or DOMAINS):
        build(vid)
