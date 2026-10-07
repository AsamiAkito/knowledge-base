/* ============================================================
   线条城市 —— 右下角小游戏（three.js r160，本地 vendor）
   ------------------------------------------------------------
   · 线稿砖块风格：白天白立面 + 细线立面图案；夜里（网页暗色主题）窗格亮灯
   · 190×190 棋盘，透视相机（近大远小）
   · 视角：左键拖动绕「按下时鼠标所指的点」旋转 / 改俯仰（拖动时显示中轴），
     滚轮缩放；展开后右键或 Shift+拖动平移、滚轮朝鼠标位置缩放
   · 右下角只能旋转和缩放；点左上角三角展开后才能编辑：
       左键单击 / 空格   指着顶面 / 地面 → 往上盖一层；指着某层侧面 → 在该面加侧翼（空格长按连放）
       右键单击 / Delete  删掉指着的方块 / 侧翼 / 连接，否则删该格最上一层；空格子则把地面降低一层（最多地下三层）
       左键拖动旋转，右键或 Shift+拖动平移；W A S D 按屏幕方向平移
       选中小方块（固定 0.16）时可在格子里任意位置摆放：指地面 / 楼顶放在所指位置，指方块顶面叠上去，指方块侧面紧贴一块
       F      空格子把地面升高一层（坑先填平，最高 12 层；相邻同高的地块连成一体，中间不画缝线）
       选中地标后按空格：在指着的格子放下整栋地标（一次撤销整栋撤掉）
       T      指着一层按住，移到另一栋楼的某层松开 → 两层相对的面直接融合相连
       Q / E  选左 / 右一个楼层    Z / C  尺寸减小 / 增大    R  顺时针旋转 15°
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
  digLevel: .16, digMax: 3, raiseMax: 12,         // 地面每层高度（= 一层楼高）、最多下挖 / 升高几层
  terrainBand: 36,                                // 随机地形只在离边缘这么多格以内，越靠边越高
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
  let outline = r.autoEdges === false ? (r.lines || null) : new THREE.EdgesGeometry(r.solid, 25), facadeG = r.autoEdges === false ? null : (r.lines || null);
  let ringTop = r.ringTop || null, ringBottom = r.ringBottom || null;
  if (r.autoEdges !== false) {                          // 轮廓里 y=0 与 y=h 的水平线段拆成上下边线（无缝层由 refreshSeams 决定显隐）
    const keep = [], top = [], bot = [], a = outline.attributes.position.array, e = 1e-4;
    for (let n = 0; n < a.length; n += 6) {
      const seg = [[a[n], a[n + 1], a[n + 2]], [a[n + 3], a[n + 4], a[n + 5]]], flat = Math.abs(a[n + 1] - a[n + 4]) < e;
      if (flat && Math.abs(a[n + 1] - h) < e) top.push(...seg); else if (flat && Math.abs(a[n + 1]) < e) bot.push(...seg); else keep.push(...seg);
    }
    outline = lines(keep); ringTop = ringTop || lines(top); ringBottom = ringBottom || lines(bot);
  }
  const edges = merge([outline, facadeG, ringTop, ringBottom]);   // 全部线条（预览、连接体用）
  const out = { solid: r.solid, edges, outline, facade: facadeG, panes: r.panes || null, h, w, ringTop, ringBottom };
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
registerFloor({ id: "cubeS", name: "小方块（无缝）", width: .16, seamless: true, icon: I('<path d="M12 3l5 2.8v12.4L12 21l-5-2.8V5.8z"/><path d="M7 5.8l5 2.8 5-2.8M12 8.6V21"/>'),
  build: ({ w, h, seed }) => ({ solid: box(w, h), panes: boxPanes(w, h, { seed, cols: 1, ph: 1, pr: .6 }) }) });
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

/* ---------------- 地标与组合模板 ----------------
   registerTemplate({ id, name, icon, build(r, P) }) — build 用 P() 生成一栋（或一组）楼的计划：
     P().add(di, dj, 楼型, 层数, 尺寸, { r: 角度或 p=>角度, z: 缩放或 p=>缩放 })   p 为本段从 0 到 1 的进度
        .wing(di, dj, 本格第几层, 面 0..3, 楼型, 尺寸)   .link([di,dj,层], [di,dj,层], 楼型)
   r 是随机数函数（随机城市楼用）。放置时以鼠标所指的格子为 (0,0)。 */
const TEMPLATES = new Map(), TORDER = [];
function plan() {
  const F = [], W = [], Lk = [], cnt = {}, o = {
    add(di, dj, t, n = 1, sz = "M", opt = {}) { const key = di + "," + dj;
      for (let q = 0; q < n; q++) { const p = n > 1 ? q / (n - 1) : 0, val = (x, d) => typeof x === "function" ? x(p) : (x ?? d);
        F.push({ di, dj, t, s: sz, r: val(opt.r, 0), z: val(opt.z, 1) }); cnt[key] = (cnt[key] || 0) + 1; }
      return o; },
    count(di, dj) { return cnt[di + "," + dj] || 0; },
    wing(di, dj, k, d, t, sz = "M") { W.push({ di, dj, k, d, t, s: sz }); return o; },
    link(a, b, t) { Lk.push({ a, b, t }); return o; },
    done() { return { floors: F, wings: W, links: Lk }; }
  };
  return o;
}
function registerTemplate(def) {
  if (!def || !def.id || typeof def.build !== "function") throw new Error("registerTemplate: 需要 id 和 build");
  if (!TEMPLATES.has(def.id)) TORDER.push(def.id); TEMPLATES.set(def.id, def); renderBar(); emit("register", def);
}
function templatePlan(id, seed) { const d = TEMPLATES.get(id); if (!d) return null; const p = d.build(rng(seed), plan); return p && p.floors ? p : p.done(); }
function placeTemplate(i, j, id, seed = Date.now()) {
  const p = templatePlan(id, seed); if (!p) return false;
  if (p.floors.some(f => !inBoard(i + f.di, j + f.dj))) { emit("blocked", { i, j }); return false; }
  const base = {}, kOf = (di, dj, k) => base[K(i + di, j + dj)] + k;
  group(() => {
    p.floors.forEach(f => { const ci = i + f.di, cj = j + f.dj; if (base[K(ci, cj)] == null) base[K(ci, cj)] = stackOf(ci, cj).length;
      place(ci, cj, f.t, f.s, f.r, undefined, f.z); });
    p.wings.forEach(w => addWing(i + w.di, j + w.dj, kOf(w.di, w.dj, w.k), w.d, w.t, w.s));
    p.links.forEach(l => connect([i + l.a[0], j + l.a[1], kOf(l.a[0], l.a[1], l.a[2])], [i + l.b[0], j + l.b[1], kOf(l.b[0], l.b[1], l.b[2])], l.t));
  });
  emit("template", { i, j, id }); return true;
}
const IT = p => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round">' + p + "</svg>";
registerTemplate({ id: "empire", name: "帝国大厦", icon: IT('<path d="M12 2v4M10.5 6h3v3h-3zM9 9h6v4H9zM7 13h10v8H7zM4 21h16"/>'),
  build: (r, P) => P().add(0, 0, "window", 8, "L").add(0, 0, "window", 34, "L", { z: .92 }).add(0, 0, "window", 22, "M").add(0, 0, "window", 10, "S", { z: .9 })
    .add(0, 0, "setback", 6, "S", { z: .9 }).add(0, 0, "antenna", 1, "S", { z: .8 }) });
