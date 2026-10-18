# Phase 0 probe

Answers the question in PLAN.md section 2: how many channels does the
browser actually expose from the SQ7 and the Focusrite, and is an Aggregate
Device usable?

## Serving it

`getUserMedia` requires a secure context. Easiest options on the Mac:

```sh
cd scripts/probe
python3 -m http.server 8096
```

Then open `http://localhost:8096` - `localhost` is treated as secure even
over plain HTTP. If accessing from another machine, use one of the HTTPS
options in PLAN.md section 6, or the browser's insecure-origin override flag.

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
