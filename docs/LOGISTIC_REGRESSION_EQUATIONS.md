# Mathematical Specification and Equation Guide: Logistic Regression from Scratch

This document provides the formal mathematical foundation, derivation, dimensional analysis, worked numerical example, and codebase mapping for the binary logistic regression engine implemented in this project. It translates the handwritten equations from the mentor's review into exact, production-grade numerical algorithms.

---

## 1. Mathematical Notation and Dimensions

All vectors and matrices follow standard linear algebra and machine learning conventions:

| Symbol | Definition | Shape / Dimension | Project Context |
|---|---|---|---|
| $N$ | Total usable observations | Scalar integer | Rows selected in Excel minus header row |
| $m$ | Training observations | Scalar integer | Number of rows allocated to the training split ($m \le N$) |
| $d$ | Number of features | Scalar integer | Number of predictor columns ($X$) |
| $\mathbf{X}$ | Feature matrix | Matrix $(m \times d)$ | Training inputs (standardized or raw) |
| $\mathbf{x}_i$ | Feature vector for row $i$ | Vector $(d \times 1)$ or $(d,)$ | $i$-th row of $\mathbf{X}$ |
| $y_i$ | Ground truth outcome | Scalar $\in \{0, 1\}$ | Encoded binary class (negative = 0, positive = 1) |
| $\mathbf{y}$ | Target vector | Vector $(m \times 1)$ or $(m,)$ | Binary outcomes for all training rows |
| $\mathbf{w}$ | Weight coefficients | Vector $(d \times 1)$ or $(d,)$ | Learned feature weights (log-odds slopes) |
| $b$ | Intercept / bias | Scalar | Learned offset |
| $z_i$ | Linear score (logit) | Scalar | $z_i = \mathbf{w}^T \mathbf{x}_i + b = \sum_{j=1}^d w_j x_{ij} + b$ |
| $\mathbf{z}$ | Score vector | Vector $(m \times 1)$ or $(m,)$ | $\mathbf{z} = \mathbf{X}\mathbf{w} + b\mathbf{1}$ |
| $p_i$ | Predicted probability | Scalar $\in [0, 1]$ | $P(Y=1 \mid \mathbf{x}_i) = \sigma(z_i)$ |
| $\mathbf{p}$ | Probability vector | Vector $(m \times 1)$ or $(m,)$ | Elementwise sigmoid of $\mathbf{z}$ |
| $J(\mathbf{w}, b)$ | Cost / Objective function | Scalar | Binary cross-entropy (negative log-likelihood) |
| $\alpha$ | Learning rate | Scalar $> 0$ | Gradient descent step size |
| $\lambda$ | L2 regularization coefficient | Scalar $\ge 0$ | Ridge penalty parameter (`l2_lambda`) |
| $\mathbf{d}\mathbf{w}$ | Weight gradient $\nabla_{\mathbf{w}} J$ | Vector $(d \times 1)$ or $(d,)$ | Partial derivatives $\frac{\partial J}{\partial \mathbf{w}}$ |
| $db$ | Intercept gradient $\frac{\partial J}{\partial b}$ | Scalar | Partial derivative $\frac{\partial J}{\partial b}$ |
| $t$ | Iteration index | Scalar integer | Current step of full-batch gradient descent |

---

## 2. Core Equations

### 2.1 Linear Combination (Score / Logit)
For observation $i$:
$$z_i = \sum_{j=1}^d w_j x_{ij} + b$$
In vectorized form across the entire training batch:
$$\mathbf{z} = \mathbf{X}\mathbf{w} + b\mathbf{1}_m$$

### 2.2 Activation Function (Sigmoid)
The standard logistic sigmoid maps real numbers $(-\infty, \infty)$ monotonically into probabilities $(0, 1)$:
$$p_i = \sigma(z_i) = \frac{1}{1 + e^{-z_i}}$$
When $z_i = 0$, $p_i = \sigma(0) = \frac{1}{1 + 1} = 0.5$.

