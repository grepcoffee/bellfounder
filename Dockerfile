FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .
COPY server/ server/
COPY static/ static/

ENV BF_DB_PATH=/data/bellfounder.db
EXPOSE 8095

CMD ["python", "app.py"]
