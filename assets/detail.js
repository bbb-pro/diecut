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
  /* 用户显式改过的参数（大写 key → 值）。必须单独记一份：
     重求解成功后 ceLive 会被上游返回的 ce 覆盖，若靠「ceLive ≠ G.ce」来判断
     "改没改过"，用户上一次的改动就会在这一次请求里丢掉（实测：改 d2 再改 of，
     请求里只剩 OF，d2 的改动没了）。resetAll / 重新载入盒型时清空。 */
  var userPms = {};
  /* 盒型的原始默认值快照（首屏加载时的参数与长/宽/高）。
     「重置」必须回到这里 —— 拿 G.ce 当默认值会把重置变成"保持当前"，
     因为 G.ce 在每次重求解后都会被上游返回的新值覆盖（改过 L 之后 ce.l 就是新值）。 */
  var ce0 = null, dims0 = null;
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
    ce0 = Object.assign({}, G.ce);                       // 重置用的原始快照
    dims0 = { L: dims.L, W: dims.W, D: dims.D };
    SP = spansFrom(G.rm);
    compute();

    /* 各渲染步骤互相隔离：某一步抛错不该让后面全都不执行。
       ❗ 2026-09-22 事故复盘：缓存里的旧 JS 在「参数面板」这步写已删除的 #advParams 抛了
       TypeError，被启动链的 catch 接住 → 后面「尺寸对照 / 刀模规格 / 用途标签」三栏
       全都没渲染（用户看到的就是"这三栏信息都没了"）。一次单点故障不该瘫掉整页。
       这里逐步 try/catch：失败的记下来，其余照常渲染，并把失败项报到状态栏 + 控制台。 */
    var failed = [];
    [
      ['头部', renderHead],
      ['刀模图', renderCanvas],
      ['参数面板', renderPanel],
      ['尺寸口径', syncDimLock],
      ['尺寸对照', renderInfo],
      ['相关盒型', renderRelated],
      ['用途标签', renderTags],
      ['导出面板', bindExport]
    ].forEach(function (it) {
      try {
        it[1]();
      } catch (e) {
        failed.push(it[0]);
        if (window.console && console.error) console.error('[boot] ' + it[0] + ' 渲染失败', e);
      }
    });
    if (failed.length) setStatus('err', failed.join('、') + ' 渲染失败（其余区域正常，可尝试强制刷新）');
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

  /* ==================== 画布鼠标手势 ====================
     按看图类工具的肌肉记忆来：
       · 滚轮       → 缩放（以光标位置为焦点，不再需要按住 Ctrl）
       · 按住拖动   → 平移（左键或中键）
       · Shift+滚轮 → 放行给浏览器（横向滚动，需要时仍可用）
     原先只有「Ctrl+滚轮缩放」，平移只能拖滚动条。 */
  (function () {
    var h = host();
    if (!h) return;

    /* —— 滚轮缩放 —— */
    h.addEventListener('wheel', function (e) {
      if (in3D) return;                       // 3D 模式下滚轮归 OrbitControls
      if (e.shiftKey) return;                 // Shift+滚轮 留给浏览器做横向滚动
      e.preventDefault();

      /* 按 deltaY 连续缩放：鼠标滚轮一格 ≈ ±20%，触控板/精密滚轮则平滑跟随。
         1.6 倍限幅防止「一滚就飞」。 */
      var d = e.deltaY;
      if (e.deltaMode === 1) d *= 16;          // 行模式（部分 Firefox）
      else if (e.deltaMode === 2) d *= 100;    // 页模式
      var f = Math.exp(-d * 0.0018);
      f = Math.min(1.6, Math.max(1 / 1.6, f));

      var next = Math.max(0.25, Math.min(4, r1(zoom * f)));
      if (next === zoom) return;

      var rect = h.getBoundingClientRect();
      var px = e.clientX - rect.left, py = e.clientY - rect.top;
      /* 记下光标在「可滚动内容」里的比例 —— 缩放前后这个比例不变，
         视觉上就是光标底下那个点纹丝不动，缩放围绕它进行。 */
      var rx = (h.scrollLeft + px) / Math.max(1, h.scrollWidth);
      var ry = (h.scrollTop + py) / Math.max(1, h.scrollHeight);

      zoom = next;
      applyZoom(false);
      h.scrollLeft = rx * h.scrollWidth - px;
      h.scrollTop = ry * h.scrollHeight - py;
    }, { passive: false });

    /* —— 按住拖动平移（左键 / 中键）—— */
    var drag = null;
    h.addEventListener('mousedown', function (e) {
      if (in3D) return;
      if (e.button !== 0 && e.button !== 1) return;
      var t = e.target;
      if (t && t.closest && t.closest('input,select,textarea,a,button')) return;
      e.preventDefault();                    // 别顺手选中图上的文字；中键也别触发自动滚动
      drag = { x: e.clientX, y: e.clientY, sl: h.scrollLeft, st: h.scrollTop };
      h.classList.add('is-pan');
    });
    document.addEventListener('mousemove', function (e) {
      if (!drag) return;
      h.scrollLeft = drag.sl - (e.clientX - drag.x);
      h.scrollTop = drag.st - (e.clientY - drag.y);
    });
    function endPan() {
      if (!drag) return;
      drag = null;
      h.classList.remove('is-pan');
    }
    document.addEventListener('mouseup', endPan);
    window.addEventListener('blur', endPan);   // 拖到窗口外松手也要收尾
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
    try {
      var u = new URL(s ? s.src : location.href, location.href);
      /* ❗ 只换文件名、保留 query —— detail.js 的 URL 上带着缓存版本串（?v=xxx），
         用 new URL('view3d.js', s.src) 会把 query 丢掉，view3d.js 就仍命中
         4 小时的旧缓存，与新版 detail.js 错配（同 #advParams 那类事故）。 */
      u.pathname = u.pathname.replace(/detail\.js$/, 'view3d.js');
      return u.href;
    } catch (e) { return 'assets/view3d.js'; }
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
      scheduleRecompute();
    });
    $('btnCalReset').addEventListener('click', function () {
      calInput.value = S.t = r2((+ceLive.inner || 0) + (+ceLive.outer || 0));
      ceLive.cal = calInput.value;
      compute();
      renderInfo();
      scheduleRecompute();
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

  /* 上游不是「照单全收」的：越界值会被钳到盒型允许的范围，关联参数还会被按盒型
     公式一并重算。实测 JP008（长100/高20/高2 80/高低位10/长1 95/高1 40/半径40）：
       · 长1   ≤ 长 − 4mm          传 200 → 实际 96
       · 半径 ≤ 长1 ÷ 2            传 500 → 实际 47.5
       · 高 / 高2 ≥ 10mm           传 1 或 0 → 实际 10
       · 高低位 ≤ 长               传 999 → 实际 100
       · 纸厚 ≤ 3mm                传 99 → 实际 3
       · 改「长」会连带重算 长1/半径；改「高2」会连带重算 高1
     所以每次重算回来，都要把**上游的实际生效值**写回输入框 ——
     否则界面显示 200、刀模却按 96 画，用户以为「改了没用」。
     返回被改动的项，供状态栏提示。 */
  function syncPmsFromCe() {
    var fixed = [];
    var inp = document.querySelectorAll('#otherParams .param input, #otherParams .param select');
    Array.prototype.forEach.call(inp, function (el) {
      var n = el.dataset.n;
      if (!n) return;
      var key = String(n).toUpperCase();
      var v = (G.ce || {})[String(n).toLowerCase()];
      if (v == null || v === '' || String(v) === String(el.value)) return;
      if (document.activeElement === el) return;   // 正在输入的框别打断（失焦后自然对齐）
      /* 下拉项：上游若回了个没在选项里的值（选项表与求解器版本对不上时会发生），
         直接 el.value = v 会静默变成空选中 —— 宁可不改，也别把界面弄成空的。 */
      if (el.tagName === 'SELECT') {
        var hit = Array.prototype.some.call(el.options, function (o) { return String(o.value) === String(v); });
        if (!hit) return;
      }
      el.value = v;
      /* 只有「用户自己改过这一项」时才把 userPms 一起对齐：
         上游的**派生重算**（如改长导致长1变小）不能当成用户意图固化，
         否则用户把长改回去，长1 也回不去了。 */
      if (Object.prototype.hasOwnProperty.call(userPms, key)) userPms[key] = v;
      fixed.push(key + ' ' + el.value);
    });

    /* 主尺寸也可能被钳制（高 传 1 → 上游用 10）。只回填可编辑的那种；
       只读项（方盒的宽之类）上面 syncLockedDims() 已经同步过了。 */
    ['L', 'W', 'D'].forEach(function (k) {
      if (!dimMode || dimMode[k].mode !== 'edit') return;
      var nv = numOr(G.ce[k.toLowerCase()]);
      if (isFinite(nv) && nv > 0 && Math.abs(nv - dims[k]) > 1e-6) {
        dims[k] = nv;
        fixed.push(k + ' ' + nv);
      }
    });

    /* 纸板厚：用户主动改过才回填（首屏保持「显示源参数 CAL 以复现原始刀模」的老约定） */
    if (Object.prototype.hasOwnProperty.call(userPms, 'CAL') && G.ce.cal != null
      && String(G.ce.cal) !== String(userPms.CAL)) {
      userPms.CAL = G.ce.cal;
      ceLive.cal = G.ce.cal;
      var ci = $('calInput');
      if (ci && document.activeElement !== ci) ci.value = G.ce.cal;
      fixed.push('CAL ' + G.ce.cal);
    }
    return fixed;
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
        scheduleRecompute();   // 改完尺寸同样自动问一次上游
      });
    });
  }

  function renderOtherParams() {
    /* 主尺寸（长/宽/高/纸板厚）已在上面单独成组，这里放其余**全部**参数。
       原先按上游 Layer 拆成「其他参数（第 0 层）/ 高级参数（第 1~14 层，还按层再分组）」，
       分类太碎、找参数要翻两层 —— 按用户要求合并成一个列表，
       顺序沿用上游给的参数顺序（上游顺序本身有含义）。 */
    var main = ['l', 'w', 'd', 'cal'];
    var rest = (G.p || []).filter(function (p) { return main.indexOf(p.n) < 0; });
    $('otherParams').innerHTML = rest.length
      ? rest.map(paramHtml).join('')
      : '<div style="font-size:12.5px;color:var(--muted)">该盒型无额外参数</div>';

    document.querySelectorAll('.param input, .param select').forEach(function (inp) {
      var ev = inp.tagName === 'SELECT' ? 'change' : 'input';
      inp.addEventListener(ev, function () {
        ceLive[this.dataset.n] = this.value;
        userPms[String(this.dataset.n).toUpperCase()] = this.value;   // 记牢，别被重求解冲掉
        compute();
        renderInfo();
        scheduleRecompute();   // 改完自动问一次上游，不必再手动点按钮
      });
    });
  }

  /* 下拉型参数（如「左右插孔数」1/2/3）渲染成 select，其余仍是数字输入 */
  function paramHtml(p) {
    /* 标签 = 上游中文名（或 catalog 标签表）优先，后面跟一个参数代码小标。
       代码是刀模图 / 上游求解串（de.op）里用的名字（如 d2 / of / l1），
       光看中文名对不上图上的标注，所以两个一起给。
       若没有中文名（label 退化成代码本身），就不重复显示。 */
    var code = String(p.n == null ? '' : p.n);
    var labels = (C && C.labels) || {};
    var label = p.d || labels[p.n] || code;
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
      '<label title="' + n + '">' +
        '<span class="pname">' + V2.esc(label) + '</span>' +
        (code && label !== code ? '<span class="pcode">' + V2.esc(code) + '</span>' : '') +
      '</label>' +
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
    // ① 基底：上游自己用的求解参数串（op）
    String(G.op || '').split(',').forEach(function (kv) {
      var i = kv.indexOf('=');
      if (i <= 0) return;
      var k = kv.slice(0, i).trim().toUpperCase();
      order.push(k);
      map[k] = kv.slice(i + 1).trim();
    });

    // ② 主尺寸：dims 才是权威（已经按内/外/刀模口径换算过）
    if (dims.L != null) map.L = dims.L;
    if (dims.W != null) map.W = dims.W;
    if (dims.D != null) map.D = dims.D;
    map.CAL = ceLive.cal;

    /* ③ 用户显式改过的参数：**无条件回传**。
       上游求解是无状态的 —— 每次只认本次传过去的参数，所以用户改过的值
       必须每次带上，否则第二次改动会把第一次的改动顶掉（实测：改 d2 再改 of，
       请求里只剩 OF，d2 回到默认）。
       另外 op 里的 key 也要允许覆盖：像 JP008 的 d2 既是 op 成员
       （`D2=80`）又显示在「其他参数」面板里，旧代码用 `k in map` 直接跳过它，
       于是面板里改了 d2 却传不上去（点「重新计算」也没反应）。 */
    var MAIN = { L: 1, W: 1, D: 1, CAL: 1 };
    Object.keys(userPms).forEach(function (k) {
      if (MAIN[k]) return;                                   // 主尺寸/纸厚另有来源
      var v = userPms[k];
      if (v == null || v === '') return;
      if (!Object.prototype.hasOwnProperty.call(map, k)) order.push(k);
      map[k] = v;
    });

    return order.filter(function (k) { return map[k] !== undefined && map[k] !== ''; })
      .map(function (k) { return k + '=' + map[k]; }).join(',');
  }

  var apiOk = null;

  /* ==================== 自动重求解 ====================
     改参数后自动问一次上游（不必再手动点「重新计算刀模」）——
     这是上游设计器的行为。两点保护：
       ① 防抖 700ms：连续输入/点步进器只发最后一次
       ② 串行：同一时刻只允许一个请求在飞；飞的过程中又改了，等这次回来再补一次
     已知离线（apiOk === false）时不再打接口，免得每次都撞墙。 */
  var rcTimer = null, rcBusy = false, rcAgain = false;

  function scheduleRecompute() {
    if (apiOk === false) return;
    clearTimeout(rcTimer);
    rcTimer = setTimeout(function () { recompute(false); }, 700);
  }

  function endRecompute() {
    rcBusy = false;
    if (rcAgain) { rcAgain = false; recompute(false); }
  }

  function setStatus(kind, text) {
    var el = $('status');
    if (!el) return;   // 元素缺失时静默跳过：状态提示本身不该再抛错
    el.className = 'status' + (kind ? ' ' + kind : '');
    el.innerHTML = '<i class="dot"></i>' + V2.esc(text);
  }

  function recompute(userAction) {
    if (rcBusy) { rcAgain = true; return; }   // 已有请求在飞 → 记一笔，回来后再补发
    rcBusy = true;
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
          /* 参数表也用上游最新的一份：值会随尺寸联动（如 JP008 把 d1 校正成 96.67）。
             ❗ 两层防御：
               ① 字段名兼容 —— 上游原始 PmItems 用 Name/DefaultV/Layer，本站格式用 n/v/l；
               ② 映射不出有效项时**保留旧的 G.p** —— 否则 G.p 被 {n:undefined} 的
                  空壳项污染，buildPms 遍历时全被跳过，之后改任何参数都传不回上游
                  （实测踩到：改 d2 只有第一次生效，后续改动静默丢失）。 */
          p: (function () {
            var arr = (nb.pm || []).map(function (p) {
              var nm = p.n || p.Name || p.name || '';
              var o = {
                n: String(nm).toLowerCase(),
                v: (p.v != null ? p.v : (p.DefaultV != null ? p.DefaultV : '')),
                l: p.l || p.Layer || 0
              };
              if (p.d || p.Desc) o.d = String(p.d || p.Desc);
              if (p.dl) o.dl = p.dl;
              if (!/^(sty|choose|of|ct|nan|insty|tran)/i.test(o.n) && o.n !== 'cal') o.u = 1;
              return o;
            }).filter(function (o) { return !!o.n; });
            return arr.length ? arr : G.p;
          })(),
          ce: parseCe(nb.ce),
          /* ❗ op 是「盒型默认的求解参数串」，必须保持首屏那一份：
             上游返回的 de.op 是**按本次传入参数**生成的（改过 L 之后里面就写着 L=420），
             拿它当新基底 → 用户的改动会被固化成新默认值，点「重置」也退不回去
             （实测：重置后请求里仍带 STY1=3）。 */
          op: G.op,
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
        /* 再把上游的实际生效值写回参数输入框：越界值是被上游钳制过的
           （如 长1 传 200 实际按 96 算），不写回去界面上就是假的。 */
        var pmsFixed = syncPmsFromCe();
        syncDimLock();
        SP = spansFrom(G.rm);
        compute();
        renderDims();
        renderCanvas();
        renderInfo();
        setStatus('ok', '已按新尺寸求解（展开 ' + V2.num((G.b[2] - G.b[0])) + ' × ' + V2.num((G.b[3] - G.b[1])) + ' mm）'
          + (pmsFixed.length
            ? ' · ' + pmsFixed.length + ' 项已按盒型规则校正（' + pmsFixed.slice(0, 3).join('、')
              + (pmsFixed.length > 3 ? ' 等' : '') + '）'
            : ''));
        /* 尺寸一变，手上的 3D 折叠树就作废。3D 开着就立刻按新尺寸重做，
           没开就留下过期标记，等下次进 3D 时再取（不白打接口）。 */
        v3dStale = true;
        if (in3D && v3d) refresh3D(false).catch(function () {});
        endRecompute();
      })
      .catch(function (e) {
        apiOk = false;
        setStatus('err', '未连接求解服务，已保留原刀模图形（尺寸标注已更新）');
        $('offlineNote').style.display = '';
        endRecompute();
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
    /* ❗ 回到 ce0 / dims0（首屏快照），不能用 G.ce —— 它已经被重求解结果覆盖了，
       否则「恢复默认」会变成「保持当前」（实测：改长 420 后点重置纹丝不动）。 */
    ceLive = Object.assign({}, ce0 || G.ce);
    userPms = {};          // 改动记录一起清掉，否则「恢复默认」后下次重求解又把旧改动带上去
    var d0 = dims0 || { L: numOr(G.ce.l), W: numOr(G.ce.w), D: numOr(G.ce.d) };
    dims.L = d0.L;
    dims.W = d0.W;
    dims.D = d0.D;
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
    scheduleRecompute();   // 参数全还原了，同步问一次上游
  }

  bindDimInputs();
})();