### 2.3 Training Objective (Binary Cross-Entropy Loss)
Under the Bernoulli likelihood model, the likelihood of observation $i$ is:
$$L_i = p_i^{y_i} (1 - p_i)^{1 - y_i}$$
The negative log-likelihood per observation is:
$$\ell_i = - \left[ y_i \ln(p_i) + (1 - y_i) \ln(1 - p_i) \right]$$
Averaging over the $m$ training rows yields the mean binary cross-entropy cost $J(\mathbf{w}, b)$:
$$J(\mathbf{w}, b) = -\frac{1}{m} \sum_{i=1}^m \left[ y_i \ln(p_i) + (1 - y_i) \ln(1 - p_i) \right]$$

With optional L2 regularization ($\lambda \ge 0$, not penalizing the bias $b$):
$$J_{\text{reg}}(\mathbf{w}, b) = J(\mathbf{w}, b) + \frac{\lambda}{2} \|\mathbf{w}\|_2^2 = J(\mathbf{w}, b) + \frac{\lambda}{2} \sum_{j=1}^d w_j^2$$

### 2.4 Analytical Gradients
The partial derivatives with respect to weights $\mathbf{w}$ and bias $b$ are:
$$\mathbf{d}\mathbf{w} = \frac{\partial J}{\partial \mathbf{w}} = \frac{1}{m} \mathbf{X}^T (\mathbf{p} - \mathbf{y}) + \lambda \mathbf{w}$$
$$db = \frac{\partial J}{\partial b} = \frac{1}{m} \sum_{i=1}^m (p_i - y_i)$$

For each individual feature $j$:
$$\frac{\partial J}{\partial w_j} = \frac{1}{m} \sum_{i=1}^m (p_i - y_i) x_{ij} + \lambda w_j$$

### 2.5 Parameter Updates (Full-Batch Gradient Descent)
At iteration $t$, parameters are updated simultaneously along the negative gradient:
$$\mathbf{w}^{(t+1)} = \mathbf{w}^{(t)} - \alpha \, \mathbf{d}\mathbf{w}^{(t)}$$
$$b^{(t+1)} = b^{(t)} - \alpha \, db^{(t)}$$
Both $\mathbf{d}\mathbf{w}^{(t)}$ and $db^{(t)}$ are computed using the probabilities $\mathbf{p}^{(t)}$ prior to the update.

---

## 3. Mathematical Derivation of Gradients

Why does binary cross-entropy lead to the clean error residual $(p_i - y_i)$?

### Step 1: Derivative of the Sigmoid Function
$$\sigma'(z) = \frac{d}{dz} \left( \frac{1}{1 + e^{-z}} \right) = \frac{e^{-z}}{(1 + e^{-z})^2} = \left(\frac{1}{1 + e^{-z}}\right) \left(\frac{e^{-z}}{1 + e^{-z}}\right) = \sigma(z)(1 - \sigma(z)) = p(1 - p)$$

### Step 2: Derivative of Single-Sample Loss with Respect to Probability
$$\ell_i = - [y_i \ln(p_i) + (1 - y_i) \ln(1 - p_i)]$$
$$\frac{\partial \ell_i}{\partial p_i} = - \left( \frac{y_i}{p_i} - \frac{1 - y_i}{1 - p_i} \right) = \frac{p_i - y_i}{p_i(1 - p_i)}$$

### Step 3: Chain Rule for the Logit $z_i$
$$\frac{\partial \ell_i}{\partial z_i} = \frac{\partial \ell_i}{\partial p_i} \cdot \frac{\partial p_i}{\partial z_i} = \left( \frac{p_i - y_i}{p_i(1 - p_i)} \right) \cdot \left[ p_i(1 - p_i) \right] = p_i - y_i$$
Notice how the non-linear denominator $p_i(1 - p_i)$ cancels completely with the sigmoid derivative.

