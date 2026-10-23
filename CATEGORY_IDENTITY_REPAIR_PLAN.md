# Remaining categorical identity repair

Status: low-priority edge case found after the table-mode follow-up fixes. The backend and add-in suites pass; this does not block testing ordinary Titanic data in Excel.

## Confirmed issue

`backend/table_preprocessing.py` maps the literal category `_missing_` to the string `\_missing\_` internally. But a source cell whose literal text is already `\_missing\_` uses the same internal string. If both appear in a training column, they are merged into one category and receive identical encodings. This is a data-identity error, not just a display issue. A direct preprocessor reproduction confirmed it.

## Minimal fix

1. In `backend/table_preprocessing.py`, stop using an escapable user-text string as the missing sentinel. Track missingness separately from category text, or encode category keys with a type-tagged structure (for example, a reserved internal tagged key that cannot be produced by a source string). Keep model serialization and `column_specs` JSON-compatible.
2. Keep display feature names unambiguous: a missing-cell indicator and a literal source category named `_missing_` or `\_missing\_` must have distinct names. Update the task-pane category display in `addin/src/taskpane/taskpane.js` if the serialized representation changes.
3. Add a test in `backend/tests/test_table_preprocessing.py` with reference text, a blank, literal `_missing_`, and literal `\_missing\_` all present; assert distinct fitted categories and encodings. Add an API train/predict round-trip in `backend/tests/test_table_api.py`, including serialization. Preserve the existing test for an unseen literal `_missing_`.

Acceptance: distinct source text values never collapse into one learned category, and blanks remain distinct from all literal text values.
