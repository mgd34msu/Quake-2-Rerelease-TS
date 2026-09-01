// linux/net_udp.c + win32/net_wins.c -- one portable bun implementation of the
// NET_* transport interface declared in qcommon.h. Real sockets are Bun.udpSocket
// (bound on demand, per netsrc); NA_LOOPBACK traffic never touches a socket at
// all and instead flows through the ring buffers below, exactly like the C
// loopback path.
//
// netadr_t.port is treated as a plain host-order integer throughout this file.
// The C implementation stores it in network byte order (a raw copy of
// sockaddr_in.sin_port) and calls ntohs()/htons() at the string<->addr
// boundary; that byte-swap is an artifact of building a raw sockaddr struct by
// hand and has no equivalent need here since Bun's udp API takes/returns plain
// numeric ports. Dropped; see report.

import { NetadrT, NetadrtypeT, NetsrcT, PORT_ANY, PORT_SERVER, ERR_FATAL } from "../qcommon/qcommon";
import type { SizeBuf } from "../qcommon/sizebuf";
import { Com_Printf, Com_Error } from "../qcommon/common";
import { Cvar_Get } from "../qcommon/cvar";
import { Com_sprintf, CVAR_NOSET } from "../shared/q_shared";
import { fixedLength } from "../shared/fixed";

type UdpSocket = Bun.udp.Socket<"buffer">;

//=============================================================================
// address helpers (replace NetadrToSockadr/SockadrToNetadr -- there is no
// sockaddr struct on this transport, only Bun's plain hostname/port pairs)

function ipBytesToString(ip: Uint8Array): string {
  return `${ip[0]}.${ip[1]}.${ip[2]}.${ip[3]}`;
}

function stringToIpBytes(s: string): Uint8Array | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const part = parts[i];
    if (part === undefined || !/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    out[i] = n;
  }
  return out;
}

export function NET_CompareAdr(a: NetadrT, b: NetadrT): boolean {
  return a.ip[0] === b.ip[0] && a.ip[1] === b.ip[1] && a.ip[2] === b.ip[2] && a.ip[3] === b.ip[3] && a.port === b.port;
}

// Compares without the port
export function NET_CompareBaseAdr(a: NetadrT, b: NetadrT): boolean {
  if (a.type !== b.type) return false;

  if (a.type === NetadrtypeT.NA_LOOPBACK) return true;

  if (a.type === NetadrtypeT.NA_IP) {
    return a.ip[0] === b.ip[0] && a.ip[1] === b.ip[1] && a.ip[2] === b.ip[2] && a.ip[3] === b.ip[3];
  }

  if (a.type === NetadrtypeT.NA_IPX) {
    for (let i = 0; i < 10; i++) {
      if (a.ipx[i] !== b.ipx[i]) return false;
    }
    return true;
  }

  // The C function has no return statement for NA_BROADCAST/NA_BROADCAST_IPX
  // (undefined behavior: whatever happened to be in the return register).
  // Treated here as false, the safe reading.
  return false;
}

export function NET_BaseAdrToString(a: NetadrT): string {
  return `${a.ip[0]}.${a.ip[1]}.${a.ip[2]}.${a.ip[3]}`;
}

export function NET_AdrToString(a: NetadrT): string {
  return Com_sprintf("%i.%i.%i.%i:%i", a.ip[0], a.ip[1], a.ip[2], a.ip[3], a.port);
}

// localhost
// idnewt
// idnewt:28000
// 192.246.40.70
// 192.246.40.70:28000
//
// gethostbyname's blocking DNS lookup has no safe synchronous equivalent on
// Bun's event loop, so unlike the original this only resolves numeric
// dotted-quad addresses and the literal hostname "localhost" -- see report.
export function NET_StringToAdr(s: string, a: NetadrT): boolean {
  if (s === "localhost") {
    a.type = NetadrtypeT.NA_LOOPBACK;
    a.ip.fill(0);
    a.ipx.fill(0);
    a.port = 0;
    return true;
  }

  let host = s;
  let port = 0;

  const colon = s.lastIndexOf(":");
  if (colon !== -1) {
    host = s.slice(0, colon);
    const p = Number(s.slice(colon + 1));
    if (!Number.isInteger(p) || p < 0 || p > 0xffff) return false;
    port = p;
  }

  const ip = host === "localhost" ? new Uint8Array([127, 0, 0, 1]) : stringToIpBytes(host);
  if (!ip) return false;

  a.type = NetadrtypeT.NA_IP;
  a.ip.set(ip);
  a.ipx.fill(0);
  a.port = port;
  return true;
}

