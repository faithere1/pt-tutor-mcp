#!/usr/bin/env node
// Writes release/pt-tutor-bridge.js: extension/bridge.js with PT_TUTOR_DEV
// off, so the shipped module has no "eval" or "reload" command. Paste it into
// a new script module in Packet Tracer and export that as a .pts.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const src = readFileSync(new URL("extension/bridge.js", root), "utf8");

const DEV_LINE = /^var PT_TUTOR_DEV = true;.*$/m;
if (!DEV_LINE.test(src)) throw new Error("bridge.js: PT_TUTOR_DEV line not found; update build-release.mjs");
const out = src.replace(DEV_LINE, "var PT_TUTOR_DEV = false;         // release build: eval and reload are disabled");
if (/PT_TUTOR_DEV\s*=\s*true/.test(out)) throw new Error("release build still enables PT_TUTOR_DEV");

const version = out.match(/var PT_TUTOR_VERSION = "([^"]+)"/)?.[1];
const dir = new URL("release/", root);
mkdirSync(dir, { recursive: true });
const dest = new URL("pt-tutor-bridge.js", dir);
writeFileSync(dest, out);
console.log(`bridge ${version} (release) -> ${fileURLToPath(dest)}`);
