# Deployment notes

For local setup use [TEAMMATE_START_HERE.md](TEAMMATE_START_HERE.md). For the release sequence and acceptance gates use [the active deployment roadmap](docs/HYBRID_PUBLIC_DEPLOYMENT_PLAN.md).

## Current architecture

Excel loads the task pane from an HTTPS static site. The task pane sends requests to the Python FastAPI service over HTTPS. The scratch model runs in Python. Hosting has not been verified or configured as part of the source ZIP handoff.

## Build the static bundle

Install dependencies with `npm ci` in `addin`, then supply all four deployment values:

```bash
cd addin
node configure-url.js https://YOUR-FRONTEND.example.com/addin https://YOUR-API.example.com "Your actual team name" https://YOUR-SUPPORT.example.com
```

Replace those example values with real addresses. Publish the contents of `addin/dist` at the frontend base URL. The bundle contains `manifest.prod.xml`, assets, task-pane source, and generated API configuration. Local source URLs remain localhost. A previously saved backend override in the task pane can override the configured default; inspect backend settings when switching environments.

Validate the generated manifest separately:

```bash
node validate-manifest.js dist/manifest.prod.xml
```

The validator requires an external Microsoft service and correctly fails if the service is unavailable. A generated XML file alone does not establish official acceptance.

## Backend configuration

Set `CORS_ALLOWED_ORIGINS` to the exact frontend origin, for example `https://YOUR-FRONTEND.example.com` (no `/addin` path). It is a comma-separated list if multiple origins are needed. The local default is `https://localhost:3001`.

For a local container check, with the Docker daemon running:

```bash
docker build -t lr-backend backend
docker run --rm -p 8000:8000 -e CORS_ALLOWED_ORIGINS=https://localhost:3001 lr-backend
```

This container serves HTTP; a hosted API needs HTTPS termination supplied by its host or proxy. The normal local development instructions use Uvicorn with development HTTPS certificates. Verify `/health` and an actual training/prediction request in the intended environment.

## Current limitations

The model registry holds up to 100 models in one process with 24-hour expiry and least-recently-used eviction. Restarting loses them; separate workers do not share models. A model ID is not authenticated ownership.

CORS limits browser origins but does not restrict direct API clients. Before an invited internet beta, provide access control as described in the roadmap. Public release still requires authentication, ownership checks, persistent storage, workload controls, privacy decisions, monitoring and live Excel verification. A privately shared manifest does not secure an otherwise public API.

The container and hosted release have not been verified by the local unit tests. Use synthetic or explicitly approved data while completing deployment acceptance.
