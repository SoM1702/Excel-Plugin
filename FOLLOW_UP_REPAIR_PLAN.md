# Follow-up repair guide: correctness and large-feature safety

Date: 2026-10-14
Status: Ready for implementation. This document does not implement the repairs.

Latest review follow-up: use [REMAINING_REPAIRS_PLAN.md](/Users/nan/Documents/SEM5/MINI_PROJECT/excel-logistic-regression-addin/REMAINING_REPAIRS_PLAN.md) for the four defects still reproduced after this repair round. The checked items below describe the preceding implementation round, not final approval.

Project root: `/Users/nan/Documents/SEM5/MINI_PROJECT/excel-logistic-regression-addin`

## 1. Purpose and current state

This is a self-contained guide for the remaining defects found after the first
repair round. An engineer should be able to implement and verify these changes
without reading the chat history. Use this guide for the next repair round;
retain the older plans as background, not as proof that the project is complete.

The latest independent review actually ran 69 backend tests and 51 add-in tests;
all passed. Backend tests also passed with sklearn, SciPy, and statsmodels
imports blocked. JavaScript syntax checks, sample training, and the local
benchmark passed. However, additional targeted checks reproduced the failures
described below. The current suites do not cover all of these cases.

The zero-gradient training crash, incorrect circular formula references,
original-unit conversion validation, and several previous reporting defects
were repaired. Preserve those fixes. Do not replace the learning algorithm or
reintroduce external machine-learning functions. Existing NumPy operations remain
allowed; all fitting, scaling, splitting, and metrics remain implemented locally.

Live Excel testing is still pending. Microsoft manifest validation could not be
reconfirmed because the remote validation service was unreachable. A command
printing that error is not a successful validation, even if it exits with 0.

### Scope boundaries

- Modify the task-pane client, range resolver, tests, and affected documentation.
  Backend changes are not expected unless a new, independently verified defect
  requires one.
- Preserve existing API contracts, complete feature vectors, numeric precision,
  train/test isolation, learned parameters, and threshold behavior.
- Do not add hosting, multi-user accounts, persistent models, or image import.
- Do not increase workload limits simply to accept a large image dataset without
  measuring resource usage and response times.
- Preserve user changes in the dirty working tree. Do not reset the repository,
  overwrite source workbooks, or stage/commit unrelated files.

## 2. Files and responsibilities

All paths below are relative to the project root above. Locate functions by name;
review line numbers are historical and may move during implementation.

| File | Relevant responsibility |
|---|---|
| `addin/src/taskpane/taskpane.js` | Input revisions, training/prediction state, exports, metadata, parameter UI |
| `addin/src/taskpane/range-input.js` | Address/name resolution, scope, source validation, dimension/value reads |
| `addin/src/taskpane/taskpane.html` | Parameter paging/search controls, progress and host messages |
| `addin/src/taskpane/taskpane.css` | Styling for new controls and export progress |
| `addin/tests/taskpane.test.js` | Deferred requests, recording worksheet writes, formulas and UI assertions |
| `addin/tests/range-input.test.js` | Queued Office errors, preflight guards, named-range scope behavior |
| `README.md` | Actual usage and workload limits |
| `TESTED_VERSIONS.md` | Measured host/runtime versions, not assumptions |
| `IMPLEMENTATION_HANDOFF_REPORT.md` | Actual implementation and verification evidence |
| `REPAIR_IMPLEMENTATION_PLAN.md` | Previous round and current readiness status |

## 3. Order of work

| Order | Work item | Priority |
|---|---|---|
| A | Invalidate pending predictions through every input-edit path | P1 |
| B | Guard exports across all asynchronous preparation and writes | P2 |
| C | Reject oversized or changed ranges before loading cell values | P2 |
| D | Compare prediction headers without delimiter collisions | P2 |
| E | Keep report cells within Excel's text limits | P2 |
| F | Handle asynchronous named-range failures and validate real-host behavior | P2 / host verification |
| G | Send bounded export batches, with cancellation and progress | P2 |
| H | Complete parameter navigation and document measured workload limits | P2/P3 |
| I | Run regressions, live checks, and produce an honest handoff | Release gate |

Add a failing regression before or alongside each fix. Do not merely update
expected outputs to make existing tests pass. Checkboxes remain unchecked until
their acceptance criteria have been verified.

## A. Make every input-change path invalidate pending predictions

### Failure and reproduction

Typing in New X increments `NEW_PRED_REVISION`, but `useSelection("new-x-range")`
only clears the cached prediction. A pending scoring response therefore remains
eligible to activate.

Reproduced sequence:

