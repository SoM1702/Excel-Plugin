"""Training and evaluation coordinator for logistic regression from scratch.

This module coordinates:
  - Feature and label validation
  - Seeded stratified train/test partitioning
  - Out-of-fold cross-validation and threshold optimization on training data only
  - Feature standardization (means and scales fit strictly on training data)
  - Full-batch gradient descent model fitting
  - Evaluation on held-out test data
  - Source-row predictions and JSON-serializable report construction

No scikit-learn, scipy, or library optimizers are used.
"""

from __future__ import annotations

import math
import platform
import uuid

import numpy as np

from logistic_scratch import LogisticRegressionScratch, sigmoid
from metrics import (
    classification_metrics,
    log_loss_scratch,
    roc_auc_scratch,
    roc_curve_scratch,
)
from preprocessing import StandardScalerScratch, check_constant_features
from splitting import StratifiedKFoldScratch, train_test_split_scratch
from table_preprocessing import TablePreprocessorScratch
from table_schema import (
    is_missing,
    is_invalid,
    col_index_to_letter,
    try_parse_float,
    to_boolean_float,
    normalize_header,
)


DEFAULT_THRESHOLD = 0.5
THRESHOLD_GRID = np.linspace(0.05, 0.95, 19)


class TrainedModel:
    """A fitted scratch model and its training-only scaler/preprocessor for later predictions."""

    def __init__(
        self,
        clf: LogisticRegressionScratch,
        scaler: StandardScalerScratch | None,
        feature_names: list[str],
        class_labels: list,
        model_id: str,
        training_diagnostics: dict,
        parameters: dict | None = None,
        table_preprocessor: TablePreprocessorScratch | None = None,
        source_columns: list[dict] | None = None,
        dropped_rows_summary: dict | None = None,
    ):
        self.clf = clf
        self.scaler = scaler
        self.feature_names = feature_names
        self.class_labels = class_labels
        self.model_id = model_id
        self.training_diagnostics = training_diagnostics
        self.parameters = parameters or {}
        self.table_preprocessor = table_preprocessor
        self.source_columns = source_columns or []
        self.dropped_rows_summary = dropped_rows_summary or {}

    def predict_score(self, X: np.ndarray) -> np.ndarray:
        X = np.asarray(X, dtype=float)
        if self.scaler is not None:
            X = self.scaler.transform(X)
        return self.clf.predict_score(X)

    def predict_proba(self, X: np.ndarray) -> np.ndarray:
        X = np.asarray(X, dtype=float)
        if self.scaler is not None:
            X = self.scaler.transform(X)
        return self.clf.predict_proba(X)

    def predict_score_and_proba(self, X: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        X = np.asarray(X, dtype=float)
        if self.scaler is not None:
            X = self.scaler.transform(X)
        z = self.clf.predict_score(X)
        p = sigmoid(z)
        return z, p

    def predict_raw_table(
        self,
        headers: list[str],
        rows: list[list],
        start_row: int = 2,
        row_numbers: list[int] | None = None,
    ) -> tuple[np.ndarray, np.ndarray, list[str]]:
        if self.table_preprocessor is None:
            raise ValueError("This model was trained in numeric mode and cannot score raw tables.")
        if not rows:
            return np.empty(0, dtype=float), np.empty(0, dtype=float), []

        seen_headers: set[str] = set()
        duplicate_headers: set[str] = set()
        header_to_idx: dict[str, int] = {}
        for i, h in enumerate(headers):
            if h is None:
                continue
            clean_h = normalize_header(h)
            if clean_h in seen_headers:
                duplicate_headers.add(clean_h)
            seen_headers.add(clean_h)
            header_to_idx[clean_h] = i

        col_mapping: list[int] = []
        for sel_idx in self.table_preprocessor.selected_indices:
            expected_header = self.table_preprocessor.source_headers[sel_idx]
            clean_expected = normalize_header(expected_header)
            if clean_expected in duplicate_headers:
                raise ValueError(
                    f"Prediction table has ambiguous duplicate header '{expected_header}'. "
                    "Each column in the prediction table must have a unique header name."
                )
            if clean_expected not in header_to_idx:
                raise ValueError(
                    f"Required feature column '{expected_header}' was not found in the prediction table. "
                    f"Available headers: {', '.join(str(h) for h in headers)}"
                )
            col_mapping.append(header_to_idx[clean_expected])

        max_idx = max(self.table_preprocessor.selected_indices) if self.table_preprocessor.selected_indices else 0
        reordered_rows: list[list] = []
        for r in rows:
            new_r = [None] * (max_idx + 1)
            for sel_idx, mapped_idx in zip(self.table_preprocessor.selected_indices, col_mapping):
                new_r[sel_idx] = r[mapped_idx] if mapped_idx < len(r) else None
            reordered_rows.append(new_r)

        X_transformed, warnings = self.table_preprocessor.transform_with_warnings(
            reordered_rows, start_row=start_row, row_numbers=row_numbers
        )
        scores, probs = self.predict_score_and_proba(X_transformed)
        return scores, probs, warnings

    def explain_raw_table_row(
        self,
        headers: list[str],
        row: list,
        start_row: int = 2,
    ) -> dict:
        if self.table_preprocessor is None:
            raise ValueError("This model was trained in numeric mode and cannot explain raw tables.")

        seen_headers: set[str] = set()
        duplicate_headers: set[str] = set()
        header_to_idx: dict[str, int] = {}
        for i, h in enumerate(headers):
            if h is None:
                continue
            clean_h = normalize_header(h)
            if clean_h in seen_headers:
                duplicate_headers.add(clean_h)
            seen_headers.add(clean_h)
            header_to_idx[clean_h] = i

        col_mapping: list[int] = []
        for sel_idx in self.table_preprocessor.selected_indices:
            expected_header = self.table_preprocessor.source_headers[sel_idx]
            clean_expected = normalize_header(expected_header)
            if clean_expected in duplicate_headers:
                raise ValueError(
                    f"Prediction table has ambiguous duplicate header '{expected_header}'. "
                    "Each column in the prediction table must have a unique header name."
                )
            if clean_expected not in header_to_idx:
                raise ValueError(
                    f"Required feature column '{expected_header}' was not found in the prediction table. "
                    f"Available headers: {', '.join(str(h) for h in headers)}"
                )
            col_mapping.append(header_to_idx[clean_expected])

        max_idx = max(self.table_preprocessor.selected_indices) if self.table_preprocessor.selected_indices else 0
        new_r = [None] * (max_idx + 1)
        for sel_idx, mapped_idx in zip(self.table_preprocessor.selected_indices, col_mapping):
            new_r[sel_idx] = row[mapped_idx] if mapped_idx < len(row) else None

        X_transformed, _ = self.table_preprocessor.transform_with_warnings([new_r], start_row=start_row)
        is_standardized = self.scaler is not None
        if is_standardized:
            X_scaled = self.scaler.transform(X_transformed)
        else:
            X_scaled = X_transformed.copy()

        weights = np.asarray(self.clf.w, dtype=float)
        intercept = float(self.clf.b)
        raw_vec = X_transformed[0]
        scaled_vec = X_scaled[0]
        contributions = scaled_vec * weights
        sum_contributions = float(np.sum(contributions))
        linear_score = float(sum_contributions + intercept)
        prob = float(sigmoid(linear_score))

        model_score = float(self.clf.predict_score(X_scaled)[0])
        model_prob = float(sigmoid(model_score))
        diff_score = abs(linear_score - model_score)
        diff_prob = abs(prob - model_prob)
        math_valid = bool(diff_score < 1e-6 and diff_prob < 1e-6)

        features = []
        for j, feat_name in enumerate(self.table_preprocessor.generated_feature_names):
            features.append({
                "feature": feat_name,
                "raw_value": float(raw_vec[j]),
                "scaled_value": float(scaled_vec[j]),
                "weight": float(weights[j]),
                "contribution": float(contributions[j]),
            })

        preparation_notes = []
        for spec, mapped_idx in zip(self.table_preprocessor.column_specs, col_mapping):
            val = row[mapped_idx] if mapped_idx < len(row) else None
            header_name = spec.source_header
            if is_missing(val):
                if spec.col_type == "numeric":
                    preparation_notes.append(
                        f"Column '{header_name}': missing value → imputed with training median ({spec.impute_value})"
                    )
                elif spec.col_type == "boolean":
                    default_str = "True" if spec.impute_value == 1.0 else "False"
                    preparation_notes.append(
                        f"Column '{header_name}': missing value → imputed with training default ({default_str})"
                    )
                elif spec.col_type == "categorical":
                    miss_feat = spec.missing_feature_name or (spec.generated_features[spec.missing_indicator_offset] if (spec.has_missing_indicator and spec.missing_indicator_offset is not None) else f"{header_name}=_missing_")
                    preparation_notes.append(
                        f"Column '{header_name}': missing/blank value → encoded with dedicated missing indicator '{miss_feat}' (= 1.0)"
                    )
            else:
                if spec.col_type == "categorical":
                    raw_cat = str(val).strip()
                    if raw_cat == spec.reference_category:
                        preparation_notes.append(
                            f"Column '{header_name}': value '{raw_cat}' is reference level → baseline (all dummy features = 0)"
                        )
                    elif raw_cat in spec.cat_to_offset:
                        feat_name = spec.generated_features[spec.cat_to_offset[raw_cat]]
                        preparation_notes.append(
                            f"Column '{header_name}': value '{raw_cat}' → active dummy '{feat_name}' = 1.0"
                        )
                    else:
                        preparation_notes.append(
                            f"Column '{header_name}': unseen category '{raw_cat}' → mapped to reference baseline (all dummy features = 0) with warning"
                        )
                elif spec.col_type == "boolean":
                    bf = to_boolean_float(val)
                    preparation_notes.append(
                        f"Column '{header_name}': boolean value '{val}' → encoded as {bf}"
                    )
                elif spec.col_type == "numeric":
                    pf = try_parse_float(val)
                    preparation_notes.append(
                        f"Column '{header_name}': numeric value {pf}"
                    )

        return {
            "math_valid": math_valid,
            "intercept": intercept,
            "standardized": is_standardized,
            "sum_contributions": sum_contributions,
            "linear_score": linear_score,
            "probability": prob,
            "diff_score": diff_score,
            "features": features,
            "preparation_notes": preparation_notes,
        }



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
        if isinstance(value, str) and not value.strip():
            raise ValueError("Outcome labels cannot be blank or whitespace-only.")
        if isinstance(value, (float, np.floating)) and not math.isfinite(float(value)):
            raise ValueError("Outcome values must be finite numbers.")
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


def _best_f1_threshold(y_true: np.ndarray, probs: np.ndarray) -> tuple[float, float]:
    """Return max-F1 threshold; ties prefer values closest to 0.5."""
    candidates = []
    for threshold in THRESHOLD_GRID:
        metrics = classification_metrics(y_true, probs, threshold=float(threshold))
        candidates.append((float(metrics["f1"]), float(threshold)))
    best_f1, best_threshold = min(
        candidates,
        key=lambda item: (-item[0], abs(item[1] - DEFAULT_THRESHOLD), item[1]),
    )
    return float(round(best_threshold, 2)), best_f1


def _training_cv(
    X_train: np.ndarray,
    y_train: np.ndarray,
    requested_folds: int,
    learning_rate: float,
    max_iterations: int,
    tolerance: float,
    l2_lambda: float,
    class_weight: str | None,
    standardize: bool,
    random_state: int,
) -> tuple[dict | None, np.ndarray | None]:
    """Run stratified cross-validation strictly on training data for threshold selection."""
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
            "converged_folds": 0,
            "all_converged": False,
            "folds": [],
            "warnings": [],
        }, None

    kfold = StratifiedKFoldScratch(
        n_splits=actual_folds, shuffle=True, random_state=random_state
    )
    oof_probs = np.empty(len(y_train), dtype=float)
    auc_scores: list[float] = []
    accuracy_scores: list[float] = []
    fold_diagnostics: list[dict] = []

    for fold_idx, (fold_train, fold_valid) in enumerate(kfold.split(X_train, y_train), start=1):
        X_tr = X_train[fold_train]
        y_tr = y_train[fold_train]
        X_va = X_train[fold_valid]
        y_va = y_train[fold_valid]

        if standardize:
            fold_scaler = StandardScalerScratch().fit(X_tr)
            X_tr_used = fold_scaler.transform(X_tr)
            X_va_used = fold_scaler.transform(X_va)
        else:
            X_tr_used, X_va_used = X_tr, X_va

        fold_model = LogisticRegressionScratch(
            learning_rate=learning_rate,
            max_iterations=max_iterations,
            tolerance=tolerance,
            l2_lambda=l2_lambda,
            class_weight=class_weight,
        )
        fold_model.fit(X_tr_used, y_tr)
        val_probs = fold_model.predict_proba(X_va_used)
        oof_probs[fold_valid] = val_probs

        val_auc = roc_auc_scratch(y_va, val_probs)
        if val_auc is not None:
            auc_scores.append(val_auc)
        val_acc = float(np.mean((val_probs >= DEFAULT_THRESHOLD).astype(int) == y_va))
        accuracy_scores.append(val_acc)

        diag = fold_model.diagnostics_ or {}
        fold_diagnostics.append(
            {
                "fold": int(fold_idx),
                "converged": bool(diag.get("converged", False)),
                "stop_reason": str(diag.get("stop_reason", "")),
                "iterations": int(diag.get("iterations", 0)),
                "warnings": list(diag.get("warnings", [])),
                "accuracy": val_acc,
                "auc": val_auc,
            }
        )

    converged_folds = sum(1 for f in fold_diagnostics if f["converged"])
    all_converged = converged_folds == actual_folds
    fold_warnings = [w for f in fold_diagnostics for w in f.get("warnings", [])]

    return {
        "requested_folds": int(requested_folds),
        "actual_folds": int(actual_folds),
        "available": True,
        "reason": None,
        "auc_mean": float(np.mean(auc_scores)) if auc_scores else None,
        "auc_std": float(np.std(auc_scores)) if auc_scores else None,
        "accuracy_mean": float(np.mean(accuracy_scores)),
        "accuracy_std": float(np.std(accuracy_scores)),
        "converged_folds": int(converged_folds),
        "all_converged": bool(all_converged),
        "folds": fold_diagnostics,
        "warnings": fold_warnings,
    }, oof_probs


