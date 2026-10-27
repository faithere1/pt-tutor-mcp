// Assessment guard. In hint-only mode diagnose hides what is wrong and only
// says where to look, hints stop at level 2, and the tutor won't read device
// configuration for the student. The mode is on while a graded activity (.pka)
// is open, or always when an instructor sets PT_TUTOR_MODE=hint-only. Pure:
// the server decides when the guard is on.

import type { Diagnosis, Finding, PathResult } from "./diagnose.js";

export const ASSESSMENT_MAX_HINT_LEVEL = 2;

export interface ModeSetting {
  /** Hint-only for every file, not just graded activities. */
  forced: boolean;
  warning?: string;
}

/** Reads PT_TUTOR_MODE. An unrecognised value fails closed: a typo must not switch the guard off. */
export function modeSetting(value: string | undefined): ModeSetting {
  const v = value?.trim().toLowerCase();
  if (!v || v === "auto") return { forced: false };
  if (v === "hint-only") return { forced: true };
  return {
    forced: true,
    warning: `pt-tutor: PT_TUTOR_MODE="${value}" is not "auto" or "hint-only"; running in hint-only mode.`,
  };
}

/** Broad area of a finding: enough to point the student at a layer, not at the fault. */
const AREAS: Record<string, string> = {
  NOT_CABLED: "physical", LINK_DOWN: "physical", DEVICE_OFF: "physical", IF_SHUTDOWN: "physical", IF_DOWN: "physical",
  HOST_NO_IP: "addressing", DHCP_FAILED: "addressing", NO_GATEWAY: "addressing", WRONG_GATEWAY: "addressing",
  GATEWAY_NOT_IN_SUBNET: "addressing", MASK_MISMATCH: "addressing", DUPLICATE_IP: "addressing",
  NO_IP_ON_INTERFACE: "addressing", DEST_UNKNOWN: "addressing",
  VLAN_MISMATCH: "switching", VLAN_NOT_ALLOWED: "switching", TRUNK_MISMATCH: "switching",
  NO_SUBINTERFACE: "switching", L2_UNREACHABLE: "switching",
  NO_ROUTE: "routing", STATIC_ROUTE_INACTIVE: "routing", WRONG_NEXT_HOP: "routing", NEXT_HOP_UNREACHABLE: "routing",
  NEXT_HOP_BROADCAST: "routing", ROUTING_LOOP: "routing", TOO_MANY_HOPS: "routing",
  ACL_DENY: "filtering",
};

export function areaOf(code: string): string {
  return AREAS[code] ?? "general";
}

export interface RedactedFinding {
  /** Pass to tutor_hint to get a hint for this finding. */
  ref: string;
  area: string;
  severity: Finding["severity"];
  device: string;
  interface?: string;
  direction?: Finding["direction"];
}

export interface RedactedDiagnosis {
  assessment: true;
  source: string;
  destination: string;
  destinationIp?: string;
  predicted: Diagnosis["predicted"];
  forward: { ok: boolean; findings: RedactedFinding[] };
  return?: { ok: boolean; findings: RedactedFinding[] };
  other: RedactedFinding[];
}

/** Strips codes, messages, evidence, concepts and hops; `ref` stores each finding and returns its handle. */
export function redactDiagnosis(d: Diagnosis, ref: (f: Finding) => string): RedactedDiagnosis {
  const one = (f: Finding): RedactedFinding => ({
    ref: ref(f),
    area: areaOf(f.code),
    severity: f.severity,
    device: f.device,
    ...(f.interface && { interface: f.interface }),
    ...(f.direction && { direction: f.direction }),
  });
  const path = (p: PathResult) => ({ ok: p.ok, findings: p.findings.map(one) });
  return {
    assessment: true,
    source: d.source,
    destination: d.destination,
    ...(d.destinationIp && { destinationIp: d.destinationIp }),
    predicted: d.predicted,
    forward: path(d.forward),
    ...(d.return && { return: path(d.return) }),
    other: d.other.map(one),
  };
}

// Commands that show the configuration itself. During an assessment the student
// reads these on their own terminal; the tutor doesn't read them for them.
const CONFIG_COMMANDS = /^sh(o(w)?)?\s+(ru|star|conf|archive)/i;

export function checkAssessmentCommand(command: string): { ok: true } | { ok: false; reason: string } {
  if (CONFIG_COMMANDS.test(command.trim())) {
    return {
      ok: false,
      reason:
        "The tutor is in hint-only mode, so it won't read device configuration. Ask the student to look at it on " +
        "their own terminal, or use status commands such as 'show ip interface brief' or 'show ip route'.",
    };
  }
  return { ok: true };
}
