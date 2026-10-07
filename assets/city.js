/* ============================================================
   线条城市 —— 右下角小游戏（three.js r160，本地 vendor）
   ------------------------------------------------------------
   · 线稿砖块风格：白天白立面 + 细线立面图案；夜里（网页暗色主题）窗格亮灯
   · 190×190 棋盘，透视相机（近大远小）
   · 视角：左键拖动平移；右键（或 Shift+左键）拖动绕「按下时鼠标所指的点」旋转 / 改俯仰（拖动时显示中轴）；
     滚轮缩放（展开后朝鼠标位置）
   · 右下角只能平移、旋转和缩放；点左上角三角展开后才能编辑：
       左键单击 / 空格   指着顶面 / 地面 → 往上盖一层；指着某层侧面 → 在该面加侧翼（空格长按连放）
       右键单击 / X       删掉指着的方块 / 侧翼 / 连接，否则删该格最上一层；空格子则把地面降低一层（最多地下三层）；X 长按连删
       贴图：街道铺在空地格上（自动连路、画路缘与中线），窗户 / 门贴在楼层侧面所指位置；右键或 X 移除
       左键拖动平移，右键拖动旋转（Shift+左键也可）；W A S D 按屏幕方向平移
       选中小方块（固定 0.16）时可在格子里任意位置摆放：指地面 / 楼顶放在所指位置，指方块顶面叠上去，指方块侧面紧贴一块
       F      空格子把地面升高一层（坑先填平，最高 12 层；相邻同高的地块连成一体，中间不画缝线）
       选中地标后按空格：在指着的格子放下整栋地标（一次撤销整栋撤掉）
       T      指着某层侧面单按 → 与该面朝向的相邻楼（同高度那层）合为一栋，中间按所指那层的样式填满
              按住移到另一栋楼的某层松开 → 两层相对的面融合相连（用选中的楼型样式）
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
  distMin: 1.2, distMax: 420,                       // 相机到中轴点的距离范围（缩放）
  rotStep: 15,                                    // R 键每次顺时针旋转的角度
  damping: .22,                                   // 旋转缓动（0–1，越大越跟手）
  recenterNear: 30,
  homeView: { tx: -1, tz: -1, theta: 45, phi: 37, dist: 43 },   // 打开网站时右下角的视角：拉近看中心城区
  builtinWindows: false,                          // 楼层 / 方块是否自带窗（默认不带，窗户用贴图加）
  fadeNear: 12, fadeReach: 6,                     // 相机距离小于 fadeNear 才虚化；只虚化离镜头 fadeReach 格以内挡视线的楼                               // 相机距离小于它时视野可移到棋盘任意位置，大于它逐步回中
  thickness: 3,                                   // 棋盘厚度（格）
  digLevel: .16, digMax: 3, raiseMax: 300,         // 地面每层高度（= 一层楼高）、最多下挖 / 升高几层（山可以比最高的楼还高）
  terrainBand: 40,                                // 随机地形只在离边缘这么多格以内，越靠边越高
  wingDepth: .32,                                 // 侧翼伸出的深度（格）
  repeatDelay: 300, repeatEvery: 90,              // 长按连放 / 连删的节奏（毫秒）
  dayMinutes: 24,                                 // 现实多少分钟是城里的一天
  carsPer: 5.2, carsMax: 300                      // 每多少格街道一辆车、最多几辆
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
  /* 标准窗框（与窗户贴图完全一致） */
  windows: (size = "M", rot = false) => (w, h) => { const [ww, wh] = winDims(size, rot, h), o = [], y1 = h * .2, y2 = y1 + wh;
    winCenters(w, ww, winStep(size, rot)).forEach(u => { const a = u - ww / 2, c = u + ww / 2; o.push([a, y1, c, y1], [c, y1, c, y2], [c, y2, a, y2], [a, y2, a, y1]); }); return o; },
  /* 窗与窗之间的竖线（幕墙分格） */
  mullions: (size = "M", rot = false) => (w, h) => { const ww = winDims(size, rot, h)[0], st = winStep(size, rot), c = winCenters(w, ww, st), o = [];
    c.slice(1).forEach((u, k) => { const m = (c[k] + u) / 2; o.push([m, 0, m, h]); }); return o; },
  /* 紧贴每扇窗两侧的竖线（肋条 / 竖条窗） */
  flank: (size = "M", rot = false, gap = .008) => (w, h) => { const ww = winDims(size, rot, h)[0], o = [];
    winCenters(w, ww, winStep(size, rot)).forEach(u => { o.push([u - ww / 2 - gap, 0, u - ww / 2 - gap, h], [u + ww / 2 + gap, 0, u + ww / 2 + gap, h]); }); return o; },
  /* 窗台线与窗顶线（带形窗） */
  band: (size = "M", rot = false) => (w, h) => { const wh = winDims(size, rot, h)[1]; return [[-w / 2, h * .2, w / 2, h * .2], [-w / 2, h * .2 + wh, w / 2, h * .2 + wh]]; },
  all: (...fns) => (w, h) => fns.flatMap(f => f(w, h))
};
/* 标准窗：只有小 / 中 / 大三种（可竖放），窗台在层高 20% 处；窗中心按 WP 等距排列、整体居中。
   所有楼层的窗（含夜里的亮灯窗格）和窗户贴图都用这一套，所以任何楼层都能用「实墙层 + 窗户贴图」复刻 */
const WIN = { S: [.048, .064], M: [.072, .096], T: [.096, .144] }, WP = .12;
function winDims(s, rot, h) { const [a, b] = WIN[s] || WIN.M; return rot ? [b, Math.min(a, h * .72)] : [a, Math.min(b, h * .72)]; }
function winCenters(w, ww, step = WP) {                     // 一面墙上窗中心的位置（沿墙方向，墙中心为 0）
  const n = Math.max(1, Math.floor((w * .86 - ww) / step + 1e-6) + 1), o = [];
  for (let k = 0; k < n; k++) o.push((k - (n - 1) / 2) * step);
  return o;
}
const winStep = (s, rot) => s === "T" && rot ? WP * 2 : WP;              // 横放的大窗按两倍窗距排
/* 方盒四面的标准窗格（夜里亮灯）：win = { s, rot, step, lit } */
function boxPanes(w, h, { s: size = "M", rot = false, step, seed = 1, lit = .72, y0 = 0 } = {}) {
  const r = rng(seed), pos = [], col = [], [ww, wh] = winDims(size, rot, h), half = w / 2 + .005, yb = y0 + h * .2;
  FACES.forEach(([nx, nz]) => { const tx = -nz, tz = nx;
    winCenters(w, ww, step || winStep(size, rot)).forEach(u => {
      const P = (a, b) => [nx * half + tx * (u + a * ww / 2), yb + b * wh, nz * half + tz * (u + a * ww / 2)];
      const c3 = r() < lit ? [1, .82, .42] : [.05, .06, .085];
      [P(-1, 0), P(1, 0), P(1, 1), P(-1, 0), P(1, 1), P(-1, 1)].forEach(v => { pos.push(...v); col.push(...c3); }); }); });
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  return g;
}
function roundPanes(rad, h, { s: size = "M", rot = false, seed = 1, lit = .72 } = {}) {                 // 圆柱面上的标准窗
  const r = rng(seed), pos = [], col = [], R2 = rad + .005, [ww, wh] = winDims(size, rot, h), count = Math.max(3, Math.floor(Math.PI * 2 * rad * .86 / winStep(size, rot))), yb = h * .2;
  for (let i = 0; i < count; i++) { const a = i / count * Math.PI * 2, nx = Math.cos(a), nz = Math.sin(a), tx = -nz, tz = nx;
    const P = (p, q) => [nx * R2 + tx * p * ww / 2, yb + q * wh, nz * R2 + tz * p * ww / 2], c3 = r() < lit ? [1, .82, .42] : [.05, .06, .085];
    [P(-1, 0), P(1, 0), P(1, 1), P(-1, 0), P(1, 1), P(-1, 1)].forEach(v => { pos.push(...v); col.push(...c3); }); }
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
  const out = { solid: r.solid, edges, outline, facade: facadeG, panes: config.builtinWindows ? r.panes || null : null, h, w, ringTop, ringBottom };
  geoCache.set(key, out); return out;
}

/* ---------------- 内置楼层（线稿砖块） ---------------- */
const I = p => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round">' + p + "</svg>";
const body = (id, name, icon, lineFn, paneOpt, extra = {}) => registerFloor(Object.assign({ id, name, icon,
  win: paneOpt ? paneOpt() : null,
  build: ({ w, h, seed }) => ({ solid: box(w, h), lines: lineFn ? facade(w, h, lineFn) : null, panes: paneOpt ? boxPanes(w, h, Object.assign({ seed }, paneOpt(w))) : null }) }, extra));
body("grid", "网格幕墙", I('<rect x="5" y="4" width="14" height="16"/><path d="M8.5 4v16M12 4v16M15.5 4v16M5 9.3h14M5 14.6h14"/>'),
  F.all(F.mullions("M"), F.band("M")), () => ({ s: "M" }));
body("vfin", "竖向肋条", I('<rect x="5" y="4" width="14" height="16"/><path d="M7.3 4v16M9.6 4v16M11.9 4v16M14.2 4v16M16.5 4v16"/>'),
  F.all(F.flank("T"), F.mullions("T")), () => ({ s: "T" }), { seamless: true });
body("louver", "横向百叶", I('<rect x="5" y="5" width="14" height="14"/><path d="M5 7.5h14M5 10h14M5 12.5h14M5 15h14M5 17.5h14"/>'),
  F.hlines(3), () => ({ s: "S" }));
body("ribbon", "带形窗", I('<rect x="5" y="5" width="14" height="14"/><path d="M5 9h14M5 13h14"/><path d="M8 9v4M11 9v4M14 9v4M17 9v4"/>'),
  F.band("M"), () => ({ s: "M" }));
body("window", "窗户层", I('<rect x="5" y="6" width="14" height="12"/><path d="M7.5 9h3v5h-3zM13.5 9h3v5h-3z"/>'),
  null, () => ({ s: "M" }), { hidden: true });          // 不带窗后与实墙层相同：底部栏不显示，地标模板仍可用
body("diagrid", "斜交网格", I('<rect x="5" y="4" width="14" height="16"/><path d="M5 4l7 16M12 4 5 20M12 4l7 16M19 4l-7 16"/>'),
  F.diag(3), () => ({ s: "S", step: WP * 2 }));
body("curtain", "玻璃幕墙", I('<rect x="6" y="5" width="12" height="15"/><path d="M9 5v15M12 5v15M15 5v15M6 12h12"/>'),
  F.mullions("T"), () => ({ s: "T" }), { seamless: true });
body("plain", "实墙层", I('<rect x="5" y="8" width="14" height="10"/>'), null, null);
body("square", "正方形方格", I('<rect x="4" y="8" width="16" height="5.3"/><path d="M9.3 8v5.3M14.6 8v5.3"/><rect x="4" y="13.3" width="16" height="5.3"/><path d="M9.3 13.3v5.3M14.6 13.3v5.3"/>'),
  F.mullions("T", true), () => ({ s: "T", rot: true }));
registerFloor({ id: "cube", name: "小方块", width: 1 / 6, height: 1 / 6, win: { s: "S" }, icon: I('<path d="M12 6l6 3.5v7L12 20l-6-3.5v-7z"/><path d="M6 9.5l6 3.5 6-3.5M12 13v7"/>'),
  build: ({ w, h, seed }) => ({ solid: box(w, h), panes: boxPanes(w, h, { seed, s: "S" }) }) });
registerFloor({ id: "cubeS", name: "小方块（无缝）", width: 1 / 6, height: 1 / 6, seamless: true, win: { s: "S", rot: true }, icon: I('<path d="M12 3l5 2.8v12.4L12 21l-5-2.8V5.8z"/><path d="M7 5.8l5 2.8 5-2.8M12 8.6V21"/>'),
  build: ({ w, h, seed }) => ({ solid: box(w, h), panes: boxPanes(w, h, { seed, s: "S", rot: true }) }) });
body("shaft", "光面塔身", I('<path d="M7 3v18M17 3v18"/>'), null, () => ({ s: "S", rot: true, step: WP * 2, lit: .5 }), { seamless: true });
body("slot", "竖条窗", I('<path d="M6 3v18M18 3v18M9 3v18M10 3v18M14 3v18M15 3v18"/>'),
  F.flank("S", true, .004), () => ({ s: "S", rot: true }), { seamless: true });
registerFloor({ id: "column", name: "圆柱塔身", seamless: true, win: { s: "T", round: true }, icon: I('<path d="M7 3v18M17 3v18M10 3v18M14 3v18"/>'),
  build: ({ w, h, seed }) => {
    const r = w / 2, g = new THREE.CylinderGeometry(r, r, h, 32); g.translate(0, h / 2, 0); const p = [];
    for (let i = 0; i < 16; i++) { const a = i / 16 * Math.PI * 2; p.push([Math.cos(a) * (r + .002), 0, Math.sin(a) * (r + .002)], [Math.cos(a) * (r + .002), h, Math.sin(a) * (r + .002)]); }
    return { solid: g, lines: lines(p), autoEdges: false, ringTop: lines(ring(r + .002, h)), ringBottom: lines(ring(r + .002, 0)),
      panes: roundPanes(r, h, { seed, s: "T" }) };
  } });
registerFloor({ id: "podium", name: "裙楼大板", height: .32, win: { s: "T", rot: true }, icon: I('<rect x="3" y="7" width="18" height="12"/><path d="M3 13h18M9 7v12M15 7v12"/><circle cx="12" cy="10" r="1.6"/>'),
  build: ({ w, h, seed }) => {
    return { solid: box(w, h), lines: facade(w, h, F.mullions("T", true)), panes: boxPanes(w, h, { seed, s: "T", rot: true }) };
  } });
registerFloor({ id: "setback", name: "收分层", win: { s: "M", scale: .72 }, icon: I('<rect x="8" y="8" width="8" height="10"/><path d="M5 18h14M10 8v10M12 8v10M14 8v10"/>'),
  build: ({ w, h, seed }) => { const s = w * .72; return { solid: box(s, h), lines: facade(s, h, F.mullions("M")), panes: boxPanes(s, h, { seed, s: "M" }) }; } });
