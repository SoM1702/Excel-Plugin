# Implementation plan: What-if UI and mentor-demo handoff

Scope: fix the two confirmed table-mode What-if UI defects, then update project documentation and test evidence. Do not change the scratch logistic-regression training algorithm, add scikit-learn, or expand into public deployment or image datasets in this work package. Preserve existing numeric-mode behavior.

## 1. Fix inconsistent 25-input limit (P1)

Files: `addin/src/taskpane/taskpane.js`, `addin/tests/taskpane.test.js`, `README.md`.

Current behavior: `buildWhatIf` allows up to 25 **source columns** in table mode, but `setModelActionsEnabled` and `runWhatIf`'s `finally` block disable the button when there are more than 25 **generated model features**. A categorical column can generate several model features, so the form can be visible while Calculate probability is disabled.

Implementation:

1. Add one small helper, e.g. `manualWhatIfInputCount(result)`, returning `result.table_metadata.column_specs.length` in table mode and `result.feature_names.length` in numeric mode. Handle missing result/metadata safely.
2. Use it in all three enable/disable decisions: `buildWhatIf`, `setModelActionsEnabled`, and `runWhatIf` cleanup. Keep the existing 25-manual-input UX limit; do not limit table mode by encoded feature count.
3. If disabled, display the reason next to the button and direct the user to **Score new rows**. The reason should say source columns or numeric features as appropriate. A stale model must remain disabled regardless of count.
4. Update the README workload-limit wording to distinguish source-column inputs in table mode from feature inputs in numeric mode.

Acceptance tests:

- Table mode: 14 source columns that expand to more than 25 encoded features render 14 controls and leave Calculate probability enabled after fitting and after a completed calculation.
- Table mode: 26 source columns disable manual calculation and show guidance; batch scoring remains available.
- Numeric mode: 25 inputs work, 26 do not. A stale model stays disabled in either mode.
- Change an input while a request is in flight; the existing stale-response protections still reject the old answer.

## 2. Make the table-mode prediction explanation truthful (P1 for mentor demo)

Files: `addin/src/taskpane/taskpane.html`, `addin/src/taskpane/taskpane.js`, `addin/tests/taskpane.test.js`; optionally `backend/model.py`, `backend/main.py`, `backend/tests/test_table_api.py` if exact feature-level contributions are returned by the backend.

Current behavior: the table headed `Scaled x̂` displays type names such as `numeric`; `Weight w` displays imputation medians or reference categories; the contribution column is a dash. The probability and score come from `/predict-table`, but the displayed table is not a mathematical contribution breakdown.

Preferred implementation:

1. For one-row table predictions, obtain the **actual transformed feature vector in model order** from the fitted preprocessor, together with the model-space vector after standardisation. Either return an optional `explanation` from `/predict-table` for one-row requests or add a separate explanation path that uses the same stored model; do not duplicate preprocessing logic in JavaScript.
2. For each generated feature show: feature name, encoded/raw numeric value, scaled value (if standardised), learned model-space weight, and `scaled value × weight`. Show the intercept separately. These are model-space quantities; do not mix original-unit weights with scaled inputs.
3. Check that `sum(contributions) + intercept` equals the backend's linear score within a small tolerance (e.g. `1e-6`). If it does not, show an explicit unavailable/error message rather than a misleading breakdown. The sigmoid of that score must equal the returned probability within tolerance.
4. Show missing numeric imputation and categorical reference/missing-bucket choices in a separate preparation note. Never place `med: 3` under `Weight w` or `numeric` under `Scaled x̂`.
5. For very wide models, show a bounded/paged explanation while retaining the complete score and all feature contributions in the returned result; do not silently omit terms from the displayed sum.

If feature-level explanation is too large for this iteration, the minimum safe fix is to relabel the table as **Input preparation**, change the columns to `Source column / Entered value / Type / Preparation`, remove the false weight/contribution columns, and state that the score is computed by the backend. Do not claim it is a worked weight calculation until the preferred implementation exists.

Acceptance tests:

- Numeric, categorical, boolean, missing numeric, and missing-category inputs produce correct encoded/scaled values.
- A passenger scored in What-if matches the same raw row in batch prediction.
- Displayed contributions plus intercept reproduce the score, including a standardised run and a no-standardisation run.
- The old numeric-mode explanation remains correct.

## 3. Bring README and demo evidence up to date (P2)

Files: `README.md`, `docs/EVALUATION.md`, `MENTOR_PRESENTATION_GUIDE.md`, and optionally a concise manual-test record in `docs/`.

1. Replace hard-coded old test counts (currently 81 backend and 91 add-in in README) with either current verified counts or, preferably, commands without brittle counts. Document the exact local start commands, the default table-mode workflow, and the difference between source columns and generated features.
2. Document the completed Titanic live result as observed evidence, not a universal benchmark: original table, 891 usable rows, 623 train/268 test, convergence, held-out accuracy at 0.50 of 0.817 and AUC 0.886, with `alive` excluded. Note that the photographed run selected `pclass`, `sex`, `age`, `sibsp`, `parch`, and `fare` (not `embarked`), and that changing features/settings changes metrics.
3. Add a short mentor demo script: inspect mixed table → select Y and X while explaining leakage → choose split → train → read held-out metrics and baseline → inspect equation/weights → score one new row → export report. State the limitations honestly: no causal claims, p-values unavailable, model is in memory, public multi-user deployment and image-scale data remain future work.
4. Make the manual test checklist explicit: sample workbook, original Titanic table, batch-vs-What-if equality, export integrity, stale-header rejection, invalid-cell errors, and backend-offline handling. Record pass/fail, settings, date, and screenshots; do not mark an unrun check as passed.
5. Keep generated `outputs/` files out of Git unless deliberately selected and checked for sharing rights/privacy. Do not copy misleading older numeric-only instructions into the current Table Mode guide.

## Verification and completion criteria

Run `backend/.venv/bin/python -m unittest discover -s tests -q` from `backend/` and `npm test` from `addin/`. Run `git diff --check`. Then sideload into Excel and repeat the original Titanic run and a single-row/batch probability comparison. Inspect the What-if table visually at normal task-pane width. Record any manifest-validation limitation rather than calling it passed if the service is unreachable.

Complete this work package only when both UI defects are fixed, their regression tests pass, the docs match the actual product, and the live Excel checklist has recorded evidence. Deployment/public packaging and image data are separate follow-up projects.
