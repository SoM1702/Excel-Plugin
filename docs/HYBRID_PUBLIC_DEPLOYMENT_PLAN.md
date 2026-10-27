# Hybrid Public Deployment Master Plan

This plan moves the Excel add-in from local development to an invited hosted beta, then to a secure public release. Hosting is not, by itself, a public launch. Preserve the scratch NumPy logistic-regression engine and the working localhost development path. The code now has a temporary process-local beta model registry and exact-origin CORS configuration, but it still has no authenticated user ownership, durable shared storage, or public workload controls.

This is the active deployment roadmap. Completed implementation history is consolidated in [CHANGELOG.md](../CHANGELOG.md); the earlier duplicate roadmap has been removed.

## Implementation status

- **Implemented locally:** repository ignores for secrets, generated output, and Excel lock files; tracked lock file removed from Git's index while retained on disk; exact direct Python dependency pins; GitHub Actions workflow; bounded 100-model/24-hour in-memory beta registry; configurable exact-origin CORS; and a deployment builder that generates a static bundle, production API configuration, and manifest from supplied HTTPS URLs.
- **Verified locally:** backend suite passes (114 tests) and add-in suite passes (119 tests). A bundle was generated using example HTTPS URLs and its key assets and backend configuration were checked locally; these are not live deployment addresses. The Microsoft manifest validation service and Docker daemon were unavailable in the local environment, so remote manifest validation and image build remain unverified. GitHub Actions status was not checked in this session.
- **Beta guidance:** the task pane identifies trained models as temporary, and both prediction APIs provide retraining guidance when a model is unavailable after expiry, restart, eviction, or routing to a different process. These messages do not provide persistent model storage.
- **Not deployed:** no hosting provider, staging URL, or credentials have been configured. The registry is temporary and does not provide authenticated ownership or durable storage.

## Architecture and release gates

```text
Excel (Windows, Mac, or web)
  -> installed XML manifest pointing to hosted HTTPS assets
  -> static task pane (HTML, CSS, JS, icons)
  -> HTTPS FastAPI service and scratch logistic-regression engine
  -> authenticated, per-user model store (required for public release)
```

Sideloading a manifest is for development and limited invited testing. An organization may distribute through its Microsoft 365 administrator; general-public discovery requires Microsoft Marketplace approval. Keep separate staging and production URLs, manifests, and settings.

| Gate | Audience and data | Minimum proof |
|---|---|---|
| Local development | Team; local/synthetic data | Existing training, prediction, and export tests pass. |
| Hosted invited beta | A few named testers; synthetic or approved non-sensitive data only | Works on another computer with the developer's local servers off. Staging access is restricted. |
| Public release candidate | Broader test group using approved data | Authentication, ownership, persistence, limits, privacy controls, monitoring, and cross-platform tests pass. |
| Public launch | General Excel users | Marketplace certification or another appropriate production distribution channel is complete; support and operations are ready. |

## Phase 0 — repository and release hygiene

**Files:** `.gitignore`, `backend/requirements.txt`, `addin/package-lock.json`, CI workflow, release documentation.

1. Review tracked files for Excel lock files such as `~$sample_data.xlsx`, private workbooks, `.env` files, development certificates, and generated outputs. Stop tracking unwanted files without casually rewriting Git history; add precise ignore rules.
2. Lock a *tested, compatible* set of Python and Node dependencies. Do not copy old version numbers merely because they appear in an example. Build the Docker image and run tests using the locked versions.
3. Add CI for backend and add-in tests, manifest validation, and a small train/predict smoke test. Run it on pull requests and the release branch.
4. Record real provider, support, privacy, and contact information needed by the manifest and distribution. Keep the development manifest and local certificate setup intact.

**Exit gate:** a clean clone can build and test reproducibly; no private material is committed; the release checklist is documented.

## Phase 1 — controlled hosted beta

**Files:** `backend/main.py`, `backend/Dockerfile`, `addin/configure-url.js`, `addin/src/taskpane/taskpane.js`, staging configuration, tests.

1. Replace `_LAST_MODEL` with a **temporary beta model registry** keyed by random model ID. A bounded, thread-safe in-memory LRU with expiry can prevent one beta tester's training run from immediately replacing another's. Test eviction, expiry, concurrent training, and stale IDs. This is **not multi-tenancy, persistence, or security**: models disappear on restart and separate workers do not share them.
2. Deploy static `addin/` files to an HTTPS origin and the Dockerized FastAPI backend to a separate HTTPS API origin. Verify the exact HTML, JS, CSS, commands page, and icon URLs; GitHub Pages and Vercel can use different base paths. Check `/health` remotely. Do not put secrets or certificates in the bundle or image.
3. Configure the task pane with the staging API URL automatically, retaining a localhost development setting. Make startup/outage messages clear, but do not treat a longer timeout as a solution to slow training. The current request timeout is 30 seconds.
4. Build the static bundle and manifest after choosing staging URLs. From `addin/`, run `npm run build:deployment -- <frontend-base-url> <backend-api-url> <provider-name> <support-url>`. The generated `dist/` contains the deployment assets and `manifest.prod.xml`; it sets the API URL without changing the local development configuration. Validate the manifest before sharing.
5. Set the backend's `CORS_ALLOWED_ORIGINS` environment variable to the **exact task-pane HTTPS origin** observed in browser preflight requests. Local development defaults to `https://localhost:3001`. CORS is browser origin control, not authentication. Do not add a broad Office-domain wildcard without a demonstrated need.
6. Before exposing the staging API to the internet, use provider-level access control to allow only the named beta group. Sharing a manifest privately or restricting CORS does **not** prevent direct API calls. If the selected host cannot protect the API, keep it offline until Phase 2 authentication is ready. Use synthetic or explicitly approved non-sensitive data.
7. Shut down the team's local servers, then test on a different computer: Titanic/churn fits, What-if, batch scoring, exports, named ranges, errors, and backend restart. Record the Excel platform and account type; sideload menus and policies vary.

