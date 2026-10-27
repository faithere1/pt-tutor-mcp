# PT Tutor — progress

An MCP server for Cisco Packet Tracer 9 that acts as a **tutor, not an autopilot**. It reads the live network, finds faults and guides the student with hints. It does not build or fix labs for them.

Last updated: 2026-10-27

## Why this exists (positioning)

There are already Packet Tracer MCP servers, but all of them are autopilots that build topologies from a prompt:

- [Mats2208/MCP-Packet-Tracer](https://github.com/Mats2208/MCP-Packet-Tracer): about 300 stars, the most mature. It already explains simulation packet traces.
- [Jcorderop02/packet-tracer-mcp](https://github.com/Jcorderop02/packet-tracer-mcp)
- [caixax/packet-tracer-mcp](https://github.com/caixax/packet-tracer-mcp)

None of them has a tutor or hint mode, detection of graded `.pka` activity files, or instructor tools. That's our gap.

Packet Tracer exists for Cisco Networking Academy, and cheating on skills assessments is a known concern there. A tool that teaches, and refuses to solve graded activities, is something Cisco could support. Possible routes to visibility: the DevNet Code Exchange AI catalog, NetAcad instructor forums, and the Cisco Live DevNet Zone.

## Architecture

```
Claude ──stdio──> MCP server (TypeScript, src/)
                     │ file mailbox ~/.pt-tutor/mailbox  (no network port)
                     ▼
              PT script module "PT Tutor Bridge" (extension/bridge.js)
```

- The **bridge** runs inside Packet Tracer's script engine. It polls the mailbox, runs only the named commands in `COMMANDS` and writes a heartbeat file. The commands are `ping`, `activityStatus`, `topology`, `deviceState` and `cli`, plus dev-only `eval` and `reload`.
- The **MCP server** has six tools: `pt_status`, `get_topology`, `get_device_state`, `run_command`, `diagnose` and `tutor_hint`.
- The **MCP server** writes `req_<id>.json` files and reads back `res_<id>.json`, using write-to-tmp-then-rename so files are never half-written.
- Read-only by design: `src/policy.ts` allowlists `show`, `ping`, `traceroute`, `ipconfig`, `arp -a` and similar commands. Configuration commands are refused.

### PT setup (already done on this Mac)

- Script module ID `dev.pttutor.bridge`, registered from `~/Cisco Packet Tracer 9.0.0/extensions/pt-tutor-dev.pts`.
- Its only script line is `#include "/Users/fatih/Desktop/projects/claude-deneme/packeT/extension/bridge.js"`, which PT resolves at runtime.
- The release module `pttutor.bridge` (from `release/pt-tutor-bridge.pts`) is also registered. Run only one of the two at a time. For dev work, stop `pttutor.bridge` and start `dev.pttutor.bridge`.
- To apply edits to `bridge.js`, run `node tools/reload.mjs`. This hot-reloads it with no PT restart.
- To export a module, use **Info tab → 6. Saving → Export**. The Export button on the Script Engine tab saves only the `.js` file.

## Milestones

- [x] **0. Spike.** Proved the bridge, topology reading, activity-file detection and CLI capture.
- [x] **1. Observe tools.** `pt_status`, `get_topology`, `get_device_state`, `run_command`. Registered in `.mcp.json`.
- [x] **2. Diagnosis engine.** The `diagnose(source, destination)` tool.
  - It walks the L2 and L3 path in both directions: VLANs, trunks, subinterfaces, link and admin state, routing table, static routes, standard and extended ACLs, and proxy ARP. It confirms the result with a real ping.
  - Finding codes: `WRONG_GATEWAY`, `NO_GATEWAY`, `GATEWAY_NOT_IN_SUBNET`, `IF_SHUTDOWN`, `IF_DOWN`, `LINK_DOWN`, `VLAN_MISMATCH`, `VLAN_NOT_ALLOWED`, `TRUNK_MISMATCH`, `NO_SUBINTERFACE`, `NO_ROUTE`, `STATIC_ROUTE_INACTIVE`, `NEXT_HOP_BROADCAST`, `WRONG_NEXT_HOP`, `ACL_DENY`, `MASK_MISMATCH`, `DUPLICATE_IP`, `DHCP_FAILED`, `HOST_NO_IP`, `NOT_CABLED`, `ROUTING_LOOP`, `DEST_UNKNOWN`.
  - Validated against 12 live fault scenarios. All predictions matched the real ping.
- [x] **3. Tutor mode and assessment guard**
  - [x] A hint ladder per finding: level 1 is a nudge, level 2 points at the device or command, level 3 explains the concept. Tool: `tutor_hint(code, level, device?, interface?)`, in `src/hints.ts`. It covers all 28 codes the engine emits; unknown codes get a generic troubleshooting ladder. No level gives a configuration command, and the tests enforce that.
  - [x] Tutor instructions (`src/tutor.ts`). They're sent as the MCP server `instructions`, which clients add to Claude's system prompt whenever `pt-tutor` is connected, and there's a `tutor` prompt (`/mcp__pt-tutor__tutor` in Claude Code) that starts a session.
    - Checked with headless `claude -p` runs. Asked for help, Claude tutors: one guiding question, no fix. In graded mode, Claude refused the fix even when the student demanded it.
    - In practice mode, a student who asks outright for the fix gets it ("this isn't a graded activity"). Stronger wording didn't change that, and it shouldn't be forced: server instructions set the default, and the student can override them. Only hint-only mode is enforced, by the tools themselves; that's why `PT_TUTOR_MODE` exists.
  - [x] Assessment guard (`src/guard.ts`). When `isActivityFile` is true, the tutor runs in hint-only mode. `pt_status` then reports `tutorMode: "hint-only"`, and `hintOnlyReason` says whether that's because of a graded activity or the instructor setting.
    - `diagnose` returns redacted findings. Each keeps its device, interface, direction, a broad area (physical, addressing, switching, routing, filtering) and an opaque `ref`. The code, message, evidence, concept and hops are removed.
    - `tutor_hint` accepts the `ref`, caps the level at 2, and leaves out the concept.
    - It fails closed: if the activity status can't be read, it assumes an assessment. Nothing forces it off.
    - Refs are kept in memory, so they're lost when the server restarts.
  - [x] Decided: during an assessment, `run_command` refuses `show running-config`, `show startup-config`, `show config` and `show archive`. Status commands stay allowed, including `show ip route`, `show access-lists` and `show vlan brief`, and so does `get_device_state`, which only runs status commands. The student can still read the config on their own terminal.
  - [x] Instructor setting `PT_TUTOR_MODE`, set in the `env` of the MCP config. `auto` (the default) means hint-only during graded activities. `hint-only` turns it on for every lab, so practice labs can't be short-circuited either. Any other value also means hint-only and prints a warning on stderr, so a typo never turns the guard off. Checked with `claude -p`: a student demanding the fix in a non-graded lab got a level-2 hint instead.
    - Caveat: the setting lives in the MCP config, so a student who can edit that file can remove it. On shared or school machines, put the config somewhere students can't write.
  - [ ] Not yet tested against a real `.pka` file; tested only with `PT_TUTOR_MODE=hint-only`.
- [ ] **4. Release.** ← almost done
  - [x] `README.md`: positioning, install, tools, instructor setting, limits. The demo GIF is still a TODO.
  - [x] Release bridge: `node tools/build-release.mjs` writes `release/pt-tutor-bridge.js` with `PT_TUTOR_DEV` off. `extension/bridge.js` stays the dev copy, because `reload.mjs` needs `reload`.
  - [x] npm package `pt-tutor-mcp` (the name was free on 2026-10-27). `files` ships `dist` without tests plus `release/`. `prepublishOnly` runs the tests and the release build. `npm pack --dry-run` gives 23 files.
  - [x] Exported `release/pt-tutor-bridge.pts` (module ID `pttutor.bridge`, with permissions saved). Against the live reference lab: `ping` reports `dev: false`, `eval` and `reload` are refused, and `smoke.mjs R1 PC1` passes. The README's install steps still need checking against the real PT menu names.
  - [x] Git and a private GitHub repo: https://github.com/faithere1/pt-tutor-mcp. Added an MIT `LICENSE` (faithere1), `repository` and `author` in `package.json`, and made `.mcp.json` use a relative path. The README installs from source until the package is on npm.
  - [x] Published `pt-tutor-mcp@0.1.0` to npm on 2026-10-27, from the npm account `fatihcse`. `npx -y pt-tutor-mcp bridge` saves the `.pts`. Checked from a clean folder: `npx -y pt-tutor-mcp` answers `pt_status` through the release bridge.
    - Publishing needs 2FA. The account uses a passkey, so run `npm publish --access public` in a real Terminal, which opens the browser login. Claude Code's `!` shell isn't interactive and fails with EOTP.
    - The first publish of a new name also created a `0.0.0-stage` placeholder (npm staged publishing). `latest` points to 0.1.0, so npx ignores it.
    - To release a new version: bump the version in `package.json` (and `PT_TUTOR_VERSION` in `bridge.js` if the bridge changed, then re-export the `.pts`), commit and push, then publish from Terminal.
  - [x] GitHub repo made public on 2026-10-27.
  - [x] Submitted to Cisco Code Exchange on 2026-10-27 (Technology: Networking, AI: yes, deploy type: stdio). Added `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md` and a help section, following their repo template. Waiting for review.
  - [ ] Demo GIF in the README.
- [ ] **Later:** instructor tools (per-student lab variants, checking submissions), router-on-a-stick and trunk fixtures, OSPF, EIGRP and DHCP-specific checks.

## Layout

| Path | What |
|---|---|
| `extension/bridge.js` | Script-engine side: mailbox loop and commands, CLI driver (boot dialogs, `enable`, `do` prefix, `--More--` paging, per-device queue) |
| `src/index.ts` | MCP server and tool definitions |
| `src/mailbox.ts` | Mailbox client and heartbeat check |
| `src/policy.ts` | Read-only command allowlist |
| `src/parse.ts` | Parsers: running-config, `show ip route`, `show vlan brief`, `show interfaces trunk`, `ipconfig /all`, ping |
| `src/model.ts` | Raw snapshot → network model (pure) |
| `src/diagnose.ts` | Diagnosis engine (pure) |
| `src/hints.ts` | Hint ladder per finding code (pure) |
| `src/tutor.ts` | Server instructions and the `tutor` prompt text |
| `src/guard.ts` | Assessment guard: redaction, hint cap, config-command block (pure) |
| `src/*.test.ts` | 33 tests; the engine tests run offline on `test/fixtures` |
| `tools/build-lab.mjs` | Dev: builds the reference lab (`--clear` wipes the canvas first) |
| `tools/scenarios.mjs` | Dev: injects each fault live, captures a fixture, checks the engine against a real ping |
| `tools/build-release.mjs` | Writes `release/pt-tutor-bridge.js`, the bridge with dev commands off |
| `tools/capture.mjs`, `ptcall.mjs`, `reload.mjs`, `smoke.mjs` | Dev helpers |

Reference lab, saved as `labs/reference-lab.pkt` (open it in PT, or rebuild it with `node tools/build-lab.mjs --clear`):
`PC1, PC2 ─ SW1 (VLAN 10) ─ R1 ═ 10.0.0.0/30 ═ R2 ─ SW2 ─ PC3`, using static routes, with 192.168.10.0/24 on the left and 192.168.20.0/24 on the right.

## Commands

```bash
npm test                              # build and run all tests (no PT needed)
node tools/smoke.mjs R1 PC1           # MCP end-to-end check against live PT
node tools/scenarios.mjs [name ...]   # live fault scenarios (needs the reference lab)
node tools/reload.mjs                 # push bridge.js changes into PT
PT_TUTOR_MODE=hint-only node dist/index.js  # run the MCP server in hint-only mode for every lab
PT_TIMEOUT=45000 node tools/ptcall.mjs cli '{"device":"PC1","command":"ping 192.168.20.10"}'
```

## PT 9 quirks learned the hard way

- `Link` has `getPort1()` and `getPort2()`. The `getOtherPortConnectedTo()` in the docs' example doesn't exist.
- The `outputWritten` event's text is in `ev.newOutput`.
- `terminal length 0` isn't honoured, and PCs page too. The bridge presses space with `enterChar(32, 0)` at each `--More--`. `getPrompt()` keeps returning `R1#` while `--More--` is pending.
- A terminal left at an old `--More--` eats the first character of the next command. The bridge doesn't detect this yet.
- A host's default gateway can't be read through `getProcess("HostIp")`, so we parse `ipconfig /all`.
- Proxy ARP (on by default in IOS) makes a wrong host mask still work. The engine models it.
- A re-enabled switch port takes about 30 seconds of spanning-tree states before it forwards. `scenarios.mjs` waits for the lab to recover.
- A new script module won't start until it has been exported (Info → 6. Saving → Export) and added back as a `.pts` file. The exported `.pts` is encrypted, so its contents can't be inspected; check the running module with `ping` instead.
- A new module needs its permissions granted (file access at least) before it can work. Without them it shows as running but never writes the heartbeat. Re-export after changing permissions, or the change is lost when the Scripting Interface closes.
- Running `open file.pkt` from the shell while PT was already running made PT quit with no crash report (seen once). Launching PT that way when it's closed works, but the script modules don't auto-start.
- If two bridge modules are running, they race on the mailbox and replies come from either one. Only one bridge module may run at a time.
- A static route whose next hop is a link's broadcast address still works in PT, because the frame is sent as a broadcast.

## Known gaps

- `diagnose` runs one CLI command after another, roughly 26 seconds on the 7-device lab. It could be faster by caching or running commands on different devices in parallel.
- No fixtures yet for trunks or router-on-a-stick. That code path is written but not validated live.
- Tools type into the student's real terminal, so the commands appear in their console history.
- Dynamic routing (OSPF, EIGRP) is only read from `show ip route`. There are no protocol-specific checks such as neighbours, areas or passive interfaces.
