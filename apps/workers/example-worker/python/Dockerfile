FROM python:3.14.6-slim-trixie

WORKDIR /app

COPY apps/workers/example-worker/python/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY apps/workers/example-worker/python/ .

USER 65532:65532
ENTRYPOINT ["python", "server.py"]