registerFloor({ id: "round", name: "圆形层", win: { s: "M", round: true }, icon: I('<ellipse cx="12" cy="7" rx="6" ry="2"/><path d="M6 7v10a6 2 0 0 0 12 0V7"/><path d="M6 11.5a6 2 0 0 0 12 0"/>'),
  build: ({ w, h, seed }) => {
    const r = w / 2, g = new THREE.CylinderGeometry(r, r, h, 32); g.translate(0, h / 2, 0);
    const p = [...ring(r + .002, 0), ...ring(r + .002, h)];
    for (let i = 0; i < 16; i++) { const a = i / 16 * Math.PI * 2; p.push([Math.cos(a) * (r + .002), 0, Math.sin(a) * (r + .002)], [Math.cos(a) * (r + .002), h, Math.sin(a) * (r + .002)]); }
    return { solid: g, lines: lines(p), autoEdges: false, panes: roundPanes(r, h, { seed, s: "M" }) };
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

/* ---------------- 配色：白天 / 夜晚两套，按城里的时间在两者之间渐变 ---------------- */
function palette(night) {
  if (night) return { tLine: 0x596080, tLow: 0x1d2030, tHigh: 0x343a52, tWall: 0x151722, tPit: 0x171925, gLow: 0x1e2e24, gHigh: 0x2f4a35, water: 0x1b3045, waterFall: 0x24405a, road: 0x272a37, face: 0x22252f, line: 0x7d84a0, ground: 0x1d2030, side: 0x181a26, side2: 0x151721, minor: 0x272b3c, major: 0x333850, sky: 0x9aa0c0, gnd: 0x1a1c28, ambient: 1.6, sun: .6, clear: 0x13141b };
  return { tLine: 0x9a9cad, tLow: 0xfbfbfd, tHigh: 0xb4b7c7, tWall: 0xcfd0dc, tPit: 0xe4e4ec, gLow: 0xd9e8cb, gHigh: 0x9fbb8a, water: 0xcfe3ef, waterFall: 0xb7d2e4, road: 0xebebf0, face: 0xffffff, line: 0x2c2e36, ground: 0xfcfcfd, side: 0xececf2, side2: 0xe1e1ea, minor: 0xececf2, major: 0xdadae4, sky: 0xffffff, gnd: 0xdedeea, ambient: 2.9, sun: .5, clear: 0xf6f6f4 };
}

function blendPalette(t) {
  t = 1 - Math.pow(1 - t, 2.4);                      // 天一擦黑楼体就暗下来，清晨 / 黄昏不会发白
  const a = palette(false), b = palette(true), o = {};
  for (const k in a) o[k] = k === "ambient" || k === "sun" ? a[k] + (b[k] - a[k]) * t : new THREE.Color(a[k]).lerp(new THREE.Color(b[k]), t).getHex();
  return o;
}

/* ---------------- 状态 ----------------
   cells:   "i,j" → [ floor ]，floor = { t,s,v,r, wings:[{d,t,s,v,obj}], obj, h }
   bridges: [ { a:[i,j,k], b:[i,j,k], obj } ] */
const roads = new Set();                                   // 街道："i,j"
const water = new Set(), grass = new Set();                // 河流（地形：河床格 + 水面）、草地（地形表面）
const cells = new Map(), bridges = [], terrain = new Map();   // terrain: "i,j" → 地面高度层数（负 = 坑，正 = 高地）
const hist = [], redoStack = [];
let sel = Object.assign({ t: "grid", s: "M", r: 0 }, (() => { try { return JSON.parse(localStorage.getItem(KEY_SEL)) || {}; } catch (e) { return {}; } })());
if (!FLOORS.has(sel.t) || FLOORS.get(sel.t).hidden) sel.t = "grid";
sel.view = true; sel.tpl = null; sel.decal = null;
if (sel.wsz === "L") sel.wsz = "T"; if (!["S", "M", "T"].includes(sel.wsz)) sel.wsz = "M"; if (sel.wlit == null) sel.wlit = 1;
const decalType = () => sel.decal === "window" ? "win:" + sel.wsz + ":" + (sel.wlit ? 1 : 0) + ":" + (sel.wrot ? 1 : 0) : sel.decal;                // 打开时默认观赏模式（鼠标按钮）
const paneLight = { value: 0 }; let paneVis = null;
let night = false, hover = null, expanded = false, tAnchor = null, drag = null;

/* ---------------- three.js 场景 ---------------- */
let winLineMat, facadeMat, renderer, scene, camera, hemi, sun, faceMat, lineMat, paneMat, ghostFace, ghostLine, hiLine;
let terrainLine, grassMesh, waterMesh, waterLines, roadMat, roadMesh, roadLines, roadEdge, bakeGroup, ground, groundTop, digMask, pitMesh, pitEdges, pitMat, gridMinor, gridMajor, floorsGroup, bridgeGroup, hoverBox, ghost, pivot, linkLine, hitMeshes = [], hiObj = null;
const cam = Object.assign({}, config.homeView), goal = { theta: cam.theta, phi: cam.phi };   // 打开网站时的视角

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
  winLineMat = new THREE.LineBasicMaterial({ color: 0x2c2e36, transparent: true });       // 楼层自带窗的窗框
  paneMat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
  paneMat.onBeforeCompile = sh => {
    sh.uniforms.uLight = paneLight;
    sh.vertexShader = sh.vertexShader.replace("#include <common>", "#include <common>\nattribute float lit;\nvarying float vLit;").replace("#include <begin_vertex>", "#include <begin_vertex>\nvLit = lit;");
    sh.fragmentShader = sh.fragmentShader.replace("#include <common>", "#include <common>\nuniform float uLight;\nvarying float vLit;").replace("void main() {", "void main() {\n  if (vLit > uLight) discard;");
  };
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
  pitMat = new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
  grassMesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
  waterMesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true, side: THREE.DoubleSide }));
  waterLines = new THREE.LineSegments(new THREE.BufferGeometry(), facadeMat);
  scene.add(grassMesh, waterMesh, waterLines);
  pitMesh = new THREE.Mesh(new THREE.BufferGeometry(), pitMat); terrainLine = new THREE.LineBasicMaterial({ color: 0x8d8fa0, transparent: true }); pitEdges = new THREE.LineSegments(new THREE.BufferGeometry(), terrainLine);
  roadMat = new THREE.MeshBasicMaterial({ color: 0xebebf0, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  roadMesh = new THREE.Mesh(new THREE.BufferGeometry(), roadMat); roadLines = new THREE.LineSegments(new THREE.BufferGeometry(), facadeMat);
  roadEdge = new THREE.LineSegments(new THREE.BufferGeometry(), lineMat);
  scene.add(groundTop, pitMesh, pitEdges, roadMesh, roadLines, roadEdge);
  const mi = [], ma = [];
  for (let k = 0; k <= N; k++) { const p = k - HALF, arr = k % 10 === 0 ? ma : mi; arr.push([p, .002, -HALF], [p, .002, HALF], [-HALF, .002, p], [HALF, .002, p]); }
  gridMinor = new THREE.LineSegments(lines(mi), maskLines(new THREE.LineBasicMaterial({ color: 0xececf2, transparent: true }), M));
  gridMajor = new THREE.LineSegments(lines(ma), maskLines(new THREE.LineBasicMaterial({ color: 0xdadae4 }), M));
  scene.add(ground, new THREE.LineSegments(new THREE.EdgesGeometry(gGeo), lineMat), gridMinor, gridMajor);
  floorsGroup = new THREE.Group(); bridgeGroup = new THREE.Group(); bakeGroup = new THREE.Group(); scene.add(floorsGroup, bridgeGroup, bakeGroup);
  initCars();

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
    if (now - (loop.ck || 0) > 500) { loop.ck = now; updateClock(); }
    /* 编辑模式车辆停住，只在操作时重绘 */
    if (host && !document.hidden && (expanded ? sel.view : cityVisible) && now - carLast >= (expanded ? 0 : 50)) { stepCars(Math.min(.1, (now - carLast) / 1000)); carLast = now; }
    if (dirtyCells.size) { dirtyCells.forEach(bakeCell); dirtyCells.clear(); }
    if (fadeDirty) { fadeDirty = false; updateFade(); }
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
  const M = N + 2, data = digMask.image.data, L = config.digLevel, B0 = BASE(), tri = [], col = [], gtri = [], gcol = [], wtri = [], wcol = [], wav = [];
  const p = palette(false), C = h => new THREE.Color(h), cLow = C(p.tLow), cHigh = C(p.tHigh), cWall = C(p.tWall), cPit = C(p.tPit),
    gLow = C(p.gLow), gHigh = C(p.gHigh), cWater = C(p.water), cFall = C(p.waterFall), top = config.raiseMax,
    cUnder = cWall.clone().multiplyScalar(.82), cGrassSide = gHigh.clone().lerp(cWall, .45);
  data.fill(255);
  const quad = (T, Cc, c, a, b, cc, d) => { T.push(...a, ...b, ...cc, ...a, ...cc, ...d); for (let q = 0; q < 6; q++) Cc.push(c.r, c.g, c.b); };
  const NB = (i, j, x0, x1, z0, z1) => [[i + 1, j, x1, z0, x1, z1], [i - 1, j, x0, z1, x0, z0], [i, j + 1, x1, z1, x0, z1], [i, j - 1, x0, z0, x1, z0]];
  const WS = .07;                                                       // 水面比方块顶低一点
  /* 挡住邻格侧面的范围：顶上露天的水块只挡到水面（否则水面和方块顶之间会漏出一条透明缝） */
  const occ = runs => runs.map((r, q) => r.t === "w" && !(runs[q + 1] && runs[q + 1].a === r.b) ? { a: r.a, b: r.b - WS / L, t: r.t } : r);
  const runsAt = (i, j) => occ(inBoard(i, j) ? colOf(K(i, j)) : DEF());
  const minus = (a, b, runs) => { let segs = [[a, b]];                   // [a,b) 去掉邻格方块挡住的部分 = 露出来的侧面
    runs.forEach(r => { segs = segs.flatMap(([x, y]) => r.b <= x || r.a >= y ? [[x, y]] : [[x, Math.max(x, r.a)], [Math.min(y, r.b), y]].filter(([u, v]) => v > u)); }); return segs; };
  cols.forEach((runs, key) => {
    const [i, j] = key.split(",").map(Number), x0 = i - HALF, x1 = x0 + 1, z0 = j - HALF, z1 = z0 + 1;
    const px = ((M - 1 - (j + 1)) * M + (i + 1)) * 4; data[px] = data[px + 1] = data[px + 2] = data[px + 3] = 0;
    const flat = (T, Cc, c, y) => quad(T, Cc, c, [x0, y, z0], [x1, y, z0], [x1, y, z1], [x0, y, z1]);
    if (!runs.length || runs[0].a > B0) flat(tri, col, cPit, B0 * L);                     // 挖到底：坑底
    runs.forEach((r, q) => {
      const up = runs[q + 1], dn = runs[q - 1], y = r.b * L;
      if (!up || up.a > r.b) {                                                             // 顶面
        if (r.t === "w") { flat(wtri, wcol, cWater, y - WS); const o = ((i * 7 + j * 13) % 5) / 10, yw = y - WS + .002;
          wav.push(x0 + .15 + o * .5, yw, z0 + .3, x0 + .45 + o * .5, yw, z0 + .3, x0 + .3 - o * .2, yw, z0 + .72, x0 + .62 - o * .2, yw, z0 + .72); }
        else { flat(tri, col, r.b < 0 ? cPit : cLow.clone().lerp(cHigh, Math.max(0, Math.min(1, r.b / top))), y);
          if (r.t === "g") flat(gtri, gcol, gLow.clone().lerp(gHigh, Math.max(0, Math.min(1, r.b / top))), y + .002); }
      }
      if (r.a > B0 && (!dn || dn.b < r.a)) flat(r.t === "w" ? wtri : tri, r.t === "w" ? wcol : col, r.t === "w" ? cFall : cUnder, r.a * L);   // 悬空的底面
      NB(i, j, x0, x1, z0, z1).forEach(([ni, nj, ax, az, bx, bz]) => {
        minus(r.a, r.b, runsAt(ni, nj)).forEach(([s0, s1]) => {
          const ya = s0 * L, yb = s1 === r.b && r.t === "w" ? s1 * L - WS : s1 * L;
          if (r.t === "w") quad(wtri, wcol, cFall, [ax, ya, az], [bx, ya, bz], [bx, yb, bz], [ax, yb, az]);
          else quad(tri, col, r.t === "g" && s1 === r.b ? cGrassSide : cWall, [ax, ya, az], [bx, ya, bz], [bx, yb, bz], [ax, yb, az]);
        });
      });
    });
    /* 默认地基的邻格（不在 cols 里）朝这格露出来的侧面，例如挖坑的四壁 */
    NB(i, j, x0, x1, z0, z1).forEach(([ni, nj, ax, az, bx, bz]) => {
      if (!inBoard(ni, nj) || cols.has(K(ni, nj))) return;
      minus(B0, 0, occ(runs)).forEach(([s0, s1]) => quad(tri, col, cWall, [bx, s0 * L, bz], [ax, s0 * L, az], [ax, s1 * L, az], [bx, s1 * L, bz]));
    });
  });
  digMask.needsUpdate = true;
  const mk = (T, Cc, normals) => { const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(T, 3)); g.setAttribute("color", new THREE.Float32BufferAttribute(Cc, 3)); if (normals) g.computeVertexNormals(); return g; };
  grassMesh.geometry.dispose(); grassMesh.geometry = mk(gtri, gcol, true);
  waterMesh.geometry.dispose(); waterMesh.geometry = mk(wtri, wcol, false);
  waterLines.geometry.dispose(); { const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(wav, 3)); waterLines.geometry = g; }
  const g = mk(tri, col, true);
  pitMesh.geometry.dispose(); pitMesh.geometry = g;
  pitEdges.geometry.dispose(); pitEdges.geometry = tri.length ? new THREE.EdgesGeometry(g, 30) : new THREE.BufferGeometry();
  carDirty = true; req();
}
function accent() { return getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#0e8fbc"; }
function applyPalette() {
  const p = blendPalette(dark), W = new THREE.Color(0xffffff);
  faceMat.color.setHex(p.face); lineMat.color.setHex(p.line); facadeMat.color.setHex(p.line); winLineMat.color.setHex(p.line);
  groundTop.material.color.setHex(p.ground); roadMat.color.setHex(p.road); terrainLine.color.setHex(p.tLine);
  /* 地形顶点色按白天算一次，入夜时整体乘一层暗色，不必重算 */
  grassMesh.material.color.copy(W).lerp(new THREE.Color(0x2a3048), dark); waterMesh.material.color.copy(grassMesh.material.color);
  pitMat.color.copy(W).lerp(new THREE.Color(0x4a5270), dark);
  [0, 1].forEach(k => ground.material[k].color.setHex(p.side)); [3, 4, 5].forEach(k => ground.material[k].color.setHex(p.side2));
  gridMinor.material.color.setHex(p.minor); gridMajor.material.color.setHex(p.major);
  hemi.color.setHex(p.sky); hemi.groundColor.setHex(p.gnd); hemi.intensity = p.ambient; sun.intensity = p.sun;
  const a = new THREE.Color(accent());
  [hoverBox.material, ghostFace, ghostLine, pivot.children[0].material, linkLine.material].forEach(m => m.color.copy(a));
  renderer.setClearColor(p.clear, 0);                                    // 棋盘外是云海背景图
  paneLight.value = light;
  if (paneVis !== night) { paneVis = night;                               // 白天纯线稿，入夜窗格陆续亮灯
    scene.traverse(o => { if (o.userData.pane) o.visible = night; });
    faded.forEach(k => { const g = baked.get(k); if (g) g.children.forEach(o => { if (o.userData.pane) o.visible = false; }); }); fadeDirty = true; }
  if (carLamps) carLamps.visible = dark > .55;                            // 车灯一次全开
  if (pop) pop.classList.toggle("night", themeNight());
  req();
}
function fadeGrid() {
  const ppc = (host ? host.clientHeight : 300) / (2 * cam.dist * Math.tan(rad(config.fov) / 2));
  gridMinor.material.opacity = Math.max(0, Math.min(1, (ppc - 5) / 10));
  gridMinor.visible = gridMinor.material.opacity > .02;
  facadeMat.opacity = Math.max(0, Math.min(1, (ppc - 4) / 10));          // 拉远时立面细节淡出，只留楼体轮廓
  facadeMat.opacity *= 1 - dark * .6;                                      // 入夜立面线调暗，楼体不发白，亮着的窗更显眼
  facadeMat.visible = facadeMat.opacity > .02;
  winLineMat.opacity = Math.max(0, Math.min(1, (ppc - 9) / 12)) * (1 - dark * .8);   // 窗框比立面线更早淡出，入夜后让位给亮着的窗格
  winLineMat.visible = winLineMat.opacity > .02;
  terrainLine.opacity = Math.max(0, Math.min(1, (ppc - 2) / 8)); terrainLine.visible = terrainLine.opacity > .02;   // 地形台阶线拉远时淡出，远看靠颜色分辨高低
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
  cam.tx = Math.max(-HALF, Math.min(HALF, cam.tx)); cam.tz = Math.max(-HALF, Math.min(HALF, cam.tz));
}
/* 往外缩时回中：越拉远，视野中心允许偏离棋盘中心的范围越小，缩到看全棋盘时正好居中（平移本身不受限） */
function recenterOnZoomOut() {
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
let fadeDirty = false, fadeFace = null, fadeLine = null;
const faded = new Set();
function updateFade() {
  if (!fadeFace) { fadeFace = new THREE.MeshLambertMaterial({ color: 0xffffff, transparent: true, opacity: .1, depthWrite: false, side: THREE.DoubleSide });
    fadeLine = new THREE.LineBasicMaterial({ transparent: true, opacity: .16, depthWrite: false }); }
  fadeFace.color.copy(faceMat.color); fadeLine.color.copy(lineMat.color);
  const close = expanded && cam.dist < config.fadeNear, cp = camera.position, tgt = new THREE.Vector3(cam.tx, 0, cam.tz);
  /* 视线：镜头 → 注视点，以及注视点左右前后偏移的几条；被视线先穿过（挡在注视点前面）的楼要虚化 */
  const side = new THREE.Vector3().subVectors(tgt, cp).cross(new THREE.Vector3(0, 1, 0)).normalize().multiplyScalar(cam.dist * .3);
  const rays = close ? [tgt, tgt.clone().add(side), tgt.clone().sub(side), tgt.clone().add(new THREE.Vector3(0, cam.dist * .15, 0))].map(t => ({ ray: new THREE.Ray(cp.clone(), t.clone().sub(cp).normalize()), len: t.distanceTo(cp) })) : [];
  const hitP = new THREE.Vector3();
  baked.forEach((grp, key) => {
    const b = grp.userData.box, holds = cam.tx >= b.min.x && cam.tx <= b.max.x && cam.tz >= b.min.z && cam.tz <= b.max.z;   // 正在看的这栋不虚化
    const reach = Math.min(config.fadeReach, cam.dist * .75);
    const f = close && !holds && b.distanceToPoint(cp) < reach && (b.distanceToPoint(cp) < Math.max(.6, cam.dist * .25) || rays.some(({ ray, len }) => ray.intersectBox(b, hitP) && hitP.distanceTo(cp) < Math.min(len * .85, reach)));
    if (f === faded.has(key)) return; f ? faded.add(key) : faded.delete(key);
    grp.children.forEach(o => {
      if (o.userData.pane) { o.visible = !f && night; return; }
      if (o.userData.mat0 === undefined) o.userData.mat0 = o.material;
      o.material = f ? (o.isMesh ? fadeFace : fadeLine) : o.userData.mat0;
    });
  });
  req();
}
function updateCamera() { fadeDirty = true;
  clampCam();
  const R = cam.dist, ph = rad(cam.phi), th = rad(cam.theta);
  camera.position.set(cam.tx + R * Math.cos(ph) * Math.sin(th), R * Math.sin(ph), cam.tz + R * Math.cos(ph) * Math.cos(th));
  camera.lookAt(cam.tx, 0, cam.tz);
  const w = host ? host.clientWidth : 300, h = host ? host.clientHeight : 150;
  camera.aspect = w / Math.max(1, h); camera.updateProjectionMatrix();
  moveSky();
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
  if (i < 0 || j < 0 || i >= N || j >= N || roads.has(K(i, j)) || water.has(K(i, j))) return false;
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
  const st = stackOf(i, j); markDirty(i, j);
  const seams = (obj, top, bot) => obj.traverse(o => { if (o.userData.seam === "top") o.visible = top; else if (o.userData.seam === "bottom") o.visible = bot; });
  st.forEach((f, k) => {
    if (FLOORS.get(f.t).seamless) f.obj.children.forEach(o => { if (o.userData.seam === "top") o.visible = !sameLayer(f, st[k + 1]); else if (o.userData.seam === "bottom") o.visible = !sameLayer(f, st[k - 1]); });
    f.wings.forEach(w => { if (!FLOORS.get(w.t).seamless) return;
      const same = g => g && sameLayer(f, g) && g.wings.some(x => x.d === w.d && x.t === w.t && x.s === w.s && (x.u || 0) === (w.u || 0));
      seams(w.obj, !same(st[k + 1]), !same(st[k - 1])); });
  });
  req();
}
/* ---------- 按格合并：一格里所有楼层（含侧翼）合成 实体 / 轮廓线 / 立面线 / 窗格 四个对象来画；
   单层对象保留但不显示，只用于拾取。某格有改动就标脏，下一帧重新合并这一格 ---------- */
const dirtyCells = new Set(), baked = new Map();
function markDirty(i, j) { dirtyCells.add(K(i, j)); req(); }
function litAttr(g) {                                     // 每扇窗（6 个顶点）按位置取一个 0–1 的亮灯阈值
  const p = g.attributes.position.array, n = p.length / 3, a = new Float32Array(n);
  for (let v = 0; v < n; v += 6) { const x = Math.sin(p[v * 3] * 12.9898 + p[v * 3 + 1] * 78.233 + p[v * 3 + 2] * 37.719) * 43758.5453, t = .03 + (x - Math.floor(x)) * .96;
    for (let q = v; q < Math.min(n, v + 6); q++) a[q] = t; }
  g.setAttribute("lit", new THREE.BufferAttribute(a, 1));
}
function bakeCell(key) {
  const old = baked.get(key); if (old) { bakeGroup.remove(old); old.traverse(o => { if (o.geometry) o.geometry.dispose(); }); baked.delete(key); }
  const [i, j] = key.split(",").map(Number), st = stackOf(i, j); if (!st.length) return;
  const B = { solid: [], outline: [], facade: [], winline: [], panes: [] };
  const take = (o, bucket) => { const g = o.geometry.clone(); g.applyMatrix4(o.matrixWorld); B[bucket].push(g); };
  st.forEach(f => {
    f.obj.visible = true; f.obj.updateMatrixWorld(true);
    (function walk(o, root) {
      if (o !== root && !o.visible && !o.userData.pane) return;
      if (o.isMesh && o.material === faceMat) take(o, "solid");
      else if (o.isMesh && o.userData.pane) take(o, "panes");
      else if (o.isLineSegments && (o.material === lineMat || o.userData.prevMat === lineMat)) take(o, "outline");
      else if (o.isLineSegments && (o.material === facadeMat || o.userData.prevMat === facadeMat)) take(o, "facade");
      else if (o.isLineSegments && (o.material === winLineMat || o.userData.prevMat === winLineMat)) take(o, "winline");
      o.children.forEach(c => walk(c, root));
    })(f.obj, f.obj);
    f.obj.visible = false;
  });
  const grp = new THREE.Group(), add = (list, make) => { const g = merge(list); if (g) grp.add(make(g)); };
  add(B.solid, g => new THREE.Mesh(g, faceMat));
  add(B.outline, g => new THREE.LineSegments(g, lineMat));
  add(B.facade, g => new THREE.LineSegments(g, facadeMat));
  add(B.winline, g => new THREE.LineSegments(g, winLineMat));
  add(B.panes, g => { litAttr(g); const m = new THREE.Mesh(g, paneMat); m.userData.pane = true; m.visible = night; return m; });
  grp.userData.box = new THREE.Box3().setFromObject(grp); grp.userData.key = key;
  bakeGroup.add(grp); baked.set(key, grp); fadeDirty = true;
}
/* 贴图几何：在楼层本地坐标的第 d 个面上、沿面位置 u 处，返回 { lines, pane } */
const OLD3 = { W: "T:1", T: "T:0" };                                        // 三段式旧格式：宽窗 / 高窗 → 新尺寸:旋转
const isWin = t => t === "window" || /^win:/.test(t || "");
function winOf(t) {
  let m = /^win:(\w):(\d)(?::(\d))?$/.exec(t || ""); if (!m) return { s: "M", lit: true, rot: false };
  let [s, rot] = m[3] === undefined && OLD3[m[1]] ? OLD3[m[1]].split(":") : m[1] === "L" ? ["T", m[3] === "1" ? "0" : "1"] : [m[1], m[3] || "0"];
  return { s: WIN[s] ? s : "M", lit: m[2] === "1", rot: rot === "1" };
}
function winSize(t, h) { const w = winOf(t); return winDims(w.s, w.rot, h); }
const normDecal = t => { if (!isWin(t)) return t; const w = winOf(t); return "win:" + w.s + ":" + (w.lit ? 1 : 0) + ":" + (w.rot ? 1 : 0); };
function decalGeo(f, d, u, type) {
  const g = floorGeo(f.t, f.s, f.v); if (!g.solid.boundingBox) g.solid.computeBoundingBox();
  const bb = g.solid.boundingBox, [nx, nz] = FACES[d], hn = (nx ? Math.max(-bb.min.x, bb.max.x) : Math.max(-bb.min.z, bb.max.z)) + .005, tx = -nz, tz = nx, h = f.h;
  const P = (uu, y) => [nx * hn + tx * uu, y, nz * hn + tz * uu], L = [], tri = [];
  const rect = (a, b, y0, y1, open) => { L.push(P(a, y0), P(a, y1), P(a, y1), P(b, y1), P(b, y1), P(b, y0)); if (!open) L.push(P(b, y0), P(a, y0)); };
  let pw, y0, y1;
  if (type === "door") { pw = .1; y0 = 0; y1 = Math.min(h * .9, .15);
    rect(u - pw / 2, u + pw / 2, y0, y1, true); rect(u - pw / 2 + .015, u + pw / 2 - .015, y0 + .015, y1 - .015, true);
    L.push(P(u + pw / 2 - .03, y1 * .5), P(u + pw / 2 - .03, y1 * .5 + .02)); }
  else { const [ww, wh] = winSize(type, h); pw = ww; y0 = h * .2; y1 = y0 + wh;            // 窗台对齐在层高 20% 处
    rect(u - pw / 2, u + pw / 2, y0, y1); }
  const q = [P(u - pw / 2, y0), P(u + pw / 2, y0), P(u + pw / 2, y1), P(u - pw / 2, y0), P(u + pw / 2, y1), P(u - pw / 2, y1)], c3 = type === "door" ? [.85, .62, .32] : [1, .82, .42];
  const pos = [], col = []; q.forEach(v => { pos.push(...v); col.push(...c3); });
  const pg = new THREE.BufferGeometry(); pg.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); pg.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  return { lines: lines(L), pane: type === "door" || winOf(type).lit ? pg : null };     // 关灯的窗只有外框
}
function decalU(f, type, u) {
  const g = floorGeo(f.t, f.s, f.v), lim = Math.max(0, g.w / 2 - (type === "door" ? .06 : winSize(type, 1)[0] / 2 + .01));
  const st = WP / 2, m = Math.floor(lim / st + 1e-6) * st;                // 吸附到标准窗格（半个窗距）
  return Math.max(-m, Math.min(m, Math.round((u || 0) / st) * st));
}
function decalObj(f, dc, lmat = lineMat, ghostMat) {
  const g = decalGeo(f, dc.d, dc.u, dc.type), grp = new THREE.Group();
  grp.add(new THREE.LineSegments(g.lines, lmat));
  if (!ghostMat && g.pane) { const pm = new THREE.Mesh(g.pane, paneMat); pm.userData.pane = true; pm.visible = night; grp.add(pm); }
  return grp;
}
function attachDecal(i, j, k, dc) {
  const f = stackOf(i, j)[k]; if (!f) return null; const type = normDecal(dc.type), u = decalU(f, type, dc.u);
  if (f.decals.some(x => x.d === dc.d && isWin(x.type) === isWin(type) && Math.abs(x.u - u) < 1e-6)) return null;
  const rec = { d: dc.d, u, type }; rec.obj = decalObj(f, rec); f.obj.add(rec.obj); f.decals.push(rec); markDirty(i, j); return rec;
}
function detachDecal(i, j, k, d, type, u) {
  const f = stackOf(i, j)[k]; if (!f) return null;
  let n = -1, bd = 1e9; f.decals.forEach((x, q) => { if (x.d === d && (x.type === type || (isWin(x.type) && isWin(type))) && Math.abs(x.u - u) < bd) { bd = Math.abs(x.u - u); n = q; } });
  if (n < 0 || bd > .12) return null;
  const x = f.decals.splice(n, 1)[0]; f.obj.remove(x.obj); x.obj.traverse(o => { if (o.geometry) o.geometry.dispose(); }); markDirty(i, j);
  return { d: x.d, u: x.u, type: x.type };
}
function addDecal(i, j, k, d, u, type) {
  const r = attachDecal(i, j, k, { d, u, type }); if (!r) { emit("blocked", { i, j, k, d }); return false; }
  record({ op: "decal+", i, j, k, dc: { d: r.d, u: r.u, type: r.type } }); changed(); emit("decal", { i, j, k, d, type }); return true;
}
function removeDecal(i, j, k, d, u, type) {
  const r = detachDecal(i, j, k, d, type, u); if (!r) return false;
  record({ op: "decal-", i, j, k, dc: r }); changed(); emit("undecal", { i, j, k, d, type }); return true;
}
/* 楼层自带的一套标准窗（窗框 + 夜里的窗格），与窗户贴图同尺寸同网格 */
const winCache = new Map();
function winGeo(f) {
  const key = f.t + "|" + f.s + "|" + f.v; if (winCache.has(key)) return winCache.get(key);
  const def = FLOORS.get(f.t), sp = def && def.win; if (!sp) return null;
  const g = floorGeo(f.t, f.s, f.v), seed = (f.v || 0) * 7919 + 13, ws = g.w * (sp.scale || 1), out = {};
  if (sp.round) out.panes = roundPanes(g.w / 2, g.h, { seed, s: sp.s, rot: sp.rot });
  else { out.lines = facade(ws, g.h, F.windows(sp.s, sp.rot)); out.panes = boxPanes(ws, g.h, { seed, s: sp.s, rot: sp.rot, step: sp.step, lit: sp.lit }); }
  winCache.set(key, out); return out;
}
function attachWin(f) {
  const g = winGeo(f); if (!g) return false;
  const grp = new THREE.Group(); if (g.lines) grp.add(new THREE.LineSegments(g.lines, winLineMat));
  const pm = new THREE.Mesh(g.panes, paneMat); pm.userData.pane = true; pm.visible = night; grp.add(pm);
  f.obj.add(grp); f.winObj = grp; f.win = 1; return true;
}
function detachWin(f) { if (f.winObj) { f.obj.remove(f.winObj); f.winObj = null; } f.win = 0; }
/* 把某层的整套窗展开成一扇扇窗户贴图（改单扇窗之前调用；圆柱面上的窗没法贴图，直接去掉） */
function winDecals(f) {
  const def = FLOORS.get(f.t), sp = def && def.win; if (!sp || sp.round) return [];
  const g = floorGeo(f.t, f.s, f.v), r = rng((f.v || 0) * 7919 + 13), ws = g.w * (sp.scale || 1), [ww] = winDims(sp.s, sp.rot, g.h), out = [];
  FACES.forEach((_, d) => winCenters(ws, ww, sp.step || winStep(sp.s, sp.rot)).forEach(u => {
    out.push({ d, u, type: "win:" + sp.s + ":" + (r() < (sp.lit ?? .72) ? 1 : 0) + ":" + (sp.rot ? 1 : 0) }); }));
  return out;
}
function expandWin(i, j, k) {
  const f = stackOf(i, j)[k]; if (!f || !f.win) return;
  const decs = winDecals(f); detachWin(f); decs.forEach(dc => attachDecal(i, j, k, dc)); markDirty(i, j);
  record({ op: "winx", i, j, k, decs });
}
function windowAll() {                                   // 给现有的楼都装上窗（已经贴过窗户的层不动）
  cells.forEach((st, key) => { const [i, j] = key.split(",").map(Number);
    st.forEach(f => { if (!f.win && !f.decals.some(x => isWin(x.type)) && attachWin(f)) markDirty(i, j); }); });
}
function addFloor(i, j, f) {
  const st = stackOf(i, j), k = st.length, y = stackTop(i, j), g = floorGeo(f.t, f.s, f.v);
  const obj = meshSet(g, { kind: "floor", i, j, k });
  obj.position.set(i - HALF + .5, y, j - HALF + .5); orient(obj, g.w, f.r, f.z || 1);
  const rec = { t: f.t, s: f.s, v: f.v, r: f.r || 0, z: f.z || 1, h: g.h, obj, wings: [], decals: [], win: 0 };
  floorsGroup.add(obj); obj.updateMatrixWorld(true); st.push(rec); cells.set(K(i, j), st);
  if (f.win) attachWin(rec);
  (f.wings || []).forEach(w => attachWing(i, j, k, w));
  (f.decals || []).forEach(dc => attachDecal(i, j, k, dc));
  refreshSeams(i, j);
  return rec;
}
function popFloor(i, j) {
  const st = cells.get(K(i, j)); if (!st || !st.length) return null;
  const k = st.length - 1, f = st.pop();
  const gone = bridges.filter(b => (b.a[0] === i && b.a[1] === j && b.a[2] === k) || (b.b[0] === i && b.b[1] === j && b.b[2] === k));
  gone.forEach(dropBridge);
  floorsGroup.remove(f.obj); dispose(f.obj);
  if (!st.length) { cells.delete(K(i, j)); markDirty(i, j); } else refreshSeams(i, j);
  return { t: f.t, s: f.s, v: f.v, r: f.r, z: f.z, win: f.win, wings: f.wings.map(w => ({ d: w.d, t: w.t, s: w.s, v: w.v, u: w.u })), decals: f.decals.map(x => ({ d: x.d, u: x.u, type: x.type })), bridges: gone.map(b => ({ a: b.a, b: b.b, t: b.t, v: b.v })) };
}
/* 侧翼：挂在某层的某个面（d=0..3，楼层本地坐标的 +x +z -x -z），随楼层旋转缩放 */
function wingU(parent, t, s, u) {                     // 固定尺寸侧翼沿面方向的位置（吸附、不出面）；其它侧翼居中
  if (!FLOORS.get(t) || !FLOORS.get(t).width) return 0;
  const lim = Math.max(0, floorGeo(parent.t, parent.s, parent.v).w / 2 - floorGeo(t, s, 0).w / 2);
  return Math.max(-lim, Math.min(lim, Math.round((u || 0) * SUB) / SUB));
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
   blocks: [{ x, z, y, t, v, obj }]（世界坐标，x/z 吸附到每格 6×6 子网格的中心，所以 36 块正好铺满一格）；
   落在地面、楼顶或下方方块上，也可贴在方块侧面悬空。点哪个面就贴着哪个面放，不会错位斜搭 */
const blocks = [], SUB = 6;
const bsnap = v => (Math.floor(v * SUB + 1e-6) + .5) / SUB;
const isFixed = t => !!(FLOORS.get(t) && FLOORS.get(t).width);
const blockMode = () => isFixed(sel.t) && !sel.tpl && !sel.decal;
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

/* ---------------- 车辆：从断头路尽头出现，沿街道开到另一条断头路的尽头消失，消失一辆补一辆；
   数量与街道格数成正比。只在城市可见时运动：右下角约 20 帧，展开后满帧，页面在后台时暂停 ---------------- */
const cars = []; let carInter = new Set(), carSeq = 0, carMesh, carLines, carLamps, carDirty = true, carEnds = [], carLast = 0, cityVisible = true;
const CAR = (() => {                                                 // 车身 + 车顶两只盒子，车头朝 +x
  const b1 = new THREE.BoxGeometry(.3, .07, .15); b1.translate(0, .055, 0);
  const b2 = new THREE.BoxGeometry(.15, .055, .12); b2.translate(-.03, .1175, 0);
  const fg = merge([b1, b2]), eg = merge([new THREE.EdgesGeometry(b1), new THREE.EdgesGeometry(b2)]), lamp = [], lc = [];
  [[.151, [1, .9, .55]], [-.151, [1, .28, .22]]].forEach(([x, c]) => [-.045, .045].forEach(z => {
    const P = (a, b) => [x, .055 + b * .018, z + a * .022];
    [P(-1, -1), P(1, -1), P(1, 1), P(-1, -1), P(1, 1), P(-1, 1)].forEach(v => { lamp.push(...v); lc.push(...c); }); }));
  return { face: fg.attributes.position.array, norm: fg.attributes.normal.array, edge: eg.attributes.position.array, lamp: new Float32Array(lamp), lampCol: lc };
})();
function initCars() {
  const M = config.carsMax, dyn = (n, size = 3) => new THREE.BufferAttribute(new Float32Array(n), size).setUsage(THREE.DynamicDrawUsage);
  let g = new THREE.BufferGeometry(); g.setAttribute("position", dyn(CAR.face.length * M)); g.setAttribute("normal", dyn(CAR.norm.length * M));
  carMesh = new THREE.Mesh(g, faceMat);
  g = new THREE.BufferGeometry(); g.setAttribute("position", dyn(CAR.edge.length * M)); carLines = new THREE.LineSegments(g, lineMat);
  g = new THREE.BufferGeometry(); g.setAttribute("position", dyn(CAR.lamp.length * M));
  const col = new Float32Array(CAR.lamp.length * M); for (let q = 0; q < M; q++) col.set(CAR.lampCol, q * CAR.lamp.length); g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  carLamps = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide })); carLamps.visible = false;
  [carMesh, carLines, carLamps].forEach(o => { o.frustumCulled = false; o.geometry.setDrawRange(0, 0); scene.add(o); });
}
function hpush(h, x) { h.push(x); let q = h.length - 1; while (q) { const p = (q - 1) >> 1; if (h[p][0] <= h[q][0]) break; [h[p], h[q]] = [h[q], h[p]]; q = p; } }
function hpop(h) { const top = h[0], last = h.pop(); if (h.length) { h[0] = last; let q = 0; for (;;) { const a = q * 2 + 1, b = a + 1; let m = q;
  if (a < h.length && h[a][0] < h[m][0]) m = a; if (b < h.length && h[b][0] < h[m][0]) m = b; if (m === q) break; [h[m], h[q]] = [h[q], h[m]]; q = m; } } return top; }
