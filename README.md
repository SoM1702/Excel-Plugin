# Excel Logistic Regression Add-in (Scratch Engine)

New teammate? Start with [TEAMMATE_START_HERE.md](TEAMMATE_START_HERE.md).
The consolidated development timeline is in [CHANGELOG.md](CHANGELOG.md).
Future deployment work is tracked in [the active roadmap](docs/HYBRID_PUBLIC_DEPLOYMENT_PLAN.md).

This project integrates binary logistic regression into Microsoft Excel from
scratch. Select numeric feature columns ($X$) and one binary outcome column ($Y$)
in your spreadsheet, then train a model using our pure NumPy full-batch gradient
descent engine with zero machine-learning library dependencies.

The add-in displays:
- **Dual Mode (Table Mode & Numeric Mode)**:
  - **Table Mode (Default)**: Select a raw rectangular Excel table with headers (e.g., the untouched Titanic dataset). Handles supported scalar numeric, boolean, and low-cardinality categorical columns with documented missing/unknown policies (does not handle arbitrary non-scalar Excel objects, nested structures, or image data). Automatically profiles columns, infers types, flags potential target leakage (e.g., `alive` vs `survived`), enables non-adjacent feature selection, and fits scratch models without requiring numeric helper sheets.
  - **Numeric Mode**: Legacy workflow for pre-engineered, adjacent numeric matrices ($X$) and binary outcome columns ($Y$).
- **Zero-Leakage Scratch Preprocessing**:
  - Imputes missing numeric values using training-partition medians (or complete-case drop).
  - Encodes low-cardinality categoricals into $k-1$ dummy indicators with documented reference levels and unknown/missing category fallbacks.
  - Preprocessing parameters are learned strictly on training rows; cross-validation folds independently fit their own scratch preprocessors.
- **Flexible range selection**: Supports cell addresses (`churn_data!A1:I401`, `$A$1:$I$401`) and Excel defined names (`CustomerFeatures`, `ChurnOutcome`, `NewCustomers`, worksheet-local names, or explicit `'Sheet'!Name`).
- **Deterministic scope resolution**: Displays a resolution preview showing name scope and resolved absolute cells before fitting or scoring.
- **Snapshot protection**: Verifies named range definitions, dimensions, and cell values before report export; prevents stale or redirected exports.
- **Training diagnostics**: Convergence status, gradient norm, iteration count, initial and final loss.
- **Bounded training-loss curve**: Real-time Chart.js visualization of binary cross-entropy vs iteration.
- **Model parameters**: Learned weights ($w$), intercept ($b$), and exponentiated odds ratios.
- **Performance evaluation**: Fixed 0.50 metrics, training majority-class baseline, log loss, Brier score, ROC curve, and tied-score AUC on held-out test data.
- **Linked partition controls**: Synchronized Train % and Test % numeric fields with slider and row allocation preview.
- **Interactive threshold tuning**: Live confusion matrix, precision, recall, and F1 updates.
- **What-if calculator & Raw Table scoring**: Score single hypothetical inputs (with raw dropdowns for categorical features) or raw workbook sheets with reordered columns using the active model pipeline.
- **Excel report export**: Writes settings, parameters, loss history, metrics, and source-row predictions (with train/test partition tags) to a new worksheet without modifying source data.

---

## Architecture

```text
    Excel Task Pane (Office.js + Vanilla CSS + Chart.js)
      Reads table or numeric inputs via shared resolver (cell addresses or defined named ranges)
      Profiles schema, detects leakage, allows non-adjacent column selection
      Displays resolution summary and multirow sample preview
      Sends HTTPS JSON payload with scratch settings (alpha, iters, tol, lambda)
                |
                v
    FastAPI Service (backend/)
      TablePreprocessorScratch: train-only median imputation & dummy encoding
      StandardScalerScratch: fits means and population scales on training data only
      train_test_split_scratch: seeded stratified split with exact complement rounding
      LogisticRegressionScratch: pure NumPy sigmoid, BCE, and full-batch gradient descent
      metrics.py: confusion matrix, log loss, ROC, and tied-score AUC
                |
                v
    Excel Task Pane
      Renders training loss curve, ROC curve, coefficients bar chart, and metrics
      Allows threshold exploration, single-row what-if prediction, and report export
```

---