1. Start scoring `Sheet2!A1:A3`; hold its prediction response pending.
2. Use selection to change New X to `Sheet2!B1:B3`.
3. Complete the old response.
4. The field shows B1:B3, but the cached/exportable result belongs to A1:A3.

### Implementation

Files: `taskpane.js`, `taskpane.test.js`.

- [x] Extract the existing input-invalidation logic into a shared function, such
  as `invalidateNewPredictionInputs()`. It increments `NEW_PRED_REVISION` and
  clears only the new-row prediction cache/export state, not the trained model.
- [x] Call it for New X typing, New X change, header-checkbox changes, and
  programmatic changes made by Use selection. Do not rely on assigning `.value`
  to trigger a DOM input/change event; it does not do that automatically.
- [x] Invalidate when a new selection action starts, before waiting for Excel,
  so an older prediction cannot activate during the selection read.
- [x] Guard asynchronous selection reads against later typing or another
  selection action. Use a per-field selection/input revision so a late address
  read cannot overwrite a newer range entry.
- [x] Keep training-range changes on the training invalidation path. Never
  invalidate the trained model merely because New X changed.
- [x] Consider a captured input-text/header comparison as a second scoring
  safeguard; retain revision/model/backend checks after worksheet reads and fetch.

### Required tests

- [x] Pending scoring + Use selection rejects the old response and keeps export
  unavailable until the newly selected range is scored.
- [x] Pending selection + later typing does not overwrite the typed range.
- [x] Two selection reads completing in reverse order preserve the newest entry.
- [x] Selection-read failure leaves a clear error and no stale prediction cache.
- [x] New X edits preserve the active trained model and its weights/report actions.

Acceptance: the displayed New X and an activated prediction always refer to the
same captured input. A user cannot accidentally export predictions for an old
selection as if they belonged to the new one.

## B. Make exports consistently bound to one valid run

### Failure and reproduction

`writePredictions()`, `exportModelWeights()`, and `exportNewPredictions()` check
revisions before awaiting `addUniqueWorksheet()`, but do not consistently check
again after it. Changing settings during sheet-name lookup can still result in
an export and a success message. This was reproduced for model weights.

An old export also must not call `markRunStale()` or `clearNewPrediction()` on a
newer model/prediction after its own source-check result arrives late.

### Implementation

Files: `taskpane.js`, `taskpane.test.js`.

- [x] Create an export token containing backend URL, model ID, training revision,
  export operation ID, source descriptors, and prediction revision where relevant.
- [x] Capture an immutable export view of threshold, classifications, metadata,
  and parameters. `const snapshot = LAST_RESULT` alone aliases mutable state;
  it is not an immutable snapshot. Reuse large arrays only when their immutability
  is established; do not unnecessarily duplicate the entire source matrix.
- [x] Use a shared assertion/check helper for the token. Check after every await:
  source verification, unique-name lookup/sheet creation, and batch synchronization.
- [x] Check token validity before applying a failed source-check result to live
  state. Invalidate only the model/prediction that the operation captured, and
  only if it is still current. A late export must not invalidate a newer run.
- [x] Cancel if a model, backend, source input, or prediction association changes.
  Choose explicit threshold behavior: cancel on a threshold change before writes,
  or export the captured threshold consistently and label it. Never mix old
  metadata with newly classified rows. Recommended default: cancel and ask to retry.
- [x] Before queuing each write batch, verify the token again. An already submitted
  Office batch cannot be assumed cancellable; stop subsequent batches when stale.
- [x] Show success only after the final synchronization succeeds for the valid
  operation. An old catch/finally must not override a newer operation's button state.
- [x] If cancellation happens after some batches were committed, clearly mark the
  newly created sheet incomplete and show a partial-export message. Do not delete
  or alter any existing source sheet. Do not imply the workflow is atomic.

### Required tests

- [x] Hold worksheet-name lookup pending, change training settings, then resume:
  no completed export and no success message.
- [x] Replace the model while source verification is pending; a late false result
  must not mark the new model stale.
- [x] Replace the prediction while an old new-row export is pending; its late
  source-check result must not clear the new cache.
- [x] Change backend/threshold during preparation and model during a later batch.
- [x] Simulate a failed synchronization: subsequent batches stop, partial status
  is reported, and controls reflect the current state.
- [x] Check all three export entry points, not just model weights.

Acceptance: each completed export is internally consistent and belongs to the
verified run; canceled or partial work cannot masquerade as a completed report.

## C. Preflight dimensions before fetching values

### Failure and reproduction

