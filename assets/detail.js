/* ============================================================
   detail.js — 详情页：参数面板 + 刀模展开图 + 内外制造尺寸对照
   ============================================================ */
(function () {
  'use strict';

  var V2 = window.V2;
  var ID = V2.qs('id');
  var C = null;
  var B = null;   // catalog 元数据
  var G = null;   // 几何 + 参数

  var dimType = 'm';     // m 制造 / i 内 / o 外
  var unit = 'mm';
  var dims = { L: null, W: null, D: null };  // 统一以「制造尺寸 mm」存储
  var ceLive = null;     // 当前生效的参数值
  var S = null;          // 尺寸计算结果
  var dimMode = null;    // 长/宽/高 各自能否编辑（见 V2.dimControl）

  var $ = function (id) { return document.getElementById(id); };

  if (!ID) {
    document.body.innerHTML = '<div class="empty" style="padding:120px 20px"><b>缺少盒型编号</b>请从盒型库进入</div>';
    return;
  }

  V2.loadCatalog().then(function (c) {
    C = c;
    B = c.boxes.filter(function (x) { return x.id === ID; })[0];
    if (!B) {
      document.body.innerHTML = '<div class="empty" style="padding:120px 20px"><b>未找到盒型 ' + V2.esc(ID) + '</b><a href="index.html">返回盒型库</a></div>';
      return;
    }
    V2.bindTopSearch(c);
    return V2.loadChunk(B.ch);
  }).then(function () {
    if (!B) return;
    G = V2.geoOf(ID);
    if (!G) return;
    boot();
  }).catch(function (e) {
    var el = $('status');
    if (el) { el.className = 'status err'; el.innerHTML = '<i class="dot"></i>' + V2.esc(e.message); }
  });

  /* ==================== 启动 ==================== */

  function boot() {
    document.title = V2.displayName(B) + '（' + ID + '）刀模展开图 · 内/制造/外尺寸对照与 SVG·DXF 下载 - 通用包装盒型库';

    ceLive = Object.assign({}, G.ce);
    dims.L = numOr(G.ce.l);
    dims.W = numOr(G.ce.w);
    dims.D = numOr(G.ce.d);
    SP = spansFrom(G.rm);
    compute();

    renderHead();
    renderCanvas();
    renderPanel();
    syncDimLock();
    renderInfo();
    renderRelated();
    renderTags();
    bindExport();
  }

  function numOr(v) { var n = parseFloat(v); return isFinite(n) ? Math.round(n * 100) / 100 : null; }

  function compute() {
    S = V2.sizesOf(ceLive);
    /* 内/外尺寸用上游标注里的真值差值；拿不到标注才退回
       「内 = 制造 − 2×内向补偿、外 = 制造 + 2×外向补偿」
       （补偿是单边量、尺寸跨两块纸板，故 ×2） */
    ['L', 'W', 'D'].forEach(function (k) {
      if (dims[k] == null) return;
      var di = SP.inn[k], dob = SP.out[k];
      S[k] = {
        m: dims[k],
        i: r2(di != null ? dims[k] - di : dims[k] - 2 * S.inner),
        o: r2(dob != null ? dims[k] + dob : dims[k] + 2 * S.outer)
      };
    });
  }
  function r2(v) { return Math.round(v * 100) / 100; }

  /* ==================== 头部 ==================== */

  /* 详情页不再单独占一行标题栏：原来那行「盒型名 + 编号」是重复信息
     （编号在面包屑与右侧「刀模规格」里都有，盒型名在浏览器标签页标题里），
     所以这里只管面包屑和属性栏里的编号 / 分类。 */
  function renderHead() {
    var cn = catName(B.cat);
    var cc = $('crumbCat');
    cc.textContent = cn;
    cc.href = B.cat == null ? 'index.html' : 'index.html?cat=' + B.cat;
    $('crumbNow').textContent = ID;
    var kvId = $('kvId'), kvCat = $('kvCat');
    if (kvId) kvId.textContent = ID;
    if (kvCat) kvCat.textContent = cn;
  }

  /* 分类名规范化（第 0 类的「免费」→「常用盒型」）统一在 common.js 里做，列表页也用同一份 */
  function catName(idx) { return V2.catName(C.cats, idx); }

  /* ==================== 画布 ==================== */

  var zoom = 1;
  var showDim = true;            // 展开宽/展开高 尺寸线
  var showMain = true;           // 主尺寸标注（长/宽/高那类，橙色）
  var showOth = false;           // 其他参数标注（绿色）—— 上游默认也是关着的
  var txtMode = 2;               // 标注文字：0 代码=数值 / 1 只要代码 / 2 只要数值
  var dimFs = null;              // 标注字号（用户单位），按渲染比例校正
  var DIM_PX = 12;               // 标注目标渲染字号（px）
  var canvasHost = null;         // .canvas（滚动视窗）
  var fitPx = 0;                 // 100% 时 SVG 的像素宽度（按视窗等比贴合）

  function host() {
    if (!canvasHost) canvasHost = document.querySelector('.canvas');
    return canvasHost;
  }

  /* 100% 时的贴合尺寸：宽高都装得下才算「适应」 */
  function calcFit(vb) {
    var h = host();
    if (!h || !vb || !vb.width || !vb.height) return 0;
    var pad = parseFloat(getComputedStyle($('canvasInner')).paddingLeft) || 0;
    var availW = Math.max(80, h.clientWidth - pad * 2 - 2);
    var availH = Math.max(80, h.clientHeight - pad * 2 - 2);
    return Math.min(availW, availH * vb.width / vb.height);
  }

  function renderCanvas(pass) {
    var svg = V2.svg(G, {
      pad: 18,
      dim: showDim,
      rm: { on: true, main: showMain, oth: showOth, choose: rmChoose(), txtMode: txtMode },
      unit: unit,
      fs: dimFs,
      nameW: '展开宽',
      nameH: '展开高'
    });
    $('canvasInner').innerHTML = svg;
    applyZoom(true);

    // 用「贴合时的真实比例」反推字号 —— 让所有盒型（大图/小图/狭长图）里标注大小一致，
    // 且缩放时标注跟着图形一起放大，不会出现「图形放大了字还是 12px」的割裂感。
    if ((showDim || showMain || showOth) && (pass || 0) < 2) {
      var el = $('canvasInner').querySelector('svg');
      var vb = el && el.viewBox && el.viewBox.baseVal;
      var scale = vb && vb.width ? calcFit(vb) / vb.width : 0;
      if (scale > 0) {
        var want = Math.max(0.3, Math.min(200, DIM_PX / scale));
        var cur = dimFs || V2.dimFontSize(G);
        if (Math.abs(want - cur) / cur > 0.1) {
          dimFs = want;
          renderCanvas((pass || 0) + 1);
          return;
        }
        dimFs = want;
      }
    }

    var bb = V2.bboxSize(G);
    $('footCut').textContent = G.c.length + ' 条';
    $('footCrease').textContent = G.k.length + ' 条';
    $('footBox').textContent = V2.num(bb.w) + ' × ' + V2.num(bb.h) + ' mm';

    var fm = $('footMark');
    if (fm) {
      var st = rmStat();
      fm.textContent = st.main || st.oth
        ? '主尺寸 ' + st.mShown + '/' + st.main + ' · 其他参数 ' + st.oShown + '/' + st.oth
        : '该盒型无标注数据';
    }
  }

  /** 展开口径对应的上游 choose：制造=3 / 内=1 / 外=2 */
  function rmChoose() { return dimType === 'i' ? 1 : dimType === 'o' ? 2 : 3; }

  /** 标注条数统计（底栏用）：上游给了多少条、当前开关下画出来多少条 */
  function rmStat() {
    var rm = (G && G.rm) || [];
    var n = { main: 0, oth: 0, mShown: 0, oShown: 0 };
    rm.forEach(function (r) {
      if (Array.isArray(r[4])) { n.main++; if (showMain) n.mShown++; }
      else { n.oth++; if (showOth) n.oShown++; }
    });
    return n;
  }

  /* 缩放：按像素设宽（不是百分比），并保持视窗中心不动 */
  function applyZoom(keepCenter) {
    var inner = $('canvasInner');
    var el = inner.querySelector('svg');
    var vb = el && el.viewBox && el.viewBox.baseVal;
    if (!vb || !vb.width) return;

    var h = host();
    var cx = null, cy = null;
    if (h && keepCenter) {
      cx = (h.scrollLeft + h.clientWidth / 2) / Math.max(1, h.scrollWidth);
      cy = (h.scrollTop + h.clientHeight / 2) / Math.max(1, h.scrollHeight);
    }

    fitPx = calcFit(vb);
    el.style.width = Math.round(fitPx * zoom) + 'px';
    el.style.height = 'auto';

    if (h && keepCenter && cx != null) {
      h.scrollLeft = cx * h.scrollWidth - h.clientWidth / 2;
      h.scrollTop = cy * h.scrollHeight - h.clientHeight / 2;
    }
    $('zoomVal').textContent = Math.round(zoom * 100) + '%';
  }

  $('zoomIn').addEventListener('click', function () { zoom = Math.min(4, r1(zoom + 0.25)); applyZoom(true); });
  $('zoomOut').addEventListener('click', function () { zoom = Math.max(0.25, r1(zoom - 0.25)); applyZoom(true); });
  $('zoomFit').addEventListener('click', function () {
    zoom = 1;
    applyZoom(false);
    var h = host();
    if (h) { h.scrollLeft = 0; h.scrollTop = 0; }
  });

  function r1(v) { return Math.round(v * 100) / 100; }

  /* Ctrl + 滚轮缩放（以光标位置为中心） */
  (function () {
    var h = host();
    if (!h) return;
    h.addEventListener('wheel', function (e) {
      if (in3D) return;                       // 3D 模式下滚轮归 OrbitControls
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      var rect = h.getBoundingClientRect();
      var rx = (h.scrollLeft + e.clientX - rect.left) / Math.max(1, h.scrollWidth);
      var ry = (h.scrollTop + e.clientY - rect.top) / Math.max(1, h.scrollHeight);
      var next = Math.max(0.25, Math.min(4, r1(zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15))));
      if (next === zoom) return;
      zoom = next;
      applyZoom(false);
      h.scrollLeft = rx * h.scrollWidth - (e.clientX - rect.left);
      h.scrollTop = ry * h.scrollHeight - (e.clientY - rect.top);
    }, { passive: false });
  })();

  var _rsT = null;
  window.addEventListener('resize', function () {
    clearTimeout(_rsT);
    _rsT = setTimeout(function () {
      if (v3d && in3D) v3d.resize();
      else applyZoom(true);
    }, 120);
  });

  var dimBtn = $('dimToggle');
  if (dimBtn) {
    dimBtn.addEventListener('click', function () {
      showDim = !showDim;
      dimBtn.classList.toggle('on', showDim);
      renderCanvas();
    });
  }

  /* 主尺寸 / 其他参数是两个独立的显示开关 —— 与上游底部那排一致：
     主尺寸（长宽高这类，标注值是三元组）默认开，其他参数默认关。
     图上密密麻麻几十条标注反而看不清刀模结构，需要时再打开。 */
  var rmMainBtn = $('rmMain');
  if (rmMainBtn) {
    rmMainBtn.addEventListener('click', function () {
      showMain = !showMain;
      rmMainBtn.classList.toggle('on', showMain);
      renderCanvas();
    });
  }

  var rmOthBtn = $('rmOth');
  if (rmOthBtn) {
    rmOthBtn.addEventListener('click', function () {
      showOth = !showOth;
      rmOthBtn.classList.toggle('on', showOth);
      renderCanvas();
    });
  }

  /* 标注文字口径：只要数值 / 代码=数值（上游叫 txtMode） */
  var rmTxtSel = $('rmTxt');
  if (rmTxtSel) {
    rmTxtSel.addEventListener('change', function () {
      txtMode = +this.value || 0;
      renderCanvas();
    });
  }

  /* ==================== 3D 立体视图 ====================
     懒加载：点了按钮才去下载 view3d.js（连它内部的 three.js），再按需 fetch
     当前这一个盒型的数据（多数 1~2KB）。不点的人一个字节都不多下。
     3D 与展开图互斥：中栏原地切换，不新增布局、不额外占高度。 */

  var v3d = null, in3D = false, v3dBusy = false, no3D = false;
  /* 折叠树是按尺寸生成的：用户一改尺寸这份树就作废（抽样 24 盒发现约 1/5 的盒型
     折角会随尺寸变，所以不能拿旧树配新几何）。标记过期，等进 3D 时按新尺寸重取。 */
  var v3dStale = false;
  var TOOLS_2D = ['zoomOut', 'zoomIn', 'zoomFit', 'rmMain', 'rmOth', 'rmTxt', 'dimToggle'];

  /* 用 detail.js 自己的 script.src 定位同目录的 view3d.js —— 站点在 GitHub Pages
     子路径（/diecut/）下也能正确解析，不写死绝对路径 */
  var v3dURL = (function () {
    var s = document.querySelector('script[src*="detail.js"]');
    try { return new URL('view3d.js', s ? s.src : location.href).href; }
    catch (e) { return 'assets/view3d.js'; }
  })();

  /* 「2D 展开图 / 3D 立体」是一组二选一的切换控件（预览框正上方），
     点当前那个不做任何事 —— 和普通 toggle 按钮的手感不同，更像标签页。 */
  var view3dBtn = $('view3dToggle');
  var view2dBtn = $('view2d');

  function syncViewTabs() {
    if (view2dBtn) { view2dBtn.classList.toggle('on', !in3D); view2dBtn.setAttribute('aria-selected', String(!in3D)); }
    if (view3dBtn) { view3dBtn.classList.toggle('on', in3D); view3dBtn.setAttribute('aria-selected', String(in3D)); }
  }

  if (view3dBtn) view3dBtn.addEventListener('click', function () { if (!in3D) enter3D(); });
  if (view2dBtn) view2dBtn.addEventListener('click', function () { if (in3D) leave3D(); });

  function set2dToolsDisabled(v) {
    TOOLS_2D.forEach(function (id) { var b = $(id); if (b) b.disabled = !!v; });
  }

  /* ---------- 3D 纸种 / 颜色（跨盒型记住） ---------- */

  var PAPER_KEY = 'V2.paper';
  function onPaperChange(k) {
    try { localStorage.setItem(PAPER_KEY, k); } catch (e) { /* 隐私模式忽略 */ }
  }
  function savedPaper() {
    try { return localStorage.getItem(PAPER_KEY) || ''; } catch (e) { return ''; }
  }

  function enter3D() {
    if (in3D || v3dBusy || no3D) return;
    in3D = true;
    document.querySelector('.canvas').classList.add('is-3d');
    document.querySelector('.canvas-panel').classList.add('is-3d');
    syncViewTabs();
    $('foot2d').hidden = true;
    $('foot3d').hidden = false;
    set2dToolsDisabled(true);

    if (v3d) {
      v3d.setVisible(true);
      /* 上次进来之后改过尺寸 → 这份 3D 已过期，按新尺寸重取 */
      if (v3dStale) return refresh3D(true);
      return;
    }

    v3dBusy = true;
    setStatus('', '正在加载 3D 立体视图…');
    import(v3dURL).then(function (m) {
      v3d = m.create($('view3d'), fill3dFoot, onPaperChange);
      /* 纸种跨盒型记住：翻下一个盒型时还是同一张纸，观感连贯 */
      var savedPk = savedPaper();
      if (savedPk) v3d.setPaper(savedPk);
      v3d.setVisible(true);
      return v3dStale ? refresh3D(true) : v3d.load(ID);
    }).then(function () {
      setStatus('', '3D 立体图已就绪');
    }).catch(function (e) {
      if (e && e.code === 'nofold') {
        no3D = true;
        view3dBtn.disabled = true;
        view3dBtn.title = '该盒型没有折叠结构，暂不支持 3D 立体图';
        setStatus('', '该盒型没有折叠结构（平面件／对折卡），暂无 3D 立体图');
      } else {
        setStatus('err', '3D 视图加载失败：' + (e && e.message ? e.message : e));
      }
      leave3D();
    }).then(function () { v3dBusy = false; });
  }

  /**
   * 按「输入框里的当前尺寸」重新计算折叠树。
   * @param allowFallback 首次进入时用：新尺寸算不出来（个别盒型在极端尺寸下算不出折叠树）
   *                      就退回标准尺寸，至少让用户看到立体图，并在状态栏说明。
   */
  function refresh3D(allowFallback) {
    if (!v3d) return Promise.resolve();
    setStatus('', '正在按当前尺寸重新折叠…');
    return v3d.load(ID, { pms: buildPms() }).then(function () {
      v3dStale = false;
      setStatus('', '3D 立体图已按当前尺寸重新折叠');
    }).catch(function (e) {
      if (allowFallback) {
        return v3d.load(ID).then(function () {
          v3dStale = true;
          setStatus('', '按当前尺寸重算失败，暂显示标准尺寸的 3D 图');
        });
      }
      v3dStale = true;      // 失败保留过期标记，下次进来还能再试
      setStatus('err', '按当前尺寸重算 3D 失败：' + (e && e.message ? e.message : e));
      throw e;
    });
  }

  function leave3D() {
    in3D = false;
    syncViewTabs();
    document.querySelector('.canvas').classList.remove('is-3d');
    document.querySelector('.canvas-panel').classList.remove('is-3d');
    $('foot2d').hidden = false;
    $('foot3d').hidden = true;
    set2dToolsDisabled(false);
    if (v3d) v3d.setVisible(false);
    applyZoom(true);
  }

  /* three 世界坐标 (x, y, z) = 长 × 宽 × 高（实测 400 盒的轴向对应关系，见 view3d.js 注释） */
  function fill3dFoot(info) {
    $('f3Size').textContent = info.size[0] + ' × ' + info.size[1] + ' × ' + info.size[2] + ' mm';
    $('f3Planes').textContent = info.planes;
    $('f3Hinges').textContent = info.hinges;
    $('f3CompWrap').hidden = !(info.comps > 1);
    $('f3Comps').textContent = info.comps;
    $('f3Steps').textContent = info.steps > 1 ? '（' + info.steps + ' 段折叠）' : '';
    /* 数据来源要说清楚：标准尺寸 / 按用户改后的尺寸现算 */
    var tag = $('f3Tag');
    if (tag) tag.textContent = info.custom ? '按当前尺寸重算' : '按标准尺寸生成';
  }

  /* ---------------- 内/外尺寸的真值（来自上游主尺寸标注） ----------------
     上游主尺寸标注的值是 [内尺寸, 外尺寸, 刀模尺寸] 三元组，内/外是**真值**
     —— 它把插舌、内衬这类结构占位算进去了，不是「制造 ± 2×补偿」推出来的。
     全库实测只有一半对得上（E055 官方内长 276，公式给 297，差 21mm），
     所以这里记「相对制造尺寸的差值」，改尺寸后按差值平移，值仍随改随变。 */

  var SP = { inn: {}, out: {} };

  function spansFrom(rm) {
    var inn = {}, out = {};
    (rm || []).forEach(function (r) {
      if (!Array.isArray(r[4]) || r[4].length < 3) return;
      var k = { l: 'L', w: 'W', d: 'D' }[String(r[0]).toLowerCase()];
      if (!k) return;
      inn[k] = r2(r[4][2] - r[4][0]);
      out[k] = r2(r[4][1] - r[4][2]);
    });
    return { inn: inn, out: out };
  }

  /* ==================== 参数面板 ==================== */

  function renderPanel() {
    // 尺寸类型
    $('segType').addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      dimType = b.dataset.t;
      syncSeg();
      renderDims();
      renderInfo();
      renderCanvas();   // 标牌高亮当前口径
    });
    syncSeg();

    // 单位
    $('unitToggle').addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      unit = b.dataset.u;
      syncUnit();
      renderDims();
      renderCanvas();   // 图上标注单位同步切换
    });
    syncUnit();

    renderDims();

    // 纸板厚度
    var calRange = G.cal || { min: 0, max: 10 };
    var calInput = $('calInput');
    calInput.value = S.t;
    calInput.min = calRange.min;
    calInput.max = calRange.max;
    $('calHint').textContent = '求解参数 CAL，可调 ' + calRange.min + '–' + calRange.max + ' mm';
    calInput.addEventListener('input', function () {
      var v = parseFloat(calInput.value);
      if (!isFinite(v)) return;
      ceLive.cal = v;
      compute();
      renderInfo();
    });
    $('btnCalReset').addEventListener('click', function () {
      calInput.value = S.t = r2((+ceLive.inner || 0) + (+ceLive.outer || 0));
      ceLive.cal = calInput.value;
      compute();
      renderInfo();
    });

    renderOtherParams();
    $('btnReset').addEventListener('click', resetAll);
    $('btnApply').addEventListener('click', function () { recompute(true); });
  }

  function syncSeg() {
    document.querySelectorAll('#segType button').forEach(function (b) {
      b.classList.toggle('on', b.dataset.t === dimType);
    });
    $('typeHint').textContent = dimType === 'm' ? '当前：制造尺寸'
      : dimType === 'i' ? '当前：内尺寸' : '当前：外尺寸';
  }

  function syncUnit() {
    document.querySelectorAll('#unitToggle button').forEach(function (b) {
      b.classList.toggle('on', b.dataset.u === unit);
    });
  }

  function sizeVal(side) {
    if (!S || !S[side]) return null;
    return dimType === 'm' ? S[side].m : dimType === 'i' ? S[side].i : S[side].o;
  }

  function renderDims() {
    ['L', 'W', 'D'].forEach(function (k) {
      var inp = $('dim' + k);
      var v = sizeVal(k);
      /* 盒型没有这一维时（ce 里是 0 或干脆没有），别把 0 显示出来 */
      if (dimMode && dimMode[k].mode === 'none') v = null;
      inp.value = v == null ? '' : V2.unitVal(v, unit);
      inp.placeholder = (dimMode && dimMode[k].mode === 'none') ? '不含此项' : '—';
    });
    document.querySelectorAll('.dim-unit').forEach(function (el) { el.textContent = unit; });
  }

  /**
   * 不可单独调整的尺寸（宽跟随长 / 由结构推算 / 盒型没有这一维）做成只读并写明原因。
   *
   * 背景：某些盒型根本没有「宽」这个参数（如 JP008 的求解串只有 长/高/高2），
   * 输入框看着能改、本地数字也会变，但回传后上游直接忽略它 —— 几何纹丝不动。
   * 与其让人反复试、怀疑是不是网站坏了，不如直接锁上并把原因写在下面。
   */
  function syncDimLock() {
    dimMode = V2.dimControl(G);
    ['L', 'W', 'D'].forEach(function (k) {
      var d = dimMode[k];
      var inp = $('dim' + k);
      var tag = $('tag' + k);
      if (!inp || !tag) return;
      var lock = d.mode !== 'edit';
      inp.readOnly = lock;
      inp.classList.toggle('is-lock', lock);
      var txt = lock ? V2.dimLockText(k, d) : '';
      tag.textContent = txt;
      tag.hidden = !txt;
      inp.title = txt;
    });
    renderDims();   // 可能要把「不含此项」那格的 0 / 旧值清掉
  }

  /** 改了别的尺寸、上游重算回来后，把只读尺寸同步成新值（方盒的宽会跟着长一起变） */
  function syncLockedDims() {
    ['L', 'W', 'D'].forEach(function (k) {
      if (!dimMode || dimMode[k].mode === 'edit') return;
      dims[k] = numOr(G.ce[k.toLowerCase()]);
    });
  }

  function bindDimInputs() {
    ['L', 'W', 'D'].forEach(function (k) {
      $('dim' + k).addEventListener('input', function () {
        if (dimMode && dimMode[k].mode !== 'edit') return;   // 只读项：万一被脚本塞值也拦住
        var raw = parseFloat(this.value);
        if (!isFinite(raw)) return;
        var mm = unit === 'in' ? raw / V2.MM2IN : raw;
        // 换算回「制造尺寸」
        dims[k] = dimType === 'm' ? mm
          : dimType === 'i' ? mm + 2 * S.inner
            : mm - 2 * S.outer;
        compute();
        renderInfo();
        renderCanvas();   // 图上标注按当前口径同步刷新
      });
    });
  }

  function renderOtherParams() {
    var main = ['l', 'w', 'd', 'cal'];
    var lv0 = (G.p || []).filter(function (p) { return p.l === 0 && main.indexOf(p.n) < 0; });
    $('otherParams').innerHTML = lv0.length
      ? lv0.map(paramHtml).join('')
      : '<div style="font-size:12.5px;color:var(--muted)">该盒型无额外外观参数</div>';

    /* 高级参数：按 Layer 分组（1..14），分层列出才好找 */
    var adv = (G.p || []).filter(function (p) { return p.l >= 1; });
    if (adv.length) {
      var byL = {};
      adv.forEach(function (p) { (byL[p.l] = byL[p.l] || []).push(p); });
      $('advParams').innerHTML = Object.keys(byL).sort(function (a, b) { return a - b; })
        .map(function (L) {
          return '<div class="param-layer"><span>第 ' + L + ' 层</span></div>'
            + byL[L].map(paramHtml).join('');
        }).join('');
    } else {
      $('advParams').innerHTML = '<div style="font-size:12.5px;color:var(--muted)">无</div>';
    }
    $('advWrap').style.display = adv.length ? '' : 'none';

    document.querySelectorAll('.param input, .param select').forEach(function (inp) {
      var ev = inp.tagName === 'SELECT' ? 'change' : 'input';
      inp.addEventListener(ev, function () {
        ceLive[this.dataset.n] = this.value;
        compute();
        renderInfo();
      });
    });
  }

  /* 下拉型参数（如「左右插孔数」1/2/3）渲染成 select，其余仍是数字输入 */
  function paramHtml(p) {
    var label = p.d || C.labels[p.n] || p.n;
    var n = V2.esc(p.n);
    var body;
    if (p.dl && p.dl.length) {
      /* dl: [{v: 传回后端的值, t: 显示文案}]，如 [{v:'1',t:'暗扣'},{v:'2',t:'锁扣'}] */
      body = '<select data-n="' + n + '">' + p.dl.map(function (o) {
        return '<option value="' + V2.esc(o.v) + '"'
          + (String(o.v) === String(p.v) ? ' selected' : '') + '>' + V2.esc(o.t) + '</option>';
      }).join('') + '</select>';
    } else {
      body = '<input type="number" step="any" data-n="' + n + '" value="' + V2.esc(p.v) + '">';
    }
    return '<div class="param">' +
      '<label title="' + n + '">' + V2.esc(label) + '</label>' +
      body + '</div>';
  }

  /* ==================== 信息卡 ==================== */

  function renderInfo() {
    var b = V2.bboxSize(G);
    $('infoBox').textContent = ID;

    var rows = [
      { k: 'm', label: '制造尺寸', cls: '' },
      { k: 'i', label: '内尺寸', cls: '' },
      { k: 'o', label: '外尺寸', cls: '' }
    ];

    var html = '<table class="size-table"><thead><tr><th>尺寸类型</th><th>长</th><th>宽</th><th>高</th></tr></thead><tbody>';
    rows.forEach(function (r) {
      var tds = ['L', 'W', 'D'].map(function (k) {
        var s = S[k];
        var v = s ? s[r.k] : null;
        return '<td>' + V2.num(v) + '</td>';
      }).join('');
      html += '<tr data-t="' + r.k + '" class="' + (dimType === r.k ? 'on' : '') + '">' +
        '<td>' + r.label + '</td>' + tds + '</tr>';
    });
    html += '</tbody></table>';
    $('sizeTable').innerHTML = html;

    $('sizeTable').querySelectorAll('tbody tr').forEach(function (tr) {
      tr.addEventListener('click', function () {
        dimType = tr.dataset.t;
        syncSeg(); renderDims(); renderInfo(); renderCanvas();
      });
    });

    $('kvExpand').textContent = V2.num(b.w) + ' × ' + V2.num(b.h) + ' mm';
    /* 纸板厚度按模型口径 = 内向补偿 + 外向补偿，与「外 − 内 = 2×纸板厚度」自洽。
       极少数盒型源数据的 cal 与 inner+outer 对不上（0017/M092/G013/G013A/HC010A），
       此时左侧输入框仍显示源参数 CAL，保证「重新计算刀模」能复现原始刀模。 */
    $('kvThick').textContent = V2.num(r2((+S.inner || 0) + (+S.outer || 0))) + ' mm';
    $('kvInner').textContent = V2.num(S.inner) + ' mm';
    $('kvOuter').textContent = V2.num(S.outer) + ' mm';
    $('kvCut').textContent = (B.cut || 0) + ' / ' + (B.cre || 0);
    $('kvMat').textContent = b.w * b.h / 1e6 >= 0 ? V2.num(r2(b.w * b.h / 1e6)) + ' m²' : '—';

    var es = $('expSize');
    if (es) es.textContent = '1:1 · ' + V2.num(b.w) + ' × ' + V2.num(b.h) + ' mm';
  }

  /* ==================== 导出 ==================== */

  function exportMeta() {
    return {
      g: G, id: ID, name: V2.displayName(B), box: B,
      sizes: S, dimType: dimType, unit: unit,
      dim: showDim,
      rm: { on: true, main: showMain, oth: showOth, choose: rmChoose(), txtMode: txtMode }
    };
  }

  function setExpNote(text, kind) {
    var el = $('expNote');
    if (!el) return;
    el.innerHTML = V2.esc(text);
    el.className = 'exp-note' + (kind ? ' ' + kind : '');
  }

  function bindExport() {
    /* 导出面板：顶栏按钮点开；点面板外 / 按 Esc 关掉。
       选完格式不自动关 —— 留着让用户看到「已导出 …」的结果提示。 */
    var menu = $('expMenu'), pop = $('expPop'), expBtn = $('expBtn');
    if (menu && pop && expBtn) {
      var setExpOpen = function (on) {
        pop.hidden = !on;
        expBtn.classList.toggle('on', on);
        expBtn.setAttribute('aria-expanded', on ? 'true' : 'false');
      };
      expBtn.addEventListener('click', function (e) {
        e.stopPropagation();            // 别让下面那个「点外面关」立刻把它关掉
        setExpOpen(pop.hidden);
      });
      document.addEventListener('click', function (e) {
        if (!pop.hidden && !menu.contains(e.target)) setExpOpen(false);
      });
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && !pop.hidden) { setExpOpen(false); expBtn.focus(); }
      });
    }

    var btns = document.querySelectorAll('.exp-btn');
    if (!btns.length) return;
    Array.prototype.forEach.call(btns, function (btn) {
      btn.addEventListener('click', function () {
        var kind = btn.dataset.exp;
        var meta = exportMeta();
        try {
          if (kind === 'svg') {
            V2.exportSVG(meta);
            setExpNote('已导出 SVG · 1:1 实际尺寸（mm），切割线 CUT / 压痕线 CREASE 分层', 'ok');
          } else if (kind === 'dxf') {
            var r = V2.exportDXF(meta);
            setExpNote('已导出 DXF · 切割线 ' + r.cut + ' 条 / 压痕线 ' + r.crease +
              ' 条，进刀模厂可直接用', 'ok');
          } else if (kind === 'pdf') {
            setExpNote('正在准备打印视图…', '');
            V2.exportPDF(meta).then(function (p) {
              setExpNote(p.ok
                ? '已调起打印（图纸 ' + p.w.toFixed(0) + ' × ' + p.h.toFixed(0) +
                  ' mm）· 缩放选「100% 实际大小」，目标选「另存为 PDF」'
                : (p.reason || 'PDF 导出失败'), p.ok ? 'ok' : 'err');
            });
          } else if (kind === 'png') {
            setExpNote('正在渲染 PNG…', '');
            V2.exportPNG(meta).then(function (r) {
              setExpNote('已导出 PNG · ' + r.w + ' × ' + r.h + ' px', 'ok');
            }).catch(function (e) {
              setExpNote('PNG 导出失败：' + e.message, 'err');
            });
          }
        } catch (e) {
          setExpNote('导出失败：' + e.message, 'err');
        }
      });
    });
  }

  /* ==================== 标签 & 相关 ==================== */

  function renderTags() {
    /* 过滤掉纯 SEO 关键词 / 关键词串标签（「包装纸箱设计」「玩具包装，电子产品包装」这类对选盒型没帮助） */
    $('tags').innerHTML = (B.tags || []).filter(function (t) {
      return !V2.isJunkName(t);
    }).map(function (t) {
      return '<a class="tag" href="index.html?q=' + encodeURIComponent(t) + '">' + V2.esc(t) + '</a>';
    }).join('');
  }

  function renderRelated() {
    var rel = C.boxes.filter(function (x) {
      return x.id !== ID && x.cats.indexOf(B.cat) >= 0;
    }).slice(0, 10);
    if (!rel.length) { $('relatedWrap').style.display = 'none'; return; }

    $('relatedRow').innerHTML = rel.map(function (x) {
      return '<a class="card" href="box.html?id=' + encodeURIComponent(x.id) + '">' +
        '<div class="thumb" data-box="' + V2.esc(x.id) + '"><svg viewBox="0 0 100 62" preserveAspectRatio="none"><rect x="12" y="10" width="76" height="42" rx="3" fill="#eceff3"/></svg></div>' +
        '<div class="card-body"><div class="card-title">' + V2.esc(V2.displayName(x)) + '</div>' +
        (V2.nameIsPlaceholder(x) ? '' : '<div class="card-id">' + V2.esc(x.id) + '</div>') + '</div></a>';
    }).join('');

    V2.ensureGeo(rel).then(function () {
      rel.forEach(function (x) {
        var host = document.querySelector('.thumb[data-box="' + cssEsc(x.id) + '"]');
        var g = V2.geoOf(x.id);
        if (host && g && (g.c.length || g.k.length)) host.innerHTML = V2.svg(g, { pad: 16 });
      });
    });
  }

  function cssEsc(s) { return String(s).replace(/["\\]/g, '\\$&'); }

  /* ==================== 重新计算 ==================== */

  function buildPms() {
    var order = [];
    var map = {};
    String(G.op || '').split(',').forEach(function (kv) {
      var i = kv.indexOf('=');
      if (i <= 0) return;
      var k = kv.slice(0, i).trim().toUpperCase();
      order.push(k);
      map[k] = kv.slice(i + 1).trim();
    });

    // 覆盖已改动的主参数
    if (dims.L != null) map.L = dims.L;
    if (dims.W != null) map.W = dims.W;
    if (dims.D != null) map.D = dims.D;
    map.CAL = ceLive.cal;

    // 只发送 packmage 自己使用的参数集（op）。
    // 其余 pm 参数（L1/W1/W2 等）是后端派生量，回传会污染求解结果，
    // 因此仅当用户显式改动过时才追加。
    var MAIN = { L: 1, W: 1, D: 1, CAL: 1 };
    (G.p || []).forEach(function (p) {
      var k = String(p.n).toUpperCase();
      if (MAIN[k] || (k in map)) return;
      var cur = ceLive[p.n];
      var orig = G.ce[p.n];
      if (cur != null && cur !== '' && String(cur) !== String(orig)) {
        order.push(k);
        map[k] = cur;
      }
    });

    return order.filter(function (k) { return map[k] !== undefined && map[k] !== ''; })
      .map(function (k) { return k + '=' + map[k]; }).join(',');
  }

  var apiOk = null;

  function setStatus(kind, text) {
    var el = $('status');
    el.className = 'status' + (kind ? ' ' + kind : '');
    el.innerHTML = '<i class="dot"></i>' + V2.esc(text);
  }

  function recompute(userAction) {
    setStatus('', '正在求解…');
    var body = JSON.stringify({ boxID: ID, inPms: buildPms() });

    fetch('/api/box', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || !j.success || !j.box) throw new Error((j && j.error) || '求解服务返回失败');
        apiOk = true;
        var nb = j.box;
        var de = nb.de || {};
        var ax = Math.abs(de.ox || 0), ay = Math.abs(de.oy || 0);
        var cuts = [], creases = [];
        (nb.fe || []).forEach(function (e) {
          var style = e[1];
          var dst = style === 0 ? cuts : creases;
          if (e[0] === 0) dst.push([[e[2] + ax, e[3] + ay], [e[4] + ax, e[5] + ay]]);
          else if (e[0] === 1) {
            var cx = e[2] + ax, cy = e[3] + ay, r = e[4], sa = e[5], ea = e[6];
            var diff = ea - sa;
            while (diff < 0) diff += 360;
            while (diff >= 360) diff -= 360;
            if (diff === 0 && sa !== ea) diff = 360;
            var steps = Math.max(16, Math.ceil(Math.abs(diff) / 3)), pts = [];
            for (var s = 0; s <= steps; s++) {
              var a = (sa + diff * (s / steps)) * Math.PI / 180;
              pts.push([cx + r * Math.cos(a), cy - r * Math.sin(a)]);
            }
            dst.push(pts);
          } else if (e[0] === 2) {
            var p2 = [];
            for (var j = 2; j < e.length; j += 2) p2.push([e[j] + ax, e[j + 1] + ay]);
            if (p2.length >= 2) dst.push(p2);
          }
        });
        var flat = function (polys) {
          return polys.map(function (pl) {
            var a = [];
            pl.forEach(function (p) { a.push(Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10); });
            return a;
          });
        };
        var all = cuts.concat(creases);
        var mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
        all.forEach(function (pl) {
          pl.forEach(function (p) {
            if (p[0] < mnx) mnx = p[0];
            if (p[0] > mxx) mxx = p[0];
            if (p[1] < mny) mny = p[1];
            if (p[1] > mxy) mxy = p[1];
          });
        });
        if (!isFinite(mnx)) { mnx = 0; mny = 0; mxx = 100; mxy = 100; }

        G = {
          b: [mnx, mny, mxx, mxy],
          c: flat(cuts), k: flat(creases),
          p: (nb.pm || []).length ? (nb.pm || []).map(function (p) {
            var o = { n: p.n, v: p.v, l: p.l || 0 };
            if (p.d) o.d = String(p.d);
            if (!/^(sty|choose|of|ct|nan|insty|tran)/i.test(p.n) && p.n !== 'cal') o.u = 1;
            return o;
          }) : G.p,
          ce: parseCe(nb.ce),
          op: (de.op || G.op),
          cal: G.cal,
          /* 标注随尺寸一起变（实测改 L 后坐标、值、条数都会更新），
             所以重算后要用上游新给的 Remarks；万一没拿到就沿用旧的，
             绝不能空着 —— 那会让整张图一条标注都没有。 */
          rm: (nb.rm && nb.rm.length) ? normRm(nb.rm, de.ox, de.oy) : G.rm
        };
        ceLive = Object.assign({}, G.ce, { cal: ceLive.cal });
        /* 只读尺寸要先按上游回来的新 ce 更新，再算、再画 —— 否则方盒改了长，
           宽的输入框还停在旧值上，看着就像「改了没反应」。 */
        syncLockedDims();
        syncDimLock();
        SP = spansFrom(G.rm);
        compute();
        renderDims();
        renderCanvas();
        renderInfo();
        setStatus('ok', '已按新尺寸求解（展开 ' + V2.num((G.b[2] - G.b[0])) + ' × ' + V2.num((G.b[3] - G.b[1])) + ' mm）');
        /* 尺寸一变，手上的 3D 折叠树就作废。3D 开着就立刻按新尺寸重做，
           没开就留下过期标记，等下次进 3D 时再取（不白打接口）。 */
        v3dStale = true;
        if (in3D && v3d) refresh3D(false).catch(function () {});
      })
      .catch(function (e) {
        apiOk = false;
        setStatus('err', '未连接求解服务，已保留原刀模图形（尺寸标注已更新）');
        $('offlineNote').style.display = '';
      });
  }

  /** 上游 Remarks → 站内格式：锚点坐标加 |Offset| 变成图面坐标
      （几何也是这么平移的，两端必须同一套坐标，否则标注会整体偏掉一个 Offset） */
  function normRm(items, ox, oy) {
    var ax = Math.abs(ox || 0), ay = Math.abs(oy || 0);
    return (items || []).filter(function (r) {
      return r && r.length >= 5 && r[3];
    }).map(function (r) {
      return [String(r[0]), r1(+r[1] + ax), r1(+r[2] + ay), String(r[3]),
        Array.isArray(r[4]) ? r[4].map(function (v) { return r2(+v); }) : r2(+r[4])];
    });
  }

  function parseCe(ce) {
    if (ce && typeof ce === 'object') return ce;
    var m = {};
    String(ce || '').split(',').forEach(function (s) {
      var i = s.indexOf('=');
      if (i > 0) m[s.slice(0, i).trim()] = s.slice(i + 1).trim();
    });
    return m;
  }

  function resetAll() {
    ceLive = Object.assign({}, G.ce);
    dims.L = numOr(G.ce.l);
    dims.W = numOr(G.ce.w);
    dims.D = numOr(G.ce.d);
    compute();
    var ci = $('calInput');
    ci.value = S.t;
    document.querySelectorAll('.param input').forEach(function (inp) {
      var n = inp.dataset.n;
      if (ceLive[n] != null) inp.value = ceLive[n];
    });
    renderDims();
    renderInfo();
    setStatus('', '已恢复为默认参数');
  }

  bindDimInputs();
})();
