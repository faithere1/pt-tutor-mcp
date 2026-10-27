#!/usr/bin/env node
// PT Tutor MCP server: read-only observation tools and connectivity diagnosis.

import { randomBytes } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { call, BridgeError, heartbeatAge, MAILBOX } from "./mailbox.js";
import { checkCommand, terminalFor } from "./policy.js";
import { buildModel, commandsFor, type RawSnapshot } from "./model.js";
import { diagnose } from "./diagnose.js";
import { parsePing } from "./parse.js";
import { hint, type HintLevel } from "./hints.js";
import { ASSESSMENT_MAX_HINT_LEVEL, checkAssessmentCommand, modeSetting, redactDiagnosis } from "./guard.js";
import type { Finding } from "./diagnose.js";
import { INSTRUCTIONS, tutorPrompt } from "./tutor.js";

interface Port {
  name: string;
  up?: boolean;
  protocolUp?: boolean;
  ip?: string;
  mask?: string;
  connectedTo?: { device: string; port: string };
  mac?: string;
  description?: string;
  dhcp?: boolean;
  adminUp?: boolean;
}

interface Device {
  name: string;
  type: string;
  model: string;
  power: boolean;
  ports: Port[];
}

interface CliResult {
  command: string;
  output: string;
  prompt: string;
  mode: string;
  timedOut: boolean;
  notes: string[];
}

const server = new McpServer({ name: "pt-tutor", version: "0.1.0" }, { instructions: INSTRUCTIONS });

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
}

