import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { hint, HINT_CODES, type HintLevel } from "./hints.js";
import { checkCommand } from "./policy.js";

const LEVELS: HintLevel[] = [1, 2, 3];

test("every finding code the engine emits has a hint ladder", () => {
  const src = readFileSync(new URL("../src/diagnose.ts", import.meta.url), "utf8");
  const emitted = new Set([...src.matchAll(/"([A-Z]+_[A-Z0-9_]+)"/g)].map((m) => m[1]));
  const missing = [...emitted].filter((c) => !HINT_CODES.includes(c));
  assert.deepEqual(missing, []);
});

test("placeholders are filled, with and without context", () => {
  for (const code of HINT_CODES) {
    for (const level of LEVELS) {
      for (const ctx of [{}, { device: "R1" }, { device: "R1", interface: "GigabitEthernet0/1" }]) {
        const h = hint(code, level, ctx);
        assert.doesNotMatch(h.hint, /[{}]/, `${code} level ${level}`);
        assert.ok(h.hint.length > 20, `${code} level ${level}`);
      }
    }
  }
});

test("level 2 names the device and only suggests read-only commands", () => {
  for (const code of HINT_CODES) {
    if (code === "UNKNOWN_DEVICE" || code === "DEST_UNKNOWN") continue;
    const h = hint(code, 2, { device: "R1", interface: "GigabitEthernet0/1" });
    assert.match(h.hint, /R1/, code);
    for (const [, cmd] of h.hint.matchAll(/'([^']+)'/g)) {
      const concrete = cmd.replace("<destination>", "10.0.0.2");
      const terminal = /^ipconfig/.test(concrete) ? "host" : "ios";
      assert.equal(checkCommand(concrete, terminal).ok, true, `${code}: ${cmd}`);
    }
  }
});

test("level 1 does not name the device", () => {
  for (const code of HINT_CODES) {
    assert.doesNotMatch(hint(code, 1, { device: "R1", interface: "Gig0/1" }).hint, /R1|Gig0\/1/, code);
  }
});

test("no level gives a configuration command", () => {
  const fixes = [/no shut/i, /switchport (mode|access|trunk)/i, /encapsulation dot1q \d/i, /ip route \d/i,
    /ip address \d/i, /access-group \S+ (in|out)/i, /\bconf(igure)? t(erminal)?\b/i];
  for (const code of HINT_CODES) {
    for (const level of LEVELS) {
      const h = hint(code, level, { device: "R1", interface: "Gig0/1" });
      for (const r of fixes) assert.doesNotMatch(h.hint, r, `${code} level ${level}`);
    }
  }
});

test("unknown codes fall back to a generic ladder", () => {
  const h = hint("SOMETHING_NEW", 1);
  assert.equal(h.concept, "troubleshooting");
  assert.equal(h.more, true);
  assert.equal(hint("no_route", 3).code, "NO_ROUTE");
  assert.equal(hint("NO_ROUTE", 3).more, false);
});
