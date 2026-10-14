# Mentor Presentation and Walkthrough Guide

## 1. One-Minute Executive Pitch

"In response to our faculty review, we implemented binary logistic regression completely from scratch using pure NumPy—strictly adhering to the handwritten mathematical equations from the review photograph.

Our solution is an Excel task-pane add-in powered by a lightweight local FastAPI service. The user selects features ($X$) and an outcome column ($Y$) directly in Excel. We partition the data using seeded stratified splitting with linked percentage controls, fit feature scalers strictly on training rows, and execute full-batch gradient descent minimizing binary cross-entropy.

The add-in visualizes training convergence through an interactive loss curve, provides an equation reference with a worked calculation, evaluates held-out metrics on untouched test data, allows interactive threshold tuning, and exports an audit report to a new Excel sheet without modifying the original data."

---

## 2. Step-by-Step Demonstration Walkthrough

### Step 1: Open Data & Select Ranges (Addresses or Named Ranges)
- Open `sample_data.xlsx` (400 customer records, 9 features, 1 churn label).
- **Option A (Direct Cell Selection):** In the task pane, click **Use selection** for $Y$ (`churn_data!J1:J401`) and $X$ (`churn_data!A1:I401`).
- **Option B (Excel Named Ranges):** Demonstrate naming cell blocks directly in Excel:
  1. Select `A1:I401`, type `CustomerFeatures` into the Excel **Name Box** (left of formula bar), and hit Enter.
  2. Select `J1:J401`, type `ChurnOutcome` into the Name Box, and hit Enter.
  3. In the task pane, enter `ChurnOutcome` into $Y$ and `CustomerFeatures` into $X$.
- Notice the **Resolution Preview & Data Preview**:
  - Live resolution banner:
    `X: CustomerFeatures (Workbook) -> churn_data!$A$1:$I$401; 400 data rows, 9 features`
    `Y: ChurnOutcome (Workbook) -> churn_data!$J$1:$J$401; 400 data rows, 1 outcome`
  - Data preview displays 400 usable rows, 9 features, class distribution (208 negative, 192 positive), and confirms there are no all-constant columns.
- Explain deterministic scoping: workbook-scoped names resolve across any sheet, while sheet-local names are checked first on the active sheet.

### Step 2: Demonstrate Linked Partition Controls
- In Section 2 (Training options), examine the **Train % / Test % controls**.
- Show that editing Train % to `80%` automatically updates Test % to `20%`, moves the slider to `0.20`, and updates the count preview:
  `Train: 320 rows (80%), Test: 80 rows (20%) for N=400`.
- Change it back to `70% / 30%` (`Train: 280, Test: 120`). Explain the ceiling rounding formula: $n_{\text{test}} = \lceil N \cdot \text{test\_fraction} \rceil$.

### Step 3: Explain the Handwritten Equations & Worked Example
- Open the **Mathematical equations reference** card in the task pane:
  1. **Logit:** $z_i = \sum_{j=1}^d w_j x_{ij} + b = \mathbf{w}^T \mathbf{x}_i + b$
  2. **Sigmoid:** $p_i = \sigma(z_i) = \frac{1}{1 + e^{-z_i}}$
  3. **Binary Cross-Entropy Loss:** $J(\mathbf{w}, b) = -\frac{1}{m} \sum_{i=1}^m [y_i \ln(p_i) + (1-y_i) \ln(1-p_i)]$
  4. **Gradients:** $\mathbf{d}\mathbf{w} = \frac{1}{m} \mathbf{X}^T (\mathbf{p} - \mathbf{y}), \quad db = \frac{1}{m} \sum_{i=1}^m (p_i - y_i)$
  5. **Parameter Update:** $\mathbf{w} \leftarrow \mathbf{w} - \alpha \, \mathbf{d}\mathbf{w}, \quad b \leftarrow b - \alpha \, db$
