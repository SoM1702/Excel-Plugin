"""Pure Python/NumPy scratch tabular data preprocessor.

Performs:
- Missing value imputation (training partition medians/modes only)
- Categorical one-hot encoding with explicit reference level (k - 1 indicators)
- Unseen category handling (deterministic zero-vector for indicators)
- Boolean numeric encoding (0.0 / 1.0)
- Detailed feature-to-source column traceability and serialization

Zero external ML libraries (scikit-learn, scipy, statsmodels) used.
"""

from __future__ import annotations

import math
from typing import Any, Literal
import numpy as np

from table_schema import is_missing, is_invalid, try_parse_float, is_boolean_value, to_boolean_float


class ColumnSpec:
    """Transformation specification for a single source column."""

    def __init__(
        self,
        source_index: int,
        source_header: str,
        col_type: Literal["numeric", "categorical", "boolean"],
        impute_strategy: Literal["median", "mean", "mode"] = "median",
    ):
        self.source_index = source_index
        self.source_header = source_header
        self.col_type = col_type
        self.impute_strategy = impute_strategy

        # Fitted parameters
        self.impute_value: float | str | None = None
        self.categories: list[str] = []  # Active indicator categories (excluding reference)
        self.reference_category: str | None = None  # Base category
        self.all_train_categories: list[str] = []
        self.has_missing_indicator: bool = False
        self.missing_indicator_offset: int | None = None
        self.cat_to_offset: dict[str, int] = {}
        self.missing_feature_name: str | None = None
        self.generated_features: list[str] = []

    def to_dict(self) -> dict[str, Any]:
        return {
            "source_index": self.source_index,
            "source_header": self.source_header,
            "col_type": self.col_type,
            "impute_strategy": self.impute_strategy,
            "impute_value": self.impute_value,
            "categories": self.categories,
            "reference_category": self.reference_category,
            "all_train_categories": self.all_train_categories,
            "has_missing_indicator": self.has_missing_indicator,
            "missing_indicator_offset": self.missing_indicator_offset,
            "cat_to_offset": self.cat_to_offset,
            "missing_feature_name": self.missing_feature_name,
            "generated_features": self.generated_features,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> ColumnSpec:
        spec = cls(
            source_index=data["source_index"],
            source_header=data["source_header"],
            col_type=data["col_type"],
            impute_strategy=data.get("impute_strategy", "median"),
        )
        spec.impute_value = data.get("impute_value")
        spec.categories = data.get("categories", [])
        spec.reference_category = data.get("reference_category")
        spec.all_train_categories = data.get("all_train_categories", [])
        spec.generated_features = data.get("generated_features", [])
        spec.has_missing_indicator = data.get("has_missing_indicator", False)
        spec.missing_indicator_offset = data.get("missing_indicator_offset")
        spec.cat_to_offset = data.get("cat_to_offset", {})
        spec.missing_feature_name = data.get("missing_feature_name")
        # Legacy fallback if cat_to_offset was not serialized
        if not spec.cat_to_offset and spec.col_type == "categorical":
            offset = 0
            for cat in spec.categories:
                if cat != "_missing_":
                    spec.cat_to_offset[cat] = offset
                    offset += 1
                else:
                    spec.has_missing_indicator = True
                    spec.missing_indicator_offset = offset
                    offset += 1
        return spec


class TablePreprocessorScratch:
    """Fitted tabular preprocessor that transforms raw heterogeneous rows into a numeric matrix."""

    def __init__(
        self,
        selected_indices: list[int],
        source_headers: list[str],
        column_types: dict[str, str] | None = None,
        missing_policy: Literal["impute", "drop_rows"] = "impute",
        impute_numeric: Literal["median", "mean"] = "median",
        category_max_cardinality: int = 20,
    ):
        self.selected_indices = list(selected_indices)
        self.source_headers = list(source_headers)
        self.column_types = column_types or {}
        self.missing_policy = missing_policy
        self.impute_numeric = impute_numeric
        self.category_max_cardinality = category_max_cardinality

        self.column_specs: list[ColumnSpec] = []
        self.generated_feature_names: list[str] = []
        self.feature_to_source_map: list[int] = []  # Maps each generated feature to its source column index
        self.is_fitted = False

        # Warnings observed during transform
        self.last_transform_warnings: list[str] = []

    def fit(
        self,
        raw_train_rows: list[list[Any]],
        start_row: int = 2,
        row_numbers: list[int] | None = None,
    ) -> TablePreprocessorScratch:
        """Fit preprocessor strictly on the training partition rows."""
    def _make_unique_feature_name(self, candidate: str) -> str:
        """Ensure every generated feature name is strictly unique across the entire model."""
        if candidate not in self._all_feature_names_set:
            self._all_feature_names_set.add(candidate)
            return candidate
        counter = 1
        while f"{candidate}#{counter}" in self._all_feature_names_set:
            counter += 1
        unique_name = f"{candidate}#{counter}"
        self._all_feature_names_set.add(unique_name)
        return unique_name

    def fit(
        self,
        raw_train_rows: list[list[Any]],
        start_row: int = 2,
        row_numbers: list[int] | None = None,
    ) -> TablePreprocessorScratch:
        """Fit preprocessor strictly on the training partition rows."""
        if not raw_train_rows:
            raise ValueError("Cannot fit TablePreprocessorScratch on empty rows.")

        self.column_specs = []
        self.generated_feature_names = []
        self.feature_to_source_map = []
        self._all_feature_names_set: set[str] = set()

        num_rows = len(raw_train_rows)

        for col_idx in self.selected_indices:
            header = self.source_headers[col_idx] if col_idx < len(self.source_headers) else f"Col_{col_idx}"
            col_vals = [raw_train_rows[r][col_idx] if col_idx < len(raw_train_rows[r]) else None for r in range(num_rows)]

            # Inferred or overridden type
            user_type = self.column_types.get(header) or self.column_types.get(str(col_idx))
            if user_type in ("numeric", "categorical", "boolean"):
                detected_type = user_type
            else:
                # Infer type from non-missing training values
                non_missing = [v for v in col_vals if not is_missing(v)]
                if not non_missing:
                    detected_type = "numeric"
                else:
                    bool_count = sum(1 for v in non_missing if is_boolean_value(v))
                    num_count = sum(1 for v in non_missing if try_parse_float(v) is not None and not isinstance(v, bool))
                    if bool_count == len(non_missing) and len(set(non_missing)) <= 2:
                        detected_type = "boolean"
                    elif num_count == len(non_missing):
                        detected_type = "numeric"
                    else:
                        detected_type = "categorical"

            spec = ColumnSpec(
                source_index=col_idx,
                source_header=header,
                col_type=detected_type,
                impute_strategy=self.impute_numeric if detected_type == "numeric" else "mode",
            )

            # Fit according to type
            if detected_type == "numeric":
                num_vals: list[float] = []
                for r_i, v in enumerate(col_vals):
                    excel_row = row_numbers[r_i] if row_numbers is not None and r_i < len(row_numbers) else start_row + r_i
                    if is_missing(v):
                        continue
                    if is_invalid(v):
                        raise ValueError(
                            f"Column '{header}' (row {excel_row}) contains invalid cell value: {repr(v)}"
                        )
                    pf = try_parse_float(v)
                    if pf is None:
                        raise ValueError(
                            f"Column '{header}' (row {excel_row}) contains non-numeric value: {repr(v)}"
                        )
                    num_vals.append(pf)

                if not num_vals:
                    spec.impute_value = 0.0
                elif self.impute_numeric == "mean":
                    spec.impute_value = float(np.mean(num_vals))
                else:
                    spec.impute_value = float(np.median(num_vals))

                feat_name = self._make_unique_feature_name(header)
                spec.generated_features = [feat_name]
                self.generated_feature_names.append(feat_name)
                self.feature_to_source_map.append(col_idx)

            elif detected_type == "boolean":
                bool_vals: list[float] = []
                for r_i, v in enumerate(col_vals):
                    excel_row = row_numbers[r_i] if row_numbers is not None and r_i < len(row_numbers) else start_row + r_i
                    if is_missing(v):
                        continue
                    if is_invalid(v):
                        raise ValueError(
                            f"Column '{header}' (row {excel_row}) contains invalid cell value: {repr(v)}"
                        )
                    bf = to_boolean_float(v)
                    if bf is None:
                        raise ValueError(
                            f"Column '{header}' (row {excel_row}) contains non-boolean value: {repr(v)}"
                        )
                    bool_vals.append(bf)
                spec.impute_value = 1.0 if (bool_vals and np.mean(bool_vals) >= 0.5) else 0.0

                feat_name = self._make_unique_feature_name(header)
                spec.generated_features = [feat_name]
                self.generated_feature_names.append(feat_name)
                self.feature_to_source_map.append(col_idx)

            elif detected_type == "categorical":
                cat_counts: dict[str, int] = {}
                missing_count = 0
                for r_i, v in enumerate(col_vals):
                    excel_row = row_numbers[r_i] if row_numbers is not None and r_i < len(row_numbers) else start_row + r_i
                    if is_missing(v):
                        missing_count += 1
                        continue
                    if is_invalid(v):
                        raise ValueError(
                            f"Column '{header}' (row {excel_row}) contains invalid error/object cell: {repr(v)}"
                        )
                    clean_cat = str(v).strip()
                    cat_counts[clean_cat] = cat_counts.get(clean_cat, 0) + 1

                if len(cat_counts) > self.category_max_cardinality:
                    raise ValueError(
                        f"Categorical column '{header}' has {len(cat_counts)} unique categories, "
                        f"which exceeds the maximum cardinality limit of {self.category_max_cardinality}."
                    )

                sorted_cats = sorted(cat_counts.keys(), key=lambda c: (-cat_counts[c], c))

                if not sorted_cats:
                    spec.reference_category = None
                    spec.categories = ["_missing_"]
                    spec.all_train_categories = []
                    spec.impute_value = "_missing_"
                    spec.has_missing_indicator = True
                    spec.missing_indicator_offset = 0
                    miss_feat = self._make_unique_feature_name(f"{header}=_missing_")
                    spec.missing_feature_name = miss_feat
                    spec.generated_features = [miss_feat]
                    self.generated_feature_names.append(miss_feat)
                    self.feature_to_source_map.append(col_idx)
                else:
                    spec.reference_category = sorted_cats[0]
                    active_cats = list(sorted_cats[1:])
                    spec.all_train_categories = list(sorted_cats)
                    spec.impute_value = spec.reference_category
                    spec.has_missing_indicator = True  # reserve missing indicator for unseen blanks/imputation

                    generated_for_col: list[str] = []
                    spec.cat_to_offset = {}
                    curr_offset = 0
                    for cat in active_cats:
                        spec.cat_to_offset[cat] = curr_offset
                        curr_offset += 1
                        feat_name = self._make_unique_feature_name(f"{header}={cat}")
                        generated_for_col.append(feat_name)
                        self.generated_feature_names.append(feat_name)
                        self.feature_to_source_map.append(col_idx)

                    if spec.has_missing_indicator:
                        spec.missing_indicator_offset = curr_offset
                        curr_offset += 1
                        # Candidate feature name for missingness
                        cand_miss = f"{header}=_missing_"
                        if cand_miss in self._all_feature_names_set:
                            cand_miss = f"{header}=<missing>"
                        feat_name = self._make_unique_feature_name(cand_miss)
                        spec.missing_feature_name = feat_name
                        generated_for_col.append(feat_name)
                        self.generated_feature_names.append(feat_name)
                        self.feature_to_source_map.append(col_idx)

                    if "_missing_" in active_cats or spec.reference_category == "_missing_":
                        spec.categories = list(active_cats)
                    else:
                        spec.categories = list(active_cats) + ["_missing_"]

                    spec.generated_features = generated_for_col

            self.column_specs.append(spec)

        if not self.generated_feature_names:
            raise ValueError("No usable features could be generated from the selected columns.")

        self.is_fitted = True
        return self

    def _transform_internal(
        self,
        raw_rows: list[list[Any]],
        start_row: int = 2,
        row_numbers: list[int] | None = None,
    ) -> tuple[np.ndarray, list[str]]:
        """Transform raw rows into matrix and compute request-local warnings without mutating fitted state."""
        if not self.is_fitted:
            raise ValueError("TablePreprocessorScratch must be fitted before calling transform.")

        num_rows = len(raw_rows)
        num_features = len(self.generated_feature_names)
        if num_rows == 0:
            return np.empty((0, num_features), dtype=float), []

        output = np.zeros((num_rows, num_features), dtype=float)
        unseen_categories: set[str] = set()
        imputed_cell_count = 0

        feat_idx = 0
        for spec in self.column_specs:
            col_idx = spec.source_index
            col_vals = [raw_rows[r][col_idx] if col_idx < len(raw_rows[r]) else None for r in range(num_rows)]

            if spec.col_type == "numeric":
                impute_val = float(spec.impute_value if spec.impute_value is not None else 0.0)
                for r in range(num_rows):
                    v = col_vals[r]
                    excel_row = row_numbers[r] if row_numbers is not None and r < len(row_numbers) else start_row + r
                    if is_missing(v):
                        output[r, feat_idx] = impute_val
                        imputed_cell_count += 1
                    else:
                        if is_invalid(v):
                            raise ValueError(
                                f"Column '{spec.source_header}' (row {excel_row}) contains invalid cell value: {repr(v)}"
                            )
                        pf = try_parse_float(v)
                        if pf is None:
                            raise ValueError(
                                f"Column '{spec.source_header}' (row {excel_row}) contains non-numeric value: {repr(v)}"
                            )
                        output[r, feat_idx] = pf
                feat_idx += 1

            elif spec.col_type == "boolean":
                impute_val = float(spec.impute_value if spec.impute_value is not None else 0.0)
                for r in range(num_rows):
                    v = col_vals[r]
                    excel_row = row_numbers[r] if row_numbers is not None and r < len(row_numbers) else start_row + r
                    if is_missing(v):
                        output[r, feat_idx] = impute_val
                        imputed_cell_count += 1
                    else:
                        if is_invalid(v):
                            raise ValueError(
                                f"Column '{spec.source_header}' (row {excel_row}) contains invalid cell value: {repr(v)}"
                            )
                        bf = to_boolean_float(v)
                        if bf is None:
                            raise ValueError(
                                f"Column '{spec.source_header}' (row {excel_row}) contains non-boolean value: {repr(v)}"
                            )
                        output[r, feat_idx] = bf
                feat_idx += 1

            elif spec.col_type == "categorical":
                k_cols = len(spec.generated_features)
                for r in range(num_rows):
                    v = col_vals[r]
                    excel_row = row_numbers[r] if row_numbers is not None and r < len(row_numbers) else start_row + r
                    if is_missing(v):
                        imputed_cell_count += 1
                        if spec.has_missing_indicator and spec.missing_indicator_offset is not None:
                            output[r, feat_idx + spec.missing_indicator_offset] = 1.0
                    else:
                        if is_invalid(v):
                            raise ValueError(
                                f"Column '{spec.source_header}' (row {excel_row}) contains invalid error/object cell: {repr(v)}"
                            )
                        raw_str = str(v).strip()
                        if raw_str == spec.reference_category:
                            # Reference level: all indicators 0
                            pass
                        elif raw_str in spec.cat_to_offset:
                            output[r, feat_idx + spec.cat_to_offset[raw_str]] = 1.0
                        else:
                            # Unseen category: all indicators 0 + warning
                            unseen_categories.add(f"{spec.source_header}='{raw_str}'")

                feat_idx += k_cols

        warnings: list[str] = []
        if unseen_categories:
            warnings.append(
                f"Observed {len(unseen_categories)} unseen categories in data: {', '.join(sorted(unseen_categories)[:5])}. "
                "These were mapped to baseline indicators."
            )

        return output, warnings

    def transform_with_warnings(
        self,
        raw_rows: list[list[Any]],
        start_row: int = 2,
        row_numbers: list[int] | None = None,
    ) -> tuple[np.ndarray, list[str]]:
        """Transform raw heterogeneous rows into float matrix and return request-local warnings (thread-safe)."""
        return self._transform_internal(raw_rows, start_row=start_row, row_numbers=row_numbers)

    def transform(
        self,
        raw_rows: list[list[Any]],
        start_row: int = 2,
        row_numbers: list[int] | None = None,
        return_warnings: bool = False,
    ) -> np.ndarray | tuple[np.ndarray, list[str]]:
        """Transform raw heterogeneous rows into a 2D float NumPy matrix using fitted parameters."""
        output, warnings = self._transform_internal(raw_rows, start_row=start_row, row_numbers=row_numbers)
        if not return_warnings:
            self.last_transform_warnings = list(warnings)
            return output
        return output, warnings

    def transform_single(self, raw_row: dict[str, Any] | list[Any]) -> tuple[np.ndarray, list[dict[str, Any]]]:
        """Transform a single raw row (dict of {header: val} or list) and return step-by-step breakdown."""
        # Convert to list ordered by selected_indices
        if isinstance(raw_row, dict):
            row_list = []
            max_idx = max(self.selected_indices) if self.selected_indices else 0
            row_list = [None] * (max_idx + 1)
            for idx in self.selected_indices:
                header = self.source_headers[idx] if idx < len(self.source_headers) else str(idx)
                if header in raw_row:
                    row_list[idx] = raw_row[header]
                elif str(idx) in raw_row:
                    row_list[idx] = raw_row[str(idx)]
        else:
            row_list = list(raw_row)

        mat, _ = self.transform_with_warnings([row_list], start_row=1)
        row_vec = mat[0]

        # Build explanation breakdown
        breakdown = []
        feat_idx = 0
        for spec in self.column_specs:
            col_idx = spec.source_index
            val = row_list[col_idx] if col_idx < len(row_list) else None

            if spec.col_type in ("numeric", "boolean"):
                breakdown.append({
                    "feature_name": spec.generated_features[0],
                    "source_header": spec.source_header,
                    "raw_input": val,
                    "imputed": is_missing(val),
                    "encoded_value": float(row_vec[feat_idx]),
                    "type": spec.col_type,
                    "reference": None,
                })
                feat_idx += 1
            elif spec.col_type == "categorical":
                val_miss = is_missing(val)
                for f_name in spec.generated_features:
                    breakdown.append({
                        "feature_name": f_name,
                        "source_header": spec.source_header,
                        "raw_input": val,
                        "imputed": val_miss,
                        "encoded_value": float(row_vec[feat_idx]),
                        "type": "categorical",
                        "reference": spec.reference_category,
                    })
                    feat_idx += 1

        return row_vec, breakdown

    def to_dict(self) -> dict[str, Any]:
        """Serialize fitted preprocessor for persistence and API reporting."""
        return {
            "selected_indices": self.selected_indices,
            "source_headers": self.source_headers,
            "column_types": self.column_types,
            "missing_policy": self.missing_policy,
            "impute_numeric": self.impute_numeric,
            "category_max_cardinality": self.category_max_cardinality,
            "generated_feature_names": self.generated_feature_names,
            "feature_to_source_map": self.feature_to_source_map,
            "column_specs": [spec.to_dict() for spec in self.column_specs],
            "is_fitted": self.is_fitted,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> TablePreprocessorScratch:
        prep = cls(
            selected_indices=data["selected_indices"],
            source_headers=data["source_headers"],
            column_types=data.get("column_types", {}),
            missing_policy=data.get("missing_policy", "impute"),
            impute_numeric=data.get("impute_numeric", "median"),
            category_max_cardinality=data.get("category_max_cardinality", 20),
        )
        prep.generated_feature_names = data.get("generated_feature_names", [])
        prep.feature_to_source_map = data.get("feature_to_source_map", [])
        prep.column_specs = [ColumnSpec.from_dict(d) for d in data.get("column_specs", [])]
        prep.is_fitted = data.get("is_fitted", False)
        return prep