def train_logistic(
    features: list[list[float]],
    labels: list,
    feature_names: list[str] | None = None,
    standardize: bool = True,
    test_size: float = 0.3,
    learning_rate: float = 0.1,
    max_iterations: int = 10_000,
    tolerance: float = 1e-6,
    l2_lambda: float = 0.0,
    class_weight: str | None = None,
    cv_folds: int = 0,
    random_state: int = 42,
) -> tuple[dict, TrainedModel]:
    """Fit a binary logistic regression model from scratch with full-batch gradient descent."""
    # Validate arguments
    learning_rate = float(learning_rate)
    if learning_rate <= 0 or learning_rate > 10.0:
        raise ValueError("Learning rate must be between 1e-5 and 10.0.")
    max_iterations = int(max_iterations)
    if max_iterations < 10 or max_iterations > 100_000:
        raise ValueError("Max iterations must be between 10 and 100,000.")
    tolerance = float(tolerance)
    if tolerance <= 0 or tolerance > 1e-2:
        raise ValueError("Tolerance must be positive and at most 1e-2.")
    l2_lambda = float(l2_lambda)
    if l2_lambda < 0 or l2_lambda > 10_000.0:
        raise ValueError("L2 lambda must be non-negative and at most 10,000.")
    if class_weight not in (None, "balanced"):
        raise ValueError('Class weight must be omitted or set to "balanced".')
    if cv_folds not in (0,) and cv_folds < 3:
        raise ValueError("Use zero to disable cross-validation or choose at least three folds.")

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

    # Check for constant features across entire dataset
    check_constant_features(X, names)

    # Seeded stratified train/test split with exact complement rounding
    test_size = float(test_size)
    train_indices, test_indices, split_meta = train_test_split_scratch(
        y, test_size=test_size, random_state=int(random_state)
    )

    X_train = X[train_indices]
    y_train = y[train_indices]
    X_test = X[test_indices]
    y_test = y[test_indices]

    # Check for constant features within the training partition
    try:
        check_constant_features(X_train, names)
    except ValueError as exc:
        raise ValueError(
            "All feature columns in the training partition are constant (zero variance). "
            "A logistic regression model cannot be trained without training feature variation."
        ) from exc

    # Training cross-validation on X_train only
    cv_summary, train_oof_probs = _training_cv(
        X_train=X_train,
        y_train=y_train,
        requested_folds=int(cv_folds),
        learning_rate=learning_rate,
        max_iterations=max_iterations,
        tolerance=tolerance,
        l2_lambda=l2_lambda,
        class_weight=class_weight,
        standardize=bool(standardize),
        random_state=int(random_state),
    )

    if train_oof_probs is None:
        selected_threshold = DEFAULT_THRESHOLD
        threshold_info = {
            "value": DEFAULT_THRESHOLD,
            "source": "default_0_5",
            "metric": None,
            "metric_value": None,
            "tuning_folds": None,
            "note": "Using the default 0.50 threshold because training-side cross-validation was not enabled.",
        }
    else:
        selected_threshold, selected_f1 = _best_f1_threshold(y_train, train_oof_probs)
        threshold_info = {
            "value": float(selected_threshold),
            "source": "training_cross_validation",
            "metric": "f1",
            "metric_value": float(selected_f1),
            "tuning_folds": cv_summary["actual_folds"] if cv_summary else None,
            "note": "Selected from out-of-fold predictions on the training portion only.",
        }

    # Final feature standardization: fit on training data only
    scaler: StandardScalerScratch | None = None
    if standardize:
        scaler = StandardScalerScratch().fit(X_train)
        X_train_used = scaler.transform(X_train)
        X_test_used = scaler.transform(X_test)
        X_all_used = scaler.transform(X)
    else:
        X_train_used, X_test_used, X_all_used = X_train, X_test, X

    # Final model fit
    clf = LogisticRegressionScratch(
        learning_rate=learning_rate,
        max_iterations=max_iterations,
        tolerance=tolerance,
        l2_lambda=l2_lambda,
        class_weight=class_weight,
    )
    clf.fit(X_train_used, y_train)

    # Coefficient rows and odds ratios
    w_vector = clf.w if clf.w is not None else np.zeros(n_features)
    b_scalar = clf.b if clf.b is not None else 0.0

    model_id = uuid.uuid4().hex
    w_model = [float(val) for val in w_vector]
    b_model = float(b_scalar)

    conversion_reason = None
    if scaler is not None:
        mean_vector = scaler.mean_
        scale_vector = scaler.scale_
        feature_means = [float(val) for val in mean_vector]
        feature_scales = [float(val) for val in scale_vector]
        w_orig_arr = w_vector / scale_vector
        b_orig_val = b_scalar - float(np.sum(w_vector * mean_vector / scale_vector))

        finite_check = bool(
            np.isfinite(w_orig_arr).all() and math.isfinite(b_orig_val)
        )
        if finite_check:
            # Check numerical equivalence on training and test rows:
            # model-space score: z_model = X_scaled @ w_vector + b_scalar
            # raw-space score: z_raw = X @ w_orig_arr + b_orig_val
            z_train_model = X_train_used @ w_vector + b_scalar
            z_train_raw = X_train @ w_orig_arr + b_orig_val
            z_test_model = X_test_used @ w_vector + b_scalar
            z_test_raw = X_test @ w_orig_arr + b_orig_val

            train_agrees = bool(np.allclose(z_train_raw, z_train_model, rtol=1e-9, atol=1e-9))
            test_agrees = bool(np.allclose(z_test_raw, z_test_model, rtol=1e-9, atol=1e-9))

            if train_agrees and test_agrees:
                conversion_valid = True
                w_orig = [float(val) for val in w_orig_arr]
                b_orig = float(b_orig_val)
            else:
                conversion_valid = False
                conversion_reason = (
                    "Raw-unit conversion produced numerical disagreement with model-space scores "
                    "(tolerance rtol=1e-9, atol=1e-9 exceeded). Features may have large offsets or extreme scales."
                )
                w_orig = None
                b_orig = None
        else:
            conversion_valid = False
            conversion_reason = "Raw-unit parameters are non-finite (overflow during scale/offset calculation)."
            w_orig = None
            b_orig = None
    else:
        feature_means = None
        feature_scales = None
        w_orig = [float(val) for val in w_vector]
        b_orig = float(b_scalar)
        conversion_valid = True
        conversion_reason = None

    parameters_dict = {
        "model_id": model_id,
        "feature_names": names,
        "feature_space": "standardized" if standardize else "original",
        "weights_model_space": w_model,
        "intercept_model_space": b_model,
        "weights_original_units": w_orig,
        "intercept_original_units": b_orig,
        "feature_means": feature_means,
        "feature_scales": feature_scales,
        "conversion_valid": conversion_valid,
        "conversion_reason": conversion_reason,
        "standardized": bool(standardize),
        "class_labels": {
            "negative": str(class_labels[0]),
            "positive": str(class_labels[1]),
        },
    }

    coefficients_vector = np.concatenate([[b_scalar], w_vector])
    coefficient_rows = []
    for index, name in enumerate(["Intercept"] + names):
        coef_val = float(coefficients_vector[index])
        try:
            odds_ratio = float(np.exp(coef_val))
            if not math.isfinite(odds_ratio):
                odds_ratio = None
        except OverflowError:
            odds_ratio = None

        coefficient_rows.append(
            {
                "name": name,
                "coef": coef_val,
                "odds_ratio": odds_ratio,
                "std_error": None,
                "z": None,
                "p_value": None,
                "significant": None,
            }
        )

    # Inference disclaimer
    inference = {
        "available": False,
        "method": None,
        "reason": (
            "Standard errors, z-scores, and p-values are not available for this "
            "gradient-descent scratch implementation without asymptotic covariance estimation."
        ),
    }

    # Test set predictions and metrics
    test_scores = clf.predict_score(X_test_used)
    test_probs = clf.predict_proba(X_test_used)
    train_majority = int(np.bincount(y_train, minlength=2).argmax())

    metrics_0_5 = classification_metrics(
        y_test, test_probs, threshold=DEFAULT_THRESHOLD, train_majority_class=train_majority
    )
    metrics_selected = classification_metrics(
        y_test, test_probs, threshold=selected_threshold, train_majority_class=train_majority
    )

    # ROC curve on test set
    fpr, tpr, _ = roc_curve_scratch(y_test, test_probs)
    roc = {
        "fpr": fpr,
        "tpr": tpr,
        "available": bool(len(fpr) > 0),
        "reason": None if len(fpr) > 0 else "ROC curve is undefined because the test set contains only one class.",
    }

    # Predictions for all original observations with train/test tag
    all_scores = clf.predict_score(X_all_used)
    all_probs = clf.predict_proba(X_all_used)
    partition_map = {idx: "train" for idx in train_indices}
    for idx in test_indices:
        partition_map[idx] = "test"
    partitions = [partition_map[i] for i in range(n_samples)]

    model = TrainedModel(
        clf,
        scaler,
        names,
        class_labels,
        model_id,
        clf.diagnostics_ or {},
        parameters=parameters_dict,
    )

    preprocessing_meta = {
        "standardized": bool(standardize),
        "feature_means": feature_means,
        "feature_scales": feature_scales,
        "zero_variance_features": [names[i] for i in scaler.zero_variance_indices_]
        if scaler is not None
        else [],
    }

    result = {
        "ok": True,
        "model_id": model_id,
        "engine": "scratch",
        "method": "Full-batch gradient descent",
        "n_samples": int(n_samples),
        "n_features": int(n_features),
        "feature_names": names,
        "class_labels": {
            "negative": str(class_labels[0]),
            "positive": str(class_labels[1]),
        },
        "class_balance": {
            "negative": int((y == 0).sum()),
            "positive": int((y == 1).sum()),
        },
        "training_class_balance": {
            "negative": int((y_train == 0).sum()),
            "positive": int((y_train == 1).sum()),
        },
        "split": split_meta,
        "evaluation": {
            "mode": "held-out test",
            "n_train": int(len(y_train)),
            "n_test": int(len(y_test)),
            "notice": None,
        },
        "standardized": bool(standardize),
        "preprocessing": preprocessing_meta,
        "parameters": parameters_dict,
        "training_settings": {
            "learning_rate": learning_rate,
            "max_iterations": max_iterations,
            "tolerance": tolerance,
            "l2_lambda": l2_lambda,
            "class_weight": class_weight,
            "test_size": float(test_size),
            "cv_folds": int(cv_folds),
            "random_state": int(random_state),
        },
        "diagnostics": clf.diagnostics_,
        "software": {
            "python": platform.python_version(),
            "numpy": np.__version__,
        },
        "coefficients": coefficient_rows,
        "inference": inference,
        "training_warnings": (
            list(clf.diagnostics_.get("warnings", []))
            + ([conversion_reason] if conversion_reason else [])
            + (list(cv_summary.get("warnings", [])) if cv_summary and cv_summary.get("warnings") else [])
        ),
        "metrics": metrics_0_5,
        "metrics_at_threshold": metrics_selected,
        "cross_validation": cv_summary,
        "threshold": threshold_info,
        "suggested_threshold": float(selected_threshold),
        "confusion_matrix": metrics_selected["confusion_matrix"],
        "confusion_matrix_0_5": metrics_0_5["confusion_matrix"],
        "roc": roc,
        "threshold_data": {
            "y_true": [int(val) for val in y_test],
            "score": [float(val) for val in test_scores],
            "prob": [float(val) for val in test_probs],
        },
        "predictions": {
            "score": [float(val) for val in all_scores],
            "prob": [float(val) for val in all_probs],
            "pred_0_5": [int(val >= DEFAULT_THRESHOLD) for val in all_probs],
            "pred_selected": [int(val >= selected_threshold) for val in all_probs],
            "partition": partitions,
        },
    }

    if not np.isfinite(clf.w).all() or not math.isfinite(clf.b):
        raise ValueError("Model parameters contain non-finite values.")
    if (
        not np.isfinite(test_scores).all()
        or not np.isfinite(test_probs).all()
        or not np.isfinite(all_scores).all()
        or not np.isfinite(all_probs).all()
    ):
        raise ValueError("Model predictions contain non-finite values.")

    return result, model


