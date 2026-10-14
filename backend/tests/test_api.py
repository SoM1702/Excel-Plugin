"""Unit tests for FastAPI endpoints, request schemas, and model ID handling."""

from __future__ import annotations

import unittest
from pathlib import Path

from fastapi import HTTPException
from pydantic import ValidationError

import asyncio
import json
import math

import numpy as np

from main import PredictRequest, TrainRequest, _LAST_MODEL, app, health, predict, train



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


async def asgi_call(method: str, path: str, body: dict | None = None) -> tuple[int, dict | None]:
    """Execute real HTTP routing and JSON serialization through ASGI."""
    body_bytes = json.dumps(body).encode() if body is not None else b""
    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": method,
        "path": path,
        "raw_path": path.encode(),
        "query_string": b"",
        "headers": [(b"content-type", b"application/json")] if body is not None else [],
        "client": ("127.0.0.1", 12345),
        "server": ("127.0.0.1", 8000),
        "scheme": "http",
    }
    sent = False

    async def receive():
        nonlocal sent
        if not sent:
            sent = True
            return {"type": "http.request", "body": body_bytes, "more_body": False}
        return {"type": "http.request", "body": b"", "more_body": False}

    response_status = None
    response_body = []

    async def send(message):
        nonlocal response_status, response_body
        if message["type"] == "http.response.start":
            response_status = message["status"]
        elif message["type"] == "http.response.body":
            response_body.append(message.get("body", b""))

    await app(scope, receive, send)
    resp_text = b"".join(response_body).decode()
    return response_status, json.loads(resp_text) if resp_text else None