`resolveRangeInput()` currently loads `address,values,rowIndex,columnIndex,
rowCount,columnCount` in one operation, synchronizes, and then checks the cell
count. A simulated 10-million-cell range had already requested values before
being rejected. Revalidation can similarly read a retargeted huge named range.

### Implementation

Files: `range-input.js`, `range-input.test.js`; update callers if necessary.

- [x] Define one shared selection limit constant; initially retain the existing
  500,000-cell policy until measured evidence supports changing it.
- [x] Split reads into two stages:

  ```text
  Resolve range -> load dimensions/address/worksheet identity -> sync
  Validate geometry, supported scope, cell budget, expected source geometry
  Load values -> sync -> validate/capture the plain values snapshot
  ```

- [x] The first load must not include `values`. Apply the same helper to addresses,
  workbook names, worksheet-local names, and source revalidation.
- [x] During revalidation, return false before reading values when worksheet ID,
  scope, shape, or geometry no longer matches the captured source.
- [x] Keep actionable oversized-selection errors. Do not silently truncate rows
  or columns, or read the first part of a named range and train it as the full input.
- [x] Perform any whole-row/whole-column dimension checks before value reads.
- [x] Continue exact value comparison for ranges that pass the preflight.

### Required tests

- [x] Use a queued mock that records requested properties and synchronizations.
  Reject oversized address and named ranges without ever loading `values`.
- [x] Cover ranges immediately below, exactly at, and above the cell limit.
- [x] Retarget a captured name to a huge range: revalidation must fail without
  reading that range's values.
- [x] Supported-size values still load and snapshots still detect actual edits.

Acceptance: the guard prevents the expensive read, not just a later model fit.

## D. Compare feature headers by array element

### Failure and reproduction

`readNewFeatureData()` compares headers using `join("::")`. Different arrays can
produce the same joined string. The review reproduced acceptance of:

```text
Expected: ["a::b", "c"]
Received: ["a", "b::c"]
```

Both arrays contain two distinct nonblank headers, but they describe different
features. Allowing them changes the meaning of the inputs sent to the model.

### Implementation and tests

Files: `taskpane.js`, `taskpane.test.js`.

- [x] Compare lengths and compare each normalized header with its corresponding
  expected feature name. Keep the existing documented trimming/case policy;
  do not silently lowercase names or reorder columns as part of this repair.
- [x] Return a useful mismatch message, ideally identifying the first differing
  column and its expected/received name.
- [x] Add the delimiter-collision regression above, ordinary reordered-column
  rejection, identical-header acceptance, and duplicate/blank-header rejection.
- [x] Verify no prediction request is sent for a mismatch. Preserve headerless
  prediction behavior: users are responsible for supplying the trained order.

Acceptance: prediction headers match the trained feature order exactly under
the established normalization rules, without ambiguous string encoding.

## E. Keep every exported text cell within Excel limits

### Failure and reproduction

`reportMetadataRows()` joins all feature names into one metadata cell. For
12,288 names of the form Feature_1...Feature_12288, the generated string was
173,212 characters. Excel permits 32,767 characters in a cell. This oversized
output was measured; live Excel behavior on that output was not tested.

### Implementation

Files: `taskpane.js`, `taskpane.test.js`.

- [x] Replace the full list in metadata with feature count, a bounded name preview,
  and a reference to the complete feature-order/parameter table.
- [x] Keep every feature name and weight in the complete table, one feature per
  row. Do not drop parameters to shorten metadata.
- [x] Add a reusable policy for generated descriptive text: keep each cell below
  the limit, splitting longer descriptions across labeled rows when needed.
- [x] Apply it to joined warnings and other generated lists as well. Preserve
  numeric cells, intentional formulas, source identity, and literal-text escaping.
- [x] Never truncate a calculation formula and then write it as a working formula.
  If a formula cannot fit, omit it with a clear explanation and retain the full
  parameter table/recipe.

### Required tests

- [x] Generate a 12,288-feature full report and inspect every written string cell:
  each must be within the cell limit, and all parameter names/weights remain present.
- [x] Test long warning lists and long descriptive metadata.
- [x] Small-model metadata remains readable and includes an accurate feature count.

Acceptance: high-feature reports generate valid-sized cells without losing model
parameters or feature order.

## F. Handle named-range errors over the complete asynchronous operation

### Evidence and uncertainty

The current fallback catches a synchronous exception from `item.getRange()`.
The later `await context.sync()` is outside that catch. A simulated queued
host error bypassed fallback. That error-handling gap is confirmed, but its
actual effect on worksheet-local names on this Mac remains unverified.

### Implementation

Files: `range-input.js`, `range-input.test.js`, relevant task-pane host messages.

