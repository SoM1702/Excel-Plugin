"""Integration tests for the Table API (/profile-table, /train-table, /predict-table) and Titanic workflow."""

from __future__ import annotations

import asyncio
import csv
import json
import os
import sys
import unittest

# Ensure backend root is on sys.path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from main import _LAST_MODEL, app


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
        titanic_csv_path = os.path.abspath(
            os.path.join(
                os.path.dirname(__file__),
                "../../outputs/01a0527d-4c96-7bf3-a80f-d819cf26701c/titanic-validation/support/titanic_source.csv",
            )
        )
        cls.headers = []
        cls.rows = []
        if os.path.exists(titanic_csv_path):
            with open(titanic_csv_path, "r", encoding="utf-8") as f:
                reader = csv.reader(f)
                cls.headers = next(reader)
                for row in reader:
                    parsed_row = []
                    for val in row:
                        val_str = val.strip()
                        if val_str == "":
                            parsed_row.append(None)
                        elif val_str.lower() == "true":
                            parsed_row.append(True)
                        elif val_str.lower() == "false":
                            parsed_row.append(False)
                        else:
                            try:
                                if "." in val_str:
                                    parsed_row.append(float(val_str))
                                else:
                                    parsed_row.append(int(val_str))
                            except ValueError:
                                parsed_row.append(val_str)
                    cls.rows.append(parsed_row)
        else:
            # Committed fixture fallback for clean checkout
            fixture_path = os.path.join(os.path.dirname(__file__), "fixtures", "titanic_clean.json")
            if os.path.exists(fixture_path):
                with open(fixture_path, "r", encoding="utf-8") as f:
                    fix_data = json.load(f)
                    cls.headers = fix_data["headers"]
                    cls.rows = fix_data["rows"]

    def setUp(self):
        _LAST_MODEL["model"] = None

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
        self.assertEqual(data["total_rows"], 891)
        self.assertEqual(data["total_columns"], 15)

        col_by_header = {col["header"]: col for col in data["columns"]}
        self.assertIn("survived", col_by_header)
        self.assertIn("sex", col_by_header)
        self.assertIn("age", col_by_header)
        self.assertIn("alive", col_by_header)

        self.assertEqual(col_by_header["sex"]["detected_type"], "categorical")
        self.assertGreater(col_by_header["age"]["missing_count"], 100)
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
        self.assertEqual(train_data["table_metadata"]["total_rows"], 891)
        self.assertEqual(train_data["table_metadata"]["usable_rows"], 891)
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
        self.assertLess(usable, 891)
        self.assertEqual(usable + len(excluded_x), 891)
        self.assertGreater(len(excluded_x), 100)

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
        self.assertIn("duplicate selected feature header", data["detail"].lower())

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


if __name__ == "__main__":
    unittest.main()
