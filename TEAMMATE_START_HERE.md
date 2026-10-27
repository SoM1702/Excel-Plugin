# Teammate setup and handoff

This archive contains the source and documentation as packaged on 28 October 2026, based on commit `09ae4fb`, plus documentation cleanup. Read `CHANGELOG.md` for the implementation timeline. This is a local development package, not an installer or a hosted service.

## Requirements

- Desktop Microsoft Excel with Office add-in support.
- Node.js and npm. CI targets Node 20; the recorded local environment used Node 25.9.0.
- Python. CI/Docker target Python 3.12; the recorded successful local environment used Python 3.14. Dependencies are pinned in `backend/requirements.txt`.
- Internet access to install dependencies and load Office.js/Chart.js assets.

The following commands are for macOS with zsh/bash. Windows users should adapt virtual-environment paths and certificate paths. Install dependencies afresh: virtual environments and node_modules are deliberately absent because they are machine-specific/generated.

## First-time installation

Extract the ZIP into a writable folder. Open Terminal in the extracted `excel-logistic-regression-addin` folder. All paths below are relative to that folder.

```bash
npm --prefix addin ci
npm --prefix addin run cert
python3 -m venv backend/.venv
backend/.venv/bin/python -m pip install -r backend/requirements.txt
```

Accept the development certificate trust prompt if shown. Certificates are created on your computer; no private keys are shipped in this package.

## Start the project

Open three terminals, each starting in the extracted project folder.

Terminal 1 — Python backend:

```bash
backend/.venv/bin/python -m uvicorn main:app --app-dir backend --host 127.0.0.1 --port 8000 --ssl-keyfile "$HOME/.office-addin-dev-certs/localhost.key" --ssl-certfile "$HOME/.office-addin-dev-certs/localhost.crt"
```

Terminal 2 — task-pane server:

```bash
npm --prefix addin start
```

Terminal 3 — open/sideload in Excel:

```bash
cd addin
npm run sideload
```

Keep terminals 1 and 2 running. Check `https://localhost:8000/health` in a browser and use `https://localhost:8000` in the pane's backend settings. The pane is served at `https://localhost:3001`.

If a port is already in use, check whether an existing copy of the server is running. If the certificate is untrusted, rerun the certificate command. A virtual environment copied or moved from another machine should be recreated.

## Quick verification

From the project root:

```bash
PYTHONPATH=backend backend/.venv/bin/python -m unittest discover -s backend/tests
npm --prefix addin test
```

The last focused review passed 113 Python and 119 JavaScript tests. This is historical evidence; record your own results after installation. Official manifest validation is separate and needs Microsoft's external service:

```bash
npm --prefix addin run validate
```

## First Excel test

1. Open a copy of `sample_data.xlsx`; choose the source data sheet, not a previous report sheet.
2. Select feature columns as X and the binary outcome as Y, including headers and enabling the header option. Table mode also allows selecting the whole source table and choosing the outcome/features.
3. Use 70% training / 30% testing and standardisation. With 400 usable rows, expect 280 training and 120 test rows.
4. Train, inspect results, and confirm confusion-matrix counts sum to the test count.
5. Enter one row in what-if; score the same row through Score new rows. Compare probabilities at the same threshold.
6. Export weights, report and predictions; verify row alignment and that source data remains intact.

Included data: the sample workbook, backend sample/loan/breast-cancer CSVs, and a committed 100-row Titanic JSON fixture for tests. The fixture is not the full 891-row Titanic workbook. Generated local evaluation folders are not shipped.

## Working together

Repository: https://github.com/SoM1702/Excel-Plugin

The ZIP has no Git metadata. For ongoing collaboration, clone the repository and work on your own branch. The packaging/documentation changes may remain uncommitted on the sender's computer until they are pushed; compare `CHANGELOG.md` before assuming the clone and ZIP are identical.

```bash
git clone https://github.com/SoM1702/Excel-Plugin.git
cd Excel-Plugin
git switch -c teammate/my-feature
```

Install dependencies as above. Commit your changes on that branch, push it, and open a pull request for review. Do not copy the entire ZIP over someone else's active working directory.

## Documents to read

- `CHANGELOG.md`: timeline and current limitations.
- `README.md`: architecture and usage.
- `docs/LOGISTIC_REGRESSION_EQUATIONS.md`: mathematics and worked examples.
- `MENTOR_PRESENTATION_GUIDE.md`: demonstration and explanation.
- `docs/EVALUATION.md`: evaluation evidence.
- `DEPLOYMENT.md` and `docs/HYBRID_PUBLIC_DEPLOYMENT_PLAN.md`: current deployment instructions and remaining work.

For a bug report, include the relevant screenshot/error, endpoint terminal message, selected ranges, data types, settings, and steps to reproduce. Use synthetic examples instead of sending confidential workbook data.
