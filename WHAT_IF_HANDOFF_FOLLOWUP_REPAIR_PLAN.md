# Follow-up repair plan: What-if explanation and demo evidence

Review date: 2026-10-15. The 25-input limit fix and feature-level explanation are implemented, and automated suites pass (93 backend; 99 add-in). The issues below remain. Do not change the scratch fitting algorithm.

## P1 — never display a fabricated arithmetic breakdown

Files: `backend/main.py`, `addin/src/taskpane/taskpane.js`, `addin/tests/taskpane.test.js`, `backend/tests/test_table_api.py`.

The `/predict-table` endpoint catches every explanation exception and silently returns a successful probability without `explanation` (`backend/main.py`, after `explanation = None`). The task pane then falls back to a table of source values, but leaves the headers `Scaled x̂` and `Weight w` in place; it writes type names under scaled values and dashes under weights. Worse, it renders `Σ(w·x̂) = 0.0000` and `b = 0.0000` even when the backend score is nonzero (`addin/src/taskpane/taskpane.js`, `runWhatIf`). This recreates the misleading-math problem in a failure path.

Implement one consistent policy:

1. When an explanation is requested for a single-row What-if call, return a clear API error if explanation computation fails, or return a structured `explanation_unavailable` reason while preserving the prediction. Do not silently swallow the cause.
2. In the task pane, if explanation is absent, invalid, or does not match the response score/probability, show the probability and a plain **Explanation unavailable** message only. Hide the feature-contribution table and arithmetic steps. Never substitute zero contributions or zero intercept. The existing UI must not claim a worked calculation in this state.
3. Validate the explanation contract before rendering: feature count/order match the active model, all numeric fields are finite, sum of contributions plus intercept agrees with returned score, and sigmoid of score agrees with returned probability (tolerance `1e-6`). A `math_valid: true` flag alone is not sufficient because the client receives independent response fields.
4. Preserve correct numeric-mode breakdown and stale/asynchronous request protection.

Tests: mock a table prediction with missing explanation, an explanation exception in the backend, `math_valid: false`, score mismatch, probability mismatch, and a valid explanation. Assert no false contribution table or `Σ=0` appears in any failure case.

## P2 — correct the mentor checklist and evidence labels

Files: `MENTOR_PRESENTATION_GUIDE.md`, `docs/EVALUATION.md`, `README.md`.

1. The checklist currently says inspect `titanic!$A$1:$I$892` and flag `alive`. On the original Titanic table, `alive` is outside that range; the photographed fit used `titanic!$A$1:$O$892`. Change the checklist range to the actual inspected range, or state that the leakage check uses the full table and the selected features are a subset.
2. Mark checks as **Observed in live Excel**, **Covered by automated test**, or **Not yet manually verified** without collapsing these into a generic PASS. In particular, do not claim live batch-vs-What-if equality or new explanation UI behavior from the earlier screenshots; those were not shown. Retain the observed training/export metrics as evidence of the earlier version.
3. Remove machine-specific `file://` links from `README.md` and use repository-relative Markdown links so GitHub readers can open the referenced docs.
4. Keep the statement of input support precise: the current table pipeline handles supported scalar numeric, boolean, and low-cardinality categorical columns with documented missing/unknown policies; it does not imply all Excel data types or images are supported.

Acceptance: a teammate can follow the guide on a fresh clone, the specified range contains the columns described, links work on GitHub, and every claimed manual pass has an actual recorded observation.

## Verification

From `backend/`, run `.venv/bin/python -m unittest discover -s tests -q`; from `addin/`, run `npm test`. Run `git diff --check`. Then perform one live Excel table-mode What-if test with the new explanation UI, one unavailable-explanation failure test in automated UI tests, and one batch-vs-What-if comparison. Record the result rather than assuming unit tests prove the live Excel path.
