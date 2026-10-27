// IPv4 and interface-name helpers.

export function ipToInt(ip: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip.trim());
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

export function intToIp(n: number): string {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}

export function maskToLen(mask: string): number | null {
  const n = ipToInt(mask);
  if (n === null) return null;
  let len = 0;
  while (len < 32 && (n & (0x80000000 >>> len)) !== 0) len++;
  // A valid mask is all ones followed by all zeros.
  return lenToMaskInt(len) === n ? len : null;
}

export function lenToMaskInt(len: number): number {
  return len === 0 ? 0 : (0xffffffff << (32 - len)) >>> 0;
}

export function lenToMask(len: number): string {
  return intToIp(lenToMaskInt(len));
}

export function networkOf(ip: string, len: number): string {
  return intToIp((ipToInt(ip)! & lenToMaskInt(len)) >>> 0);
}

export function inSubnet(ip: string, net: string, len: number): boolean {
  const a = ipToInt(ip), b = ipToInt(net);
  if (a === null || b === null) return false;
  const m = lenToMaskInt(len);
  return ((a & m) >>> 0) === ((b & m) >>> 0);
}

export function isUsableIp(ip: string | undefined): ip is string {
  return !!ip && ip !== "0.0.0.0" && ipToInt(ip) !== null;
}

export function isApipa(ip: string): boolean {
  return ip.startsWith("169.254.");
}

/** Matches an IOS wildcard (e.g. 0.0.0.255) against an address. */
export function wildcardMatch(ip: string, base: string, wildcard: string): boolean {
  const a = ipToInt(ip), b = ipToInt(base), w = ipToInt(wildcard);
  if (a === null || b === null || w === null) return false;
  return ((a & ~w) >>> 0) === ((b & ~w) >>> 0);
}

const PORT_PREFIXES: [RegExp, string][] = [
  [/^(fa|fastethernet)/i, "FastEthernet"],
  [/^(gi|gig|gigabitethernet)/i, "GigabitEthernet"],
  [/^(te|tengigabitethernet)/i, "TenGigabitEthernet"],
  [/^(se|serial)/i, "Serial"],
  [/^(et|eth|ethernet)/i, "Ethernet"],
  [/^(vl|vlan)/i, "Vlan"],
  [/^(lo|loopback)/i, "Loopback"],
  [/^(po|port-channel)/i, "Port-channel"],
];

/** "Gig0/1", "gi0/1" and "GigabitEthernet0/1" all become "GigabitEthernet0/1". */
export function canonicalPort(name: string): string {
  const s = name.trim();
  const m = /^([A-Za-z-]+)\s*([\d/.:]+)$/.exec(s);
  if (!m) return s;
  for (const [re, full] of PORT_PREFIXES) {
    if (re.test(m[1])) return full + m[2];
  }
  return s;
}