// Never set by anything in this port (the vanilla engine only ever assigns it
// on Windows/Solaris/Irix builds via a NET_GetLocalAddress this file's linux
// counterpart does not have either), so this stays zeroed like the C global.
// Still consumed by NET_GetLoopPacket below (populates a received loopback
// packet's `from` address) -- just no longer by NET_IsLocalAddress itself,
// see that function's own comment.
export const net_local_adr: NetadrT = new NetadrT();

// FIXED (.orch/followups.md post-1.0 follow-up): this used to be vanilla's
// own `NET_CompareAdr(adr, net_local_adr)` (linux/net_udp.c:205-208) --
// vanilla's NET_CompareAdr (net_udp.c:74-79) compares only ip[]+port,
// never `.type`, and net_local_adr is a zeroed NetadrT (ip 0.0.0.0, port 0)
// that is never assigned on this platform. That makes ANY address whose
// ip/port both happen to be zero read as "local" regardless of its actual
// `.type` -- most of the time harmless (every genuine loopback-ring address
// this port produces IS all-zero, see NET_GetLoopPacket below), but a
// concretely wrong answer for a real NA_IP address that happens to be
// 0.0.0.0:0 (documented as a live quirk by cl_main.ts's CL_ServerIsOurOwn
// comment and test/net_chan_maxpacketlen_parity.test.ts's own driveConnect
// test, both of which had to construct a non-zero network address to avoid
// tripping over it).
//
// q2repro's own reference (inc/common/net/net.h:105) does not carry this
// quirk at all -- q2repro dropped the net_local_adr/NET_CompareAdr pattern
// entirely and replaced it with the plain macro `#define
// NET_IsLocalAddress(adr) ((adr)->type == NA_LOOPBACK)`. Every call site in
// this port that receives `adr` from a real packet (NET_GetPacket below
// always stamps a genuine network sender NA_IP, and a loopback-ring sender
// NA_LOOPBACK) already gets an identical answer either way; only the
// pathological all-zero-NA_IP case changes, from a false "yes" to the
// correct "no". Matches q2repro's macro exactly now.
export function NET_IsLocalAddress(adr: NetadrT): boolean {
  return adr.type === NetadrtypeT.NA_LOOPBACK;
}

//=============================================================================
// LOOPBACK BUFFERS FOR LOCAL PLAYER

const MAX_LOOPBACK = 4;

class LoopbackT {
  msgs: Uint8Array[] = fixedLength("LoopbackT.msgs", MAX_LOOPBACK, [
    new Uint8Array(0),
    new Uint8Array(0),
    new Uint8Array(0),
    new Uint8Array(0),
  ]);
  get = 0;
  send = 0;
}

const loopbacks: [LoopbackT, LoopbackT] = [new LoopbackT(), new LoopbackT()];

// Test seam (CM_MarkMapLoadedForTesting precedent): the loopback rings are
// process-wide singletons; suites that drive a real connect flow reset them
// so later suites see empty rings regardless of file order.
export function NET_ClearLoopback(): void {
  loopbacks[0] = new LoopbackT();
  loopbacks[1] = new LoopbackT();
}

function NET_GetLoopPacket(sock: NetsrcT, out_from: NetadrT, message: SizeBuf): boolean {
  const loop = loopbacks[sock];

  if (loop.send - loop.get > MAX_LOOPBACK) loop.get = loop.send - MAX_LOOPBACK;

  if (loop.get >= loop.send) return false;

  const i = loop.get & (MAX_LOOPBACK - 1);
  loop.get++;

  const packet = loop.msgs[i];
  message.data.set(packet, 0);
  message.cursize = packet.length;

  out_from.type = net_local_adr.type;
  out_from.ip.set(net_local_adr.ip);
  out_from.ipx.set(net_local_adr.ipx);
  out_from.port = net_local_adr.port;

  return true;
}

