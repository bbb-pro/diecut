/* ============================================================
   view3d.js — 详情页「3D 立体」视图（懒加载：点了才拉代码和数据）

   数据 data/3d/<盒型ID>.json 由 tools 侧的生成器产出，内容是折叠器的
   **最小输入集**（面板轮廓 + 三角形索引 + 铰链线 + 折角关键帧），不是烘好的帧。
   所以浏览器端跑的是同一套折叠算法，折叠动画是白送的。

   算法与 _fold4.mjs 同源：
     M_child = M_parent · R(铰链线, θ(t))，θ 由 FoldLine 关键帧按
     getCurrentAngle 语义插值（数组短的先折完停住，数组长的贯穿全轴）。

   两个数据来源，结构完全相同，渲染/动画/交互零分支：
     ① load(id)         → 静态 data/3d/<ID>.json（原始尺寸，0 请求，可缓存）
     ② load(id, {pms})  → POST /api/box3d 按**当前尺寸**重算折叠树
        （用户改过尺寸时走这条；抽样 24 盒发现约 1/5 的盒型折角会随尺寸变，
          所以必须重新取一次，不能自己按比例缩放几何糊过去）
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

/** FoldLine.getCurrentAngle 的等价实现 */
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
 *   这里靠 `M[k]` 只拦重复入队。
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
  var u = new URL('../data/3d/' + encodeURIComponent(id) + '.json', import.meta.url);
  /* 继承 view3d.js 自己的缓存版本串（?v=xxx，由 tools/bump-assets.mjs 写入）：
     折叠树会随数据同步重抓，不带版本串的话老浏览器最长 4 小时拿到旧树，
     配上按新尺寸算出的几何会折歪（切 3D 时用 force-cache，更依赖这一点）。
     ⚠️ new URL(相对路径, import.meta.url) 不会把 query 传下去，必须显式补。 */
  var v = new URL(import.meta.url).searchParams.get('v');
  if (v) u.searchParams.set('v', v);
  return u.href;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function r1(v) { return Math.round(v * 10) / 10; }
function r2(v) { return Math.round(v * 100) / 100; }

/* ============================================================
   接口实时返回的数据 → 内部紧凑格式
   ------------------------------------------------------------
   /uc/LinTest3D 返回的 Box3D 是「键不带引号的类 JSON 字面量」，
   如 {Border:[-219,-324,438,125,1],Rel:["M0",…],Planes:[…]}。

   ❗不用 eval / new Function 解析：这段代码跑在用户浏览器里，
     站点一旦加 CSP 就会整块挂掉。改成逐字符扫描 + 补键引号 + JSON.parse。
     与原始格式的等价性已用全站 1293 盒逐盒比对过（见 _v3d_parse_check.mjs）。
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
 * 接口返回的 Box3D + BoxJson → 与 data/3d/<ID>.json 完全同构的对象。
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
    /* FoldLine = [x1,y1,x2,y2,[折角关键帧…]]；整条管线跑在 Y 镜像系，这里同步取反。
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

/* 实时重折叠接口
   ❗ 必须用【域名根】的绝对路径，不能用 new URL('../api/box3d', import.meta.url)。
      站点部署在子路径 /diecut/ 下，`../` 从 /diecut/assets/view3d.js 只退一层到
      /diecut/，于是 POST 打到 Pages 的静态托管 → 静态资源不收 POST → **405**。
      而 Worker 的路由挂在域名根的 /api/*，与站点在哪个子目录无关。
      本地看不出这个坑：本地站点根就是 /，相对路径恰好算对。
      与 detail.js 的 '/api/box' 保持同一口径。 */
const API3D = '/api/box3d';

/* ---------- 自动折叠的时间参数 ----------
   上游动画是一条 TWEEN：0→1 走 timeOfFold（默认 8000ms）后
   .repeat(Infinity).yoyo(true) 无限往复，两端**不停**；速度由「自动折叠速度」滑块调。

   这里按用户要求改成：单程 3.8s（比原来 1.5s 慢一倍多，也不至于拖到 8s），
   到首帧（全展开）和末帧（全折好）各停 2 秒再掉头。 */
const SPEED_SLOW = 6000;    // 滑块最左：单程 6s
const SPEED_FAST = 1400;    // 滑块最右：单程 1.4s
const SPEED_DEF = 50;       // 默认落在中间 → 3.7s
const DWELL_MS = 2000;      // 首末帧停留

function speedToMs(v) { return Math.round(SPEED_SLOW + (SPEED_FAST - SPEED_SLOW) * v / 100); }

/* 「纸厚」开关（视觉加厚）跟网格一样是纯视图偏好，自己存自己读。
   数值本身不存 —— 它来自盒型求解结果，换盒型就是另一个值。 */
const THICK_KEY = 'V2.v3dThick';
function readThickPref() {
  try { return localStorage.getItem(THICK_KEY) === '1'; } catch (e) { return false; }
}

/* ---------- 纸材质（「纸种底色」）

   所谓「颜色设置」其实是**预置材质贴图**：
     /Images/Cad/Paper/{wa,niu,jin,yin,qing,pink,red}_A.jpg
   已随站点下载到 assets/mat/（本地自带，离线可用，不依赖上游）。

   UV 直接取**展开图 2D 坐标 ÷ TEX_MM**：
   折叠是刚体变换，同一顶点的 UV 不变 → 贴图等于「印在同一张纸上」，
   折起来纹理跟着面板走，不会在折痕处撕开错位。 */
const TEX_MM = 160;         // 一张贴图代表 160mm 见方的纸面
const MAT_BASE = 'assets/mat/';
const PAPERS = [
  { k: 'plain', name: '纸板原色' },
  { k: 'wa',    name: '瓦楞纸', file: 'paper_wa_A.jpg' },
  { k: 'niu',   name: '牛皮纸', file: 'paper_niu_A.jpg' },
  { k: 'jin',   name: '金卡纸', file: 'paper_jin_A.jpg' },
  { k: 'yin',   name: '银卡纸', file: 'paper_yin_A.jpg' },
  { k: 'qing',  name: '青色纸', file: 'paper_qing_A.jpg' },
  { k: 'pink',  name: '粉色纸', file: 'paper_pink_A.jpg' },
  { k: 'red',   name: '红色纸', file: 'paper_red_A.jpg' },
];

