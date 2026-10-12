# Excel Logistic Regression Add-in — Implementation Plan

Status: implemented locally; awaiting live Excel verification.

Implemented on 2026-09-08:

- Backend validation, model IDs, JSON-safe rare-class CV behavior, training-only
  threshold selection, qualified inference, and threshold-aware prediction.
- Task-pane validation/preview, stale-result protection, new-sheet report
  export, what-if validation, and batch scoring of a new Excel range.
- Automated backend and task-pane tests, an updated smoke test, a reproducible
  public-data benchmark, and updated project/mentor/deployment documents.

Still requiring a live Excel verification: actual workbook read/write behavior,
protected-sheet behavior, sideloading, and the online Microsoft manifest
validator. The manifest provider name also remains a user-supplied placeholder.

## Objective and scope

Make the existing prototype reliable enough for a mentor demonstration: consistent predictions, safe worksheet output, validated inputs, defensible evaluation, and reproducible results. Preserve the current Office.js + plain JavaScript + FastAPI + scikit-learn architecture.

This plan covers every fix and improvement in the working-draft review. Work in the order below, delivering a working version at each phase. Add regression tests alongside each behavior change.

## Review-to-work mapping

| Reviewed gap | Work item | Completion evidence |
|---|---|---|
| Slider, export, and what-if disagree | P1.2 | Same probability and threshold yield the same class everywhere |
| Write-back overwrites cells or uses changed source | P1.3 | Export uses a new worksheet and rejects stale training data |
| Invalid or misleading X/Y selections | P2.1 | Invalid selections rejected before training; preview matches workbook |
| Small samples silently evaluated on training data | P2.2 | Requested test split is honored or rejected with an explanation |
| Rare-class cross-validation returns NaN | P2.3 | Class-count validation and JSON-safe failure handling |
| Threshold selected on final test data | P3.1 | Threshold comes only from training-side validation predictions |
| Approximate p-values presented too strongly | P3.2 | Limitations visible in UI and export; unsupported inference suppressed |
| Save button runs the range-selection handler | P1.1 | Save updates the URL without attempting to read a range |
| Old sample descriptions and instructions | P5.2 | All guides agree with the final application and current data |
| Only synthetic-data evidence | P5.1 | Reproducible evaluation on a documented real dataset |
| No UI for predicting a new range | P4.1 | Score new unlabeled rows with the existing model |
| No complete exported report | P4.2 | Report records model, data source, settings, metrics, and predictions |
| Smoke test prints output without assertions | P0, all phases | Automated regression suite and live Excel acceptance checklist |

## P0 — Establish a reproducible baseline

Files: `backend/test_api.py`, `backend/requirements.txt`, `addin/package.json`; add `backend/tests/`, `addin/tests/`, and a development test dependency file.

- [ ] Record the working Python, scientific-library, Node, and Office tool versions. Create a reproducible dependency snapshot after compatibility checks; do not upgrade everything as part of the fixes.
- [ ] Keep the current smoke demo, but make its sample CSV path relative to the script, not the shell's working directory.
- [ ] Make HTTP test mode accept an explicit backend URL. Document HTTPS certificate trust instead of disabling certificate verification.
- [ ] Add Python tests for model behavior and API responses, using an in-process test client without opening a port.
- [ ] Add JavaScript tests for input validation, threshold classification, and export planning. Use a small Office.js mock to inspect reads and writes; actual Excel verification remains separate.
- [ ] Capture current sample results as a reproducibility reference: 400 rows, nine features, accuracy approximately 0.808 and AUC approximately 0.892 in the reviewed environment.

Acceptance: tests run without opening Excel or modifying the demo workbook. Assert properties such as finite probabilities, correct row counts, valid JSON, and correct confusion totals. Do not make an arbitrary accuracy target the definition of correctness. Numerical comparisons use documented tolerances and controlled versions/settings.

## P1 — Fix prediction consistency and worksheet safety

### P1.1 — Correct event handlers and connection feedback

Files: `addin/src/taskpane/taskpane.js`, `taskpane.html`.

- [ ] Bind range selection only to buttons carrying `data-target`, not every `button.pick`.
- [ ] Change the URL placeholder and startup guidance to match the HTTPS setup.
- [ ] Validate saved URLs; show connection errors as readable text. Use text nodes for dynamic URLs rather than interpolating them into HTML.
- [ ] Add request timeouts and restore button state after failures. A timeout must not leave the UI claiming that a new model was successfully trained.
- [ ] Changing the backend URL clears the active model association and disables dependent prediction/export actions until training succeeds on that backend.

Acceptance: Save fires only its own action; connection success and failure behave predictably; training controls recover after an API error.

