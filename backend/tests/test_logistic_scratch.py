"""Unit and numerical verification tests for pure NumPy scratch logistic regression.

Tests:
  1. Numerically stable sigmoid function (0, large positive, large negative).
  2. Binary cross-entropy loss against hand-derived values.
  3. Single-observation worked teaching example (initial loss, dw, db, parameter updates).
  4. Central finite-difference gradient checks (dw and db) across multiple fixtures.
  5. Finite-difference checks with L2 regularization and balanced sample weights.
  6. Fitting and convergence on synthetic non-separable classification data.
  7. Step-halving line search behavior and bounded loss history preservation.
"""

from __future__ import annotations

import math
import unittest

import numpy as np

from logistic_scratch import (
    LogisticRegressionScratch,
    compute_bce_loss,
    compute_gradients,
    compute_sample_weights,
    sigmoid,
)


class TestSigmoid(unittest.TestCase):
    def test_sigmoid_zero(self):
        self.assertAlmostEqual(float(sigmoid(0.0)), 0.5, places=9)

    def test_sigmoid_symmetry(self):
        val = 2.5
        self.assertAlmostEqual(float(sigmoid(val) + sigmoid(-val)), 1.0, places=9)

    def test_sigmoid_large_values_no_overflow(self):
        # Large positive should saturate cleanly to 1.0 without runtime warnings
        pos_large = sigmoid(np.array([100.0, 500.0, 1000.0]))
        self.assertTrue(np.all(pos_large == 1.0))

        # Large negative should saturate cleanly to <= 1e-15 without runtime warnings
        neg_large = sigmoid(np.array([-100.0, -500.0, -1000.0]))
        self.assertTrue(np.all(neg_large >= 0.0))
        self.assertTrue(np.all(neg_large <= 1e-15))

    def test_sigmoid_shape_preservation(self):
        matrix = np.array([[0.0, 1.0], [-1.0, 2.0]])
        res = sigmoid(matrix)
        self.assertEqual(res.shape, matrix.shape)
        self.assertAlmostEqual(float(res[0, 0]), 0.5, places=7)


class TestBinaryCrossEntropy(unittest.TestCase):
    def test_loss_at_p_half(self):
        # When w=0 and b=0, z=0 and p=0.5 for any X
        X = np.array([[1.0, 2.0], [3.0, 4.0]])
        y = np.array([1.0, 0.0])
        w = np.zeros(2)
        b = 0.0
        loss = compute_bce_loss(X, y, w, b)
        expected = math.log(2.0)
        self.assertAlmostEqual(loss, expected, places=7)

    def test_loss_decreases_with_confident_correct_predictions(self):
        X = np.array([[1.0], [-1.0]])
        y = np.array([1.0, 0.0])
        w_init = np.array([0.0])
        loss_init = compute_bce_loss(X, y, w_init, 0.0)

        # A positive w gives z_1 > 0 (p_1 > 0.5) and z_2 < 0 (p_2 < 0.5)
        w_improved = np.array([2.0])
        loss_improved = compute_bce_loss(X, y, w_improved, 0.0)
        self.assertLess(loss_improved, loss_init)


