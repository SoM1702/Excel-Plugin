"""Pure NumPy implementation of binary logistic regression from scratch.

Follows the handwritten review equations:
  z_i = sum_j(w_j * x_ij) + b
  p_i = sigmoid(z_i) = 1 / (1 + exp(-z_i))
  J(w, b) = -(1/m) * sum_i[y_i * ln(p_i) + (1-y_i) * ln(1-p_i)]
  dw = (1/m) * X.T @ (p - y)
  db = (1/m) * sum_i(p_i - y_i)
  w_next = w - alpha * dw
  b_next = b - alpha * db

No scikit-learn or library optimizers are used.
"""

from __future__ import annotations

import math
import time
from typing import Literal

import numpy as np


def sigmoid(z: np.ndarray | float) -> np.ndarray:
    """Compute elementwise logistic sigmoid stably for all real inputs.

    Uses separate positive and negative branches to eliminate exp overflow:
      z >= 0: 1 / (1 + exp(-z))
      z < 0:  exp(z) / (1 + exp(z))
    """
    z_arr = np.asarray(z, dtype=float)
    out = np.empty_like(z_arr)
    pos_mask = z_arr >= 0
    neg_mask = ~pos_mask

    # z >= 0: exp(-z) is in (0, 1], never overflows
    out[pos_mask] = 1.0 / (1.0 + np.exp(-z_arr[pos_mask]))
    # z < 0: exp(z) is in (0, 1), never overflows
    exp_neg = np.exp(z_arr[neg_mask])
    out[neg_mask] = exp_neg / (1.0 + exp_neg)

    return out if out.ndim > 0 else out.item()


def compute_sample_weights(y: np.ndarray) -> np.ndarray:
    """Compute balanced sample weights s_i = m / (2 * n_class_i).

    Ensures both classes have equal total effective weight m/2.
    """
    y_arr = np.asarray(y, dtype=int)
    m = len(y_arr)
    n_0 = int(np.sum(y_arr == 0))
    n_1 = int(np.sum(y_arr == 1))
    if n_0 == 0 or n_1 == 0:
        raise ValueError("Cannot balance classes when one class is empty.")

    weights = np.empty(m, dtype=float)
    weights[y_arr == 0] = m / (2.0 * n_0)
    weights[y_arr == 1] = m / (2.0 * n_1)
    return weights


def compute_bce_loss(
    X: np.ndarray,
    y: np.ndarray,
    w: np.ndarray,
    b: float,
    l2_lambda: float = 0.0,
    sample_weights: np.ndarray | None = None,
) -> float:
    """Compute binary cross-entropy loss directly from scores to prevent log(0).

    Uses the identity:
      - [y*ln(p) + (1-y)*ln(1-p)] = ln(1 + exp(z)) - y*z = logaddexp(0, z) - y*z
    Optional L2 regularization adds (lambda/2) * ||w||^2 (bias b is not penalized).
    """
    z = X @ w + b
    raw_loss = np.logaddexp(0.0, z) - y * z

    if sample_weights is not None:
        total_w = np.sum(sample_weights)
        if total_w <= 0:
            raise ValueError("Sum of sample weights must be positive.")
        loss = float(np.sum(sample_weights * raw_loss) / total_w)
    else:
        loss = float(np.mean(raw_loss))

    if l2_lambda > 0.0:
        loss += 0.5 * float(l2_lambda) * float(np.sum(w * w))

    return loss


def compute_gradients(
    X: np.ndarray,
    y: np.ndarray,
    w: np.ndarray,
    b: float,
    l2_lambda: float = 0.0,
    sample_weights: np.ndarray | None = None,
) -> tuple[np.ndarray, float]:
    """Compute analytical gradients dw and db simultaneously from pre-update probabilities.

    dw = (1/m) * X.T @ (p - y) + lambda * w
    db = (1/m) * sum(p - y)
    """
    z = X @ w + b
    p = sigmoid(z)
    residual = p - y

    if sample_weights is not None:
        weighted_residual = sample_weights * residual
        total_w = float(np.sum(sample_weights))
        if total_w <= 0:
            raise ValueError("Sum of sample weights must be positive.")
        dw = (X.T @ weighted_residual) / total_w
        db = float(np.sum(weighted_residual) / total_w)
    else:
        m = X.shape[0]
        dw = (X.T @ residual) / float(m)
        db = float(np.sum(residual) / float(m))

    if l2_lambda > 0.0:
        dw = dw + float(l2_lambda) * w

    return dw, db


