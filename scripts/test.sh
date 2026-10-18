#!/usr/bin/env bash
# Runs the full test suite in containers, so the Ubuntu box (or any CI
# runner) needs nothing but Docker - no Node or Python install required.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== DSP tests (node --test) =="
docker run --rm -v "$PWD":/w -w /w node:22-alpine \
  node --test tests/js/

echo
echo "== Server tests (pytest) =="
docker run --rm -v "$PWD":/w -w /w python:3.12-slim \
  bash -c "pip install -q -r requirements.txt pytest && pytest tests/py/ -v"

echo
echo "All tests passed."
