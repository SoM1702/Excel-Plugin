# Project change timeline

This is the consolidated maintenance history. Git commit dates are authoritative for committed milestones; review dates below identify verification sessions, not separate releases. Current source baseline: `09ae4fb` (23 October 2026).

## 28 October 2026 — teammate handoff and documentation cleanup

- Consolidated completed implementation and repair plans into this timeline.
- Removed 14 superseded plan files; their complete contents remain recoverable from commit `09ae4fb` in the GitHub repository.
- Added `TEAMMATE_START_HERE.md` with installation, startup, verification, and collaboration instructions.
- Corrected deployment instructions for the current four-argument bundle builder, exact-origin CORS, and temporary multi-model registry.
- Retained `docs/HYBRID_PUBLIC_DEPLOYMENT_PLAN.md` as the active roadmap and the dated reviews as historical evidence.
- Prepared a source ZIP containing the current working files. Git history, installed dependencies, certificates, secrets, caches, generated outputs, and Excel lock files are excluded. Dependencies must be installed on the receiving computer.
- Packaging verification on this date: 113 backend tests and 119 frontend tests passed; `git diff --check` passed. No live Excel or hosted acceptance was performed during packaging.

## 23 October 2026 — validation, prediction and deployment foundation

Commit: `09ae4fb` — Fix data validation, prediction edge cases, and deployment checks.

### Data correctness

- Parse percentage text in fractional units: `50%` becomes `0.5`.
- Reject malformed signed numbers, repeated currency symbols and malformed percentages.
- Use consistent normalised header identity in profiling, training and scoring; reject ambiguous headers and outcome names.
- Preserve literal `_missing_` and escaped-looking category names independently from actual blank cells, including what-if selection and serialized preprocessing.
- Make prediction warnings request-local so concurrent scoring cannot exchange unknown-category warnings.
- Return actionable validation responses for numerical prediction overflow while preserving a usable model.

### Excel behaviour and explanations

- Apply the manual what-if limit to source inputs in table mode, allowing categorical expansion beyond 25 generated features.
- Show encoded values, scaled values, coefficients, contributions, intercept, score and probability in a checked mathematical explanation.
- Report an unavailable explanation instead of showing fabricated arithmetic when explanation validation fails.
- Improve metadata exports and the mentor demonstration documentation.

### Deployment foundation

- Replace the single latest model with a bounded, process-local registry holding multiple models, with expiry and least-recently-used eviction.
- Configure exact HTTPS CORS origins through `CORS_ALLOWED_ORIGINS`.
- Generate a hosted static bundle, production manifest and runtime backend URL without changing localhost source configuration.
- Escape XML and use literal replacements for provider names and URLs.
- Add a manifest validator that fails when the external validation service cannot be reached.
- Add GitHub CI for backend/frontend tests and manifest checks; pin direct Python dependencies and tighten Docker exclusions.
- Exclude local environment files and Excel lock files from source control.

Verification history: the 18 October review passed 101 Python and 107 JavaScript tests but identified seven additional defects. The first 19 October recheck passed 112/117 and found two remaining edge cases. The final focused recheck passed **113 backend and 119 frontend tests**, with malformed-number and literal-category fixes verified. These counts describe those sessions; they do not establish hosted or live Excel acceptance.

## 15 October 2026 — table missingness and source row reporting

Commit: `c4314a2` — Fix table missing categories and Excel row errors.

- Reserve a categorical missing bucket even when training rows have no blanks.
- Distinguish reference, missing and unknown category behaviour.
- Report original worksheet row positions in training, held-out and cross-validation validation errors.
- Later category-identity edge cases were completed in `09ae4fb`.

## 14 October 2026 — scratch engine and general table workflow

Commit: `c66aafb` — Add scratch logistic regression and Excel table mode.

- Implement stable sigmoid, binary cross-entropy, analytical gradients and full-batch gradient descent using NumPy, with no sklearn model or library optimiser.
- Add learning rate, iteration cap, convergence tolerance, L2 penalty and balanced class weights; record loss history and convergence diagnostics.
- Implement standardisation, stratified splitting, training-side cross-validation, ROC/AUC and classification metrics from scratch.
- Link train/test percentage inputs and tune the suggested threshold using training-side out-of-fold predictions.
- Add table profiling, nonadjacent feature selection, numeric/boolean/categorical preparation and training-only missing-value handling.
- Add cell-address and named-range resolution with source snapshots and dimension preflight checks.
- Support new-row prediction, class mapping, worked single-row predictions and original-unit/model-space coefficient exports.
- Protect stale requests and exports; preserve literal cell text; bound export batches by rows, cells and bytes; support parameter search and pagination.
- Add numerical, API, preprocessing, range-resolution and task-pane tests, along with equations and evaluation documentation.

## 12 October 2026 — preserved original prototype

Commit: `b55c696` — baseline: preserve initial state before scratch logistic regression implementation.

- Preserved the earlier Excel/Office.js and Python service prototype before the faculty-directed scratch implementation.
- This is the earliest commit in the current repository history, not necessarily the project's actual start date.

## Current maintenance boundaries and unfinished work

- The product handles suitable tabular binary-classification inputs. It does not automatically support arbitrary images, free text, multiclass targets or every Excel value type.
- Authentication, per-user ownership, durable shared model storage, backend resource limits, public hosting and distribution remain active roadmap work.
- Models are currently temporary and disappear on restart or expiry; multiple workers do not share this registry.
- The current model is fitted on the training partition; exported training-row predictions are not held-out evaluation.
- Official manifest acceptance, clean container execution, large-data benchmarks, and live Excel acceptance across hosts require separate verification. Earlier automated pass counts do not substitute for those checks.
- A supplied-weight calculator and automatic training-size comparison were discussed but have not been implemented.

## How to maintain this file

Add a dated entry when a meaningful change is completed. Record what changed, the relevant commit once available, actual checks performed, and remaining limitations. Use the active deployment roadmap for future work rather than creating another duplicate completed-plan document.

## Recovery of removed plans

The shared ZIP has no `.git` history. Use the GitHub repository or a clone to retrieve an old document, for example:

```bash
git show 09ae4fb:SCRATCH_IMPLEMENTATION_PLAN.md
```

Removed documents: CATEGORY_IDENTITY_REPAIR_PLAN.md, FOLLOW_UP_REPAIR_PLAN.md, GENERAL_TABULAR_DATA_IMPLEMENTATION_PLAN.md, IMPLEMENTATION_PLAN.md, NAMED_RANGE_IMPLEMENTATION_PLAN.md, PUBLIC_DEPLOYMENT_IMPLEMENTATION_PLAN.md, REMAINING_REPAIRS_PLAN.md, REPAIR_IMPLEMENTATION_PLAN.md, SCRATCH_IMPLEMENTATION_PLAN.md, TABLE_MODE_FOLLOWUP_REPAIR_PLAN.md, TABLE_MODE_REPAIR_PLAN.md, WEIGHTS_AND_EQUATION_IMPLEMENTATION_PLAN.md, WHAT_IF_AND_DEMO_HANDOFF_IMPLEMENTATION_PLAN.md, WHAT_IF_HANDOFF_FOLLOWUP_REPAIR_PLAN.md.
