# Deployment Guide

## Production Serving

The project can be served as a unified application (FastAPI backend + static dashboard frontend) using the root entry point `main.py`:

```bash
uvicorn main:app --host 0.0.0.0 --port 8000
```

Alternatively, the `dashboard/` static frontend and FastAPI backend can be served independently.

---

## Local Development

### Backend API

```bash
# Create virtual environment
python3 -m venv venv
source venv/bin/activate

# Install dependencies
pip install -r requirements.txt

# Start API server
uvicorn src.api_server:app --host 0.0.0.0 --port 8000 --reload
```

### Frontend Dashboard

```bash
# Option 1: Python HTTP server
python3 -m http.server 8001

# Option 2: Node.js serve
npx -y serve dashboard -p 8001
```

Navigate to `http://localhost:8001/dashboard`.

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `API_HOST` | `0.0.0.0` | API bind address |
| `API_PORT` | `8000` | API port |
| `LOG_LEVEL` | `INFO` | Logging level |

Copy `.env.example` to `.env` and customize as needed.

---

## Production Checklist

- [ ] Set `LOG_LEVEL=WARNING` in production
- [ ] Enable HTTPS via reverse proxy (nginx/Caddy)
- [ ] Configure CORS origins for your domain
- [ ] Set up monitoring and alerting
- [ ] Run `make validate-data` to verify data integrity
