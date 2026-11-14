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

const PING_MS = 8000; // intervalo do sinal de vida
const MAX_SILENT = 2; // sinais sem resposta até dar a conexão por perdida

// Conexão base com reconexão automática. Além de reagir quando o navegador
// avisa que a conexão caiu, vigia a conexão que "morre em silêncio" (comum
// em rede móvel): sem resposta a dois sinais seguidos, reconecta sozinha.
class Link {
  constructor(code, key) {
    this.code = code;
    this.key = key || "";
    this.ws = null;
    this.closed = false;
    this.tries = 0;
    this.silent = 0;
    this.state = "connecting";
    this.onState = () => {};
    this.onMessage = () => {};
    this.onEnded = () => {};
    this.onOpen = () => {};
    // voltou a internet, ou a aba voltou para a frente: confere na hora
    this.wake = () => {
      if (this.closed || !this.started || document.visibilityState === "hidden") return;
      const ws = this.ws;
      if (!ws || ws.readyState > 1) { this.retry(true); return; }
      if (ws.readyState !== 1) return;
      const seen = this.rx;
      try { ws.send("ping"); } catch {}
      setTimeout(() => { if (this.ws === ws && this.rx === seen) this.dropped(ws, 0); }, 5000);
    };
    window.addEventListener("online", this.wake);
    document.addEventListener("visibilitychange", this.wake);
  }

  connect() {
    if (this.closed) return;
    this.started = true;
    const ws = new WebSocket(wsUrl(this.code, this.key));
    this.ws = ws;
    this.rx = 0; // contador de mensagens recebidas nesta conexão
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.tries = 0;
      this.silent = 0;
      this.setState("open");
      clearInterval(this.pinger);
      this.pinger = setInterval(() => {
        if (this.ws !== ws || ws.readyState !== 1) return;
        if (this.silent >= MAX_SILENT) { this.dropped(ws, 0); return; }
        this.silent++;
        try { ws.send("ping"); } catch {}
      }, PING_MS);
      if (this.flush) this.flush();
      this.onOpen();
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      this.silent = 0;
      this.rx++;
      if (ev.data === "pong") return;
      const [h, body] = unpack(ev.data);
      if (!h) return;
      if (h.t === "ended") { this.finish(); return; }
      this.onMessage(h, body);
    };
    ws.onclose = (ev) => this.dropped(ws, ev.code);
    ws.onerror = () => {};
  }

  // A conexão caiu (ou foi dada por perdida): tenta de novo.
  dropped(ws, code) {
    if (this.closed || this.ws !== ws) return;
    clearInterval(this.pinger);
    if (code === 4004) { this.finish(); return; }
    if (code === 4001) { this.closed = true; this.unhook(); this.setState("replaced"); return; }
    this.ws = null;
    ws.onopen = ws.onmessage = ws.onclose = null;
    try { ws.close(); } catch {}
    this.setState("reconnecting");
    this.retry();
  }

  async retry(now) {
    if (now && this.skipWait) { this.skipWait(); return; }
    if (this.retrying) return;
    this.retrying = true;
    try {
      for (;;) {
        if (!now) {
          const wait = Math.min(6000, 500 * 2 ** this.tries++);
          await new Promise((r) => { this.skipWait = r; setTimeout(r, wait); });
          this.skipWait = null;
        }
        now = false;
        if (this.closed || this.ws) return;
        try {
          const r = await fetch(`/api/rooms/${this.code}`, { cache: "no-store" });
          if (r.status === 404) { this.finish(); return; }
        } catch {
          continue; // sem internet: continua tentando
        }
        if (this.closed || this.ws) return;
        this.connect();
        return;
      }
    } finally {
      this.retrying = false;
    }
  }

  setState(s) {
    this.state = s;
    this.onState(s);
  }

  unhook() {
    clearInterval(this.pinger);
    window.removeEventListener("online", this.wake);
    document.removeEventListener("visibilitychange", this.wake);
  }

  finish() {
    if (this.closed) return;
    this.closed = true;
    this.unhook();
    try { this.ws.close(); } catch {}
    this.setState("ended");
    this.onEnded();
  }

  close() {
    this.closed = true;
    this.unhook();
    try { this.ws.close(); } catch {}
  }

  get isOpen() { return !!this.ws && this.ws.readyState === 1; }
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

  // Quanto ainda está esperando para sair deste aparelho (bytes).
  buffered() { return this.isOpen ? this.ws.bufferedAmount : 0; }

  end() {
    if (this.isOpen) this.ws.send(pack({ t: "end" }));
    this.close();
  }
}

