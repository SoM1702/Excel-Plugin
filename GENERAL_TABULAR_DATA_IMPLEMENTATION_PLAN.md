# General Excel table support: implementation plan

## Goal and honest scope

A user can open an ordinary Excel table, select one rectangular table range, choose a binary outcome column, choose input columns in any order, review preparation choices, train the scratch logistic regression model, and score a second raw table with the same saved preparation rules. The user does not need to make a numeric helper sheet.

First acceptance case: the original Seaborn Titanic sheet with headers `survived,pclass,sex,age,sibsp,parch,fare,embarked,...`. The user selects the table, chooses `survived`, then selects `pclass,sex,age,sibsp,parch,fare,embarked`. The user can choose whether missing values are filled or rows are excluded, and sees how many records remain. The feature `alive` is flagged as outcome leakage and excluded.

This release supports **tabular binary classification**. It should accept numeric, boolean, finite low-cardinality categorical, supported dates, and missing cells under explicit rules. It must reject or exclude high-cardinality identifiers, free text, embedded images, error cells, and unsupported shapes with an actionable reason. Embedded-image extraction and other model families are separate milestones. No change to the scratch logistic regression optimizer or introduction of scikit-learn is required.

## Current behavior and where change is needed

| Concern | Current behavior | Main files |
|---|---|---|
| Excel selection | Separate X/Y ranges; X is one adjacent block, numeric values only | `addin/src/taskpane/taskpane.html`, `taskpane.js` (`readTrainingData`, `validateNumericRows`), `range-input.js` |
| API contract | `/train` and `/predict` require numeric matrices | `backend/main.py` (`TrainRequest`, `PredictRequest`) |
| Training | Splits numeric X, then fits scaler and scratch model; each CV fold fits its own scaler | `backend/model.py`, `backend/preprocessing.py` |
| Stored model | Stores weights and scaler for one active in-memory model | `backend/model.py` (`TrainedModel`), `backend/main.py` (`_LAST_MODEL`) |
| New-row scoring | Requires same numeric feature count/order | `taskpane.js` (`readNewFeatureData`, `scoreNewRows`) |
| Explanations/exports | Assume one user column equals one learned weight | `taskpane.js` (parameter display, what-if, weight/report/new-row exports) |

Keep the current numeric-range workflow as a supported legacy mode while adding **table mode**. Do not change the meaning of existing `/train` or `/predict` requests, because current workbooks and tests use them.

## Data contract and decisions to settle before coding

1. Add a versioned table workflow, for example `POST /profile-table`, `POST /train-table`, and `POST /predict-table`. Requests carry a header list, raw scalar rows, outcome column identity, an **ordered list of individually selected source-column indices**, and preparation policy. Predictions carry the returned `model_id`, raw headers/rows, and threshold. `/train` and `/predict` remain numeric-only. The selected indices may be nonadjacent, such as `[1, 2, 3, 7, 8]`; never reinterpret them as one continuous range.
2. Use source column indices within the selected Excel rectangle for training identity, with display names that include the Excel column letter when headers are duplicated. Duplicate or blank headers produce a warning, not an accidental substitution. Scoring maps by unambiguous header name; if names are duplicated or missing in the scoring table, require explicit mapping or reject. Never silently take the first matching column.
3. Treat `null`, empty string, and whitespace-only string as missing. Treat formula-error cells, arrays, embedded objects, and non-finite numbers as invalid. Keep numeric zero and boolean `false` as real values. Preserve Excel row numbers for every record. Header rows never become training examples.
4. Only a binary, non-missing outcome is supported. Rows with missing Y are excluded from fitting with a count and source-row list. More than two distinct outcome classes or a continuous target gets a clear error. Never fill missing Y.
5. Type inference is a **proposal**. Users can override a column's type or exclude it before fitting. Never infer a date solely because a numeric value resembles an Excel date serial; use Excel formatting/type metadata or an explicit user choice. Formulas are read through their calculated values, with errors detected.
6. Default numeric missing policy: training-partition median, with an explicit option to drop incomplete rows. Default categorical missing policy: a dedicated missing category. Category vocabulary is learned from training data only; unseen categories map to a fixed unknown bucket and produce a count/notice. Define a configurable cardinality cap (initial suggestion: 20 categories per column), an encoded-feature limit, and a cell/payload budget before implementation.
7. For categorical encoding, choose one reference level and create `k-1` indicator columns plus an unknown/missing policy that is deterministic. Document the reference level and the generated names. A boolean may be encoded as 0/1. A date may produce documented components such as year/month/weekday, with user approval of those generated features.
8. Do not auto-use all columns. Show likely identifiers, high-cardinality fields, duplicate information, and possible target leakage. `alive` is an obvious Titanic leakage example, but no universal detector can guarantee that all leaking columns are found. The user confirms the selected feature list.
9. All transformations are scratch code using Python/NumPy and simple standard-library logic. Do not call external model, imputer, one-hot encoder, or automatic ML functions.

