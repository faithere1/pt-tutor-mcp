// The diagnosis engine: walks the path a packet would take from a source
// device to a destination and reports where and why it breaks, with the
// evidence a teacher would point at. Pure: works on a Model, no I/O.

import { inSubnet, intToIp, ipToInt, isApipa, lenToMaskInt, maskToLen, networkOf, wildcardMatch } from "./net.js";
import { vlanListHas } from "./parse.js";
import type { L3If, Model, Node } from "./model.js";

export type Severity = "error" | "warning" | "info";

export interface Finding {
  code: string;
  severity: Severity;
  device: string;
  interface?: string;
  /** Plain statement of the fault, written for the tutor (not shown verbatim to students). */
  message: string;
  evidence: string[];
  /** The networking concept a student needs, e.g. "default gateway". */
  concept: string;
  direction?: "forward" | "return";
}

export interface PathResult {
  ok: boolean;
  hops: string[];
  findings: Finding[];
}

export interface Diagnosis {
  source: string;
  destination: string;
  destinationIp?: string;
  predicted: "reachable" | "unreachable" | "unknown";
  forward: PathResult;
  return?: PathResult;
  /** Problems found that are not on the path but are worth knowing about. */
  other: Finding[];
}

const MAX_HOPS = 16;

// ------------------------------------------------------------ indexes

interface Owner {
  node: Node;
  iface: L3If;
}

function ipOwners(model: Model): Map<string, Owner[]> {
  const owners = new Map<string, Owner[]>();
  for (const node of model.nodes.values()) {
    for (const iface of node.l3) {
      const list = owners.get(iface.ip) ?? [];
      list.push({ node, iface });
      owners.set(iface.ip, list);
    }
  }
  return owners;
}

const isRouting = (n: Node) => n.kind === "router" || (n.kind === "l3switch" && n.routingEnabled);

function describeIf(i: L3If): string {
  return `${i.device} ${i.name} ${i.ip}/${i.len}`;
}

// ------------------------------------------------------------ layer 2

interface Endpoint {
  device: string;
  iface: string;
}

interface L2Result {
  ok: boolean;
  findings: Finding[];
  hops: string[];
}

/**
 * Can a frame from `from` reach `to` at layer 2? Floods through switches and
 * hubs honouring link state, access VLANs, trunks and router subinterfaces.
 * When it cannot, walks the shortest physical path to say why.
 */
function l2Reach(model: Model, from: L3If, to: L3If): L2Result {
  if (from.device === to.device && from.name === to.name) return { ok: true, findings: [], hops: [] };
  const reached = flood(model, from);
  if (reached.has(`${to.device}|${to.name}`)) {
    return { ok: true, findings: [], hops: [] };
  }
  return explainL2(model, from, to);
}

interface Arrival {
  device: string;
  port: string;
  tag: number | null;
}

function egressOf(iface: L3If): { device: string; port: string; tag: number | null }[] {
  if (iface.port) return [{ device: iface.device, port: iface.port, tag: iface.vlan !== undefined && !iface.nativeTag ? iface.vlan : null }];
  return []; // SVIs leave through switch ports; handled in flood start
}