/* ---------- 厚度（视觉加厚）与图稿贴图的状态 ----------
   加厚走「三明治」：外皮 +outer / 内皮 -inner（不对称，取自上游 ce.inner/outer），
   沿面板轮廓补侧壁。折叠仍绕 z=0 中性层旋转，所以贴图 UV 完全不用改。 */
const THICK_SIDE_COLOR = 0xc99b6a;   // 瓦楞断面色（官方 canvasCal 用的是这个）
let thick = { cal: 0, inner: 0, outer: 0, sign: 1 };
let artTex = null;        // 当前图稿纹理（CanvasTexture）
let artFit = 'stretch';   // stretch=铺满展开包围盒 / contain=保持图片比例居中
/* 图稿在展开图上的摆放：sx/sy 缩放倍数、rot 顺时针角度、dx/dy 位移（占包围盒宽/高的比例）。
   变换一律在**展开图 mm 空间**里做（先位移→再旋转→再缩放），
   2D 的 SVG transform 与 3D 的 UV 用同一套定义，两边才不会一个正一个反。 */
let artXf = { sx: 1, sy: 1, rot: 0, dx: 0, dy: 0 };
let bbox2 = null;         // 展开图包围盒 {x0,y0,x1,y1}（贴图归一化 UV 用）

/** 图稿落位区间（归一化）：stretch=铺满整个包围盒，contain=按图片比例居中留白 */
function fitUv(ratio, bw, bh) {
  let ux0 = 0, uy0 = 0, ux1 = 1, uy1 = 1;
  if (artFit === 'contain' && ratio > 0) {
    const rb = bw / bh;
    if (ratio > rb) {                            // 图更扁：上下留白
      const h = rb / ratio;
      uy0 = (1 - h) / 2; uy1 = uy0 + h;
    } else {                                     // 图更瘦：左右留白
      const w = ratio / rb;
      ux0 = (1 - w) / 2; ux1 = ux0 + w;
    }
  }
  return { ux0: ux0, uy0: uy0, ux1: ux1, uy1: uy1 };
}

/**
 * 摆放的逆变换：展开图归一化坐标 (nx, ny) → 图稿自己的 0..1 坐标（y 向下，未翻 V）。
 *
 * 正向定义（2D 的 SVG transform 就照这句写，见 detail.js applyArt2d）：
 *   图稿绕展开图中心顺时针转 rot → 按 sx/sy 缩放 → 平移 dx/dy（占包围盒宽/高的比例）
 * 这里反过来算：减位移 → 除缩放 → 反旋转 → 折算回图稿自己的 0..1。
 *
 * 全程在 **mm 空间** 里算 —— 在归一化空间里转会被非等比缩放拉歪（contain 时尤其明显）。
 * 3D 的 UV 与 2D 的 <image transform> 共用这一套定义，两边才不会一个正一个反。
 */
function xfUV(nx, ny, bw, bh, fw, fh) {
  const cs = Math.cos(artXf.rot * Math.PI / 180), sn = Math.sin(artXf.rot * Math.PI / 180);
  const qx = ((nx - 0.5) * bw - artXf.dx * bw) / (artXf.sx || 1);
  const qy = ((ny - 0.5) * bh - artXf.dy * bh) / (artXf.sy || 1);
  const mx = cs * qx + sn * qy;
  const my = -sn * qx + cs * qy;
  return [mx / fw + 0.5, my / fh + 0.5];
}
let artOf = [];           // 每面板两份 UV：[平铺 Float32Array, 归一化 Float32Array]

/** 边界边：只属于一个三角形的边 = 面板轮廓，用来补侧壁 */
function outlineEdges(p) {
  const cnt = new Map();
  for (let k = 0; k + 2 < p.f.length; k += 3) {
    const t = [p.f[k], p.f[k + 1], p.f[k + 2]];
    for (let e = 0; e < 3; e++) {
      const a = t[e], b = t[(e + 1) % 3];
      if (a === b) continue;
      const key = a < b ? a + ',' + b : b + ',' + a;
      const cur = cnt.get(key);
      if (cur) cur.n++;
      else cnt.set(key, { n: 1, a: a, b: b });
    }
  }
  const out = [];
  cnt.forEach(function (v) { if (v.n === 1) out.push([v.a, v.b]); });
  return out;
}

/* ---------- 视图实例 ---------- */

/**
 * @param host  容器元素（绝对定位铺满的中栏画布）
 * @param onInfo 数据加载完成后的回调：({id, planes, hinges, comps, size, tris})
 * @param onPaper 纸种/颜色变化回调：(k) —— 上层用来持久化
 */
