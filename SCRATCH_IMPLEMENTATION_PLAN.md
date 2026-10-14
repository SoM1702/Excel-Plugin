# Logistic regression from scratch — faculty implementation plan

Status: completed; all phases implemented, verified with tests, and documented.

This is the next-stage plan following the faculty meeting. It supersedes the
scikit-learn architecture assumption in `IMPLEMENTATION_PLAN.md` for this work;
the earlier document remains a record of the prototype reliability work.

## 1. Deliverables and scope

Implement binary logistic regression using the sigmoid, binary cross-entropy,
and full-batch gradient-descent equations in the mentor's photograph. Make the
implementation explainable through documented equations, a worked calculation,
training diagnostics, and a loss curve. Improve the existing test-split control
so users can enter percentages and see both train and test allocations.

Complete these requirements first. The mentor's other two or three requested
changes have not been specified, so they are not implementation commitments in
this plan. Domain-specific products and AI assistants are outside this stage.

Working assumption: NumPy is allowed for array storage, dot products, means,
exponentials, and other elementary numerical operations. We write the model,
gradients, optimiser, scaling, splitting, CV, and metrics ourselves. Do not use
scikit-learn, statsmodels, an autodifferentiation library, or a library optimiser
to perform the learning. FastAPI, Pydantic, Office.js, Chart.js, and OpenPyXL keep
their existing roles. Revisit this assumption if the mentor disallows NumPy.

## 2. Translate the handwritten equations precisely

Use consistent notation in implementation comments and the equation guide:

| Symbol | Meaning in this project |
|---|---|
| N | Number of usable selected rows after excluding headers |
| m | Number of training rows for the current fit, not all N rows |
| d | Number of selected features |
| X | Training feature matrix, shape `(m, d)` |
| x_i | Feature vector for training row i |
| y_i | Encoded actual outcome, 0 or 1 |
| w | One learned weight for each feature, shape `(d,)` |
| b | Learned intercept/bias, a scalar |
| z_i | Linear score `w dot x_i + b` |
| p_i or y_hat_i | Predicted probability `P(Y=1 | x_i)` |
| J | Mean training objective being minimised |
| alpha | Learning rate: size of the update |
| t | Training iteration, with one complete training-set pass per iteration |

The core, unweighted, unregularised equations are:

```text
z_i = sum_j(w_j * x_ij) + b
p_i = sigmoid(z_i) = 1 / (1 + exp(-z_i))

J(w, b) = -(1/m) * sum_i[y_i * log(p_i) + (1-y_i) * log(1-p_i)]

dw = (1/m) * X.T @ (p-y)
db = (1/m) * sum_i(p_i-y_i)

w_next = w - alpha * dw
b_next = b - alpha * db
```

Compute both gradients from the same pre-update probabilities, then update w
and b together. Apply gradients to probabilities, not thresholded 0/1 classes.
Each weight gradient includes its corresponding feature value; the bias
gradient does not. Use natural logarithms.

Why the cross-entropy gradient is simple: for one row, `dp/dz = p*(1-p)` and
`d(loss)/dp = (p-y)/(p*(1-p))`, so `d(loss)/dz = p-y`. Multiplying by `dz/dw_j =
x_ij` gives the weight gradient. This derivation belongs in the guide.

Explain that the score is linear in features, while the sigmoid converts the
score to a probability. Weights describe changes in log-odds; `exp(w_j)` is an
odds multiplier for a one-unit change in the model's feature units, holding
other features fixed. Scaling changes those units. Explain bias, learning rate,
loss, gradient, convergence, threshold, and train/test separation separately.

### Clarify the squared-error expression in the photo

The lower expression appears to be:

```text
(1/(2*m)) * sum_i(p_i-y_i)^2
```

