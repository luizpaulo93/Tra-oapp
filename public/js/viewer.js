// Tela de quem assiste: mostra a página do apresentador em tempo real.
// Só leitura: dá para aproximar, arrastar e folhear, nunca escrever.

import { Board } from "./board.js";
import * as ink from "./ink.js";
import { ViewerLink } from "./net.js";
import { h, icon, formatCode, toast, toggleFullscreen, fullscreenButton } from "./ui.js";

export class Viewer {
  constructor(root, code, opts) {
    this.root = root;
    this.code = code;
    this.onExit = opts.onExit;
    this.pages = new Map(); // id -> { id, w, h, items, bg, state: 'none'|'req'|'ok' }
    this.order = [];
    this.cur = null; // página do apresentador
    this.showing = null; // página na tela
    this.follow = true; // acompanha a página do apresentador
    this.followView = true; // acompanha o zoom/região do apresentador
    this.hostView = null; // { pg, r:[x0,y0,x1,y1] }
    this.hostOn = true;
    // Imagens de página em qualidade total: chegam aos poucos, depois da
    // prévia leve, e ficam guardadas (uma queda de conexão não as baixa de novo).
    this.imgCache = new Map(); // id -> { q: "m" (média) | "f" (total), bg }
    this.partial = new Map(); // "q:id" -> { total, parts, got } (download em andamento)
    this.dlBusy = null;
    this.lastLive = 0;

    root.innerHTML = `
      <div class="viewer">
        <div class="stage"></div>
        <div class="v-top">
          <span class="v-live"><span class="live-dot"></span><span data-status>Ao vivo</span></span>
          <span class="v-code">${formatCode(code)}</span>
          <span class="bar-gap"></span>
          <button class="ib is-dark" data-a="fit" title="Ajustar à tela" aria-label="Ajustar à tela">${icon("fit", 20)}</button>
          <button class="ib is-dark" data-a="full" title="Tela cheia" aria-label="Tela cheia">${icon("full", 20)}</button>
          <button class="ib is-dark" data-a="exit" title="Sair" aria-label="Sair da transmissão">${icon("x", 20)}</button>
        </div>
        <div class="v-bottom">
          <button class="ib is-dark is-small" data-a="prev" aria-label="Página anterior">${icon("back", 18)}</button>
          <span class="v-page" data-page></span>
          <button class="ib is-dark is-small" data-a="next" aria-label="Próxima página">${icon("next", 18)}</button>
          <button class="chip is-live" data-a="follow" hidden>Voltar ao vivo</button>
        </div>
        <div class="v-msg" data-msg hidden></div>
      </div>`;
    const q = (s) => root.querySelector(s);
    this.elStatus = q("[data-status]");
    this.elPage = q("[data-page]");
    this.elFollow = q('[data-a="follow"]');
    this.elMsg = q("[data-msg]");
    this.elLive = q(".v-live");
    this.board = new Board(q(".stage"), {
      readonly: true, fit: "contain", insetTop: 58, insetBottom: 54,
      // se a pessoa mexer no zoom por conta própria, para de acompanhar
      onView: (v, user) => {
        if (!user) return;
        this.lastManual = performance.now();
        if (this.followView) { this.followView = false; this.updatePager(); }
      },
    });

    q(".viewer").addEventListener("click", (e) => {
      const b = e.target.closest("[data-a]");
      if (!b || this.dead) return;
      const a = b.dataset.a;
      if (a === "exit") this.exit();
      else if (a === "fit") { this.followView = false; this.board.fitView(); this.updatePager(); }
      else if (a === "full") this.fullscreen();
      else if (a === "prev") this.browse(-1);
      else if (a === "next") this.browse(1);
      else if (a === "follow") { this.follow = true; this.followView = true; this.show(this.cur); }
    });

    const link = new ViewerLink(code);
    this.link = link;
    link.onMessage = (m, body) => this.message(m, body);
    link.onState = (s) => this.status(s);
    link.onEnded = () => this.ended();
    link.connect();
    this.status("connecting");
    this.onResize = () => { clearTimeout(this.rsz); this.rsz = setTimeout(() => this.applyHostView(false), 180); };
    window.addEventListener("resize", this.onResize);
  }

  destroy() {
    if (this.dead) return;
    this.dead = true;
    window.removeEventListener("resize", this.onResize);
    clearTimeout(this.rsz);
    clearTimeout(this.dlTimer);
    cancelAnimationFrame(this.anim);
    this.link.close();
    this.board.destroy();
    if (document.fullscreenElement || document.webkitFullscreenElement) toggleFullscreen();
  }