function flood(model: Model, from: L3If): Set<string> {
  const reached = new Set<string>();
  const seen = new Set<string>();
  const queue: Arrival[] = [];

  const send = (device: string, port: string, tag: number | null) => {
    const node = model.nodes.get(device);
    const p = node?.ports.get(port);
    if (!p || !p.peer || !p.adminUp || !p.up) return;
    const peer = model.nodes.get(p.peer.device);
    const pp = peer?.ports.get(p.peer.port);
    if (!pp || !pp.adminUp || !pp.up) return;
    queue.push({ device: p.peer.device, port: p.peer.port, tag });
  };

  const switchEgress = (node: Node, ingress: string | null, vlan: number) => {
    for (const port of node.ports.keys()) {
      if (port === ingress) continue;
      const trunk = node.trunks.get(port);
      if (trunk) {
        if (vlanListHas(trunk.allowed, vlan)) send(node.name, port, vlan === trunk.nativeVlan ? null : vlan);
      } else if ((node.access.get(port) ?? -1) === vlan) send(node.name, port, null);
    }
    // An SVI in this VLAN on the same switch receives the frame too.
    for (const svi of node.l3) if (svi.vlan === vlan && !svi.port && svi.adminUp) reached.add(`${node.name}|${svi.name}`);
  };

  const src = model.nodes.get(from.device)!;
  if (!from.port && from.vlan !== undefined) switchEgress(src, null, from.vlan);
  for (const e of egressOf(from)) send(e.device, e.port, e.tag);

  while (queue.length) {
    const a = queue.shift()!;
    const key = `${a.device}|${a.port}|${a.tag}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const node = model.nodes.get(a.device);
    if (!node || !node.power) continue;

    if (node.kind === "switch" || node.kind === "l3switch") {
      const trunk = node.trunks.get(a.port);
      let vlan: number;
      if (trunk) {
        vlan = a.tag ?? trunk.nativeVlan;
        if (!vlanListHas(trunk.allowed, vlan)) continue;
      } else {
        if (a.tag !== null) continue; // tagged frame on an access port
        vlan = node.access.get(a.port) ?? 1;
      }
      switchEgress(node, a.port, vlan);
    } else if (node.kind === "hub" || node.kind === "other") {
      for (const port of node.ports.keys()) if (port !== a.port) send(node.name, port, a.tag);
    } else {
      // Router or host: the frame is delivered to the matching L3 interface.
      const iface = node.l3.find((i) => i.port === a.port && matchesTag(i, a.tag));
      if (iface && iface.adminUp) reached.add(`${node.name}|${iface.name}`);
    }
  }
  return reached;
}

function matchesTag(i: L3If, tag: number | null): boolean {
  if (tag === null) return i.vlan === undefined || !!i.nativeTag;
  return i.vlan === tag && !i.nativeTag;
}

/** Shortest physical path between two devices, ignoring state: [device, outPort, inPort][]. */
function physicalPath(model: Model, from: string, to: string): { device: string; out: string; next: string; in: string }[] | null {
  const prev = new Map<string, { device: string; out: string; in: string }>();
  const queue = [from];
  const seen = new Set([from]);
  while (queue.length) {
    const d = queue.shift()!;
    if (d === to) break;
    for (const p of model.nodes.get(d)?.ports.values() ?? []) {
      if (!p.peer || seen.has(p.peer.device)) continue;
      seen.add(p.peer.device);
      prev.set(p.peer.device, { device: d, out: p.name, in: p.peer.port });
      queue.push(p.peer.device);
    }
  }
  if (!seen.has(to)) return null;
  const path: { device: string; out: string; next: string; in: string }[] = [];
  for (let d = to; d !== from; ) {
    const step = prev.get(d)!;
    path.unshift({ device: step.device, out: step.out, next: d, in: step.in });
    d = step.device;
  }
  return path;
}

function explainL2(model: Model, from: L3If, to: L3If): L2Result {
  const findings: Finding[] = [];
  const hops: string[] = [];
  const path = physicalPath(model, from.device, to.device);
  if (!path) {
    findings.push({
      code: "NOT_CABLED",
      severity: "error",
      device: from.device,
      message: `There is no cable path at all between ${from.device} and ${to.device}.`,
      evidence: [`no chain of links connects ${from.device} to ${to.device} on the canvas`],
      concept: "physical connectivity",
    });
    return { ok: false, findings, hops };
  }

  let tag: number | null = from.vlan !== undefined && !from.nativeTag && from.port ? from.vlan : null;
  let vlan: number | null = !from.port && from.vlan !== undefined ? from.vlan : null;

  for (const step of path) {
    const node = model.nodes.get(step.device)!;
    const next = model.nodes.get(step.next)!;
    const out = node.ports.get(step.out)!;
    const inn = next.ports.get(step.in)!;
    hops.push(`${step.device} ${step.out} -> ${step.next} ${step.in}`);

    // Egress decision on a switch: is the outgoing port in the frame's VLAN?
    if ((node.kind === "switch" || node.kind === "l3switch") && vlan !== null) {
      const trunk = node.trunks.get(step.out);
      const accessVlan = node.access.get(step.out);
      if (trunk && !vlanListHas(trunk.allowed, vlan)) {
        findings.push(l2Finding("VLAN_NOT_ALLOWED", node, step.out, `VLAN ${vlan} is not allowed on trunk ${step.out}.`,
          [`show interfaces trunk: ${step.out} allows ${trunk.allowed}`], "trunk allowed VLANs"));
        break;
      }
      if (!trunk && accessVlan !== undefined && accessVlan !== vlan) {
        findings.push(l2Finding("VLAN_MISMATCH", node, step.out,
          `Traffic arrives in VLAN ${vlan} but ${step.out} towards ${step.next} is an access port in VLAN ${accessVlan}.`,
          [`show vlan brief: ${step.out} is in VLAN ${accessVlan}`, `the frame is in VLAN ${vlan}`], "VLAN membership"));
        break;
      }
      tag = trunk ? (vlan === trunk.nativeVlan ? null : vlan) : null;
    }

    // The link itself.
    if (!out.adminUp || !inn.adminUp) {
      const [dev, port] = !out.adminUp ? [node, step.out] : [next, step.in];
      findings.push(l2Finding("IF_SHUTDOWN", dev, port, `${dev.name} ${port} is administratively shut down.`,
        [`${dev.name} ${port}: administratively down`], "interface shutdown"));
      break;
    }
    if (!out.up || !inn.up) {
      findings.push(l2Finding("LINK_DOWN", node, step.out, `The link ${step.device} ${step.out} <-> ${step.next} ${step.in} is down.`,
        [`${step.device} ${step.out}: ${out.up ? "up" : "down"}`, `${step.next} ${step.in}: ${inn.up ? "up" : "down"}`],
        "link status"));
      break;
    }
    if (!next.power) {
      findings.push(l2Finding("DEVICE_OFF", next, step.in, `${next.name} is powered off.`, [`${next.name}: power off`], "device power"));
      break;
    }

    // Ingress on the next device.
    if (next.kind === "switch" || next.kind === "l3switch") {
      const trunk = next.trunks.get(step.in);
      if (trunk) {
        vlan = tag ?? trunk.nativeVlan;
        if (!vlanListHas(trunk.allowed, vlan)) {
          findings.push(l2Finding("VLAN_NOT_ALLOWED", next, step.in, `VLAN ${vlan} is not allowed on trunk ${step.in}.`,
            [`show interfaces trunk: ${step.in} allows ${trunk.allowed}`], "trunk allowed VLANs"));
          break;
        }
      } else if (tag !== null) {
        findings.push(l2Finding("TRUNK_MISMATCH", next, step.in,
          `${step.device} sends tagged (802.1Q) frames for VLAN ${tag}, but ${step.next} ${step.in} is an access port, not a trunk.`,
          [`${step.next} ${step.in} is not listed in show interfaces trunk`], "trunking"));
        break;
      } else {
        vlan = next.access.get(step.in) ?? 1;
      }
    } else if (next.kind === "router" || next.kind === "host") {
      const iface = next.l3.find((i) => i.port === step.in && matchesTag(i, tag));
      if (!iface) {
        const msg = tag !== null
          ? `${next.name} receives VLAN ${tag} tagged on ${step.in} but has no subinterface with "encapsulation dot1Q ${tag}".`
          : `${next.name} ${step.in} has no IP address for this traffic.`;
        findings.push(l2Finding(tag !== null ? "NO_SUBINTERFACE" : "NO_IP_ON_INTERFACE", next, step.in, msg,
          next.l3.filter((i) => i.port === step.in).map((i) => `${i.name}: ${i.ip}/${i.len}${i.vlan !== undefined ? ` dot1Q ${i.vlan}` : ""}`),
          tag !== null ? "router-on-a-stick" : "interface addressing"));
        break;
      }
      if (!iface.adminUp) {
        findings.push(l2Finding("IF_SHUTDOWN", next, iface.name, `${next.name} ${iface.name} is shut down.`,
          [`${iface.name}: shutdown`], "interface shutdown"));
        break;
      }
      if (step.next !== to.device) break; // reached a different L3 device first
    }
  }

  if (!findings.length) {
    findings.push({
      code: "L2_UNREACHABLE",
      severity: "error",
      device: from.device,
      message: `${describeIf(from)} cannot reach ${describeIf(to)} at layer 2, for a reason the engine could not pin down.`,
      evidence: hops,
      concept: "switching",
    });
  }
  return { ok: false, findings, hops };
}

function l2Finding(code: string, node: Node, iface: string, message: string, evidence: string[], concept: string): Finding {
  return { code, severity: "error", device: node.name, interface: iface, message, evidence, concept };
}

// ------------------------------------------------------------ ACLs

function aclVerdict(node: Node, aclName: string, src: string, dst: string, icmpType: "echo" | "echo-reply"): { permit: boolean; line?: string } {
  const acl = node.acls[aclName];
  if (!acl || !acl.entries.length) return { permit: true }; // an undefined ACL permits everything
  for (const entry of acl.entries) {
    const t = entry.split(/\s+/);
    const action = t.shift();
    if (action !== "permit" && action !== "deny") continue;
    let match: boolean;
    if (acl.kind === "standard") {
      match = matchSpec(t, 0, src).match;
    } else {
      const proto = t.shift();
      if (proto !== "ip" && proto !== "icmp") continue;
      const s = matchSpec(t, 0, src);
      const d = matchSpec(t, s.next, dst);
      const rest = t.slice(d.next);
      const typeOk = proto !== "icmp" || !rest.length || !/^(echo|echo-reply)$/.test(rest[0]) || rest[0] === icmpType;
      match = s.match && d.match && typeOk;
    }
    if (match) return { permit: action === "permit", line: entry };
  }
  return { permit: false, line: "(implicit deny any at the end of the list)" };
}

function matchSpec(t: string[], i: number, ip: string): { match: boolean; next: number } {
  if (t[i] === "any") return { match: true, next: i + 1 };
  if (t[i] === "host") return { match: t[i + 1] === ip, next: i + 2 };
  if (t[i + 1] && /^\d+\.\d+\.\d+\.\d+$/.test(t[i + 1])) return { match: wildcardMatch(ip, t[i], t[i + 1]), next: i + 2 };
  return { match: t[i] === ip, next: i + 1 };
}

function checkAcl(node: Node, iface: L3If, dir: "in" | "out", src: string, dst: string, icmp: "echo" | "echo-reply"): Finding | null {
  for (const g of iface.accessGroups) {
    if (g.dir !== dir) continue;
    const v = aclVerdict(node, g.acl, src, dst, icmp);
    if (!v.permit) {
      return {
        code: "ACL_DENY",
        severity: "error",
        device: node.name,
        interface: iface.name,
        message: `Access list ${g.acl} applied ${dir} on ${node.name} ${iface.name} drops ${src} -> ${dst}.`,
        evidence: [`ip access-group ${g.acl} ${dir}`, `matching entry: ${v.line}`],
        concept: "access control lists",
      };
    }
  }
  return null;
}

// ------------------------------------------------------------ layer 3

interface Ctx {
  model: Model;
  owners: Map<string, Owner[]>;
}

function hostChecks(node: Node, direction: "forward" | "return"): { iface?: L3If; findings: Finding[] } {
  const findings: Finding[] = [];
  const iface = node.l3.find((i) => i.port && node.ports.get(i.port)?.peer) ?? node.l3[0];
  if (!iface) {
    findings.push({
      code: node.dhcp ? "DHCP_FAILED" : "HOST_NO_IP",
      severity: "error",
      device: node.name,
      message: node.dhcp ? `${node.name} is set to DHCP but did not get an address.` : `${node.name} has no IPv4 address.`,
      evidence: [node.evidence["ipconfig /all"]?.split("\n").find((l) => /IPv4 Address/.test(l))?.trim() ?? "IPv4 Address: 0.0.0.0"],
      concept: node.dhcp ? "DHCP" : "IP addressing",
      direction,
    });
    return { findings };
  }
  if (isApipa(iface.ip)) {
    findings.push({
      code: "DHCP_FAILED",
      severity: "error",
      device: node.name,
      interface: iface.name,
      message: `${node.name} has a 169.254.x.x address: DHCP failed and it fell back to APIPA.`,
      evidence: [`IPv4 Address: ${iface.ip}`],
      concept: "DHCP",
      direction,
    });
  }
  const port = iface.port ? node.ports.get(iface.port) : undefined;
  if (port && !port.peer) {
    findings.push({
      code: "NOT_CABLED",
      severity: "error",
      device: node.name,
      interface: iface.name,
      message: `${node.name} ${iface.port} is not connected to anything.`,
      evidence: [`${iface.port}: no cable`],
      concept: "physical connectivity",
      direction,
    });
  }
  return { iface, findings };
}

/** Routes a packet for dstIp, starting at srcIf on its device. */
function route(ctx: Ctx, srcIf: L3If, srcIp: string, dstIp: string, direction: "forward" | "return"): PathResult {
  const { model, owners } = ctx;
  const findings: Finding[] = [];
  const hops: string[] = [];
  const fail = (f: Omit<Finding, "direction">) => {
    findings.push({ ...f, direction });
    return { ok: false, hops, findings };
  };
  const icmp = direction === "forward" ? "echo" : "echo-reply";
  const dstOwners = owners.get(dstIp) ?? [];
  const dstOwner = dstOwners[0];

  let node = model.nodes.get(srcIf.device)!;
  let ingress: L3If | null = null;
  const visited = new Set<string>();

  // End hosts: same subnet goes direct, otherwise to the default gateway.
  if (node.kind === "host" || !isRouting(node)) {
    let proxy: Owner | undefined;
    if (inSubnet(dstIp, srcIf.ip, srcIf.len)) {
      if (!dstOwner) {
        return fail({
          code: "DEST_UNKNOWN", severity: "error", device: node.name,
          message: `No device on the canvas has the address ${dstIp}.`,
          evidence: [`${dstIp} is in ${node.name}'s subnet ${networkOf(srcIf.ip, srcIf.len)}/${srcIf.len}, but nothing owns it`],
          concept: "IP addressing",
        });
      }
      const l2 = l2Reach(model, srcIf, dstOwner.iface);
      hops.push(`${node.name} -> ${dstOwner.node.name} (same subnet, direct)`);
      if (!inSubnet(srcIf.ip, dstOwner.iface.ip, dstOwner.iface.len)) {
        // The mask makes the host treat a remote address as local: it ARPs
        // for it directly instead of using its gateway.
        // A router on the segment with proxy ARP (IOS default) answers on
        // the destination's behalf, which hides the mistake.
        proxy = l2.ok ? undefined : proxyArpRouter(model, srcIf, dstIp);
        const evidence = [`${node.name}: ${srcIf.ip} ${srcIf.mask}`, `${dstOwner.node.name}: ${dstOwner.iface.ip} ${dstOwner.iface.mask}`];
        const actual = `${dstOwner.node.name} is actually on ${networkOf(dstOwner.iface.ip, dstOwner.iface.len)}/${dstOwner.iface.len}`;
        if (!proxy && !l2.ok) {
          return fail({
            code: "MASK_MISMATCH", severity: "error", device: node.name, interface: srcIf.name,
            message: `${node.name}'s mask /${srcIf.len} makes it think ${dstIp} is on its own network, so it never uses its gateway and the ARP request for ${dstIp} goes unanswered. ${actual}.`,
            evidence,
            concept: "subnet masks",
          });
        }
        findings.push({
          code: "MASK_MISMATCH", severity: "warning", device: node.name, interface: srcIf.name,
          message: proxy
            ? `${node.name}'s mask /${srcIf.len} is wrong: it thinks ${dstIp} is local and ARPs for it directly. It only works because ${proxy.node.name} ${proxy.iface.name} answers with proxy ARP. ${actual}.`
            : `${node.name}'s mask /${srcIf.len} does not match ${dstOwner.node.name}'s /${dstOwner.iface.len}. ${actual}.`,
          evidence: proxy ? [...evidence, `${proxy.node.name} ${proxy.iface.name}: ip proxy-arp (enabled by default)`] : evidence,
          concept: "subnet masks", direction,
        });
        if (proxy) hops.push(`${proxy.node.name} answers ARP for ${dstIp} (proxy ARP)`);
      }
      if (!proxy) {
        if (!l2.ok) return { ok: false, hops: [...hops, ...l2.hops], findings: [...findings, ...l2.findings.map((f) => ({ ...f, direction }))] };
        return { ok: !findings.some((f) => f.severity === "error"), hops, findings };
      }
    }

    if (proxy) {
      node = proxy.node;
      ingress = proxy.iface;
    } else {
    if (!node.gateway) {
      return fail({
        code: "NO_GATEWAY", severity: "error", device: node.name, interface: srcIf.name,
        message: `${node.name} has no default gateway, so it cannot send anything outside ${networkOf(srcIf.ip, srcIf.len)}/${srcIf.len}.`,
        evidence: [`Default Gateway: 0.0.0.0`, `destination ${dstIp} is outside ${networkOf(srcIf.ip, srcIf.len)}/${srcIf.len}`],
        concept: "default gateway",
      });
    }
    if (!inSubnet(node.gateway, srcIf.ip, srcIf.len)) {
      return fail({
        code: "GATEWAY_NOT_IN_SUBNET", severity: "error", device: node.name, interface: srcIf.name,
        message: `${node.name}'s default gateway ${node.gateway} is not inside its own subnet ${networkOf(srcIf.ip, srcIf.len)}/${srcIf.len}.`,
        evidence: [`IPv4 ${srcIf.ip} ${srcIf.mask}`, `Default Gateway: ${node.gateway}`],
        concept: "default gateway",
      });
    }
    const gw = (owners.get(node.gateway) ?? []).find((o) => isRouting(o.node)) ?? (owners.get(node.gateway) ?? [])[0];
    if (!gw || !isRouting(gw.node)) {
      const candidates = [...model.nodes.values()].flatMap((n) => isRouting(n) ? n.l3.filter((i) => inSubnet(i.ip, srcIf.ip, srcIf.len)) : []);
      return fail({
        code: "WRONG_GATEWAY", severity: "error", device: node.name, interface: srcIf.name,
        message: gw
          ? `${node.name}'s default gateway ${node.gateway} belongs to ${gw.node.name}, which is not a router.`
          : `${node.name}'s default gateway ${node.gateway} does not belong to any router.`,
        evidence: [`Default Gateway: ${node.gateway}`, ...candidates.map((c) => `router interface in this subnet: ${describeIf(c)}`)],
        concept: "default gateway",
      });
    }
    if (gw.iface.len !== srcIf.len) {
      findings.push({
        code: "MASK_MISMATCH", severity: "warning", device: node.name, interface: srcIf.name,
        message: `${node.name} uses /${srcIf.len} but its gateway interface ${gw.node.name} ${gw.iface.name} uses /${gw.iface.len}.`,
        evidence: [`${node.name}: ${srcIf.ip} ${srcIf.mask}`, `${describeIf(gw.iface)}`],
        concept: "subnet masks", direction,
      });
    }
    hops.push(`${node.name} -> gateway ${describeIf(gw.iface)}`);
    const l2 = l2Reach(model, srcIf, gw.iface);
    if (!l2.ok) return { ok: false, hops: [...hops, ...l2.hops], findings: [...findings, ...l2.findings.map((f) => ({ ...f, direction }))] };
    node = gw.node;
    ingress = gw.iface;
    }
  }

  // Router by router.
  for (let n = 0; n < MAX_HOPS; n++) {
    if (visited.has(node.name)) {
      return fail({
        code: "ROUTING_LOOP", severity: "error", device: node.name,
        message: `Packets to ${dstIp} loop back to ${node.name}.`,
        evidence: hops,
        concept: "routing loops",
      });
    }
    visited.add(node.name);

    if (ingress) {
      const acl = checkAcl(node, ingress, "in", srcIp, dstIp, icmp);
      if (acl) return fail(acl);
    }
    if (node.l3.some((i) => i.ip === dstIp)) {
      hops.push(`${node.name} owns ${dstIp}`);
      return { ok: !findings.some((f) => f.severity === "error"), hops, findings };
    }

    // Directly connected?
    const connected = node.l3.find((i) => i.up && inSubnet(dstIp, i.ip, i.len));
    let exit: L3If | undefined;
    let nextHopIp: string | undefined;
    if (connected) {
      exit = connected;
    } else {
      const r = longestMatch(node, dstIp);
      if (!r) {
        const downConnected = node.l3.find((i) => !i.up && inSubnet(dstIp, i.ip, i.len));
        if (downConnected) {
          return fail({
            code: downConnected.adminUp ? "IF_DOWN" : "IF_SHUTDOWN", severity: "error", device: node.name, interface: downConnected.name,
            message: `${node.name} has ${downConnected.name} in ${dstIp}'s subnet, but that interface is ${downConnected.adminUp ? "down" : "shut down"}, so the connected route is missing.`,
            evidence: [`${describeIf(downConnected)}: ${downConnected.adminUp ? "down/down" : "administratively down"}`, `no route to ${dstIp} in show ip route`],
            concept: downConnected.adminUp ? "link status" : "interface shutdown",
          });
        }
        // A configured static route that IOS did not install: its next hop
        // is not on any connected network.
        const inactive = node.staticRoutes.find((s) => {
          const len = maskToLen(s.mask);
          return len !== null && inSubnet(dstIp, s.prefix, len) && !!s.nextHop && !node.l3.some((i) => i.up && inSubnet(s.nextHop!, i.ip, i.len));
        });
        if (inactive) {
          return fail({
            code: "STATIC_ROUTE_INACTIVE", severity: "error", device: node.name,
            message: `${node.name} has "ip route ${inactive.prefix} ${inactive.mask} ${inactive.nextHop}", but ${inactive.nextHop} is not on any of ${node.name}'s connected networks, so the route is never installed.`,
            evidence: [
              `running-config: ip route ${inactive.prefix} ${inactive.mask} ${inactive.nextHop}`,
              `show ip route has no entry for ${inactive.prefix}`,
              ...node.l3.filter((i) => i.up).map((i) => `connected: ${i.name} ${networkOf(i.ip, i.len)}/${i.len}`),
            ],
            concept: "static routes",
          });
        }
        return fail({
          code: "NO_ROUTE", severity: "error", device: node.name,
          message: `${node.name} has no route to ${dstIp} (and no default route), so it drops the packet.`,
          evidence: [`show ip route on ${node.name} has no entry covering ${dstIp}`, ...node.routes.filter((x) => x.code !== "L").map((x) => x.line)],
          concept: direction === "return" ? "return routes" : "routing table",
        });
      }
      nextHopIp = r.nextHop;
      exit = r.exitInterface ? node.l3.find((i) => i.name === r.exitInterface) : undefined;
      if (nextHopIp && !exit) exit = node.l3.find((i) => i.up && inSubnet(nextHopIp!, i.ip, i.len));
      if (!exit) {
        return fail({
          code: "NEXT_HOP_UNREACHABLE", severity: "error", device: node.name,
          message: `${node.name} routes ${dstIp} via ${nextHopIp}, but no up interface of ${node.name} is in that next hop's subnet.`,
          evidence: [r.line],
          concept: "static routes",
        });
      }
      hops.push(`${node.name}: ${r.line}`);
    }

    const acl = checkAcl(node, exit, "out", srcIp, dstIp, icmp);
    if (acl) return fail(acl);

    if (!nextHopIp) {
      // Final segment: deliver to the destination at layer 2.
      if (!dstOwner) {
        return fail({
          code: "DEST_UNKNOWN", severity: "error", device: node.name,
          message: `${node.name} delivers to the ${networkOf(exit.ip, exit.len)}/${exit.len} segment, but no device there has ${dstIp}.`,
          evidence: [`connected: ${describeIf(exit)}`],
          concept: "IP addressing",
        });
      }
      hops.push(`${node.name} ${exit.name} -> ${dstOwner.node.name} (connected)`);
      const l2 = l2Reach(model, exit, dstOwner.iface);
      if (!l2.ok) return { ok: false, hops: [...hops, ...l2.hops], findings: [...findings, ...l2.findings.map((f) => ({ ...f, direction }))] };
      if (dstOwner.node.kind === "host" && dstOwner.iface.len !== exit.len) {
        findings.push({
          code: "MASK_MISMATCH", severity: "warning", device: dstOwner.node.name, interface: dstOwner.iface.name,
          message: `${dstOwner.node.name} uses /${dstOwner.iface.len} on a /${exit.len} segment.`,
          evidence: [describeIf(dstOwner.iface), describeIf(exit)],
          concept: "subnet masks", direction,
        });
      }
      return { ok: !findings.some((f) => f.severity === "error"), hops, findings };
    }

    let nh = (owners.get(nextHopIp) ?? []).find((o) => o.node.name !== node.name);
    if (!nh && nextHopIp === broadcastOf(exit)) {
      // Sent as a layer-2 broadcast, so the router on the link still gets it.
      const peers = [...model.nodes.values()].flatMap((n) =>
        n.name !== node.name && isRouting(n) ? n.l3.filter((i) => i.up && inSubnet(i.ip, exit!.ip, exit!.len)).map((iface) => ({ node: n, iface })) : [],
      );
      findings.push({
        code: "NEXT_HOP_BROADCAST", severity: "warning", device: node.name,
        message: `${node.name}'s route uses ${nextHopIp} as next hop, which is the broadcast address of ${networkOf(exit.ip, exit.len)}/${exit.len}. It only works because the frame is broadcast; the next hop should be the neighbour router's address${peers[0] ? ` (${peers[0].iface.ip})` : ""}.`,
        evidence: [hops[hops.length - 1]],
        concept: "static routes", direction,
      });
      if (peers.length === 1) nh = peers[0];
    }
    if (!nh) {
      return fail({
        code: "WRONG_NEXT_HOP", severity: "error", device: node.name,
        message: `${node.name} sends ${dstIp} to next hop ${nextHopIp}, but no device has that address.`,
        evidence: [hops[hops.length - 1] ?? `next hop ${nextHopIp}`, ...exitNeighbours(ctx, exit)],
        concept: "static routes",
      });
    }
    const l2 = l2Reach(model, exit, nh.iface);
    if (!l2.ok) return { ok: false, hops: [...hops, ...l2.hops], findings: [...findings, ...l2.findings.map((f) => ({ ...f, direction }))] };
    if (!isRouting(nh.node)) {
      return fail({
        code: "WRONG_NEXT_HOP", severity: "error", device: node.name,
        message: `${node.name} sends ${dstIp} to ${nextHopIp}, which is ${nh.node.name}, not a router.`,
        evidence: [hops[hops.length - 1]],
        concept: "static routes",
      });
    }
    node = nh.node;
    ingress = nh.iface;
  }
  return fail({ code: "TOO_MANY_HOPS", severity: "error", device: node.name, message: `More than ${MAX_HOPS} hops to ${dstIp}.`, evidence: hops, concept: "routing loops" });
}

