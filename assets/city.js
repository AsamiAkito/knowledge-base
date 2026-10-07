/* ============================================================
   线条城市 —— 右下角小游戏（three.js r160，本地 vendor）
   ------------------------------------------------------------
   · 线稿砖块风格：白天白立面 + 细线立面图案；夜里（网页暗色主题）窗格亮灯
   · 190×190 棋盘，透视相机（近大远小）
   · 视角：左键拖动绕「按下时鼠标所指的点」旋转 / 改俯仰（拖动时显示中轴），
     滚轮缩放；展开后右键或 Shift+拖动平移、滚轮朝鼠标位置缩放
   · 右下角只能旋转和缩放；点左上角三角展开后才能编辑：
       空格   指着顶面 / 地面 → 往上盖一层；指着某层侧面 → 在该面加侧翼（长按连放）
       D      删掉指着的侧翼 / 连接，否则删该格最上一层；空格子则往下挖一层（最多地下三层，长按连删 / 连挖）
       F      回填一层（只对没有楼的坑）
       T      指着一层按住，移到另一栋楼的某层松开 → 两层相对的面直接融合相连
       Q / E  选左 / 右一个楼层    W / S  尺寸增大 / 减小    R  顺时针旋转 15°
       Ctrl+Z 撤销   Ctrl+Shift+Z / Ctrl+Y 重做   Esc 收起
   · 每位访客的城市存在本机 localStorage
   · 扩展接口：window.CityGame（见文件末尾）
   ============================================================ */
import * as THREE from "three";

const N = 190, HALF = N / 2;
const SIZES = { S: .5, M: .7, L: .9 };          // 占一个格子的比例，都小于 1 格
const KEY_CITY = "myspace-city", KEY_SEL = "myspace-city-sel";
const config = {
  phiMin: 12, phiMax: 85,                         // 俯仰角范围（度，离地面的仰角）
  thetaRange: null,                               // 水平旋转范围 [min,max]（度），null 为不限
  fov: 35,                                        // 透视视角（度）
  distMin: 4, distMax: 420,                       // 相机到中轴点的距离范围（缩放）
  rotStep: 15,                                    // R 键每次顺时针旋转的角度
  damping: .22,                                   // 旋转缓动（0–1，越大越跟手）
  recenterNear: 30,                               // 相机距离小于它时视野可移到棋盘任意位置，大于它逐步回中
  thickness: 3,                                   // 棋盘厚度（格）
  digLevel: .16, digMax: 3,                       // 每挖一层的深度（= 一层楼高）与最多挖几层
  wingDepth: .32,                                 // 侧翼伸出的深度（格）
  repeatDelay: 300, repeatEvery: 90               // 长按连放 / 连删的节奏（毫秒）
};

/* 界面元素（注册内置楼层前声明，renderBar 会用到） */
let host, corner, pop, popStage, bar, needs = true;

/* ---------------- 事件 ---------------- */
const handlers = {};
function on(ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); return () => off(ev, fn); }
function off(ev, fn) { handlers[ev] = (handlers[ev] || []).filter(f => f !== fn); }
function emit(ev, data) { (handlers[ev] || []).forEach(f => { try { f(data); } catch (e) { console.error(e); } }); }

/* ---------------- 几何工具（也通过 CityGame.helpers 提供给扩展） ---------------- */
function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function merge(list) {
  list = list.filter(Boolean).map(g => g.index ? g.toNonIndexed() : g);
  if (!list.length) return null;
  const names = Object.keys(list[0].attributes).filter(n => list.every(g => g.attributes[n]));
  const out = new THREE.BufferGeometry();
  names.forEach(n => {
    const size = list[0].attributes[n].itemSize, total = list.reduce((a, g) => a + g.attributes[n].array.length, 0);
    const arr = new Float32Array(total); let o = 0;
    list.forEach(g => { arr.set(g.attributes[n].array, o); o += g.attributes[n].array.length; });
    out.setAttribute(n, new THREE.BufferAttribute(arr, size));
  });
  return out;
}
function box(w, h, d, y = 0, x = 0, z = 0) { const g = new THREE.BoxGeometry(w, h, d ?? w); g.translate(x, y + h / 2, z); return g; }
function lines(pts) { const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(pts.flat(), 3)); return g; }
function ring(r, y, seg = 32) { const p = []; for (let i = 0; i < seg; i++) { const a = i / seg * Math.PI * 2, b = (i + 1) / seg * Math.PI * 2; p.push([Math.cos(a) * r, y, Math.sin(a) * r], [Math.cos(b) * r, y, Math.sin(b) * r]); } return p; }
const FACES = [[1, 0], [0, 1], [-1, 0], [0, -1]];   // +x +z -x -z，与侧翼方向 d=0..3 对应
/* 立面线条：fn(w,h) 返回面内线段 [[u1,y1,u2,y2],…]（u∈[-w/2,w/2]，y∈[0,h]），自动铺到四个面 */
function facade(w, h, fn, { y0 = 0, d } = {}) {
  const segs = fn(w, h), p = [], half = w / 2 + .003;
  FACES.forEach(([nx, nz]) => { const tx = -nz, tz = nx;
    segs.forEach(([u1, y1, u2, y2]) => p.push([nx * half + tx * u1, y0 + y1, nz * half + tz * u1], [nx * half + tx * u2, y0 + y2, nz * half + tz * u2])); });
  return lines(p);
}
const F = {   // 常用立面图案
  cols: (n, y1 = 0, y2) => (w, h) => { const o = []; for (let i = 1; i < n; i++) { const u = -w / 2 + i * w / n; o.push([u, y1, u, y2 ?? h]); } return o; },
  rows: (ys) => (w) => ys.map(y => [-w / 2, y, w / 2, y]),
  hlines: (n) => (w, h) => { const o = []; for (let i = 1; i < n; i++) o.push([-w / 2, h * i / n, w / 2, h * i / n]); return o; },
  diag: (n) => (w, h) => { const o = [], c = w / n; for (let i = 0; i < n; i++) { const u = -w / 2 + i * c; o.push([u, 0, u + c, h], [u + c, 0, u, h]); } return o; },
  windows: (n, b = .2, t = .78, gap = .5) => (w, h) => { const o = [], span = w * .82, cw = span / n, pw = cw * gap;
    for (let i = 0; i < n; i++) { const u = -span / 2 + (i + .5) * cw, a = u - pw / 2, c = u + pw / 2, y1 = h * b, y2 = h * t;
      o.push([a, y1, c, y1], [c, y1, c, y2], [c, y2, a, y2], [a, y2, a, y1]); } return o; },
  slots: (n, gap = .022) => (w, h) => { const o = [], span = w * .8; for (let i = 0; i < n; i++) { const u = -span / 2 + (i + .5) * span / n; o.push([u - gap, 0, u - gap, h], [u + gap, 0, u + gap, h]); } return o; },
  all: (...fns) => (w, h) => fns.flatMap(f => f(w, h))
};
/* 方盒四面的窗格（夜里亮灯）：cols 列，rows 为每行中心高度比例 */
function boxPanes(w, h, { cols, rows = [.5], ph = .6, pr = .55, seed = 1, y0 = 0, lit = .72 } = {}) {
  const r = rng(seed), pos = [], col = [];
  cols = cols || Math.max(2, Math.round(w / .17));
  const span = w * .82, cw = span / cols, pw = cw * pr, half = w / 2 + .005;
  FACES.forEach(([nx, nz]) => { const tx = -nz, tz = nx;
    for (let c = 0; c < cols; c++) { const u = -span / 2 + (c + .5) * cw;
      rows.forEach(ry => { const yc = y0 + h * ry, hh = h * ph / 2, hw = pw / 2, cx = nx * half + tx * u, cz = nz * half + tz * u;
        const P = (s, t) => [cx + tx * hw * s, yc + hh * t, cz + tz * hw * s];
        const c3 = r() < lit ? [1, .82, .42] : [.16, .18, .25];
        [P(-1, -1), P(1, -1), P(1, 1), P(-1, -1), P(1, 1), P(-1, 1)].forEach(v => { pos.push(...v); col.push(...c3); }); }); } });
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  return g;
}
function roundPanes(rad, h, { count = 12, ph = .46, seed = 1, rows = [.5] } = {}) {
  const r = rng(seed), pos = [], col = [], R = rad + .005, pw = Math.PI * 2 * rad / count * .5;
  for (let i = 0; i < count; i++) { const a = i / count * Math.PI * 2, nx = Math.cos(a), nz = Math.sin(a), tx = -nz, tz = nx;
    rows.forEach(ry => { const cx = nx * R, cz = nz * R, yc = h * ry, hh = h * ph / 2, hw = pw / 2;
      const P = (s, t) => [cx + tx * hw * s, yc + hh * t, cz + tz * hw * s], c3 = r() < .72 ? [1, .82, .42] : [.16, .18, .25];
      [P(-1, -1), P(1, -1), P(1, 1), P(-1, -1), P(1, 1), P(-1, 1)].forEach(v => { pos.push(...v); col.push(...c3); }); }); }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  return g;
}

/* ---------------- 楼层类型注册表 ----------------
   def = {
     id, name, icon(24×24 线条 SVG 字符串),
     height: 数字 | (w)=>数字    层高（格，默认 0.16 = 一排方格），可按占地宽度 w 计算
     cap: true                    封顶层：上面不能再盖，也不能当侧翼
     width: 数字                   固定占地宽度（格），不随 S/M/L 变化（如 0.16 的小方块）
     seamless: true               无缝层：同类型、同尺寸、同朝向上下相叠时，层间不画横线，像一整根连续的塔身
                                  （上下边线自动从实体轮廓里拆出，也可在 build 里返回 ringTop / ringBottom 自定义）
     build({THREE,w,h,seed,helpers}) → { solid, lines?, panes?, autoEdges? }
       solid  实体几何（底面在 y=0，占地 w×w 居中）
       lines  立面线条（LineSegments 的顶点对），可用 helpers.facade / helpers.F 生成
       panes  窗格（带 color 属性，夜里亮灯、白天隐藏）
       autoEdges:false 时不自动描实体轮廓（圆柱、穹顶等自己画线）
   } */