/* 从某个尽头出发，边权随机的最短路：每辆车走的路线都不太一样 */
function route(start) {
  const dist = new Map([[start, 0]]), prev = new Map(), heap = [[0, start]];
  while (heap.length) { const [d, k] = hpop(heap); if (d > dist.get(k)) continue;
    roadNb(k).forEach(n => { const nd = d + .5 + Math.random() * 1.5; if (!dist.has(n) || nd < dist.get(n)) { dist.set(n, nd); prev.set(n, k); hpush(heap, [nd, n]); } }); }
  const goals = carEnds.filter(e => e !== start && dist.has(e)); if (!goals.length) return null;
  let k = goals[Math.floor(Math.random() * goals.length)]; const path = [k];
  while (k !== start) { k = prev.get(k); path.push(k); }
  return path.reverse();
}
function lanePoints(path) {                                          // 靠右行驶：车道中心偏到前进方向右侧
  const L = config.digLevel, ij = k => k.split(",").map(Number), dir = (a, b) => { const p = ij(a), q = ij(b); return [q[0] - p[0], q[1] - p[1]]; };
  return path.map((k, q) => {
    const [i, j] = ij(k), a = q > 0 ? dir(path[q - 1], k) : dir(k, path[q + 1]), b = q < path.length - 1 ? dir(k, path[q + 1]) : a;
    const same = a[0] === b[0] && a[1] === b[1], rx = -a[1] - (same ? 0 : b[1]), rz = a[0] + (same ? 0 : b[0]);
    const x = i - HALF + .5 + rx * .2, z = j - HALF + .5 + rz * .2; return [x, surfaceY(x, z) + .003, z];
  });
}
function spawnCar(mid) {
  const start = carEnds[Math.floor(Math.random() * carEnds.length)];
  if (!mid && cars.some(c => c.path[0] === start && c.s < 1.2)) return false;     // 同一路口刚出来一辆，等它开远
  const path = route(start); if (!path || path.length < 3) return false;
  const pts = lanePoints(path), c = { id: ++carSeq, path, pts, len: pts.length - 1, v: 1 + Math.random() * .9, s: 0 };
  if (mid) { c.s = Math.random() * c.len * .95; const p = carPose(c);
    if (cars.some(o => o.p && Math.hypot(o.p.x - p.x, o.p.z - p.z) < .45)) return false; c.p = p; }
  cars.push(c); return true;
}
function stepCars(dt) {
  if (carDirty) { carDirty = false; carEnds = deadEnds(); carInter = new Set([...roads].filter(k => roadNb(k).length >= 3));
    for (let q = cars.length - 1; q >= 0; q--) if (cars[q].path.some(k => !roads.has(k))) cars.splice(q, 1); }
  const want = carEnds.length < 2 ? 0 : Math.min(config.carsMax, Math.round(roads.size / config.carsPer));
  if (cars.length > want) cars.length = want;
  const first = !cars.length;
  for (let n = 0; cars.length < want && n < (first ? want * 3 : 3); n++) spawnCar(first);
  cars.forEach(c => { c.p = carPose(c); });
  /* 网格分桶找邻车：只看前方 0.75 格以内、横向偏差小（同一车道或正在横穿）的车 */
  const grid = new Map(), cellKey = (x, z) => Math.floor(x) + "," + Math.floor(z);
  cars.forEach(c => { const k = cellKey(c.p.x, c.p.z); (grid.get(k) || grid.set(k, []).get(k)).push(c); });
  cars.forEach(c => {
    const { x, z, cs, sn } = c.p; let gap = Infinity; c.block = null;
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) (grid.get(cellKey(x + a, z + b)) || []).forEach(o => {
      if (o === c || o.s < .3) return;                                     // 刚出现的车还在缩放，不挡人
      const dx = o.p.x - x, dz = o.p.z - z, ahead = dx * cs + dz * sn, side = Math.abs(-dx * sn + dz * cs);
      if (ahead > .02 && ahead < .75 && side < .16 && ahead < gap) { gap = ahead; c.block = o; }
    });
    c.gap = gap;
  });
  /* 路口：进路口前要先占住这一格；已被别的车占着（在里面或离得更近）就停在路口外等它过去 */
  const hold = new Map(), appr = [];
  cars.forEach(c => { c.q = Math.round(c.s); const k = c.path[c.q]; if (carInter.has(k) && !hold.has(k)) hold.set(k, c); });
  cars.forEach(c => { for (let q = c.q + 1; q < c.path.length && q - .5 - c.s < .9; q++) if (carInter.has(c.path[q])) { appr.push([q - .5 - c.s, c, c.path[q]]); break; } });
  appr.sort((a, b) => a[0] - b[0]).forEach(([e, c, k]) => { const h = hold.get(k); if (!h) hold.set(k, c); else if (h !== c) c.gap = Math.min(c.gap, e + .16); });
  cars.forEach(c => {
    if (c.block && c.block.block === c && c.id < c.block.id) c.gap = Infinity;     // 互相挡住（路口对角）时编号小的先走
    if (c.wait > 4) c.gap = Infinity;                                              // 堵死超过 4 秒就让它慢慢挤过去
    const want = c.gap === Infinity ? c.v : c.v * Math.max(0, Math.min(1, (c.gap - .36) / .3));
    c.cur = c.cur == null ? want : c.cur + Math.max(-dt * 6, Math.min(dt * 2.5, want - c.cur));   // 刹车快、起步慢
    c.wait = c.cur < .05 ? (c.wait || 0) + dt : Math.max(0, (c.wait || 0) - dt * 2);
  });
  for (let q = cars.length - 1; q >= 0; q--) { const c = cars[q]; c.s += c.cur * dt; if (c.s >= c.len) cars.splice(q, 1); }
  drawCars();
}
/* 车在路上的位置与朝向（路口转弯时车头平滑转向） */
function carPose(c) {
  const s = Math.min(c.len - 1e-6, c.s), a = Math.floor(s), t = s - a, A = c.pts[a], B = c.pts[a + 1];
  const seg = (m) => { const P = c.pts[m], Q = c.pts[m + 1]; return P && Q ? [Q[0] - P[0], Q[2] - P[2]] : null; };
  let [hx, hz] = seg(a); const nx = t > .7 ? seg(a + 1) : t < .3 ? seg(a - 1) : null;
  if (nx) { const w = t > .7 ? (t - .7) / .6 : (.3 - t) / .6; hx += (nx[0] - hx) * w; hz += (nx[1] - hz) * w; }
  const hl = Math.hypot(hx, hz) || 1;
  const x = A[0] + (B[0] - A[0]) * t, z = A[2] + (B[2] - A[2]) * t;
  return { x, y: surfaceY(x, z) + .003, z, cs: hx / hl, sn: hz / hl };
}
let carDrawn = 0;
function drawCars() {
  if (!cars.length && !carDrawn) return; carDrawn = cars.length;
  const fp = carMesh.geometry.attributes.position, fn = carMesh.geometry.attributes.normal, ep = carLines.geometry.attributes.position, lp = carLamps.geometry.attributes.position;
  const put = (src, dst, off, x, y, z, cs, sn, sc, isN) => {
    for (let v = 0; v < src.length; v += 3) { const lx = src[v], ly = src[v + 1], lz = src[v + 2];
      dst[off + v] = (isN ? 0 : x) + (lx * cs - lz * sn) * (isN ? 1 : sc); dst[off + v + 1] = (isN ? 0 : y) + ly * (isN ? 1 : sc); dst[off + v + 2] = (isN ? 0 : z) + (lx * sn + lz * cs) * (isN ? 1 : sc); } };
  cars.forEach((c, q) => {
    const { x, y, z, cs, sn } = carPose(c), sc = Math.max(.01, Math.min(1, c.s / .5, (c.len - c.s) / .5));   // 出现 / 消失时缩放
    put(CAR.face, fp.array, q * CAR.face.length, x, y, z, cs, sn, sc); put(CAR.norm, fn.array, q * CAR.norm.length, 0, 0, 0, cs, sn, 1, true);
    put(CAR.edge, ep.array, q * CAR.edge.length, x, y, z, cs, sn, sc); put(CAR.lamp, lp.array, q * CAR.lamp.length, x, y, z, cs, sn, sc);
  });
  [[carMesh, CAR.face, [fp, fn]], [carLines, CAR.edge, [ep]], [carLamps, CAR.lamp, [lp]]].forEach(([o, src, attrs]) => {
    o.geometry.setDrawRange(0, cars.length * src.length / 3); attrs.forEach(at => { at.needsUpdate = true; }); });
  req();
}

