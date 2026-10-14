# Tested Local Versions

Recorded for the scratch logistic regression engine:

| Component | Tested Version | Role |
|---|---:|---|
| Python | 3.14 | Backend runtime environment |
| NumPy | 2.5.3 | Array storage, dot products, exponentials, and vectorized operations |
| FastAPI | 0.142.2 | REST API routing and endpoints |
| Uvicorn | 0.54.0 | ASGI web server |
| Pydantic | 2.13.5 | Request schema validation |
| OpenPyXL | 3.1.5 | Excel spreadsheet reading and generation |
| Node.js | 25.9.0 | Task-pane development server |
| Office.js | v1 CDN | Excel JavaScript API host integration |
| Chart.js | 4.4.1 CDN | Training loss curve, ROC curve, and feature weights rendering |

Note: `scikit-learn` and `scipy` are not required by the application or benchmark scripts. All machine learning algorithms (sigmoid, loss, gradients, optimizer, scaling, splitting, CV, metrics) run natively via pure NumPy.
