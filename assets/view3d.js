/* ============================================================
   view3d.js — 详情页「3D 立体」视图（懒加载：点了才拉代码和数据）

   数据 data/3d/<盒型ID>.json 由 tools 侧的生成器产出，内容是折叠器的
   **最小输入集**（面板轮廓 + 三角形索引 + 铰链线 + 折角关键帧），不是烘好的帧。
   所以浏览器端跑的是同一套折叠算法，折叠动画是白送的。

   算法与 _fold4.mjs / 官方 UI 引擎同源：
     M_child = M_parent · R(铰链线, θ(t))，θ 由 FoldLine 关键帧按官方
     getCurrentAngle 语义插值（数组短的先折完停住，数组长的贯穿全轴）。

   两个数据来源，结构完全相同，渲染/动画/交互零分支：
     ① load(id)         → 静态 data/3d/<ID>.json（原始尺寸，0 请求，可缓存）
     ② load(id, {pms})  → POST /api/box3d 让官方按**当前尺寸**重算折叠树
        （用户改过尺寸时走这条；抽样 24 盒发现约 1/5 的盒型折角会随尺寸变，
          所以必须重新问一次官方，不能自己按比例缩放几何糊过去）
   ============================================================ */

/* ---------- 4×4 变换（与 _fold4.mjs 逐字同源） ---------- */

const I4 = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function mul(a, b) {
  const o = new Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
    o[c * 4 + r] = s;
  }
  return o;
}

function xform(m, p) {
  const x = p[0], y = p[1], z = p[2];
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}

/** 绕「过 p、方向 u」的轴旋转 deg 度 */
function rotAxis(p, u, deg) {
  const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a), t = 1 - c;
  const x = u[0], y = u[1], z = u[2];
  const R = [
    t * x * x + c, t * x * y - s * z, t * x * z + s * y,
    t * x * y + s * z, t * y * y + c, t * y * z - s * x,
    t * x * z - s * y, t * y * z + s * x, t * z * z + c,
  ];
  const m = I4();
  for (let r = 0; r < 3; r++) for (let cc = 0; cc < 3; cc++) m[cc * 4 + r] = R[r * 3 + cc];
  const rx = R[0] * p[0] + R[1] * p[1] + R[2] * p[2];
  const ry = R[3] * p[0] + R[4] * p[1] + R[5] * p[2];
  const rz = R[6] * p[0] + R[7] * p[1] + R[8] * p[2];
  m[12] = p[0] - rx; m[13] = p[1] - ry; m[14] = p[2] - rz;
  return m;
}

/** 官方 FoldLine.getCurrentAngle 的逐字翻译 */
function angleAt(kf, t, step) {
  if (!kf || !kf.length) return 0;
  const T = Math.max(step || kf.length, kf.length) - 1;
  if (t <= 0 || kf.length === 1) return kf[0];
  if (t >= 1) return kf[kf.length - 1];
  const r = T * t, i = Math.floor(r);
  return i >= kf.length - 1
    ? kf[kf.length - 1]
    : kf[i] + (r - i) * (kf[i + 1] - kf[i]);
}

/**
 * 按进度 t 求每个面板的变换矩阵。
 * ❗ 不能拿 M[i] 当「已访问」判断（节点入队时就已赋值，会把整棵子树跳过）。
 *   这里靠 `M[k]` 只拦重复入队，语义与官方一致。
 */
function buildM(P, t, step, M) {
  const n = P.length;
  for (let i = 0; i < n; i++) M[i] = null;
  const st = [];
  for (let i = 0; i < n; i++) if (P[i].p < 0) st.push([i, I4()]);
  while (st.length) {
    const cur = st.shift(), i = cur[0], m = cur[1];
    M[i] = m;
    for (let k = 0; k < n; k++) {
      if (P[k].p !== i || M[k]) continue;
      let mm = m;
      const L = P[k].L;
      if (L) {
        const dx = L[2] - L[0], dy = L[3] - L[1], len = Math.hypot(dx, dy) || 1;
        mm = mul(m, rotAxis([L[0], L[1], 0], [dx / len, dy / len, 0], angleAt(L[4], t, step)));
      }
      M[k] = mm; st.push([k, mm]);
    }
  }
  /* 兜底：悬空父引用 / 数据异常时不让面整块消失（与折叠器同口径） */
  for (let i = 0; i < n; i++) if (!M[i]) M[i] = I4();
  return M;
}

