# Implementation plan: four remaining correctness repairs

Date: 2026-10-14
Status: Completed. All 4 repairs implemented and verified with 87 passing frontend tests and 69 passing backend tests; manifest validated; live Excel checks pending host session.

Project root: `/Users/nan/Documents/SEM5/MINI_PROJECT/excel-logistic-regression-addin`

## Scope and baseline

The latest independent review ran 69 backend tests and 71 add-in tests; all
passed. Syntax checks, the blocked-ML-import check, sample training, and the
benchmark also passed. Additional targeted checks reproduced the four remaining
issues below. Implement these repairs without reworking the already-correct
logistic regression engine or reopening previously repaired features.

Work is primarily in:

- `addin/src/taskpane/taskpane.js`
- `addin/tests/taskpane.test.js`
- `README.md` and `IMPLEMENTATION_HANDOFF_REPORT.md` for corrected claims

Paths here are relative to the project root above. Locate code by function name;
line numbers from the review may move. Preserve the dirty working tree and source
workbooks. Do not reset files, regenerate the workbook, or commit unrelated work.
Do not introduce sklearn, external ML functions, or new dependencies.

Public deployment and a new image-data import workflow remain out of scope.
Live Excel verification is still pending. Remote manifest validation was
unavailable in the review; a validation command printing a connection error must
not be reported as passing, even if its exit code is zero.

## Priority and order

All four findings were ranked P2. Fix them in this order:

| Order | Repair | Main functions |
|---|---|---|
| 1 | Ignore obsolete selection failures | `useSelection` |
| 2 | Preserve exact names and labels in exports | `writeTableChunks`, text preparation helpers, export callers |
| 3 | Bound batches by bytes/cells as well as rows | `writeTableChunks`, direct-write export sections |
| 4 | Handle invalidation during final export synchronization | `writePredictions`, `exportModelWeights`, `exportNewPredictions` |

For each repair, add a regression that fails against the current defective code,
implement the minimal fix, and run the relevant tests before proceeding.

## 1. Ignore obsolete selection failures

### Problem

The success path in `useSelection(targetId)` checks the captured `reqRev` against
`SELECTION_REVISIONS[targetId]`. Its catch path does not. An older request that
fails after a newer input/prediction exists can call
`invalidateNewPredictionInputs()` and clear that valid prediction.

The review reproduced a newer valid prediction being cleared and an obsolete
"Could not read the selected cells" message being displayed.

### Required implementation

- [x] At the start of `catch`, return if the captured selection revision is no
  longer current. Perform this check before invalidating state or showing errors.
- [x] Retain normal failure behavior for the current selection request: show an
  actionable error and leave no prediction tied to a failed selection attempt.
- [x] Apply the revision guard for every selection target, including training X/Y,
  so obsolete failures cannot display errors for a newer interaction.
- [x] Preserve the existing guards against late successful reads and the input
  invalidation that happens when a selection action starts.

Suggested control flow:

```javascript
catch (error) {
  if (reqRev !== SELECTION_REVISIONS[targetId]) return;
  // Only the current request may invalidate state or display its error.
}
```

### Required regressions

- [x] Start a selection read and hold its synchronization pending. Type a new
  range, complete a valid new prediction, then reject the old selection read.
  The new prediction, range text, export availability, and error display remain
  unchanged.
- [x] Start two selection reads; complete the newer one, then reject the older
  one. The newer entry/cache is preserved.
- [x] Reject the currently active selection read. Its error is displayed, and
  stale prediction export remains unavailable.
- [x] An obsolete training-range selection failure does not disturb a newer fit
  or display an irrelevant error.

Acceptance: an obsolete selection request has no state or UI side effects,
whether it succeeds or fails.

## 2. Preserve identity text; shorten descriptions only

### Problem

`writeTableChunks()` currently runs every non-formula string through
`truncateForExcelCell(..., 32000)`. This includes feature names and labels, not
just descriptions. In the review, a valid 32,500-character name was changed to
31,999 characters. The exported parameter table then no longer retains the
complete name, contrary to the documented behavior.

Excel's cell text limit is 32,767 characters; 32,000 is an application choice for
descriptive text, not a reason to silently alter valid identity data.

### Required implementation

- [x] Remove blanket truncation from the generic table writer. Prepare text
  according to its meaning before it reaches the writer.
- [x] Keep feature names, outcome/class labels, model IDs, and other identity
  fields exact. Preserve their trained order and existing literal-text escaping.
- [x] Permit controlled shortening of descriptions, feature-list previews and
  explanatory summaries only, with a visible shortened/split indication.
