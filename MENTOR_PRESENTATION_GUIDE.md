# Mentor Presentation and Walkthrough Guide

## 1. Executive Pitch

"In response to our faculty review, we implemented binary logistic regression completely from scratch using pure NumPy—strictly adhering to the mathematical equations from the review photograph.

Our solution is an Excel task-pane add-in powered by a lightweight local FastAPI service. By default, the add-in operates in **Table Mode**: users select any raw, mixed rectangular Excel table with headers (such as the untouched Seaborn Titanic dataset). The system profiles column types, detects and flags potential target leakage (e.g. `alive` vs `survived`), applies training-only median imputation and dummy encoding, and partitions data using seeded stratified splitting.

The add-in visualizes training convergence through an interactive loss curve, evaluates held-out metrics against a majority-class baseline on untouched test data, provides an interactive threshold slider, enables truthful single-row What-If breakdown, and exports full reproducible audit reports to new Excel sheets without modifying the original data."

---

## 2. Table-Mode Mentor Demo Script (Recommended Flow)

Follow this concise 5-minute walkthrough during faculty evaluations:

### Step 1: Inspect Raw Mixed Table in Excel
- Open the workbook containing the raw table (e.g., the untouched Titanic dataset with 891 rows and 15 columns from `survived` to `alone`).
- In the task pane, ensure **Table Mode** is active.
- Enter or select the full table range: `titanic!$A$1:$O$892`.
- Click **Inspect table columns**.

### Step 2: Explain Automated Profiling & Target Leakage Detection
- Point out the profiling results card:
  - Total columns detected (15 columns), row count (891 rows), detected scalar data types (numeric, boolean, categorical).
  - Show the **Leakage Candidate Alert**: column `alive` (column N) is flagged as a leakage candidate because it has a 1-to-1 correspondence with `survived` (column A).
  - Explain to the mentor: *"Our preprocessor inspects the entire table and flags `alive` so that students or analysts do not accidentally train a model on a post-outcome duplicate."*
- Select `survived` as $Y$, and select the feature subset for $X$: `pclass`, `sex`, `age`, `sibsp`, `parch`, `fare` (leave `alive` and other redundant/identifier columns unchecked).

### Step 3: Choose Data Split
- In Training Options, show the linked Train % / Test % controls (e.g., 70% Train / 30% Test $\to$ 623 train rows / 268 test rows for $N=891$).
- Explain that preprocessing rules (imputation medians, dummy encoding levels, standardisation means/scales) are computed **strictly on training rows** with zero leakage into the test set.

### Step 4: Fit Scratch Model
- Click **Fit scratch model**.
- Show the **Diagnostics Banner**:
  - Convergence badge: `Converged ✓` with final gradient norm.
  - Loss trajectory: monotonic descent on binary cross-entropy $J(\mathbf{w}, b)$.
- Show the **Training Loss Curve** (Chart.js visualization).

### Step 5: Read Held-Out Metrics & Baseline Comparison
- Review the held-out performance metrics:
  - Accuracy @ 0.50 (e.g., `0.817`).
  - ROC AUC (e.g., `0.886`).
  - Training majority-class baseline (e.g., `0.616` for predicting all perished).
  - Accuracy Gain: point out `+0.201` (+20.1% improvement over simply guessing the majority class).
- Move the **Threshold slider**: show live confusion matrix and classification metric updates.

### Step 6: Inspect Parameters & Formula
- Review the learned weights table ($\mathbf{w}$) and intercept ($b$).
- Click **Export model weights** to write a native Excel recalculable formula sheet (`=SUMPRODUCT + IF/EXP`).

### Step 7: Single-Row What-If Prediction with Truthful Breakdown
- Scroll to the **Single-row what-if calculator**:
  - Enter hypothetical values for a passenger (e.g. Class 1, female, Age 35, Fare 50).
  - Click **Calculate probability**.