class TestWorkedArithmeticExample(unittest.TestCase):
    """Verify exact match with the hand-worked arithmetic example in section 2."""

    def test_worked_single_row_update(self):
        # Row: x=2, y=1, initial w=0, b=0, alpha=0.1
        X = np.array([[2.0]])
        y = np.array([1.0])
        w = np.array([0.0])
        b = 0.0
        alpha = 0.1

        # 1. Linear logit and probability
        z = float((X @ w)[0] + b)
        self.assertEqual(z, 0.0)
        p = float(sigmoid(z))
        self.assertEqual(p, 0.5)

        # 2. Initial loss
        J = compute_bce_loss(X, y, w, b)
        self.assertAlmostEqual(J, math.log(2.0), places=7)

        # 3. Analytical gradients
        dw, db = compute_gradients(X, y, w, b)
        self.assertAlmostEqual(float(dw[0]), -1.0, places=9)
        self.assertAlmostEqual(float(db), -0.5, places=9)

        # 4. Simultaneous parameter update
        w_next = w - alpha * dw
        b_next = b - alpha * db
        self.assertAlmostEqual(float(w_next[0]), 0.10, places=9)
        self.assertAlmostEqual(float(b_next), 0.05, places=9)

        # 5. Updated probability and loss
        z_next = float((X @ w_next)[0] + b_next)
        self.assertAlmostEqual(z_next, 0.25, places=9)
        p_next = float(sigmoid(z_next))
        # 1 / (1 + exp(-0.25)) approx 0.5621765
        self.assertAlmostEqual(p_next, 1.0 / (1.0 + math.exp(-0.25)), places=7)
        self.assertGreater(p_next, 0.5)


class TestFiniteDifferenceGradients(unittest.TestCase):
    """Verify analytical gradients against central finite differences."""

    def _finite_difference_check(
        self,
        X: np.ndarray,
        y: np.ndarray,
        w: np.ndarray,
        b: float,
        l2_lambda: float = 0.0,
        sample_weights: np.ndarray | None = None,
        eps: float = 1e-6,
    ):
        dw_analytic, db_analytic = compute_gradients(
            X, y, w, b, l2_lambda=l2_lambda, sample_weights=sample_weights
        )

        # Numerical gradient for w
        dw_num = np.zeros_like(w)
        for j in range(len(w)):
            w_plus = w.copy()
            w_minus = w.copy()
            w_plus[j] += eps
            w_minus[j] -= eps
            loss_plus = compute_bce_loss(X, y, w_plus, b, l2_lambda, sample_weights)
            loss_minus = compute_bce_loss(X, y, w_minus, b, l2_lambda, sample_weights)
            dw_num[j] = (loss_plus - loss_minus) / (2.0 * eps)

        # Numerical gradient for b
        loss_b_plus = compute_bce_loss(X, y, w, b + eps, l2_lambda, sample_weights)
        loss_b_minus = compute_bce_loss(X, y, w, b - eps, l2_lambda, sample_weights)
        db_num = (loss_b_plus - loss_b_minus) / (2.0 * eps)

        np.testing.assert_allclose(dw_analytic, dw_num, rtol=1e-5, atol=1e-7)
        self.assertAlmostEqual(db_analytic, db_num, places=5)

    def test_unregularized_gradients(self):
        rng = np.random.default_rng(123)
        X = rng.normal(size=(20, 4))
        y = rng.integers(0, 2, size=20).astype(float)
        w = rng.normal(size=4)
        b = float(rng.normal())
        self._finite_difference_check(X, y, w, b)

    def test_l2_regularized_gradients(self):
        rng = np.random.default_rng(456)
        X = rng.normal(size=(25, 3))
        y = rng.integers(0, 2, size=25).astype(float)
        w = rng.normal(size=3)
        b = float(rng.normal())
        self._finite_difference_check(X, y, w, b, l2_lambda=0.5)

    def test_class_balanced_sample_weights_gradients(self):
        rng = np.random.default_rng(789)
        X = rng.normal(size=(30, 3))
        # Imbalanced outcome
        y = np.array([0.0] * 25 + [1.0] * 5)
        w = rng.normal(size=3)
        b = float(rng.normal())
        sample_weights = compute_sample_weights(y)
        self._finite_difference_check(
            X, y, w, b, l2_lambda=0.1, sample_weights=sample_weights
        )