### Step 4: Chain Rule for Weights and Bias
Since $z_i = \sum_{j=1}^d w_j x_{ij} + b$:
$$\frac{\partial z_i}{\partial w_j} = x_{ij}, \quad \frac{\partial z_i}{\partial b} = 1$$
Therefore:
$$\frac{\partial \ell_i}{\partial w_j} = \frac{\partial \ell_i}{\partial z_i} \cdot \frac{\partial z_i}{\partial w_j} = (p_i - y_i) x_{ij}$$
$$\frac{\partial \ell_i}{\partial b} = \frac{\partial \ell_i}{\partial z_i} \cdot \frac{\partial z_i}{\partial b} = (p_i - y_i)$$

Averaging across all $m$ samples:
$$\frac{\partial J}{\partial \mathbf{w}} = \frac{1}{m} \sum_{i=1}^m (p_i - y_i) \mathbf{x}_i = \frac{1}{m} \mathbf{X}^T (\mathbf{p} - \mathbf{y})$$
$$\frac{\partial J}{\partial b} = \frac{1}{m} \sum_{i=1}^m (p_i - y_i)$$

---

## 4. Discussion of the Mentor's Squared-Error Equation

The mentor's reference photograph includes a lower formula:
$$\frac{1}{2m} \sum_{i=1}^m (p_i - y_i)^2$$

### Distinction from Binary Cross-Entropy
1. **Nature of the Metric**: This formula is **half the Mean Squared Error (MSE)** between probabilities and binary targets. Without the $\frac{1}{2}$ scalar, it is known in probabilistic forecasting as the **Brier Score**.
2. **Not R-squared**: Ordinary $R^2$ measures explained variance for continuous linear regression. In binary classification, $R^2$ is inappropriate and can yield negative or misleading values.
3. **Different Gradients**: If one were to minimize MSE for logistic regression, the chain rule would yield:
   $$\frac{\partial \ell_i^{\text{MSE}}}{\partial z_i} = (p_i - y_i) \cdot p_i(1 - p_i)$$
   The extra factor $p_i(1 - p_i)$ vanishes when $p_i \to 0$ or $p_i \to 1$, leading to **vanishing gradients and non-convex local plateaus**.
4. **Implementation Decision**: Binary cross-entropy is the canonical Maximum Likelihood Estimation (MLE) criterion for Bernoulli processes. Our training engine optimizes binary cross-entropy ($J$). MSE / Brier score is computed purely as an evaluation diagnostic, never mixed with cross-entropy update gradients.

---

## 5. Numerical Stability in Floating-Point Arithmetic

Directly computing $\sigma(z) = 1 / (1 + e^{-z})$ and $\ln(p)$ causes floating-point overflow (`exp(1000) -> inf`) or underflow (`log(0) -> -inf`). Our implementation uses numerically stable branches:

### Stable Sigmoid
For scalar or array $z$:
$$\sigma(z) = \begin{cases}
\frac{1}{1 + e^{-z}} & \text{if } z \ge 0 \\
\frac{e^z}{1 + e^z} & \text{if } z < 0
\end{cases}$$
Both branches guarantee exponent arguments $\le 0$, preventing overflow.

### Stable Binary Cross-Entropy Loss
Instead of evaluating probabilities and taking logarithms, compute loss directly from the logit $z_i$:
$$- [y \ln(p) + (1 - y) \ln(1 - p)] = \ln(1 + e^z) - y z = \text{logaddexp}(0, z) - y z$$
Proof:
$$\ln(p) = \ln\left(\frac{1}{1 + e^{-z}}\right) = -\ln(1 + e^{-z}) = z - \ln(1 + e^z)$$
$$\ln(1 - p) = \ln\left(\frac{e^{-z}}{1 + e^{-z}}\right) = -z - \ln(1 + e^{-z}) = -\ln(1 + e^z)$$
$$- [y(z - \ln(1 + e^z)) + (1-y)(-\ln(1 + e^z))] = \ln(1 + e^z) - yz$$
In NumPy, `np.logaddexp(0, z) - y * z` computes this stably for all $z \in (-\infty, \infty)$ without evaluating intermediate infinities.

