// Which terminal commands the read-only tools may send. Anything that could
// change device state is refused before it reaches Packet Tracer.

export type Terminal = "ios" | "host";

const IOS_ALLOWED = [
  /^sh(o(w)?)?\s+\S/i, // show ... (and its abbreviations)
  /^ping(\s+\S+){1,3}$/i,
  /^trace(route)?\s+\S+$/i,
];

const HOST_ALLOWED = [
  /^ipconfig(\s+\/all)?$/i,
  /^ipv6config(\s+\/all)?$/i,
  /^ping(\s+-[a-z]+(\s+\d+)?)*\s+\S+$/i,
  /^tracert\s+\S+$/i,
  /^arp\s+-a$/i,
  /^nslookup\s+\S+$/i,
  /^netstat(\s+-[a-z]+)?$/i,
];

// Show commands that could stall the terminal or are not reads.
const IOS_DENIED = [/^sh(o(w)?)?\s+tech/i, /\|\s*(redirect|tee|append)\b/i];

export function checkCommand(command: string, terminal: Terminal): { ok: true; command: string } | { ok: false; reason: string } {
  const cmd = command.trim().replace(/\s+/g, " ");
  if (!cmd) return { ok: false, reason: "empty command" };
  if (/[\r\n;]/.test(command)) return { ok: false, reason: "one command at a time; newlines and ';' are not allowed" };

  if (terminal === "ios") {
    if (IOS_DENIED.some((r) => r.test(cmd))) return { ok: false, reason: `'${cmd}' is not allowed` };
    if (IOS_ALLOWED.some((r) => r.test(cmd))) return { ok: true, command: cmd };
    return { ok: false, reason: `'${cmd}' is not a read-only command. Allowed on IOS devices: show ..., ping, traceroute` };
  }
  if (HOST_ALLOWED.some((r) => r.test(cmd))) return { ok: true, command: cmd };
  return { ok: false, reason: `'${cmd}' is not allowed. Allowed on end devices: ipconfig, ping, tracert, arp -a, nslookup, netstat` };
}

const IOS_TYPES = new Set(["Router", "Switch", "MultiLayerSwitch", "Switch3650", "ASA"]);

export function terminalFor(deviceType: string): Terminal {
  return IOS_TYPES.has(deviceType) ? "ios" : "host";
}