const FLOORS = new Map(), ORDER = [], geoCache = new Map();
const helpers = { box, lines, ring, merge, facade, F, boxPanes, roundPanes, rng };
function floorHeight(def, w) { return typeof def.height === "function" ? def.height(w) : def.height; }
function registerFloor(def) {
  if (!def || !def.id || typeof def.build !== "function") throw new Error("registerFloor: 需要 id 和 build");
  if (!FLOORS.has(def.id)) ORDER.push(def.id);
  FLOORS.set(def.id, Object.assign({ name: def.id, height: .16, cap: false, icon: "" }, def));
  [...geoCache.keys()].forEach(k => { if (k.startsWith(def.id + "|")) geoCache.delete(k); });
  renderBar(); emit("register", def);
}
function floorGeo(t, s, v) {
  const key = t + "|" + s + "|" + v;
  if (geoCache.has(key)) return geoCache.get(key);
  const def = FLOORS.get(t), w = def.width || SIZES[s], h = floorHeight(def, w);
  const r = def.build({ THREE, w, h, seed: v * 7919 + 13, helpers });
  let edges = merge([r.autoEdges === false ? null : new THREE.EdgesGeometry(r.solid, 25), r.lines]), ringTop = null, ringBottom = null;
  if (def.seamless) {                                   // 拆出 y=0 与 y=h 的水平线段，由 refreshSeams 决定是否显示
    const keep = [], top = [], bot = [], a = edges.attributes.position.array, e = 1e-4;
    for (let n = 0; n < a.length; n += 6) {
      const seg = [[a[n], a[n + 1], a[n + 2]], [a[n + 3], a[n + 4], a[n + 5]]], flat = Math.abs(a[n + 1] - a[n + 4]) < e;
      if (flat && Math.abs(a[n + 1] - h) < e) top.push(...seg); else if (flat && Math.abs(a[n + 1]) < e) bot.push(...seg); else keep.push(...seg);
    }
    edges = lines(keep); ringTop = r.ringTop || lines(top); ringBottom = r.ringBottom || lines(bot);
  }
  const out = { solid: r.solid, edges, panes: r.panes || null, h, w, ringTop, ringBottom };
  geoCache.set(key, out); return out;
}

/* ---------------- 内置楼层（线稿砖块） ---------------- */
const I = p => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round">' + p + "</svg>";
const body = (id, name, icon, lineFn, paneOpt, extra = {}) => registerFloor(Object.assign({ id, name, icon,
  build: ({ w, h, seed }) => ({ solid: box(w, h), lines: lineFn ? facade(w, h, lineFn) : null, panes: paneOpt ? boxPanes(w, h, Object.assign({ seed }, paneOpt(w))) : null }) }, extra));
body("grid", "网格幕墙", I('<rect x="5" y="4" width="14" height="16"/><path d="M8.5 4v16M12 4v16M15.5 4v16M5 9.3h14M5 14.6h14"/>'),
  (w, h) => F.cols(Math.max(4, Math.round(w / .09)))(w, h), w => ({ cols: Math.max(4, Math.round(w / .09)), ph: .62, pr: .8 }));
body("vfin", "竖向肋条", I('<rect x="5" y="4" width="14" height="16"/><path d="M7.3 4v16M9.6 4v16M11.9 4v16M14.2 4v16M16.5 4v16"/>'),
  (w, h) => F.cols(Math.max(6, Math.round(w / .045)))(w, h), w => ({ cols: Math.max(3, Math.round(w / .14)), ph: 1, pr: .5 }), { seamless: true });
body("louver", "横向百叶", I('<rect x="5" y="5" width="14" height="14"/><path d="M5 7.5h14M5 10h14M5 12.5h14M5 15h14M5 17.5h14"/>'),
  F.hlines(3), w => ({ cols: Math.max(2, Math.round(w / .2)), ph: .3, pr: .8 }));
body("ribbon", "带形窗", I('<rect x="5" y="5" width="14" height="14"/><path d="M5 9h14M5 13h14"/><path d="M8 9v4M11 9v4M14 9v4M17 9v4"/>'),
  (w, h) => F.all(F.rows([h * .25, h * .75]), F.cols(Math.max(3, Math.round(w / .12)), h * .25, h * .75))(w, h), w => ({ cols: Math.max(3, Math.round(w / .12)), ph: .46, pr: .82 }));
body("window", "窗户层", I('<rect x="5" y="6" width="14" height="12"/><path d="M7.5 9h3v5h-3zM13.5 9h3v5h-3z"/>'),
  (w, h) => F.windows(Math.max(2, Math.round(w / .17)), .2, .8)(w, h), w => ({ cols: Math.max(2, Math.round(w / .17)), ph: .58, pr: .5 }));
body("diagrid", "斜交网格", I('<rect x="5" y="4" width="14" height="16"/><path d="M5 4l7 16M12 4 5 20M12 4l7 16M19 4l-7 16"/>'),
  F.diag(3), w => ({ cols: 3, ph: .4, pr: .45 }));
body("curtain", "玻璃幕墙", I('<rect x="6" y="5" width="12" height="15"/><path d="M9 5v15M12 5v15M15 5v15M6 12h12"/>'),
  (w, h) => F.cols(Math.max(5, Math.round(w / .07)))(w, h), w => ({ cols: Math.max(5, Math.round(w / .07)), ph: 1, pr: .78 }), { seamless: true });
body("plain", "实墙层", I('<rect x="5" y="8" width="14" height="10"/>'), null, null);
body("square", "正方形方格", I('<rect x="4" y="8" width="16" height="5.3"/><path d="M9.3 8v5.3M14.6 8v5.3"/><rect x="4" y="13.3" width="16" height="5.3"/><path d="M9.3 13.3v5.3M14.6 13.3v5.3"/>'),
  (w, h) => F.cols(Math.max(2, Math.round(w / .16)))(w, h), w => ({ cols: Math.max(2, Math.round(w / .16)), ph: .7, pr: .7 }));
registerFloor({ id: "cube", name: "小方块", width: .16, icon: I('<path d="M12 6l6 3.5v7L12 20l-6-3.5v-7z"/><path d="M6 9.5l6 3.5 6-3.5M12 13v7"/>'),
  build: ({ w, h, seed }) => ({ solid: box(w, h), panes: boxPanes(w, h, { seed, cols: 1, ph: .6, pr: .6 }) }) });
body("shaft", "光面塔身", I('<path d="M7 3v18M17 3v18"/>'), null, w => ({ cols: 2, ph: 1, pr: .25, lit: .5 }), { seamless: true });
body("slot", "竖条窗", I('<path d="M6 3v18M18 3v18M9 3v18M10 3v18M14 3v18M15 3v18"/>'),
  (w, h) => F.slots(Math.max(2, Math.round(w / .2)))(w, h), w => ({ cols: Math.max(2, Math.round(w / .2)), ph: 1, pr: .22 }), { seamless: true });
registerFloor({ id: "column", name: "圆柱塔身", seamless: true, icon: I('<path d="M7 3v18M17 3v18M10 3v18M14 3v18"/>'),
  build: ({ w, h, seed }) => {
    const r = w / 2, g = new THREE.CylinderGeometry(r, r, h, 32); g.translate(0, h / 2, 0); const p = [];
    for (let i = 0; i < 16; i++) { const a = i / 16 * Math.PI * 2; p.push([Math.cos(a) * (r + .002), 0, Math.sin(a) * (r + .002)], [Math.cos(a) * (r + .002), h, Math.sin(a) * (r + .002)]); }
    return { solid: g, lines: lines(p), autoEdges: false, ringTop: lines(ring(r + .002, h)), ringBottom: lines(ring(r + .002, 0)),
      panes: roundPanes(r, h, { seed, count: 16, ph: 1 }) };
  } });
registerFloor({ id: "podium", name: "裙楼大板", height: .32, icon: I('<rect x="3" y="7" width="18" height="12"/><path d="M3 13h18M9 7v12M15 7v12"/><circle cx="12" cy="10" r="1.6"/>'),
  build: ({ w, h, seed }) => {
    const L = facade(w, h, F.cols(3));
    const c = [], r = h * .26, cx = 0, cy = h * .5, z = w / 2 + .004;      // 正面一个圆窗（参考图里的裙楼）
    for (let i = 0; i < 24; i++) { const a = i / 24 * Math.PI * 2, b = (i + 1) / 24 * Math.PI * 2; c.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r, z], [cx + Math.cos(b) * r, cy + Math.sin(b) * r, z]); }
    return { solid: box(w, h), lines: merge([L, lines(c)]), panes: boxPanes(w, h, { seed, cols: 3, ph: .7, pr: .8 }) };
  } });
registerFloor({ id: "setback", name: "收分层", icon: I('<rect x="8" y="8" width="8" height="10"/><path d="M5 18h14M10 8v10M12 8v10M14 8v10"/>'),
  build: ({ w, h, seed }) => { const s = w * .72; return { solid: box(s, h), lines: facade(s, h, F.cols(Math.max(3, Math.round(s / .07)))), panes: boxPanes(s, h, { seed, cols: Math.max(3, Math.round(s / .14)), ph: .7 }) }; } });
registerFloor({ id: "round", name: "圆形层", icon: I('<ellipse cx="12" cy="7" rx="6" ry="2"/><path d="M6 7v10a6 2 0 0 0 12 0V7"/><path d="M6 11.5a6 2 0 0 0 12 0"/>'),
  build: ({ w, h, seed }) => {
    const r = w / 2, g = new THREE.CylinderGeometry(r, r, h, 32); g.translate(0, h / 2, 0);
    const p = [...ring(r + .002, 0), ...ring(r + .002, h)];
    for (let i = 0; i < 16; i++) { const a = i / 16 * Math.PI * 2; p.push([Math.cos(a) * (r + .002), 0, Math.sin(a) * (r + .002)], [Math.cos(a) * (r + .002), h, Math.sin(a) * (r + .002)]); }
    return { solid: g, lines: lines(p), autoEdges: false, panes: roundPanes(r, h, { seed, count: 16, ph: .6 }) };
  } });
