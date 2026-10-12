# Tested local versions

Recorded on 2026-09-08 in the project virtual environment:

| Component | Version |
|---|---:|
| Python | 3.14.4 |
| FastAPI | 0.139.0 |
| Uvicorn | 0.51.0 |
| scikit-learn | 1.9.0 |
| NumPy | 2.5.1 |
| SciPy | 1.18.0 |
| Pydantic | 2.13.4 |
| Node.js | 25.9.0 |
| npm | 11.12.1 |
| office-addin-debugging | 6.1.2 |
| office-addin-dev-certs | 1.13.5 |
| office-addin-manifest | 1.13.6 |

The Python requirements specify compatible minimum versions rather than
pinning every dependency. The task-pane package lock records exact Node
dependency versions. Each exported report also records the runtime Python,
scikit-learn, NumPy, and SciPy versions used for that model.
