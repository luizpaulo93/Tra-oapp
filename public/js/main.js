// Início: entrar em uma transmissão por código, login, cadernos e admin.

import * as store from "./store.js";
import { api, session, setSession, roomIsLive } from "./net.js";
import { Editor, paperLabel } from "./editor.js";
import { Viewer } from "./viewer.js";
import { readPdf } from "./pdfio.js";
import { uid } from "./ink.js";
import { h, esc, icon, toast, modal, confirmBox, popover } from "./ui.js";

const app = document.getElementById("app");
const COVERS = ["#2347d9", "#e5383b", "#1e9e61", "#f0a202", "#7c3aed", "#14213d"];
const WATCH_KEY = "traco.watch";
let current = null; // tela aberta (editor ou espectador)
let user = session();

// Safari: impede o zoom da página inteira por gesto
document.addEventListener("gesturestart", (e) => e.preventDefault());

window.addEventListener("hashchange", route);
route();
if (user) {
  api("/api/me").catch((e) => {
    if (e.status === 401) { setSession(null); user = null; if (!current) home(); }
  });
}

async function route() {
  if (current) { const c = current; current = null; await c.destroy(); }
  const hash = location.hash.slice(1);
  if (hash === "ao-vivo") {
    const code = sessionStorage.getItem(WATCH_KEY);
    if (code) {
      document.body.classList.add("is-app");
      current = new Viewer(app, code, { onExit: () => { sessionStorage.removeItem(WATCH_KEY); location.hash = ""; } });
      return;
    }
  } else if (hash.startsWith("c/") && user) {
    const nb = await store.getNotebook(hash.slice(2));
    if (nb && nb.owner === user.email) {
      document.body.classList.add("is-app");
      current = new Editor(app, nb, { onExit: () => { location.hash = ""; } });
      return;
    }
  }
  if (hash) { history.replaceState(null, "", location.pathname); }
  home();
}

// ---------- início ----------

async function home() {
  document.body.classList.remove("is-app");
  const list = user ? await store.listNotebooks(user.email) : [];
  app.innerHTML = `
    <div class="home">
      <header class="top">
        <span class="brand">Traço<svg viewBox="0 0 120 12" preserveAspectRatio="none" aria-hidden="true"><path d="M2 8c14-6 26 4 40-1s22-5 36 0 26 2 40-3" /></svg></span>
        <span class="bar-gap"></span>
        ${user
          ? `<button class="btn is-quiet" data-a="user">${icon("user", 18)}<span class="user-mail">${esc(user.email)}</span></button>`
          : `<button class="btn" data-a="login">Entrar</button>`}
      </header>
      <main>
        <section class="sheet" aria-labelledby="watch-h">
          <h1 id="watch-h">Assistir a uma transmissão</h1>
          <p>Digite o código de 6 dígitos que o apresentador mostrou.</p>
          <form class="code-form" novalidate>
            <label class="code">
              <input inputmode="numeric" pattern="[0-9]*" autocomplete="off" maxlength="6" aria-label="Código da transmissão">
              <span class="cell"></span><span class="cell"></span><span class="cell"></span><i></i><span class="cell"></span><span class="cell"></span><span class="cell"></span>
            </label>
            <button class="btn is-primary" type="submit">Entrar na transmissão</button>
          </form>
          <p class="code-error" role="alert"></p>
        </section>
        ${user ? shelf(list) : `
        <section class="cta">
          <h2>Vai apresentar?</h2>
          <p>Entre com a conta criada para você pelo administrador. Depois é só abrir um caderno ou PDF, escrever e tocar em Transmitir.</p>
          <button class="btn" data-a="login">Entrar na conta</button>
        </section>`}
      </main>
      <input type="file" accept="application/pdf,.pdf" hidden data-f="pdf">
    </div>`;
  bindCode();
  app.querySelector(".home").addEventListener("click", onHomeClick);
  const f = app.querySelector('[data-f="pdf"]');
  f.addEventListener("change", () => { const file = f.files[0]; f.value = ""; if (file) importPdf(file); });
}