- Demonstrate the **Truthful Mathematical Breakdown**:
  - **Feature Table**: shows generated features (`pclass`, `sex=female`, `age`), raw values, standardized values, weights, and signed contributions $w_j \hat{x}_j$.
  - **Calculation Steps**:
    1. Sum of feature contributions: $\sum(w_j \cdot \hat{x}_j) = \dots$
    2. Learned intercept: $b = \dots$
    3. Linear score: $z = \sum + b = \dots$
    4. Sigmoid probability: $p = \sigma(z) = \dots\%$
    5. Decision: $p \ge \text{threshold} \implies \text{Class}$.
  - **Data Preparation Details**: shows exact transformations applied (e.g., `sex=female` active indicator, median imputation if age omitted, reference category baseline).
  - Explain: *"Every number in this breakdown directly sums to the linear score and matches the sigmoid probability."*

### Step 8: Batch Scoring & Export Full Audit Report
- Use **Score new rows** to score an entire new table or batch.
- Click **Export full report to new sheet** to demonstrate an immutable audit report generated without touching source rows.

---

## 3. Honest Project Limitations & Scope

When discussing the project with faculty, state these limitations transparently:

1. **No Causal Claims**: Logistic regression coefficients represent conditional statistical associations, not causal effects. Unobserved confounders or selection biases in observational data cannot be resolved purely through regression.
2. **Standard Errors and p-values Unavailable**: In full-batch gradient descent without second-order Hessian matrix inversion, classical Wald p-values cannot be rigorously produced without asymptotic covariance assumptions. We display learned weights and odds ratios, but mark asymptotic p-values as unavailable.
3. **In-Memory Model Lifecycle**: The active model resides in local service memory (`_LAST_MODEL`). The architecture is tailored for single-user analytical sessions in Excel rather than persistent multi-tenant cloud storage.
4. **Precise Input Support**: The table preprocessor supports scalar numeric, boolean, and low-cardinality categorical columns with documented median imputation, binary dummy encoding, and missing-bucket policies. It does not handle arbitrary Excel formula objects, multidimensional arrays, nested data structures, or image data.
5. **Future Work**: Multi-user cloud deployment, automated hyperparameter tuning (grid search), and deep neural architectures for unstructured/image data remain future extensions.

---

## 4. Manual Test Checklist & Verification Evidence

Record the verification status for live Excel demonstrations:

| Test Case | Objective & Steps | Expected Result | Verification Status |
|---|---|---|---|
| **1. Table Mode Inspection** | Select full table `titanic!$A$1:$O$892` and click *Inspect table columns*. | Profiles 891 rows, 15 columns; flags `alive` (col N) as leakage candidate. | **Observed in live Excel** |
| **2. Target Leakage Rejection** | Verify `alive` is flagged with warning and excluded from default $X$. | Prevents 100% artificial accuracy from duplicate outcome column. | **Observed in live Excel** |
| **3. Stratified Split Integrity** | Choose 70/30 split. Fit model on selected $X$ features. | Exactly 623 train and 268 test rows; train-only medians. | **Observed in live Excel** |
| **4. Convergence & Metrics** | Review loss curve and held-out metrics. | Converged; Acc @ 0.50: ~0.817, AUC: ~0.886 > baseline (0.616). | **Observed in live Excel** |
| **5. Batch vs What-If Equality** | Score an identical row via What-If and batch New Rows. | Predicted probability and score match to at least 6 decimal places. | **Covered by automated test** (Live Excel check pending) |
| **6. Truthful Breakdown Check** | Check that $\sum(w_j \cdot \hat{x}_j) + b = z$ and $\sigma(z) = p$ in What-If. | Feature table contributions sum plus intercept equals linear score $z$. | **Covered by automated test** (Live Excel check pending) |
| **7. Explanation Unavailable Path** | Trigger missing explanation, backend error, or contract mismatch. | Hides breakdown and steps; displays clear *Explanation unavailable* notice. | **Covered by automated test** |
| **8. Input Limit Guardrail** | Test 26 source columns in table mode. | Disables What-If button with guidance directing to *Score new rows*. | **Covered by automated test** |
| **9. Stale-Header Detection** | Rename a column header in Excel after inspection and click Fit. | Blocks training with clear error: *Table headers or columns have changed*. | **Covered by automated test** |
| **10. Invalid Cell Error** | Place text in numeric column at row 23. | Error message names exact physical Excel row: *Column 'age' (row 23)...*. | **Covered by automated test** |
| **11. Formula Recalculation** | Export model weights; edit input cell in Excel. | Excel formula recalculates $z$, $p$, and class natively without Python. | **Observed in live Excel** |
| **12. Service Offline Handling** | Stop FastAPI backend and click *Fit scratch model*. | Displays clean, actionable notification: *Backend service unreachable*. | **Observed in live Excel** |

