#!/usr/bin/env node
// Dev only: hot-reloads extension/bridge.js into the running script module.
import { fileURLToPath } from "node:url";
import { call } from "../dist/mailbox.js";

const path = fileURLToPath(new URL("../extension/bridge.js", import.meta.url));
await call("reload", { path });
await new Promise((r) => setTimeout(r, 500));
console.log("bridge", (await call("ping")).bridge);
