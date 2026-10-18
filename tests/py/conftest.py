import json
import sys
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("BF_DB_PATH", str(tmp_path / "bf_test.db"))
    import app as appmod

    appmod.app.config["TESTING"] = True
    with appmod.app.test_client() as c:
        yield c


class FakeOllamaResponse:
    """Stands in for requests.Response from a streaming Ollama call."""

    def __init__(self, chunks, delay=0.0):
        self._chunks = chunks
        self._delay = delay

    def raise_for_status(self):
        pass

    def iter_lines(self):
        for chunk in self._chunks:
            if self._delay:
                time.sleep(self._delay)
            yield json.dumps(chunk).encode()


@pytest.fixture
def stub_ollama(monkeypatch):
    """Patches server.llm.requests.post. Test sets `.response_chunks` and/or
    `.delay` on the returned holder to control behaviour; `.calls` records
    every prompt sent, in order.
    """
    from server import llm

    class Holder:
        response_chunks = [{"response": "ok"}, {"response": "", "done": True}]
        delay = 0.0
        calls = []
        raise_connection_error = False

    def fake_post(url, json=None, stream=True, timeout=60):
        Holder.calls.append(json)
        if Holder.raise_connection_error:
            import requests

            raise requests.ConnectionError("no route to host")
        return FakeOllamaResponse(Holder.response_chunks, delay=Holder.delay)

    monkeypatch.setattr(llm.requests, "post", fake_post)
    return Holder
