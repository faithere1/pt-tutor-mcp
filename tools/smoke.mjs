#!/usr/bin/env node
// End-to-end check: starts the MCP server over stdio and calls each tool
// against the running Packet Tracer. Usage: node tools/smoke.mjs [router] [pc]

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [router = "Router0", pc = "PC0"] = process.argv.slice(2);

const client = new Client({ name: "smoke", version: "0" });
await client.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"] }));

const { tools } = await client.listTools();
console.log("tools:", tools.map((t) => t.name).join(", "));

const calls = [
  ["pt_status", {}],
  ["get_topology", {}],
  ["get_device_state", { device: router }],
  ["run_command", { device: router, command: "sh ip int br" }],
  ["run_command", { device: router, command: "conf t" }],
  ["run_command", { device: pc, command: "ipconfig" }],
];

for (const [name, args] of calls) {
  const r = await client.callTool({ name, arguments: args });
  console.log(`\n### ${name} ${JSON.stringify(args)}${r.isError ? "  (error)" : ""}`);
  console.log(r.content.map((c) => c.text).join("\n"));
}

await client.close();
