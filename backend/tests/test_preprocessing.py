"""Unit tests for pure NumPy feature standardization and constant feature checks."""

from __future__ import annotations

import unittest

import numpy as np

from preprocessing import StandardScalerScratch, check_constant_features


class TestStandardScalerScratch(unittest.TestCase):
    def test_standardize_normal_data(self):
        X = np.array([[10.0, 100.0], [20.0, 200.0], [30.0, 300.0]])
        scaler = StandardScalerScratch().fit(X)

        # Means: 20.0, 200.0
        np.testing.assert_allclose(scaler.mean_, [20.0, 200.0])
        # Population standard deviations ddof=0
        expected_stds = np.std(X, axis=0, ddof=0)
        np.testing.assert_allclose(scaler.scale_, expected_stds)

        X_trans = scaler.transform(X)
        np.testing.assert_allclose(np.mean(X_trans, axis=0), [0.0, 0.0], atol=1e-12)
        np.testing.assert_allclose(np.std(X_trans, axis=0, ddof=0), [1.0, 1.0], atol=1e-12)

    def test_zero_variance_feature_handling(self):
        # Column 1 is normal, Column 2 is constant (zero variance)
        X = np.array([[1.0, 44.0], [2.0, 44.0], [3.0, 44.0]])
        scaler = StandardScalerScratch().fit(X)

        self.assertEqual(scaler.zero_variance_indices_, [1])
        # Scale for zero variance feature should be 1.0
        self.assertEqual(scaler.scale_[1], 1.0)

        X_trans = scaler.transform(X)
        # Transformed constant column should be all zeros: (44 - 44) / 1 = 0
        np.testing.assert_allclose(X_trans[:, 1], [0.0, 0.0, 0.0])
        self.assertTrue(np.isfinite(X_trans).all())

    def test_transform_held_out_data_preserves_training_statistics(self):
        X_train = np.array([[0.0], [10.0]])
        scaler = StandardScalerScratch().fit(X_train)
        # mean=5.0, std=5.0
        X_test = np.array([[15.0]])
        # (15 - 5) / 5 = 2.0
        X_test_trans = scaler.transform(X_test)
        self.assertAlmostEqual(float(X_test_trans[0, 0]), 2.0, places=9)


class TestConstantFeaturesCheck(unittest.TestCase):
    def test_detect_constant_column(self):
        X = np.array([[1.0, 5.0], [2.0, 5.0], [3.0, 5.0]])
        constant_names = check_constant_features(X, ["feat_a", "feat_b"])
        self.assertEqual(constant_names, ["feat_b"])

    def test_reject_all_constant_features(self):
        X = np.array([[44.0, 10.0], [44.0, 10.0], [44.0, 10.0]])
        with self.assertRaises(ValueError) as ctx:
            check_constant_features(X, ["feat_a", "feat_b"])
        self.assertIn("All selected feature columns are constant", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