registerFloor({ id: "roofbox", name: "屋顶设备", height: .12, icon: I('<path d="M4 17h16"/><rect x="9" y="12" width="6" height="5"/><path d="M11 12v5M13 12v5"/>'),
  build: ({ w, h }) => ({ solid: merge([box(w * .92, .03), box(w * .34, h - .03, w * .34, .03, w * .15, -w * .12)]) }) });
registerFloor({ id: "parapet", name: "平顶女儿墙", cap: true, height: .12, icon: I('<path d="M4 16h16v-3H4zM6 13v-2h12v2"/>'),
  build: ({ w, h }) => ({ solid: merge([box(w, .04), box(w, h - .04, .03, .04, 0, w / 2 - .015), box(w, h - .04, .03, .04, 0, -w / 2 + .015), box(.03, h - .04, w, .04, w / 2 - .015), box(.03, h - .04, w, .04, -w / 2 + .015)]) }) });
registerFloor({ id: "crown", name: "阶梯冠顶", cap: true, height: .7, icon: I('<path d="M5 20h14v-5H5zM7.5 15v-4h9v4M10 11V7h4v4M12 7V4"/>'),
  build: ({ w }) => ({ solid: merge([box(w * .86, .22), box(w * .64, .22, w * .64, .22), box(w * .4, .22, w * .4, .44)]),
    lines: merge([facade(w * .86, .22, F.cols(8)), facade(w * .64, .22, F.cols(6), { y0: .22 }), facade(w * .4, .22, F.cols(4), { y0: .44 }), lines([[0, .66, 0], [0, 1.05, 0]])]) }) });
registerFloor({ id: "spire", name: "尖顶", cap: true, height: 1.3, icon: I('<path d="M12 3v3M8 20l4-14 4 14z"/><path d="M6 20h12"/>'),
  build: ({ w }) => {
    const base = box(w * .72, .12), py = new THREE.ConeGeometry(w * .34, 1.0, 4, 1); py.rotateY(Math.PI / 4); py.translate(0, .12 + .5, 0);
    return { solid: merge([base, py]), lines: lines([[0, 1.12, 0], [0, 1.6, 0]]) };
  } });
registerFloor({ id: "antenna", name: "避雷针", cap: true, height: .3, icon: I('<path d="M12 3v9M10 6h4"/><rect x="9" y="12" width="6" height="4"/><path d="M5 20h14v-4H5z"/>'),
  build: ({ w }) => ({ solid: merge([box(w * .92, .08), box(w * .34, .22, w * .34, .08)]),
    lines: lines([[0, .3, 0], [0, 1.25, 0], [-.07, .95, 0], [.07, .95, 0], [0, .95, -.07], [0, .95, .07]]) }) });
registerFloor({ id: "dome", name: "圆顶", cap: true, height: w => w * .45, icon: I('<path d="M5 17a7 7 0 0 1 14 0z"/><path d="M12 10v7M4 17h16"/>'),
  build: ({ w }) => {
    const r = w * .45, g = new THREE.SphereGeometry(r, 24, 10, 0, Math.PI * 2, 0, Math.PI / 2);
    const p = [...ring(r, 0)];
    [.35, .65].forEach(t => { const a = t * Math.PI / 2; p.push(...ring(Math.cos(a) * r, Math.sin(a) * r)); });
    for (let i = 0; i < 8; i++) { const a = i / 8 * Math.PI * 2;
      for (let j = 0; j < 8; j++) { const b0 = j / 8 * Math.PI / 2, b1 = (j + 1) / 8 * Math.PI / 2;
        p.push([Math.cos(b0) * r * Math.cos(a), Math.sin(b0) * r, Math.cos(b0) * r * Math.sin(a)], [Math.cos(b1) * r * Math.cos(a), Math.sin(b1) * r, Math.cos(b1) * r * Math.sin(a)]); } }
    return { solid: g, lines: lines(p), autoEdges: false };
  } });

/* ---------------- 配色：白天 = 网页亮色主题，夜晚 = 网页暗色主题 ---------------- */
function palette(night) {
  if (night) return { face: 0x22252f, line: 0x7d84a0, ground: 0x1d2030, side: 0x181a26, side2: 0x151721, minor: 0x272b3c, major: 0x333850, sky: 0x9aa0c0, gnd: 0x1a1c28, ambient: 1.6, sun: .6, clear: 0x13141b };
  return { face: 0xffffff, line: 0x2c2e36, ground: 0xfcfcfd, side: 0xececf2, side2: 0xe1e1ea, minor: 0xececf2, major: 0xdadae4, sky: 0xffffff, gnd: 0xdedeea, ambient: 2.9, sun: .5, clear: 0xf6f6f4 };
}

/* ---------------- 状态 ----------------
   cells:   "i,j" → [ floor ]，floor = { t,s,v,r, wings:[{d,t,s,v,obj}], obj, h }
   bridges: [ { a:[i,j,k], b:[i,j,k], obj } ] */
const cells = new Map(), bridges = [], digs = new Map();   // digs: "i,j" → 挖了几层（1..digMax）
const hist = [], redoStack = [];
let sel = Object.assign({ t: "grid", s: "M", r: 0 }, (() => { try { return JSON.parse(localStorage.getItem(KEY_SEL)) || {}; } catch (e) { return {}; } })());
if (!FLOORS.has(sel.t)) sel.t = "grid";
let night = false, hover = null, expanded = false, tAnchor = null, drag = null;

/* ---------------- three.js 场景 ---------------- */
let renderer, scene, camera, hemi, sun, faceMat, lineMat, paneMat, ghostFace, ghostLine, hiLine;
let ground, groundTop, digMask, pitMesh, pitEdges, pitMat, gridMinor, gridMajor, floorsGroup, bridgeGroup, hoverBox, ghost, pivot, linkLine, hitMeshes = [], hiObj = null;
const cam = { tx: 0, tz: 0, theta: 45, phi: 35.26, dist: 64 }, goal = { theta: 45, phi: 35.26 };

