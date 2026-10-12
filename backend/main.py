"""FastAPI layer for the Excel logistic-regression service."""

from __future__ import annotations

import math
from typing import Literal

import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from model import DEFAULT_THRESHOLD, TrainedModel, train_logistic


app = FastAPI(title="Excel Logistic Regression Service", version="0.2.0")

# The configurable add-in can run locally or from a hosted task pane. Restrict
# this list to the hosted add-in URL before deploying to users who handle data
# you do not control.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# This is intentionally single-user prototype storage. A restart clears it and
# a new /train request replaces it; model_id prevents accidental reuse.
_LAST_MODEL: dict[str, TrainedModel | None] = {"model": None}


class TrainRequest(BaseModel):
    features: list[list[float]] = Field(..., description="Rows of numeric feature values (X).")
    labels: list = Field(..., description="Exactly two outcome classes (Y).")
    feature_names: list[str] | None = None
    standardize: bool = True
    test_size: float = Field(0.3, ge=0, lt=0.9)
    C: float = Field(1.0, gt=0, le=1_000_000, description="Inverse L2 strength; smaller means stronger regularisation.")
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
            C=req.C,
            class_weight=req.class_weight,
            cv_folds=req.cv_folds,
            random_state=req.random_state,
        )
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
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

    probabilities = model.predict_proba(X)
    if not np.isfinite(probabilities).all():
        raise HTTPException(status_code=500, detail="The model returned an invalid probability.")
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
                "prob": float(probability),
                "pred": int(probability >= req.threshold),
            }
            for probability in probabilities
        ],
    }