/* ---------------- 编辑操作（都进撤销栈） ---------------- */
let grouping = null;
function group(fn) { grouping = []; try { fn(); } finally { const g = grouping; grouping = null; if (g.length) record({ op: "group", list: g }); } changed(); }
function record(a) { seeded = 0; edited = 1; if (grouping) { grouping.push(a); return; } hist.push(a); redoStack.length = 0; if (hist.length > 2000) hist.splice(0, hist.length - 2000); }
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
/* ---------------- 地形：每格一列方块（土 e / 草 g / 水 w），三种方块逻辑相同：都是填满一格的方块，可叠、可贴侧面、可悬空 ----------------
   cols: "i,j" → [{a,b,t}]（层号区间 [a,b)，自下而上、同类相邻已合并）；没记录的格 = 默认地基 [-digMax, 0) 的土。
   terrain / water / grass 是由 cols 推出的「最上面那块」：顶面高度、是否水面、是否草地（其他代码只读它们） */
const cols = new Map();
const BASE = () => -config.digMax, DEF = () => [{ a: BASE(), b: 0, t: "e" }];
const colOf = k => cols.get(k) || DEF();
const isDef = c => c.length === 1 && c[0].a === BASE() && c[0].b === 0 && c[0].t === "e";
function syncCell(k) {
  const c = colOf(k), top = c[c.length - 1], h = top ? top.b : BASE();
  if (h) terrain.set(k, h); else terrain.delete(k);
  if (top && top.t === "w") water.add(k); else water.delete(k);
  if (top && top.t === "g") grass.add(k); else grass.delete(k);
}
function syncAll() { terrain.clear(); water.clear(); grass.clear(); cols.forEach((c, k) => syncCell(k)); }
function putCol(k, c) {
  c.sort((x, y) => x.a - y.a); const m = [];
  c.forEach(r => { const p = m[m.length - 1]; if (r.b <= r.a) return; if (p && p.b === r.a && p.t === r.t) p.b = r.b; else m.push({ a: r.a, b: r.b, t: r.t }); });
  if (isDef(m)) cols.delete(k); else cols.set(k, m); syncCell(k);
}
function typeAt(i, j, lv) { const r = colOf(K(i, j)).find(r => lv >= r.a && lv < r.b); return r ? r.t : null; }
function setVox(i, j, lv, t) {                           // 把第 lv 层设成 t（null = 挖空）
  const k = K(i, j), out = [];
  colOf(k).forEach(r => { if (lv < r.a || lv >= r.b) { out.push({ ...r }); return; }
    if (r.a < lv) out.push({ a: r.a, b: lv, t: r.t }); if (lv + 1 < r.b) out.push({ a: lv + 1, b: r.b, t: r.t }); });
  if (t) out.push({ a: lv, b: lv + 1, t }); putCol(k, out);
}
function terrainChanged() { rebuildTerrain(); if (roadMesh) rebuildRoads(); }
/* 加 / 删一块（进撤销栈）。楼所在的格子不能在楼身范围里加块，也不能挖掉楼脚下那块 */
function addVox(i, j, lv, t = "e") {
  if (!inBoard(i, j) || lv < BASE() || lv >= config.raiseMax || typeAt(i, j, lv) || (stackOf(i, j).length && lv >= levelOf(i, j))) { emit("blocked", { i, j }); return false; }
  setVox(i, j, lv, t); terrainChanged(); record({ op: "vox", i, j, lv, t, add: 1 }); changed(); emit("terrain", { i, j, lv, t }); return true;
}
function delVox(i, j, lv) {
  const t = inBoard(i, j) ? typeAt(i, j, lv) : null;
  if (!t || (stackOf(i, j).length && lv === levelOf(i, j) - 1)) { emit("blocked", { i, j }); return false; }
  setVox(i, j, lv, null); terrainChanged(); record({ op: "vox", i, j, lv, t, add: 0 }); changed(); emit("terrain", { i, j, lv }); return true;
}
/* 旧格式（高度 + 水面 + 草地）→ 方块列：水 = 河床上一块水，草 = 最上面一块草 */
function colsFromMaps(T, W, G) {
  const out = new Map(), B0 = BASE();
  new Set([...T.keys(), ...W, ...G]).forEach(k => {
    const h = Math.max(B0, Math.min(config.raiseMax, T.get(k) || 0)), c = [];
    if (W.has(k)) { if (h > B0) c.push({ a: B0, b: h, t: "e" }); c.push({ a: h, b: h + 1, t: "w" }); }
    else if (G.has(k) && h > B0) { if (h - 1 > B0) c.push({ a: B0, b: h - 1, t: "e" }); c.push({ a: h - 1, b: h, t: "g" }); }
    else if (h > B0) c.push({ a: B0, b: h, t: "e" });
    if (!isDef(c)) out.set(k, c);
  });
  return out;
}
/* 选中的面 → 要加块的位置 / 要删的那块 */
function terrainTarget(h) {
  if (!h || h.kind !== "top" || h.i == null || h.k != null) return null;
  if (h.ter === "side") return { i: h.front[0], j: h.front[1], lv: h.lv };
  if (h.ter === "bottom") return { i: h.i, j: h.j, lv: h.lv - 1 };
  return { i: h.i, j: h.j, lv: h.ter === "top" ? h.lv : levelOf(h.i, h.j) };
}
function terrainBlock(h) {
  if (!h || h.kind !== "top" || h.i == null || h.k != null) return null;
  if (h.ter === "side" || h.ter === "bottom") return { i: h.i, j: h.j, lv: h.lv };
  return { i: h.i, j: h.j, lv: (h.ter === "top" ? h.lv : levelOf(h.i, h.j)) - 1 };
}
/* 街道：路面一格一块；只在不接路的一侧画路缘线；直行路段画中线虚线，路口不画 */
function rebuildRoads() {
  computeBridges(); computeRamps();
  const tri = [], mark = [], edge = [], L = config.digLevel, E = .003, TH = .05;
  const quad = (a, b, c, d) => tri.push(...a, ...b, ...c, ...a, ...c, ...d);
  roads.forEach(key => {
    const [i, j] = key.split(",").map(Number), x0 = i - HALF, z0 = j - HALF, P = (u, v, dy = E) => [x0 + u, roadY(i, j, u, v) + dy, z0 + v];
    const ground = levelOf(i, j) * L, bridge = bridgeLv.has(key), r = rampOf.get(key);
    /* 路面：斜坡分两段画，平路一块 */
    if (r && r.x) { quad(P(0, 0), P(0, 1), P(.5, 1), P(.5, 0)); quad(P(.5, 0), P(.5, 1), P(1, 1), P(1, 0)); }
    else if (r) { quad(P(0, 0), P(0, .5), P(1, .5), P(1, 0)); quad(P(0, .5), P(0, 1), P(1, 1), P(1, .5)); }
    else quad(P(0, 0), P(0, 1), P(1, 1), P(1, 0));
    const nb = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([a, b]) => linked(i, j, i + a, j + b));
    const sides = [[[1, 0], [1, 1]], [[0, 0], [0, 1]], [[0, 1], [1, 1]], [[0, 0], [1, 0]]];
    nb.forEach((on, q) => {
      if (on) return; const [[ua, va], [ub, vb]] = sides[q], um = (ua + ub) / 2, vm = (va + vb) / 2;
      [[ua, va, um, vm], [um, vm, ub, vb]].forEach(([u0, v0, u1, v1]) => {
        edge.push(...P(u0, v0, E + .004), ...P(u1, v1, E + .004));     // 边线略高于路面，斜坡上不会被路面盖住
        if (bridge) {                                     // 桥：桥面侧板
          quad(P(u0, v0), P(u1, v1), P(u1, v1, -TH), P(u0, v0, -TH)); edge.push(...P(u0, v0, -TH), ...P(u1, v1, -TH));
        } else if (r) {                                   // 斜坡：侧面封到地面，并描出底边与竖边
          const a = P(u0, v0), b = P(u1, v1);
          if (a[1] - E > ground + 1e-4 || b[1] - E > ground + 1e-4) {
            quad(a, b, [b[0], ground, b[2]], [a[0], ground, a[2]]);
            edge.push(a[0], ground + .004, a[2], b[0], ground + .004, b[2]);
            [a, b].forEach(p => { if (p[1] - E > ground + 1e-4) edge.push(p[0], ground, p[2], p[0], p[1] + .004, p[2]); });
          }
        }
      });
    });
    if (bridge) quad(P(0, 0, -TH), P(1, 0, -TH), P(1, 1, -TH), P(0, 1, -TH));   // 桥底
    const cnt = nb.filter(Boolean).length;
    if (cnt && cnt <= 2) [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(([a, b], q) => { if (!nb[q]) return;
      [[.08, .22], [.32, .46]].forEach(([w0, w1]) => mark.push(...P(.5 + a * w0, .5 + b * w0), ...P(.5 + a * w1, .5 + b * w1))); });
  });
  const set = (obj, arr) => { obj.geometry.dispose(); const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(arr, 3)); obj.geometry = g; };
  set(roadMesh, tri); set(roadLines, mark); set(roadEdge, edge); carDirty = true; req();
}
function addRoad(i, j) {
  if (!inBoard(i, j) || roads.has(K(i, j)) || stackOf(i, j).length) { emit("blocked", { i, j }); return false; }
  roads.add(K(i, j)); rebuildRoads(); record({ op: "road+", i, j }); changed(); emit("road", { i, j }); return true;
}
function removeRoad(i, j) {
  if (!roads.delete(K(i, j))) return false; rebuildRoads(); record({ op: "road-", i, j }); changed(); emit("unroad", { i, j }); return true;
}
const inBoard = (i, j) => i >= 0 && j >= 0 && i < N && j < N;
/* 路面高度（层）：过河的路是桥，桥面比两岸高一层、比河床至少高两层，桥下看得到河；
   相邻两格路面只要高度不同，低的那格就做成斜坡接上去（车可以开） */