function NET_SendLoopPacket(sock: NetsrcT, length: number, data: Uint8Array): void {
  const loop = loopbacks[sock ^ 1];

  const i = loop.send & (MAX_LOOPBACK - 1);
  loop.send++;

  loop.msgs[i] = data.slice(0, length);
}

//=============================================================================
// real UDP sockets, poll-based to match the C recvfrom(..., O_NONBLOCK) API.
// Bun.udpSocket's bind is asynchronous; NET_Config kicks it off and returns a
// promise instead of C's `void`, but NET_GetPacket/NET_SendPacket themselves
// stay synchronous polling functions exactly like the original -- see report.

interface RxPacket {
  data: Uint8Array;
  port: number;
  address: string;
}

const ip_sockets: [UdpSocket | null, UdpSocket | null] = [null, null];
const rxQueue: [RxPacket[], RxPacket[]] = [[], []];

// Reports whether a given netsrc currently has a bound socket -- used by
// callers (namely the optional real-UDP test) that need to know synchronously
// whether NET_Config's async bind actually succeeded. Not part of the C
// header; added purely for testability.
export function NET_SocketBound(sock: NetsrcT): boolean {
  return ip_sockets[sock] !== null;
}

// Reports the actual bound port for a netsrc (e.g. the ephemeral port the OS
// assigned), or 0 if unbound. Also added purely for testability -- not part
// of the C header.
export function NET_SocketPort(sock: NetsrcT): number {
  const socket = ip_sockets[sock];
  return socket ? socket.port : 0;
}

function resolveBindHost(net_interface: string): string {
  if (!net_interface || net_interface.toLowerCase() === "localhost") return "0.0.0.0";
  return net_interface;
}

async function NET_Socket(net_interface: string, port: number, sock: NetsrcT): Promise<void> {
  const hostname = resolveBindHost(net_interface);
  const bindPort = port === PORT_ANY ? 0 : port;

  try {
    const socket = await Bun.udpSocket({
      hostname,
      port: bindPort,
      socket: {
        data(_socket, data, fromPort, fromAddress) {
          rxQueue[sock].push({ data: new Uint8Array(data), port: fromPort, address: fromAddress });
        },
        error(_socket, error) {
          // RULE-17 FINDING (phase-8 q2repro interop): bun-types declares
          // this callback's `error` parameter as a non-optional `Error`, but
          // real Bun 1.3.14 invokes it with `error === undefined` under
          // genuine interop load (observed only once a real q2repro client
          // connected -- never triggered by this engine's own synthetic UDP
          // tests). The declared type cannot be trusted at this native
          // boundary; narrow the same way the catch block just below this
          // handler already does for the identical mismatch.
          const message = error instanceof Error ? error.message : String(error);
          Com_Printf("NET_GetPacket: %s\n", message);
        },
      },
    });
    socket.setBroadcast(true);
    ip_sockets[sock] = socket;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    Com_Printf(`ERROR: UDP_OpenSocket: ${message}\n`);
  }
}

async function NET_OpenIP(): Promise<void> {
  const port = Cvar_Get("port", Com_sprintf("%i", PORT_SERVER), CVAR_NOSET);
  const ip = Cvar_Get("ip", "localhost", CVAR_NOSET);

  const iface = ip ? ip.string : "localhost";
  const bindPort = port ? Math.trunc(port.value) : PORT_SERVER;

  const tasks: Array<Promise<void>> = [];
  if (!ip_sockets[NetsrcT.NS_SERVER]) tasks.push(NET_Socket(iface, bindPort, NetsrcT.NS_SERVER));
  if (!ip_sockets[NetsrcT.NS_CLIENT]) tasks.push(NET_Socket(iface, PORT_ANY, NetsrcT.NS_CLIENT));

  await Promise.all(tasks);
}

// NET_OpenIPX -- dropped. IPX is not a supported transport on this port (no
// modern OS exposes an IPX socket family); every IPX branch below is a no-op.

// A single player game will only use the loopback code
export async function NET_Config(multiplayer: boolean): Promise<void> {
  if (!multiplayer) {
    for (const sock of [NetsrcT.NS_CLIENT, NetsrcT.NS_SERVER] as const) {
      const socket = ip_sockets[sock];
      if (socket) {
        socket.close();
        ip_sockets[sock] = null;
      }
      rxQueue[sock] = [];
    }
    return;
  }

  await NET_OpenIP();
}

