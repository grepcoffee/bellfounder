"""SQLite persistence. Plain stdlib sqlite3, no ORM - see PLAN.md section 5
for the schema rationale. DB_PATH is read from the environment on every
call (not frozen at import) so tests can point at a temp file per-test.
"""

import json
import os
import sqlite3
import time

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS channels (
    num INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    role TEXT NOT NULL,
    notes TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started REAL NOT NULL,
    ended REAL,
    kind TEXT NOT NULL DEFAULT 'service',
    summary_text TEXT
);

CREATE TABLE IF NOT EXISTS snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    ts REAL NOT NULL,
    source TEXT NOT NULL,
    features_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snapshots_session ON snapshots(session_id);

CREATE TABLE IF NOT EXISTS captures (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER,
    ts REAL NOT NULL,
    label TEXT,
    channel_num INTEGER,
    source TEXT NOT NULL,
    features_json TEXT NOT NULL,
    wav_path TEXT
);
CREATE INDEX IF NOT EXISTS idx_captures_session ON captures(session_id);

CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER,
    ts REAL NOT NULL,
    kind TEXT NOT NULL,
    freq REAL,
    detail_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_alerts_session ON alerts(session_id);

CREATE TABLE IF NOT EXISTS qa (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts REAL NOT NULL,
    question TEXT NOT NULL,
    answer TEXT NOT NULL,
    context_json TEXT,
    model TEXT,
    latency_ms INTEGER
);
"""


def _db_path():
    return os.environ.get("BF_DB_PATH", "/data/bellfounder.db")


def get_conn():
    conn = sqlite3.connect(_db_path())
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    conn = get_conn()
    try:
        conn.executescript(SCHEMA_SQL)
        conn.commit()
    finally:
        conn.close()


# --- channels ---------------------------------------------------------

def list_channels():
    conn = get_conn()
    try:
        rows = conn.execute("SELECT * FROM channels ORDER BY num").fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def replace_channels(channels):
    conn = get_conn()
    try:
        conn.execute("DELETE FROM channels")
        conn.executemany(
            "INSERT INTO channels (num, name, role, notes) VALUES (?, ?, ?, ?)",
            [(c["num"], c["name"], c["role"], c.get("notes")) for c in channels],
        )
        conn.commit()
    finally:
        conn.close()


# --- sessions -----------------------------------------------------------

def create_session(kind="service"):
    conn = get_conn()
    try:
        cur = conn.execute(
            "INSERT INTO sessions (started, kind) VALUES (?, ?)", (time.time(), kind)
        )
        conn.commit()
        return cur.lastrowid
    finally:
        conn.close()


def end_session(session_id):
    conn = get_conn()
    try:
        conn.execute("UPDATE sessions SET ended = ? WHERE id = ?", (time.time(), session_id))
        conn.commit()
    finally:
        conn.close()


def set_session_summary(session_id, summary_text):
    conn = get_conn()
    try:
        conn.execute("UPDATE sessions SET summary_text = ? WHERE id = ?", (summary_text, session_id))
        conn.commit()
    finally:
        conn.close()


def get_session(session_id):
    conn = get_conn()
    try:
        row = conn.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def session_stats(session_id):
    conn = get_conn()
    try:
        row = conn.execute(
            "SELECT source, COUNT(*) as n FROM snapshots WHERE session_id = ? GROUP BY source",
            (session_id,),
        ).fetchall()
        alert_count = conn.execute(
            "SELECT COUNT(*) as n FROM alerts WHERE session_id = ?", (session_id,)
        ).fetchone()["n"]
        return {
            "snapshotCountsBySource": {r["source"]: r["n"] for r in row},
            "alertCount": alert_count,
        }
    finally:
        conn.close()


# --- snapshots ------------------------------------------------------------

def insert_snapshot(session_id, ts, source, features):
    conn = get_conn()
    try:
        conn.execute(
            "INSERT INTO snapshots (session_id, ts, source, features_json) VALUES (?, ?, ?, ?)",
            (session_id, ts, source, json.dumps(features)),
        )
        conn.commit()
    finally:
        conn.close()


def recent_snapshots(session_id, source=None, limit=360):
    conn = get_conn()
    try:
        if source:
            rows = conn.execute(
                "SELECT * FROM snapshots WHERE session_id = ? AND source = ? ORDER BY ts DESC LIMIT ?",
                (session_id, source, limit),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM snapshots WHERE session_id = ? ORDER BY ts DESC LIMIT ?",
                (session_id, limit),
            ).fetchall()
        return [_snapshot_row_to_dict(r) for r in rows]
    finally:
        conn.close()


def _snapshot_row_to_dict(row):
    d = dict(row)
    d["features"] = json.loads(d.pop("features_json"))
    return d


# --- captures -------------------------------------------------------------

def insert_capture(session_id, ts, label, channel_num, source, features, wav_path=None):
    conn = get_conn()
    try:
        cur = conn.execute(
            """INSERT INTO captures (session_id, ts, label, channel_num, source, features_json, wav_path)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (session_id, ts, label, channel_num, source, json.dumps(features), wav_path),
        )
        conn.commit()
        return cur.lastrowid
    finally:
        conn.close()


def list_captures(session_id=None):
    conn = get_conn()
    try:
        if session_id:
            rows = conn.execute(
                "SELECT * FROM captures WHERE session_id = ? ORDER BY ts DESC", (session_id,)
            ).fetchall()
        else:
            rows = conn.execute("SELECT * FROM captures ORDER BY ts DESC").fetchall()
        return [_capture_row_to_dict(r) for r in rows]
    finally:
        conn.close()


def get_capture(capture_id):
    conn = get_conn()
    try:
        row = conn.execute("SELECT * FROM captures WHERE id = ?", (capture_id,)).fetchone()
        return _capture_row_to_dict(row) if row else None
    finally:
        conn.close()


def _capture_row_to_dict(row):
    d = dict(row)
    d["features"] = json.loads(d.pop("features_json"))
    return d


# --- alerts -----------------------------------------------------------------

def insert_alert(session_id, ts, kind, freq, detail):
    conn = get_conn()
    try:
        conn.execute(
            "INSERT INTO alerts (session_id, ts, kind, freq, detail_json) VALUES (?, ?, ?, ?, ?)",
            (session_id, ts, kind, freq, json.dumps(detail)),
        )
        conn.commit()
    finally:
        conn.close()


def list_alerts(session_id):
    conn = get_conn()
    try:
        rows = conn.execute(
            "SELECT * FROM alerts WHERE session_id = ? ORDER BY ts DESC", (session_id,)
        ).fetchall()
        out = []
        for r in rows:
            d = dict(r)
            d["detail"] = json.loads(d.pop("detail_json"))
            out.append(d)
        return out
    finally:
        conn.close()


# --- qa log -----------------------------------------------------------------

def insert_qa(question, answer, context, model, latency_ms):
    conn = get_conn()
    try:
        conn.execute(
            "INSERT INTO qa (ts, question, answer, context_json, model, latency_ms) VALUES (?, ?, ?, ?, ?, ?)",
            (time.time(), question, answer, json.dumps(context), model, latency_ms),
        )
        conn.commit()
    finally:
        conn.close()