  exit() {
    this.onExit(); // a troca de tela chama destroy()
  }

  fullscreen() {
    fullscreenButton();
  }

  status(s) {
    const wait = s !== "open";
    this.elLive.classList.toggle("is-wait", wait || !this.hostOn);
    this.elStatus.textContent = s === "open" ? (this.hostOn ? "Ao vivo" : "Apresentador reconectando…") : "Reconectando…";
  }

  ended() {
    this.elLive.classList.add("is-wait");
    this.elStatus.textContent = "Encerrada";
    this.elMsg.hidden = false;
    this.elMsg.innerHTML = `<div class="v-card"><h2>A transmissão foi encerrada</h2><p class="muted">O apresentador finalizou esta transmissão.</p><button class="btn is-primary" data-a="exit">Voltar ao início</button></div>`;
  }

  meta(id) {
    let p = this.pages.get(id);
    if (!p) { p = { id, w: 1000, h: 1414, items: [], state: "none" }; this.pages.set(id, p); }
    return p;
  }

  message(m, body) {
    switch (m.t) {
      case "hello": // (re)conexão: recomeça do zero (as imagens já baixadas ficam)
        this.pages.clear();
        this.dlBusy = null;
        this.order = m.order || [];
        for (const p of m.pages || []) Object.assign(this.meta(p.id), { w: p.w, h: p.h });
        this.cur = m.cur;
        this.hostOn = m.host;
        this.status("open");
        this.showing = null;
        this.show(this.follow || !this.order.includes(this.wanted) ? this.cur : this.wanted);
        break;
      case "reset":
        this.pages.clear();
        this.order = [];
        this.cur = null;
        this.showing = null;
        this.hostView = null;
        this.board.setPage(null);
        this.updatePager();
        break;
      case "host":
        this.hostOn = m.on;
        if (!m.on) { this.board.liveStrokes.clear(); this.board.invalidateLive(); }
        this.status("open");
        break;
      case "order":
        this.order = m.ids;
        if (this.showing && !this.order.includes(this.showing)) { this.follow = true; this.show(this.cur); }
        this.updatePager();
        break;
      case "page": {
        const p = this.meta(m.id);
        p.w = m.w; p.h = m.h;
        if (p.state !== "none") { p.state = "none"; p.items = []; delete p.bg; delete p.bgImg; }
        if (this.wanted === m.id) this.show(m.id, true);
        break;
      }
      case "delpage":
        this.pages.delete(m.id);
        break;
      case "cur":
        this.cur = m.id;
        if (this.follow) this.show(m.id);
        else this.updatePager();
        break;
      case "pagedata": {
        const p = this.meta(m.id);
        // imagem melhor que a prévia, já baixada antes (vale se ainda for a mesma)
        let have = this.imgCache.get(m.id);
        if (have && ((have.q === "f" && m.full && have.bg.length !== m.full) || (have.q === "m" && m.med && have.bg.length !== m.med))) {
          this.imgCache.delete(m.id);
          have = null;
        }
        if (m.nobg && !have) { // a imagem guardada não serve mais: pede a página inteira
          p.state = "req";
          this.link.get(m.id);
          break;
        }
        p.w = m.w; p.h = m.h; p.items = []; p.state = "ok";
        p.med = m.med || 0;
        p.full = m.full || 0;
        const bg = have ? have.bg : body || undefined;
        if (p.bg !== bg) { p.bg = bg; delete p.bgImg; }
        break;
      }
      case "bg": { // uma versão melhor da imagem ficou disponível
        const p = this.pages.get(m.id);
        if (p) {
          if (m.q === "m") p.med = m.total || 0;
          else { p.full = m.total || 0; p.med = 0; }
        }
        if (this.showing === m.id) this.pumpFull();
        break;
      }
      case "bgpart":
        this.gotPart(m, body);
        break;
      case "ops": {
        const p = this.pages.get(m.pg);
        if (!p || p.state !== "ok") break;
        for (const line of body.split("\n")) this.applyOp(p, line);
        break;
      }
      case "pageend":
        if (this.wanted === m.id) this.display(m.id);
        break;
      case "nopage":
        { const p = this.pages.get(m.id); if (p) p.state = "none"; }
        break;
      case "op": {
        const p = this.pages.get(m.pg);
        if (!p || p.state !== "ok") break;
        const op = this.applyOp(p, body);
        if (!op || this.showing !== m.pg) break;
        const b = this.board;
        const put = op.p || [];
        if (!(op.d && op.d.length) && put.length === 1 && put[0].k === "s") {
          b.commitStroke(put[0]); // traço novo: desenha só ele
        } else {
          for (const it of put) b.liveStrokes.delete(it.id);
          b.renderBg(); b.renderInk(); b.drawLive();
        }
        break;
      }
      case "live":
        this.lastLive = performance.now();
        this.live(body);
        break;
    }
  }

