#!/usr/bin/env node
// Dev only: builds the reference lab on the open Packet Tracer canvas using
// the bridge's dev "eval" command. Usage: node tools/build-lab.mjs [--clear]
//
//   PC1 ─┐
//        ├─ SW1 (VLAN 10) ── R1 ══ 10.0.0.0/30 ══ R2 ── SW2 ── PC3
//   PC2 ─┘  192.168.10.0/24      static routes       192.168.20.0/24

import { call } from "../dist/mailbox.js";

const STRAIGHT = 8100;
const CROSS = 8101;

const devices = [
  ["R1", 0, "2911", 300, 200],
  ["R2", 0, "2911", 550, 200],
  ["SW1", 1, "2960-24TT", 150, 300],
  ["SW2", 1, "2960-24TT", 700, 300],
  ["PC1", 8, "PC-PT", 50, 450],
  ["PC2", 8, "PC-PT", 200, 450],
  ["PC3", 8, "PC-PT", 750, 450],
];

const links = [
  ["R1", "GigabitEthernet0/0", "SW1", "GigabitEthernet0/1", STRAIGHT],
  ["R1", "GigabitEthernet0/1", "R2", "GigabitEthernet0/1", CROSS],
  ["R2", "GigabitEthernet0/0", "SW2", "GigabitEthernet0/1", STRAIGHT],
  ["PC1", "FastEthernet0", "SW1", "FastEthernet0/1", STRAIGHT],
  ["PC2", "FastEthernet0", "SW1", "FastEthernet0/2", STRAIGHT],
  ["PC3", "FastEthernet0", "SW2", "FastEthernet0/1", STRAIGHT],
];

const hosts = [
  ["PC1", "192.168.10.10", "255.255.255.0", "192.168.10.1"],
  ["PC2", "192.168.10.11", "255.255.255.0", "192.168.10.1"],
  ["PC3", "192.168.20.10", "255.255.255.0", "192.168.20.1"],
];

const configs = {
  R1: [
    "hostname R1",
    "interface GigabitEthernet0/0", "ip address 192.168.10.1 255.255.255.0", "no shutdown",
    "interface GigabitEthernet0/1", "ip address 10.0.0.1 255.255.255.252", "no shutdown",
    "exit",
    "ip route 192.168.20.0 255.255.255.0 10.0.0.2",
  ],
  R2: [
    "hostname R2",
    "interface GigabitEthernet0/0", "ip address 192.168.20.1 255.255.255.0", "no shutdown",
    "interface GigabitEthernet0/1", "ip address 10.0.0.2 255.255.255.252", "no shutdown",
    "exit",
    "ip route 192.168.10.0 255.255.255.0 10.0.0.1",
  ],
  SW1: [
    "hostname SW1",
    "vlan 10", "name STUDENTS", "exit",
    "interface range FastEthernet0/1 - 2", "switchport mode access", "switchport access vlan 10",
    "interface GigabitEthernet0/1", "switchport mode access", "switchport access vlan 10",
  ],
  SW2: ["hostname SW2"],
};

const js = (s) => JSON.stringify(s);
const evalPT = (code) => call("eval", { code });

if (process.argv.includes("--clear")) {
  const names = await evalPT("var n = ipc.network(), r = []; for (var i = 0; i < n.getDeviceCount(); i++) r.push(String(n.getDeviceAt(i).getName())); r");
  const lw = "ipc.appWindow().getActiveWorkspace().getLogicalWorkspace()";
  for (const name of names) await evalPT(`${lw}.removeDevice(${js(name)})`);
  console.log("removed:", names.join(", "));
}

for (const [name, type, model, x, y] of devices) {
  const created = await evalPT(
    `var lw = ipc.appWindow().getActiveWorkspace().getLogicalWorkspace();` +
      `var n = String(lw.addDevice(${type}, ${js(model)}, ${x}, ${y}));` +
      `var d = ipc.network().getDevice(n); d.setName(${js(name)}); if (d.skipBoot) d.skipBoot(); n`,
  );
  console.log(`device ${name} (${created})`);
}

for (const [a, pa, b, pb, cable] of links) {
  const ok = await evalPT(
    `ipc.appWindow().getActiveWorkspace().getLogicalWorkspace().createLink(${js(a)}, ${js(pa)}, ${js(b)}, ${js(pb)}, ${cable})`,
  );
  console.log(`link ${a}:${pa} - ${b}:${pb} ${ok ? "ok" : "FAILED"}`);
}

for (const [name, ip, mask, gw] of hosts) {
  await evalPT(
    `var d = ipc.network().getDevice(${js(name)}); var p = d.getPort("FastEthernet0");` +
      `p.setIpSubnetMask(${js(ip)}, ${js(mask)}); p.setDefaultGateway(${js(gw)}); true`,
  );
  console.log(`host ${name} ${ip}/${mask} gw ${gw}`);
}

// Get each terminal to a prompt first (the bridge answers boot dialogs).
for (const name of Object.keys(configs)) await call("cli", { device: name, command: "show clock" });

for (const [name, lines] of Object.entries(configs)) {
  const cmds = ["enable", "configure terminal", ...lines, "end"];
  await evalPT(
    `var l = ipc.network().getDevice(${js(name)}).getCommandLine();` +
      `${js(cmds)}.forEach(function (c) { l.enterCommand(c); }); String(l.getPrompt())`,
  );
  console.log(`configured ${name}`);
}