class ApiTests(unittest.TestCase):
    def setUp(self):
        _LAST_MODEL["model"] = None
        self.feature_names, self.features, self.labels = load_sample()

    def test_health_endpoint(self):
        res = health()
        self.assertEqual(res["status"], "ok")
        self.assertEqual(res["engine"], "scratch")
        self.assertFalse(res["has_model"])
        self.assertIsNone(res["model_id"])

    def test_prediction_uses_model_id_and_requested_threshold(self):
        trained = train(
            TrainRequest(
                features=self.features,
                labels=self.labels,
                feature_names=self.feature_names,
                learning_rate=0.1,
                max_iterations=1000,
                l2_lambda=0.01,
            )
        )
        model_id = trained["model_id"]
        self.assertTrue(health()["has_model"])

        response = predict(
            PredictRequest(
                model_id=model_id,
                features=[self.features[0]],
                threshold=0.0,
            )
        )
        self.assertEqual(response["results"][0]["pred"], 1)

        # Stale model ID rejected with 409
        with self.assertRaises(HTTPException) as stale:
            predict(PredictRequest(model_id="old-model-id", features=[self.features[0]], threshold=0.5))
        self.assertEqual(stale.exception.status_code, 409)

    def test_predict_without_training_rejected(self):
        with self.assertRaises(HTTPException) as err:
            predict(PredictRequest(model_id="any-id", features=[self.features[0]], threshold=0.5))
        self.assertEqual(err.exception.status_code, 400)

    def test_api_rejects_invalid_test_size_before_training(self):
        with self.assertRaises(ValidationError):
            TrainRequest(
                features=self.features[:20],
                labels=self.labels[:20],
                test_size=0.01,
            )

    def test_api_rejects_invalid_learning_rate(self):
        with self.assertRaises(ValidationError):
            TrainRequest(
                features=self.features[:20],
                labels=self.labels[:20],
                learning_rate=-0.5,
            )

    def test_api_rejects_negative_l2_lambda(self):
        with self.assertRaises(ValidationError):
            TrainRequest(
                features=self.features[:20],
                labels=self.labels[:20],
                l2_lambda=-1.0,
            )

    def test_http_asgi_health_endpoint(self):
        status, data = asyncio.run(asgi_call("GET", "/health"))
        self.assertEqual(status, 200)
        self.assertEqual(data["status"], "ok")
        self.assertFalse(data["has_model"])

    def test_http_asgi_validation_error_returns_422(self):
        status, data = asyncio.run(asgi_call("POST", "/train", {"features": "not-a-list"}))
        self.assertEqual(status, 422)
        self.assertIn("detail", data)

    def test_http_asgi_numerical_failure_rejects_without_activating_model(self):
        payload = {
            "features": [[1e308, 1e308] for _ in range(10)],
            "labels": [0, 0, 0, 0, 0, 1, 1, 1, 1, 1],
            "standardize": True,
        }
        payload["features"][0][0] = 0.5e308
        status, data = asyncio.run(asgi_call("POST", "/train", payload))
        self.assertEqual(status, 400)
        self.assertIn("detail", data)
        self.assertIsNone(_LAST_MODEL["model"])

    def test_http_asgi_train_and_predict_flow_with_full_precision(self):
        train_payload = {
            "features": self.features[:50],
            "labels": self.labels[:50],
            "feature_names": self.feature_names,
            "max_iterations": 200,
        }
        status, train_res = asyncio.run(asgi_call("POST", "/train", train_payload))
        self.assertEqual(status, 200)
        self.assertTrue(train_res["ok"])
        model_id = train_res["model_id"]
        self.assertIsNotNone(_LAST_MODEL["model"])

        # Test predict with 1-row batch
        predict_payload = {
            "model_id": model_id,
            "features": [self.features[0]],
            "threshold": 0.5,
        }
        status, pred_res = asyncio.run(asgi_call("POST", "/predict", predict_payload))
        self.assertEqual(status, 200)
        self.assertEqual(len(pred_res["results"]), 1)
        res_item = pred_res["results"][0]
        self.assertIn("score", res_item)
        self.assertIn("prob", res_item)
        self.assertIn("pred", res_item)
        score = res_item["score"]
        prob = res_item["prob"]
        self.assertIsInstance(score, float)
        self.assertIsInstance(prob, float)
        self.assertTrue(0.0 <= prob <= 1.0)
        # Verify sigmoid relation: prob == 1 / (1 + exp(-score))
        expected_prob = 1.0 / (1.0 + math.exp(-score))
        self.assertAlmostEqual(prob, expected_prob, places=9)

    def test_predict_score_agrees_with_exported_parameters(self):
        trained = train(
            TrainRequest(
                features=self.features[:50],
                labels=self.labels[:50],
                feature_names=self.feature_names,
                max_iterations=100,
            )
        )
        params = trained["parameters"]
        model_id = trained["model_id"]

        test_row = self.features[0]
        pred_res = predict(
            PredictRequest(
                model_id=model_id,
                features=[test_row],
                threshold=0.5,
            )
        )
        item = pred_res["results"][0]
        returned_score = item["score"]

        # Calculate score using exported original-unit parameters
        w_orig = np.array(params["weights_original_units"])
        b_orig = params["intercept_original_units"]
        manual_score = float(np.dot(test_row, w_orig) + b_orig)

        self.assertAlmostEqual(returned_score, manual_score, places=8)

    def test_extreme_feature_scores_do_not_produce_nan_or_overflow(self):
        trained = train(
            TrainRequest(
                features=self.features[:50],
                labels=self.labels[:50],
                feature_names=self.feature_names,
                max_iterations=50,
            )
        )
        model_id = trained["model_id"]
        # Very large positive and negative feature rows
        extreme_pos = [1e6] * len(self.feature_names)
        extreme_neg = [-1e6] * len(self.feature_names)
        pred_res = predict(
            PredictRequest(
                model_id=model_id,
                features=[extreme_pos, extreme_neg],
                threshold=0.5,
            )
        )
        for row in pred_res["results"]:
            self.assertTrue(math.isfinite(row["score"]))
            self.assertTrue(math.isfinite(row["prob"]))
            self.assertTrue(0.0 <= row["prob"] <= 1.0)
            self.assertIn(row["pred"], (0, 1))

    def test_http_asgi_zero_gradient_train_and_predict(self):
        # 20 samples, 1 feature. Training partition class-conditional sums are 0, yielding zero gradient.
        y = [0] * 10 + [1] * 10
        X = [[0.0]] * 20
        # Class 0: indices 0..3 are -1.0, 4, 7, 8, 9 are 1.0; 5 is -1.0, 6 is 1.0
        # Class 1: indices 10..13 are -1.0, 15, 16, 17, 19 are 1.0; 14 is -1.0, 18 is 1.0
        for i in [0, 1, 2, 3, 5, 10, 11, 12, 13, 14]:
            X[i] = [-1.0]
        for i in [4, 6, 7, 8, 9, 15, 16, 17, 18, 19]:
            X[i] = [1.0]

        train_payload = {
            "features": X,
            "labels": y,
            "feature_names": ["feat1"],
            "test_size": 0.2,
            "random_state": 42,
            "l2_lambda": 0.0,
            "standardize": True,
        }

        status, train_res = asyncio.run(asgi_call("POST", "/train", train_payload))
        self.assertEqual(status, 200)
        self.assertTrue(train_res["ok"])
        model_id = train_res["model_id"]
        self.assertEqual(train_res["diagnostics"]["iterations"], 0)
        self.assertTrue(train_res["diagnostics"]["converged"])
        self.assertAlmostEqual(train_res["diagnostics"]["gradient_norm"], 0.0)

        # Health endpoint should confirm active model
        status, health_res = asyncio.run(asgi_call("GET", "/health"))
        self.assertEqual(status, 200)
        self.assertTrue(health_res["has_model"])
        self.assertEqual(health_res["model_id"], model_id)

        # Prediction endpoint should return valid predictions
        predict_payload = {
            "model_id": model_id,
            "features": [[-2.0], [0.0], [2.0]],
            "threshold": 0.5,
        }
        status, pred_res = asyncio.run(asgi_call("POST", "/predict", predict_payload))
        self.assertEqual(status, 200)
        self.assertEqual(len(pred_res["results"]), 3)
        for row in pred_res["results"]:
            self.assertAlmostEqual(row["score"], 0.0, places=7)
            self.assertAlmostEqual(row["prob"], 0.5, places=7)
            self.assertEqual(row["pred"], 1)

    def test_http_asgi_non_finite_result_rejects_without_activating_model(self):
        from unittest.mock import patch
        import main

        # First train a valid model to activate it
        train_payload = {
            "features": self.features[:20],
            "labels": self.labels[:20],
            "feature_names": self.feature_names,
            "max_iterations": 50,
        }
        status, initial_res = asyncio.run(asgi_call("POST", "/train", train_payload))
        self.assertEqual(status, 200)
        initial_model = main._LAST_MODEL["model"]
        self.assertIsNotNone(initial_model)

        # Inject a non-finite float (NaN) in the result returned by train_logistic
        real_train = main.train_logistic
        def mock_train_logistic(*args, **kwargs):
            res, m = real_train(*args, **kwargs)
            res["metrics"]["accuracy"] = float("nan")
            return res, m

        with patch("main.train_logistic", side_effect=mock_train_logistic):
            status, err_res = asyncio.run(asgi_call("POST", "/train", train_payload))
            self.assertEqual(status, 400)
            # The prior model must NOT have been replaced
            self.assertIs(main._LAST_MODEL["model"], initial_model)


if __name__ == "__main__":
    unittest.main()