This is half the mean squared error. It is not ordinary R-squared. If computed
on probabilities without the 1/2 factor, it is the Brier score. It is a different
loss from the cross-entropy written above it. With a sigmoid model its gradient
has an additional `p_i*(1-p_i)` factor; do not mix this loss with the
cross-entropy update equations.

Implement cross-entropy as the training objective. Discuss the squared-error
expression as a comparison in the guide; a second training mode and pseudo-R2
are not part of this stage unless the mentor explicitly requests them.

### Worked first update for learning

For an illustrative single row `x=2`, `y=1`, starting at `w=0`, `b=0`:
`z=0`, `p=0.5`, `J=log(2)`. Then `dw=-1`, `db=-0.5`. With `alpha=0.1`, the
simultaneous update gives `w=0.1`, `b=0.05`, `z=0.25`, and `p approximately
0.5622`. The probability moves towards the actual outcome. This is an arithmetic
example, not a recommendation to fit a model using one observation.

Primary mathematical references:

- Stanford CS229 notes: https://cs229.stanford.edu/notes-spring2019/cs229-notes1.pdf
- Stanford STATS 305B: https://web.stanford.edu/class/stats305b/slides/Logistic-regression.html

The notes may describe maximising log-likelihood with gradient ascent. Our
implementation minimises negative mean log-likelihood with gradient descent;
the sign and the learning-rate convention must be explained consistently.

## 3. Changes to the current codebase

| File | Planned change |
|---|---|
| `backend/logistic_scratch.py` (new) | Stable sigmoid, objective/gradient, full-batch fit loop, prediction, convergence diagnostics |
| `backend/preprocessing.py` (new) | Training-fitted means/scales and transform-only prediction |
| `backend/splitting.py` (new) | Seeded stratified split and CV index generation |
| `backend/metrics.py` (new) | Confusion counts, accuracy, precision, recall, F1, log loss, ROC, tied-score AUC |
| `backend/model.py` | Replace sklearn objects and calls; orchestrate scratch modules, CV, threshold selection, result construction |
| `backend/main.py` | Validate new training settings, pass them to the engine, return engine identity and diagnostics |
| `backend/requirements.txt` | Remove scikit-learn; add a separate development dependency file for HTTP test tooling if needed |
| `backend/evaluate_real_data.py` | Replace sklearn dataset loading with a documented local CSV loader and explicit data-preparation instructions |
| `backend/test_api.py` | Send scratch settings, display convergence and allocations, make smoke checks assert meaningful properties |
| `backend/tests/test_model.py` | Update integration tests and split/threshold isolation checks |
| `backend/tests/test_logistic_scratch.py` (new) | Hand calculations, finite-difference gradient checks, stability, convergence |
| `backend/tests/test_splitting.py` (new) | Allocation, class preservation, reproducibility, index disjointness |
| `backend/tests/test_metrics.py` (new) | Hand-computed metrics and tied/undefined AUC cases |
| `backend/tests/test_api.py` (new) | Real in-process HTTP requests, schema failures, serialisation, model-ID behaviour |
| `backend/Dockerfile` | Correct comments and verify installation/start without sklearn |
| `addin/src/taskpane/taskpane.html` | Linked split controls, advanced training settings, loss chart, equation explanations |
| `addin/src/taskpane/taskpane.js` | Synchronise controls, snapshot settings, send new fields, render scratch diagnostics, update export |
| `addin/src/taskpane/taskpane.css` | Fit percentage inputs, counts, diagnostics, and explanations into the narrow pane |
| `addin/tests/taskpane.test.js` | Exercise split controls, submitted payloads, changing settings during requests, exports and cache consistency |
| `addin/manifest.xml`, `addin/package.json` | Replace sklearn descriptions with the implemented scratch method |
| `docs/LOGISTIC_REGRESSION_EQUATIONS.md` (new) | Equation derivations, significance, dimensions, numerical example and code mapping |
| `README.md`, `PROJECT_EXPLAINED.md`, `MENTOR_PRESENTATION_GUIDE.md` | Update architecture, controls, settings, mathematics, limitations and demonstration |
| `docs/EVALUATION.md`, `TESTED_VERSIONS.md`, `DEPLOYMENT.md` | Document new engine, dataset loading, measured results and clean dependency setup |
| `IMPLEMENTATION_PLAN.md` | Mark the former sklearn direction as historical; use evidence-based completion status |

