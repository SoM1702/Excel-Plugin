# Mentor presentation guide

## One-minute explanation

Excel stores historical data well, but it does not provide a guided logistic
regression workflow for binary questions such as churn or no churn. Our
project is an Excel task-pane add-in. The user selects numeric feature columns
and one two-class outcome column. Office.js reads those cells and sends them
over HTTPS to a small FastAPI service. The Python service uses scikit-learn
logistic regression and returns probabilities, coefficients, AUC, ROC data,
confusion-matrix data, and validated predictions. The task pane presents the
results and can export a self-contained report sheet or score new Excel rows.

## Demonstration script

1. Open sample_data.xlsx. It has 400 synthetic customer records, nine numeric
   predictors, and a binary churn column.
2. Select churn_data!A1:I401 as X and churn_data!J1:J401 as Y. Keep headers
   enabled.
3. Point out the preview. It confirms rows, feature names, class counts, and
   warns if a feature is constant.
4. Enable five-fold cross-validation and run the model.
5. Explain that the large cards are fixed-0.50 held-out test metrics. AUC is
   threshold independent.
6. Show the threshold note. The suggested cut-off was selected from
   out-of-fold predictions on training data, not by looking at final test
   performance.
7. Move the slider. The matrix and threshold metrics update immediately from
   held-out probabilities.
8. Export the report. It creates a new worksheet rather than writing beside or
   over the original data.
9. Select a range of new rows with the same feature headers, score it, and
   export the new-row result.
10. Deliberately choose a bad range, such as two outcome columns, to show an
    understandable validation error.

## Architecture

    Excel task pane
    Office.js, HTML, CSS, JavaScript, Chart.js
       reads workbook data and presents results
                       |
                       | HTTPS JSON
                       v
    Python service
    FastAPI, Pydantic, NumPy, SciPy, scikit-learn
       validates input, trains, evaluates, predicts

Why use two programs? An Excel add-in runs as a secure browser page, so it
uses JavaScript and Office.js to access workbook cells. Python has mature
scientific libraries. Separating the interface from the model engine makes
the ML code testable without Excel and reflects a standard client/server
application design.

## Essential ML explanation

Logistic regression calculates:

    z = b0 + b1*x1 + b2*x2 + ... + bn*xn
    probability = 1 / (1 + exp(-z))

The sigmoid turns any score into a value between zero and one. If the
probability is at least the chosen threshold, the project predicts the
positive class.

The model uses L2 regularisation. C controls its strength:

    smaller C means stronger regularisation
    larger C means weaker regularisation

Standardisation transforms each feature using the training-set mean and
standard deviation. It prevents large numerical units from dominating the
optimizer. The project fits the scaler only on training data; in
cross-validation it fits a new scaler in every fold. That avoids data leakage.

## Evaluation answer

We use a stratified outer train/test split, so the class ratio is preserved.
The model trains on the outer training portion and the final test portion is
kept for evaluation.

When cross-validation is enabled, the training portion is divided into
stratified folds. The model generates out-of-fold training probabilities.
Those probabilities choose the threshold that maximises F1. Then the final
model is evaluated once on untouched test rows. This prevents us from picking
a threshold using the final test data and then claiming that its score is an
unbiased result.

The useful metric definitions are:

| Metric | Meaning |
|---|---|
| Accuracy | Correct predictions divided by all predictions |
| Precision | Of rows predicted positive, how many were actually positive |
| Recall | Of actual positive rows, how many were caught |
| F1 | Balance of precision and recall |
| AUC | Probability that the model ranks a random positive above a random negative |
| ROC curve | True-positive rate against false-positive rate across thresholds |
| Confusion matrix | Counts of TP, FP, TN, and FN |

The add-in also shows majority-class baseline accuracy. This prevents a
misleading success claim when one class dominates the data.

## Coefficients and p-values

A positive coefficient raises the estimated odds of the positive class; a
negative coefficient lowers them. The odds ratio is exp(coefficient). For
example, an odds ratio of 1.60 means a selected change in a feature multiplies
the estimated odds by 1.60 while the other selected features are held fixed.

Because standardisation is enabled by default, a feature coefficient refers
roughly to a one-standard-deviation change. It does not mean one original
currency unit, month, or call.

P-values are labelled approximate. The model is regularised, so the
unregularised information-matrix formula does not give exact classical
inference. P-values are hidden when balanced class weighting is active.
Neither a coefficient nor a p-value proves that a feature causes churn.

## Engineering safeguards

| Risk | Project behavior |
|---|---|
| Wrong or overlapping ranges | Rejects them before training |
| Missing/non-numeric feature data | Reports the feature and Excel row |
| More or fewer than two outcome classes | Rejects the request |
| Too few minority examples for CV | Reports that CV is unavailable and uses 0.50 |
| Changed sheet after training | Blocks export until retraining |
| New training or backend restart | Model ID blocks stale prediction |
| Export overwrites user data | Results always go to a new worksheet |
| Different class rules in different UI areas | Active threshold is shared by matrix, what-if, batch score, and export |

## File map

| Area | File | Role |
|---|---|---|
| ML engine | backend/model.py | Training, held-out evaluation, CV, threshold choice, coefficient results |
| API | backend/main.py | Request validation, health, model-ID-checked prediction |
| Tests | backend/tests/test_model.py | Model and API behavior |
| Excel client | addin/src/taskpane/taskpane.js | Office.js reads, UI state, API calls, safe exports |
| UI | addin/src/taskpane/taskpane.html and taskpane.css | Controls and styles |
| Add-in registration | addin/manifest.xml | Excel host, permissions, task-pane URL, ribbon |
| Development hosting | addin/dev-server.js | HTTPS task-pane server |
| Benchmark | backend/evaluate_real_data.py | Reproducible public-data software evaluation |

## Honest limitations

This is a single-user local prototype. It keeps only the most recent model in
memory. Restarting the backend removes it. The development server permits
cross-origin calls; production would restrict allowed add-in origins and add
authentication.

The add-in currently accepts numeric input and two outcome classes. It does
not automatically handle missing data, categorical columns, multiclass
classification, or persistent per-user models. The churn workbook is
synthetic. The public-data benchmark is for reproducible software evaluation,
not for clinical or other high-stakes deployment.

## Questions you may be asked

Why did you not use linear regression?

Linear regression can produce values below zero or above one. Logistic
regression applies the sigmoid function, so the output is a probability.

Why did you separate Excel and Python?

Office.js is the supported way to read/write a workbook from a task pane.
scikit-learn provides a tested implementation of logistic regression and
metrics. HTTP JSON connects the two responsibilities.

Why standardise after splitting?

If we computed the mean and standard deviation using future test rows, the
model would receive information from data it is supposed not to have seen.

Why not always use 0.50?

0.50 is a normal default, but a business may value recall and precision
differently. We choose a suggested threshold from training-side
cross-validation and keep the final test set separate.

What happens when the source sheet changes?

The export checks the stored source snapshot. If it differs, the add-in blocks
the export and requires retraining so predictions cannot be attached to
different rows.

How did you test it?

There are backend tests for JSON-safe output, rare-class CV, held-out splits,
model ID, threshold behavior, and request validation. Task-pane logic tests
check that the backend Save button does not trigger range selection and that a
selected threshold drives live classification metrics. The final check should
be a live Excel run using the demo script above.