- Walk through the single observation teaching arithmetic:
  - Observation: $x = 2.0, y = 1.0$. Initial $w = 0, b = 0, \alpha = 0.1$.
  - Initial logit $z = 0$, probability $p = 0.5$, loss $J = \ln(2) \approx 0.6931$.
  - Analytical gradients: $dw = (0.5 - 1.0) \times 2 = -1.0$; $db = (0.5 - 1.0) = -0.5$.
  - Updated parameters: $w = 0 - 0.1(-1.0) = 0.10$; $b = 0 - 0.1(-0.5) = 0.05$.
  - Next state: $z = 0.25$, $p \approx 0.5622$, loss $J \approx 0.5759$ (probability increases toward $y=1$, loss decreases).

### Step 4: Fit the Scratch Model
- Click **Fit scratch model**.
- Show the **Diagnostics Banner**:
  - Convergence badge: `Converged ✓` (or stopped at iteration cap).
  - Initial loss vs Final loss: e.g. $0.6931 \to 0.4578$.
  - Iteration count and final gradient norm (e.g. $< 10^{-6}$).
- Show the **Training Loss Curve**:
  - Chart.js plots binary cross-entropy vs iteration pass, demonstrating monotonic objective reduction.

### Step 5: Held-Out Evaluation & Threshold Tuning
- Review the held-out metrics cards: Accuracy @ 0.50, AUC, Precision, Recall, and majority-class baseline.
- Move the **Threshold slider**:
  - Point out that the confusion matrix (TN, FP, FN, TP) and threshold metrics (@thr) update instantaneously from held-out probabilities.

### Step 6: Export Report to a New Sheet & Snapshot Verification
- Click **Export report to new sheet**.
- Switch to the newly generated `LR Report <timestamp>` sheet in Excel:
  - Model settings and scratch algorithm identity.
  - Source tracking rows: records original input text, scope, and resolved absolute address (e.g. `CustomerFeatures (Workbook) -> churn_data!$A$1:$I$401`).
  - Convergence statistics and stopping reason.
  - Weights ($w$) and Odds Ratios ($\exp(w)$).
  - Feature scaling parameters ($\mu, \sigma$).
  - Training loss iteration history table.
  - All source-row predictions tagged with their exact partition (`"train"` vs `"test"`).
- **Demonstrate Snapshot Safety:**
  - In Excel's Name Manager, change `CustomerFeatures` target or edit cell values in the sheet, then click Export again.
  - This guarantees that exported models can never become desynchronized from the worksheet data.

### Step 7: Score New Rows / What-If Prediction & Step-by-Step Breakdown
- In the task pane, test the **What-if calculator** by entering values for a customer and clicking **Calculate probability**:
  - Show the **Feature Contributions Table**: displays raw values, standardized values, weights, and individual signed contributions $w_j \tilde{x}_j$.
  - Show the **Step-by-Step Calculation Breakdown Card**:
    1. Sum of feature contributions: $\sum (w_j \cdot \tilde{x}_j) = \dots$
    2. Learned intercept: $b = \dots$
    3. Linear score: $z = \sum + b = \dots$
    4. Sigmoid probability: $p = \sigma(z) = \dots\%$
    5. Decision rule: $p \ge \text{threshold} \implies \text{Class}$.
- Move the **Threshold slider**:
  - Point out that the predicted class flips dynamically, while weights, linear score $z$, and probability $p$ remain strictly untouched.
- Edit any input field:
  - Point out that the explanation card immediately clears to avoid displaying stale calculations until recalculated.
- For batch prediction, enter either an address (`Sheet2!A2:I25`) or a defined name (`NewCustomers`), click **Score new rows**, and export the new predictions.

### Step 8: Export Model Weights & Demonstrate Live Excel Recalculation
- Click **Export model weights**.
- Switch to the newly created `Model Weights <timestamp>` worksheet in Excel:
  - Show model identification, sample count, convergence status, and feature space metadata.
  - Show the **Parameter Specification Table** with full-precision weights in both model space and original units, plus feature means and standard deviations, formatted to 6 decimal places.
  - Show the **Live Recalculable Excel Formula Example**:
    - Input row and weight row arranged horizontally so `SUMPRODUCT` evaluates with matching dimensions:
      `=SUMPRODUCT(C25:E25, C26:E26) + B27`
    - Numerically stable sigmoid formula:
      `=IF(B30>=0, 1/(1+EXP(-B30)), EXP(B30)/(1+EXP(B30)))`
    - Classification decision:
      `=IF(B31>=B28, 1, 0)`
  - **Live Test**: Edit an input cell in Excel right in front of the mentor; Excel instantly recalculates the linear score, probability, and predicted class natively without touching Python.

