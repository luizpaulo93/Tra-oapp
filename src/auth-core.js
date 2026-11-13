// Contas e sessões. Um único objeto guarda todos os usuários.
// As senhas nunca são guardadas: só um resumo (PBKDF2 com sal).
//
// Administradores: a configuração guarda o resumo SHA-256 do e-mail de cada
// um (ADMIN_EMAIL_SHA256, separados por vírgula). Nenhuma senha e nenhum
// e-mail ficam no código. No primeiro login com um desses e-mails, a conta
// de administrador é criada com a senha digitada naquele momento. Se o
// e-mail já tiver conta comum, ela vira administradora no próximo login.
// Contas de administrador não podem ser removidas por ninguém.

const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const ITERATIONS = 40000;
const MAX_USERS = 500;

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const fromHex = (s) => new Uint8Array(s.match(/../g).map((h) => parseInt(h, 16)));
const rand = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));
const normEmail = (e) => String(e || "").trim().toLowerCase();
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 120;

async function hashPassword(password, saltHex) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: fromHex(saltHex), iterations: ITERATIONS },
    key, 256
  );
  return hex(bits);
}

function sameText(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

const ok = (body) => ({ status: 200, body });
const fail = (status, error, message) => ({ status, body: { error, message } });

export class AuthCore {
  // admin: { email?, hash? } — o e-mail em texto ou o seu resumo SHA-256
  constructor(ctx, admin = {}) {
    this.ctx = ctx;
    const list = (v) => String(v || "").toLowerCase().split(/[\s,;]+/).filter(Boolean);
    this.adminEmails = list(admin.email);
    this.adminHashes = list(admin.hash);
    this.ready = false;
    this.fails = new Map(); // e-mail -> { n, until }
  }

  get sql() { return this.ctx.storage.sql; }

  ensure() {
    if (this.ready) return;
    this.sql.exec("CREATE TABLE IF NOT EXISTS users (email TEXT PRIMARY KEY, salt TEXT, hash TEXT, role TEXT, created INTEGER)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, email TEXT, exp INTEGER)");
    this.ready = true;
  }

  user(email) {
    return this.sql.exec("SELECT email, salt, hash, role, created FROM users WHERE email = ?", email).toArray()[0] || null;
  }

  session(token) {
    if (!token || typeof token !== "string") return null;
    const s = this.sql.exec("SELECT email, exp FROM sessions WHERE token = ?", token).toArray()[0];
    if (!s || s.exp < Date.now()) return null;
    const u = this.user(s.email);
    return u ? { email: u.email, role: u.role } : null;
  }

  async setPassword(email, password, role) {
    const salt = rand(16);
    const hash = await hashPassword(password, salt);
    const cur = this.user(email);
    if (cur) this.sql.exec("UPDATE users SET salt = ?, hash = ? WHERE email = ?", salt, hash, email);
    else this.sql.exec("INSERT INTO users (email, salt, hash, role, created) VALUES (?, ?, ?, ?, ?)", email, salt, hash, role, Date.now());
  }

  async rpc(op, a = {}) {
    this.ensure();
    switch (op) {
      case "login": return this.login(a);
      case "logout":
        if (a.token) this.sql.exec("DELETE FROM sessions WHERE token = ?", String(a.token));
        return ok({});
      case "me": {
        const me = this.session(a.token);
        return me ? ok(me) : fail(401, "auth", "Entre de novo para continuar.");
      }
      case "verify": {
        const me = this.session(a.token);
        return ok({ ok: !!me, ...(me || {}) });
      }
      case "list": {
        const me = this.session(a.token);
        if (!me || me.role !== "admin") return fail(403, "forbidden", "Só o administrador vê os usuários.");
        return ok({ users: this.sql.exec("SELECT email, role, created FROM users ORDER BY created").toArray() });
      }
      case "add": return this.add(a);
      case "remove": {
        const me = this.session(a.token);
        if (!me || me.role !== "admin") return fail(403, "forbidden", "Só o administrador remove usuários.");
        const email = normEmail(a.email);
        const u = this.user(email);
        if (!u) return fail(404, "missing", "Usuário não encontrado.");
        if (u.role === "admin") return fail(400, "admin", "A conta de administrador não pode ser removida.");
        this.sql.exec("DELETE FROM sessions WHERE email = ?", email);
        this.sql.exec("DELETE FROM users WHERE email = ?", email);
        return ok({});
      }
      case "password": return this.password(a);
    }
    return fail(404, "not_found", "Operação desconhecida.");
  }

  async login(a) {
    const email = normEmail(a.email);
    const password = String(a.password || "");
    if (!validEmail(email) || !password) return fail(400, "invalid", "Informe e-mail e senha.");

    const f = this.fails.get(email);
    if (f && f.until > Date.now()) {
      return fail(429, "wait", "Muitas tentativas. Aguarde um minuto e tente de novo.");
    }

    let u = this.user(email);
    const isAdmin = await this.isAdminEmail(email);
    // Primeiro acesso de um administrador: a senha digitada passa a ser a senha.
    if (!u && isAdmin) {
      if (password.length < 6) return fail(400, "weak", "A senha precisa ter pelo menos 6 caracteres.");
      await this.setPassword(email, password, "admin");
      u = this.user(email);
    }

    const good = u ? sameText(await hashPassword(password, u.salt), u.hash) : false;
    if (!good) {
      const n = ((f && f.n) || 0) + 1;
      this.fails.set(email, { n, until: n >= 5 ? Date.now() + 60000 : 0 });
      if (this.fails.size > 2000) this.fails.clear();
      return fail(401, "wrong", "E-mail ou senha incorretos.");
    }
    this.fails.delete(email);
    // E-mail de administrador que já tinha conta comum: passa a administrar.
    if (isAdmin && u.role !== "admin") {
      this.sql.exec("UPDATE users SET role = 'admin' WHERE email = ?", email);
      u = this.user(email);
    }

    this.sql.exec("DELETE FROM sessions WHERE exp < ?", Date.now());
    const token = rand(32);
    this.sql.exec("INSERT INTO sessions (token, email, exp) VALUES (?, ?, ?)", token, email, Date.now() + SESSION_MS);
    return ok({ token, email, role: u.role });
  }

  async isAdminEmail(email) {
    if (this.adminEmails.includes(email)) return true;
    if (!this.adminHashes.length) return false;
    return this.adminHashes.includes(hex(await crypto.subtle.digest("SHA-256", enc.encode(email))));
  }

  async add(a) {
    const me = this.session(a.token);
    if (!me || me.role !== "admin") return fail(403, "forbidden", "Só o administrador cadastra usuários.");
    const email = normEmail(a.email);
    const password = String(a.password || "");
    if (!validEmail(email)) return fail(400, "email", "Esse e-mail não parece válido.");
    if (password.length < 6) return fail(400, "weak", "A senha precisa ter pelo menos 6 caracteres.");
    if (this.user(email)) return fail(409, "exists", "Já existe um usuário com esse e-mail.");
    const count = this.sql.exec("SELECT COUNT(*) AS n FROM users").toArray()[0].n;
    if (count >= MAX_USERS) return fail(400, "full", "Limite de usuários atingido.");
    await this.setPassword(email, password, "user");
    return ok({ email, role: "user" });
  }

  async password(a) {
    const me = this.session(a.token);
    if (!me) return fail(401, "auth", "Entre de novo para continuar.");
    const next = String(a.next || "");
    if (next.length < 6) return fail(400, "weak", "A nova senha precisa ter pelo menos 6 caracteres.");
    const u = this.user(me.email);
    if (!sameText(await hashPassword(String(a.current || ""), u.salt), u.hash)) {
      return fail(401, "wrong", "A senha atual não confere.");
    }
    await this.setPassword(me.email, next, u.role);
    // encerra as outras sessões dessa conta
    this.sql.exec("DELETE FROM sessions WHERE email = ? AND token != ?", me.email, String(a.token));
    return ok({});
  }
}
