"""Training and evaluation engine for the Excel logistic-regression add-in.

This module is deliberately independent from Excel and HTTP. It validates a
numeric feature matrix and a binary target, trains a scikit-learn model, and
returns JSON-safe data for the task pane and report export.
"""

from __future__ import annotations

import math
import platform
import uuid
import warnings

import numpy as np
import scipy
import sklearn
from scipy import stats
from sklearn.exceptions import ConvergenceWarning
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import (
    accuracy_score,
    confusion_matrix,
    f1_score,
    log_loss,
    precision_score,
    recall_score,
    roc_auc_score,
    roc_curve,
)
from sklearn.model_selection import StratifiedKFold, train_test_split
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler


DEFAULT_THRESHOLD = 0.5
THRESHOLD_GRID = np.linspace(0.05, 0.95, 19)


class TrainedModel:
    """A fitted classifier and its training-only scaler for later predictions."""

    def __init__(
        self,
        clf: LogisticRegression,
        scaler: StandardScaler | None,
        feature_names: list[str],
        class_labels: list,
        model_id: str,
    ):
        self.clf = clf
        self.scaler = scaler
        self.feature_names = feature_names
        self.class_labels = class_labels
        self.model_id = model_id

    def predict_proba(self, X: np.ndarray) -> np.ndarray:
        if self.scaler is not None:
            X = self.scaler.transform(X)
        return self.clf.predict_proba(X)[:, 1]


def _label_key(value: object) -> tuple[str, str]:
    """Make a stable key for a supported scalar label without merging types."""
    return type(value).__name__, repr(value)


def _validate_and_encode_labels(y_raw: list) -> tuple[np.ndarray, list]:
    """Validate two scalar classes and map them to encoded values 0 and 1."""
    if not y_raw:
        raise ValueError("The outcome column is empty.")

    unique_by_key: dict[tuple[str, str], object] = {}
    keys: list[tuple[str, str]] = []
    for value in y_raw:
        if value is None or isinstance(value, (list, dict, set, tuple)):
            raise ValueError("Each outcome value must be a non-empty scalar.")
        if isinstance(value, (float, np.floating)) and not math.isfinite(float(value)):
            raise ValueError("Outcome values must be finite.")
        key = _label_key(value)
        unique_by_key[key] = value
        keys.append(key)

    unique_keys = sorted(unique_by_key)
    if len(unique_keys) != 2:
        labels = [str(unique_by_key[key]) for key in unique_keys[:6]]
        raise ValueError(
            "Logistic regression needs exactly two outcome classes, but the "
            f"selected outcome has {len(unique_keys)}: {labels}."
        )

    mapping = {unique_keys[0]: 0, unique_keys[1]: 1}
    y = np.asarray([mapping[key] for key in keys], dtype=int)
    return y, [unique_by_key[key] for key in unique_keys]


def _validate_features(features: list[list[float]]) -> np.ndarray:
    try:
        X = np.asarray(features, dtype=float)
    except (TypeError, ValueError) as exc:
        raise ValueError("Features must be a rectangular matrix of numbers.") from exc

    if X.ndim != 2:
        raise ValueError("Features must be a two-dimensional matrix (rows x columns).")
    if X.shape[0] == 0 or X.shape[1] == 0:
        raise ValueError("Select at least one data row and one feature column.")
    if not np.isfinite(X).all():
        raise ValueError("Features cannot contain blank, infinite, or non-numeric values.")
    return X


def _validate_feature_names(feature_names: list[str] | None, n_features: int) -> list[str]:
    if feature_names is None:
        return [f"X{i + 1}" for i in range(n_features)]
    if len(feature_names) != n_features:
        raise ValueError("Feature-name count must match the number of selected X columns.")

    names = [str(name).strip() for name in feature_names]
    if any(not name for name in names):
        raise ValueError("Feature headers cannot be blank.")
    if len(set(names)) != len(names):
        raise ValueError("Feature headers must be unique.")
    return names


def _standard_errors(X_design: np.ndarray, probs: np.ndarray) -> np.ndarray:
    """Approximate Wald standard errors using the observed information matrix."""
    weights = probs * (1.0 - probs)
    information = X_design.T @ (X_design * weights[:, None])
    covariance = np.linalg.pinv(information)
    diagonal = np.diag(covariance)
    if not np.isfinite(diagonal).all() or np.any(diagonal < 0):
        raise ValueError("The coefficient information matrix is not numerically stable.")
    return np.sqrt(diagonal)


