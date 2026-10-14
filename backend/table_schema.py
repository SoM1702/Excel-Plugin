"""Table mode schema definitions and profile analysis for general Excel tabular data."""

from __future__ import annotations

import math
import re
from typing import Any, Literal
from pydantic import BaseModel, Field


def is_missing(val: Any) -> bool:
    """Check if a cell value represents missing data (null, empty, or whitespace-only)."""
    if val is None:
        return True
    if isinstance(val, str) and not val.strip():
        return True
    if isinstance(val, (float, int)) and not isinstance(val, bool):
        if math.isnan(val):
            return True
    return False


def is_invalid(val: Any) -> bool:
    """Check if a cell value is an error, non-scalar, or non-finite number."""
    if val is None:
        return False
    if isinstance(val, (list, dict, set, tuple)):
        return True
    if isinstance(val, (float, int)) and not isinstance(val, bool):
        if math.isinf(val):
            return True
    if isinstance(val, str):
        v_upper = val.strip().upper()
        if v_upper.startswith("#") and any(
            err in v_upper for err in ["#NULL!", "#DIV/0!", "#VALUE!", "#REF!", "#NAME?", "#NUM!", "#N/A", "#ERROR!"]
        ):
            return True
    return False


def try_parse_float(val: Any) -> float | None:
    """Attempt to parse a cell value as float. Returns None if not numeric."""
    if val is None or isinstance(val, bool):
        return None
    if isinstance(val, (int, float)):
        f = float(val)
        return f if math.isfinite(f) else None
    if isinstance(val, str):
        s = val.strip()
        # Clean currency symbols or trailing percent if simple
        s_clean = s.lstrip("$€£¥").rstrip("%").strip()
        try:
            f = float(s_clean)
            return f if math.isfinite(f) else None
        except (ValueError, TypeError):
            return None
    return None


def is_boolean_value(val: Any) -> bool:
    """Check if value is a genuine boolean or standard boolean string."""
    if isinstance(val, bool):
        return True
    if isinstance(val, str):
        return val.strip().lower() in ("true", "false", "yes", "no")
    return False


def to_boolean_float(val: Any) -> float | None:
    """Convert a boolean-like cell to 1.0 or 0.0."""
    if isinstance(val, bool):
        return 1.0 if val else 0.0
    if isinstance(val, str):
        s = val.strip().lower()
        if s in ("true", "yes", "1"):
            return 1.0
        if s in ("false", "no", "0"):
            return 0.0
    if isinstance(val, (int, float)):
        if val == 1:
            return 1.0
        if val == 0:
            return 0.0
    return None


def col_index_to_letter(col_idx: int) -> str:
    """Convert a 0-indexed column integer to an Excel column letter (0 -> A, 27 -> AB)."""
    result = ""
    col_idx += 1
    while col_idx > 0:
        col_idx, remainder = divmod(col_idx - 1, 26)
        result = chr(65 + remainder) + result
    return result


class ColumnProfile(BaseModel):
    index: int = Field(..., description="0-indexed source column position in selected table rectangle.")
    excel_col: str = Field(..., description="Excel column letter (e.g. A, B, C).")
    header: str = Field(..., description="Header text.")
    detected_type: Literal["numeric", "categorical", "boolean", "date", "unsupported"] = "numeric"
    missing_count: int = 0
    invalid_count: int = 0
    distinct_count: int = 0
    sample_values: list[Any] = Field(default_factory=list)
    is_constant: bool = False
    is_identifier: bool = False
    is_leakage_candidate: bool = False
    leakage_reason: str | None = None
    suggested_use: Literal["x", "y", "exclude"] = "x"
    cardinality_warning: bool = False
    unique_values: list[str] = Field(default_factory=list)


class TableProfileResponse(BaseModel):
    ok: bool = True
    total_rows: int
    total_columns: int
    table_range: str | None = None
    worksheet_name: str | None = None
    columns: list[ColumnProfile]
    suggested_y: str | None = None
    suggested_x: list[int] = Field(default_factory=list)
    usable_rows: int
    warnings: list[str] = Field(default_factory=list)


class TableProfileRequest(BaseModel):
    headers: list[str] = Field(..., description="Table header names.")
    rows: list[list[Any]] = Field(..., description="Raw cell data rows.")
    table_range: str | None = None
    worksheet_name: str | None = None
    start_row: int = Field(1, ge=1, description="1-based starting row of table rectangle (header row).")
    start_col: int = Field(1, ge=1, description="1-based starting column of table rectangle (1 = A).")