def _training_table_cv(
    train_rows: list[list[Any]],
    y_train: np.ndarray,
    selected_indices: list[int],
    headers: list[str],
    column_types: dict[str, str] | None,
    missing_policy: str,
    impute_numeric: str,
    category_max_cardinality: int,
    requested_folds: int,
    learning_rate: float,
    max_iterations: int,
    tolerance: float,
    l2_lambda: float,
    class_weight: str | None,
    standardize: bool,
    random_state: int,
    train_row_numbers: list[int] | None = None,
) -> tuple[dict | None, np.ndarray | None]:
    """Run stratified cross-validation on raw tabular training data without evaluation leakage."""
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
            "converged_folds": 0,
            "all_converged": False,
            "folds": [],
            "warnings": [],
        }, None

    kfold = StratifiedKFoldScratch(
        n_splits=actual_folds, shuffle=True, random_state=random_state
    )
    oof_probs = np.empty(len(y_train), dtype=float)
    auc_scores: list[float] = []
    accuracy_scores: list[float] = []
    fold_diagnostics: list[dict] = []

    dummy_X = np.zeros((len(y_train), 1))
    for fold_idx, (fold_train, fold_valid) in enumerate(kfold.split(dummy_X, y_train), start=1):
        fold_tr_rows = [train_rows[i] for i in fold_train]
        fold_va_rows = [train_rows[i] for i in fold_valid]
        fold_tr_row_numbers = [train_row_numbers[i] for i in fold_train] if train_row_numbers is not None else None
        fold_va_row_numbers = [train_row_numbers[i] for i in fold_valid] if train_row_numbers is not None else None
        y_tr = y_train[fold_train]
        y_va = y_train[fold_valid]

        # Fit fold preprocessor strictly on fold training rows
        fold_prep = TablePreprocessorScratch(
            selected_indices=selected_indices,
            source_headers=headers,
            column_types=column_types,
            missing_policy=missing_policy,
            impute_numeric=impute_numeric,
            category_max_cardinality=category_max_cardinality,
        )
        fold_prep.fit(fold_tr_rows, row_numbers=fold_tr_row_numbers)
        X_tr = fold_prep.transform(fold_tr_rows, row_numbers=fold_tr_row_numbers)
        X_va = fold_prep.transform(fold_va_rows, row_numbers=fold_va_row_numbers)

        if standardize:
            fold_scaler = StandardScalerScratch().fit(X_tr)
            X_tr_used = fold_scaler.transform(X_tr)
            X_va_used = fold_scaler.transform(X_va)
        else:
            X_tr_used, X_va_used = X_tr, X_va

        fold_model = LogisticRegressionScratch(
            learning_rate=learning_rate,
            max_iterations=max_iterations,
            tolerance=tolerance,
            l2_lambda=l2_lambda,
            class_weight=class_weight,
        )
        fold_model.fit(X_tr_used, y_tr)
        val_probs = fold_model.predict_proba(X_va_used)
        oof_probs[fold_valid] = val_probs

        val_auc = roc_auc_scratch(y_va, val_probs)
        if val_auc is not None:
            auc_scores.append(val_auc)
        val_acc = float(np.mean((val_probs >= DEFAULT_THRESHOLD).astype(int) == y_va))
        accuracy_scores.append(val_acc)

        diag = fold_model.diagnostics_ or {}
        fold_diagnostics.append(
            {
                "fold": int(fold_idx),
                "converged": bool(diag.get("converged", False)),
                "stop_reason": str(diag.get("stop_reason", "")),
                "iterations": int(diag.get("iterations", 0)),
                "warnings": list(diag.get("warnings", [])),
                "accuracy": val_acc,
                "auc": val_auc,
            }
        )

    converged_folds = sum(1 for f in fold_diagnostics if f["converged"])
    all_converged = converged_folds == actual_folds
    fold_warnings = [w for f in fold_diagnostics for w in f.get("warnings", [])]

    return {
        "requested_folds": int(requested_folds),
        "actual_folds": int(actual_folds),
        "available": True,
        "reason": None,
        "auc_mean": float(np.mean(auc_scores)) if auc_scores else None,
        "auc_std": float(np.std(auc_scores)) if auc_scores else None,
        "accuracy_mean": float(np.mean(accuracy_scores)) if accuracy_scores else None,
        "accuracy_std": float(np.std(accuracy_scores)) if accuracy_scores else None,
        "converged_folds": int(converged_folds),
        "all_converged": bool(all_converged),
        "folds": fold_diagnostics,
        "warnings": fold_warnings,
    }, oof_probs


