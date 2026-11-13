// Geometria e desenho da tinta. Usado pelo apresentador, pelo espectador
// e pela exportação em PDF, para que o traço seja idêntico nos três.
//
// Traço: { id, k:'s', t:'pen'|'hl', c:'#rrggbb', w:espessura, p:[x,y,pressão, ...] }
// Imagem: { id, k:'i', x, y, w, h, src:dataURL }
// Coordenadas em unidades de página (uma página retrato tem 1000 de largura).

const TAU = Math.PI * 2;
const pathCache = new WeakMap();
const boxCache = new WeakMap();

export function uid() {
  const a = new Uint8Array(9);
  crypto.getRandomValues(a);
  let s = "";
  for (const b of a) s += b.toString(36).padStart(2, "0");
  return s.slice(0, 12);
}

export function radiusAt(s, i) {
  const half = s.w / 2;
  if (s.t !== "pen") return half;
  const pr = s.p[i * 3 + 2];
  return half * (0.7 + 0.6 * pr); // a pressão engrossa ou afina, sem exagero
}

// Linha central suavizada: tira o tremor fino da caneta (que amostra a
// posição centenas de vezes por segundo) sem mudar o desenho. Formas
// geométricas (s.g) ficam como estão, com cantos vivos.
function centerline(s) {
  const p = s.p;
  const n = p.length / 3;
  const X = new Float64Array(n), Y = new Float64Array(n), R = new Float64Array(n);
  for (let i = 0; i < n; i++) { X[i] = p[i * 3]; Y[i] = p[i * 3 + 1]; R[i] = radiusAt(s, i); }
  if (s.g || n < 3) return { X, Y, R, n };
  for (let pass = 0; pass < 2; pass++) {
    let px = X[0], py = Y[0], pr = R[0];
    for (let i = 1; i < n - 1; i++) {
      const cx = X[i], cy = Y[i], cr = R[i];
      X[i] = (px + 2 * cx + X[i + 1]) / 4;
      Y[i] = (py + 2 * cy + Y[i + 1]) / 4;
      R[i] = (pr + 2 * cr + R[i + 1]) / 4;
      px = cx; py = cy; pr = cr;
    }
  }
  return { X, Y, R, n };
}

// Contorno do traço: um polígono que acompanha a linha central com a
// espessura variando conforme a pressão, com pontas arredondadas.
function outline(s) {
  const { X, Y, R, n } = centerline(s);
  const left = [];
  const right = [];
  let tx = 1, ty = 0;
  let lastLx = NaN, lastLy = NaN, lastRx = NaN, lastRy = NaN;
  const minD2 = Math.max(0.04, (s.w * 0.08) ** 2);

  for (let i = 0; i < n; i++) {
    const x = X[i], y = Y[i], r = R[i];
    // direção medida numa janela larga, para não oscilar com pontos muito próximos
    const a = Math.max(i - 2, 0), b = Math.min(i + 2, n - 1);
    const dx = X[b] - X[a], dy = Y[b] - Y[a];
    const len = Math.hypot(dx, dy);
    if (len > 1e-6) { tx = dx / len; ty = dy / len; }

    // Canto fechado de verdade (volta de mais de 100°, com trechos de tamanho
    // real): contorna o ponto com um círculo para a ponta não ficar "amassada".
    if (i > 0 && i < n - 1) {
      const d1x = x - X[i - 1], d1y = y - Y[i - 1];
      const d2x = X[i + 1] - x, d2y = Y[i + 1] - y;
      const l1 = Math.hypot(d1x, d1y), l2 = Math.hypot(d2x, d2y);
      if (l1 > 0.5 && l2 > 0.5 && (d1x * d2x + d1y * d2y) / (l1 * l2) < -0.2) {
        const ox = (-d1y / l1) * r, oy = (d1x / l1) * r;
        for (let k = 0; k <= 6; k++) {
          const ang = (Math.PI * k) / 6;
          const c = Math.cos(ang), sn = Math.sin(ang);
          left.push(x + (-ox * c - -oy * sn), y + (-ox * sn + -oy * c));
          right.push(x + (ox * c + oy * sn), y + (-ox * sn + oy * c));
        }
        lastLx = lastRx = NaN;
        continue;
      }
    }

    const nx = -ty * r, ny = tx * r;
    const lx = x - nx, ly = y - ny, rx = x + nx, ry = y + ny;
    const end = i === n - 1;
    if (end || !((lx - lastLx) ** 2 + (ly - lastLy) ** 2 < minD2)) {
      left.push(lx, ly); lastLx = lx; lastLy = ly;
    }
    if (end || !((rx - lastRx) ** 2 + (ry - lastRy) ** 2 < minD2)) {
      right.push(rx, ry); lastRx = rx; lastRy = ry;
    }
  }
  return { left, right };
}

