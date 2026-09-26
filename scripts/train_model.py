#!/usr/bin/env python3
"""
Train the XGBoost Flood Risk Classifier
===============================================
Generates synthetic training data across 3 terrain types,
trains an XGBoost classifier, and saves the model artifacts.

Usage:
    python scripts/train_model.py
    python scripts/train_model.py --samples 20000 --estimators 300
"""

import argparse
import json
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from src.ml_model import generate_training_data, train_model, save_model, RISK_LABELS

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-8s | %(message)s",
)
logger = logging.getLogger(__name__)


def main():
    parser = argparse.ArgumentParser(description="Train Jal Drishti XGBoost Model")
    parser.add_argument("--samples", type=int, default=15000, help="Training samples")
    parser.add_argument("--estimators", type=int, default=300, help="Number of boosting rounds")
    parser.add_argument("--depth", type=int, default=8, help="Max tree depth")
    parser.add_argument("--output", type=str, default="src/models/saved", help="Output dir")
    args = parser.parse_args()

    print("=" * 60)
    print("  JAL DRISHTI — XGBoost Model Training")
    print("=" * 60)

    # 1. Generate training data
    print(f"\n▸ Generating {args.samples:,} synthetic training samples...")
    print("  Terrain types: Hilly Ghats, Riverine Plain, Floodplain")
    X, y = generate_training_data(n_samples=args.samples)

    class_counts = {RISK_LABELS[i]: int((y == i).sum()) for i in range(4)}
    print(f"  Class distribution: {class_counts}")

    # 2. Train model
    print(f"\n▸ Training XGBoost ({args.estimators} rounds, max_depth={args.depth})...")
    result = train_model(X, y, n_estimators=args.estimators, max_depth=args.depth)

    metrics = result["metrics"]
    print(f"\n  ✓ Test Accuracy:  {metrics['accuracy']:.2%}")
    print(f"  ✓ F1 Score:       {metrics['f1_score']:.2%}")
    print(f"  ✓ CV Accuracy:    {metrics['cv_mean_accuracy']:.2%} ± {metrics['cv_std']:.4f}")

    # 3. Feature importance
    print("\n▸ Feature Importance:")
    for name, imp in sorted(metrics["feature_importance"].items(), key=lambda x: -x[1]):
        bar = "█" * int(imp * 50)
        print(f"  {name:>20s}  {bar} {imp:.3f}")

    # 4. Per-class metrics
    print("\n▸ Per-Class Performance:")
    print(f"  {'Class':<10s} {'Precision':>10s} {'Recall':>10s} {'F1':>10s} {'Support':>10s}")
    print("  " + "-" * 50)
    for label, m in metrics["per_class_metrics"].items():
        print(f"  {label:<10s} {m['precision']:>10.3f} {m['recall']:>10.3f} {m['f1']:>10.3f} {m['support']:>10d}")

    # 5. Save
    print(f"\n▸ Saving model to {args.output}/...")
    paths = save_model(result, output_dir=args.output)

    print("\n" + "=" * 60)
    print("  ✓ Model artifacts saved:")
    for key, path in paths.items():
        print(f"    {key}: {path}")
    print("=" * 60)


if __name__ == "__main__":
    main()
