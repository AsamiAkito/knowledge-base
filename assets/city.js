/* ============================================================
   线条城市 —— 右下角小游戏（three.js r160，本地 vendor）
   ------------------------------------------------------------
   · 常态显示在 #corner；点左上角小三角展开为屏幕中间的大窗口
   · 190×190 棋盘，透视相机（近大远小）；左键拖动绕棋盘中心旋转 / 改俯仰，
     滚轮缩放；展开后右键或 Shift+拖动平移、滚轮朝鼠标位置缩放
   · 右下角只能旋转和缩放；展开后才能编辑：
     空格放置（长按连放）、D 删除（长按连删）、Ctrl+Z 撤销、Ctrl+Shift+Z / Ctrl+Y 重做、
     Q / E 选左 / 右一个楼层、W / S 增大 / 减小尺寸、R 顺时针旋转 15°
   · 昼夜跟随网页主题：暗色主题即夜晚，窗户亮灯（游戏内不能切换）
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
  distMin: 4, distMax: 420,                       // 相机到注视点的距离范围（缩放）
  rotStep: 15,                                    // R 键每次顺时针旋转的角度
  repeatDelay: 300, repeatEvery: 90               // 长按连放 / 连删的节奏（毫秒）
};

/* 界面元素（在注册内置楼层之前声明，renderBar 会用到） */
let host, corner, pop, popStage, bar, needs = true;

/* ---------------- 事件 ---------------- */
const handlers = {};
function on(ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); return () => off(ev, fn); }
function off(ev, fn) { handlers[ev] = (handlers[ev] || []).filter(f => f !== fn); }
function emit(ev, data) { (handlers[ev] || []).forEach(f => { try { f(data); } catch (e) { console.error(e); } }); }