---

## 6. Worked Arithmetic Example (Single Observation)

To verify the code against manual calculations, consider a minimal single-row fixture:
- Feature: $x = 2.0$ ($d=1$)
- Label: $y = 1$
- Learning rate: $\alpha = 0.1$
- Initial parameters: $w = 0.0$, $b = 0.0$

### Step 1: Linear Logit
$$z = w \cdot x + b = 0.0 \cdot 2.0 + 0.0 = 0.0$$

### Step 2: Probability
$$p = \sigma(0.0) = \frac{1}{1 + e^{-0}} = 0.5$$

### Step 3: Initial Loss
$$J = - [1 \cdot \ln(0.5) + 0 \cdot \ln(0.5)] = -\ln(0.5) = \ln(2) \approx 0.693147$$

### Step 4: Gradients
$$dw = \frac{1}{1} (p - y) \cdot x = (0.5 - 1.0) \cdot 2.0 = -0.5 \cdot 2.0 = -1.0$$
$$db = \frac{1}{1} (p - y) = (0.5 - 1.0) = -0.5$$

### Step 5: Simultaneous Parameter Update
$$w_{\text{next}} = w - \alpha \cdot dw = 0.0 - 0.1 \cdot (-1.0) = +0.10$$
$$b_{\text{next}} = b - \alpha \cdot db = 0.0 - 0.1 \cdot (-0.5) = +0.05$$

### Step 6: Verify Next State
$$z_{\text{next}} = w_{\text{next}} \cdot x + b_{\text{next}} = 0.10 \cdot 2.0 + 0.05 = 0.25$$
$$p_{\text{next}} = \sigma(0.25) = \frac{1}{1 + e^{-0.25}} = \frac{1}{1 + 0.778801} \approx 0.562177$$
$$J_{\text{next}} = -\ln(0.562177) \approx 0.575939$$

The probability increased toward the true label $y=1$ ($0.50 \to 0.5622$), and the cost decreased ($0.6931 \to 0.5759$). This exact sequence is tested in `backend/tests/test_logistic_scratch.py`.

---

## 7. Statistical Interpretability: Odds Ratios

In logistic regression, the logit is linear in features:
$$\ln\left(\frac{p}{1 - p}\right) = \mathbf{w}^T \mathbf{x} + b$$
The ratio $\frac{p}{1 - p}$ is the **odds** of the positive event ($Y=1$).

When feature $j$ increases by 1 unit ($\Delta x_j = 1$) while all other features remain constant:
$$\Delta \ln(\text{odds}) = w_j \implies \text{odds}_{\text{new}} = \text{odds}_{\text{old}} \cdot e^{w_j}$$
- $w_j > 0 \implies e^{w_j} > 1$: Increasing $x_j$ increases odds of $Y=1$.
- $w_j < 0 \implies e^{w_j} < 1$: Increasing $x_j$ decreases odds of $Y=1$.
- $w_j = 0 \implies e^{w_j} = 1$: Feature $x_j$ has no linear association with the log-odds.

**Note on Standardization**: When features are standardized ($\tilde{x}_j = \frac{x_j - \mu_j}{\sigma_j}$), $w_j$ represents the change in log-odds per **one standard deviation** change in the raw feature.

---

## 8. Codebase Mapping

