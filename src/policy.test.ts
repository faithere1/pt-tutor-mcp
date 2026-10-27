import { test } from "node:test";
import assert from "node:assert/strict";
import { checkCommand, terminalFor } from "./policy.js";

test("IOS show commands and abbreviations are allowed", () => {
  for (const c of ["show ip route", "sh ip int br", "SHOW running-config", "show vlan brief", "show ip ospf neighbor"]) {
    assert.equal(checkCommand(c, "ios").ok, true, c);
  }
});

test("IOS config and state-changing commands are refused", () => {
  for (const c of [
    "configure terminal",
    "conf t",
    "reload",
    "write memory",
    "copy running-config startup-config",
    "erase startup-config",
    "clear ip route *",
    "debug all",
    "enable",
    "show",
    "show tech-support",
    "show run | redirect flash:x",
  ]) {
    assert.equal(checkCommand(c, "ios").ok, false, c);
  }
});

test("multiple commands in one call are refused", () => {
  assert.equal(checkCommand("show ip route\nconf t", "ios").ok, false);
  assert.equal(checkCommand("show ip route; reload", "ios").ok, false);
  assert.equal(checkCommand("ipconfig\r\nipconfig /release", "host").ok, false);
});

test("IOS ping and traceroute are allowed", () => {
  assert.equal(checkCommand("ping 10.0.0.1", "ios").ok, true);
  assert.equal(checkCommand("traceroute 10.0.0.1", "ios").ok, true);
});

test("host diagnostic commands are allowed, changes are refused", () => {
  for (const c of ["ipconfig", "ipconfig /all", "ping 192.168.1.1", "ping -n 2 192.168.1.1", "tracert 8.8.8.8", "arp -a", "nslookup example.com"]) {
    assert.equal(checkCommand(c, "host").ok, true, c);
  }
  for (const c of ["ipconfig /release", "ipconfig /renew", "arp -d", "ftp 10.0.0.1", "telnet 10.0.0.1", "ssh -l admin 10.0.0.1"]) {
    assert.equal(checkCommand(c, "host").ok, false, c);
  }
});

test("whitespace is normalised", () => {
  const r = checkCommand("  show   ip   route  ", "ios");
  assert.deepEqual(r, { ok: true, command: "show ip route" });
});

test("terminal type follows device type", () => {
  assert.equal(terminalFor("Router"), "ios");
  assert.equal(terminalFor("MultiLayerSwitch"), "ios");
  assert.equal(terminalFor("PC"), "host");
  assert.equal(terminalFor("Server"), "host");
});