class TestScratchModelFitting(unittest.TestCase):
    def test_fit_and_convergence_on_learnable_data(self):
        rng = np.random.default_rng(42)
        # 100 samples, 2 features with slight overlap and small L2 regularization
        X_neg = rng.normal(loc=-0.5, scale=1.0, size=(50, 2))
        X_pos = rng.normal(loc=0.5, scale=1.0, size=(50, 2))
        X = np.vstack([X_neg, X_pos])
        y = np.array([0.0] * 50 + [1.0] * 50)

        model = LogisticRegressionScratch(
            learning_rate=0.5, max_iterations=2000, tolerance=1e-5, l2_lambda=0.01
        )
        model.fit(X, y)

        self.assertTrue(model.diagnostics_["converged"])
        self.assertLess(model.diagnostics_["final_loss"], model.diagnostics_["initial_loss"])
        self.assertLess(model.diagnostics_["final_loss"], 0.60)

        # Predictions should have good accuracy
        preds = model.predict(X)
        accuracy = np.mean(preds == y)
        self.assertGreater(accuracy, 0.70)

        # Loss history starts at iteration 0 and ends at final iteration
        history = model.diagnostics_["loss_history"]
        self.assertEqual(history[0]["iteration"], 0)
        self.assertEqual(history[-1]["iteration"], model.diagnostics_["iterations"])
        self.assertLessEqual(len(history), 200)

    def test_unregularized_separable_data_diagnostics(self):
        # Linearly separable data without regularization
        X = np.array([[-10.0], [-8.0], [8.0], [10.0]])
        y = np.array([0.0, 0.0, 1.0, 1.0])
        model = LogisticRegressionScratch(
            learning_rate=0.1, max_iterations=1000, tolerance=0.01, l2_lambda=0.0
        )
        model.fit(X, y)
        self.assertIsNotNone(model.diagnostics_)
        self.assertLess(model.diagnostics_["final_loss"], model.diagnostics_["initial_loss"])
        # Honest reporting: separation warning must be emitted
        warnings_text = " ".join(model.diagnostics_["warnings"]).lower()
        self.assertIn("separable", warnings_text)

    def test_step_halving_prevents_divergence(self):
        rng = np.random.default_rng(8)
        X = rng.normal(size=(30, 2))
        y = rng.integers(0, 2, size=30).astype(float)

        # Learning rate that triggers step-halving retries
        model = LogisticRegressionScratch(
            learning_rate=5.0, max_iterations=50, tolerance=1e-6
        )
        model.fit(X, y)

        self.assertIsNotNone(model.diagnostics_)
        # Parameters and loss must remain finite
        self.assertTrue(np.isfinite(model.w).all())
        self.assertTrue(math.isfinite(model.b))
        self.assertLessEqual(model.diagnostics_["final_loss"], model.diagnostics_["initial_loss"])
        self.assertGreater(model.diagnostics_["step_reductions"], 0)

    def test_numerical_overflow_rejects_with_value_error(self):
        X = np.full((10, 2), 1e308)
        X[0, 0] = 0.5e308
        y = np.array([0, 0, 0, 0, 0, 1, 1, 1, 1, 1])
        model = LogisticRegressionScratch(learning_rate=0.1, max_iterations=100)
        with self.assertRaises(ValueError):
            model.fit(X, y)

    def test_zero_gradient_immediate_convergence(self):
        # Direct fit regression using X=[[-1],[1],[-1],[1]], y=[0,0,1,1], lambda=0 and lambda=1.5
        X = np.array([[-1.0], [1.0], [-1.0], [1.0]])
        y = np.array([0, 0, 1, 1])

        for l2 in (0.0, 1.5):
            with self.subTest(l2_lambda=l2):
                model = LogisticRegressionScratch(l2_lambda=l2, tolerance=1e-6)
                model.fit(X, y)
                self.assertTrue(np.allclose(model.w, [0.0]))
                self.assertAlmostEqual(model.b, 0.0)
                self.assertTrue(model.diagnostics_["converged"])
                self.assertEqual(model.diagnostics_["iterations"], 0)
                self.assertEqual(len(model.diagnostics_["loss_history"]), 1)
                self.assertAlmostEqual(model.diagnostics_["gradient_norm"], 0.0)
                probs = model.predict_proba(X)
                self.assertTrue(np.allclose(probs, 0.5))


if __name__ == "__main__":
    unittest.main()