---

## 5. Anticipated Faculty Questions & Answers

### Q1: "Why did you use Binary Cross-Entropy instead of the squared-error expression in the photo?"
**Answer:** The squared-error expression $\frac{1}{2m}\sum (p_i - y_i)^2$ is half the Mean Squared Error (the Brier score), not binary cross-entropy. For a sigmoid activation, minimizing MSE introduces an additional $p_i(1-p_i)$ factor into the gradient, causing vanishing gradients when the model is confidently wrong. Binary cross-entropy is the canonical Maximum Likelihood Estimation (MLE) criterion for Bernoulli distributions. We compute Brier score as an evaluation diagnostic, but optimize binary cross-entropy for training.

### Q2: "How do you ensure zero data leakage?"
**Answer:**
1. **Feature scaling:** Column means and population standard deviations are computed strictly using training rows ($X_{\text{train}}$) and applied unchanged to test rows ($X_{\text{test}}$).
2. **Missing value imputation:** Medians and modes are calculated strictly on the training partition.
3. **Cross-validation:** During 5-fold CV, a fresh preprocessor, scaler, and model are fit inside every fold.
4. **Threshold selection:** The optimal F1 threshold is selected exclusively from out-of-fold training predictions. Held-out test rows are evaluated only once after the model is locked.

### Q3: "Why are p-values and standard errors marked n/a?"
**Answer:** In full-batch gradient descent without an asymptotic inverted Hessian covariance matrix, Wald p-values cannot be rigorously guaranteed without large-sample asymptotic assumptions that gradient descent does not verify. Rather than emitting misleading pseudo p-values, we display weights and exponentiated odds ratios, and transparently mark p-values as n/a.

### Q4: "How does the algorithm handle non-decreasing steps?"
**Answer:** We implemented a step-halving line search retry. If a proposed step $\alpha$ increases the objective function, the step is halved ($\alpha \leftarrow 0.5 \alpha$) up to 15 times before accepting. If no step decreases the loss, training terminates cleanly with an explicit plateau diagnostic.

### Q5: "How does the add-in resolve Excel Named Ranges and prevent stale exports?"
**Answer:**
1. **Deterministic resolution:** Unqualified names check the active worksheet's local defined names first, then workbook-scoped names. Qualified names (`'Sheet1'!Name`) explicitly target that sheet.
2. **Unsupported inputs:** We validate that the defined name refers to a single contiguous rectangular worksheet range. Multi-area unions, external workbook links, array constants, scalar formulas, and broken `#REF!` definitions fail with clear, actionable messages.
3. **Snapshot integrity:** We snapshot the full descriptor and exact 2D values. Before exporting a report, the add-in re-verifies the named range against the saved snapshot. If the definition, cells, or geometry changed, the export is blocked until refitted or rescored.

### Q6: "Can you prove that your standardized model and original-unit equation give identical results?"
**Answer:** Yes. We mathematically derive the closed-form conversion:
$$w_{\text{orig}, j} = \frac{w_{\text{model}, j}}{\sigma_j}, \quad b_{\text{orig}} = b_{\text{model}} - \sum_{j=1}^d \frac{w_{\text{model}, j} \cdot \mu_j}{\sigma_j}$$
Substituting $\tilde{x}_j = (x_j - \mu_j)/\sigma_j$ shows that $\sum w_{\text{model}, j}\tilde{x}_j + b_{\text{model}} \equiv \sum w_{\text{orig}, j}x_j + b_{\text{orig}}$ identically. In backend and frontend tests, both parameterizations evaluate to the exact same score $z$ within $10^{-12}$ tolerance.

### Q7: "Can I reproduce the prediction inside Excel without your Python backend running?"
**Answer:** Yes. The **Export model weights** action writes an Excel-recalculable formula (`SUMPRODUCT(inputs, weights) + bias`, `IF(z>=0, 1/(1+EXP(-z)), EXP(z)/(1+EXP(z)))`, `IF(p>=threshold, 1, 0)`). Anyone opening the workbook in Excel can edit input cells and evaluate predictions natively without Python installed.
