# Overall system review and repair plan — 18 October 2026

## Verdict

**REQUEST CHANGES before public deployment.** The normal training and prediction paths work in the automated checks, but additional targeted probes found correctness gaps. This is not a claim that every Excel host or production environment has been tested.

Only this report was added during the review. Application source and user workbooks were not changed. Existing uncommitted work was preserved.

## Evidence from this review

| Check | Actual result |
| --- | --- |
| `PYTHONPATH=backend backend/.venv/bin/python -m unittest discover -s backend/tests -v` | 101 passed |
| `npm test` in `addin` | 107 passed |
| Local environment `pip check` | No broken requirements |
| `git diff --check` before adding this report | Passed |
| Additional sample CSV training, 5-fold CV, and prediction | Passed; 400 rows, 280 train / 120 test; accuracy 0.8167, AUC 0.8989 at threshold 0.5 |
| Additional committed Titanic JSON fixture training and raw-row prediction | Passed; fixture contains **100 rows**, not the full 891; 70 train / 30 test, accuracy 0.8000, AUC 0.8148 |
| Score the earlier numeric model after training the table model | Passed; model registry preserves both |
| Official manifest validation | **Unverified:** service DNS lookup failed. Importantly, the command nevertheless exited with status 0 |
| Docker availability | Failed: local Docker daemon socket unavailable; container build/runtime not verified |

The test suites cover scratch gradients, numerical stability, train/test splitting, training-only preprocessing, metrics, missing/category handling, model IDs, named ranges, stale requests, explanation agreement, and export batching/failure handling. Frontend tests use mocks; they are not live Excel tests. Local Python is 3.14; the configured CI/container Python 3.12 environment was not executed here. No new live Mac/Windows/web Excel, cloud, authentication, or sustained-load validation was performed.

## Confirmed findings and exact repair work

### 1. P1 — Percentage text silently changes the meaning of an input

**Location:** `backend/table_schema.py:41–54`, consumed by `backend/table_preprocessing.py`.

The parser strips `%` but does not divide by 100. A fitted numeric preprocessor transforms numeric `0.5` to `0.5`, but text `"50%"` to `50.0`. These represent the same percentage to a spreadsheet user, yet can produce very different predictions. This affects imported text percentages and mixed numeric/text columns.

**Repair:** define and implement an explicit percent parsing rule: a single trailing `%` means divide the parsed number by 100; leave existing numeric Excel values unchanged. Reject malformed repeated symbols. Reuse the same parser for profiling, fitting, and prediction. Document units rather than guessing whether ordinary `50` means 50%.

**Tests:** add cases to `backend/tests/test_table_preprocessing.py` for `0.5` versus `"50%"`, negative percentages, whitespace, malformed percentages, missing values, and train-on-numeric/predict-on-percent-text probability equivalence. Add focused parser tests if helpful.

### 2. P2 — Training accepts headers that prediction cannot distinguish

**Locations:** `backend/model.py:998–1010` and `backend/model.py:112–131`.

Training checks exact header text; prediction strips spaces and lowercases it. A 50-row training request with selected headers `Age` and `age` succeeded. Predicting with those same headers returned HTTP 400: ambiguous duplicate header. Whitespace-only variants have the same underlying inconsistency.

**Repair:** introduce one shared header identity rule and use it in profiling, training, outcome resolution, prediction, and the UI. Keep original text for display. Reject ambiguous selected columns before training; reject ambiguous outcome names instead of picking the first matching name. Keep index-based outcome selection explicit.

**Files/tests:** `backend/model.py`, `backend/table_schema.py`, `addin/src/taskpane/taskpane.js`, `backend/tests/test_table_api.py`, and `addin/tests/taskpane.test.js`. Cover case/whitespace variants, X/Y name collisions, reordered unique columns, and ordinary names. An accepted schema must be scoreable using the same headers.

### 3. P2 — Two distinct category strings collapse into one category

**Location:** `backend/table_preprocessing.py:211–215` and the matching categorical transform logic.

The escape for the literal category `_missing_` is the string `\_missing\_`. That escaped string can itself occur in user data. With both literal values present, the probe produced the same encoded vector `[1, 0]` for both, while a real blank produced `[0, 1]`. Two real categories are silently merged.

