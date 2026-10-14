"""Run a readable smoke test of the local training engine or HTTP API.

Examples:
  python test_api.py
  python test_api.py --url https://localhost:8000

The default uses the scratch engine directly and needs no server.
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
    if not csv_path.exists():
        raise FileNotFoundError(
            f"Test fixture {csv_path} not found. Tests must not regenerate or overwrite the workbook."
        )
    with csv_path.open(newline="") as source:
        rows = list(csv.reader(source))
    header = rows[0]
    data = [[float(value) for value in row] for row in rows[1:]]
    return header[:-1], [row[:-1] for row in data], [int(row[-1]) for row in data]


def display(result):
    evaluation = result["evaluation"]
    split = result["split"]
    diag = result.get("diagnostics", {})
    print(
        f"\nEngine: {result.get('engine', 'scratch')} ({result.get('method', 'Full-batch gradient descent')})"
    )
    print(
        f"Samples: {result['n_samples']}   Features: {result['n_features']}   "
        f"Allocation: Train {split['n_train']} ({split['actual_train_percent']}%), Test {split['n_test']} ({split['actual_test_percent']}%)"
    )
    if diag:
        status_str = "Converged" if diag.get("converged") else "Not converged"
        grad_norm_str = f"{diag['gradient_norm']:.2e}" if diag.get("gradient_norm") is not None else "n/a"
        print(
            f"Diagnostics: {status_str} in {diag.get('iterations')} iters | "
            f"Loss: {diag.get('initial_loss', 0):.4f} -> {diag.get('final_loss', 0):.4f} | "
            f"Grad Norm: {grad_norm_str} | Time: {diag.get('elapsed_seconds', 0)}s"
        )

    metrics = result["metrics"]
    print(
        f"Fixed 0.50 — Accuracy {metrics['accuracy']:.3f} | "
        f"Precision {metrics['precision']:.3f} | Recall {metrics['recall']:.3f} | "
        f"F1 {metrics['f1']:.3f} | AUC {metrics['auc']:.3f} | Brier {metrics.get('brier_score', 0):.3f}"
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
        p_val = "n/a" if coefficient.get("p_value") is None else f"{coefficient['p_value']:.3f}"
        odds_str = f"{coefficient['odds_ratio']:6.2f}" if coefficient.get("odds_ratio") is not None else "   inf"
        print(
            f"  {coefficient['name']:<25} {coefficient['coef']:+7.3f}  "
            f"{odds_str}   {p_val}"
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
        "learning_rate": 0.1,
        "max_iterations": 10000,
        "tolerance": 1e-6,
        "l2_lambda": 0.0,
        "cv_folds": 5,
        "random_state": 42,
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

    # Smoke assertions
    rendered = json.dumps(result, allow_nan=False)
    assert "NaN" not in rendered
    assert result["metrics"]["accuracy"] > 0.60
    assert result["metrics"]["auc"] > 0.70
    assert result["split"]["n_train"] == 280
    assert result["split"]["n_test"] == 120

    display(result)


if __name__ == "__main__":
    main()