function initThree() {
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.domElement.className = "city-canvas";
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(config.fov, 2, .1, 6000);
  hemi = new THREE.HemisphereLight(0xffffff, 0xdedeea, 2.9); scene.add(hemi);
  sun = new THREE.DirectionalLight(0xffffff, .5); sun.position.set(-1, 2.2, .7); scene.add(sun);
  faceMat = new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
  lineMat = new THREE.LineBasicMaterial({ color: 0x2c2e36 });
  paneMat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
  ghostFace = new THREE.MeshBasicMaterial({ color: 0x0e8fbc, transparent: true, opacity: .16, depthWrite: false });
  ghostLine = new THREE.LineBasicMaterial({ color: 0x0e8fbc, transparent: true, opacity: .9 });
  hiLine = new THREE.LineBasicMaterial({ color: 0xc0344d });

  const T = config.thickness, M = N + 2;
  const gGeo = new THREE.BoxGeometry(M, T, M); gGeo.translate(0, -T / 2, 0);
  const gm = c => new THREE.MeshBasicMaterial({ color: c, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
  ground = new THREE.Mesh(gGeo, [gm(0), gm(0), gm(0), gm(0), gm(0), gm(0)]);   // 两组侧面各一色，像插画那样平涂
  ground.material[2].visible = false;                                          // 台面另画，好在挖坑处开洞
  /* 台面：一张平面 + 遮罩贴图（每格一个像素，挖过的格子透明） */
  const mdata = new Uint8Array(M * M * 4).fill(255);
  digMask = new THREE.DataTexture(mdata, M, M, THREE.RGBAFormat); digMask.magFilter = digMask.minFilter = THREE.NearestFilter; digMask.needsUpdate = true;
  const tGeo = new THREE.PlaneGeometry(M, M); tGeo.rotateX(-Math.PI / 2);
  groundTop = new THREE.Mesh(tGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, alphaMap: digMask, alphaTest: .5, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }));
  pitMat = new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
  pitMesh = new THREE.Mesh(new THREE.BufferGeometry(), pitMat); pitEdges = new THREE.LineSegments(new THREE.BufferGeometry(), lineMat);
  scene.add(groundTop, pitMesh, pitEdges);
  const mi = [], ma = [];
  for (let k = 0; k <= N; k++) { const p = k - HALF, arr = k % 10 === 0 ? ma : mi; arr.push([p, .002, -HALF], [p, .002, HALF], [-HALF, .002, p], [HALF, .002, p]); }
  gridMinor = new THREE.LineSegments(lines(mi), maskLines(new THREE.LineBasicMaterial({ color: 0xececf2, transparent: true }), M));
  gridMajor = new THREE.LineSegments(lines(ma), maskLines(new THREE.LineBasicMaterial({ color: 0xdadae4 }), M));
  scene.add(ground, new THREE.LineSegments(new THREE.EdgesGeometry(gGeo), lineMat), gridMinor, gridMajor);
  floorsGroup = new THREE.Group(); bridgeGroup = new THREE.Group(); scene.add(floorsGroup, bridgeGroup);

  hoverBox = new THREE.LineLoop(lines([[-.5, 0, -.5], [.5, 0, -.5], [.5, 0, .5], [-.5, 0, .5]]), new THREE.LineBasicMaterial({ color: 0x0e8fbc }));
  hoverBox.visible = false; scene.add(hoverBox);
  ghost = new THREE.Group(); ghost.visible = false; scene.add(ghost);
  /* 旋转中轴：拖动旋转时显示 */
  pivot = new THREE.Group(); pivot.visible = false;
  pivot.add(new THREE.LineSegments(lines([[0, 0, 0], [0, 30, 0], ...ring(.6, .01, 40)]), new THREE.LineBasicMaterial({ color: 0x0e8fbc, transparent: true, opacity: .8 })));
  scene.add(pivot);
  /* T 连廊预览线 */
  linkLine = new THREE.Line(lines([[0, 0, 0], [0, 0, 0]]), new THREE.LineDashedMaterial({ color: 0x0e8fbc, dashSize: .25, gapSize: .15 }));
  linkLine.visible = false; scene.add(linkLine);

  applyPalette(); updateCamera();
  (function loop() {
    requestAnimationFrame(loop);
    const dt = goal.theta - cam.theta, dp = goal.phi - cam.phi;           // 旋转缓动
    if (Math.abs(dt) > .01 || Math.abs(dp) > .01) {
      const st = dt * config.damping; cam.theta += st; cam.phi += dp * config.damping;
      if (orbit) orbitTarget(rad(st));
      updateCamera();
    } else if (orbit && !drag) { orbit = null; }
    if (!needs || !host) return; needs = false; fadeGrid(); renderer.render(scene, camera); emit("render");
  })();
}
function req() { needs = true; }
function maskLines(mat, M) {
  mat.onBeforeCompile = sh => {
    sh.uniforms.uMask = { value: digMask };
    sh.vertexShader = sh.vertexShader.replace("#include <common>", "#include <common>\nvarying vec2 vMaskUv;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvMaskUv = vec2((position.x + " + (M / 2).toFixed(1) + ") / " + M.toFixed(1) + ", (" + (M / 2).toFixed(1) + " - position.z) / " + M.toFixed(1) + ");");
    sh.fragmentShader = sh.fragmentShader.replace("#include <common>", "#include <common>\nvarying vec2 vMaskUv;\nuniform sampler2D uMask;")
      .replace("void main() {", "void main() {\n  if (texture2D(uMask, vMaskUv).g < .5) discard;");
  };
  return mat;
}
/* 坑：只在比邻格更深的一侧画坑壁，相邻的坑连成一片 */
function rebuildPits() {
  const M = N + 2, data = digMask.image.data, L = config.digLevel, tri = [];
  data.fill(255);
  const quad = (a, b, c, d) => tri.push(...a, ...b, ...c, ...a, ...c, ...d);
  digs.forEach((d, key) => {
    const [i, j] = key.split(",").map(Number), x0 = i - HALF, x1 = x0 + 1, z0 = j - HALF, z1 = z0 + 1, yb = -d * L;
    const px = ((M - 1 - (j + 1)) * M + (i + 1)) * 4; data[px] = data[px + 1] = data[px + 2] = data[px + 3] = 0;
    quad([x0, yb, z0], [x1, yb, z0], [x1, yb, z1], [x0, yb, z1]);                                   // 坑底
    [[i + 1, j, x1, z0, x1, z1], [i - 1, j, x0, z1, x0, z0], [i, j + 1, x1, z1, x0, z1], [i, j - 1, x0, z0, x1, z0]].forEach(([ni, nj, ax, az, bx, bz]) => {
      const nd = digOf(ni, nj); if (nd >= d) return; const yt = -nd * L;
      quad([ax, yb, az], [bx, yb, bz], [bx, yt, bz], [ax, yt, az]);                                // 坑壁
    });
  });
  digMask.needsUpdate = true;
  const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(tri, 3)); g.computeVertexNormals();
  pitMesh.geometry.dispose(); pitMesh.geometry = g;
  pitEdges.geometry.dispose(); pitEdges.geometry = tri.length ? new THREE.EdgesGeometry(g, 30) : new THREE.BufferGeometry();
  req();
}
function accent() { return getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#0e8fbc"; }
function applyPalette() {
  const p = palette(night);
  faceMat.color.setHex(p.face); lineMat.color.setHex(p.line);
  groundTop.material.color.setHex(p.ground); pitMat.color.setHex(p.ground);
  [0, 1].forEach(k => ground.material[k].color.setHex(p.side)); [3, 4, 5].forEach(k => ground.material[k].color.setHex(p.side2));
  gridMinor.material.color.setHex(p.minor); gridMajor.material.color.setHex(p.major);
  hemi.color.setHex(p.sky); hemi.groundColor.setHex(p.gnd); hemi.intensity = p.ambient; sun.intensity = p.sun;
  const a = new THREE.Color(accent());
  [hoverBox.material, ghostFace, ghostLine, pivot.children[0].material, linkLine.material].forEach(m => m.color.copy(a));
  renderer.setClearColor(p.clear, expanded ? 1 : 0);
  scene.traverse(o => { if (o.userData.pane) o.visible = night; });     // 白天纯线稿，夜里窗格亮灯
  if (pop) pop.classList.toggle("night", night);
  req();
}
function fadeGrid() {
  const ppc = (host ? host.clientHeight : 300) / (2 * cam.dist * Math.tan(rad(config.fov) / 2));
  gridMinor.material.opacity = Math.max(0, Math.min(1, (ppc - 5) / 10));
  gridMinor.visible = gridMinor.material.opacity > .02;
}

/* ---------------- 相机：绕中轴点（画面中心正下方的地面点）旋转 ---------------- */
const rad = d => d * Math.PI / 180;
function clampAngles(o) {
  o.phi = Math.max(config.phiMin, Math.min(config.phiMax, o.phi));
  if (config.thetaRange) o.theta = Math.max(config.thetaRange[0], Math.min(config.thetaRange[1], o.theta));
}
function clampCam() {
  clampAngles(cam);
  cam.dist = Math.max(config.distMin, Math.min(config.distMax, cam.dist));
  /* 视野中心可偏离棋盘中心的范围随缩放收紧：拉近时可看到边缘，越拉远越回中，缩到看全棋盘时正好居中 */
  const full = N * .62 / Math.tan(rad(config.fov) / 2), near = config.recenterNear;
  const lim = HALF * Math.max(0, Math.min(1, (full - cam.dist) / (full - near)));
  cam.tx = Math.max(-lim, Math.min(lim, cam.tx)); cam.tz = Math.max(-lim, Math.min(lim, cam.tz));
}
function rotateBy(dTheta, dPhi) { goal.theta += dTheta; goal.phi += dPhi; clampAngles(goal); }
/* 中轴点：按下左键时鼠标下方的点（楼上或地面）；null 时绕画面中心 */
let orbit = null;
function orbitTarget(d) {
  const c = Math.cos(d), sn = Math.sin(d), x = cam.tx - orbit.x, z = cam.tz - orbit.z;
  cam.tx = orbit.x + x * c + z * sn; cam.tz = orbit.z + z * c - x * sn;
}
function updateCamera() {
  clampCam();
  const R = cam.dist, ph = rad(cam.phi), th = rad(cam.theta);
  camera.position.set(cam.tx + R * Math.cos(ph) * Math.sin(th), R * Math.sin(ph), cam.tz + R * Math.cos(ph) * Math.cos(th));
  camera.lookAt(cam.tx, 0, cam.tz);
  const w = host ? host.clientWidth : 300, h = host ? host.clientHeight : 150;
  camera.aspect = w / Math.max(1, h); camera.updateProjectionMatrix();
  if (pivot) { pivot.position.set(orbit ? orbit.x : cam.tx, 0, orbit ? orbit.z : cam.tz); pivot.scale.setScalar(cam.dist / 40); }
  req();
}
function resize() {
  if (!host || !renderer) return;
  const w = host.clientWidth, h = host.clientHeight; if (!w || !h) return;
  renderer.setSize(w, h, false); updateCamera();
}

/* ---------------- 楼层 / 侧翼 / 连廊 ---------------- */
const K = (i, j) => i + "," + j;
const stackOf = (i, j) => cells.get(K(i, j)) || [];
const digOf = (i, j) => digs.get(K(i, j)) || 0;
function stackTop(i, j) { return -digOf(i, j) * config.digLevel + stackOf(i, j).reduce((a, f) => a + f.h, 0); }
function canPlace(i, j) {
  if (i < 0 || j < 0 || i >= N || j >= N) return false;
  const st = stackOf(i, j), top = st[st.length - 1];
  return !(top && FLOORS.get(top.t) && FLOORS.get(top.t).cap);
}
/* 一组可渲染对象：实体 + 线 + 窗格；tag 写进实体的 userData 供拾取 */
function meshSet(g, tag, mat = faceMat, lmat = lineMat) {
  const grp = new THREE.Group(), m = new THREE.Mesh(g.solid, mat);
  if (tag) { m.userData = tag; hitMeshes.push(m); }
  grp.add(m, new THREE.LineSegments(g.edges, lmat));
  if (g.ringTop) { const t = new THREE.LineSegments(g.ringTop, lmat), b = new THREE.LineSegments(g.ringBottom, lmat); t.userData.seam = "top"; b.userData.seam = "bottom"; grp.add(t, b); }
  if (g.panes && mat === faceMat) { const pm = new THREE.Mesh(g.panes, paneMat); pm.userData.pane = true; pm.visible = night; grp.add(pm); }
  return grp;
}
function dispose(obj) { obj.traverse(o => { const k = hitMeshes.indexOf(o); if (k >= 0) hitMeshes.splice(k, 1); }); if (hiObj && !hiObj.parent) hiObj = null; }
function orient(obj, w, r) {
  const a = rad(r || 0), k = Math.min(1, .96 / (w * (Math.abs(Math.cos(a)) + Math.abs(Math.sin(a)))));
  obj.rotation.y = -a; obj.scale.set(k, 1, k);
}
const sameLayer = (a, b) => a && b && a.t === b.t && a.s === b.s && (a.r || 0) === (b.r || 0);
function refreshSeams(i, j) {
  const st = stackOf(i, j);
  st.forEach((f, k) => { if (!FLOORS.get(f.t).seamless) return;
    const showTop = !sameLayer(f, st[k + 1]), showBot = !sameLayer(f, st[k - 1]);
    f.obj.children.forEach(o => { if (o.userData.seam === "top") o.visible = showTop; else if (o.userData.seam === "bottom") o.visible = showBot; }); });
  req();
}
function addFloor(i, j, f) {
  const st = stackOf(i, j), k = st.length, y = stackTop(i, j), g = floorGeo(f.t, f.s, f.v);
  const obj = meshSet(g, { kind: "floor", i, j, k });
  obj.position.set(i - HALF + .5, y, j - HALF + .5); orient(obj, g.w, f.r);
  const rec = { t: f.t, s: f.s, v: f.v, r: f.r || 0, h: g.h, obj, wings: [] };
  floorsGroup.add(obj); st.push(rec); cells.set(K(i, j), st);
  (f.wings || []).forEach(w => attachWing(i, j, k, w));
  refreshSeams(i, j);
  return rec;
}
function popFloor(i, j) {
  const st = cells.get(K(i, j)); if (!st || !st.length) return null;
  const k = st.length - 1, f = st.pop();
  const gone = bridges.filter(b => (b.a[0] === i && b.a[1] === j && b.a[2] === k) || (b.b[0] === i && b.b[1] === j && b.b[2] === k));
  gone.forEach(dropBridge);
  floorsGroup.remove(f.obj); dispose(f.obj);
  if (!st.length) cells.delete(K(i, j)); else refreshSeams(i, j);
  return { t: f.t, s: f.s, v: f.v, r: f.r, wings: f.wings.map(w => ({ d: w.d, t: w.t, s: w.s, v: w.v })), bridges: gone.map(b => ({ a: b.a, b: b.b, t: b.t, v: b.v })) };
}
/* 侧翼：挂在某层的某个面（d=0..3，楼层本地坐标的 +x +z -x -z），随楼层旋转缩放 */
function wingObj(parent, d, t, s, v, tag, mat, lmat) {
  const g = floorGeo(t, s, v), pw = floorGeo(parent.t, parent.s, parent.v).w, ww = Math.min(g.w * .8, pw), depth = config.wingDepth;
  const outer = new THREE.Group(), inner = meshSet(g, tag, mat, lmat);
  outer.rotation.y = -d * Math.PI / 2;
  inner.position.x = pw / 2 + depth / 2; inner.scale.set(depth / g.w, parent.h / g.h, ww / g.w);
  outer.add(inner); return outer;
}
function attachWing(i, j, k, w) {
  const f = stackOf(i, j)[k]; if (!f || f.wings.some(x => x.d === w.d)) return null;
  const obj = wingObj(f, w.d, w.t, w.s, w.v, { kind: "wing", i, j, k, d: w.d });
  f.obj.add(obj); const rec = { d: w.d, t: w.t, s: w.s, v: w.v, obj }; f.wings.push(rec); return rec;
}
function detachWing(i, j, k, d) {
  const f = stackOf(i, j)[k]; if (!f) return null;
  const n = f.wings.findIndex(x => x.d === d); if (n < 0) return null;
  const w = f.wings.splice(n, 1)[0]; f.obj.remove(w.obj); dispose(w.obj);
  return { d: w.d, t: w.t, s: w.s, v: w.v };
}
/* 连接体：取两层楼相对的那两个面，按各自面的大小放样相连（大小、高度不同时自然过渡） */
function floorCenter(i, j, k) {
  const f = stackOf(i, j)[k]; if (!f) return null;
  return new THREE.Vector3(f.obj.position.x, f.obj.position.y + f.h / 2, f.obj.position.z);
}
/* 某层朝向 toward（世界坐标点）的那个面：返回四角 [左下, 右下, 右上, 左上]（世界坐标） */
function faceToward(i, j, k, toward) {
  const f = stackOf(i, j)[k]; if (!f) return null;
  const g = floorGeo(f.t, f.s, f.v); if (!g.solid.boundingBox) g.solid.computeBoundingBox();
  const bb = g.solid.boundingBox, hx = Math.max(Math.abs(bb.min.x), bb.max.x), hz = Math.max(Math.abs(bb.min.z), bb.max.z);
  f.obj.updateMatrixWorld(true);
  const local = f.obj.worldToLocal(toward.clone());
  let best = 0, bd = -Infinity;
  FACES.forEach(([nx, nz], d) => { const v = nx * local.x + nz * local.z; if (v > bd) { bd = v; best = d; } });
  const [nx, nz] = FACES[best], tx = -nz, tz = nx, hn = nx ? hx : hz, ht = nx ? hz : hx;
  return [[-1, 0], [1, 0], [1, f.h], [-1, f.h]].map(([s2, y]) => f.obj.localToWorld(new THREE.Vector3(nx * hn + tx * ht * s2, y, nz * hn + tz * ht * s2)));
}
function linkGeo(a, b, t, v) {
  const ca = floorCenter(...a), cb = floorCenter(...b);
  const A = faceToward(...a, cb), B0 = faceToward(...b, ca); if (!A || !B0) return null;
  /* 两端四角配对：B 的左右与 A 相反时交换，取总距离最短的配法 */
  const sw = [B0[1], B0[0], B0[3], B0[2]], dist = Q => Q.reduce((s2, p, n) => s2 + p.distanceTo(A[n]), 0), B = dist(B0) <= dist(sw) ? B0 : sw;
  /* 楼层单元：x 为连接方向，z 为宽度方向，y 为高度。端面（x=±hx）上的面、线、窗格都在楼体里，去掉 */
  const g = floorGeo(linkType(t), "M", v || 0); if (!g.solid.boundingBox) g.solid.computeBoundingBox();
  const hx = Math.max(Math.abs(g.solid.boundingBox.min.x), g.solid.boundingBox.max.x), hw = g.w / 2, H = g.h;
  const len = (A[0].distanceTo(B[0]) + A[1].distanceTo(B[1])) / 2, n = Math.max(1, Math.round(len / g.w));
  const P = new THREE.Vector3(), Q = new THREE.Vector3();
  const mapPt = (x, y, z, tile, out) => {                       // 单元坐标 → 两端四边形之间的放样位置
    const t = (tile + (x + hx) / (2 * hx)) / n, sx = Math.min(1, Math.max(0, (z + hw) / (2 * hw))), sy = Math.min(1, Math.max(0, y / H));
    const pa = P.copy(A[0]).lerp(A[1], sx).lerp(Q.copy(A[3]).lerp(A[2], sx), sy).clone();
    const pb = P.copy(B[0]).lerp(B[1], sx).lerp(Q.copy(B[3]).lerp(B[2], sx), sy);
    return out.copy(pa).lerp(pb, t);
  };
  const onEnd = (x, pad) => Math.abs(Math.abs(x) - hx - pad) < 2e-3;
  const tri = (geo, pad) => {                                     // 三角面：去掉落在端面上的
    const src = geo.index ? geo.toNonIndexed() : geo, p = src.attributes.position.array, c = src.attributes.color && src.attributes.color.array;
    const pos = [], col = [], o = new THREE.Vector3();
    for (let tile = 0; tile < n; tile++) for (let q = 0; q < p.length; q += 9) {
      if (onEnd(p[q], pad) && onEnd(p[q + 3], pad) && onEnd(p[q + 6], pad)) continue;
      for (let m = 0; m < 9; m += 3) { mapPt(p[q + m], p[q + m + 1], p[q + m + 2], tile, o); pos.push(o.x, o.y, o.z); if (c) col.push(c[q + m], c[q + m + 1], c[q + m + 2]); }
    }
    const out = new THREE.BufferGeometry(); out.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    if (c) out.setAttribute("color", new THREE.Float32BufferAttribute(col, 3)); else out.computeVertexNormals();
    return out;
  };
  const seg = geos => {                                           // 线段：去掉两端都在端面上的
    const pos = [], o = new THREE.Vector3();
    geos.filter(Boolean).forEach(geo => { const p = geo.attributes.position.array;
      for (let tile = 0; tile < n; tile++) for (let q = 0; q < p.length; q += 6) {
        if (onEnd(p[q], .003) && onEnd(p[q + 3], .003) || onEnd(p[q], 0) && onEnd(p[q + 3], 0)) continue;
        mapPt(p[q], p[q + 1], p[q + 2], tile, o); pos.push(o.x, o.y, o.z); mapPt(p[q + 3], p[q + 4], p[q + 5], tile, o); pos.push(o.x, o.y, o.z); } });
    const out = new THREE.BufferGeometry(); out.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); return out;
  };
  return { solid: tri(g.solid, 0), edges: seg([g.edges, g.ringTop, g.ringBottom]), panes: g.panes ? tri(g.panes, .005) : null };
}
/* 连接体样式：选中的楼型；封顶层不能当连接，改用光面塔身 */
function linkType(t) { const d = FLOORS.get(t); return d && !d.cap ? t : "shaft"; }
function addBridge(a, b, t = "shaft", v = 0) {
  const pa = floorCenter(...a), pb = floorCenter(...b); if (!pa || !pb) return null;
  if (bridges.some(x => (sameF(x.a, a) && sameF(x.b, b)) || (sameF(x.a, b) && sameF(x.b, a)))) return null;
  t = linkType(t); const rec = { a: a.slice(), b: b.slice(), t, v }, g = linkGeo(a, b, t, v); if (!g) return null;
  rec.obj = meshSet(g, { kind: "bridge", ref: rec });
  bridgeGroup.add(rec.obj); bridges.push(rec); return rec;
}
function dropBridge(rec) { const n = bridges.indexOf(rec); if (n >= 0) bridges.splice(n, 1); bridgeGroup.remove(rec.obj); dispose(rec.obj); }
const sameF = (x, y) => x[0] === y[0] && x[1] === y[1] && x[2] === y[2];