def _downsample_history(history: list[dict], max_points: int = 200) -> list[dict]:
    """Uniformly downsample loss history while strictly preserving first and last steps."""
    if len(history) <= max_points:
        return history
    step = (len(history) - 1) / (max_points - 1)
    indices = {int(round(i * step)) for i in range(max_points)}
    indices.add(0)
    indices.add(len(history) - 1)
    sorted_indices = sorted(indices)
    return [history[idx] for idx in sorted_indices]


class LogisticRegressionScratch:
    """Binary logistic regression with full-batch gradient descent from scratch."""

    def __init__(
        self,
        learning_rate: float = 0.1,
        max_iterations: int = 10_000,
        tolerance: float = 1e-6,
        l2_lambda: float = 0.0,
        class_weight: Literal["balanced"] | None = None,
    ):
        if learning_rate <= 0:
            raise ValueError(f"Learning rate must be positive, got {learning_rate}")
        if max_iterations < 1:
            raise ValueError(f"Max iterations must be >= 1, got {max_iterations}")
        if tolerance <= 0:
            raise ValueError(f"Tolerance must be positive, got {tolerance}")
        if l2_lambda < 0:
            raise ValueError(f"L2 lambda must be non-negative, got {l2_lambda}")
        if class_weight not in (None, "balanced"):
            raise ValueError('class_weight must be None or "balanced"')

        self.learning_rate = float(learning_rate)
        self.max_iterations = int(max_iterations)
        self.tolerance = float(tolerance)
        self.l2_lambda = float(l2_lambda)
        self.class_weight = class_weight

        # Learned parameters
        self.w: np.ndarray | None = None
        self.b: float | None = None
        self.diagnostics_: dict | None = None

    def fit(self, X: np.ndarray, y: np.ndarray) -> LogisticRegressionScratch:
        """Fit parameters w and b using full-batch gradient descent."""
        start_time = time.perf_counter()

        X = np.asarray(X, dtype=float)
        y = np.asarray(y, dtype=float)
        m, d = X.shape

        if m == 0 or d == 0:
            raise ValueError("Training matrix X must have at least one row and one column.")
        if len(y) != m:
            raise ValueError(f"Row count mismatch: X has {m} rows, y has {len(y)} elements.")
        if not np.isfinite(X).all():
            raise ValueError("Training features must be finite numbers.")
        if not np.isfinite(y).all():
            raise ValueError("Training labels must be finite numbers.")

        unique_labels = np.unique(y)
        if not np.array_equal(unique_labels, [0, 1]) and not np.array_equal(unique_labels, [0]) and not np.array_equal(unique_labels, [1]):
            raise ValueError(f"y must contain binary values 0 and 1, got {unique_labels}")

        # Compute sample weights if class balancing is enabled
        sample_weights = compute_sample_weights(y) if self.class_weight == "balanced" else None

        # Zero initialization per teaching standard: w=0, b=0 gives p=0.5 initially
        w = np.zeros(d, dtype=float)
        b = 0.0

        initial_loss = compute_bce_loss(X, y, w, b, self.l2_lambda, sample_weights)
        if not math.isfinite(initial_loss):
            raise ValueError("Initial objective calculation produced a non-finite loss (numerical overflow detected).")
        current_loss = initial_loss

        raw_history: list[dict] = [{"iteration": 0, "loss": round(float(initial_loss), 6)}]
        step_reductions = 0
        converged = False
        stop_reason = ""
        warnings_list: list[str] = []

        last_grad_norm = float("inf")

        for iteration in range(1, self.max_iterations + 1):
            dw, db = compute_gradients(X, y, w, b, self.l2_lambda, sample_weights)

            if not np.isfinite(dw).all() or not math.isfinite(db):
                raise ValueError(
                    "Optimization encountered non-finite gradients (numerical overflow). "
                    "Standardize features or decrease learning rate."
                )

            # Norm of joint parameter gradient vector [dw, db]
            last_grad_norm = float(np.sqrt(np.sum(dw**2) + db**2))

            if last_grad_norm <= self.tolerance:
                converged = True
                stop_reason = (
                    f"Gradient norm ({last_grad_norm:.2e}) reached tolerance ({self.tolerance:.2e})"
                )
                break

            # Step-halving line search retry if candidate increases objective
            step_size = self.learning_rate
            max_halvings = 15
            accepted = False

            for halving in range(max_halvings):
                w_cand = w - step_size * dw
                b_cand = b - step_size * db

                cand_loss = compute_bce_loss(X, y, w_cand, b_cand, self.l2_lambda, sample_weights)

                # Accept step if loss is non-increasing (within small float margin)
                if math.isfinite(cand_loss) and cand_loss <= current_loss + 1e-12:
                    w = w_cand
                    b = b_cand
                    current_loss = cand_loss
                    accepted = True
                    if halving > 0:
                        step_reductions += halving
                    raw_history.append({"iteration": iteration, "loss": round(float(current_loss), 6)})
                    break
                else:
                    step_size *= 0.5

            if not accepted:
                if iteration == 1:
                    raise ValueError(
                        "Optimization failed to decrease objective on initial iteration (numerical overflow or step-halving limit)."
                    )
                # Step halving reached limit without decrease
                stop_reason = "Step-halving reached minimum step size without objective decrease."
                warnings_list.append(
                    "Optimization halted: proposed step could not decrease the training objective."
                )
                break

            # Check for quasi-complete separation / coefficient explosion
            norm_w = float(np.linalg.norm(w))
            if not math.isfinite(norm_w) or not math.isfinite(b):
                raise ValueError("Optimization diverged: non-finite parameters encountered.")

            if norm_w > 10_000.0:
                warnings_list.append(
                    f"Coefficients grew very large (||w|| = {norm_w:.1f}), which indicates "
                    "quasi-complete or complete separation in the training data."
                )
                stop_reason = "Stopped due to coefficient divergence (potential separation)."
                break

        if not stop_reason:
            converged = False
            stop_reason = f"Reached maximum iterations ({self.max_iterations})"

        norm_w = float(np.linalg.norm(w))
        if not np.isfinite(w).all() or not math.isfinite(b) or not math.isfinite(current_loss) or not math.isfinite(norm_w):
            raise ValueError("Optimization produced non-finite parameters or loss.")

        # Check for linear separation when unregularized
        if self.l2_lambda == 0.0:
            train_probs = sigmoid(X @ w + b)
            train_preds = (train_probs >= 0.5).astype(int)
            is_perfect_sep = np.array_equal(train_preds, y)
            if is_perfect_sep or current_loss < 1e-4 or norm_w > 1000.0:
                sep_msg = (
                    "Data appears linearly separable (complete or quasi-complete separation detected without regularization); "
                    "maximum likelihood coefficients may diverge or not be unique."
                )
                if sep_msg not in warnings_list:
                    warnings_list.append(sep_msg)

        elapsed_time = time.perf_counter() - start_time

        self.w = w
        self.b = b
        self.diagnostics_ = {
            "initial_loss": float(initial_loss),
            "final_loss": float(current_loss),
            "iterations": int(len(raw_history) - 1),
            "gradient_norm": float(last_grad_norm) if math.isfinite(last_grad_norm) else None,
            "converged": bool(converged),
            "stop_reason": stop_reason,
            "learning_rate": float(self.learning_rate),
            "l2_lambda": float(self.l2_lambda),
            "class_weight": self.class_weight,
            "step_reductions": int(step_reductions),
            "elapsed_seconds": round(float(elapsed_time), 4),
            "loss_history": _downsample_history(raw_history, max_points=200),
            "warnings": warnings_list,
        }

        return self

    def predict_score(self, X: np.ndarray) -> np.ndarray:
        """Compute the linear score z = X @ w + b."""
        if self.w is None or self.b is None:
            raise ValueError("Model is not fitted. Call fit() first.")
        X = np.asarray(X, dtype=float)
        return X @ self.w + self.b

    def predict_proba(self, X: np.ndarray) -> np.ndarray:
        """Predict positive class probabilities P(Y=1 | X)."""
        z = self.predict_score(X)
        return sigmoid(z)

    def predict(self, X: np.ndarray, threshold: float = 0.5) -> np.ndarray:
        """Predict binary class 0 or 1 at given threshold."""
        probs = self.predict_proba(X)
        return (probs >= float(threshold)).astype(int)

