// Tela do apresentador: caderno, ferramentas de escrita, páginas,
// importação/exportação e a transmissão ao vivo.

import { Board } from "./board.js";
import * as ink from "./ink.js";
import * as store from "./store.js";
import { api, HostLink } from "./net.js";
import { readPdf, readImage, exportPdf, download, pageAssets } from "./pdfio.js";
import { h, esc, icon, toast, modal, confirmBox, popover, sleep, formatCode, toggleFullscreen, NO_FULLSCREEN } from "./ui.js";
import { qrSvg } from "./qr.js";

const PEN_COLORS = ["#14213d", "#2347d9", "#e5383b", "#1e9e61", "#f08c00", "#7c3aed"];
const HL_COLORS = ["#ffe14d", "#9bec8a", "#ffa6c9", "#8fd3ff", "#ffc06a"];
const LIVE_KEY = "traco.live";
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

const TOOLS = [
  ["pen", "Caneta"], ["hl", "Marca-texto"], ["eraser", "Borracha"],
  ["lasso", "Selecionar e mover"], ["shape", "Formas"], ["laser", "Laser (só aponta, não risca)"],
];

function loadPrefs() {
  const base = { tool: "pen", pen: { c: PEN_COLORS[0], w: 3 }, hl: { c: HL_COLORS[0], w: 26 }, er: { mode: "part", w: 22 }, shape: "line", finger: null };
  try {
    const p = JSON.parse(localStorage.getItem("traco.prefs")) || {};
    return { ...base, ...p, pen: { ...base.pen, ...p.pen }, hl: { ...base.hl, ...p.hl }, er: { ...base.er, ...p.er } };
  } catch { return base; }
}

export function paperLabel(type) {
  return type === "lined" ? "pautado" : type === "grid" ? "quadriculado" : "em branco";
}

export class Editor {
  constructor(root, nb, opts) {
    this.root = root;
    this.nb = nb;
    this.onExit = opts.onExit;
    this.pages = new Map();
    this.index = 0;
    this.page = null;
    this.prefs = loadPrefs();
    this.undoStack = [];
    this.redoStack = [];
    this.sel = null;
    this.act = null;
    this.link = null;
    this.viewers = 0;
    this.uploaded = new Set();
    // Já se usou caneta neste aparelho? (liga a rejeição de palma desde o início)
    this.penSeen = false;
    try { this.penSeen = localStorage.getItem("traco.pen") === "1"; } catch {}
    this.optsOpen = false; // cores e espessuras só aparecem ao tocar na ferramenta
    this.saveTimers = new Map();
    this.build();
    this.start();
  }

  // ---------- montagem ----------