/* ---------------- 编辑操作（都进撤销栈） ---------------- */
function record(a) { hist.push(a); redoStack.length = 0; if (hist.length > 2000) hist.splice(0, hist.length - 2000); }
function place(i, j, t = sel.t, s = sel.s, r = sel.r, v) {
  if (!FLOORS.has(t) || !SIZES[s]) return false;
  if (!canPlace(i, j)) { emit("blocked", { i, j }); return false; }
  const f = { t, s, r, v: v ?? Math.floor(Math.random() * 3) };
  addFloor(i, j, f); record({ op: "add", i, j, f }); changed(); emit("place", { i, j, t, s, r }); return true;
}
function remove(i, j) {
  const f = popFloor(i, j); if (!f) return false;
  record({ op: "del", i, j, f }); changed(); emit("remove", { i, j, t: f.t, s: f.s }); return true;
}
function addWing(i, j, k, d, t = sel.t, s = sel.s, v) {
  const def = FLOORS.get(t); if (!def || def.cap || !SIZES[s]) { emit("blocked", { i, j, k, d }); return false; }
  const w = attachWing(i, j, k, { d, t, s, v: v ?? Math.floor(Math.random() * 3) }); if (!w) return false;
  record({ op: "wing+", i, j, k, w: { d, t, s, v: w.v } }); changed(); emit("wing", { i, j, k, d, t, s }); return true;
}
function removeWing(i, j, k, d) {
  const w = detachWing(i, j, k, d); if (!w) return false;
  record({ op: "wing-", i, j, k, w }); changed(); emit("unwing", { i, j, k, d }); return true;
}
function setDig(i, j, d) { if (d > 0) digs.set(K(i, j), d); else digs.delete(K(i, j)); rebuildPits(); }
function dig(i, j) {
  if (i < 0 || j < 0 || i >= N || j >= N || stackOf(i, j).length || digOf(i, j) >= config.digMax) { emit("blocked", { i, j }); return false; }
  setDig(i, j, digOf(i, j) + 1); record({ op: "dig", i, j }); changed(); emit("dig", { i, j, depth: digOf(i, j) }); return true;
}
function fill(i, j) {
  if (stackOf(i, j).length || !digOf(i, j)) return false;
  setDig(i, j, digOf(i, j) - 1); record({ op: "fill", i, j }); changed(); emit("fill", { i, j, depth: digOf(i, j) }); return true;
}
function connect(a, b, t = sel.t) {
  if (a[0] === b[0] && a[1] === b[1]) return false;
  const r = addBridge(a, b, t, Math.floor(Math.random() * 3)); if (!r) return false;
  record({ op: "link+", a: r.a, b: r.b, t: r.t, v: r.v }); changed(); emit("link", { a: r.a, b: r.b, t: r.t }); return true;
}
function disconnect(rec) { dropBridge(rec); record({ op: "link-", a: rec.a, b: rec.b, t: rec.t, v: rec.v }); changed(); emit("unlink", { a: rec.a, b: rec.b }); return true; }
function findBridge(a, b) { return bridges.find(x => sameF(x.a, a) && sameF(x.b, b)); }
function apply(a, inverse) {
  const add = (a.op === "add") !== inverse, wingAdd = (a.op === "wing+") !== inverse, linkAdd = (a.op === "link+") !== inverse;
  if (a.op === "add" || a.op === "del") {
    if (a.op === "add" ? !inverse : inverse) { addFloor(a.i, a.j, a.f); (a.f.bridges || []).forEach(b => addBridge(b.a, b.b, b.t, b.v)); }
    else { const g = popFloor(a.i, a.j); if (g && a.op === "add") a.f = g; }
  } else if (a.op === "wing+" || a.op === "wing-") { wingAdd ? attachWing(a.i, a.j, a.k, a.w) : detachWing(a.i, a.j, a.k, a.w.d); }
  else if (a.op === "dig" || a.op === "fill") { setDig(a.i, a.j, digOf(a.i, a.j) + ((a.op === "dig") !== inverse ? 1 : -1)); }
  else if (a.op === "link+" || a.op === "link-") { if (linkAdd) addBridge(a.a, a.b, a.t, a.v); else { const r = findBridge(a.a, a.b); if (r) dropBridge(r); } }
  return add;
}
function undo() { const a = hist.pop(); if (!a) return false; apply(a, true); redoStack.push(a); changed(); emit("undo", a); return true; }
function redo() { const a = redoStack.pop(); if (!a) return false; apply(a, false); hist.push(a); changed(); emit("redo", a); return true; }
function clearCity() {
  [...bridges].forEach(dropBridge); digs.clear(); if (pitMesh) rebuildPits();
  [...cells.keys()].forEach(k => { const [i, j] = k.split(",").map(Number); while (popFloor(i, j)); });
  hist.length = 0; redoStack.length = 0; changed();
}
let saveT = 0;
function changed() { updateGhost(); req(); clearTimeout(saveT); saveT = setTimeout(save, 300); emit("change"); }
function exportJSON() {
  const out = [];
  cells.forEach((st, k) => { const [i, j] = k.split(",").map(Number);
    out.push([i, j, st.map(f => [f.t, f.s, f.v, f.r || 0, f.wings.map(w => [w.d, w.t, w.s, w.v])])]); });
  return { v: 3, cells: out, bridges: bridges.map(b => [...b.a, ...b.b, b.t, b.v]), digs: [...digs].map(([k, d]) => [...k.split(",").map(Number), d]) };
}
function importJSON(d) {
  clearCity();
  ((d && d.digs) || []).forEach(([i, j, n]) => { if (n > 0) digs.set(K(i, j), Math.min(config.digMax, n)); }); if (pitMesh) rebuildPits();
  ((d && d.cells) || []).forEach(([i, j, st]) => st.forEach(([t, s, v, r, ws]) => {
    if (FLOORS.has(t) && SIZES[s] && canPlace(i, j)) addFloor(i, j, { t, s, v, r: r || 0, wings: (ws || []).filter(w => FLOORS.has(w[1])).map(([d2, t2, s2, v2]) => ({ d: d2, t: t2, s: s2, v: v2 })) }); }));
  ((d && d.bridges) || []).forEach(b => addBridge(b.slice(0, 3), b.slice(3, 6), b[6] || "shaft", b[7] || 0));
  hist.length = 0; changed();
}
function save() { try { localStorage.setItem(KEY_CITY, JSON.stringify(exportJSON())); } catch (e) { } }
function load() { try { const d = JSON.parse(localStorage.getItem(KEY_CITY)); if (d) importJSON(d); } catch (e) { } }