const RAMP = Infinity, bridgeLv = new Map(), rampOf = new Map();
const roadLevel = (i, j) => { const k = K(i, j); return bridgeLv.has(k) ? bridgeLv.get(k) : levelOf(i, j); };
const linked = (i, j, a, b) => roads.has(K(a, b)) && Math.abs(roadLevel(a, b) - roadLevel(i, j)) <= RAMP;
function roadNb(k) {
  const [i, j] = k.split(",").map(Number), out = [];
  FACES.forEach(([a, b]) => { if (linked(i, j, i + a, j + b)) out.push(K(i + a, j + b)); });
  return out;
}
function computeBridges() {
  bridgeLv.clear();
  roads.forEach(k => {
    if (!water.has(k) || bridgeLv.has(k)) return;
    const [i, j] = k.split(",").map(Number), ax = roads.has(K(i + 1, j)) || roads.has(K(i - 1, j)) ? [1, 0] : [0, 1];
    const run = [k], banks = []; let bed = levelOf(i, j);
    [1, -1].forEach(sg => { for (let q = 1; q < N; q++) {
      const a = i + ax[0] * sg * q, b = j + ax[1] * sg * q, kk = K(a, b);
      if (!roads.has(kk) || !water.has(kk)) { banks.push(levelOf(a, b)); break; }
      run.push(kk); bed = Math.max(bed, levelOf(a, b)); } });
    const deck = Math.max(...banks.map(v => v + 1), bed + 1);          // bed = 水面（最上那块水的顶）
    run.forEach(x => bridgeLv.set(x, deck));
  });
}
/* 斜坡：只做在低的那格上，从远端（本格高度）升到与高邻格相接的一边；两头都高时中间低 */
function computeRamps() {
  rampOf.clear();
  roads.forEach(k => {
    const [i, j] = k.split(",").map(Number), c = roadLevel(i, j);
    const up = (a, b) => linked(i, j, a, b) && roadLevel(a, b) > c ? roadLevel(a, b) : c;
    const xa = up(i - 1, j), xb = up(i + 1, j), za = up(i, j - 1), zb = up(i, j + 1);
    if (xa > c || xb > c) rampOf.set(k, { x: true, a: xa, b: xb, c });
    else if (za > c || zb > c) rampOf.set(k, { x: false, a: za, b: zb, c });
  });
}
/* 格内某点（u,v ∈ 0..1）的路面高度（世界单位） */
function roadY(i, j, u, v) {
  const L = config.digLevel, r = rampOf.get(K(i, j)); if (!r) return roadLevel(i, j) * L;
  const t = r.x ? u : v, lerp = (p, q, w) => (p + (q - p) * w) * L;
  return r.a > r.c && r.b > r.c ? (t < .5 ? lerp(r.a, r.c, t * 2) : lerp(r.c, r.b, t * 2 - 1)) : lerp(r.a, r.b, t);
}
function surfaceY(x, z) { const i = Math.floor(x + HALF), j = Math.floor(z + HALF); return roadY(i, j, x + HALF - i, z + HALF - j); }
const deadEnds = () => [...roads].filter(k => roadNb(k).length === 1);
/* 断头路：路网外圈每边挑几条通到边上的路，继续向外延伸若干格（平地、无楼无水、不贴着别的路），车从这些尽头出入 */
function addSpurs(seed, per = 3) {
  if (!roads.size) return 0;
  const r = rng(seed + 11); let i0 = Infinity, i1 = -Infinity, j0 = Infinity, j1 = -Infinity, n = 0;
  roads.forEach(k => { const [i, j] = k.split(",").map(Number); i0 = Math.min(i0, i); i1 = Math.max(i1, i); j0 = Math.min(j0, j); j1 = Math.max(j1, j); });
  [[0, -1], [0, 1], [-1, 0], [1, 0]].forEach(([di, dj]) => {
    const cand = [];
    roads.forEach(k => { const [i, j] = k.split(",").map(Number), u = dj ? i : j;
      const edge = dj < 0 ? j === j0 : dj > 0 ? j === j1 : di < 0 ? i === i0 : i === i1;
      if (edge && roads.has(K(i - di, j - dj)) && u !== (dj ? i0 : j0) && u !== (dj ? i1 : j1)) cand.push([i, j, r()]); });
    cand.sort((a, b) => a[2] - b[2]);
    const picked = [];
    cand.forEach(([i, j]) => {
      const u = dj ? i : j; if (picked.length >= per || picked.some(p => Math.abs(p - u) < 10)) return;
      const len = 6 + Math.floor(r() * 9), add = [];
      for (let q = 1; q <= len; q++) {
        const a = i + di * q, b = j + dj * q, k = K(a, b);
        if (!inBoard(a, b) || stackOf(a, b).length || levelOf(a, b) || water.has(k) || roads.has(k) || roads.has(K(a + dj, b + di)) || roads.has(K(a - dj, b - di))) break;
        add.push(k);
      }
      if (add.length >= 3) { add.forEach(k => roads.add(k)); picked.push(u); n++; }
    });
  });
  if (n) rebuildRoads();
  return n;
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
    const e = Math.pow(1 - d / band, 1.25), nz = n1(i, j) * .7 + n2(i, j) * .3;
    const h = Math.round(e * 130 + (nz - .5) * 110 * e + Math.max(0, nz - .6) * 260 * e - (d > band * .6 && nz < .3 ? 2 : 0));
    const hc = Math.max(-config.digMax, Math.min(config.raiseMax, h)); if (hc) out.push([i, j, hc]);
  }
  return out;
}
/* 河流：北边山谷发源，沿切出的山谷一级级下降，进城后沿一条南北向街道（替代那条路）穿城，再穿南边山谷流出 */
function genRiver(T, seed) {
  const r = rng(seed + 7), c = HALF, out = new Map(), L = (i, j) => T.get(K(i, j)) || 0;
  const pts = [[c + 40, 0], [c + 34, 16], [c + 24, 34], [c + 17, 52], [c + 13, c - 30], [c + 13, c + 30], [c + 18, c + 46], [c + 26, N - 36], [c + 16, N - 18], [c + 20, N - 1]];
  const cityIn = 4, cityOut = 5, samples = []; let len = 0, sIn = 0;
  for (let q = 0; q < pts.length - 1; q++) {
    const [ax, az] = pts[q], [bx, bz] = pts[q + 1], seg = Math.hypot(bx - ax, bz - az), n = Math.ceil(seg / .35), city = q === cityIn;
    if (q === cityIn) sIn = len;
    for (let k = 0; k < n; k++) { const t = k / n, wob = city ? 0 : Math.sin((len + seg * t) * .23 + r() * .3) * 1.6;
      samples.push([ax + (bx - ax) * t + wob * (bz - az) / seg, az + (bz - az) * t - wob * (bx - ax) / seg, len + seg * t]); }
    len += seg;
  }
  const src = 90;
  samples.forEach(([x, z, sl]) => {
    const lvl = sl < sIn ? Math.round(src + (-1 - src) * (sl / sIn)) || -1 : -1;
    for (let i = Math.floor(x - 2); i <= Math.ceil(x + 2); i++) for (let j = Math.floor(z - 2); j <= Math.ceil(z + 2); j++) {
      if (!inBoard(i, j) || Math.hypot(i + .5 - x, j + .5 - z) > 1.05) continue;
      const k = K(i, j); out.set(k, Math.min(out.has(k) ? out.get(k) : 99, lvl));
    }
  });
  out.forEach((lvl, k) => T.set(k, lvl));
  /* 切山谷：河两侧的山按离河距离逐级抬起，不会比河高出太多 */
  out.forEach((lvl, k) => { const [i, j] = k.split(",").map(Number);
    for (let a = -12; a <= 12; a++) for (let b = -12; b <= 12; b++) { const kk = K(i + a, j + b); if (out.has(kk) || !inBoard(i + a, j + b)) continue;
      const lim = Math.max(lvl, 0) + 1 + Math.max(Math.abs(a), Math.abs(b)) * 7, cur = L(i + a, j + b); if (cur > lim) T.set(kk, lim); } });
  return out;
}
function fill(i, j) { return addVox(i, j, levelOf(i, j), "e"); }        // 顶上加一块土
function dig(i, j) { return delVox(i, j, levelOf(i, j) - 1); }           // 删掉最上面一块
function genWorld(seed) {
  const T = new Map(genTerrain(seed).map(([i, j, h]) => [K(i, j), h])), river = genRiver(T, seed);
  return { terrain: [...T].filter(([, h]) => h).map(([k, h]) => [...k.split(",").map(Number), h]), water: [...river.keys()],
    grass: [...T].filter(([k, h]) => h > 0 && !river.has(k)).map(([k]) => k) };
}
function setWorld(w) {
  cols.clear(); colsFromMaps(new Map(w.terrain.map(([i, j, h]) => [K(i, j), h])), new Set(w.water), new Set(w.grass)).forEach((c, k) => cols.set(k, c));
  syncAll(); rebuildTerrain(); if (roadMesh) rebuildRoads();
}
function addGrass(i, j) { return addVox(i, j, levelOf(i, j), "g"); }
function addWater(i, j) { return addVox(i, j, levelOf(i, j), "w"); }
function removeGrass(i, j) { return grass.has(K(i, j)) && dig(i, j); }
function removeWater(i, j) { return water.has(K(i, j)) && dig(i, j); }
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
  else if (a.op === "winx") { const f = stackOf(a.i, a.j)[a.k]; if (f) { if (inverse) { a.decs.forEach(dc => detachDecal(a.i, a.j, a.k, dc.d, dc.type, dc.u)); attachWin(f); } else { detachWin(f); a.decs.forEach(dc => attachDecal(a.i, a.j, a.k, dc)); } markDirty(a.i, a.j); } }
  else if (a.op === "vox") { setVox(a.i, a.j, a.lv, (a.add ? !inverse : inverse) ? a.t : null); terrainChanged(); }
  else if (a.op === "road+" || a.op === "road-") { if ((a.op === "road+") !== inverse) roads.add(K(a.i, a.j)); else roads.delete(K(a.i, a.j)); rebuildRoads(); }
  else if (a.op === "decal+" || a.op === "decal-") { if ((a.op === "decal+") !== inverse) attachDecal(a.i, a.j, a.k, a.dc); else detachDecal(a.i, a.j, a.k, a.dc.d, a.dc.type, a.dc.u); }
  else if (a.op === "block+" || a.op === "block-") { if ((a.op === "block+") !== inverse) addBlockObj(a.b); else { const b = findBlock(a.b); if (b) dropBlock(b); } }
  else if (a.op === "group") { (inverse ? [...a.list].reverse() : a.list).forEach(x => apply(x, inverse)); }
  else if (a.op === "link+" || a.op === "link-") { if (linkAdd) addBridge(a.a, a.b, a.t, a.v); else { const r = findBridge(a.a, a.b); if (r) dropBridge(r); } }
  return add;
}
function undo() { const a = hist.pop(); if (!a) return false; apply(a, true); redoStack.push(a); changed(); emit("undo", a); return true; }
function redo() { const a = redoStack.pop(); if (!a) return false; apply(a, false); hist.push(a); changed(); emit("redo", a); return true; }
function clearCity() {
  [...bridges].forEach(dropBridge); [...blocks].forEach(dropBlock); cols.clear(); terrain.clear(); roads.clear(); water.clear(); grass.clear(); if (roadMesh) rebuildRoads();
  baked.forEach(g => { bakeGroup && bakeGroup.remove(g); g.traverse(o => { if (o.geometry) o.geometry.dispose(); }); }); baked.clear(); dirtyCells.clear(); if (pitMesh) rebuildTerrain();
  [...cells.keys()].forEach(k => { const [i, j] = k.split(",").map(Number); while (popFloor(i, j)); });
  hist.length = 0; redoStack.length = 0; changed();
}
let saveT = 0;
function changed() { updateGhost(); req(); clearTimeout(saveT); saveT = setTimeout(save, 300); emit("change"); }
function exportJSON() {
  const out = [];
  cells.forEach((st, k) => { const [i, j] = k.split(",").map(Number);
    out.push([i, j, st.map(f => [f.t, f.s, f.v, f.r || 0, f.wings.map(w => [w.d, w.t, w.s, w.v, w.u || 0]), f.z || 1, f.decals.map(x => [x.d, x.u, x.type]), f.win ? 1 : 0])]); });
  const B = baseWorld(WORLD_SEED).cols, cd = [], ser = c => c.map(r => r.a + ":" + r.b + ":" + r.t).join("|");
  new Set([...cols.keys(), ...B.keys()]).forEach(k => { const a = cols.get(k) || DEF(); if (ser(a) !== ser(B.get(k) || DEF())) cd.push([...k.split(",").map(Number), a.flatMap(r => [r.a, r.b, r.t])]); });
  return { v: 7, world: WORLD_SEED, wv, edited, stamp, cells: out, bridges: bridges.map(b => [...b.a, ...b.b, b.t, b.v]), cdiff: cd, seeded, roads: [...roads].map(k => k.split(",").map(Number)), blocks: blocks.map(b => [b.x, b.z, b.y, b.t, b.v]) };
}
function importJSON(d) {
  clearCity();
  if (d && d.cdiff) {                                                                 // v7：方块列（生成世界 + 差异）
    baseWorld(d.world).cols.forEach((c, k) => cols.set(k, c.map(r => ({ ...r }))));
    d.cdiff.forEach(([i, j, fl]) => { const c = []; for (let q = 0; q < fl.length; q += 3) c.push({ a: fl[q], b: fl[q + 1], t: fl[q + 2] }); putCol(K(i, j), c); });
  } else {                                                                            // 旧格式：高度 + 水面 + 草地
    const T = new Map(), W = new Set(), G = new Set();
    if (d && d.world != null) {
      const B = baseWorld(d.world); B.T.forEach((h, k) => T.set(k, h)); B.water.forEach(k => W.add(k)); B.grass.forEach(k => G.add(k));
      (d.tdiff || []).forEach(([i, j, h]) => { if (h) T.set(K(i, j), h); else T.delete(K(i, j)); });
      (d.wadd || []).forEach(k => W.add(k)); (d.wdel || []).forEach(k => W.delete(k)); (d.gadd || []).forEach(k => G.add(k)); (d.gdel || []).forEach(k => G.delete(k));
    } else { ((d && d.terrain) || []).forEach(([i, j, h]) => { if (h) T.set(K(i, j), h); }); ((d && d.water) || []).forEach(k => W.add(k)); ((d && d.grass) || []).forEach(k => G.add(k)); }
    colsFromMaps(T, W, G).forEach((c, k) => cols.set(k, c));
  }
  syncAll(); if (pitMesh) rebuildTerrain();
  seeded = (d && d.seeded) || 0; wv = (d && d.wv) || 0; stamp = (d && d.stamp) || 0;
  edited = d && d.edited != null ? d.edited : (d && d.seeded ? 0 : 1);               // 旧存档：不是默认城区就算改动过
  ((d && d.roads) || []).forEach(([i, j]) => roads.add(K(i, j))); if (roadMesh) rebuildRoads();
  ((d && d.cells) || []).forEach(([i, j, st]) => st.forEach(([t, s, v, r, ws, z, dcs, win]) => {
    if (FLOORS.has(t) && SIZES[s] && canPlace(i, j)) addFloor(i, j, { t, s, v, r: r || 0, z: z || 1, win, decals: (dcs || []).map(([d2, u2, ty]) => ({ d: d2, u: u2, type: ty })), wings: (ws || []).filter(w => FLOORS.has(w[1])).map(([d2, t2, s2, v2, u2]) => ({ d: d2, t: t2, s: s2, v: v2, u: u2 || 0 })) }); }));
  ((d && d.bridges) || []).forEach(b => addBridge(b.slice(0, 3), b.slice(3, 6), b[6] || "shaft", b[7] || 0));
  ((d && d.blocks) || []).forEach(([x, z, y, t, v]) => { if (isFixed(t)) addBlockObj({ x, z, y, t, v }); });
  hist.length = 0; changed();
}
/* 生成的世界（同一种子结果固定）缓存起来，存档只记与它的差异 */
const WORLD_SEED = 20261007, WORLD_VER = 4, worldCache = new Map();
let wv = 0, edited = 0, stamp = 0;
function baseWorld(seed) {
  if (!worldCache.has(seed)) { const w = genWorld(seed), T = new Map(w.terrain.map(([i, j, h]) => [K(i, j), h])), W = new Set(w.water), G = new Set(w.grass);
    worldCache.set(seed, { T, water: W, grass: G, cols: colsFromMaps(T, W, G) }); }
  return worldCache.get(seed);
}
/* 旧城市换上新版世界：边缘山体、河流、草地按新生成的来；有楼 / 有路的格子保持原高度，
   河道经过的格子上的楼移走让河贯通（路保留，成桥）；路网没有断头路时补几条 */
