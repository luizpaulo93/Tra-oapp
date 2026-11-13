// A "mesa": mostra uma página, cuida de zoom/arrasto e entrega os gestos de
// escrita para quem a controla. Usada pelo apresentador e pelo espectador.

import { drawPaper, drawStrokes, drawImages, strokePath, loadImage, bbox, HL_ALPHA } from "./ink.js";

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export class Board {
  constructor(root, opts = {}) {
    this.root = root;
    this.readonly = !!opts.readonly;
    this.fit = opts.fit || "width"; // 'width' (apresentador) ou 'contain' (espectador)
    this.onView = opts.onView || (() => {});
    this.onPen = opts.onPen || (() => {});
    this.fingerDraw = opts.fingerDraw || (() => true);
    this.insetTop = opts.insetTop || 0; // espaço ocupado por barras flutuantes
    this.insetBottom = opts.insetBottom || 0;
    this.tool = null; // { start, move, end, cancel, hover }
    this.page = null;
    this.paper = null;
    this.view = { s: 1, x: 0, y: 0 };
    this.rendered = { s: 1, x: 0, y: 0 };
    this.fast = true;
    this.hidden = new Set();
    this.liveStrokes = new Map();
    this.laser = [];
    this.lasso = null;
    this.selection = null; // { box, dx, dy, scale, items, handle }
    this.cursor = null; // { x, y, r }
    this.touches = new Map();
    this.gesture = null;
    this.draw = null;
    this.spaceDown = false;
    this.lastTap = 0;

    root.classList.add("board");
    root.innerHTML =
      '<div class="board-layers"><canvas class="c-bg"></canvas><canvas class="c-hl"></canvas><canvas class="c-ink"></canvas></div><canvas class="c-live"></canvas>';
    this.layers = root.firstChild;
    const [bg, hl, ink] = this.layers.children;
    this.cBg = bg; this.cHl = hl; this.cInk = ink; this.cLive = root.lastChild;
    this.xBg = bg.getContext("2d", { alpha: true });
    this.xHl = hl.getContext("2d");
    this.xInk = ink.getContext("2d");
    this.xLive = this.cLive.getContext("2d", { desynchronized: true });

    this.resize = this.resize.bind(this);
    this.ro = new ResizeObserver(this.resize);
    this.ro.observe(root);

    const on = (t, f, o) => root.addEventListener(t, f.bind(this), o);
    on("pointerdown", this.onDown);
    on("pointermove", this.onMove);
    on("pointerup", this.onUp);
    on("pointercancel", this.onUp);
    on("pointerleave", () => { if (!this.draw && this.cursor) { this.cursor = null; this.invalidateLive(); } });
    on("wheel", this.onWheel, { passive: false });
    on("contextmenu", (e) => e.preventDefault());
    on("dblclick", () => { if (this.readonly) this.fitView(); });
    this.keyDown = (e) => { if (e.code === "Space" && !/INPUT|TEXTAREA/.test(e.target.tagName)) this.spaceDown = true; };
    this.keyUp = (e) => { if (e.code === "Space") this.spaceDown = false; };
    window.addEventListener("keydown", this.keyDown);
    window.addEventListener("keyup", this.keyUp);
    this.resize();
  }

  destroy() {
    this.ro.disconnect();
    window.removeEventListener("keydown", this.keyDown);
    window.removeEventListener("keyup", this.keyUp);
    cancelAnimationFrame(this.rafLive);
    cancelAnimationFrame(this.rafView);
    clearTimeout(this.viewTimer);
    this.root.innerHTML = "";
  }

  // ---------- tamanho e visão ----------

  resize() {
    const r = this.root.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const first = !this.W;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    this.dpr = dpr;
    const cx = this.W ? this.W / 2 : 0;
    this.W = r.width; this.H = r.height;
    for (const c of [this.cBg, this.cHl, this.cInk, this.cLive]) {
      c.width = Math.round(r.width * dpr);
      c.height = Math.round(r.height * dpr);
    }
    if (this.page) {
      if (first || this.atFit) this.fitView();
      else { this.view.x += this.W / 2 - cx; this.setView(this.view); }
    }
    this.renderAll();
  }

  fitScale() {
    const p = this.page;
    const pad = this.W < 600 ? 8 : 24;
    const sw = (this.W - pad * 2) / p.w;
    const sh = (this.H - pad * 2 - this.insetTop - this.insetBottom) / p.h;
    if (this.fit === "contain") return Math.min(sw, sh);
    return Math.max(Math.min(sw, 1.5), Math.min(sw, sh));
  }

  fitView() {
    if (!this.page || !this.W) return;
    const s = this.fitScale();
    const pad = this.W < 600 ? 8 : 24;
    const ph = this.page.h * s;
    const free = this.H - this.insetTop - this.insetBottom;
    this.view = { s, x: (this.W - this.page.w * s) / 2, y: this.insetTop + (ph < free ? (free - ph) / 2 : pad) };
    this.atFit = true;
    this.renderAll();
    this.onView(this.view);
  }

  setView(v, user) {
    const p = this.page;
    if (!p) return;
    const base = this.fitScale();
    const s = clamp(v.s, base * 0.6, Math.max(base * 10, 6));
    const pw = p.w * s, ph = p.h * s, m = 40;
    const top = this.insetTop + m, bottom = this.H - this.insetBottom - m;
    let x = v.x, y = v.y;
    x = pw <= this.W ? (this.W - pw) / 2 : clamp(x, this.W - pw - m, m);
    y = ph <= bottom - top ? clamp(y, Math.min(top, (this.H - ph) / 2), Math.max(bottom - ph, (this.H - ph) / 2)) : clamp(y, bottom - ph, top);
    this.view = { s, x, y };
    if (user) this.atFit = false;
    this.requestViewRender();
    this.onView(this.view);
  }

  zoomAt(cx, cy, factor) {
    const v = this.view;
    const s = v.s * factor;
    const px = (cx - v.x) / v.s, py = (cy - v.y) / v.s;
    this.setView({ s, x: cx - px * s, y: cy - py * s }, true);
    // setView pode limitar a escala: reancora no ponto
    const s2 = this.view.s;
    if (s2 !== s) this.setView({ s: s2, x: cx - px * s2, y: cy - py * s2 }, true);
  }

  // Enquanto o gesto acontece, se a página for pesada, move as camadas por
  // CSS (instantâneo) e redesenha com nitidez quando o gesto para.
  requestViewRender() {
    if (this.fast) {
      if (!this.rafView) this.rafView = requestAnimationFrame(() => { this.rafView = 0; this.renderAll(); });
    } else {
      const a = this.rendered, b = this.view;
      const k = b.s / a.s;
      this.layers.style.transform = `translate(${b.x - a.x * k}px,${b.y - a.y * k}px) scale(${k})`;
      clearTimeout(this.viewTimer);
      this.viewTimer = setTimeout(() => this.renderAll(), 140);
      this.invalidateLive();
    }
  }

  toPage(e) {
    const r = this.rect || (this.rect = this.root.getBoundingClientRect());
    return { x: (e.clientX - r.left - this.view.x) / this.view.s, y: (e.clientY - r.top - this.view.y) / this.view.s };
  }

  // ---------- conteúdo ----------

  setPage(page, paper, keepView) {
    const changed = !this.page || this.page.id !== (page && page.id) || this.page.w !== page.w || this.page.h !== page.h;
    this.page = page;
    this.paper = paper || null;
    this.hidden.clear();
    this.liveStrokes.clear();
    this.lasso = null;
    this.selection = null;
    if (page && page.bg && !page.bgImg) {
      const e = loadImage(page.bg);
      if (e.img) page.bgImg = e.img;
      else e.promise.then((im) => { if (im && this.page === page) { page.bgImg = im; this.renderBg(); } });
    }
    if (page && (changed || !keepView)) this.fitView();
    else this.renderAll();
  }

  setPaper(paper) { this.paper = paper; this.renderBg(); }

  transform(ctx) {
    const d = this.dpr, v = this.view;
    ctx.setTransform(d * v.s, 0, 0, d * v.s, d * v.x, d * v.y);
  }

  clear(ctx) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  }

  visibleRect() {
    const v = this.view;
    return [-v.x / v.s, -v.y / v.s, (this.W - v.x) / v.s, (this.H - v.y) / v.s];
  }

  renderAll() {
    const t0 = performance.now();
    clearTimeout(this.viewTimer);
    this.renderBg();
    this.renderInk();
    this.drawLive();
    this.rendered = { ...this.view };
    this.layers.style.transform = "";
    this.rect = this.root.getBoundingClientRect();
    this.fast = performance.now() - t0 < 9;
  }

  renderBg() {
    const ctx = this.xBg, p = this.page;
    this.clear(ctx);
    if (!p) return;
    this.transform(ctx);
    ctx.save();
    ctx.shadowColor = "rgba(20,33,61,.16)";
    ctx.shadowBlur = 22 * this.dpr;
    ctx.shadowOffsetY = 5 * this.dpr;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, p.w, p.h);
    ctx.restore();
    drawPaper(ctx, p, this.readonly ? null : this.paper, 1 / (this.dpr * this.view.s));
    if (p.bgImg) ctx.drawImage(p.bgImg, 0, 0, p.w, p.h);
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, p.w, p.h); ctx.clip();
    drawImages(ctx, this.visibleItems(), (it) => this.getImg(it));
    ctx.restore();
  }

  getImg(it) {
    if (!it.src) return null;
    const e = loadImage(it.src);
    if (e.img) return e.img;
    e.promise.then(() => {
      if (this.bgSoon) return;
      this.bgSoon = requestAnimationFrame(() => { this.bgSoon = 0; this.renderBg(); this.invalidateLive(); });
    });
    return null;
  }

  visibleItems() {
    const p = this.page;
    if (!p) return [];
    return this.hidden.size ? p.items.filter((it) => !this.hidden.has(it.id)) : p.items;
  }

  renderInk() {
    const p = this.page;
    const items = this.visibleItems();
    const rect = this.visibleRect();
    for (const [ctx, kind] of [[this.xHl, "hl"], [this.xInk, "pen"]]) {
      this.clear(ctx);
      if (!p) continue;
      this.transform(ctx);
      ctx.save();
      ctx.beginPath(); ctx.rect(0, 0, p.w, p.h); ctx.clip();
      if (kind === "hl") ctx.globalAlpha = HL_ALPHA;
      drawStrokes(ctx, items, kind, rect);
      ctx.restore();
    }
  }

  // Acrescenta um traço pronto sem redesenhar a página inteira.
  commitStroke(s) {
    const p = this.page;
    this.liveStrokes.delete(s.id);
    if (!this.fast && this.layers.style.transform) { this.renderAll(); return; }
    const ctx = s.t === "hl" ? this.xHl : this.xInk;
    this.transform(ctx);
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, p.w, p.h); ctx.clip();
    if (s.t === "hl") ctx.globalAlpha = HL_ALPHA;
    ctx.fillStyle = s.c;
    ctx.fill(strokePath(s));
    ctx.restore();
    this.drawLive();
  }

  // ---------- camada ao vivo (traço em andamento, laser, seleção) ----------

  invalidateLive() {
    if (!this.rafLive) this.rafLive = requestAnimationFrame(() => { this.rafLive = 0; this.drawLive(); });
  }

  drawLive() {
    const ctx = this.xLive, p = this.page;
    this.clear(ctx);
    if (!p) return;
    this.transform(ctx);
    const px = 1 / this.view.s;

    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, p.w, p.h); ctx.clip();
    for (const s of this.liveStrokes.values()) {
      if (!s.p.length) continue;
      ctx.globalAlpha = s.t === "hl" ? HL_ALPHA : 1;
      ctx.fillStyle = s.c;
      ctx.fill(strokePath({ t: s.t, w: s.w, p: s.p }));
    }
    ctx.globalAlpha = 1;

    const sel = this.selection;
    if (sel) {
      ctx.save();
      const k = sel.scale || 1;
      ctx.translate(sel.dx || 0, sel.dy || 0);
      if (this.hidden.size) {
        for (const it of sel.items) {
          if (it.k === "i") {
            const img = this.getImg(it);
            if (img) ctx.drawImage(img, it.x, it.y, it.w * k, it.h * k);
          }
        }
        ctx.globalAlpha = HL_ALPHA;
        drawStrokes(ctx, sel.items, "hl");
        ctx.globalAlpha = 1;
        drawStrokes(ctx, sel.items, "pen");
      }
      ctx.restore();
    }
    ctx.restore();

    if (sel) {
      const b = sel.box, k = sel.scale || 1;
      const x = b[0] + (sel.dx || 0), y = b[1] + (sel.dy || 0), w = (b[2] - b[0]) * k, h = (b[3] - b[1]) * k;
      ctx.strokeStyle = "#2347d9";
      ctx.lineWidth = 1.5 * px;
      ctx.setLineDash([6 * px, 4 * px]);
      ctx.strokeRect(x, y, w, h);
      ctx.setLineDash([]);
      if (sel.handle) {
        ctx.fillStyle = "#fff";
        ctx.beginPath(); ctx.arc(x + w, y + h, 7 * px, 0, 7); ctx.fill(); ctx.stroke();
      }
    }

    if (this.lasso && this.lasso.length >= 4) {
      ctx.beginPath();
      ctx.moveTo(this.lasso[0], this.lasso[1]);
      for (let i = 2; i < this.lasso.length; i += 2) ctx.lineTo(this.lasso[i], this.lasso[i + 1]);
      ctx.strokeStyle = "#2347d9";
      ctx.lineWidth = 1.5 * px;
      ctx.setLineDash([6 * px, 5 * px]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // laser: rastro vermelho que some em ~1 s
    if (this.laser.length) {
      const now = performance.now();
      while (this.laser.length && now - this.laser[0].t > 1100) this.laser.shift();
      ctx.lineCap = "round"; ctx.lineJoin = "round";
      for (let i = 1; i < this.laser.length; i++) {
        const a = this.laser[i - 1], b = this.laser[i];
        if (b.brk) continue;
        const age = (now - b.t) / 1100;
        ctx.strokeStyle = `rgba(229,56,59,${Math.max(0, 1 - age) * 0.85})`;
        ctx.lineWidth = (5 * (1 - age * 0.5)) * px;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
      const last = this.laser[this.laser.length - 1];
      if (last && now - last.t < 700) {
        ctx.fillStyle = "rgba(229,56,59,.95)";
        ctx.beginPath(); ctx.arc(last.x, last.y, 5 * px, 0, 7); ctx.fill();
      }
      if (this.laser.length) this.invalidateLive();
    }

    if (this.cursor) {
      ctx.strokeStyle = "rgba(20,33,61,.55)";
      ctx.lineWidth = 1.2 * px;
      ctx.beginPath(); ctx.arc(this.cursor.x, this.cursor.y, this.cursor.r, 0, 7); ctx.stroke();
    }
  }

  // ---------- entrada ----------

  activeTouches() {
    const out = [];
    for (const t of this.touches.values()) if (!t.ignore) out.push(t);
    return out;
  }

  startGesture() {
    const a = this.activeTouches();
    if (a.length === 0) { this.gesture = null; return; }
    if (a.length === 1) {
      this.gesture = { type: "pan", lx: a[0].x, ly: a[0].y, x0: a[0].x, y0: a[0].y, t0: performance.now(), moved: false };
    } else {
      const r = this.rect;
      const mx = (a[0].x + a[1].x) / 2 - r.left, my = (a[0].y + a[1].y) / 2 - r.top;
      this.gesture = {
        type: "pinch", d0: Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y) || 1, s0: this.view.s,
        px: (mx - this.view.x) / this.view.s, py: (my - this.view.y) / this.view.s,
      };
    }
  }

  canDrawWith(e) {
    if (this.readonly || !this.tool) return false;
    if (e.pointerType === "mouse") return e.button === 0 && !this.spaceDown;
    if (e.pointerType === "touch") return this.fingerDraw();
    return true;
  }

  onDown(e) {
    if (e.pointerType === "mouse" && e.button === 2) return;
    this.rect = this.root.getBoundingClientRect();
    try { this.root.setPointerCapture(e.pointerId); } catch {}
    e.preventDefault();

    if (e.pointerType === "touch") {
      const t = { id: e.pointerId, x: e.clientX, y: e.clientY, ignore: !!(this.draw && this.draw.type === "pen") };
      this.touches.set(e.pointerId, t);
      if (t.ignore) return;
      if (this.draw && this.draw.type === "touch") { // segundo dedo: vira zoom/arrasto
        this.tool.cancel();
        this.draw = null;
        this.startGesture();
        return;
      }
      if (this.activeTouches().length === 1 && this.canDrawWith(e)) {
        this.draw = { id: e.pointerId, type: "touch" };
        this.tool.start(this.toPage(e), e);
        return;
      }
      this.startGesture();
      return;
    }

    if (e.pointerType === "pen") {
      this.onPen();
      // palma apoiada: ignora os toques que já estavam na tela
      for (const t of this.touches.values()) t.ignore = true;
      this.gesture = null;
      if (this.draw && this.draw.type === "touch") { this.tool.cancel(); this.draw = null; }
    }
    if (this.draw) return;
    if (!this.canDrawWith(e)) {
      this.gesture = { type: "drag", id: e.pointerId, lx: e.clientX, ly: e.clientY };
      this.root.classList.add("grabbing");
      return;
    }
    this.draw = { id: e.pointerId, type: e.pointerType };
    this.tool.start(this.toPage(e), e);
  }

  onMove(e) {
    if (this.draw && e.pointerId === this.draw.id) {
      const list = (e.getCoalescedEvents && e.getCoalescedEvents()) || [];
      const evs = list.length ? list : [e];
      const pts = [];
      for (const ev of evs) {
        const p = this.toPage(ev);
        p.pr = ev.pressure; p.t = ev.timeStamp;
        pts.push(p);
      }
      this.tool.move(pts, e);
      return;
    }
    if (e.pointerType === "touch") {
      const t = this.touches.get(e.pointerId);
      if (!t) return;
      t.x = e.clientX; t.y = e.clientY;
      if (t.ignore || !this.gesture) return;
      const g = this.gesture;
      const a = this.activeTouches();
      if (g.type === "pan") {
        const dx = t.x - g.lx, dy = t.y - g.ly;
        g.lx = t.x; g.ly = t.y;
        if (Math.hypot(t.x - g.x0, t.y - g.y0) > 8) g.moved = true;
        this.setView({ s: this.view.s, x: this.view.x + dx, y: this.view.y + dy }, true);
      } else if (g.type === "pinch" && a.length >= 2) {
        const r = this.rect;
        const d = Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y) || 1;
        const mx = (a[0].x + a[1].x) / 2 - r.left, my = (a[0].y + a[1].y) / 2 - r.top;
        const s = g.s0 * (d / g.d0);
        this.setView({ s, x: mx - g.px * s, y: my - g.py * s }, true);
        const s2 = this.view.s;
        if (s2 !== s) this.setView({ s: s2, x: mx - g.px * s2, y: my - g.py * s2 }, true);
      }
      return;
    }
    if (this.gesture && this.gesture.type === "drag" && e.pointerId === this.gesture.id) {
      const g = this.gesture;
      this.setView({ s: this.view.s, x: this.view.x + e.clientX - g.lx, y: this.view.y + e.clientY - g.ly }, true);
      g.lx = e.clientX; g.ly = e.clientY;
      return;
    }
    if (this.tool && this.tool.hover && !this.readonly && e.pointerType !== "touch") this.tool.hover(this.toPage(e));
  }

  onUp(e) {
    try { this.root.releasePointerCapture(e.pointerId); } catch {}
    if (this.draw && e.pointerId === this.draw.id) {
      this.draw = null;
      if (e.type === "pointercancel") this.tool.cancel();
      else this.tool.end(e);
    }
    if (e.pointerType === "touch") {
      const g = this.gesture;
      this.touches.delete(e.pointerId);
      if (g && g.type === "pan" && !g.moved && performance.now() - g.t0 < 260 && this.readonly) {
        const now = performance.now();
        if (now - this.lastTap < 320) { // toque duplo: aproxima ou volta
          if (this.atFit) this.zoomAt(e.clientX - this.rect.left, e.clientY - this.rect.top, 2.2);
          else this.fitView();
          this.lastTap = 0;
        } else this.lastTap = now;
      }
      this.startGesture();
      return;
    }
    if (this.gesture && this.gesture.type === "drag" && e.pointerId === this.gesture.id) {
      this.gesture = null;
      this.root.classList.remove("grabbing");
    }
  }

  onWheel(e) {
    e.preventDefault();
    if (!this.page) return;
    this.rect = this.root.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) {
      this.zoomAt(e.clientX - this.rect.left, e.clientY - this.rect.top, Math.exp(-e.deltaY * 0.01));
    } else {
      const k = e.deltaMode === 1 ? 32 : 1;
      this.setView({ s: this.view.s, x: this.view.x - e.deltaX * k, y: this.view.y - e.deltaY * k }, true);
    }
  }
}

export { bbox };
