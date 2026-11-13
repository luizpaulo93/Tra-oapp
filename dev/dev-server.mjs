// Servidor de testes local: roda a MESMA lógica de sala (src/room-core.js)
// fora da Cloudflare, com um ambiente simulado. Uso: node dev/dev-server.mjs
// Requer o pacote "ws" e Node 22+. Não é publicado.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { RoomCore } from "../src/room-core.js";
import { AuthCore } from "../src/auth-core.js";
import { handleApi, bearer } from "../src/api.js";

const require = createRequire(import.meta.url);
let WebSocketServer;
try {
  ({ WebSocketServer } = require("ws"));
} catch {
  ({ WebSocketServer } = require("/opt/npm-tools/node_modules/ws"));
}

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const PORT = +process.env.PORT || 8787;
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json",
  ".webmanifest": "application/manifest+json", ".wasm": "application/wasm", ".png": "image/png",
};

// ---- ambiente simulado de um Durable Object ----
function makeCtx(onAlarm) {
  let db = new DatabaseSync(":memory:");
  const kv = new Map();
  const sockets = new Set();
  let timer = null;
  const ctx = {
    storage: {
      sql: {
        exec(q, ...b) {
          const rows = db.prepare(q).all(...b);
          return { toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() };
        },
      },
      async get(k) { return kv.has(k) ? structuredClone(kv.get(k)) : undefined; },
      async put(k, v) { kv.set(k, structuredClone(v)); },
      async setAlarm(t) {
        clearTimeout(timer);
        timer = setTimeout(onAlarm, Math.min(Math.max(0, t - Date.now()), 2 ** 31 - 1));
      },
      async deleteAlarm() { clearTimeout(timer); },
      async deleteAll() { kv.clear(); db.close(); db = new DatabaseSync(":memory:"); },
    },
    acceptWebSocket(ws, tags) { ws.tags = tags; sockets.add(ws); },
    getWebSockets(tag) { return [...sockets].filter((s) => !tag || s.tags.includes(tag)); },
    _drop(ws) { sockets.delete(ws); },
  };
  return ctx;
}

const rooms = new Map();
function room(code) {
  if (!rooms.has(code)) {
    const ctx = makeCtx(() => core.alarm());
    const core = new RoomCore(ctx);
    // Uma sala processa um evento por vez, como na Cloudflare.
    const entry = { ctx, core, q: Promise.resolve() };
    entry.run = (fn) => (entry.q = entry.q.then(fn).catch((e) => console.error(e)));
    rooms.set(code, entry);
  }
  return rooms.get(code);
}

function send(res, status, data) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(data));
}

const authCore = new AuthCore(makeCtx(() => {}), {
  email: process.env.ADMIN_EMAIL,
  hash: process.env.ADMIN_EMAIL_SHA256 || "011673ddf1f4a3101576d736c30e5c32795e157dc40c30e930ad74169ed42347,40765a29f642d16d1d1e7f65e389a48c59fa5d2cba4ec28d067234c29ede633b",
});
let authQ = Promise.resolve();

const apiEnv = {
  randomCode: () => process.env.FIXED_CODE || String(100000 + Math.floor(Math.random() * 900000)),
  auth: (op, args) => (authQ = authQ.catch(() => {}).then(() => authCore.rpc(op, args))),
  roomCreate: (code) => room(code).core.create(code),
  roomStatus: (code, key) => room(code).core.status(key),
};

function readBody(req) {
  return new Promise((resolve) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => resolve(d));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname.startsWith("/api/")) {
    const r = await handleApi(
      {
        method: req.method,
        path: url.pathname,
        query: url.searchParams,
        token: bearer(req.headers.authorization),
        json: async () => JSON.parse(await readBody(req)),
      },
      apiEnv
    );
    return send(res, r.status, r.body);
  }
  let file = path.normalize(path.join(ROOT, decodeURIComponent(url.pathname)));
  if (!file.startsWith(ROOT)) return send(res, 403, {});
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
  if (!fs.existsSync(file)) return send(res, 404, {});
  res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" });
  fs.createReadStream(file).pipe(res);
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
server.on("upgrade", async (req, socket, headBuf) => {
  const url = new URL(req.url, "http://x");
  const m = url.pathname.match(/^\/api\/rooms\/(\d{6})\/ws$/);
  if (!m) return socket.destroy();
  const { ctx, core, run } = room(m[1]);
  const role = await core.admit(url.searchParams.get("key"));
  if (!role) {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, headBuf, async (raw) => {
    let attachment = null;
    const ws = {
      send: (m) => raw.send(m),
      close: (c, r) => raw.close(c, r),
      serializeAttachment: (v) => { attachment = v; },
      deserializeAttachment: () => attachment,
    };
    ctx.acceptWebSocket(ws, [role]);
    ws.serializeAttachment({ role });
    raw.on("message", (data, isBinary) => {
      const text = isBinary ? data : data.toString();
      if (text === "ping") return raw.send("pong");
      run(() => core.message(ws, text));
    });
    raw.on("close", () => { ctx._drop(ws); run(() => core.closed(ws)); });
    run(() => core.joined(ws, role));
  });
});

server.listen(PORT, () => console.log("Traço (teste local) em http://localhost:" + PORT));