/* ---------- 依赖（点了才下载，且只下一次） ---------- */

const BASE = new URL('./vendor/three/', import.meta.url);
let _libs = null;

function libs() {
  if (!_libs) {
    _libs = Promise.all([
      import(new URL('three.module.js', BASE).href),
      import(new URL('OrbitControls.js', BASE).href)
    ]).then(function (r) {
      return { THREE: r[0], OrbitControls: r[1].OrbitControls };
    });
  }
  return _libs;
}

function dataURL(id) {
  return new URL('../data/3d/' + encodeURIComponent(id) + '.json', import.meta.url).href;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function r1(v) { return Math.round(v * 10) / 10; }
function r2(v) { return Math.round(v * 100) / 100; }

/* ============================================================
   官方实时数据 → 内部紧凑格式
   ------------------------------------------------------------
   官方 /uc/LinTest3D 的 Box3D 是「键不带引号的类 JSON 字面量」，
   如 {Border:[-219,-324,438,125,1],Rel:["M0",…],Planes:[…]}。

   ❗不用 eval / new Function 解析：这段代码跑在用户浏览器里，
     站点一旦加 CSP 就会整块挂掉。改成逐字符扫描 + 补键引号 + JSON.parse。
     与官方原格式的等价性已用全站 1293 盒逐盒比对过（见 _v3d_parse_check.mjs）。
   ============================================================ */

function isWS(ch) {
  return ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t';
}

function parseLoose(src) {
  if (typeof src !== 'string') return src;
  var out = '', i = 0, n = src.length;
  while (i < n) {
    var c = src.charAt(i);
    if (c === '"' || c === "'") {                 // 字符串：整段原样搬运（含转义）
      var q = c;
      out += c; i++;
      while (i < n) {
        var d = src.charAt(i);
        out += d; i++;
        if (d === '\\') { out += src.charAt(i); i++; continue; }
        if (d === q) break;
      }
      continue;
    }
    if (c === '{' || c === ',') {                 // 「键」只可能出现在 { 或 , 之后
      out += c; i++;
      var ws = i;
      while (i < n && isWS(src.charAt(i))) i++;
      out += src.slice(ws, i);
      var m = /^([A-Za-z_$][A-Za-z0-9_$]*)\s*:/.exec(src.slice(i, i + 80));
      if (m) { out += '"' + m[1] + '":'; i += m[0].length; }
      continue;
    }
    out += c; i++;
  }
  return JSON.parse(out.replace(/,\s*([}\]])/g, '$1'));
}

/**
 * 官方 Box3D + BoxJson → 与 data/3d/<ID>.json 完全同构的对象。
 * 逐条对应 _fold4.mjs 的 officialModel：Rel 建父子、FoldLine 端点 y 取反、
 * 顶点 y 取反、按父链求连通分量、分量沿 X 错开摆一排。
 * 折叠矩阵不必在这里算 —— 渲染时 buildM 会按进度实时求。
 */
