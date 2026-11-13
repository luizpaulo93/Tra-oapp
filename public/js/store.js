// Cadernos guardados neste aparelho (IndexedDB).
// Só os 10 cadernos mais recentes de cada conta são mantidos.

export const MAX_NOTEBOOKS = 10;

let dbp;
function db() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const rq = indexedDB.open("traco", 1);
      rq.onupgradeneeded = () => {
        const d = rq.result;
        d.createObjectStore("nbs", { keyPath: "id" });
        d.createObjectStore("pages", { keyPath: "id" });
        d.createObjectStore("blobs");
      };
      rq.onsuccess = () => resolve(rq.result);
      rq.onerror = () => reject(rq.error);
    });
  }
  return dbp;
}

async function tx(stores, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(stores, mode);
    let out;
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
    out = fn(...[].concat(stores).map((s) => t.objectStore(s)));
  });
}

const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export async function listNotebooks(owner) {
  const d = await db();
  const all = await req(d.transaction("nbs").objectStore("nbs").getAll());
  return all.filter((n) => n.owner === owner).sort((a, b) => b.updated - a.updated);
}

export async function getNotebook(id) {
  const d = await db();
  return req(d.transaction("nbs").objectStore("nbs").get(id));
}

export function putNotebook(nb) {
  return tx("nbs", "readwrite", (s) => { s.put(nb); });
}

export async function deleteNotebook(id) {
  const nb = await getNotebook(id);
  if (!nb) return;
  for (const pid of nb.pages) await deletePage(pid);
  await tx("nbs", "readwrite", (s) => { s.delete(id); });
}

// O caderno mais antigo, se a conta já estiver no limite.
export async function oldestIfFull(owner) {
  const list = await listNotebooks(owner);
  return list.length >= MAX_NOTEBOOKS ? list[list.length - 1] : null;
}

// Apaga os cadernos que passaram do limite (os mais antigos primeiro).
export async function enforceLimit(owner) {
  const list = await listNotebooks(owner);
  const removed = [];
  for (const nb of list.slice(MAX_NOTEBOOKS)) {
    await deleteNotebook(nb.id);
    removed.push(nb);
  }
  return removed;
}

// Página: { id, nb, w, h, bg?:dataURL, items:[...] }
// O fundo e as fotos ficam em registros separados para o salvamento de
// cada traço ser leve.
export async function getPage(id) {
  const d = await db();
  const rec = await req(d.transaction("pages").objectStore("pages").get(id));
  if (!rec) return null;
  const page = { id: rec.id, nb: rec.nb, w: rec.w, h: rec.h, hasBg: !!rec.hasBg, items: rec.items || [], imgIds: rec.imgIds || [] };
  const blobs = d.transaction("blobs").objectStore("blobs");
  const jobs = [];
  if (rec.hasBg) jobs.push(req(blobs.get("bg:" + id)).then((v) => { page.bg = v; }));
  for (const it of page.items) {
    if (it.k === "i" && !it.src) jobs.push(req(blobs.get("im:" + it.id)).then((v) => { it.src = v; }));
  }
  await Promise.all(jobs);
  page._savedImgs = new Set(page.items.filter((it) => it.k === "i").map((it) => it.id));
  return page;
}

export async function getBg(id) {
  const d = await db();
  return req(d.transaction("blobs").objectStore("blobs").get("bg:" + id));
}

export function putPage(page, withBlobs) {
  const imgIds = new Set(page.imgIds || []);
  const items = page.items.map((it) => {
    if (it.k !== "i") return it;
    imgIds.add(it.id);
    const { src, ...rest } = it;
    return rest;
  });
  page.imgIds = [...imgIds];
  const known = page._savedImgs || (page._savedImgs = new Set());
  return tx(["pages", "blobs"], "readwrite", (pages, blobs) => {
    pages.put({ id: page.id, nb: page.nb, w: page.w, h: page.h, hasBg: !!(page.hasBg || page.bg), items, imgIds: page.imgIds });
    if (withBlobs && page.bg) blobs.put(page.bg, "bg:" + page.id);
    for (const it of page.items) {
      if (it.k === "i" && it.src && !known.has(it.id)) { blobs.put(it.src, "im:" + it.id); known.add(it.id); }
    }
  });
}

export async function deletePage(id) {
  const d = await db();
  const rec = await req(d.transaction("pages").objectStore("pages").get(id));
  await tx(["pages", "blobs"], "readwrite", (pages, blobs) => {
    pages.delete(id);
    blobs.delete("bg:" + id);
    for (const im of (rec && rec.imgIds) || []) blobs.delete("im:" + im);
  });
}

// Pede ao navegador para não apagar os dados por conta própria.
export function persist() {
  try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch {}
}
