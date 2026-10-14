# Portable backend: builds the same everywhere, so the API runs on any machine
# or cloud host using our pure NumPy scratch logistic regression engine.
FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 8000

# Cloud hosts inject the port via $PORT; default to 8000 for local `docker run`.
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}"]
