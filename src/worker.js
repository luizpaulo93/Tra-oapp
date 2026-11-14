// Traço — servidor (Cloudflare Workers + Durable Objects).
// O Worker entrega o app (pasta public/), cuida do login e encaminha cada
// transmissão para a sua "sala" (um Durable Object por código de 6 dígitos).

import { DurableObject } from "cloudflare:workers";
import { RoomCore } from "./room-core.js";
import { AuthCore } from "./auth-core.js";
import { handleApi, bearer } from "./api.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function randomCode() {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return String(100000 + (a[0] % 900000));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);

    const room = (code) => env.ROOMS.get(env.ROOMS.idFromName(code));

    // Conexão ao vivo: /api/rooms/123456/ws
    const ws = url.pathname.match(/^\/api\/rooms\/(\d{6})\/ws$/);
    if (ws) {
      if (request.headers.get("Upgrade") !== "websocket") return json({ error: "upgrade" }, 426);
      return room(ws[1]).fetch(request);
    }

    const res = await handleApi(
      {
        method: request.method,
        path: url.pathname,
        query: url.searchParams,
        token: bearer(request.headers.get("Authorization")),
        json: () => request.json(),
      },
      {
        randomCode,
        async auth(op, args) {
          const stub = env.AUTH.get(env.AUTH.idFromName("auth"));
          const r = await stub.fetch("https://auth/rpc", { method: "POST", body: JSON.stringify({ op, args }) });
          return r.json();
        },
        async roomCreate(code) {
          const r = await room(code).fetch("https://room/create?code=" + code, { method: "POST" });
          return r.json();
        },
        async roomStatus(code, key) {
          const r = await room(code).fetch("https://room/status?key=" + encodeURIComponent(key));
          return r.json();
        },
      }
    );
    return json(res.body, res.status);
  },
};

// Cadastro de usuários e sessões (um único objeto para o site todo).
export class Auth extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.core = new AuthCore(ctx, { email: env.ADMIN_EMAIL, hash: env.ADMIN_EMAIL_SHA256 });
  }

  async fetch(request) {
    const { op, args } = await request.json();
    return json(await this.core.rpc(op, args));
  }
}

// Uma transmissão ao vivo.
export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.core = new RoomCore(ctx);
    // "ping" é respondido sem acordar a sala (não consome cota).
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/create") {
      return json(await this.core.create(url.searchParams.get("code")));
    }

    if (url.pathname === "/status") {
      return json(await this.core.status(url.searchParams.get("key")));
    }

    if (url.pathname.endsWith("/ws")) {
      const role = await this.core.admit(url.searchParams.get("key"), url.searchParams.get("pk"));
      if (!role) return json({ error: "not_live" }, 404);
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      this.ctx.acceptWebSocket(server, [role]);
      server.serializeAttachment({ role });
      await this.core.joined(server, role);
      return new Response(null, { status: 101, webSocket: client });
    }

    return json({ error: "not_found" }, 404);
  }

  async webSocketMessage(ws, message) {
    await this.core.message(ws, message);
  }

  async webSocketClose(ws, code, reason) {
    await this.core.closed(ws);
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code, reason); } catch {}
  }

  async webSocketError(ws) {
    await this.core.closed(ws);
  }

  async alarm() {
    await this.core.alarm();
  }
}