// Corta a linha em trechos "ligados" de comprimento `dash`, separados por `gap`.
function dashRuns(p, count, dash, gap) {
  const runs = [];
  let on = true, left = dash, cur = [p[0], p[1], p[2]];
  for (let i = 1; i < count; i++) {
    const ax = p[i * 3 - 3], ay = p[i * 3 - 2], bx = p[i * 3], by = p[i * 3 + 1], pr = p[i * 3 + 2];
    const L = Math.hypot(bx - ax, by - ay);
    let pos = 0;
    while (L - pos > left) {
      pos += left;
      const t = pos / L, x = ax + (bx - ax) * t, y = ay + (by - ay) * t;
      if (on) { cur.push(x, y, pr); runs.push(cur); cur = []; } else cur = [x, y, pr];
      on = !on;
      left = on ? dash : gap;
    }
    left -= L - pos;
    if (on) cur.push(bx, by, pr);
  }
  if (on && cur.length >= 6) runs.push(cur);
  return runs;
}

// Traço: { ..., g:1 = forma geométrica, d:1 = pontilhado, dn = quantos pontos
// do início são pontilhados (na seta, a ponta fica contínua) }
export function strokePath(s) {
  let path = pathCache.get(s);
  if (path) return path;
  const n = s.p.length / 3;
  if (s.d && n >= 2) {
    path = new Path2D();
    const dn = Math.min(n, s.dn || n);
    const dash = Math.max(9, s.w * 3.2), gap = Math.max(7, s.w * 2.6);
    for (const run of dashRuns(s.p, dn, dash, gap)) path.addPath(solidPath({ t: s.t, w: s.w, g: 1, p: run }));
    if (dn < n) path.addPath(solidPath({ t: s.t, w: s.w, g: 1, p: s.p.slice((dn - 1) * 3) }));
  } else path = solidPath(s);
  pathCache.set(s, path);
  return path;
}

function solidPath(s) {
  const path = new Path2D();
  const p = s.p;
  const n = p.length / 3;
  if (n === 0) return path;

  let span = 0;
  for (let i = 1; i < n && span < 0.5; i++) {
    span += Math.hypot(p[i * 3] - p[i * 3 - 3], p[i * 3 + 1] - p[i * 3 - 2]);
  }
  if (n === 1 || span < 0.5) { // um ponto: bolinha
    const r = Math.max(radiusAt(s, 0), 0.3);
    path.arc(p[0], p[1], r, 0, TAU);
    return path;
  }

  const { left, right } = outline(s);
  const pts = [];
  for (let i = 0; i < left.length; i += 2) pts.push(left[i], left[i + 1]);
  // ponta final
  cap(pts, p[(n - 1) * 3], p[(n - 1) * 3 + 1], left[left.length - 2], left[left.length - 1], right[right.length - 2], right[right.length - 1]);
  for (let i = right.length - 2; i >= 0; i -= 2) pts.push(right[i], right[i + 1]);
  // ponta inicial
  cap(pts, p[0], p[1], right[0], right[1], left[0], left[1]);

  const m = pts.length / 2;
  path.moveTo((pts[0] + pts[2]) / 2, (pts[1] + pts[3]) / 2);
  for (let i = 1; i <= m; i++) {
    const a = (i % m) * 2, b = ((i + 1) % m) * 2;
    path.quadraticCurveTo(pts[a], pts[a + 1], (pts[a] + pts[b]) / 2, (pts[a + 1] + pts[b + 1]) / 2);
  }
  path.closePath();
  return path;
}

