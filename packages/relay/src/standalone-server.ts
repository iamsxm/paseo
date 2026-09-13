import { createServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";

type Role = "server" | "client";
type Peer = { ws: WebSocket; role: Role; version: "1" | "2"; connectionId: string | null };
type Session = { peers: Set<Peer>; pending: Map<string, Array<string | Buffer>> };

const port = Number(process.env.PASEO_RELAY_PORT ?? 8787);
const sessions = new Map<string, Session>();
const server = createServer((request, response) => {
  if (request.url === "/healthz") {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("ok\n");
    return;
  }
  response.writeHead(426);
  response.end("WebSocket upgrade required\n");
});
const wss = new WebSocketServer({ server, maxPayload: 32 * 1024 * 1024 });

function sessionFor(id: string): Session {
  let session = sessions.get(id);
  if (!session) {
    session = { peers: new Set(), pending: new Map() };
    sessions.set(id, session);
  }
  return session;
}

function send(peer: Peer, data: string | Buffer): void {
  if (peer.ws.readyState === peer.ws.OPEN) peer.ws.send(data);
}

function peers(session: Session, role: Role, connectionId?: string | null): Peer[] {
  return [...session.peers].filter((peer) => peer.role === role && (connectionId === undefined || peer.connectionId === connectionId));
}

wss.on("connection", (ws, request) => {
  const url = new URL(request.url ?? "/", "http://relay.local");
  const serverId = url.searchParams.get("serverId");
  const role = url.searchParams.get("role");
  const version = url.searchParams.get("v") === "2" ? "2" : "1";
  if (!serverId || (role !== "server" && role !== "client")) {
    ws.close(1008, "Invalid relay parameters");
    return;
  }
  const connectionId = version === "2" && role === "client"
    ? (url.searchParams.get("connectionId") || `conn_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`)
    : version === "2" ? url.searchParams.get("connectionId") : null;
  const session = sessionFor(serverId);
  const peer: Peer = { ws, role, version, connectionId };
  for (const old of peers(session, role, role === "server" ? connectionId : undefined)) {
    old.ws.close(1008, "Replaced by new connection");
  }
  session.peers.add(peer);
  if (version === "2" && role === "server" && !connectionId) {
    send(peer, JSON.stringify({ type: "sync", connectionIds: [...new Set(peers(session, "client").map((item) => item.connectionId).filter(Boolean))] }));
  }
  if (version === "2" && role === "server" && connectionId) {
    for (const frame of session.pending.get(connectionId) ?? []) send(peer, frame);
    session.pending.delete(connectionId);
  }
  if (version === "2" && role === "client" && connectionId) {
    for (const control of peers(session, "server", null)) send(control, JSON.stringify({ type: "connected", connectionId }));
  }
  ws.on("message", (data, isBinary) => {
    const frame = isBinary ? Buffer.from(data as Buffer) : data.toString();
    if (version === "1") {
      for (const target of peers(session, role === "server" ? "client" : "server")) send(target, frame);
      return;
    }
    if (!connectionId) return;
    const targets = peers(session, role === "client" ? "server" : "client", connectionId);
    if (targets.length === 0 && role === "client") {
      const pending = session.pending.get(connectionId) ?? [];
      if (pending.length < 200) pending.push(frame);
      session.pending.set(connectionId, pending);
    } else for (const target of targets) send(target, frame);
  });
  ws.on("close", () => {
    session.peers.delete(peer);
    if (version === "2" && role === "client" && connectionId) {
      for (const control of peers(session, "server", null)) send(control, JSON.stringify({ type: "disconnected", connectionId }));
    }
    if (session.peers.size === 0) sessions.delete(serverId);
  });
});

server.listen(port, "0.0.0.0", () => console.log(`[relay] listening on ${port}`));