### P1.2 — Use one active threshold

Files: `taskpane.js`, `taskpane.html`, `backend/main.py`, `backend/model.py`; optionally extract a small reusable JavaScript prediction helper.

- [ ] Store an `activeThreshold` with the current run; initialize it from the validated suggested threshold.
- [ ] Define classification consistently as `probability >= threshold`.
- [ ] Compute slider metrics and exported classes using that threshold; make what-if requests pass it explicitly.
- [ ] Add a validated threshold field to prediction requests and echo the applied threshold in responses.
- [ ] Retain full precision internally and round only for display. Avoid classifying a rounded probability near the boundary.
- [ ] Clearly distinguish fixed-0.5 metrics, selected-threshold metrics, and threshold-independent AUC. Display F1 since it is the threshold-selection objective.
- [ ] Show the original negative/positive labels and their encoded 0/1 mapping. Export the mapping with results.

Acceptance examples: probability 0.40 gives class 1 at threshold 0.30 and class 0 at threshold 0.50; probability exactly equal to the threshold gives class 1. UI, what-if, and export agree.

### P1.3 — Bind results to their source and export safely

Files: `taskpane.js`; add a focused export helper if needed.

- [ ] Capture a run snapshot at training time: worksheet identifiers, exact X/Y addresses, header mode, source values/headers, feature order, class mapping, settings, timestamp, and model identifier.
- [ ] Disable stale-result actions while a new training attempt is pending. On failure, explicitly retain the old run as old or clear it; do not present it as the failed run's result.
- [ ] Mark a run stale when its selection/header settings change. Before exporting training-row predictions, re-read the captured source and compare it with the snapshot to catch edits, sorting, row insertion, or deletion.
- [ ] Export to a uniquely named new worksheet by default. Never calculate a destination from the current X textbox and write into occupied neighboring cells.
- [ ] Include source row references in exported predictions and keep results in original row order.
- [ ] Check worksheet protection, output dimensions, and worksheet capacity before writing; report a clear error if export cannot complete.
- [ ] Disable duplicate export clicks while writing. Report success only after Excel confirms the writes.

Acceptance: occupied neighboring columns remain untouched; changing source data blocks stale export; exporting twice creates distinct output sheets; header and no-header modes preserve row alignment.

## P2 — Validate workbook data and API inputs

### P2.1 — Validate selections and add a data preview

Files: `taskpane.js`, `taskpane.html`, `taskpane.css`; consider extracting pure validation functions for testing.

- [ ] Require one contiguous rectangular X range with at least one feature and exactly one Y column.
- [ ] For this version, require X and Y on the same worksheet with identical starting rows and row counts. Explain this rule in the UI.
- [ ] Reject overlapping X/Y cells so the target cannot accidentally become a feature.
- [ ] Validate headers, empty cells, Excel errors, and non-finite numbers. Report the worksheet cell address, not just an array index.
- [ ] Require nonempty, usable feature names when headers are enabled; reject ambiguous duplicate names.
- [ ] Reject blank outcomes; require exactly two supported scalar classes. Display their mapping before training.
- [ ] Add a preview with a few sample rows, row/feature counts, feature names, outcome name, and class counts.
- [ ] Detect constant features and flag them. Do not silently remove columns or impute missing values in this release.
- [ ] Render worksheet-derived names and labels using text nodes rather than raw `innerHTML`.

Acceptance: multiple Y columns, shifted ranges, X containing Y, bad headers, blanks, and Excel error cells produce actionable messages before an API training request.

### P2.2 — Validate options and honor the requested evaluation mode

Files: `backend/main.py`, `backend/model.py`, `taskpane.html`.

- [ ] Add schema constraints for finite positive C, supported class-weight values, test-split bounds, CV settings, and prediction threshold.
- [ ] Validate rectangular matrices, at least one feature, equal X/Y lengths, finite values, and supported label types at the backend independently of the UI.
- [ ] Remove the silent fallback to training-set evaluation when a requested split cannot be formed.
- [ ] Check both classes can appear in the requested train/test partitions; otherwise return a clear error.
- [ ] If test size zero remains supported, label it explicitly as training-only evaluation and display a prominent warning. Do not claim it estimates performance on unseen data.
- [ ] Normalize validation errors so UI users see useful messages rather than a generic object or server failure.

Acceptance: a 15-row request either forms a valid requested split or returns an explicit reason; invalid test sizes cannot silently produce training scores; invalid C and malformed prediction requests return structured client errors.

### P2.3 — Make cross-validation and response serialization robust

Files: `backend/model.py`, `backend/main.py`.

