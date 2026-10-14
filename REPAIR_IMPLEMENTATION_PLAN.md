# Repair implementation plan

Date: 2026-10-14
Status: Independent re-review requires further changes. The 69 backend tests and 51 add-in tests pass, but additional targeted checks reproduce outstanding defects. Live Excel checks remain pending; remote manifest validation could not be reconfirmed during the independent review.

Next repair round: follow [FOLLOW_UP_REPAIR_PLAN.md](/Users/nan/Documents/SEM5/MINI_PROJECT/excel-logistic-regression-addin/FOLLOW_UP_REPAIR_PLAN.md), which supplies self-contained implementation steps and acceptance tests for the remaining issues. Existing completion checkmarks below record the prior implementation round; they do not establish final approval.

## Scope and evidence

Repair the defects found in the independent review, complete the outstanding
named-range and large-feature safeguards, and make the tests verify the actual
behavior. Preserve the existing scratch logistic regression implementation,
Office.js interface, API, and training/test separation.

The preceding review ran 61 backend tests and 35 JavaScript tests successfully,
but targeted checks still reproduced defects. Passing those suites is a
baseline, not release approval. The sample smoke test and benchmark completed;
live Excel verification is pending. Remote manifest validation failed to reach
Microsoft's validation service, so it is not a successful validation result.

No sklearn, SciPy, statsmodels, external optimizer, or external ML/explanation
function may be introduced. Existing NumPy operations remain allowed, consistent
with the previous scratch plan. This is not a zero-dependency Python project.

Public distribution, hosted multi-user storage, model persistence, and a new
image-import pipeline remain outside this repair. Do not promise performance or
accuracy on the mentor's image dataset before measuring the actual workload.

Preserve the dirty working tree and existing workbook. Do not reset files,
overwrite sample_data.xlsx, or stage/commit unrelated changes.

## Priority and implementation order

| Order | Work | Priority | Evidence |
|---|---|---|---|
| 1 | Zero-gradient training failure | P1 | Valid /train request returned HTTP 500 |
| 2 | Exported formula references and meaningful export tests | P1 | Probability and class formulas referenced themselves |
| 3 | Backend, prediction, input, and export request consistency | P1 | Delayed responses restored obsolete model/input/threshold state |
| 4 | New-row source invalidation | P2 | Export read _source after clearing its prediction cache |
| 5 | Report metadata and training warnings | P2 | Wrong requested split and L2 formula; warnings not displayed |
| 6 | Numerically valid parameter conversion and fallback | P2 | Finite converted parameters produced different scores |
| 7 | Literal text and safe generated formulas | P2 | User text passed directly to formula-interpreting Excel writes |
| 8 | Named-range host compatibility | Verification gate | Mocks do not prove worksheet-local name support |
| 9 | Large-feature bounds and complete exports | P2 | UI still builds every parameter row and what-if input |
| 10 | Safe fixtures, honest documentation, final acceptance | P2/P3 | Test fallback can overwrite workbook; completion claims exceed evidence |

Add focused regression tests before or alongside each repair. They must fail
against the defective implementation and pass only after the behavior changes.
Checkboxes below remain unchecked until the described work is verified.

## 1. Prevent valid zero-gradient training from crashing

Files:

- backend/logistic_scratch.py
- backend/tests/test_logistic_scratch.py
- backend/tests/test_api.py

- [x] Calculate the final coefficient norm from the final w before using it in
  post-fit separation checks. Never depend on a variable assigned only after an
  accepted update.
- [x] Preserve legitimate immediate numerical convergence: w=0, b=0 and p=0.5
  are valid results when the initial gradient is zero. Do not reject varying
  features merely because they have no relationship with Y.
- [x] Ensure diagnostics and loss history remain finite and describe the actual
  stop condition without inventing an optimization update.
- [x] Add a direct fit regression using X=[[-1],[1],[-1],[1]], y=[0,0,1,1], lambda=0.
- [x] Add an actual ASGI /train regression with enough rows and a deterministic
  training partition whose class-conditional feature sums give zero gradient.
  Expect 200, a valid active model, and valid subsequent /predict results.
- [x] Cover both zero and positive L2 penalties and retain the existing
  numerical-overflow rejection tests.

Acceptance: valid no-signal data produces an honest fitted model, not HTTP 500.

## 2. Repair and verify Excel-recalculable predictions

Files:

- addin/src/taskpane/taskpane.js
- addin/tests/taskpane.test.js

- [x] Build formula references from one explicit layout description. Keep
  zero-based worksheet indices separate from one-based Excel row references.