function fromOfficial(raw, id) {
  var b3 = parseLoose(raw.Box3D);
  var names = b3.Rel || [];
  var short = function (s) { return String(s).split(':')[0]; };
  var idxOf = new Map();
  for (var k = 0; k < names.length; k++) idxOf.set(short(names[k]), k);

  var n = b3.Planes.length;
  var P = new Array(n);
  var c = new Array(n).fill(-1);
  var maxStep = 2;

  for (var i = 0; i < n; i++) {
    var pl = b3.Planes[i] || {};
    var nm = String(names[i] == null ? '' : names[i]);
    var parts = nm.split(':');
    var pName = parts.length > 1 ? parts.slice(1).join(':') : null;
    var parent = -1;
    if (pName !== null) {
      if (idxOf.has(pName)) parent = idxOf.get(pName);
      else for (var t = 0; t < names.length; t++) if (short(names[t]) === pName) { parent = t; break; }
    }
    /* FoldLine = [x1,y1,x2,y2,[折角关键帧…]]；官方整条管线跑在 Y 镜像系，这里同步取反。
       折角实测全是纯数字（全站 30091 组关键帧、0 个 JS 表达式），不需再求值。 */
    var L = null, fl = pl.FoldLine;
    if (fl && fl.length >= 4) {
      var kf = null;
      for (var f = 4; f < fl.length; f++) if (fl[f] && fl[f].length !== undefined) { kf = fl[f]; break; }
      var src = kf || [0], kfa = [];
      for (var a = 0; a < src.length; a++) {
        var av = src[a];
        kfa.push(typeof av === 'number' ? av : (Number(av) || 0));
      }
      if (kfa.length > maxStep) maxStep = kfa.length;
      L = [fl[0], -fl[1], fl[2], -fl[3], kfa];
    }
    var vs = pl.Vertices || [], v = [];
    for (var z = 0; z + 1 < vs.length; z += 2) v.push(r2(vs[z]), r2(-vs[z + 1]));
    P[i] = { p: parent, v: v, f: (pl.Faces || []).slice(), L: L };
  }

  /* 连通分量：按父链 BFS（与 officialModel 同口径，扫描顺序也一致） */
  var kids = new Array(n);
  for (var k2 = 0; k2 < n; k2++) kids[k2] = [];
  for (var k3 = 0; k3 < n; k3++) { var pp = P[k3].p; if (pp >= 0 && pp < n) kids[pp].push(k3); }
  function mark(root, comp) {
    var q = [root]; c[root] = comp;
    while (q.length) {
      var cur = q.shift(), ks = kids[cur];
      for (var u = 0; u < ks.length; u++) if (c[ks[u]] < 0) { c[ks[u]] = comp; q.push(ks[u]); }
    }
  }
  var nc = 0;
  for (var i2 = 0; i2 < n; i2++) if (P[i2].p < 0) mark(i2, nc++);
  for (var i3 = 0; i3 < n; i3++) if (c[i3] < 0) mark(i3, nc++);   // 悬空/环形兜底，别让面凭空消失

  /* 分量沿 X 错开（保持展开图左右顺序）—— 多件拼版刀模才不会叠在一起 */
  var compX = new Array(nc), co = new Array(nc).fill(0);
  for (var i4 = 0; i4 < n; i4++) {
    var vv = P[i4].v;
    if (!vv.length) continue;
    var x0 = Infinity, x1 = -Infinity;
    for (var w = 0; w < vv.length; w += 2) { if (vv[w] < x0) x0 = vv[w]; if (vv[w] > x1) x1 = vv[w]; }
    var bx = compX[c[i4]];
    if (!bx) compX[c[i4]] = [x0, x1];
    else { if (x0 < bx[0]) bx[0] = x0; if (x1 > bx[1]) bx[1] = x1; }
  }
  var order = [];
  for (var ci = 0; ci < nc; ci++) if (compX[ci]) order.push(ci);
  order.sort(function (a2, b2) { return compX[a2][0] - compX[b2][0]; });
  var acc = 0;
  for (var oi = 0; oi < order.length; oi++) {
    var cc = order[oi], bb = compX[cc];
    co[cc] = r2(acc - bb[0]);
    acc += (bb[1] - bb[0]) + 20;
  }
  for (var i5 = 0; i5 < n; i5++) P[i5].c = c[i5] < 0 ? 0 : c[i5];

  return { i: id, s: maxStep, nc: nc, co: co, P: P, custom: 1 };
}

/* 实时重折叠接口（站点根下，GitHub Pages 子路径也能正确解析） */
const API3D = new URL('../api/box3d', import.meta.url).href;

/* ---------- 自动折叠的时间参数 ----------
   官方（lin3d.min.js 的 ft()）是一条 TWEEN：0→1 走 timeOfFold（默认 8000ms）后
   .repeat(Infinity).yoyo(true) 无限往复，两端**不停**；速度由「自动折叠速度」滑块调。

   这里按用户要求改成：单程 3.8s（比原来 1.5s 慢一倍多，也不至于像官方 8s 那么拖），
   到首帧（全展开）和末帧（全折好）各停 2 秒再掉头。 */
const SPEED_SLOW = 6000;    // 滑块最左：单程 6s
const SPEED_FAST = 1400;    // 滑块最右：单程 1.4s
const SPEED_DEF = 50;       // 默认落在中间 → 3.7s
const DWELL_MS = 2000;      // 首末帧停留

function speedToMs(v) { return Math.round(SPEED_SLOW + (SPEED_FAST - SPEED_SLOW) * v / 100); }

/* ---------- 视图实例 ---------- */

/**
 * @param host  容器元素（绝对定位铺满的中栏画布）
 * @param onInfo 数据加载完成后的回调：({id, planes, hinges, comps, size, tris})
 */
