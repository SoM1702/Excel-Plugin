"""Reproduce one transparent benchmark on a public binary-classification dataset.

This is a benchmark for the software workflow, not a medical model or a claim
that the add-in is ready for clinical use. The benchmark loads from the local
breast_cancer.csv dataset (569 rows, 30 features) and runs our scratch logistic
regression engine with zero external ML dependencies.
"""

from __future__ import annotations

import argparse
import csv
import json
from datetime import datetime, timezone
from pathlib import Path

from model import train_logistic


SOURCE_URL = "https://archive.ics.uci.edu/dataset/17/breast+cancer+wisconsin+diagnostic"


def load_dataset():
    csv_path = Path(__file__).with_name("breast_cancer.csv")
    if not csv_path.exists():
        raise FileNotFoundError(f"Benchmark dataset not found at {csv_path}")

    with csv_path.open(newline="") as f:
        reader = list(csv.reader(f))

    headers = reader[0]
    feature_names = headers[:-1]
    rows = [[float(v) for v in row] for row in reader[1:]]
    features = [row[:-1] for row in rows]
    labels = [int(row[-1]) for row in rows]
    return feature_names, features, labels


def evaluate():
    feature_names, features, labels = load_dataset()
    result, _ = train_logistic(
        features=features,
        labels=labels,
        feature_names=feature_names,
        standardize=True,
        test_size=0.3,
        learning_rate=0.1,
        max_iterations=5000,
        tolerance=1e-5,
        l2_lambda=0.1,
        class_weight=None,
        cv_folds=5,
        random_state=42,
    )
    return {
        "benchmark": {
            "name": "Breast Cancer Wisconsin (Diagnostic)",
            "source": SOURCE_URL,
            "loaded_from": "local breast_cancer.csv",
            "purpose": "reproducible binary-classification software benchmark",
            "not_for": "clinical diagnosis, treatment, or deployment decisions",
            "samples": len(labels),
            "features": len(feature_names),
            "engine": "scratch_full_batch_gradient_descent",
            "run_at_utc": datetime.now(timezone.utc).isoformat(),
        },
        "result": result,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, help="Optional JSON file to write.")
    args = parser.parse_args()
    report = evaluate()
    rendered = json.dumps(report, indent=2, allow_nan=False)
    if args.output:
        args.output.write_text(rendered + "\n")
        print(f"Wrote {args.output}")
    else:
        print(rendered)


if __name__ == "__main__":
    main()