**Repair:** use collision-free internal category identities: represent missingness separately from arbitrary user strings. Keep identity distinct from display labels and generated feature labels. Ensure serialization preserves the identities. Include generated-name collision checks where source headers contain `=` or resemble encoded feature names.

**Files/tests:** `backend/table_preprocessing.py`, its serialization methods, any category-display consumers in `addin/src/taskpane/taskpane.js`, and `backend/tests/test_table_preprocessing.py`. Test both literals simultaneously, real blanks, unknown categories, reference categories, and serialization round trips. Existing literal-missing tests do not include the escaped literal at the same time.

### 4. P2 — Concurrent predictions can lose or exchange warnings

**Locations:** `backend/table_preprocessing.py` assignment to `last_transform_warnings`; `backend/model.py:141–143`.

The registry returns shared model objects. Each transform mutates a warning list on the fitted preprocessor. Prediction reads that list only after calculating scores. In a controlled interleaving, request A transformed an unseen category and generated a warning; a second transform with a known category cleared the list; A then returned no warning. This reproduces the race without relying on random timing. It does not demonstrate corrupted probability calculations.

**Repair:** return request-local warnings with the transformed matrix instead of using mutable fitted state. Update prediction, explanation, training/CV consumers, and serialization callers accordingly. A registry lock alone does not protect operations on the returned model.

**Files/tests:** `backend/table_preprocessing.py`, `backend/model.py`, `backend/tests/test_table_api.py`, `backend/tests/test_table_preprocessing.py`. Add a barrier-controlled concurrent prediction regression: only the request with the unseen category receives its warning, with unchanged scores for both requests.

### 5. P2 — Numeric prediction has an uncaught numerical-error path

**Location:** `backend/main.py:167`, calling `StandardScalerScratch.transform` in `backend/preprocessing.py`.

A model trained on small finite inputs accepted a prediction request containing finite `1e308`. Standardization overflowed; an uncaught `ValueError` propagated through the real ASGI application. The frontend receives a server failure instead of an actionable validation response. Table prediction already catches similar ValueErrors.

**Repair:** handle expected numerical input failures consistently around numeric prediction, return a JSON 400 error explaining that the values are outside the supported numerical range, and retain the usable model. Do not convert unrelated programming exceptions into validation errors. Apply a consistent policy to non-finite computed scores.

**Files/tests:** `backend/main.py`, `backend/tests/test_api.py`. Test the full HTTP route with huge finite inputs, assert status/body, then score a normal row successfully with the same model. Existing extreme-value tests do not trigger this particular scaling-overflow path.

### 6. P2 — Production manifest generation mishandles valid text and URLs

**Locations:** `addin/configure-url.js:52–54` and `:91`.

Two independent probes failed:

- Provider `Team $&` became nested `<ProviderName>` markup because JavaScript replacement strings interpret `$&`; XML escaping alone does not prevent this replacement behavior.
- Frontend base `https://example.com/a&b` was accepted but inserted without XML escaping. The generated manifest failed local XML parsing.

**Repair:** use callback replacements so replacement text is literal; XML-escape every URL inserted into XML, including the frontend base. Keep unescaped URL values for JavaScript configuration. Parse the generated XML before reporting success. Avoid modifying the development manifest.

**Files/tests:** `addin/configure-url.js`, `addin/tests/configure-url.test.js`. Cover `$&`, `$$`, replacement backtick/apostrophe tokens, ampersands, quotes, Unicode provider names, and hosted subpaths. Assert parsed element values and URL attributes, not only substring presence.

### 7. P2 — Manifest-validation CI can report success when no validation occurred

**Locations:** `.github/workflows/ci.yml` final validation step; `addin/package.json` validation script.

During this review `npm run validate` printed “Unable to contact the manifest validation service” with DNS ENOTFOUND and exited **0**. The current CI step trusts that exit status, so this failure can be green without a validated manifest.

**Repair:** wrap validation with an explicit success contract for the installed validator, or invoke an API that rejects on transport/validation failure. Fail or clearly block the release check when the service is unavailable. Validate both development and generated production manifests. Do not treat local XML well-formedness as full Office manifest certification.

