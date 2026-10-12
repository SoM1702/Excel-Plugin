# Excel Logistic Regression Add-in: current implementation

## Problem

Excel users can easily store historical business data, but standard Excel
tools do not provide a guided logistic-regression workflow for a two-class
outcome. This project lets a user choose numeric predictor columns and one
outcome column in Excel, fit a logistic regression model, inspect its quality,
and score future rows.

Examples include churn or no churn, loan default or no default, and fraud or
normal transaction. The project is a classification-analysis tool; its
probabilities support decisions but do not prove a cause.

## Product flow

    1. User selects aligned X feature columns and one Y outcome column.
    2. Office.js reads the worksheet values and validates the selection.
    3. The task pane sends HTTPS JSON to the Python service.
    4. FastAPI validates the request and calls the ML engine.
    5. scikit-learn fits logistic regression and the engine returns results.
    6. The task pane renders metrics, charts, and a threshold explorer.
    7. The user can score a hypothetical row, score a new Excel range, or
       export a report to a separate worksheet.

The source sheet is not modified by export. Before export, the add-in rereads
the selected ranges and blocks output when the source changed after training.

## Architecture

    Excel task pane                         Python backend
    HTML, CSS, JavaScript                   FastAPI, NumPy, SciPy, scikit-learn
    Office.js reads and writes workbook     validates and trains the classifier
    Chart.js renders results                returns JSON results and model ID
                 \                         /
                  \----- HTTPS JSON -------/

The split is intentional. An Office add-in runs in an embedded browser and
uses JavaScript to interact with a workbook. It cannot execute Python
libraries directly. The browser client therefore handles the user interface
and Excel operations; Python handles numerical computation and validation.

## Logistic regression

The model first forms a weighted score:

    z = b0 + b1*x1 + b2*x2 + ... + bn*xn

It then converts that score to a probability:

    p = 1 / (1 + exp(-z))

The probability is converted into a class using:

    predicted class = 1 when p is at least the active threshold

The normal threshold is 0.50. A lower threshold catches more positive cases
but can create more false positives. A higher threshold reduces false alarms
but can miss positives.

## Evaluation design

The current version avoids using final test data to choose the suggested
threshold.

    Outer train/test split
      Training portion
        stratified cross-validation
        scaler fit separately inside every fold
        out-of-fold probabilities choose max-F1 threshold
      Final model fit on the full outer training portion
      Final test portion evaluates 0.50 and suggested threshold once

Cross-validation is optional. If it is disabled or cannot be performed
because a class has too few training examples, the project uses 0.50 and says
why. It never silently replaces a requested test split with training scores.

The results have four distinct meanings:

| Result | Meaning |
|---|---|
| Accuracy, precision, recall, F1 at 0.50 | Performance at the standard classification rule |
| Active-threshold matrix | Current false-positive and false-negative trade-off |
| AUC and ROC curve | Ranking quality across thresholds |
| Training-side CV | Stability across folds and source of suggested threshold |

## Main code responsibilities

| File | Responsibility |
|---|---|
| backend/model.py | Validation, split, standardisation, fitting, CV, threshold selection, metrics, coefficient rows |
| backend/main.py | HTTP request schemas, health, train, predict, model-ID checks |
| backend/test_api.py | Readable local or HTTPS smoke test |
| backend/evaluate_real_data.py | Reproducible public-data software benchmark |
| addin/src/taskpane/taskpane.js | Excel reads, UI state, safe output, API calls, charts, new-row scoring |
| addin/src/taskpane/taskpane.html | Task-pane controls and result areas |
| addin/src/taskpane/taskpane.css | Layout and visual treatment |
| addin/manifest.xml | Excel host, permissions, icons, ribbon command, task-pane URL |
| addin/dev-server.js | Local HTTPS static server |

## Data validation

Before a model request, the add-in requires:

- one Y column and one or more X columns;
- X and Y from the same worksheet, with identical starting rows and counts;
- no X/Y overlap;
- numeric, finite feature cells;
- nonblank, unique headers when headers are enabled;
- exactly two nonblank outcome classes.

The backend repeats important validation because a browser client is not a
security boundary. It also checks C, test split, fold count, feature shape,
finite values, and class counts.

## Reports and predictions

Every training result receives a model ID. The Python service stores one
active model in memory for this single-user prototype. A backend restart or a
new training request invalidates older model IDs.

The report export creates a new worksheet that contains:

- source ranges, timestamp, model ID, class mapping, and settings;
- fixed-0.50 and active-threshold metrics;
- CV and inference notes;
- coefficient table;
- source row number, probability, encoded class, and displayed class label.

New rows must have the trained headers in exactly the same order. They are
scored with the fitted scaler and classifier, never fitted again. Their output
also goes into a separate worksheet.

## Statistical interpretation

Positive coefficients increase the model's estimated odds of the encoded
positive class; negative coefficients decrease them. The odds ratio is
exp(coefficient), so a ratio above one multiplies odds upward.

With standardisation enabled, a coefficient means a roughly one-standard-
deviation feature change. With it disabled, it means one original feature
unit. Coefficients describe association while other selected features are held
constant; they do not establish causation.

The project shows approximate Wald p-values only for unweighted models. The
classifier uses L2 regularisation, so these values are qualified estimates,
not exact unregularised inference. When balanced class weights are used, the
p-values are hidden rather than presented as reliable.

## Current limits

The prototype accepts numeric features and two outcome classes. It does not
yet encode categories, impute missing data, support multiclass models, retain
separate models for several users, authenticate callers, or restrict CORS for
a production deployment. The synthetic churn workbook demonstrates product
integration, while docs/EVALUATION.md describes a reproducible public-data
benchmark. Neither result authorizes a real-world high-stakes decision.