function failure(message: string) {
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

// Wraps a handler so bridge problems come back as tool errors, not crashes.
function guarded<A>(fn: (args: A) => Promise<ReturnType<typeof text>>) {
  return async (args: A) => {
    try {
      return await fn(args);
    } catch (e) {
      if (e instanceof BridgeError) return failure(e.message);
      throw e;
    }
  };
}

// Hint-only mode: on while a graded activity (.pka) is open, or always when an
// instructor sets PT_TUTOR_MODE=hint-only. Fails closed: if Packet Tracer can't
// be asked, assume an assessment. Nothing forces it off.
const MODE = modeSetting(process.env.PT_TUTOR_MODE);
if (MODE.warning) console.error(MODE.warning);

async function hintOnly(): Promise<boolean> {
  if (MODE.forced) return true;
  try {
    return (await call<{ isActivityFile: boolean }>("activityStatus")).isActivityFile;
  } catch {
    return true;
  }
}

// Findings handed out as opaque refs during an assessment, for tutor_hint.
const hintRefs = new Map<string, Finding>();

function refFor(f: Finding): string {
  const ref = `h_${randomBytes(4).toString("hex")}`;
  hintRefs.set(ref, f);
  return ref;
}

async function runCli(device: Device, command: string): Promise<CliResult> {
  // Pings and traceroutes on unreachable targets take a while to time out.
  const slow = /^(ping|trace|tracert)/i.test(command);
  return call<CliResult>("cli", { device: device.name, command, timeoutMs: slow ? 30000 : 15000 }, slow ? 40000 : 25000);
}

function formatCli(r: CliResult): string {
  const lines = [`${r.prompt}${r.command}`, r.output];
  if (r.timedOut) lines.push("[output may be incomplete: the prompt did not return in time]");
  for (const n of r.notes) lines.push(`[note: ${n}]`);
  return lines.join("\n");
}

server.registerTool(
  "pt_status",
  {
    title: "Packet Tracer status",
    description:
      "Check that Packet Tracer is connected and report its version, the open file, and whether that file is a graded " +
      "activity (.pka). Call this first. tutorMode is \"hint-only\" during a graded activity or when an instructor has " +
      "set it for every lab (hintOnlyReason says which): diagnose hides what is wrong, hints stop at level 2, and the " +
      "configuration can't be read. " +
      "Guide them with questions; never give the configuration that solves the activity.",
    annotations: { readOnlyHint: true },
  },
  guarded(async () => {
    const age = await heartbeatAge();
    const info = await call<Record<string, unknown>>("ping");
    const activity = await call<Record<string, unknown>>("activityStatus");
    const reason = MODE.forced ? "instructor setting" : activity.isActivityFile ? "graded activity" : undefined;
    return text({ ...info, ...activity, tutorMode: reason ? "hint-only" : "full", ...(reason && { hintOnlyReason: reason }), heartbeatAgeMs: age === null ? null : Math.round(age), mailbox: MAILBOX });
  }),
);

server.registerTool(
  "get_topology",
  {
    title: "Get network topology",
    description:
      "List every network device on the Packet Tracer canvas (name, type, model, power) with its cabled or addressed " +
      "ports, and every link with its up/down state. Read-only.",
    inputSchema: {
      includeNonNetwork: z.boolean().optional().describe("Also include canvas furniture such as power distribution devices and patch panels."),
    },
    annotations: { readOnlyHint: true },
  },
  guarded(async ({ includeNonNetwork }) => text(await call("topology", { all: !!includeNonNetwork }))),
);

server.registerTool(
  "get_device_state",
  {
    title: "Get device state",
    description:
      "Detailed state of one device: every port (IP, mask, MAC, admin and line status, neighbour), plus the key show " +
      "output for its kind. Routers get 'show ip interface brief' and 'show ip route'. Switches add 'show vlan brief' " +
      "and 'show interfaces trunk'. End devices get 'ipconfig /all'. Read-only.",
    inputSchema: { device: z.string().describe("Device name exactly as shown on the canvas, e.g. 'Router0' or 'PC1'.") },
    annotations: { readOnlyHint: true },
  },
  guarded(async ({ device }) => {
    const state = await call<Device>("deviceState", { device });
    if (!state.power) return text({ ...state, cli: "device is powered off" });

    const commands =
      terminalFor(state.type) === "host"
        ? ["ipconfig /all"]
        : state.type === "Router"
          ? ["show ip interface brief", "show ip route"]
          : ["show ip interface brief", "show vlan brief", "show interfaces trunk"];

    const cli: string[] = [];
    for (const c of commands) {
      try {
        cli.push(formatCli(await runCli(state, c)));
      } catch (e) {
        cli.push(`${c}\n[failed: ${(e as Error).message}]`);
      }
    }
    return text(`${JSON.stringify(state, null, 2)}\n\n--- CLI ---\n${cli.join("\n\n")}`);
  }),
);

server.registerTool(
  "run_command",
  {
    title: "Run a read-only command",
    description:
      "Run one read-only command on a device's terminal and return its output. IOS devices (routers, switches) accept " +
      "'show ...', 'ping' and 'traceroute'. End devices (PCs, servers) accept 'ipconfig', 'ping', 'tracert', " +
      "'arp -a', 'nslookup' and 'netstat'. Configuration commands are refused: the student makes the changes, the " +
      "tutor only looks. In hint-only mode, 'show running-config' and 'show startup-config' are refused too.",
    inputSchema: {
      device: z.string().describe("Device name exactly as shown on the canvas."),
      command: z.string().describe("A single command, e.g. 'show ip route' or 'ping 192.168.1.1'."),
    },
    annotations: { readOnlyHint: true },
  },
  guarded(async ({ device, command }) => {
    const state = await call<Device>("deviceState", { device });
    if (!state.power) return failure(`${device} is powered off.`);
    const check = checkCommand(command, terminalFor(state.type));
    if (!check.ok) return failure(check.reason);
    if (await hintOnly()) {
      const guard = checkAssessmentCommand(check.command);
      if (!guard.ok) return failure(guard.reason);
    }
    return text(formatCli(await runCli(state, check.command)));
  }),
);

async function collectSnapshot(): Promise<RawSnapshot> {
  const topo = await call<{ devices: Device[] }>("topology");
  const raw: RawSnapshot = { devices: {}, cli: {} };
  for (const d of topo.devices) {
    raw.devices[d.name] = await call<Device>("deviceState", { device: d.name });
    raw.cli[d.name] = {};
    if (!d.power) continue;
    for (const cmd of commandsFor(d.type)) {
      try {
        raw.cli[d.name][cmd] = (await runCli(d, cmd)).output;
      } catch {
        // A device whose terminal fails is modelled from API data alone.
      }
    }
  }
  return raw;
}

server.registerTool(
  "diagnose",
  {
    title: "Diagnose connectivity",
    description:
      "Explain why one device can or cannot reach another. Reads the whole live network (addressing, gateways, " +
      "VLANs, trunks, interface state, routing tables, static routes, ACLs, proxy ARP), walks the path hop by hop in " +
      "both directions, and runs a real ping to confirm. Returns findings with a code, the device and interface, " +
      "evidence and the concept involved. In tutor mode, use the findings to ask guiding questions; do not paste " +
      "the fix. Pass a finding to tutor_hint to get a graded hint. In hint-only mode the findings are redacted to " +
      "where the problem is (device, interface, area) and a ref for tutor_hint. Takes 10-60 seconds on larger labs.",
    inputSchema: {
      source: z.string().describe("Device the traffic starts from, e.g. 'PC1'."),
      destination: z.string().describe("Destination device name or IPv4 address, e.g. 'PC3' or '192.168.20.10'."),
      ping: z.boolean().optional().describe("Also run a real ping from the source to confirm (default true)."),
    },
    annotations: { readOnlyHint: true },
  },
  guarded(async ({ source, destination, ping }) => {
    const raw = await collectSnapshot();
    const result = diagnose(buildModel(raw), source, destination);
    let observed: ReturnType<typeof parsePing> | undefined;
    const src = raw.devices[source];
    if (ping !== false && src?.power && result.destinationIp) {
      const cmd = terminalFor(src.type) === "host" ? `ping -n 3 ${result.destinationIp}` : `ping ${result.destinationIp}`;
      observed = parsePing((await runCli(src, cmd)).output);
    }
    if (await hintOnly()) {
      return text({
        ...redactDiagnosis(result, refFor),
        observed,
        note: "Hint-only mode: findings are redacted. Use tutor_hint with each ref, starting at level 1.",
      });
    }
    const agrees = observed ? (observed.received > 0) === (result.predicted === "reachable") : undefined;
    return text({
      ...result,
      observed,
      ...(agrees === false && {
        note: "The real ping disagrees with the prediction. Trust the ping; the engine may not model this situation yet.",
      }),
    });
  }),
);

server.registerTool(
  "tutor_hint",
  {
    title: "Get a tutor hint",
    description:
      "Get a hint for a finding from diagnose, at one of three levels. Pass either the finding's code, or its ref when " +
      "diagnose returned redacted findings. Level 1 is a nudge towards the problem area " +
      "without naming the device. Level 2 names the device and a read-only command to look at. Level 3 explains the " +
      "concept. No level gives the fix. Start at level 1 and only go up after the student has tried and is still " +
      "stuck. Put the hint in your own words, as a question where you can. In hint-only mode the highest " +
      "level is 2.",
    inputSchema: {
      code: z.string().optional().describe("Finding code from diagnose, e.g. 'WRONG_GATEWAY'."),
      ref: z.string().optional().describe("The finding's ref from a redacted diagnose result, e.g. 'h_1a2b3c4d'."),
      level: z.number().int().min(1).max(3).describe("1 = nudge, 2 = where to look, 3 = explain the concept."),
      device: z.string().optional().describe("The finding's device, from diagnose."),
      interface: z.string().optional().describe("The finding's interface, from diagnose."),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ code, ref, level, device, interface: iface }) => {
    const finding = ref ? hintRefs.get(ref) : undefined;
    if (ref && !finding) return failure(`Unknown ref '${ref}'. Refs last until the server restarts; run diagnose again.`);
    const c = finding?.code ?? code;
    if (!c) return failure("Pass either code or ref.");
    const ctx = finding ? { device: finding.device, interface: finding.interface } : { device, interface: iface };
    if (!(await hintOnly())) return text(hint(c, level as HintLevel, ctx));
    const capped = Math.min(level, ASSESSMENT_MAX_HINT_LEVEL) as HintLevel;
    // The code and concept would name the fault, so a ref stays a ref and the concept is left out.
    const { concept: _concept, ...plain } = hint(c, capped, ctx);
    const h = { ...plain, ...(ref && { code: ref }), more: capped < ASSESSMENT_MAX_HINT_LEVEL };
    if (capped < level) {
      return text({ ...h, note: `Hint-only mode: hints stop at level ${ASSESSMENT_MAX_HINT_LEVEL}. Encourage the student to reason it out.` });
    }
    return text(h);
  },
);

server.registerPrompt(
  "tutor",
  {
    title: "Start a tutoring session",
    description: "Get help with a Packet Tracer lab as a tutor: guiding questions and hints, not answers.",
    argsSchema: {
      problem: z.string().optional().describe("What you're trying to do or what isn't working, e.g. 'PC1 can't ping PC3'."),
    },
  },
  ({ problem }) => ({
    messages: [{ role: "user", content: { type: "text", text: tutorPrompt(problem) } }],
  }),
);

await server.connect(new StdioServerTransport());