def train_table_logistic(
    headers: list[str],
    rows: list[list[Any]],
    y_column: str | int,
    selected_x_columns: list[int],
    column_types: dict[str, str] | None = None,
    missing_policy: Literal["impute", "drop_rows"] = "impute",
    impute_numeric: Literal["median", "mean"] = "median",
    category_max_cardinality: int = 20,
    standardize: bool = True,
    test_size: float = 0.3,
    learning_rate: float = 0.1,
    max_iterations: int = 10000,
    tolerance: float = 1e-6,
    l2_lambda: float = 0.0,
    class_weight: str | None = None,
    cv_folds: int = 0,
    random_state: int = 42,
    start_row: int = 1,
    start_col: int = 1,
) -> tuple[dict, TrainedModel]:
    """Train logistic regression model on an Excel table with heterogeneous columns."""
    total_rows = len(rows)
    total_cols = len(headers)
    if total_rows < 10:
        raise ValueError(f"Table training requires at least 10 rows (found {total_rows}).")
    if not selected_x_columns:
        raise ValueError("At least one feature column must be selected.")

    if len(selected_x_columns) != len(set(selected_x_columns)):
        raise ValueError("Duplicate column indices detected in feature selection.")
    for idx in selected_x_columns:
        if idx < 0 or idx >= total_cols:
            raise ValueError(f"Selected feature index {idx} is out of table bounds [0, {total_cols - 1}].")

    # Check for duplicate feature header names using canonical normalize_header
    selected_header_map: dict[str, list[tuple[str, str]]] = {}
    for idx in selected_x_columns:
        h = headers[idx] if idx < len(headers) else f"Col_{idx}"
        norm_h = normalize_header(h)
        col_letter = col_index_to_letter(start_col - 1 + idx)
        selected_header_map.setdefault(norm_h, []).append((str(h), f"{col_letter} (index {idx})"))

    duplicate_headers = {norm_h: entries for norm_h, entries in selected_header_map.items() if len(entries) > 1}
    if duplicate_headers:
        first_norm, entries = next(iter(duplicate_headers.items()))
        loc_strs = [f"'{h}' at {loc}" for h, loc in entries]
        raise ValueError(
            f"Ambiguous or duplicate selected feature header detected for '{entries[0][0]}' ({', '.join(loc_strs)}). "
            "Please ensure selected column headers are unique up to case and whitespace."
        )

    # 1. Resolve Y column index
    if isinstance(y_column, int):
        y_idx = int(y_column)
    else:
        clean_target = normalize_header(y_column)
        matching_indices = [
            i for i, h in enumerate(headers)
            if normalize_header(h) == clean_target
        ]
        if not matching_indices:
            raise ValueError(f"Outcome column '{y_column}' was not found in table headers.")
        if len(matching_indices) > 1:
            matched_descs = [f"'{headers[i]}' ({col_index_to_letter(start_col - 1 + i)}, index {i})" for i in matching_indices]
            raise ValueError(
                f"Outcome column '{y_column}' is ambiguous: matches multiple headers ({', '.join(matched_descs)}). "
                "Specify the outcome column by index or rename duplicate headers in Excel."
            )
        y_idx = matching_indices[0]

    if y_idx < 0 or y_idx >= total_cols:
        raise ValueError(f"Invalid outcome column index: {y_idx}")
    if y_idx in selected_x_columns:
        y_col_letter = col_index_to_letter(start_col - 1 + y_idx)
        raise ValueError(
            f"Outcome column '{headers[y_idx]}' (column {y_col_letter}) cannot also be selected as an input feature."
        )

    y_header = headers[y_idx] if y_idx < len(headers) else f"Col_{y_idx}"
    y_norm = normalize_header(y_header)
    if y_norm in selected_header_map:
        entries = selected_header_map[y_norm]
        y_loc = f"{col_index_to_letter(start_col - 1 + y_idx)} (index {y_idx})"
        feature_locs = [f"'{h}' at {loc}" for h, loc in entries]
        raise ValueError(
            f"Outcome column header '{y_header}' at {y_loc} conflicts with selected feature {', '.join(feature_locs)}. "
            "Please rename headers in Excel before fitting."
        )

    # 2. Filter missing Y rows (Excel row number = start_row + 1 + r)
    data_start_row = start_row + 1
    excluded_missing_y_rows: list[int] = []
    valid_y_pairs: list[tuple[int, list[Any], Any]] = []

    for r_idx, r in enumerate(rows):
        y_val = r[y_idx] if y_idx < len(r) else None
        if is_missing(y_val):
            excluded_missing_y_rows.append(data_start_row + r_idx)
        else:
            valid_y_pairs.append((r_idx, r, y_val))

    if len(valid_y_pairs) < 10:
        raise ValueError("Too few rows with valid non-missing outcome values to train a model.")

    # 3. Filter missing X rows if complete-case policy requested
    excluded_missing_x_rows: list[int] = []
    clean_pairs: list[tuple[int, list[Any], Any]] = []

    if missing_policy == "drop_rows":
        for orig_r, r, y_val in valid_y_pairs:
            has_missing = any(is_missing(r[c]) if c < len(r) else True for c in selected_x_columns)
            if has_missing:
                excluded_missing_x_rows.append(data_start_row + orig_r)
            else:
                clean_pairs.append((orig_r, r, y_val))
        if len(clean_pairs) < 10:
            raise ValueError(
                f"Complete case policy ('drop_rows') left {len(clean_pairs)} rows, which is below the 10-row minimum."
            )
    else:
        clean_pairs = valid_y_pairs

    # 4. Target encoding & validation
    y_raw = [p[2] for p in clean_pairs]
    y, class_labels = _validate_and_encode_labels(y_raw)
    clean_rows = [p[1] for p in clean_pairs]
    clean_row_numbers = [data_start_row + p[0] for p in clean_pairs]

    # 5. Seeded stratified train/test split
    train_indices, test_indices, split_meta = train_test_split_scratch(y, test_size=test_size, random_state=random_state)
    train_rows = [clean_rows[i] for i in train_indices]
    test_rows = [clean_rows[i] for i in test_indices]
    train_row_numbers = [clean_row_numbers[i] for i in train_indices]
    test_row_numbers = [clean_row_numbers[i] for i in test_indices]
    y_train = y[train_indices]
    y_test = y[test_indices]

    # 6. Training Cross-Validation
    cv_summary, train_oof_probs = _training_table_cv(
        train_rows=train_rows,
        y_train=y_train,
        selected_indices=selected_x_columns,
        headers=headers,
        column_types=column_types,
        missing_policy=missing_policy,
        impute_numeric=impute_numeric,
        category_max_cardinality=category_max_cardinality,
        requested_folds=int(cv_folds),
        learning_rate=learning_rate,
        max_iterations=max_iterations,
        tolerance=tolerance,
        l2_lambda=l2_lambda,
        class_weight=class_weight,
        standardize=bool(standardize),
        random_state=int(random_state),
        train_row_numbers=train_row_numbers,
    )

    if train_oof_probs is None:
        selected_threshold = DEFAULT_THRESHOLD
        threshold_info = {
            "value": DEFAULT_THRESHOLD,
            "source": "default_0_5",
            "metric": None,
            "metric_value": None,
            "tuning_folds": None,
            "note": "Using the default 0.50 threshold because training-side cross-validation was not enabled.",
        }
    else:
        selected_threshold, selected_f1 = _best_f1_threshold(y_train, train_oof_probs)
        threshold_info = {
            "value": float(selected_threshold),
            "source": "training_cross_validation",
            "metric": "f1",
            "metric_value": float(selected_f1),
            "tuning_folds": cv_summary["actual_folds"] if cv_summary else None,
            "note": "Selected from out-of-fold predictions on the training portion only.",
        }

    # 7. Fit final preprocessor strictly on training partition
    preprocessor = TablePreprocessorScratch(
        selected_indices=selected_x_columns,
        source_headers=headers,
        column_types=column_types,
        missing_policy=missing_policy,
        impute_numeric=impute_numeric,
        category_max_cardinality=category_max_cardinality,
    )
    preprocessor.fit(train_rows, start_row=data_start_row, row_numbers=train_row_numbers)
    X_train = preprocessor.transform(train_rows, start_row=data_start_row, row_numbers=train_row_numbers)
    X_test = preprocessor.transform(test_rows, start_row=data_start_row, row_numbers=test_row_numbers)
    X_all = preprocessor.transform(clean_rows, start_row=data_start_row, row_numbers=clean_row_numbers)

    names = preprocessor.generated_feature_names
    n_features = len(names)

    # Constant feature check on transformed training data
    try:
        check_constant_features(X_train)
    except ValueError as exc:
        raise ValueError(
            "All generated feature columns in the training partition are constant (zero variance). "
            "A logistic regression model cannot be trained without training feature variation."
        ) from exc

    # 8. Feature standardization
    scaler: StandardScalerScratch | None = None
    if standardize:
        scaler = StandardScalerScratch().fit(X_train)
        X_train_used = scaler.transform(X_train)
        X_test_used = scaler.transform(X_test)
        X_all_used = scaler.transform(X_all)
    else:
        X_train_used, X_test_used, X_all_used = X_train, X_test, X_all

    # 9. Fit model
    clf = LogisticRegressionScratch(
        learning_rate=learning_rate,
        max_iterations=max_iterations,
        tolerance=tolerance,
        l2_lambda=l2_lambda,
        class_weight=class_weight,
    )
    clf.fit(X_train_used, y_train)

    w_vector = clf.w if clf.w is not None else np.zeros(n_features)
    b_scalar = clf.b if clf.b is not None else 0.0

    model_id = uuid.uuid4().hex
    w_model = [float(val) for val in w_vector]
    b_model = float(b_scalar)

    conversion_reason = None
    if scaler is not None:
        mean_vector = scaler.mean_
        scale_vector = scaler.scale_
        feature_means = [float(val) for val in mean_vector]
        feature_scales = [float(val) for val in scale_vector]
        w_orig_arr = w_vector / scale_vector
        b_orig_val = b_scalar - float(np.sum(w_vector * mean_vector / scale_vector))

        finite_check = bool(np.isfinite(w_orig_arr).all() and math.isfinite(b_orig_val))
        if finite_check:
            z_train_model = X_train_used @ w_vector + b_scalar
            z_train_raw = X_train @ w_orig_arr + b_orig_val
            z_test_model = X_test_used @ w_vector + b_scalar
            z_test_raw = X_test @ w_orig_arr + b_orig_val

            train_agrees = bool(np.allclose(z_train_raw, z_train_model, rtol=1e-9, atol=1e-9))
            test_agrees = bool(np.allclose(z_test_raw, z_test_model, rtol=1e-9, atol=1e-9))

            if train_agrees and test_agrees:
                conversion_valid = True
                w_orig = [float(val) for val in w_orig_arr]
                b_orig = float(b_orig_val)
            else:
                conversion_valid = False
                conversion_reason = (
                    "Raw-unit conversion produced numerical disagreement with model-space scores."
                )
                w_orig = None
                b_orig = None
        else:
            conversion_valid = False
            conversion_reason = "Raw-unit parameters are non-finite (overflow during scale/offset calculation)."
            w_orig = None
            b_orig = None
    else:
        feature_means = None
        feature_scales = None
        w_orig = [float(val) for val in w_vector]
        b_orig = float(b_scalar)
        conversion_valid = True
        conversion_reason = None

    parameters_dict = {
        "model_id": model_id,
        "feature_names": names,
        "feature_space": "standardized" if standardize else "original",
        "weights_model_space": w_model,
        "intercept_model_space": b_model,
        "weights_original_units": w_orig,
        "intercept_original_units": b_orig,
        "feature_means": feature_means,
        "feature_scales": feature_scales,
        "conversion_valid": conversion_valid,
        "conversion_reason": conversion_reason,
        "standardized": bool(standardize),
        "class_labels": {
            "negative": str(class_labels[0]),
            "positive": str(class_labels[1]),
        },
    }

    coefficients_vector = np.concatenate([[b_scalar], w_vector])
    coefficient_rows = []
    for index, name in enumerate(["Intercept"] + names):
        coef_val = float(coefficients_vector[index])
        try:
            odds_ratio = float(np.exp(coef_val))
            if not math.isfinite(odds_ratio):
                odds_ratio = None
        except OverflowError:
            odds_ratio = None

        coefficient_rows.append(
            {
                "name": name,
                "coef": coef_val,
                "odds_ratio": odds_ratio,
                "std_error": None,
                "z": None,
                "p_value": None,
                "significant": None,
            }
        )

    inference = {
        "available": False,
        "method": None,
        "reason": (
            "Standard errors, z-scores, and p-values are not available for this "
            "gradient-descent scratch implementation without asymptotic covariance estimation."
        ),
    }

    test_scores = clf.predict_score(X_test_used)
    test_probs = clf.predict_proba(X_test_used)
    train_majority = int(np.bincount(y_train, minlength=2).argmax())

    metrics_0_5 = classification_metrics(
        y_test, test_probs, threshold=DEFAULT_THRESHOLD, train_majority_class=train_majority
    )
    metrics_selected = classification_metrics(
        y_test, test_probs, threshold=selected_threshold, train_majority_class=train_majority
    )

    fpr, tpr, _ = roc_curve_scratch(y_test, test_probs)
    roc = {
        "fpr": fpr,
        "tpr": tpr,
        "available": bool(len(fpr) > 0),
        "reason": None if len(fpr) > 0 else "ROC curve is undefined because the test set contains only one class.",
    }

    all_scores = clf.predict_score(X_all_used)
    all_probs = clf.predict_proba(X_all_used)
    partitions = [""] * len(clean_rows)
    for idx in train_indices:
        partitions[idx] = "train"
    for idx in test_indices:
        partitions[idx] = "test"

    table_meta = {
        "source_headers": headers,
        "selected_indices": selected_x_columns,
        "y_column_name": headers[y_idx],
        "y_column_index": y_idx,
        "missing_policy": missing_policy,
        "impute_numeric": impute_numeric,
        "total_rows": total_rows,
        "usable_rows": len(clean_rows),
        "excluded_missing_y_rows": excluded_missing_y_rows,
        "excluded_missing_x_rows": excluded_missing_x_rows,
        "column_specs": [s.to_dict() for s in preprocessor.column_specs],
        "generated_feature_names": preprocessor.generated_feature_names,
    }

    result = {
        "ok": True,
        "table_mode": True,
        "table_metadata": table_meta,
        "model_id": model_id,
        "feature_names": names,
        "n_samples": int(len(clean_rows)),
        "n_features": int(n_features),
        "class_labels": {
            "negative": str(class_labels[0]),
            "positive": str(class_labels[1]),
        },
        "class_balance": {
            "negative": int((y == 0).sum()),
            "positive": int((y == 1).sum()),
        },
        "training_class_balance": {
            "negative": int((y_train == 0).sum()),
            "positive": int((y_train == 1).sum()),
        },
        "split": {
            "train_fraction": float(round(1.0 - test_size, 4)),
            "test_fraction": float(round(test_size, 4)),
            "n_train": int(len(train_indices)),
            "n_test": int(len(test_indices)),
            "actual_train_percent": int(round(len(train_indices) / len(clean_rows) * 100)),
            "actual_test_percent": int(round(len(test_indices) / len(clean_rows) * 100)),
            "requested_test_size": float(test_size),
        },
        "evaluation": {
            "mode": "held-out test",
            "n_train": int(len(y_train)),
            "n_test": int(len(y_test)),
            "notice": None,
        },
        "standardized": bool(standardize),
        "parameters": parameters_dict,
        "training_settings": {
            "learning_rate": learning_rate,
            "max_iterations": max_iterations,
            "tolerance": tolerance,
            "l2_lambda": l2_lambda,
            "class_weight": class_weight,
            "test_size": float(test_size),
            "cv_folds": int(cv_folds),
            "random_state": int(random_state),
        },
        "diagnostics": clf.diagnostics_,
        "software": {
            "python": platform.python_version(),
            "numpy": np.__version__,
        },
        "coefficients": coefficient_rows,
        "inference": inference,
        "training_warnings": (
            list(clf.diagnostics_.get("warnings", []))
            + ([conversion_reason] if conversion_reason else [])
            + (list(cv_summary.get("warnings", [])) if cv_summary and cv_summary.get("warnings") else [])
        ),
        "metrics": metrics_0_5,
        "metrics_at_threshold": metrics_selected,
        "cross_validation": cv_summary,
        "threshold": threshold_info,
        "suggested_threshold": float(selected_threshold),
        "confusion_matrix": metrics_selected["confusion_matrix"],
        "confusion_matrix_0_5": metrics_0_5["confusion_matrix"],
        "roc": roc,
        "threshold_data": {
            "y_true": [int(val) for val in y_test],
            "score": [float(val) for val in test_scores],
            "prob": [float(val) for val in test_probs],
        },
        "predictions": {
            "row_number": clean_row_numbers,
            "score": [float(val) for val in all_scores],
            "prob": [float(val) for val in all_probs],
            "pred_0_5": [int(val >= DEFAULT_THRESHOLD) for val in all_probs],
            "pred_selected": [int(val >= selected_threshold) for val in all_probs],
            "partition": partitions,
        },
    }

    if not np.isfinite(clf.w).all() or not math.isfinite(clf.b):
        raise ValueError("Model parameters contain non-finite values.")
    if (
        not np.isfinite(test_scores).all()
        or not np.isfinite(test_probs).all()
        or not np.isfinite(all_scores).all()
        or not np.isfinite(all_probs).all()
    ):
        raise ValueError("Model predictions contain non-finite values.")

    model = TrainedModel(
        clf=clf,
        scaler=scaler,
        feature_names=names,
        class_labels=class_labels,
        model_id=model_id,
        training_diagnostics=clf.diagnostics_,
        parameters=parameters_dict,
        table_preprocessor=preprocessor,
        source_columns=[s.to_dict() for s in preprocessor.column_specs],
        dropped_rows_summary={
            "excluded_missing_y_rows": excluded_missing_y_rows,
            "excluded_missing_x_rows": excluded_missing_x_rows,
            "total_rows": total_rows,
            "usable_rows": len(clean_rows),
        },
    )

    return result, model

