/* ============================================================
   list.js — 列表页：分类筛选 + 搜索 + 卡片网格 + 几何懒加载
   ============================================================ */
(function () {
  'use strict';

  var V2 = window.V2;
  var C = null;
  var state = { cat: 'all', kw: '' };

  var $grid = document.getElementById('grid');
  var $cats = document.getElementById('cats');
  var $bar = document.getElementById('loadbar');
  var $heroTitle = document.getElementById('heroTitle');
  var $heroDesc = document.getElementById('heroDesc');

  /* ---------------- 启动 ---------------- */

  V2.loadCatalog().then(function (c) {
    C = c;
    c.boxes.forEach(function (b) { byId[b.id] = b; });
    document.getElementById('statTotal').textContent = c.total;
    document.getElementById('statCat').textContent = c.cats.length;
    document.getElementById('statChunk').textContent = c.chunks.length;
    renderCats();
    V2.bindTopSearch(c);

    var want = V2.qs('cat');
    if (want != null && c.cats.some(function (x) { return String(x.idx) === String(want); })) {
      state.cat = +want;
    }
    var kw0 = V2.qs('q');
    if (kw0) {
      state.kw = kw0.trim().toLowerCase();
      var qi = document.getElementById('q');
      if (qi) qi.value = kw0;
    }
    hvBind();
    render();
  }).catch(function (e) {
    $grid.innerHTML = '<div class="empty"><b>数据加载失败</b>' + V2.esc(e.message) + '</div>';
  });

  /* ---------------- 分类树 ---------------- */

  function renderCats() {
    var html = '<div class="side-title">盒型分类</div>';
    html += catBtn('all', '全部盒型', C.total);
    C.cats.forEach(function (c) { html += catBtn(c.idx, V2.catName(C.cats, c.idx), c.count); });
    $cats.innerHTML = html;

    $cats.addEventListener('click', function (e) {
      var b = e.target.closest('.cat-item');
      if (!b) return;
      state.cat = b.dataset.cat === 'all' ? 'all' : +b.dataset.cat;
      history.replaceState(null, '', state.cat === 'all' ? location.pathname : '?cat=' + state.cat);
      render();
    });
  }

  function catBtn(idx, name, count) {
    var on = String(state.cat) === String(idx) ? ' active' : '';
    return '<button class="cat-item' + on + '" data-cat="' + idx + '">' +
      '<span class="cat-name">' + V2.esc(name) + '</span>' +
      '<span class="cat-count">' + count + '</span></button>';
  }

  /* ---------------- 渲染 ---------------- */

  function current() {
    var list = C.boxes;
    if (state.cat !== 'all') {
      list = list.filter(function (b) { return b.cats.indexOf(state.cat) >= 0; });
    }
    if (state.kw) {
      var kw = state.kw;
      list = list.filter(function (b) {
        return b.id.toLowerCase().indexOf(kw) >= 0 ||
          b.name.toLowerCase().indexOf(kw) >= 0 ||
          b.tags.join(',').toLowerCase().indexOf(kw) >= 0;
      });
    }
    return list;
  }

  function render() {
    hvHide();                     /* 重绘前先收起悬浮预览，避免挂在已消失的卡片上 */
    var list = current();

    var catName = state.cat === 'all' ? '全部盒型' : catNameOf(state.cat);
    $heroTitle.textContent = catName;
    $heroDesc.textContent = state.kw
      ? '搜索「' + state.kw + '」，命中 ' + list.length + ' 个盒型'
      : '共 ' + list.length + ' 个盒型 · 点击卡片查看刀模展开图与内外制造尺寸';

    if (!list.length) {
      $grid.innerHTML = '<div class="empty"><b>没有匹配的盒型</b>换个关键词或分类试试</div>';
      return;
    }

    // 首屏：先出骨架，几何到位后填充
    $grid.innerHTML = list.map(cardHtml).join('');
    document.querySelectorAll('.cat-item').forEach(function (el) {
      el.classList.toggle('active', String(state.cat) === String(el.dataset.cat));
    });

    paintGeo(list);
  }

  function catNameOf(idx) { return V2.catName(C.cats, idx); }

  function cardHtml(b) {
    /* 源站把 SEO 关键词当了盒型名（如 0215「包装纸箱设计」），这类改用真类型名；
       连真类型名都没有时标题直接显示编号，并省掉第二行编号（否则重复） */
    var dn = V2.displayName(b);
    var ph = V2.nameIsPlaceholder(b);
    return '<a class="card" href="box.html?id=' + encodeURIComponent(b.id) + '">' +
      '<div class="thumb" data-box="' + V2.esc(b.id) + '">' + skeletonSvg() + '</div>' +
      '<div class="card-body">' +
      '<div class="card-title' + (ph ? ' is-id' : '') + '" title="' + V2.esc(b.id + ' · ' + (V2.typeName(b) || '未命名')) + '">' + V2.esc(dn) + '</div>' +
      (ph ? '' : '<div class="card-id">' + V2.esc(b.id) + '</div>') +
      '<div class="card-dims">' +
      (b.L && b.W && b.D
        ? '<span class="chip chip-accent">' + V2.num(b.L.m) + '×' + V2.num(b.W.m) + '×' + V2.num(b.D.m) + '</span>'
        : '<span class="chip">尺寸未标注</span>') +
      (b.t ? '<span class="chip">厚 ' + V2.num(b.t) + '</span>' : '') +
      '</div></div></a>';
  }

  function skeletonSvg() {
    return '<svg viewBox="0 0 100 75" preserveAspectRatio="none"><rect x="12" y="12" width="76" height="51" rx="3" fill="#eceff3"/></svg>';
  }

  /* 几何分批加载 + 填充 */
  function paintGeo(list) {
    var need = {};
    list.forEach(function (b) { need[b.ch] = 1; });
    var keys = Object.keys(need).map(Number).sort(function (a, b) { return a - b; });
    var done = 0;

    $bar.classList.remove('done');
    $bar.firstElementChild.style.width = '4%';

    keys.forEach(function (k) {
      V2.loadChunk(k).then(function () {
        fill(list.filter(function (b) { return b.ch === k; }));
        done++;
        $bar.firstElementChild.style.width = Math.round(100 * done / keys.length) + '%';
        if (done === keys.length) {
          $bar.classList.add('done');
          $bar.firstElementChild.style.width = '100%';
        }
      }).catch(function () { done++; });
    });
  }

  function fill(boxes) {
    boxes.forEach(function (b) {
      var host = document.querySelector('.thumb[data-box="' + cssEsc(b.id) + '"]');
      if (!host) return;
      var g = V2.geoOf(b.id);
      if (!g || !(g.c.length || g.k.length)) {
        host.innerHTML = '<div style="color:#b6bcc7;font-size:12px">无展开图</div>';
        return;
      }
      host.innerHTML = V2.svg(g, { pad: 16 });
    });
  }

  function cssEsc(s) { return String(s).replace(/["\\]/g, '\\$&'); }

  /* ---------------- 刀模 hover 预览（盒型参考图） ---------------- */

  var byId = {};
  var hv = document.getElementById('hvp');
  var hvId = document.getElementById('hvpId');
  var hvName = document.getElementById('hvpName');
  var hvDim = document.getElementById('hvpDim');
  var hvFlat = hv ? hv.querySelector('.hvp-flat') : null;
  var hvIso = hv ? hv.querySelector('.hvp-iso') : null;
  var hvFor = null, hvShowT = null, hvHideT = null;

  /* 立体盒预览：用 280×208 缩略图
     三级兜底  本地 data/thumbs/ → 回源 online.packmage.cn → 离线矢量示意（极少走到） */
  var THUMB_LOCAL = 'data/thumbs/';
  var THUMB_REMOTE = 'https://online.packmage.cn/Content/boximg/';
  var hvLoaded = {};

  function hvThumbUrl(id, remote) {
    return (remote ? THUMB_REMOTE : THUMB_LOCAL) + id + '-M.png';
  }

  /* 鼠标一压上就开始拉图：等浮层真正显示（150ms 后）时图基本已就位，不闪白 */
  function hvPreload(id) {
    if (!id || hvLoaded[id]) return;
    hvLoaded[id] = 1;
    var im = new Image();
    im.src = hvThumbUrl(id, false);
  }

  function hvPaint(b) {
    var g = V2.geoOf(b.id);
    hvFlat.innerHTML = (g && (g.c.length || g.k.length))
      ? V2.svg(g, { pad: 12 })
      : '<div class="hvp-wait">展开图未加载</div>';

    /* 左刀模 + 右立体图，即 V1「盒型参考图」的版式 */
    hvIso.innerHTML = '';
    var img = document.createElement('img');
    img.className = 'hvp-thumb';
    img.alt = b.id + ' 立体图';
    img.draggable = false;
    img.onerror = function () {
      if (!img.dataset.remote) {          /* 本地缺失 → 回源 */
        img.dataset.remote = '1';
        img.src = hvThumbUrl(b.id, true);
        return;
      }
      img.onerror = null;                 /* 远程也挂 → 矢量示意兜底 */
      hvIso.innerHTML = (b.L && b.W && b.D)
        ? V2.isoBox(b.L.m, b.W.m, b.D.m)
        : '<div class="hvp-wait">暂无参考图</div>';
    };
    img.src = hvThumbUrl(b.id, false);
    hvIso.appendChild(img);

    hvId.textContent = b.id;
    var tn = V2.typeName(b);
    hvName.textContent = tn ? ' · ' + tn : '';
    hvDim.textContent = (b.L && b.W && b.D)
      ? V2.num(b.L.m) + '×' + V2.num(b.W.m) + '×' + V2.num(b.D.m) + ' mm' : '';
  }

  function hvPlace(thumb) {
    var r = thumb.getBoundingClientRect();
    var w = hv.offsetWidth, h = hv.offsetHeight;
    var left = r.right + 14;
    if (left + w > innerWidth - 12) left = r.left - w - 14;          /* 右边放不下就放左边 */
    if (left < 12) left = Math.max(12, Math.min(r.left, innerWidth - w - 12));
    var top = r.top + r.height / 2 - h / 2;
    top = Math.max(12, Math.min(top, innerHeight - h - 12));
    hv.style.left = Math.round(left) + 'px';
    hv.style.top = Math.round(top) + 'px';
  }

  function hvShow(thumb) {
    var b = byId[thumb.dataset.box];
    if (!b || !hv) return;
    hvPaint(b);
    hv.hidden = false;
    hvPlace(thumb);                 /* 先量高度再定位 */
    hv.classList.add('on');
  }

  function hvHide() {
    clearTimeout(hvShowT); clearTimeout(hvHideT);
    hvFor = null;
    if (!hv) return;
    hv.classList.remove('on');
    hvHideT = setTimeout(function () { if (!hvFor) hv.hidden = true; }, 150);
  }

  function hvBind() {
    if (!hv) return;
    $grid.addEventListener('mouseover', function (e) {
      var th = e.target.closest ? e.target.closest('.thumb') : null;
      if (!th || th === hvFor) return;
      hvFor = th;
      clearTimeout(hvShowT); clearTimeout(hvHideT);
      var b = byId[th.dataset.box];
      if (!b) return;
      hvPreload(b.id);                /* 立即起拉缩略图，浮层出现时已就位 */
      /* 几何没到先拉分片，拉到了补画（不阻塞 hover） */
      var ready = !!V2.geoOf(b.id);
      hvShowT = setTimeout(function () { if (hvFor === th) hvShow(th); }, ready ? 150 : 220);
      if (!ready) {
        V2.loadChunk(b.ch).then(function () {
          if (hvFor === th && !hv.hidden) hvPaint(b);
        }).catch(function () {});
      }
    });
    $grid.addEventListener('mouseout', function (e) {
      var th = e.target.closest ? e.target.closest('.thumb') : null;
      if (!th || th !== hvFor) return;
      if (e.relatedTarget && th.contains(e.relatedTarget)) return;
      hvHide();
    });
    addEventListener('scroll', function () { if (hvFor) hvHide(); }, { passive: true });
    addEventListener('resize', function () { if (hvFor) hvHide(); });
  }

  /* ---------------- 搜索联动（列表内） ---------------- */

  var t = null;
  var q = document.getElementById('q');
  q.addEventListener('input', function () {
    clearTimeout(t);
    t = setTimeout(function () {
      state.kw = q.value.trim().toLowerCase();
      render();
    }, 220);
  });
})();
