# Excel Logistic Regression Add-in: Architecture and Implementation Guide

## 1. Problem and Objective

Excel is widely used for business and tabular data, but lacks built-in guided tools for binary classification modeling. This project provides a full-featured Office.js task pane add-in that enables users to select predictor features ($X$) and a binary outcome ($Y$), fit a logistic regression model from scratch, inspect training diagnostics and held-out metrics, and score hypothetical or future rows.

Per faculty mentor specifications, the model is implemented completely from scratch using pure NumPy:
- Standard logistic sigmoid function
- Binary cross-entropy loss objective (negative log-likelihood)
- Analytical vector gradients
- Full-batch gradient descent with step-halving stability safeguard
- Seeded stratified train/test partitioning with exact complement rounding
- Pure NumPy feature standardization and classification metrics

No library optimizers or machine learning frameworks (such as scikit-learn or statsmodels) are used for learning.

---

## 2. System Architecture

```text
  Excel Task Pane (Office.js + Vanilla CSS + Chart.js)
    1. Resolves X and Y ranges/names via range-input.js (cell addresses or Excel defined names)
    2. Validates non-empty, finite numeric inputs and unique headers
    3. Displays resolution summary and multirow data preview with constant-feature warnings
    4. Provides synchronized Train % / Test % inputs with allocation preview
    5. Dispatches HTTPS JSON requests to the backend service
               |
               v
  Python Backend (FastAPI + NumPy)
    backend/logistic_scratch.py: Sigmoid, BCE loss, analytical gradients, GD fit loop
    backend/preprocessing.py: StandardScalerScratch (ddof=0 population variance)
    backend/splitting.py: Seeded stratified split & StratifiedKFoldScratch
    backend/metrics.py: Confusion counts, accuracy, precision, recall, F1, log loss, AUC
    backend/model.py: Training coordinator, fold CV, optimal F1 threshold tuning
    backend/main.py: REST endpoints (/health, /train, /predict)
               |
               v
  Excel Task Pane
    6. Displays training diagnostics (convergence status, loss, gradient norm)
    7. Plots training loss curve and ROC curve using Chart.js
    8. Allows interactive threshold tuning and single-row what-if prediction
    9. Re-verifies source snapshot and exports full audit report to a new Excel worksheet
```

---

## 3. Mathematical Equations Implemented

The engine translates the mentor's handwritten review equations into vectorized algorithms:

1. **Linear Score (Logit):**
   $$z_i = \sum_{j=1}^d w_j x_{ij} + b = \mathbf{w}^T \mathbf{x}_i + b$$
2. **Sigmoid Probability:**
   $$p_i = \sigma(z_i) = \frac{1}{1 + e^{-z_i}}$$
3. **Cost Function (Binary Cross-Entropy):**
   $$J(\mathbf{w}, b) = -\frac{1}{m} \sum_{i=1}^m \left[ y_i \ln(p_i) + (1 - y_i) \ln(1 - p_i) \right] + \frac{\lambda}{2} \|\mathbf{w}\|_2^2$$
4. **Analytical Gradients:**
   $$\mathbf{d}\mathbf{w} = \frac{1}{m} \mathbf{X}^T (\mathbf{p} - \mathbf{y}) + \lambda \mathbf{w}$$
   $$db = \frac{1}{m} \sum_{i=1}^m (p_i - y_i)$$
5. **Simultaneous Update:**
   $$\mathbf{w}^{(t+1)} = \mathbf{w}^{(t)} - \alpha \, \mathbf{d}\mathbf{w}^{(t)}, \quad b^{(t+1)} = b^{(t)} - \alpha \, db^{(t)}$$

---

## 4. Evaluation and Threshold Optimization

1. **Outer Stratified Train/Test Split:**
   The test fraction is chosen by the user (5% to 80%, default 30%). Training fraction is its exact complement ($1 - \text{test\_fraction}$).
   Row counts follow exact ceiling rounding: $n_{\text{test}} = \lceil N \cdot \text{test\_fraction} \rceil$, $n_{\text{train}} = N - n_{\text{test}}$.
2. **Threshold Tuning on Training Folds:**
   When 5-fold cross-validation is enabled, out-of-fold training predictions are evaluated across a candidate threshold grid ($0.05$ to $0.95$) to find the threshold maximizing F1.
3. **Uncontaminated Final Evaluation:**
   Held-out test rows are evaluated only once at threshold 0.50 and at the suggested threshold. Test rows are never seen during parameter fitting or threshold selection.

---

## 5. Main Code Files and Responsibilities

