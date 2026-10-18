"""Ollama client, prompt construction, and single-flight scheduling.

PLAN.md section 5 is explicit about the discipline this needs: facts in,
advice out (the model only sees computed findings, never raw audio), and
on a CPU-only host, only one generation runs at a time with the newest
request winning - a roast must never queue behind a question, or vice
versa.
"""

import json
import os
import threading
import time

import requests

from server import db

SYSTEM_PROMPT_ASK = (
    "You are Bellfounder, advising a live sound engineer at front of house. "
    "You are given measured facts about a channel or mix - never raw audio. "
    "Use only frequencies and amounts that are traceable to the facts given. "
    "Give at most 3 concrete actions, each as a short line: "
    "{band or HPF, frequency in Hz, gain in dB, Q, one short reason}. "
    "If there is nothing obvious to fix, say so plainly instead of inventing a problem."
)

SYSTEM_PROMPT_ROAST = (
    "You are Bellfounder, giving a brief, candid read on the live mix to the "
    "operator at front of house. You are given measured facts, never raw audio. "
    "Keep it to 2-3 sentences. Be specific and traceable to the facts - no "
    "invented numbers. Tone: {tone}."
)

_generation_lock = threading.Lock()
_current_generation = 0


def _start_generation():
    global _current_generation
    with _generation_lock:
        _current_generation += 1
        return _current_generation


def _is_current(generation):
    return generation == _current_generation


def ollama_url():
    return os.environ.get("OLLAMA_URL", "http://localhost:11434").rstrip("/")


def model_name():
    return os.environ.get("BF_MODEL", "qwen2.5:7b")


def _facts_lines(context):
    lines = []
    channel = context.get("channel")
    if channel:
        lines.append(f"Channel: {channel.get('name')} (#{channel.get('num')}, role: {channel.get('role')})")

    findings = context.get("findings")
    if findings:
        lines.append("Findings:")
        for f in findings:
            lines.append(f"- {json.dumps(f)}")

    live = context.get("live_features")
    if live:
        lines.append(f"Live features: {json.dumps(live)}")

    for key in ("target_lufs", "current_lufs", "current_eq"):
        if context.get(key) is not None:
            lines.append(f"{key}: {context[key]}")

    capture_ids = context.get("capture_ids")
    if capture_ids:
        lines.append(f"Comparing captures: {capture_ids}")

    return lines


def build_ask_prompt(question, context, history):
    parts = [SYSTEM_PROMPT_ASK, "", "Facts:"]
    parts.extend(_facts_lines(context) or ["(none given)"])
    parts.append("")
    for turn in history or []:
        role = turn.get("role", "user")
        parts.append(f"{role}: {turn.get('content', '')}")
    parts.append(f"user: {question}")
    parts.append("assistant:")
    return "\n".join(parts)


def build_roast_prompt(window_features, tone="blunt but kind"):
    parts = [SYSTEM_PROMPT_ROAST.format(tone=tone), "", "Facts:"]
    parts.append(json.dumps(window_features))
    parts.append("")
    parts.append("assistant:")
    return "\n".join(parts)


def _generate_stream(prompt, num_predict=250, temperature=0.4):
    """Yields response text chunks from Ollama's streaming /api/generate.
    On any connection error, yields a single explanatory chunk instead of
    raising - a down LLM must never break the rest of the page.
    """
    url = f"{ollama_url()}/api/generate"
    payload = {
        "model": model_name(),
        "prompt": prompt,
        "stream": True,
        "options": {"num_predict": num_predict, "temperature": temperature},
    }
    try:
        resp = requests.post(url, json=payload, stream=True, timeout=60)
        resp.raise_for_status()
        for line in resp.iter_lines():
            if not line:
                continue
            obj = json.loads(line)
            if obj.get("response"):
                yield obj["response"]
            if obj.get("done"):
                break
    except requests.RequestException as exc:
        yield f"[Bellfounder: couldn't reach the local model ({exc})]"


def ask_stream(question, context, history):
    generation = _start_generation()
    prompt = build_ask_prompt(question, context, history)
    start = time.time()
    chunks = []
    for chunk in _generate_stream(prompt):
        if not _is_current(generation):
            return  # superseded by a newer question or roast
        chunks.append(chunk)
        yield chunk
    answer = "".join(chunks)
    try:
        db.insert_qa(question, answer, context, model_name(), int((time.time() - start) * 1000))
    except Exception:
        pass  # logging the Q&A is best-effort, never block the response


def roast_stream(window_features, tone="blunt but kind"):
    generation = _start_generation()
    prompt = build_roast_prompt(window_features, tone)
    for chunk in _generate_stream(prompt):
        if not _is_current(generation):
            return
        yield chunk


def generate_session_summary(session_id, session_facts):
    """Non-streaming end-of-session summary, run from a background thread
    so ending a session returns immediately."""
    generation = _start_generation()
    prompt = (
        "You are Bellfounder. Write a brief end-of-service summary (3-5 sentences) "
        "from these measured facts - loudness, feedback alerts, and anything notable. "
        "Never invent numbers not present in the facts.\n\nFacts:\n"
        + json.dumps(session_facts)
        + "\n\nSummary:"
    )
    chunks = []
    for chunk in _generate_stream(prompt, num_predict=300):
        if not _is_current(generation):
            return None
        chunks.append(chunk)
    summary = "".join(chunks)
    db.set_session_summary(session_id, summary)
    return summary
