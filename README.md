# Bellfounder

Live sound analysis for front of house. Bellfounder watches the main mix
and the room during a service, catches feedback before it howls, and
answers "how should I EQ this channel?" with advice built from real
measurements.

It's built for an Allen & Heath SQ7 feeding a Mac mini over USB, plus a
Focusrite room mic. Analysis runs in a browser tab on the Mac, so nothing
is installed there. A small server on another machine (Linux + Docker)
serves the page, stores sessions and captures, and asks a local Ollama
model for the written feedback. `docker compose up` brings up both the
server and its own Ollama instance - nothing needs to be pre-installed on
that machine beyond Docker.

Status: **Phase 0-1 scaffolding built**. See [`PLAN.md`](PLAN.md) for the
design, the phased delivery plan, and the open questions that still need
answers from the operator (section 10).

## Running it

### 1. Phase 0 probe (do this first, on the real Mac)

Before relying on the capture pipeline, confirm how many channels Chrome
and Firefox actually expose from the SQ7 and the Focusrite - see
[`scripts/probe/README.md`](scripts/probe/README.md).

### 2. Server

```sh
cp .env.example .env   # defaults are fine for a from-scratch box - see comments if you already have Ollama running elsewhere
docker compose up --build -d
curl http://localhost:8095/health   # {"status":"ok"} once it's up
```

This also brings up an `ollama` container and pulls the model
(`BF_MODEL`, default `qwen2.5:7b`, ~4.7GB) automatically on first start -
kick this off as early as possible, since the download takes a while.
Watch progress with:

```sh
docker compose logs -f ollama-pull
```

`/api/ask` and `/api/roast` work (slowly) once the pull finishes; the rest
of the app (meters, feedback alerts, sessions, captures) doesn't depend on
Ollama at all and works immediately.

Then open `https://<box>:8095` from the Mac (see PLAN.md section 6 for
HTTPS options - plain HTTP will load the page but the browser will refuse
to expose audio input on an insecure origin).

For local development without Docker:

```sh
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
BF_DB_PATH=./data/bellfounder.db python3 app.py
```

### 3. Tests

```sh
./scripts/test.sh           # runs both suites in containers (Docker only, no local Node/Python needed)
# or, with Node and Python already installed locally:
npm test                    # DSP unit tests (node --test)
pip install -r requirements.txt pytest && pytest tests/py/   # server tests
```

### Backups

`scripts/backup.sh` tars the `bellfounder_data` volume (SQLite + any
opted-in WAVs). Point `cron` at it on the Ubuntu box.