registerTemplate({ id: "burj", name: "哈利法塔", icon: IT('<path d="M12 2v5M11 7h2v4h-2zM10 11h4v4h-4zM9 15h6v6H9zM6 21h12"/>'),
  build: (r, P) => { const p = P().add(0, 0, "curtain", 36, "L"); for (let k = 0; k < 36; k++) [0, 1, 2].forEach(d => p.wing(0, 0, k, d, "curtain", "M"));
    p.add(0, 0, "curtain", 30, "M"); for (let k = 36; k < 56; k++) [0, 2].forEach(d => p.wing(0, 0, k, d, "curtain", "S"));
    return p.add(0, 0, "curtain", 26, "S").add(0, 0, "curtain", 14, "S", { z: .7 }).add(0, 0, "shaft", 10, "S", { z: .5 }).add(0, 0, "spire", 1, "S", { z: .5 }); } });
registerTemplate({ id: "shanghai", name: "上海中心", icon: IT('<path d="M8 21c0-7 2-12 3-19h2c1 7 3 12 3 19z"/><path d="M9.5 15c2-1 3.5-2.5 5-5"/>'),
  build: (r, P) => P().add(0, 0, "curtain", 110, "L", { r: p => p * 120, z: p => 1 - p * .38 }).add(0, 0, "parapet", 1, "L", { r: 120, z: .62 }) });
registerTemplate({ id: "taipei101", name: "台北 101", icon: IT('<path d="M12 2v3M10 5h4l-.5 3h-3zM9 8h6l-.6 3H9.6zM9 11h6l-.6 3H9.6zM8.5 14h7l-.6 3h-5.8zM7 17h10v4H7z"/>'),
  build: (r, P) => { const p = P().add(0, 0, "window", 12, "L", { z: .92 });
    for (let q = 0; q < 8; q++) p.add(0, 0, "grid", 8, "M", { z: x => .8 + x * .2 });
    return p.add(0, 0, "setback", 6, "S").add(0, 0, "spire", 1, "S"); } });
registerTemplate({ id: "petronas", name: "双子塔", icon: IT('<path d="M6 21V8l1.5-6L9 8v13M15 21V8l1.5-6L18 8v13M9 12h6M4 21h16"/>'),
  build: (r, P) => { const p = P();
    [0, 2].forEach(di => p.add(di, 0, "column", 44, "L").add(di, 0, "column", 12, "M").add(di, 0, "column", 8, "S").add(di, 0, "round", 4, "S", { z: .8 }).add(di, 0, "spire", 1, "S", { z: .8 }));
    return p.link([0, 0, 24], [2, 0, 24], "grid"); } });
registerTemplate({ id: "willis", name: "威利斯大厦", icon: IT('<path d="M5 21V10h4v11M9 21V4h3v17M12 21V6h3v15M15 21V12h4v9M10 4V2M13 6V3M3 21h18"/>'),
  build: (r, P) => { const p = P(), H = [[44, 60, 36], [60, 74, 60], [28, 44, 36]];
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) p.add(a - 1, b - 1, "curtain", H[a][b], "L").add(a - 1, b - 1, (a === 1 && b === 1) || (a === 0 && b === 1) ? "antenna" : "parapet", 1, "L");
    return p; } });
registerTemplate({ id: "cntower", name: "CN 塔", icon: IT('<path d="M12 2v8M11 10h2v3h-2zM8 13h8l-1 2H9zM11 15h2v6h-2zM8 21h8"/>'),
  build: (r, P) => P().add(0, 0, "column", 64, "S", { z: p => .8 - p * .15 }).add(0, 0, "round", 3, "L").add(0, 0, "column", 4, "S", { z: .6 })
    .add(0, 0, "round", 1, "M").add(0, 0, "column", 26, "S", { z: .42 }).add(0, 0, "antenna", 1, "S", { z: .4 }) });
registerTemplate({ id: "onewtc", name: "世贸一号", icon: IT('<path d="M12 2v3M9 21l2-16h2l2 16zM9.5 14h5M6 21h12"/>'),
  build: (r, P) => P().add(0, 0, "shaft", 10, "L").add(0, 0, "curtain", 72, "L", { r: p => p * 45, z: p => 1 - p * .32 }).add(0, 0, "antenna", 1, "L", { r: 45, z: .66 }) });
registerTemplate({ id: "chrysler", name: "克莱斯勒大厦", icon: IT('<path d="M12 2v4M10 6l2-2 2 2v3h-4zM9 9h6v12H9zM6 13h12v8H6zM4 21h16"/><path d="M10 7.5c1-.6 3-.6 4 0"/>'),
  build: (r, P) => P().add(0, 0, "window", 26, "L").add(0, 0, "window", 18, "M").add(0, 0, "setback", 8, "M").add(0, 0, "round", 4, "S", { z: .85 }).add(0, 0, "spire", 1, "S") });
registerTemplate({ id: "random", name: "随机城市楼", icon: IT('<rect x="5" y="5" width="14" height="14" rx="1"/><circle cx="9" cy="9" r=".6" fill="currentColor"/><circle cx="15" cy="15" r=".6" fill="currentColor"/><circle cx="12" cy="12" r=".6" fill="currentColor"/>'),
  build: (r, P) => { const pickR = a => a[Math.floor(r() * a.length)], p = P();
    const bodies = ["grid", "vfin", "curtain", "louver", "ribbon", "window", "diagrid", "square", "slot", "shaft"];
    if (r() < .5) p.add(0, 0, pickR(["podium", "window", "plain"]), 1 + Math.floor(r() * 4), "L");
    const b1 = pickR(bodies), n1 = 8 + Math.floor(r() * 40); p.add(0, 0, b1, n1, pickR(["M", "L"]));
    if (r() < .55) p.add(0, 0, r() < .5 ? b1 : pickR(bodies), 4 + Math.floor(r() * 16), "S", { z: .8 + r() * .2 });
    const cap = pickR(["parapet", "crown", "spire", "antenna", "dome", "roofbox", null]); if (cap) p.add(0, 0, cap, 1, "S");
    return p; } });

/* ---------------- 配色：白天 = 网页亮色主题，夜晚 = 网页暗色主题 ---------------- */
function palette(night) {
  if (night) return { face: 0x22252f, line: 0x7d84a0, ground: 0x1d2030, side: 0x181a26, side2: 0x151721, minor: 0x272b3c, major: 0x333850, sky: 0x9aa0c0, gnd: 0x1a1c28, ambient: 1.6, sun: .6, clear: 0x13141b };
  return { face: 0xffffff, line: 0x2c2e36, ground: 0xfcfcfd, side: 0xececf2, side2: 0xe1e1ea, minor: 0xececf2, major: 0xdadae4, sky: 0xffffff, gnd: 0xdedeea, ambient: 2.9, sun: .5, clear: 0xf6f6f4 };
}

/* ---------------- 状态 ----------------
   cells:   "i,j" → [ floor ]，floor = { t,s,v,r, wings:[{d,t,s,v,obj}], obj, h }
   bridges: [ { a:[i,j,k], b:[i,j,k], obj } ] */
