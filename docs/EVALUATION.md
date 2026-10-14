# Reproducible Evaluation and Benchmark

The project includes both a synthetic customer churn workbook (`sample_data.xlsx`, 400 rows) for Excel integration testing and a reproducible real-world benchmark (`breast_cancer.csv`, 569 rows, 30 features).

## 1. Local Benchmark Execution

Run the standalone benchmark without external ML library dependencies:

```bash
cd backend
python evaluate_real_data.py --output breast_cancer_evaluation.json
```

The benchmark:
- Loads the public Wisconsin Diagnostic Breast Cancer dataset directly from local `backend/breast_cancer.csv` (UCI Machine Learning Repository, 569 instances, 30 continuous features, binary diagnosis).
- Uses a fixed seed (42), an authoritative 70/30 stratified train/test split (exact ceiling complement rounding: 171 test rows, 398 train rows).
- Fits column means and population standard deviations (`ddof=0`) strictly on training rows using `StandardScalerScratch`.
- Executes 5-fold cross-validation inside the training portion using `StratifiedKFoldScratch` to optimize the F1 decision threshold.
- Fits the final binary logistic regression model from scratch via full-batch gradient descent (`learning_rate=0.1`, `max_iterations=5000`, `l2_lambda=0.1`).
- Evaluates test performance on the untouched test partition at both 0.50 and the tuned threshold.

## 2. Benchmark Findings & Interpretation

The generated JSON file records:
- **Optimization Diagnostics**: Initial loss, final loss, iteration count, gradient norm, and convergence status.
- **Classification Performance**: Held-out accuracy, precision, recall, F1, log loss, and tied-score AUC.
- **Weights & Odds Ratios**: Coefficients learned by full-batch gradient descent.

> [!NOTE]
> This benchmark demonstrates software correctness, optimization convergence, and data partition integrity. It is an algorithmic demonstration, not a medical diagnostic tool.