/* ---------------- 拾取：顶面 / 侧面 / 侧翼 / 连廊 / 地面 ---------------- */
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
function setRay(ev) { const r = renderer.domElement.getBoundingClientRect(); ndc.set((ev.clientX - r.left) / r.width * 2 - 1, -(ev.clientY - r.top) / r.height * 2 + 1); ray.setFromCamera(ndc, camera); }
function pick(ev) {
  setRay(ev);
  const hit = ray.intersectObjects(hitMeshes, false)[0];
  if (hit) {
    const u = hit.object.userData;
    if (u.kind === "bridge") return { kind: "bridge", ref: u.ref };
    if (u.kind === "wing") return { kind: "wing", i: u.i, j: u.j, k: u.k, d: u.d };
    const n = hit.face.normal;                                   // 楼层实体的本地法线
    if (Math.abs(n.y) > .5) return { kind: "top", i: u.i, j: u.j, k: u.k };
    const d = Math.abs(n.x) >= Math.abs(n.z) ? (n.x > 0 ? 0 : 2) : (n.z > 0 ? 1 : 3);
    return { kind: "side", i: u.i, j: u.j, k: u.k, d };
  }
  const p = new THREE.Vector3(); if (!ray.ray.intersectPlane(plane, p)) return null;
  const i = Math.floor(p.x + HALF), j = Math.floor(p.z + HALF);
  return i >= 0 && j >= 0 && i < N && j < N ? { kind: "top", i, j } : null;
}
function groundAt(ev) { setRay(ev); const p = new THREE.Vector3(); return ray.ray.intersectPlane(plane, p) ? p : null; }
function hoverFloor() {                                           // 当前指着的「层」，用于 T 连廊
  if (!hover || hover.kind === "bridge") return null;
  if (hover.k != null) return [hover.i, hover.j, hover.k];
  const st = stackOf(hover.i, hover.j); return st.length ? [hover.i, hover.j, st.length - 1] : null;
}
function setHover(h) {
  const key = x => x ? [x.kind, x.i, x.j, x.k, x.d, x.ref && bridges.indexOf(x.ref)].join() : "";
  if (key(h) === key(hover)) return; hover = h; updateGhost(); emit("hover", hover);
}
function highlight(obj) {
  if (hiObj === obj) return;
  if (hiObj) hiObj.traverse(o => { if (o.isLineSegments && o.userData.prevMat) { o.material = o.userData.prevMat; delete o.userData.prevMat; } });
  hiObj = obj;
  if (obj) obj.traverse(o => { if (o.isLineSegments) { o.userData.prevMat = o.material; o.material = hiLine; } });
}
function updateGhost() {
  if (!scene) return;
  ghost.clear(); if (ghost.parent !== scene) { ghost.parent && ghost.parent.remove(ghost); scene.add(ghost); }
  ghost.position.set(0, 0, 0); ghost.rotation.set(0, 0, 0); ghost.scale.set(1, 1, 1);
  hoverBox.visible = false; ghost.visible = false; highlight(null);
  if (!hover) return req();
  if (hover.kind === "bridge") { highlight(hover.ref.obj); return req(); }
  if (hover.kind === "wing") { const f = stackOf(hover.i, hover.j)[hover.k], w = f && f.wings.find(x => x.d === hover.d); if (w) highlight(w.obj); return req(); }
  if (hover.kind === "side") {
    const f = stackOf(hover.i, hover.j)[hover.k], def = FLOORS.get(sel.t);
    if (f && def && !def.cap && !f.wings.some(x => x.d === hover.d)) {
      ghost.add(wingObj(f, hover.d, sel.t, sel.s, 0, null, ghostFace, ghostLine));
      f.obj.add(ghost); ghost.visible = true;                      // 预览挂在该层上，随它旋转缩放
    }
    return req();
  }
  const y = stackTop(hover.i, hover.j), x = hover.i - HALF + .5, z = hover.j - HALF + .5, ok = canPlace(hover.i, hover.j);
  hoverBox.position.set(x, y + .004, z); hoverBox.visible = true;
  hoverBox.material.color.set(ok ? accent() : "#c0344d");
  if (ok && FLOORS.has(sel.t)) {
    const g = floorGeo(sel.t, sel.s, 0);
    ghost.add(meshSet(g, null, ghostFace, ghostLine));
    ghost.position.set(x, y, z); orient(ghost, g.w, sel.r); ghost.visible = true;
  }
  req();
}
let linkGhost = null;
function clearLinkGhost() { if (!linkGhost) return; scene.remove(linkGhost); linkGhost.traverse(o => { if (o.geometry) o.geometry.dispose(); }); linkGhost = null; }
function updateLink() {
  if (!tAnchor) { clearLinkGhost(); linkLine.visible = false; return req(); }
  const pa = floorCenter(...tAnchor); if (!pa) { tAnchor = null; linkLine.visible = false; return req(); }
  const b = hoverFloor(), pb = b && !(b[0] === tAnchor[0] && b[1] === tAnchor[1]) ? floorCenter(...b) : null;
  clearLinkGhost();
  if (!pb) { linkLine.visible = false; return req(); }
  const g = linkGeo(tAnchor, b, linkType(sel.t), 0);
  if (g) { linkGhost = meshSet(g, null, ghostFace, ghostLine); scene.add(linkGhost); linkLine.visible = false; }
  else { linkLine.geometry.dispose(); linkLine.geometry = lines([[pa.x, pa.y, pa.z], [pb.x, pb.y, pb.z]]); linkLine.computeLineDistances(); linkLine.visible = true; }
  req();
}

