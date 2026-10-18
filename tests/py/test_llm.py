from server import llm


def test_build_ask_prompt_includes_only_traceable_facts():
    context = {
        "channel": {"name": "Pastor", "num": 1, "role": "speech-mic"},
        "findings": [{"type": "mud", "deviationDb": 4.2}],
        "target_lufs": -23,
        "current_lufs": -19.5,
    }
    prompt = llm.build_ask_prompt("why boxy?", context, [])
    assert "Pastor" in prompt
    assert "speech-mic" in prompt
    assert "mud" in prompt
    assert "-23" in prompt
    assert "-19.5" in prompt
    assert "why boxy?" in prompt
    assert "at most 3" in prompt  # system prompt's action-count cap survives into the real prompt


def test_build_ask_prompt_includes_history_in_order():
    history = [{"role": "user", "content": "first"}, {"role": "assistant", "content": "second"}]
    prompt = llm.build_ask_prompt("third", {}, history)
    assert prompt.index("first") < prompt.index("second") < prompt.index("third")


def test_build_roast_prompt_embeds_tone_and_facts():
    prompt = llm.build_roast_prompt({"lufsS": -18.2}, tone="drill sergeant")
    assert "drill sergeant" in prompt
    assert "-18.2" in prompt


def test_single_flight_newest_request_wins(stub_ollama):
    stub_ollama.response_chunks = [
        {"response": "a"},
        {"response": "b"},
        {"response": "c"},
        {"response": "", "done": True},
    ]

    gen1 = llm.ask_stream("first question", {}, [])
    first_chunk = next(gen1)
    assert first_chunk == "a"

    gen2 = llm.ask_stream("second question", {}, [])
    second_chunk = next(gen2)
    assert second_chunk == "a"

    # gen1 was superseded the moment gen2 started; resuming it should yield
    # nothing further rather than continue competing for the CPU-only model.
    remaining = list(gen1)
    assert remaining == []

    # gen2 is current and runs to completion normally.
    rest_of_gen2 = list(gen2)
    assert rest_of_gen2 == ["b", "c"]


def test_qa_logged_after_successful_ask(stub_ollama, monkeypatch, tmp_path):
    monkeypatch.setenv("BF_DB_PATH", str(tmp_path / "llm_test.db"))
    from server import db

    db.init_db()
    stub_ollama.response_chunks = [{"response": "Try a notch."}, {"response": "", "done": True}]

    list(llm.ask_stream("why ring?", {"channel": {"name": "Pastor"}}, []))

    conn = db.get_conn()
    rows = conn.execute("SELECT * FROM qa").fetchall()
    conn.close()
    assert len(rows) == 1
    assert rows[0]["question"] == "why ring?"
    assert rows[0]["answer"] == "Try a notch."
