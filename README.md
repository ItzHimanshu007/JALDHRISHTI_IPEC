# 🌊 Jal Drishti: AI-Driven Flood Intelligence & Mission Control

**Jal Drishti** (Water Vision) is a state-of-the-art Mission Control Dashboard engineered for high-fidelity flood simulation, real-time risk assessment, and tactical resource deployment. Designed for disaster management professionals, it translates complex hydrological data into actionable field intelligence.

---

## 🚀 Advanced Intelligence Features

### 1. 🧠 Flood Risk Intelligence (AI Analysis)
Move beyond simple monitoring. Our AI engine performs real-time terrain analysis to predict flood impact zones based on multi-criteria modeling:
- **Terrain Stability Analysis**: Real-time evaluation of elevation, slope, and land-use saturation.
- **Dynamic Risk Gridding**: Visualizes danger zones from 'Low' to 'Extreme' based on rainfall intensity.
- **Automated Reporting**: Generates deep-scan tactical summaries with a single click.

### 2. 🗺️ Intelligent Population Heatmap
Our predictive population modeling isn't just a random cluster. It uses **Geographic Building Analysis** to:
- Focus density on **actual building centers** and residential hubs.
- Automatically **avoid riverbeds, floodplains, and unpopulated plains**.
- Link population vulnerability directly to current simulation risk levels.

### 3. 🛡️ Risk-Aware Tactical Rescue Routing
The dashboard features a professional A* pathfinding system designed for emergency extraction:
- **Danger Avoidance**: Routes are strictly prohibited from crossing 'Extreme' risk zones (>70% flood risk).
- **Multi-Destination Ranking**: Simultaneously calculates paths to 5 safe havens per village (Hospitals, Shelters, High Ground) and ranks them by safety and distance.
- **Smoothed Pathing**: Uses Catmull-Rom splines for realistic vehicle/personnel transit visualization.

### 4. 🎯 Linked Resource Optimization
A MISSION-LINKED heuristic engine for resource distribution:
- **Prioritized Allocation**: Distributes limited resources (Boats, Ambulances, Personnel) with 80% bias towards 'Extreme' danger zones.
- **Simulation Interlock**: Optimization only runs when active risk is detected (Rainfall > 0mm).
- **Control & Abort**: Real-time management with a dedicated "Stop Optimization" interrupt.

---

## 🛠️ Technology Ecosystem

- **Engine**: vanilla JavaScript (ES6+) with optimized A* pathfinding and Catmull-Rom spline logic.
- **Mapping**: **MapLibre GL JS** with AWS Terrarium 3D terrain rendering.
- **Visuals**: **Chart.js** for precinct forecasting; CSS3 Glassmorphism for a premium HUD feel.
- **Deployment**: Deployment-ready architecture for local hosting, static distribution, or edge deployment.

---

## 📂 Project Structure

```bash
jaldrishti/
│
├── dashboard/                          # 🖥️  Mission Control Frontend
│   ├── index.html                      # Main dashboard (map, controls, charts)
│   ├── methodology.html                # Interactive methodology documentation
│   ├── drone-intelligence.html         # Drone/aerial intelligence page
│   ├── user-guide.html                 # Operator's user guide
│   ├── js/
│   │   ├── enhanced.js                 # ⭐ Core intelligence engine (4700 LOC)
│   │   └── future-expansion.js         # Drone page logic
│   ├── css/
│   │   ├── styles.css                  # HUD/Glassmorphism styling
│   │   └── future-expansion.css        # Drone page styling
│   ├── assets/graphs/                  # Static chart images
│   └── data/                           # 📊 Spatial & Hydrological Data
│       ├── raw/
│       │   ├── boundaries/             # Village boundary GeoJSON (3 files)
│       │   ├── buildings/              # Building footprints GeoJSON (3 files)
│       │   └── infrastructure/         # Safe havens & rescue centers
│       └── processed/
│           ├── risk_zones_sample.geojson
│           ├── population_clusters.json
│           └── elevation_profile.json
│
├── src/                                # 🐍 Backend Intelligence Core
│   ├── config.py                       # Central configuration
│   ├── flood_model.py                  # Multi-criteria flood simulation
│   ├── terrain_analyzer.py             # DEM processing & terrain classification
│   ├── resource_allocator.py           # Heuristic resource distribution
│   ├── rescue_path.py                  # Pathfinding algorithms
│   ├── data_ingestion.py               # GeoJSON/CSV ETL pipeline
│   ├── api_server.py                   # FastAPI REST API
│   └── utils.py                        # Shared utility functions
│
├── tests/                              # 🧪 Test Suite
│   ├── conftest.py                     # Pytest fixtures
│   ├── test_flood_model.py
│   ├── test_terrain_analyzer.py
│   ├── test_resource_allocator.py
│   └── test_rescue_path.py
│
├── scripts/                            # 🔧 Data Processing Scripts
│   ├── preprocess_dem.py               # DEM terrain preprocessing
│   ├── generate_risk_zones.py          # Risk zone GeoJSON generator
│   └── export_report.py               # Tactical report exporter
│
├── config/                             # ⚙️  Configuration
│   ├── default.yaml                    # Default app settings
│   └── villages.yaml                   # Village terrain definitions
│
├── docs/                               # 📄 Documentation
│   ├── API_REFERENCE.md
│   ├── ARCHITECTURE.md
│   └── DEPLOYMENT_GUIDE.md
│
├── notebooks/                          # 📓 Jupyter Notebooks
│   └── README.md
│
├── requirements.txt                    # Python dependencies
├── package.json                        # NPM scripts
├── setup.py                            # Python package setup
├── Makefile                            # Dev/test/lint shortcuts
├── .env.example                        # Environment template
├── technical_documentation.md          # Algorithm deep-dive
├── CONTRIBUTING.md
├── CHANGELOG.md
├── LICENSE                             # MIT
└── README.md
```

---

## ⚡ Quick Start

1. **Local Development**:
   ```bash
   python3 -m http.server 8001
   ```
   Navigate to `http://localhost:8001/dashboard`.

2. **Production Deployment**:
   Deploy the `dashboard/` directory to any standard web server or static hosting environment.

---

## 📍 Coverage Areas
- **Meppadi (Kerala)**: High-altitude terrain stabilization.
- **Darbhanga (Bihar)**: Riverine flood basin management.
- **Dhemaji (Assam)**: Extreme precipitation response planning.

---

*Developed as a professional disaster management solution for Jal Drishti.*
