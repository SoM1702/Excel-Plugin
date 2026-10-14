"""Unit tests for pure NumPy stratified splitting and cross-validation."""

from __future__ import annotations

import math
import unittest

import numpy as np

from splitting import StratifiedKFoldScratch, train_test_split_scratch


class TestTrainTestSplitScratch(unittest.TestCase):
    def test_exact_rounding_and_counts(self):
        # 400 samples with 70/30 split: 120 test, 280 train
        y = np.array([0] * 200 + [1] * 200)
        train_idx, test_idx, meta = train_test_split_scratch(y, test_size=0.30, random_state=42)

        self.assertEqual(len(test_idx), 120)
        self.assertEqual(len(train_idx), 280)
        self.assertEqual(meta["n_test"], 120)
        self.assertEqual(meta["n_train"], 280)

        # 400 samples with 80/20 split: 80 test, 320 train
        train_idx80, test_idx80, meta80 = train_test_split_scratch(y, test_size=0.20, random_state=42)
        self.assertEqual(len(test_idx80), 80)
        self.assertEqual(len(train_idx80), 320)

    def test_disjointness_and_coverage(self):
        N = 105
        y = np.array([0] * 60 + [1] * 45)
        # ceil(105 * 0.3) = ceil(31.5) = 32 test, 73 train
        train_idx, test_idx, meta = train_test_split_scratch(y, test_size=0.30, random_state=99)

        self.assertEqual(len(test_idx), 32)
        self.assertEqual(len(train_idx), 73)

        # Disjoint
        self.assertEqual(len(set(train_idx).intersection(set(test_idx))), 0)
        # Full coverage
        all_indices = set(train_idx).union(set(test_idx))
        self.assertEqual(all_indices, set(range(N)))

    def test_preserves_both_classes_in_partitions(self):
        # Imbalanced outcome: 90 negative, 10 positive
        y = np.array([0] * 90 + [1] * 10)
        train_idx, test_idx, _ = train_test_split_scratch(y, test_size=0.25, random_state=42)

        y_test = y[test_idx]
        y_train = y[train_idx]

        self.assertGreaterEqual(int(np.sum(y_test == 0)), 1)
        self.assertGreaterEqual(int(np.sum(y_test == 1)), 1)
        self.assertGreaterEqual(int(np.sum(y_train == 0)), 1)
        self.assertGreaterEqual(int(np.sum(y_train == 1)), 1)

    def test_reproducibility_with_seed(self):
        y = np.array([0] * 50 + [1] * 50)
        t1, s1, _ = train_test_split_scratch(y, test_size=0.3, random_state=42)
        t2, s2, _ = train_test_split_scratch(y, test_size=0.3, random_state=42)
        np.testing.assert_array_equal(t1, t2)
        np.testing.assert_array_equal(s1, s2)

    def test_bounds_rejection(self):
        y = np.array([0] * 20 + [1] * 20)
        # test_size < 0.05
        with self.assertRaises(ValueError):
            train_test_split_scratch(y, test_size=0.02)
        # test_size > 0.80
        with self.assertRaises(ValueError):
            train_test_split_scratch(y, test_size=0.85)


class TestStratifiedKFoldScratch(unittest.TestCase):
    def test_k_fold_partitions(self):
        y = np.array([0] * 50 + [1] * 50)
        X = np.zeros((100, 2))
        kfold = StratifiedKFoldScratch(n_splits=5, shuffle=True, random_state=42)

        seen_val_indices = []
        for train_idx, val_idx in kfold.split(X, y):
            # Each val set has 20 samples
            self.assertEqual(len(val_idx), 20)
            self.assertEqual(len(train_idx), 80)
            # Both classes in val fold
            self.assertEqual(int(np.sum(y[val_idx] == 0)), 10)
            self.assertEqual(int(np.sum(y[val_idx] == 1)), 10)
            seen_val_indices.extend(val_idx.tolist())

        # All indices covered exactly once across all validation folds
        self.assertEqual(sorted(seen_val_indices), list(range(100)))


if __name__ == "__main__":
    unittest.main()
