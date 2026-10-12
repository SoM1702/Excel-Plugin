"""Reproduce one transparent benchmark on a public binary-classification dataset.

This is a benchmark for the software workflow, not a medical model or a claim
that the add-in is ready for clinical use. The data is bundled with
scikit-learn, so running this script does not download data or modify files
unless --output is supplied.
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

import sklearn
from sklearn.datasets import load_breast_cancer

from model import train_logistic


SOURCE_URL = "https://archive.ics.uci.edu/dataset/17/breast+cancer+wisconsin+diagnostic"


def evaluate():
    dataset = load_breast_cancer()
    result, _ = train_logistic(
        features=dataset.data.tolist(),
        labels=dataset.target.tolist(),
        feature_names=dataset.feature_names.tolist(),
        standardize=True,
        test_size=0.3,
        C=1.0,
        class_weight=None,
        cv_folds=5,
        random_state=42,
    )
    return {
        "benchmark": {
            "name": "Breast Cancer Wisconsin (Diagnostic)",
            "source": SOURCE_URL,
            "loaded_from": "scikit-learn built-in load_breast_cancer dataset",
            "purpose": "reproducible binary-classification software benchmark",
            "not_for": "clinical diagnosis, treatment, or deployment decisions",
            "samples": int(dataset.data.shape[0]),
            "features": int(dataset.data.shape[1]),
            "target_names": dataset.target_names.tolist(),
            "scikit_learn_version": sklearn.__version__,
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
