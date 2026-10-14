"""Integration tests for model.py using pure NumPy scratch engine."""

from __future__ import annotations

import json
import math
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np

import model as engine
from model import train_logistic


def load_sample():
    csv_path = Path(__file__).parent.parent.joinpath("sample_data.csv")
    if not csv_path.exists():
        raise FileNotFoundError(
            f"Test fixture {csv_path} not found. Tests must not regenerate or overwrite the workbook."
        )
    rows = csv_path.read_text().splitlines()
    header = rows[0].split(",")
    data = [[float(value) for value in row.split(",")] for row in rows[1:] if row]
    return header[:-1], [row[:-1] for row in data], [int(row[-1]) for row in data]


class ModelTests(unittest.TestCase):
    def setUp(self):
        self.feature_names, self.features, self.labels = load_sample()

    def test_sample_result_is_json_safe_and_has_reproducible_shape(self):
        result, model = train_logistic(
            self.features,
            self.labels,
            feature_names=self.feature_names,
            cv_folds=5,
        )

        json.dumps(result, allow_nan=False)
        self.assertEqual(result["n_samples"], 400)
        self.assertEqual(result["n_features"], 9)
        self.assertEqual(len(result["predictions"]["prob"]), 400)
        self.assertEqual(len(result["predictions"]["partition"]), 400)
        self.assertEqual(result["model_id"], model.model_id)
        self.assertEqual(result["engine"], "scratch")
        self.assertEqual(result["evaluation"]["mode"], "held-out test")
        self.assertEqual(result["threshold"]["source"], "training_cross_validation")
        self.assertTrue(result["cross_validation"]["available"])
        self.assertGreaterEqual(result["threshold"]["value"], 0.05)
        self.assertLessEqual(result["threshold"]["value"], 0.95)

        # Check diagnostics
        diag = result["diagnostics"]
        self.assertIn("initial_loss", diag)
        self.assertIn("final_loss", diag)
        self.assertIn("iterations", diag)
        self.assertIn("loss_history", diag)
        self.assertLess(diag["final_loss"], diag["initial_loss"])

    def test_rare_class_cross_validation_is_explained_without_nan(self):
        features = [[float(index), float(index % 3)] for index in range(40)]
        labels = [0] * 38 + [1] * 2
        result, _ = train_logistic(features, labels, cv_folds=5)

        json.dumps(result, allow_nan=False)
        self.assertFalse(result["cross_validation"]["available"])
        self.assertIsNone(result["cross_validation"]["actual_folds"])
        self.assertEqual(result["threshold"]["value"], 0.5)

    def test_requested_held_out_split_exact_counts(self):
        features = [[float(index), float(index % 5)] for index in range(20)]
        labels = [0, 1] * 10
        result, _ = train_logistic(features, labels, test_size=0.3)

        self.assertEqual(result["evaluation"]["mode"], "held-out test")
        # ceil(20 * 0.3) = 6
        self.assertEqual(result["evaluation"]["n_test"], 6)
        self.assertEqual(result["evaluation"]["n_train"], 14)

    def test_invalid_split_is_rejected(self):
        features = [[float(index), float(index % 5)] for index in range(40)]
        labels = [0, 1] * 20
        with self.assertRaisesRegex(ValueError, "Test split"):
            train_logistic(features, labels, test_size=0.02)

    def test_constant_features_rejection(self):
        features = [[44.0, 1.0], [44.0, 1.0], [44.0, 1.0], [44.0, 1.0], [44.0, 1.0],
                    [44.0, 1.0], [44.0, 1.0], [44.0, 1.0], [44.0, 1.0], [44.0, 1.0]]
        labels = [0, 1] * 5
        with self.assertRaises(ValueError):
            train_logistic(features, labels)

    def test_threshold_selector_receives_training_side_cv_predictions_only(self):
        with patch("model._best_f1_threshold", wraps=engine._best_f1_threshold) as selector:
            result, _ = train_logistic(
                self.features,
                self.labels,
                feature_names=self.feature_names,
                cv_folds=5,
            )

        labels_seen_by_selector = selector.call_args.args[0]
        self.assertEqual(len(labels_seen_by_selector), result["evaluation"]["n_train"])
        self.assertNotEqual(len(labels_seen_by_selector), result["evaluation"]["n_test"])

    def test_blank_and_whitespace_labels_rejected(self):
        features = [[float(i), float(i)] for i in range(10)]
        with self.assertRaisesRegex(ValueError, "blank or whitespace"):
            train_logistic(features, ["", "Yes"] * 5)
        with self.assertRaisesRegex(ValueError, "blank or whitespace"):
            train_logistic(features, ["   ", "Yes"] * 5)

    def test_constant_training_partition_rejected(self):
        # 10 rows: overall has variation, but rows partitioned into train (seed 42) are all 10.0
        features = [[12.0] if i in (4, 7, 8) else [10.0] for i in range(10)]
        labels = [0, 1, 0, 1, 0, 1, 0, 1, 0, 1]
        with self.assertRaisesRegex(ValueError, "training partition are constant"):
            train_logistic(features, labels, test_size=0.3, random_state=42)

    def test_small_unit_scale_features_accepted(self):
        # Features with very small units (1e-12) must NOT be rejected as constant
        rng = np.random.default_rng(42)
        raw_vals = rng.normal(size=(20, 2)) * 1e-12
        labels = [0, 1] * 10
        result, model = train_logistic(raw_vals.tolist(), labels, test_size=0.3)
        self.assertTrue(result["ok"])

    def test_numerical_overflow_features_rejected_without_activation(self):
        # Huge feature values (1e308) that overflow scaling / gradients
        huge_feats = [[1e308, 1e308] for _ in range(10)]
        huge_feats[0][0] = 0.5e308
        labels = [0, 0, 0, 0, 0, 1, 1, 1, 1, 1]
        with self.assertRaises(ValueError):
            train_logistic(huge_feats, labels, standardize=True)
        with self.assertRaises(ValueError):
            train_logistic(huge_feats, labels, standardize=False)

    def test_cross_validation_fold_diagnostics_retained(self):
        result, _ = train_logistic(
            self.features,
            self.labels,
            feature_names=self.feature_names,
            cv_folds=5,
        )
        cv = result["cross_validation"]
        self.assertTrue(cv["available"])
        self.assertIn("converged_folds", cv)
        self.assertIn("all_converged", cv)
        self.assertEqual(len(cv["folds"]), 5)
        for fold in cv["folds"]:
            self.assertIn("converged", fold)
            self.assertIn("stop_reason", fold)

    def test_full_precision_probabilities_unrounded(self):
        result, _ = train_logistic(
            self.features,
            self.labels,
            feature_names=self.feature_names,
            cv_folds=0,
        )
        probs = result["predictions"]["prob"]
        # Float values should retain precision beyond 6 decimal digits
        has_high_precision = any(
            len(str(p).split(".")[1]) > 6 for p in probs if "." in str(p)
        )
        self.assertTrue(has_high_precision)

    def test_three_feature_model_parameters_structure_and_counts(self):
        # 3 features: exactly 3 weights and 1 intercept in both spaces
        rng = np.random.default_rng(101)
        X = rng.normal(size=(30, 3)).tolist()
        y = ([0, 1] * 15)
        names = ["Feature_A", "Feature_B", "Feature_C"]
        result, model = train_logistic(X, y, feature_names=names, standardize=True)

        params = result["parameters"]
        self.assertEqual(len(params["feature_names"]), 3)
        self.assertEqual(params["feature_names"], names)
        self.assertEqual(len(params["weights_model_space"]), 3)
        self.assertIsInstance(params["intercept_model_space"], float)
        self.assertEqual(len(params["weights_original_units"]), 3)
        self.assertIsInstance(params["intercept_original_units"], float)
        self.assertEqual(len(params["feature_means"]), 3)
        self.assertEqual(len(params["feature_scales"]), 3)
        self.assertEqual(params["feature_space"], "standardized")
        self.assertTrue(params["conversion_valid"])
        self.assertTrue(params["standardized"])

        # Coefficients list has Intercept + 3 features = 4 rows
        self.assertEqual(len(result["coefficients"]), 4)
        self.assertEqual(result["coefficients"][0]["name"], "Intercept")
        self.assertEqual([row["name"] for row in result["coefficients"][1:]], names)

    def test_parameter_conversion_numerical_equivalence_with_scaling(self):
        # Compare raw-space linear score with model-space linear score
        result, model = train_logistic(
            self.features,
            self.labels,
            feature_names=self.feature_names,
            standardize=True,
        )
        params = result["parameters"]
        self.assertTrue(params["conversion_valid"])

        w_orig = np.array(params["weights_original_units"], dtype=float)
        b_orig = float(params["intercept_original_units"])

        X_raw = np.array(self.features, dtype=float)
        z_raw = X_raw @ w_orig + b_orig

        # Model scores from model.predict_score
        z_model = model.predict_score(X_raw)
        np.testing.assert_allclose(z_raw, z_model, rtol=1e-9, atol=1e-9)

        # Sigmoid of raw scores matches model.predict_proba
        p_raw = 1.0 / (1.0 + np.exp(-np.clip(z_raw, -500, 500)))
        p_model = model.predict_proba(X_raw)
        np.testing.assert_allclose(p_raw, p_model, rtol=1e-9, atol=1e-9)

        # Also verify predictions object includes score
        scores_in_result = result["predictions"]["score"]
        self.assertEqual(len(scores_in_result), len(self.features))
        np.testing.assert_allclose(scores_in_result, z_model, rtol=1e-9, atol=1e-9)

    def test_parameters_with_scaling_disabled(self):
        result, model = train_logistic(
            self.features,
            self.labels,
            feature_names=self.feature_names,
            standardize=False,
        )
        params = result["parameters"]
        self.assertEqual(params["feature_space"], "original")
        self.assertFalse(params["standardized"])
        self.assertTrue(params["conversion_valid"])
        self.assertIsNone(params["feature_means"])
        self.assertIsNone(params["feature_scales"])
        self.assertEqual(params["weights_original_units"], params["weights_model_space"])
        self.assertEqual(params["intercept_original_units"], params["intercept_model_space"])

        X_raw = np.array(self.features, dtype=float)
        z_raw = X_raw @ np.array(params["weights_original_units"]) + params["intercept_original_units"]
        z_model = model.predict_score(X_raw)
        np.testing.assert_allclose(z_raw, z_model, rtol=1e-12, atol=1e-12)

    def test_small_scale_features_retain_precision(self):
        rng = np.random.default_rng(42)
        raw_vals = rng.normal(size=(20, 2)) * 1e-9
        labels = [0, 1] * 10
        result, model = train_logistic(raw_vals.tolist(), labels, test_size=0.3)
        params = result["parameters"]
        self.assertTrue(params["conversion_valid"])
        # feature_scales should not be 0.0 despite small magnitude
        for s in params["feature_scales"]:
            self.assertGreater(s, 0.0)
            self.assertLess(s, 1e-7)

    def test_single_zero_variance_feature_parameter_conversion(self):
        # 1 constant feature and 1 varying feature
        rng = np.random.default_rng(42)
        v = rng.normal(size=20)
        feats = [[42.0, float(v[i])] for i in range(20)]
        labels = [0, 1] * 10
        result, model = train_logistic(feats, labels, feature_names=["Const", "Vary"])
        params = result["parameters"]
        self.assertTrue(params["conversion_valid"])
        # Constant feature scale must be 1.0
        self.assertEqual(params["feature_scales"][0], 1.0)
        # Numerical equivalence check
        X_raw = np.array(feats, dtype=float)
        w_orig = np.array(params["weights_original_units"], dtype=float)
        b_orig = params["intercept_original_units"]
        z_raw = X_raw @ w_orig + b_orig
        z_model = model.predict_score(X_raw)
        np.testing.assert_allclose(z_raw, z_model, rtol=1e-9, atol=1e-9)

    def test_extreme_offset_1e16_conversion_invalidation(self):
        # Features with huge offset 1e16 experience catastrophic cancellation in b_orig
        rng = np.random.default_rng(42)
        base = rng.normal(size=(20, 2))
        X_extreme = 1e16 + base
        labels = [0, 1] * 10
        result, model = train_logistic(X_extreme.tolist(), labels, test_size=0.3, max_iterations=100)
        params = result["parameters"]
        # Conversion must be invalidated because raw vs model scores disagree
        self.assertFalse(params["conversion_valid"])
        self.assertIsNone(params["weights_original_units"])
        self.assertIsNone(params["intercept_original_units"])
        self.assertIsNotNone(params["conversion_reason"])
        self.assertIn("numerical disagreement", params["conversion_reason"].lower())
        # Warning must be present in training_warnings
        self.assertTrue(any("numerical disagreement" in str(w).lower() for w in result["training_warnings"]))
        # Valid model-space predictions still function
        preds = model.predict_proba(X_extreme)
        self.assertTrue(np.isfinite(preds).all())

    def test_splits_and_reports_80_20_and_65_35(self):
        # 80/20 split
        res_80, _ = train_logistic(self.features, self.labels, test_size=0.2)
        self.assertAlmostEqual(res_80["split"]["requested_train_percent"], 80.0)
        self.assertAlmostEqual(res_80["split"]["requested_test_percent"], 20.0)
        self.assertEqual(res_80["training_settings"]["test_size"], 0.2)

        # 65/35 split
        res_65, _ = train_logistic(self.features, self.labels, test_size=0.35)
        self.assertAlmostEqual(res_65["split"]["requested_train_percent"], 65.0)
        self.assertAlmostEqual(res_65["split"]["requested_test_percent"], 35.0)
        self.assertEqual(res_65["training_settings"]["test_size"], 0.35)

    def test_objective_with_lambda_positive(self):
        res, model = train_logistic(self.features[:30], self.labels[:30], l2_lambda=2.5, max_iterations=50)
        self.assertEqual(res["training_settings"]["l2_lambda"], 2.5)
        self.assertTrue(math.isfinite(res["diagnostics"]["final_loss"]))

    def test_separation_warning_displayed(self):
        # Perfectly separable 1D dataset without regularization
        X = [[-10.0], [-9.0], [-8.0], [-7.0], [-6.0], [6.0], [7.0], [8.0], [9.0], [10.0]]
        y = [0, 0, 0, 0, 0, 1, 1, 1, 1, 1]
        res, model = train_logistic(X, y, feature_names=["SepX"], l2_lambda=0.0, max_iterations=50)
        # Warning must be present in diagnostics and in training_warnings
        warnings_str = " ".join(res["training_warnings"]).lower()
        self.assertIn("separable", warnings_str)

    def test_partly_non_converged_cv_folds(self):
        # Cross validation with max_iterations=10 and tiny tolerance to ensure folds do not reach convergence tolerance
        res, model = train_logistic(
            self.features[:30],
            self.labels[:30],
            cv_folds=3,
            max_iterations=10,
            tolerance=1e-12,
        )
        cv = res["cross_validation"]
        self.assertIsNotNone(cv)
        self.assertTrue(cv["available"])
        self.assertLess(cv["converged_folds"], cv["actual_folds"])
        self.assertFalse(cv["all_converged"])


if __name__ == "__main__":
    unittest.main()