/** A router interface on the host's segment that would answer ARP for dstIp. */
function proxyArpRouter(model: Model, srcIf: L3If, dstIp: string): Owner | undefined {
  for (const node of model.nodes.values()) {
    if (!isRouting(node)) continue;
    for (const iface of node.l3) {
      if (!iface.up || !iface.proxyArp || !inSubnet(srcIf.ip, iface.ip, iface.len)) continue;
      if (inSubnet(dstIp, iface.ip, iface.len)) continue; // IOS only proxies for other networks
      const hasRoute = node.l3.some((i) => i.up && inSubnet(dstIp, i.ip, i.len)) || !!longestMatch(node, dstIp);
      if (hasRoute && l2Reach(model, srcIf, iface).ok) return { node, iface };
    }
  }
  return undefined;
}

function broadcastOf(i: L3If): string {
  return intToIp((ipToInt(i.ip)! | ~lenToMaskInt(i.len)) >>> 0);
}

function longestMatch(node: Node, ip: string) {
  let best: Node["routes"][number] | undefined;
  for (const r of node.routes) {
    if (r.code === "L") continue;
    if (!inSubnet(ip, r.prefix, r.len)) continue;
    if (!best || r.len > best.len) best = r;
  }
  return best;
}

function exitNeighbours(ctx: Ctx, exit: L3If): string[] {
  const out: string[] = [];
  for (const [ip, list] of ctx.owners) {
    for (const o of list) {
      if (o.node.name !== exit.device && isRouting(o.node) && inSubnet(ip, exit.ip, exit.len)) out.push(`router on that segment: ${describeIf(o.iface)}`);
    }
  }
  return out;
}

