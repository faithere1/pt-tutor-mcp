<div align="center">

# PT Tutor

**A troubleshooting tutor for Cisco Packet Tracer, built on the Model Context Protocol.**

It reads the student's live network, finds the fault, and teaches them to find it too.

![Packet Tracer 9](https://img.shields.io/badge/Packet%20Tracer-9.0-1BA0D7)
![Node 20+](https://img.shields.io/badge/node-%E2%89%A520-339933)
![MCP](https://img.shields.io/badge/MCP-server-6E56CF)
![License: MIT](https://img.shields.io/badge/license-MIT-lightgrey)

</div>

---

> **Student:** PC1 can't ping PC3.
>
> **Tutor:** Let's follow the packet. PC3 is on another subnet, so where does PC1 send it first? Check what PC1 has set as that address.

Most AI tools for Packet Tracer build and fix the lab for you. PT Tutor does the opposite: it works out what's wrong, then asks the next good question, the way a lab instructor would. The student makes every change.

## Features

- **Read-only by design.** Only status commands (`show`, `ping`, `traceroute`, `ipconfig`) can run. Configuration commands are refused.
- **Real diagnosis.** It walks the path in both directions (cabling, interfaces, VLANs, trunks, gateways, routes, ACLs, DHCP) and checks its verdict with a live ping.
- **Hint ladder.** Every finding has three levels: a nudge, a pointer to where to look, then the concept. No level hands over the configuration.
- **Assessment guard.** If a graded activity (`.pka`) is open, it switches to hint-only mode. It says where the problem is, not what it is. If it can't tell whether the file is graded, it assumes it is.

## How it works

```
Claude  ──MCP──▶  PT Tutor server  ──file mailbox──▶  Packet Tracer script module
                  (Node.js)          ~/.pt-tutor        (reads the live network)
```

A small script module inside Packet Tracer exchanges files with the server in `~/.pt-tutor/mailbox`. It opens no network port, and it accepts only a short list of read-only commands.

## Getting started

**Requirements:** Packet Tracer 9.0, Node.js 20 or newer, and an MCP client such as Claude Code or Claude Desktop.

**1. Build the server**

```bash
git clone https://github.com/faithere1/pt-tutor-mcp.git
cd pt-tutor-mcp
npm install && npm run build
```

**2. Add the bridge to Packet Tracer**

1. Open **Extensions → Scripting → Configure PT Script Modules**.
2. Click **Add** and choose `release/pt-tutor-bridge.pts`.
3. Give the module file access in its permission settings, then start it.

**3. Connect your MCP client**

```bash
claude mcp add pt-tutor -- node /path/to/pt-tutor-mcp/dist/index.js
```

For Claude Desktop, add the same command to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "pt-tutor": { "command": "node", "args": ["/path/to/pt-tutor-mcp/dist/index.js"] }
  }
}
```

**4. Try it.** Open a lab, break something, and ask for help. In Claude Code, run:

```
/mcp__pt-tutor__tutor PC1 can't reach the server
```

## Tools

| Tool | Purpose |
|---|---|
| `pt_status` | Connection check, the open file, and the current tutor mode |
| `get_topology` | Devices, ports and links on the canvas |
| `get_device_state` | Interfaces, addresses, routes and VLANs of one device |
| `run_command` | One read-only command on a device |
| `diagnose` | Why a source can't reach a destination (10–60 s) |
| `tutor_hint` | The next hint for a finding |

## For instructors

Set `PT_TUTOR_MODE` in the server's `env`:

| Value | Behaviour |
|---|---|
| `auto` *(default)* | Hint-only during graded activities, full hints otherwise |
| `hint-only` | Hint-only for every lab |

An unrecognised value also means hint-only, so a typo can't turn the guard off. The setting lives in the MCP config, so on shared machines keep that file somewhere students can't edit.

## Limitations

- Packet Tracer 9 only. Developed on macOS; Windows and Linux are untested.
- Static routing, VLANs, trunks and ACLs are checked in depth. OSPF and EIGRP are read from the routing table only.
- The commands the tutor runs appear in the device's console history.

## Development

```bash
npm test                       # build and run the test suite (no Packet Tracer needed)
node tools/build-release.mjs   # write the release bridge with dev commands off
```

See [`PROGRESS.md`](PROGRESS.md) for the architecture, the dev setup and the Packet Tracer API notes.

## License

[MIT](LICENSE)
