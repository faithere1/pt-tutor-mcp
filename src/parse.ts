// Parsers for the Packet Tracer command output the diagnosis engine needs.
// Fixtures captured from a live Packet Tracer live in test/fixtures.

import { canonicalPort } from "./net.js";

// ------------------------------------------------------------ running-config

export interface ConfigInterface {
  name: string;
  ip?: string;
  mask?: string;
  shutdown: boolean;
  /** "encapsulation dot1Q <vlan>" on a router subinterface. */
  dot1q?: number;
  dot1qNative?: boolean;
  accessGroups: { acl: string; dir: "in" | "out" }[];
  proxyArp: boolean;
  switchport?: { mode?: string; accessVlan?: number; nativeVlan?: number; allowed?: string };
}

export interface StaticRoute {
  prefix: string;
  mask: string;
  nextHop?: string;
  exitInterface?: string;
}

export interface RunningConfig {
  hostname?: string;
  interfaces: ConfigInterface[];
  staticRoutes: StaticRoute[];
  /** ACL name/number -> its entry lines, in order ("permit host 1.2.3.4", ...). */
  acls: Record<string, { kind: "standard" | "extended"; entries: string[] }>;
  ipRouting?: boolean;
}

export function parseRunningConfig(text: string): RunningConfig {
  const cfg: RunningConfig = { interfaces: [], staticRoutes: [], acls: {} };
  let iface: ConfigInterface | null = null;
  let namedAcl: string | null = null;

  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    const indented = /^\s/.test(line);
    const t = line.trim();
    if (!indented) {
      iface = null;
      namedAcl = null;
    }
    if (!t || t === "!") continue;

    let m: RegExpExecArray | null;
    if (!indented) {
      if ((m = /^hostname (\S+)/.exec(t))) cfg.hostname = m[1];
      else if ((m = /^interface (\S+)/.exec(t))) {
        iface = { name: canonicalPort(m[1]), shutdown: false, accessGroups: [], proxyArp: true };
        cfg.interfaces.push(iface);
      } else if ((m = /^ip route (\S+) (\S+) (\S+)(?: (\S+))?/.exec(t))) {
        const isIp = /^\d+\.\d+\.\d+\.\d+$/;
        const route: StaticRoute = { prefix: m[1], mask: m[2] };
        if (isIp.test(m[3])) route.nextHop = m[3];
        else {
          route.exitInterface = canonicalPort(m[3]);
          if (m[4] && isIp.test(m[4])) route.nextHop = m[4];
        }
        cfg.staticRoutes.push(route);
      } else if ((m = /^access-list (\d+) (.+)$/.exec(t))) {
        const n = Number(m[1]);
        const kind = n < 100 || (n >= 1300 && n < 2000) ? "standard" : "extended";
        const acl = (cfg.acls[m[1]] ??= { kind, entries: [] });
        if (!m[2].startsWith("remark")) acl.entries.push(m[2].trim());
      } else if ((m = /^ip access-list (standard|extended) (\S+)/.exec(t))) {
        namedAcl = m[2];
        cfg.acls[namedAcl] ??= { kind: m[1] as "standard" | "extended", entries: [] };
      } else if (t === "ip routing") cfg.ipRouting = true;
      else if (t === "no ip routing") cfg.ipRouting = false;
      continue;
    }

    if (namedAcl) {
      const entry = t.replace(/^\d+\s+/, "");
      if (!entry.startsWith("remark")) cfg.acls[namedAcl].entries.push(entry);
      continue;
    }
    if (!iface) continue;
    if ((m = /^ip address (\S+) (\S+)/.exec(t))) {
      iface.ip = m[1];
      iface.mask = m[2];
    } else if (t === "shutdown") iface.shutdown = true;
    else if (t === "no ip proxy-arp") iface.proxyArp = false;
    else if ((m = /^encapsulation dot1Q (\d+)( native)?/i.exec(t))) {
      iface.dot1q = Number(m[1]);
      iface.dot1qNative = !!m[2];
    } else if ((m = /^ip access-group (\S+) (in|out)/.exec(t))) {
      iface.accessGroups.push({ acl: m[1], dir: m[2] as "in" | "out" });
    } else if ((m = /^switchport mode (\S+)/.exec(t))) {
      (iface.switchport ??= {}).mode = m[1];
    } else if ((m = /^switchport access vlan (\d+)/.exec(t))) {
      (iface.switchport ??= {}).accessVlan = Number(m[1]);
    } else if ((m = /^switchport trunk native vlan (\d+)/.exec(t))) {
      (iface.switchport ??= {}).nativeVlan = Number(m[1]);
    } else if ((m = /^switchport trunk allowed vlan (.+)$/.exec(t))) {
      (iface.switchport ??= {}).allowed = m[1];
    }
  }
  return cfg;
}