def _make_pipeline(C: float, class_weight: str | None, standardize: bool) -> Pipeline:
    steps: list[tuple[str, object]] = []
    if standardize:
        steps.append(("scaler", StandardScaler()))
    steps.append(
        (
            "clf",
            LogisticRegression(
                C=C,
                max_iter=1000,
                solver="lbfgs",
                class_weight=class_weight,
            ),
        )
    )
    return Pipeline(steps)


def _metrics_at_threshold(y_true: np.ndarray, probs: np.ndarray, threshold: float) -> dict:
    pred = (probs >= threshold).astype(int)
    tn, fp, fn, tp = confusion_matrix(y_true, pred, labels=[0, 1]).ravel()
    return {
        "threshold": float(threshold),
        "accuracy": float(accuracy_score(y_true, pred)),
        "precision": float(precision_score(y_true, pred, zero_division=0)),
        "recall": float(recall_score(y_true, pred, zero_division=0)),
        "f1": float(f1_score(y_true, pred, zero_division=0)),
        "confusion_matrix": {"tn": int(tn), "fp": int(fp), "fn": int(fn), "tp": int(tp)},
    }


def _best_f1_threshold(y_true: np.ndarray, probs: np.ndarray) -> tuple[float, float]:
    """Return max-F1 threshold; ties prefer values closest to the usual 0.5."""
    candidates = []
    for threshold in THRESHOLD_GRID:
        f1 = f1_score(y_true, (probs >= threshold).astype(int), zero_division=0)
        candidates.append((float(f1), float(threshold)))
    best_f1, best_threshold = min(
        candidates,
        key=lambda item: (-item[0], abs(item[1] - DEFAULT_THRESHOLD), item[1]),
    )
    return float(round(best_threshold, 2)), best_f1


def _training_cv(
    X_train: np.ndarray,
    y_train: np.ndarray,
    requested_folds: int,
    C: float,
    class_weight: str | None,
    standardize: bool,
    random_state: int,
) -> tuple[dict | None, np.ndarray | None]:
    """Generate out-of-fold training predictions for CV and threshold selection."""
    if requested_folds == 0:
        return None, None

    min_class_count = int(np.bincount(y_train, minlength=2).min())
    actual_folds = min(requested_folds, min_class_count)
    if actual_folds < 3:
        return {
            "requested_folds": int(requested_folds),
            "actual_folds": None,
            "available": False,
            "reason": (
                "Cross-validation needs at least three training examples in each "
                "outcome class. Use more data or disable cross-validation."
            ),
            "auc_mean": None,
            "auc_std": None,
            "accuracy_mean": None,
            "accuracy_std": None,
        }, None

    splitter = StratifiedKFold(n_splits=actual_folds, shuffle=True, random_state=random_state)
    oof_probs = np.empty(len(y_train), dtype=float)
    auc_scores: list[float] = []
    accuracy_scores: list[float] = []

    for fold_train, fold_valid in splitter.split(X_train, y_train):
        pipeline = _make_pipeline(C, class_weight, standardize)
        pipeline.fit(X_train[fold_train], y_train[fold_train])
        probabilities = pipeline.predict_proba(X_train[fold_valid])[:, 1]
        oof_probs[fold_valid] = probabilities
        auc_scores.append(float(roc_auc_score(y_train[fold_valid], probabilities)))
        accuracy_scores.append(
            float(accuracy_score(y_train[fold_valid], (probabilities >= DEFAULT_THRESHOLD).astype(int)))
        )

    return {
        "requested_folds": int(requested_folds),
        "actual_folds": int(actual_folds),
        "available": True,
        "reason": None,
        "auc_mean": float(np.mean(auc_scores)),
        "auc_std": float(np.std(auc_scores)),
        "accuracy_mean": float(np.mean(accuracy_scores)),
        "accuracy_std": float(np.std(accuracy_scores)),
    }, oof_probs


def _split_data(
    X: np.ndarray,
    y: np.ndarray,
    test_size: float,
    random_state: int,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, str]:
    if test_size == 0:
        return X, X, y, y, "training only"

    if not 0 < test_size < 0.9:
        raise ValueError("Test split must be 0 for training-only results or between 0 and 0.9.")

    class_counts = np.bincount(y, minlength=2)
    if class_counts.min() < 2:
        raise ValueError(
            "A held-out test split needs at least two examples of each outcome class."
        )
    n_test = math.ceil(len(y) * test_size)
    n_train = len(y) - n_test
    if n_test < 2 or n_train < 2:
        raise ValueError("The requested test split leaves too few rows in train or test data.")

    try:
        X_train, X_test, y_train, y_test = train_test_split(
            X, y, test_size=test_size, random_state=random_state, stratify=y
        )
    except ValueError as exc:
        raise ValueError(
            "The requested test split cannot preserve both outcome classes. "
            "Use more rows, a different split, or training-only evaluation."
        ) from exc
    return X_train, X_test, y_train, y_test, "held-out test"