/* ---------------- 几何工具 ---------------- */
function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
/* 合并若干几何体（转为非索引，按共有属性拼接） */
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
/* 方盒四面的窗格：cols 列 × rows 行；每格随机亮/不亮（夜里用） */
function boxPanes(w, h, { cols, rows = [.5], ph = .46, pr = .55, seed = 1, y0 = 0 } = {}) {
  const r = rng(seed), pos = [], col = [];
  cols = cols || Math.max(2, Math.round(w / .17));
  const span = w * .8, cw = span / cols, pw = cw * pr, half = w / 2 + .004;
  const faces = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  faces.forEach(([nx, nz]) => {
    const tx = -nz, tz = nx;                       // 面内水平方向
    for (let c = 0; c < cols; c++) {
      const u = -span / 2 + (c + .5) * cw;
      rows.forEach(ry => {
        const yc = y0 + h * ry, hh = h * ph / 2, hw = pw / 2;
        const cx = nx * half + tx * u, cz = nz * half + tz * u;
        const P = (s, t) => [cx + tx * hw * s, yc + hh * t, cz + tz * hw * s];
        const q = [P(-1, -1), P(1, -1), P(1, 1), P(-1, -1), P(1, 1), P(-1, 1)];
        const lit = r() < .72, c3 = lit ? [1, .82, .42] : [.2, .22, .3];
        q.forEach(v => { pos.push(...v); col.push(...c3); });
      });
    }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  return g;
}
/* 圆柱一圈的窗格 */
function roundPanes(rad, h, { count = 12, ph = .46, seed = 1 } = {}) {
  const r = rng(seed), pos = [], col = [], R = rad + .004, pw = Math.PI * 2 * rad / count * .5;
  for (let i = 0; i < count; i++) {
    const a = i / count * Math.PI * 2, nx = Math.cos(a), nz = Math.sin(a), tx = -nz, tz = nx;
    const cx = nx * R, cz = nz * R, yc = h / 2, hh = h * ph / 2, hw = pw / 2;
    const P = (s, t) => [cx + tx * hw * s, yc + hh * t, cz + tz * hw * s];
    const lit = r() < .72, c3 = lit ? [1, .82, .42] : [.2, .22, .3];
    [P(-1, -1), P(1, -1), P(1, 1), P(-1, -1), P(1, 1), P(-1, 1)].forEach(v => { pos.push(...v); col.push(...c3); });
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  return g;
}

/* ---------------- 楼层类型注册表 ----------------
   def = {
     id, name, icon(24×24 线条 SVG 字符串),
     height(w) | 数字          层高（格），可按占地宽度 w 计算
     cap: true                  封顶层，上面不能再盖
     build({THREE,w,h,seed,helpers}) → { solid, lines?, panes?, autoEdges? }
       solid  实体几何（底面在 y=0）
       lines  额外线条（LineSegments 用的顶点对）
       panes  窗格（带 color 属性，夜里亮灯）
       autoEdges:false 时不自动描实体边（圆柱、穹顶等自己画线）
   } */
const FLOORS = new Map(), ORDER = [], geoCache = new Map();
const helpers = { box, lines, ring, merge, boxPanes, roundPanes, rng };
function floorHeight(def, w) { return typeof def.height === "function" ? def.height(w) : def.height; }
function registerFloor(def) {
  if (!def || !def.id || typeof def.build !== "function") throw new Error("registerFloor: 需要 id 和 build");
  if (!FLOORS.has(def.id)) ORDER.push(def.id);
  FLOORS.set(def.id, Object.assign({ name: def.id, height: .32, cap: false, icon: "" }, def));
  [...geoCache.keys()].forEach(k => { if (k.startsWith(def.id + "|")) geoCache.delete(k); });
  renderBar(); emit("register", def);
}
function floorGeo(t, s, v) {
  const key = t + "|" + s + "|" + v;
  if (geoCache.has(key)) return geoCache.get(key);
  const def = FLOORS.get(t), w = SIZES[s], h = floorHeight(def, w);
  const r = def.build({ THREE, w, h, seed: v * 7919 + 13, helpers });
  const edges = merge([r.autoEdges === false ? null : new THREE.EdgesGeometry(r.solid, 25), r.lines]);
  const out = { solid: r.solid, edges, panes: r.panes || null, h };
  geoCache.set(key, out); return out;
}

/* ---------------- 内置楼层 ---------------- */
const I = p => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round">' + p + "</svg>";
registerFloor({ id: "window", name: "窗户层", icon: I('<rect x="5" y="8" width="14" height="10"/><path d="M8 11v4M12 11v4M16 11v4"/>'),
  build: ({ w, h, seed }) => ({ solid: box(w, h), panes: boxPanes(w, h, { seed }) }) });
registerFloor({ id: "curtain", name: "玻璃幕墙层", icon: I('<rect x="6" y="5" width="12" height="15"/><path d="M9 5v15M12 5v15M15 5v15"/>'),
  build: ({ w, h, seed }) => {
    const p = [], k = Math.max(4, Math.round(w / .1)), hw = w / 2 + .002;
    for (let i = 1; i < k; i++) { const u = -w / 2 + i * w / k;
      p.push([u, 0, hw], [u, h, hw], [u, 0, -hw], [u, h, -hw], [hw, 0, u], [hw, h, u], [-hw, 0, u], [-hw, h, u]); }
    return { solid: box(w, h), lines: lines(p), panes: boxPanes(w, h, { seed, cols: k, ph: .8, pr: .7 }) };
  } });
registerFloor({ id: "plain", name: "实墙层", icon: I('<rect x="5" y="8" width="14" height="10"/><path d="M5 13h14"/>'),
  build: ({ w, h }) => { const hw = w / 2 + .002, y = h * .5;
    return { solid: box(w, h), lines: lines([[-hw, y, hw], [hw, y, hw], [hw, y, hw], [hw, y, -hw], [hw, y, -hw], [-hw, y, -hw], [-hw, y, -hw], [-hw, y, hw]]) }; } });
registerFloor({ id: "setback", name: "收分层", icon: I('<rect x="8" y="8" width="8" height="10"/><path d="M5 18h14M10 11v4M14 11v4"/>'),
  build: ({ w, h, seed }) => ({ solid: box(w * .72, h), panes: boxPanes(w * .72, h, { seed }) }) });
registerFloor({ id: "round", name: "圆形层", icon: I('<ellipse cx="12" cy="8" rx="6" ry="2"/><path d="M6 8v9a6 2 0 0 0 12 0V8"/>'),
  build: ({ w, h, seed }) => {
    const r = w / 2, g = new THREE.CylinderGeometry(r, r, h, 28); g.translate(0, h / 2, 0);
    const p = [...ring(r, 0), ...ring(r, h)];
    for (let i = 0; i < 8; i++) { const a = i / 8 * Math.PI * 2; p.push([Math.cos(a) * r, 0, Math.sin(a) * r], [Math.cos(a) * r, h, Math.sin(a) * r]); }
    return { solid: g, lines: lines(p), autoEdges: false, panes: roundPanes(r, h, { seed, count: Math.max(8, Math.round(w * 16)) }) };
  } });
registerFloor({ id: "roofbox", name: "屋顶设备", height: .16, icon: I('<path d="M4 17h16"/><rect x="9" y="12" width="6" height="5"/>'),
  build: ({ w, h }) => ({ solid: merge([box(w * .92, .03), box(w * .34, h - .03, w * .34, .03, w * .15, -w * .12)]) }) });
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
    for (let i = 0; i < 6; i++) { const a = i / 6 * Math.PI * 2;
      for (let j = 0; j < 8; j++) { const b0 = j / 8 * Math.PI / 2, b1 = (j + 1) / 8 * Math.PI / 2;
        p.push([Math.cos(b0) * r * Math.cos(a), Math.sin(b0) * r, Math.cos(b0) * r * Math.sin(a)], [Math.cos(b1) * r * Math.cos(a), Math.sin(b1) * r, Math.cos(b1) * r * Math.sin(a)]); } }
    return { solid: g, lines: lines(p), autoEdges: false };
  } });