Do not regenerate or overwrite `sample_data.xlsx` just to obtain desired scores.
The sample generators already use NumPy rather than sklearn. Retain the sample
for integration testing; update score commentary after measuring the new engine.

## 4. Phase A — establish the mathematical contract and baseline

- [x] Preserve a recoverable copy of the current source before replacing the
  engine; the current project has no local Git repository. Choose a source
  snapshot or establish version control when implementation begins.
- [x] Capture current sample shape, class mapping, representative cell values,
  settings, probability properties and metrics as historical observations.
- [x] Record that the existing frontend slider already selects test fraction
  from 0 to 0.50 and defaults to 0.30; train percentage is currently implicit.
- [x] Define the core as unweighted, unregularised full-batch gradient descent.
  Use `w=zeros(d)` and `b=0` so the first probability is 0.5 and the first update
  matches the teaching example.
- [x] Starting settings to validate, not performance guarantees: learning rate
  0.1, maximum 10,000 iterations, gradient tolerance 1e-6, split seed 42.
- [x] Define the replacement for the existing C parameter explicitly. Remove C
  from this scratch API/UI and replace it with optional `l2_lambda`, default 0.
  Do not label `1/C` as an exact equivalent of the old library objective.
- [x] Retain class balancing as an optional advanced extension, default off.
  Explain exactly how enabling it changes the mentor's base objective.

Acceptance: loss, gradients, parameter units, defaults, response fields and
extensions are documented before implementation. Historical sample scores do
not become exact acceptance targets for a new split algorithm/objective.

## 5. Phase B — implement and verify the scratch learning engine

- [x] Implement sigmoid with separate positive/negative-score branches to
  avoid overflow from exponentiating very large magnitudes.
- [x] Compute binary cross-entropy directly from scores using
  `mean(logaddexp(0, z) - y*z)`. This is mathematically the same objective as
  the handwritten log-probability formula and avoids `log(0)`.
- [x] Implement vectorised `dw`, `db`, and simultaneous parameter updates.
- [x] Save initial and final loss, iterations, gradient norm, convergence flag,
  stop reason, learning-rate information and elapsed time. Return bounded loss
  history, always including the first and final points (target at most 200).
- [x] Check finite parameters/objective/gradients at each accepted iteration.
  Distinguish reaching max iterations from satisfying the convergence criterion.
  A tiny loss change alone must not be called convergence while gradients are
  substantial.
- [x] Use the selected learning rate as the initial step. Add a simple
  handwritten step-halving retry when a proposed step increases the objective;
  cap retries, report step reductions, and fail clearly if no usable step is
  found. Do not call a library optimiser. Document that this is a stability
  safeguard on the same gradient update, not a different model.
- [x] Deal explicitly with unregularised complete/quasi separation: finite
  coefficients may not have a finite optimum. Record parameter-growth or
  separation warnings and do not equate small loss with a validated finite
  maximum-likelihood estimate.
- [x] Add optional L2 with objective `J + (lambda/2)*sum(w*w)` and weight
  gradient `dw + lambda*w`. Do not penalise b. Keep lambda=0 as the default
  matching the photograph.
- [x] For balancing, derive `s_i = m/(2*n_class_i)` using only the current fit's
  training rows. Use `sum(s_i*loss_i)/sum(s_i)` and gradients with the same
  normalisation. Never calculate fold weights from outer validation/test rows.
- [x] Expose only `fit` and `predict_proba` plus learned data/diagnostics needed
  by the coordinator. Prediction never modifies weights or scaling.