  applyOp(p, text) {
    let op;
    try { op = JSON.parse(text); } catch { return null; }
    // foto que só mudou de lugar, tamanho ou giro: a imagem é a que já está aqui
    for (const it of op.p || []) {
      if (it.k !== "i" || it.src || !it.sr) continue;
      const old = p.items.find((x) => x.id === it.id);
      if (old && old.src) it.src = old.src;
      delete it.sr;
    }
    p.items = ink.applyOp(p.items, op.d, op.p);
    return op;
  }

  live(text) {
    let m;
    try { m = JSON.parse(text); } catch { return; }
    if (m.k === "vw") { // enquadramento do apresentador
      if (!Array.isArray(m.r) || m.r.length !== 4) return;
      this.hostView = { pg: m.pg, r: m.r };
      // Quem mexeu no próprio zoom volta a acompanhar sozinho depois de
      // alguns segundos parado, quando o apresentador muda o enquadramento.
      if (!this.followView && this.follow && performance.now() - (this.lastManual || 0) > 6000) {
        this.followView = true;
        this.updatePager();
      }
      this.applyHostView(true);
      return;
    }
    if (m.pg && m.pg !== this.showing) return;
    const b = this.board;
    if (m.k === "sp") {
      let s = b.liveStrokes.get(m.id);
      if (!s) { s = { id: m.id, t: m.t, c: m.c, w: m.w, p: [] }; b.liveStrokes.set(m.id, s); }
      s.g = m.g; s.d = m.d; s.dn = m.dn;
      if (m.r) s.p = m.p; else for (const v of m.p) s.p.push(v);
    } else if (m.k === "sx") {
      b.liveStrokes.delete(m.id);
    } else if (m.k === "lz") {
      const pts = Array.isArray(m.p) ? m.p : [];
      b.laserBegin();
      for (let i = 0; i < pts.length; i += 2) b.laser.push({ x: pts[i], y: pts[i + 1], brk: m.n && i === 0 });
      b.laserDown = !m.e; // "e": o apresentador soltou; some 2 s depois, se não voltar a marcar
    }
    b.invalidateLive();
  }

  // Mostra uma página, pedindo-a ao servidor se ainda não chegou.
  show(id, again) {
    this.wanted = id;
    if (!id) { this.board.setPage(null); this.showing = null; this.updatePager(); this.waiting(true); return; }
    const p = this.meta(id);
    if (p.state === "ok") { this.display(id); return; }
    if (p.state === "none" || again) { p.state = "req"; this.link.get(id, this.imgCache.has(id)); }
    this.waiting(true);
    this.updatePager();
  }

  display(id) {
    const p = this.pages.get(id);
    if (!p) return;
    const same = this.showing === id;
    this.showing = id;
    this.waiting(false);
    this.board.setPage(p, null, same);
    this.applyHostView(false);
    this.updatePager();
    this.pumpFull();
  }

  // Busca, aos poucos, uma versão melhor da imagem da página que está na tela:
  // primeiro a de qualidade média (já boa para ler), depois a total.
  // Um pedaço por vez: os traços ao vivo passam entre um pedaço e outro, e
  // enquanto o apresentador escreve os pedaços são menores e mais espaçados.
  pumpFull() {
    clearTimeout(this.dlTimer);
    if (this.dead || this.dlBusy) return;
    const id = this.showing;
    const p = id && this.pages.get(id);
    if (!p || p.state !== "ok") return;
    const have = this.imgCache.get(id);
    let q = null;
    if (!have && p.med) q = "m";
    else if (p.full && (!have || have.q !== "f")) q = "f";
    if (!q) return;
    const total = q === "m" ? p.med : p.full;
    const key = q + ":" + id;
    let st = this.partial.get(key);
    if (!st || st.total !== total) {
      st = { total, parts: [], got: 0 };
      if (this.partial.size >= 3) this.partial.delete(this.partial.keys().next().value);
      this.partial.set(key, st);
    }
    // cada pedaço deve levar ~0,4 s nesta conexão (menos ainda durante a escrita),
    // para não segurar os traços ao vivo nem a troca de página
    const writing = performance.now() - this.lastLive < 500;
    const fit = this.dlRate ? this.dlRate * (writing ? 0.25 : 0.4) : 8192;
    const n = Math.max(4096, Math.min(writing ? 8192 : 32768, Math.round(fit)));
    if (this.link.getBg(id, q, st.got, n)) {
      this.dlBusy = key;
      this.dlAt = performance.now();
      // se a resposta não vier (conexão ruim), tenta de novo
      this.dlTimer = setTimeout(() => { if (this.dlBusy === key) { this.dlBusy = null; this.pumpFull(); } }, 15000);
    }
  }

