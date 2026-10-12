# Deployment notes

For local development, the task pane runs at HTTPS localhost port 3001 and
the Python API runs at HTTPS localhost port 8000. To use the add-in on another
machine without installing Python or Node, host both parts over HTTPS.

    Excel loads task pane files from an HTTPS static host.
    The task pane calls the FastAPI service at an HTTPS API host.

## Backend

The backend contains a Dockerfile. A container host such as Render, Railway,
Fly.io, or another HTTPS-capable provider can run it.

1. Push the project to a repository.
2. Create a web service whose root directory is backend.
3. Build from the included Dockerfile.
4. Confirm the deployed address ends with /health and returns status ok.

For a local container check:

    cd backend
    docker build -t lr-backend .
    docker run -p 8000:8000 lr-backend

The provided Docker command exposes HTTP locally. A hosted Excel task pane
must call an HTTPS endpoint, so terminate TLS at the hosting provider or put
an HTTPS proxy in front of the container.

## Front-end

Host the addin directory as HTTPS static files. GitHub Pages is one possible
choice. Then generate a manifest that refers to the hosted task pane:

    cd addin
    node configure-url.js https://YOUR-USER.github.io/YOUR-REPOSITORY/addin

This creates manifest.prod.xml. Its task-pane and ribbon asset URLs point to
the hosted front-end. It does not set the API address; that remains a user
setting in the task pane.

## Demo machine

1. Upload manifest.prod.xml through Excel's My Add-ins area.
2. Open Backend settings in the task pane.
3. Save the HTTPS address of the deployed API.
4. Train a model, then export a report or score new rows.

## Production limitations to resolve first

The current backend keeps exactly one recently trained model in memory. A new
training request replaces it, and a restart removes it. The returned model ID
prevents a browser from accidentally using a replaced model, but it is not
authentication or durable storage.

The development configuration allows calls from every origin. Before deploying
with non-demo data, restrict CORS in backend/main.py to the hosted add-in
origin, add authentication, isolate models by user/session, store approved
models securely, and define data-retention rules.

Free hosting tiers often sleep after inactivity. The first model request can
take longer while the service wakes. This is a hosting behavior, not evidence
that the model itself is slow.

Before distributing the manifest, replace the placeholder provider name in
addin/manifest.xml with the actual team or organisation name.