function migrateWorld() {
  const B = baseWorld(WORLD_SEED), band = config.terrainBand, built = new Set([...cells.keys(), ...roads]);
  const cellOfBlock = b => K(Math.floor(b.x + HALF), Math.floor(b.z + HALF));
  blocks.forEach(b => built.add(cellOfBlock(b)));
  B.water.forEach(k => { const [i, j] = k.split(",").map(Number); while (popFloor(i, j)); blocks.filter(b => cellOfBlock(b) === k).forEach(dropBlock); });
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    const k = K(i, j), d = Math.min(i, j, N - 1 - i, N - 1 - j);
    if (B.water.has(k) || (!built.has(k) && (d < band || B.cols.has(k)))) { const c = B.cols.get(k); if (c) cols.set(k, c.map(r => ({ ...r }))); else cols.delete(k); }
  }
  syncAll(); rebuildTerrain(); rebuildRoads(); wv = 2;
  if (deadEnds().length < 2) addSpurs(WORLD_SEED);
  hist.length = 0; redoStack.length = 0; changed();
}
/* 河面上只留横跨河的桥：沿着河走的路（两头 8 格内到不了岸）删掉 */
function trimRiverRoads() {
  const cross = new Set();
  roads.forEach(k => { if (!water.has(k)) return; const [i, j] = k.split(",").map(Number);
    [[1, 0], [0, 1]].forEach(([dx, dz]) => { const run = [k]; let ok = 0;
      [1, -1].forEach(sg => { for (let q = 1; q <= 8; q++) { const kk = K(i + dx * sg * q, j + dz * sg * q); if (!roads.has(kk)) break; if (!water.has(kk)) { ok++; break; } run.push(kk); } });
      if (ok === 2) run.forEach(x => cross.add(x)); }); });
  let n = 0; [...roads].forEach(k => { if (water.has(k) && !cross.has(k)) { roads.delete(k); n++; } });
  if (n && roadMesh) rebuildRoads(); return n;
}
function save() { try { localStorage.setItem(KEY_CITY, JSON.stringify(exportJSON())); } catch (e) { } }