- [x] For a calculation block beginning at zero-based row c, use:
  intercept B(c+1), threshold B(c+2), score B(c+3), probability B(c+4),
  class B(c+5), label B(c+6).
- [x] Score references the matching horizontal input/weight rows and intercept;
  probability references score; class references probability and threshold;
  label references the calculated class or the same correct decision inputs.
- [x] Keep the branch-stable sigmoid formula. Do not create circular references
  or rely on Excel's iterative-calculation setting.
- [x] Where raw conversion is unavailable, use the explicit scaled calculation
  described in section 6, rather than multiplying raw inputs by scaled weights.
- [x] Replace the export test ending in assert.ok(true). Capture created sheets,
  written values, and intentional formulas in a recording mock. Assert unique
  names, full numeric parameters, correct references, and absence of cycles.
- [x] Add an independent expected-layout assertion so the test cannot pass when
  production code and a copied test helper share the same off-by-one error.
- [x] Verify the three-feature example w=[0.6,-0.3,0.2], b=-0.4, x=[2,1,3]:
  z=1.1, p approximately 0.7502601056, class=1 at threshold 0.5.
- [ ] Verify actual Excel recalculation later: editing an input or threshold
  changes the expected output, with no circular-reference warning or cell error.

Acceptance: the exported workbook can reproduce predictions without Python.
Mocked writes alone do not prove Excel has evaluated the formulas correctly.

## 3. Make asynchronous actions consistent with their inputs

Files:

- addin/src/taskpane/taskpane.js
- addin/tests/taskpane.test.js

- [x] Capture backend URL, model ID, training revision, source descriptors, and
  settings before asynchronous work. Make fetchJson accept the captured backend
  URL rather than consulting a mutable global halfway through an operation.
- [x] Changing backend invalidates the training revision and all prediction
  revisions. Abort outstanding requests where practical, but also reject their
  late responses because aborting the browser request does not undo server work.
- [x] Use separate revisions for what-if inputs and new-row scoring inputs;
  changing new prediction inputs must not invalidate the unchanged trained model.
- [x] Reject a what-if response after any input edit, model replacement, backend
  change, or newer what-if request. Optionally compare the captured input array
  against current inputs as an additional safeguard.
- [x] Reject a new-row response after source input/header edits, retraining,
  backend change, or a newer scoring request. Recheck captured state after the
  worksheet read and after the prediction response.
- [x] Treat score/probability as independent of the threshold. If the threshold
  changes during prediction, classify the accepted probabilities using the
  current threshold and use that threshold everywhere in the result/export.
- [x] Keep cached what-if pred, displayed decision, and cached new-row pred
  synchronized when the threshold changes after prediction completes.
- [x] Capture a stable export snapshot. Do not reread LAST_RESULT or
  LAST_NEW_PREDICTION after awaiting worksheet creation/name lookup. Verify the
  captured run/source association before writing, and bind all exported values
  and metadata to that same snapshot.
- [x] Do not let an old request's catch/finally handler show obsolete errors,
  enable buttons for a stale model, or change a newer request's loading state.
- [x] Add controllable deferred-response tests for every change above, including
  two predictions completing in reverse order and changes during export setup.
- [x] Correct the DOM test harness: inputs must have INPUT tagName, appropriate
  types, and real listener behavior; buttons must remain BUTTON elements.

Acceptance: the visible result always belongs to the stated backend, model,
inputs, and threshold. Edited inputs never acquire an older explanation.

## 4. Invalidate only the changed new-row prediction

Files: addin/src/taskpane/taskpane.js and addin/tests/taskpane.test.js.

- [x] Capture the prediction and its descriptor before checking the source.
- [x] If a scored range's values, definition, geometry, or identity changed,
  clear only that prediction cache and explanation/export availability.
- [x] Preserve the trained model and its enabled training-report/weights actions
  unless training inputs or model settings independently changed.
- [x] Display an actionable message: "The new-row data or named range changed.
  Score these rows again before exporting." Do not access a cleared cache.
- [x] Revalidate the active model ID as well as the prediction revision before
  export; never export an older model's prediction as a newer model's result.
- [x] Test changed values, retargeted names with identical values, deleted names,
  and deleted/recreated worksheets. A failed export must not write results or
  re-enable the invalid export button in finally.

Acceptance: editing Sheet2 requires rescoring Sheet2, not retraining Sheet1.

## 5. Correct reports and expose diagnostic warnings

Files:

