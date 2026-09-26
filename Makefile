# =============================================
# Jal Drishti - Project Makefile
# =============================================

.PHONY: help dev api test lint format clean validate-data install setup

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

# ---- Development ----

dev: ## Start frontend dev server (port 8001)
	python3 -m http.server 8001

api: ## Start FastAPI backend (port 8000)
	uvicorn src.api_server:app --host 0.0.0.0 --port 8000 --reload

# ---- Testing ----

test: ## Run all tests
	pytest tests/ -v --tb=short

test-cov: ## Run tests with coverage report
	pytest tests/ -v --cov=src --cov-report=html --cov-report=term
	@echo "\n  Coverage report: htmlcov/index.html"

# ---- Code Quality ----

lint: ## Run linters (flake8 + black check)
	flake8 src/ tests/ --max-line-length=120
	black --check src/ tests/

format: ## Auto-format code with black
	black src/ tests/

# ---- Data ----

validate-data: ## Validate all GeoJSON/JSON data files
	@python3 -c "\
	import json, glob; \
	files = glob.glob('dashboard/data/**/*.geojson', recursive=True) + glob.glob('dashboard/data/**/*.json', recursive=True); \
	[print(f'  ✓ {f}') for f in files if json.load(open(f))]; \
	print(f'\n{len(files)} files validated.')"

# ---- Cleanup ----

clean: ## Remove build artifacts and caches
	find . -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true
	find . -type f -name '*.pyc' -delete 2>/dev/null || true
	rm -rf .pytest_cache htmlcov .coverage output/
	@echo "  Cleaned."

# ---- Setup ----

install: ## Install Python dependencies
	pip install -r requirements.txt

setup: install ## Full project setup
	@mkdir -p output
	@echo "  Jal Drishti setup complete."