// Meia-volta de (ax,ay) até (bx,by) em torno do centro, pelo lado de fora.
function cap(out, cx, cy, ax, ay, bx, by) {
  const a0 = Math.atan2(ay - cy, ax - cx);
  let a1 = Math.atan2(by - cy, bx - cx);
  const r = (Math.hypot(ax - cx, ay - cy) + Math.hypot(bx - cx, by - cy)) / 2;
  let d = a1 - a0;
  while (d <= 0) d += TAU; // sempre no mesmo sentido do contorno
  const steps = 6;
  for (let k = 1; k < steps; k++) {
    const ang = a0 + (d * k) / steps;
    out.push(cx + Math.cos(ang) * r, cy + Math.sin(ang) * r);
  }
}

export function bbox(it) {
  if (it.k === "i") return [it.x, it.y, it.x + it.w, it.y + it.h];
  let b = boxCache.get(it);
  if (b) return b;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const p = it.p;
  for (let i = 0; i < p.length; i += 3) {
    if (p[i] < x0) x0 = p[i];
    if (p[i] > x1) x1 = p[i];
    if (p[i + 1] < y0) y0 = p[i + 1];
    if (p[i + 1] > y1) y1 = p[i + 1];
  }
  const m = it.w;
  b = [x0 - m, y0 - m, x1 + m, y1 + m];
  boxCache.set(it, b);
  return b;
}

function segDist2(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = ax + dx * t, cy = ay + dy * t;
  return (px - cx) ** 2 + (py - cy) ** 2;
}

// O círculo (x,y,r) encosta no traço?
export function hitStroke(s, x, y, r) {
  const b = bbox(s);
  if (x < b[0] - r || x > b[2] + r || y < b[1] - r || y > b[3] + r) return false;
  const p = s.p;
  const n = p.length / 3;
  if (n === 1) return (p[0] - x) ** 2 + (p[1] - y) ** 2 <= (r + radiusAt(s, 0)) ** 2;
  for (let i = 1; i < n; i++) {
    const rr = r + radiusAt(s, i);
    if (segDist2(x, y, p[i * 3 - 3], p[i * 3 - 2], p[i * 3], p[i * 3 + 1]) <= rr * rr) return true;
  }
  return false;
}

// Borracha parcial: devolve os pedaços que sobram do traço (ou null se a
// borracha não encostou nele).
export function eraseFrom(s, x, y, r) {
  if (!hitStroke(s, x, y, r)) return null;
  const src = [];
  const p = dense(s.p, Math.max(1.5, r * 0.5), src);
  const n = p.length / 3;
  const dn = s.d ? s.dn || s.p.length / 3 : 0; // pontos do início que são pontilhados
  const pieces = [];
  let cur = [], dashed = 0;
  const close = () => {
    if (cur.length >= 6) {
      const piece = { id: uid(), k: "s", t: s.t, c: s.c, w: s.w, p: cur };
      if (s.g) piece.g = 1;
      if (dashed >= 2) { piece.d = 1; if (dashed < cur.length / 3) piece.dn = dashed; }
      pieces.push(piece);
    }
    cur = []; dashed = 0;
  };
  const rr = r + radiusAt(s, 0) * 0.5;
  for (let i = 0; i < n; i++) {
    if ((p[i * 3] - x) ** 2 + (p[i * 3 + 1] - y) ** 2 <= rr * rr) close();
    else {
      cur.push(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]);
      if (src[i] < dn) dashed++;
    }
  }
  close();
  return pieces;
}