- [x] Preserve warning detail by splitting into labeled cells/rows when practical,
  rather than silently losing warnings needed to interpret a model.
- [x] Validate text limits before queuing writes. If exact text cannot be stored
  through the supported literal-text mechanism, fail with an actionable message
  or use an explicitly lossless representation. Never silently replace it with
  a shortened identifier.
- [x] Keep intentional formulas separate from descriptive/identity text. Never
  truncate a formula and treat the shortened result as a valid calculation.
- [x] Audit all export entry points, including direct example-grid writes, to
  ensure parameter names and labels follow the same policy.

Recommended helper responsibilities:

```text
prepareDescription(text) -> bounded preview or labeled text parts
prepareIdentityText(text) -> exact literal text, or explicit validation error
prepareFormula(formula) -> unchanged valid formula, or explicit omission/error
writeTableChunks(...) -> write prepared cells without changing their meaning
```

### Required regressions

- [x] A 32,500-character feature name is exported unchanged in the parameter table.
- [x] Boundary tests preserve supported identity text near the actual Excel limit;
  over-limit input is rejected or losslessly represented, not silently truncated.
- [x] Names/labels starting with `=`, `+`, `-`, or `@` remain literal text and
  preserve their visible original value. Include apostrophes and quoted labels.
- [x] Long descriptions remain bounded or split, while exact names remain exact.
- [x] Numeric weights, feature indices, probabilities, and formulas are unchanged.

Acceptance: a reader can recover the actual feature names, labels, order, and
parameters from the export. The writer does not mutate model identity data.

## 3. Bound actual batch size

### Problem

The writer now synchronizes every 250-row chunk, which fixes the earlier
unbounded queue. However, a row-count limit does not bound serialized size.
The review submitted one 250-row probe containing 8,004,251 serialized
characters in one synchronization. Wide rows or long names/labels can create
large requests even when each individual cell is legal.

### Required implementation

- [x] Keep the 250-row maximum and add a maximum-cell and estimated UTF-8 byte
  budget per batch. Count prepared values, formula strings, number-format arrays,
  and the queued actions' overhead conservatively.
- [x] Use named policy constants and document that these are application budgets,
  not guaranteed Office platform limits. An initial conservative engineering
  policy can be 250 rows, 10,000 cells, and approximately 1 MiB of estimated
  serialized content per batch, with headroom for protocol overhead. Validate
  and adjust this policy using real-host observations; do not claim it is measured
  or universally safe merely because a mock passes.
- [x] Build the next chunk dynamically. Add rows only while every budget remains
  satisfied; do not first construct/queue an oversized fixed 250-row block.
- [x] If one wide row exceeds a budget, split it into column segments without
  changing coordinates or formula references, or fail clearly before writing
  that row. Do not truncate names, labels, rows, or columns to meet the budget.
- [x] Flush queued values and associated formatting for each chunk, then verify
  the export token again. Retain progress reporting and stop after any failure.
- [x] Route metadata, equations and example grids through budget-aware writes as
  well, or give those direct writes an equivalent explicit budget check.
- [x] Avoid quadratic serialization of large tables. Estimate incrementally and
  perform an exact check on the candidate batch before submission.

### Required regressions

- [x] Record all queued actions between synchronizations. Assert row, cell and
  estimated-byte limits for each submitted batch, including formatting.
- [x] Repeat the long-text probe from the review: it must be divided into multiple
  smaller batches and every identity value must remain unchanged.
- [x] Include Unicode, escaped quotes and backslashes. JavaScript string length
  alone is not an accurate UTF-8 byte count.
- [x] Test a wide row and an individually unrepresentable row, exercising the
  chosen segmentation/error policy without silent data loss.
- [x] Verify no duplicate, missing or reordered rows across chunk boundaries;
  formulas retain correct cell references and number formats retain their columns.
- [x] Retain the existing 600-row test and add high-feature parameter-table output.

Acceptance: each synchronization contains bounded prepared data and formatting,
not just a bounded number of rows. Successful exports remain complete and exact.

## 4. Recheck state after final synchronization

### Problem

All three export functions perform a final `await context.sync()` inside their
write block. If the model becomes stale during that final await, they do not
throw inside the block's cancellation handler. Instead, the later success check
is false and the function silently returns.

The review reproduced a weights export with no success message, no cancellation
error, and no stale/incomplete marker when the model changed during final sync.
The existing middle-batch failure handling worked in the independent probe;
preserve it while repairing the final-step path.

### Required implementation

- [x] Immediately after the final synchronization, validate the captured export
  token inside the existing inner try/catch. Throw a specific cancellation/stale
  error there when the token is no longer valid.