Acceptance: stable probabilities in [0,1], the worked update matches, analytical
gradients agree with central finite differences on several nondegenerate cases,
loss reduces on a learnable nonseparable fixture, and termination is honest.
Finite-difference checks also cover optional L2 and balancing if enabled.

## 6. Phase C — remove the remaining sklearn operations

### Scaling

- [x] Fit column means and population standard deviations (`ddof=0`) using only
  training rows. Use scale 1 for a zero-variance column and report its name.
- [x] Apply those means/scales to held-out and new rows unchanged.
- [x] Fit a fresh scaler within every CV fold.
- [x] Detect constant features in raw data and training data. Reject the primary
  training workflow when all features are constant with a useful message.

The latest Excel preview showed all features as 44. That is evidence about the
values read from the open workbook; rewriting the optimiser will not recover
missing variation. Verify raw worksheet cells/Office.js reads separately from
the saved sample and use a multirow preview to make such problems visible.

### Splitting

- [x] Proposed user-facing range: test 5-80% in one-percentage-point increments;
  train 20-95%; default train 70%, test 30%. The test fraction is authoritative,
  with the train value computed as its complement.
- [x] This narrows the API's previous zero-test/training-only option. Document
  the change; this stage requires held-out evaluation rather than silently
  returning training scores for a requested test split.
- [x] Compute `n_test = ceil(N*test_fraction)` and `n_train = N-n_test`; use that
  same rounding rule for frontend counts and backend allocation.
- [x] Shuffle per-class row indices with a local seeded NumPy generator.
  Allocate an exact total n_test with each class contributing at least one row
  to both partitions, when feasible; choose allocations close to proportional
  class counts using a documented deterministic tie-break.
- [x] Reject infeasible splits with a clear class/count explanation. Check the
  actual partitions as well as initial counts. Do not silently change percent.
- [x] Carry original row indices so test membership can be tested, reported,
  and written alongside original-row predictions.

### Metrics and CV

- [x] Implement confusion counts and derive accuracy, precision, recall, F1.
  Keep explicit zero-denominator conventions and document them.
- [x] Implement probability log loss; distinguish this unweighted evaluation
  metric from a penalised/weighted training objective.
- [x] Implement ROC by descending scores and advancing all tied scores together;
  include endpoints. Implement AUC using trapezoids and verify against a separate
  pairwise/rank calculation with half credit for ties.
- [x] AUC is null with a reason if only one class is available; never emit NaN.
- [x] Select the majority-class baseline from training labels, then evaluate
  that fixed predictor on test labels. Correct the current test-majority baseline.
- [x] Implement stratified folds with seeded per-class shuffling and balanced
  allocation. Each validation fold must contain both classes; reduce folds or
  explain unavailability according to the documented policy.
- [x] Train a fresh scratch model/scaler on each fold. Collect out-of-fold
  probabilities for threshold selection entirely within outer training rows.
- [x] Retain the existing F1 threshold-grid concept and document its tie-break.
  Evaluate selected thresholds on the separate final test portion.
- [x] Record fold convergence; do not silently discard failed fits or present
  an unavailable fold summary as a fully successful CV run.

Acceptance: index coverage/disjointness, both-class guarantees, scaler fitting
boundaries, tied-score AUC, finite responses, and threshold isolation have tests.

## 7. Phase D — integrate API, prediction and statistical output

- [x] Update `TrainedModel` to retain scratch weights/intercept, scaler,
  feature order, mapping, model ID, and training diagnostics.
- [x] Refactor `train_logistic` to coordinate validation, indices, fold fitting,
  final fitting, testing and original-row prediction without sklearn imports.
- [x] Add finite validated request fields `learning_rate`, `max_iterations`,
  `tolerance`, and optional `l2_lambda`. Define computational bounds based on
  profiling and reject unreasonable requests before fitting.
- [x] Update test_size bounds consistently with the UI; preserve prediction
  threshold validation and active-model-ID checks.
