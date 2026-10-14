"""Unit tests for pure NumPy classification metrics, ROC curve, and tied AUC."""

from __future__ import annotations

import math
import unittest

import numpy as np

from metrics import (
    classification_metrics,
    confusion_matrix_scratch,
    log_loss_scratch,
    roc_auc_scratch,
    roc_curve_scratch,
)


class TestMetricsScratch(unittest.TestCase):
    def test_confusion_and_classification_metrics(self):
        y_true = np.array([1, 1, 0, 0, 1, 0])
        # Suppose predictions at threshold 0.5 are [1, 0, 0, 1, 1, 0]
        # TP: y=1, pred=1 -> 2 (indices 0, 4)
        # FN: y=1, pred=0 -> 1 (index 1)
        # FP: y=0, pred=1 -> 1 (index 3)
        # TN: y=0, pred=0 -> 2 (indices 2, 5)
        probs = np.array([0.9, 0.4, 0.1, 0.8, 0.7, 0.2])

        metrics = classification_metrics(y_true, probs, threshold=0.5, train_majority_class=0)
        counts = metrics["confusion_matrix"]
        self.assertEqual(counts["tp"], 2)
        self.assertEqual(counts["fn"], 1)
        self.assertEqual(counts["fp"], 1)
        self.assertEqual(counts["tn"], 2)

        # Accuracy: (2 + 2) / 6 = 4/6 = 2/3
        self.assertAlmostEqual(metrics["accuracy"], 4.0 / 6.0, places=7)
        # Precision: 2 / (2 + 1) = 2/3
        self.assertAlmostEqual(metrics["precision"], 2.0 / 3.0, places=7)
        # Recall: 2 / (2 + 1) = 2/3
        self.assertAlmostEqual(metrics["recall"], 2.0 / 3.0, places=7)
        # F1: 2/3
        self.assertAlmostEqual(metrics["f1"], 2.0 / 3.0, places=7)

        # Train majority is class 0: 3 out of 6 in y_true are 0, so baseline_acc = 3/6 = 0.5
        self.assertAlmostEqual(metrics["baseline_accuracy"], 0.5, places=7)
        self.assertAlmostEqual(metrics["accuracy_gain"], (4.0 / 6.0) - 0.5, places=7)

    def test_log_loss_hand_value(self):
        y_true = np.array([1, 0])
        probs = np.array([0.5, 0.5])
        # - [1*ln(0.5) + 1*ln(0.5)] / 2 = -ln(0.5) = ln(2)
        loss = log_loss_scratch(y_true, probs)
        self.assertAlmostEqual(loss, math.log(2.0), places=7)

    def test_roc_auc_perfect(self):
        y_true = np.array([0, 0, 1, 1])
        probs = np.array([0.1, 0.2, 0.8, 0.9])
        auc = roc_auc_scratch(y_true, probs)
        self.assertEqual(auc, 1.0)

    def test_roc_auc_reversed(self):
        y_true = np.array([0, 0, 1, 1])
        probs = np.array([0.9, 0.8, 0.2, 0.1])
        auc = roc_auc_scratch(y_true, probs)
        self.assertEqual(auc, 0.0)

    def test_roc_auc_all_tied(self):
        y_true = np.array([0, 0, 1, 1])
        probs = np.array([0.5, 0.5, 0.5, 0.5])
        auc = roc_auc_scratch(y_true, probs)
        self.assertEqual(auc, 0.5)

    def test_roc_auc_single_class(self):
        y_true = np.array([1, 1, 1])
        probs = np.array([0.2, 0.5, 0.8])
        auc = roc_auc_scratch(y_true, probs)
        self.assertIsNone(auc)

        fpr, tpr, thresholds = roc_curve_scratch(y_true, probs)
        self.assertEqual(fpr, [])
        self.assertEqual(tpr, [])
        self.assertEqual(thresholds, [])

    def test_roc_auc_100_mixed_tie_cases_matches_wilcoxon(self):
        rng = np.random.default_rng(2024)
        for trial in range(100):
            n_samples = rng.integers(10, 40)
            # Ensure both classes present
            n_pos = rng.integers(2, n_samples - 2)
            y = np.zeros(n_samples, dtype=int)
            pos_idx = rng.choice(n_samples, size=n_pos, replace=False)
            y[pos_idx] = 1

            # Generate probabilities with high rate of ties by sampling from small discrete set
            discrete_levels = [0.1, 0.3, 0.5, 0.7, 0.9]
            probs = rng.choice(discrete_levels, size=n_samples).astype(float)

            auc_trapezoid = roc_auc_scratch(y, probs)

            # Independent Mann-Whitney / Wilcoxon formulation:
            # sum over positive-negative pairs: 1 if pos > neg, 0.5 if pos == neg, 0 otherwise
            pos_scores = probs[y == 1]
            neg_scores = probs[y == 0]
            pairwise_sum = 0.0
            for ps in pos_scores:
                for ns in neg_scores:
                    if ps > ns:
                        pairwise_sum += 1.0
                    elif ps == ns:
                        pairwise_sum += 0.5

            expected_auc = pairwise_sum / (len(pos_scores) * len(neg_scores))
            self.assertAlmostEqual(
                auc_trapezoid,
                expected_auc,
                places=9,
                msg=f"Trial {trial} failed: AUC trapezoid {auc_trapezoid} != Wilcoxon {expected_auc}",
            )


if __name__ == "__main__":
    unittest.main()