/* ---------------- 指针：旋转 / 平移 / 缩放 ---------------- */
function bindPointer(cv) {
  cv.addEventListener("contextmenu", e => e.preventDefault());
  const hov = e => { setHover(expanded ? pick(e) : null); if (tAnchor) updateLink(); };
  cv.addEventListener("pointerleave", () => { if (!drag) setHover(null); });
  cv.addEventListener("pointerdown", e => {
    e.stopPropagation();
    const pan = expanded && (e.button === 2 || e.button === 1 || e.shiftKey);
    drag = { lx: e.clientX, ly: e.clientY, pan, g: pan ? groundAt(e) : null };
    if (!pan) {
      /* 按在楼上：中轴取这栋楼的中心（楼原地转）；按在地面或连廊：取按下的点 */
      setRay(e); const hit = ray.intersectObjects(hitMeshes, false)[0], u = hit && hit.object.userData;
      const fl = u && (u.kind === "floor" || u.kind === "wing") ? stackOf(u.i, u.j)[u.k] : null;
      const g = fl ? fl.obj.position : hit ? hit.point : groundAt(e);
      orbit = g ? { x: g.x, z: g.z } : null; goal.theta = cam.theta; goal.phi = cam.phi;
      pivot.visible = true; updateCamera();
    }
    try { cv.setPointerCapture(e.pointerId); } catch (_) { } cv.classList.add("grabbing");
  });
  cv.addEventListener("pointermove", e => {
    if (drag) {
      if (drag.pan) { const g = groundAt(e); if (g && drag.g) { cam.tx -= g.x - drag.g.x; cam.tz -= g.z - drag.g.z; updateCamera(); } }
      else { rotateBy(-(e.clientX - drag.lx) * .35, (e.clientY - drag.ly) * .25); drag.lx = e.clientX; drag.ly = e.clientY; }
      return;
    }
    hov(e);
  });
  const end = e => { if (!drag) return; drag = null; pivot.visible = false; req(); cv.classList.remove("grabbing"); try { cv.releasePointerCapture(e.pointerId); } catch (_) { } hov(e); };
  cv.addEventListener("pointerup", end); cv.addEventListener("pointercancel", end);
  cv.addEventListener("wheel", e => {
    e.preventDefault(); e.stopPropagation();
    const before = expanded ? groundAt(e) : null;
    cam.dist *= Math.pow(1.0018, e.deltaY); updateCamera();
    const after = before ? groundAt(e) : null;
    if (before && after) { cam.tx += before.x - after.x; cam.tz += before.z - after.z; updateCamera(); }
    hov(e);
  }, { passive: false });
}

