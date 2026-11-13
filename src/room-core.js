// Lógica de uma sala de transmissão. Não depende de nada específico da
// Cloudflare além do objeto `ctx` (storage, sockets, alarmes), para poder
// rodar também no servidor de testes local (dev/dev-server.mjs).
//
// Formato das mensagens: "<cabeçalho JSON>\n<corpo opcional>".
// O servidor só interpreta o cabeçalho; o corpo é guardado/retransmitido cru.

const HOST_GRACE_MS = 3 * 60 * 1000; // tempo para o apresentador reconectar
const MAX_LIFE_MS = 12 * 60 * 60 * 1000; // duração máxima de uma transmissão
const MAX_MSG = 1_500_000; // tamanho máximo de uma mensagem
const CHUNK = 256 * 1024; // tamanho dos blocos enviados a quem entra depois

function head(obj, body) {
  return body === undefined ? JSON.stringify(obj) + "\n" : JSON.stringify(obj) + "\n" + body;
}

function randomKey() {
  const a = new Uint8Array(18);
  crypto.getRandomValues(a);
  let s = "";
  for (const b of a) s += b.toString(16).padStart(2, "0");
  return s;
}

export class RoomCore {
  constructor(ctx) {
    this.ctx = ctx;
    this.room = undefined; // undefined = ainda não lido; null = sala não existe
  }

  get sql() {
    return this.ctx.storage.sql;
  }

  async load() {
    if (this.room === undefined) this.room = (await this.ctx.storage.get("room")) || null;
    return this.room;
  }

  async save() {
    await this.ctx.storage.put("room", this.room);
  }

  // ---------- chamadas HTTP (feitas pelo Worker) ----------

