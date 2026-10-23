# Deployment roadmap: from local add-in to public Excel product

This is an implementation plan, not evidence that the add-in is already public. Preserve the scratch NumPy model and the working local development path. Do not expose the present backend as an unrestricted public API: it has one process-global model, permissive CORS, no authentication, and no public workload controls.

## Target architecture

```text
Excel (Windows / Mac / web)
  -> production XML manifest
  -> HTTPS static task-pane host (HTML, CSS, JS, icons)
  -> HTTPS FastAPI service
  -> authenticated, per-user model store with expiry
```

The front end and API are two independently deployed services. GitHub holds source code and triggers deployment; it is not the running Python service. Use a staging environment before production.

## Decisions to make before coding

1. Product audience: first a small invited beta, then public Microsoft Marketplace distribution. The beta may use synthetic/non-sensitive data while security work is still underway; do not invite public users or real confidential datasets during that stage.
2. Hosting: pick one HTTPS static host for `addin/` and one container-capable host for `backend/`. Examples are Azure Static Web Apps/Container Apps or another reputable static/container pair. Choose based on the team's access, budget, region, and operational comfort; do not hard-code a provider into the model code.
3. Identity: choose a managed OpenID Connect provider that supports the intended general-public audience (not only one university tenant). Never embed a shared API secret in the JavaScript task pane. Decide whether users must sign in before sending workbook data.
4. Data retention: recommended initial policy is no raw workbook storage, short-lived per-user models (e.g. 24 hours), and explicit deletion/expiry. If users need saved models, make that a separate opt-in feature with a clear privacy policy.
5. Limits: define maximum selected cells, JSON body bytes, rows, generated features, model-training time, simultaneous jobs, and per-user rate. Measure them on real hosting before publishing a numeric guarantee.

## Phase 0 — release hygiene (no hosting yet)

Files: `.gitignore`, `README.md`, `DEPLOYMENT.md`, `addin/package.json`, `backend/requirements.txt`, CI workflow (new), tests.

- Keep `backend/.venv`, `addin/node_modules`, certificates, local `.env` files, workbooks with personal data, and generated `outputs/` out of public Git. Review the existing tracked `~$sample_data.xlsx` Excel lock file and remove it from future tracking if appropriate. Do not rewrite history casually.
- Run backend and add-in suites in CI on every pull request. Pin or lock Python dependencies for reproducible container builds; keep Node lockfile current. Run manifest validation where the validator is reachable.
- Add a staging smoke test that checks `/health`, task-pane static assets, and a small train/predict cycle. Keep a clean sample workbook and a manual Excel acceptance checklist.
- Confirm all URLs used by the manifest and add-in are HTTPS and that real provider/support details replace placeholders.

Exit: a clean clone can build/test; nothing private is committed; staging/release checklist is versioned.

## Phase 1 — hosted beta on another computer

Files: `addin/manifest.xml`, `addin/configure-url.js`, `addin/src/taskpane/taskpane.js`, `backend/Dockerfile`, `backend/main.py`, `DEPLOYMENT.md`; deployment configuration (new).

1. Deploy `addin/` as static HTTPS files. Verify the exact task-pane HTML, command page, icons, and JS load from a fresh browser without localhost. The current `dev-server.js` and Office development certificate are for local work only.
2. Deploy the FastAPI Docker image behind a real HTTPS domain. Add a lightweight readiness check and explicit startup/runtime configuration. Do not bake certificates or secrets into the image. Check `/health` from a different computer.
3. Generate a production manifest from the hosted static base URL. Improve `configure-url.js` so it validates the URL, updates all required production URLs/provider/support values, and produces a release artifact. Validate that XML; keep a stable add-in ID across updates, increment the manifest version, and retain the local manifest for development.
4. Configure the task pane's default production API URL through deployment configuration; retain a development override for localhost. A normal user must never have to open Backend settings and paste a URL.
5. Add a narrow staging CORS allowlist for the exact static origin. This is browser origin control, **not** user authentication. Ensure HTTPS is used end-to-end.
6. Sideload the production manifest on a teammate's machine. With your Mac and its local servers turned off, test health, original Titanic fit, What-if, batch scoring, exports, named ranges, and backend-restart behavior. Use non-sensitive data at this stage.