export function create(host, onInfo, onPaper) {
  host.innerHTML =
    '<div class="v3d-stage"></div>' +
    /* 视角类放画布右上角（动画类放底部条）—— 两类操作分开，底栏就不用挤成一条 */
    '<div class="v3d-hud">' +
      '<span class="v3d-chip">加载中…</span>' +
      '<div class="v3d-viewbtns">' +
        '<button class="v3d-btn v3d-paper-t" type="button" aria-haspopup="true" aria-expanded="false"'
          + ' title="换纸张材质 / 盒体颜色">纸种 ⌄</button>' +
        '<button class="v3d-btn v3d-thick" type="button" aria-pressed="false"'
          + ' title="按纸板厚度把盒面挤成薄板（厚度取自盒型求解结果，开关注会被记住）">纸厚</button>' +
        '<button class="v3d-btn v3d-rot" type="button" title="让模型自己慢慢转圈，方便看背面">自动旋转</button>' +
        '<button class="v3d-btn v3d-home" type="button" title="回到刚进来时的视角（不改动自动折叠 / 自动旋转的开关）">复位视角</button>' +
        '<button class="v3d-btn v3d-gridb" type="button" aria-pressed="true"'
          + ' title="显示 / 隐藏脚下的地面网格（选择会记住）">网格</button>' +
        '<div class="v3d-paper" hidden></div>' +
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
  const paperBtn = host.querySelector('.v3d-paper-t');
  const paperPop = host.querySelector('.v3d-paper');
  const gridBtn = host.querySelector('.v3d-gridb');
  const thickBtn = host.querySelector('.v3d-thick');

  /* 网格开关（纯视图偏好，自己存自己读，不必上层转一手） */
  const GRID_KEY = 'V2.v3dGrid';
  function readGridPref() {
    try { return localStorage.getItem(GRID_KEY) !== '0'; } catch (e) { return true; }
  }

  let THREE = null, OrbitControls = null;
  let renderer = null, scene = null, camera = null, controls = null, grid = null;
  let group = null, meshes = [], mats = [], matsIn = [], matsSide = [];
  let data = null, M = [], t = 1, visible = false, raf = 0, lastTs = 0;
  /* playing: 0 停 / +1 往折好的方向走 / -1 往展开的方向走
     hold:    端点停留剩余毫秒（>0 时不动，数完掉头） */
  let playing = 0, hold = 0, legMs = speedToMs(SPEED_DEF);
  let wasPlaying = 0;               // 切去 2D 时正在播的那个方向，回来时接上
  let gridOn = readGridPref();      // 地面网格显隐（读数在 readGridPref 里做兜底）
  let thickOn = readThickPref();    // 「纸厚」按钮：开=按 cal 挤成薄板，关=零厚度曲面
  let thickSrc = { cal: 0, inner: 0, outer: 0 };   // 上游给的数值（上层每次重算后推过来）
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
       ❗右键不绑任何动作。OrbitControls 默认 RIGHT: PAN，
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
    grid.visible = gridOn;         // ❗ 首次建好就按记忆应用，否则每次进 3D 都会先闪一下网格
    scene.add(grid);
    syncGrid();

    return true;
  }

  /* ---------- 纸材质：纸种底色 ---------- */

  const texCache = {};
  let curPaper = 'plain', curTint = null;

  function paperTexture(file) {
    if (texCache[file]) return texCache[file];
    const t = new THREE.TextureLoader().load(MAT_BASE + file);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;   // 按 mm 平铺，必须能重复
    t.anisotropy = 4;
    if (THREE.SRGBColorSpace) t.colorSpace = THREE.SRGBColorSpace;
    texCache[file] = t;
    return t;
  }

  /* 把当前纸种套到全部面板材质。
     ❗ 不论贴图还是纯色，都按面板序号留一点明暗差 ——
     所有面完全同色时，折起来分不清哪块是哪块。 */
  function applyPaper() {
    if (!mats.length) return;
    let tex = null;
    for (let d = 0; d < PAPERS.length; d++) {
      if (PAPERS[d].k === curPaper && PAPERS[d].file) { tex = paperTexture(PAPERS[d].file); break; }
    }
    for (let i = 0; i < mats.length; i++) {
      const m = mats[i];
      const lvl = 1 - (i % 5) * 0.030;          // 0.88 ~ 1.00
      /* 有图稿时外面印图稿（UV 已切成归一化），纸纹让位 */
      if (artTex) {
        m.map = artTex;
        m.color.setScalar(1);
      } else if (tex) {
        m.map = tex;
        m.color.setScalar(lvl);                  // 压暗贴图，保留面的层次
      } else {
        m.map = null;
        if (curTint) {
          const c = new THREE.Color(curTint), h = { h: 0, s: 0, l: 0 };
          c.getHSL(h);
          m.color.setHSL(h.h, h.s, Math.max(0.06, Math.min(0.94, h.l * lvl)));
        } else {
          m.color.setHSL(0.09 + (i % 7) * 0.010, 0.30, 0.66 - (i % 5) * 0.030);
        }
      }
      m.needsUpdate = true;
      /* 内皮：不印图稿（盒内通常是空白或另一张图），保持纸色/纸纹，压暗一点点 */
      const mi = matsIn[i];
      if (mi) {
        mi.map = artTex ? null : tex;
        if (artTex || !tex) {
          mi.color.setHSL(0.09 + (i % 7) * 0.010, 0.24, 0.52 - (i % 5) * 0.024);
        } else {
          mi.color.setScalar(lvl * 0.82);
        }
        mi.needsUpdate = true;
      }
    }
    if (renderer) render();
  }

  /* ---------- 图稿贴图：整张展开图 = 一张印刷面 ---------- */

  /** 归一化 UV：把展开坐标映到 0..1（fit=contain 时按图片比例居中留白） */
  function artUV(p, ratio, edgeCount) {
    const N = p.v.length / 2, E = edgeCount || 0;
    /* 顶点序：外皮 N → 内皮 N → 侧壁 4E；零厚度（E=0）时只有外皮 */
    const VN = E ? (N * 2 + E * 4) : N;
    const out = new Float32Array(VN * 2);
    const bw = (bbox2.x1 - bbox2.x0) || 1, bh = (bbox2.y1 - bbox2.y0) || 1;
    const fit = fitUv(ratio, bw, bh);
    /* 图稿在展开图上占据的矩形（mm）：stretch=整个包围盒，contain=按图片比例居中后的那块 */
    const fw = bw * (fit.ux1 - fit.ux0) || 1, fh = bh * (fit.uy1 - fit.uy0) || 1;

    for (let k = 0; k < N; k++) {
      const nx = (p.v[k * 2] - bbox2.x0) / bw;
      const ny = (p.v[k * 2 + 1] - bbox2.y0) / bh;
      const uv = xfUV(nx, ny, bw, bh, fw, fh);
      /* 世界嵌入是【恒等映射】(x,y,z)->(x,y,z)，行列式 +1，纯旋转、手性守恒 → u 不用翻。
         v 也不用翻：p.v 里的 y 在 fromOfficial 就已取反（`r2(-vs[z+1])`），
         所以数据 y 越大= 越靠上，ny=1 就是 2D 上方；
         而three 纹理 flipY=true 时 v=1 正对图像顶行 → v = ny 正好对上，一个字都不用翻。
         （曾误加 u=1-u「抵消镜像」、v=1-v「翻V」，前者凭空造镜像、后者把图上下翻反，
           已由 readPixels 像素比对实测纠正。）*/
      const u = uv[0];
      const v = uv[1];
      out[k * 2] = u; out[k * 2 + 1] = v;
      if (E) { out[(N + k) * 2] = u; out[(N + k) * 2 + 1] = v; }
    }
    return out;
  }

  /** 换贴图/换贴合方式：重算归一化 UV 并整体切换（外皮↔内皮共用同一套 UV 属性） */
  function applyArt() {
    if (!meshes.length) return;
    const P = data.P;
    const ratio = artTex && artTex.image ? (artTex.image.width / artTex.image.height) : 0;
    for (let mi = 0; mi < meshes.length; mi++) {
      const mesh = meshes[mi], i = mesh.userData.i, p = P[i];
      const src = artTex ? artUV(p, ratio, mesh.userData.edges.length) : mesh.userData.uvT;
      mesh.geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(src), 2));
    }
    applyPaper();
  }

  /**
   * 用户上传的图：@param src 已解码的 image/canvas；@param fit stretch|contain
   * @param xf 可选摆放参数 {sx,sy,rot,dx,dy}（传进来就整体替换）
   */
  function setArt(src, fit, xf) {
    if (fit) artFit = fit;
    if (xf) artXf = { sx: +xf.sx || 1, sy: +xf.sy || 1, rot: +xf.rot || 0, dx: +xf.dx || 0, dy: +xf.dy || 0 };
    if (!src) { clearArt(); return true; }
    if (!THREE) return false;
    if (artTex) artTex.dispose();
    artTex = new THREE.CanvasTexture(src);       // canvas/image 都收，走 GPU 直传
    artTex.wrapS = artTex.wrapT = THREE.ClampToEdgeWrapping;
    artTex.anisotropy = 8;
    if (THREE.SRGBColorSpace) artTex.colorSpace = THREE.SRGBColorSpace;
    applyArt();
    return true;
  }

  function clearArt() {
    if (artTex) { artTex.dispose(); artTex = null; }
    applyArt();
  }

  /** 只改摆放（缩放 / 旋转 / 位移）：重算 UV 就行，纹理不用重建 */
  function setArtXf(xf) {
    if (!xf) return artXf;
    if (xf.sx != null) artXf.sx = +xf.sx || 1;
    if (xf.sy != null) artXf.sy = +xf.sy || 1;
    if (xf.rot != null) artXf.rot = +xf.rot || 0;
    if (xf.dx != null) artXf.dx = +xf.dx || 0;
    if (xf.dy != null) artXf.dy = +xf.dy || 0;
    if (artTex) applyArt();
    return artXf;
  }

  /** 厚度：上游 ce 的 cal/inner/outer（mm）。cal=0 退回零厚度曲面 */
  function setThickness(cal, inner, outer) {
    const c = Math.max(0, Number(cal) || 0);
    thick.cal = c;
    thick.inner = Math.max(0, Number(inner) || 0);
    thick.outer = Math.max(0, Number(outer) || 0);
    if (c > 0 && !thick.inner && !thick.outer) { thick.inner = c / 2; thick.outer = c / 2; }
    if (c > 0 && thick.inner + thick.outer < c * 0.9) {   // 数据不全时按 2:1 兜底
      thick.inner = c * 2 / 3; thick.outer = c / 3;
    }
    if (data && meshes.length) {
      /* 只有「有没有厚度」这种结构变化才需要重建几何；只改数值时重写顶点就够 */
      const wasOn = meshes.length && meshes[0].userData.on;
      if (wasOn !== (c > 0.0001)) build();
      else { applyProgress(t, true); geoNormalsOnce(); }
      if (visible) render();
    }
    return { cal: thick.cal, inner: thick.inner, outer: thick.outer };
  }

  /* ---------- 「纸厚」按钮（HUD 里，纸种旁边） ---------- */

  function mm(v) { return (Math.round((+v || 0) * 100) / 100).toString(); }

  /** 按钮态与实际加厚都由这里统一刷（点按钮 / 上层推新数值都走它） */
  function syncThick() {
    const has = thickSrc.cal > 0.0001;
    const on = thickOn && has;
    thickBtn.classList.toggle('on', on);
    thickBtn.setAttribute('aria-pressed', String(on));
    thickBtn.disabled = !has;
    thickBtn.title = has
      ? (on ? '关掉' : '显示') + '纸板厚度（' + mm(thickSrc.cal) + 'mm，内 ' + mm(thickSrc.inner)
        + ' / 外 ' + mm(thickSrc.outer) + '；开关会被记住）'
      : '该盒型没有厚度数据';
  }

  /** 上层把上游算出来的厚度推过来（每次重算后都推一次）；开关由 3D 的「纸厚」按钮管 */
  function setThickData(cal, inner, outer) {
    thickSrc = { cal: +cal || 0, inner: +inner || 0, outer: +outer || 0 };
    if (thickOn && thickSrc.cal > 0.0001) setThickness(thickSrc.cal, thickSrc.inner, thickSrc.outer);
    else setThickness(0, 0, 0);
    syncThick();
    return { on: thickOn, cal: thickSrc.cal, inner: thickSrc.inner, outer: thickSrc.outer };
  }

  /** 开 / 关（不传参取反）；选择写进本地记忆，下次进 3D 沿用 */
  function setThick(on) {
    thickOn = (on == null) ? !thickOn : !!on;
    try { localStorage.setItem(THICK_KEY, thickOn ? '1' : '0'); } catch (e) { /* 隐私模式忽略 */ }
    if (thickOn && thickSrc.cal > 0.0001) setThickness(thickSrc.cal, thickSrc.inner, thickSrc.outer);
    else setThickness(0, 0, 0);
    syncThick();
    return thickOn;
  }

  thickBtn.addEventListener('click', function () { api.setThick(); });

  /* ---------- 载入 / 重建 ---------- */

  function clearMeshes() {
    if (!group) return;
    for (let i = 0; i < meshes.length; i++) meshes[i].geometry.dispose();
    for (let i = 0; i < mats.length; i++) mats[i].dispose();
    for (let i = 0; i < matsIn.length; i++) matsIn[i].dispose();
    for (let i = 0; i < matsSide.length; i++) matsSide[i].dispose();
    scene.remove(group);
    if (THREE) group = new THREE.Group();
    meshes = []; mats = []; matsIn = []; matsSide = [];
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

    /* 展开图包围盒：图稿贴图的 UV 按它归一化（整张展开图 = 一张印刷面） */
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < n; i++) {
      const v = P[i].v;
      for (let k = 0; k < v.length; k += 2) {
        if (v[k] < x0) x0 = v[k];
        if (v[k] > x1) x1 = v[k];
        if (v[k + 1] < y0) y0 = v[k + 1];
        if (v[k + 1] > y1) y1 = v[k + 1];
      }
    }
    if (!isFinite(x0)) { x0 = 0; y0 = 0; x1 = 1; y1 = 1; }
    bbox2 = { x0: x0, y0: y0, x1: x1, y1: y1 };
    artOf = [];

    const on = thick.cal > 0.0001;

    for (let i = 0; i < n; i++) {
      const p = P[i];
      if (!p.v.length || !p.f.length) continue;
      const N = p.v.length / 2;
      const edges = on ? outlineEdges(p) : [];
      const E = edges.length;
      const VN = on ? (N * 2 + E * 4) : N;      // 加厚：外皮 N + 内皮 N + 侧壁 4E

      /* UV 两套：
         ① 平铺（纸纹）：展开坐标 ÷ TEX_MM —— 折叠是刚体变换，UV 恒定，
            纹理等于「印在同一张纸上」，折痕处不会撕开错位。
         ② 归一化（图稿）：(展开坐标 − 包围盒原点) ÷ 包围盒尺寸 —— 整张展开图一张图。
         两套随贴图开关切换，顶点不动。 */
      const uvT = new Float32Array(VN * 2);
      const uvN = new Float32Array(VN * 2);
      const bw = (x1 - x0) || 1, bh = (y1 - y0) || 1;
      for (let k = 0; k < N; k++) {
        const tx = p.v[k * 2] / TEX_MM, ty = p.v[k * 2 + 1] / TEX_MM;
        const nx = (p.v[k * 2] - x0) / bw, ny = (p.v[k * 2 + 1] - y0) / bh;
        // 外皮 [0,N) 与内皮 [N,2N) 共用同一套 UV（零厚度时没有内皮）
        uvT[k * 2] = tx; uvT[k * 2 + 1] = ty;
        uvN[k * 2] = nx; uvN[k * 2 + 1] = ny;
        if (on) {
          uvT[(N + k) * 2] = tx; uvT[(N + k) * 2 + 1] = ty;
          uvN[(N + k) * 2] = nx; uvN[(N + k) * 2 + 1] = ny;
        }
      }

      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(VN * 3), 3));
      geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvT), 2));

      const idx = new Uint32Array(on ? (p.f.length * 2 + E * 6) : p.f.length);
      idx.set(p.f, 0);
      const matOut = new THREE.MeshStandardMaterial({
        /* 纸板色：暖调，面板之间轻微错开明度，折起来才看得清都是哪些面 */
        color: new THREE.Color().setHSL(0.09 + (i % 7) * 0.010, 0.30, 0.66 - (i % 5) * 0.030),
        side: THREE.DoubleSide,
        roughness: 0.86,
        metalness: 0.02,
        flatShading: true
      });
      let matIn = null, matSide = null;
      const matList = [matOut];

      if (on) {
        /* 内皮：绕向翻转（外皮朝外时内皮朝内），颜色压暗一点，折起来里外分得清 */
        for (let k = 0; k < p.f.length; k += 3) {
          idx[p.f.length + k] = p.f[k + 1] + N;
          idx[p.f.length + k + 1] = p.f[k] + N;
          idx[p.f.length + k + 2] = p.f[k + 2] + N;
        }
        /* 侧壁：每条轮廓边 4 个顶点（外A 外B 内B 内A）→ 2 个三角形。
           DoubleSide 兜底，不必纠结绕向。 */
        for (let e = 0; e < E; e++) {
          const b = N * 2 + e * 4, o = p.f.length * 2 + e * 6;
          idx[o] = b; idx[o + 1] = b + 1; idx[o + 2] = b + 2;
          idx[o + 3] = b; idx[o + 4] = b + 2; idx[o + 5] = b + 3;
        }
        matIn = new THREE.MeshStandardMaterial({
          color: new THREE.Color().setHSL(0.09 + (i % 7) * 0.010, 0.24, 0.52 - (i % 5) * 0.024),
          side: THREE.DoubleSide, roughness: 0.9, metalness: 0.02, flatShading: true
        });
        matSide = new THREE.MeshStandardMaterial({
          color: THICK_SIDE_COLOR, side: THREE.DoubleSide, roughness: 0.95, metalness: 0.0, flatShading: true
        });
        matList.push(matIn, matSide);
        geo.addGroup(0, p.f.length, 0);                 // 外皮
        geo.addGroup(p.f.length, p.f.length, 1);        // 内皮
        geo.addGroup(p.f.length * 2, E * 6, 2);         // 侧壁
      }
      geo.setIndex(new THREE.BufferAttribute(idx, 1));

      /* ❗ 零厚度时必须传「单个材质」而不是 [matOut]：
         three 遇到材质数组只按 geometry.groups 渲染，而零厚度几何没有 group，
         结果就是整个网格一个三角形都不画（表现为关掉「纸厚」后模型凭空消失）。 */
      const mesh = new THREE.Mesh(geo, on ? matList : matOut);
      mesh.userData.i = i;
      mesh.userData.edges = edges;
      mesh.userData.N = N;
      mesh.userData.on = on;
      mesh.userData.uvT = uvT;                    // 平铺 UV（纸纹）
      mesh.userData.uvN = uvN;                    // 归一化 UV（图稿，contain 时会重算）
      mesh.frustumCulled = false;   // 顶点每帧都在动，交给引擎算包围球不如直接不过滤
      group.add(mesh);
      meshes.push(mesh); mats.push(matOut);
      if (matIn) { matsIn.push(matIn); matsSide.push(matSide); }
    }

    applyProgress(1, true);         // 先把顶点写进去（否则包围盒退化成一个点）
    thick.sign = faceSign();        // 折好之后才知道哪面朝外（整张纸统一判定）
    applyProgress(1, true);
    fitCamera();
    geoNormalsOnce();
    applyPaper();                   // 重建后把当前纸种贴回去
    applyArt();                     // 重建后把图稿贴回去
  }

  /** 哪一面朝外：折好之后按「面积加权」看法线是不是背离盒心 —— 整张纸只判一次，
      不能逐面板翻（一张纸的两面是连续的，逐面翻会让贴图在折痕处镜像错位）。 */
  function faceSign() {
    const P = data.P, n = P.length;
    if (!n || !meshes.length) return 1;
    const cen = [];
    let cx = 0, cy = 0, cz = 0, w = 0;
    for (let mi = 0; mi < meshes.length; mi++) {
      const mesh = meshes[mi], i = mesh.userData.i, p = P[i];
      if (p.c !== mainComp) continue;
      const N = mesh.userData.N;
      const arr = mesh.geometry.attributes.position.array;
      let sx = 0, sy = 0, sz = 0;
      for (let j = 0; j < N * 3; j += 3) { sx += arr[j]; sy += arr[j + 1]; sz += arr[j + 2]; }
      if (!N) continue;
      cen[i] = [sx / N, sy / N, sz / N];
      cx += cen[i][0]; cy += cen[i][1]; cz += cen[i][2]; w++;
    }
    if (!w) return 1;
    cx /= w; cy /= w; cz /= w;
    let dot = 0, wsum = 0;
    for (let i = 0; i < n; i++) {
      if (!cen[i]) continue;
      const m = M[i];
      /* 法线 = 变换矩阵第三列（局部 z 轴）—— 恒等映射下直接就是 three 法线 */
      let tx = m[8], ty = m[9], tz = m[10];
      const L = Math.hypot(tx, ty, tz) || 1;
      tx /= L; ty /= L; tz /= L;
      const dx = cen[i][0] - cx, dy = cen[i][1] - cy, dz = cen[i][2] - cz;
      const a = Math.hypot(dx, dy, dz) || 1;
      dot += (tx * dx + ty * dy + tz * dz) / a * (1 + a);
      wsum += (1 + a);
    }
    return dot >= 0 ? 1 : -1;
  }

  function geoNormalsOnce() {
    for (let i = 0; i < meshes.length; i++) meshes[i].geometry.computeVertexNormals();
  }

  /* ---------- 每帧顶点 ----------
   * three 世界坐标 = 折叠数学坐标【恒等映射】(x, y, z)。
   *
   * ❗这里曾经写成 (x, z, -y)，害得所有盒子「躺倒」：数学空间里 y 才是盒子的高度轴
   *   （实测0014 管式盒 120x100x200，恒等映射竖直跨度 = 200 = 高度D，正好对上；
   *   旧映射只有 100 = 宽度 W，200 那根管轴被甩到了屏幕深度方向）。
   *   恒等映射行列式 = +1（纯旋转，手性守恒），所以贴图 UV 不需要任何翻转去"抵消镜像"，
   *   此前 artUV 里那个 u = 1-uv[0] 纯属凭空制造左右镜像，已删。
   */

  function applyProgress(tt, noRender) {
    t = Math.max(0, Math.min(1, tt));
    if (!data) return;
    const P = data.P, co = data.co || [];
    buildM(P, t, data.s, M);
    const sgn = thick.sign;
    const up = thick.outer * sgn, dn = thick.inner * sgn;   // 外皮 / 内皮 沿法线的偏移
    for (let mi = 0; mi < meshes.length; mi++) {
      const mesh = meshes[mi], i = mesh.userData.i, p = P[i];
      const arr = mesh.geometry.attributes.position.array;
      const off = co[p.c] || 0;
      const N = mesh.userData.N;
      const on = mesh.userData.on;
      /* 面板法线：变换矩阵第三列（局部 z 轴）—— 恒等映射下它就是 three 世界法线。
         折叠是刚体变换，所以法线跟着面板一起转，加厚方向永远垂直于板面。 */
      let nx = 0, ny = 0, nz = 0;
      if (on) {
        nx = M[i][8]; ny = M[i][9]; nz = M[i][10];
        const L = Math.hypot(nx, ny, nz) || 1;
        nx = nx / L * up; ny = ny / L * up; nz = nz / L * up;
      }
      const mx = on ? -M[i][8] : 0, my = on ? -M[i][9] : 0, mz = on ? -M[i][10] : 0;
      const ML = Math.hypot(mx, my, mz) || 1;
      const ix = mx / ML * dn, iy = my / ML * dn, iz = mz / ML * dn;
      for (let k = 0, j = 0; k < p.v.length; k += 2, j += 3) {
        const q = xform(M[i], [p.v[k], p.v[k + 1], 0]);
        const bx = q[0] + off, by = q[1], bz = q[2];
        arr[j] = bx + nx; arr[j + 1] = by + ny; arr[j + 2] = bz + nz;   // 外皮
        if (on) {
          arr[N * 3 + j] = bx + ix;                                     // 内皮（反方向）
          arr[N * 3 + j + 1] = by + iy;
          arr[N * 3 + j + 2] = bz + iz;
        }
      }
      if (on) {
        /* 侧壁：外A / 外B / 内B / 内A —— 直接复用刚写好的外皮、内皮顶点 */
        const edges = mesh.userData.edges;
        for (let e = 0; e < edges.length; e++) {
          const a = edges[e][0] * 3, b = edges[e][1] * 3;
          const o = (N * 2 + e * 4) * 3;
          arr[o] = arr[a]; arr[o + 1] = arr[a + 1]; arr[o + 2] = arr[a + 2];
          arr[o + 3] = arr[b]; arr[o + 4] = arr[b + 1]; arr[o + 5] = arr[b + 2];
          arr[o + 6] = arr[N * 3 + b]; arr[o + 7] = arr[N * 3 + b + 1]; arr[o + 8] = arr[N * 3 + b + 2];
          arr[o + 9] = arr[N * 3 + a]; arr[o + 10] = arr[N * 3 + a + 1]; arr[o + 11] = arr[N * 3 + a + 2];
        }
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
    /* 机位在 +z 侧（恒等映射下展开图平铺在 z=0 平面，朝+z 就是正面）：
       从前上方俯视，展开态正立、折好后从正面看到盒子的印刷面。
       镜像/颠倒一律由坐标映射负责，机位只决定从哪看——改机位治不了方向错。 */
    home = {
      pos: new THREE.Vector3(ctr.x + mx * 0.85, ctr.y + mx * 0.75, ctr.z + mx * 1.45),
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

  /* ---------- 纸种浮层 ---------- */

  paperPop.innerHTML =
    '<div class="v3d-paper-hd">纸张材质<em>7 种纸样</em></div>' +
    '<div class="v3d-paper-grid">' +
      PAPERS.map(function (p) {
        return '<button type="button" class="v3d-sw" data-k="' + p.k + '" title="' + p.name + '"'
          + (p.file ? ' style="background-image:url(' + MAT_BASE + p.file + ')"' : '') + '>'
          + (p.file ? '' : '<i></i>') + '</button>';
      }).join('') +
    '</div>' +
    '<label class="v3d-paper-ct"><input type="color" value="#c8a273"><span>自定义颜色</span></label>';

  /* 选中态由这里统一刷（点色块 / 取色器 / 上层恢复记忆都走它） */
  function syncSw() {
    const cur = api.paper();
    const btns = paperPop.querySelectorAll('.v3d-sw');
    for (let i = 0; i < btns.length; i++) btns[i].classList.toggle('on', btns[i].dataset.k === cur);
    const ct = paperPop.querySelector('input[type=color]');
    const isHex = cur.charAt(0) === '#';
    ct.parentNode.classList.toggle('on', isHex);
    if (isHex) ct.value = cur;
  }

  paperPop.addEventListener('click', function (e) {
    const b = e.target.closest && e.target.closest('.v3d-sw');
    if (!b) return;
    api.setPaper(b.dataset.k);
    if (onPaper) onPaper(api.paper());
  });
  paperPop.querySelector('input[type=color]').addEventListener('input', function () {
    api.setPaper(this.value);
    if (onPaper) onPaper(api.paper());
  });

  paperBtn.addEventListener('click', function (e) {
    e.stopPropagation();                 // 否则冒到 document 立刻又被关掉
    paperPop.hidden = !paperPop.hidden;
    paperBtn.setAttribute('aria-expanded', String(!paperPop.hidden));
  });
  document.addEventListener('click', function () {
    if (!paperPop.hidden) { paperPop.hidden = true; paperBtn.setAttribute('aria-expanded', 'false'); }
  });

  /* ---------- 地面网格开关 ---------- */

  /* 按钮态与网格显隐都由这里统一刷（点按钮 / 上层恢复记忆都走它） */
  function syncGrid() {
    if (grid) grid.visible = gridOn;
    gridBtn.classList.toggle('on', gridOn);
    gridBtn.setAttribute('aria-pressed', String(gridOn));
    gridBtn.title = (gridOn ? '隐藏' : '显示') + '脚下的地面网格（选择会记住）';
  }

  gridBtn.addEventListener('click', function () { api.setGrid(!gridOn); });

  /* ---------- 对外 ---------- */

  const api = {
    visible: function () { return visible; },
    info: function () { return info; },

    /**
     * 纸种 / 颜色
     * @param k 'plain' 纸板原色 | 'wa'|'niu'|'jin'|'yin'|'qing'|'pink'|'red' 预设纸 | '#rrggbb' 自定义色
     * 传色值时忽略第 2 参。
     */
    setPaper: function (k, tint) {
      if (k && k.charAt(0) === '#') { curPaper = 'plain'; curTint = k; }
      else { curPaper = k || 'plain'; curTint = tint || null; }
      applyPaper();
      syncSw();
      return api;
    },
    paper: function () { return curTint || curPaper; },
    papers: function () {
      return PAPERS.map(function (p) { return { k: p.k, name: p.name, file: p.file || null }; });
    },

    /* 视觉加厚：按上游 ce 的 cal/inner/outer（mm）把零厚度曲面挤成薄板。
       cal 传 0 就退回原来的曲面（不加厚）。 */
    setThickness: setThickness,
    thickness: function () { return { cal: thick.cal, inner: thick.inner, outer: thick.outer }; },

    /* 「纸厚」按钮走的入口：
       setThickData() 由上层推上游数值（换盒型 / 改了纸厚参数都会重推），
       setThick() 是按钮本身的开 / 关，开关状态记在本地，下次进 3D 沿用。 */
    setThickData: setThickData,
    setThick: setThick,
    thick: function () {
      return { on: thickOn, cal: thick.cal, inner: thick.inner, outer: thick.outer, src: thickSrc.cal };
    },

    /* 图稿贴图：src 是 image/canvas（整张展开图当印刷面），fit = stretch|contain；
       setArtXf() 只改摆放（缩放 / 旋转 / 位移），clearArt() 撤掉贴图退回纸纹/纸色。 */
    setArt: setArt,
    setArtXf: setArtXf,
    artXf: function () { return { sx: artXf.sx, sy: artXf.sy, rot: artXf.rot, dx: artXf.dx, dy: artXf.dy }; },
    clearArt: clearArt,
    hasArt: function () { return !!artTex; },

    /** 地面网格显隐（不传参则取反）；选择写进本地记忆，下次进 3D 沿用 */
    setGrid: function (v) {
      gridOn = (v == null) ? !gridOn : !!v;
      syncGrid();
      try { localStorage.setItem(GRID_KEY, gridOn ? '1' : '0'); } catch (e) { /* 隐私模式忽略 */ }
      return api;
    },
    grid: function () { return gridOn; },

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
     * @param opts { pms } —— 给了 pms 就走「实时重折叠」：按这组尺寸重新计算折叠树。
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
          /* 走站内代理（浏览器不能跨域直连） */
          return fetch(API3D, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ boxID: id, inPms: pms })
          }).then(function (r) {
            return r.text().then(function (txt) {
              /* 代理是原样透传上游响应（见 server.js / worker.js 注释），
                 所以这里直接就是 {BoxJson, LineExp, Box3D, …} */
              var j = null;
              try { j = JSON.parse(txt); } catch (e2) { j = null; }
              if (!r.ok || !j || !j.Box3D) {
                var e3 = new Error((j && j.error) || ('求解服务返回 ' + r.status));
                e3.code = 'noapi';
                throw e3;
              }
              var packed = fromOfficial(j, id);
              /* 折叠结构是按标准尺寸给定的，不随尺寸变 —— 这里没有就等于该盒型做不了 */
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
          setMsg('该盒型没有折叠结构（多为平面件或对折卡），<br>暂时做不了 3D 立体图。');
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

    /* 自动旋转 */
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
    /* 验收探针用：几何/厚度/贴图现状（加厚后顶点数应从 N 变成 2N+4E） */
    debug: function () {
      return {
        meshes: meshes.length,
        verts: meshes.map(function (m) { return m.geometry.attributes.position.count; }),
        thick: { cal: thick.cal, inner: thick.inner, outer: thick.outer, sign: thick.sign },
        art: !!artTex, artFit: artFit, artXf: artXf,
        flipY: artTex ? artTex.flipY : null,
        bbox: bbox2, comps: (data && data.nc) || 0
      };
    },
    /* 验收探针用：第 i 个面板的原始顶点/UV（贴图方向排查用） */
    raw: function (i) {
      const m = meshes[i || 0];
      if (!m) return null;
      const p = data.P[m.userData.i];
      const r2v = function (n) { return Math.round(n * 100) / 100; };
      return {
        comp: p.c, N: m.userData.N,
       展开v: Array.from(p.v).map(r2v),
        pos: Array.from(m.geometry.attributes.position.array).map(r2v),
        uv: Array.from(m.geometry.attributes.uv.array).map(function (n) { return Math.round(n * 1000) / 1000; })
      };
    },
    /* 验收探针用：展开图绝对坐标 (mm) → 画布像素坐标（贴图方向零假设采样用）。
       世界嵌入与 applyProgress 完全同款：(q0+off, q1, q2)。 */
    project: function (x, y) {
      if (!camera || !renderer || !data || !data.P.length) return null;
      const off = (data.co && data.co[data.P[0].c]) || 0;
      const q = xform(M[0], [x, y, 0]);
      const v = new THREE.Vector3(q[0] + off, q[1], q[2]).project(camera);
      return {
        x: Math.round((v.x * 0.5 + 0.5) * renderer.domElement.width),
        y: Math.round((1 - v.y * 0.5 - 0.5) * renderer.domElement.height),
        ndc: [+v.x.toFixed(3), +v.y.toFixed(3)]
      };
    },
    /* 验收探针用：展开图上某点（归一化 0..1）对应到图稿的 UV。
       拿它跟 2D 那张 <image> 的 transform 反算结果对比，就能证明两边摆放一致。 */
    uvAt: function (nx, ny) {
      if (!bbox2 || !artTex) return null;
      const bw = (bbox2.x1 - bbox2.x0) || 1, bh = (bbox2.y1 - bbox2.y0) || 1;
      const ratio = artTex.image ? artTex.image.width / artTex.image.height : 0;
      const fit = fitUv(ratio, bw, bh);
      const fw = bw * (fit.ux1 - fit.ux0) || 1, fh = bh * (fit.uy1 - fit.uy0) || 1;
      const uv = xfUV(nx, ny, bw, bh, fw, fh);
      /* 与 artUV 完全同一套公式（恒等映射：u、v 都不翻），两边永不脱钩 */
      return { u: +uv[0].toFixed(4), v: +uv[1].toFixed(4) };
    },
    /* 验收探针用：量外皮↔内皮的实际距离（应等于 cal），null = 该面板没加厚 */
    measureThickness: function () {
      const res = [];
      for (let mi = 0; mi < Math.min(4, meshes.length); mi++) {
        const mesh = meshes[mi];
        if (!mesh.userData.on) { res.push(null); continue; }
        const N = mesh.userData.N, a = mesh.geometry.attributes.position.array;
        let d = 0;
        for (let k = 0; k < N; k++) {
          d += Math.hypot(
            a[N * 3 + k * 3] - a[k * 3],
            a[N * 3 + k * 3 + 1] - a[k * 3 + 1],
            a[N * 3 + k * 3 + 2] - a[k * 3 + 2]
          );
        }
        res.push(+(d / N).toFixed(3));
      }
      return res;
    },
    /* 验收探针用：折好后的真实 3D 包围盒（mm）。
       判方向的关键量就是 sizeY —— 恒等映射下它应≈ 盒型高度 D。 */
    measureWorldBBox: function () {
      const b = new THREE.Box3();
      let first = true;
      for (let mi = 0; mi < meshes.length; mi++) {
        const a = meshes[mi].geometry.attributes.position.array;
        for (let j = 0; j < a.length; j += 3) {
          const v = new THREE.Vector3(a[j], a[j + 1], a[j + 2]);
          if (first) { b.set(v, v); first = false; } else b.expandByPoint(v);
        }
      }
      if (first) return null;
      const sz = b.getSize(new THREE.Vector3());
      return {
        min: [r2(b.min.x), r2(b.min.y), r2(b.min.z)],
        max: [r2(b.max.x), r2(b.max.y), r2(b.max.z)],
        size: [r2(sz.x), r2(sz.y), r2(sz.z)]
      };
    },
    /* 验收探针用：每个面板中心的世界 Y + 展开图 y（找「上盖」该待在哪） */
    panelWorldY: function () {
      const res = [];
      for (let mi = 0; mi < meshes.length; mi++) {
        const mesh = meshes[mi], p = data.P[mesh.userData.i];
        const N = mesh.userData.N, a = mesh.geometry.attributes.position.array;
        let sy = 0, y2 = 0;
        for (let k = 0; k < N; k++) { sy += a[k * 3 + 1]; y2 += p.v[k * 2 + 1]; }
        res.push({ i: mesh.userData.i, worldY: r2(sy / N), flatY: r2(y2 / N) });
      }
      return res;
    },
    state: function () {
      return {
        t: r2(t), playing: playing, hold: Math.round(hold),
        legMs: legMs, dwell: DWELL_MS,
        grid: gridOn,
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

  syncThick();      // 按钮初始态：还没数据 → 置灰，等上层推厚度数值过来

  function setMsg(html) {
    if (html == null) { msgEl.hidden = true; msgEl.innerHTML = ''; }
    else { msgEl.hidden = false; msgEl.innerHTML = html; }
  }

  /* ---------- 交互 ---------- */

  playBtn.addEventListener('click', function () {
    if (!data) return;
    if (playing) stopPlay(); else startPlay();
  });

  /* 手动拖进度条就停下自动折叠（拖滑块即停自动折叠），拖完可以再按播放 */
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