// ------------------------------------------------------------ whole-network checks

function duplicateIps(ctx: Ctx): Finding[] {
  const out: Finding[] = [];
  for (const [ip, list] of ctx.owners) {
    if (list.length < 2) continue;
    out.push({
      code: "DUPLICATE_IP",
      severity: "error",
      device: list[0].node.name,
      message: `${ip} is configured on more than one device.`,
      evidence: list.map((o) => describeIf(o.iface)),
      concept: "IP addressing",
    });
  }
  return out;
}

// ------------------------------------------------------------ entry point

export function resolveDestination(model: Model, dst: string): { ip?: string; device?: Node } {
  if (ipToInt(dst) !== null) {
    const owner = ipOwners(model).get(dst)?.[0];
    return { ip: dst, device: owner?.node };
  }
  const node = model.nodes.get(dst);
  if (!node) return {};
  const iface = node.l3.find((i) => i.up) ?? node.l3[0];
  return { ip: iface?.ip, device: node };
}

export function diagnose(model: Model, source: string, destination: string): Diagnosis {
  const ctx: Ctx = { model, owners: ipOwners(model) };
  const other = duplicateIps(ctx);
  const src = model.nodes.get(source);
  const empty = (f: Finding): Diagnosis => ({
    source, destination, predicted: "unreachable", forward: { ok: false, hops: [], findings: [f] }, other,
  });
  if (!src) return empty({ code: "UNKNOWN_DEVICE", severity: "error", device: source, message: `No device named ${source}.`, evidence: [], concept: "" });

  const dst = resolveDestination(model, destination);
  if (!dst.ip) {
    return empty({
      code: dst.device ? "HOST_NO_IP" : "UNKNOWN_DEVICE", severity: "error", device: destination,
      message: dst.device ? `${destination} has no IPv4 address to reach.` : `No device or address ${destination}.`,
      evidence: [], concept: "IP addressing",
    });
  }

  let srcIf: L3If | undefined;
  const pre: Finding[] = [];
  if (src.kind === "host") {
    const h = hostChecks(src, "forward");
    pre.push(...h.findings);
    srcIf = h.iface;
  } else {
    srcIf = src.l3.find((i) => i.up) ?? src.l3[0];
  }
  if (!srcIf || pre.some((f) => f.code === "HOST_NO_IP" || f.code === "NOT_CABLED")) {
    return { source, destination, destinationIp: dst.ip, predicted: "unreachable", forward: { ok: false, hops: [], findings: pre }, other };
  }

  const forward = route(ctx, srcIf, srcIf.ip, dst.ip, "forward");
  forward.findings.unshift(...pre);
  forward.ok &&= !pre.some((f) => f.severity === "error");

  let back: PathResult | undefined;
  if (forward.ok && dst.device) {
    const owner = ctx.owners.get(dst.ip)?.find((o) => o.node.name === dst.device!.name);
    if (owner) {
      const start = dst.device.kind === "host" ? hostChecks(dst.device, "return") : { iface: owner.iface, findings: [] };
      if (start.iface) {
        back = route(ctx, owner.iface, dst.ip, srcIf.ip, "return");
        back.findings.unshift(...start.findings);
      }
    }
  }

  const ok = forward.ok && (back ? back.ok : true);
  return {
    source,
    destination,
    destinationIp: dst.ip,
    predicted: ok ? "reachable" : "unreachable",
    forward,
    return: back,
    other: other.filter((f) => !forward.findings.some((x) => x.code === f.code)),
  };
}

