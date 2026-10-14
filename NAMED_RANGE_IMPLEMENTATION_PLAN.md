
# Excel named ranges as X/Y inputs — implementation plan

Status: implemented.

## User outcome

A user can name a rectangular block of Excel cells `CustomerFeatures` (or
`Matrix`) and enter that name in the X field. They can name the outcome column
`ChurnOutcome` and enter it in Y. Ordinary cell addresses and Use selection
continue to work. The same feature applies to the new-row prediction input.

Example using the existing sample, with headers included:

| Input | Excel name | Refers to |
|---|---|---|
| X | CustomerFeatures | churn_data!$A$1:$I$401 |
| Y | ChurnOutcome | churn_data!$J$1:$J$401 |
| New X | NewCustomers | A separate feature-only range in trained column order |

These are Excel defined names referring to worksheet cells, not mathematical
objects typed into the field. A name can be chosen freely subject to Excel's
own naming rules. Each selected X block remains a rows-by-features matrix;
each Y block remains one column. Named ranges do not change the model equations.

## Current code and compatibility

`getRangeByAddress(context, address)` in `taskpane.js` currently splits an
optional worksheet prefix, then calls `sheet.getRange(rangeAddress)`. Microsoft
documents that `Worksheet.getRange` accepts an address or a name, so some simple
named ranges may already work. The current implementation does not explicitly
identify names, explain their scopes, or preserve their definitions in snapshots.
Do not claim every named input currently fails without a live reproduction.

References:

- Worksheet.getRange: https://learn.microsoft.com/en-us/javascript/api/excel/excel.worksheet?view=excel-js-1.4
- NamedItem: https://learn.microsoft.com/en-us/javascript/api/excel/excel.nameditem?view=excel-js-1.4
- NamedItemCollection: https://learn.microsoft.com/en-us/javascript/api/excel/excel.nameditemcollection?view=excel-js-1.4

Name lookup/type/scope inspection requires queued Office.js loads followed by
`context.sync()`. `NamedItem.getRange()` throws when a defined name is not a
range. The documentation's example also notes workbook-scoped limitations;
verify worksheet-local resolution through the documented Worksheet range API
on the target Excel host rather than assuming workbook/local behaviour matches.

## Supported inputs and resolution policy

Support these inputs in the first release:

- Workbook-defined range name: `CustomerFeatures` or `Matrix`.
- Worksheet-defined range name on the current worksheet: `LocalFeatures`.
- Explicit local name: `Sheet1!LocalFeatures` or `'Customer Data'!LocalFeatures`.
- Worksheet-qualified address: `churn_data!A1:I401`.
- Address on the worksheet captured when reading starts: `A1:I401`.
- Absolute cell addresses such as `$A$1:$I$401`.

Trim surrounding whitespace, keep user spelling for display, and use Excel's
name matching rather than creating a separate case-sensitive namespace.

For an unqualified name, use the active worksheet's local name first, then the
workbook name. Show the selected scope and resolved cells in the preview so a
local name shadowing a workbook name is visible. Do not silently search unrelated
worksheets for a matching local name. Suggest a worksheet qualifier if needed.
An explicit worksheet-qualified name searches that worksheet's local collection;
the workbook-wide alternative can be entered unqualified where not shadowed.

First-release inputs must resolve to one nonempty rectangular worksheet range
in the current workbook. Provide a specific unsupported-input error for unions,
external-workbook references, literal arrays, named constants and scalar formulas.
Existing formula-defined names that Excel resolves to an actual single range may
be accepted, but typed expressions such as `=OFFSET(...)` are not evaluated by
the add-in. Excel table/structured references are a separate future extension.

## Phase 1 — build one shared resolver

Add `addin/src/taskpane/range-input.js` as a small plain-JavaScript helper loaded
before `taskpane.js`. It exposes a resolver for addresses and defined names.
Avoid adding a frontend framework or a Python name-resolution service.

