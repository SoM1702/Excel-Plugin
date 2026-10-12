"""Generate a small, realistic binary-classification dataset (loan defaults).

Run once: `python make_loan_data.py`. Produces loan_data.csv with a header
row, four numeric features, and a 0/1 `default` outcome. Handy for testing
the add-in on a different scenario.
"""

import numpy as np

rng = np.random.default_rng(123)
n = 400

income = rng.normal(65000, 20000, n).clip(25000, 200000)
credit_score = rng.normal(680, 70, n).clip(300, 850)
loan_amount = rng.normal(20000, 8000, n).clip(2000, 100000)
employment_years = rng.normal(8, 5, n).clip(0, 40)

# "True" relationship the model should recover: 
# lower credit score, lower income, shorter employment, and higher loan amount increase risk of default.
z = (
    1.5 
    - 0.02 * (credit_score - 650) 
    - 0.00005 * (income - 50000) 
    + 0.0001 * loan_amount 
    - 0.15 * employment_years
)
prob = 1 / (1 + np.exp(-z))
default = (rng.random(n) < prob).astype(int)

header = "income,credit_score,loan_amount,employment_years,default"
rows = np.column_stack([
    income.round(0), credit_score.round(0), loan_amount.round(0),
    employment_years.round(1), default,
])

np.savetxt("loan_data.csv", rows, delimiter=",", header=header,
           comments="", fmt=["%d", "%d", "%d", "%.1f", "%d"])
print(f"Wrote loan_data.csv  ({n} rows, default rate {default.mean():.0%})")