## Core Mathematical Equations

The learning engine implements the handwritten mathematical equations from the mentor review:

1. **Linear Score (Logit):**
   $$z_i = \sum_{j=1}^d w_j x_{ij} + b = \mathbf{w}^T \mathbf{x}_i + b$$
2. **Sigmoid Probability:**
   $$p_i = \sigma(z_i) = \frac{1}{1 + e^{-z_i}}$$
3. **Training Objective (Binary Cross-Entropy):**
   $$J(\mathbf{w}, b) = -\frac{1}{m} \sum_{i=1}^m \left[ y_i \ln(p_i) + (1 - y_i) \ln(1 - p_i) \right] + \frac{\lambda}{2} \|\mathbf{w}\|_2^2$$
4. **Analytical Gradients:**
   $$\mathbf{d}\mathbf{w} = \frac{1}{m} \mathbf{X}^T (\mathbf{p} - \mathbf{y}) + \lambda \mathbf{w}, \quad db = \frac{1}{m} \sum_{i=1}^m (p_i - y_i)$$
5. **Simultaneous Parameter Update:**
   $$\mathbf{w}^{(t+1)} = \mathbf{w}^{(t)} - \alpha \, \mathbf{d}\mathbf{w}^{(t)}, \quad b^{(t+1)} = b^{(t)} - \alpha \, db^{(t)}$$

Detailed derivations, numerical stability proofs, and a worked arithmetic example are provided in [`docs/LOGISTIC_REGRESSION_EQUATIONS.md`](docs/LOGISTIC_REGRESSION_EQUATIONS.md). Evaluation benchmarks and observed live evidence are documented in [`docs/EVALUATION.md`](docs/EVALUATION.md).

---

## Project Structure

```text
sample_data.xlsx                  400-row synthetic customer churn workbook
docs/
  LOGISTIC_REGRESSION_EQUATIONS.md Formal mathematical derivations, dimensions, and proofs
  EVALUATION.md                   Benchmark methodology and software checks
MENTOR_PRESENTATION_GUIDE.md      Mentor demo script, checklist, and architectural Q&A
backend/
  logistic_scratch.py             Pure NumPy stable sigmoid, BCE loss, gradients, and GD fit loop
  table_schema.py                 Table profiling, type inference, leakage detection, and schemas
  table_preprocessing.py          Pure NumPy TablePreprocessorScratch (train-only median/mode & dummy encoding)
  preprocessing.py                Pure NumPy StandardScalerScratch and constant feature checks
  splitting.py                    Seeded stratified train/test split and StratifiedKFoldScratch
  metrics.py                      Confusion matrix, accuracy, precision, recall, F1, AUC, log loss
  model.py                        Training and evaluation coordinator (numeric and table pipelines)
  main.py                         FastAPI service (/health, /train, /predict, /profile-table, /train-table, /predict-table)
  test_api.py                     Local and HTTP smoke test script
  evaluate_real_data.py           Reproducible local CSV benchmark (breast cancer dataset)
  breast_cancer.csv               Local 569-row benchmark dataset
  tests/                          Complete automated Python unit and integration test suite
addin/
  manifest.xml                    Office add-in XML manifest (ExcelApi 1.4+ requirement)
  dev-server.js                   Local HTTPS static file server
  src/taskpane/
    range-input.js                Shared asynchronous resolver for cell addresses & defined names
    taskpane.html                 Task pane layout with mode switcher, table preview & column selector
    taskpane.css                  Responsive task pane stylesheet with resolution and table preview styling
    taskpane.js                   Data acquisition, Chart.js charts, table preprocessing, diagnostics, export audit
  tests/
    range-input.test.js           Unit test suite for range resolution, scopes, syntax, and errors
    taskpane.test.js              Integration test suite for UI flows, model fitting, and exports
```

---

## Running Locally

### 1. Start the Excel Task Pane

```bash
cd addin
npm install
npm run cert   # Installs local HTTPS development certificate
npm start      # Serves add-in at https://localhost:3001
```

### 2. Start the Backend Service

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload --port 8000 \
  --ssl-keyfile ~/.office-addin-dev-certs/localhost.key \
  --ssl-certfile ~/.office-addin-dev-certs/localhost.crt
```

Check health at `https://localhost:8000/health`.

### 3. Sideload the Add-in in Excel

