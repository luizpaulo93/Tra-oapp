// Rotas da API. Mesma lógica na Cloudflare e no servidor de testes local;
// só muda `env`, que sabe falar com as salas e com o cadastro de usuários.
//
// req: { method, path, query(URLSearchParams), token, json(): Promise<obj> }
// env: { auth(op, args), roomCreate(code), roomStatus(code, key), randomCode() }
// retorna { status, body }

export async function handleApi(req, env) {
  const { method, path, token } = req;
  const post = method === "POST";
  const body = async () => {
    try { return (await req.json()) || {}; } catch { return {}; }
  };

  if (path === "/api/login" && post) {
    const b = await body();
    return env.auth("login", { email: b.email, password: b.password });
  }
  if (path === "/api/logout" && post) return env.auth("logout", { token });
  if (path === "/api/me" && method === "GET") return env.auth("me", { token });
  if (path === "/api/users" && method === "GET") return env.auth("list", { token });
  if (path === "/api/users" && post) {
    const b = await body();
    return env.auth("add", { token, email: b.email, password: b.password });
  }
  if (path === "/api/users/remove" && post) {
    const b = await body();
    return env.auth("remove", { token, email: b.email });
  }
  if (path === "/api/password" && post) {
    const b = await body();
    return env.auth("password", { token, current: b.current, next: b.next });
  }

  // Criar transmissão: só para quem está logado.
  if (path === "/api/rooms" && post) {
    const v = await env.auth("verify", { token });
    if (!v.body.ok) return { status: 401, body: { error: "auth", message: "Entre com sua conta para transmitir." } };
    for (let i = 0; i < 10; i++) {
      const code = env.randomCode();
      const r = await env.roomCreate(code);
      if (r.ok) return { status: 200, body: { code, key: r.key } };
    }
    return { status: 503, body: { error: "busy", message: "Não foi possível criar a transmissão. Tente de novo." } };
  }

  // A transmissão está no ar?
  const m = path.match(/^\/api\/rooms\/(\d{6})$/);
  if (m && method === "GET") {
    const d = await env.roomStatus(m[1], req.query.get("key") || "");
    return { status: d.live ? 200 : 404, body: d };
  }

  return { status: 404, body: { error: "not_found" } };
}

export function bearer(header) {
  const m = /^Bearer\s+([0-9a-f]{64})$/i.exec(header || "");
  return m ? m[1] : "";
}
