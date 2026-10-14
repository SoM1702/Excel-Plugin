# Learned weights, model equation and worked predictions — implementation plan

Status: completed; all phases implemented and verified with 100% test pass rate.

## From-scratch constraint

The mentor-facing feature must use our existing handwritten gradient-descent
engine. Read w and b from that engine's learned state; implement parameter
conversion, contribution calculations and score/probability explanations
directly. Do not call sklearn, statsmodels, a library optimiser, an external
coefficient estimator, or a third-party model-explanation function.

The existing engine uses NumPy for elementary array arithmetic. That is an
external numerical dependency, even though the learning algorithm is our own.
Do not describe the project as using no external functions whatsoever. If the
mentor's restriction also includes NumPy or elementary numerical helpers, that
would require a separate rewrite of the current numerical engine and must be
established before claiming compliance with that stronger restriction.

Any optional Excel formula example checks the exported parameters; it does not
fit the model or replace the from-scratch backend prediction calculation.

## Interpretation of the mentor's request

The likely requirement is to expose all fitted coefficients and the intercept,
write them into Excel, and demonstrate how they produce a prediction for a new
input row. The remembered equation is the linear score:

```text
z = w1*x1 + w2*x2 + w3*x3 + b
```

For logistic regression, finish the prediction with:

```text
p = 1 / (1 + exp(-z))
predicted_class = 1 if p >= threshold else 0
```

The mentor may have used y informally for the score. Do not silently replace
logistic regression with linear regression. If he explicitly requests a
continuous-outcome linear-regression mode, plan that separately.

There is one weight per feature column, not one weight per data row. Three
features mean three weights plus b; the existing nine-feature sample means
nine weights plus b; 400 customers do not mean 400 weights. If the mentor meant
three observations of a single feature, there is only one weight plus b.

Use a clearly labelled illustrative calculation in the guide:

```text
w = [0.6, -0.3, 0.2], b = -0.4
x = [2, 1, 3]
z = 0.6*2 - 0.3*1 + 0.2*3 - 0.4 = 1.1
p = sigmoid(1.1) approximately 0.75026
at threshold 0.50, predicted class = 1
```

These numbers are for learning, not reported results from the current dataset.

## Current implementation and gap

The project already displays a coefficient table and exports coefficients and
scaling statistics in the main report. It also has what-if prediction. The
remaining work is to make parameter identity/units explicit, preserve sufficient
precision, print a usable equation, and expose a trace of the calculation.

Currently, `backend/model.py` rounds fitted coefficients to six decimal places
and means/scales to six decimals before returning them. The frontend presents
weights with three decimals. Those displayed/exported values must not be used
as an exact model specification.

The current weights belong to standardized feature units when standardization
is enabled. Directly multiplying those weights by original Excel values is
incorrect. Named input ranges still represent the same feature columns and do
not change this rule.

## Phase 1 — return an exact, clearly labelled parameter specification

Files: `backend/model.py`, `backend/main.py`; use learned parameters from
`backend/logistic_scratch.py` and `backend/preprocessing.py`.

- [x] Return the actual fitted weight vector and bias as finite full-precision
  floats, in the same feature order used for training and prediction.
- [x] Include feature names, model ID, positive/negative label mapping, whether
  scaling was applied, and the exact fitted means/scales.
- [x] Add a dedicated `parameters` response object rather than requiring callers
  to infer bias/weights from rounded display rows. Suggested fields:

```text
feature_names
feature_space: standardized | original
weights_model_space
intercept_model_space
weights_original_units
intercept_original_units
feature_means
feature_scales
```

- [x] Preserve full usable precision in the existing coefficient/scaling response
  fields too; perform rounding only in UI text and Excel number formatting.
- [x] Convert fitted standardized parameters into an equivalent original-unit
  equation using the exact fitted preprocessing data:

```text
x_scaled_j = (x_j - mean_j) / scale_j
w_original_j = w_model_j / scale_j
b_original = b_model - sum_j(w_model_j * mean_j / scale_j)
```

- [x] When standardization is off, original-unit parameters equal fitted
  parameters. Use the scaler's actual effective scale for constant columns.
- [x] Distinguish the fitted model-space parameters from their converted
  original-unit equivalent; conversion must not change the active classifier.
- [x] Check conversion for finite values and numerical agreement. If an extreme
  conversion cannot be represented accurately, retain the valid model-space
  equation with explicit scaling rather than silently exporting an invalid
  raw equation.
- [x] Add `score` (z) to each `/predict` result, calculated with the same scaler
  and parameters used to produce its probability. Do not return an additional
  rows-by-features explanation matrix for every batch request.
- [x] Maintain prediction threshold validation and model-ID checks. Do not
  introduce retraining as part of parameter export or what-if calculation.

Acceptance: reconstructing a normal-range prediction from exported parameters
matches the retained model within documented floating-point tolerances. The
original-unit and scaled equations are equivalent within those tolerances.

## Phase 2 — show the equation and a worked prediction in the task pane

Files: `addin/src/taskpane/taskpane.html`, `taskpane.js`, `taskpane.css`.

- [x] Display the intercept explicitly as `b`, with one row per feature:
  index (`w1`, `w2`, ...), feature name, fitted weight and original-unit weight.
- [x] Label units clearly. A model-space coefficient is per training standard
  deviation when scaling is enabled; an original-unit coefficient is per unit
  of the raw Excel feature. State that coefficients express model associations.
- [x] For small feature counts, display the learned numerical score equation,
  the sigmoid equation, active threshold and class mapping. Clearly identify
  which feature units the displayed equation expects.
- [x] Integrate the existing what-if controls so users enter one value for each
  feature, and see: input values, scaled values where applicable, weight,
  contribution `w_model_j*x_scaled_j`, sum of contributions, b, z, p and class.
