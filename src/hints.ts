// The hint ladder: three levels of help for each finding code the diagnosis
// engine produces. Level 1 nudges towards the area of the problem without
// naming the device. Level 2 names the device and a read-only command to look
// at. Level 3 explains the concept. No level gives the configuration that
// fixes the fault: the student works that out. Pure: no I/O.

export type HintLevel = 1 | 2 | 3;

export interface HintContext {
  device?: string;
  interface?: string;
}

export interface Hint {
  code: string;
  level: HintLevel;
  hint: string;
  concept: string;
  /** True when a more detailed level exists. */
  more: boolean;
}

interface Ladder {
  concept: string;
  levels: [string, string, string];
}

// Placeholders: {device}, {interface}, and {where} ("R1 Gig0/1", or just "R1"
// when the finding has no interface).
const LADDERS: Record<string, Ladder> = {
  // ---------------------------------------------------- end hosts
  HOST_NO_IP: {
    concept: "IP addressing",
    levels: [
      "Before a device can talk to anything, what does it need to have? Check whether every device on the path has one.",
      "Look at {device} with 'ipconfig /all'. What IPv4 address does it show?",
      "Every host needs an IPv4 address and a subnet mask to send IP traffic, set either statically or by DHCP. " +
        "Without an address the host has nothing to put in the source field of a packet, so it cannot send at all.",
    ],
  },
  DHCP_FAILED: {
    concept: "DHCP",
    levels: [
      "One of the hosts was supposed to get its address automatically. Did it actually get one?",
      "Run 'ipconfig /all' on {device}. Is the address from your network, or does it start with 169.254?",
      "A DHCP client broadcasts a Discover and waits for an Offer. If no server answers, Windows-style hosts give " +
        "themselves a 169.254.x.x (APIPA) address that only works on the local link. So check that a DHCP server is " +
        "reachable from that segment: a pool for the right subnet, and an ip helper-address on the router if the " +
        "server is on another network.",
    ],
  },
  NO_GATEWAY: {
    concept: "default gateway",
    levels: [
      "Traffic inside the local network is fine, but how does a host send a packet to a different network?",
      "Check {device} with 'ipconfig /all'. What does the Default Gateway line say?",
      "A host only delivers directly to addresses inside its own subnet. For everything else it sends the frame to " +
        "its default gateway, the router interface on its LAN. With no gateway set, the host has nowhere to send " +
        "off-subnet packets and drops them.",
    ],
  },
  WRONG_GATEWAY: {
    concept: "default gateway",
    levels: [
      "Local traffic works but remote traffic doesn't. Which address does a host hand remote packets to, and is it the right one?",
      "Compare the Default Gateway in 'ipconfig /all' on {device} with the IP addresses on the router interface " +
        "for that LAN ('show ip interface brief' on the router).",
      "The default gateway must be the IP address of the router interface on the host's own LAN. If it points to an " +
        "address that isn't a router (or isn't any device), ARP for it fails or the packet goes to a device that " +
        "won't forward it.",
    ],
  },
  GATEWAY_NOT_IN_SUBNET: {
    concept: "default gateway",
    levels: [
      "A host can only reach its gateway directly if the gateway is local. Is it?",
      "Look at the IP address, subnet mask and default gateway in 'ipconfig /all' on {device}. Is the gateway inside " +
        "the subnet that address and mask describe?",
      "The host uses its own address and mask to decide what is local. A gateway outside that range is not local, " +
        "so the host can't ARP for it, and it won't use it. The gateway and the host must share a subnet.",
    ],
  },
  MASK_MISMATCH: {
    concept: "subnet masks",
    levels: [
      "Two devices that should be on the same network may disagree about how big that network is.",
      "Compare the subnet mask on {where} with the mask of the other devices and the router on that LAN.",
      "The subnet mask decides which addresses a device treats as local. If devices on one LAN use different masks, " +
        "one may try to reach a remote address directly (and only succeed because of proxy ARP), or treat a local " +
        "address as remote. Every device on a segment should use the same mask.",
    ],
  },
  DUPLICATE_IP: {
    concept: "IP addressing",
    levels: [
      "Every address on a network has to be unique. Is it here?",
      "Look at the address on {where}, then compare it with the addresses in 'ipconfig /all' and " +
        "'show ip interface brief' on the other devices.",
      "When two devices share an IP address, ARP replies from both, and switches and routers send traffic to " +
        "whichever answered last. Connections fail or flap. Each interface on a network needs its own address.",
    ],
  },
  NOT_CABLED: {
    concept: "physical connectivity",
    levels: [
      "Start at the bottom: is everything on the path actually connected?",
      "Look at {where} on the canvas. Is there a cable plugged into it?",
      "Nothing above layer 1 works without a physical link. Each device needs a cable to the next device on the path, " +
        "on the port its configuration expects.",
    ],
  },

  // ---------------------------------------------------- layer 2
  IF_SHUTDOWN: {
    concept: "interface shutdown",
    levels: [
      "Is every interface on the path turned on? Look for link lights that aren't green.",
      "Check {where}. Run 'show ip interface brief' on {device}. What does the Status column say for that interface?",
      "IOS interfaces can be administratively disabled with the shutdown command, and router interfaces start that " +
        "way. 'administratively down' means someone (or the default) turned it off; it stays down until it is " +
        "enabled in interface configuration mode.",
    ],
  },
  IF_DOWN: {
    concept: "link status",
    levels: [
      "The router knows about the network on one interface, but can it actually use that interface right now?",
      "Run 'show ip interface brief' on {device} and look at Status and Protocol for {interface}.",
      "A connected route only appears in the routing table while its interface is up/up. If the interface is " +
        "enabled but down, the problem is at layers 1 or 2: the cable, the device at the other end, or a mismatch " +
        "between the two sides.",
    ],
  },
  LINK_DOWN: {
    concept: "link status",
    levels: [
      "Follow the path cable by cable. Is every link up?",
      "Look at the link at {where}. Check the link lights, and run 'show ip interface brief' on {device} and on " +
        "the device at the other end.",
      "A link needs both ends enabled and a cable of the right type. If one side is shut down, powered off or " +
        "wired with the wrong cable, the link stays down and no frames cross it.",
    ],
  },
  DEVICE_OFF: {
    concept: "device power",
    levels: [
      "Is every device on the path actually running?",
      "Look at {device} on the canvas. Is it powered on?",
      "A device that is powered off forwards nothing, and its links go down. In Packet Tracer the power switch is " +
        "on the device's Physical tab.",
    ],
  },
  VLAN_MISMATCH: {
    concept: "VLAN membership",
    levels: [
      "The devices are cabled, but a switch can split one physical network into several logical ones. Are both ends in the same one?",
      "Run 'show vlan brief' on {device}. Which VLAN is {interface} in, and which VLAN are the other ports for this traffic in?",
      "A switch only forwards a frame between ports in the same VLAN. Hosts that should talk directly, and a host " +
        "and its gateway, must have their access ports in the same VLAN. Traffic between different VLANs has to go " +
        "through a router.",
    ],
  },
  VLAN_NOT_ALLOWED: {
    concept: "trunk allowed VLANs",
    levels: [
      "The link between the switches carries several VLANs. Is this VLAN one of them?",
      "Run 'show interfaces trunk' on {device} and look at the allowed VLANs for {interface}.",
      "A trunk carries frames for many VLANs, but only the ones in its allowed list. A frame in a VLAN that isn't " +
        "allowed is dropped at the trunk even though the link is up.",
    ],
  },
  TRUNK_MISMATCH: {
    concept: "trunking",
    levels: [
      "One side of a link is sending frames tagged with their VLAN. Is the other side expecting tags?",
      "Run 'show interfaces trunk' on {device}. Is {interface} listed? Compare it with the device at the other end.",
      "On a trunk, frames carry an 802.1Q tag that says which VLAN they belong to. An access port doesn't expect " +
        "tags, so tagged frames arriving on it are dropped. Both ends of a link have to agree: both trunk, or both access.",
    ],
  },
  NO_SUBINTERFACE: {
    concept: "router-on-a-stick",
    levels: [
      "The router receives traffic from several VLANs on one physical port. Does it have somewhere to put each one?",
      "Run 'show running-config' on {device} and look at the subinterfaces under {interface}. Which VLAN does each one handle?",
      "In router-on-a-stick, one physical router port is a trunk and each VLAN gets its own subinterface. A " +
        "subinterface accepts frames only for the VLAN set by its dot1Q encapsulation, so a VLAN without a matching " +
        "subinterface is dropped.",
    ],
  },
  NO_IP_ON_INTERFACE: {
    concept: "interface addressing",
    levels: [
      "Traffic reaches a router, but does the router have an address on that network?",
      "Run 'show ip interface brief' on {device}. What address does {interface} have?",
      "A router interface needs an IP address in the LAN's subnet before the router will accept and route IP " +
        "packets arriving there. That address is also what the hosts use as their default gateway.",
    ],
  },
  L2_UNREACHABLE: {
    concept: "switching",
    levels: [
      "Two devices on the same network can't reach each other. Walk the switch path between them.",
      "Starting at {device}, check each switch on the way with 'show vlan brief' and 'show interfaces trunk'.",
      "Within one network, frames travel switch to switch. Each port on the way must be up, in the right VLAN, or " +
        "a trunk that allows that VLAN.",
    ],
  },

  // ---------------------------------------------------- layer 3
  NO_ROUTE: {
    concept: "routing table",
    levels: [
      "A router got the packet. Does it know where to send it next?",
      "Run 'show ip route' on {device}. Is there any route that covers the destination address, including a default route?",
      "A router forwards a packet only if its routing table has a matching entry: a connected network, a static " +
        "route, a dynamically learned route, or a default route. With no match it drops the packet and sends back " +
        "'destination unreachable'. Remember the reply needs a route back too.",
    ],
  },
  STATIC_ROUTE_INACTIVE: {
    concept: "static routes",
    levels: [
      "There's a route configured for this network, but is the router actually using it?",
      "Compare the ip route lines in 'show running-config' with 'show ip route' on {device}. Does every " +
        "configured static route appear in the table?",
      "A static route is only installed while its next hop is reachable (or its exit interface is up). If the " +
        "next hop's network isn't connected, the route stays in the configuration but is missing from the routing table.",
    ],
  },
  WRONG_NEXT_HOP: {
    concept: "static routes",
    levels: [
      "The router has a route, but does it point at the right neighbour?",
      "Run 'show ip route' on {device} and look at the next-hop address for the destination network. Which device owns that address?",
      "A static route's next hop must be the IP address of the neighbouring router on a directly connected link. " +
        "If it points at the wrong address, the packet is sent somewhere that can't or won't forward it.",
    ],
  },
  NEXT_HOP_UNREACHABLE: {
    concept: "static routes",
    levels: [
      "The route names a next hop. Can the router actually reach that address?",
      "Take the next-hop address from 'show ip route' on {device}. Is it on one of the router's directly connected networks?",
      "The next hop must be on a network the router is directly attached to, so the router can ARP for it. A next " +
        "hop that is several hops away doesn't work as a static route's next hop.",
    ],
  },
  NEXT_HOP_BROADCAST: {
    concept: "static routes",
    levels: [
      "This route works, but look closely at the address it uses as its next hop.",
      "Look at the next hop in 'show ip route' on {device}. Work out the network and broadcast address of the link it is on.",
      "A next hop should be the neighbouring router's interface address. Using the link's broadcast address happens " +
        "to work in Packet Tracer because the frame is sent as a broadcast, but it isn't valid design and fails on " +
        "real equipment.",
    ],
  },
  ROUTING_LOOP: {
    concept: "routing loops",
    levels: [
      "Trace the packet router by router. Does it ever come back to a router it already visited?",
      "Run 'traceroute <destination>' from {device}, then compare 'show ip route' on each router it passes.",
      "When router A's route points to router B and B's route points back to A, the packet bounces between them " +
        "until its TTL runs out. Each router's route must lead closer to the destination.",
    ],
  },
  TOO_MANY_HOPS: {
    concept: "routing loops",
    levels: [
      "The packet passes through a lot of routers. Is it going round in circles?",
      "Run 'traceroute <destination>' from {device}. Do any addresses repeat?",
      "Every router decrements the TTL. A packet that keeps getting forwarded without arriving usually means the " +
        "routes form a loop somewhere on the path.",
    ],
  },
  ACL_DENY: {
    concept: "access control lists",
    levels: [
      "The path and routes look fine. Is something on the way filtering traffic on purpose?",
      "Run 'show access-lists' and 'show ip interface {interface}' on {device}. Which list is applied, in which direction?",
      "An ACL is checked top to bottom and the first matching line wins. Every ACL ends with an invisible 'deny " +
        "any', so traffic that matches no permit line is dropped. Also check where the list is applied: on which " +
        "interface and in which direction (in or out).",
    ],
  },
  DEST_UNKNOWN: {
    concept: "IP addressing",
    levels: [
      "Is the address you're trying to reach actually assigned to a device?",
      "Check the destination address against 'ipconfig /all' and 'show ip interface brief' on the devices in that network.",
      "Traffic can only be delivered if some device owns the destination address. Check for a typo in the address, " +
        "or a device whose address doesn't match the plan.",
    ],
  },
  UNKNOWN_DEVICE: {
    concept: "",
    levels: [
      "That device name doesn't match anything on the canvas. Check the spelling.",
      "Device names must match the labels on the canvas exactly, including capital letters.",
      "Device names must match the labels on the canvas exactly, including capital letters.",
    ],
  },
};

const FALLBACK: Ladder = {
  concept: "troubleshooting",
  levels: [
    "Work layer by layer: cabling and link lights, then addressing, then VLANs, then routing, then filtering.",
    "Start at {device} and check its interfaces with 'show ip interface brief' or 'ipconfig /all'.",
    "Divide and conquer: ping the nearest device first, then the next hop, and so on. The first ping that fails " +
      "tells you which segment to look at.",
  ],
};

export const HINT_CODES = Object.keys(LADDERS);

export function hint(code: string, level: HintLevel, ctx: HintContext = {}): Hint {
  const key = code.toUpperCase();
  const ladder = LADDERS[key] ?? FALLBACK;
  const device = ctx.device || "the device";
  const iface = ctx.interface || "the interface";
  const where = ctx.device ? (ctx.interface ? `${ctx.device} ${ctx.interface}` : ctx.device) : "the device";
  const text = ladder.levels[level - 1]
    .replaceAll("{where}", where)
    .replaceAll("{device}", device)
    .replaceAll("{interface}", iface);
  return { code: key, level, hint: text, concept: ladder.concept, more: level < 3 };
}
