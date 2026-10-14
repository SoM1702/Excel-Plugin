"""Pure NumPy classification metrics, ROC curve, and tied-score AUC from scratch.

Computes:
  - Confusion matrix counts (TN, FP, FN, TP)
  - Accuracy, precision, recall, F1 score
  - Probability log loss (binary cross-entropy evaluation metric)
  - ROC curve (advancing tied scores simultaneously)
  - Area Under the ROC Curve (AUC) via trapezoidal integration and rank sum
  - Training-derived majority class baseline accuracy
"""

from __future__ import annotations

import math

import numpy as np


def confusion_matrix_scratch(y_true: np.ndarray, y_pred: np.ndarray) -> dict[str, int]:
    """Compute confusion counts: tn, fp, fn, tp."""
    y_true = np.asarray(y_true, dtype=int)
    y_pred = np.asarray(y_pred, dtype=int)

    tp = int(np.sum((y_true == 1) & (y_pred == 1)))
    tn = int(np.sum((y_true == 0) & (y_pred == 0)))
    fp = int(np.sum((y_true == 0) & (y_pred == 1)))
    fn = int(np.sum((y_true == 1) & (y_pred == 0)))

    return {"tn": tn, "fp": fp, "fn": fn, "tp": tp}


def log_loss_scratch(y_true: np.ndarray, probs: np.ndarray, eps: float = 1e-15) -> float:
    """Compute unweighted binary cross-entropy evaluation loss."""
    y_true = np.asarray(y_true, dtype=float)
    probs = np.asarray(probs, dtype=float)

    if len(y_true) == 0:
        return 0.0

    p_clipped = np.clip(probs, eps, 1.0 - eps)
    loss = -np.mean(y_true * np.log(p_clipped) + (1.0 - y_true) * np.log(1.0 - p_clipped))
    return float(loss)


def roc_curve_scratch(
    y_true: np.ndarray, probs: np.ndarray
) -> tuple[list[float], list[float], list[float]]:
    """Compute ROC curve advancing tied scores together.

    Returns:
        fpr: False positive rate coordinates (starting at 0.0, ending at 1.0).
        tpr: True positive rate coordinates (starting at 0.0, ending at 1.0).
        thresholds: Distinct classification thresholds.
    """
    y_true = np.asarray(y_true, dtype=int)
    probs = np.asarray(probs, dtype=float)

    n_pos = int(np.sum(y_true == 1))
    n_neg = int(np.sum(y_true == 0))

    if n_pos == 0 or n_neg == 0:
        return [], [], []

    # Sort in descending order of predicted probability
    desc_indices = np.argsort(-probs, kind="mergesort")
    y_sorted = y_true[desc_indices]
    p_sorted = probs[desc_indices]

    # Find unique probability thresholds to advance tied scores together
    # Identify indices where probability changes
    distinct_mask = np.empty(len(p_sorted), dtype=bool)
    distinct_mask[:-1] = p_sorted[:-1] != p_sorted[1:]
    distinct_mask[-1] = True
    threshold_indices = np.where(distinct_mask)[0]

    # Cumulative TP and FP
    cum_tp = np.cumsum(y_sorted == 1)
    cum_fp = np.cumsum(y_sorted == 0)

    tpr = [0.0] + [float(cum_tp[idx] / n_pos) for idx in threshold_indices]
    fpr = [0.0] + [float(cum_fp[idx] / n_neg) for idx in threshold_indices]
    thresholds = [float(p_sorted[0] + 1.0)] + [float(p_sorted[idx]) for idx in threshold_indices]

    return fpr, tpr, thresholds


def roc_auc_scratch(y_true: np.ndarray, probs: np.ndarray) -> float | None:
    """Compute Area Under ROC Curve with exact handling of tied scores.

    Returns None if only one outcome class exists.
    """
    y_true = np.asarray(y_true, dtype=int)
    probs = np.asarray(probs, dtype=float)

    n_pos = int(np.sum(y_true == 1))
    n_neg = int(np.sum(y_true == 0))

    if n_pos == 0 or n_neg == 0:
        return None

    # Check if all scores are identical (all tied)
    if np.all(probs == probs[0]):
        return 0.5

    # Compute trapezoidal AUC from ROC curve
    fpr, tpr, _ = roc_curve_scratch(y_true, probs)
    auc = 0.0
    for i in range(1, len(fpr)):
        auc += 0.5 * (tpr[i] + tpr[i - 1]) * (fpr[i] - fpr[i - 1])

    return float(np.clip(auc, 0.0, 1.0))


def classification_metrics(
    y_true: np.ndarray,
    probs: np.ndarray,
    threshold: float = 0.5,
    train_majority_class: int | None = None,
) -> dict:
    """Compute all evaluation metrics at a specified decision threshold."""
    y_true = np.asarray(y_true, dtype=int)
    probs = np.asarray(probs, dtype=float)
    threshold = float(threshold)

    pred = (probs >= threshold).astype(int)
    counts = confusion_matrix_scratch(y_true, pred)
    tp, tn, fp, fn = counts["tp"], counts["tn"], counts["fp"], counts["fn"]
    total = len(y_true)

    accuracy = float((tp + tn) / total) if total > 0 else 0.0
    precision = float(tp / (tp + fp)) if (tp + fp) > 0 else 0.0
    recall = float(tp / (tp + fn)) if (tp + fn) > 0 else 0.0
    f1 = float(2.0 * precision * recall / (precision + recall)) if (precision + recall) > 0 else 0.0
    log_loss_val = log_loss_scratch(y_true, probs)
    auc_val = roc_auc_scratch(y_true, probs)
    brier_score = float(np.mean((probs - y_true) ** 2)) if total > 0 else 0.0

    # Baseline majority-class accuracy derived from training distribution
    if train_majority_class is not None:
        baseline_acc = float(np.mean(y_true == train_majority_class)) if total > 0 else 0.0
        acc_gain = float(accuracy - baseline_acc)
    else:
        # Fallback to test majority class if training distribution not supplied
        if total > 0:
            majority = int(np.bincount(y_true, minlength=2).argmax())
            baseline_acc = float(np.mean(y_true == majority))
            acc_gain = float(accuracy - baseline_acc)
        else:
            baseline_acc = 0.0
            acc_gain = 0.0

    return {
        "threshold": threshold,
        "accuracy": accuracy,
        "precision": precision,
        "recall": recall,
        "f1": f1,
        "auc": auc_val,
        "auc_reason": (
            None
            if auc_val is not None
            else "AUC is undefined because the evaluation set contains only one outcome class."
        ),
        "log_loss": log_loss_val,
        "brier_score": brier_score,
        "baseline_accuracy": baseline_acc,
        "accuracy_gain": acc_gain,
        "confusion_matrix": counts,
    }