class TableTrainRequest(BaseModel):
    headers: list[str] = Field(..., description="Raw table headers.")
    rows: list[list[Any]] = Field(..., description="Raw data rows (excluding header).")
    y_column: str | int = Field(..., description="Outcome column header name or 0-indexed column index.")
    selected_x_columns: list[int] = Field(
        ...,
        min_length=1,
        description="Ordered list of individually selected source-column indices (e.g. [1, 2, 3, 7, 8]).",
    )
    start_row: int = Field(1, ge=1, description="1-based starting row of table rectangle (header row).")
    start_col: int = Field(1, ge=1, description="1-based starting column of table rectangle (1 = A).")
    column_types: dict[str, str] | None = Field(
        default=None,
        description="Optional type overrides per column name ('numeric', 'categorical', 'boolean').",
    )
    missing_policy: Literal["impute", "drop_rows"] = Field(
        default="impute",
        description="Impute missing values using train medians/categories or drop rows with missing values.",
    )
    impute_numeric: Literal["median", "mean"] = "median"
    category_max_cardinality: int = Field(20, ge=2, le=100)
    standardize: bool = True
    test_size: float = Field(0.3, ge=0.05, le=0.80)
    learning_rate: float = Field(0.1, gt=0, le=10.0)
    max_iterations: int = Field(10000, ge=10, le=100000)
    tolerance: float = Field(1e-6, gt=0, le=1e-2)
    l2_lambda: float = Field(0.0, ge=0.0, le=10000.0)
    class_weight: Literal["balanced"] | None = None
    cv_folds: int = Field(0, ge=0, le=20)
    random_state: int = Field(42, ge=0)


class TablePredictRequest(BaseModel):
    model_id: str = Field(..., min_length=1)
    headers: list[str] = Field(..., description="Headers of the new scoring table.")
    rows: list[list[Any]] = Field(..., description="Raw rows to score.")
    threshold: float = Field(0.5, ge=0.0, le=1.0)
    start_row: int = Field(2, ge=1, description="1-based starting row of data rows in scoring sheet.")
    start_col: int = Field(1, ge=1, description="1-based starting column of scoring table.")