/* ---------------- 键盘（只在展开后生效） ---------------- */
const holds = {};
function typing(t) { return t && t.closest && t.closest("input,textarea,select,[contenteditable]"); }
function startHold(k, fn) { if (holds[k]) return; fn(); holds[k] = { t: setTimeout(() => { holds[k].i = setInterval(fn, config.repeatEvery); }, config.repeatDelay) }; }
function stopHold(k) { const h = holds[k]; if (!h) return; clearTimeout(h.t); clearInterval(h.i); delete holds[k]; }
function cycleType(d) { const k = ORDER.indexOf(sel.t); select(ORDER[(k + d + ORDER.length) % ORDER.length]); }
function cycleSize(d) { const ks = Object.keys(SIZES), k = ks.indexOf(sel.s); select(null, ks[Math.max(0, Math.min(ks.length - 1, k + d))]); }
function rotateSel() { select(null, null, (sel.r || 0) + config.rotStep); }
function doPlace() {
  if (!hover) return;
  if (hover.kind === "side") addWing(hover.i, hover.j, hover.k, hover.d);
  else if (hover.kind === "top") place(hover.i, hover.j);
}
function doDelete() {
  if (!hover) return;
  if (hover.kind === "bridge") { if (bridges.includes(hover.ref)) disconnect(hover.ref); return; }
  if (hover.kind === "wing") { removeWing(hover.i, hover.j, hover.k, hover.d); return; }
  if (stackOf(hover.i, hover.j).length) remove(hover.i, hover.j); else dig(hover.i, hover.j);
}
addEventListener("keydown", e => {
  if (!expanded || typing(e.target)) return;
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if ((e.ctrlKey || e.metaKey) && k === "y") { e.preventDefault(); redo(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (k === " " || e.code === "Space") { e.preventDefault(); if (!e.repeat) startHold("space", doPlace); return; }
  if (k === "d") { e.preventDefault(); if (!e.repeat) startHold("d", doDelete); return; }
  if (k === "t") { e.preventDefault(); if (!e.repeat) { tAnchor = hoverFloor(); updateLink(); } return; }
  if (k === "q") { e.preventDefault(); cycleType(-1); return; }
  if (k === "e") { e.preventDefault(); cycleType(1); return; }
  if (k === "w") { e.preventDefault(); cycleSize(1); return; }
  if (k === "s") { e.preventDefault(); cycleSize(-1); return; }
  if (k === "r") { e.preventDefault(); rotateSel(); return; }
  if (k === "f") { e.preventDefault(); if (!e.repeat) startHold("f", () => { if (hover && hover.kind === "top") fill(hover.i, hover.j); }); return; }
  if (k === "escape") { e.preventDefault(); collapse(); }
}, true);
addEventListener("keyup", e => {
  const k = e.key.toLowerCase();
  if (k === " " || e.code === "Space") stopHold("space");
  if (k === "d") stopHold("d");
  if (k === "f") stopHold("f");
  if (k === "t" && tAnchor) { const b = hoverFloor(); if (b) connect(tAnchor, b); tAnchor = null; updateLink(); }
});
addEventListener("blur", () => { stopHold("space"); stopHold("d"); stopHold("f"); tAnchor = null; if (linkLine) updateLink(); });

/* ---------------- 昼夜：只跟随网页主题 ---------------- */
function themeNight() { return document.documentElement.getAttribute("data-theme") === "dark"; }
function refreshNight() { const n = themeNight(); if (n !== night || !scene) { night = n; if (scene) applyPalette(); emit("night", night); } }

/* ---------------- 界面：右下角、展开窗口、底部选择栏 ---------------- */
const UNDO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/></svg>';
const REDO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m15 14 5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/></svg>';
const extraButtons = [];
function addButton(b) { extraButtons.push(b); renderBar(); }
function renderBar() {
  if (!bar) return;
  bar.innerHTML = '<div class="cb-group cb-types">' + ORDER.map(id => { const d = FLOORS.get(id);
      return '<button class="cb-btn' + (sel.t === id ? ' on' : '') + '" data-t="' + id + '" aria-label="' + d.name + '">' + (d.icon || d.name.slice(0, 1)) + '</button>'; }).join("") + '</div>'
    + '<span class="cb-sep"></span><div class="cb-group">' + Object.keys(SIZES).map(s => '<button class="cb-btn cb-size' + (sel.s === s ? ' on' : '') + '" data-s="' + s + '">' + s + '</button>').join("") + '</div>'
    + '<span class="cb-sep"></span><div class="cb-group">'
    + '<button class="cb-btn" data-act="undo" title="撤销 Ctrl+Z">' + UNDO + '</button>'
    + '<button class="cb-btn" data-act="redo" title="重做 Ctrl+Shift+Z">' + REDO + '</button>'
    + extraButtons.map((b, k) => '<button class="cb-btn" data-x="' + k + '" title="' + (b.title || "") + '">' + (b.icon || b.title || "") + '</button>').join("")
    + '</div>';
}
function select(t, s, r) {
  if (t && FLOORS.has(t)) sel.t = t; if (s && SIZES[s]) sel.s = s; if (r != null) sel.r = ((+r % 360) + 360) % 360;
  try { localStorage.setItem(KEY_SEL, JSON.stringify(sel)); } catch (e) { }
  renderBar(); updateGhost(); emit("select", Object.assign({}, sel));
}
function mount(target) { host = target; host.appendChild(renderer.domElement); resize(); applyPalette(); }
function expand() { if (expanded) return; expanded = true; pop.classList.add("show"); mount(popStage); emit("expand"); }
function collapse() {
  if (!expanded) return; expanded = false;
  stopHold("space"); stopHold("d"); tAnchor = null; updateLink(); setHover(null);
  pop.classList.remove("show"); mount(corner.querySelector(".city-host")); emit("collapse");
}
function injectCSS() {
  const st = document.createElement("style");
  st.textContent = `
  .city-host{position:absolute;inset:0;overflow:hidden}
  .city-canvas{display:block;width:100%;height:100%;cursor:grab;touch-action:none}
  .city-canvas.grabbing{cursor:grabbing}
  .city-tri{position:absolute;left:0;top:0;width:36px;height:36px;border:0;padding:0;margin:0;cursor:pointer;z-index:3;background:transparent}
  .city-tri::before{content:"";position:absolute;left:0;top:0;width:18px;height:18px;background:var(--accent);
    clip-path:polygon(0 0,100% 0,0 100%);transition:width var(--d2,200ms) var(--e-out,ease),height var(--d2,200ms) var(--e-out,ease)}
  .city-tri:hover::before{width:26px;height:26px}
  .city-tri:focus-visible{outline:0}.city-tri:focus-visible::before{width:26px;height:26px}
  #corner.city-on{padding:0}
  .city-pop{position:fixed;inset:0;z-index:88;display:flex;align-items:center;justify-content:center;padding:24px;
    background:rgba(12,13,15,.5);opacity:0;pointer-events:none;transition:opacity var(--d2,200ms) var(--e-out,ease)}
  .city-pop.show{opacity:1;pointer-events:auto}
  .city-win{position:relative;width:min(1180px,100%);height:min(800px,100%);background:var(--card);border-radius:var(--r,2px);
    box-shadow:var(--sh5);display:flex;flex-direction:column;overflow:hidden;transform:scale(.97);transition:transform var(--d3,320ms) var(--e-out,ease)}
  .city-pop.show .city-win{transform:none}
  .city-pop.night .city-win{background:#13141b}
  .city-stage{position:relative;flex:1;min-height:0}
  .city-bar{display:flex;align-items:center;justify-content:center;gap:12px;flex-wrap:wrap;padding:8px 16px;
    border-top:1px solid var(--line-s);background:var(--card)}
  .city-pop.night .city-bar{background:#1a1c26;border-top-color:#262a3a}
  .cb-group{display:flex;gap:2px;flex-wrap:wrap;justify-content:center}
  .cb-sep{width:1px;height:24px;background:var(--line)}
  .cb-btn{width:38px;height:38px;display:flex;align-items:center;justify-content:center;border:1px solid transparent;border-radius:var(--r,2px);
    background:transparent;color:var(--text-soft);cursor:pointer;padding:7px;font-family:var(--mono);font-size:12px;font-weight:700;
    transition:background-color var(--d1,120ms) var(--e-out,ease),color var(--d1,120ms) var(--e-out,ease),border-color var(--d1,120ms) var(--e-out,ease)}
  .cb-btn svg{width:22px;height:22px}
  .cb-btn:hover{background:color-mix(in srgb,var(--text) 6%,transparent);color:var(--text)}
  .cb-btn.on{border-color:var(--accent);color:var(--accent);background:color-mix(in srgb,var(--accent) 8%,transparent)}
  .cb-size{width:32px}
  .cb-pv{position:absolute;width:132px;height:156px;z-index:4;pointer-events:none;background:var(--card);border-radius:var(--r,2px);box-shadow:var(--sh3);
    opacity:0;transform:translateY(4px);transition:opacity var(--d1,120ms) var(--e-out,ease),transform var(--d1,120ms) var(--e-out,ease)}
  .cb-pv.show{opacity:1;transform:none}
  .cb-pv canvas{display:block;width:132px;height:156px}
  .city-pop.night .cb-pv{background:#1a1c26}
  .city-pop.night .cb-btn{color:#a9adc2}.city-pop.night .cb-btn.on{color:var(--accent)}
  `;
  document.head.appendChild(st);
}
/* 楼型预览：单独一个小渲染器；普通层叠 3 层（看得出有没有缝），封顶层放在两层光面塔身上 */
let tp = null;
function showTypePreview(btn) {
  const t = btn.dataset.t, def = FLOORS.get(t); if (!def) return;
  if (!tp) {
    const el = document.createElement("div"); el.className = "cb-pv";
    const r2 = new THREE.WebGLRenderer({ antialias: true, alpha: true }); r2.setPixelRatio(Math.min(devicePixelRatio || 1, 2)); r2.setSize(132, 156);
    el.appendChild(r2.domElement); pop.querySelector(".city-win").appendChild(el);
    const sc = new THREE.Scene(), h2 = new THREE.HemisphereLight(), d2 = new THREE.DirectionalLight(); d2.position.copy(sun.position); sc.add(h2, d2);
    tp = { el, r2, sc, h2, d2, cam: new THREE.PerspectiveCamera(28, 132 / 156, .01, 100), obj: null };
  }
  tp.h2.color.copy(hemi.color); tp.h2.groundColor.copy(hemi.groundColor); tp.h2.intensity = hemi.intensity; tp.d2.intensity = sun.intensity;
  if (tp.obj) tp.sc.remove(tp.obj);
  const grp = new THREE.Group(), list = def.cap ? ["shaft", "shaft", t] : [t, t, t]; let y = 0;
  const objs = list.map(id => { const g = floorGeo(id, "M", 1), o = meshSet(g); o.position.y = y; y += g.h; grp.add(o); return { id, o }; });
  objs.forEach(({ id, o }, k) => { if (!FLOORS.get(id).seamless) return;            // 同 refreshSeams：相同的相邻层不画交界线
    o.children.forEach(c => { if (c.userData.seam === "top") c.visible = !(objs[k + 1] && objs[k + 1].id === id); if (c.userData.seam === "bottom") c.visible = !(objs[k - 1] && objs[k - 1].id === id); }); });
  tp.obj = grp; tp.sc.add(grp);
  const bb = new THREE.Box3().setFromObject(grp), c = bb.getCenter(new THREE.Vector3()), rr = bb.getSize(new THREE.Vector3()).length() / 2;
  const d = rr / Math.sin(rad(tp.cam.fov) / 2) * 1.05, th = rad(45), ph = rad(24);
  tp.cam.position.set(c.x + d * Math.cos(ph) * Math.sin(th), c.y + d * Math.sin(ph), c.z + d * Math.cos(ph) * Math.cos(th)); tp.cam.lookAt(c);
  tp.r2.render(tp.sc, tp.cam);
  const wr = pop.querySelector(".city-win").getBoundingClientRect(), br = btn.getBoundingClientRect();
  tp.el.style.left = Math.round(br.left - wr.left + br.width / 2 - 66) + "px"; tp.el.style.top = Math.round(br.top - wr.top - 156 - 10) + "px";
  tp.el.classList.add("show");
}
function hideTypePreview() { if (tp) tp.el.classList.remove("show"); }
function buildUI() {
  injectCSS();
  corner.classList.add("city-on");
  corner.innerHTML = '<div class="city-host"></div><button class="city-tri" aria-label="展开"></button>';
  pop = document.createElement("div"); pop.className = "city-pop";
  pop.innerHTML = '<div class="city-win"><div class="city-stage"></div><button class="city-tri" aria-label="收起"></button><div class="city-bar"></div></div>';
  document.body.appendChild(pop);
  popStage = pop.querySelector(".city-stage"); bar = pop.querySelector(".city-bar");
  corner.querySelector(".city-tri").addEventListener("click", e => { e.stopPropagation(); expand(); });
  pop.querySelector(".city-tri").addEventListener("click", e => { e.stopPropagation(); collapse(); });
  pop.addEventListener("mousedown", e => { if (e.target === pop) collapse(); });
  bar.addEventListener("mousedown", e => { if (e.target.closest(".cb-btn")) e.preventDefault(); });
  bar.addEventListener("mouseover", e => { const b = e.target.closest(".cb-btn[data-t]"); if (b) showTypePreview(b); });
  bar.addEventListener("mouseout", e => { const b = e.target.closest(".cb-btn[data-t]"); if (b && !b.contains(e.relatedTarget)) hideTypePreview(); });   // 不抢焦点，空格不会触发按钮
  bar.addEventListener("click", e => {
    const b = e.target.closest(".cb-btn"); if (!b) return;
    if (b.dataset.t) select(b.dataset.t); else if (b.dataset.s) select(null, b.dataset.s);
    else if (b.dataset.act === "undo") undo(); else if (b.dataset.act === "redo") redo();
    else if (b.dataset.x != null) { const x = extraButtons[+b.dataset.x]; if (x && x.onClick) x.onClick(api); }
  });
  new ResizeObserver(resize).observe(corner); new ResizeObserver(resize).observe(popStage);
  new MutationObserver(() => { refreshNight(); applyPalette(); }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  renderBar();
}

/* ---------------- 启动：右下角可见（桌面端）时才创建 WebGL ---------------- */
let started = false;
function start() {
  corner = document.getElementById("corner");
  if (started || !corner || !corner.offsetWidth) return;
  started = true; night = themeNight();
  initThree(); buildUI(); bindPointer(renderer.domElement);
  mount(corner.querySelector(".city-host")); load(); updateGhost();
  emit("ready", api);
}

/* ---------------- 扩展接口 ----------------
   CityGame.registerFloor(def)                 新增楼层类型（见上方 def 说明；helpers.facade / helpers.F 生成立面线条）
   CityGame.addButton({icon,title,onClick})    在底部栏加按钮
   CityGame.on(事件, fn)  ready / place / remove / wing / unwing / link / unlink / undo / redo / change / select /
                          hover / night / expand / collapse / blocked / render / register
   CityGame.place(i,j[,t,s,r]) / remove(i,j) / addWing(i,j,k,d[,t,s]) / removeWing(i,j,k,d)
   CityGame.connect([i,j,k],[i,j,k]) / undo() / redo() / clear()
   CityGame.select(t,s,r) / rotateBy(dθ,dφ) / expand() / collapse() / exportJSON() / importJSON(data)
   CityGame.three / scene / camera / renderer / cells / bridges / config / sizes / helpers */
const api = {
  registerFloor, addButton, on, off, place, remove, addWing, removeWing, connect, dig, fill, undo, redo, clear: clearCity,
  select, expand, collapse, rotateBy, exportJSON, importJSON, config, sizes: SIZES, helpers, three: THREE,
  get floors() { return ORDER.map(id => FLOORS.get(id)); },
  get selected() { return Object.assign({}, sel); },
  get scene() { return scene; }, get camera() { return camera; }, get renderer() { return renderer; },
  get cells() { return cells; }, get bridges() { return bridges; }, get night() { return night; }, get hover() { return hover; },
  refresh() { updateCamera(); req(); }
};
window.CityGame = api;
emit("loaded", api);
addEventListener("resize", start);
start();
