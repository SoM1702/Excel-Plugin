# Reproducible Evaluation and Benchmark

The project includes both a reproducible numeric benchmark (`breast_cancer.csv`, 569 rows, 30 continuous features) and observed live evaluation evidence on the original tabular Titanic dataset (891 rows, mixed numeric and categorical features).

---

## 1. Local Benchmark Execution (Breast Cancer Dataset)

Run the standalone benchmark without external ML library dependencies:

```bash
cd backend
python evaluate_real_data.py --output breast_cancer_evaluation.json
```

The benchmark:
- Loads the public Wisconsin Diagnostic Breast Cancer dataset directly from local `backend/breast_cancer.csv` (UCI Machine Learning Repository, 569 instances, 30 continuous features, binary diagnosis).
- Uses a fixed seed (42), an authoritative 70/30 stratified train/test split (exact ceiling complement rounding: 171 test rows, 398 train rows).
- Fits column means and population standard deviations (`ddof=0`) strictly on training rows using `StandardScalerScratch`.
- Executes 5-fold cross-validation inside the training portion using `StratifiedKFoldScratch` to optimize the decision threshold.
- Fits the final binary logistic regression model from scratch via full-batch gradient descent (`learning_rate=0.1`, `max_iterations=5000`, `l2_lambda=0.1`).
- Evaluates test performance on the untouched test partition at both 0.50 and the tuned threshold.

### Benchmark Findings & Interpretation

The generated JSON file records:
- **Optimization Diagnostics**: Initial loss, final loss, iteration count, gradient norm, and convergence status.
- **Classification Performance**: Held-out accuracy, precision, recall, F1, log loss, and tied-score AUC.
- **Weights & Odds Ratios**: Coefficients learned by full-batch gradient descent.

> [!NOTE]
> This benchmark demonstrates software correctness, optimization convergence, and data partition integrity. It is an algorithmic demonstration, not a medical diagnostic tool.

---

## 2. Observed Live Evaluation Evidence (Titanic Tabular Dataset)

The following observed metrics document live evaluation evidence obtained from running the add-in on the untouched tabular Titanic dataset in Excel. This is recorded evidence of software operation, not a universal benchmark:

- **Source Table**: Original tabular Titanic dataset with headers in Excel (891 rows, 15 columns from `survived` to `alone`, range `titanic!$A$1:$O$892`).
- **Target Outcome ($Y$)**: `survived` (binary: 0 = perished, 1 = survived).
- **Leakage Prevention**: Column `alive` (column N in the full table) was flagged as a potential target leakage candidate by the preprocessor and excluded from training because it is a direct textual duplicate of the target outcome.
- **Input Scope**: The tabular preprocessor handles supported scalar numeric, boolean, and low-cardinality categorical columns with documented missing/unknown policies (it does not handle arbitrary non-scalar Excel objects or image data).
- **Selected Features ($X$)**:
  - `pclass` (numeric: passenger class 1, 2, 3)
  - `sex` (categorical: reference level `male`, active dummy `sex=female`)
  - `age` (numeric: missing values imputed with training median `28.0`)
  - `sibsp` (numeric: sibling/spouse count)
  - `parch` (numeric: parent/child count)
  - `fare` (numeric: passenger fare)
  *(Note: `embarked` was omitted in this run)*
- **Data Partitioning**: 70% Train / 30% Test stratified split:
  - Total usable rows: 891
  - Train set: 623 rows
  - Held-out test set: 268 rows
- **Convergence**: Full-batch gradient descent converged with monotonic cross-entropy loss reduction.
- **Held-Out Test Metrics**:
  - **Accuracy @ 0.50**: `0.817` (81.7%)
  - **ROC AUC**: `0.886`
  - **Training Majority-Class Baseline**: `0.616` (61.6% accuracy for predicting all perished)
  - **Accuracy Gain**: `+0.201` (+20.1% over majority baseline)

> [!IMPORTANT]
> The observed metrics reflect this exact feature selection (`pclass`, `sex`, `age`, `sibsp`, `parch`, `fare`), median imputation, and 70/30 partition. Selecting different columns (e.g., adding `embarked`), changing missing-value policies, or modifying hyperparameters will yield different metric values.

---

## 3. Algorithmic Correctness and Test Suite Coverage

- **Backend Python Test Suite**: Automated unit and integration tests covering the pure NumPy scratch engine (`logistic_scratch.py`), train-only standardization (`preprocessing.py`), seeded stratified splitting (`splitting.py`), tabular profiling/leakage detection (`table_schema.py`), tabular preprocessing with missing indicators and exact row coordinates (`table_preprocessing.py`), and FastAPI routes (`main.py`).
- **Add-in Frontend Test Suite**: Automated tests covering asynchronous range resolution, cell budgets, dynamic chunked writing, Excel cell text limits, concurrency protection tokens, What-If 25-input limits, and truthful mathematical prediction breakdowns.