function shelf(list) {
  const covers = list.map((nb) => `
    <article class="cover" style="--c:${esc(nb.color)}">
      <button class="cover-open" data-open="${nb.id}">
        <span class="cover-label"><strong>${esc(nb.name)}</strong>
        <small>${nb.pages.length} ${nb.pages.length === 1 ? "página" : "páginas"}, ${paperLabel(nb.paper.type)}</small></span>
      </button>
      <button class="ib is-small cover-more" data-more="${nb.id}" aria-label="Opções de ${esc(nb.name)}">${icon("more", 18)}</button>
    </article>`).join("");
  return `
    <section class="shelf" aria-labelledby="shelf-h">
      <div class="shelf-head">
        <h2 id="shelf-h">Seus cadernos</h2>
        <span class="bar-gap"></span>
        <button class="btn" data-a="import">${icon("pdf", 18)} Abrir um PDF</button>
        <button class="btn is-primary" data-a="new">${icon("plus", 18)} Novo caderno</button>
      </div>
      <p class="notice"><strong>${list.length} de ${store.MAX_NOTEBOOKS} cadernos.</strong>
        Só os ${store.MAX_NOTEBOOKS} mais recentes ficam guardados, e apenas neste aparelho. Ao criar mais um, o mais antigo é apagado.
        Exporte em PDF o que você quiser manter.</p>
      ${list.length ? `<div class="covers">${covers}</div>` : `<p class="empty">Nenhum caderno ainda. Crie um caderno em branco ou abra um PDF para escrever por cima.</p>`}
    </section>`;
}

function bindCode() {
  const form = app.querySelector(".code-form");
  const input = form.querySelector("input");
  const cells = [...form.querySelectorAll(".cell")];
  const err = app.querySelector(".code-error");
  const btn = form.querySelector("button");
  const paint = () => {
    const v = input.value;
    cells.forEach((c, i) => {
      c.textContent = v[i] || "";
      c.classList.toggle("is-next", document.activeElement === input && i === Math.min(v.length, 5));
    });
  };
  input.addEventListener("input", () => {
    input.value = input.value.replace(/\D/g, "").slice(0, 6);
    err.textContent = "";
    paint();
    if (input.value.length === 6) form.requestSubmit();
  });
  input.addEventListener("focus", paint);
  input.addEventListener("blur", paint);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const code = input.value;
    if (code.length !== 6) { err.textContent = "O código tem 6 dígitos."; input.focus(); return; }
    if (btn.disabled) return;
    btn.disabled = true;
    try {
      if (await roomIsLive(code)) {
        sessionStorage.setItem(WATCH_KEY, code);
        location.hash = "ao-vivo";
        return;
      }
      err.textContent = "Nenhuma transmissão ao vivo com este código. Confira os números com o apresentador.";
      input.select();
    } catch {
      err.textContent = "Sem conexão com o servidor. Confira a internet e tente de novo.";
    }
    btn.disabled = false;
  });
  paint();
}

function onHomeClick(e) {
  const b = e.target.closest("button");
  if (!b) return;
  const a = b.dataset.a;
  if (a === "login") loginDialog();
  else if (a === "user") userMenu(b);
  else if (a === "new") newDialog();
  else if (a === "import") app.querySelector('[data-f="pdf"]').click();
  else if (b.dataset.open) location.hash = "c/" + b.dataset.open;
  else if (b.dataset.more) coverMenu(b, b.dataset.more);
}

// ---------- conta ----------

function loginDialog() {
  const m = modal(`
    <form class="form">
      <h2>Entrar</h2>
      <label class="field"><span>E-mail</span><input type="email" name="email" autocomplete="username" required autofocus></label>
      <label class="field"><span>Senha</span><input type="password" name="password" autocomplete="current-password" required></label>
      <p class="form-error" role="alert"></p>
      <div class="row end"><button class="btn" type="button" data-close>Cancelar</button><button class="btn is-primary" type="submit">Entrar</button></div>
    </form>`, { cls: "is-small" });
  const form = m.el.querySelector("form");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = form.querySelector('[type="submit"]');
    btn.disabled = true;
    try {
      const r = await api("/api/login", { email: form.email.value, password: form.password.value });
      user = { email: r.email, role: r.role, token: r.token };
      setSession(user);
      store.persist();
      m.close();
      home();
    } catch (er) {
      form.querySelector(".form-error").textContent = er.message;
      btn.disabled = false;
    }
  });
}

function userMenu(btn) {
  const el = h(`<div class="menu">
    ${user.role === "admin" ? `<button data-m="users">${icon("users", 20)}<span>Usuários</span></button>` : ""}
    <button data-m="pass">${icon("key", 20)}<span>Trocar minha senha</span></button>
    <button data-m="out">${icon("out", 20)}<span>Sair da conta</span></button>
  </div>`);
  const pop = popover(btn, el);
  el.addEventListener("click", async (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    pop.close();
    if (b.dataset.m === "users") usersDialog();
    else if (b.dataset.m === "pass") passwordDialog();
    else {
      api("/api/logout", {}).catch(() => {});
      setSession(null);
      user = null;
      home();
    }
  });
}

