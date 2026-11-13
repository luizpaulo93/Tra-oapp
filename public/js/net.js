// Comunicação com o servidor: login, criação de transmissão e a conexão
// ao vivo (apresentador e espectador).

const SESSION_KEY = "traco.session";

export function session() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY)) || null; } catch { return null; }
}
export function setSession(s) {
  try {
    if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else localStorage.removeItem(SESSION_KEY);
  } catch {}
}

export async function api(path, body, method) {
  const s = session();
  let r;
  try {
    r = await fetch(path, {
      method: method || (body ? "POST" : "GET"),
      headers: { "content-type": "application/json", ...(s ? { authorization: "Bearer " + s.token } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    const e = new Error("Sem conexão com o servidor. Confira a internet e tente de novo.");
    e.offline = true;
    throw e;
  }
  let data = {};
  try { data = await r.json(); } catch {}
  if (!r.ok) {
    const e = new Error(data.message || "Algo deu errado. Tente de novo.");
    e.status = r.status;
    e.code = data.error;
    throw e;
  }
  return data;
}

function wsUrl(code, key) {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/api/rooms/${code}/ws${key ? "?key=" + key : ""}`;
}

const pack = (h, body) => JSON.stringify(h) + "\n" + (body === undefined ? "" : body);

function unpack(raw) {
  const nl = raw.indexOf("\n");
  try {
    return [JSON.parse(nl < 0 ? raw : raw.slice(0, nl)), nl < 0 ? "" : raw.slice(nl + 1)];
  } catch {
    return [null, ""];
  }
}

// Conexão base com reconexão automática.
class Link {
  constructor(code, key) {
    this.code = code;
    this.key = key || "";
    this.ws = null;
    this.closed = false;
    this.tries = 0;
    this.state = "connecting";
    this.onState = () => {};
    this.onMessage = () => {};
    this.onEnded = () => {};
    this.onOpen = () => {};
  }

  connect() {
    if (this.closed) return;
    const ws = new WebSocket(wsUrl(this.code, this.key));
    this.ws = ws;
    ws.onopen = () => {
      this.tries = 0;
      this.setState("open");
      clearInterval(this.pinger);
      this.pinger = setInterval(() => { if (ws.readyState === 1) ws.send("ping"); }, 25000);
      if (this.flush) this.flush();
      this.onOpen();
    };
    ws.onmessage = (ev) => {
      if (ev.data === "pong") return;
      const [h, body] = unpack(ev.data);
      if (!h) return;
      if (h.t === "ended") { this.finish(); return; }
      this.onMessage(h, body);
    };
    ws.onclose = (ev) => {
      clearInterval(this.pinger);
      if (this.closed || this.ws !== ws) return;
      if (ev.code === 4004) { this.finish(); return; }
      if (ev.code === 4001) { this.closed = true; this.setState("replaced"); return; }
      this.setState("reconnecting");
      this.retry();
    };
    ws.onerror = () => {};
  }

  async retry() {
    const wait = Math.min(8000, 600 * 2 ** this.tries++);
    await new Promise((r) => setTimeout(r, wait));
    if (this.closed) return;
    try {
      const r = await fetch(`/api/rooms/${this.code}`, { cache: "no-store" });
      if (r.status === 404) { this.finish(); return; }
    } catch {
      // sem internet: continua tentando
      this.retry();
      return;
    }
    this.connect();
  }

  setState(s) {
    this.state = s;
    this.onState(s);
  }

  finish() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.pinger);
    try { this.ws.close(); } catch {}
    this.setState("ended");
    this.onEnded();
  }

  close() {
    this.closed = true;
    clearInterval(this.pinger);
    try { this.ws.close(); } catch {}
  }

  get isOpen() { return this.ws && this.ws.readyState === 1; }
}

export class HostLink extends Link {
  constructor(code, key) {
    super(code, key);
    this.queue = [];
  }

  // Ao reconectar, envia primeiro o que ficou guardado.
  flush() {
    const q = this.queue;
    this.queue = [];
    for (const m of q) this.ws.send(m);
  }

  // Envia; se a conexão caiu, guarda para enviar ao reconectar
  // (menos os traços "em andamento", que perdem o sentido).
  send(h, body) {
    const msg = pack(h, body);
    if (this.isOpen) this.ws.send(msg);
    else if (h.t !== "live") this.queue.push(msg);
  }

  buffered() { return this.isOpen ? this.ws.bufferedAmount : 0; }

  end() {
    if (this.isOpen) this.ws.send(pack({ t: "end" }));
    this.close();
  }
}

export class ViewerLink extends Link {
  get(id) {
    if (this.isOpen) this.ws.send(pack({ t: "get", id }));
  }
}

export async function roomIsLive(code) {
  const r = await fetch(`/api/rooms/${code}`, { cache: "no-store" });
  return r.ok;
}