- [x] Keep existing useful result keys such as `metrics`, `threshold_data`,
  `predictions`, and `class_labels` to minimise incidental frontend breakage.
- [x] Add engine identity/version, requested/actual split percentages, counts,
  row membership, objective name, training settings and diagnostics.
- [x] Record Python/NumPy versions instead of sklearn. Return JSON null plus a
  reason for legitimately unavailable values; inspect every numeric output for
  finiteness, including exponentiated odds ratios.
- [x] Keep coefficients and odds ratios. For this first scratch release set
  standard errors, z scores, p-values and significance fields to null with an
  explicit inference-unavailable reason. Remove any misleading significance
  presentation. Valid Wald inference is a separately verified later task;
  successful gradient descent does not prove inference assumptions.
- [x] Do not activate a diverged or numerically invalid model. Finite fits that
  stop at the iteration cap may be returned with an unmistakable not-converged
  warning, propagated to reports and CV handling.
- [x] Keep `/health` quick. Profile six fits for five-fold CV plus the final fit;
  if the current 30-second client timeout is insufficient, introduce an explicit
  bounded training timeout and clear feedback. A client timeout does not cancel
  Python computation; discard outdated responses and require a confirmed model
  association before subsequent predictions.
- [x] Replace the real-data loader's `load_breast_cancer` dependency with an
  explicitly prepared local numeric CSV and recorded source/schema/label
  mapping. Do not introduce hidden downloads during training or tests.

Acceptance: `/train`, `/predict`, and JSON serialisation work in HTTP tests;
what-if/batch prediction reuses the same model/scaler and agrees for equal rows.

## 8. Phase E — task-pane percentages and learning explanations

- [x] Extend the existing test slider instead of adding a second independent
  train/test slider. Add linked Train % and Test % numeric fields; editing either
  updates the complement, slider, and preview. Their sum must be 100%.
- [x] Display counts after reading the usable data, before submitting training:
  for N=400, 70/30 gives 280 train and 120 test; 80/20 gives 320 and 80.
  Explain rounding for other sizes. Do not include headers in counts.
- [x] Update raw data preview to several rows with column alignment and explicit
  warnings. All-constant selected/training features must produce an actionable
  message instead of presenting a normal successful model.
- [x] Add an Advanced training section for learning rate, iteration cap,
  tolerance, optional L2 and balancing. Core defaults use the base equations.
- [x] Replace the existing Regularisation C label and payload. Explain each
  control briefly; split percent, threshold, alpha and lambda have different roles.
- [x] Snapshot backend URL, selected ranges, header flag, all model controls and
  a request revision before asynchronous reads/training. Changing settings
  invalidates pending results; an old response must not enable export/prediction.
- [x] Mark split/training setting changes stale. Keep error recovery and button
  state correct. Show a truthful busy state rather than an invented percentage.
- [x] Show Scratch logistic regression / Full-batch gradient descent, convergence
  status, iterations and initial/final objective. Render a bounded training-loss
  curve with Chart.js, clearly labelled as training loss.
- [x] Add compact explanatory content linking the displayed w/b, sigmoid, loss
  and update formulas to the longer equation guide. A single selected row can
  show raw values, scaled values, score, probability and threshold result.
- [x] Reclassify or explicitly invalidate cached new-row and what-if results
  when the active threshold changes; make on-screen and exported classes agree.
- [x] Test an actual multirow Excel read against the on-disk sample. The source
  of the all-44 preview is still unconfirmed and must not be assumed fixed by
  this engine migration.

Acceptance: percentage edits stay linked, submitted fractions match labels,
row counts match the backend, stale responses are blocked, and charts and
explanations reflect actual model data.

## 9. Phase F — export and documentation

- [x] Export algorithm identity, objective, w/b, learning rate, lambda/weighting,
  iterations, stopping reason, convergence, seed, training timestamp,
  requested/actual train-test percentages and actual counts.
