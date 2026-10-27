#!/usr/bin/env node
// Dev only: injects one fault at a time into the reference lab (see
// build-lab.mjs), captures a fixture, records what a real ping does, runs
// the diagnosis engine, then restores the lab.
// Usage: node tools/scenarios.mjs [scenarioName ...]

import { mkdir, writeFile } from "node:fs/promises";
import { call } from "../dist/mailbox.js";
import { commandsFor, buildModel } from "../dist/model.js";
import { diagnose } from "../dist/diagnose.js";
import { parsePing } from "../dist/parse.js";

const js = (s) => JSON.stringify(s);
const evalPT = (code) => call("eval", { code });

const ios = (device, lines) =>
  evalPT(
    `var l = ipc.network().getDevice(${js(device)}).getCommandLine();` +
      `${js(["enable", "configure terminal", ...lines, "end"])}.forEach(function (c) { l.enterCommand(c); }); true`,
  );

const host = (device, { ip, mask, gw }) =>
  evalPT(
    `var p = ipc.network().getDevice(${js(device)}).getPort("FastEthernet0");` +
      (ip ? `p.setIpSubnetMask(${js(ip)}, ${js(mask)});` : "") +
      (gw !== undefined ? `p.setDefaultGateway(${js(gw)});` : "") +
      "true",
  );

// Each scenario: fault to apply, how to undo it, the ping to test, and the
// finding code the engine is expected to lead with.
export const SCENARIOS = {
  "wrong-gateway": {
    apply: () => host("PC1", { gw: "192.168.10.254" }),
    revert: () => host("PC1", { gw: "192.168.10.1" }),
    src: "PC1", dst: "PC3", expect: "WRONG_GATEWAY",
  },
  "no-gateway": {
    apply: () => host("PC3", { gw: "0.0.0.0" }),
    revert: () => host("PC3", { gw: "192.168.20.1" }),
    src: "PC3", dst: "PC1", expect: "NO_GATEWAY",
  },
  "router-if-shutdown": {
    apply: () => ios("R2", ["interface GigabitEthernet0/0", "shutdown"]),
    revert: () => ios("R2", ["interface GigabitEthernet0/0", "no shutdown"]),
    src: "PC1", dst: "PC3", expect: "IF_SHUTDOWN",
  },
  "no-route": {
    apply: () => ios("R1", ["no ip route 192.168.20.0 255.255.255.0 10.0.0.2"]),
    revert: () => ios("R1", ["ip route 192.168.20.0 255.255.255.0 10.0.0.2"]),
    src: "PC1", dst: "PC3", expect: "NO_ROUTE",
  },
  "no-return-route": {
    apply: () => ios("R2", ["no ip route 192.168.10.0 255.255.255.0 10.0.0.1"]),
    revert: () => ios("R2", ["ip route 192.168.10.0 255.255.255.0 10.0.0.1"]),
    src: "PC1", dst: "PC3", expect: "NO_ROUTE", direction: "return",
  },
  "next-hop-broadcast": {
    apply: () => ios("R1", ["no ip route 192.168.20.0 255.255.255.0 10.0.0.2", "ip route 192.168.20.0 255.255.255.0 10.0.0.3"]),
    revert: () => ios("R1", ["no ip route 192.168.20.0 255.255.255.0 10.0.0.3", "ip route 192.168.20.0 255.255.255.0 10.0.0.2"]),
    src: "PC1", dst: "PC3", expect: "NEXT_HOP_BROADCAST",
  },
  "next-hop-off-link": {
    apply: () => ios("R1", ["no ip route 192.168.20.0 255.255.255.0 10.0.0.2", "ip route 192.168.20.0 255.255.255.0 10.0.0.6"]),
    revert: () => ios("R1", ["no ip route 192.168.20.0 255.255.255.0 10.0.0.6", "ip route 192.168.20.0 255.255.255.0 10.0.0.2"]),
    src: "PC1", dst: "PC3", expect: "STATIC_ROUTE_INACTIVE",
  },
  "vlan-mismatch": {
    apply: () => ios("SW1", ["interface GigabitEthernet0/1", "switchport access vlan 1"]),
    revert: () => ios("SW1", ["interface GigabitEthernet0/1", "switchport access vlan 10"]),
    src: "PC1", dst: "PC3", expect: "VLAN_MISMATCH",
  },
  "switch-port-shutdown": {
    apply: () => ios("SW2", ["interface FastEthernet0/1", "shutdown"]),
    revert: () => ios("SW2", ["interface FastEthernet0/1", "no shutdown"]),
    src: "PC1", dst: "PC3", expect: "IF_SHUTDOWN",
  },
  "mask-mismatch": {
    apply: () => host("PC2", { ip: "192.168.10.11", mask: "255.255.0.0" }),
    revert: () => host("PC2", { ip: "192.168.10.11", mask: "255.255.255.0" }),
    src: "PC2", dst: "PC3", expect: "MASK_MISMATCH",
  },
  "mask-mismatch-no-proxy-arp": {
    apply: () => Promise.all([
      host("PC2", { ip: "192.168.10.11", mask: "255.255.0.0" }),
      ios("R1", ["interface GigabitEthernet0/0", "no ip proxy-arp"]),
    ]),
    revert: () => Promise.all([
      host("PC2", { ip: "192.168.10.11", mask: "255.255.255.0" }),
      ios("R1", ["interface GigabitEthernet0/0", "ip proxy-arp"]),
    ]),
    src: "PC2", dst: "PC3", expect: "MASK_MISMATCH",
  },
  "acl-deny": {
    apply: () => ios("R2", ["access-list 10 deny host 192.168.10.10", "access-list 10 permit any", "interface GigabitEthernet0/0", "ip access-group 10 out"]),
    revert: () => ios("R2", ["interface GigabitEthernet0/0", "no ip access-group 10 out", "exit", "no access-list 10"]),
    src: "PC1", dst: "PC3", expect: "ACL_DENY",
  },
};

