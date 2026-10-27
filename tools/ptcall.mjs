#!/usr/bin/env node
// Sends one command to the PT Tutor bridge through the file mailbox.
// Usage: node tools/ptcall.mjs <command> ['{"json":"args"}']

import { mkdir, writeFile, rename, readFile, rm, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

const MAILBOX = join(homedir(), ".pt-tutor", "mailbox");
const TIMEOUT_MS = Number(process.env.PT_TIMEOUT ?? 15000);

const [cmd, rawArgs] = process.argv.slice(2);
if (!cmd) {
  console.error("usage: ptcall <command> [jsonArgs]");
  process.exit(2);
}

await mkdir(MAILBOX, { recursive: true, mode: 0o700 });

try {
  const hb = await stat(join(MAILBOX, "heartbeat"));
  const age = Date.now() - hb.mtimeMs;
  if (age > 3000) console.error(`warning: bridge heartbeat is ${Math.round(age / 1000)}s old`);
} catch {
  console.error("warning: no heartbeat yet — is the script module running in Packet Tracer?");
}

const id = randomUUID().replace(/-/g, "");
const req = join(MAILBOX, `req_${id}.json`);
await writeFile(req + ".tmp", JSON.stringify({ id, cmd, args: rawArgs ? JSON.parse(rawArgs) : {} }));
await rename(req + ".tmp", req);

const res = join(MAILBOX, `res_${id}.json`);
const deadline = Date.now() + TIMEOUT_MS;
while (Date.now() < deadline) {
  try {
    const text = await readFile(res, "utf8");
    await rm(res, { force: true });
    console.log(JSON.stringify(JSON.parse(text), null, 2));
    process.exit(0);
  } catch {
    await new Promise((r) => setTimeout(r, 50));
  }
}
await rm(req, { force: true });
console.error("timeout: no response from Packet Tracer");
process.exit(1);