// ------------------------------------------------------------ show ip route

export interface Route {
  code: string;
  prefix: string;
  len: number;
  nextHop?: string;
  exitInterface?: string;
  /** The full line, for evidence. */
  line: string;
}

export interface RouteTable {
  routes: Route[];
  gatewayOfLastResort?: string;
}

export function parseIpRoute(text: string): RouteTable {
  const table: RouteTable = { routes: [] };
  // Classful parent lines ("10.0.0.0/8 is variably subnetted") carry no route.
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    let m: RegExpExecArray | null;
    if ((m = /Gateway of last resort is (\S+) to network/.exec(line))) {
      table.gatewayOfLastResort = m[1];
      continue;
    }
    // "C    10.0.0.0/30 is directly connected, GigabitEthernet0/1"
    // "S    192.168.20.0/24 [1/0] via 10.0.0.2"
    // "O    1.1.1.0/24 [110/2] via 10.0.0.2, 00:00:12, GigabitEthernet0/1"
    // "S*   0.0.0.0/0 [1/0] via 10.0.0.2"
    m = /^([A-Za-z][A-Za-z0-9* ]{0,5}?)\s+(\d+\.\d+\.\d+\.\d+)(?:\/(\d+))?\s+(.*)$/.exec(line);
    if (m && !/subnetted/.test(m[4])) {
      table.routes.push(makeRoute(m[1].replace(/\s+/g, "").replace("*", ""), m[2], m[3], m[4], line));
      continue;
    }
    // Continuation line for equal-cost paths: "                [110/2] via 10.0.0.6, ..."
    if ((m = /^\s+\[\d+\/\d+\] via (\S+?),?(?:\s|$)/.exec(line)) && table.routes.length) {
      const prev = table.routes[table.routes.length - 1];
      table.routes.push({ ...prev, nextHop: m[1], line: line.trim() });
    }
  }
  return table;
}

function makeRoute(code: string, prefix: string, len: string | undefined, rest: string, line: string): Route {
  const route: Route = { code, prefix, len: len ? Number(len) : classfulLen(prefix), line: line.trim() };
  let m: RegExpExecArray | null;
  if ((m = /is directly connected, (\S+)/.exec(rest))) route.exitInterface = canonicalPort(m[1]);
  if ((m = /via (\d+\.\d+\.\d+\.\d+)/.exec(rest))) route.nextHop = m[1];
  if ((m = /, ((?:[A-Za-z-]+)[\d/.:]+)\s*$/.exec(rest)) && !route.exitInterface) route.exitInterface = canonicalPort(m[1]);
  return route;
}

function classfulLen(ip: string): number {
  const first = Number(ip.split(".")[0]);
  return first < 128 ? 8 : first < 192 ? 16 : 24;
}

// ------------------------------------------------------------ switches

/** "show vlan brief" -> port -> access VLAN. */
export function parseVlanBrief(text: string): { ports: Record<string, number>; vlans: Record<number, string> } {
  const ports: Record<string, number> = {};
  const vlans: Record<number, string> = {};
  let current: number | null = null;
  for (const line of text.split("\n")) {
    let m = /^(\d+)\s+(\S+)\s+(\S+)\s*(.*)$/.exec(line);
    if (m) {
      current = Number(m[1]);
      vlans[current] = m[2];
      addPorts(m[4]);
      continue;
    }
    m = /^\s{20,}(\S.*)$/.exec(line);
    if (m && current !== null) addPorts(m[1]);
  }
  function addPorts(list: string) {
    for (const p of list.split(",")) if (p.trim()) ports[canonicalPort(p.trim())] = current!;
  }
  return { ports, vlans };
}