- [x] Use the backend's score/probability as the authoritative result and check
  the frontend explanatory calculation against it. Use full returned precision.
- [x] Moving the threshold changes the class, not the fitted weights, z or p.
- [x] Bind explanations to the current model/request and input values. Changing
  inputs invalidates the old explanation; late responses cannot update a newly
  trained model's explanation or attach results to edited inputs.
- [x] Render feature names and equations as text, not interpolated HTML.

Acceptance: the mentor can supply x1/x2/x3 for a three-feature fit, inspect all
three learned weights and b, and follow the numeric score-to-probability-to-class
calculation without reading source code.

## Phase 3 — print a complete model specification into Excel

File: `addin/src/taskpane/taskpane.js`; update task-pane controls in the HTML.

- [x] Add `Export model weights` using a uniquely named new worksheet. Extend
  the existing full report to use the same parameter-export helper.
- [x] Export every feature weight plus the intercept, in trained feature order;
  include both fitted model-space and original-unit parameters, means and
  scales. Record model ID, trained time, feature order, class mapping, settings,
  threshold and convergence state.
- [x] Write numeric cells at usable precision and apply readable number formats.
  Do not export three-/six-decimal display strings as the calculation source.
- [x] Print the equations and the unit convention. For short models, include a
  concrete numerical equation using actual learned values.
- [x] Optionally include the current worked prediction as a clearly labelled
  example, retaining its feature values, score, probability and threshold.
- [x] Support an Excel-recalculable example using a matching horizontal input
  row and horizontal weight row:

```text
score = SUMPRODUCT(input_row, original_weight_row) + original_bias_cell
probability = IF(score>=0, 1/(1+EXP(-score)), EXP(score)/(1+EXP(score)))
class = IF(probability>=threshold_cell, 1, 0)
```

- [x] Use actual exported cell references in formulas; do not compare a
  horizontal input row with a vertical weight vector in SUMPRODUCT. If converted
  parameters are unavailable, use fitted weights with explicit scaling instead.
- [x] Treat feature names as literal text when writing them to Excel.
- [x] Capture a stable run for export and verify its model/request association
  across asynchronous worksheet operations. Never overwrite source data.

Acceptance: a reader can identify all parameters and reproduce a prediction
using the exported model, without access to the Python process. The worksheet
example recalculates when its input values change and uses the stated threshold.

## Large feature counts

The same design must work for more than three or nine features. In particular,
64x64 RGB pixels yield 12,288 feature weights plus b if flattened directly.

- [x] Export all weights in a table; do not drop parameters merely to simplify
  the interface. Include row/column order and any pixel-order convention provided
  with the dataset, rather than inventing one.
- [x] Use search/pagination or a bounded preview in the task pane. Avoid
  rendering thousands of inputs, bars or contributions at once.
- [x] Show the compact equation `z = sum(w_j*x_j) + b` for large models; do not
  concatenate thousands of terms into one Excel formula or text cell.
- [x] Keep formula examples range-based and respect worksheet dimensions.
  If an example row cannot fit, export parameter tables and the compact
  mathematical recipe with an explicit explanation.
- [x] Export full contribution details only for a requested example row;
  do not automatically create an observations-by-features contribution report.

## Verification and documentation

Backend tests in `backend/tests/test_model.py` and `backend/tests/test_api.py`:

- [x] A three-feature fitted model returns exactly three weights plus one bias.
- [x] Feature order and original labels remain correct.
- [x] Parameters and means/scales retain precision, including small scales that
  would round to zero at six decimals.
- [x] With scaling on, direct raw-equation and scaled-equation scores agree with
  model scores on training, test and new rows within numerical tolerance.
- [x] With scaling off, exported parameters equal learned weights and bias.
- [x] Zero-variance columns use the retained effective scale consistently.
- [x] `/predict` score, probability and class agree with the same parameters.
- [x] Extreme scores use stable sigmoid calculations and never emit NaN/Infinity.

Frontend/export tests in `addin/tests/taskpane.test.js`:

- [x] Actual learned weights and b populate the table/equation, not placeholders.
- [x] What-if contribution sums plus b match backend score/probability.
- [x] Threshold changes preserve weights/score/probability and update the class.
- [x] Edited inputs or changed models cannot revive stale explanations.
- [x] Export writes all weights, usable numeric values, correct units and model ID
  to a new worksheet. Formula ranges have matching dimensions.
- [x] Large feature counts use a bounded UI but complete parameter export.

Documentation updates in `docs/LOGISTIC_REGRESSION_EQUATIONS.md`,
`PROJECT_EXPLAINED.md`, and `MENTOR_PRESENTATION_GUIDE.md`:

- [x] Explain feature weights versus observation counts, b versus alpha/lambda,
  score versus probability versus class, and standardized versus raw units.
- [x] Add a worked three-feature arithmetic example and parameter-conversion
  derivation, separate from the earlier one-step training example.
- [x] Explain that data/split/training settings can change fitted weights, while
  the prediction threshold alone cannot.

Live Excel acceptance:

1. Fit a dataset with exactly three feature columns and one binary target.
2. Inspect the three fitted weights and b; enter a new three-value row.
3. Manually calculate z, p and class using the exported parameters.
4. Compare the manual calculation, task-pane output, API output and worksheet
   formula example. Use tolerances, not equality of rounded display values.
5. Repeat with standardization off, then with the existing nine-feature sample.
6. Confirm export does not modify the training worksheet and correctly states
   the model's convergence status.

Completion requires agreement across the retained model, exposed parameters,
worked explanation and Excel output. Public distribution remains a separate,
deferred task, as requested.
