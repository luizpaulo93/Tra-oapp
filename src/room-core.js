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
const PART_MSGS = 8; // mensagens grandes que podem estar chegando em pedaços ao mesmo tempo
const KEEP_MS = 5 * 60 * 1000; // depois de encerrada, quem assistiu tem 5 minutos para baixar o PDF da aula
const KEEP_SLACK_MS = 20 * 1000; // folga para um download que começou no último instante terminar
const BG_MAX = 128 * 1024; // maior pedaço de imagem que o espectador pode pedir
const BG_CHUNK = 32 * 1024; // pedaço de imagem entregue a cada pedido do espectador

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

  // Tabela de apoio para conexões lentas — fulls: imagem da página em qualidade
  // média ("m:id") e total ("id"). A tabela `pages` guarda só uma prévia leve,
  // que aparece na hora para quem assiste.
  ensureExtra() {
    if (this.extra) return;
    this.sql.exec("CREATE TABLE IF NOT EXISTS fulls (id TEXT PRIMARY KEY, bg TEXT)");
    this.extra = true;
  }

  // Pedaços de uma mensagem grande do apresentador, que chega aos poucos para
  // não travar os traços ao vivo. Ficam só na memória (sem gastar gravações no
  // banco); se algo se perder, o apresentador é avisado e reenvia.
  // Devolve a mensagem inteira (chegou o último pedaço), undefined (ainda
  // faltam pedaços) ou null (perdeu-se algum: precisa reenviar).
  takePart(mid, n, body, last) {
    const all = this.partBuf || (this.partBuf = new Map());
    let m = all.get(mid);
    if (!m) {
      if (n !== 0) return null; // o começo se perdeu
      while (all.size >= PART_MSGS) all.delete(all.keys().next().value);
      m = { list: [], size: 0 };
      all.set(mid, m);
    }
    if (n < m.list.length) return undefined; // repetido
    if (n > m.list.length || m.size + body.length > MAX_MSG + 4096) { all.delete(mid); return null; }
    m.list.push(body);
    m.size += body.length;
    if (!last) return undefined;
    all.delete(mid);
    return m.list.join("");
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
    // pk: senha do PDF. Quem assiste a recebe ao entrar e só com ela baixa o
    // PDF depois do fim; como fica só na memória da página, atualizar a tela a perde.
    this.room = { code, key: randomKey(), pk: randomKey(), created: Date.now(), cur: null, order: [] };
    await this.save();
    await this.ctx.storage.setAlarm(Date.now() + HOST_GRACE_MS);
    return { ok: true, key: this.room.key };
  }

  async status(key) {
    const room = await this.load();
    if (!room) return { live: false };
    if (room.ended) return { live: false, pdf: true }; // fora do ar; quem assistiu ainda pode baixar o PDF
    return { live: true, host: !!key && key === room.key };
  }

  // Decide se uma conexão pode entrar. Retorna o papel ou null.
  async admit(key, pk) {
    const room = await this.load();
    if (!room) return null;
    if (key) return key === room.key && !room.ended ? "host" : null;
    // depois de encerrada, só entra (para baixar o PDF) quem estava assistindo
    if (room.ended) return room.pk && pk === room.pk ? "viewer" : null;
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
      ws.send(head({ t: "hello", order: room.order, pages: this.pageMeta(), cur: room.cur, host: this.hostOnline(), pk: room.pk }));
      if (room.ended) ws.send(head({ t: "ended", pdf: 1, left: Math.max(0, room.ended + KEEP_MS - Date.now()) }));
      else this.toHost(head({ t: "viewers", n: this.viewerCount() }));
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
    if (room.ended && role === "host") return;

    if (role !== "host") {
      if (typeof h.id !== "string") return;
      if (h.t === "get") this.sendPage(ws, h.id, !!h.nobg);
      else if (h.t === "getbg") this.sendBg(ws, h.id, h.q, h.o, h.n);
      return;
    }

    switch (h.t) {
      case "part": { // pedaço de uma mensagem grande
        if (typeof h.mid !== "string" || h.mid.length > 40 || !Number.isInteger(h.n) || h.n < 0 || h.n > 4000) return;
        const whole = this.takePart(h.mid, h.n, body, !!h.last);
        // confirma o recebimento: é por essas confirmações que o apresentador
        // mede a velocidade da conexão e dosa o envio
        ws.send(head({ t: "pa", mid: h.mid, n: h.n }));
        if (whole === undefined) return;
        if (whole === null) { ws.send(head({ t: "partfail", mid: h.mid })); return; } // faltou pedaço: reenviar
        await this.message(ws, whole);
        ws.send(head({ t: "partok", mid: h.mid }));
        break;
      }
      case "partdrop": // o apresentador reconectou: descarta envios pela metade
        this.partBuf = null;
        break;
      case "bg": { // imagem da página: q "m" = qualidade média (chega logo), "f" = total
        if (typeof h.id !== "string") return;
        this.ensureExtra();
        const q = h.q === "m" ? "m" : "f";
        this.sql.exec("INSERT OR REPLACE INTO fulls (id, bg) VALUES (?, ?)", (q === "m" ? "m:" : "") + h.id, body);
        if (q === "f") this.sql.exec("DELETE FROM fulls WHERE id = ?", "m:" + h.id); // a média não é mais necessária
        this.toViewers(head({ t: "bg", id: h.id, q, total: body.length }));
        break;
      }
      case "live": // traço em andamento, laser: só retransmite
        this.toViewers(raw);
        break;
      case "op": // alteração definitiva em uma página
        if (typeof h.pg !== "string") return;
        this.sql.exec("INSERT INTO ops (pg, body) VALUES (?, ?)", h.pg, body);
        this.toViewers(raw);
        break;
      case "page": // nova página (o corpo é uma prévia leve da imagem de fundo, se houver)
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
        this.ensureExtra();
        this.sql.exec("DELETE FROM pages WHERE id = ?", h.id);
        this.sql.exec("DELETE FROM ops WHERE pg = ?", h.id);
        this.sql.exec("DELETE FROM fulls WHERE id = ? OR id = ?", h.id, "m:" + h.id);
        this.toViewers(head({ t: "delpage", id: h.id }));
        break;
      case "reset":
        this.ensureExtra();
        this.sql.exec("DELETE FROM pages");
        this.sql.exec("DELETE FROM ops");
        this.sql.exec("DELETE FROM fulls");
        this.partBuf = null;
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
    if (!room || room.ended) return;
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
    if (room.ended) { // já encerrada: apaga tudo quando acabar o prazo do PDF
      if (Date.now() >= room.ended + KEEP_MS + KEEP_SLACK_MS - 1000) await this.purge();
      else await this.ctx.storage.setAlarm(room.ended + KEEP_MS + KEEP_SLACK_MS);
      return;
    }
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

  // Envia a um espectador tudo o que já existe em uma página. A imagem vai
  // como prévia leve, que aparece na hora; `med` e `full` dizem o tamanho das
  // versões em qualidade média e total, que o espectador busca aos poucos
  // (sendBg). Com `nobg`, ele já tem uma imagem melhor guardada.
  sendPage(ws, id, nobg) {
    const rows = this.sql.exec("SELECT id, w, h, bg FROM pages WHERE id = ?", id).toArray();
    if (!rows.length) {
      ws.send(head({ t: "nopage", id }));
      return;
    }
    this.ensureExtra();
    const p = rows[0];
    const len = (key) => {
      const r = this.sql.exec("SELECT length(bg) AS n FROM fulls WHERE id = ?", key).toArray()[0];
      return r ? Number(r.n) : 0;
    };
    ws.send(head({ t: "pagedata", id, w: p.w, h: p.h, med: len("m:" + id), full: len(id), nobg: nobg ? 1 : 0 }, nobg ? "" : p.bg || ""));
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

  // Um pedaço da imagem (média ou total). O espectador pede um por vez, no
  // ritmo da conexão dele, e os traços ao vivo passam entre um pedaço e outro.
  sendBg(ws, id, q, o, n) {
    this.ensureExtra();
    q = q === "m" ? "m" : "f";
    o = Math.max(0, Math.floor(+o || 0));
    n = Math.min(BG_MAX, Math.max(4096, Math.floor(+n || BG_CHUNK))); // do tamanho que o espectador pedir
    const r = this.sql.exec("SELECT length(bg) AS n, substr(bg, ?, ?) AS part FROM fulls WHERE id = ?", o + 1, n, (q === "m" ? "m:" : "") + id).toArray()[0];
    ws.send(head({ t: "bgpart", id, q, o, total: r ? Number(r.n) : 0 }, r ? r.part : ""));
  }

  // A transmissão acabou (o apresentador encerrou, sumiu ou passou do tempo
  // máximo). Ela sai do ar na hora, mas as páginas ficam guardadas por 5
  // minutos para quem assistiu baixar o PDF da aula; depois, tudo é apagado.
  async end() {
    const room = await this.load();
    if (!room) return;
    if (room.ended || !room.order.length) { await this.purge(); return; } // nada a guardar
    room.ended = Date.now();
    await this.save();
    this.partBuf = null;
    const msg = head({ t: "ended", pdf: 1, left: KEEP_MS });
    for (const s of this.ctx.getWebSockets("host")) {
      try { s.send(msg); } catch {}
      try { s.close(4004, "ended"); } catch {}
    }
    this.toViewers(msg); // quem assiste continua conectado só para baixar o PDF
    await this.ctx.storage.setAlarm(room.ended + KEEP_MS + KEEP_SLACK_MS);
  }

  async purge() {
    const msg = head({ t: "ended" });
    for (const s of this.ctx.getWebSockets()) {
      try { s.send(msg); } catch {}
      try { s.close(4004, "ended"); } catch {}
    }
    this.room = null;
    this.extra = false;
    this.partBuf = null;
    try { await this.ctx.storage.deleteAlarm(); } catch {}
    await this.ctx.storage.deleteAll();
  }
}