Exit: a second computer can install and use the hosted add-in without Node/Python/local certificates. **This is an invited beta, not yet a public multi-user release.**

## Phase 2 — multi-user, privacy, and abuse resistance

Files: `backend/main.py`, `backend/model.py`, `backend/table_schema.py`, `addin/src/taskpane/taskpane.js`, backend/API tests, deployment configuration, privacy/support docs.

- Replace `_LAST_MODEL` with a model registry keyed by unguessable model ID **and authenticated user ID**. Training stores only that user's model. Prediction checks both ownership and expiry. Use a shared store rather than process memory so multiple workers/restarts behave predictably. Avoid unsafe untrusted pickle deserialization; use a versioned, validated serialization format for weights and preprocessing state.
- Add managed sign-in, backend token validation, logout/session expiry, and `401/403/404` tests. Do not rely on `model_id` secrecy, CORS, or a JavaScript-embedded API key as authorization. Provide a clear user-facing sign-in flow.
- Add request-body, row/column, generated-feature, time, and concurrency limits at the proxy and API layers. Reject oversized work before reading or fitting. For long jobs, consider queued jobs with polling/cancel instead of relying on the current task pane's 30-second request timeout.
- Decide and enforce data retention. Avoid logging cell values and labels. Encrypt stored model artifacts, expire/delete them, and publish an honest privacy policy explaining worksheet data sent to the API. Add a user-visible notice before the first upload if appropriate.
- Add structured error reporting, health monitoring, uptime/error alerts, deployment rollback, and backup/restore checks for any persistent model store. Test two users training concurrently, each scoring only their own model, followed by restart and expiry.

Exit: no cross-user model overwrite or access; large/hostile requests are bounded; a privacy/retention policy matches actual code.

## Phase 3 — compatibility and release quality

Files: add-in tests, backend load tests, manifest, support docs.

- Test Excel on supported Windows, Mac, and web versions. Verify requirement-set support, ribbon command, task-pane dimensions, HTTPS/certificate trust, and named-range behavior. Excel on the web has request/response payload constraints; test large ranges with chunked Office.js reads before claiming a large-data limit.
- Run a release matrix: original Titanic table, 400-row churn sample, missing/invalid values, nonadjacent columns, What-if vs batch equality, threshold changes, export integrity, service outage, auth expiry, two-user isolation, and oversized-input rejection.
- Publish a support page, privacy policy, terms/licence, product screenshots, and a short user guide. Keep research/teaching limitations clear: binary classification only, supported scalar data types, no guarantee for raw image arrays or arbitrary Excel objects.
- Record exact results from a production-like staging build. Do not reuse old local screenshots as evidence of the new hosted release.

Exit: the release candidate works across target Excel platforms and its documentation states what was actually tested.

## Phase 4 — distribute

- For a university or company: ask its Microsoft 365 administrator to deploy the manifest to a small pilot group, then expand. This is not general-public distribution.
- For the public: use a Partner Center account to submit the Office add-in to Microsoft Marketplace/AppSource, complete Microsoft validation/certification, and provide required support/privacy/terms information. Only after approval can users discover and install it through the in-product marketplace. Keep the hosted services running and monitored after publication.
- Roll out gradually, monitor failures and costs, and maintain a changelog/versioned manifest. Have a process to revoke a bad release and restore the previous hosted files/API image.

## First sprint: concrete tasks to start now

1. Choose a staging static host and API container host. Create `staging` URLs and deployment secrets outside Git.
2. Make the backend container reproducible and run it in staging; verify `/health` remotely.
3. Publish the static task pane and test each manifest asset URL.
4. Generate/validate a staging manifest with real URLs and sideload on the teammate's computer.
5. Record every failure. Do **not** share the URL publicly until Phase 2's auth/isolation/limits are complete.

## References

- Microsoft: Office add-in manifests — https://learn.microsoft.com/en-us/office/dev/add-ins/develop/add-in-manifests
- Microsoft: deployment methods — https://learn.microsoft.com/en-us/office/dev/add-ins/publish/publish
- Microsoft: Excel add-in resource limits — https://learn.microsoft.com/en-us/office/dev/add-ins/concepts/resource-limits-and-performance-optimization
- Microsoft: publishing to Marketplace — https://learn.microsoft.com/en-us/office/dev/add-ins/publish/publish-office-add-ins-to-appsource