| Mathematical Concept | Implementation Module | Function / Class |
|---|---|---|
| Stable Sigmoid $\sigma(z)$ | `backend/logistic_scratch.py` | `sigmoid(z)` |
| Binary Cross-Entropy $J(\mathbf{w}, b)$ | `backend/logistic_scratch.py` | `compute_bce_loss(X, y, w, b, l2_lambda, sample_weights)` |
| Vectorized Gradients $\mathbf{d}\mathbf{w}, db$ | `backend/logistic_scratch.py` | `compute_gradients(X, y, w, b, l2_lambda, sample_weights)` |
| Full-batch Fit Loop & Step Halving | `backend/logistic_scratch.py` | `LogisticRegressionScratch.fit(...)` |
| Feature Scaling $\frac{x - \mu}{\sigma}$ | `backend/preprocessing.py` | `StandardScalerScratch` |
| Stratified Split & Complement Rounding | `backend/splitting.py` | `train_test_split_scratch(...)` |
| Stratified K-Fold CV | `backend/splitting.py` | `StratifiedKFoldScratch` |
| Confusion, Accuracy, Precision, Recall, F1 | `backend/metrics.py` | `confusion_matrix_scratch`, `classification_metrics` |
| Log Loss | `backend/metrics.py` | `log_loss_scratch` |
| ROC Curve & Tied-score AUC | `backend/metrics.py` | `roc_curve_scratch`, `roc_auc_scratch` |
| End-to-end Pipeline & Training Coordination | `backend/model.py` | `train_logistic(...)` |
| REST API Endpoints & Request Validation | `backend/main.py` | `/train`, `/predict`, `/health` |

---

## 9. Parameter Spaces and Exact Conversion Derivation

When training with feature standardization enabled, gradient descent learns weights in **standardized feature space**:
$$z = \sum_{j=1}^d w_{\text{model}, j} \tilde{x}_j + b_{\text{model}}$$
where each feature is normalized using the training set mean $\mu_j$ and population standard deviation $\sigma_j$:
$$\tilde{x}_j = \frac{x_j - \mu_j}{\sigma_j}$$

### 9.1 Mathematical Derivation of Original-Unit Parameters

To allow users and spreadsheets to evaluate predictions directly on raw, unscaled business values $x_j$, we substitute the definition of $\tilde{x}_j$ into the linear combination:
$$z = \sum_{j=1}^d w_{\text{model}, j} \left( \frac{x_j - \mu_j}{\sigma_j} \right) + b_{\text{model}}$$
Expanding the linear terms:
$$z = \sum_{j=1}^d \left( \frac{w_{\text{model}, j}}{\sigma_j} x_j - \frac{w_{\text{model}, j} \mu_j}{\sigma_j} \right) + b_{\text{model}}$$
Grouping by the raw variable $x_j$ and collecting all constant terms:
$$z = \sum_{j=1}^d \left( \frac{w_{\text{model}, j}}{\sigma_j} \right) x_j + \left( b_{\text{model}} - \sum_{j=1}^d \frac{w_{\text{model}, j} \cdot \mu_j}{\sigma_j} \right)$$

Comparing this to the canonical original-unit equation:
$$z = \sum_{j=1}^d w_{\text{orig}, j} x_j + b_{\text{orig}}$$
we obtain the exact closed-form parameter conversion formulas:
$$\boxed{w_{\text{orig}, j} = \frac{w_{\text{model}, j}}{\sigma_j}}$$
$$\boxed{b_{\text{orig}} = b_{\text{model}} - \sum_{j=1}^d \frac{w_{\text{model}, j} \cdot \mu_j}{\sigma_j} = b_{\text{model}} - \sum_{j=1}^d w_{\text{orig}, j} \cdot \mu_j}$$

### 9.2 Properties of the Conversion
1. **Exact Equivalence**: For any input row $\mathbf{x} \in \mathbb{R}^d$, the linear score evaluated in model space $\mathbf{w}_{\text{model}}^T \tilde{\mathbf{x}} + b_{\text{model}}$ and the score evaluated in original space $\mathbf{w}_{\text{orig}}^T \mathbf{x} + b_{\text{orig}}$ are mathematically identical. In IEEE 754 64-bit floating point arithmetic, they agree within $10^{-12}$.
2. **Unstandardized Models**: When standardization is disabled (`standardize=False`), no scaling transform is applied ($\mu_j = 0, \sigma_j = 1$). In that case:
   $$w_{\text{orig}, j} = w_{\text{model}, j}, \quad b_{\text{orig}} = b_{\text{model}}$$