- [x] Include scaling statistics, class mapping, train-derived baseline, numeric
  CV summary, threshold origin, train/test row membership and held-out metrics.
- [x] Keep full usable probability precision and unique new output worksheets.
- [x] Include bounded iteration/loss history in a labelled report section so a
  mentor can check whether training improved the chosen objective.
- [x] Update new-row report metadata and inference-unavailable text consistently.
- [x] Replace sklearn claims in manifests, package descriptions and user guides.
  Record measured new scores; do not copy old exact accuracy claims as promises.
- [x] Add a mentor walkthrough explaining equations with a hand-worked update,
  changing 70/30 to 80/20, loss reduction, test metrics, and new-row prediction.

Acceptance: someone reading only the report can identify the algorithm,
mathematics, settings, evaluation partition and convergence state.

## 10. Verification and completion checklist

### Mathematical and numerical checks

- [x] Sigmoid at 0 equals 0.5; extreme positive/negative scores remain finite.
- [x] BCE at p=0.5 equals log(2); confident correct predictions reduce loss.
- [x] First update agrees with the worked example; w/b update simultaneously.
- [x] Central finite differences agree with both gradients within justified
  tolerances; checks include multiple rows and features.
- [x] Learnable, nonseparable fixtures converge; diverging/nonconverging cases
  produce explicit diagnostics; unregularised separable data is handled honestly.
- [x] All-constant features, singular designs, blanks, malformed labels, NaN,
  huge feature values and odds-ratio overflow are handled deliberately.

### Evaluation checks

- [x] Requested exact split counts, disjoint indices and complete coverage.
- [x] Extreme minority counts preserve both classes or fail explicitly.
- [x] Same seed/settings are reproducible under the recorded environment.
- [x] Scaler/weights/threshold tuning never fit on final test rows.
- [x] Toy AUC cases: perfect ranking=1, reversed ranking=0, all tied=0.5.
- [x] Baseline class comes from training rows; predictions retain source order.
- [x] No NaN/Infinity in the actual HTTP response.

### Excel workflow checks

- [x] Raw sample cells and multirow preview agree.
- [x] Slider and both numeric percentages stay consistent.
- [x] Train/test counts at 70/30 and 80/20 match displayed and exported counts.
- [x] Loss curve uses returned objective values; capped iterations warn clearly.
- [x] Changing settings during training cannot revive an outdated result.
- [x] Same row scored individually and in a batch gives equal probabilities.
- [x] Threshold changes cannot leave cached exports with old classifications.
- [x] Safe exports preserve original data and state convergence and split details.

### Dependency and reproducibility checks

- [x] No sklearn import in application, helper scripts, or tests.
- [x] Clean environment with declared dependencies and no installed sklearn runs
  the unit suite, sample smoke test and application imports successfully.
- [x] The real-data benchmark loads from its documented local file.
- [x] Both backend and JS suites pass. Actual Excel desktop acceptance is recorded
  separately as pending interactive desktop sideloading; automated mocked tests establish
  programmatic correctness but do not substitute for live desktop validation.
- [x] Optional old sklearn outputs are labelled historical observations only;
  required validation uses equations, hand-calculated fixtures and independent
  numerical checks, so it does not require importing sklearn.

## 11. Suggested implementation order

1. Preserve the existing source and write the equation guide/contract.
2. Implement the scratch engine and numerical/gradient tests.
3. Implement scaling, index splits, metrics and folds.
4. Integrate the API and replace dataset/dependency references.
5. Implement linked percentages, diagnostics and stale/cache protections.
6. Complete reports, documentation and live Excel acceptance.

The stage is complete when the add-in runs without sklearn, uses the stated
equations, honours the chosen split, explains the learned model and convergence,
and passes mathematical, API and actual Excel checks. Extra mentor requests can
be planned once their details are supplied.