**Files/tests:** `.github/workflows/ci.yml`, `addin/package.json`, a new validation wrapper and its tests. Simulate validator success, invalid manifest, network failure, and a misleading zero exit code. A service outage must not count as successful validation.

## Public-release blockers already acknowledged by the deployment plan

These are missing release capabilities, not claims that the earlier foundation sprint promised to finish them:

- **P1 public-access gate:** `backend/main.py` has no authenticated ownership checks or backend workload quotas. Browser CORS does not protect direct API calls. Require authentication/ownership and proxy/API body, row, encoded-feature, concurrency, duration, and rate limits before open public access. Do not expose the current API openly while fixing the above issues.
- **Model durability:** `backend/model_registry.py` is process-local. Restart, expiration, eviction, or routing to a different worker can lose model availability. Use one worker only for a controlled temporary beta; implement a versioned persistent shared model/preprocessing store before claiming saved models survive restarts.
- **Container hygiene:** `backend/Dockerfile` uses `COPY . .`; `backend/.dockerignore` excludes only the venv, bytecode, and sample CSV. If a backend `.env`, private key, local dataset, or other secret is added, Git ignore does not prevent it entering the image. Add explicit Docker exclusions or an allowlisted copy strategy before building a hosted image. No actual secret exposure was demonstrated in this review.
- **Long-running jobs:** the pane aborts requests after 30 seconds (`addin/src/taskpane/taskpane.js:11,629`); that does not cancel the synchronous backend training work. Large jobs need measured limits and, if needed, job status/progress/cancellation. No large-data performance claim is justified by these small fixtures.

## Repair order and acceptance gates

1. Fix percentage parsing, header identity, and category identity first. These affect data meaning or whether the trained model is usable.
2. Make transform warnings request-local and prediction error responses consistent.
3. Repair manifest generation and fail-closed manifest validation; harden Docker build contents.
4. Add all regression tests above, then run the existing 101 backend and 107 frontend checks plus the new tests. Test-suite counts will increase.
5. Run a clean install and tests under the declared Python 3.12 / Node 20 environments, build and run the container, and validate the generated production manifest using the actual service.
6. Manually test in live Excel: numeric and mixed tables, named ranges, nonadjacent selected columns, missing values, what-if versus batch agreement, threshold changes, source edits while a request is running, all exports, backend outage/restart, and repeated runs. Confirm source sheets stay unchanged.
7. Complete authenticated ownership, persistence and resource limits according to `docs/HYBRID_PUBLIC_DEPLOYMENT_PLAN.md` before a public release.

## Missing or inadequate evidence

- Current automated suites miss the seven reproduced defects above.
- `backend/tests/test_table_api.py` prefers an ignored local Titanic CSV when present and otherwise uses the committed 100-row fixture. Local and clean-checkout runs can therefore use different datasets. Use the committed fixture for deterministic CI; make the full 891-row check a separate explicit integration test with recorded row count and dataset identity.
- Registry tests prove concurrent registry operations, not thread-safe operations on models returned by the registry.
- Dependency consistency in the existing venv does not prove that a fresh Python 3.12 installation or container build succeeds.
- Mocked Excel tests do not verify Office permissions, actual worksheet layout, host limits, sideloading, TLS trust, or cross-platform behavior.
- No throughput, peak-memory, large image-pixel matrix, or multi-user load benchmark was run. A 64×64 RGB image has 12,288 features before any additional processing; treat that as a separate performance experiment, not an already supported workflow.

## Useful improvements after correctness repairs

1. **Data-preparation preview:** show detected types, parsed percentage units, imputed-cell counts, generated columns, excluded rows, and unknown-category policy before training. Let users correct mistaken type detection.
2. **Save and reopen a model:** persist the complete preprocessing pipeline, class mapping, feature order, parameters, version, owner and expiry—not just coefficient cells. Make current temporary model lifetime visible.
3. **Training progress and cancellation:** distinguish service startup, data preparation, CV, fitting and completion. Prevent repeated clicks from launching duplicate expensive jobs.
4. **Prediction comparison check:** show the same row through what-if and batch prediction and verify probability/threshold agreement. Include this in the demo checklist.

Keep the product's promise precise: it supports suitable tabular binary-classification data after validated preparation. Arbitrary text, images, multiclass outcomes, and time-series tasks are not automatically solved by logistic regression.
