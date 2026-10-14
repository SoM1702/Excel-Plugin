"""Unit and leakage tests for pure scratch TablePreprocessorScratch."""

import unittest
import numpy as np

from table_preprocessing import TablePreprocessorScratch
from table_schema import profile_table


class TestTablePreprocessingScratch(unittest.TestCase):
    def setUp(self):
        # Sample Titanic-like rows: [pclass, sex, age, fare, embarked]
        self.headers = ["pclass", "sex", "age", "fare", "embarked"]
        self.train_rows = [
            [3, "male", 22.0, 7.25, "S"],
            [1, "female", 38.0, 71.28, "C"],
            [3, "female", 26.0, 7.925, "S"],
            [1, "female", 35.0, 53.1, "S"],
            [3, "male", None, 8.05, "S"],  # missing age -> should be imputed with train median (30.5)
            [1, "male", 54.0, 51.86, "S"],
        ]

    def test_fit_and_transform_imputation_and_dummy_encoding(self):
        # Train rows ages: [22.0, 38.0, 26.0, 35.0, 54.0] -> sorted: 22, 26, 35, 38, 54 -> median = 35.0
        prep = TablePreprocessorScratch(
            selected_indices=[0, 1, 2, 3, 4],
            source_headers=self.headers,
        )
        prep.fit(self.train_rows)

        # Expected features:
        # pclass (numeric)
        # sex: 3 female, 3 male -> ref: female, indicator: sex=male
        # age (numeric)
        # fare (numeric)
        # embarked: 5 S, 1 C -> ref: S, indicator: embarked=C
        self.assertIn("pclass", prep.generated_feature_names)
        self.assertIn("sex=male", prep.generated_feature_names)
        self.assertNotIn("sex=female", prep.generated_feature_names)  # reference level excluded
        self.assertIn("age", prep.generated_feature_names)
        self.assertIn("fare", prep.generated_feature_names)
        self.assertIn("embarked=C", prep.generated_feature_names)
        self.assertNotIn("embarked=S", prep.generated_feature_names)  # reference level excluded

        X_train = prep.transform(self.train_rows)
        self.assertEqual(X_train.shape, (6, len(prep.generated_feature_names)))
        self.assertTrue(np.isfinite(X_train).all())

        # Check row 4 (where age was None): age feature index
        age_feat_idx = prep.generated_feature_names.index("age")
        self.assertAlmostEqual(X_train[4, age_feat_idx], 35.0)

    def test_zero_leakage_held_out_outlier_does_not_affect_train_median(self):
        """Verify that an extreme outlier in test data does not affect fitted median."""
        prep = TablePreprocessorScratch(
            selected_indices=[2],  # age only
            source_headers=self.headers,
        )
        prep.fit(self.train_rows)
        train_median = prep.column_specs[0].impute_value
        self.assertEqual(train_median, 35.0)

        # Test rows with extreme outlier and missing value
        test_rows = [
            [None, None, 10000.0, None, None],
            [None, None, None, None, None],  # Missing value in test
        ]
        X_test = prep.transform(test_rows)
        # Test missing row should receive train median (35.0), NOT affected by 10000.0
        self.assertAlmostEqual(X_test[1, 0], 35.0)
        self.assertEqual(prep.column_specs[0].impute_value, 35.0)

    def test_zero_leakage_test_only_category_does_not_enter_vocabulary(self):
        """Verify that a category seen only in test data does not enter vocabulary."""
        prep = TablePreprocessorScratch(
            selected_indices=[4],  # embarked only (train has S and C)
            source_headers=self.headers,
        )
        prep.fit(self.train_rows)
        self.assertEqual(prep.column_specs[0].reference_category, "S")
        self.assertEqual(prep.column_specs[0].categories, ["C"])

        # Test rows have 'Q' and 'UnknownPort'
        test_rows = [
            [None, None, None, None, "Q"],
            [None, None, None, None, "UnknownPort"],
            [None, None, None, None, "C"],
            [None, None, None, None, "S"],
        ]
        X_test = prep.transform(test_rows)
        # 'Q' -> not in train categories -> indicator embarked=C is 0.0
        self.assertEqual(X_test[0, 0], 0.0)
        # 'UnknownPort' -> indicator embarked=C is 0.0
        self.assertEqual(X_test[1, 0], 0.0)
        # 'C' -> indicator embarked=C is 1.0
        self.assertEqual(X_test[2, 0], 1.0)
        # 'S' -> reference level -> indicator embarked=C is 0.0
        self.assertEqual(X_test[3, 0], 0.0)

        # Warnings should record unseen categories
        self.assertTrue(any("unseen categories" in w for w in prep.last_transform_warnings))

    def test_non_adjacent_column_selection(self):
        """User selects columns [0, 3] (pclass and fare), skipping [1, 2]."""
        prep = TablePreprocessorScratch(
            selected_indices=[0, 3],
            source_headers=self.headers,
        )
        prep.fit(self.train_rows)
        self.assertEqual(prep.generated_feature_names, ["pclass", "fare"])
        X = prep.transform(self.train_rows)
        self.assertEqual(X.shape, (6, 2))
        self.assertEqual(X[0, 0], 3.0)
        self.assertEqual(X[0, 1], 7.25)

    def test_profile_table_leakage_detection(self):
        """Verify profile_table detects 'alive' as outcome leakage for 'survived'."""
        headers = ["survived", "pclass", "sex", "alive"]
        rows = [
            [1, 1, "female", "yes"],
            [0, 3, "male", "no"],
            [1, 2, "male", "yes"],  # male survivor
            [0, 1, "female", "no"],  # female victim
            [1, 3, "female", "yes"],
            [0, 2, "male", "no"],
            [1, 1, "female", "yes"],
            [0, 3, "male", "no"],
            [1, 2, "female", "yes"],
            [0, 1, "male", "no"],
        ]
        profile = profile_table(headers, rows)
        self.assertEqual(profile.suggested_y, "survived")

        # Find 'alive' profile
        alive_prof = next(c for c in profile.columns if c.header == "alive")
        self.assertTrue(alive_prof.is_leakage_candidate)
        self.assertEqual(alive_prof.suggested_use, "exclude")
        self.assertIn("alive", alive_prof.leakage_reason.lower())

        # pclass and sex should be suggested X
        self.assertIn(1, profile.suggested_x)  # pclass
        self.assertIn(2, profile.suggested_x)  # sex
        self.assertNotIn(3, profile.suggested_x)  # alive excluded

    def test_serialization_fidelity(self):
        """Verify to_dict and from_dict preserve complete preprocessor state."""
        prep1 = TablePreprocessorScratch(
            selected_indices=[0, 1, 2],
            source_headers=self.headers,
        )
        prep1.fit(self.train_rows)
        d = prep1.to_dict()

        prep2 = TablePreprocessorScratch.from_dict(d)
        self.assertEqual(prep1.generated_feature_names, prep2.generated_feature_names)
        self.assertEqual(prep1.selected_indices, prep2.selected_indices)

        X1 = prep1.transform(self.train_rows)
        X2 = prep2.transform(self.train_rows)
        np.testing.assert_array_equal(X1, X2)

    def test_invalid_cell_raises_error_not_imputed(self):
        """Present-but-invalid values must raise ValueError rather than being silently imputed."""
        prep = TablePreprocessorScratch(
            selected_indices=[0],  # pclass (numeric)
            source_headers=self.headers,
        )
        prep.fit(self.train_rows)

        # Blank cell is imputed
        X_blank = prep.transform([[None, None, None, None, None]])
        self.assertEqual(X_blank[0, 0], prep.column_specs[0].impute_value)

        # Present invalid non-numeric string 'oops' must raise ValueError
        with self.assertRaises(ValueError) as ctx:
            prep.transform([["oops", None, None, None, None]], start_row=15)
        self.assertIn("pclass", str(ctx.exception))
        self.assertIn("non-numeric", str(ctx.exception).lower())
        self.assertIn("row 15", str(ctx.exception))

        # Excel error value #VALUE! must raise ValueError
        with self.assertRaises(ValueError) as ctx:
            prep.transform([["#VALUE!", None, None, None, None]], start_row=20)
        self.assertIn("pclass", str(ctx.exception))
        self.assertIn("invalid cell value", str(ctx.exception).lower())
        self.assertIn("row 20", str(ctx.exception))

    def test_categorical_missing_distinguishable_from_reference(self):
        """Missing categorical values receive an explicit _missing_ indicator when present in training."""
        train_rows = [
            ["female"],
            ["female"],
            ["male"],
            [None],  # Missing category in training
        ]
        prep = TablePreprocessorScratch(
            selected_indices=[0],
            source_headers=["gender"],
        )
        prep.fit(train_rows)

        # Reference: female (most frequent). Active indicators: gender=male, gender=_missing_
        self.assertEqual(prep.column_specs[0].reference_category, "female")
        self.assertIn("gender=male", prep.generated_feature_names)
        self.assertIn("gender=_missing_", prep.generated_feature_names)

        # Transform reference category 'female' -> [0.0, 0.0]
        X_ref = prep.transform([["female"]])
        np.testing.assert_array_equal(X_ref[0], [0.0, 0.0])

        # Transform category 'male' -> [1.0, 0.0]
        X_male = prep.transform([["male"]])
        np.testing.assert_array_equal(X_male[0], [1.0, 0.0])

        # Transform missing cell None -> [0.0, 1.0] (distinguishable from reference!)
        X_miss = prep.transform([[None]])
        np.testing.assert_array_equal(X_miss[0], [0.0, 1.0])

        # Transform unseen category 'other' -> [0.0, 0.0] + warning
        X_unseen = prep.transform([["other"]])
        np.testing.assert_array_equal(X_unseen[0], [0.0, 0.0])
        self.assertTrue(any("unseen categories" in w.lower() for w in prep.last_transform_warnings))


if __name__ == "__main__":
    unittest.main()