export function create(host, onInfo) {
  host.innerHTML =
    '<div class="v3d-stage"></div>' +
    /* 视角类放画布右上角（动画类放底部条）—— 两类操作分开，底栏就不用挤成一条 */
    '<div class="v3d-hud">' +
      '<span class="v3d-chip">加载中…</span>' +
      '<div class="v3d-viewbtns">' +
        '<button class="v3d-btn v3d-rot" type="button" title="让模型自己慢慢转圈，方便看背面">自动旋转</button>' +
        '<button class="v3d-btn v3d-home" type="button" title="回到刚进来时的视角（不改动自动折叠 / 自动旋转的开关）">复位视角</button>' +
      '</div>' +
    '</div>' +
    '<div class="v3d-bar">' +
      '<button class="v3d-btn v3d-play" type="button">▶ 自动折叠</button>' +
      '<input class="v3d-range" type="range" min="0" max="1000" step="1" value="1000" aria-label="折叠进度">' +
      '<b class="v3d-pct">100%</b>' +
      '<i class="v3d-sep"></i>' +
      '<span class="v3d-lab">折叠速度 慢</span>' +
      '<input class="v3d-spd" type="range" min="0" max="100" step="1" value="' + SPEED_DEF + '" aria-label="自动折叠速度">' +
      '<span class="v3d-lab">快</span>' +
    '</div>' +
    '<div class="v3d-msg" hidden></div>';

  const stage = host.querySelector('.v3d-stage');
  const chip = host.querySelector('.v3d-chip');
  const msgEl = host.querySelector('.v3d-msg');
  const bar = host.querySelector('.v3d-bar');
  const range = host.querySelector('.v3d-range');
  const pctEl = host.querySelector('.v3d-pct');
  const playBtn = host.querySelector('.v3d-play');
  const homeBtn = host.querySelector('.v3d-home');
  const rotBtn = host.querySelector('.v3d-rot');
  const spd = host.querySelector('.v3d-spd');

  let THREE = null, OrbitControls = null;
  let renderer = null, scene = null, camera = null, controls = null, grid = null;
  let group = null, meshes = [], mats = [];
  let data = null, M = [], t = 1, visible = false, raf = 0, lastTs = 0;
  /* playing: 0 停 / +1 往折好的方向走 / -1 往展开的方向走
     hold:    端点停留剩余毫秒（>0 时不动，数完掉头） */
  let playing = 0, hold = 0, legMs = speedToMs(SPEED_DEF);
  let wasPlaying = 0;               // 切去 2D 时正在播的那个方向，回来时接上
  let home = null, info = null, bbox = null, mainComp = -1;

  /* ---------- 渲染器（首次需要时创建） ---------- */

  function ensureGL() {
    if (renderer) return true;
    if (!THREE) return false;
    const w = Math.max(1, stage.clientWidth), h = Math.max(1, stage.clientHeight);

    /* ❗ 背景透明：3D 直接坐在中栏那张「绘图坐标纸」上，和展开图同一个底，
       切进切出不会突兀地换背景。
       preserveDrawingBuffer 打开：代价很小，但换来「读像素可验收」+ 以后能直接
       把当前视角 toDataURL 存成图片（否则读到的永远是空白帧）。 */
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setClearColor(0x000000, 0);
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.setSize(w, h, false);
    stage.appendChild(renderer.domElement);

    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(35, w / h, 1, 200000);

    /* 鼠标操作：左键拖拽旋转 / 中键拖拽平移 / 滚轮缩放
       ❗右键不绑任何动作。OrbitControls 默认 RIGHT: PAN（官方那套也是右键平移），
       这里刻意改成中键；RIGHT 置 null 后 onMouseDown 的 switch 走 default → state=NONE，
       右键彻底不响应（不是「换了个动作」，是真的没动作）。 */
    controls = new OrbitControls(camera, renderer.domElement);
    controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.PAN,
      RIGHT: null
    };
    controls.enableRotate = true;
    controls.enableZoom = true;
    controls.enablePan = true;
    controls.enableDamping = true;
    controls.dampingFactor = 0.09;
    controls.rotateSpeed = 0.85;
    controls.zoomSpeed = 0.9;
    controls.minPolarAngle = 0.02;
    controls.maxPolarAngle = Math.PI - 0.02;
    controls.autoRotate = false;
    controls.autoRotateSpeed = 1.6;

    /* 抓取手势：让人一眼看出这块能拖 */
    const cv = renderer.domElement;
    /* ❗中键按住还会触发 Chrome/Edge 自带的「自动滚动」圆盘（松开后页面开始自己滚），
       跟拖拽平移打架。OrbitControls 只管 pointerdown，不会拦这个 —— 自己吃掉 mousedown 默认行为。 */
    cv.addEventListener('mousedown', function (e) { if (e.button === 1) e.preventDefault(); });
    cv.addEventListener('pointerdown', function () { stage.classList.add('is-drag'); });
    window.addEventListener('pointerup', function () { stage.classList.remove('is-drag'); });
    cv.addEventListener('pointercancel', function () { stage.classList.remove('is-drag'); });

    /* ⚠ 光照总系数别过 1（three r155+ 物理光照模式下会叠加，
       一过曝纸板色被 clamp 成白色，就分不出面了）。 */
    scene.add(new THREE.AmbientLight(0xffffff, 0.52));
    const d1 = new THREE.DirectionalLight(0xffffff, 0.65); d1.position.set(-0.6, 1, 0.8); scene.add(d1);
    const d2 = new THREE.DirectionalLight(0xffffff, 0.35); d2.position.set(0.9, -0.4, -0.7); scene.add(d2);
    const d3 = new THREE.DirectionalLight(0xffffff, 0.28); d3.position.set(0.2, -1, 0.9); scene.add(d3);

    grid = new THREE.GridHelper(4000, 40, 0xd7dce4, 0xe6eaf0);
    grid.material.transparent = true;
    grid.material.opacity = 0.75;
    scene.add(grid);

    return true;
  }

  /* ---------- 载入 / 重建 ---------- */

  function clearMeshes() {
    if (!group) return;
    for (let i = 0; i < meshes.length; i++) {
      meshes[i].geometry.dispose();
      mats[i].dispose();
    }
    scene.remove(group);
    if (THREE) group = new THREE.Group();
    meshes = []; mats = [];
  }

  function build() {
    const P = data.P, n = P.length;
    clearMeshes();
    if (!group) group = new THREE.Group();
    scene.add(group);

    /* 主分量 = 面积最大的那个连通分量（拼版刀模有多个独立盒子，
       相机与网格按主分量定位，其余分量沿 X 错开摆一排） */
    const nc = data.nc || 0;
    const area = new Array(Math.max(1, nc)).fill(0);
    for (let i = 0; i < n; i++) {
      const p = P[i];
      let a = 0;
      for (let k = 0; k + 2 < p.f.length; k += 3) {
        const A0 = p.f[k] * 2, B0 = p.f[k + 1] * 2, C0 = p.f[k + 2] * 2;
        a += Math.abs(
          (p.v[B0] - p.v[A0]) * (p.v[C0 + 1] - p.v[A0 + 1]) -
          (p.v[C0] - p.v[A0]) * (p.v[B0 + 1] - p.v[A0 + 1])
        ) / 2;
      }
      area[p.c] = (area[p.c] || 0) + a;
    }
    mainComp = 0;
    for (let c = 0; c < area.length; c++) if (area[c] > area[mainComp]) mainComp = c;

    for (let i = 0; i < n; i++) {
      const p = P[i];
      if (!p.v.length || !p.f.length) continue;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(p.v.length / 2 * 3), 3));
      geo.setIndex(p.f.slice());
      const mat = new THREE.MeshStandardMaterial({
        /* 纸板色：暖调，面板之间轻微错开明度，折起来才看得清都是哪些面 */
        color: new THREE.Color().setHSL(0.09 + (i % 7) * 0.010, 0.30, 0.66 - (i % 5) * 0.030),
        side: THREE.DoubleSide,
        roughness: 0.86,
        metalness: 0.02,
        flatShading: true
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.userData.i = i;
      mesh.frustumCulled = false;   // 顶点每帧都在动，交给引擎算包围球不如直接不过滤
      group.add(mesh);
      meshes.push(mesh); mats.push(mat);
    }

    applyProgress(1, true);         // 先把顶点写进去（否则包围盒退化成一个点）
    fitCamera();
    geoNormalsOnce();
  }

  function geoNormalsOnce() {
    for (let i = 0; i < meshes.length; i++) meshes[i].geometry.computeVertexNormals();
  }

  /* ---------- 每帧顶点（three 坐标 = (x, z, -y)：把抬升方向摆成世界的「上」） ---------- */

  function applyProgress(tt, noRender) {
    t = Math.max(0, Math.min(1, tt));
    if (!data) return;
    const P = data.P, co = data.co || [];
    buildM(P, t, data.s, M);
    for (let mi = 0; mi < meshes.length; mi++) {
      const mesh = meshes[mi], i = mesh.userData.i, p = P[i];
      const arr = mesh.geometry.attributes.position.array;
      const off = co[p.c] || 0;
      for (let k = 0, j = 0; k < p.v.length; k += 2, j += 3) {
        const q = xform(M[i], [p.v[k], p.v[k + 1], 0]);
        arr[j] = q[0] + off;
        arr[j + 1] = q[2];
        arr[j + 2] = -q[1];
      }
      mesh.geometry.attributes.position.needsUpdate = true;
    }
    range.value = String(Math.round(t * 1000));
    pctEl.textContent = Math.round(t * 100) + '%';
    if (!noRender) render();
  }

  function fitCamera() {
    const box = new THREE.Box3();
    let first = true;
    for (let mi = 0; mi < meshes.length; mi++) {
      const mesh = meshes[mi];
      const P = data.P, p = P[mesh.userData.i];
      if (p.c !== mainComp) continue;          // 只按主分量取景
      const arr = mesh.geometry.attributes.position.array;
      for (let j = 0; j < arr.length; j += 3) {
        const v = new THREE.Vector3(arr[j], arr[j + 1], arr[j + 2]);
        if (first) { box.set(v, v); first = false; } else box.expandByPoint(v);
      }
    }
    if (first) { box.set(new THREE.Vector3(0, 0, 0), new THREE.Vector3(100, 100, 100)); }
    bbox = box;

    const size = box.getSize(new THREE.Vector3());
    const ctr = box.getCenter(new THREE.Vector3());
    const mx = Math.max(size.x, size.y, size.z) || 100;
    home = {
      pos: new THREE.Vector3(ctr.x + mx * 1.15, ctr.y + mx * 0.95, ctr.z + mx * 1.5),
      tgt: ctr.clone(),
      near: mx / 500, far: mx * 60
    };
    resetView();

    grid.position.y = box.min.y;
    grid.scale.setScalar(Math.max(1, mx / 300));

    info = {
      id: data.i,
      custom: !!data.custom,          // true = 按用户改后的尺寸现算的
      planes: data.P.length,
      hinges: data.P.filter(function (p) { return p.L; }).length,
      comps: data.nc || 1,
      steps: data.s,
      /* three 坐标系里 (x, y, z) 恰好对应 长 × 宽 × 高 —— 实测 400 盒：
         model X↔长(88%)、model Z↔宽(67%)、model Y↔高(55%，多数家族)，而 three 正好是
         (modelX, modelZ, −modelY)，合起来就是 (长, 宽, 高)。 */
      size: [r1(size.x), r1(size.y), r1(size.z)],
      tris: data.P.reduce(function (a, p) { return a + p.f.length / 3; }, 0) | 0,
      verts: data.P.reduce(function (a, p) { return a + p.v.length / 2; }, 0) | 0
    };
    chip.innerHTML = '<b>' + esc(data.i) + '</b> · 面板 ' + info.planes +
      ' · 铰链 ' + info.hinges + (info.comps > 1 ? ' · 拼版 ' + info.comps + ' 件' : '') +
      ' · 折叠后 ' + info.size.join(' × ') + ' mm';
    if (onInfo) onInfo(info);
  }

  /**
   * 复位视角。
   *
   * ❗enableDamping 打开时 OrbitControls 把「残余角速度」藏在内部闭包里
   *   （sphericalDelta / panOffset），只复制 position/target 的话，复位完成后
   *   还会继续往老方向飘一小段，看起来「按了没回到原位」。
   *   唯一能把它们清零的路径是走 update() 的**非阻尼分支** —— 所以：
   *     ① 先临时关掉阻尼、用当前姿态 update 一次 → 残余清零
   *     ② 残余已是 0，这时再把相机摆到 home 才真的不动
   */
  function resetView() {
    if (!home) return;
    const damping = controls.enableDamping;
    controls.enableDamping = false;
    controls.target.copy(home.tgt);
    controls.update();
    camera.position.copy(home.pos);
    camera.near = home.near; camera.far = home.far;
    camera.updateProjectionMatrix();
    controls.update();
    controls.enableDamping = damping;
  }

  function render() {
    if (!renderer || !visible) return;
    controls.update();
    renderer.render(scene, camera);
  }

  /* ---------- 尺寸 / 可见性 ---------- */

  function resize() {
    if (!renderer) return;
    const w = Math.max(1, stage.clientWidth), h = Math.max(1, stage.clientHeight);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    render();
  }

  let ro = null;
  if (window.ResizeObserver) {
    ro = new ResizeObserver(function () { if (visible) resize(); });
    ro.observe(stage);
  }

  /**
   * 自动折叠推进一帧。dms = 这一帧过了多少毫秒。
   *
   * 状态机：走到底 → 停 DWELL_MS → playing 反向 → 再走到底 → 再停 → 无限循环。
   *
   * ❗只在「这一程自己要到达的那一端」判到站：第一帧 dms=0 → next 恰好等于当前值，
   *   若两端都判（next<=0 也算到站）会当场停住，动画根本不动（老代码在这里踩过坑）。
   */
  function advance(dms) {
    if (hold > 0) {
      hold -= dms;
      if (hold > 0) return;
      hold = 0;
      playing = -playing;                       // 停留结束 → 掉头
      return;
    }
    const next = t + playing * dms / legMs;
    if (playing > 0 ? next >= 1 : next <= 0) {
      applyProgress(playing > 0 ? 1 : 0, true);
      hold = DWELL_MS;                          // 到端点 → 停 2 秒
    } else {
      applyProgress(next, true);
    }
  }

  function loop(ts) {
    if (!visible) return;
    raf = requestAnimationFrame(loop);
    const dt = lastTs ? Math.min(0.05, (ts - lastTs) / 1000) : 0;
    lastTs = ts;
    if (playing) advance(dt * 1000);
    render();
  }

  function startLoop() {
    if (raf) return;
    lastTs = 0;
    raf = requestAnimationFrame(loop);
  }
  function stopLoop() { if (raf) cancelAnimationFrame(raf); raf = 0; }

  function startPlay(dir) {
    if (!data || (data.s || 1) <= 1) return;
    const d = dir || 1;
    /* 朝折好的方向走、又已经折好了 → 从头演示；朝展开方向走就别去动它 */
    if (d > 0 && t >= 0.999) applyProgress(0, true);
    playing = d;
    hold = 0;
    playBtn.textContent = '⏸ 暂停';
    playBtn.classList.add('on');
  }

  function stopPlay() {
    playing = 0;
    hold = 0;
    playBtn.textContent = '▶ 自动折叠';
    playBtn.classList.remove('on');
  }

  /* ---------- 对外 ---------- */

  const api = {
    visible: function () { return visible; },
    info: function () { return info; },

    setVisible: function (v) {
      visible = !!v;
      if (!visible) {
        wasPlaying = playing;                    // 记住是「正在往哪边走」，切回来接着走
        stopLoop(); stopPlay();
        return;
      }
      if (!renderer) { if (!ensureGL()) return; }
      resize();
      startLoop();
      /* 切去 2D 前正在自动折叠 → 切回来接着放，否则会让人以为按钮失灵 */
      if (wasPlaying && data && !playBtn.hidden) startPlay(wasPlaying);
    },

    /**
     * @param id   盒型 ID
     * @param opts { pms } —— 给了 pms 就走「实时重折叠」：让官方按这组尺寸现算折叠树。
     *             返回两种来源都是同一种结构，下游零分支。
     */
    load: function (id, opts) {
      var pms = opts && opts.pms;
      setMsg(pms ? '正在按当前尺寸重新折叠…' : '正在加载 3D 数据…');
      bar.hidden = true;
      return libs().then(function (L) {
        THREE = L.THREE; OrbitControls = L.OrbitControls;
        ensureGL();
        if (pms) {
          /* 走站内代理（浏览器不能跨域直连官方） */
          return fetch(API3D, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ boxID: id, inPms: pms })
          }).then(function (r) {
            return r.text().then(function (txt) {
              /* 代理是原样透传上游响应（见 server.js / worker.js 注释），
                 所以这里直接就是官方的 {BoxJson, LineExp, Box3D, …} */
              var j = null;
              try { j = JSON.parse(txt); } catch (e2) { j = null; }
              if (!r.ok || !j || !j.Box3D) {
                var e3 = new Error((j && j.error) || ('求解服务返回 ' + r.status));
                e3.code = 'noapi';
                throw e3;
              }
              var packed = fromOfficial(j, id);
              /* 折叠结构是官方的属性，不随尺寸变 —— 这里没有就等于该盒型做不了 */
              if (!packed.P.some(function (p) { return p.L; })) {
                var e4 = new Error('no-fold-tree');
                e4.code = 'nofold';
                throw e4;
              }
              return packed;
            });
          });
        }
        return fetch(dataURL(id), { cache: 'force-cache' }).then(function (res) {
          if (!res.ok) {
            const e = new Error('no-fold-tree');
            e.code = 'nofold';
            throw e;
          }
          return res.json();
        });
      }).then(function (j) {
        data = j;
        playBtn.hidden = (data.s || 1) <= 1;      // 没有时序（单档）就不放动画按钮
        build();
        setMsg(null);
        bar.hidden = false;
        applyProgress(0, true);                    // 从展开态开始，自动折给你看
        if (!playBtn.hidden) startPlay();           // 折好 → 停 2 秒 → 展开 → 停 2 秒 → 循环
        /* ❗首次进入时 three 还在下载，setVisible(true) 那一下 renderer 还没建出来，
           循环起不来 —— 这里必须补一次，否则画面是空白的。 */
        if (visible) { resize(); startLoop(); }
        return info;
      }).catch(function (e) {
        if (e && e.code === 'nofold') {
          setMsg('该盒型官方没有提供折叠结构（多为平面件或对折卡），<br>暂时做不了 3D 立体图。');
        } else if (e && e.code === 'noapi') {
          setMsg('按当前尺寸重新折叠失败，已保留上一次的 3D 图。<br>' + esc(e.message));
        } else {
          setMsg('3D 视图启动失败：' + esc(e && e.message ? e.message : e));
        }
        throw e;
      });
    },

    setProgress: function (v) { stopPlay(); applyProgress(v); },

    /* 自动折叠：开关 / 速度 */
    play: function (on) { if (on === false) stopPlay(); else startPlay(); },
    isPlaying: function () { return !!playing; },
    setSpeed: function (v) {
      v = Math.max(0, Math.min(100, Number(v) || 0));
      spd.value = String(v);
      legMs = speedToMs(v);
      return legMs;
    },

    /* 自动旋转（官方那颗 fa-refresh 按钮） */
    autoRotate: function (on) {
      if (!controls) return false;
      controls.autoRotate = (on === undefined) ? !controls.autoRotate : !!on;
      rotBtn.classList.toggle('on', controls.autoRotate);
      return controls.autoRotate;
    },

    /* 验收探针用 */
    cam: function () {
      return camera ? [r2(camera.position.x), r2(camera.position.y), r2(camera.position.z)] : null;
    },
    state: function () {
      return {
        t: r2(t), playing: playing, hold: Math.round(hold),
        legMs: legMs, dwell: DWELL_MS,
        autoRotate: !!(controls && controls.autoRotate)
      };
    },

    home: resetView,
    resize: resize,

    dispose: function () {
      stopLoop();
      if (ro) { ro.disconnect(); ro = null; }
      if (scene) {
        clearMeshes();
        if (grid) { grid.geometry.dispose(); grid.material.dispose(); scene.remove(grid); grid = null; }
      }
      if (renderer) { renderer.dispose(); if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement); }
      renderer = null; scene = null; camera = null; controls = null; group = null; data = null;
    }
  };

  function setMsg(html) {
    if (html == null) { msgEl.hidden = true; msgEl.innerHTML = ''; }
    else { msgEl.hidden = false; msgEl.innerHTML = html; }
  }

  /* ---------- 交互 ---------- */

  playBtn.addEventListener('click', function () {
    if (!data) return;
    if (playing) stopPlay(); else startPlay();
  });

  /* 手动拖进度条就停下自动折叠（和官方拖滑块即停自动折叠一个道理），拖完可以再按播放 */
  range.addEventListener('input', function () {
    stopPlay();
    applyProgress(parseInt(range.value, 10) / 1000);
  });

  rotBtn.addEventListener('click', function () { api.autoRotate(); });

  spd.addEventListener('input', function () {
    legMs = speedToMs(parseInt(spd.value, 10) || 0);
  });

  homeBtn.addEventListener('click', function () { resetView(); render(); });

  /* 给无头验收用 */
  window.__v3d = api;
  return api;
}

/* 导出解析层给离线回归测试用：`node _v3d_parse_check.mjs` 会把本文件复制成 .mjs
   后直接 import，所以测的就是线上这一份源码，不存在「测试副本和线上不同步」。 */
export { parseLoose, fromOfficial };