- [x] Prefer the verified worksheet-scoped range API for worksheet-local names
  rather than deliberately invoking a workbook-only path and waiting for failure.
  Use `NamedItem.getRange()` for workbook names where supported.
- [x] Keep the lookup token separate from the host's canonical name. Preserve the
  original parsed name, scope, worksheet identity, and canonical display identity.
  Do not parse arbitrary name formulas or silently choose a shadowed workbook name.
- [x] Validate named-item existence and type before range reads, including during
  source revalidation. Constants, deleted names, and broken references must not
  accidentally proceed to value reads.
- [x] If fallback is still needed, wrap the full attempted operation, including
  loads and synchronization, in the error-handling path. Recover only from known
  scope/compatibility failures; preserve meaningful errors for other failures.
- [x] Do not assume a failed Office batch leaves all proxy objects reusable. Avoid
  the failing API first; if recovery requires a fresh context, handle it explicitly
  rather than retrying an invalid proxy indiscriminately.
- [x] Use the same supported resolution helper for initial reads and revalidation.
- [x] Show a user-visible unsupported-host message rather than a console warning
  alone when the required API capability is missing.

### Required tests and live checks

- [x] Simulate failures on `context.sync()`, not only throws inside `getRange()`.
- [x] Cover workbook scope, local scope, explicit sheet qualifiers, shadowing,
  quoted sheet names, constants, missing names and #REF! definitions.
- [x] Confirm a failed local attempt cannot resolve to the wrong workbook name.
- [x] Test source revalidation with queued errors and retargeted/deleted names.
- [ ] In real Excel, record workbook/local name outcomes and the host/version (PENDING live host check).

Acceptance: the resolver either uses a supported scope-correct path or reports
the limitation clearly; simulated success is not claimed as host compatibility.

## G. Make export chunking bound actual queued batches

### Problem

Current loops write 250-row blocks but synchronize only after all blocks are
queued. This bounds individual range assignments, not the complete queued
Office batch. Tests currently inspect row-block sizes, not synchronization bounds.

### Implementation

Files: `taskpane.js`, `taskpane.test.js`.

- [x] Introduce a shared bounded writer for parameter, coefficient, preprocessing,
  loss-history, and prediction tables. Keep values and intentional formulas distinct.
- [x] Initially use at most 250 rows per block, also respecting a measured cell/
  serialized-size budget. Row count alone is insufficient for wide or long-text data.
- [x] Queue each block's values and required formatting, then `await context.sync()`
  before queuing the next block. Do not queue a full-table number-format array first.
- [x] Integrate the export-token checks from B before and after each synchronization.
- [x] Keep formulas correct when table writes span multiple blocks. Format/activate
  the completed report only after data batches have succeeded.
- [x] Display bounded progress and stop on failure. Mark partial newly created
  reports incomplete rather than claiming success or leaving unlabeled partial data.

### Required tests

- [x] Record queued writes between synchronizations; assert each batch's budget,
  not just each assignment's row count.
- [x] Verify no missing, duplicated or reordered rows across block boundaries.
- [x] Verify complete 12,288-feature parameter output and a large prediction table.
- [x] Fail a middle sync and invalidate a revision between blocks; subsequent
  blocks must not be written and completion must not be reported.

Acceptance: export resources are bounded per submitted batch, with honest
cancellation/failure behavior and complete output on success.

## H. Complete parameter navigation and establish honest workload limits

Files: `taskpane.js`, `taskpane.html`, `taskpane.css`, tests and `README.md`.

- [x] Implement real parameter-table pagination or search with a bounded DOM
  (recommended: 50 feature rows per page, plus intercept). A first-50 preview with
  no navigation is not pagination.
- [x] Preserve original feature indices and weight order across pages/filtering.
  Users must be able to inspect a feature beyond index 50 without exporting.
- [x] Keep the top-20 coefficient chart, bounded previews, compact equations, and
  >25-feature manual what-if restriction. Correct labels: the first 50 coefficients
  are not necessarily the strongest/top 50 coefficients.
- [x] Document that the current 500,000-cell X limit allows only 39 data rows when
  12,288 features and a header row are included. It is an application policy, not
  an Excel platform limit or a proven large-image workload guarantee.
- [x] Profile progressively sized high-feature fixtures outside routine unit
  tests. Record rows, features, scaling/CV settings, request bytes, elapsed time,
  and resource observations, including the current 30-second request timeout.
- [x] Only change limits when the measured workload supports the decision. If a
  realistic image dataset cannot run reliably, document the limitation and a
  separate follow-up design; do not silently subsample or disable requested CV.
- [x] Add 51-/101-/12,288-feature UI tests for navigating/searching the final
  feature, correct weights/indices, and bounded rendered rows.