// Garante que não há pontos mais distantes que `step` (para traços retos).
// `src` recebe, para cada ponto gerado, o índice do ponto original.
function dense(p, step, src = []) {
  const out = [p[0], p[1], p[2]];
  src.push(0);
  for (let i = 3; i < p.length; i += 3) {
    const ax = p[i - 3], ay = p[i - 2], ap = p[i - 1];
    const bx = p[i], by = p[i + 1], bp = p[i + 2];
    const d = Math.hypot(bx - ax, by - ay);
    const k = Math.floor(d / step);
    for (let j = 1; j <= k; j++) {
      const t = j / (k + 1);
      out.push(r1(ax + (bx - ax) * t), r1(ay + (by - ay) * t), ap + (bp - ap) * t);
      src.push(i / 3);
    }
    out.push(bx, by, bp);
    src.push(i / 3);
  }
  return out;
}

export function r1(v) { return Math.round(v * 100) / 100; }

export function inPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 2; i < poly.length; j = i, i += 2) {
    const xi = poly[i], yi = poly[i + 1], xj = poly[j], yj = poly[j + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// O item está (na maior parte) dentro do laço?
export function itemInLasso(it, poly) {
  if (it.k === "i") return inPolygon(it.x + it.w / 2, it.y + it.h / 2, poly);
  const p = it.p;
  let inC = 0, tot = 0;
  const step = Math.max(3, Math.floor(p.length / 3 / 40) * 3);
  for (let i = 0; i < p.length; i += step) {
    tot++;
    if (inPolygon(p[i], p[i + 1], poly)) inC++;
  }
  return inC / tot >= 0.6;
}

export function moved(it, dx, dy) {
  if (it.k === "i") return { ...it, x: r1(it.x + dx), y: r1(it.y + dy) };
  const p = it.p.slice();
  for (let i = 0; i < p.length; i += 3) { p[i] = r1(p[i] + dx); p[i + 1] = r1(p[i + 1] + dy); }
  return { ...it, p };
}

// Aplica uma alteração (apagar ids, depois inserir/substituir itens).
export function applyOp(items, delIds, putItems) {
  const del = new Set(delIds || []);
  const put = new Map((putItems || []).map((it) => [it.id, it]));
  const out = [];
  for (const it of items) {
    if (put.has(it.id)) { out.push(put.get(it.id)); put.delete(it.id); }
    else if (!del.has(it.id)) out.push(it);
  }
  for (const it of put.values()) out.push(it);
  return out;
}

// ---------- formas ----------

export function shapePoints(kind, x0, y0, x1, y1, w = 3) {
  const pts = [];
  const add = (x, y) => pts.push(r1(x), r1(y), 0.5);
  const line = (ax, ay, bx, by) => {
    const d = Math.hypot(bx - ax, by - ay);
    const k = Math.max(1, Math.ceil(d / 6));
    for (let i = pts.length ? 1 : 0; i <= k; i++) add(ax + ((bx - ax) * i) / k, ay + ((by - ay) * i) / k);
  };
  if (kind === "line") line(x0, y0, x1, y1);
  else if (kind === "arrow") {
    line(x0, y0, x1, y1);
    pts.shaft = pts.length / 3; // daqui em diante é a ponta
    const ang = Math.atan2(y1 - y0, x1 - x0);
    // ponta proporcional ao traço (fino = pequena, grosso = grande) e igual
    // para setas curtas ou compridas
    const L = 8 + w * 4.5;
    line(x1, y1, x1 - L * Math.cos(ang - 0.45), y1 - L * Math.sin(ang - 0.45));
    line(x1 - L * Math.cos(ang - 0.45), y1 - L * Math.sin(ang - 0.45), x1, y1);
    line(x1, y1, x1 - L * Math.cos(ang + 0.45), y1 - L * Math.sin(ang + 0.45));
  } else if (kind === "rect") {
    line(x0, y0, x1, y0); line(x1, y0, x1, y1); line(x1, y1, x0, y1); line(x0, y1, x0, y0);
  } else if (kind === "ellipse") {
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, rx = Math.abs(x1 - x0) / 2, ry = Math.abs(y1 - y0) / 2;
    const k = Math.max(24, Math.ceil((rx + ry) / 3));
    for (let i = 0; i <= k; i++) add(cx + rx * Math.cos((TAU * i) / k), cy + ry * Math.sin((TAU * i) / k));
  }
  return pts;
}

// ---------- desenho ----------

export const HL_ALPHA = 0.5;

// Papel: fundo branco e, se pedido, pauta ou quadriculado bem claros.
// `px` é o tamanho de um pixel do dispositivo em unidades de página.
export function drawPaper(ctx, page, paper, px) {
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, page.w, page.h);
  if (!paper || paper.type === "blank" || page.bg || page.hasBg) return;
  const gap = Math.max(12, paper.size || 40);
  const lw = Math.max(px, 0.7);
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, page.w, page.h);
  ctx.clip();
  ctx.fillStyle = paper.type === "grid" ? "#dfe8f6" : "#d3dff2";
  const snap = (v) => Math.round(v / px) * px;
  if (paper.type === "lined") {
    const top = gap * 2;
    for (let y = top; y < page.h - gap * 0.6; y += gap) ctx.fillRect(0, snap(y), page.w, lw);
    ctx.fillStyle = "#f6c9cf";
    ctx.fillRect(snap(gap * 2.2), 0, lw, page.h);
  } else if (paper.type === "grid") {
    for (let y = gap; y < page.h; y += gap) ctx.fillRect(0, snap(y), page.w, lw);
    for (let x = gap; x < page.w; x += gap) ctx.fillRect(snap(x), 0, lw, page.h);
  }
  ctx.restore();
}

