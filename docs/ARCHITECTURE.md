# System Architecture

## Overview

Jal Drishti is a client-heavy architecture where the Mission Control dashboard performs flood simulation, risk assessment, and pathfinding entirely in the browser. The backend serves spatial data and runs resource optimization.

```
┌─────────────────────────────────────────────────────────────┐
│                     User / Disaster Manager                  │
└────────────────────────────┬────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────┐
│              Mission Control Dashboard (Browser)             │
│                                                              │
│  ┌──────────────┐  ┌───────────────┐  ┌──────────────────┐ │
│  │ Flood Sim    │  │ A* Pathfinder │  │ Population AI    │ │
│  │ Engine       │  │ + Spline      │  │ Heatmap          │ │
│  └──────┬───────┘  └───────┬───────┘  └────────┬─────────┘ │
│         │                  │                    │            │
│  ┌──────▼──────────────────▼────────────────────▼─────────┐ │
│  │              MapLibre GL JS (WebGL)                     │ │
│  │   Satellite Tiles + 3D Terrain + Risk Overlays          │ │
│  └─────────────────────────────────────────────────────────┘ │
└──────────────────────┬──────────────────────────────────────┘
                       │  REST API
┌──────────────────────▼──────────────────────────────────────┐
│                 Backend API (FastAPI)                         │
│                                                              │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────────┐ │
│  │ Data        │  │ Resource     │  │ Terrain            │ │
│  │ Ingestion   │  │ Allocator    │  │ Analyzer           │ │
│  └──────┬──────┘  └──────────────┘  └────────────────────┘ │
└─────────┼───────────────────────────────────────────────────┘
          │
┌─────────▼───────────────────────────────────────────────────┐
│                    Data Layer                                │
│                                                              │
│  GeoJSON Boundaries │ Building Footprints │ Safe Havens      │
│  Elevation Profiles │ Population Clusters │ Risk Zones       │
│  AWS Terrarium DEM  │ Esri Satellite Tiles                   │
└─────────────────────────────────────────────────────────────┘
```

## Key Components

### Frontend (dashboard/)

| Module | Responsibility |
|--------|---------------|
| `enhanced.js` | Core intelligence engine (simulation, pathfinding, optimization) |
| `styles.css` | Mission Control HUD styling (glassmorphism) |
| `index.html` | Dashboard layout and controls |
| `methodology.html` | Interactive methodology documentation |
| `drone-intelligence.html` | Drone/aerial intelligence features |

### Backend (src/)

| Module | Responsibility |
|--------|---------------|
| `api_server.py` | FastAPI REST endpoints |
| `flood_model.py` | Multi-criteria flood simulation |
| `terrain_analyzer.py` | DEM processing and terrain classification |
| `resource_allocator.py` | Heuristic resource distribution |
| `rescue_path.py` | Pathfinding algorithms |
| `data_ingestion.py` | GeoJSON/CSV ETL pipeline |
| `config.py` | Centralized configuration |
| `utils.py` | Shared utilities |

## Data Flow

1. **Initialization**: Dashboard loads village config and fetches live weather from Open-Meteo
2. **Simulation**: User adjusts rainfall → JS generates terrain-specific flood grid → Risk classification
3. **Visualization**: Flood depth + risk overlays rendered on MapLibre 3D terrain
4. **Rescue**: A* pathfinding avoids extreme risk zones → Catmull-Rom smoothing → Route display
5. **Optimization**: Resource allocator uses population clusters + risk scores → Deployment plan

## External Dependencies

| Service | Purpose | Auth Required |
|---------|---------|--------------|
| Esri World Imagery | Satellite tiles | No |
| AWS Terrarium | Elevation tiles (3D) | No |
| Open-Meteo | Live weather + forecast | No |