const cells = new Map(), bridges = [], terrain = new Map();   // terrain: "i,j" → 地面高度层数（负 = 坑，正 = 高地）
const hist = [], redoStack = [];
let sel = Object.assign({ t: "grid", s: "M", r: 0 }, (() => { try { return JSON.parse(localStorage.getItem(KEY_SEL)) || {}; } catch (e) { return {}; } })());
if (!FLOORS.has(sel.t)) sel.t = "grid";
let night = false, hover = null, expanded = false, tAnchor = null, drag = null;

/* ---------------- three.js 场景 ---------------- */
let facadeMat, renderer, scene, camera, hemi, sun, faceMat, lineMat, paneMat, ghostFace, ghostLine, hiLine;
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
  facadeMat = new THREE.LineBasicMaterial({ color: 0x2c2e36, transparent: true });
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
    const now = performance.now(), dtm = Math.min(.05, (now - (loop.t || now)) / 1000); loop.t = now;
    if (panKeys.size && expanded) {
      const th = rad(cam.theta), fx = -Math.sin(th), fz = -Math.cos(th), sp = cam.dist * .9 * dtm;
      let mx = 0, mz = 0;
      if (panKeys.has("w")) { mx += fx; mz += fz; } if (panKeys.has("s")) { mx -= fx; mz -= fz; }
      if (panKeys.has("d")) { mx += -fz; mz += fx; } if (panKeys.has("a")) { mx -= -fz; mz -= fx; }
      if (mx || mz) { cam.tx += mx * sp; cam.tz += mz * sp; orbit = null; updateCamera(); }
    }
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
/* 地形：每个非零格画一块顶面（坑底或高地顶），只在两格高度不同的边界画一整面竖墙（不分层），
   相邻同高的格子共面相连，所以整块地形中间没有缝线 */