def profile_table(
    headers: list[str],
    rows: list[list[Any]],
    table_range: str | None = None,
    worksheet_name: str | None = None,
    start_row: int = 1,
    start_col: int = 1,
    start_col_idx: int | None = None,
) -> TableProfileResponse:
    """Profile an Excel table range to detect types, missing counts, leakage, and suggestions."""
    total_rows = len(rows)
    total_cols = len(headers)
    if total_rows == 0:
        raise ValueError("The table contains no data rows.")
    if total_cols == 0:
        raise ValueError("The table contains no columns.")

    effective_start_col_idx = start_col_idx if start_col_idx is not None else max(0, start_col - 1)
    start_col_idx = effective_start_col_idx

    col_profiles: list[ColumnProfile] = []
    warnings: list[str] = []

    # Check for duplicate headers
    seen_headers: dict[str, int] = {}
    for i, h in enumerate(headers):
        clean_h = str(h).strip() if h is not None else ""
        if not clean_h:
            clean_h = f"Column_{col_index_to_letter(start_col_idx + i)}"
            warnings.append(f"Column {col_index_to_letter(start_col_idx + i)} has a blank header; named as '{clean_h}'.")
        seen_headers[clean_h] = seen_headers.get(clean_h, 0) + 1

    for h, count in seen_headers.items():
        if count > 1:
            warnings.append(f"Header '{h}' is duplicated {count} times across the table.")

    # Profile each column individually
    candidate_y_idx: int | None = None
    highest_y_score = -1.0

    target_name_tokens = ("survived", "churn", "target", "outcome", "label", "default", "class", "status", "y")

    for c_idx in range(total_cols):
        raw_header = str(headers[c_idx]).strip() if headers[c_idx] is not None else ""
        col_letter = col_index_to_letter(start_col_idx + c_idx)
        display_header = raw_header if raw_header else f"Column_{col_letter}"

        col_values = [rows[r_idx][c_idx] if c_idx < len(rows[r_idx]) else None for r_idx in range(total_rows)]

        missing_count = 0
        invalid_count = 0
        non_missing_values: list[Any] = []
        numeric_count = 0
        boolean_count = 0

        for val in col_values:
            if is_missing(val):
                missing_count += 1
            elif is_invalid(val):
                invalid_count += 1
            else:
                non_missing_values.append(val)
                if isinstance(val, bool) or (isinstance(val, str) and val.strip().lower() in ("true", "false", "yes", "no")):
                    boolean_count += 1
                if try_parse_float(val) is not None and not isinstance(val, bool):
                    numeric_count += 1

        distinct_vals = list(dict.fromkeys(non_missing_values))
        distinct_count = len(distinct_vals)

        # Detect type
        detected_type: Literal["numeric", "categorical", "boolean", "date", "unsupported"] = "categorical"
        valid_count = len(non_missing_values)

        if invalid_count > 0 and valid_count == 0:
            detected_type = "unsupported"
        elif valid_count == 0:
            detected_type = "numeric"
        elif boolean_count == valid_count and distinct_count <= 2:
            detected_type = "boolean"
        elif numeric_count == valid_count:
            detected_type = "numeric"
        else:
            detected_type = "categorical"

        # Safe sample values (up to 5)
        samples = [str(v) if v is not None else "" for v in distinct_vals[:5]]

        is_const = distinct_count <= 1 and valid_count > 0
        # Identifier heuristic: distinct count >= 90% of rows and header has ID/key or values are strings/ints
        h_lower = display_header.lower()
        is_id = False
        if total_rows >= 10 and distinct_count >= int(total_rows * 0.95):
            if any(token in h_lower for token in ("id", "code", "key", "number", "uuid", "passenger")):
                is_id = True

        cardinality_warn = (detected_type == "categorical" and distinct_count > 20)

        # Suggested Y scoring
        y_score = 0.0
        if distinct_count == 2 and not is_const and missing_count < total_rows * 0.5:
            # High potential Y
            y_score += 10.0
            for token in target_name_tokens:
                if token in h_lower:
                    y_score += 15.0
                    break
            if detected_type == "boolean":
                y_score += 5.0
            if y_score > highest_y_score:
                highest_y_score = y_score
                candidate_y_idx = c_idx

        col_profiles.append(
            ColumnProfile(
                index=c_idx,
                excel_col=col_letter,
                header=display_header,
                detected_type=detected_type,
                missing_count=missing_count,
                invalid_count=invalid_count,
                distinct_count=distinct_count,
                sample_values=samples,
                is_constant=is_const,
                is_identifier=is_id,
                cardinality_warning=cardinality_warn,
                unique_values=[str(v) for v in distinct_vals[:20]],
            )
        )

    # Detect outcome leakage against suggested Y
    suggested_y_name = None
    if candidate_y_idx is not None:
        y_profile = col_profiles[candidate_y_idx]
        y_profile.suggested_use = "y"
        suggested_y_name = y_profile.header
        y_vals = [rows[r_idx][candidate_y_idx] if candidate_y_idx < len(rows[r_idx]) else None for r_idx in range(total_rows)]

        # Check other columns for correlation / leakage with Y
        for c_idx, prof in enumerate(col_profiles):
            if c_idx == candidate_y_idx:
                continue
            # Name-based leakage token check (e.g. survived vs alive)
            h_lower = prof.header.lower()
            leakage_detected = False
            leakage_reason = None

            if "alive" in h_lower and "surviv" in y_profile.header.lower():
                leakage_detected = True
                leakage_reason = f"Header '{prof.header}' indicates outcome leakage for '{y_profile.header}'."
            elif h_lower == y_profile.header.lower():
                leakage_detected = True
                leakage_reason = f"Duplicate of outcome column '{y_profile.header}'."

            # Exact or near 1-to-1 matching values check
            if not leakage_detected and prof.distinct_count == 2 and y_profile.distinct_count == 2:
                # Compare non-missing pairs
                pairs = [
                    (rows[r][c_idx], y_vals[r])
                    for r in range(total_rows)
                    if not is_missing(rows[r][c_idx]) and not is_missing(y_vals[r])
                ]
                if len(pairs) >= 10:
                    x_to_y: dict[Any, set] = {}
                    for x_v, y_v in pairs:
                        x_to_y.setdefault(str(x_v).strip().lower(), set()).add(str(y_v).strip().lower())
                    # If each category maps to exactly 1 outcome class, it is a perfect duplicate
                    if all(len(s) == 1 for s in x_to_y.values()) and len(x_to_y) == 2:
                        leakage_detected = True
                        leakage_reason = f"Values in '{prof.header}' correlate 100% with '{y_profile.header}' (direct target leakage)."

            if leakage_detected:
                prof.is_leakage_candidate = True
                prof.leakage_reason = leakage_reason
                prof.suggested_use = "exclude"
            elif prof.is_constant or prof.is_identifier or prof.detected_type == "unsupported":
                prof.suggested_use = "exclude"
            else:
                prof.suggested_use = "x"

    suggested_x = [p.index for p in col_profiles if p.suggested_use == "x"]

    # Compute usable rows (rows with non-missing suggested Y)
    usable_rows = total_rows
    if candidate_y_idx is not None:
        usable_rows = total_rows - col_profiles[candidate_y_idx].missing_count

    return TableProfileResponse(
        ok=True,
        total_rows=total_rows,
        total_columns=total_cols,
        table_range=table_range,
        worksheet_name=worksheet_name,
        columns=col_profiles,
        suggested_y=suggested_y_name,
        suggested_x=suggested_x,
        usable_rows=usable_rows,
        warnings=warnings,
    )