- backend/model.py and backend/logistic_scratch.py
- addin/src/taskpane/taskpane.js, taskpane.html, taskpane.css
- backend/tests/test_model.py and addin/tests/taskpane.test.js
- docs/LOGISTIC_REGRESSION_EQUATIONS.md and IMPLEMENTATION_HANDOFF_REPORT.md

- [x] Use split.requested_train_percent/requested_test_percent for report labels;
  use the returned counts/actual percentages for actual allocation. Add test_size
  to training_settings if retaining that API convention, but avoid competing
  sources of truth and silent 70/30 fallback for an existing result.
- [x] Print the implemented objective:
  mean BCE + (lambda/2)*sum(w_j^2), with no penalty on b. For weighted fits,
  describe sum(a_i*loss_i)/sum(a_i) + (lambda/2)*sum(w_j^2).
- [x] Display loss, gradient norm, AUC, and standard deviation values of zero as
  zero, not n/a or a dash; use null/undefined checks rather than truthiness.
- [x] Render training warnings and cross-validation warnings safely in the task
  pane and both model/report exports. Include CV convergence counts.
- [x] Distinguish meeting a numerical stopping tolerance from having a finite,
  reliable unregularized coefficient estimate. When separation is suspected,
  display that warning even if the optimizer reached its gradient tolerance.
  Do not claim a heuristic is a mathematical proof of separation.
- [x] Record max iterations, tolerance, seed, balancing, lambda, threshold,
  preprocessing, and the actual software versions. Identify package and manifest
  versions separately instead of hardcoding a misleading "Add-in v1.0.0".
- [x] Add tests for 80/20 and 65/35 reports, lambda>0 objectives, exact zero
  metrics, separation warnings, and partly non-converged CV folds.

Acceptance: the exported explanation describes the actual fitted calculation
and settings; all important warnings remain visible to the mentor.

## 6. Validate conversion and provide a correctly labeled fallback

Files:

- backend/model.py and backend/tests/test_model.py
- addin/src/taskpane/taskpane.js and addin/tests/taskpane.test.js

- [x] Retain full-precision fitted weights, intercept, means and effective scales.
  Calculate w_raw=w_model/scale and b_raw=b_model-sum(w_model*mean/scale).
- [x] After the finite-value check, compare raw-equation scores against stable
  model-space scores on available training and held-out rows, using documented
  tolerances, initially atol=1e-9 and rtol=1e-9. Cover requested new rows in tests.
  Record a conversion warning/reason when agreement fails. Agreement on checked
  rows is not a guarantee for every possible future input.
- [x] Keep the valid model-space classifier active if raw conversion fails;
  expose conversion_valid=false and no misleading raw parameter values.
- [x] Export unavailable original-unit weights as n/a, not fitted weights with
  the wrong unit heading. Keep model-space weights and scales available.
- [x] In fallback examples, calculate scaled inputs explicitly with retained
  means/scales, then calculate z=sum(w_model*x_scaled)+b_model. Clearly label
  which space every equation and parameter uses.
- [x] Check the frontend contribution sum plus b against the backend's score
  with documented tolerances. If explanation arithmetic disagrees, show an
  explanation warning rather than claiming the displayed steps reproduce it.
- [x] Add regressions for offsets 1e12 and 1e16, small nonzero scales, constant
  columns with effective scale 1, scaling disabled, conversion failure, and
  three-feature raw/scaled equivalence. Test fallback exports as well.

Acceptance: a reproducible parameter equation is supplied, or its numerical
limitation is stated and a valid scaled recipe is supplied instead.

## 7. Separate literal user text from intentional Excel formulas

Files: addin/src/taskpane/taskpane.js and addin/tests/taskpane.test.js.

- [x] Introduce one compatibility-appropriate literal-text writer/escaping
  helper for feature names, class labels, outcome names and other user-sourced
  strings written to worksheets. Preserve the displayed original text.
- [x] Protect formula-leading strings (=, +, -; defensively @) without changing
  genuine numeric values. Verify the chosen method in actual Excel; formatting
  a column as text must not be assumed sufficient without checking behavior.
- [x] Keep generated calculation formulas on a separate intentional-formula
  path, preferably using Range.formulas. Do not sanitize them into plain text.
- [x] Store literal class labels in known cells and reference those cells in
  the label formula. If labels are interpolated, escape embedded double quotes
  using Excel's string-literal rules.
- [x] Use explicit literal data versus formula records in the export mock so
  unsafe writes and accidental formula escaping are test-visible.
- [x] Test labels/headers such as =1+1, +SUM(A1:A2), -Example, and a label with
  double quotes, apostrophes, or angle brackets. DOM rendering remains text-only.