const PART = 16 * 1024; // maior pedaço
const PART_MIN = 2 * 1024; // menor pedaço (conexões muito lentas)
const clampN = (v, a, b) => (v < a ? a : v > b ? b : v);

// Envio de coisas pesadas (imagens de página, fotos, lotes de traços) sem
// travar a escrita ao vivo. Tudo passa pela mesma conexão, que entrega em
// ordem: uma imagem de 500 KB enviada de uma vez deixaria cada traço preso
// atrás dela por vários segundos numa internet lenta.
//
// Aqui o conteúdo pesado sai em pedaços pequenos e o servidor confirma cada
// pedaço. O tempo de cada confirmação mostra se a conexão está dando conta:
// se as confirmações demoram, a dose diminui; se vêm rápido, aumenta. Assim,
// só fica "a caminho" o que a conexão entrega em uma fração de segundo, e um
// traço nunca espera mais do que isso. Enquanto o apresentador escreve, a
// dose é ainda menor.
//
// A fila tem prioridades (a página aberta vem antes das outras; imagem em
// qualidade média antes da total). Um item mais urgente interrompe o que
// está sendo enviado, que depois continua de onde parou. O servidor confirma
// cada item inteiro; o que não chegar é reenviado.
export class BulkSender {
  // busy(): o apresentador está escrevendo agora?
  // pri(job): prioridade do item (menor = mais urgente)
  constructor(link, busy, pri) {
    this.link = link;
    this.busy = busy;
    this.pri = pri || (() => 0);
    this.queue = []; // itens: { key, pg?, cls?, ids?, make: async () => [cabeçalho, corpo] | null, done?: () => void }
    this.cur = null;
    this.loading = false;
    this.loadingJob = null;
    this.gen = 0; // muda quando a fila é zerada
    this.waiting = new Map(); // enviados inteiros, aguardando confirmação
    this.flight = []; // pedaços a caminho: { mid, n, size, t }
    this.unacked = 0; // bytes a caminho
    this.win = 8 * 1024; // quanto pode ficar a caminho (ajustado o tempo todo)
    this.base = Infinity; // menor tempo de confirmação visto (ida e volta)
    this.baseAt = 0;
    this.rate = 0; // velocidade medida (bytes/s)
    this.acks = 0;
    this.lastAck = 0;
    this.seq = 0;
    this.timer = setInterval(() => this.tick(), 40);
  }

  get size() { return this.queue.length + (this.cur ? 1 : 0) + (this.loading ? 1 : 0); }

  // A conexão é rápida? (dispensa a etapa de qualidade média)
  fast() { return this.acks >= 6 && this.rate > 150000; }

  // Há algum item (na fila, sendo preparado ou a caminho) que atende ao teste?
  has(test) {
    return this.queue.some(test) || (!!this.cur && test(this.cur.job)) || (!!this.loadingJob && test(this.loadingJob));
  }

  add(jobs) {
    this.queue.push(...[].concat(jobs));
    this.sort();
  }

  // Reordena pela prioridade (mantendo a ordem de chegada entre iguais).
  sort() {
    for (const j of this.queue) j.p = this.pri(j);
    this.queue = this.queue.map((j, i) => [j, i]).sort((x, y) => x[0].p - y[0].p || x[1] - y[1]).map((x) => x[0]);
  }

  tick() {
    const link = this.link;
    if (this.stopped || !link.isOpen) return;
    const busy = this.busy();
    const win = busy ? Math.max(PART_MIN, this.win * 0.35) : this.win;
    // algo mais urgente chegou: o envio atual dá a vez e continua depois
    if (this.cur && this.queue.length && this.queue[0].p < this.pri(this.cur.job)) {
      const c = this.cur;
      c.job.resume = c;
      this.cur = null;
      this.add(c.job);
    }
    let budget = 8;
    while (budget-- > 0 && link.ws.bufferedAmount <= PART) {
      if (!this.cur) {
        if (this.loading) return;
        const job = this.queue.shift();
        if (!job) return;
        if (job.resume) { this.cur = job.resume; job.resume = null; continue; }
        this.loading = true;
        this.loadingJob = job;
        const gen = this.gen;
        Promise.resolve().then(() => job.make()).then(
          (m) => {
            this.loading = false;
            this.loadingJob = null;
            if (this.stopped || gen !== this.gen) return; // a fila foi zerada no meio do caminho
            if (!m) { if (job.done) job.done(); return; } // não há mais o que enviar
            this.cur = { job, msg: pack(m[0], m[1]), off: 0, n: 0, mid: `${Date.now().toString(36)}-${++this.seq}` };
          },
          () => { this.loading = false; this.loadingJob = null; }
        );
        return;
      }
      const c = this.cur;
      const want = clampN(Math.floor(win), PART_MIN, busy ? 4096 : PART);
      if (this.unacked > 0 && this.unacked + want > win) return; // espera confirmações
      let end = Math.min(c.msg.length, c.off + want);
      // não parte um caractere composto ao meio
      if (end < c.msg.length && (c.msg.charCodeAt(end - 1) & 0xfc00) === 0xd800) end--;
      const last = end >= c.msg.length;
      const size = end - c.off;
      link.ws.send(pack({ t: "part", mid: c.mid, n: c.n, last: last ? 1 : 0 }, c.msg.slice(c.off, end)));
      this.flight.push({ mid: c.mid, n: c.n, size, t: performance.now() });
      this.unacked += size;
      c.n++;
      c.off = end;
      if (last) { this.waiting.set(c.mid, c.job); this.cur = null; }
    }
  }