3. **Zero-Variance Safeguard**: If a feature column has zero variance ($\sigma_j = 0$), the scaler sets the effective scale to $1.0$ (leaving centered values as $0$) to prevent division-by-zero.
4. **Pure Transformation**: Parameter conversion is an exact post-training algebraic mapping. It never retrains or alters the model state.

---

## 10. Structural Clarifications: Dimensions, Biases, and Thresholds

To prevent conceptual confusion during faculty examinations:

### 10.1 Feature Weights ($d$) vs Observation Counts ($N$)
- The number of learned weights is determined strictly by the number of features $d$, not by sample size $N$ or batch size $m$.
- A dataset with $d=3$ predictor columns will always yield exactly **3 feature weights** ($w_1, w_2, w_3$) plus **1 intercept** ($b$), regardless of whether the spreadsheet contains 50 rows or 50,000 rows.

### 10.2 Learned Bias ($b$) vs Hyperparameters ($\alpha, \lambda$)
- The intercept $b$ is a **learned parameter** (an offset scalar) updated by gradient descent at each iteration ($db = \frac{1}{m}\sum (p_i - y_i)$).
- Learning rate $\alpha$ is a **training hyperparameter** controlling gradient step size.
- Regularization coefficient $\lambda$ is a **penalty hyperparameter** controlling weight shrinkage.
- Notice that the bias $b$ is deliberately exempt from L2 regularization, ensuring that baseline prevalence shifts do not distort classification calibration.

### 10.3 Linear Score ($z$) vs Probability ($p$) vs Class ($\hat{y}$)
- **Linear score $z \in (-\infty, \infty)$**: The log-odds logit, representing feature evidence.
- **Probability $p \in (0, 1)$**: The squashed monotonic likelihood $p = \sigma(z) = 1 / (1 + e^{-z})$.
- **Predicted Class $\hat{y} \in \{0, 1\}$**: The discrete decision rule application $\hat{y} = \mathbb{I}(p \ge \tau)$ where $\tau$ is the classification threshold.

### 10.4 Threshold Invariance
- Modifying the decision threshold $\tau$ (e.g. from 0.50 to 0.75) updates the decision rule and confusion matrix, but **never changes the fitted weights $\mathbf{w}$, bias $b$, linear scores $z$, or probabilities $p$**.
- To change weights, the underlying data, split partition, or training parameters must be altered and the model refit.

---

## 11. Worked Three-Feature Inference Example

Consider a three-feature fitted churn model with:
- Features: $x_1$ = Tenure (months), $x_2$ = MonthlyCharges (dollars), $x_3$ = Contract (years: 0, 1, or 2)
- Training Means: $\mu_1 = 24.0, \mu_2 = 70.0, \mu_3 = 1.0$
- Training Scales: $\sigma_1 = 12.0, \sigma_2 = 25.0, \sigma_3 = 0.8$
- Fitted Model-Space Weights:
  $$w_{\text{model}, 1} = -0.60, \quad w_{\text{model}, 2} = +0.50, \quad w_{\text{model}, 3} = -0.40$$
  $$b_{\text{model}} = -0.20$$

### Step 1: Parameter Conversion to Original Units
$$w_{\text{orig}, 1} = \frac{-0.60}{12.0} = -0.0500$$
$$w_{\text{orig}, 2} = \frac{+0.50}{25.0} = +0.0200$$
$$w_{\text{orig}, 3} = \frac{-0.40}{0.8} = -0.5000$$

$$b_{\text{orig}} = -0.20 - \left[ (-0.0500)(24.0) + (0.0200)(70.0) + (-0.5000)(1.0) \right]$$
$$b_{\text{orig}} = -0.20 - [-1.20 + 1.40 - 0.50] = -0.20 - [-0.30] = +0.1000$$

### Step 2: New Observation Evaluation
Suppose a customer has raw values:
$$x_1 = 36.0 \text{ months}, \quad x_2 = 85.0 \text{ dollars}, \quad x_3 = 0.0 \text{ years}$$