def train_logistic(
    features: list[list[float]],
    labels: list,
    feature_names: list[str] | None = None,
    standardize: bool = True,
    test_size: float = 0.3,
    C: float = 1.0,
    class_weight: str | None = None,
    cv_folds: int = 0,
    random_state: int = 42,
) -> tuple[dict, TrainedModel]:
    """Fit a binary logistic-regression model and return result data plus model."""
    if not math.isfinite(float(C)) or C <= 0 or C > 1_000_000:
        raise ValueError("Regularisation C must be a finite number between 0 and 1,000,000.")
    if not isinstance(cv_folds, int) or cv_folds < 0:
        raise ValueError("Cross-validation folds must be a non-negative integer.")
    if cv_folds not in (0,) and cv_folds < 3:
        raise ValueError("Use zero to disable cross-validation or choose at least three folds.")
    if class_weight not in (None, "balanced"):
        raise ValueError('Class weight must be omitted or set to "balanced".')

    X = _validate_features(features)
    n_samples, n_features = X.shape
    if n_samples < 10:
        raise ValueError("Need at least ten rows to fit a meaningful model.")
    if len(labels) != n_samples:
        raise ValueError(
            f"Row mismatch: {n_samples} feature rows but {len(labels)} outcome rows."
        )

    y, class_labels = _validate_and_encode_labels(list(labels))
    names = _validate_feature_names(feature_names, n_features)
    if np.bincount(y, minlength=2).min() < 2:
        raise ValueError("Each outcome class needs at least two rows.")

    test_size = float(test_size)
    X_train, X_test, y_train, y_test, evaluation_mode = _split_data(
        X, y, test_size, int(random_state)
    )

    cv_summary, train_oof_probs = _training_cv(
        X_train,
        y_train,
        int(cv_folds),
        float(C),
        class_weight,
        bool(standardize),
        int(random_state),
    )
    if train_oof_probs is None:
        selected_threshold = DEFAULT_THRESHOLD
        threshold_info = {
            "value": DEFAULT_THRESHOLD,
            "source": "default_0_5",
            "metric": None,
            "metric_value": None,
            "tuning_folds": None,
            "note": "Using the default threshold because training-side cross-validation was not available.",
        }
    else:
        selected_threshold, selected_f1 = _best_f1_threshold(y_train, train_oof_probs)
        threshold_info = {
            "value": float(selected_threshold),
            "source": "training_cross_validation",
            "metric": "f1",
            "metric_value": float(selected_f1),
            "tuning_folds": cv_summary["actual_folds"],
            "note": "Selected from out-of-fold predictions on the training portion only.",
        }

    scaler: StandardScaler | None = None
    if standardize:
        scaler = StandardScaler().fit(X_train)
        X_train_used = scaler.transform(X_train)
        X_test_used = scaler.transform(X_test)
        X_all_used = scaler.transform(X)
    else:
        X_train_used, X_test_used, X_all_used = X_train, X_test, X

    clf = LogisticRegression(
        C=float(C), max_iter=1000, solver="lbfgs", class_weight=class_weight
    )
    with warnings.catch_warnings(record=True) as caught_warnings:
        warnings.simplefilter("always", ConvergenceWarning)
        clf.fit(X_train_used, y_train)
    training_warnings = [
        str(item.message) for item in caught_warnings if issubclass(item.category, ConvergenceWarning)
    ]

    train_probs = clf.predict_proba(X_train_used)[:, 1]
    inference = {"available": False, "method": None, "reason": None}
    standard_errors: np.ndarray | None = None
    p_values: np.ndarray | None = None
    if class_weight is not None:
        inference["reason"] = "P-values are unavailable when balanced class weights are used."
    else:
        try:
            design = np.hstack([np.ones((X_train_used.shape[0], 1)), X_train_used])
            if np.linalg.matrix_rank(design) < design.shape[1]:
                raise ValueError("selected features are linearly dependent")
            standard_errors = _standard_errors(design, train_probs)
            coefficients_vector = np.concatenate([clf.intercept_, clf.coef_[0]])
            z_scores = np.divide(
                coefficients_vector,
                standard_errors,
                out=np.zeros_like(coefficients_vector),
                where=standard_errors > 0,
            )
            p_values = 2.0 * (1.0 - stats.norm.cdf(np.abs(z_scores)))
            if not np.isfinite(p_values).all() or not np.isfinite(standard_errors).all():
                raise ValueError("The coefficient standard errors are not finite.")
            inference.update(
                {
                    "available": True,
                    "method": "Approximate Wald p-values from an unregularized information matrix.",
                    "reason": (
                        "The fitted classifier uses L2 regularisation, so these values are "
                        "approximate association estimates, not causal evidence."
                    ),
                }
            )
        except ValueError as exc:
            inference["reason"] = f"P-values are unavailable: {exc}"

    coefficients_vector = np.concatenate([clf.intercept_, clf.coef_[0]])
    coefficient_rows = []
    for index, name in enumerate(["Intercept"] + names):
        p_value = float(p_values[index]) if p_values is not None else None
        standard_error = float(standard_errors[index]) if standard_errors is not None else None
        z_score = (
            float(coefficients_vector[index] / standard_errors[index])
            if standard_errors is not None and standard_errors[index] > 0
            else None
        )
        coefficient_rows.append(
            {
                "name": name,
                "coef": float(coefficients_vector[index]),
                "odds_ratio": float(np.exp(coefficients_vector[index])),
                "std_error": standard_error,
                "z": z_score,
                "p_value": p_value,
                "significant": bool(p_value < 0.05) if p_value is not None else None,
            }
        )

    test_probs = clf.predict_proba(X_test_used)[:, 1]
    metrics_0_5 = _metrics_at_threshold(y_test, test_probs, DEFAULT_THRESHOLD)
    metrics_selected = _metrics_at_threshold(y_test, test_probs, selected_threshold)
    metrics_0_5["log_loss"] = float(log_loss(y_test, test_probs, labels=[0, 1]))
    metrics_selected["log_loss"] = metrics_0_5["log_loss"]

    baseline_accuracy = float(max(np.mean(y_test == 0), np.mean(y_test == 1)))
    for metric_set in (metrics_0_5, metrics_selected):
        metric_set["baseline_accuracy"] = baseline_accuracy
        metric_set["accuracy_gain"] = float(metric_set["accuracy"] - baseline_accuracy)

    try:
        auc = float(roc_auc_score(y_test, test_probs))
        fpr, tpr, _ = roc_curve(y_test, test_probs)
        roc = {"fpr": [float(value) for value in fpr], "tpr": [float(value) for value in tpr]}
    except ValueError:
        auc = None
        roc = {"fpr": [], "tpr": []}
    metrics_0_5["auc"] = auc
    metrics_selected["auc"] = auc

    all_probs = clf.predict_proba(X_all_used)[:, 1]
    model_id = uuid.uuid4().hex
    model = TrainedModel(clf, scaler, names, class_labels, model_id)
    preprocessing = {
        "standardized": bool(standardize),
        "feature_means": [float(value) for value in scaler.mean_] if scaler is not None else None,
        "feature_scales": [float(value) for value in scaler.scale_] if scaler is not None else None,
    }

    result = {
        "ok": True,
        "model_id": model_id,
        "n_samples": int(n_samples),
        "n_features": int(n_features),
        "feature_names": names,
        "class_labels": {"negative": str(class_labels[0]), "positive": str(class_labels[1])},
        "class_balance": {"positive": int(y.sum()), "negative": int((y == 0).sum())},
        "training_class_balance": {
            "positive": int(y_train.sum()),
            "negative": int((y_train == 0).sum()),
        },
        "evaluation": {
            "mode": evaluation_mode,
            "n_train": int(len(y_train)),
            "n_test": int(len(y_test)),
            "notice": (
                "Metrics use training rows because no held-out test split was requested."
                if test_size == 0
                else None
            ),
        },
        "standardized": bool(standardize),
        "preprocessing": preprocessing,
        "regularisation_C": float(C),
        "class_weight": class_weight,
        "random_state": int(random_state),
        "software": {
            "python": platform.python_version(),
            "scikit_learn": sklearn.__version__,
            "numpy": np.__version__,
            "scipy": scipy.__version__,
        },
        "coefficients": coefficient_rows,
        "inference": inference,
        "training_warnings": training_warnings,
        "metrics": metrics_0_5,
        "metrics_at_threshold": metrics_selected,
        "cross_validation": cv_summary,
        "threshold": threshold_info,
        "suggested_threshold": float(selected_threshold),
        "confusion_matrix": metrics_selected["confusion_matrix"],
        "confusion_matrix_0_5": metrics_0_5["confusion_matrix"],
        "roc": roc,
        "threshold_data": {
            "y_true": [int(value) for value in y_test],
            "prob": [float(value) for value in test_probs],
        },
        "predictions": {
            "prob": [float(value) for value in all_probs],
            "pred_0_5": [int(value >= DEFAULT_THRESHOLD) for value in all_probs],
        },
    }
    return result, model