function rebuildTerrain() {
  const M = N + 2, data = digMask.image.data, L = config.digLevel, tri = [];
  data.fill(255);
  const quad = (a, b, c, d) => tri.push(...a, ...b, ...c, ...a, ...c, ...d);
  terrain.forEach((h, key) => {
    const [i, j] = key.split(",").map(Number), x0 = i - HALF, x1 = x0 + 1, z0 = j - HALF, z1 = z0 + 1, y = h * L;
    const px = ((M - 1 - (j + 1)) * M + (i + 1)) * 4; data[px] = data[px + 1] = data[px + 2] = data[px + 3] = 0;
    quad([x0, y, z0], [x1, y, z0], [x1, y, z1], [x0, y, z1]);
    [[i + 1, j, x1, z0, x1, z1], [i - 1, j, x0, z1, x0, z0], [i, j + 1, x1, z1, x0, z1], [i, j - 1, x0, z0, x1, z0]].forEach(([ni, nj, ax, az, bx, bz]) => {
      const nh = levelOf(ni, nj);
      if (h > nh) quad([ax, nh * L, az], [bx, nh * L, bz], [bx, y, bz], [ax, y, az]);                // 比邻格高：画到邻格高度
      else if (h < nh && nh === 0) quad([ax, y, az], [bx, y, bz], [bx, 0, bz], [ax, 0, az]);         // 坑边是平地：坑壁画到地面
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
  faceMat.color.setHex(p.face); lineMat.color.setHex(p.line); facadeMat.color.setHex(p.line);
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
  facadeMat.opacity = Math.max(0, Math.min(1, (ppc - 4) / 10));          // 拉远时立面细节淡出，只留楼体轮廓
  facadeMat.visible = facadeMat.opacity > .02;
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
const levelOf = (i, j) => terrain.get(K(i, j)) || 0;
function stackTop(i, j) { return levelOf(i, j) * config.digLevel + stackOf(i, j).reduce((a, f) => a + f.h, 0); }
function canPlace(i, j) {
  if (i < 0 || j < 0 || i >= N || j >= N) return false;
  const st = stackOf(i, j), top = st[st.length - 1];
  return !(top && FLOORS.get(top.t) && FLOORS.get(top.t).cap);
}
/* 一组可渲染对象：实体 + 线 + 窗格；tag 写进实体的 userData 供拾取 */
function meshSet(g, tag, mat = faceMat, lmat = lineMat) {
  const grp = new THREE.Group(), m = new THREE.Mesh(g.solid, mat);
  if (tag) { m.userData = tag; hitMeshes.push(m); }
  grp.add(m);
  if (lmat !== lineMat || g.outline === undefined) grp.add(new THREE.LineSegments(g.edges, lmat));   // 预览、连接体：整套线条
  else {
    if (g.outline) grp.add(new THREE.LineSegments(g.outline, lineMat));
    if (g.facade) grp.add(new THREE.LineSegments(g.facade, facadeMat));
    if (g.ringTop) { const t = new THREE.LineSegments(g.ringTop, facadeMat), b = new THREE.LineSegments(g.ringBottom, facadeMat); t.userData.seam = "top"; b.userData.seam = "bottom"; grp.add(t, b); }
  }
  if (g.panes && mat === faceMat) { const pm = new THREE.Mesh(g.panes, paneMat); pm.userData.pane = true; pm.visible = night; grp.add(pm); }
  return grp;
}
function dispose(obj) { obj.traverse(o => { const k = hitMeshes.indexOf(o); if (k >= 0) hitMeshes.splice(k, 1); }); if (hiObj && !hiObj.parent) hiObj = null; }
function orient(obj, w, r, z = 1) {                   // z：这一层的缩放（≤1），斜放时再按比例缩小保证不出格
  const a = rad(r || 0), k = Math.min(1, .96 / (w * z * (Math.abs(Math.cos(a)) + Math.abs(Math.sin(a)))));
  obj.rotation.y = -a; obj.scale.set(k * z, 1, k * z);
}
const sameLayer = (a, b) => a && b && a.t === b.t && a.s === b.s && (a.r || 0) === (b.r || 0) && (a.z || 1) === (b.z || 1);
function refreshSeams(i, j) {
  const st = stackOf(i, j);
  const seams = (obj, top, bot) => obj.traverse(o => { if (o.userData.seam === "top") o.visible = top; else if (o.userData.seam === "bottom") o.visible = bot; });
  st.forEach((f, k) => {
    if (FLOORS.get(f.t).seamless) f.obj.children.forEach(o => { if (o.userData.seam === "top") o.visible = !sameLayer(f, st[k + 1]); else if (o.userData.seam === "bottom") o.visible = !sameLayer(f, st[k - 1]); });
    f.wings.forEach(w => { if (!FLOORS.get(w.t).seamless) return;
      const same = g => g && sameLayer(f, g) && g.wings.some(x => x.d === w.d && x.t === w.t && x.s === w.s && (x.u || 0) === (w.u || 0));
      seams(w.obj, !same(st[k + 1]), !same(st[k - 1])); });
  });
  req();
}
function addFloor(i, j, f) {
  const st = stackOf(i, j), k = st.length, y = stackTop(i, j), g = floorGeo(f.t, f.s, f.v);
  const obj = meshSet(g, { kind: "floor", i, j, k });
  obj.position.set(i - HALF + .5, y, j - HALF + .5); orient(obj, g.w, f.r, f.z || 1);
  const rec = { t: f.t, s: f.s, v: f.v, r: f.r || 0, z: f.z || 1, h: g.h, obj, wings: [] };
  floorsGroup.add(obj); obj.updateMatrixWorld(true); st.push(rec); cells.set(K(i, j), st);
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
  return { t: f.t, s: f.s, v: f.v, r: f.r, z: f.z, wings: f.wings.map(w => ({ d: w.d, t: w.t, s: w.s, v: w.v, u: w.u })), bridges: gone.map(b => ({ a: b.a, b: b.b, t: b.t, v: b.v })) };
}
/* 侧翼：挂在某层的某个面（d=0..3，楼层本地坐标的 +x +z -x -z），随楼层旋转缩放 */
function wingU(parent, t, s, u) {                     // 固定尺寸侧翼沿面方向的位置（吸附、不出面）；其它侧翼居中
  if (!FLOORS.get(t) || !FLOORS.get(t).width) return 0;
  const lim = Math.max(0, floorGeo(parent.t, parent.s, parent.v).w / 2 - floorGeo(t, s, 0).w / 2);
  return Math.max(-lim, Math.min(lim, Math.round((u || 0) / .04) * .04));
}
function wingObj(parent, d, t, s, v, tag, mat, lmat, u = 0) {
  const g = floorGeo(t, s, v), pw = floorGeo(parent.t, parent.s, parent.v).w, ww = Math.min(g.w * .8, pw), depth = config.wingDepth;
  const outer = new THREE.Group(), inner = meshSet(g, tag, mat, lmat);
  outer.rotation.y = -d * Math.PI / 2;
  if (FLOORS.get(t).width) inner.position.set(pw / 2 + g.w / 2, 0, u);          // 小方块：原尺寸，贴在所指位置
  else { inner.position.x = pw / 2 + depth / 2; inner.scale.set(depth / g.w, parent.h / g.h, ww / g.w); }
  outer.add(inner); return outer;
}
function attachWing(i, j, k, w) {
  const f = stackOf(i, j)[k]; if (!f) return null; const u = wingU(f, w.t, w.s, w.u);
  if (f.wings.some(x => x.d === w.d && (x.u || 0) === u)) return null;
  const obj = wingObj(f, w.d, w.t, w.s, w.v, { kind: "wing", i, j, k, d: w.d, u }, faceMat, lineMat, u);
  f.obj.add(obj); obj.updateMatrixWorld(true); const rec = { d: w.d, t: w.t, s: w.s, v: w.v, u, obj }; f.wings.push(rec); refreshSeams(i, j); return rec;
}
function detachWing(i, j, k, d, u = 0) {
  const f = stackOf(i, j)[k]; if (!f) return null;
  const n = f.wings.findIndex(x => x.d === d && Math.abs((x.u || 0) - u) < 1e-6); if (n < 0) return null;
  const w = f.wings.splice(n, 1)[0]; f.obj.remove(w.obj); dispose(w.obj); refreshSeams(i, j);
  return { d: w.d, t: w.t, s: w.s, v: w.v, u: w.u };
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
  return { solid: tri(g.solid, 0), edges: seg([g.edges]), panes: g.panes ? tri(g.panes, .005) : null };
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

/* ---------------- 自由方块：固定尺寸楼型（如 0.16 小方块）可在格子里任意位置摆放 ----------------
   blocks: [{ x, z, y, t, v, obj }]（世界坐标，x/z 吸附 0.04）；落在地面、楼顶或下方方块上，也可贴在方块侧面悬空 */
const blocks = [], BSNAP = .04;
const bsnap = v => Math.round(v / BSNAP) * BSNAP;
const isFixed = t => !!(FLOORS.get(t) && FLOORS.get(t).width);
const blockMode = () => isFixed(sel.t) && !sel.tpl;
function bgeo(b) { return floorGeo(b.t, "M", b.v || 0); }
function overlapXZ(b, x, z, w) { return Math.abs(b.x - x) < (bgeo(b).w + w) / 2 - 1e-4 && Math.abs(b.z - z) < (bgeo(b).w + w) / 2 - 1e-4; }
function groundUnder(x, z) {                              // 该点下方：地形高度，或（在楼的占地范围内时）楼顶
  const i = Math.floor(x + HALF), j = Math.floor(z + HALF); if (!inBoard(i, j)) return null;
  let y = levelOf(i, j) * config.digLevel; const st = stackOf(i, j);
  if (st.length) { const cx = i - HALF + .5, cz = j - HALF + .5, hw = Math.max(...st.map(f => floorGeo(f.t, f.s, f.v).w * (f.z || 1))) / 2;
    if (Math.abs(x - cx) < hw && Math.abs(z - cz) < hw) y = stackTop(i, j); }
  return y;
}
function blockTarget(x, z, t, yFix) {                    // 方块落点；被占用或出界返回 null
  const w = floorGeo(t, "M", 0).w, h = floorGeo(t, "M", 0).h, lim = HALF - w / 2;
  x = Math.max(-lim, Math.min(lim, bsnap(x))); z = Math.max(-lim, Math.min(lim, bsnap(z)));
  let y = yFix;
  if (y == null) { y = groundUnder(x, z); if (y == null) return null; blocks.forEach(b => { if (overlapXZ(b, x, z, w)) y = Math.max(y, b.y + bgeo(b).h); }); }
  if (blocks.some(b => overlapXZ(b, x, z, w) && b.y < y + h - 1e-4 && b.y + bgeo(b).h > y + 1e-4)) return null;
  return { x, z, y };
}
function refreshBlockSeams() {
  blocks.forEach(b => { if (!FLOORS.get(b.t).seamless) return; const h = bgeo(b).h;
    const same = dy => blocks.some(c => c !== b && c.t === b.t && Math.abs(c.x - b.x) < 1e-6 && Math.abs(c.z - b.z) < 1e-6 && Math.abs(c.y - (b.y + dy)) < 1e-6);
    b.obj.children.forEach(o => { if (o.userData.seam === "top") o.visible = !same(h); else if (o.userData.seam === "bottom") o.visible = !same(-h); }); });
  req();
}
function addBlockObj(d) {
  const b = { x: d.x, z: d.z, y: d.y, t: d.t, v: d.v || 0 };
  b.obj = meshSet(bgeo(b), { kind: "block", ref: b }); b.obj.position.set(b.x, b.y, b.z); b.obj.updateMatrixWorld(true);
  floorsGroup.add(b.obj); blocks.push(b); refreshBlockSeams(); return b;
}
function dropBlock(b) { const n = blocks.indexOf(b); if (n >= 0) blocks.splice(n, 1); floorsGroup.remove(b.obj); dispose(b.obj); refreshBlockSeams(); }
const bdata = b => ({ x: b.x, z: b.z, y: b.y, t: b.t, v: b.v });
const findBlock = d => blocks.find(b => b.t === d.t && Math.abs(b.x - d.x) < 1e-6 && Math.abs(b.z - d.z) < 1e-6 && Math.abs(b.y - d.y) < 1e-6);
function placeBlock(x, z, t = sel.t, yFix) {
  if (!isFixed(t)) return false;
  const p = blockTarget(x, z, t, yFix); if (!p) { emit("blocked", { x, z }); return false; }
  const b = addBlockObj({ ...p, t, v: Math.floor(Math.random() * 3) });
  record({ op: "block+", b: bdata(b) }); changed(); emit("block", bdata(b)); return true;
}
function removeBlock(b) {                                 // 删这一列最上面的那块，避免上面的方块悬空
  let top = b; blocks.forEach(c => { if (overlapXZ(c, b.x, b.z, bgeo(b).w) && c.y > top.y) top = c; });
  const d = bdata(top); dropBlock(top); record({ op: "block-", b: d }); changed(); emit("unblock", d); return true;
}

/* ---------------- 编辑操作（都进撤销栈） ---------------- */
let grouping = null;
function group(fn) { grouping = []; try { fn(); } finally { const g = grouping; grouping = null; if (g.length) record({ op: "group", list: g }); } changed(); }
function record(a) { if (grouping) { grouping.push(a); return; } hist.push(a); redoStack.length = 0; if (hist.length > 2000) hist.splice(0, hist.length - 2000); }
function place(i, j, t = sel.t, s = sel.s, r = sel.r, v, z = 1) {
  if (!FLOORS.has(t) || !SIZES[s]) return false;
  if (!canPlace(i, j)) { emit("blocked", { i, j }); return false; }
  const f = { t, s, r, z, v: v ?? Math.floor(Math.random() * 3) };
  addFloor(i, j, f); record({ op: "add", i, j, f }); changed(); emit("place", { i, j, t, s, r }); return true;
}
function remove(i, j) {
  const f = popFloor(i, j); if (!f) return false;
  record({ op: "del", i, j, f }); changed(); emit("remove", { i, j, t: f.t, s: f.s }); return true;
}
function addWing(i, j, k, d, t = sel.t, s = sel.s, v, u = 0) {
  const def = FLOORS.get(t); if (!def || def.cap || !SIZES[s]) { emit("blocked", { i, j, k, d }); return false; }
  const w = attachWing(i, j, k, { d, t, s, u, v: v ?? Math.floor(Math.random() * 3) }); if (!w) return false;
  record({ op: "wing+", i, j, k, w: { d, t, s, v: w.v, u: w.u } }); changed(); emit("wing", { i, j, k, d, t, s }); return true;
}
function removeWing(i, j, k, d, u = 0) {
  const w = detachWing(i, j, k, d, u); if (!w) return false;
  record({ op: "wing-", i, j, k, w }); changed(); emit("unwing", { i, j, k, d }); return true;
}
function setLevel(i, j, h) { if (h) terrain.set(K(i, j), h); else terrain.delete(K(i, j)); rebuildTerrain(); }
const inBoard = (i, j) => i >= 0 && j >= 0 && i < N && j < N;
function dig(i, j) {                                    // 地面降低一层
  if (!inBoard(i, j) || stackOf(i, j).length || levelOf(i, j) <= -config.digMax) { emit("blocked", { i, j }); return false; }
  setLevel(i, j, levelOf(i, j) - 1); record({ op: "dig", i, j }); changed(); emit("dig", { i, j, level: levelOf(i, j) }); return true;
}
function fill(i, j) {                                   // 地面升高一层
  if (!inBoard(i, j) || stackOf(i, j).length || levelOf(i, j) >= config.raiseMax) { emit("blocked", { i, j }); return false; }
  setLevel(i, j, levelOf(i, j) + 1); record({ op: "fill", i, j }); changed(); emit("fill", { i, j, level: levelOf(i, j) }); return true;
}
/* 随机地形：中间平坦，离边缘 terrainBand 格以内起伏，越靠边越高；返回 [[i,j,h],…] */
function genTerrain(seed = Date.now()) {
  const r = rng(seed), out = [], band = config.terrainBand;
  const lattice = (step) => { const n = Math.ceil(N / step) + 2, g = []; for (let q = 0; q < n * n; q++) g.push(r()); return (x, y) => {
    const gx = x / step, gy = y / step, x0 = Math.floor(gx), y0 = Math.floor(gy), fx = gx - x0, fy = gy - y0, sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const v = (a, b) => g[(b % n) * n + (a % n)];
    return (v(x0, y0) * (1 - sx) + v(x0 + 1, y0) * sx) * (1 - sy) + (v(x0, y0 + 1) * (1 - sx) + v(x0 + 1, y0 + 1) * sx) * sy; }; };
  const n1 = lattice(14), n2 = lattice(6);
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    const d = Math.min(i, j, N - 1 - i, N - 1 - j); if (d >= band) continue;
    const e = Math.pow(1 - d / band, 1.4), nz = n1(i, j) * .7 + n2(i, j) * .3;
    const h = Math.round(e * 6 + (nz - .5) * 10 * e - (d > band * .55 && nz < .32 ? 2 : 0));
    const hc = Math.max(-config.digMax, Math.min(config.raiseMax, h)); if (hc) out.push([i, j, hc]);
  }
  return out;
}
function terrainSnapshot() { return [...terrain].map(([k, h]) => [...k.split(",").map(Number), h]); }
function setTerrain(list) { terrain.clear(); list.forEach(([i, j, h]) => { if (h) terrain.set(K(i, j), h); }); rebuildTerrain(); }
function randomTerrain(seed) {                          // 有楼的格子保持原高度
  const before = terrainSnapshot(), keep = new Map(before.map(([i, j, h]) => [K(i, j), h]));
  const next = genTerrain(seed).filter(([i, j]) => !stackOf(i, j).length);
  cells.forEach((st, k) => { if (keep.has(k)) { const [i, j] = k.split(",").map(Number); next.push([i, j, keep.get(k)]); } });
  setTerrain(next); record({ op: "terrain", before, after: next }); changed(); emit("terrain"); return true;
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
  } else if (a.op === "wing+" || a.op === "wing-") { wingAdd ? attachWing(a.i, a.j, a.k, a.w) : detachWing(a.i, a.j, a.k, a.w.d, a.w.u || 0); }
  else if (a.op === "dig" || a.op === "fill") { setLevel(a.i, a.j, levelOf(a.i, a.j) + ((a.op === "dig") !== inverse ? -1 : 1)); }
  else if (a.op === "block+" || a.op === "block-") { if ((a.op === "block+") !== inverse) addBlockObj(a.b); else { const b = findBlock(a.b); if (b) dropBlock(b); } }
  else if (a.op === "terrain") { setTerrain(inverse ? a.before : a.after); }
  else if (a.op === "group") { (inverse ? [...a.list].reverse() : a.list).forEach(x => apply(x, inverse)); }
  else if (a.op === "link+" || a.op === "link-") { if (linkAdd) addBridge(a.a, a.b, a.t, a.v); else { const r = findBridge(a.a, a.b); if (r) dropBridge(r); } }
  return add;
}
function undo() { const a = hist.pop(); if (!a) return false; apply(a, true); redoStack.push(a); changed(); emit("undo", a); return true; }
function redo() { const a = redoStack.pop(); if (!a) return false; apply(a, false); hist.push(a); changed(); emit("redo", a); return true; }
function clearCity() {
  [...bridges].forEach(dropBridge); [...blocks].forEach(dropBlock); terrain.clear(); if (pitMesh) rebuildTerrain();
  [...cells.keys()].forEach(k => { const [i, j] = k.split(",").map(Number); while (popFloor(i, j)); });
  hist.length = 0; redoStack.length = 0; changed();
}
let saveT = 0;
function changed() { updateGhost(); req(); clearTimeout(saveT); saveT = setTimeout(save, 300); emit("change"); }
function exportJSON() {
  const out = [];
  cells.forEach((st, k) => { const [i, j] = k.split(",").map(Number);
    out.push([i, j, st.map(f => [f.t, f.s, f.v, f.r || 0, f.wings.map(w => [w.d, w.t, w.s, w.v, w.u || 0]), f.z || 1])]); });
  return { v: 5, cells: out, bridges: bridges.map(b => [...b.a, ...b.b, b.t, b.v]), terrain: terrainSnapshot(), blocks: blocks.map(b => [b.x, b.z, b.y, b.t, b.v]) };
}
function importJSON(d) {
  clearCity();
  ((d && d.digs) || []).forEach(([i, j, n]) => { if (n > 0) terrain.set(K(i, j), -Math.min(config.digMax, n)); });     // v3：只有坑
  ((d && d.terrain) || []).forEach(([i, j, h]) => { if (h) terrain.set(K(i, j), Math.max(-config.digMax, Math.min(config.raiseMax, h))); });
  if (pitMesh) rebuildTerrain();
  ((d && d.cells) || []).forEach(([i, j, st]) => st.forEach(([t, s, v, r, ws, z]) => {
    if (FLOORS.has(t) && SIZES[s] && canPlace(i, j)) addFloor(i, j, { t, s, v, r: r || 0, z: z || 1, wings: (ws || []).filter(w => FLOORS.has(w[1])).map(([d2, t2, s2, v2, u2]) => ({ d: d2, t: t2, s: s2, v: v2, u: u2 || 0 })) }); }));
  ((d && d.bridges) || []).forEach(b => addBridge(b.slice(0, 3), b.slice(3, 6), b[6] || "shaft", b[7] || 0));
  ((d && d.blocks) || []).forEach(([x, z, y, t, v]) => { if (isFixed(t)) addBlockObj({ x, z, y, t, v }); });
  hist.length = 0; changed();
}
function save() { try { localStorage.setItem(KEY_CITY, JSON.stringify(exportJSON())); } catch (e) { } }
function load() { try { const d = JSON.parse(localStorage.getItem(KEY_CITY)); if (d) importJSON(d); } catch (e) { } }

/* ---------------- 拾取：顶面 / 侧面 / 侧翼 / 连廊 / 地面 ---------------- */
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
function setRay(ev) { const r = renderer.domElement.getBoundingClientRect(); ndc.set((ev.clientX - r.left) / r.width * 2 - 1, -(ev.clientY - r.top) / r.height * 2 + 1); ray.setFromCamera(ndc, camera); }
function pick(ev) {
  setRay(ev);
  const hit = ray.intersectObjects(pitMesh ? [...hitMeshes, pitMesh] : hitMeshes, false)[0];
  if (hit && hit.object === pitMesh) {
    const p = hit.point.clone().addScaledVector(ray.ray.direction, Math.abs(hit.face.normal.y) > .5 ? 0 : .01), i = Math.floor(p.x + HALF), j = Math.floor(p.z + HALF);
    return inBoard(i, j) ? { kind: "top", i, j, p: hit.point.clone() } : null;
  }
  if (hit) {
    const u = hit.object.userData;
    if (u.kind === "bridge") return { kind: "bridge", ref: u.ref };
    if (u.kind === "block") { const n = hit.face.normal; return { kind: "block", ref: u.ref, p: hit.point.clone(), n: [Math.round(n.x), Math.round(n.y), Math.round(n.z)] }; }
    if (u.kind === "wing") return { kind: "wing", i: u.i, j: u.j, k: u.k, d: u.d, u: u.u || 0 };
    const n = hit.face.normal;                                   // 楼层实体的本地法线
    if (Math.abs(n.y) > .5) return { kind: "top", i: u.i, j: u.j, k: u.k, p: hit.point.clone() };
    const d = Math.abs(n.x) >= Math.abs(n.z) ? (n.x > 0 ? 0 : 2) : (n.z > 0 ? 1 : 3), [fx, fz] = FACES[d];
    const loc = stackOf(u.i, u.j)[u.k].obj.worldToLocal(hit.point.clone());   // 侧面上的位置（沿面方向）
    return { kind: "side", i: u.i, j: u.j, k: u.k, d, u: loc.x * -fz + loc.z * fx };
  }
  const p = new THREE.Vector3(); if (!ray.ray.intersectPlane(plane, p)) return null;
  const i = Math.floor(p.x + HALF), j = Math.floor(p.z + HALF);
  return i >= 0 && j >= 0 && i < N && j < N ? { kind: "top", i, j, p } : null;
}
function groundAt(ev) { setRay(ev); const p = new THREE.Vector3(); return ray.ray.intersectPlane(plane, p) ? p : null; }
function hoverFloor() {                                           // 当前指着的「层」，用于 T 连廊
  if (!hover || hover.kind === "bridge") return null;
  if (hover.k != null) return [hover.i, hover.j, hover.k];
  const st = stackOf(hover.i, hover.j); return st.length ? [hover.i, hover.j, st.length - 1] : null;
}
function setHover(h) {
  const key = x => x ? [x.kind, x.i, x.j, x.k, x.d, x.ref && (bridges.indexOf(x.ref) + "/" + blocks.indexOf(x.ref)), x.n, blockMode() ? [x.u, x.p && bsnap(x.p.x), x.p && bsnap(x.p.z)] : ""].join() : "";
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
  if (hover.kind === "wing") { const f = stackOf(hover.i, hover.j)[hover.k], w = f && f.wings.find(x => x.d === hover.d && Math.abs((x.u || 0) - hover.u) < 1e-6); if (w) highlight(w.obj); return req(); }
  if (blockMode() && hover.kind !== "side") {                       // 方块模式：预览落点
    const p = blockAim(); if (p) { ghost.add(meshSet(floorGeo(sel.t, "M", 0), null, ghostFace, ghostLine)); ghost.position.set(p.x, p.y, p.z); ghost.visible = true; }
    return req();
  }
  if (hover.kind === "block") { highlight(hover.ref.obj); return req(); }
  if (hover.kind === "side") {
    const f = stackOf(hover.i, hover.j)[hover.k], def = FLOORS.get(sel.t);
    const u = f && def ? wingU(f, sel.t, sel.s, hover.u) : 0;
    if (f && def && !def.cap && !f.wings.some(x => x.d === hover.d && (x.u || 0) === u)) {
      ghost.add(wingObj(f, hover.d, sel.t, sel.s, 0, null, ghostFace, ghostLine, u));
      f.obj.add(ghost); ghost.visible = true;                      // 预览挂在该层上，随它旋转缩放
    }
    return req();
  }
  const y = stackTop(hover.i, hover.j), x = hover.i - HALF + .5, z = hover.j - HALF + .5, ok = canPlace(hover.i, hover.j);
  hoverBox.position.set(x, y + .004, z); hoverBox.visible = true;
  hoverBox.material.color.set(ok ? accent() : "#c0344d");
  if (ok && FLOORS.has(sel.t) && !sel.tpl) {
    const g = floorGeo(sel.t, sel.s, 0);
    ghost.add(meshSet(g, null, ghostFace, ghostLine));
    ghost.position.set(x, y, z); orient(ghost, g.w, sel.r); ghost.visible = true;
  }
  req();
}
let linkGhost = null;
function clearLinkGhost() { if (!linkGhost) return; scene.remove(linkGhost); linkGhost.traverse(o => { if (o.geometry) o.geometry.dispose(); }); linkGhost = null; }
/* 方块模式下当前所指的落点 */
function blockAim() {
  if (!hover) return null;
  if (hover.kind === "block") { const b = hover.ref, [nx, ny, nz] = hover.n || [0, 1, 0], w = bgeo(b).w;
    if (ny > 0) return blockTarget(b.x, b.z, sel.t);
    if (ny < 0) return null;
    return blockTarget(b.x + nx * (w + floorGeo(sel.t, "M", 0).w) / 2, b.z + nz * (w + floorGeo(sel.t, "M", 0).w) / 2, sel.t, b.y); }
  if (hover.kind === "top" && hover.p) return blockTarget(hover.p.x, hover.p.z, sel.t);
  return null;
}
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
    drag = { lx: e.clientX, ly: e.clientY, sx: e.clientX, sy: e.clientY, btn: e.button, moved: 0, pan, g: pan ? groundAt(e) : null };
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
      drag.moved = Math.max(drag.moved, Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy));
      if (drag.pan) { const g = groundAt(e); if (g && drag.g) { cam.tx -= g.x - drag.g.x; cam.tz -= g.z - drag.g.z; updateCamera(); } }
      else { rotateBy(-(e.clientX - drag.lx) * .35, (e.clientY - drag.ly) * .25); drag.lx = e.clientX; drag.ly = e.clientY; }
      return;
    }
    hov(e);
  });
  const end = e => { if (!drag) return; const d0 = drag; drag = null; pivot.visible = false;
    if (expanded && e.type === "pointerup" && d0.moved < 5) { if (d0.btn === 0) doPlace(); else if (d0.btn === 2) doDelete(); } req(); cv.classList.remove("grabbing"); try { cv.releasePointerCapture(e.pointerId); } catch (_) { } hov(e); };
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
const holds = {}, panKeys = new Set();
function typing(t) { return t && t.closest && t.closest("input,textarea,select,[contenteditable]"); }
function startHold(k, fn) { if (holds[k]) return; fn(); holds[k] = { t: setTimeout(() => { holds[k].i = setInterval(fn, config.repeatEvery); }, config.repeatDelay) }; }
function stopHold(k) { const h = holds[k]; if (!h) return; clearTimeout(h.t); clearInterval(h.i); delete holds[k]; }
function cycleType(d) { const k = ORDER.indexOf(sel.t); select(ORDER[(k + d + ORDER.length) % ORDER.length]); }
function cycleSize(d) { const ks = Object.keys(SIZES), k = ks.indexOf(sel.s); select(null, ks[Math.max(0, Math.min(ks.length - 1, k + d))]); }
function rotateSel() { select(null, null, (sel.r || 0) + config.rotStep); }
function doPlace() {
  if (!hover) return;
  if (blockMode() && hover.kind !== "side") { const p = blockAim(); if (p) placeBlock(p.x, p.z, sel.t, hover.kind === "block" && !(hover.n && hover.n[1] > 0) ? p.y : undefined); return; }
  if (hover.kind === "side") addWing(hover.i, hover.j, hover.k, hover.d, sel.t, sel.s, undefined, hover.u);
  else if (hover.kind === "top") { if (sel.tpl) placeTemplate(hover.i, hover.j, sel.tpl); else place(hover.i, hover.j); }
}
function doDelete() {
  if (!hover) return;
  if (hover.kind === "bridge") { if (bridges.includes(hover.ref)) disconnect(hover.ref); return; }
  if (hover.kind === "block") { if (blocks.includes(hover.ref)) removeBlock(hover.ref); return; }
  if (hover.kind === "wing") { removeWing(hover.i, hover.j, hover.k, hover.d, hover.u || 0); return; }
  if (stackOf(hover.i, hover.j).length) remove(hover.i, hover.j); else dig(hover.i, hover.j);
}
addEventListener("keydown", e => {
  if (!expanded || typing(e.target)) return;
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if ((e.ctrlKey || e.metaKey) && k === "y") { e.preventDefault(); redo(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (k === " " || e.code === "Space") { e.preventDefault(); if (!e.repeat) { if (sel.tpl) doPlace(); else startHold("space", doPlace); } return; }
  if (k === "delete" || k === "backspace") { e.preventDefault(); if (!e.repeat) startHold("del", doDelete); return; }
  if (k === "w" || k === "a" || k === "s" || k === "d") { e.preventDefault(); panKeys.add(k); return; }
  if (k === "t") { e.preventDefault(); if (!e.repeat) { tAnchor = hoverFloor(); updateLink(); } return; }
  if (k === "q") { e.preventDefault(); cycleType(-1); return; }
  if (k === "e") { e.preventDefault(); cycleType(1); return; }
  if (k === "z") { e.preventDefault(); cycleSize(-1); return; }
  if (k === "c") { e.preventDefault(); cycleSize(1); return; }
  if (k === "r") { e.preventDefault(); rotateSel(); return; }
  if (k === "f") { e.preventDefault(); if (!e.repeat) startHold("f", () => { if (hover && hover.kind === "top" && !stackOf(hover.i, hover.j).length) fill(hover.i, hover.j); }); return; }
  if (k === "escape") { e.preventDefault(); collapse(); }
}, true);
addEventListener("keyup", e => {
  const k = e.key.toLowerCase();
  if (k === " " || e.code === "Space") stopHold("space");
  if (k === "delete" || k === "backspace") stopHold("del");
  panKeys.delete(k);
  if (k === "f") stopHold("f");
  if (k === "t" && tAnchor) { const b = hoverFloor(); if (b) connect(tAnchor, b); tAnchor = null; updateLink(); }
});
addEventListener("blur", () => { stopHold("space"); stopHold("del"); stopHold("f"); panKeys.clear(); tAnchor = null; if (linkLine) updateLink(); });

/* ---------------- 昼夜：只跟随网页主题 ---------------- */
function themeNight() { return document.documentElement.getAttribute("data-theme") === "dark"; }
function refreshNight() { const n = themeNight(); if (n !== night || !scene) { night = n; if (scene) applyPalette(); emit("night", night); } }

/* ---------------- 界面：右下角、展开窗口、底部选择栏 ---------------- */
const UNDO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/></svg>';
const REDO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m15 14 5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/></svg>';
const TERRAIN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M2 19l6-9 4 5 3-4 7 8z"/><path d="M8 10l1.5 2.2"/></svg>';
const extraButtons = [];
function addButton(b) { extraButtons.push(b); renderBar(); }
function renderBar() {
  if (!bar) return;
  bar.innerHTML = '<div class="cb-group cb-types">' + ORDER.map(id => { const d = FLOORS.get(id);
      return '<button class="cb-btn' + (sel.t === id && !sel.tpl ? ' on' : '') + '" data-t="' + id + '" aria-label="' + d.name + '">' + (d.icon || d.name.slice(0, 1)) + '</button>'; }).join("") + '</div>'
    + '<span class="cb-sep"></span><div class="cb-group">' + TORDER.map(id => { const d = TEMPLATES.get(id);
      return '<button class="cb-btn' + (sel.tpl === id ? ' on' : '') + '" data-tpl="' + id + '" aria-label="' + d.name + '">' + (d.icon || d.name.slice(0, 1)) + '</button>'; }).join("") + '</div>'
    + '<span class="cb-sep"></span><div class="cb-group">' + Object.keys(SIZES).map(s => '<button class="cb-btn cb-size' + (sel.s === s ? ' on' : '') + '" data-s="' + s + '">' + s + '</button>').join("") + '</div>'
    + '<span class="cb-sep"></span><div class="cb-group">'
    + '<button class="cb-btn" data-act="terrain" aria-label="随机地形">' + TERRAIN + '</button>'
    + '<button class="cb-btn" data-act="undo" title="撤销 Ctrl+Z">' + UNDO + '</button>'
    + '<button class="cb-btn" data-act="redo" title="重做 Ctrl+Shift+Z">' + REDO + '</button>'
    + extraButtons.map((b, k) => '<button class="cb-btn" data-x="' + k + '" title="' + (b.title || "") + '">' + (b.icon || b.title || "") + '</button>').join("")
    + '</div>';
}
function select(t, s, r) {
  if (t && FLOORS.has(t)) { sel.t = t; sel.tpl = null; } if (s && SIZES[s]) sel.s = s; if (r != null) sel.r = ((+r % 360) + 360) % 360;
  try { localStorage.setItem(KEY_SEL, JSON.stringify(sel)); } catch (e) { }
  renderBar(); updateGhost(); emit("select", Object.assign({}, sel));
}
function mount(target) { host = target; host.appendChild(renderer.domElement); resize(); applyPalette(); }
function expand() { if (expanded) return; expanded = true; pop.classList.add("show"); mount(popStage); emit("expand"); }
function collapse() {
  if (!expanded) return; expanded = false;
  stopHold("space"); stopHold("del"); panKeys.clear(); tAnchor = null; updateLink(); setHover(null);
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
  const t = btn.dataset.t, def = FLOORS.get(t), tplId = btn.dataset.tpl; if (!def && !TEMPLATES.has(tplId)) return;
  if (!tp) {
    const el = document.createElement("div"); el.className = "cb-pv";
    const r2 = new THREE.WebGLRenderer({ antialias: true, alpha: true }); r2.setPixelRatio(Math.min(devicePixelRatio || 1, 2)); r2.setSize(132, 156);
    el.appendChild(r2.domElement); pop.querySelector(".city-win").appendChild(el);
    const sc = new THREE.Scene(), h2 = new THREE.HemisphereLight(), d2 = new THREE.DirectionalLight(); d2.position.copy(sun.position); sc.add(h2, d2);
    tp = { el, r2, sc, h2, d2, cam: new THREE.PerspectiveCamera(28, 132 / 156, .01, 100), obj: null };
  }
  tp.h2.color.copy(hemi.color); tp.h2.groundColor.copy(hemi.groundColor); tp.h2.intensity = hemi.intensity; tp.d2.intensity = sun.intensity;
  if (tp.obj) tp.sc.remove(tp.obj);
  const grp = new THREE.Group();
  /* 楼型：普通层叠 3 层，封顶层放在两层光面塔身上；地标：按计划逐格叠起（侧翼与连接省略） */
  const floors = tplId ? templatePlan(tplId, 7).floors : (def.cap ? ["shaft", "shaft", t] : [t, t, t]).map(id => ({ di: 0, dj: 0, t: id, s: "M", r: 0, z: 1 }));
  const tops = {}, objs = floors.map(f => { const key = f.di + "," + f.dj, g = floorGeo(f.t, f.s, 1), o = meshSet(g);
    o.position.set(f.di, tops[key] || 0, f.dj); orient(o, g.w, f.r, f.z); tops[key] = (tops[key] || 0) + g.h; grp.add(o); return { f, o, key }; });
  objs.forEach(({ f, o, key }, k) => { if (!FLOORS.get(f.t).seamless) return;            // 同 refreshSeams：相同的相邻层不画交界线
    const nb = d => { for (let q = k + d; q >= 0 && q < objs.length; q += d) if (objs[q].key === key) return objs[q].f; return null; };
    o.children.forEach(c => { if (c.userData.seam === "top") c.visible = !sameLayer(f, nb(1)); if (c.userData.seam === "bottom") c.visible = !sameLayer(f, nb(-1)); }); });
  tp.obj = grp; tp.sc.add(grp);
  const bb = new THREE.Box3().setFromObject(grp), c = bb.getCenter(new THREE.Vector3()), rr = bb.getSize(new THREE.Vector3()).length() / 2;
  const d = rr / Math.sin(rad(tp.cam.fov) / 2) * 1.05, th = rad(45), ph = rad(24);
  tp.cam.position.set(c.x + d * Math.cos(ph) * Math.sin(th), c.y + d * Math.sin(ph), c.z + d * Math.cos(ph) * Math.cos(th)); tp.cam.lookAt(c);
  const fo = facadeMat.opacity, fv = facadeMat.visible; facadeMat.opacity = 1; facadeMat.visible = true;
  tp.r2.render(tp.sc, tp.cam); facadeMat.opacity = fo; facadeMat.visible = fv;
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
  bar.addEventListener("mouseover", e => { const b = e.target.closest(".cb-btn[data-t],.cb-btn[data-tpl]"); if (b) showTypePreview(b); });
  bar.addEventListener("mouseout", e => { const b = e.target.closest(".cb-btn[data-t],.cb-btn[data-tpl]"); if (b && !b.contains(e.relatedTarget)) hideTypePreview(); });   // 不抢焦点，空格不会触发按钮
  bar.addEventListener("click", e => {
    const b = e.target.closest(".cb-btn"); if (!b) return;
    if (b.dataset.t) select(b.dataset.t); else if (b.dataset.s) select(null, b.dataset.s);
    else if (b.dataset.tpl) { sel.tpl = sel.tpl === b.dataset.tpl ? null : b.dataset.tpl; select(); }
    else if (b.dataset.act === "terrain") randomTerrain();
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
  mount(corner.querySelector(".city-host"));
  let saved = null; try { saved = localStorage.getItem(KEY_CITY); } catch (e) { }
  if (saved) load(); else setTerrain(genTerrain(20261007));
  updateGhost();
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
  registerFloor, registerTemplate, placeTemplate, addButton, on, off, place, remove, addWing, removeWing, connect, dig, fill,
  raise: fill, lower: dig, randomTerrain, genTerrain, group, placeBlock, removeBlock, undo, redo, clear: clearCity,
  select, expand, collapse, rotateBy, exportJSON, importJSON, config, sizes: SIZES, helpers, three: THREE,
  get floors() { return ORDER.map(id => FLOORS.get(id)); },
  get selected() { return Object.assign({}, sel); },
  get scene() { return scene; }, get camera() { return camera; }, get renderer() { return renderer; },
  get cells() { return cells; }, get terrain() { return terrain; }, get blocks() { return blocks; }, get templates() { return TORDER.map(id => TEMPLATES.get(id)); }, get bridges() { return bridges; }, get night() { return night; }, get hover() { return hover; },
  refresh() { updateCamera(); req(); }
};
window.CityGame = api;
emit("loaded", api);
addEventListener("resize", start);
start();