## Milestone 1: profile and select a real Excel table

**Files:** `addin/src/taskpane/taskpane.html`, `taskpane.css`, `taskpane.js`, `range-input.js`; new `backend/table_schema.py` (or similarly named module); `backend/main.py`.

- Add a visible choice between **Table mode** and the existing **Numeric X/Y mode**. Table mode has one table range/name and a **Use selection** button. The selected rectangle includes headers and rows; preflight dimensions with the existing cell cap before loading values.
- Show a data preview: Excel sheet and address, total rows, headers, detected/proposed type per column, missing and invalid counts, distinct category count, and a few safe sample values. No model training occurs during profiling.
- In that preview, put a **Y selector** and a checkbox beside **every source column** for X, showing its Excel letter and header (for example `B · pclass`). Include **Select all suggested**, **Clear**, and a visible selected-feature count. The user can tick `B:E` and `H:N` while leaving `F:G` unticked; each checked column remains an individual selected index. Preserve the user's chosen order or let them reorder explicitly, and show the final order before fitting. The Y checkbox is disabled. This does not require Ctrl/Cmd selection or entering a comma-separated union of cell ranges; the existing range resolver rejects unions.
- A blank or unsupported column between chosen columns must not invalidate an otherwise usable selection, because it is not an input. Require at least one selected X column and confirm every selected column has the same table row span. Defaults must not silently include `alive`, an ID, blank-header columns, or an obviously identical/derived outcome. Allow the user to include a warned column only after seeing the reason.
- Expose per-column type and missing-value policy. Show projected row count and generated feature count before the user clicks Fit. Make the projected count clearly provisional where the final train-only policy may affect it.
- Build the profile endpoint with strict size limits and bounded samples. A profile response describes the raw table; it does not learn medians or a category vocabulary from the eventual test split. Avoid rendering arbitrary cell contents as HTML; use text nodes as the existing preview does.
- Tie the profile and column choices to the table descriptor/fingerprint. Editing the source table, changing the range, or changing a policy invalidates the preview and stale results. Preserve named-range resolution and sheet identity checks.

**Done when:** the untouched original Titanic sheet can be selected as one table; the UI shows `sex` and `embarked` as categories, missing `age`, and an `alive` leakage warning; the user can select the seven useful source columns without moving cells. A separate test table also permits nonadjacent groups such as `B:E` plus `H:N`, skipping `F:G`, and displays the exact chosen column order.

## Milestone 2: implement a fitted raw-to-numeric transformer

**Files:** new `backend/table_preprocessing.py` (or extend `preprocessing.py` without mixing its scaler contract); tests in `backend/tests/test_table_preprocessing.py`.

- Implement `fit(raw_train_rows, schema, policy)` and `transform(raw_rows)` on a `TablePreprocessorScratch` object. Save source-header mapping, inferred/overridden types, imputation values, category vocabulary/reference levels, generated feature names, output dimensions, and warnings. Define a serializable metadata representation for reports and later persistence.
- Numeric: parse only supported scalar numbers and deliberate numeric-text coercions; reject mixed nonnumeric values with source cell locations. Median imputation uses **training rows only**. Check all resulting values are finite.
- Category: normalize consistently (define whitespace/case policy), fit vocabulary on training rows only, use deterministic column order, and handle missing/unseen categories by saved rules. Cap category count and encoded width with a clear error before constructing a huge matrix.
- Boolean: distinguish `TRUE/FALSE` values from strings that merely look similar; encode consistently for training and scoring.
- Date: support genuine Excel dates or user-marked date columns after deciding the exact Office.js representation. Document generated features and missing-date behavior. Leave ambiguous numeric serials as numeric by default.
- Keep a mapping from each encoded feature to its original Excel column and transformation. The transformed matrix must have the same width at fit, test, CV and prediction time.
- Reject unsupported cell errors/objects. For ordinary free text and image cells, return an actionable explanation and offer exclusion; do not pretend that an arbitrary code or pixel value is a meaningful numeric feature.