  gotPart(m, body) {
    const key = (m.q === "m" ? "m" : "f") + ":" + m.id;
    if (this.dlBusy !== key) return;
    this.dlBusy = null;
    if (body.length >= 2048) { // velocidade de recebimento medida (bytes/s)
      const r = body.length / (Math.max(20, performance.now() - this.dlAt) / 1000);
      this.dlRate = this.dlRate ? this.dlRate * 0.6 + r * 0.4 : r;
    }
    const st = this.partial.get(key);
    if (st && m.total === st.total && m.o === st.got && body.length) {
      st.parts.push(body);
      st.got += body.length;
      if (st.got >= st.total) {
        this.partial.delete(key);
        this.useImage(m.id, m.q === "m" ? "m" : "f", st.parts.join(""));
      }
    } else if (st && (m.total !== st.total || !body.length)) {
      this.partial.delete(key); // a imagem mudou no servidor: recomeça
      const p = this.pages.get(m.id);
      if (p) { if (m.q === "m") p.med = m.total || 0; else p.full = m.total || 0; }
    }
    clearTimeout(this.dlTimer);
    this.dlTimer = setTimeout(() => this.pumpFull(), performance.now() - this.lastLive < 500 ? 200 : 0);
  }

  // Uma versão melhor da imagem chegou: guarda e troca na tela, sem piscar.
  useImage(id, q, bg) {
    const old = this.imgCache.get(id);
    if (old && old.q === "f" && q === "m") return;
    this.imgCache.delete(id);
    this.imgCache.set(id, { q, bg });
    let size = 0;
    for (const v of this.imgCache.values()) size += v.bg.length;
    for (const k of [...this.imgCache.keys()]) { // limite de memória
      if (size <= 24_000_000 || k === id) break;
      size -= this.imgCache.get(k).bg.length;
      this.imgCache.delete(k);
    }
    ink.loadImage(bg).promise.then((im) => {
      const p = this.pages.get(id);
      if (!im || !p || this.dead) return;
      const now = this.imgCache.get(id);
      if (now && now.bg !== bg) return; // já chegou uma versão melhor
      p.bg = bg;
      p.bgImg = im;
      if (this.showing === id) this.board.renderBg();
    });
  }

  // Enquadra nesta tela a mesma região que o apresentador está vendo.
  applyHostView(animate) {
    const hv = this.hostView;
    if (this.dead || !this.followView || !hv || hv.pg !== this.showing) return;
    const t = this.board.rectView(hv.r);
    if (!t) return;
    this.board.atFit = false;
    if (!animate) { cancelAnimationFrame(this.anim); this.anim = 0; this.board.setView(t); return; }
    this.target = t;
    if (this.anim) return;
    let n = 0;
    const step = () => {
      const b = this.board, v = b.view, g = this.target;
      if (this.dead) return;
      if (++n >= 8 || !this.followView) { this.anim = 0; if (this.followView) b.setView(g); return; }
      b.setView({ s: v.s + (g.s - v.s) * 0.4, x: v.x + (g.x - v.x) * 0.4, y: v.y + (g.y - v.y) * 0.4 });
      this.anim = requestAnimationFrame(step);
    };
    this.anim = requestAnimationFrame(step);
  }

  waiting(on) {
    if (this.link.state === "ended") return;
    this.elMsg.hidden = !on;
    if (on) this.elMsg.innerHTML = `<div class="v-wait">${this.cur || this.wanted ? "Carregando a página…" : "Aguardando o apresentador abrir uma página…"}</div>`;
  }

  browse(dir) {
    const at = this.order.indexOf(this.wanted || this.cur);
    const next = this.order[at + dir];
    if (!next) return;
    this.follow = next === this.cur;
    this.show(next);
  }

  updatePager() {
    const id = this.wanted || this.cur;
    const at = this.order.indexOf(id);
    this.elPage.textContent = this.order.length ? `${at + 1} de ${this.order.length}` : "";
    this.elFollow.hidden = (this.follow && this.followView) || !this.cur;
    this.root.querySelector('[data-a="prev"]').disabled = at <= 0;
    this.root.querySelector('[data-a="next"]').disabled = at < 0 || at >= this.order.length - 1;
  }
}