function passwordDialog() {
  const m = modal(`
    <form class="form">
      <h2>Trocar minha senha</h2>
      <label class="field"><span>Senha atual</span><input type="password" name="current" autocomplete="current-password" required autofocus></label>
      <label class="field"><span>Nova senha (6 caracteres ou mais)</span><input type="password" name="next" autocomplete="new-password" minlength="6" required></label>
      <p class="form-error" role="alert"></p>
      <div class="row end"><button class="btn" type="button" data-close>Cancelar</button><button class="btn is-primary" type="submit">Salvar nova senha</button></div>
    </form>`, { cls: "is-small" });
  const form = m.el.querySelector("form");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await api("/api/password", { current: form.current.value, next: form.next.value });
      m.close();
      toast("Nova senha salva.");
    } catch (er) { form.querySelector(".form-error").textContent = er.message; }
  });
}

// Tela do administrador: cadastrar e remover usuários.
function usersDialog() {
  const m = modal(`
    <div class="drawer-head"><h2>Usuários</h2><button class="ib" data-close aria-label="Fechar">${icon("x")}</button></div>
    <p class="muted">Quem tem conta pode abrir cadernos e transmitir. Para assistir não é preciso conta, só o código.</p>
    <form class="form user-add">
      <label class="field"><span>E-mail do novo usuário</span><input type="email" name="email" autocomplete="off" required></label>
      <label class="field"><span>Senha (6 caracteres ou mais)</span><input type="text" name="password" autocomplete="off" minlength="6" required></label>
      <button class="btn is-primary" type="submit">Cadastrar usuário</button>
      <p class="form-error" role="alert"></p>
    </form>
    <ul class="users" aria-live="polite"><li class="muted">Carregando…</li></ul>`, { cls: "is-users" });
  const ul = m.el.querySelector(".users");
  const form = m.el.querySelector("form");
  const err = form.querySelector(".form-error");
  const load = async () => {
    try {
      const { users } = await api("/api/users");
      ul.innerHTML = users.map((u) => `
        <li><span class="u-mail">${esc(u.email)}</span>
        ${u.role === "admin" ? `<span class="tag">administrador</span>` : `<button class="ib is-small" data-rm="${esc(u.email)}" aria-label="Remover ${esc(u.email)}">${icon("trash", 16)}</button>`}</li>`).join("");
    } catch (er) { ul.innerHTML = `<li class="form-error">${esc(er.message)}</li>`; }
  };
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    err.textContent = "";
    try {
      await api("/api/users", { email: form.email.value, password: form.password.value });
      toast("Usuário cadastrado.");
      form.reset();
      load();
    } catch (er) { err.textContent = er.message; }
  });
  ul.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-rm]");
    if (!b) return;
    const email = b.dataset.rm;
    if (!(await confirmBox({ title: "Remover este usuário?", text: `${email} não poderá mais entrar nem transmitir.`, ok: "Remover usuário", danger: true }))) return;
    try { await api("/api/users/remove", { email }); toast("Usuário removido."); load(); }
    catch (er) { toast(er.message, { error: true }); }
  });
  load();
}

// ---------- cadernos ----------

// No limite, avisa qual caderno será apagado antes de criar outro.
async function roomForOneMore() {
  const old = await store.oldestIfFull(user.email);
  if (!old) return true;
  return confirmBox({
    title: `Você já tem ${store.MAX_NOTEBOOKS} cadernos`,
    text: `Criar mais um apaga o mais antigo: “${old.name}”. Se quiser guardá-lo, cancele, abra esse caderno e exporte em PDF antes.`,
    ok: "Criar e apagar o mais antigo", danger: true,
  });
}

async function createNotebook(data) {
  const nb = {
    id: uid(), owner: user.email, name: data.name, color: data.color,
    paper: { type: data.type, size: data.size }, orient: data.orient,
    pages: [], created: Date.now(), updated: Date.now(),
  };
  await store.putNotebook(nb);
  const removed = await store.enforceLimit(user.email);
  if (removed.length) toast(`“${removed[0].name}” foi apagado para abrir espaço.`, { ms: 5000 });
  return nb;
}

