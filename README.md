# Bellfounder

Live sound analysis for front of house. Bellfounder watches the main mix
and the room during a service, catches feedback before it howls, and
answers "how should I EQ this channel?" with advice built from real
measurements.

It's built for an Allen & Heath SQ7 feeding a Mac mini over USB, plus a
Focusrite room mic. Analysis runs in a browser tab on the Mac, so nothing
is installed there. A small server on another machine (Ubuntu + Docker)
serves the page, stores sessions and captures, and asks a local Ollama
model for the written feedback.

Status: **planning**. See [`PLAN.md`](PLAN.md) for the design, the phased
delivery plan, and the open questions.
