"""Run a readable smoke test of the local training engine or HTTP API.

Examples:
  python test_api.py
  python test_api.py --url https://localhost:8000

The default uses the engine directly and needs no server. The sample path is
resolved from this file, so the command works from any current directory.
"""

from __future__ import annotations

import argparse
import csv
import json
import ssl
import urllib.request
from pathlib import Path


def load_sample():
    csv_path = Path(__file__).with_name("sample_data.csv")
    with csv_path.open(newline="") as source:
        rows = list(csv.reader(source))
    header = rows[0]
    data = [[float(value) for value in row] for row in rows[1:]]
    return header[:-1], [row[:-1] for row in data], [int(row[-1]) for row in data]


def display(result):
    evaluation = result["evaluation"]
    print(
        f"\nSamples: {result['n_samples']}   Features: {result['n_features']}   "
        f"Evaluation: {evaluation['mode']} (train {evaluation['n_train']}, test {evaluation['n_test']})"
    )
    metrics = result["metrics"]
    print(
        f"Fixed 0.50 — Accuracy {metrics['accuracy']:.3f} | "
        f"Precision {metrics['precision']:.3f} | Recall {metrics['recall']:.3f} | "
        f"F1 {metrics['f1']:.3f} | AUC {metrics['auc']:.3f}"
    )
    threshold = result["threshold"]
    selected = result["metrics_at_threshold"]
    print(
        f"Threshold {threshold['value']:.2f} ({threshold['source']}) — "
        f"Accuracy {selected['accuracy']:.3f} | F1 {selected['f1']:.3f}"
    )
    cv = result["cross_validation"]
    if cv and cv["available"]:
        print(
            f"{cv['actual_folds']}-fold training CV: AUC {cv['auc_mean']:.3f} ± "
            f"{cv['auc_std']:.3f} | Accuracy {cv['accuracy_mean']:.3f} ± {cv['accuracy_std']:.3f}"
        )
    elif cv:
        print(f"Cross-validation unavailable: {cv['reason']}")

    print("\n  feature                     coef     odds    p-value")
    for coefficient in result["coefficients"]:
        p_value = "n/a" if coefficient["p_value"] is None else (
            "<0.001" if coefficient["p_value"] < 0.001 else f"{coefficient['p_value']:.3f}"
        )
        print(
            f"  {coefficient['name']:<25} {coefficient['coef']:+7.3f}  "
            f"{coefficient['odds_ratio']:6.2f}   {p_value}"
        )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--url",
        help="Call a running HTTPS API at this base URL instead of the local engine.",
    )
    args = parser.parse_args()
    feature_names, features, labels = load_sample()
    payload = {
        "features": features,
        "labels": labels,
        "feature_names": feature_names,
        "standardize": True,
        "test_size": 0.3,
        "cv_folds": 5,
    }

    if args.url:
        url = args.url.rstrip("/") + "/train"
        request = urllib.request.Request(
            url,
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"},
        )
        try:
            result = json.loads(urllib.request.urlopen(request, timeout=30).read())
        except ssl.SSLCertVerificationError as exc:
            raise SystemExit(
                "The backend certificate is not trusted by this Python environment. "
                "Install/trust the Office development certificate, then retry."
            ) from exc
    else:
        from model import train_logistic

        result, _ = train_logistic(**payload)

    json.dumps(result, allow_nan=False)
    display(result)


if __name__ == "__main__":
    main()