function newDialog() {
  const st = { type: "lined", size: 40, orient: "p", color: COVERS[0] };
  const m = modal(`
    <form class="form">
      <h2>Novo caderno</h2>
      <label class="field"><span>Nome</span><input name="name" maxlength="60" placeholder="Ex.: Física, 2º ano" autofocus></label>
      <div class="field"><span>Papel</span>
        <div class="papers">
          ${[["blank", "Em branco"], ["lined", "Pautado"], ["grid", "Quadriculado"]].map(([k, l]) => `<button type="button" class="paper-opt" data-type="${k}"><i class="pv pv-${k}"></i>${l}</button>`).join("")}
        </div>
      </div>
      <label class="field" data-size><span>Tamanho das linhas</span><input type="range" min="18" max="90" value="40"></label>
      <p class="note">As linhas ficam bem clarinhas e aparecem só para você. Quem assiste vê a página em branco.</p>
      <div class="field"><span>Folha</span>
        <div class="seg"><button type="button" class="chip" data-orient="p">Em pé</button><button type="button" class="chip" data-orient="l">Deitada</button></div>
      </div>
      <div class="field"><span>Cor da capa</span>
        <div class="row">${COVERS.map((c) => `<button type="button" class="dot" style="--c:${c}" data-cover="${c}" aria-label="Capa ${c}"></button>`).join("")}</div>
      </div>
      <div class="row end"><button class="btn" type="button" data-close>Cancelar</button><button class="btn is-primary" type="submit">Criar caderno</button></div>
    </form>`, { cls: "is-new" });
  const el = m.el;
  const range = el.querySelector('input[type="range"]');
  const sync = () => {
    el.querySelectorAll("[data-type]").forEach((b) => b.classList.toggle("is-on", b.dataset.type === st.type));
    el.querySelectorAll("[data-orient]").forEach((b) => b.classList.toggle("is-on", b.dataset.orient === st.orient));
    el.querySelectorAll("[data-cover]").forEach((b) => b.classList.toggle("is-on", b.dataset.cover === st.color));
    el.querySelector("[data-size]").hidden = st.type === "blank";
    el.style.setProperty("--gap", Math.round(st.size / 3.4) + "px");
  };
  el.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.type) st.type = b.dataset.type;
    else if (b.dataset.orient) st.orient = b.dataset.orient;
    else if (b.dataset.cover) st.color = b.dataset.cover;
    else return;
    sync();
  });
  range.addEventListener("input", () => { st.size = +range.value; sync(); });
  el.querySelector("form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = el.querySelector('[name="name"]').value.trim() || "Caderno sem nome";
    m.close();
    if (!(await roomForOneMore())) return;
    const nb = await createNotebook({ ...st, name });
    location.hash = "c/" + nb.id;
  });
  sync();
}

async function importPdf(file) {
  if (!(await roomForOneMore())) return;
  const t = toast("Abrindo o PDF…", { sticky: true });
  let nb;
  try {
    nb = await createNotebook({ name: file.name.replace(/\.pdf$/i, "").slice(0, 60) || "PDF", color: COVERS[5], type: "blank", size: 40, orient: "p" });
    for await (const pg of readPdf(file, (i, total) => t.update(`Importando o PDF: página ${i} de ${total}`))) {
      const p = { id: uid(), nb: nb.id, w: pg.w, h: pg.h, bg: pg.bg, hasBg: true, items: [] };
      await store.putPage(p, true);
      nb.pages.push(p.id);
    }
    if (!nb.pages.length) throw new Error("vazio");
    await store.putNotebook(nb);
    t.close();
    location.hash = "c/" + nb.id;
  } catch (e) {
    console.error(e);
    t.close();
    if (nb) await store.deleteNotebook(nb.id).catch(() => {});
    toast("Não foi possível ler esse PDF. Ele pode estar protegido por senha ou corrompido.", { error: true, ms: 6000 });
    home();
  }
}

function coverMenu(btn, id) {
  const el = h(`<div class="menu">
    <button data-m="rename">${icon("pen", 20)}<span>Renomear</span></button>
    <button data-m="del" class="is-danger">${icon("trash", 20)}<span>Excluir caderno</span></button>
  </div>`);
  const pop = popover(btn, el);
  el.addEventListener("click", async (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    pop.close();
    const nb = await store.getNotebook(id);
    if (!nb) return;
    if (b.dataset.m === "rename") {
      const m = modal(`<form class="form"><h2>Renomear caderno</h2>
        <label class="field"><span>Nome</span><input name="name" maxlength="60" value="${esc(nb.name)}" autofocus></label>
        <div class="row end"><button class="btn" type="button" data-close>Cancelar</button><button class="btn is-primary" type="submit">Salvar nome</button></div></form>`, { cls: "is-small" });
      m.el.querySelector("form").addEventListener("submit", async (ev) => {
        ev.preventDefault();
        nb.name = m.el.querySelector("input").value.trim() || nb.name;
        await store.putNotebook(nb);
        m.close();
        home();
      });
    } else if (await confirmBox({ title: "Excluir este caderno?", text: `“${nb.name}” e todas as suas páginas serão apagados deste aparelho. Isso não pode ser desfeito.`, ok: "Excluir caderno", danger: true })) {
      await store.deleteNotebook(id);
      home();
    }
  });
}