**Done when:** a transformer fitted on some rows handles the same raw columns on new rows, including missing values and a never-seen category, without changing its vocabulary, dimensions or statistics.

## Milestone 3: integrate preprocessing without evaluation leakage

**Files:** `backend/model.py`, `backend/main.py`, `backend/splitting.py` only if row metadata requires it, `backend/tests/test_model.py`, new table tests.

The order matters:

```text
Read raw table → validate/select source columns → exclude missing-Y rows
→ seeded stratified train/test split
→ fit transformer on training rows → transform training and held-out rows
→ fit scaler on transformed training rows → fit scratch logistic regression
→ evaluate once on held-out rows
```

- Each CV fold must independently fit its **own** transformer on that fold's training rows, then transform its validation rows, then fit its own scaler/model. A median, category level, or date rule discovered only in a fold's validation rows must not affect its fit.
- The final transformer and scaler are fitted only on the main training partition. Store both in `TrainedModel` with the raw schema and use them for every later prediction. The numeric legacy path continues using its existing scaler behavior.
- Include original Excel row identities and row-level outcomes in the report so the full-report export can explain rows excluded for missing Y or for a user-selected complete-case policy. Confusion totals must equal only the held-out test count.
- `result.feature_names`, parameters and coefficient rows refer to **generated numeric features**; return separate source-column and transformation metadata. Check constant generated features and numerical overflow before activating the model. The final `/train-table` response must be finite JSON.
- Decide a policy for complete-case deletion *before* the split, because rows dropped for missing X will not be in either partition. Report exactly which rows and why. For imputation mode, preserve all rows with valid Y unless another validation error applies.

**Done when:** train/test and every CV fold learn preparation from their own training rows; a deliberately test-only category or extreme test-only age cannot change training medians, vocabulary, weights or CV threshold selection.

## Milestone 4: score a new raw sheet with the saved pipeline

**Files:** `backend/main.py` (`/predict-table`); `TrainedModel`; `addin/src/taskpane/taskpane.js` (`readNewFeatureData`, `scoreNewRows`); export logic.

- Let the user select a raw new-row table, optionally including headers. Map its input columns to the saved raw feature schema by unique names or explicit mapping. Extra columns, including Y, may be ignored with a notice; missing required columns or ambiguous duplicate names are errors.
- Apply saved imputation, category vocabulary, date features, scaler and weights in that order. Do not refit anything during prediction. Return probability, class, source row, unknown-category/missing-value warnings, and model ID.
- Keep the current stale-model, source-change, revision and model-ID protections for table mode. Recheck the new table before exporting predictions. A failed prediction must not leave an old export enabled.
- Make the single-row what-if form accept **raw source fields**, not dozens of generated dummy inputs. Show how raw values became numeric features and then how feature contributions produced `z` and probability. If there are more raw fields than the UI can safely show, direct users to batch scoring and state that limit.

**Done when:** the model fitted on raw Titanic rows scores a second raw sheet whose columns are in a different order, with one missing age and one previously unseen category, using its saved rules; repeated scoring does not change model parameters.

## Milestone 5: make coefficients and exports truthful

**Files:** `addin/src/taskpane/taskpane.js` result rendering, weights export, full-report export, what-if and new-row export; `taskpane.html` explanatory labels; `backend/model.py` metadata.

- Show both original source columns and generated numeric features, e.g. `sex=female` with its reference category. Show medians, missing/unknown policy, reference categories, excluded rows, and train/test counts in results and exports.
- Explain that a coefficient for a categorical indicator compares that level with its reference. Numeric original-unit weights refer to the **transformed numeric feature**, not to arbitrary raw text. Do not label a dummy coefficient as a raw text coefficient.
- Keep the existing Excel formula example only when it is mathematically equivalent to the saved preprocessing + scaling + model. Otherwise show a clear limitation and export the full transformation/parameter table. Never present a numeric-only `SUMPRODUCT` formula as if it directly accepts raw text or missing cells.
- Report any dropped rows with original worksheet row numbers. Exported new-row predictions align with those original rows, even after exclusions. A report saved to Excel remains understandable after the task pane closes.

