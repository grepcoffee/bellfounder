def test_health(client):
    r = client.get("/health")
    assert r.status_code == 200
    assert r.get_json()["status"] == "ok"


def test_config_reflects_env(client, monkeypatch):
    monkeypatch.setenv("BF_MODEL", "llama3:8b")
    monkeypatch.setenv("SQ_HOST", "192.168.1.50")
    r = client.get("/api/config")
    body = r.get_json()
    assert body["model"] == "llama3:8b"
    assert body["sqLinkEnabled"] is True


def test_channels_round_trip(client):
    channels = [
        {"num": 1, "name": "Pastor", "role": "speech-mic", "notes": ""},
        {"num": 2, "name": "Kick", "role": "kick", "notes": "beta 91"},
    ]
    r = client.put("/api/channels", json=channels)
    assert r.status_code == 200
    assert len(r.get_json()) == 2

    r = client.get("/api/channels")
    got = r.get_json()
    assert [c["num"] for c in got] == [1, 2]
    assert got[1]["notes"] == "beta 91"


def test_session_lifecycle_and_snapshot_round_trip(client):
    r = client.post("/api/sessions", json={"kind": "rehearsal"})
    assert r.status_code == 201
    session_id = r.get_json()["id"]

    r = client.post(
        "/api/snapshots",
        json={"session_id": session_id, "source": "mix", "features": {"lufsI": -21.3}},
    )
    assert r.status_code == 201

    r = client.get(f"/api/sessions/{session_id}")
    body = r.get_json()
    assert body["kind"] == "rehearsal"
    assert body["ended"] is None
    assert body["stats"]["snapshotCountsBySource"] == {"mix": 1}


def test_get_session_404_when_missing(client):
    r = client.get("/api/sessions/999")
    assert r.status_code == 404


def test_capture_round_trip(client):
    r = client.post(
        "/api/captures",
        json={
            "label": "pastor pre-eq",
            "channel": 1,
            "source": "channel",
            "features": {"deviationDb": [1, 2, 3]},
        },
    )
    assert r.status_code == 201
    capture_id = r.get_json()["id"]

    r = client.get(f"/api/captures/{capture_id}")
    body = r.get_json()
    assert body["label"] == "pastor pre-eq"
    assert body["features"]["deviationDb"] == [1, 2, 3]

    r = client.get("/api/captures")
    assert len(r.get_json()) == 1


def test_alert_round_trip_via_session_stats(client):
    r = client.post("/api/sessions", json={})
    session_id = r.get_json()["id"]

    r = client.post(
        "/api/alerts",
        json={"session_id": session_id, "kind": "feedback", "freq": 2531.0, "detail": {"note": "E7"}},
    )
    assert r.status_code == 201

    r = client.get(f"/api/sessions/{session_id}")
    assert r.get_json()["stats"]["alertCount"] == 1


def test_sq_state_disabled_by_default(client):
    r = client.get("/api/sq/state")
    assert r.status_code == 501


def test_ask_streams_and_logs_qa(client, stub_ollama):
    stub_ollama.response_chunks = [
        {"response": "Try "},
        {"response": "a notch at 2.5kHz."},
        {"response": "", "done": True},
    ]
    r = client.post(
        "/api/ask",
        json={
            "question": "why does it ring?",
            "context": {"channel": {"name": "Pastor", "num": 1, "role": "speech-mic"}},
        },
    )
    assert r.status_code == 200
    assert r.get_data(as_text=True) == "Try a notch at 2.5kHz."

    # The facts-only prompt must have reached Ollama with the channel context.
    assert len(stub_ollama.calls) == 1
    assert "Pastor" in stub_ollama.calls[0]["prompt"]
    assert "why does it ring?" in stub_ollama.calls[0]["prompt"]


def test_ask_survives_ollama_being_down(client, stub_ollama):
    stub_ollama.raise_connection_error = True
    r = client.post("/api/ask", json={"question": "anything?", "context": {}})
    assert r.status_code == 200
    assert "couldn't reach" in r.get_data(as_text=True)


def test_roast_streams(client, stub_ollama):
    stub_ollama.response_chunks = [{"response": "Mix is fine."}, {"response": "", "done": True}]
    r = client.post("/api/roast", json={"window_features": {"lufsS": -19.0}})
    assert r.status_code == 200
    assert r.get_data(as_text=True) == "Mix is fine."
