// Client side of the file mailbox shared with the Packet Tracer script module
// (extension/bridge.js). Requests are written atomically as req_<id>.json and
// answered with res_<id>.json.

import { mkdir, writeFile, rename, readFile, rm, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

export const MAILBOX = process.env.PT_TUTOR_MAILBOX ?? join(homedir(), ".pt-tutor", "mailbox");

const HEARTBEAT_STALE_MS = 5000;
const POLL_MS = 40;

export class BridgeError extends Error {}

export async function ensureMailbox(): Promise<void> {
  await mkdir(MAILBOX, { recursive: true, mode: 0o700 });
}

/** Milliseconds since the script module last wrote its heartbeat, or null if never. */
export async function heartbeatAge(): Promise<number | null> {
  try {
    const hb = await stat(join(MAILBOX, "heartbeat"));
    return Date.now() - hb.mtimeMs;
  } catch {
    return null;
  }
}

export async function call<T = unknown>(cmd: string, args: Record<string, unknown> = {}, timeoutMs = 20000): Promise<T> {
  await ensureMailbox();
  const age = await heartbeatAge();
  if (age === null || age > HEARTBEAT_STALE_MS) {
    throw new BridgeError(
      "Packet Tracer bridge is not running. Open Packet Tracer and make sure the " +
        "'PT Tutor Bridge' script module is started (Extensions > Scripting > Configure PT Script Modules).",
    );
  }

  const id = randomUUID().replace(/-/g, "");
  const req = join(MAILBOX, `req_${id}.json`);
  const res = join(MAILBOX, `res_${id}.json`);
  await writeFile(req + ".tmp", JSON.stringify({ id, cmd, args }));
  await rename(req + ".tmp", req);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let text: string;
    try {
      text = await readFile(res, "utf8");
    } catch {
      await new Promise((r) => setTimeout(r, POLL_MS));
      continue;
    }
    await rm(res, { force: true });
    const reply = JSON.parse(text) as { ok: boolean; value?: T; error?: string };
    if (!reply.ok) throw new BridgeError(reply.error ?? "unknown bridge error");
    return reply.value as T;
  }
  await rm(req, { force: true });
  throw new BridgeError(`Packet Tracer did not answer '${cmd}' within ${timeoutMs / 1000}s`);
}
