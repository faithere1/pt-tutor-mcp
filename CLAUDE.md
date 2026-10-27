# PT Tutor

Read `PROGRESS.md` first. It has the goal, the architecture, the milestone status and the Packet Tracer 9 quirks.

- Packet Tracer must be open with the "PT Tutor Bridge" script module running. Check with `node tools/ptcall.mjs ping`.
- After editing `extension/bridge.js`, run `node tools/reload.mjs`. Never ask the user to restart the module for that.
- `npm test` must pass. Engine changes should also pass `node tools/scenarios.mjs` against the live reference lab.
- Keep the tutor read-only: no tool may change the student's network.
- Update `PROGRESS.md` when a milestone or quirk changes.