- [x] Define `resolveRangeInput(context, input, options)` as asynchronous, since
  inspecting names and their properties requires Office.js synchronization.
- [x] Capture the active worksheet ID once for unqualified input, then use it
  throughout the read rather than repeatedly consulting the active sheet.
- [x] Parse optional worksheet qualifiers with quoted names and escaped
  apostrophes. Preserve existing absolute/relative A1 address support.
- [x] Use actual workbook/worksheet name collections to find defined names,
  inspect their type, and resolve the corresponding Range through supported
  APIs. Do not extract arbitrary formula text and evaluate it ourselves.
- [x] Validate that the resolved object is one rectangle and load values,
  address, worksheet ID/name, row/column indices and counts.
- [x] Return both the resolved range and a serializable reference descriptor:
  original text, kind (address/name), canonical name, scope, scope worksheet ID,
  resolved worksheet ID/name, absolute address, indices and dimensions.
- [x] Keep Office.js proxy objects inside their Excel.run context. Only copy
  loaded values and plain descriptors out of it.
- [x] Translate missing name, missing worksheet, wrong named-item type,
  broken definition (#REF!), unsupported range and permission errors into
  readable messages identifying X, Y, or New X.
- [x] Check the Excel API requirement level for named-item scope/lookups on
  startup. Use a clear feature-availability message when unsupported; review
  whether manifest requirements need updating based on the chosen APIs.

Acceptance: addresses and defined names resolve through the same interface,
scope selection is deterministic, and the resolver identifies actual cells
without modifying the workbook or its names.

## Phase 2 — integrate training and new-row scoring

Update the callers in `addin/src/taskpane/taskpane.js`:

- [x] `readTrainingData`: await resolution of both inputs within Excel.run,
  copy values/metadata, then use the existing numerical and label validators.
- [x] Retain the existing same-worksheet, aligned-row, one-Y-column and
  non-overlap rules. Check actual resolved geometry rather than input strings.
- [x] `readNewFeatureData`: use the same resolver; preserve trained feature
  count, header ordering and prediction-mode validation (including one row).
- [x] Handle each field independently: X can be a name while Y is an address,
  or the reverse.
- [x] Keep header selection explicit. Names do not tell us whether row 1 is a
  header; do not silently drop or infer that row.
- [x] Keep Use selection available. It may continue placing the actual address
  in the field rather than guessing which of several names refers to selection.
- [x] Capture reference inputs and settings before asynchronous work. Invalidate
  affected requests/actions when fields or header settings change.

Acceptance: the same cells/settings selected by addresses or by names produce
identical feature/outcome arrays, row counts and probabilities. Model IDs and
timestamps need not match between separate runs.

## Phase 3 — make name resolution visible

Update `taskpane.html`, `taskpane.js`, and small supporting CSS:

- [x] Change field help to “Cell range or Excel named range”. Use examples
  `CustomerFeatures or churn_data!A1:I401` and `ChurnOutcome or churn_data!J1:J401`
  so examples match the checked header option.
- [x] Show a resolution preview before sending training data, for example:
  `X: CustomerFeatures (Workbook) -> churn_data!$A$1:$I$401; 400 data rows, 9 features`.
- [x] Preserve the actual multirow value preview; render names, addresses and
  labels as text nodes.
- [x] Explain how to create names in Excel through the Name Box or Name Manager.
  Recommend workbook scope for the simplest usage across sheets.
- [x] Show source-resolution errors in place of an obscure Office.js error.

An optional dropdown of defined ranges is a later convenience, not a required
part of the initial implementation. Do not automatically create or rename Excel
names as part of this feature.

## Phase 4 — preserve snapshot and export correctness

Named ranges may be renamed, deleted, expanded or redirected after a fit.
Saved cell addresses alone cannot identify these definition changes.

- [x] Store the reference descriptor and exact structured value snapshot for
  each training source and new-row source. Do not rely on the existing lossy
  32-bit fingerprint for correctness.
- [x] Before export, resolve a named source again using its stored scope and
  worksheet identity, not the currently active worksheet.
- [x] Compare resolved worksheet ID, geometry and values with the scoring/fit
  snapshot. Reject a deleted, broken, retargeted or resized name even when the
  new cells happen to contain identical values.
- [x] Block export with “The named range changed. Fit/score again.” when the
  corresponding source association is no longer valid.
- [x] Keep new-row changes separate from training-model validity: editing the
  new-row source requires rescoring, not necessarily retraining the classifier.
- [x] Apply request/model revision guards across asynchronous verification and
  writing so changing sources during export cannot produce a mixed report.
- [x] Export original input text, canonical name/scope and resolved absolute
  address alongside the existing model settings and source-row references.

Acceptance: switching the active sheet alone cannot change a saved source.
Editing either values or a name's target prevents use of stale row predictions.

## Files to change

| File | Purpose |
|---|---|
| `addin/src/taskpane/range-input.js` (new) | Shared asynchronous resolver and reference descriptors |
| `addin/src/taskpane/taskpane.js` | Resolver callers, preview, source snapshots and export verification |
| `addin/src/taskpane/taskpane.html` | Examples/help and loading the helper before taskpane.js |
| `addin/src/taskpane/taskpane.css` | Readable resolution preview within the task pane |
| `addin/tests/range-input.test.js` (new) | Office.js resolution mocks covering lookup, scopes and errors |
| `addin/tests/taskpane.test.js` | Load the helper and exercise training/scoring/export callers |
| `addin/manifest.xml` (if required) | API capability declaration consistent with host support |
| `README.md`, `PROJECT_EXPLAINED.md`, `MENTOR_PRESENTATION_GUIDE.md` | Named-range creation, examples, limitations and demonstration |

No backend model/API changes are required for name resolution. The frontend
still sends the resolved numerical X array and Y label array to /train or
feature rows to /predict. Do not mix this feature with unrelated scratch-engine
repairs, although the source-snapshot protections above belong to this feature.

## Verification

Automated checks:

- [x] Existing qualified, unqualified and absolute addresses still work.
- [x] Workbook names resolve even when another worksheet is active.
- [x] Local names and explicit qualified local names follow the documented scope
  policy; duplicate global/local names show the selected scope.
- [x] Names differing only by case are resolved consistently with Excel.
- [x] Quoted worksheet names and embedded apostrophes work.
- [x] Missing names, constants, formulas returning scalars, errors, external
  references and disconnected areas fail with actionable messages.
- [x] Resolved names still enforce matching rows, one Y column, numeric values,
  binary outcomes and non-overlap.
- [x] Header and no-header names preserve the first actual data row correctly.
- [x] Named and address inputs for identical cells submit identical arrays.
- [x] New-row named ranges support a single row, repeated rows and feature schema
  checks without retraining.
- [x] Renamed/deleted/retargeted/resized named sources and edited values invalidate
  stale exports. Changes to the active sheet do not.
- [x] Deferred responses and exports cannot revive invalid sources.
- [x] Export records the name, scope, resolved address and correct source rows.

Live Excel acceptance (record separately from mocked tests):

1. Open a copy of the unchanged sample workbook. Name A1:I401
   `CustomerFeatures` and J1:J401 `ChurnOutcome` with workbook scope.
2. Enter these names into X/Y, keep headers checked, and fit using existing
   defaults. Confirm 400 usable rows, nine features and correct value preview.
3. Repeat with the equivalent cell addresses and compare arrays/probabilities.
4. Switch to another worksheet and repeat with the workbook names.
5. Create worksheet-local names and verify scope, quoting and resolution errors.
6. Score a named new-feature block and export to a new sheet.
7. Change a defined name's target through Name Manager and verify that export is
   refused until the corresponding data is fitted/scored again.
8. Inspect the exported name/scope/address/row references.

Completion requires these checks to pass and the existing address workflow to
remain usable. Until then, label this feature implemented or tested only to the
extent supported by actual evidence.