export interface TrunkPort {
  port: string;
  mode?: string;
  status?: string;
  nativeVlan: number;
  allowed: string;
  active?: string;
}

/** "show interfaces trunk" -> operational trunks. */
export function parseInterfacesTrunk(text: string): TrunkPort[] {
  const trunks = new Map<string, TrunkPort>();
  let section = 0;
  for (const line of text.split("\n")) {
    if (/^Port\s+Mode/.test(line)) { section = 1; continue; }
    if (/^Port\s+Vlans allowed on trunk/.test(line)) { section = 2; continue; }
    if (/^Port\s+Vlans allowed and active/.test(line)) { section = 3; continue; }
    if (/^Port\s+Vlans in spanning tree/.test(line)) { section = 4; continue; }
    const m = /^(\S+)\s+(.*)$/.exec(line.trim());
    if (!m || !section) continue;
    const port = canonicalPort(m[1]);
    if (section === 1) {
      const f = m[2].split(/\s+/);
      trunks.set(port, { port, mode: f[0], status: f[2], nativeVlan: Number(f[3] ?? 1), allowed: "1-4094" });
    } else if (trunks.has(port)) {
      const t = trunks.get(port)!;
      if (section === 2) t.allowed = m[2].trim();
      if (section === 3) t.active = m[2].trim();
    }
  }
  return [...trunks.values()];
}

/** Expands "1,10,20-22" (or "all"/"none") into a membership test. */
export function vlanListHas(list: string, vlan: number): boolean {
  const s = list.trim().toLowerCase();
  if (s === "all" || s === "") return true;
  if (s === "none") return false;
  return s.split(",").some((part) => {
    const [a, b] = part.split("-").map((x) => Number(x.trim()));
    return b === undefined ? vlan === a : vlan >= a && vlan <= b;
  });
}

// ------------------------------------------------------------ end devices

export interface HostIpConfig {
  connection: string;
  ip?: string;
  mask?: string;
  gateway?: string;
  dns?: string;
}

/** PC "ipconfig /all". Returns one entry per connection, default port first. */
export function parseIpconfig(text: string): HostIpConfig[] {
  const out: HostIpConfig[] = [];
  let cur: HostIpConfig | null = null;
  let last = "";
  for (const line of text.split("\n")) {
    let m: RegExpExecArray | null;
    if ((m = /^(\S.*?) Connection:/.exec(line))) {
      cur = { connection: m[1] };
      out.push(cur);
      last = "";
      continue;
    }
    if (!cur) continue;
    if ((m = /^\s+([A-Za-z][A-Za-z0-9 -]*?)\.{2,}\s*:\s*(.*)$/.exec(line))) {
      last = m[1];
      const v = m[2].trim();
      if (last === "IPv4 Address" || last === "IP Address") cur.ip = v;
      else if (last === "Subnet Mask") cur.mask = v;
      else if (last === "Default Gateway" && /^\d+\.\d+\.\d+\.\d+$/.test(v)) cur.gateway = v;
      else if (last === "DNS Servers" && /^\d+\.\d+\.\d+\.\d+$/.test(v)) cur.dns = v;
      continue;
    }
    // IPv4 values for gateway/DNS follow the IPv6 value on an indented line.
    if ((m = /^\s+(\d+\.\d+\.\d+\.\d+)\s*$/.exec(line))) {
      if (last === "Default Gateway") cur.gateway = m[1];
      if (last === "DNS Servers") cur.dns = m[1];
    }
  }
  return out;
}

// ------------------------------------------------------------ ping

export function parsePing(text: string): { sent: number; received: number } | null {
  let m = /Sent = (\d+), Received = (\d+)/.exec(text);
  if (m) return { sent: Number(m[1]), received: Number(m[2]) };
  m = /Success rate is \d+ percent \((\d+)\/(\d+)\)/.exec(text);
  if (m) return { sent: Number(m[2]), received: Number(m[1]) };
  return null;
}
