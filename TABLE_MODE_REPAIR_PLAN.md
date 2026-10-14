# Table-mode repair plan

This plan addresses the issues found while reviewing the new mixed-data/table workflow. It is a plan, not an implementation. Keep the existing from-scratch logistic-regression training code; no scikit-learn dependency should be introduced.

## Goal and release rule

On an unmodified Titanic-style Excel table, a user must be able to choose a binary outcome and nonadjacent feature columns, train, inspect the actual learned weights, score new rows, and export results. The same column definitions and preprocessing rules must be used throughout. Do not call the table workflow ready until the acceptance tests below pass in both automated tests and Excel.

## P1 — repair before another demo

### 1. Make the backend and task pane agree on the result schema

Files: `backend/model.py`, `backend/table_preprocessing.py`, `addin/src/taskpane/taskpane.js`, `backend/tests/test_table_api.py`, `addin/tests/taskpane.test.js`.

- Return a top-level `feature_names` array for table training, in exactly the order of the model's coefficient vector. Keep `table_meta.generated_feature_names` if existing consumers use it, but assert the two match. Include the sample/feature counts and preprocessing metadata required by the existing result/export paths, or explicitly update those paths to use the table metadata.
- Use one documented `column_specs` contract. The backend currently emits `source_index`, `source_header`, and `all_train_categories`; the task pane currently reads `index`, `header`, and `vocabulary`. Update the task pane to consume the actual backend fields consistently in result rendering, parameter explanations, What-if inputs, and prediction requests. Do not maintain two untested aliases.
- In What-if scoring, construct a positional raw row using `source_index`. Confirm that changing a numeric or categorical input actually changes the request body and (on a suitable trained model) the returned probability. Compare a What-if prediction with batch scoring for the same raw values.
- Check weights export, prediction export, the learned equation, and the parameter table against a real table-mode response. An empty feature list or an exception is a failure.

Acceptance: an integration/contract fixture captured from the real backend is consumed by the task-pane tests; its generated feature names, coefficients, column specs, and What-if values remain aligned.

### 2. Stop silently turning invalid values into valid-looking predictions

Files: `backend/table_preprocessing.py`, `backend/model.py`, `backend/main.py`, `backend/tests/test_table_preprocessing.py`, `backend/tests/test_table_api.py`.

- Distinguish genuinely missing cells from present-but-invalid cells. A blank numeric value may use the trained median; the text `oops` in a numeric column must not quietly use that median. Apply the same rule to boolean columns and Excel error values.
- Define one explicit policy for invalid selected training, held-out, and prediction cells: preferably reject with a useful column name and Excel row number, while preserving the existing documented handling for genuinely blank cells. API errors should be actionable in the task pane.
- Test invalid numeric and boolean cells in training, held-out rows, single-row What-if, and batch prediction. Assert both the error status and message; a superficially successful prediction is a failure.

Acceptance: invalid present values never produce a normal-looking score through silent imputation.

### 3. Never train on a stale table profile or wrong selected columns

Files: `addin/src/taskpane/taskpane.js`, `addin/tests/taskpane.test.js`.

- Invalidate the cached table profile and selected feature indices when the source range/name changes, when inspection fails, or when the source header row changes. Require the user to inspect and reconfirm selection before training when the current table no longer matches the inspected table.
- Protect the asynchronous inspect/train sequence from late responses: bind each response to the source address, selected columns, and a revision/token. Ignore an old response rather than overwriting newer state.
- Re-read the current header row immediately before sending `/train-table` and compare it with the inspected snapshot. If source data edits after inspection can alter column meaning, either re-profile and reconfirm or include a source fingerprint/revision check before training.
- Test switching between two same-width tables with different column order, editing headers, rapid repeated inspection, and a failed inspection after a successful one.

Acceptance: the UI cannot silently send old Y/X indices against a new table's columns.

## P2 — complete table semantics and diagnostic quality

### 4. Define stable column identity, including duplicate headers

Files: `backend/model.py`, `backend/table_schema.py`, `addin/src/taskpane/taskpane.js`, `backend/tests/test_table_api.py`, `addin/tests/taskpane.test.js`.

- For this release, reject duplicate *selected* header names at training time with exact column locations and a rename instruction. The current backend can train with duplicate selected names but cannot score the resulting model by header name. Reject duplicate Y/X indices, out-of-range indices, and Y appearing in X with equally clear errors.
- Make the outcome selector identify the column by numeric index rather than header text, so duplicate visible names cannot select the wrong Y. Display both the header and Excel column letter to the user.
- Later, if duplicate headers must be supported, define immutable column IDs and carry them through model metadata and prediction mapping; do not just suppress the validation.