export function drawStrokes(ctx, items, kind, view) {
  for (const it of items) {
    if (it.k !== "s" || (it.t === "hl") !== (kind === "hl")) continue;
    if (view) {
      const b = bbox(it);
      if (b[2] < view[0] || b[0] > view[2] || b[3] < view[1] || b[1] > view[3]) continue;
    }
    ctx.fillStyle = it.c;
    ctx.fill(strokePath(it));
  }
}

export function drawImages(ctx, items, getImg) {
  for (const it of items) {
    if (it.k !== "i") continue;
    const img = getImg(it);
    if (img) ctx.drawImage(img, it.x, it.y, it.w, it.h);
    else {
      ctx.fillStyle = "#eef1f5";
      ctx.fillRect(it.x, it.y, it.w, it.h);
    }
  }
}

// Desenha a página inteira em um único canvas (miniaturas e exportação).
export function drawPageFlat(ctx, page, opts) {
  const { paper, getImg, bgImg, px = 1 } = opts;
  drawPaper(ctx, page, paper, px);
  if (bgImg) ctx.drawImage(bgImg, 0, 0, page.w, page.h);
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, page.w, page.h);
  ctx.clip();
  drawImages(ctx, page.items, getImg);
  ctx.globalCompositeOperation = "multiply";
  ctx.globalAlpha = HL_ALPHA;
  drawStrokes(ctx, page.items, "hl");
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  drawStrokes(ctx, page.items, "pen");
  ctx.restore();
}

// Cache de imagens decodificadas, limitado pela memória que ocupam.
const imgCache = new Map();
const IMG_BUDGET = 48e6; // pixels
export function loadImage(src) {
  let e = imgCache.get(src);
  if (e) {
    imgCache.delete(src); // move para o fim (mais recente)
    imgCache.set(src, e);
    e.used = performance.now();
    return e;
  }
  e = { img: null, promise: null, px: 0, used: performance.now() };
  e.promise = new Promise((res) => {
    const im = new Image();
    im.onload = () => { e.img = im; e.px = im.naturalWidth * im.naturalHeight; trim(); res(im); };
    im.onerror = () => res(null);
    im.src = src;
  });
  imgCache.set(src, e);
  return e;
}

function trim() {
  let total = 0;
  for (const e of imgCache.values()) total += e.px;
  const now = performance.now();
  for (const [k, e] of imgCache) {
    if (total <= IMG_BUDGET) break;
    if (now - e.used < 3000) continue; // em uso agora
    total -= e.px;
    imgCache.delete(k);
  }
}
