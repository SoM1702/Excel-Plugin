# Excel Logistic Regression Add-in

This project adds binary logistic regression to Excel. Select numeric feature
columns and one two-class outcome column, then train a Python
scikit-learn model from an Excel task pane.

The add-in shows fixed-threshold metrics, AUC, a ROC curve, coefficients,
odds ratios, qualified p-values, and an interactive confusion matrix. It can
score a hypothetical row or a new Excel range without retraining. It exports
each result to a new report worksheet, so it does not overwrite the source
sheet.

## Architecture

    Excel task pane
      Office.js reads checked X and Y ranges
      JavaScript sends HTTPS JSON requests
                |
                v
    FastAPI service
      validates data and trains scikit-learn LogisticRegression
      returns metrics, model ID, coefficients, probabilities, and warnings
                |
                v
    Excel task pane
      charts results, explores a threshold, scores new rows, exports report

Office add-ins run in a web view and cannot execute Python directly. The
task pane therefore handles spreadsheet interaction and presentation, while
the Python service handles validation, training, and statistics.

## What the current version protects against

- Exactly one outcome column is required. X and Y must be aligned, on the
  same worksheet, and must not overlap.
- Feature values must be finite numbers. Headers must be nonblank and unique.
- The UI shows a preview of row count, features, classes, and constant-column
  warnings before training.
- The model uses a held-out stratified test split when requested. It does not
  silently replace that with training-set evaluation.
- A suggested F1 threshold comes only from cross-validation inside the
  training portion. The final test set stays separate.
- The active threshold is used consistently by the live matrix, what-if
  prediction, new-row prediction, and report export.
- Results belong to one source snapshot and one model ID. Changed data or
  settings require retraining before export or prediction.

## Project layout

    sample_data.xlsx                  400-row synthetic churn demo workbook
    backend/
      model.py                        validation, training, threshold selection, metrics
      main.py                         FastAPI routes: health, train, predict
      test_api.py                     readable local or HTTPS smoke test
      evaluate_real_data.py           reproducible public-data benchmark
      tests/test_model.py             backend regression tests
      make_sample_data.py             creates the synthetic Excel and CSV demo
      make_loan_data.py               creates an alternate loan-default CSV
      requirements.txt
      Dockerfile
    addin/
      manifest.xml                    tells Excel how to load the add-in
      dev-server.js                   local HTTPS static-file server
      src/taskpane/                   HTML, CSS, Office.js, charts, interactions
      tests/taskpane.test.js          browser-logic tests
    docs/EVALUATION.md                benchmark methodology and limitations
    TESTED_VERSIONS.md                verified local dependency versions

## Run locally

Prerequisites: Python 3.11 or newer, Node 18 or newer, and Microsoft Excel.

Start the task pane:

    cd addin
    npm install
    npm run cert
    npm start

The task pane is served at https://localhost:3001. Leave that process running.

Start the API in a second terminal:

    cd backend
    python3 -m venv .venv
    source .venv/bin/activate
    pip install -r requirements.txt
    python make_sample_data.py
    uvicorn main:app --reload --port 8000 \
      --ssl-keyfile ~/.office-addin-dev-certs/localhost.key \
      --ssl-certfile ~/.office-addin-dev-certs/localhost.crt

The API must use HTTPS because an HTTPS Excel task pane cannot call a plain
HTTP backend. Visit https://localhost:8000/health to confirm it is available.

Sideload the development manifest:

    cd addin
    npm run sideload

If sideloading is unavailable on macOS, copy addin/manifest.xml into Excel's
developer add-in folder, fully quit Excel, and reopen it. The add-in requires
ReadWriteDocument permission because it reads selected ranges and creates
report sheets.

## Demo workflow

1. Open sample_data.xlsx and the Logistic Regression task pane.
2. Set X to churn_data!A1:I401 and Y to churn_data!J1:J401.
3. Leave First row is a header enabled. Review the preview.
4. Keep standardisation enabled. Use a 30 percent test split. Enable five-fold
   cross-validation to obtain an independently chosen suggested threshold.
5. Run the model. Fixed 0.50 metrics, AUC, and training-side CV results
   answer different questions, so read their labels carefully.
6. Move the threshold slider to inspect the held-out confusion matrix. This is
   exploratory after the suggested threshold; changing it updates exports and
   predictions consistently.
7. Use Export report to new sheet. The source data is checked first, then a
   separate worksheet records settings, metrics, coefficients, and predictions.
8. To score future rows, select a new X range with the same feature headers
   and ordering, then use Score new rows and Export new-row predictions.

## How the model is evaluated

With a nonzero test split, the data is split once into outer training and test
portions. Standardisation is fitted on training data only. If cross-validation
is enabled, each fold fits its own scaler and classifier. Out-of-fold
probabilities from the training portion select an F1 threshold. The final
model is then evaluated once on the untouched test portion.

The UI distinguishes:

- Metrics at 0.50: the normal fixed classification rule.
- Metrics at the active threshold: useful for the displayed confusion matrix
  and exported classes.
- AUC: threshold-independent ranking performance.
- Cross-validation: variation across training-side folds.

The sample churn workbook is synthetic and validates the end-to-end product
flow. It does not prove real-world performance. See docs/EVALUATION.md for a
separate reproducible public-data benchmark and its limitations.

## Tests

Run backend tests:

    cd backend
    .venv/bin/python -m unittest discover -s tests -v
    .venv/bin/python test_api.py

Run task-pane logic tests:

    cd addin
    npm test
    node --check src/taskpane/taskpane.js

The manifest validation command also exists:

    npm run validate

It contacts Microsoft's online validation service, so it needs network access.

## Interpretation and limits

Logistic regression estimates:

    probability = 1 / (1 + exp(-(b0 + b1*x1 + ... + bn*xn)))

Positive coefficients raise the estimated odds of the encoded positive class;
negative coefficients lower them. An odds ratio is exp(coefficient). When
standardisation is enabled, a feature coefficient refers roughly to a
one-standard-deviation increase.

P-values are approximate Wald-style values calculated from an unregularised
information matrix while the classifier uses L2 regularisation. The UI hides
them when balanced class weights make that calculation unsupported. They show
association, not causation.

This version supports numeric features and exactly two outcome classes. It
does not yet handle missing data, categorical encoding, multiclass outcomes,
per-user persistent models, authentication, or production CORS restrictions.