Acceptance: any model that trains successfully can also score a raw table using its stored schema.

### 5. Make missing and unseen categories explicit

Files: `backend/table_preprocessing.py`, `backend/table_schema.py`, `addin/src/taskpane/taskpane.html`, `addin/src/taskpane/taskpane.js`, `backend/tests/test_table_preprocessing.py`.

- The task pane currently promises a dedicated missing bucket, but missing, unseen, and reference-category values can all encode as the same all-zero vector. Choose and implement a stable policy: reserve a missing-category indicator learned from training; retain the reference category as the all-zero baseline; handle unseen values with a separately documented indicator or a clear warning/error policy. Build the complete output schema from training only, even when a category is absent from one CV fold.
- Ensure generated names and displayed coefficient explanations identify these buckets correctly. Update UI text and documentation to describe the actual behavior, including what happens to categories appearing only in a test/prediction row.
- Test reference, missing, and unseen values separately, including a CV fold and batch prediction.

Acceptance: missing is distinguishable from the reference category, and unseen-category behavior is deterministic and visible to the user.

### 6. Preserve true Excel row and column positions

Files: `addin/src/taskpane/taskpane.js`, `backend/main.py`, `backend/model.py`, `backend/table_schema.py`, relevant API/UI tests.

- Pass the selected table's starting row and column (or absolute source address) to the backend where it creates profiles and row-numbered outputs. Do not assume every table begins at A1; the current training row-number calculation uses relative index `+2`.
- Use the offsets for displayed column letters, validation messages, excluded-row reports, and exported prediction row labels. Named ranges should resolve to their actual worksheet address.
- Test a table starting at D10 and one starting at A1, both with a header and without a header if supported.

Acceptance: a reported row/column points to the corresponding cell in the original worksheet.

## Test reliability changes

Files: `backend/tests/test_table_api.py`, `backend/tests/fixtures/` (new small committed fixture), `addin/tests/taskpane.test.js`.

- Replace or supplement the test dependency on an untracked `outputs/.../titanic_source.csv`. A clean checkout must still execute a representative end-to-end mixed-data test rather than silently skipping it. Keep the full Titanic test as an optional integration test if desired, with an explicit skip reason.
- Use the backend's actual serialized table response as the JS test fixture. The current JS mock invents `index`, `header`, and `vocabulary`, so those tests pass while production What-if is broken.
- Add explicit assertions for feature/weight alignment, prediction row mapping, stale-profile protection, invalid-cell errors, duplicate selected headers, categorical buckets, and What-if-vs-batch equivalence.
- Retain regression tests for legacy numeric/range mode, scratch logistic regression, training/test split, CV, and baseline metrics.

## Later release gate — not a reason to delay the correctness fixes

- “Any Excel data” remains a product goal, not a current guarantee. Dates, free text, images, high-cardinality identifiers, very wide tables, and Excel error values need documented handling, bounds, and type overrides before a general-public claim.
- Before offering a shared/public service, replace process-global last-model state with user/workbook-scoped model IDs and persistence, constrain CORS, add appropriate access control and request-size limits, and test concurrent users. This is separate from local demo readiness.
- Validate the add-in manifest in an environment that can contact Microsoft's validation service; the previous local `npm run validate` attempt could not reach it, so that result is inconclusive.

## Verification and handoff checklist

1. Run the backend unit suite and task-pane test suite on a clean checkout, with no skipped core table tests. Record command, exit code, test count, and any warnings.
2. Train on the original 891-row Titanic-style table using a 70/30 split and selected mixed/nonadjacent columns. Confirm row counts, useful coefficients, AUC/accuracy, correct source locations, and a successful batch prediction. The earlier backend-only happy path yielded 623 training and 268 test rows; that alone did not verify Excel.
3. In Excel, change a What-if input and verify its raw request and probability change; export weights and predictions; switch to a different source table and verify training is blocked until reinspection; try duplicate selected headers and invalid numeric/boolean cells and verify clear errors.
4. Confirm numerical-only/range mode still works. Then rerun manifest validation with network access and test actual sideloading in Excel. Only mark the workflow complete after these checks are recorded.

Suggested order: contract and What-if fix → invalid-value handling → stale-profile protection → column identity → category semantics → worksheet offsets → clean-checkout tests → live Excel acceptance.