/* ---------------- 配色（随页面主题与昼夜） ---------------- */
function palette(night) {
  if (night) return { face: 0x262938, line: 0x737a96, ground: 0x1f2230, side: 0x191b26, side2: 0x161822, minor: 0x2a2e40, major: 0x363b52, sky: 0x9aa0c0, gnd: 0x1a1c28, ambient: 1.6, sun: .7, clear: 0x15161d };
  return { face: 0xffffff, line: 0x4a4d5a, ground: 0xfbfbfd, side: 0xe4e3f1, side2: 0xd6d5ea, minor: 0xebebf2, major: 0xd8d8e4, sky: 0xffffff, gnd: 0xc9c8e6, ambient: 2.6, sun: .9, clear: 0xf2f2ee, pane: 0xe2e4ee };
}

/* ---------------- 状态 ---------------- */
const cells = new Map();                  // "i,j" → [{t,s,v,obj}]
const hist = [], redoStack = [];
let sel = Object.assign({ t: "window", s: "M", r: 0 }, (() => { try { return JSON.parse(localStorage.getItem(KEY_SEL)) || {}; } catch (e) { return {}; } })());
let night = false;
let hover = null;                          // {i,j}
let expanded = false;

/* ---------------- three.js 场景 ---------------- */
let renderer, scene, camera, hemi, sun, faceMat, lineMat, paneDay, paneNight, ghostFace, ghostLine;
let ground, groundEdges, gridMinor, gridMajor, floorsGroup, hoverBox, ghost, faceMeshes = [];
const cam = { tx: 0, tz: 0, theta: 45, phi: 35.26, dist: 64 };