- [ ] Check minority-class counts on the actual data used for CV, not just total sample count.
- [ ] In automatic mode, reduce requested folds only when a supported stratified evaluation remains possible, and report the actual count. Otherwise explain why CV is unavailable or reject the request.
- [ ] Treat undefined scores and failed fits explicitly. Never substitute zero for an unavailable metric or silently average only successful folds.
- [ ] Ensure every numeric response field is finite, or use a documented `null` with an explanation where absence is valid.
- [ ] Handle training convergence warnings and prediction errors deliberately, including malformed or non-finite new data.

Acceptance: the reproduced two-positive/five-fold case no longer produces NaN JSON; the result states the folds actually used or why evaluation was refused.

## P3 — Make evaluation and interpretation defensible

### P3.1 — Keep final test data untouched during threshold selection

Files: `backend/model.py`; update result rendering and tests.

Implement this sequence:

1. Create the outer training/test split once using the recorded seed.
2. Generate validation predictions using stratified folds entirely within the outer training portion. Fit scaling inside every fold.
3. Select the threshold from those training-side validation predictions using the documented F1 grid and a deterministic tie-break rule.
4. Fit the model and scaler on the full outer training portion.
5. Evaluate once on the outer test portion at both 0.5 and the selected threshold.
6. Retain that fitted model for what-if, original-row predictions, and new-row prediction.

- [ ] Never choose the threshold from `y_test` or test probabilities.
- [ ] Report training-side CV scores and final test scores as different estimates. Do not present scores on the threshold-tuning data as independent evaluation of the tuned threshold.
- [ ] When training-side class counts cannot support threshold tuning, use 0.5 with an explicit reason instead of using the final test set.
- [ ] Keep manual test-set slider exploration available, but label it exploratory. Repeatedly selecting thresholds using test results does not create a fresh unbiased evaluation.
- [ ] Record threshold source, optimization metric, folds, seed, and train/test sizes in response metadata.
- [ ] Label original-row predictions as a mixture of training-row and held-out-row predictions. Do not compute headline generalization metrics from all original rows.

Acceptance: tests verify split/index separation and that the threshold selector only receives training-side predictions. Scaler fitting remains within the appropriate training partitions. Every test metric identifies its threshold and sample count.

### P3.2 — Correct coefficient and p-value presentation

Files: `backend/model.py`, `taskpane.js`, `taskpane.html`, project guides.

- [ ] Include statistical-method and limitation metadata with coefficients.
- [ ] Clearly label regularised-fit p-values as approximate Wald-style estimates. Suppress them when class weighting or invalid/singular inference conditions make the current calculation unsupported; explain why.
- [ ] Remove unconditional significant/not-significant claims when inference is unavailable or unreliable.
- [ ] Explain coefficient units: one original unit without scaling, one training standard deviation with scaling; hold other features constant when interpreting an effect.
- [ ] Explain that odds ratios multiply odds, not probabilities, and associations do not establish causation.
- [ ] Display very small p-values as `<0.001`, not `0.000`.
- [ ] Keep a separately validated unregularised inference mode and confidence intervals as a possible later extension; do not add them by simply reusing the current covariance formula under different assumptions.

Acceptance: UI, report, and guides describe the same method and limitations; weighted models do not show unsupported significance labels.

## P4 — Complete prediction and reporting workflows

### P4.1 — Predict a new Excel range without retraining

Files: `backend/main.py`, `backend/model.py`, `taskpane.js`, `taskpane.html`, `taskpane.css`.

- [ ] Return a model identifier from training and require it for prediction. As a minimal single-user implementation, retain one active model and reject identifiers replaced by subsequent training or lost on server restart.
- [ ] Add a Predict new rows section with a feature-range selector and header option; no Y column is required.
- [ ] Require the trained feature schema. With headers, validate names and ordering; without headers, show the required column order and require an exact feature count.
- [ ] Reuse the fitted scaler and classifier without calling `fit` on new rows.
- [ ] Return probabilities and classes at the active threshold, with model identity and class labels.
- [ ] Preserve row order, validate every row, and use the safe export path from P1.3.
- [ ] Give what-if inputs feature labels and reject missing/invalid entries instead of silently turning them into zero.

Acceptance: batch predictions match individual what-if predictions for identical rows; reversed or missing columns fail clearly; stale model identifiers require retraining. Prediction does not alter model coefficients or scaler statistics.

### P4.2 — Export a complete report

Files: front-end export helpers; backend response metadata.

