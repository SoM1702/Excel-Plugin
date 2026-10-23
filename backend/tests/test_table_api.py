"""Integration tests for the Table API (/profile-table, /train-table, /predict-table) and Titanic workflow."""

from __future__ import annotations

import asyncio
import csv
import json
import math
import os
import sys
import threading
import unittest

# Ensure backend root is on sys.path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from main import _MODEL_REGISTRY, app


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


class TestTableAPI(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        fixture_path = os.path.join(os.path.dirname(__file__), "fixtures", "titanic_clean.json")
        with open(fixture_path, "r", encoding="utf-8") as f:
            fix_data = json.load(f)
            cls.headers = fix_data["headers"]
            cls.rows = fix_data["rows"]
            cls.dataset_identity = "committed_titanic_clean_100_rows"

    def setUp(self):
        _MODEL_REGISTRY.clear()

    def test_zero_external_ml_libraries(self):
        """Strict verification: No sklearn, scipy, or statsmodels loaded."""
        forbidden = ["sklearn", "scipy", "statsmodels"]
        for mod in forbidden:
            self.assertNotIn(mod, sys.modules, f"Forbidden library '{mod}' must not be imported.")

    def test_profile_table_titanic(self):
        if not self.rows:
            self.skipTest("Titanic source CSV not found.")

        status, data = asyncio.run(
            asgi_call(
                "POST",
                "/profile-table",
                {
                    "headers": self.headers,
                    "rows": self.rows,
                    "table_range": "A1:O892",
                    "worksheet_name": "titanic_source",
                },
            )
        )
        self.assertEqual(status, 200, data)
        self.assertTrue(data["ok"])
        self.assertEqual(data["total_rows"], len(self.rows))
        self.assertEqual(data["total_columns"], len(self.headers))

        col_by_header = {col["header"]: col for col in data["columns"]}
        self.assertIn("survived", col_by_header)
        self.assertIn("sex", col_by_header)
        self.assertIn("age", col_by_header)
        self.assertIn("alive", col_by_header)

        self.assertEqual(col_by_header["sex"]["detected_type"], "categorical")
        self.assertGreater(col_by_header["age"]["missing_count"], 0)
        self.assertTrue(
            col_by_header["alive"]["is_leakage_candidate"],
            f"alive must be flagged as leakage: {col_by_header['alive']}",
        )
        self.assertEqual(col_by_header["alive"]["suggested_use"], "exclude")
        self.assertEqual(data["suggested_y"], "survived")

    def test_train_table_imputation_and_scoring(self):
        if not self.rows:
            self.skipTest("Titanic source CSV not found.")

        # X columns: pclass(1), sex(2), age(3), sibsp(4), parch(5), fare(6), embarked(7)
        # Non-adjacent: select [1, 2, 3, 5, 6, 7] (omitting sibsp 4)
        selected_x = [1, 2, 3, 5, 6, 7]
        req_payload = {
            "headers": self.headers,
            "rows": self.rows,
            "y_column": "survived",
            "selected_x_columns": selected_x,
            "missing_policy": "impute",
            "impute_numeric": "median",
            "test_size": 0.25,
            "cv_folds": 3,
            "max_iterations": 1000,
            "random_state": 42,
        }

        train_status, train_data = asyncio.run(asgi_call("POST", "/train-table", req_payload))
        self.assertEqual(train_status, 200, train_data)

        self.assertTrue(train_data["table_mode"])
        self.assertEqual(train_data["table_metadata"]["total_rows"], len(self.rows))
        self.assertEqual(train_data["table_metadata"]["usable_rows"], len(self.rows))
        self.assertEqual(len(train_data["table_metadata"]["excluded_missing_y_rows"]), 0)

        gen_names = train_data["table_metadata"]["generated_feature_names"]
        self.assertTrue(any("sex=" in name for name in gen_names))
        self.assertTrue(any("embarked=" in name for name in gen_names))

        model_id = train_data["model_id"]
        self.assertTrue(model_id)

        # Now score a new raw table with reordered columns, an unseen category, and missing age
        scoring_headers = ["fare", "embarked", "sex", "pclass", "parch", "age", "extra_unrelated"]
        scoring_rows = [
            [25.0, "S", "female", 2, 0, 28.0, "ignore_me"],
            [10.0, "Z_UNKNOWN", "male", 3, 1, None, "ignore_me_too"],
        ]

        pred_status, pred_data = asyncio.run(
            asgi_call(
                "POST",
                "/predict-table",
                {
                    "model_id": model_id,
                    "headers": scoring_headers,
                    "rows": scoring_rows,
                    "threshold": 0.5,
                },
            )
        )
        self.assertEqual(pred_status, 200, pred_data)
        self.assertTrue(pred_data["ok"])
        self.assertEqual(len(pred_data["results"]), 2)
        self.assertTrue(any("unseen" in w.lower() or "unknown" in w.lower() for w in pred_data["warnings"]))

    def test_train_table_complete_case_drop_rows(self):
        if not self.rows:
            self.skipTest("Titanic source CSV not found.")

        selected_x = [1, 2, 3, 4, 5, 6, 7]  # pclass, sex, age, sibsp, parch, fare, embarked
        req_payload = {
            "headers": self.headers,
            "rows": self.rows,
            "y_column": "survived",
            "selected_x_columns": selected_x,
            "missing_policy": "drop_rows",
            "test_size": 0.25,
            "cv_folds": 0,
            "max_iterations": 500,
            "random_state": 42,
        }

        train_status, train_data = asyncio.run(asgi_call("POST", "/train-table", req_payload))
        self.assertEqual(train_status, 200, train_data)

        usable = train_data["table_metadata"]["usable_rows"]
        excluded_x = train_data["table_metadata"]["excluded_missing_x_rows"]
        self.assertLess(usable, len(self.rows))
        self.assertEqual(usable + len(excluded_x), len(self.rows))
        self.assertGreater(len(excluded_x), 0)

    def test_predict_table_duplicate_header_rejection(self):
        if not self.rows:
            self.skipTest("Titanic source CSV not found.")

        train_status, train_data = asyncio.run(
            asgi_call(
                "POST",
                "/train-table",
                {
                    "headers": self.headers,
                    "rows": self.rows,
                    "y_column": "survived",
                    "selected_x_columns": [1, 2],
                    "max_iterations": 100,
                },
            )
        )
        self.assertEqual(train_status, 200)
        model_id = train_data["model_id"]

        bad_pred_status, bad_pred_data = asyncio.run(
            asgi_call(
                "POST",
                "/predict-table",
                {
                    "model_id": model_id,
                    "headers": ["pclass", "sex", "pclass"],
                    "rows": [[1, "male", 3]],
                    "threshold": 0.5,
                },
            )
        )
        self.assertEqual(bad_pred_status, 400)
        self.assertIn("duplicate", bad_pred_data["detail"].lower())

    def test_predict_table_missing_feature_column(self):
        if not self.rows:
            self.skipTest("Titanic source CSV not found.")

        train_status, train_data = asyncio.run(
            asgi_call(
                "POST",
                "/train-table",
                {
                    "headers": self.headers,
                    "rows": self.rows,
                    "y_column": "survived",
                    "selected_x_columns": [1, 2],
                    "max_iterations": 100,
                },
            )
        )
        model_id = train_data["model_id"]

        bad_pred_status, bad_pred_data = asyncio.run(
            asgi_call(
                "POST",
                "/predict-table",
                {
                    "model_id": model_id,
                    "headers": ["pclass", "age"],
                    "rows": [[1, 25.0]],
                    "threshold": 0.5,
                },
            )
        )
        self.assertEqual(bad_pred_status, 400)
        self.assertIn("not found", bad_pred_data["detail"].lower())

    def test_invalid_cell_rejection_in_predict_table(self):
        """Present-but-invalid values (like 'oops' in numeric) must raise 400 rather than silently imputing."""
        train_status, train_data = asyncio.run(
            asgi_call(
                "POST",
                "/train-table",
                {
                    "headers": self.headers,
                    "rows": self.rows,
                    "y_column": "survived",
                    "selected_x_columns": [1, 2],  # pclass, sex
                    "max_iterations": 100,
                },
            )
        )
        self.assertEqual(train_status, 200)
        model_id = train_data["model_id"]

        status, data = asyncio.run(
            asgi_call(
                "POST",
                "/predict-table",
                {
                    "model_id": model_id,
                    "headers": ["pclass", "sex"],
                    "rows": [["oops_not_a_number", "male"]],
                    "threshold": 0.5,
                    "start_row": 5,
                },
            )
        )
        self.assertEqual(status, 400)
        self.assertIn("pclass", data["detail"])
        self.assertIn("non-numeric", data["detail"].lower())
        self.assertIn("row 5", data["detail"])

    def test_malformed_signed_number_rejected_in_numeric_column_with_actionable_error(self):
        """P2 regression: Malformed signed numbers like '--50%' or '+-50' must return HTTP 400 rather than silently repairing."""
        # Train-time rejection
        train_rows = [
            [1, 20.0],
            [0, 30.0],
            [1, "--50%"],  # malformed signed percentage at row 4 (start_row 2 + 2)
            [0, 40.0],
            [1, 25.0],
            [0, 35.0],
            [1, 22.0],
            [0, 33.0],
            [1, 28.0],
            [0, 38.0],
            [1, 24.0],
            [0, 34.0],
        ]
        status, data = asyncio.run(
            asgi_call(
                "POST",
                "/train-table",
                {
                    "headers": ["outcome", "age"],
                    "rows": train_rows,
                    "y_column": 0,
                    "selected_x_columns": [1],
                    "column_types": {"age": "numeric"},
                    "start_row": 2,
                },
            )
        )
        self.assertEqual(status, 400)
        self.assertIn("row 5", data["detail"].lower())
        self.assertIn("age", data["detail"])
        self.assertIn("non-numeric value", data["detail"].lower())

        # Prediction-time rejection
        valid_train_rows = [
            [1, 20.0],
            [0, 30.0],
            [1, 25.0],
            [0, 35.0],
            [1, 22.0],
            [0, 33.0],
            [1, 28.0],
            [0, 38.0],
            [1, 24.0],
            [0, 34.0],
        ]
        t_status, t_data = asyncio.run(
            asgi_call(
                "POST",
                "/train-table",
                {
                    "headers": ["outcome", "age"],
                    "rows": valid_train_rows,
                    "y_column": 0,
                    "selected_x_columns": [1],
                    "column_types": {"age": "numeric"},
                },
            )
        )
        self.assertEqual(t_status, 200)
        m_id = t_data["model_id"]

        p_status, p_data = asyncio.run(
            asgi_call(
                "POST",
                "/predict-table",
                {
                    "model_id": m_id,
                    "headers": ["age"],
                    "rows": [["+-50"]],
                    "start_row": 10,
                },
            )
        )
        self.assertEqual(p_status, 400)
        self.assertIn("row 10", p_data["detail"].lower())
        self.assertIn("age", p_data["detail"])
        self.assertIn("non-numeric value", p_data["detail"].lower())

    def test_duplicate_selected_feature_headers_rejected(self):
        """Selected feature columns with duplicate names must be rejected at training time."""
        status, data = asyncio.run(
            asgi_call(
                "POST",
                "/train-table",
                {
                    "headers": ["survived", "age", "age"],
                    "rows": [[1, 25.0, 30.0] for _ in range(12)],
                    "y_column": 0,
                    "selected_x_columns": [1, 2],
                },
            )
        )
        self.assertEqual(status, 400)
        self.assertIn("ambiguous or duplicate selected feature header", data["detail"].lower())

    def test_case_and_whitespace_variant_selected_feature_headers_rejected(self):
        """P2 regression: Feature columns differing only by case or whitespace must be rejected before training."""
        status, data = asyncio.run(
            asgi_call(
                "POST",
                "/train-table",
                {
                    "headers": ["survived", "Age", " age "],
                    "rows": [[1, 25.0, 30.0] for _ in range(12)],
                    "y_column": 0,
                    "selected_x_columns": [1, 2],
                },
            )
        )
        self.assertEqual(status, 400)
        self.assertIn("ambiguous or duplicate selected feature header", data["detail"].lower())
        self.assertIn("age", data["detail"].lower())

    def test_ambiguous_outcome_column_name_rejected(self):
        """P2 regression: Ambiguous outcome header name matching multiple columns must be rejected."""
        status, data = asyncio.run(
            asgi_call(
                "POST",
                "/train-table",
                {
                    "headers": ["Outcome", "outcome", "feature"],
                    "rows": [[1, 1, 25.0] for _ in range(12)],
                    "y_column": "outcome",
                    "selected_x_columns": [2],
                },
            )
        )
        self.assertEqual(status, 400)
        self.assertIn("ambiguous", data["detail"].lower())
        self.assertIn("matches multiple headers", data["detail"].lower())

    def test_outcome_colliding_with_selected_feature_name_rejected(self):
        """P2 regression: Outcome header colliding with selected feature header (case/whitespace) must be rejected."""
        status, data = asyncio.run(
            asgi_call(
                "POST",
                "/train-table",
                {
                    "headers": ["Target", "target "],
                    "rows": [[1, 25.0] for _ in range(12)],
                    "y_column": 0,
                    "selected_x_columns": [1],
                },
            )
        )
        self.assertEqual(status, 400)
        self.assertIn("conflicts with selected feature", data["detail"].lower())

    def test_reordered_unique_columns_and_case_variants_scoreable(self):
        """An accepted schema must be scoreable using reordered columns and case/whitespace header variants."""
        train_status, train_data = asyncio.run(
            asgi_call(
                "POST",
                "/train-table",
                {
                    "headers": ["Survived", "Pclass", "Age"],
                    "rows": [[0, 3, 22.0], [1, 1, 38.0], [1, 3, 26.0], [1, 1, 35.0], [0, 3, 35.0],
                             [0, 1, 54.0], [0, 3, 2.0], [1, 3, 27.0], [1, 2, 14.0], [1, 3, 4.0],
                             [1, 1, 58.0], [0, 3, 20.0]],
                    "y_column": "Survived",
                    "selected_x_columns": [1, 2],
                    "missing_policy": "impute",
                },
            )
        )
        self.assertEqual(train_status, 200, train_data)
        model_id = train_data["model_id"]

        # Predict with reordered headers and different case/whitespace: [" age ", "pclass"]
        pred_status, pred_data = asyncio.run(
            asgi_call(
                "POST",
                "/predict-table",
                {
                    "model_id": model_id,
                    "headers": [" age ", "pclass"],
                    "rows": [[28.0, 2]],
                    "threshold": 0.5,
                },
            )
        )
        self.assertEqual(pred_status, 200, pred_data)
        self.assertTrue(pred_data["ok"])
        self.assertEqual(len(pred_data["results"]), 1)
        self.assertTrue(0.0 <= pred_data["results"][0]["prob"] <= 1.0)

    def test_y_selected_as_x_rejected(self):
        """Selecting Y column as an X feature must be rejected."""
        status, data = asyncio.run(
            asgi_call(
                "POST",
                "/train-table",
                {
                    "headers": ["survived", "pclass"],
                    "rows": [[1, 2] for _ in range(12)],
                    "y_column": 0,
                    "selected_x_columns": [0, 1],
                },
            )
        )
        self.assertEqual(status, 400)
        self.assertIn("cannot also be selected as an input feature", data["detail"].lower())

    def test_y_by_numeric_index(self):
        """y_column can be passed as a 0-indexed integer."""
        status, data = asyncio.run(
            asgi_call(
                "POST",
                "/train-table",
                {
                    "headers": self.headers,
                    "rows": self.rows,
                    "y_column": 0,  # survived
                    "selected_x_columns": [1, 2],
                    "max_iterations": 50,
                },
            )
        )
        self.assertEqual(status, 200)
        self.assertTrue(data["ok"])
        self.assertEqual(data["table_metadata"]["y_column_index"], 0)

    def test_table_row_and_column_offsets(self):
        """Table starting at D10:H25 preserves column letters (D, E, F...) and row numbers (11, 12...)."""
        prof_status, prof_data = asyncio.run(
            asgi_call(
                "POST",
                "/profile-table",
                {
                    "headers": ["col1", "col2", "col3"],
                    "rows": [[1, "A", 10.0] for _ in range(12)],
                    "start_row": 10,
                    "start_col": 4,  # Column D
                },
            )
        )
        self.assertEqual(prof_status, 200)
        # Column 0 is D, Column 1 is E, Column 2 is F
        self.assertEqual(prof_data["columns"][0]["excel_col"], "D")
        self.assertEqual(prof_data["columns"][1]["excel_col"], "E")
        self.assertEqual(prof_data["columns"][2]["excel_col"], "F")

        train_status, train_data = asyncio.run(
            asgi_call(
                "POST",
                "/train-table",
                {
                    "headers": ["outcome", "feat1", "feat2"],
                    "rows": [[i % 2, float(i), "cat_a" if i % 3 == 0 else "cat_b"] for i in range(20)],
                    "y_column": 0,
                    "selected_x_columns": [1, 2],
                    "start_row": 10,
                    "start_col": 4,
                    "max_iterations": 50,
                },
            )
        )
        self.assertEqual(train_status, 200)
        pred_rows = train_data["predictions"]["row_number"]
        # Header is at 10, so first data row is 11
        self.assertEqual(pred_rows[0], 11)
        self.assertEqual(pred_rows[1], 12)

    def test_top_level_feature_names_matches_coefficients(self):
        """Top-level feature_names matches model coefficient vector and table_metadata."""
        status, data = asyncio.run(
            asgi_call(
                "POST",
                "/train-table",
                {
                    "headers": self.headers,
                    "rows": self.rows,
                    "y_column": "survived",
                    "selected_x_columns": [1, 2],  # pclass, sex
                    "max_iterations": 50,
                },
            )
        )
        self.assertEqual(status, 200)
        self.assertIn("feature_names", data)
        self.assertEqual(data["feature_names"], data["table_metadata"]["generated_feature_names"])
        coef_names = [c["name"] for c in data["coefficients"] if c["name"] != "Intercept"]
        self.assertEqual(data["feature_names"], coef_names)

    def test_train_and_predict_table_unseen_missing_and_literal_missing(self):
        """Train categorical feature with no blanks, score reference, blank, unseen, and literal _missing_."""
        train_rows = [
            [1, "C", 20.0],
            [0, "S", 30.0],
            [1, "C", 40.0],
            [0, "S", 50.0],
            [1, "C", 25.0],
            [0, "S", 35.0],
            [1, "C", 45.0],
            [0, "S", 55.0],
            [1, "C", 60.0],
            [0, "S", 65.0],
        ]
        status, train_data = asyncio.run(
            asgi_call(
                "POST",
                "/train-table",
                {
                    "headers": ["y", "embarked", "age"],
                    "rows": train_rows,
                    "y_column": 0,
                    "selected_x_columns": [1, 2],
                    "max_iterations": 50,
                },
            )
        )
        self.assertEqual(status, 200)
        model_id = train_data["model_id"]
        # Both embarked=S and embarked=_missing_ must be generated feature names
        self.assertIn("embarked=_missing_", train_data["feature_names"])

        # Score 4 distinct rows
        test_rows = [
            ["C", 30.0],          # 1. Reference category
            ["", 30.0],           # 2. Blank cell
            ["Q", 30.0],          # 3. Unseen category
            ["_missing_", 30.0],  # 4. Literal category text "_missing_"
        ]
        pred_status, pred_data = asyncio.run(
            asgi_call(
                "POST",
                "/predict-table",
                {
                    "model_id": model_id,
                    "headers": ["embarked", "age"],
                    "rows": test_rows,
                },
            )
        )
        self.assertEqual(pred_status, 200)
        results = pred_data["results"]
        self.assertEqual(len(results), 4)

        # Probabilities exist and are valid numbers
        for r in results:
            self.assertTrue(0.0 <= r["prob"] <= 1.0)

        # Warnings should record 'Q' and '_missing_' as unseen, but NOT 'C' or blank
        warnings_str = " ".join(pred_data.get("warnings", []))
        self.assertIn("embarked='Q'", warnings_str)
        self.assertIn("embarked='_missing_'", warnings_str)
        self.assertNotIn("embarked='C'", warnings_str)

    def test_validation_errors_report_exact_excel_row_in_train_heldout_and_cv(self):
        """Validation errors in train, held-out test, and CV folds report the real Excel row."""
        # Table starts at row 10 (headers at row 10, data rows at 11..30)
        base_rows = [
            [i % 2, float(i + 10), i % 2 == 1]
            for i in range(20)
        ]

        # Case 1: Place invalid numeric string at row 23 (data row index 12: 10 + 1 + 12 = 23)
        rows_train_err = [list(r) for r in base_rows]
        rows_train_err[12][1] = "bad_numeric_val"

        # Fit with cv_folds=0, test_size=0.3
        status1, data1 = asyncio.run(
            asgi_call(
                "POST",
                "/train-table",
                {
                    "headers": ["y", "numeric_feat", "bool_feat"],
                    "rows": rows_train_err,
                    "y_column": 0,
                    "selected_x_columns": [1, 2],
                    "start_row": 10,
                    "cv_folds": 0,
                    "random_state": 42,
                },
            )
        )
        self.assertEqual(status1, 400)
        self.assertIn("row 23", data1["detail"])
        self.assertIn("numeric_feat", data1["detail"])

        # Case 2: Place invalid value at row 17 (data row index 6: 10 + 1 + 6 = 17) with CV enabled
        rows_cv_err = [list(r) for r in base_rows]
        rows_cv_err[6][1] = "bad_numeric_cv"

        status2, data2 = asyncio.run(
            asgi_call(
                "POST",
                "/train-table",
                {
                    "headers": ["y", "numeric_feat", "bool_feat"],
                    "rows": rows_cv_err,
                    "y_column": 0,
                    "selected_x_columns": [1, 2],
                    "start_row": 10,
                    "cv_folds": 5,
                    "random_state": 42,
                },
            )
        )
        self.assertEqual(status2, 400)
        self.assertIn("row 17", data2["detail"])

        # Case 3: Place non-boolean value at row 28 (data row index 17: 10 + 1 + 17 = 28)
        rows_bool_err = [list(r) for r in base_rows]
        rows_bool_err[17][2] = "not_a_boolean"

        status3, data3 = asyncio.run(
            asgi_call(
                "POST",
                "/train-table",
                {
                    "headers": ["y", "numeric_feat", "bool_feat"],
                    "rows": rows_bool_err,
                    "y_column": 0,
                    "selected_x_columns": [1, 2],
                    "start_row": 10,
                    "cv_folds": 0,
                },
            )
        )
        self.assertEqual(status3, 400)
        self.assertIn("row 28", data3["detail"])
        self.assertIn("non-boolean", data3["detail"])

        # Case 4: Missing outcome Y at rows 14 and 25 (data indices 3 and 14)
        rows_missing_y = [list(r) for r in base_rows]
        rows_missing_y[3][0] = ""
        rows_missing_y[14][0] = None

        status4, data4 = asyncio.run(
            asgi_call(
                "POST",
                "/train-table",
                {
                    "headers": ["y", "numeric_feat", "bool_feat"],
                    "rows": rows_missing_y,
                    "y_column": 0,
                    "selected_x_columns": [1, 2],
                    "start_row": 10,
                    "max_iterations": 50,
                },
            )
        )
        self.assertEqual(status4, 200)
        self.assertEqual(data4["table_metadata"]["excluded_missing_y_rows"], [14, 25])
        # Prediction row numbers start at 11, skip 14 and 25, and end at 30
        pred_row_nums = data4["predictions"]["row_number"]
        self.assertNotIn(14, pred_row_nums)
        self.assertNotIn(25, pred_row_nums)
        self.assertIn(11, pred_row_nums)
        self.assertIn(30, pred_row_nums)
        self.assertEqual(len(pred_row_nums), 18)

    def test_predict_table_single_row_explanation_mathematical_breakdown(self):
        # Mixed tabular data
        headers = ["outcome", "age", "is_member", "tier"]
        rows = [
            [0, 20.0, True, "silver"],
            [0, 25.0, False, "bronze"],
            [1, 45.0, True, "gold"],
            [1, 50.0, True, "platinum"],
            [0, 30.0, False, "silver"],
            [1, 60.0, False, "gold"],
            [0, 22.0, True, "bronze"],
            [1, 55.0, True, "platinum"],
            [0, 35.0, False, "silver"],
            [1, 40.0, True, "gold"],
        ]

        for standardize in [True, False]:
            train_status, train_data = asyncio.run(
                asgi_call(
                    "POST",
                    "/train-table",
                    {
                        "headers": headers,
                        "rows": rows,
                        "y_column": 0,
                        "selected_x_columns": [1, 2, 3],
                        "standardize": standardize,
                        "test_size": 0.2,
                        "cv_folds": 0,
                        "max_iterations": 100,
                        "random_state": 42,
                    },
                )
            )
            self.assertEqual(train_status, 200, train_data)
            model_id = train_data["model_id"]

            # Single row with:
            # - missing age (imputed with median ~ 37.5)
            # - is_member = False
            # - tier = "platinum" (active dummy)
            single_row = [None, False, "platinum"]
            single_headers = ["age", "is_member", "tier"]

            pred_status, pred_data = asyncio.run(
                asgi_call(
                    "POST",
                    "/predict-table",
                    {
                        "model_id": model_id,
                        "headers": single_headers,
                        "rows": [single_row],
                        "threshold": 0.5,
                        "explain": True,
                    },
                )
            )
            self.assertEqual(pred_status, 200, pred_data)
            self.assertTrue(pred_data["ok"])
            self.assertIn("explanation", pred_data)
            explanation = pred_data["explanation"]
            self.assertTrue(explanation["math_valid"])
            self.assertEqual(explanation["standardized"], standardize)

            # Mathematical exactness: sum(contributions) + b == linear_score
            contributions = [f["contribution"] for f in explanation["features"]]
            sum_contrib = sum(contributions)
            self.assertAlmostEqual(sum_contrib, explanation["sum_contributions"], places=6)
            reconstructed_z = sum_contrib + explanation["intercept"]
            self.assertAlmostEqual(reconstructed_z, explanation["linear_score"], places=6)
            self.assertAlmostEqual(reconstructed_z, pred_data["results"][0]["score"], places=6)

            # Sigmoid probability
            expected_p = 1.0 / (1.0 + math.exp(-reconstructed_z))
            self.assertAlmostEqual(expected_p, pred_data["results"][0]["prob"], places=6)
            self.assertAlmostEqual(expected_p, explanation["probability"], places=6)

            # Preparation notes
            notes = explanation["preparation_notes"]
            self.assertTrue(any("missing value → imputed with training median" in n for n in notes))
            self.assertTrue(any("is_member" in n and "boolean" in n for n in notes))
            self.assertTrue(any("platinum" in n and "active dummy" in n for n in notes))

            # Batch scoring comparison: score the single row alongside another row
            batch_rows = [
                single_row,
                [30.0, True, "silver"],
            ]
            batch_status, batch_data = asyncio.run(
                asgi_call(
                    "POST",
                    "/predict-table",
                    {
                        "model_id": model_id,
                        "headers": single_headers,
                        "rows": batch_rows,
                        "threshold": 0.5,
                    },
                )
            )
            self.assertEqual(batch_status, 200, batch_data)
            # The first row in batch must match single-row prediction exactly
            self.assertAlmostEqual(batch_data["results"][0]["score"], pred_data["results"][0]["score"], places=7)
            self.assertAlmostEqual(batch_data["results"][0]["prob"], pred_data["results"][0]["prob"], places=7)

    def test_predict_table_explanation_unavailable_when_computation_fails(self):
        from unittest.mock import patch
        from main import _MODEL_REGISTRY

        train_headers = ["age", "tier", "churn"]
        train_rows = [
            [25.0, "silver", 0],
            [30.0, "gold", 0],
            [35.0, "platinum", 1],
            [40.0, "gold", 1],
            [22.0, "silver", 0],
            [38.0, "platinum", 1],
            [29.0, "gold", 0],
            [45.0, "platinum", 1],
            [33.0, "silver", 0],
            [50.0, "platinum", 1],
        ]
        train_status, train_data = asyncio.run(
            asgi_call(
                "POST",
                "/train-table",
                {
                    "headers": train_headers,
                    "rows": train_rows,
                    "y_column": "churn",
                    "selected_x_columns": [0, 1],
                    "max_iterations": 100,
                },
            )
        )
        self.assertEqual(train_status, 200, train_data)
        model_id = train_data["model_id"]
        model = _MODEL_REGISTRY.get(model_id)

        with patch.object(model, "explain_raw_table_row", side_effect=RuntimeError("Simulated explanation failure")):
            pred_status, pred_data = asyncio.run(
                asgi_call(
                    "POST",
                    "/predict-table",
                    {
                        "model_id": model_id,
                        "headers": ["age", "tier"],
                        "rows": [[28.0, "gold"]],
                        "threshold": 0.5,
                        "explain": True,
                    },
                )
            )
            self.assertEqual(pred_status, 200, pred_data)
            self.assertTrue(pred_data["ok"])
            self.assertNotIn("explanation", pred_data)
            self.assertIn("explanation_unavailable", pred_data)
            self.assertIn("Simulated explanation failure", pred_data["explanation_unavailable"])
            self.assertEqual(len(pred_data["results"]), 1)
            self.assertIn("score", pred_data["results"][0])
            self.assertIn("prob", pred_data["results"][0])
            self.assertIn("explanation_unavailable", pred_data["results"][0])
            self.assertNotIn("explanation", pred_data["results"][0])

    def test_barrier_controlled_concurrent_predictions_warnings_isolated(self):
        """P2 regression: Concurrent predictions must keep warnings request-local without cross-talk."""
        train_status, train_data = asyncio.run(
            asgi_call(
                "POST",
                "/train-table",
                {
                    "headers": ["y", "gender"],
                    "rows": [[1, "male"], [0, "female"], [1, "male"], [0, "female"],
                             [1, "male"], [0, "female"], [1, "male"], [0, "female"],
                             [1, "male"], [0, "female"], [1, "male"], [0, "female"]],
                    "y_column": 0,
                    "selected_x_columns": [1],
                },
            )
        )
        self.assertEqual(train_status, 200, train_data)
        model_id = train_data["model_id"]
        model = _MODEL_REGISTRY.get(model_id)
        self.assertIsNotNone(model)

        barrier = threading.Barrier(2)
        results = {}
        exceptions = []

        def worker_unseen():
            try:
                # Synchronize threads before transform
                barrier.wait(timeout=5)
                scores, probs, warnings = model.predict_raw_table(
                    headers=["gender"],
                    rows=[["unseen_cat"]],
                )
                results["unseen"] = (scores, probs, warnings)
            except Exception as e:
                exceptions.append(("unseen", e))

        def worker_known():
            try:
                # Synchronize threads before transform
                barrier.wait(timeout=5)
                scores, probs, warnings = model.predict_raw_table(
                    headers=["gender"],
                    rows=[["male"]],
                )
                results["known"] = (scores, probs, warnings)
            except Exception as e:
                exceptions.append(("known", e))

        t1 = threading.Thread(target=worker_unseen)
        t2 = threading.Thread(target=worker_known)

        t1.start()
        t2.start()
        t1.join(timeout=10)
        t2.join(timeout=10)

        self.assertEqual(len(exceptions), 0, f"Exceptions in worker threads: {exceptions}")
        self.assertIn("unseen", results)
        self.assertIn("known", results)

        _, _, unseen_warnings = results["unseen"]
        _, _, known_warnings = results["known"]

        # Only the worker scoring an unseen category must receive a warning
        self.assertEqual(len(unseen_warnings), 1)
        self.assertIn("unseen_cat", unseen_warnings[0])
        # The worker scoring the known category must receive NO warning (no leakage!)
        self.assertEqual(len(known_warnings), 0)


class TestTitanicFullDatasetIntegration(unittest.TestCase):
    """Explicit integration check for the full 891-row Titanic dataset when available."""

    def test_full_titanic_dataset_row_count_and_identity_if_present(self):
        titanic_csv_path = os.path.abspath(
            os.path.join(
                os.path.dirname(__file__),
                "../../outputs/01a0527d-4c96-7bf3-a80f-d819cf26701c/titanic-validation/support/titanic_source.csv",
            )
        )
        if not os.path.exists(titanic_csv_path):
            self.skipTest("Full 891-row Titanic source CSV not present on disk.")

        with open(titanic_csv_path, "r", encoding="utf-8") as f:
            reader = csv.reader(f)
            headers = next(reader)
            rows = list(reader)

        self.assertEqual(len(rows), 891, "Full Titanic dataset must contain exactly 891 rows.")
        self.assertIn("survived", [h.lower() for h in headers])


if __name__ == "__main__":
    unittest.main()