function initThree() {
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.domElement.className = "city-canvas";
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(config.fov, 2, .1, 6000);
  hemi = new THREE.HemisphereLight(0xffffff, 0xbdbce0, .85); scene.add(hemi);
  sun = new THREE.DirectionalLight(0xffffff, .3); sun.position.set(-1, 2.2, .7); scene.add(sun);
  faceMat = new THREE.MeshLambertMaterial({ color: 0xffffff, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
  lineMat = new THREE.LineBasicMaterial({ color: 0x4a4d5a });
  paneDay = new THREE.MeshBasicMaterial({ color: 0xe2e4ee, side: THREE.DoubleSide });
  paneNight = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
  ghostFace = new THREE.MeshBasicMaterial({ color: 0x0e8fbc, transparent: true, opacity: .18, depthWrite: false });
  ghostLine = new THREE.LineBasicMaterial({ color: 0x0e8fbc, transparent: true, opacity: .9 });

  /* 底座（参考图那样带厚度的方台）+ 网格 */
  const gGeo = new THREE.BoxGeometry(N + 2, 1.2, N + 2); gGeo.translate(0, -.6, 0);
  const gm = c => new THREE.MeshBasicMaterial({ color: c, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
  ground = new THREE.Mesh(gGeo, [gm(0), gm(0), gm(0), gm(0), gm(0), gm(0)]);   // 台面纯色、两组侧面各一色，像插画那样平涂
  groundEdges = new THREE.LineSegments(new THREE.EdgesGeometry(gGeo), lineMat);
  const mi = [], ma = [];
  for (let k = 0; k <= N; k++) { const p = k - HALF, arr = k % 10 === 0 ? ma : mi;
    arr.push([p, .002, -HALF], [p, .002, HALF], [-HALF, .002, p], [HALF, .002, p]); }
  gridMinor = new THREE.LineSegments(lines(mi), new THREE.LineBasicMaterial({ color: 0xe6e6ee, transparent: true }));
  gridMajor = new THREE.LineSegments(lines(ma), new THREE.LineBasicMaterial({ color: 0xd2d2de }));
  scene.add(ground, groundEdges, gridMinor, gridMajor);
  floorsGroup = new THREE.Group(); scene.add(floorsGroup);

  /* 悬停格子与预览 */
  hoverBox = new THREE.LineLoop(lines([[-.5, 0, -.5], [.5, 0, -.5], [.5, 0, .5], [-.5, 0, .5]]), new THREE.LineBasicMaterial({ color: 0x0e8fbc }));
  hoverBox.visible = false; scene.add(hoverBox);
  ghost = new THREE.Group(); ghost.visible = false; scene.add(ghost);

  applyPalette(); updateCamera();
  (function loop() { requestAnimationFrame(loop); if (!needs || !host) return; needs = false; fadeGrid(); renderer.render(scene, camera); emit("render"); })();
}
function req() { needs = true; }
function accent() { return getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#0e8fbc"; }
function applyPalette() {
  const p = palette(night);
  faceMat.color.setHex(p.face); lineMat.color.setHex(p.line);
  ground.material[2].color.setHex(p.ground); [0, 1].forEach(k => ground.material[k].color.setHex(p.side)); [4, 5].forEach(k => ground.material[k].color.setHex(p.side2)); ground.material[3].color.setHex(p.side2); gridMinor.material.color.setHex(p.minor); gridMajor.material.color.setHex(p.major);
  hemi.color.setHex(p.sky); hemi.groundColor.setHex(p.gnd); hemi.intensity = p.ambient; sun.intensity = p.sun;
  if (p.pane) paneDay.color.setHex(p.pane);
  const a = new THREE.Color(accent()); hoverBox.material.color.copy(a); ghostFace.color.copy(a); ghostLine.color.copy(a);
  renderer.setClearColor(p.clear, expanded ? 1 : 0);
  floorsGroup.traverse(o => { if (o.userData.pane) o.material = night ? paneNight : paneDay; });
  if (pop) pop.classList.toggle("night", night);
  req();
}
/* 网格随缩放淡入淡出：格子太密时只留每 10 格的主线 */
function fadeGrid() {
  const ppc = (host ? host.clientHeight : 300) / (2 * cam.dist * Math.tan(rad(config.fov) / 2));   // 注视点附近每格像素
  gridMinor.material.opacity = Math.max(0, Math.min(1, (ppc - 5) / 10));
  gridMinor.visible = gridMinor.material.opacity > .02;
}

/* ---------------- 相机 ---------------- */
const rad = d => d * Math.PI / 180;
function clampCam() {
  cam.phi = Math.max(config.phiMin, Math.min(config.phiMax, cam.phi));
  if (config.thetaRange) cam.theta = Math.max(config.thetaRange[0], Math.min(config.thetaRange[1], cam.theta));
  cam.dist = Math.max(config.distMin, Math.min(config.distMax, cam.dist));
  cam.tx = Math.max(-HALF, Math.min(HALF, cam.tx)); cam.tz = Math.max(-HALF, Math.min(HALF, cam.tz));
}
function rotateBy(dTheta, dPhi) {
  const old = cam.theta; cam.theta += dTheta; cam.phi += dPhi; clampCam();
  const d = rad(cam.theta - old), c = Math.cos(d), sn = Math.sin(d), x = cam.tx, z = cam.tz;
  cam.tx = x * c + z * sn; cam.tz = z * c - x * sn; updateCamera();
}
function updateCamera() {
  clampCam();
  const R = cam.dist, ph = rad(cam.phi), th = rad(cam.theta);
  camera.position.set(cam.tx + R * Math.cos(ph) * Math.sin(th), R * Math.sin(ph), cam.tz + R * Math.cos(ph) * Math.cos(th));
  camera.lookAt(cam.tx, 0, cam.tz);
  const w = host ? host.clientWidth : 300, h = host ? host.clientHeight : 150;
  camera.aspect = w / Math.max(1, h); camera.updateProjectionMatrix(); req();
}
function resize() {
  if (!host || !renderer) return;
  const w = host.clientWidth, h = host.clientHeight; if (!w || !h) return;
  renderer.setSize(w, h, false); updateCamera();
}

/* ---------------- 楼层增删 ---------------- */
const K = (i, j) => i + "," + j;
function stackTop(i, j) { const st = cells.get(K(i, j)) || []; return st.reduce((a, f) => a + floorGeo(f.t, f.s, f.v).h, 0); }
function canPlace(i, j) {
  if (i < 0 || j < 0 || i >= N || j >= N) return false;
  const st = cells.get(K(i, j)) || [], top = st[st.length - 1];
  return !(top && FLOORS.get(top.t) && FLOORS.get(top.t).cap);
}
function makeFloorObj(t, s, v) {
  const g = floorGeo(t, s, v), grp = new THREE.Group();
  const m = new THREE.Mesh(g.solid, faceMat); grp.add(m); faceMeshes.push(m);
  grp.add(new THREE.LineSegments(g.edges, lineMat));
  if (g.panes) { const pm = new THREE.Mesh(g.panes, night ? paneNight : paneDay); pm.userData.pane = true; grp.add(pm); }
  return grp;
}
function orient(obj, s, r) {
  const a = rad(r || 0), w = SIZES[s], k = Math.min(1, .96 / (w * (Math.abs(Math.cos(a)) + Math.abs(Math.sin(a)))));
  obj.rotation.y = -a; obj.scale.set(k, 1, k);
}
function addFloor(i, j, t, s, v, r = 0) {
  const st = cells.get(K(i, j)) || [];
  const y = stackTop(i, j), obj = makeFloorObj(t, s, v);
  obj.position.set(i - HALF + .5, y, j - HALF + .5); orient(obj, s, r);
  obj.traverse(o => { o.userData.cell = [i, j]; });
  floorsGroup.add(obj); st.push({ t, s, v, r, obj }); cells.set(K(i, j), st);
}
function popFloor(i, j) {
  const st = cells.get(K(i, j)); if (!st || !st.length) return null;
  const f = st.pop(); floorsGroup.remove(f.obj);
  f.obj.traverse(o => { const k = faceMeshes.indexOf(o); if (k >= 0) faceMeshes.splice(k, 1); });
  if (!st.length) cells.delete(K(i, j));
  return f;
}
function place(i, j, t = sel.t, s = sel.s, r = sel.r, v) {
  if (!FLOORS.has(t) || !SIZES[s]) return false;
  if (!canPlace(i, j)) { emit("blocked", { i, j }); return false; }
  v = v ?? Math.floor(Math.random() * 3);
  addFloor(i, j, t, s, v, r); hist.push({ op: "add", i, j, t, s, v, r }); redoStack.length = 0; trimHist();
  changed(); emit("place", { i, j, t, s, r }); return true;
}
function remove(i, j) {
  const f = popFloor(i, j); if (!f) return false;
  hist.push({ op: "del", i, j, t: f.t, s: f.s, v: f.v, r: f.r }); redoStack.length = 0; trimHist();
  changed(); emit("remove", { i, j, t: f.t, s: f.s }); return true;
}
function undo() {
  const a = hist.pop(); if (!a) return false;
  if (a.op === "add") popFloor(a.i, a.j); else addFloor(a.i, a.j, a.t, a.s, a.v, a.r);
  redoStack.push(a); changed(); emit("undo", a); return true;
}
function redo() {
  const a = redoStack.pop(); if (!a) return false;
  if (a.op === "add") addFloor(a.i, a.j, a.t, a.s, a.v, a.r); else popFloor(a.i, a.j);
  hist.push(a); changed(); emit("redo", a); return true;
}
function trimHist() { if (hist.length > 2000) hist.splice(0, hist.length - 2000); }
function clearCity() { [...cells.keys()].forEach(k => { const [i, j] = k.split(",").map(Number); while (popFloor(i, j)); }); hist.length = 0; redoStack.length = 0; changed(); }
let saveT = 0;
function changed() { updateGhost(); req(); clearTimeout(saveT); saveT = setTimeout(save, 300); emit("change"); }
function exportJSON() { const out = []; cells.forEach((st, k) => { const [i, j] = k.split(",").map(Number); out.push([i, j, st.map(f => [f.t, f.s, f.v, f.r || 0])]); }); return { v: 1, cells: out }; }
function importJSON(d) {
  clearCity();
  ((d && d.cells) || []).forEach(([i, j, st]) => st.forEach(([t, s, v, r]) => { if (FLOORS.has(t) && SIZES[s] && canPlace(i, j)) addFloor(i, j, t, s, v, r || 0); }));
  changed();
}
function save() { try { localStorage.setItem(KEY_CITY, JSON.stringify(exportJSON())); } catch (e) { } }
function load() { try { const d = JSON.parse(localStorage.getItem(KEY_CITY)); if (d) importJSON(d); hist.length = 0; } catch (e) { } }

/* ---------------- 悬停、预览 ---------------- */
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
function pick(ev) {
  const r = renderer.domElement.getBoundingClientRect();
  ndc.set((ev.clientX - r.left) / r.width * 2 - 1, -(ev.clientY - r.top) / r.height * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const hit = ray.intersectObjects(faceMeshes, false)[0];
  if (hit) return { i: hit.object.userData.cell[0], j: hit.object.userData.cell[1] };
  const p = new THREE.Vector3(); if (!ray.ray.intersectPlane(plane, p)) return null;
  const i = Math.floor(p.x + HALF), j = Math.floor(p.z + HALF);
  return i >= 0 && j >= 0 && i < N && j < N ? { i, j } : null;
}
function groundAt(ev) {
  const r = renderer.domElement.getBoundingClientRect();
  ndc.set((ev.clientX - r.left) / r.width * 2 - 1, -(ev.clientY - r.top) / r.height * 2 + 1);
  ray.setFromCamera(ndc, camera); const p = new THREE.Vector3();
  return ray.ray.intersectPlane(plane, p) ? p : null;
}
function setHover(h) {
  const same = h && hover && h.i === hover.i && h.j === hover.j;
  if (same || (!h && !hover)) return; hover = h; updateGhost(); emit("hover", hover);
}
function updateGhost() {
  if (!scene) return;
  ghost.clear();
  if (!hover) { hoverBox.visible = false; ghost.visible = false; req(); return; }
  const y = stackTop(hover.i, hover.j), x = hover.i - HALF + .5, z = hover.j - HALF + .5, ok = canPlace(hover.i, hover.j);
  hoverBox.position.set(x, y + .004, z); hoverBox.visible = true;
  hoverBox.material.color.set(ok ? accent() : "#c0344d");
  if (ok && FLOORS.has(sel.t)) {
    const g = floorGeo(sel.t, sel.s, 0);
    ghost.add(new THREE.Mesh(g.solid, ghostFace), new THREE.LineSegments(g.edges, ghostLine));
    ghost.position.set(x, y, z); orient(ghost, sel.s, sel.r); ghost.visible = true;
  } else ghost.visible = false;
  req();
}

/* ---------------- 指针：旋转 / 平移 / 缩放 ---------------- */
let drag = null, inside = false;
function bindPointer(cv) {
  cv.addEventListener("contextmenu", e => e.preventDefault());
  cv.addEventListener("pointerenter", () => { inside = true; });
  cv.addEventListener("pointerleave", () => { inside = false; if (!drag) setHover(null); });
  const hov = e => setHover(expanded ? pick(e) : null);
  cv.addEventListener("pointerdown", e => {
    e.stopPropagation();
    drag = { x: e.clientX, y: e.clientY, lx: e.clientX, ly: e.clientY, pan: expanded && (e.button === 2 || e.button === 1 || e.shiftKey), g: groundAt(e), moved: 0 };
    cv.setPointerCapture(e.pointerId); cv.classList.add("grabbing");
  });
  cv.addEventListener("pointermove", e => {
    if (drag) {
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag.moved = Math.max(drag.moved, Math.abs(dx) + Math.abs(dy));
      if (drag.pan) { const g = groundAt(e); if (g && drag.g) { cam.tx -= g.x - drag.g.x; cam.tz -= g.z - drag.g.z; updateCamera(); } }
      else { rotateBy(-(e.clientX - drag.lx) * .35, (e.clientY - drag.ly) * .25); drag.lx = e.clientX; drag.ly = e.clientY; }
      return;
    }
    hov(e);
  });
  const end = e => { if (!drag) return; drag = null; cv.classList.remove("grabbing"); try { cv.releasePointerCapture(e.pointerId); } catch (_) { } hov(e); };
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

/* ---------------- 键盘：空格放 / D 删 / Ctrl+Z ---------------- */
const holds = {};
function active() { return expanded; }
function cycleType(d) { const k = ORDER.indexOf(sel.t); select(ORDER[(k + d + ORDER.length) % ORDER.length]); }
function cycleSize(d) { const ks = Object.keys(SIZES), k = ks.indexOf(sel.s); select(null, ks[Math.max(0, Math.min(ks.length - 1, k + d))]); }
function rotateSel() { sel.r = ((sel.r || 0) + config.rotStep) % 360; select(); }
function typing(t) { return t && t.closest && t.closest("input,textarea,select,[contenteditable]"); }
function startHold(k, fn) {
  if (holds[k]) return; fn();
  holds[k] = { t: setTimeout(() => { holds[k].i = setInterval(fn, config.repeatEvery); }, config.repeatDelay) };
}
function stopHold(k) { const h = holds[k]; if (!h) return; clearTimeout(h.t); clearInterval(h.i); delete holds[k]; }
addEventListener("keydown", e => {
  if (!active() || typing(e.target)) return;
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if ((e.ctrlKey || e.metaKey) && k === "y") { e.preventDefault(); redo(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (k === " " || e.code === "Space") { e.preventDefault(); if (!e.repeat) startHold("space", () => { if (hover) place(hover.i, hover.j); }); return; }
  if (k === "d") { e.preventDefault(); if (!e.repeat) startHold("d", () => { if (hover) remove(hover.i, hover.j); }); return; }
  if (k === "q") { e.preventDefault(); cycleType(-1); return; }
  if (k === "e") { e.preventDefault(); cycleType(1); return; }
  if (k === "w") { e.preventDefault(); cycleSize(1); return; }
  if (k === "s") { e.preventDefault(); cycleSize(-1); return; }
  if (k === "r") { e.preventDefault(); rotateSel(); return; }
  if (k === "escape" && expanded) { e.preventDefault(); collapse(); }
}, true);
addEventListener("keyup", e => { const k = e.key.toLowerCase(); if (k === " " || e.code === "Space") stopHold("space"); if (k === "d") stopHold("d"); });
addEventListener("blur", () => { stopHold("space"); stopHold("d"); });

/* ---------------- 昼夜 ---------------- */
function themeNight() { return document.documentElement.getAttribute("data-theme") === "dark"; }
function refreshNight() {
  const n = themeNight();
  if (n !== night || !scene) { night = n; if (scene) applyPalette(); emit("night", night); }
}

/* ---------------- 界面：右下角、展开窗口、底部选择栏 ---------------- */
const UNDO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/></svg>';
const REDO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m15 14 5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/></svg>';
const extraButtons = [];                 // addButton() 新增的按钮
function addButton(b) { extraButtons.push(b); renderBar(); }
function renderBar() {
  if (!bar) return;
  bar.innerHTML = '<div class="cb-group">' + ORDER.map(id => { const d = FLOORS.get(id);
      return '<button class="cb-btn' + (sel.t === id ? ' on' : '') + '" data-t="' + id + '" title="' + d.name + '">' + (d.icon || d.name.slice(0, 1)) + '</button>'; }).join("") + '</div>'
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
function expand() {
  if (expanded) return; expanded = true;
  pop.classList.add("show"); mount(popStage); emit("expand");
}
function collapse() {
  if (!expanded) return; expanded = false;
  stopHold("space"); stopHold("d"); setHover(null);
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
  .city-win{position:relative;width:min(1120px,100%);height:min(780px,100%);background:var(--card);border-radius:var(--r,2px);
    box-shadow:var(--sh5);display:flex;flex-direction:column;overflow:hidden;transform:scale(.97);transition:transform var(--d3,320ms) var(--e-out,ease)}
  .city-pop.show .city-win{transform:none}
  .city-pop.night .city-win{background:#15161d}
  .city-stage{position:relative;flex:1;min-height:0}
  .city-bar{display:flex;align-items:center;justify-content:center;gap:12px;flex-wrap:wrap;padding:10px 16px;
    border-top:1px solid var(--line-s);background:var(--card)}
  .city-pop.night .city-bar{background:#1b1d27;border-top-color:#262a3a}
  .cb-group{display:flex;gap:4px}
  .cb-sep{width:1px;height:24px;background:var(--line)}
  .cb-btn{width:40px;height:40px;display:flex;align-items:center;justify-content:center;border:1px solid transparent;border-radius:var(--r,2px);
    background:transparent;color:var(--text-soft);cursor:pointer;padding:8px;font-family:var(--mono);font-size:12px;font-weight:700;
    transition:background-color var(--d1,120ms) var(--e-out,ease),color var(--d1,120ms) var(--e-out,ease),border-color var(--d1,120ms) var(--e-out,ease)}
  .cb-btn svg{width:22px;height:22px}
  .cb-btn:hover{background:color-mix(in srgb,var(--text) 6%,transparent);color:var(--text)}
  .cb-btn.on{border-color:var(--accent);color:var(--accent);background:color-mix(in srgb,var(--accent) 8%,transparent)}
  .cb-size{width:32px}
  .city-pop.night .cb-btn{color:#a9adc2}.city-pop.night .cb-btn.on{color:var(--accent)}
  `;
  document.head.appendChild(st);
}
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
  bar.addEventListener("mousedown", e => { if (e.target.closest(".cb-btn")) e.preventDefault(); });   // 不抢焦点，空格不会触发按钮
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
  started = true;
  night = themeNight();
  initThree(); buildUI(); bindPointer(renderer.domElement);
  mount(corner.querySelector(".city-host")); load(); updateGhost();
  emit("ready", api);
}

/* ---------------- 扩展接口 ----------------
   CityGame.registerFloor(def)     新增楼层类型（见上方 def 说明）
   CityGame.addButton({icon,title,onClick(api)})  在底部栏加按钮
   CityGame.on(事件, fn)            ready / place / remove / undo / redo / change / select / hover / night / expand / collapse / blocked / render / register
   CityGame.place(i,j[,t,s]) / remove(i,j) / undo() / redo() / clear()
   CityGame.select(t,s,r) / expand() / collapse()
   CityGame.exportJSON() / importJSON(data)
   CityGame.three / scene / camera / renderer / cells / config / sizes / helpers */
const api = {
  registerFloor, addButton, on, off, place, remove, undo, redo, clear: clearCity, select, expand, collapse, rotateBy,
  exportJSON, importJSON, config, sizes: SIZES, helpers, three: THREE,
  get floors() { return ORDER.map(id => FLOORS.get(id)); },
  get selected() { return Object.assign({}, sel); },
  get scene() { return scene; }, get camera() { return camera; }, get renderer() { return renderer; },
  get cells() { return cells; }, get night() { return night; }, get hover() { return hover; },
  refresh() { updateCamera(); req(); }
};
window.CityGame = api;
emit("loaded", api);
addEventListener("resize", start);
start();