Acceptance: user-provided names remain names; only intentional formulas execute.

## 8. Verify named ranges on the real Excel host

Files:

- addin/src/taskpane/range-input.js and addin/tests/range-input.test.js
- addin/src/taskpane/taskpane.js and addin/tests/taskpane.test.js
- addin/manifest.xml, only if the actual APIs require a higher requirement set

This is a compatibility concern, not a confirmed live-host failure. Microsoft
documents a workbook-scope limitation in its NamedItem.getRange example. The
current local-name mocks allow getRange unconditionally and cannot resolve it.

- [ ] Verify workbook names, active-sheet local names, explicitly qualified
  local names, and local/workbook shadowing in desktop Excel on this Mac.
- [x] If the chosen local getRange path is unsupported, resolve local names
  through the documented worksheet-scoped range API rather than parsing and
  evaluating arbitrary formula text. Do not silently switch to a shadowed name.
- [x] Apply the same verified resolution behavior to source revalidation.
- [x] Parse worksheet qualifiers before detecting unions. A comma inside a
  quoted sheet name must not be confused with multiple range areas.
- [x] Cover spaces, escaped apostrophes, commas, case-insensitive names, missing
  names, constants, #REF!, external references, and valid range-defined formulas.
- [x] Keep deterministic worksheet IDs, scope, geometry, and exact value snapshots;
  never replace source comparison with the old lossy fingerprint.
- [x] Show a user-visible unsupported-host message when the required API set is
  unavailable. Console warnings alone are not adequate for a nontechnical user.
- [x] Update mocks to simulate queued errors surfaced by context.sync as well
  as synchronous errors. Record host/version and actual results in the handoff.

Acceptance: supported name scopes work in real Excel, and unsupported cases fail
with clear messages rather than a fabricated successful compatibility claim.

Relevant primary API references to verify during implementation:

- NamedItem.getRange: https://learn.microsoft.com/en-us/javascript/api/excel/excel.nameditem?view=excel-js-preview#getrange
- Worksheet.getRange: https://learn.microsoft.com/en-us/javascript/api/excel/excel.worksheet?view=excel-js-preview#getrange-address-
- Range.values and formulas: https://learn.microsoft.com/en-us/javascript/api/excel/excel.range?view=excel-js-preview#values

## 9. Finish large-feature safeguards without dropping parameters

Files: addin/src/taskpane/taskpane.js, taskpane.html, taskpane.css,
range-input.js, addin/tests/taskpane.test.js; relevant backend tests and docs.

- [x] Paginate/search the parameter table (for example 50 feature rows/page),
  while preserving all parameters in memory and exporting all of them.
- [x] Bound coefficient charts (for example top 20 by absolute model-space
  weight) and state the selection rule. Do not render thousands of bars.
- [x] Bound multirow data previews by both rows and columns and clearly state
  omitted dimensions. A three-row preview can still have 12,288 columns.
- [x] Keep compact equations for large models and identify whether x means raw
  or standardized features; no thousands-of-terms text or formula.
- [x] For more than a documented small manual-input limit, do not build one
  what-if input per feature. Direct users to the existing new-row range scorer;
  bound any displayed per-row contribution details. Do not silently score a
  truncated feature vector.
- [x] Export all weights in bounded row chunks if needed, with stable snapshots,
  correct order and progress/error handling. Respect worksheet dimensions.
- [x] Explain when a live formula example is omitted due to size; retain the
  complete parameter table and model-space calculation recipe.
- [x] Load source dimensions before large value reads. Measure reasonable cell,
  payload and compute budgets, document them, and reject oversized selections
  clearly instead of freezing Excel. Do not invent an untested supported limit.
- [x] Use a bounded 12,288-feature fixture to verify parameter count/order and
  bounded UI output. Profile realistic image workloads separately, including
  standardization, CV and the existing 30-second request timeout.
- [x] If profiling exceeds current limits, document the blocked workload and
  design a follow-up computation workflow; do not silently retrain partial data
  or mark the large-scale image test complete.

Acceptance: all learned weights remain inspectable/exportable without generating
an unbounded interface. Large-scale training readiness is evidence-based.

## 10. Harden tests, fixture handling, and completion evidence

Files:

- backend/main.py and backend/tests/test_api.py
- backend/tests/test_model.py and backend/test_api.py
- addin/tests/taskpane.test.js and addin/tests/range-input.test.js
- IMPLEMENTATION_HANDOFF_REPORT.md, TESTED_VERSIONS.md, README.md,
  SCRATCH_IMPLEMENTATION_PLAN.md, NAMED_RANGE_IMPLEMENTATION_PLAN.md,
  WEIGHTS_AND_EQUATION_IMPLEMENTATION_PLAN.md

- [x] Use json.dumps(result, allow_nan=False) before model activation. Default
  json.dumps permits non-finite values. Add a controlled API test injecting a
  non-finite result and verify rejection without replacing the prior model.
  This hardens a latent guard weakness, not a claim that normal results currently
  contain NaN.
- [x] Remove automatic make_sample_data.py execution from test/smoke loaders.
  A missing fixture should fail clearly or use a dedicated temporary fixture;
  tests must never regenerate/overwrite the user's sample workbook.
- [x] Use temporary directories for any generation test and assert the existing
  workbook remains unchanged. Do not delete the actual CSV to test this path.
- [x] Confirm required source/data files are included in the eventual handoff or
  source-control change, including currently untracked modules and CSV fixtures.
  Do not claim that a present or unignored file is already tracked/committed.
- [x] Keep ASGI routing tests, gradient finite-difference tests, scaler/split/CV
  isolation tests, full-precision prediction tests, and blocked-ML-import checks.
- [x] Re-run tests in a fresh process. Do not validate by training against the
  user's running service and replacing their active model unnecessarily.
- [x] Record commands, actual counts and outputs. Leave live/remote checks marked
  pending or blocked until they genuinely complete; remove unconditional
  completion checkmarks and obsolete test-count/behavior claims.

## Final verification commands

Run from the project root:

```bash
PYTHONPATH=backend backend/.venv/bin/python -m unittest discover -s backend/tests -v
npm --prefix addin test
node --check addin/src/taskpane/taskpane.js
node --check addin/src/taskpane/range-input.js
PYTHONPATH=backend backend/.venv/bin/python backend/test_api.py
PYTHONPATH=backend backend/.venv/bin/python backend/evaluate_real_data.py
npm --prefix addin run validate
```

Repeat the backend suite with an import guard blocking sklearn, scipy, and
statsmodels in an isolated process. Pytest is not installed in the current
virtual environment; use the project's existing unittest runner.

If remote manifest validation is unavailable, record that limitation separately;
local XML parsing and successful sideloading are not equivalent to Microsoft's
manifest validation.

## Live Excel acceptance checklist

Use a copy of the sample workbook for manual edits.

- [ ] Start backend and add-in servers, sideload, and verify /health and task-pane
  connectivity over trusted HTTPS. No backend-unreachable banner.
- [ ] Train on churn_data!A1:I401 / churn_data!J1:J401, with headers checked.
  At 80/20, expect train=320, test=80; confusion counts sum to 80. At 70/30,
  expect train=280, test=120. Report requested and actual allocations agree.
- [ ] Train using workbook-defined names; compare with address-based results.
  Repeat supported worksheet-local and mixed name/address cases.
- [ ] Inspect actual learned weights and b. For a three-feature model, manually
  verify the score, sigmoid probability, and class with the supplied inputs.
- [ ] Export weights and the full report; verify source sheets are unchanged,
  repeated exports create unique sheets, formulas recalculate, and full numeric
  parameters—not rounded display strings—are used.
- [ ] Score one row, repeated identical rows, and multiple rows on another sheet
  without Y. Compare with what-if scoring and verify the same training scaler
  and coefficients are retained; no new fit or train/test split occurs.
- [ ] Change threshold before/after a delayed prediction; score/probability stay
  unchanged and all class labels use the current threshold.
- [ ] Edit inputs, change backend, or replace the model during pending requests;
  no old response becomes active or re-enables stale exports.
- [ ] Change/retarget a new-row named range after scoring; export asks to rescore,
  preserves the trained model, and does not show a null-reference error.
- [ ] Test formula-like headers and quoted labels as literal text; intentional
  generated formulas still calculate correctly.
- [ ] Confirm separation/numerical-conversion/CV warnings appear in UI and export.
- [ ] Verify bounded rendering and complete parameter export on the chosen
  high-feature fixture; record actual performance limits separately.

## Definition of done

All P1/P2 correctness repairs above are implemented; each has meaningful
regression coverage; full suites and smoke/benchmark checks pass without new
ML dependencies; relevant Excel acceptance checks pass; outstanding host,
performance, or remote-validation limitations are explicitly recorded. The
handoff report accurately separates implemented, tested, pending, and blocked
items. Only then repeat the independent review for an approval decision.
