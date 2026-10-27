// Builds a network model from a raw snapshot (bridge API data + CLI output).
// Pure: the same raw snapshot always gives the same model, which is what lets
// the diagnosis engine run against saved fixtures in tests.

import { canonicalPort, isUsableIp, maskToLen } from "./net.js";
import {
  parseInterfacesTrunk,
  parseIpconfig,
  parseIpRoute,
  parseRunningConfig,
  parseVlanBrief,
  type Route,
  type StaticRoute,
  type TrunkPort,
} from "./parse.js";

export interface RawPort {
  name: string;
  up?: boolean;
  protocolUp?: boolean;
  adminUp?: boolean;
  ip?: string;
  mask?: string;
  dhcp?: boolean;
  connectedTo?: { device: string; port: string };
}

export interface RawDevice {
  name: string;
  type: string;
  model: string;
  power: boolean;
  ports: RawPort[];
}

export interface RawSnapshot {
  devices: Record<string, RawDevice>;
  /** device -> command -> output */
  cli: Record<string, Record<string, string>>;
}

export type Kind = "router" | "switch" | "l3switch" | "host" | "hub" | "other";

export interface PortState {
  name: string;
  adminUp: boolean;
  up: boolean;
  peer?: { device: string; port: string };
}

export interface L3If {
  device: string;
  /** Interface name: "GigabitEthernet0/0.10", "Vlan10", or a host's "FastEthernet0". */
  name: string;
  /** Physical port carrying it; undefined for SVIs. */
  port?: string;
  ip: string;
  mask: string;
  len: number;
  /** 802.1Q tag for router subinterfaces, VLAN for SVIs. */
  vlan?: number;
  nativeTag?: boolean;
  adminUp: boolean;
  up: boolean;
  accessGroups: { acl: string; dir: "in" | "out" }[];
  proxyArp: boolean;
}

export interface Node {
  name: string;
  type: string;
  kind: Kind;
  power: boolean;
  ports: Map<string, PortState>;
  l3: L3If[];
  routes: Route[];
  /** "ip route" lines from the config, installed or not. */
  staticRoutes: StaticRoute[];
  routingEnabled: boolean;
  gateway?: string;
  dhcp?: boolean;
  access: Map<string, number>;
  trunks: Map<string, TrunkPort>;
  acls: Record<string, { kind: "standard" | "extended"; entries: string[] }>;
  /** Commands whose output was available, for evidence. */
  evidence: Record<string, string>;
}

export interface Model {
  nodes: Map<string, Node>;
}

const KINDS: Record<string, Kind> = {
  Router: "router",
  ASA: "router",
  Switch: "switch",
  MultiLayerSwitch: "l3switch",
  Switch3650: "l3switch",
  Hub: "hub",
  Repeater: "hub",
  PC: "host",
  Server: "host",
  Laptop: "host",
  Printer: "host",
  TabletPC: "host",
  Pda: "host",
  WiredEndDevice: "host",
  WirelessEndDevice: "host",
  IpPhone: "host",
};

export function kindOf(type: string): Kind {
  return KINDS[type] ?? "other";
}

/** Commands the model needs from each kind of device. */
export function commandsFor(type: string): string[] {
  switch (kindOf(type)) {
    case "router":
      return ["show running-config", "show ip route"];
    case "switch":
      return ["show running-config", "show vlan brief", "show interfaces trunk"];
    case "l3switch":
      return ["show running-config", "show ip route", "show vlan brief", "show interfaces trunk"];
    case "host":
      return ["ipconfig /all"];
    default:
      return [];
  }
}

export function buildModel(raw: RawSnapshot): Model {
  const nodes = new Map<string, Node>();
  for (const dev of Object.values(raw.devices)) nodes.set(dev.name, buildNode(dev, raw.cli[dev.name] ?? {}));
  return { nodes };
}

function buildNode(dev: RawDevice, cli: Record<string, string>): Node {
  const kind = kindOf(dev.type);
  const node: Node = {
    name: dev.name,
    type: dev.type,
    kind,
    power: dev.power,
    ports: new Map(),
    l3: [],
    routes: [],
    staticRoutes: [],
    routingEnabled: kind === "router",
    access: new Map(),
    trunks: new Map(),
    acls: {},
    evidence: cli,
  };

  for (const p of dev.ports) {
    node.ports.set(p.name, {
      name: p.name,
      adminUp: p.adminUp ?? true,
      up: !!(p.up && p.protocolUp) && dev.power,
      peer: p.connectedTo,
    });
  }

  if (kind === "host") {
    const ipconfig = cli["ipconfig /all"] ? parseIpconfig(cli["ipconfig /all"]) : [];
    for (const p of dev.ports) {
      if (!isUsableIp(p.ip) || !p.mask) continue;
      node.l3.push({
        device: dev.name,
        name: p.name,
        port: p.name,
        ip: p.ip,
        mask: p.mask,
        len: maskToLen(p.mask) ?? 0,
        adminUp: p.adminUp ?? true,
        up: node.ports.get(p.name)!.up,
        accessGroups: [],
        proxyArp: false,
      });
      node.dhcp ||= !!p.dhcp;
    }
    // ipconfig lists the default port first; its gateway is the one in use.
    const main = ipconfig.find((c) => isUsableIp(c.ip)) ?? ipconfig[0];
    if (main && isUsableIp(main.gateway)) node.gateway = main.gateway;
    if (!node.l3.length) node.dhcp = dev.ports.some((p) => p.dhcp);
    return node;
  }

  if (cli["show running-config"]) {
    const cfg = parseRunningConfig(cli["show running-config"]);
    node.acls = cfg.acls;
    node.staticRoutes = cfg.staticRoutes;
    if (kind === "l3switch") node.routingEnabled = !!cfg.ipRouting;
    for (const i of cfg.interfaces) {
      if (i.switchport && kind !== "router") continue;
      if (!i.ip || !i.mask) continue;
      // On a plain L2 switch this is the management SVI: an address that can
      // be pinged, but not a gateway (the engine checks routingEnabled).
      const isSvi = i.name.startsWith("Vlan");
      const parent = isSvi ? undefined : i.name.split(".")[0];
      node.l3.push(l3FromConfig(dev.name, i, parent, node, isSvi));
    }
  }
  if (cli["show ip route"]) node.routes = parseIpRoute(cli["show ip route"]).routes;
  if (cli["show vlan brief"]) {
    for (const [port, vlan] of Object.entries(parseVlanBrief(cli["show vlan brief"]).ports)) node.access.set(port, vlan);
  }
  if (cli["show interfaces trunk"]) {
    for (const t of parseInterfacesTrunk(cli["show interfaces trunk"])) {
      node.trunks.set(t.port, t);
      node.access.delete(t.port);
    }
  }
  return node;
}

function l3FromConfig(
  device: string,
  i: ReturnType<typeof parseRunningConfig>["interfaces"][number],
  parent: string | undefined,
  node: Node,
  isSvi: boolean,
): L3If {
  const parentPort = parent ? node.ports.get(canonicalPort(parent)) : undefined;
  const adminUp = !i.shutdown && (parentPort ? parentPort.adminUp : true);
  return {
    device,
    name: i.name,
    port: parentPort?.name,
    ip: i.ip!,
    mask: i.mask!,
    len: maskToLen(i.mask!) ?? 0,
    vlan: isSvi ? Number(i.name.replace(/^Vlan/, "")) : i.dot1q,
    nativeTag: i.dot1qNative,
    adminUp,
    up: adminUp && (parentPort ? parentPort.up : true),
    accessGroups: i.accessGroups,
    proxyArp: i.proxyArp,
  };
}
