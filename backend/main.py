"""FastAPI layer for the Excel logistic regression service from scratch."""

from __future__ import annotations

import json
import math
from typing import Literal

import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from model import DEFAULT_THRESHOLD, TrainedModel, train_logistic, train_table_logistic
from table_schema import (
    TablePredictRequest,
    TableProfileRequest,
    TableProfileResponse,
    TableTrainRequest,
    profile_table,
)


app = FastAPI(
    title="Excel Logistic Regression Service (Scratch Engine)",
    version="0.3.0",
)

# CORS middleware for the local or hosted Office.js task pane
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Single-user in-memory model storage
_LAST_MODEL: dict[str, TrainedModel | None] = {"model": None}


class TrainRequest(BaseModel):
    features: list[list[float]] = Field(..., description="Rows of numeric feature values (X).")
    labels: list = Field(..., description="Exactly two outcome classes (Y).")
    feature_names: list[str] | None = None
    standardize: bool = True
    test_size: float = Field(0.3, ge=0.05, le=0.80, description="Test split fraction (0.05 to 0.80).")
    learning_rate: float = Field(0.1, gt=0, le=10.0, description="Gradient descent learning rate alpha.")
    max_iterations: int = Field(10000, ge=10, le=100000, description="Maximum iterations cap.")
    tolerance: float = Field(1e-6, gt=0, le=1e-2, description="Gradient norm convergence tolerance.")
    l2_lambda: float = Field(0.0, ge=0.0, le=10000.0, description="L2 regularization strength lambda.")
    class_weight: Literal["balanced"] | None = None
    cv_folds: int = Field(0, ge=0, le=20, description="0 disables CV; otherwise use at least 3.")
    random_state: int = Field(42, ge=0)


class PredictRequest(BaseModel):
    model_id: str = Field(..., min_length=1, description="ID returned by the active /train result.")
    features: list[list[float]] = Field(..., description="Rows to score in the trained feature order.")
    threshold: float = Field(DEFAULT_THRESHOLD, ge=0, le=1)


@app.get("/health")
def health():
    model = _LAST_MODEL["model"]
    return {
        "status": "ok",
        "engine": "scratch",
        "has_model": model is not None,
        "model_id": model.model_id if model is not None else None,
    }


@app.post("/train")
def train(req: TrainRequest):
    try:
        result, model = train_logistic(
            features=req.features,
            labels=req.labels,
            feature_names=req.feature_names,
            standardize=req.standardize,
            test_size=req.test_size,
            learning_rate=req.learning_rate,
            max_iterations=req.max_iterations,
            tolerance=req.tolerance,
            l2_lambda=req.l2_lambda,
            class_weight=req.class_weight,
            cv_folds=req.cv_folds,
            random_state=req.random_state,
        )
        # Ensure result contains only finite values and is valid JSON before activating model
        json.dumps(result, allow_nan=False)
    except (TypeError, ValueError, OverflowError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Training failed: {exc}") from exc

    _LAST_MODEL["model"] = model
    return result


@app.post("/predict")
def predict(req: PredictRequest):
    model = _LAST_MODEL["model"]
    if model is None:
        raise HTTPException(status_code=400, detail="Train a model first, then predict.")
    if req.model_id != model.model_id:
        raise HTTPException(
            status_code=409,
            detail="This model is no longer active. Train again before predicting.",
        )

    try:
        X = np.asarray(req.features, dtype=float)
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail="Prediction features must be numeric.") from exc
    if X.ndim != 2 or X.shape[0] == 0 or X.shape[1] != len(model.feature_names):
        raise HTTPException(
            status_code=400,
            detail=f"Each prediction row must have exactly {len(model.feature_names)} feature values.",
        )
    if not np.isfinite(X).all():
        raise HTTPException(status_code=400, detail="Prediction features must be finite numbers.")

    scores, probabilities = model.predict_score_and_proba(X)
    if not np.isfinite(scores).all() or not np.isfinite(probabilities).all():
        raise HTTPException(status_code=500, detail="The model returned an invalid score or probability.")
    return {
        "ok": True,
        "model_id": model.model_id,
        "feature_names": model.feature_names,
        "threshold": req.threshold,
        "class_labels": {
            "negative": str(model.class_labels[0]),
            "positive": str(model.class_labels[1]),
        },
        "results": [
            {
                "score": float(score),
                "prob": float(probability),
                "pred": int(probability >= req.threshold),
            }
            for score, probability in zip(scores, probabilities)
        ],
    }


@app.post("/profile-table", response_model=TableProfileResponse)
def api_profile_table(req: TableProfileRequest):
    try:
        response = profile_table(
            headers=req.headers,
            rows=req.rows,
            table_range=req.table_range,
            worksheet_name=req.worksheet_name,
            start_row=req.start_row,
            start_col=req.start_col,
        )
        json.dumps(response.model_dump() if hasattr(response, "model_dump") else response.dict(), allow_nan=False)
        return response
    except (TypeError, ValueError, OverflowError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Table profiling failed: {exc}") from exc


@app.post("/train-table")
def api_train_table(req: TableTrainRequest):
    try:
        result, model = train_table_logistic(
            headers=req.headers,
            rows=req.rows,
            y_column=req.y_column,
            selected_x_columns=req.selected_x_columns,
            column_types=req.column_types,
            missing_policy=req.missing_policy,
            impute_numeric=req.impute_numeric,
            category_max_cardinality=req.category_max_cardinality,
            standardize=req.standardize,
            test_size=req.test_size,
            learning_rate=req.learning_rate,
            max_iterations=req.max_iterations,
            tolerance=req.tolerance,
            l2_lambda=req.l2_lambda,
            class_weight=req.class_weight,
            cv_folds=req.cv_folds,
            random_state=req.random_state,
            start_row=req.start_row,
            start_col=req.start_col,
        )
        json.dumps(result, allow_nan=False)
    except (TypeError, ValueError, OverflowError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Table training failed: {exc}") from exc

    _LAST_MODEL["model"] = model
    return result


@app.post("/predict-table")
def api_predict_table(req: TablePredictRequest):
    model = _LAST_MODEL["model"]
    if model is None:
        raise HTTPException(status_code=400, detail="Train a model first, then predict.")
    if req.model_id != model.model_id:
        raise HTTPException(
            status_code=409,
            detail="This model is no longer active. Train again before predicting.",
        )
    if model.table_preprocessor is None:
        raise HTTPException(
            status_code=400,
            detail="Active model was trained in numeric mode and does not support raw table prediction.",
        )

    try:
        scores, probabilities, warnings = model.predict_raw_table(req.headers, req.rows, start_row=req.start_row)
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Table prediction failed: {exc}") from exc

    if not np.isfinite(scores).all() or not np.isfinite(probabilities).all():
        raise HTTPException(status_code=500, detail="The model returned an invalid score or probability.")

    return {
        "ok": True,
        "model_id": model.model_id,
        "threshold": req.threshold,
        "warnings": warnings,
        "class_labels": {
            "negative": str(model.class_labels[0]),
            "positive": str(model.class_labels[1]),
        },
        "results": [
            {
                "score": float(score),
                "prob": float(probability),
                "pred": int(probability >= req.threshold),
            }
            for score, probability in zip(scores, probabilities)
        ],
    }

