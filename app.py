"""Bellfounder Flask app: serves the static browser page and the /api/*
endpoints described in PLAN.md section 5. Small and boring on purpose.
"""

import os
import threading
import time

from flask import Flask, Response, jsonify, request, stream_with_context

from server import db, llm

app = Flask(__name__, static_folder="static", static_url_path="")


@app.before_request
def _ensure_db():
    # init_db() is idempotent (CREATE TABLE IF NOT EXISTS); cheap enough to
    # call per-request and it keeps tests from needing an explicit setup
    # step beyond pointing BF_DB_PATH at a temp file.
    db.init_db()


@app.route("/")
def index():
    return app.send_static_file("index.html")


@app.route("/health")
def health():
    return jsonify(status="ok")


@app.route("/api/config")
def config():
    return jsonify(
        {
            "model": llm.model_name(),
            "roastIntervalS": int(os.environ.get("BF_ROAST_INTERVAL_S", 120)),
            "sqLinkEnabled": bool(os.environ.get("SQ_HOST")),
        }
    )


@app.route("/api/channels", methods=["GET", "PUT"])
def channels():
    if request.method == "GET":
        return jsonify(db.list_channels())
    data = request.get_json(force=True) or []
    db.replace_channels(data)
    return jsonify(db.list_channels())


@app.route("/api/sessions", methods=["POST"])
def create_session():
    data = request.get_json(silent=True) or {}
    session_id = db.create_session(kind=data.get("kind", "service"))
    return jsonify({"id": session_id}), 201


@app.route("/api/sessions/<int:session_id>/end", methods=["POST"])
def end_session(session_id):
    db.end_session(session_id)
    stats = db.session_stats(session_id)
    alerts = db.list_alerts(session_id)
    facts = {"stats": stats, "alerts": alerts}

    def _run_summary():
        try:
            llm.generate_session_summary(session_id, facts)
        except Exception:
            pass  # summary generation is best-effort

    threading.Thread(target=_run_summary, daemon=True).start()
    return jsonify({"id": session_id, "stats": stats})


@app.route("/api/sessions/<int:session_id>", methods=["GET"])
def get_session(session_id):
    session = db.get_session(session_id)
    if not session:
        return jsonify(error="not found"), 404
    session["stats"] = db.session_stats(session_id)
    return jsonify(session)


@app.route("/api/snapshots", methods=["POST"])
def create_snapshot():
    data = request.get_json(force=True)
    db.insert_snapshot(
        data["session_id"], data.get("ts", time.time()), data["source"], data["features"]
    )
    return jsonify(ok=True), 201


@app.route("/api/alerts", methods=["POST"])
def create_alert():
    data = request.get_json(force=True)
    db.insert_alert(
        data.get("session_id"),
        data.get("ts", time.time()),
        data["kind"],
        data.get("freq"),
        data.get("detail", {}),
    )
    return jsonify(ok=True), 201


@app.route("/api/captures", methods=["GET", "POST"])
def captures():
    if request.method == "GET":
        session_id = request.args.get("session_id", type=int)
        return jsonify(db.list_captures(session_id))
    data = request.get_json(force=True)
    capture_id = db.insert_capture(
        data.get("session_id"),
        data.get("ts", time.time()),
        data.get("label"),
        data.get("channel"),
        data["source"],
        data["features"],
        data.get("wav_path"),
    )
    return jsonify({"id": capture_id}), 201


@app.route("/api/captures/<int:capture_id>", methods=["GET"])
def get_capture(capture_id):
    capture = db.get_capture(capture_id)
    if not capture:
        return jsonify(error="not found"), 404
    return jsonify(capture)


@app.route("/api/ask", methods=["POST"])
def ask():
    data = request.get_json(force=True)
    question = data["question"]
    context = data.get("context", {})
    history = data.get("history", [])

    def generate():
        yield from llm.ask_stream(question, context, history)

    return Response(stream_with_context(generate()), mimetype="text/plain")


@app.route("/api/roast", methods=["POST"])
def roast():
    data = request.get_json(force=True) or {}
    window_features = data.get("window_features", {})
    tone = data.get("tone", "blunt but kind")

    def generate():
        yield from llm.roast_stream(window_features, tone)

    return Response(stream_with_context(generate()), mimetype="text/plain")


@app.route("/api/sq/state")
def sq_state():
    if not os.environ.get("SQ_HOST"):
        return jsonify(error="SQ link disabled"), 501
    return jsonify(error="SQ link not implemented yet (Phase 3)"), 501


if __name__ == "__main__":
    db.init_db()
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 8095)), threaded=True)