#### Method A: Evaluation in Standardized Coordinates
$$\tilde{x}_1 = \frac{36.0 - 24.0}{12.0} = +1.00$$
$$\tilde{x}_2 = \frac{85.0 - 70.0}{25.0} = +0.60$$
$$\tilde{x}_3 = \frac{0.0 - 1.0}{0.8} = -1.25$$

Contributions:
$$c_1 = w_{\text{model}, 1} \cdot \tilde{x}_1 = (-0.60)(1.00) = -0.6000$$
$$c_2 = w_{\text{model}, 2} \cdot \tilde{x}_2 = (+0.50)(0.60) = +0.3000$$
$$c_3 = w_{\text{model}, 3} \cdot \tilde{x}_3 = (-0.40)(-1.25) = +0.5000$$
$$\sum_{j=1}^3 c_j = -0.6000 + 0.3000 + 0.5000 = +0.2000$$
$$z = \sum c_j + b_{\text{model}} = +0.2000 + (-0.2000) = 0.0000$$

#### Method B: Evaluation in Original-Unit Coordinates
$$z = w_{\text{orig}, 1} x_1 + w_{\text{orig}, 2} x_2 + w_{\text{orig}, 3} x_3 + b_{\text{orig}}$$
$$z = (-0.0500)(36.0) + (0.0200)(85.0) + (-0.5000)(0.0) + 0.1000$$
$$z = -1.8000 + 1.7000 + 0.0000 + 0.1000 = 0.0000$$
Notice that Method A and Method B evaluate to the exact same logit $z = 0.0000$.

### Step 3: Sigmoid Probability
$$p = \sigma(z) = \sigma(0.0000) = \frac{1}{1 + e^{-0}} = \frac{1}{2} = 0.5000 \quad (50.00\%)$$

### Step 4: Decision Rule at Chosen Threshold $\tau$
- If threshold $\tau = 0.45$: Since $p = 0.50 \ge 0.45$, Predicted Class = **1 (Positive / Churn)**.
- If threshold $\tau = 0.60$: Since $p = 0.50 < 0.60$, Predicted Class = **0 (Negative / Stay)**.

---

## 12. Excel Recalculable Formula Implementation

When exporting model weights to an Excel worksheet via **Export model weights**, the add-in writes live formulas that allow users to alter input cells and observe instantaneous recalculation without running Python:

### 12.1 Dimension-Matching Rule for SUMPRODUCT
Excel's `SUMPRODUCT(array1, array2)` requires that both ranges have identical dimensions (e.g. both are $1 \times d$ horizontal rows). If an example input row is horizontal (`B25:D25`) and the weights are vertical, `SUMPRODUCT` emits an error. Our export helper writes a horizontal weight row directly aligned with the horizontal input row:

| Row | Label | Feature 1 ($x_1$) | Feature 2 ($x_2$) | Feature 3 ($x_3$) |
|---|---|---|---|---|
| 25 | Example Inputs | `36.0` | `85.0` | `0.0` |
| 26 | Weights ($w_{\text{orig}}$) | `-0.050000` | `0.020000` | `-0.500000` |

### 12.2 Recalculable Formulas
With the bias placed in cell `B27` and the classification threshold placed in cell `B28`:

1. **Linear Score ($z$):**
   ```excel
   =SUMPRODUCT(C25:E25, C26:E26) + B27
   ```
2. **Numerically Stable Sigmoid Probability ($p$):**
   ```excel
   =IF(B30>=0, 1/(1+EXP(-B30)), EXP(B30)/(1+EXP(B30)))
   ```
   *(where `B30` contains the linear score formula)*
3. **Threshold Decision ($\hat{y}$):**
   ```excel
   =IF(B31>=B28, 1, 0)
   ```
   *(where `B31` contains the probability formula and `B28` contains the threshold)*

This enables 100% self-contained, auditable verification directly inside Microsoft Excel.

