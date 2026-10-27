import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { buildModel, type RawSnapshot } from "./model.js";
import { diagnose } from "./diagnose.js";
import { HINT_CODES } from "./hints.js";
import { areaOf, checkAssessmentCommand, modeSetting, redactDiagnosis } from "./guard.js";

const root = new URL("../test/fixtures/", import.meta.url);

test("redacted diagnoses never reveal the fault", () => {
  let checked = 0;
  for (const name of readdirSync(root)) {
    const file = new URL(`${name}/raw.json`, root);
    if (!existsSync(file)) continue;
    const raw = JSON.parse(readFileSync(file, "utf8")) as RawSnapshot & { expected?: { src: string; dst: string } };
    if (!raw.expected) continue;
    const d = diagnose(buildModel(raw), raw.expected.src, raw.expected.dst);
    const all = [...d.forward.findings, ...(d.return?.findings ?? []), ...d.other];
    const stored = new Map<string, string>();
    const r = redactDiagnosis(d, (f) => {
      const ref = `h_${stored.size}`;
      stored.set(ref, f.code);
      return ref;
    });
    const json = JSON.stringify(r);

    assert.ok(all.length > 0, name);
    for (const f of all) {
      assert.ok(!json.includes(f.code), `${name}: code ${f.code} leaked`);
      assert.ok(!json.includes(f.message), `${name}: message leaked`);
      for (const e of f.evidence) assert.ok(!json.includes(e), `${name}: evidence leaked: ${e}`);
    }
    assert.doesNotMatch(json, /"(message|evidence|concept|hops|code)"/, name);
    // Every finding still gets a ref, so tutor_hint can help with it.
    assert.equal(stored.size, all.length, name);
    assert.equal(r.predicted, d.predicted, name);
    checked++;
  }
  assert.ok(checked >= 12);
});

test("every hinted code has an area", () => {
  for (const code of HINT_CODES) {
    if (code === "UNKNOWN_DEVICE") continue;
    assert.notEqual(areaOf(code), "general", code);
  }
});

test("configuration commands are refused during an assessment", () => {
  for (const c of ["show running-config", "sh run", "show run | include ip route", "SHOW startup-config", "sh start",
    "show config", "show archive"]) {
    assert.equal(checkAssessmentCommand(c).ok, false, c);
  }
  for (const c of ["show ip route", "show ip interface brief", "show vlan brief", "show interfaces trunk",
    "show access-lists", "ping 10.0.0.2", "ipconfig /all"]) {
    assert.equal(checkAssessmentCommand(c).ok, true, c);
  }
});

test("PT_TUTOR_MODE: auto by default, hint-only when set, and fails closed on anything else", () => {
  for (const v of [undefined, "", "auto", " AUTO "]) assert.deepEqual(modeSetting(v), { forced: false }, String(v));
  for (const v of ["hint-only", "Hint-Only"]) assert.deepEqual(modeSetting(v), { forced: true }, v);
  for (const v of ["hint_only", "full", "off", "0"]) {
    const m = modeSetting(v);
    assert.equal(m.forced, true, v);
    assert.match(m.warning ?? "", /hint-only/, v);
  }
});
