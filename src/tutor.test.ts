import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { INSTRUCTIONS, tutorPrompt } from "./tutor.js";

test("instructions mention every tool, and only tools that exist", () => {
  const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const tools = [...src.matchAll(/registerTool\(\s*"([a-z_]+)"/g)].map((m) => m[1]);
  assert.ok(tools.length >= 6);
  for (const t of tools) assert.ok(INSTRUCTIONS.includes(t), `instructions don't mention ${t}`);
  const named = new Set([...INSTRUCTIONS.matchAll(/\b([a-z]+_[a-z_]+)\b/g)].map((m) => m[1]));
  for (const n of named) assert.ok(tools.includes(n), `instructions name unknown tool ${n}`);
});

test("instructions cover the graded-activity mode the server reports", () => {
  assert.match(INSTRUCTIONS, /tutorMode "hint-only"/);
  assert.match(INSTRUCTIONS, /level 2/);
});

test("the tutor prompt includes the student's problem when given", () => {
  assert.match(tutorPrompt("PC1 can't ping PC3"), /PC1 can't ping PC3/);
  assert.doesNotMatch(tutorPrompt(), /stuck:/);
  assert.equal(tutorPrompt("  "), tutorPrompt());
});
