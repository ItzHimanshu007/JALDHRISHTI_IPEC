"""
Jal Drishti - Application Entry Point
=======================================
Root entry point for production and local deployment.
Imports the FastAPI app and adds static dashboard serving.

Usage:
    uvicorn main:app --host 0.0.0.0 --port 8000 --reload
"""

from pathlib import Path
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

# Import the existing FastAPI app with all API routes
from src.api_server import app

# =============================================
# Paths
# =============================================

DASHBOARD_DIR = Path(__file__).resolve().parent / "dashboard"
ROOT_DIR = Path(__file__).resolve().parent

# =============================================
# HTML Page Routes (MUST be registered BEFORE mounts)
# =============================================

@app.get("/", include_in_schema=False)
@app.get("/index.html", include_in_schema=False)
async def serve_dashboard():
    """Serve the main dashboard page."""
    return FileResponse(DASHBOARD_DIR / "index.html")


@app.get("/methodology", include_in_schema=False)
@app.get("/methodology.html", include_in_schema=False)
async def serve_methodology():
    """Serve the methodology page."""
    return FileResponse(DASHBOARD_DIR / "methodology.html")


@app.get("/settings", include_in_schema=False)
@app.get("/settings.html", include_in_schema=False)
async def serve_settings():
    """Serve the settings page (voice language + reports)."""
    return FileResponse(DASHBOARD_DIR / "settings.html")


@app.get("/judge", include_in_schema=False)
@app.get("/judge.html", include_in_schema=False)
@app.get("/jal_drishti_judge_viz.html", include_in_schema=False)
async def serve_judge():
    """Serve the judge evaluation interface."""
    return FileResponse(ROOT_DIR / "jal_drishti_judge_viz.html")


@app.get("/pipeline", include_in_schema=False)
@app.get("/pipeline.html", include_in_schema=False)
@app.get("/jal_drishti_final_pipeline.html", include_in_schema=False)
async def serve_pipeline():
    """Serve the architecture pipeline diagram."""
    return FileResponse(ROOT_DIR / "jal_drishti_final_pipeline.html")


# =============================================
# Static Asset Mounts (registered AFTER explicit routes)
# =============================================

# Serve static asset directories
app.mount("/css", StaticFiles(directory=DASHBOARD_DIR / "css"), name="css")
app.mount("/js", StaticFiles(directory=DASHBOARD_DIR / "js"), name="js")
app.mount("/data", StaticFiles(directory=DASHBOARD_DIR / "data"), name="data")

# Mount assets directory if it exists
assets_dir = DASHBOARD_DIR / "assets"
if assets_dir.exists():
    app.mount("/assets", StaticFiles(directory=assets_dir), name="assets")

# Mount full dashboard directory for /dashboard URLs
app.mount("/dashboard", StaticFiles(directory=DASHBOARD_DIR, html=True), name="dashboard")