async function capture() {
  const topo = await call("topology");
  const raw = { devices: {}, cli: {} };
  for (const d of topo.devices) {
    raw.devices[d.name] = await call("deviceState", { device: d.name });
    raw.cli[d.name] = {};
    for (const cmd of commandsFor(d.type)) raw.cli[d.name][cmd] = (await call("cli", { device: d.name, command: cmd }, 30000)).output;
  }
  return raw;
}

async function ping(src, dstIp) {
  const r = await call("cli", { device: src, command: `ping -n 3 ${dstIp}`, timeoutMs: 30000 }, 40000);
  return parsePing(r.output);
}

// A re-enabled switch port spends ~30s in STP listening/learning, so wait
// until the baseline path works again before the next scenario.
async function waitHealthy() {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const r = await ping("PC1", "192.168.20.10");
    if (r?.received) return;
    await new Promise((res) => setTimeout(res, 3000));
  }
  throw new Error("lab did not recover after revert");
}

const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(SCENARIOS);
for (const name of names) {
  const s = SCENARIOS[name];
  await s.apply();
  await new Promise((r) => setTimeout(r, 3000)); // let links and routes settle
  try {
    const raw = await capture();
    const d = diagnose(buildModel(raw), s.src, s.dst);
    const observed = await ping(s.src, d.destinationIp);
    raw.expected = { src: s.src, dst: s.dst, code: s.expect, direction: s.direction ?? "forward", observed };
    const dir = new URL(`../test/fixtures/${name}/`, import.meta.url);
    await mkdir(dir, { recursive: true });
    await writeFile(new URL("raw.json", dir), JSON.stringify(raw, null, 2));

    const findings = [...d.forward.findings, ...(d.return?.findings ?? [])];
    const first = findings.find((f) => f.severity === "error") ?? findings[0];
    const pass = first?.code === s.expect && d.predicted === (observed?.received ? "reachable" : "unreachable");
    console.log(`${pass ? "PASS" : "FAIL"} ${name}: predicted ${d.predicted}, ping ${observed?.received}/${observed?.sent}, first finding ${first?.code ?? "-"} (${first?.direction ?? ""})`);
    if (!pass) for (const f of findings) console.log(`     ${f.direction} ${f.code} ${f.device} ${f.interface ?? ""}: ${f.message}`);
  } finally {
    await s.revert();
    await waitHealthy();
  }
}
