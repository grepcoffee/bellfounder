# Phase 0 probe

Answers the question in PLAN.md section 2: how many channels does the
browser actually expose from the SQ7 and the Focusrite, and is an Aggregate
Device usable?

## Serving it

`getUserMedia` requires a secure context. The Mac has no dev tools
installed, so don't rely on `python3 -m http.server` being available -
instead it's served as part of the main app:

- **If the `bellfounder` server is already running** (Ubuntu box, via
  `docker compose up`), this page is at `/probe/` on that same origin -
  e.g. `https://ubuntu-box:8095/probe/` - and inherits whatever HTTPS/
  insecure-origin setup you did for the main app (PLAN.md section 6).
- A copy also lives in this directory (`scripts/probe/`) for reference and
  for serving some other way if you're testing before the server exists.

This is the same file served two ways - if you edit one, copy it to the
other (`static/probe/` is what actually ships).

## What to check

1. Plug the SQ7 USB-B and Focusrite in, patch SQ **I/O -> USB Audio
   outputs** per PLAN.md section 2.
2. Open the page in Chrome, pick the SQ device, request `channelCount: 8`.
   Check the "Applied constraints" panel - does it cap at 2?
3. Repeat in Firefox.
4. Try opening the SQ and the Focusrite at the same time (two browser tabs,
   or extend this probe) - do both deliver signal simultaneously?
5. In Audio MIDI Setup, create an Aggregate Device combining the SQ and the
   Focusrite. Does it show up as a single input here, and does each channel
   carry the right signal?

Write the findings into PLAN.md section 2 (or a new NOTES.md once code
exists) so Phase 1's capture design is settled.
