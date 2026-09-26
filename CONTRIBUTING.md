# Contributing to Jal Drishti

Thank you for your interest in contributing to **Jal Drishti**! This guide will help you get started.

## 🚀 Getting Started

### Prerequisites

- Python 3.9+ 
- Git
- Node.js 16+ (optional, for `npx serve`)

### Local Setup

```bash
# Clone the repository
git clone <repository-url>
cd Jaldrishti

# Install Python dependencies
pip install -r requirements.txt

# Start the dashboard
python3 -m http.server 8001
# Navigate to http://localhost:8001/dashboard

# (Optional) Start the API backend
uvicorn src.api_server:app --reload
```

## 📋 Development Workflow

1. **Fork** the repository
2. Create a **feature branch**: `git checkout -b feature/your-feature`
3. Make your changes
4. Run **tests**: `pytest tests/ -v`
5. Run **linter**: `black --check src/ tests/`
6. **Commit** with descriptive messages
7. **Push** and open a Pull Request

## 🧪 Running Tests

```bash
# Run all tests
make test

# Run with coverage
make test-cov

# Run specific test file
pytest tests/test_flood_model.py -v
```

## 🎨 Code Style

- Python: **Black** formatter (line length 120)
- JavaScript: ES6+ with descriptive variable names
- CSS: Glassmorphism design system

## 📁 Project Structure

| Directory | Contents |
|-----------|----------|
| `dashboard/` | Frontend HTML/CSS/JS |
| `dashboard/data/` | GeoJSON & spatial data |
| `src/` | Python backend modules |
| `tests/` | Pytest test suite |
| `scripts/` | Data processing scripts |
| `config/` | YAML configuration |
| `docs/` | Technical documentation |

## 🐛 Reporting Issues

Please include:
- Steps to reproduce
- Expected vs actual behavior
- Browser/OS version
- Screenshots if applicable

## 📝 License

By contributing, you agree that your contributions will be licensed under the MIT License.
