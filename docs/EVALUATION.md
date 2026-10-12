# Reproducible evaluation

The project keeps its synthetic customer-churn workbook as a quick Excel
integration demo. Its outcome was generated from a known probabilistic rule,
so its score should not be treated as evidence of real-world performance.

For a transparent software benchmark, run:

    cd backend
    .venv/bin/python evaluate_real_data.py --output breast_cancer_evaluation.json

The script uses the Breast Cancer Wisconsin (Diagnostic) dataset bundled with
scikit-learn. Scikit-learn documents 569 samples, 30 positive real-valued
features, and two classes; it identifies the upstream UCI source as:

https://archive.ics.uci.edu/dataset/17/breast+cancer+wisconsin+diagnostic

The script uses a fixed random seed of 42, a 70/30 stratified outer
train/test split, standardisation fitted only on training data, C = 1.0, and
five-fold stratified cross-validation inside the training portion. It selects
the F1 threshold from those training-side out-of-fold predictions, then
reports both 0.50-threshold and selected-threshold metrics on the untouched
outer test data.

The generated JSON records the dataset details, library version, split
settings, class balance, coefficients, metrics, and threshold source. This is
a benchmark of the add-in's classification workflow. It is not a medical
diagnostic system, and the result must not guide clinical decisions.

When presenting it, report the class balance, fixed 0.50 metrics, selected
threshold, AUC, confusion counts, and cross-validation summary. Do not tune
the model or threshold on the final test set to improve the reported score.
