from __future__ import annotations

import json
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException
from pydantic import ValidationError

from main import PredictRequest, TrainRequest, _LAST_MODEL, predict, train
import model as engine
from model import train_logistic


def load_sample():
    rows = Path(__file__).parent.parent.joinpath("sample_data.csv").read_text().splitlines()
    header = rows[0].split(",")
    data = [[float(value) for value in row.split(",")] for row in rows[1:] if row]
    return header[:-1], [row[:-1] for row in data], [int(row[-1]) for row in data]


class ModelTests(unittest.TestCase):
    def setUp(self):
        self.feature_names, self.features, self.labels = load_sample()

    def test_sample_result_is_json_safe_and_has_reproducible_shape(self):
        result, model = train_logistic(
            self.features,
            self.labels,
            feature_names=self.feature_names,
            cv_folds=5,
        )

        json.dumps(result, allow_nan=False)
        self.assertEqual(result["n_samples"], 400)
        self.assertEqual(result["n_features"], 9)
        self.assertEqual(len(result["predictions"]["prob"]), 400)
        self.assertEqual(result["model_id"], model.model_id)
        self.assertEqual(result["evaluation"]["mode"], "held-out test")
        self.assertEqual(result["threshold"]["source"], "training_cross_validation")
        self.assertTrue(result["cross_validation"]["available"])
        self.assertGreaterEqual(result["threshold"]["value"], 0.05)
        self.assertLessEqual(result["threshold"]["value"], 0.95)

    def test_rare_class_cross_validation_is_explained_without_nan(self):
        features = [[float(index), float(index % 3)] for index in range(40)]
        labels = [0] * 38 + [1] * 2
        result, _ = train_logistic(features, labels, cv_folds=5)

        json.dumps(result, allow_nan=False)
        self.assertFalse(result["cross_validation"]["available"])
        self.assertIsNone(result["cross_validation"]["actual_folds"])
        self.assertEqual(result["threshold"]["value"], 0.5)

    def test_requested_held_out_split_is_not_silently_replaced_by_training_scores(self):
        features = [[float(index), float(index % 5)] for index in range(15)]
        labels = [0, 1] * 7 + [0]
        result, _ = train_logistic(features, labels, test_size=0.3)

        self.assertEqual(result["evaluation"]["mode"], "held-out test")
        self.assertEqual(result["evaluation"]["n_test"], 5)

    def test_invalid_split_is_rejected(self):
        features = [[float(index), float(index % 5)] for index in range(40)]
        labels = [0, 1] * 20
        with self.assertRaisesRegex(ValueError, "Test split"):
            train_logistic(features, labels, test_size=-0.1)

    def test_threshold_selector_receives_training_side_cv_predictions_only(self):
        with patch("model._best_f1_threshold", wraps=engine._best_f1_threshold) as selector:
            result, _ = train_logistic(
                self.features,
                self.labels,
                feature_names=self.feature_names,
                cv_folds=5,
            )

        labels_seen_by_selector = selector.call_args.args[0]
        self.assertEqual(len(labels_seen_by_selector), result["evaluation"]["n_train"])
        self.assertNotEqual(len(labels_seen_by_selector), result["evaluation"]["n_test"])


class ApiTests(unittest.TestCase):
    def setUp(self):
        _LAST_MODEL["model"] = None
        self.feature_names, self.features, self.labels = load_sample()

    def test_prediction_uses_model_id_and_requested_threshold(self):
        trained = train(
            TrainRequest(
                features=self.features,
                labels=self.labels,
                feature_names=self.feature_names,
            )
        )
        model_id = trained["model_id"]

        response = predict(
            PredictRequest(
                model_id=model_id,
                features=[self.features[0]],
                threshold=0.0,
            )
        )
        self.assertEqual(response["results"][0]["pred"], 1)

        with self.assertRaises(HTTPException) as stale:
            predict(PredictRequest(model_id="old-model", features=[self.features[0]], threshold=0.5))
        self.assertEqual(stale.exception.status_code, 409)

    def test_api_rejects_invalid_option_before_training(self):
        with self.assertRaises(ValidationError):
            TrainRequest(
                features=self.features[:20],
                labels=self.labels[:20],
                feature_names=self.feature_names,
                C=0,
            )


if __name__ == "__main__":
    unittest.main()