**Exit gate:** invited testers can use the hosted add-in without the developer's computer. This does **not** authorize an open public launch or confidential workbook uploads.

## Phase 2 — public-use security, privacy, and capacity

**Files:** `backend/main.py`, `backend/model.py`, `backend/table_schema.py`, task-pane authentication/configuration, API tests, hosting configuration, privacy and support documents.

1. Choose a managed sign-in provider suitable for general users. Validate tokens on the backend. Associate each model with an authenticated user; prediction checks both owner and model ID. Test unauthorized, expired, deleted, and cross-user access. Never use CORS, model ID secrecy, or a secret embedded in JavaScript as authorization.
2. Move model state to a **shared, durable store** that survives workers and restarts. Define expiry and deletion. Do not use SQLite on an ephemeral container filesystem as the sole durable store. Serialize only validated, versioned model and preprocessing state; do not deserialize untrusted pickle data.
3. Audit the data flow before making privacy claims: workbook values are sent over HTTPS, processed in memory, and may appear in logs or errors unless deliberately excluded. Verify what artifacts retain (including categories and training statistics), where they are stored, who can access them, and when they are deleted. Publish an accurate privacy notice and add a user-facing notice before upload where appropriate.
4. Add request-body, selected-cell, row/column, generated-feature, training-time, concurrent-job, and per-user rate limits. Reject oversized work early at proxy and API layers. Choose numeric limits **after benchmarking**; do not claim that 50,000 rows × 100 columns or 10 MB JSON works merely because the backend accepts it. Excel on the web has a 5 MB Office.js request/response limit; test chunked reads and client memory. Long jobs may need a queue with progress/polling/cancel instead of a longer timeout.
5. Add safe structured logging without cell values, service/error alerts, deployment rollback, and backup/restore procedures. Use an always-on hosting tier when promising dependable public availability; free-tier spin-down and keep-alive pings are not a production reliability design.

**Exit gate:** two users can train concurrently and score only their own models; models survive restarts as promised; expiry/deletion work; oversized requests are bounded; privacy claims match the system.

## Phase 3 — release-quality verification

1. Test intended Excel platforms (web, Windows, Mac) and account/organization policies. Verify ribbon button, task pane, permissions, HTTPS, manifest update, and installation experience.
2. Run the regression matrix: Titanic and churn; numeric/categorical/boolean inputs; missing values; nonadjacent columns and named ranges; What-if versus batch agreement; threshold changes; exports; server outage; auth expiry; two-user isolation; restart; expiry; oversized inputs.
3. Benchmark progressively larger workbooks. Record actual row/cell counts, transfer sizes, training times, memory, failures, and hosting cost. Set published limits from results. Verify Office.js reads on Excel on the web before advertising large-scale support.
4. Prepare a support page, privacy policy, terms/licence, screenshots, and a short guide. State the product's actual scope: binary logistic regression on supported tabular data, not arbitrary Excel objects or raw image recognition.

**Exit gate:** a production-like staging build passes cross-platform and load checks; documentation describes observed behavior.

## Phase 4 — distribution and operations

- **Invited evaluation:** continue using the staging manifest for named testers only. Sideloading is a testing route, not general-public production distribution. Provide current platform-specific instructions rather than promising a universal 15-second install.
- **Institutions:** an authorized Microsoft 365 administrator can pilot centralized deployment to a small group, then expand. Check organization policies and licensing with that administrator.
- **General public:** submit through Microsoft Partner Center/Marketplace and meet current validation policies. Verify account requirements, fees, and timelines directly; do not rely on an unverified fixed fee or promised review duration. In-product discovery follows approval.
- **After launch:** monitor availability, errors, abuse, costs, and support requests. Keep a versioned manifest/asset release process, an incident contact, and a rollback path.

## First sprint — work to start now

1. Complete Phase 0 hygiene and CI.
2. Choose staging static and container hosts; document exact URLs and costs.
3. Implement and test the bounded **beta-only** model registry; make restart/expiry behavior visible to testers.
4. Publish static assets and API, generate/validate the staging manifest, and run the different-computer test with approved non-sensitive data.
5. Record failures and benchmark a small-to-medium workbook. **Do not post the manifest or API as an unrestricted public service at this stage.**

## Primary references

- Microsoft deployment methods: https://learn.microsoft.com/en-us/office/dev/add-ins/publish/publish
- Microsoft sideloading for testing: https://learn.microsoft.com/en-us/office/dev/add-ins/testing/sideload-office-add-ins-for-testing
- Microsoft Excel add-in resource limits: https://learn.microsoft.com/en-us/office/dev/add-ins/concepts/resource-limits-and-performance-optimization
- Microsoft Marketplace publication: https://learn.microsoft.com/en-us/office/dev/add-ins/publish/publish-office-add-ins-to-appsource
- Render free-service behavior (if selected for staging): https://render.com/docs/free