/* ---------------- 拾取：顶面 / 侧面 / 侧翼 / 连廊 / 地面 ---------------- */
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
function setRay(ev) { const r = renderer.domElement.getBoundingClientRect(); ndc.set((ev.clientX - r.left) / r.width * 2 - 1, -(ev.clientY - r.top) / r.height * 2 + 1); ray.setFromCamera(ndc, camera); }
function pick(ev) {
  setRay(ev);
  const terr = pitMesh ? [pitMesh, grassMesh, waterMesh] : [];
  const hit = ray.intersectObjects([...hitMeshes, ...terr], false)
    .find(h => { const u = h.object.userData; return !(u && u.i != null && faded.has(K(u.i, u.j))); });
  if (hit && terr.includes(hit.object)) {
    const L = config.digLevel, dir = ray.ray.direction, P = hit.point;
    if (Math.abs(hit.face.normal.y) > .5) {                                  // 水平面：从上往下看是顶面，从下往上是底面
      const i = Math.floor(P.x + HALF), j = Math.floor(P.z + HALF), topFace = dir.y < 0;
      return inBoard(i, j) ? { kind: "top", ter: topFace ? "top" : "bottom", i, j, lv: topFace ? Math.round(P.y / L + .4) : Math.round(P.y / L), p: P.clone() } : null;
    }
    const a = P.clone().addScaledVector(dir, .01), b = P.clone().addScaledVector(dir, -.01), i = Math.floor(a.x + HALF), j = Math.floor(a.z + HALF);
    return inBoard(i, j) ? { kind: "top", ter: "side", i, j, lv: Math.floor(P.y / L + 1e-6), front: [Math.floor(b.x + HALF), Math.floor(b.z + HALF)], p: P.clone() } : null;
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
  const key = x => x ? [x.kind, x.i, x.j, x.k, x.d, x.ter, x.lv, x.front, sel.decal && x.u != null ? Math.round(x.u / .04) : "", x.ref && (bridges.indexOf(x.ref) + "/" + blocks.indexOf(x.ref)), x.n, blockMode() ? [x.u, x.p && bsnap(x.p.x), x.p && bsnap(x.p.z)] : ""].join() : "";
  if (key(h) === key(hover)) return; hover = h; updateGhost(); emit("hover", hover);
}
let hiOverlay = null;
function highlight(obj) {
  if (hiObj === obj) return;
  if (hiOverlay) { scene.remove(hiOverlay); hiOverlay.geometry.dispose(); hiOverlay = null; }
  hiObj = obj; if (!obj) return;
  obj.updateMatrixWorld(true); const list = [];
  obj.traverse(o => { if (o.isLineSegments) { const g = o.geometry.clone(); g.applyMatrix4(o.matrixWorld); list.push(g); } });
  const g = merge(list); if (g) { hiOverlay = new THREE.LineSegments(g, hiLine); scene.add(hiOverlay); }
}
function updateGhost() {
  if (!scene) return;
  ghost.clear(); if (ghost.parent !== scene) { ghost.parent && ghost.parent.remove(ghost); scene.add(ghost); }
  ghost.position.set(0, 0, 0); ghost.quaternion.identity(); ghost.scale.set(1, 1, 1);
  hoverBox.visible = false; ghost.visible = false; highlight(null);
  if (!hover) return req();
  if (hover.kind === "bridge") { highlight(hover.ref.obj); return req(); }
  if (hover.kind === "wing") { const f = stackOf(hover.i, hover.j)[hover.k], w = f && f.wings.find(x => x.d === hover.d && Math.abs((x.u || 0) - hover.u) < 1e-6); if (w) highlight(w.obj); return req(); }
  if (sel.decal) {                                                  // 贴图模式
    if (sel.decal === "grass" || sel.decal === "water" || sel.decal === "earth") { const t = terrainTarget(hover);
      if (t) { const ok = inBoard(t.i, t.j) && !typeAt(t.i, t.j, t.lv) && t.lv < config.raiseMax && !(stackOf(t.i, t.j).length && t.lv >= levelOf(t.i, t.j));
        hoverBox.position.set(t.i - HALF + .5, (t.lv + 1) * config.digLevel + .006, t.j - HALF + .5); hoverBox.material.color.set(ok ? accent() : "#c0344d"); hoverBox.visible = true; } }
    else if (sel.decal === "street") { if (hover.kind === "top" && hover.i != null) { const k = K(hover.i, hover.j), ok = !roads.has(k) && !stackOf(hover.i, hover.j).length;
      hoverBox.position.set(hover.i - HALF + .5, stackTop(hover.i, hover.j) + .006, hover.j - HALF + .5); hoverBox.material.color.set(ok ? accent() : "#c0344d"); hoverBox.visible = true; } }
    else if (hover.kind === "side") { const f = stackOf(hover.i, hover.j)[hover.k];
      if (f) { ghost.add(decalObj(f, { d: hover.d, u: decalU(f, decalType(), hover.u), type: decalType() }, ghostLine, true));
        f.obj.updateMatrixWorld(true); f.obj.matrixWorld.decompose(ghost.position, ghost.quaternion, ghost.scale); ghost.visible = true; } }
    return req();
  }
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
      f.obj.updateMatrixWorld(true); f.obj.matrixWorld.decompose(ghost.position, ghost.quaternion, ghost.scale); ghost.visible = true;   // 预览复制该层的位置朝向缩放
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
  const hov = e => { setHover(expanded && !sel.view ? pick(e) : null); if (tAnchor) updateLink(); };
  cv.addEventListener("pointerleave", () => { if (!drag) setHover(null); });
  cv.addEventListener("pointerdown", e => {
    e.stopPropagation();
    const pan = e.button === 0 && !e.shiftKey;                 // 左键拖动平移（右下角也可以）；右键 / 中键 / Shift+左键拖动旋转
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
    if (expanded && !sel.view && e.type === "pointerup" && d0.moved < 5) { if (d0.btn === 0) doPlace(); } req(); cv.classList.remove("grabbing"); try { cv.releasePointerCapture(e.pointerId); } catch (_) { } hov(e); };
  cv.addEventListener("pointerup", end); cv.addEventListener("pointercancel", end);
  cv.addEventListener("wheel", e => {
    e.preventDefault(); e.stopPropagation();
    const before = expanded && e.deltaY < 0 ? groundAt(e) : null;        // 放大朝鼠标位置；缩小朝画面中心并逐步回中
    cam.dist *= Math.pow(1.0018, e.deltaY); if (e.deltaY > 0) recenterOnZoomOut(); updateCamera();
    const after = before ? groundAt(e) : null;
    if (before && after) { cam.tx += before.x - after.x; cam.tz += before.z - after.z; updateCamera(); }
    hov(e);
  }, { passive: false });
}

/* ---------------- 键盘（只在展开后生效） ---------------- */
const holds = {}, panKeys = new Set();
let tSide = null;
/* 合并：沿所指侧面的朝向（世界坐标最近的轴向）找最近的一栋楼，取与这一层高度最接近的那层，
   两面之间按所指这一层的楼型填满 */
function mergeNeighbor({ i, j, k, d }) {
  const f = stackOf(i, j)[k]; if (!f) return false;
  const n = new THREE.Vector3(FACES[d][0], 0, FACES[d][1]).applyQuaternion(f.obj.quaternion);
  const di = Math.abs(n.x) >= Math.abs(n.z) ? Math.sign(n.x) : 0, dj = di ? 0 : Math.sign(n.z);
  const y0 = f.obj.position.y, y1 = y0 + f.h, yc = (y0 + y1) / 2;
  for (let step = 1; step <= 4; step++) {
    const ni = i + di * step, nj = j + dj * step, st = stackOf(ni, nj); if (!st.length) continue;
    let best = -1, bd = Infinity;
    st.forEach((g, q) => { const a = g.obj.position.y, b = a + g.h; if (b <= y0 + 1e-4 || a >= y1 - 1e-4) return; const dd = Math.abs((a + b) / 2 - yc); if (dd < bd) { bd = dd; best = q; } });
    if (best >= 0) return connect([i, j, k], [ni, nj, best], f.t);
    break;                                                  // 中间隔着的第一栋楼没有同高度的层，就不跨过去
  }
  emit("blocked", { i, j, k, d }); return false;
}
function typing(t) { return t && t.closest && t.closest("input,textarea,select,[contenteditable]"); }
function startHold(k, fn) { if (holds[k]) return; fn(); holds[k] = { t: setTimeout(() => { holds[k].i = setInterval(fn, config.repeatEvery); }, config.repeatDelay) }; }
function stopHold(k) { const h = holds[k]; if (!h) return; clearTimeout(h.t); clearInterval(h.i); delete holds[k]; }
function cycleType(d) { const O = ORDER.filter(id => !FLOORS.get(id).hidden), k = O.indexOf(sel.t); select(O[(k + d + O.length) % O.length]); }
function cycleSize(d) { const ks = Object.keys(SIZES), k = ks.indexOf(sel.s); select(null, ks[Math.max(0, Math.min(ks.length - 1, k + d))]); }
function rotateSel() { select(null, null, (sel.r || 0) + config.rotStep); }
function doPlace() {
  if (!hover) return;
  if (sel.decal) {
    if (sel.decal === "street") { if (hover.kind === "top" && hover.i != null) addRoad(hover.i, hover.j); }
    else if (sel.decal === "grass" || sel.decal === "water" || sel.decal === "earth") { const t = terrainTarget(hover); if (t) addVox(t.i, t.j, t.lv, { grass: "g", water: "w", earth: "e" }[sel.decal]); }
    else if (hover.kind === "side") { const f = stackOf(hover.i, hover.j)[hover.k];
      if (f && f.win) group(() => { expandWin(hover.i, hover.j, hover.k); addDecal(hover.i, hover.j, hover.k, hover.d, hover.u, decalType()); });
      else addDecal(hover.i, hover.j, hover.k, hover.d, hover.u, decalType()); }
    return;
  }
  if (blockMode() && hover.kind !== "side") { const p = blockAim(); if (p) placeBlock(p.x, p.z, sel.t, hover.kind === "block" && !(hover.n && hover.n[1] > 0) ? p.y : undefined); return; }
  if (hover.kind === "side") addWing(hover.i, hover.j, hover.k, hover.d, sel.t, sel.s, undefined, hover.u);
  else if (hover.kind === "top") { if (sel.tpl) placeTemplate(hover.i, hover.j, sel.tpl); else place(hover.i, hover.j); }
}
function doDelete() {
  if (!hover) return;
  if (sel.decal === "street" && hover.kind === "top" && roads.has(K(hover.i, hover.j))) { removeRoad(hover.i, hover.j); return; }
  if ((sel.decal === "window" || sel.decal === "door") && hover.kind === "side") { const f = stackOf(hover.i, hover.j)[hover.k];
    if (f && f.win && sel.decal === "window") { group(() => { expandWin(hover.i, hover.j, hover.k); removeDecal(hover.i, hover.j, hover.k, hover.d, hover.u, sel.decal); }); return; }
    if (removeDecal(hover.i, hover.j, hover.k, hover.d, hover.u, sel.decal)) return; }
  if (hover.kind === "top" && hover.i != null && roads.has(K(hover.i, hover.j)) && !stackOf(hover.i, hover.j).length) { removeRoad(hover.i, hover.j); return; }
  if (hover.kind === "bridge") { if (bridges.includes(hover.ref)) disconnect(hover.ref); return; }
  if (hover.kind === "block") { if (blocks.includes(hover.ref)) removeBlock(hover.ref); return; }
  if (hover.kind === "wing") { removeWing(hover.i, hover.j, hover.k, hover.d, hover.u || 0); return; }
  if (hover.ter) { const b = terrainBlock(hover); if (b) delVox(b.i, b.j, b.lv); return; }        // 指着地形：删那一块
  if (stackOf(hover.i, hover.j).length) remove(hover.i, hover.j); else dig(hover.i, hover.j);
}
addEventListener("keydown", e => {
  if (!expanded || typing(e.target)) return;
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if ((e.ctrlKey || e.metaKey) && k === "y") { e.preventDefault(); redo(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (k === "escape") { e.preventDefault(); if (pure) setPure(false); else collapse(); return; }
  if (sel.view && (k === " " || e.code === "Space" || k === "x" || k === "f" || k === "t")) { e.preventDefault(); return; }   // 浏览模式不放不删
  if (k === " " || e.code === "Space") { e.preventDefault(); if (!e.repeat) { if (sel.tpl || sel.decal === "window" || sel.decal === "door") doPlace(); else startHold("space", doPlace); } return; }
  if (k === "x") { e.preventDefault(); if (!e.repeat) startHold("del", doDelete); return; }
  if (k === "w" || k === "a" || k === "s" || k === "d") { e.preventDefault(); panKeys.add(k); return; }
  if (k === "t") { e.preventDefault(); if (!e.repeat) { tAnchor = hoverFloor(); tSide = hover && hover.kind === "side" ? { i: hover.i, j: hover.j, k: hover.k, d: hover.d } : null; updateLink(); } return; }
  if (k === "q") { e.preventDefault(); cycleType(-1); return; }
  if (k === "e") { e.preventDefault(); cycleType(1); return; }
  if (k === "z") { e.preventDefault(); cycleSize(-1); return; }
  if (k === "c") { e.preventDefault(); cycleSize(1); return; }
  if (k === "r") { e.preventDefault(); if (sel.decal === "window") { sel.wrot = !sel.wrot; select(); } else rotateSel(); return; }
  if (k === "f") { e.preventDefault(); if (!e.repeat) startHold("f", () => { const t = terrainTarget(hover); if (t) addVox(t.i, t.j, t.lv, "e"); }); return; }
}, true);
addEventListener("keyup", e => {
  const k = e.key.toLowerCase();
  if (k === " " || e.code === "Space") stopHold("space");
  if (k === "x") stopHold("del");
  panKeys.delete(k);
  if (k === "f") stopHold("f");
  if (k === "t" && tAnchor) {
    const b = hoverFloor();
    if (b && !(b[0] === tAnchor[0] && b[1] === tAnchor[1])) connect(tAnchor, b);
    else if (tSide) mergeNeighbor(tSide);
    tAnchor = null; tSide = null; updateLink();
  }
});
addEventListener("blur", () => { stopHold("space"); stopHold("del"); stopHold("f"); panKeys.clear(); tAnchor = null; tSide = null; if (linkLine) updateLink(); });

/* ---------------- 昼夜：现实 24 分钟 = 城里一天（1 分钟 = 1 小时），所有人看到的是同一时刻 ----------------
   傍晚城市渐暗、窗户逐盏亮灯，车灯一次全开；清晨渐亮、灯逐盏熄灭。
   切换网页明暗（~ 键或主题按钮）时，城里时间跳到中午 / 夜里 10 点，之后照常走 */
function themeNight() { return document.documentElement.getAttribute("data-theme") === "dark"; }
let dark = 0, light = 0, hourFix = null;
const KEY_CLOCK = "myspace-city-clock";
let clockOffset = (() => { try { return +localStorage.getItem(KEY_CLOCK) || 0; } catch (e) { return 0; } })();
function jumpTo(h) {                                       // 让城里此刻变成 h 点（存本机，之后从这里继续走）
  const ms = config.dayMinutes * 60000, now = ((Date.now() + clockOffset) % ms + ms) % ms;
  clockOffset = ((clockOffset + h / 24 * ms - now) % ms + ms) % ms;
  try { localStorage.setItem(KEY_CLOCK, String(Math.round(clockOffset))); } catch (e) { }
  hourFix = null; updateClock(true);
}
const smooth = t => { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); };
function cityHour() { if (hourFix != null) return hourFix; const ms = config.dayMinutes * 60000; return (((Date.now() + clockOffset) % ms + ms) % ms) / ms * 24; }
function darkAt(h) { return h < 5 ? 1 : h < 7.5 ? 1 - smooth((h - 5) / 2.5) : h < 17 ? 0 : h < 20 ? smooth((h - 17) / 3) : 1; }
function lightAt(h) { return h < 4.5 ? 1 : h < 7.5 ? 1 - (h - 4.5) / 3 : h < 17.5 ? 0 : h < 21 ? (h - 17.5) / 3.5 : 1; }
function updateClock(force) {
  const h = cityHour(), d = darkAt(h), l = lightAt(h);
  updateSky(h);
  if (!force && Math.abs(d - dark) < .003 && Math.abs(l - light) < .003) return;
  dark = d; light = l;
  if ((l > 0) !== night) { night = l > 0; emit("night", night); }
  if (scene) applyPalette();
}
/* 云海背景：清晨 / 白天 / 傍晚 / 夜晚 四张俯瞰云海照片（Unsplash 免费授权，见 assets/sky/CREDITS.txt），
   随时间交替淡入淡出，城市像浮在云上的空岛；只加载正在显示的那几张 */
const SKY = ["night", "dawn", "day", "dusk"].map(id => new URL("sky/" + id + ".jpg", import.meta.url).href);
const SKY_KEYS = [[0, 0], [4.5, 0], [6, 1], [8, 2], [16.5, 2], [18.5, 3], [20.5, 0], [24, 0]];
let skyLast = "";
function makeSky(el) {
  const box = document.createElement("div"); box.className = "city-sky";
  box.innerHTML = ["night", "dawn", "day", "dusk"].map(k => '<i data-k="' + k + '"></i>').join("");
  el.prepend(box); skyLast = ""; moveSky();
}
/* 视差：旋转时背景横向轻移，平移时跟着地面方向挪一点，俯仰时上下挪，拉近时略放大 */
function moveSky() {
  const th = rad(cam.theta), ox = (cam.tx * Math.cos(th) - cam.tz * Math.sin(th)) / HALF, oz = (cam.tx * Math.sin(th) + cam.tz * Math.cos(th)) / HALF;
  const x = Math.sin(th) * 4 - ox * 2.5, y = (cam.phi - 38) * .12 - oz * 1.5, sc = 1.16 + (1 - Math.min(1, cam.dist / config.distMax)) * .06;
  const tf = "translate(" + x.toFixed(2) + "%," + y.toFixed(2) + "%) scale(" + sc.toFixed(3) + ")";
  document.querySelectorAll(".city-sky").forEach(b => { b.style.transform = tf; });
}
function updateSky(h) {
  let q = 0; while (q < SKY_KEYS.length - 2 && h >= SKY_KEYS[q + 1][0]) q++;
  const [h0, a] = SKY_KEYS[q], [h1, b] = SKY_KEYS[q + 1], t = h1 > h0 ? Math.max(0, Math.min(1, (h - h0) / (h1 - h0))) : 0;
  const key = a + "," + b + "," + t.toFixed(3); if (key === skyLast) return; skyLast = key;
  document.querySelectorAll(".city-sky").forEach(box => [...box.children].forEach((el, k) => {    // 底下一张不透明，上面一张按进度淡入
    const op = k === a ? 1 : k === b ? t : 0;
    if (op > 0 && !el.style.backgroundImage) el.style.backgroundImage = "url(" + SKY[k] + ")";
    el.style.opacity = op; el.style.zIndex = k === b && a !== b ? 2 : k === a ? 1 : 0; }));
}

/* ---------------- 界面：右下角、展开窗口、底部选择栏 ---------------- */
const UNDO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/></svg>';
const REDO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m15 14 5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/></svg>';
const MOUSE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M6 3.5 18 13l-5.2.8 3 6.2-2.3 1.1-3-6.3L6 18.6z"/></svg>';
const FULL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>';
const DI = p => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round">' + p + "</svg>";
const DECALS = [
  ["street", "街道", DI('<path d="M7 3 4 21M17 3l3 18"/><path d="M12 4v3M12 10.5v3M12 17v3"/>')],
  ["window", "窗户贴图", DI('<rect x="7.5" y="4.5" width="9" height="15"/>')],
  ["door", "门贴图", DI('<path d="M7 21V4h10v17M4 21h16"/><path d="M14.5 12.5v1.5"/>')],
  ["earth", "地块", DI('<path d="M4 8.5 12 4.5l8 4-8 4z"/><path d="M4 8.5v7l8 4 8-4v-7M12 12.5v7"/>')],
  ["water", "水", DI('<path d="M3 9c2-1.6 4-1.6 6 0s4 1.6 6 0 4-1.6 6 0M3 14c2-1.6 4-1.6 6 0s4 1.6 6 0 4-1.6 6 0M3 19c2-1.6 4-1.6 6 0s4 1.6 6 0 4-1.6 6 0"/>')],
  ["grass", "草地", DI('<path d="M3 20h18"/><path d="M6 20c0-3 1-5 2-7M9 20c0-4 .5-6 1.5-9M13 20c0-3 1.5-6 3-8M17 20c0-2 .5-4 2-5"/>')]];
const extraButtons = [];
function addButton(b) { extraButtons.push(b); renderBar(); }
function renderBar() {
  if (!bar) return;
  bar.innerHTML = '<div class="cb-group"><button class="cb-btn' + (sel.view ? ' on' : '') + '" data-act="view" aria-label="浏览">' + MOUSE + '</button>'
    + '<button class="cb-btn" data-act="pure" aria-label="全览">' + FULL + '</button></div><span class="cb-sep"></span>'
    + '<div class="cb-group cb-types">' + ORDER.filter(id => !FLOORS.get(id).hidden).map(id => { const d = FLOORS.get(id);
      return '<button class="cb-btn' + (sel.t === id && !sel.tpl && !sel.decal && !sel.view ? ' on' : '') + '" data-t="' + id + '" aria-label="' + d.name + '">' + (d.icon || d.name.slice(0, 1)) + '</button>'; }).join("") + '</div>'
    + '<span class="cb-sep"></span><div class="cb-group">' + TORDER.map(id => { const d = TEMPLATES.get(id);
      return '<button class="cb-btn' + (sel.tpl === id ? ' on' : '') + '" data-tpl="' + id + '" aria-label="' + d.name + '">' + (d.icon || d.name.slice(0, 1)) + '</button>'; }).join("") + '</div>'
    + '<span class="cb-sep"></span><div class="cb-group">' + DECALS.map(([id, name, icon]) => '<button class="cb-btn' + (sel.decal === id ? ' on' : '') + '" data-decal="' + id + '" aria-label="' + name + '">' + icon + '</button>').join("") + '</div>'
    + '<span class="cb-sep"></span><div class="cb-group">' + Object.keys(SIZES).map(s => '<button class="cb-btn cb-size' + (sel.s === s ? ' on' : '') + '" data-s="' + s + '">' + s + '</button>').join("") + '</div>'
    + '<span class="cb-sep"></span><div class="cb-group">'
    + '<button class="cb-btn" data-act="undo" title="撤销 Ctrl+Z">' + UNDO + '</button>'
    + '<button class="cb-btn" data-act="redo" title="重做 Ctrl+Shift+Z">' + REDO + '</button>'
    + (sel.decal === "window" ? '<div class="cb-sub">'
      + [[1, "开灯", '<rect x="7.5" y="4.5" width="9" height="15" fill="currentColor" fill-opacity=".35"/>'], [0, "关灯", '<rect x="7.5" y="4.5" width="9" height="15"/>']]
        .map(([v, n, p]) => '<button class="cb-btn' + ((sel.wlit ? 1 : 0) === v ? ' on' : '') + '" data-wl="' + v + '" aria-label="' + n + '">' + DI(p) + '</button>').join("")
      + '<span class="cb-sep"></span>'
      + [["S", "小", 5, 7], ["M", "中", 8, 11], ["T", "大", 10, 15]]
        .map(([v, n, a, b]) => { const [w, h] = sel.wrot ? [b, a] : [a, b], x = 12 - w / 2, y = 12 - h / 2; return '<button class="cb-btn' + (sel.wsz === v ? ' on' : '') + '" data-ws="' + v + '" aria-label="' + n + '">' + DI('<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '"/>') + '</button>'; }).join("")
      + '</div>' : '')
    + extraButtons.map((b, k) => '<button class="cb-btn" data-x="' + k + '" title="' + (b.title || "") + '">' + (b.icon || b.title || "") + '</button>').join("")
    + '</div>';
}
function select(t, s, r) {
  if (t && FLOORS.has(t)) { sel.t = t; sel.tpl = null; sel.decal = null; sel.view = false; } if (s && SIZES[s]) sel.s = s; if (r != null) sel.r = ((+r % 360) + 360) % 360;
  try { localStorage.setItem(KEY_SEL, JSON.stringify(sel)); } catch (e) { }
  renderBar(); updateGhost(); emit("select", Object.assign({}, sel));
}
function mount(target) { host = target; host.appendChild(renderer.domElement); resize(); applyPalette(); }
function expand() { if (expanded) return; expanded = true; if (!sel.view) setView(true); pop.classList.add("show"); mount(popStage); emit("expand"); }
/* 全览：窗口铺满屏幕（能全屏就全屏），按钮全部隐藏，快捷键照常；Esc 退出 */
let pure = false;
function setPure(on) {
  if (on === pure || (on && !expanded)) return; pure = on; pop.classList.toggle("pure", on); hideTypePreview();
  try { if (on && pop.requestFullscreen) pop.requestFullscreen().catch(() => { }); else if (!on && document.fullscreenElement) document.exitFullscreen().catch(() => { }); } catch (e) { }
  emit("pure", on);
}
function setView(on) { sel.view = on; if (on) { sel.tpl = null; sel.decal = null; setHover(null); } select(); }
function collapse() {
  if (!expanded) return; setPure(false); expanded = false;
  stopHold("space"); stopHold("del"); panKeys.clear(); tAnchor = null; updateLink(); setHover(null);
  pop.classList.remove("show"); mount(corner.querySelector(".city-host")); emit("collapse");
}
function injectCSS() {
  const st = document.createElement("style");
  st.textContent = `
  .city-host{position:absolute;inset:0;overflow:hidden}
  .city-canvas{position:relative;display:block;width:100%;height:100%;cursor:grab;touch-action:none}
  .city-sky{position:absolute;inset:0;z-index:0;pointer-events:none;transform-origin:50% 50%;will-change:transform}
  .city-host,.city-stage{overflow:hidden}
  .city-sky i{position:absolute;inset:0;background-size:cover;background-position:center 45%;opacity:0;transition:opacity 1.2s linear;
    filter:saturate(.72) contrast(.92) brightness(1.04)}                  /* 照片压一点饱和与对比，贴近线稿的淡雅 */
  .city-sky i[data-k=night]{filter:saturate(.6) contrast(.95) brightness(.42)}
  .city-pop.pure{padding:0;background:#000}
  .city-pop.pure .city-win{width:100%;height:100%;border-radius:0;box-shadow:none;transform:none}
  .city-pop.pure .city-bar,.city-pop.pure .city-tri,.city-pop.pure .cb-pv{display:none}
  .city-canvas.grabbing{cursor:grabbing}
  /* 展开 = 十字、收起 = 一字，与栏目标题前的青色短横同一粗细长度 */
  .city-tri{position:absolute;left:0;top:0;width:40px;height:40px;border:0;padding:0;margin:0;cursor:pointer;z-index:3;background:transparent;
    transition:transform var(--d2,200ms) var(--e-out,ease)}
  .city-tri::before,.city-tri::after{content:"";position:absolute;left:13px;top:19px;width:14px;height:2px;background:var(--accent)}
  .city-tri::after{transform:rotate(90deg)}
  .city-tri.minus::after{display:none}
  .city-tri:hover,.city-tri:focus-visible{outline:0;transform:rotate(90deg)}
  .city-tri.minus:hover,.city-tri.minus:focus-visible{transform:scaleX(1.4)}
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
  .city-bar{position:relative}
  .cb-sub{position:absolute;left:50%;bottom:calc(100% + 8px);transform:translateX(-50%);display:flex;align-items:center;gap:2px;padding:4px;
    background:var(--card);border-radius:var(--r,2px);box-shadow:var(--sh3);animation:cbsub var(--d1,120ms) var(--e-out,ease)}
  @keyframes cbsub{from{opacity:0;transform:translate(-50%,4px)}}
  .city-pop.night .cb-sub{background:#1a1c26}
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
  pop.innerHTML = '<div class="city-win"><div class="city-stage"></div><button class="city-tri minus" aria-label="收起"></button><div class="city-bar"></div></div>';
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
    else if (b.dataset.tpl) { sel.tpl = sel.tpl === b.dataset.tpl ? null : b.dataset.tpl; sel.decal = null; sel.view = false; select(); }
    else if (b.dataset.wl != null) { sel.wlit = +b.dataset.wl; select(); }
    else if (b.dataset.ws) { sel.wsz = b.dataset.ws; select(); }
    else if (b.dataset.decal) { sel.decal = sel.decal === b.dataset.decal ? null : b.dataset.decal; sel.tpl = null; sel.view = false; select(); }
    else if (b.dataset.act === "view") setView(!sel.view); else if (b.dataset.act === "pure") setPure(true);
    else if (b.dataset.act === "undo") undo(); else if (b.dataset.act === "redo") redo();
    else if (b.dataset.x != null) { const x = extraButtons[+b.dataset.x]; if (x && x.onClick) x.onClick(api); }
  });
  makeSky(corner.querySelector(".city-host")); makeSky(popStage);
  document.addEventListener("fullscreenchange", () => { if (!document.fullscreenElement && pure) setPure(false); });
  new ResizeObserver(resize).observe(corner); new ResizeObserver(resize).observe(popStage);
  new MutationObserver(() => { const n = themeNight(); pop.classList.toggle("night", n); jumpTo(n ? 22 : 12); }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  renderBar();
}

/* 默认城区：地标放在中心附近的固定位置，四周撒随机楼；不进撤销栈 */
/* 默认城区：以棋盘中心为原点，每 6 格一条路（8×8 个 5×5 街区）；9 个地标各占一个街区，
   其余街区按离中心远近随机撒楼（越近越密），楼都不压路。不进撤销栈 */
const SEED_VER = 3;
function seedCity(seed) {
  const r = rng(seed), c = HALF, S = 6, B = 4;
  for (let a = -B * S; a <= B * S; a++) for (let b = -B * S; b <= B * S; b++) if (a % S === 0 || b % S === 0) {
    const k = K(c + a, c + b); if (water.has(k) && b % S !== 0) continue; roads.add(k); }
  rebuildRoads();
  const cellOf = (bx, bz, ox, oz) => [c + bx * S + ox, c + bz * S + oz];        // 街区 (bx,bz) 内第 (ox,oz) 格，ox/oz ∈ 1..5
  const marks = [["burj", 0, 0, 3, 3], ["shanghai", 1, 0, 3, 3], ["empire", -1, 0, 3, 3], ["taipei101", 0, 1, 3, 3], ["onewtc", 1, 1, 3, 3],
    ["chrysler", -1, 1, 3, 3], ["cntower", 0, -1, 3, 3], ["petronas", -1, -1, 2, 3], ["willis", 1, -1, 3, 3]];
  const taken = new Set();
  marks.forEach(([id, bx, bz, ox, oz]) => { const [i, j] = cellOf(bx, bz, ox, oz); placeTemplate(i, j, id, Math.floor(r() * 1e9)); taken.add(bx + "," + bz); });
  for (let bx = -B; bx < B; bx++) for (let bz = -B; bz < B; bz++) {
    if (taken.has(bx + "," + bz)) continue;
    const dist = Math.max(Math.abs(bx + .5), Math.abs(bz + .5)), p = .22 - dist * .045;
    for (let ox = 1; ox <= 5; ox++) for (let oz = 1; oz <= 5; oz++) { const [i, j] = cellOf(bx, bz, ox, oz);
      if (r() < p && !stackOf(i, j).length && !water.has(K(i, j))) placeTemplate(i, j, "random", Math.floor(r() * 1e9)); }
  }
  addSpurs(seed); windowAll();
  seeded = SEED_VER; edited = 0; hist.length = 0; redoStack.length = 0; changed();
}
let seeded = 0;

/* ---------------- 启动：右下角可见（桌面端）时才创建 WebGL ---------------- */
let started = false;
function start() {
  corner = document.getElementById("corner");
  if (started || !corner || !corner.offsetWidth) return;
  started = true;
  initThree(); buildUI(); bindPointer(renderer.domElement);
  mount(corner.querySelector(".city-host")); updateClock(true);
  if (window.IntersectionObserver) new IntersectionObserver(es => { cityVisible = es[es.length - 1].isIntersecting; }).observe(corner);
  loadCity();
}
/* 访客第一次打开载入我发布的城市，之后他们的改动只存在他们自己的浏览器里；
   没改动过的访客在我重新发布后会换成新版本 */
async function fetchPublished() {
  try { const r = await fetch("data.json?_=" + Date.now(), { cache: "no-store" }); if (!r.ok) return null;
    const j = await r.json(); return j && j.city ? (typeof j.city === "string" ? JSON.parse(j.city) : j.city) : null; } catch (e) { return null; }
}
async function loadCity() {
  let local = null; try { local = JSON.parse(localStorage.getItem(KEY_CITY)); } catch (e) { }
  const isEdited = d => !!d && (d.edited != null ? !!d.edited : !d.seeded);
  const stale = local && !isEdited(local) && local.seeded && local.seeded < SEED_VER;   // 没改动过的旧版默认城区：换成新版
  const fresh = () => { clearCity(); setWorld(genWorld(WORLD_SEED)); wv = WORLD_VER; seedCity(WORLD_SEED); };
  const done = () => { if (wv < 2) migrateWorld(); if (wv < 3) { trimRiverRoads(); wv = 3; } if (wv < 4) { windowAll(); wv = 4; } if (!cells.size && !blocks.length) seedCity(WORLD_SEED); updateGhost(); save(); };
  if (local && !stale) { importJSON(local); done(); }
  if (!isEdited(local)) {
    const pub = await fetchPublished();
    if (pub && (!local || stale || (local.stamp || 0) !== (pub.stamp || 0))) { importJSON(pub); edited = 0; stamp = pub.stamp || 0; done(); }
    else if (!local || stale) fresh();
  }
  emit("ready", api);
}
/* 发布：返回带新版本号的城市数据（字符串），由网页写进 data.json */
function publishJSON() { stamp = Date.now(); save(); return JSON.stringify(exportJSON()); }

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
  addRoad, removeRoad, addGrass, removeGrass, windowAll, attachWin, detachWin, addWater, removeWater, genWorld, setWorld, addDecal, removeDecal, raise: fill, lower: dig, addVox, delVox, typeAt, genTerrain, trimRiverRoads, group, placeBlock, removeBlock, mergeNeighbor, seedCity, undo, redo, clear: clearCity,
  select, expand, collapse, rotateBy, exportJSON, importJSON, publishJSON, migrateWorld, addSpurs, setPure, setView, config,
  jumpTo, tickCars: dt => stepCars(dt),
  setCamera(o) { Object.assign(cam, o); if (o.theta != null) goal.theta = cam.theta; if (o.phi != null) goal.phi = cam.phi; orbit = null; updateCamera(); },
  get cam() { return Object.assign({}, cam); },
  setHour(h) { hourFix = h == null ? null : ((+h % 24) + 24) % 24; updateClock(true); },
  get hour() { return cityHour(); }, get started() { return started; }, get cars() { return cars; }, sizes: SIZES, helpers, three: THREE,
  get floors() { return ORDER.map(id => FLOORS.get(id)); },
  get selected() { return Object.assign({}, sel); },
  get scene() { return scene; }, get camera() { return camera; }, get renderer() { return renderer; },
  get cells() { return cells; }, get terrain() { return terrain; }, get columns() { return cols; }, get roads() { return roads; }, get water() { return water; }, get grass() { return grass; }, get blocks() { return blocks; }, get templates() { return TORDER.map(id => TEMPLATES.get(id)); }, get bridges() { return bridges; }, get night() { return night; }, get hover() { return hover; },
  refresh() { updateCamera(); req(); },
  renderNow() { updateCamera(); if (fadeDirty) { fadeDirty = false; updateFade(); } fadeGrid(); renderer.render(scene, camera); }   // 立即按真实一帧渲染（截图用）
};
window.CityGame = api;
emit("loaded", api);
addEventListener("resize", start);
start();
