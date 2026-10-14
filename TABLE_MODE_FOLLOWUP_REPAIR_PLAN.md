# Table-mode follow-up repair plan

Review date: 2026-10-14. The previous contract/What-if/selection fixes are present, and the automated suites pass. These are the remaining issues confirmed by code inspection and a small preprocessor reproduction. Do not change the scratch logistic-regression algorithm or add scikit-learn.

## P2 — preserve missing-category meaning on unseen missing rows

Files: `backend/table_preprocessing.py`, `backend/tests/test_table_preprocessing.py`, `backend/tests/test_table_api.py`, and the task-pane description if its wording changes.

`TablePreprocessorScratch.fit` currently adds the `_missing_` indicator only when missing values occur in the training subset. If the train subset has no blanks but a held-out or future scoring row does, `transform` maps that blank to the all-zero vector, identical to the reference category. This contradicts the UI promise of a dedicated missing bucket and can silently change a prediction. A direct reproduction with training values `S` and `C` produced the same encoding for the reference value `C`, a missing value, and an unseen value `Q`.

Reserve a distinct missing indicator in the fitted categorical schema even when the training partition has no blank values, and preserve it during serialization, CV, scoring, feature names, coefficients, and export. Because the indicator is constant zero during such training, ensure the model accepts that feature or document and implement an alternative explicit missing-value policy. Do not accidentally treat the literal category text `_missing_` as a missing cell; use an internal sentinel or escaped name. Specify whether unseen nonmissing categories are rejected or mapped to a separate bucket; never represent them as missing without warning.

Acceptance tests: train a categorical feature with no blanks, then score the reference, blank, unseen, and literal `_missing_` values; assert distinct or explicitly documented outcomes. Repeat through `/train-table` and `/predict-table`, including model serialization. Keep the existing test where missing occurs in training.

## P2 — report actual Excel rows in validation errors

Files: `backend/model.py`, `backend/table_preprocessing.py`, `backend/tests/test_table_api.py`.

Training computes the true `clean_row_numbers`, but passes a single `start_row` into `fit(train_rows)` and `transform(train_rows/test_rows/clean_rows)`. After stratified shuffling, position 0 of `train_rows` is generally not the first worksheet row. Thus an invalid cell can be reported against the wrong Excel row. Cross-validation also calls `fit/transform` on shuffled fold rows without their source row numbers.

Pass per-row source row numbers into fit/transform, or validate all selected cells with their absolute worksheet positions before splitting and retain row mapping for any subsequent errors. Use the same mapping for held-out and CV rows. A source cell at D23 must always report row 23, regardless of split, filtering, or CV. Keep `start_row` support for straightforward batch prediction where rows are contiguous.

Acceptance tests: place an invalid numeric or boolean cell at a known Excel row in a D10-starting table; force it into train, held-out, and CV paths using deterministic seeds; assert every error names the real row. Confirm excluded-row and exported prediction row numbers remain correct.

## Verification

Run from `backend/`: `.venv/bin/python -m unittest discover -s tests -q`. Run from `addin/`: `npm test`. Test one real Excel table with missing categorical cells in a later batch and check its weights/What-if/export. Record any remaining warnings. Automated success does not replace a live Excel sideload test or online manifest validation.
