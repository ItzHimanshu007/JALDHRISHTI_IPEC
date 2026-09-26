# Jal Drishti - API Reference

> **Base URL**: `http://localhost:8000/api`

## Endpoints

### Health Check

```
GET /api/health
```

**Response:**
```json
{
  "status": "operational",
  "version": "1.0.0",
  "villages_loaded": 3,
  "data_complete": true
}
```

---

### Villages

#### List Villages
```
GET /api/villages
```

Returns all supported villages with coordinates and terrain type.

#### Get Village Details
```
GET /api/villages/{village_id}
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `village_id` | string | `wayanad_meppadi`, `darbhanga`, or `dhemaji` |

---

### Flood Simulation

```
POST /api/simulate
```

**Request Body:**
```json
{
  "village_id": "wayanad_meppadi",
  "rainfall_mm": 200
}
```

**Response:** Time-stepped flood risk grids with depth and risk classification per cell.

| Field | Type | Description |
|-------|------|-------------|
| `rainfall_mm` | float | 0–500 mm input |
| `time_steps` | object | Keyed by `0h`, `4h`, ... `24h` |
| `time_steps.*.stats.max_depth_m` | float | Peak water depth |
| `time_steps.*.stats.cells_extreme` | int | Cells with >70% risk |

---

### Spatial Data

#### Boundary GeoJSON
```
GET /api/boundary/{village_id}
```

#### Safe Haven Locations
```
GET /api/safe-havens/{village_id}
```

#### Pre-computed Risk Zones
```
GET /api/risk-zones/{village_id}
```

#### Population Clusters
```
GET /api/population/{village_id}
```

---

### Resource Optimization

```
POST /api/optimize-resources
```

**Request Body:**
```json
{
  "village_id": "darbhanga",
  "resources": {
    "boats": 10,
    "ambulances": 5,
    "personnel": 50
  }
}
```

**Response:** Deployment plan with assignments, coverage, and recommendations.

---

## Error Codes

| Code | Meaning |
|------|---------|
| 200 | Success |
| 400 | Bad request / insufficient data |
| 404 | Village or resource not found |
| 500 | Internal server error |

## Rate Limiting

100 requests per minute per IP. Returns `429 Too Many Requests` when exceeded.