**Done when:** a user can trace one raw Titanic row through encoding, imputation (if applicable), generated features, weighted score, sigmoid probability and class; exported explanations agree with `/predict-table` to a stated floating-point tolerance.

## Verification and regression gates

Add meaningful tests in `backend/tests/test_table_preprocessing.py`, `backend/tests/test_model.py`, `backend/tests/test_api.py`, and `addin/tests/taskpane.test.js`; update mock Excel contexts for table selection, source snapshots and new-row mapping. Keep the existing numeric tests passing.

Required automated cases:

1. Numeric legacy `/train` and `/predict` results still match the existing sample reference for the same split/settings.
2. Original Titanic-like rows: mixed numeric/category/boolean values, missing age, category missingness, and nonadjacent selected columns produce the expected generated matrix and named coefficients.
   Verify that an unselected text, blank, error, or high-cardinality column between two selected groups is ignored; changing an unselected column does not change the feature matrix. Changing a selected column invalidates the fit/export snapshot.
3. Test-only numeric outlier does not change the train median; test-only category does not enter train vocabulary. Repeat this test inside one CV fold. Check the held-out test rows are never used in fitted preprocessing.
4. Duplicate/blank headers, wrong raw-column mapping, invalid numeric text, formula error, unknown category, all-missing column, high-cardinality identifier, no usable features, continuous/multiclass Y, missing Y, and overlapping/Y-selected-as-X cases produce clear outcomes.
5. Train/test counts, dropped-row list, row identity and confusion total agree for both impute and drop policies. Repeated runs with the same seed/data/settings are reproducible.
6. Batch and one-row prediction agree. Prediction and threshold changes do not alter transformer, scaler, weights or probabilities. A stale model ID or edited Excel source invalidates scoring/export.
7. Exported coefficient labels, category reference levels, and worked equation match model output; no numeric-only formula is offered for unsupported mixed-data inputs.
8. Size caps prevent a huge selected range or high-cardinality one-hot expansion from freezing Excel or exhausting the backend. Invalid input does not replace the currently active valid model.

Manual Excel gates:

- Open the **untouched original** Titanic worksheet and select its header + 891 rows. Choose `survived` as Y and `pclass,sex,age,sibsp,parch,fare,embarked` as X. Verify the preview, missing-value choice, warning for `alive`, generated-feature list and row counts. In imputation mode, all 891 rows with valid Y should be considered before train/test splitting; in complete-case mode, the subset should shrink and the excluded count must be visible.
- Fit, inspect loss/convergence, weights, AUC and confusion total. Score raw passengers from another sheet, including reordered columns and a missing value. Export the report and predictions, save/reopen the workbook, and confirm input data were not overwritten.
- Repeat the existing 400-row numeric sample and the prepared Titanic workbook. Their results should remain consistent with the prior reference when settings are identical.

## Delivery order

1. Freeze the table-mode API/schema and missing/category rules in a short design document or request/response fixtures.
2. Build the pure scratch transformer and leakage tests.
3. Integrate transformer fit into split/CV/final model and add table API endpoints.
4. Add Excel table profile/selection UI, source tracking and train request.
5. Add raw-sheet scoring, what-if support, report/weight exports.
6. Run automated suites and then perform the manual original-sheet Titanic walkthrough. Update README/user guide with supported cell types and precise limits.

This is one architectural milestone with intermediate gates, not a cosmetic task-pane patch. It is complete only when raw training **and** raw prediction use the same fitted preparation rules.

## Additional work before calling the product public or industry ready

The current backend stores one active model in `_LAST_MODEL` and permits all CORS origins. Those choices fit local single-user development but not a multi-user service. Public distribution needs user-scoped model storage, authentication, deliberate origin policy, model persistence/versioning, request and workbook size budgets, privacy handling, deployment and update paths, and multi-user isolation tests. This is a separate release gate after table mode works. Image matrices and free text require dedicated feature extraction and scale/performance work; they should not be claimed as supported by this plan's first release.