---

## 3. Anticipated Faculty Questions & Answers

### Q1: "Why did you use Binary Cross-Entropy instead of the squared-error expression in the photo?"
**Answer:** The squared-error expression $\frac{1}{2m}\sum (p_i - y_i)^2$ is half the Mean Squared Error (the Brier score), not binary cross-entropy. For a sigmoid activation, minimizing MSE introduces an additional $p_i(1-p_i)$ factor into the gradient, causing vanishing gradients when the model is confidently wrong. Binary cross-entropy is the canonical Maximum Likelihood Estimation (MLE) criterion for Bernoulli distributions. We compute Brier score as an evaluation diagnostic, but optimize binary cross-entropy for training.

### Q2: "How do you ensure zero data leakage?"
**Answer:**
1. **Feature scaling:** Column means and population standard deviations are computed strictly using training rows ($X_{\text{train}}$) and applied unchanged to test rows ($X_{\text{test}}$).
2. **Cross-validation:** During 5-fold CV, a fresh scaler and model are fit inside every fold.
3. **Threshold selection:** The optimal F1 threshold is selected exclusively from out-of-fold training predictions. Held-out test rows are evaluated only once after the model is locked.

### Q3: "Why are p-values and standard errors marked n/a?"
**Answer:** In full-batch gradient descent without an asymptotic inverted Hessian covariance matrix, Wald p-values cannot be rigorously guaranteed without large-sample asymptotic assumptions that gradient descent does not verify. Rather than emitting misleading pseudo p-values, we display weights and exponentiated odds ratios, and transparently mark p-values as n/a.

### Q4: "How does the algorithm handle non-decreasing steps?"
**Answer:** We implemented a step-halving line search retry. If a proposed step $\alpha$ increases the objective function, the step is halved ($\alpha \leftarrow 0.5 \alpha$) up to 15 times before accepting. If no step decreases the loss, training terminates cleanly with an explicit plateau diagnostic.

### Q5: "How does the add-in resolve Excel Named Ranges and prevent stale exports?"
**Answer:**
1. **Deterministic resolution:** Unqualified names check the active worksheet's local defined names first, then workbook-scoped names. Qualified names (`'Sheet1'!Name`) explicitly target that sheet.
2. **Unsupported inputs:** We validate that the defined name refers to a single contiguous rectangular worksheet range. Multi-area unions, external workbook links, array constants, scalar formulas, and broken `#REF!` definitions fail with clear, actionable messages.
3. **Snapshot integrity:** We snapshot the full descriptor and exact 2D values. Before exporting a report, the add-in re-verifies the named range against the saved snapshot (using its original scope, unaffected by switching active sheets). If the definition, cells, or geometry changed, the export is blocked until refitted or rescored.

### Q6: "Can you prove that your standardized model and original-unit equation give identical results?"
**Answer:** Yes. We mathematically derive the closed-form conversion:
$$w_{\text{orig}, j} = \frac{w_{\text{model}, j}}{\sigma_j}, \quad b_{\text{orig}} = b_{\text{model}} - \sum_{j=1}^d \frac{w_{\text{model}, j} \cdot \mu_j}{\sigma_j}$$
Substituting $\tilde{x}_j = (x_j - \mu_j)/\sigma_j$ shows that $\sum w_{\text{model}, j}\tilde{x}_j + b_{\text{model}} \equiv \sum w_{\text{orig}, j}x_j + b_{\text{orig}}$ identically. In backend and frontend tests, both parameterizations evaluate to the exact same score $z$ within $10^{-12}$ tolerance.

### Q7: "Can I reproduce the prediction inside Excel without your Python backend running?"
**Answer:** Yes. The **Export model weights** action writes an Excel-recalculable formula (`SUMPRODUCT(inputs, weights) + bias`, `IF(z>=0, 1/(1+EXP(-z)), EXP(z)/(1+EXP(z)))`, `IF(p>=threshold, 1, 0)`). Anyone opening the workbook in Excel can edit input cells and evaluate predictions natively without Python installed.
