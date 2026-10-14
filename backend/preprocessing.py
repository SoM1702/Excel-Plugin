"""Pure NumPy feature standardization and preprocessing from scratch.

Calculates means and population standard deviations (ddof=0) strictly from
training observations. Zero-variance features use unit scale to avoid division
by zero and are recorded explicitly.
"""

from __future__ import annotations

import numpy as np


class StandardScalerScratch:
    """Standardize features by removing the mean and scaling to unit variance."""

    def __init__(self):
        self.mean_: np.ndarray | None = None
        self.scale_: np.ndarray | None = None
        self.zero_variance_indices_: list[int] = []

    def fit(self, X: np.ndarray) -> StandardScalerScratch:
        X = np.asarray(X, dtype=float)
        if X.ndim != 2 or X.shape[0] == 0 or X.shape[1] == 0:
            raise ValueError("Feature matrix must be a non-empty 2D array.")
        if not np.isfinite(X).all():
            raise ValueError("Feature matrix contains non-finite values.")

        means = np.mean(X, axis=0)
        # Population standard deviation ddof=0
        stds = np.std(X, axis=0, ddof=0)

        if not np.isfinite(means).all() or not np.isfinite(stds).all():
            raise ValueError(
                "Feature scaling produced non-finite values (numerical overflow during mean/variance calculation)."
            )

        # Handle zero-variance (constant) features: exact match or std == 0
        scales = stds.copy()
        zero_var = (scales == 0.0) | np.all(X == X[0:1, :], axis=0)
        self.zero_variance_indices_ = [int(idx) for idx in np.where(zero_var)[0]]
        scales[zero_var] = 1.0

        self.mean_ = means
        self.scale_ = scales
        return self

    def transform(self, X: np.ndarray) -> np.ndarray:
        if self.mean_ is None or self.scale_ is None:
            raise ValueError("StandardScalerScratch is not fitted.")
        X = np.asarray(X, dtype=float)
        if X.shape[1] != len(self.mean_):
            raise ValueError(
                f"Feature dimension mismatch: expected {len(self.mean_)}, got {X.shape[1]}"
            )
        if not np.isfinite(X).all():
            raise ValueError("Prediction features contain non-finite values.")
        scaled = (X - self.mean_) / self.scale_
        if not np.isfinite(scaled).all():
            raise ValueError("Standardized features contain non-finite values (numerical overflow).")
        return scaled

    def fit_transform(self, X: np.ndarray) -> np.ndarray:
        return self.fit(X).transform(X)


def check_constant_features(X: np.ndarray, feature_names: list[str] | None = None) -> list[str]:
    """Check for constant features and return their names/indices.

    Raises ValueError if all features are constant.
    """
    X = np.asarray(X, dtype=float)
    stds = np.std(X, axis=0, ddof=0)
    is_constant = (stds == 0.0) | np.all(X == X[0:1, :], axis=0)
    zero_var_indices = np.where(is_constant)[0]

    names = feature_names if feature_names is not None else [f"X{i+1}" for i in range(X.shape[1])]
    constant_names = [names[i] for i in zero_var_indices]

    if len(constant_names) == X.shape[1]:
        raise ValueError(
            "All selected feature columns are constant (zero variance). "
            "A logistic regression model cannot be trained without feature variation."
        )

    return constant_names