| File | Primary Responsibility |
|---|---|
| `addin/src/taskpane/range-input.js` | Shared asynchronous resolver for cell addresses, defined names, scope inspection, and snapshot re-verification |
| `backend/logistic_scratch.py` | Stable sigmoid, BCE loss directly from logit, analytical gradients, gradient descent fit loop |
| `backend/preprocessing.py` | Feature standardization fit on training rows only, constant-feature detection |
| `backend/splitting.py` | Seeded stratified train/test partitioning and StratifiedKFold index generator |
| `backend/metrics.py` | Confusion counts, accuracy, precision, recall, F1, log loss, ROC curve, tied-score AUC |
| `backend/model.py` | Training coordinator, threshold tuning, and JSON report compilation |
| `backend/main.py` | FastAPI endpoints, Pydantic schemas, active model ID tracking |
| `docs/LOGISTIC_REGRESSION_EQUATIONS.md` | Formal mathematical derivations, dimensional analysis, and worked arithmetic example |
| `addin/src/taskpane/taskpane.html` | UI layout: linked split controls, diagnostics banner, loss chart canvas, equation card, and named range guidance |
| `addin/src/taskpane/taskpane.js` | Office.js Excel data read/write, synchronized controls, Chart.js rendering, report export |
| `addin/src/taskpane/taskpane.css` | Modern styling optimized for the Excel task pane with resolution preview styles |
| `addin/tests/range-input.test.js` | Unit tests for address parsing, scope precedence, and snapshot alteration checks |
| `addin/tests/taskpane.test.js` | Integration tests for task pane UI lifecycle, training, scoring, and export verification |

---

## 6. Model Parameters, Dual Feature Spaces, and What-If Inference

### 6.1 Dual Feature Space Parameters
To provide complete transparency between optimization theory and real-world business interpretability, every fitted model produces exact parameters in two spaces:
1. **Model Space ($\mathbf{w}_{\text{model}}, b_{\text{model}}$)**: The direct parameters learned by gradient descent on normalized data ($\tilde{x}_j = (x_j - \mu_j) / \sigma_j$).
2. **Original-Unit Space ($\mathbf{w}_{\text{orig}}, b_{\text{orig}}$)**: Exact algebraic closed-form converted parameters that operate directly on raw unscaled user inputs:
   $$w_{\text{orig}, j} = \frac{w_{\text{model}, j}}{\sigma_j}, \quad b_{\text{orig}} = b_{\text{model}} - \sum_{j=1}^d \frac{w_{\text{model}, j} \cdot \mu_j}{\sigma_j}$$
Both parameterizations evaluate to the exact same logit $z$ within $10^{-12}$ precision.

### 6.2 Parameter Tables and Concrete Equation Display
In the task pane's **Model Parameters & Mathematical Equations** card:
- Explicit Intercept ($b$) row and feature weight rows ($w_1, \dots, w_d$) are rendered with full precision.
- A concrete numerical equation is shown for models with $\le 10$ features (e.g. $z = -0.0654 \cdot x_1 + 0.0032 \cdot x_2 + 0.8123$), while a compact summation notation $z = \sum (w_j \cdot x_j) + b$ is displayed for large feature counts ($d > 10$).

### 6.3 Interactive Single-Row What-If Breakdown
The task pane provides a single-row **What-If Calculator** allowing users to enter custom predictor values and trace the complete arithmetic chain:
1. **Feature-by-Feature Table**: Shows raw value $x_j$, standardized value $\tilde{x}_j$, weight $w_j$, and signed contribution $w_j \tilde{x}_j$.
2. **Step-by-Step Breakdown Card**:
   - Step 1: Sum of feature contributions $\sum w_j \tilde{x}_j$
   - Step 2: Learned bias $b$
   - Step 3: Linear logit $z = \sum + b$
   - Step 4: Sigmoid probability $p = \sigma(z)$
   - Step 5: Decision rule comparison against active threshold $\tau$
3. **Threshold Reactivity**: Moving the threshold slider immediately updates the decision rule and predicted class without modifying weights, scores, or probabilities. Editing input fields immediately clears the explanation until recalculated.

---

## 7. Dedicated Model Weights Export & Excel Recalculation

In addition to the comprehensive training report, users can click **Export model weights** to export a standalone model audit sheet into Excel:
- **Unique Timestamped Sheet**: Automatically named `Model Weights YYYYMMDDHHMMSS` without modifying or overwriting any existing sheet.
- **Model Metadata**: Algorithm identification, model ID, training timestamp, sample size, feature space, convergence status, iterations, loss, and class mapping.
- **Complete Parameter Specification**: Full precision weights and intercept in both model-space and original units, alongside feature means and scales.
- **Recalculable Excel Example**: Exports an example row with inputs and weights placed in matching horizontal dimensions, enabling live Excel formula recalculation:
  - Linear score: `=SUMPRODUCT(inputs, weights) + bias_cell`
  - Stable probability: `=IF(score_cell>=0, 1/(1+EXP(-score_cell)), EXP(score_cell)/(1+EXP(score_cell)))`
  - Decision: `=IF(prob_cell>=threshold_cell, 1, 0)`
- **Snapshot Safety**: Re-verifies source ranges and defined names before exporting to ensure the model matches active spreadsheet state.

