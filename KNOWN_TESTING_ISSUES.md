# Known issues found during live Excel testing

Historical record: the two issues below were addressed in the changes included in `09ae4fb`, with later automated regression checks passing. They are retained as reproduction history, not a list of currently open defects. See [CHANGELOG.md](CHANGELOG.md) for current status and remaining verification.

## Table-mode What-if button can be disabled incorrectly

Observed 2026-10-15 in the original Titanic table workflow: the single-row What-if form rendered source-column inputs, but **Calculate probability** was disabled.

Cause: `buildWhatIf` in `addin/src/taskpane/taskpane.js` permits up to 25 source columns in table mode, while `setModelActionsEnabled` and the `runWhatIf` cleanup path disable the button when the number of generated/encoded model features exceeds 25. Categorical source columns may expand into several model features, so these checks disagree.

Expected: in table mode, all button-enable checks use the number of source-column inputs (`table_metadata.column_specs.length`); in numeric mode, they use the number of feature inputs. The intentionally imposed 25-input manual-form limit remains. When disabled, the UI should state why and direct the user to **Score new rows**.

Repair: update both later checks in `addin/src/taskpane/taskpane.js` to use a shared helper for the correct mode-specific count. Add a task-pane test where fewer than 25 source columns produce more than 25 encoded features and the button remains enabled, plus a test where more than 25 source columns are blocked with guidance. Do not change model training or the 25-input UX limit.

Temporary workaround: select only `pclass`, `sex`, `age`, `sibsp`, `parch`, `fare`, and `embarked`, then refit. Exclude `alive` from X because it directly reveals `survived`.

## Table-mode What-if breakdown labels do not match their values

Observed 2026-10-15 after a successful Titanic run: the calculator returned a probability and linear score, but its table headed `Scaled x̂` contained type names such as `numeric`, and its table headed `Weight w` contained text such as `med: 3` or `ref: male`. These are not scaled inputs or learned weights. The raw-score calculation comes from `/predict-table`; this is a display/interpretation defect, not evidence that the probability is wrong.

Repair: in `addin/src/taskpane/taskpane.js` `runWhatIf`, either render the actual encoded feature values, scaling, model-space weights, and contributions (using the fitted preprocessing contract) or change the table headers and title to accurately describe the source inputs, types, reference categories, and imputation defaults. Do not label a median as a weight. Add a table-mode UI test that checks header/cell meaning and that displayed contributions, if present, sum with the intercept to the returned score.
