/* ============================================================
   common.js — 列表页 / 详情页共用能力
   ============================================================ */
(function () {
  'use strict';

  var V2 = window.V2 = window.V2 || {};

  /* ---------------- 数据加载 ---------------- */

  var _loaded = {};
  var BASE = 'data/';

  function loadScript(src) {
    if (_loaded[src]) return _loaded[src];
    _loaded[src] = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('加载失败: ' + src)); };
      document.head.appendChild(s);
    });
    return _loaded[src];
  }

  V2.loadCatalog = function () {
    if (window.V2_CATALOG) return Promise.resolve(window.V2_CATALOG);
    return loadScript(BASE + 'catalog.js').then(function () { return window.V2_CATALOG; });
  };

  V2.loadChunk = function (i) {
    var f = String(i).padStart(2, '0');
    return loadScript(BASE + 'geo/' + f + '.js');
  };

  /** 确保某批盒型的几何已就绪 */
  V2.ensureGeo = function (boxes) {
    var need = {};
    boxes.forEach(function (b) { need[b.ch] = 1; });
    var list = Object.keys(need).map(function (k) { return V2.loadChunk(k); });
    return Promise.all(list);
  };

  V2.geoOf = function (id) { return (window.V2_GEO || {})[id]; };

  /* ---------------- 配色 / 线宽 ---------------- */

  /* 注意：这两个字体栈会写进 style="..." 属性里，只能用单引号，
     用双引号会提前闭合属性，导出的 SVG 就成了非法 XML（图片加载会失败）。 */
  var FONT = "system-ui,-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif";
  var MONO = "ui-monospace,Menlo,Consolas,'Courier New',monospace";

  /** 导出用线宽（用户单位 = mm，即 1:1 图纸上的物理线宽） */
  V2.SW_MM = { cut: 0.25, crease: 0.22, dim: 0.16, dash: [1.2, 0.9] };

  V2.COLOR = {
    cut: '#1b1f27',
    crease: '#d93a3f',
    dim: '#93a0ae',
    arrow: '#5b6472',
    text: '#39414d',
    text2: '#6b7683',
    outer: '#e8853a',
    make: '#2f6df6',
    inner: '#12a594'
  };

  /** 长/宽/高 在展开图上的定位配色 */
  V2.MARK_COLOR = { L: '#3b6ef5', W: '#ef7f2c', D: '#12a594' };
  V2.MARK_NAME = { L: '长', W: '宽', D: '高' };
  var MARK_ORDER = { L: 0, W: 1, D: 2 };   // 摆放优先级：长先占中线，宽高再避让
  var MARK_BOX = null;                     // markLayer 把标注牌外沿写在这里，V2.svg 据此撑画布

  /* ---------------- 几何 -> SVG ---------------- */

  /** 把扁平折线数组转成一条 path 的 d 字符串 */
  function toPath(polys) {
    var d = '';
    for (var i = 0; i < polys.length; i++) {
      var a = polys[i];
      if (!a || a.length < 4) continue;
      d += 'M' + a[0] + ' ' + a[1];
      for (var j = 2; j < a.length; j += 2) d += 'L' + a[j] + ' ' + a[j + 1];
    }
    return d;
  }

  V2.toPath = toPath;

  /** 标注字号兜底推算（用户单位）——详情页会用真实渲染比例再校正一次 */
  V2.dimFontSize = function (g) {
    var W = g.b[2] - g.b[0], H = g.b[3] - g.b[1];
    return Math.max(3, Math.min(30, Math.min(W, H) / 26));
  };

  /**
   * 生成刀模 SVG 字符串。
   * opts: { pad, dim, unit, fs, nameW, nameH,
   *         marks, dims, markLabel, standalone, sw, dash, px }
   *   dim        绘制工程制式尺寸标注（上=展开宽，左=展开高）
   *   marks      在展开图上标出「长/宽/高」分别对应哪一块面板（需要 dims）
   *   dims       {L,W,D} 制造尺寸（mm），用于定位面板
   *   markLabel  {L:'长 120', ...} 自定义标注文字，不传则按 dims 自动生成
   *   standalone 生成可独立打开的 SVG（内联样式 + 物理 mm 尺寸），用于导出
   *   sw/dash    导出线宽与虚线节距（用户单位），不传用 V2.SW_MM
   *   px         导出为位图时给 <svg> 写死的像素宽度
   */
  V2.svg = function (g, opts) {
    opts = opts || {};
    var b = g.b;
    var W = b[2] - b[0], H = b[3] - b[1];
    var basePad = opts.pad == null ? 14 : opts.pad;
    var useDim = !!opts.dim;
    var useMark = !!opts.marks && !!opts.dims && !!(opts.dims.L || opts.dims.W || opts.dims.D);

    var SW = opts.sw || V2.SW_MM;
    var DASH = opts.dash || V2.SW_MM.dash;

    var fs = (useDim || useMark) ? (opts.fs || V2.dimFontSize(g)) : 0;
    fs = Math.max(0.3, Math.min(200, fs));
    var band = fs * 1.5;                 // 尺寸线距图形边缘的距离

    var padL = basePad, padT = basePad, padR = basePad, padB = basePad;
    if (useDim) {
      padT = band + fs * 1.7;
      padL = band + fs * 1.4;
      padR = Math.max(basePad * 0.4, fs * 0.8);
      padB = Math.max(basePad * 0.4, fs * 0.8);
    }

    /* 标注牌比图形边缘还靠外时（窄面板 + 大字），把画布扩出去，别把牌子裁掉 */
    var markStr = '';
    if (useMark) {
      markStr = markLayer(b, fs, opts);
      if (MARK_BOX) {
        padL = Math.max(padL, b[0] - MARK_BOX.x0 + fs * 0.6);
        padT = Math.max(padT, b[1] - MARK_BOX.y0 + fs * 0.6);
        padR = Math.max(padR, MARK_BOX.x1 - b[2] + fs * 0.6);
        padB = Math.max(padB, MARK_BOX.y1 - b[3] + fs * 0.6);
      }
    }

    var x0 = b[0] - padL, y0 = b[1] - padT;
    var vw = W + padL + padR, vh = H + padT + padB;
    var vb = [x0, y0, vw, vh].map(round1).join(' ');

    var s = '<svg viewBox="' + vb + '" preserveAspectRatio="xMidYMid meet" ' +
      'xmlns="http://www.w3.org/2000/svg" role="img"';
    if (opts.standalone) {
      if (opts.px) s += ' width="' + Math.round(opts.px) + '" height="' +
        Math.round(opts.px * vh / vw) + '"';
      else s += ' width="' + round1(vw) + 'mm" height="' + round1(vh) + 'mm"';
    }
    s += '>';

    var cut = toPath(g.c);
    var cre = toPath(g.k);

    if (cre) {
      s += '<path' + clsAttr(opts, 'crease',
        'fill:none;stroke:' + V2.COLOR.crease + ';stroke-width:' + SW.crease +
        ';stroke-dasharray:' + DASH[0] + ' ' + DASH[1] + ';stroke-linecap:butt"') +
        ' d="' + cre + '"/>';
    }
    if (cut) {
      s += '<path' + clsAttr(opts, 'cut',
        'fill:none;stroke:' + V2.COLOR.cut + ';stroke-width:' + SW.cut +
        ';stroke-linejoin:round;stroke-linecap:round"') +
        ' d="' + cut + '"/>';
    }
    if (useDim) s += dimLayer(b, fs, band, opts);
    if (useMark) s += markStr;
    s += '</svg>';
    return s;
  };

  /** 屏幕用 class，导出用内联 style（style 值里的双引号必须转成单引号，否则 XML 非法） */
  function clsAttr(opts, name, inline) {
    return opts.standalone
      ? ' style="' + String(inline).replace(/"/g, "'") + '"'
      : ' class="' + name + '"';
  }

  function round1(v) { return Math.round(v * 10) / 10; }

  /** 估算文本在用户单位下的长度（CJK 计 1 字宽，西文数字计 0.58） */
  function textW(str, fs) {
    var n = 0;
    for (var i = 0; i < str.length; i++) {
      n += str.charCodeAt(i) > 0x2e80 ? 1 : 0.58;
    }
    return n * fs;
  }

  /** 一个 <text> 元素（fill 一律内联，保证标牌配色不被样式表覆盖） */
  function txt(opts, x, y, fs, fill, anchor, weight, str, mono) {
    var css = 'fill:' + fill + ';';
    if (opts.standalone) css += 'font-family:' + (mono ? MONO : FONT) + ';font-weight:' + weight + ';';
    return '<text' + clsAttr(opts, 'dimtxt', css) +
      ' x="' + round1(x) + '" y="' + round1(y) + '" font-size="' + round1(fs) +
      '" font-weight="' + weight + '" text-anchor="' + anchor + '"' +
      (mono ? ' font-family="' + MONO.replace(/"/g, "'") + '"' : '') +
      '>' + esc(str) + '</text>';
  }

  /** 屏幕模式下标注文字要加白描边（避免压线看不清） */
  function haloAttr(opts, sw) {
    return opts.standalone ? '' : ' stroke-width="' + round1(sw) + '"';
  }

  /* ---------------- 展开尺寸标注（上=宽，左=高） ---------------- */

  function dimLayer(b, fs, band, opts) {
    var unit = opts.unit === 'in' ? 'in' : 'mm';
    var conv = function (mm) { return V2.unitVal(mm, unit); };
    var W = b[2] - b[0], H = b[3] - b[1];
    var al = fs * 0.95;          // 箭头长度
    var gap = fs * 0.5;          // 尺寸界线与图形的间隙
    var over = fs * 0.7;         // 尺寸界线超出尺寸线的长度
    var txtGap = fs * 0.55;      // 文字与尺寸线的间距
    var halo = fs * 0.22;        // 文字描边（白底）宽度
    var out = '';

    if (opts.standalone) {
      out += '<g style="fill:none;stroke:' + V2.COLOR.dim + ';stroke-width:' + (opts.sw || V2.SW_MM).dim + '">';
    }

    /* ---- 顶部：展开宽 ---- */
    {
      var labW = (opts.nameW || '展开宽') + ' ' + conv(W) + ' ' + unit;
      if (textW(labW, fs) > W * 0.94) labW = conv(W) + ' ' + unit;   // 装不下就转紧凑
      var dy = b[1] - band;
      out += '<line class="dim" x1="' + round1(b[0]) + '" y1="' + round1(b[1] - gap) +
        '" x2="' + round1(b[0]) + '" y2="' + round1(dy - over) + '"/>';
      out += '<line class="dim" x1="' + round1(b[2]) + '" y1="' + round1(b[1] - gap) +
        '" x2="' + round1(b[2]) + '" y2="' + round1(dy - over) + '"/>';
      out += '<line class="dim" x1="' + round1(b[0]) + '" y1="' + round1(dy) +
        '" x2="' + round1(b[2]) + '" y2="' + round1(dy) + '"/>';
      if (opts.standalone) out += '</g>';
      out += arrow(opts, b[0], dy, 1, 0, al);
      out += arrow(opts, b[2], dy, -1, 0, al);
      out += txt(opts, (b[0] + b[2]) / 2, dy - txtGap, fs, V2.COLOR.text, 'middle', '600', labW);
    }

    /* ---- 左侧：展开高 ---- */
    {
      if (opts.standalone) {
        out += '<g style="fill:none;stroke:' + V2.COLOR.dim + ';stroke-width:' + (opts.sw || V2.SW_MM).dim + '">';
      }
      var labH = (opts.nameH || '展开高') + ' ' + conv(H) + ' ' + unit;
      if (textW(labH, fs) > H * 0.94) labH = conv(H) + ' ' + unit;
      var dx = b[0] - band;
      out += '<line class="dim" x1="' + round1(b[0] - gap) + '" y1="' + round1(b[1]) +
        '" x2="' + round1(dx - over) + '" y2="' + round1(b[1]) + '"/>';
      out += '<line class="dim" x1="' + round1(b[0] - gap) + '" y1="' + round1(b[3]) +
        '" x2="' + round1(dx - over) + '" y2="' + round1(b[3]) + '"/>';
      out += '<line class="dim" x1="' + round1(dx) + '" y1="' + round1(b[1]) +
        '" x2="' + round1(dx) + '" y2="' + round1(b[3]) + '"/>';
      if (opts.standalone) out += '</g>';
      out += arrow(opts, dx, b[1], 0, 1, al);
      out += arrow(opts, dx, b[3], 0, -1, al);
      var cy = (b[1] + b[3]) / 2;
      out += '<text' + clsAttr(opts, 'dimtxt',
        'font-family:' + FONT + ';font-size:' + round1(fs) + 'px;font-weight:600;fill:' +
        V2.COLOR.text) +
        haloAttr(opts, halo) +
        ' x="' + round1(dx - txtGap) + '" y="' + round1(cy) + '" font-size="' + round1(fs) +
        '" text-anchor="middle" transform="rotate(-90 ' + round1(dx - txtGap) + ' ' +
        round1(cy) + ')">' + esc(labH) + '</text>';
    }

    return out;
  }

  /** 箭头（实心三角），(x,y) 为箭尖，dir 指向外 */
  function arrow(opts, x, y, dx, dy, al) {
    var w = al * 0.34;
    var p;
    if (dx) p = [[x, y], [x - dx * al, y - w], [x - dx * al, y + w]];
    else p = [[x, y], [x - w, y - dy * al], [x + w, y - dy * al]];
    var d = 'M' + p.map(function (q) { return round1(q[0]) + ' ' + round1(q[1]); }).join(' L') + 'Z';
    return '<path' + clsAttr(opts, 'dimarrow',
      'fill:' + V2.COLOR.arrow + ';stroke:none') + ' d="' + d + '"/>';
  }

  /* ---------------- 长/宽/高 在展开图上的位置定位 ----------------
     思路：盒子的长/宽/高一定体现为「两块压痕线之间的一段间距」。
     把展开图里所有轴对齐线段扫出来 → 按键值聚类 → 找间距等于 L/W/D 的那一对 →
     再取这对线段之间被其它线段切分出的最大空档，就是那个面板的实际范围。
     识别不出来就不标注，绝不瞎标。                                    */

  /** 扫出轴对齐线段（V=竖线，H=横线），k 为线所在坐标 */
  function axisLines(polys) {
    var V = [], H = [];
    for (var i = 0; i < polys.length; i++) {
      var pl = polys[i];
      if (!pl) continue;
      for (var j = 0; j + 3 < pl.length; j += 2) {
        var x1 = pl[j], y1 = pl[j + 1], x2 = pl[j + 2], y2 = pl[j + 3];
        if (Math.abs(x1 - x2) < 0.05 && Math.abs(y2 - y1) > 0.5) {
          V.push({ k: round1(x1), a: Math.min(y1, y2), b: Math.max(y1, y2) });
        } else if (Math.abs(y1 - y2) < 0.05 && Math.abs(x2 - x1) > 0.5) {
          H.push({ k: round1(y1), a: Math.min(x1, x2), b: Math.max(x1, x2) });
        }
      }
    }
    return { V: V, H: H };
  }

  /** 把线段坐标聚类成「板界」：{k, iv:[[a,b],…]}，相邻差值 ≤ tol 视为同一条 */
  function boardGroups(segs, tol) {
    if (!segs.length) return [];
    var s = segs.slice().sort(function (p, q) { return p.k - q.k; });
    var out = [], cur = null;
    s.forEach(function (g) {
      if (!cur || g.k - cur.k > tol) { cur = { k: g.k, iv: [[g.a, g.b]] }; out.push(cur); }
      else cur.iv.push([g.a, g.b]);
    });
    out.forEach(function (o) { o.k = round1(o.k); o.iv = mergeIv(o.iv); });
    return out;
  }

  /** 合并重叠或相接的区间 */
  function mergeIv(list) {
    var a = list.slice().sort(function (p, q) { return p[0] - q[0]; });
    var out = [];
    a.forEach(function (p) {
      var last = out[out.length - 1];
      if (last && p[0] <= last[1] + 0.5) last[1] = Math.max(last[1], p[1]);
      else out.push([p[0], p[1]]);
    });
    return out;
  }

  /** 区间集合与 [lo,hi] 的重叠总长 */
  function ovLen(iv, lo, hi) {
    var s = 0;
    for (var i = 0; i < iv.length; i++) {
      var a = Math.max(iv[i][0], lo), c = Math.min(iv[i][1], hi);
      if (c > a) s += c - a;
    }
    return s;
  }

  /** 两条板界共同覆盖的范围：先取重叠区间；重叠被切得很碎时退化为最长的一段 */
  function perpOf(A, B) {
    var iv = [];
    A.forEach(function (p) {
      B.forEach(function (q) {
        var lo = Math.max(p[0], q[0]), hi = Math.min(p[1], q[1]);
        if (hi - lo > 0.4) iv.push([lo, hi]);
      });
    });
    if (!iv.length) return null;
    iv.sort(function (p, q) { return p[0] - q[0]; });
    var lo = iv[0][0], hi = iv[iv.length - 1][1], tot = 0;
    iv.forEach(function (s) { tot += s[1] - s[0]; });
    if (tot >= (hi - lo) * 0.45) return [lo, hi];
    var best = iv[0];
    iv.forEach(function (s) { if (s[1] - s[0] > best[1] - best[0]) best = s; });
    return [best[0], best[1]];
  }

  /**
   * 定位 L/W/D 各自对应的面板。
   * 返回 { tol, x:[{k,v,a,b,ya,yb}], y:[{k,v,a,b,xa,xb}] }
   *   x 数组：量的是水平距离（a/b 为 x 范围，ya/yb 为面板 y 范围）
   *   y 数组：量的是垂直距离（a/b 为 y 范围，xa/xb 为面板 x 范围）
   *   err：匹配误差（mm），可用于判断这条标注靠不靠谱
   */
  V2.locateFaces = function (g, D3) {
    if (!g || !D3 || !g.b) return null;
    var L = D3.L, W = D3.W, D = D3.D;
    if (!L && !W && !D) return null;
    var b = g.b;
    var vals = [L, W, D].filter(function (v) { return v && v > 2; });
    if (!vals.length) return null;

    var tol = Math.max(1.5, Math.min.apply(null, vals) * 0.10, Math.max.apply(null, vals) * 0.008);
    var lines = axisLines((g.k && g.k.length) ? g.k : (g.c || []));
    /* 有些盒型的压痕几乎全是斜线/弧线，抽不出几条正交线段（板界无从谈起）。
       这种时候把切割线并进来 —— 外轮廓也是板界，代价是判定略松，但只在压痕极稀时才启用。 */
    if (lines.V.length + lines.H.length < 6 && g.k && g.c && g.c.length) {
      lines = axisLines(g.k.concat(g.c));
    }
    var GTOL = Math.max(1.0, tol * 0.2);
    var GX = boardGroups(lines.V, GTOL);      // 竖板界（k = x）
    var GY = boardGroups(lines.H, GTOL);      // 横板界（k = y）
    var LIST = [['L', L], ['W', W], ['D', D]];

    /* 一个方向上的「带」：图幅边界 + 各板界坐标，相邻两两成带。
       关键点：展开图里同一个 x 可能只在上半区是折线、在下半区根本不是，
       所以不能把所有板界混在一起取相邻间距 —— 必须先在带内筛一遍。 */
    function bands(G, lo, hi) {
      var ks = [lo];
      G.forEach(function (o) { if (o.k > lo + 0.8 && o.k < hi - 0.8) ks.push(o.k); });
      ks.push(hi);
      var out = [];
      for (var i = 0; i + 1 < ks.length; i++) out.push([ks[i], ks[i + 1]]);
      return out;
    }

    /** 只有在本带里真的有一段线的板界，才算这个带里的板界 */
    function active(G, y0, y1) {
      var need = Math.max(1.2, (y1 - y0) * 0.12);
      return G.filter(function (o) { return ovLen(o.iv, y0, y1) >= need; });
    }

    /** 面板另一个方向的范围：先取两条板界的公共覆盖段，
        再向紧邻的板界贴一下 —— 两条线本身常被切口切断，外沿会略窄 */
    function growPerp(pr, a, c, crossG) {
      var win = tol * 3;
      var nd = Math.max(1.2, Math.abs(c - a) * 0.12);
      var lo = pr[0], hi = pr[1], below = null, above = null;
      crossG.forEach(function (o) {
        if (ovLen(o.iv, a, c) < nd) return;
        if (o.k < lo - 0.2 && (below === null || o.k > below)) below = o.k;
        if (o.k > hi + 0.2 && (above === null || o.k < above)) above = o.k;
      });
      if (below !== null && lo - below <= win) lo = below;
      if (above !== null && above - hi <= win) hi = above;
      return [lo, hi];
    }

    /** 面板另一个方向是不是也正好等于某个已知尺寸
        —— 真正的面必然由 长×宽 / 长×高 / 宽×高 构成 */
    function crossFit(other, key) {
      for (var i = 0; i < LIST.length; i++) {
        var p = LIST[i];
        if (p[0] === key || !p[1] || p[1] < 3) continue;
        if (Math.abs(other - p[1]) <= Math.max(tol, p[1] * 0.05)) return true;
      }
      return false;
    }

    var cand = { L: [], W: [], D: [] };

    /* axis 'x' → 在某个 y 带里量水平距离；axis 'y' → 在某个 x 带里量垂直距离 */
    function scan(axis) {
      var alongG = axis === 'x' ? GX : GY;
      var crossG = axis === 'x' ? GY : GX;
      var lo = axis === 'x' ? b[1] : b[0];
      var hi = axis === 'x' ? b[3] : b[2];

      bands(crossG, lo, hi).forEach(function (bd) {
        var act = active(alongG, bd[0], bd[1]);
        for (var i = 0; i + 1 < act.length; i++) {
          var A = act[i], B = act[i + 1];
          var d = r2(B.k - A.k);
          if (!(d > 2)) continue;
          /* 面板另一个方向的初值：两条板界的公共覆盖段 ∩ 本带
             （公共覆盖段常跨到相邻面/翼片上，用带夹一下才不会标到别的面板上） */
          var pv = perpOf(A.iv, B.iv);
          if (pv) {
            var l2 = Math.max(pv[0], bd[0]), h2 = Math.min(pv[1], bd[1]);
            if (h2 - l2 > 1) pv = [l2, h2];
          } else pv = bd;
          var pr = growPerp(pv, A.k, B.k, crossG);
          var pw = r2(pr[1] - pr[0]);
          LIST.forEach(function (p) {
            if (!p[1] || p[1] < 3) return;
            var e = Math.abs(d - p[1]);
            if (e > tol) return;
            cand[p[0]].push({
              k: p[0], v: p[1], e: e, axis: axis,
              a: r2(A.k), c: r2(B.k), p0: r2(pr[0]), p1: r2(pr[1]),
              fit: crossFit(pw, p[0])
            });
          });
        }
      });
    }
    scan('x');
    scan('y');

    /** 匹配误差优先；误差相同时取「另一方向也是已知尺寸」的那块（更像真实的面） */
    function bestOf(list) {
      if (!list.length) return null;
      return list.slice().sort(function (p, q) {
        return (p.e + (p.fit ? 0 : tol)) - (q.e + (q.fit ? 0 : tol));
      })[0];
    }

    function makeItem(k, c) {
      return c.axis === 'x'
        ? { k: k, v: c.v, a: c.a, b: c.c, ya: c.p0, yb: c.p1, err: c.e }
        : { k: k, v: c.v, a: c.a, b: c.c, xa: c.p0, xb: c.p1, err: c.e };
    }

    var out = { tol: tol, x: [], y: [] };
    var used = {};
    ['L', 'W', 'D'].forEach(function (k) {
      var c = bestOf(cand[k]);
      if (!c) return;
      var key = c.axis + '|' + c.a + '|' + c.c;
      var prev = used[key];
      if (prev) {
        /* 两个尺寸落到同一段间距上（典型是正方盒 L=W）：
           值相同 → 合并成「长·宽」；值不同 → 只留匹配更准的那条，绝不标错 */
        if (Math.abs(prev.v - c.v) <= 0.15) {
          prev.ks = prev.ks || [prev.k];
          if (prev.ks.indexOf(k) < 0) prev.ks.push(k);
        } else if (c.e + 1e-9 < prev.err) {
          var arr = c.axis === 'x' ? out.x : out.y;
          var idx = arr.indexOf(prev);
          var it = makeItem(k, c);
          if (idx >= 0) arr[idx] = it;
          used[key] = it;
        }
        return;
      }
      var item = makeItem(k, c);
      used[key] = item;
      (c.axis === 'x' ? out.x : out.y).push(item);
    });

    return out;
  };

  /** 实心三角箭头（fill 用属性写，屏幕/导出都生效，且不会破坏 style 属性） */
  function tri(x, y, dx, dy, al, color, cls) {
    var w = al * 0.34, p;
    if (dx) p = [[x, y], [x - dx * al, y - w], [x - dx * al, y + w]];
    else p = [[x, y], [x - w, y - dy * al], [x + w, y - dy * al]];
    var d = 'M' + p.map(function (q) { return round1(q[0]) + ' ' + round1(q[1]); }).join(' L') + 'Z';
    return '<path class="' + cls + '" fill="' + color + '" stroke="none" d="' + d + '"/>';
  }

  /** 面板底色 + 尺寸线 + 标注牌 */
  function markLayer(b, fs, opts) {
    var faces = opts.faces || V2.locateFaces(opts.g || { b: b, k: [], c: [] }, opts.dims);
    MARK_BOX = null;                 // 对外暴露标注牌的外沿，供 V2.svg 撑开画布
    if (!faces || (!faces.x.length && !faces.y.length)) return '';
    var unit = opts.unit === 'in' ? 'in' : 'mm';
    /* 标注值口径：定位用的是制造尺寸，标注文字按当前口径做一次偏移 */
    var off = +opts.markOffset || 0;
    var al = fs * 0.8;
    var tfs = fs * 0.95;
    var out = '';
    var chips = [];                  // 已摆下的标注牌，新牌子要避开它们
    var filled = {};                 // 同一块面板只铺一层底色（长宽可能共用一块面板）

    /** 标注牌文字，如「长 120 mm」「长·宽 100 mm」 */
    function labelOf(m) {
      var names = m.ks && m.ks.length > 1
        ? m.ks.map(function (k) { return V2.MARK_NAME[k] || k; }).join('·')
        : (V2.MARK_NAME[m.k] || m.k);
      return names + ' ' + V2.unitVal(m.v + off, unit) + (unit === 'in' ? ' in' : ' mm');
    }

    /* 牌子必须压在自己的尺寸线上（否则箭头又和文字离远了）。
       所以只允许沿尺寸线滑动来避让；滑不动就接受重叠，绝不为了摆开而脱离线。 */
    function placeChip(m, vertical, cw, ch) {
      /* 沿尺寸线的中点 = (a+b)/2；尺寸线本身的位置 = 面板横向/纵向中点。
         横向尺寸的 a/b 是 x，纵向尺寸的 a/b 是 y —— 两者不能弄反。 */
      var along = (m.a + m.b) / 2;
      var cross = vertical ? (m.xa + m.xb) / 2 : (m.ya + m.yb) / 2;
      var TS = [0.5, 0.32, 0.68, 0.2, 0.8, 0.12, 0.88];
      var px = vertical ? cross : along;
      var py = vertical ? along : cross;
      var i, j;
      for (i = 0; i < TS.length; i++) {
        if (vertical) {
          py = m.a + (m.b - m.a) * TS[i];
          py = Math.max(b[1] + ch / 2, Math.min(b[3] - ch / 2, py));
        } else {
          px = m.a + (m.b - m.a) * TS[i];
          px = Math.max(b[0] + cw / 2, Math.min(b[2] - cw / 2, px));
        }
        var hit = false;
        for (j = 0; j < chips.length; j++) {
          var q = chips[j];
          if (px - cw / 2 < q.x1 && px + cw / 2 > q.x0 &&
              py - ch / 2 < q.y1 && py + ch / 2 > q.y0) { hit = true; break; }
        }
        if (!hit) break;
      }
      chips.push({ x0: px - cw / 2, y0: py - ch / 2, x1: px + cw / 2, y1: py + ch / 2 });
      if (!MARK_BOX) MARK_BOX = { x0: px - cw / 2, y0: py - ch / 2, x1: px + cw / 2, y1: py + ch / 2 };
      else {
        MARK_BOX.x0 = Math.min(MARK_BOX.x0, px - cw / 2);
        MARK_BOX.y0 = Math.min(MARK_BOX.y0, py - ch / 2);
        MARK_BOX.x1 = Math.max(MARK_BOX.x1, px + cw / 2);
        MARK_BOX.y1 = Math.max(MARK_BOX.y1, py + ch / 2);
      }
      return { mx: px, my: py };
    }

    function draw(m, vertical) {
      var color = V2.MARK_COLOR[m.k] || V2.COLOR.make;
      var x = vertical ? m.xa : m.a;
      var w = vertical ? (m.xb - m.xa) : (m.b - m.a);
      var y = vertical ? m.a : m.ya;
      var h = vertical ? (m.b - m.a) : (m.yb - m.ya);
      if (!(w > 0) || !(h > 0)) return '';

      var text = labelOf(m);
      var o = '';

      // 面板底色（淡）—— 长与宽共用一块面时只铺一层，避免叠色发深
      var fk = round1(x) + '|' + round1(y) + '|' + round1(w) + '|' + round1(h);
      if (!filled[fk]) {
        filled[fk] = 1;
        o += '<rect class="markfill" fill="' + color + '" fill-opacity="0.08" x="' + round1(x) +
          '" y="' + round1(y) + '" width="' + round1(w) + '" height="' + round1(h) + '" rx="' +
          round1(Math.min(w, h) * 0.05) + '"/>';
      }

      /* 尺寸线 + 双箭头（箭尖贴面板边，箭头朝内）。
         关键：尺寸线必须落在标注牌的中心上，否则箭头会和文字离得很远。
         · 纵向尺寸 → 线画在面板的「横向中点」(xa..xb)，不能把 y 的中点当成 x 用
         · 横向尺寸 → 线画在面板的「纵向中点」(ya..yb) */
      var lw = opts.standalone ? (opts.sw || V2.SW_MM).dim : '';
      var linePos;
      if (vertical) {
        linePos = (m.xa + m.xb) / 2;
        o += '<line class="markline" x1="' + round1(linePos) + '" y1="' + round1(m.a) +
          '" x2="' + round1(linePos) + '" y2="' + round1(m.b) + '" stroke="' + color + '"' +
          (lw ? ' stroke-width="' + lw + '"' : '') + '/>';
        o += tri(linePos, m.a, 0, -1, al, color, 'markarrow');
        o += tri(linePos, m.b, 0, 1, al, color, 'markarrow');
      } else {
        linePos = (m.ya + m.yb) / 2;
        o += '<line class="markline" x1="' + round1(m.a) + '" y1="' + round1(linePos) +
          '" x2="' + round1(m.b) + '" y2="' + round1(linePos) + '" stroke="' + color + '"' +
          (lw ? ' stroke-width="' + lw + '"' : '') + '/>';
        o += tri(m.a, linePos, -1, 0, al, color, 'markarrow');
        o += tri(m.b, linePos, 1, 0, al, color, 'markarrow');
      }

      // 标注牌（白底 + 彩色描边），压在尺寸线上
      var cw = textW(text, tfs) + tfs * 1.4;
      var chh = tfs * 1.86;
      var cp = placeChip(m, vertical, cw, chh);

      o += '<rect class="markchip" x="' + round1(cp.mx - cw / 2) + '" y="' + round1(cp.my - chh / 2) +
        '" width="' + round1(cw) + '" height="' + round1(chh) + '" rx="' + round1(chh * 0.32) +
        '" fill="#ffffff" stroke="' + color + '"' +
        (opts.standalone ? ' stroke-width="' + (opts.sw || V2.SW_MM).dim + '"' : '') + '/>';
      o += '<text class="marktxt" x="' + round1(cp.mx) + '" y="' + round1(cp.my + tfs * 0.36) +
        '" font-size="' + round1(tfs) + '" font-weight="700" text-anchor="middle" fill="' +
        color + '"' + (opts.standalone ? ' font-family="' + FONT.replace(/"/g, "'") + '"' : '') +
        '>' + esc(text) + '</text>';
      return o;
    }

    /* 按 长→宽→高 的顺序摆牌子：先来的占中线，后来的自动滑开 */
    var all = [];
    faces.x.forEach(function (m) { all.push({ m: m, v: false }); });
    faces.y.forEach(function (m) { all.push({ m: m, v: true }); });
    all.sort(function (p, q) { return (MARK_ORDER[p.m.k] || 0) - (MARK_ORDER[q.m.k] || 0); });
    all.forEach(function (t) { out += draw(t.m, t.v); });
    return out;
  }

  /** 展开尺寸（包围盒，mm） */
  V2.bboxSize = function (g) {
    return {
      w: Math.round((g.b[2] - g.b[0]) * 10) / 10,
      h: Math.round((g.b[3] - g.b[1]) * 10) / 10
    };
  };

  /* ---------------- 尺寸模型 ---------------- */

  /* 尺寸模型（用户确认）：
       制造尺寸 = 主尺寸（刀模线）
       内尺寸  = 制造 - 2*inner
       外尺寸  = 制造 + 2*outer
     补偿是「单边」量，而一个尺寸要跨两块纸板，所以 ×2；
     于是 外 - 内 = 2x(inner+outer) = 2x纸板厚度，与实物一致。 */
  V2.sizesOf = function (ce) {
    var i = +ce.inner || 0;
    var o = +ce.outer || 0;
    var t = ce.cal != null && ce.cal !== '' ? +ce.cal : Math.round((i + o) * 100) / 100;
    var one = function (v) {
      if (v == null || v === '') return null;
      v = +v;
      return { m: r2(v), i: r2(v - 2 * i), o: r2(v + 2 * o) };
    };
    return { inner: i, outer: o, t: r2(t), L: one(ce.l), W: one(ce.w), D: one(ce.d) };
  };

  function r2(v) { return Math.round(v * 100) / 100; }
  V2.r2 = r2;

  /* ---------------- 盒型显示名 ---------------- */

  /* ❗ 源站把 SEO 关键词当盒型名抓下来了（全库 1278 个里 484 个），
     比如 0215 的 name 就叫「包装纸箱设计」。这类名字对选盒型毫无帮助，
     所以先在 tags / 名字分段里找第一个「像盒型名」的候选（含结构词、不含营销词）。
     实在找不到就返回 null，由调用方退化成编号显示。 */

  var SEO_WORD = /设计|印刷|定制|定做|厂家|生产|制作|批发|报价|方案|加工|包装盒型|包装材料|包装项目|一站式|直销|采购|供应/;
  /* 结构词：真正描述盒型的名字里一定会出现这些字 */
  var TYPE_WORD = /盒|箱|袋|卡|托|盘|架|筒|管|罐|匣|册|签|牌|衬|格|套|板|片|封|兜|篮|槽|提手|展示|挂钩|手提/;

  V2.isSeoName = function (s) { return SEO_WORD.test(String(s == null ? '' : s).trim()); };

  /* 「不能当名字用」的三类：
     ① 含营销 SEO 词（设计/印刷/定制…）
     ② 逗号 / 顿号堆砌的关键词串（「信封包装，贺卡包装，简易包裹」）
     ③ 占位名（「未分类盒型」） */
  V2.isJunkName = function (s) {
    s = String(s == null ? '' : s).trim();
    if (!s) return true;
    if (SEO_WORD.test(s)) return true;
    if (/[，,、]/.test(s)) return true;
    if (/^未(分类|命名|知)/.test(s)) return true;
    return false;
  };

  /** 取盒型的真类型名；拿不到返回 null */
  V2.typeName = function (b) {
    b = b || {};
    var name = String(b.name == null ? '' : b.name).trim();
    if (name && !V2.isJunkName(name)) return name;
    var cand = (b.tags || []).concat(name.split(/[,，、\/|；;]/));
    for (var i = 0; i < cand.length; i++) {
      var t = String(cand[i] == null ? '' : cand[i]).trim();
      if (t.length < 2 || t.length > 14) continue;
      if (V2.isJunkName(t)) continue;               /* 逗号串 / SEO 词 / 占位名全部跳过 */
      if (!TYPE_WORD.test(t)) continue;
      return t;
    }
    return null;
  };

  /** 卡片 / 标题用：拿不到真类型名就回编号 */
  V2.displayName = function (b) { return V2.typeName(b) || String((b || {}).id || ''); };

  /** 名字是否为占位名（卡片据此隐藏第二行重复的编号） */
  V2.nameIsPlaceholder = function (b) { return V2.typeName(b) == null; };

  /* ---------------- 等轴测立体盒（列表页 hover 预览用） ---------------- */

  /* 斜二测投影：正面 = 宽×高，深度（长）向右上短缩，于是看得到
     正面 / 右侧面 / 顶面 三个面。不依赖外部图片与 3D 库，比例真实、任意尺寸都清晰。 */
  var ISO_KX = 0.55, ISO_KY = 0.34;
  V2.ISO_COLOR = { top: '#bccf76', front: '#9db257', side: '#7b8f3d' };

  V2.isoBox = function (L, W, D, opts) {
    opts = opts || {};
    var l = Math.max(1, +L || 0), w = Math.max(1, +W || 0), d = Math.max(1, +D || 0);
    var kx = opts.kx == null ? ISO_KX : opts.kx;
    var ky = opts.ky == null ? ISO_KY : opts.ky;

    /* (x=宽, y=高, z=深) -> 屏幕坐标（y 轴向上为正） */
    function P(x, y, z) { return [x + z * kx, y + z * ky]; }

    var A = P(0, 0, 0), B = P(w, 0, 0), C = P(w, d, 0), D0 = P(0, d, 0);
    var At = P(0, d, l), Bt = P(w, d, l), Ct = P(w, 0, l);

    var front = [A, B, C, D0];
    var top = [D0, C, Bt, At];
    var side = [B, Ct, Bt, C];

    var pts = front.concat(top, side);
    var xs = pts.map(function (p) { return p[0]; });
    var ys = pts.map(function (p) { return p[1]; });
    var x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs);
    var y0 = Math.min.apply(null, ys), y1 = Math.max.apply(null, ys);
    var pad = Math.max(x1 - x0, y1 - y0) * 0.04 + 1;

    function poly(ps, fill) {
      var c = ps.map(function (p) { return round1(p[0]) + ',' + round1(y1 - p[1]); }).join(' ');
      return '<polygon points="' + c + '" fill="' + fill + '"/>';
    }

    return '<svg viewBox="' + round1(x0 - pad) + ' ' + (-pad) + ' ' +
      round1(x1 - x0 + pad * 2) + ' ' + round1(y1 - y0 + pad * 2) +
      '" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg" role="img">' +
      poly(top, V2.ISO_COLOR.top) + poly(side, V2.ISO_COLOR.side) + poly(front, V2.ISO_COLOR.front) +
      '</svg>';
  };

  /* ---------------- 格式化 ---------------- */

  V2.MM2IN = 1 / 25.4;

  V2.num = function (v) {
    if (v == null || v === '' || !isFinite(v)) return '—';
    var n = Math.round(v * 100) / 100;
    return String(n);
  };

  V2.unitVal = function (mm, unit) {
    if (mm == null || !isFinite(mm)) return '';
    return unit === 'in' ? String(Math.round(mm * V2.MM2IN * 1000) / 1000) : String(Math.round(mm * 100) / 100);
  };

  /* ---------------- 顶栏搜索 ---------------- */

  V2.bindTopSearch = function (catalog, onPick) {
    var input = document.getElementById('q');
    var box = document.getElementById('qbox');
    if (!input) return;

    function hide() { if (box) box.style.display = 'none'; }

    function render(kw) {
      if (!box) return;
      kw = kw.trim().toLowerCase();
      if (!kw) return hide();
      var hits = catalog.boxes.filter(function (b) {
        return b.id.toLowerCase().indexOf(kw) >= 0 ||
          b.name.toLowerCase().indexOf(kw) >= 0 ||
          b.tags.join(',').toLowerCase().indexOf(kw) >= 0;
      }).slice(0, 8);
      if (!hits.length) return hide();
      box.innerHTML = hits.map(function (b) {
        return '<a class="sug" href="box.html?id=' + encodeURIComponent(b.id) + '">' +
          '<b>' + esc(V2.displayName(b)) + '</b>' +
          '<span>' + esc(b.id) + ' · ' + dimText(b) + '</span></a>';
      }).join('');
      box.style.display = 'block';
    }

    input.addEventListener('input', function () { render(input.value); });
    input.addEventListener('focus', function () { if (input.value) render(input.value); });
    document.addEventListener('click', function (e) {
      if (e.target !== input && box && !box.contains(e.target)) hide();
    });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        var first = box && box.querySelector('a');
        if (first) location.href = first.getAttribute('href');
      }
      if (e.key === 'Escape') hide();
    });
  };

  V2.esc = esc;
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  V2.dimText = dimText;
  function dimText(b) {
    if (!b.L || !b.W || !b.D) return '尺寸未标注';
    return V2.num(b.L.m) + ' × ' + V2.num(b.W.m) + ' × ' + V2.num(b.D.m) + ' mm';
  }

  /* ---------------- 分类名规范化 ----------------
     数据源里第 0 类原名就叫「免费」（来源站的免费专区，原始数据里其实是「常用」），
     单看「免费」两个字根本不知道是什么盒，统一叫「常用盒型」。
     列表页侧栏、面包屑、详情页共用这一份，避免同一个分类出现两个名字。 */

  V2.CAT_FIX = { 0: '常用盒型' };

  V2.catName = function (cats, idx) {
    if (V2.CAT_FIX[idx]) return V2.CAT_FIX[idx];
    for (var i = 0; i < (cats || []).length; i++) {
      if (cats[i].idx === idx) return cats[i].name;
    }
    return '其他';
  };

  /* ---------------- 查询参数 ---------------- */

  V2.qs = function (name) {
    var m = new RegExp('[?&]' + name + '=([^&#]*)').exec(location.search);
    return m ? decodeURIComponent(m[1]) : null;
  };

  /* ---------------- 下载小工具 ---------------- */

  V2.download = function (blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 1200);
  };

  V2.safeName = function (s) {
    return String(s == null ? '' : s).replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60);
  };
})();
