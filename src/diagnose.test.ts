// Runs the engine on every fixture captured from a live Packet Tracer by
// tools/scenarios.mjs. Each fixture records the injected fault, the finding
// expected first, and what a real ping did.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { buildModel, type RawSnapshot } from "./model.js";
import { diagnose } from "./diagnose.js";

const root = new URL("../test/fixtures/", import.meta.url);

interface Expected {
  src: string;
  dst: string;
  code: string;
  direction: "forward" | "return";
  observed: { sent: number; received: number } | null;
}

for (const name of readdirSync(root)) {
  const file = new URL(`${name}/raw.json`, root);
  if (!existsSync(file)) continue;
  const raw = JSON.parse(readFileSync(file, "utf8")) as RawSnapshot & { expected?: Expected };

  if (!raw.expected) {
    test(`${name}: healthy lab has no findings`, () => {
      const model = buildModel(raw);
      for (const [s, d] of [["PC1", "PC3"], ["PC1", "PC2"], ["PC3", "192.168.10.1"], ["R1", "PC3"]]) {
        const r = diagnose(model, s, d);
        assert.equal(r.predicted, "reachable", `${s} -> ${d}`);
        assert.deepEqual([...r.forward.findings, ...(r.return?.findings ?? [])], [], `${s} -> ${d}`);
      }
    });
    continue;
  }

  const e = raw.expected;
  test(`${name}: ${e.src} -> ${e.dst} leads with ${e.code}`, () => {
    const r = diagnose(buildModel(raw), e.src, e.dst);
    const findings = [...r.forward.findings, ...(r.return?.findings ?? [])];
    const first = findings.find((f) => f.severity === "error") ?? findings[0];
    assert.equal(first?.code, e.code);
    assert.equal(first?.direction, e.direction);
    // The prediction must agree with what the real ping did.
    assert.equal(r.predicted, e.observed?.received ? "reachable" : "unreachable");
  });
}