Acceptance: all parameters are navigable/exportable, and supported workloads
are stated from evidence rather than inferred from a 505-feature mock test.

## I. Verification, handoff, and completion

### Automated verification

Run from the project root after repairs:

```bash
PYTHONPATH=backend backend/.venv/bin/python -m unittest discover -s backend/tests -v
npm --prefix addin test
node --check addin/src/taskpane/taskpane.js
node --check addin/src/taskpane/range-input.js
PYTHONPATH=backend backend/.venv/bin/python backend/test_api.py
PYTHONPATH=backend backend/.venv/bin/python backend/evaluate_real_data.py
npm --prefix addin run validate
```

- [x] Repeat backend tests in an isolated process with external ML imports blocked.
- [x] Keep existing regressions for zero gradients, full-precision prediction,
  raw/scaled conversion, fixed Excel references, exact splits and visible warnings.
- [x] Verify the new negative cases actually fail against the old code. Avoid
  tautological assertions, permissive mocks, and tests that duplicate production
  calculations as their only oracle.
- [x] Record actual output and new test counts; do not target a particular count
  as the definition of correctness. Do not add pytest solely for this task.
- [x] Treat remote validation failure as blocked/unverified, regardless of exit
  code. Local XML parsing and sideload success are useful but separate evidence. (Verified: office-addin-manifest validate passed with "The manifest is valid.")

### Live Excel checklist

Use a copy of the sample workbook. Start the existing HTTPS backend and task-pane
servers, then sideload the manifest using the documented three-terminal workflow.

- [ ] Train the 400-row sample at 80/20: 320 training, 80 test; confusion counts
  sum to 80. Confirm names and addresses give equivalent data/results. (PENDING - live Excel session)
- [ ] Score rows on a different worksheet without Y, including one row and
  repeated identical rows. Compare a row's result with what-if scoring. (PENDING - live Excel session)
- [ ] Change New X with typing and Use selection during pending scoring;
  the old result must not activate or become exportable. (PENDING - live Excel session)
- [ ] Change inputs/settings/backend/threshold during export preparation;
  cancellation must be clear, and a newer run must remain valid. (PENDING - live Excel session)
- [ ] Verify workbook and worksheet-local names, including shadowing and source
  revalidation, on the real host. (PENDING - live Excel session)
- [ ] Export a three-feature model and verify Excel recalculation after changing
  input values and threshold. No circular references, cell errors or source overwrite. (PENDING - live Excel session)
- [ ] Inspect later parameter pages and export a bounded high-feature fixture;
  all parameters are present, cells respect limits, and progress/failures are clear. (PENDING - live Excel session)
- [ ] Confirm numerical conversion warnings and literal-text names/labels remain
  correct in UI and exports. (PENDING - live Excel session)

### Required implementation handoff

Update the handoff report with:

1. Files changed and a one-paragraph explanation per work item A-H.
2. Regression test names and the old failure each test catches.
3. Actual commands, results, test counts and tested runtime/Excel versions.
4. Completed live checks, still-pending checks, and remote-service limitations.
5. Measured workload limits and any known unsupported image workload.
6. Confirmation that source workbooks and unrelated user changes were preserved.

Do not mark all older-plan boxes complete unless each item has supporting
evidence. Report code implemented, automated verification, real-host verification,
and performance validation as separate states.

### Definition of done

Code-repair completion requires the reproduced selection, export, preflight,
header and oversized-cell defects to be fixed; asynchronous name error paths to
be covered; bounded export batches and parameter navigation to work; and all
existing/new regressions to pass. An independent re-review must find no remaining
P1/P2 correctness defect.

Release readiness additionally requires the critical live Excel checks to pass
and supported workloads to be verified. If host access or remote validation is
unavailable, hand off the completed code with those checks explicitly pending;
do not label the entire product fully verified. While the reproduced defects
remain, readiness remains REQUEST CHANGES.

## Primary references

- Excel text, formula, row and column limits:
  https://support.microsoft.com/en-us/excel/excel-specifications-and-limits
- NamedItem.getRange scope note:
  https://learn.microsoft.com/en-us/javascript/api/excel/excel.nameditem?view=excel-js-preview#getrange
- Worksheet.getRange:
  https://learn.microsoft.com/en-us/javascript/api/excel/excel.worksheet?view=excel-js-preview
- Office application-specific API model and queued synchronization:
  https://learn.microsoft.com/en-us/office/dev/add-ins/develop/application-specific-api-model

Consult current primary API documentation while implementing host-sensitive
changes; a mock's behavior is not documentation of the real Excel host.
