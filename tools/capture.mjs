#!/usr/bin/env node
// Dev only: saves real command output from the open lab as parser/engine
// fixtures. Usage: node tools/capture.mjs <fixtureName>

import { mkdir, writeFile } from "node:fs/promises";
import { call } from "../dist/mailbox.js";
import { commandsFor } from "../dist/model.js";

const name = process.argv[2];
if (!name) throw new Error("usage: capture.mjs <fixtureName>");
const dir = new URL(`../test/fixtures/${name}/`, import.meta.url);
await mkdir(dir, { recursive: true });

const topo = await call("topology");
const snapshot = { topology: topo, devices: {}, cli: {} };
for (const d of topo.devices) {
  snapshot.devices[d.name] = await call("deviceState", { device: d.name });
  snapshot.cli[d.name] = {};
  for (const cmd of commandsFor(d.type)) {
    const r = await call("cli", { device: d.name, command: cmd }, 30000);
    snapshot.cli[d.name][cmd] = r.output;
    console.log(`${d.name}: ${cmd} (${r.output.length} chars${r.timedOut ? ", TIMED OUT" : ""})`);
  }
}
await writeFile(new URL("raw.json", dir), JSON.stringify(snapshot, null, 2));
console.log(`saved test/fixtures/${name}/raw.json`);