- [x] Apply the same rule to `writePredictions()`, `exportModelWeights()` and
  `exportNewPredictions()`. Use a shared checked-sync helper if it reduces the
  chance of omitting an await path.
- [x] On cancellation/failure after committed writes, visibly mark only the
  newly created output sheet. Distinguish an incomplete write from a fully
  written but canceled/stale result where possible.
- [x] Show an actionable message, for example: "The model/settings changed while
  exporting. This output is marked stale; export again from the current model."
- [x] Treat the status-marker write as best effort: if it also fails, report that
  the output may be incomplete/unmarked. Preserve the original error; do not
  claim a marker was successfully written without successful synchronization.
- [x] Show success only after the checked final synchronization succeeds. Do not
  attempt to roll back already submitted Office operations or delete source data.
- [x] Ensure old catch/finally handlers do not overwrite a newer operation's
  progress message, error, or enabled/disabled state.

### Required end-to-end regressions

Test the actual three export entry points with a recording Office mock:

- [x] Change model/settings/backend during final sync. Verify an explicit error,
  no success notification, and a stale/incomplete status on the new sheet.
- [x] Reject a middle-batch synchronization. Verify later batches stop and the
  actual export function writes and synchronizes the incomplete marker.
- [x] Reject the final synchronization. Verify failure is reported and the new
  sheet is marked when the host still permits a status write.
- [x] Make the marker synchronization fail too. Verify the user is warned that
  the sheet could not be labeled, with no false success or swallowed root cause.
- [x] Successful export still produces the expected model, threshold, parameters,
  rows and formulas, and leaves the source workbook data unchanged.

Important test correction: the existing test titled
`writeTableChunks aborts mid-export when token invalidated and marks partial sheet incomplete`
only asserts that the helper throws. Rename it to describe what it verifies,
and add separate tests that actually assert the output sheet's status cell.

Acceptance: every export ends with a visible, truthful completed, failed,
incomplete, or stale outcome. Final-await cancellation cannot silently disappear.

## Verification and handoff

Run from the project root after implementation:

```bash
PYTHONPATH=backend backend/.venv/bin/python -m unittest discover -s backend/tests -v
npm --prefix addin test
node --check addin/src/taskpane/taskpane.js
node --check addin/src/taskpane/range-input.js
PYTHONPATH=backend backend/.venv/bin/python backend/test_api.py
PYTHONPATH=backend backend/.venv/bin/python backend/evaluate_real_data.py
npm --prefix addin run validate
```

- [x] Repeat the backend suite with sklearn, SciPy and statsmodels imports blocked
  in an isolated process. No running user's model needs to be replaced for tests.
- [x] Record actual commands, outputs and test counts. Tests added for these
  repairs must catch the reviewed failures, not merely assert that calls return.
- [x] Preserve existing preflight, exact-header, pagination/search, numerical
  conversion, fixed-formula, split, and threshold regressions.
- [x] Update the README and handoff report: identify actual batch budgets and
  exact-text behavior, and remove unsupported guarantees such as "eliminating
  memory spikes" without real workload measurements.
- [x] Record actual host measurements if performed: rows, features, settings,
  batch bytes, elapsed time, and observed failures. Arithmetic limits alone do
  not demonstrate high-dimensional performance.
- [x] Keep live Excel checks and unavailable remote validation marked pending or
  blocked rather than claiming complete release verification.

### Live Excel checks still required

Use a copy of the sample workbook and the existing HTTPS startup/sideload flow.

- [ ] Train 400 rows at 80/20: train=320, test=80, confusion total=80.
- [ ] Verify named ranges, another-sheet prediction and parameter navigation.
- [ ] Export the three-feature example and verify actual Excel recalculation.
- [ ] Verify supported long identity text and literal-text escaping in real cells.
- [ ] Exercise changed settings during an export; inspect its resulting status.
- [ ] Observe bounded export performance with representative large parameters/
  long-text data. Do not assume the 12,288-feature image workflow is production-ready.

## Definition of done

All four reviewed defects have meaningful regression coverage and are repaired;
the existing suites, syntax and smoke/benchmark checks pass; original model
identity/numeric values are preserved; actual export functions handle failure and
cancellation visibly; and batch budgets are enforced and accurately documented.

This establishes code-repair completion. Full release verification additionally
requires the critical live Excel checks and supported-workload measurements.
Do not call the project fully verified while those checks remain pending.

Reference for Excel text/formula limits:
https://support.microsoft.com/en-us/excel/excel-specifications-and-limits