  build() {
    this.root.innerHTML = `
      <div class="editor">
        <header class="bar">
          <button class="ib" data-a="back" title="Voltar aos cadernos" aria-label="Voltar aos cadernos">${icon("back")}</button>
          <button class="bar-title" data-a="rename" title="Renomear caderno">${esc(this.nb.name)}</button>
          <span class="bar-gap"></span>
          <button class="ib" data-a="undo" title="Desfazer" aria-label="Desfazer">${icon("undo")}</button>
          <button class="ib" data-a="redo" title="Refazer" aria-label="Refazer">${icon("redo")}</button>
          <span class="bar-sep"></span>
          <button class="ib" data-a="add" title="Adicionar página, imagem ou PDF" aria-label="Adicionar">${icon("plus")}</button>
          <button class="ib" data-a="pages" title="Páginas" aria-label="Páginas">${icon("pages")}</button>
          <button class="ib" data-a="paper" title="Papel" aria-label="Papel">${icon("paper")}</button>
          <button class="ib" data-a="export" title="Exportar em PDF" aria-label="Exportar em PDF">${icon("download")}</button>
          <button class="ib" data-a="full" title="Tela cheia" aria-label="Tela cheia">${icon("full")}</button>
          <button class="live-btn" data-a="live">${icon("live", 18)}<span>Transmitir</span></button>
        </header>
        <div class="stage-wrap">
          <div class="stage"></div>
          <div class="tools" role="toolbar" aria-label="Ferramentas"></div>
          <div class="pager">
            <button class="ib is-small" data-a="prev" aria-label="Página anterior">${icon("back", 18)}</button>
            <button class="pager-num" data-a="pages"></button>
            <button class="ib is-small" data-a="next" aria-label="Próxima página"></button>
          </div>
        </div>
        <input type="file" accept="image/*" hidden data-f="image">
        <input type="file" accept="application/pdf,.pdf" hidden data-f="pdf">
      </div>`;
    const q = (s) => this.root.querySelector(s);
    this.elTools = q(".tools");
    this.elPagerNum = q(".pager-num");
    this.elNext = q('[data-a="next"]');
    this.elLive = q(".live-btn");
    this.elUndo = q('[data-a="undo"]');
    this.elRedo = q('[data-a="redo"]');
    this.fImage = q('[data-f="image"]');
    this.fPdf = q('[data-f="pdf"]');

    this.board = new Board(q(".stage"), {
      fit: "width",
      insetTop: 74,
      insetBottom: 56,
      penMode: () => this.penSeen,
      onView: () => this.viewChanged(),
      fingerDraw: () => (this.prefs.finger === null ? !this.penSeen : this.prefs.finger),
      onPen: () => {
        if (this.penSeen) return;
        this.penSeen = true;
        try { localStorage.setItem("traco.pen", "1"); } catch {}
        this.renderTools();
      },
    });
    this.board.tool = {
      start: (pt, e) => this.toolStart(pt, e),
      move: (pts, e) => this.toolMove(pts, e),
      end: () => this.toolEnd(false),
      cancel: () => this.toolEnd(true),
      hover: (pt) => this.toolHover(pt),
    };

    // o ouvinte fica no elemento desta tela (que some junto com ela)
    q(".editor").addEventListener("click", (e) => {
      const b = e.target.closest("[data-a]");
      if (b && !this.dead) this.action(b.dataset.a, b);
    });
    this.fImage.addEventListener("change", () => { const f = this.fImage.files[0]; this.fImage.value = ""; if (f) this.insertImage(f); });
    this.fPdf.addEventListener("change", () => { const f = this.fPdf.files[0]; this.fPdf.value = ""; if (f) this.insertPdf(f); });

    this.onKey = (e) => {
      if (/INPUT|TEXTAREA/.test(e.target.tagName) || document.querySelector(".modal-wrap")) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? this.redo() : this.undo(); }
      else if (mod && e.key.toLowerCase() === "y") { e.preventDefault(); this.redo(); }
      else if ((e.key === "Delete" || e.key === "Backspace") && this.sel) { e.preventDefault(); this.deleteSel(); }
      else if (e.key === "PageDown" || e.key === "ArrowRight") this.go(this.index + 1);
      else if (e.key === "PageUp" || e.key === "ArrowLeft") this.go(this.index - 1);
    };
    document.addEventListener("keydown", this.onKey);
    this.onPaste = (e) => {
      const f = [...(e.clipboardData?.files || [])].find((x) => x.type.startsWith("image/"));
      if (f) { e.preventDefault(); this.insertImage(f); }
    };
    document.addEventListener("paste", this.onPaste);
    this.onHide = () => { if (document.visibilityState === "hidden") this.flushSaves(); };
    document.addEventListener("visibilitychange", this.onHide);
    this.renderTools();
  }

  async start() {
    if (!this.nb.pages.length) await this.addPages([this.blankSize()], 0, true);
    await this.go(0, true);
    // retoma uma transmissão se a página foi recarregada no meio dela
    try {
      const saved = JSON.parse(sessionStorage.getItem(LIVE_KEY) || "null");
      if (saved && saved.nb === this.nb.id) {
        const r = await fetch(`/api/rooms/${saved.code}?key=${saved.key}`, { cache: "no-store" });
        const d = r.ok ? await r.json() : null;
        if (d && d.host) this.openLink(saved.code, saved.key);
        else sessionStorage.removeItem(LIVE_KEY);
      }
    } catch {}
  }

  async destroy() {
    if (this.dead) return;
    this.dead = true;
    document.removeEventListener("keydown", this.onKey);
    document.removeEventListener("paste", this.onPaste);
    document.removeEventListener("visibilitychange", this.onHide);
    clearInterval(this.liveTimer);
    clearTimeout(this.viewTimer);
    await this.flushSaves();
    if (this.link) this.stopLive(true);
    this.board.destroy();
    document.querySelectorAll(".pop").forEach((p) => p._close && p._close());
  }

  action(a, btn) {
    switch (a) {
      case "back": this.exit(); break;
      case "undo": this.undo(); break;
      case "redo": this.redo(); break;
      case "prev": this.go(this.index - 1); break;
      case "next":
        if (this.index >= this.nb.pages.length - 1) this.addPages([this.blankSize()], this.index + 1).then(() => this.go(this.index + 1));
        else this.go(this.index + 1);
        break;
      case "add": this.addMenu(btn); break;
      case "pages": this.pagesPanel(); break;
      case "paper": this.paperPop(btn); break;
      case "export": this.exportDialog(); break;
      case "full": if (!toggleFullscreen()) toast(NO_FULLSCREEN, { ms: 8000 }); break;
      case "rename": this.renameDialog(btn); break;
      case "live": this.link ? this.livePanel() : this.startLive(); break;
    }
  }

  renameDialog(btn) {
    const m = modal(`<form class="form"><h2>Renomear caderno</h2>
      <label class="field"><span>Nome</span><input name="name" maxlength="60" value="${esc(this.nb.name)}" autofocus></label>
      <div class="row end"><button class="btn" type="button" data-close>Cancelar</button><button class="btn is-primary" type="submit">Salvar nome</button></div></form>`, { cls: "is-small" });
    m.el.querySelector("form").addEventListener("submit", (e) => {
      e.preventDefault();
      this.nb.name = m.el.querySelector("input").value.trim() || "Caderno sem nome";
      btn.textContent = this.nb.name;
      this.saveNb();
      m.close();
    });
  }

  async exit() {
    if (this.link) {
      const yes = await confirmBox({
        title: "Encerrar a transmissão?",
        text: "Sair do caderno encerra a transmissão para quem está assistindo.",
        ok: "Encerrar e sair", danger: true,
      });
      if (!yes) return;
    }
    this.onExit(); // a troca de tela chama destroy()
  }

  // ---------- páginas ----------

  blankSize() {
    return this.nb.orient === "l" ? { w: 1414, h: 1000 } : { w: 1000, h: 1414 };
  }

  async loadPage(id) {
    let p = this.pages.get(id);
    if (!p) {
      p = await store.getPage(id);
      if (!p) return null;
      this.pages.set(id, p);
    } else if (p.hasBg && !p.bg) {
      p.bg = await store.getBg(id);
    }
    return p;
  }

  // Libera a memória dos fundos de páginas distantes da atual.
  trimPages() {
    this.nb.pages.forEach((id, i) => {
      const p = this.pages.get(id);
      if (p && p.hasBg && p.bg && Math.abs(i - this.index) > 3) { delete p.bg; delete p.bgImg; }
    });
  }

  async go(i, force) {
    i = clamp(i, 0, this.nb.pages.length - 1);
    if (i === this.index && this.page && !force) return;
    if (this.act) return;
    this.clearSel();
    const p = await this.loadPage(this.nb.pages[i]);
    if (!p) return;
    this.index = i;
    this.page = p;
    this.board.setPage(p, this.nb.paper);
    this.updatePager();
    if (this.link) {
      if (!this.uploaded.has(p.id)) this.uploadPage(p);
      this.link.send({ t: "cur", id: p.id });
      this.sendView();
    }
    this.trimPages();
  }

  updatePager() {
    const n = this.nb.pages.length;
    this.elPagerNum.textContent = `${this.index + 1} de ${n}`;
    const last = this.index >= n - 1;
    this.elNext.innerHTML = icon(last ? "plus" : "next", 18);
    this.elNext.title = last ? "Nova página" : "Próxima página";
    this.elNext.setAttribute("aria-label", this.elNext.title);
    this.root.querySelector('[data-a="prev"]').disabled = this.index === 0;
  }

  async addPages(list, at, quiet) {
    const made = [];
    for (const src of list) {
      const p = { id: ink.uid(), nb: this.nb.id, w: src.w, h: src.h, items: [], hasBg: !!src.bg };
      if (src.bg) p.bg = src.bg;
      await store.putPage(p, true);
      this.pages.set(p.id, p);
      made.push(p);
    }
    this.nb.pages.splice(at, 0, ...made.map((p) => p.id));
    if (at <= this.index && this.page) this.index += made.length;
    await this.saveNb();
    if (this.link) {
      this.link.send({ t: "order", ids: this.nb.pages });
      this.pumpUploads();
    }
    if (!quiet) this.updatePager();
    this.trimPages();
    return made;
  }

  async deletePage(i) {
    if (this.nb.pages.length <= 1) { toast("O caderno precisa ter pelo menos uma página."); return false; }
    const yes = await confirmBox({ title: `Excluir a página ${i + 1}?`, text: "Tudo o que está escrito nela será apagado. Isso não pode ser desfeito.", ok: "Excluir página", danger: true });
    if (!yes) return false;
    const [id] = this.nb.pages.splice(i, 1);
    this.pages.delete(id);
    this.undoStack = this.undoStack.filter((a) => a.pg !== id);
    this.redoStack = this.redoStack.filter((a) => a.pg !== id);
    this.updateUndo();
    await store.deletePage(id);
    await this.saveNb();
    if (this.link) {
      this.link.send({ t: "delpage", id });
      this.link.send({ t: "order", ids: this.nb.pages });
      this.uploaded.delete(id);
    }
    if (i < this.index) { this.index--; this.updatePager(); }
    else if (i === this.index) await this.go(Math.min(i, this.nb.pages.length - 1), true);
    else this.updatePager();
    return true;
  }

  async movePage(i, dir) {
    const j = i + dir;
    if (j < 0 || j >= this.nb.pages.length) return;
    const cur = this.nb.pages[this.index];
    [this.nb.pages[i], this.nb.pages[j]] = [this.nb.pages[j], this.nb.pages[i]];
    this.index = this.nb.pages.indexOf(cur);
    await this.saveNb();
    if (this.link) this.link.send({ t: "order", ids: this.nb.pages });
    this.updatePager();
  }

  saveNb() {
    this.nb.updated = Date.now();
    return store.putNotebook(this.nb);
  }

  dirty(p) {
    clearTimeout(this.saveTimers.get(p.id));
    this.saveTimers.set(p.id, setTimeout(() => {
      this.saveTimers.delete(p.id);
      store.putPage(p).catch(() => toast("Não foi possível salvar. O armazenamento do aparelho pode estar cheio.", { error: true }));
      this.saveNb();
    }, 500));
  }

  async flushSaves() {
    const jobs = [];
    for (const [id, t] of this.saveTimers) {
      clearTimeout(t);
      const p = this.pages.get(id);
      if (p) jobs.push(store.putPage(p).catch(() => {}));
    }
    this.saveTimers.clear();
    if (jobs.length) jobs.push(this.saveNb());
    await Promise.all(jobs);
  }

  // ---------- alterações (com desfazer) ----------

  // a = { pg, del:[itens], put:[itens] }
  apply(a, o = {}) {
    const p = this.pages.get(a.pg);
    if (!p) return;
    p.items = ink.applyOp(p.items, a.del.map((it) => it.id), a.put);
    if (p === this.page) {
      if (o.stroke) this.board.commitStroke(a.put[0]);
      else { this.board.renderBg(); this.board.renderInk(); this.board.drawLive(); }
    }
    this.sendOp(a.pg, a.del.map((it) => it.id), a.put);
    this.dirty(p);
  }

  commit(a, o) {
    this.apply(a, o);
    this.undoStack.push(a);
    if (this.undoStack.length > 300) this.undoStack.shift();
    this.redoStack.length = 0;
    this.updateUndo();
  }

  async undo() {
    if (this.act) return;
    const a = this.undoStack.pop();
    if (!a) return;
    await this.showPageOf(a);
    this.apply({ pg: a.pg, del: a.put, put: a.del });
    this.redoStack.push(a);
    this.updateUndo();
  }

  async redo() {
    if (this.act) return;
    const a = this.redoStack.pop();
    if (!a) return;
    await this.showPageOf(a);
    this.apply(a);
    this.undoStack.push(a);
    this.updateUndo();
  }

  async showPageOf(a) {
    this.clearSel();
    const i = this.nb.pages.indexOf(a.pg);
    if (i >= 0 && i !== this.index) await this.go(i);
  }

  updateUndo() {
    this.elUndo.disabled = !this.undoStack.length;
    this.elRedo.disabled = !this.redoStack.length;
  }

  // ---------- ferramentas ----------

  setTool(t) {
    if (this.act) return;
    if (t !== "lasso") this.clearSel();
    this.prefs.tool = t;
    this.board.cursor = null;
    this.board.invalidateLive();
    this.savePrefs();
    this.renderTools();
  }

  savePrefs() {
    try { localStorage.setItem("traco.prefs", JSON.stringify(this.prefs)); } catch {}
  }

  renderTools() {
    const p = this.prefs;
    const t = p.tool;
    const fingerOn = p.finger === null ? !this.penSeen : p.finger;
    let opts = "";
    const dots = (list, cur, key) =>
      list.map((c) => `<button class="dot${c === cur ? " is-on" : ""}" style="--c:${c}" data-color="${c}" data-key="${key}" aria-label="Cor ${c}"></button>`).join("") +
      `<label class="dot is-custom${list.includes(cur) ? "" : " is-on"}" style="--c:${list.includes(cur) ? "transparent" : cur}" title="Outra cor"><input type="color" value="${cur}" data-key="${key}"></label>`;
    const size = (key, min, max, val) =>
      `<label class="size" title="Espessura"><span class="size-dot" style="--d:${clamp(val * (key === "pen" ? 1.6 : 0.5), 3, 20)}px"></span><input type="range" min="${min}" max="${max}" step="0.5" value="${val}" data-size="${key}" aria-label="Espessura"></label>`;
    if (t === "pen" || t === "shape") {
      if (t === "shape") {
        opts += `<div class="seg">` + [["line", "Linha"], ["arrow", "Seta"], ["rect", "Retângulo"], ["ellipse", "Elipse"]]
          .map(([k, l]) => `<button class="ib is-small${p.shape === k ? " is-on" : ""}" data-shape="${k}" title="${l}" aria-label="${l}">${icon(k, 18)}</button>`).join("") + `</div><span class="tools-sep"></span>`;
      }
      opts += dots(PEN_COLORS, p.pen.c, "pen") + size("pen", 1, 14, p.pen.w);
    } else if (t === "hl") {
      opts += dots(HL_COLORS, p.hl.c, "hl") + size("hl", 10, 60, p.hl.w);
    } else if (t === "eraser") {
      opts += `<div class="seg"><button class="chip${p.er.mode === "part" ? " is-on" : ""}" data-er="part">Parcial</button><button class="chip${p.er.mode === "stroke" ? " is-on" : ""}" data-er="stroke">Traço inteiro</button></div>` + size("er", 8, 70, p.er.w);
    } else if (t === "lasso") {
      opts += this.sel
        ? `<button class="chip is-danger" data-sel="del">${icon("trash", 16)} Excluir seleção</button>`
        : `<span class="hint">Contorne os traços ou toque em uma imagem</span>`;
    } else if (t === "laser") {
      opts += `<span class="hint">Quem assiste vê o ponteiro, e nada fica riscado</span>`;
    }
    const inkOf = (k) => (k === "pen" ? p.pen.c : k === "hl" ? p.hl.c : null);
    this.elTools.classList.toggle("show-opts", this.optsOpen);
    this.elTools.innerHTML =
      `<div class="tools-main">` +
      TOOLS.map(([k, l]) => `<button class="ib${t === k ? " is-on" : ""}" data-tool="${k}" title="${l}" aria-label="${l}" aria-pressed="${t === k}">${icon(k)}${inkOf(k) ? `<i class="tool-ink" style="--c:${inkOf(k)}"></i>` : ""}</button>`).join("") +
      `<span class="tools-sep"></span><button class="ib${fingerOn ? " is-on" : ""}" data-finger title="Escrever com o dedo" aria-label="Escrever com o dedo" aria-pressed="${fingerOn}">${icon("finger")}</button></div>` +
      (opts ? `<div class="tools-opts">${opts}</div>` : "");

    if (!this.toolsBound) {
      this.toolsBound = true;
      this.elTools.addEventListener("click", (e) => {
        const b = e.target.closest("button");
        if (!b) return;
        if (b.dataset.tool) {
          // tocar na ferramenta abre as opções; tocar de novo fecha
          if (b.dataset.tool === this.prefs.tool) this.showOpts(!this.optsOpen);
          else { this.optsOpen = true; this.setTool(b.dataset.tool); }
        }
        else if (b.dataset.color) { this.prefs[b.dataset.key].c = b.dataset.color; this.savePrefs(); this.renderTools(); }
        else if (b.dataset.shape) { this.prefs.shape = b.dataset.shape; this.savePrefs(); this.renderTools(); }
        else if (b.dataset.er) { this.prefs.er.mode = b.dataset.er; this.savePrefs(); this.renderTools(); }
        else if (b.dataset.sel === "del") this.deleteSel();
        else if ("finger" in b.dataset) {
          const on = this.prefs.finger === null ? !this.penSeen : this.prefs.finger;
          this.prefs.finger = !on;
          this.savePrefs();
          this.renderTools();
          toast(this.prefs.finger ? "O dedo escreve. Use dois dedos para mover a página." : "O dedo move a página. Só a caneta escreve.");
        }
      });
      this.elTools.addEventListener("input", (e) => {
        const i = e.target;
        if (i.dataset.size) {
          this.prefs[i.dataset.size].w = +i.value;
          const d = i.parentElement.querySelector(".size-dot");
          if (d) d.style.setProperty("--d", clamp(+i.value * (i.dataset.size === "pen" ? 1.6 : 0.5), 3, 20) + "px");
          this.savePrefs();
        } else if (i.type === "color") { this.prefs[i.dataset.key].c = i.value; this.savePrefs(); }
      });
      this.elTools.addEventListener("change", (e) => { if (e.target.type === "color") this.renderTools(); });
    }
  }

  showOpts(on) {
    this.optsOpen = on;
    this.elTools.classList.toggle("show-opts", on);
  }

  toolStart(pt, e) {
    const p = this.prefs;
    const tool = p.tool;
    // ao começar a escrever, as opções saem da frente
    if (this.optsOpen && !(tool === "lasso" && this.sel)) this.showOpts(false);
    const pg = this.page.id;
    const isPen = e.pointerType === "pen";
    if (tool === "pen" || tool === "hl") {
      const pr = tool === "hl" ? 0.5 : isPen ? clamp(e.pressure || 0.2, 0.05, 1) : 0.5;
      const s = { id: ink.uid(), k: "s", t: tool, c: p[tool].c, w: p[tool].w, p: [ink.r1(pt.x), ink.r1(pt.y), pr] };
      this.act = { tool, pg, s, isPen, lx: pt.x, ly: pt.y, fx: pt.x, fy: pt.y, rx: pt.x, ry: pt.y, pr, lt: e.timeStamp, sent: 0 };
      this.board.liveStrokes.set(s.id, s);
      this.board.invalidateLive();
    } else if (tool === "shape") {
      const s = { id: ink.uid(), k: "s", t: "pen", g: 1, c: p.pen.c, w: p.pen.w, p: [] }; // g: forma geométrica
      this.act = { tool, pg, s, x0: pt.x, y0: pt.y, changed: false };
      this.board.liveStrokes.set(s.id, s);
    } else if (tool === "eraser") {
      this.act = { tool, pg, lx: pt.x, ly: pt.y, del: new Map(), put: new Map(), nDel: new Set(), nPut: new Map() };
      this.eraseAt(pt.x, pt.y);
      if (this.act.touched) { this.act.touched = false; this.board.renderInk(); }
      this.board.cursor = { x: pt.x, y: pt.y, r: p.er.w / 2 };
      this.board.invalidateLive();
    } else if (tool === "laser") {
      this.act = { tool, pg, pend: [], first: true };
      this.board.laser.push({ x: pt.x, y: pt.y, t: performance.now(), brk: true });
      this.act.pend.push(ink.r1(pt.x), ink.r1(pt.y));
      this.board.invalidateLive();
    } else if (tool === "lasso") {
      this.lassoStart(pt);
    }
    clearInterval(this.liveTimer);
    this.liveTimer = setInterval(() => this.liveTick(), 33);
  }

  toolMove(pts) {
    const a = this.act;
    if (!a) return;
    const v = this.board.view;
    if (a.tool === "pen" || a.tool === "hl") {
      // A caneta manda a posição centenas de vezes por segundo, com um tremor
      // fino. Um filtro leve (que quase não atrasa) e um espaçamento mínimo
      // entre pontos deixam o traço liso como o do dedo.
      const minD = (a.isPen ? 1.1 : 0.8) / v.s;
      const k = a.isPen ? 0.5 : 0.75;
      const arr = a.s.p;
      for (const p of pts) {
        a.rx = p.x; a.ry = p.y;
        a.fx += (p.x - a.fx) * k;
        a.fy += (p.y - a.fy) * k;
        if (a.tool === "pen" && a.isPen) {
          const raw = p.pr > 0 ? p.pr : a.pr;
          a.pr += (raw - a.pr) * 0.3; // pressão também suavizada
        }
        const d = Math.hypot(a.fx - a.lx, a.fy - a.ly);
        if (d < minD) continue;
        let pr = 0.5;
        if (a.tool === "pen") {
          if (!a.isPen) {
            // sem caneta: simula a pressão pela velocidade (rápido = mais fino)
            const dt = Math.max(1, p.t - a.lt);
            const speed = (d * v.s) / dt;
            a.pr += (clamp(0.62 - speed * 0.16, 0.3, 0.62) - a.pr) * 0.2;
          }
          pr = a.pr;
        }
        a.lx = a.fx; a.ly = a.fy; a.lt = p.t;
        arr.push(ink.r1(a.fx), ink.r1(a.fy), Math.round(pr * 100) / 100);
      }
      this.board.invalidateLive();
    } else if (a.tool === "shape") {
      const p = pts[pts.length - 1];
      a.s.p = ink.shapePoints(this.prefs.shape, a.x0, a.y0, p.x, p.y, a.s.w);
      a.changed = true;
      this.board.invalidateLive();
    } else if (a.tool === "eraser") {
      for (const p of pts) {
        const d = Math.hypot(p.x - a.lx, p.y - a.ly);
        const step = Math.max(2, this.prefs.er.w / 4);
        const n = Math.max(1, Math.ceil(d / step));
        for (let i = 1; i <= n; i++) this.eraseAt(a.lx + ((p.x - a.lx) * i) / n, a.ly + ((p.y - a.ly) * i) / n);
        a.lx = p.x; a.ly = p.y;
      }
      this.board.cursor = { x: a.lx, y: a.ly, r: this.prefs.er.w / 2 };
      if (a.touched) { a.touched = false; this.board.renderInk(); }
      this.board.invalidateLive();
    } else if (a.tool === "laser") {
      const now = performance.now();
      for (const p of pts) {
        this.board.laser.push({ x: p.x, y: p.y, t: now });
        a.pend.push(ink.r1(p.x), ink.r1(p.y));
      }
      this.board.invalidateLive();
    } else if (a.tool === "lasso") {
      this.lassoMove(pts[pts.length - 1]);
    }
  }

  toolEnd(cancel) {
    const a = this.act;
    if (!a) return;
    clearInterval(this.liveTimer);
    this.act = null;
    if (a.tool === "pen" || a.tool === "hl" || a.tool === "shape") {
      const empty = a.tool === "shape" && a.s.p.length < 6;
      if (cancel || empty) {
        this.board.liveStrokes.delete(a.s.id);
        this.board.invalidateLive();
        this.sendLive({ k: "sx", id: a.s.id });
      } else {
        if (a.tool !== "shape" && Math.hypot(a.rx - a.lx, a.ry - a.ly) > 0.3 / this.board.view.s) {
          a.s.p.push(ink.r1(a.rx), ink.r1(a.ry), a.tool === "pen" ? Math.round(a.pr * 100) / 100 : 0.5);
        }
        this.commit({ pg: a.pg, del: [], put: [a.s] }, { stroke: true });
      }
    } else if (a.tool === "eraser") {
      this.flushErase(a);
      this.board.cursor = null;
      this.board.invalidateLive();
      if (a.del.size || a.put.size) {
        this.undoStack.push({ pg: a.pg, del: [...a.del.values()], put: [...a.put.values()] });
        this.redoStack.length = 0;
        this.updateUndo();
      }
    } else if (a.tool === "laser") {
      this.liveTickFor(a);
    } else if (a.tool === "lasso") {
      this.lassoEnd(a, cancel);
    }
  }

  toolHover(pt) {
    if (this.prefs.tool !== "eraser" || this.act) return;
    this.board.cursor = { x: pt.x, y: pt.y, r: this.prefs.er.w / 2 };
    this.board.invalidateLive();
  }

  eraseAt(x, y) {
    const a = this.act;
    const page = this.page;
    const r = this.prefs.er.w / 2;
    const part = this.prefs.er.mode === "part";
    let del = null, put = null;
    for (const it of page.items) {
      if (it.k !== "s") continue;
      if (part) {
        const pieces = ink.eraseFrom(it, x, y, r);
        if (!pieces) continue;
        (del || (del = [])).push(it);
        if (pieces.length) (put || (put = [])).push(...pieces);
      } else if (ink.hitStroke(it, x, y, r)) (del || (del = [])).push(it);
    }
    if (!del) return;
    page.items = ink.applyOp(page.items, del.map((d) => d.id), put);
    for (const d of del) {
      if (a.put.has(d.id)) a.put.delete(d.id); else a.del.set(d.id, d);
      if (a.nPut.has(d.id)) a.nPut.delete(d.id); else a.nDel.add(d.id);
    }
    for (const n of put || []) { a.put.set(n.id, n); a.nPut.set(n.id, n); }
    a.touched = true;
    this.dirty(page);
  }

  flushErase(a) {
    if (!a.nDel.size && !a.nPut.size) return;
    this.sendOp(a.pg, [...a.nDel], [...a.nPut.values()]);
    a.nDel.clear();
    a.nPut.clear();
  }

  // ----- seleção (laço) -----

  lassoStart(pt) {
    const page = this.page;
    const px = 1 / this.board.view.s;
    const sel = this.sel;
    let mode = null;
    if (sel) {
      const b = sel.box;
      if (sel.single && Math.hypot(pt.x - b[2], pt.y - b[3]) < 18 * px) mode = "resize";
      else if (pt.x >= b[0] - 8 * px && pt.x <= b[2] + 8 * px && pt.y >= b[1] - 8 * px && pt.y <= b[3] + 8 * px) mode = "move";
    }
    if (!mode) {
      let img = null;
      for (const it of page.items) if (it.k === "i" && pt.x >= it.x && pt.x <= it.x + it.w && pt.y >= it.y && pt.y <= it.y + it.h) img = it;
      if (img) { this.select([img]); mode = "move"; }
    }
    if (mode) {
      this.act = { tool: "lasso", pg: page.id, mode, x0: pt.x, y0: pt.y };
      this.board.hidden = new Set(this.sel.items.map((it) => it.id));
      this.board.renderBg();
      this.board.renderInk();
      this.board.invalidateLive();
    } else {
      this.clearSel();
      this.act = { tool: "lasso", pg: page.id, mode: "draw", path: [pt.x, pt.y] };
      this.board.lasso = this.act.path;
    }
  }

  lassoMove(pt) {
    const a = this.act;
    const s = this.board.selection;
    if (a.mode === "draw") a.path.push(pt.x, pt.y);
    else if (a.mode === "move") { s.dx = pt.x - a.x0; s.dy = pt.y - a.y0; }
    else if (a.mode === "resize") {
      const b = this.sel.box;
      s.scale = clamp((pt.x - b[0]) / (b[2] - b[0]), 0.08, 12);
    }
    this.board.invalidateLive();
  }

  lassoEnd(a, cancel) {
    const board = this.board;
    if (a.mode === "draw") {
      board.lasso = null;
      if (!cancel && a.path.length >= 8) {
        const items = this.page.items.filter((it) => ink.itemInLasso(it, a.path));
        if (items.length) this.select(items);
      }
      board.invalidateLive();
      return;
    }
    const s = board.selection;
    const items = this.sel.items;
    board.hidden = new Set();
    let next = null;
    if (!cancel && a.mode === "move" && Math.abs(s.dx) + Math.abs(s.dy) > 0.5) next = items.map((it) => ink.moved(it, s.dx, s.dy));
    if (!cancel && a.mode === "resize" && Math.abs(s.scale - 1) > 0.01) {
      const it = items[0];
      next = [{ ...it, w: ink.r1(it.w * s.scale), h: ink.r1(it.h * s.scale) }];
    }
    if (next) {
      this.commit({ pg: a.pg, del: items, put: next });
      this.select(next);
    } else {
      this.select(items);
      board.renderBg();
      board.renderInk();
    }
  }

  select(items) {
    let b = [Infinity, Infinity, -Infinity, -Infinity];
    for (const it of items) {
      const c = ink.bbox(it);
      b = [Math.min(b[0], c[0]), Math.min(b[1], c[1]), Math.max(b[2], c[2]), Math.max(b[3], c[3])];
    }
    const single = items.length === 1 && items[0].k === "i";
    if (!single) b = [b[0] - 6, b[1] - 6, b[2] + 6, b[3] + 6];
    this.sel = { items, box: b, single };
    this.board.selection = { box: b, items, dx: 0, dy: 0, scale: 1, handle: single };
    this.board.invalidateLive();
    if (this.prefs.tool === "lasso") { this.optsOpen = true; this.renderTools(); } // mostra "Excluir seleção"
  }

  clearSel() {
    if (!this.sel) return;
    this.sel = null;
    this.board.selection = null;
    this.board.hidden = new Set();
    this.board.invalidateLive();
    if (this.prefs.tool === "lasso") { this.optsOpen = false; this.renderTools(); }
  }

  deleteSel() {
    if (!this.sel || this.act) return;
    const items = this.sel.items;
    this.clearSel();
    this.commit({ pg: this.page.id, del: items, put: [] });
  }

  // ---------- inserir imagem / PDF ----------

  addMenu(btn) {
    const el = h(`<div class="menu">
      <button data-m="blank">${icon("paper", 20)}<span>Página nova</span></button>
      <button data-m="image">${icon("image", 20)}<span>Imagem nesta página</span></button>
      <button data-m="pdf">${icon("pdf", 20)}<span>PDF inteiro, depois desta página</span></button>
    </div>`);
    const pop = popover(btn, el);
    el.addEventListener("click", async (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      pop.close();
      if (b.dataset.m === "blank") { await this.addPages([this.blankSize()], this.index + 1); this.go(this.index + 1); }
      else if (b.dataset.m === "image") this.fImage.click();
      else this.fPdf.click();
    });
  }

  async insertImage(file) {
    let im;
    try { im = await readImage(file); } catch (e) { toast(e.message, { error: true }); return; }
    const page = this.page;
    const v = this.board.visibleRect();
    const w = Math.min(page.w * 0.6, im.w);
    const hh = (w * im.h) / im.w;
    const cx = clamp((Math.max(v[0], 0) + Math.min(v[2], page.w)) / 2, w / 2, page.w - w / 2);
    const cy = clamp((Math.max(v[1], 0) + Math.min(v[3], page.h)) / 2, hh / 2, Math.max(hh / 2, page.h - hh / 2));
    const it = { id: ink.uid(), k: "i", x: ink.r1(cx - w / 2), y: ink.r1(cy - hh / 2), w: ink.r1(w), h: ink.r1(hh), src: im.src };
    this.commit({ pg: page.id, del: [], put: [it] });
    this.prefs.tool = "lasso";
    this.select([it]);
    this.renderTools();
    toast("Arraste a imagem para posicionar. Puxe o canto para mudar o tamanho.");
  }

  async insertPdf(file) {
    const t = toast("Abrindo o PDF…", { sticky: true });
    const at = this.index + 1;
    let n = 0;
    try {
      for await (const pg of readPdf(file, (i, total) => t.update(`Importando o PDF: página ${i} de ${total}`))) {
        await this.addPages([pg], at + n, true);
        n++;
      }
      t.close();
      if (n) { toast(n === 1 ? "1 página adicionada." : `${n} páginas adicionadas.`); await this.go(at, true); }
    } catch (e) {
      t.close();
      console.error(e);
      toast("Não foi possível ler esse PDF. Ele pode estar protegido por senha ou corrompido.", { error: true, ms: 6000 });
      this.updatePager();
    }
  }

  // ---------- painéis ----------

  paperPop(btn) {
    const nb = this.nb;
    const el = h(`<div class="panel">
      <h3>Papel</h3>
      <div class="seg is-wide">
        ${[["blank", "Em branco"], ["lined", "Pautado"], ["grid", "Quadriculado"]].map(([k, l]) => `<button class="chip${nb.paper.type === k ? " is-on" : ""}" data-type="${k}">${l}</button>`).join("")}
      </div>
      <label class="field"><span>Tamanho das linhas</span><input type="range" min="18" max="90" step="1" value="${nb.paper.size}"></label>
      <p class="note">As linhas aparecem só para você. Quem assiste vê a página em branco.</p>
    </div>`);
    popover(btn, el);
    const range = el.querySelector("input");
    const sync = () => {
      range.disabled = nb.paper.type === "blank";
      el.querySelectorAll("[data-type]").forEach((b) => b.classList.toggle("is-on", b.dataset.type === nb.paper.type));
      this.board.setPaper(nb.paper);
    };
    el.addEventListener("click", (e) => {
      const b = e.target.closest("[data-type]");
      if (!b) return;
      nb.paper.type = b.dataset.type;
      sync();
      this.saveNb();
    });
    range.addEventListener("input", () => { nb.paper.size = +range.value; this.board.setPaper(nb.paper); });
    range.addEventListener("change", () => this.saveNb());
    sync();
  }

  pagesPanel() {
    const m = modal(`<div class="drawer-head"><h2>Páginas</h2><button class="ib" data-close aria-label="Fechar">${icon("x")}</button></div><div class="thumbs"></div>`, { cls: "is-drawer" });
    const list = m.el.querySelector(".thumbs");
    let token = 0;
    const render = async () => {
      const my = ++token;
      list.innerHTML = "";
      const jobs = [];
      this.nb.pages.forEach((id, i) => {
        const row = h(`<div class="thumb${i === this.index ? " is-cur" : ""}">
          <button class="thumb-pic" data-go="${i}" aria-label="Ir para a página ${i + 1}"><canvas></canvas></button>
          <div class="thumb-side"><span class="thumb-n">${i + 1}</span>
            <button class="ib is-small" data-up="${i}" aria-label="Mover para cima" ${i === 0 ? "disabled" : ""}>${icon("up", 16)}</button>
            <button class="ib is-small" data-down="${i}" aria-label="Mover para baixo" ${i === this.nb.pages.length - 1 ? "disabled" : ""}>${icon("down", 16)}</button>
            <button class="ib is-small" data-del="${i}" aria-label="Excluir página">${icon("trash", 16)}</button></div></div>`);
        list.appendChild(row);
        jobs.push([id, row.querySelector("canvas")]);
      });
      const cur = list.querySelector(".is-cur");
      if (cur) cur.scrollIntoView({ block: "center" });
      for (const [id, canvas] of jobs) {
        if (my !== token || !canvas.isConnected) return;
        const p = await this.loadPage(id);
        if (!p) continue;
        const k = 150 / p.w;
        canvas.width = 150; canvas.height = Math.round(p.h * k);
        const ctx = canvas.getContext("2d");
        ctx.scale(k, k);
        ink.drawPageFlat(ctx, p, { ...(await pageAssets(p)), paper: this.nb.paper, px: 1 / k });
        await sleep(0);
      }
      this.trimPages();
    };
    list.addEventListener("click", async (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      if (b.dataset.go) { m.close(); this.go(+b.dataset.go); }
      else if (b.dataset.up) { await this.movePage(+b.dataset.up, -1); render(); }
      else if (b.dataset.down) { await this.movePage(+b.dataset.down, 1); render(); }
      else if (b.dataset.del) { if (await this.deletePage(+b.dataset.del)) render(); }
    });
    render();
  }

  exportDialog() {
    const m = modal(`<h2>Exportar em PDF</h2>
      <p class="muted">Gera um PDF com todas as ${this.nb.pages.length === 1 ? "" : this.nb.pages.length + " "}página${this.nb.pages.length === 1 ? "" : "s"} do caderno, com o que você escreveu, e baixa para este aparelho.</p>
      <label class="check"><input type="checkbox" data-lines ${this.nb.paper.type === "blank" ? "disabled" : ""}> <span>Incluir as linhas do papel</span></label>
      <div class="row end"><button class="btn" data-close>Cancelar</button><button class="btn is-primary" data-go>Baixar PDF</button></div>`, { cls: "is-small" });
    m.el.querySelector("[data-go]").onclick = async () => {
      const withPaper = m.el.querySelector("[data-lines]").checked;
      m.close();
      await this.flushSaves();
      const total = this.nb.pages.length;
      const t = toast("Preparando o PDF…", { sticky: true });
      try {
        const self = this;
        const blob = await exportPdf(async function* () {
          for (const id of self.nb.pages) { const p = await self.loadPage(id); if (p) yield p; }
        }, { withPaper, paper: this.nb.paper, onProgress: (n) => t.update(`Preparando o PDF: página ${n} de ${total}`) });
        download(blob, (this.nb.name.replace(/[^\p{L}\p{N} _-]+/gu, " ").replace(/\s+/g, " ").trim() || "caderno") + ".pdf");
        t.close();
        toast("PDF baixado.");
      } catch (e) {
        console.error(e);
        t.close();
        toast("Não foi possível gerar o PDF. Tente de novo.", { error: true });
      }
      this.trimPages();
    };
  }

  // ---------- transmissão ----------

  async startLive() {
    if (this.starting) return;
    this.starting = true;
    this.elLive.classList.add("is-busy");
    try {
      const r = await api("/api/rooms", {});
      this.openLink(r.code, r.key);
      this.livePanel(true);
    } catch (e) {
      toast(e.status === 401 ? "Sua sessão expirou. Volte aos cadernos e entre de novo para transmitir." : e.message, { error: true, ms: 6000 });
    }
    this.starting = false;
    this.elLive.classList.remove("is-busy");
  }

  openLink(code, key) {
    const link = new HostLink(code, key);
    this.link = link;
    this.code = code;
    this.viewers = 0;
    let synced = false;
    try { sessionStorage.setItem(LIVE_KEY, JSON.stringify({ code, key, nb: this.nb.id })); } catch {}
    link.onOpen = () => { if (!synced) { synced = true; this.syncAll(); } };
    link.onMessage = (m) => {
      if (m.t === "viewers" || m.t === "ready") {
        this.viewers = m.t === "ready" ? m.viewers : m.n;
        this.updateLive();
        this.sendView(); // quem acabou de entrar recebe o enquadramento atual
      }
    };
    link.onState = (s) => {
      this.updateLive();
      if (s === "replaced") { toast("A transmissão foi aberta em outra aba ou aparelho.", { error: true }); this.stopLive(false, true); }
    };
    link.onEnded = () => { if (this.link === link) { this.stopLive(false, true); toast("A transmissão foi encerrada.", { ms: 5000 }); } };
    link.connect();
    this.updateLive();
  }

  stopLive(silent, already) {
    const link = this.link;
    if (!link) return;
    this.link = null;
    if (already) link.close(); else link.end();
    try { sessionStorage.removeItem(LIVE_KEY); } catch {}
    this.uploaded = new Set();
    this.updateLive();
    if (this.liveModal) { this.liveModal.close(); this.liveModal = null; }
    if (!silent && !already) toast("Transmissão encerrada.");
  }

  updateLive() {
    const b = this.elLive;
    const on = !!this.link;
    b.classList.toggle("is-live", on);
    if (!on) b.innerHTML = `${icon("live", 18)}<span>Transmitir</span>`;
    else if (this.link.state !== "open") b.innerHTML = `<span class="live-dot is-wait"></span><span>Conectando…</span>`;
    else b.innerHTML = `<span class="live-dot"></span><span class="live-code">${formatCode(this.code)}</span><span class="live-n">${icon("user", 15)}${this.viewers}</span>`;
    b.title = on ? "Ver código e encerrar" : "Transmitir este caderno ao vivo";
    const n = document.querySelector("[data-viewers]");
    if (n) n.textContent = this.viewers === 1 ? "1 pessoa assistindo" : `${this.viewers} pessoas assistindo`;
    if (!on) document.querySelectorAll(".qr-full").forEach((q) => q.remove());
  }

  shareLink() {
    return `${location.origin}/?c=${this.code}`;
  }

  // Compartilhar: código, link direto para copiar e QR code (toque para ampliar).
  livePanel() {
    const link = this.shareLink();
    const digits = [...String(this.code)].map((d) => `<span>${d}</span>`).join("");
    const m = modal(`<div class="live-panel">
        <p class="live-tag"><span class="live-dot"></span> Ao vivo <span class="live-count" data-viewers></span></p>
        <div class="share">
          <button class="qr" data-qr title="Ampliar o QR code" aria-label="Ampliar o QR code">${qrSvg(link)}</button>
          <div class="share-side">
            <p class="muted">Código da transmissão</p>
            <div class="big-code" aria-label="Código da transmissão">${digits}</div>
            <p class="note">Toque no QR code para mostrar em tela cheia.</p>
          </div>
        </div>
        <label class="field"><span>Link direto</span>
          <span class="link-row"><input readonly value="${esc(link)}" aria-label="Link direto"><button class="btn" type="button" data-copy>${icon("copy", 18)} Copiar</button></span>
        </label>
        <div class="row end"><button class="btn is-danger" data-stop>Encerrar transmissão</button><button class="btn is-primary" data-close>Continuar</button></div>
      </div>`, { cls: "is-small", onClose: () => { this.liveModal = null; } });
    this.liveModal = m;
    this.updateLive();
    const input = m.el.querySelector(".link-row input");
    input.addEventListener("focus", () => input.select());
    m.el.querySelector("[data-copy]").onclick = async () => {
      try { await navigator.clipboard.writeText(link); toast("Link copiado."); }
      catch {
        input.focus(); input.select();
        try { document.execCommand("copy"); toast("Link copiado."); }
        catch { toast("Selecione o link e copie.", { ms: 5000 }); }
      }
    };
    m.el.querySelector("[data-qr]").onclick = () => this.qrFull();
    m.el.querySelector("[data-stop]").onclick = () => this.stopLive();
  }

  // QR code ocupando a tela toda, para a turma apontar a câmera.
  qrFull() {
    const el = h(`<div class="qr-full" role="dialog" aria-label="QR code da transmissão" tabindex="-1">
      <div class="qr-big">${qrSvg(this.shareLink())}</div>
      <div class="big-code">${[...String(this.code)].map((d) => `<span>${d}</span>`).join("")}</div>
      <p class="qr-host">${esc(location.host)}</p>
      <p class="note">Toque em qualquer lugar para fechar</p>
    </div>`);
    const close = () => { document.removeEventListener("keydown", key); el.remove(); };
    const key = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
    el.addEventListener("click", close);
    document.addEventListener("keydown", key);
    document.body.appendChild(el);
    el.focus();
  }

  sendOp(pg, d, p) {
    if (!this.link || !this.uploaded.has(pg)) return;
    this.link.send({ t: "op", pg }, JSON.stringify({ d, p }));
  }

  // Quem assiste acompanha o zoom e a região que o apresentador está vendo.
  viewChanged() {
    if (!this.link || this.viewTimer) return;
    this.viewTimer = setTimeout(() => { this.viewTimer = 0; this.sendView(); }, 90);
  }

  sendView() {
    if (!this.link || !this.page) return;
    const r = this.board.viewRect();
    if (r) this.sendLive({ k: "vw", pg: this.page.id, r: r.map(ink.r1) });
  }

  sendLive(body) {
    if (this.link) this.link.send({ t: "live" }, JSON.stringify(body));
  }

  liveTick() {
    if (this.act) this.liveTickFor(this.act);
  }

  liveTickFor(a) {
    if (a.tool === "eraser") { this.flushErase(a); return; }
    if (!this.link) return;
    if (a.tool === "pen" || a.tool === "hl") {
      const n = a.s.p.length / 3;
      if (n > a.sent) {
        this.sendLive({ k: "sp", pg: a.pg, id: a.s.id, t: a.s.t, c: a.s.c, w: a.s.w, p: a.s.p.slice(a.sent * 3) });
        a.sent = n;
      }
    } else if (a.tool === "shape" && a.changed) {
      a.changed = false;
      this.sendLive({ k: "sp", pg: a.pg, id: a.s.id, t: "pen", c: a.s.c, w: a.s.w, r: 1, p: a.s.p });
    } else if (a.tool === "laser" && a.pend.length) {
      this.sendLive({ k: "lz", pg: a.pg, n: a.first ? 1 : 0, p: a.pend });
      a.pend = [];
      a.first = false;
    }
  }

  uploadPage(p) {
    const link = this.link;
    this.uploaded.add(p.id);
    link.send({ t: "page", id: p.id, w: p.w, h: p.h }, p.bg || "");
    let parts = [], size = 0;
    const flush = () => {
      if (parts.length) link.send({ t: "op", pg: p.id }, '{"p":[' + parts.join(",") + "]}");
      parts = []; size = 0;
    };
    for (const it of p.items) {
      const s = JSON.stringify(it);
      if (size + s.length > 300000) flush();
      parts.push(s);
      size += s.length;
    }
    flush();
  }

  async syncAll() {
    const link = this.link;
    if (!link) return;
    this.uploaded = new Set();
    link.send({ t: "reset" });
    this.uploadPage(this.page);
    link.send({ t: "order", ids: this.nb.pages });
    link.send({ t: "cur", id: this.page.id });
    this.sendView();
    this.pumpUploads();
  }

  // Envia em segundo plano as páginas que os espectadores ainda não têm.
  async pumpUploads() {
    if (this.pumping) { this.pumpAgain = true; return; }
    this.pumping = true;
    try {
      do {
        this.pumpAgain = false;
        for (const id of [...this.nb.pages]) {
          const link = this.link;
          if (!link || link.closed) return;
          if (this.uploaded.has(id)) continue;
          while (link.buffered() > 1_500_000) await sleep(60);
          const had = this.pages.get(id);
          const hadBg = had && had.bg;
          const p = await this.loadPage(id);
          if (!p || this.link !== link || this.uploaded.has(id) || !this.nb.pages.includes(id)) continue;
          this.uploadPage(p);
          if (!hadBg) this.trimPages();
          await sleep(20);
        }
      } while (this.pumpAgain);
    } finally {
      this.pumping = false;
    }
  }
}