```bash
cd addin
npm run sideload
```

Or copy `addin/manifest.xml` into your Office developer catalog folder (`~/Library/Containers/com.microsoft.Excel/Data/Documents/wef` on macOS).

---

## Running Automated Tests

Run the full verification suites from the repository root:

- **Backend Python Suite (Unit, Preprocessor, and API Integration Tests):**
  ```bash
  PYTHONPATH=backend backend/.venv/bin/python -m unittest discover -s backend/tests
  ```
- **Frontend JavaScript Suite (Range Resolver and Task Pane Tests):**
  ```bash
  npm --prefix addin test
  ```
- **Local API Smoke Test:**
  ```bash
  PYTHONPATH=backend backend/.venv/bin/python backend/test_api.py
  ```
- **Local Real-Data Benchmark:**
  ```bash
  PYTHONPATH=backend backend/.venv/bin/python backend/evaluate_real_data.py
  ```
- **Office Add-in Manifest Validation:**
  ```bash
  npm --prefix addin run validate
  ```

---

## Workload Limits & Production Guardrails

| Subsystem / Operation | Policy / Limit | Technical Rationale & Behavior |
|---|---|---|
| **Range Selection Preflight** | 500,000 cells max per range ($X$ or $Y$) | Geometry (`rowCount`, `columnCount`, `worksheet.id`) is verified in Stage 1 without requesting values. Ranges $>500,000$ cells are rejected immediately before loading values into Office.js memory. |
| **High-Dimensional Support** | Up to 12,288 features supported | Under the 500,000-cell budget, a 12,288-feature dataset accommodates 39 usable data rows plus 1 header row ($12,288 \times 40 = 491,520$ cells). |
| **Parameter Table UI** | 50 features per page + search filter | Prevents DOM bloat and UI freezing when navigating models with hundreds or thousands of features. Preserves true feature indexing ($w_{i+1}$) across search filters. |
| **What-If Calculator** | $\le 25$ source columns (Table Mode) or $\le 25$ features (Numeric Mode) | Models with $>25$ user input fields disable manual what-if inputs with clear guidance, directing users to the batch *Score new rows* workflow. Generated one-hot categorical dummy features in Table Mode do **not** count against this manual source-column limit. |
| **Truthful Explanation** | Exact mathematical contribution breakdown | Displays generated features in model order, raw values, scaled values (if standardized), learned weights, and signed contributions $w_j \hat{x}_j$. Verifies that $\sum(w_j \cdot \hat{x}_j) + b = z$ and $\sigma(z) = p$ within $10^{-6}$ tolerance, with data preparation details rendered separately. |
| **Excel Export Batching** | 250 rows, 10,000 cells, or 1 MiB per batch block | Reports and tables write in dynamically chunked batches bounded by rows ($\le 250$), cells ($\le 10,000$), and estimated UTF-8 serialized bytes ($\le 1$ MiB), executing an explicit `await context.sync()` per batch to bound queued Office.js host memory. Wide rows exceeding cell budgets are dynamically segmented across column blocks. |
| **Excel Cell Text Limits** | Exact identity preservation up to 32,767 chars | Feature names, class labels, and identity fields are preserved exactly up to Excel's 32,767 character-per-cell limit; text exceeding 32,767 characters raises an explicit validation error rather than being silently truncated. Descriptive text, previews, and warnings are wrapped or shortened cleanly via `prepareDescription`. |
| **Formula Bounds** | $\le 500$ features for horizontal Excel formulas | Excel horizontal recalculation formulas are omitted for models $>500$ features (retaining complete vertical parameter specification tables and batch predictions). |
| **Export Concurrency Protection** | Immutable export tokens | Checked after every asynchronous step (`sourceStillMatches`, `addUniqueWorksheet`, each batch chunk, and immediately after final `await context.sync()`). Exports abort if training settings, models, or thresholds change, and interrupted sheets are marked `[STALE EXPORT - CANCELLED: ...]` or `[INCOMPLETE EXPORT - CANCELLED: ...]`. Status-marker failures are surfaced without swallowing the original error. |
| **New X Input Revisions** | Per-field selection and scoring revisions | Guarantees that typing, checkbox toggles, or out-of-order and obsolete "Use selection" reads/failures do not invalidate newer predictions or display irrelevant error messages. |