  // O servidor confirmou um pedaço: libera espaço e ajusta a dose.
  partAck(mid, n) {
    const i = this.flight.findIndex((f) => f.mid === mid && f.n === n);
    if (i < 0) return;
    const now = performance.now();
    for (const f of this.flight.splice(0, i + 1)) {
      this.unacked -= f.size;
      const delay = now - f.t; // tempo até a confirmação deste pedaço
      if (delay < this.base || now - this.baseAt > 30000) { this.base = delay; this.baseAt = now; }
      // meta: no máximo ~1/4 de segundo de fila além do tempo normal de ida e volta
      if (delay > this.base + 260) this.win = Math.max(PART_MIN, this.win * 0.7);
      else if (delay < this.base + 140) this.win = Math.min(192 * 1024, this.win + Math.max(1024, f.size / 2));
      const dt = Math.max(30, now - Math.max(f.t, this.lastAck)) / 1000;
      const r = f.size / dt;
      this.rate = this.rate ? this.rate * 0.8 + r * 0.2 : r;
      this.acks++;
    }
    if (this.unacked < 0) this.unacked = 0;
    this.lastAck = now;
    this.tick();
  }

  // Resposta do servidor: o item chegou inteiro (ok) ou faltou pedaço (reenvia).
  ack(mid, ok) {
    const job = this.waiting.get(mid);
    if (job) {
      this.waiting.delete(mid);
      if (ok) { if (job.done) job.done(); } else this.again(job);
      return;
    }
    if (ok) return;
    // faltou pedaço de um envio ainda em andamento (ou pausado): recomeça
    if (this.cur && this.cur.mid === mid) {
      const j = this.cur.job;
      this.cur = null;
      this.again(j);
    }
    for (const j of this.queue) if (j.resume && j.resume.mid === mid) j.resume = null;
  }

  // Reenvia um item que não chegou inteiro; depois de algumas tentativas,
  // desiste dele para não ocupar a conexão para sempre.
  again(job) {
    job.fails = (job.fails || 0) + 1;
    if (job.fails > 4) { if (job.done) job.done(); return; }
    this.add(job);
  }

  // A conexão caiu e voltou: o que estava a caminho recomeça do início.
  restart() {
    const redo = [...this.waiting.values()];
    this.waiting.clear();
    if (this.cur) { redo.push(this.cur.job); this.cur = null; }
    for (const j of this.queue) j.resume = null;
    this.flight = [];
    this.unacked = 0;
    this.win = 8 * 1024;
    this.link.send({ t: "partdrop" });
    this.add(redo);
  }

  clear() {
    this.queue = [];
    this.cur = null;
    this.gen++;
    this.waiting.clear();
    this.flight = [];
    this.unacked = 0;
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    this.clear();
  }
}

export class ViewerLink extends Link {
  // Pede uma página. `nobg`: a imagem dela já está guardada aqui.
  get(id, nobg) {
    if (this.isOpen) this.ws.send(pack(nobg ? { t: "get", id, nobg: 1 } : { t: "get", id }));
  }

  // Pede o próximo pedaço da imagem (q: "m" = qualidade média, "f" = total).
  getBg(id, q, o, n) {
    if (this.isOpen) this.ws.send(pack({ t: "getbg", id, q, o, n }));
    return this.isOpen;
  }
}

export async function roomIsLive(code) {
  const r = await fetch(`/api/rooms/${code}`, { cache: "no-store" });
  return r.ok;
}
