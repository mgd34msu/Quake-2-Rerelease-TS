// TCP transport for the GTV (MVD relay) protocol.
//
// SANCTIONED BUN-API DIVERGENCE (see PORTING.md's platform-layer table and
// .orch/preferences.md rule 17 "interop outranks literal preservation"):
// q2repro's GTV server/client (src/server/mvd.c's gtv_client_t,
// src/server/mvd/client.c's outbound connector) run over real TCP sockets
// (inc/common/net/net.h's NA_IP + a stream-oriented netstream_t on top of
// the same BSD socket API net_udp.ts already wraps for UDP). This engine's
// platform layer has never needed TCP before -- net_udp.ts's `Bun.udpSocket`
// is the only transport PORTING.md's directory-mapping table names
// (`src/platform/` -- "ONE bun implementation of the sys/net/vid/snd
// interfaces"). GTV genuinely cannot be built on UDP (it is a length-
// prefixed byte STREAM with partial-read/partial-write semantics, TCP's
// defining property), so this module adds `Bun.listen`/`Bun.connect`
// (Bun's native TCP API, not a Node polyfill) as the one new transport
// primitive this port introduces beyond net_udp.ts's UDP socket, exactly
// the way NET_GetPacket/NET_SendPacket wrap `Bun.udpSocket` today. Reported
// per this unit's brief as "the one Bun-API divergence."
//
// Poll-based design, matching net_udp.ts's own rxQueue idiom: Bun's TCP
// sockets are callback/event driven (`open`/`data`/`close`/`error`), but
// q2repro's GTV code (SV_MvdRunClients, MVD_ParseMessage) is written as
// synchronous polling over a FIFO byte stream. Each connection gets a
// growable receive-byte-queue array that the `data` callback appends to;
// TCP_Read drains and concatenates it. This mirrors net_udp.ts's
// `rxQueue`/`NET_GetPacket` split (accept push-driven bytes into a buffer,
// let the game-visible API pull synchronously) rather than introducing a
// second concurrency model into the engine.

export interface TcpAcceptedT {
  id: number;
  address: string;
  port: number;
}

interface ConnState {
  socket: Bun.Socket<{ id: number }>;
  chunks: Uint8Array[];
  closed: boolean;
  closeError: string | null;
  address: string;
  port: number;
}

const connections = new Map<number, ConnState>();
let nextConnId = 1;

// Listener id -> { listener, pending accepted connection ids }
interface ListenerState {
  listener: Bun.TCPSocketListener<{ id: number }>;
  pendingAccepts: number[];
}
const listeners = new Map<number, ListenerState>();
let nextListenerId = 1;

function registerSocket(socket: Bun.Socket<{ id: number }>, address: string, port: number): number {
  const id = nextConnId++;
  socket.data = { id };
  connections.set(id, { socket, chunks: [], closed: false, closeError: null, address, port });
  return id;
}

/*
==============
TCP_Listen

Starts listening for GTV server connections on `hostname:port`. Newly
accepted connections are queued; drain them with TCP_Accept(). Returns the
listener id (used with TCP_StopListening), or null on bind failure --
mirrors net_udp.ts's NET_Socket catch-and-report-null pattern.
==============
*/
export async function TCP_Listen(hostname: string, port: number): Promise<number | null> {
  try {
    let listenerId = 0;
    const listener = Bun.listen<{ id: number }>({
      hostname,
      port,
      socket: {
        open(socket) {
          const state = listeners.get(listenerId);
          const id = registerSocket(socket, socket.remoteAddress ?? "0.0.0.0", 0);
          if (state) state.pendingAccepts.push(id);
        },
        data(socket, data) {
          const conn = connections.get(socket.data.id);
          if (conn) conn.chunks.push(new Uint8Array(data));
        },
        close(socket) {
          const conn = connections.get(socket.data.id);
          if (conn) conn.closed = true;
        },
        error(socket, error) {
          const conn = connections.get(socket.data.id);
          if (conn) {
            conn.closed = true;
            conn.closeError = error.message;
          }
        },
      },
    });
    listenerId = nextListenerId++;
    listeners.set(listenerId, { listener, pendingAccepts: [] });
    return listenerId;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return null;
  }
}

// Pops one pending accepted connection for `listenerId`, or null if none.
export function TCP_Accept(listenerId: number): TcpAcceptedT | null {
  const state = listeners.get(listenerId);
  if (!state) return null;
  const id = state.pendingAccepts.shift();
  if (id === undefined) return null;
  const conn = connections.get(id);
  if (!conn) return null;
  return { id, address: conn.address, port: conn.port };
}

export function TCP_ListenerPort(listenerId: number): number {
  const state = listeners.get(listenerId);
  return state ? state.listener.port : 0;
}

export function TCP_StopListening(listenerId: number): void {
  const state = listeners.get(listenerId);
  if (!state) return;
  state.listener.stop(true);
  listeners.delete(listenerId);
}

/*
==============
TCP_Connect

Opens an outbound GTV client connection. Returns the connection id used by
TCP_Read/TCP_Write/TCP_Close/TCP_IsClosed, or null on connect failure.
==============
*/
export async function TCP_Connect(hostname: string, port: number): Promise<number | null> {
  try {
    let id = 0;
    const socket = await Bun.connect<{ id: number }>({
      hostname,
      port,
      socket: {
        data(sock, data) {
          const conn = connections.get(sock.data.id);
          if (conn) conn.chunks.push(new Uint8Array(data));
        },
        close(sock) {
          const conn = connections.get(sock.data.id);
          if (conn) conn.closed = true;
        },
        error(sock, error) {
          const conn = connections.get(sock.data.id);
          if (conn) {
            conn.closed = true;
            conn.closeError = error.message;
          }
        },
      },
    });
    id = registerSocket(socket, hostname, port);
    return id;
  } catch (err) {
    return null;
  }
}

// Drains and returns every byte received since the last call, or null if
// nothing is buffered. Concatenates multiple `data` callback chunks into one
// contiguous view (GTV's FIFO_TryRead/FIFO_ReadMessage callers expect to be
// able to read an arbitrary byte range regardless of TCP packet boundaries).
export function TCP_Read(id: number): Uint8Array | null {
  const conn = connections.get(id);
  if (!conn || conn.chunks.length === 0) return null;
  if (conn.chunks.length === 1) {
    const only = conn.chunks[0];
    conn.chunks = [];
    return only;
  }
  let total = 0;
  for (const c of conn.chunks) total += c.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of conn.chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  conn.chunks = [];
  return out;
}

export function TCP_Write(id: number, data: Uint8Array): boolean {
  const conn = connections.get(id);
  if (!conn || conn.closed) return false;
  const written = conn.socket.write(data);
  return written >= 0;
}

export function TCP_IsClosed(id: number): boolean {
  const conn = connections.get(id);
  return !conn || conn.closed;
}

export function TCP_CloseError(id: number): string | null {
  const conn = connections.get(id);
  return conn ? conn.closeError : null;
}

export function TCP_Close(id: number): void {
  const conn = connections.get(id);
  if (!conn) return;
  try {
    conn.socket.end();
  } catch {
    // already closed
  }
  connections.delete(id);
}

// Test/shutdown helper: drops all connection and listener state without
// closing sockets gracefully. Not part of any C interface; used by
// test/mvd.test.ts to reset module state between cases.
export function TCP_ResetForTests(): void {
  connections.clear();
  listeners.clear();
}