//=============================================================================

export function NET_Init(): void {
  // --- cvar-parity audit: src/common/net/net.c cvars ---
  // q2repro replaced vanilla's single "ip"/"port" bind (still this port's
  // NET_OpenIP model above) with a dual IPv4/IPv6-capable net_ip/net_ip6/
  // net_port/net_clientport/net_enable_ipv6 set. Registered, consumer
  // unported: this port's socket layer (NET_OpenIP above) only ever binds
  // one address family via "ip"/"port", never these names.
  Cvar_Get("net_ip", "", 0); // net.c:1829
  Cvar_Get("net_ip6", "", 0); // net.c:1831
  Cvar_Get("net_port", String(PORT_SERVER), 0); // net.c:1833
  Cvar_Get("net_clientport", String(PORT_ANY), 0); // net.c:1837
  // net_dropsim (net.c:1839) would simulate packet loss on send/receive;
  // no such simulation exists anywhere in this port's socket layer.
  Cvar_Get("net_dropsim", "0", 0);
  // net_log_* (net.c:1843-1847) gate q2repro's raw packet logging to a file;
  // not ported.
  Cvar_Get("net_log_enable", "0", 0);
  Cvar_Get("net_log_name", "network", 0);
  Cvar_Get("net_log_flush", "0", 0);
  // net_enable_ipv6's C default is a runtime probe (NET_EnableIP6(): tries
  // to open an AF_INET6 socket). This port never attempts an IPv6 socket
  // anywhere, so there is nothing to probe -- default conservatively to "0"
  // rather than guessing OS capability.
  Cvar_Get("net_enable_ipv6", "0", 0); // net.c:1851
  Cvar_Get("net_ignore_icmp", "0", 0); // net.c:1855
}

// C's `void NET_Shutdown(void)` just calls `NET_Config(false)`; that call is
// now async here since it may need to close sockets whose bind promise hasn't
// settled, so NET_Shutdown is async too -- see report.
export async function NET_Shutdown(): Promise<void> {
  await NET_Config(false);
}

export function NET_GetPacket(sock: NetsrcT, out_from: NetadrT, message: SizeBuf): boolean {
  if (NET_GetLoopPacket(sock, out_from, message)) return true;

  const queue = rxQueue[sock];

  let packet = queue.shift();
  while (packet) {
    if (packet.data.length >= message.maxsize) {
      Com_Printf(`Oversize packet from %s:%i\n`, packet.address, packet.port);
      packet = queue.shift();
      continue;
    }

    message.data.set(packet.data, 0);
    message.cursize = packet.data.length;

    out_from.type = NetadrtypeT.NA_IP;
    const ip = stringToIpBytes(packet.address);
    if (ip) out_from.ip.set(ip);
    out_from.ipx.fill(0);
    out_from.port = packet.port;

    return true;
  }

  return false;
}

export function NET_SendPacket(sock: NetsrcT, length: number, data: Uint8Array, to: NetadrT): void {
  if (to.type === NetadrtypeT.NA_LOOPBACK) {
    NET_SendLoopPacket(sock, length, data);
    return;
  }

  if (to.type === NetadrtypeT.NA_IPX || to.type === NetadrtypeT.NA_BROADCAST_IPX) {
    // IPX transport dropped -- see report
    return;
  }

  if (to.type !== NetadrtypeT.NA_BROADCAST && to.type !== NetadrtypeT.NA_IP) {
    Com_Error(ERR_FATAL, "NET_SendPacket: bad address type");
  }

  const socket = ip_sockets[sock];
  if (!socket) return;

  const address = to.type === NetadrtypeT.NA_BROADCAST ? "255.255.255.255" : ipBytesToString(to.ip);
  socket.send(data.subarray(0, length), to.port, address);
}

// NET_Sleep -- omitted. The C version blocks the process in select() until a
// socket is readable or a timeout elapses, standing in for the whole engine's
// frame pacing on a dedicated server. This port's frame loop (not yet landed)
// is expected to poll NET_GetPacket itself rather than block the JS event
// loop; see report.