- [ ] Create a report worksheet with model ID, training time, source addresses, feature schema, class mapping/counts, preprocessing, C, class weighting, seed, split sizes, and actual CV folds.
- [ ] Include test metrics at 0.5 and the active threshold, CV summaries, baseline definition, threshold-selection method, coefficients, and inference caveats.
- [ ] Export prediction rows with source-row references, full usable probabilities, encoded classes, and original class labels.
- [ ] Include software versions needed to reproduce the result. Add the exact feature means/scales if exporting a usable fitted equation.
- [ ] Use clear headings, number formatting, and frozen header rows. Make absence of CV or inference explicit.
- [ ] Label reports clearly as training-data analysis or new-data prediction so a new-data report does not imply access to unknown outcomes.

Acceptance: a mentor can identify the dataset, settings, threshold, model, and meaning of the reported scores from the workbook alone. Report values match the run snapshot and visible UI.

## P5 — Validate beyond the demo and update documentation

### P5.1 — Add a reproducible real-data evaluation

Files to add: `backend/evaluate_dataset.py`, `docs/EVALUATION.md`, and dataset metadata/preparation instructions.

- [ ] Select one public binary-classification dataset from an authoritative source; record source URL, license, version/download date, target meaning, and preprocessing.
- [ ] Prefer numeric predictors compatible with the current product scope. Exclude identifiers and outcome-derived fields; if encoding is needed, document it and fit learned preprocessing using training data only.
- [ ] Use an appropriate split for the dataset. Repeated entities or time-ordered records require grouped or chronological evaluation rather than an automatically assumed random split.
- [ ] Compare logistic regression with a majority-class predictor fitted on the training portion. Define the baseline consistently in the application and report.
- [ ] Report accuracy, precision, recall, F1, AUC, confusion counts, class balance, split design, and limitations. Do not edit the dataset or tune against the final test set to reach a desired accuracy.
- [ ] Keep the synthetic churn sample as the quick integration demo; explain that its outcomes were generated from a logistic relationship and therefore do not establish real-world utility.

Acceptance: a documented command reproduces the evaluation; another reader can trace data provenance and the experimental setup. No real-customer deployment claim is made from a single benchmark.

### P5.2 — Update setup, explanation, and mentor materials

Files: `README.md`, `PROJECT_EXPLAINED.md`, `MENTOR_PRESENTATION_GUIDE.md`, `DEPLOYMENT.md`, `addin/manifest.xml`.

- [ ] Correct the sample to 400 rows and nine features. For the current workbook, X is `churn_data!A1:I401` and Y is `churn_data!J1:J401` with headers enabled.
- [ ] Align all examples, threshold behavior, export instructions, p-value descriptions, and evaluation claims with the implemented version.
- [ ] Explain the distinction between the fixed-0.5 score, the independently evaluated suggested threshold, and manual exploratory slider results.
- [ ] Document model loss after backend restart and stale-model behavior. A model ID is a consistency mechanism, not authentication.
- [ ] Replace placeholder provider details only with the actual supplied team information; flag missing information rather than inventing it.
- [ ] Update setup commands and record tested Excel/platform versions; do not claim untested cross-platform compatibility.
- [ ] Prepare a mentor demo: inspect the preview, train, interpret one coefficient, move the threshold, export a report, predict new rows, and demonstrate one clear validation error.

Acceptance: a teammate can follow the setup and demo instructions without guessing ranges, commands, thresholds, or the meaning of the results.

## Final verification and release gates

- [ ] Backend model/API tests pass, including validation errors and strict JSON serialization.
- [ ] JavaScript tests pass for event wiring, threshold boundaries, class mappings, preview validation, and export planning.
- [ ] Original sample and documented real-data evaluation complete reproducibly.
- [ ] Manifest validation passes.
- [ ] In live Excel: source data remains intact, selected-threshold classes agree everywhere, stale sources are blocked, batch prediction works, and report contents match the UI.
- [ ] In live Excel: test protected sheets, repeated export, missing backend, backend restart, malformed selection, a failed retrain, and a rare-class dataset.
- [ ] Confirm chart labels and notices remain readable with all nine current features.
- [ ] Record which checks used mocks, which ran against the API, and which were actually performed in Excel.

## Delivery checkpoints

| Checkpoint | Included work | Result |
|---|---|---|
| 1: Reliable basic demo | P0 + P1 | Consistent classes and safe output |
| 2: Robust training | P2 | Bad data and unsupported splits fail clearly |
| 3: Defensible statistics | P3 | Untouched final test data and qualified interpretation |
| 4: Complete user workflow | P4 | Train, score new data, export a reproducible report |
| 5: Mentor-ready submission | P5 + final verification | Real-data evidence and accurate documentation |

Public deployment, authentication, persistent per-user model storage, automatic missing-value imputation, multiclass classification, and additional algorithms are outside this repair plan. Revisit them after these checkpoints; they are not required to complete the local mentor demonstration.