  async create(code) {
    const room = await this.load();
    if (room) return { ok: false };
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS pages (id TEXT PRIMARY KEY, w REAL, h REAL, bg TEXT)"
    );
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS ops (seq INTEGER PRIMARY KEY AUTOINCREMENT, pg TEXT, body TEXT)"
    );
    this.sql.exec("CREATE INDEX IF NOT EXISTS ops_pg ON ops (pg, seq)");
    this.room = { code, key: randomKey(), created: Date.now(), cur: null, order: [] };
    await this.save();
    await this.ctx.storage.setAlarm(Date.now() + HOST_GRACE_MS);
    return { ok: true, key: this.room.key };
  }

  async status(key) {
    const room = await this.load();
    if (!room) return { live: false };
    return { live: true, host: !!key && key === room.key };
  }

  // Decide se uma conexão pode entrar. Retorna o papel ou null.
  async admit(key) {
    const room = await this.load();
    if (!room) return null;
    if (key) return key === room.key ? "host" : null;
    return "viewer";
  }

  // Chamado depois que o socket foi aceito com a tag do papel.
  async joined(ws, role) {
    const room = await this.load();
    if (!room) {
      try { ws.close(4004, "ended"); } catch {}
      return;
    }
    if (role === "host") {
      for (const other of this.ctx.getWebSockets("host")) {
        if (other !== ws) {
          try { other.close(4001, "replaced"); } catch {}
        }
      }
      await this.ctx.storage.setAlarm(room.created + MAX_LIFE_MS);
      ws.send(head({ t: "ready", viewers: this.viewerCount(), fresh: room.order.length === 0 }));
      this.toViewers(head({ t: "host", on: true }));
    } else {
      ws.send(head({ t: "hello", order: room.order, pages: this.pageMeta(), cur: room.cur, host: this.hostOnline() }));
      this.toHost(head({ t: "viewers", n: this.viewerCount() }));
    }
  }

  // ---------- eventos de socket ----------

  async message(ws, raw) {
    if (typeof raw !== "string" || raw.length > MAX_MSG) return;
    const room = await this.load();
    if (!room) return;
    const nl = raw.indexOf("\n");
    let h;
    try {
      h = JSON.parse(nl < 0 ? raw : raw.slice(0, nl));
    } catch {
      return;
    }
    const body = nl < 0 ? "" : raw.slice(nl + 1);
    const role = (ws.deserializeAttachment() || {}).role;

    if (role !== "host") {
      if (h.t === "get" && typeof h.id === "string") this.sendPage(ws, h.id);
      return;
    }

    switch (h.t) {
      case "live": // traço em andamento, laser: só retransmite
        this.toViewers(raw);
        break;
      case "op": // alteração definitiva em uma página
        if (typeof h.pg !== "string") return;
        this.sql.exec("INSERT INTO ops (pg, body) VALUES (?, ?)", h.pg, body);
        this.toViewers(raw);
        break;
      case "page": // nova página (o corpo é a imagem de fundo, se houver)
        if (typeof h.id !== "string") return;
        this.sql.exec(
          "INSERT OR REPLACE INTO pages (id, w, h, bg) VALUES (?, ?, ?, ?)",
          h.id, +h.w || 1000, +h.h || 1414, body
        );
        this.toViewers(head({ t: "page", id: h.id, w: +h.w || 1000, h: +h.h || 1414 }));
        break;
      case "order":
        if (!Array.isArray(h.ids)) return;
        room.order = h.ids.filter((x) => typeof x === "string").slice(0, 2000);
        await this.save();
        this.toViewers(head({ t: "order", ids: room.order }));
        break;
      case "cur":
        room.cur = typeof h.id === "string" ? h.id : null;
        await this.save();
        this.toViewers(head({ t: "cur", id: room.cur }));
        break;
      case "delpage":
        if (typeof h.id !== "string") return;
        this.sql.exec("DELETE FROM pages WHERE id = ?", h.id);
        this.sql.exec("DELETE FROM ops WHERE pg = ?", h.id);
        this.toViewers(head({ t: "delpage", id: h.id }));
        break;
      case "reset":
        this.sql.exec("DELETE FROM pages");
        this.sql.exec("DELETE FROM ops");
        room.order = [];
        room.cur = null;
        await this.save();
        this.toViewers(head({ t: "reset" }));
        break;
      case "end":
        await this.end();
        break;
    }
  }

  async closed(ws) {
    const role = (ws.deserializeAttachment() || {}).role;
    const room = await this.load();
    if (!room) return;
    if (role === "host") {
      const others = this.ctx.getWebSockets("host").filter((s) => s !== ws);
      if (others.length === 0) {
        this.toViewers(head({ t: "host", on: false }));
        await this.ctx.storage.setAlarm(Date.now() + HOST_GRACE_MS);
      }
    } else {
      this.toHost(head({ t: "viewers", n: this.viewerCount(ws) }));
    }
  }

  async alarm() {
    const room = await this.load();
    if (!room) return;
    const expired = Date.now() >= room.created + MAX_LIFE_MS;
    if (!this.hostOnline() || expired) await this.end();
    else await this.ctx.storage.setAlarm(room.created + MAX_LIFE_MS);
  }

  // ---------- auxiliares ----------

  hostOnline() {
    return this.ctx.getWebSockets("host").length > 0;
  }

  viewerCount(except) {
    let n = 0;
    for (const s of this.ctx.getWebSockets("viewer")) if (s !== except) n++;
    return n;
  }

  pageMeta() {
    return this.sql.exec("SELECT id, w, h FROM pages").toArray();
  }

  toViewers(msg) {
    for (const s of this.ctx.getWebSockets("viewer")) {
      try { s.send(msg); } catch {}
    }
  }

  toHost(msg) {
    for (const s of this.ctx.getWebSockets("host")) {
      try { s.send(msg); } catch {}
    }
  }

  // Envia a um espectador tudo o que já existe em uma página.
  sendPage(ws, id) {
    const rows = this.sql.exec("SELECT id, w, h, bg FROM pages WHERE id = ?", id).toArray();
    if (!rows.length) {
      ws.send(head({ t: "nopage", id }));
      return;
    }
    const p = rows[0];
    ws.send(head({ t: "pagedata", id, w: p.w, h: p.h }, p.bg || ""));
    let buf = [];
    let size = 0;
    for (const row of this.sql.exec("SELECT body FROM ops WHERE pg = ? ORDER BY seq", id)) {
      buf.push(row.body);
      size += row.body.length;
      if (size >= CHUNK) {
        ws.send(head({ t: "ops", pg: id }, buf.join("\n")));
        buf = [];
        size = 0;
      }
    }
    if (buf.length) ws.send(head({ t: "ops", pg: id }, buf.join("\n")));
    ws.send(head({ t: "pageend", id }));
  }

  async end() {
    const msg = head({ t: "ended" });
    for (const s of this.ctx.getWebSockets()) {
      try { s.send(msg); } catch {}
      try { s.close(4004, "ended"); } catch {}
    }
    this.room = null;
    try { await this.ctx.storage.deleteAlarm(); } catch {}
    await this.ctx.storage.deleteAll();
  }
}
