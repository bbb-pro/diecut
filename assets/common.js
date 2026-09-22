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

  /* 尺寸标注配色 —— 与上游一致：主尺寸（长/宽/高这类主参数）橙、其他参数绿。
     上游 SignDataToART 用「值是不是数组」决定用哪个色槽（isArray ? 0 : 1），
     两个槽位的默认值就是这两个（可在上游「颜色设置」里改）。 */
  V2.RM_COLOR = { main: '#de7a00', oth: '#1f801f' };
  var RM_BOX = null;                       // rmLayer 把标注外沿写在这里，V2.svg 据此撑画布

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
    var useRm = !!(opts.rm && opts.rm.on !== false) && !!(g.rm && g.rm.length);

    var SW = opts.sw || V2.SW_MM;
    var DASH = opts.dash || V2.SW_MM.dash;

    var fs = (useDim || useRm) ? (opts.fs || V2.dimFontSize(g)) : 0;
    fs = Math.max(0.3, Math.min(200, fs));
    var band = fs * 1.5;                 // 尺寸线距图形边缘的距离

    var padL = basePad, padT = basePad, padR = basePad, padB = basePad;
    if (useDim) {
      padT = band + fs * 1.7;
      padL = band + fs * 1.4;
      padR = Math.max(basePad * 0.4, fs * 0.8);
      padB = Math.max(basePad * 0.4, fs * 0.8);
    }

    /* 标注跑到图形外面时（引出线、尺寸线、文字都可能在图幅外），
       把画布扩出去，别把标注裁掉 */
    var rmStr = '';
    if (useRm) {
      rmStr = rmLayer(g, fs, opts);
      if (RM_BOX) {
        padL = Math.max(padL, b[0] - RM_BOX.x0 + fs * 0.6);
        padT = Math.max(padT, b[1] - RM_BOX.y0 + fs * 0.6);
        padR = Math.max(padR, RM_BOX.x1 - b[2] + fs * 0.6);
        padB = Math.max(padB, RM_BOX.y1 - b[3] + fs * 0.6);
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
    if (useRm) s += rmStr;
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

  /* ---------------- 尺寸标注：直接渲染上游 Remarks ----------------
     不再靠几何反推「长宽高在哪块面板」，而是照搬上游给的标注数据。
     每条 Remark = [参数名, 图面x, 图面y, 类型, 值]：

       类型  x / xb    水平尺寸，线沿 x 方向；x 的文字在上方，xb 在下方
             y / yl    垂直尺寸，线沿 y 方向；y 的文字在右侧，yl 在左侧
             r1 ~ r4   圆角半径，45° 对角引出 + 箭头（r1 右上 / r2 左上 / r3 左下 / r4 右下）
             a* / ac*  角度，起始边与终止边各一支箭头
       值    数组 = 主尺寸 [内尺寸, 外尺寸, 刀模尺寸]，按当前尺寸口径取其一；
             单值 = 普通参数，直接就是数值

     配色：值是数组的算「主尺寸」，用主参色；其余用其他参数色 ——
     上游 SignDataToART 正是按 Array.isArray(v) 分槽的（t[6] = 0 / 1）。

     ❗上游渲染用的是**屏幕像素**单位（线偏移 5px、引出 20px、箭头半宽 3px…），
       这里要换到图面单位。上游字号 k 像素时那几个量约合 0.42k、1.7k，
       所以取「1px ≈ 字号/12」作换算因子：fs 越大（图越大）标注越长，比例恒定。 */

  var RM_PX = 1 / 12;        // 上游 1px ≈ 字号 × RM_PX（图面单位）
  var RM_ARROW = 0.6;        // 箭头长度（× 字号）

  /** 标注里「线」的长度：主尺寸取刀模尺寸（数组末位），其他参数就是它自己的值 */
  function rmLenOf(r) {
    var v = r[4];
    return +((Array.isArray(v) ? v[v.length - 1] : v)) || 0;
  }

  /** 实心三角箭头：箭尖在 (x,y)，朝 (dx,dy)；fill 用属性写（屏幕与导出都生效，
      且不会被样式表里的 fill 覆盖 —— CSS 是覆盖 presentation attribute 的，
      所以样式表里只准设 fill-opacity，不许设 fill） */
  function tri(x, y, dx, dy, al, color, cls) {
    var w = al * 0.34, p;
    if (dx) p = [[x, y], [x - dx * al, y - w], [x - dx * al, y + w]];
    else p = [[x, y], [x - w, y - dy * al], [x + w, y - dy * al]];
    var d = 'M' + p.map(function (q) { return round1(q[0]) + ' ' + round1(q[1]); }).join(' L') + 'Z';
    return '<path class="' + cls + '" fill="' + color + '" stroke="none" d="' + d + '"/>';
  }

  function rmLayer(g, fs, opts) {
    RM_BOX = null;
    var R = opts.rm || {};
    var list = (g && g.rm) || [];
    if (!list.length) return '';

    var unit = opts.unit === 'in' ? 'in' : 'mm';
    var choose = Math.max(1, Math.min(3, +(R.choose || 3)));
    var txtMode = R.txtMode == null ? 2 : +R.txtMode;
    var onMain = R.main !== false;
    var onOth = R.oth === true;
    var U = fs * RM_PX;
    var al = fs * RM_ARROW;
    var tfs = fs * 0.95;
    var out = '';

    /** 记下标注占用的范围，V2.svg 据此把画布撑开 */
    function box(x0, y0, x1, y1) {
      if (!RM_BOX) RM_BOX = { x0: x0, y0: y0, x1: x1, y1: y1 };
      else {
        RM_BOX.x0 = Math.min(RM_BOX.x0, x0); RM_BOX.y0 = Math.min(RM_BOX.y0, y0);
        RM_BOX.x1 = Math.max(RM_BOX.x1, x1); RM_BOX.y1 = Math.max(RM_BOX.y1, y1);
      }
    }

    function lineAttr(color) {
      return opts.standalone
        ? ' style="fill:none;stroke:' + color + ';stroke-width:' + (opts.sw || V2.SW_MM).dim +
          ';stroke-linejoin:round;stroke-linecap:round"'
        : ' class="rmline" stroke="' + color + '"';
    }

    /** 标注文字（屏幕模式加白描边，压在线上也看得清） */
    function label(cx, cy, str, color) {
      if (!str) return '';
      var w = textW(str, tfs);
      box(cx - w / 2, cy - tfs * 0.75, cx + w / 2, cy + tfs * 0.45);
      var css = 'font-family:' + FONT + ';font-size:' + round1(tfs) + 'px;font-weight:600;fill:' + color;
      return '<text' + clsAttr(opts, 'rmtxt', css) +
        ' x="' + round1(cx) + '" y="' + round1(cy + tfs * 0.35) + '" font-size="' + round1(tfs) +
        '" font-weight="600" text-anchor="middle" fill="' + color + '">' + esc(str) + '</text>';
    }

    /** 当前口径下这条标注要显示的值 */
    function valOf(r) {
      var v = r[4];
      if (!Array.isArray(v)) return v;
      var x = v[choose - 1];
      return x == null ? v[v.length - 1] : x;
    }

    /** 文字内容：0 代码=数值 / 1 只要代码 / 2 只要数值 / 3 不标注（上游 txtMode） */
    function textOf(r) {
      var isMain = Array.isArray(r[4]);
      var code = isMain ? String(r[0]).toUpperCase() : String(r[0]);
      var v = V2.unitVal(valOf(r), unit);
      if (txtMode === 1) return code;
      if (txtMode === 2) return v;
      if (txtMode === 3) return '';
      return code + '=' + v;
    }

    /** 水平尺寸（x / xb）—— 线从 (x,y) 到 (x+len,y)，文字在线中点、上/下偏 */
    function drawX(r, len, str, color, isMain) {
      var x = +r[1] || 0, y = +r[2] || 0;
      var ti = isMain ? choose : 3;
      var sl = (ti === 1 ? 5 : ti === 2 ? -5 : 0) * U;
      var x0 = x + sl, x1 = x + len - sl;
      if (x1 < x0) { var t = x0; x0 = x1; x1 = t; }
      var o = '';
      /* 长度够（≥10px 等效）就画整条尺寸线 + 两端朝外的箭头；
         太短画不下线，就把箭头改朝内，免得两个箭头糊在一起 */
      if (x1 - x0 >= 10 * U) {
        o += '<line x1="' + round1(x0) + '" y1="' + round1(y) + '" x2="' + round1(x1) +
          '" y2="' + round1(y) + '"' + lineAttr(color) + '/>';
        o += tri(x0, y, -1, 0, al, color, 'rmarrow');
        o += tri(x1, y, 1, 0, al, color, 'rmarrow');
      } else {
        o += tri(x0, y, 1, 0, al, color, 'rmarrow');
        o += tri(x1, y, -1, 0, al, color, 'rmarrow');
      }
      box(x0 - al, y - al, x1 + al, y + al);
      var down = String(r[3]) === 'xb';
      return o + label((x0 + x1) / 2, y + (down ? 1 : -1) * (fs * 0.5 + 4 * U), str, color);
    }

    /** 垂直尺寸（y / yl）—— 线从 (x,y) 到 (x,y+len)，文字在线的右/左侧 */
    function drawY(r, len, str, color, isMain) {
      var x = +r[1] || 0, y = +r[2] || 0;
      var ti = isMain ? choose : 3;
      var sl = (ti === 1 ? 5 : ti === 2 ? -5 : 0) * U;
      var y0 = y + sl, y1 = y + len - sl;
      if (y1 < y0) { var t = y0; y0 = y1; y1 = t; }
      var o = '';
      if (y1 - y0 >= 10 * U) {
        o += '<line x1="' + round1(x) + '" y1="' + round1(y0) + '" x2="' + round1(x) +
          '" y2="' + round1(y1) + '"' + lineAttr(color) + '/>';
        o += tri(x, y0, 0, -1, al, color, 'rmarrow');
        o += tri(x, y1, 0, 1, al, color, 'rmarrow');
      } else {
        o += tri(x, y0, 0, 1, al, color, 'rmarrow');
        o += tri(x, y1, 0, -1, al, color, 'rmarrow');
      }
      box(x - al, y0 - al, x + al, y1 + al);
      var th = (textW(str, tfs) + 24 * U) / 2;
      var left = String(r[3]) === 'yl';
      return o + label(x + (left ? -th : th), y + len / 2, str, color);
    }

    /** 圆角半径（r1~r4）—— 沿 45° 对角方向引出，末端折一段水平线放文字 */
    function drawR(r, len, str, color) {
      var x = +r[1] || 0, y = +r[2] || 0;
      var t = String(r[3]);
      var sx = /r1|r4/.test(t) ? 1 : -1;          // 对角方向的水平分量
      var sy = /r1|r2/.test(t) ? -1 : 1;          // 对角方向的垂直分量（y 向下）
      var et = len * 1.41421356 / 2;              // 半径投到 45° 方向
      var ot = et + 20 * U;                       // 引出终点（官方再外推 20px）
      var ht = textW(str, tfs) + 20 * U;          // 文字横向引出距离
      var wt = (/r2|r3/.test(t) ? -1 : 1) * 10 * U;   // 45° 线上的短划（官方 r2/r3 取反向）
      var qx = x + sx * et, qy = y + sy * et;     // 对角点：贴在圆角上
      var ax = qx - sx * wt, ay = qy - sy * wt;   // 45° 短划两端
      var bx = qx + sx * wt, by = qy + sy * wt;
      var cx = bx + sx * ht;                      // 折向水平，末端放文字
      var pts = [ax, ay, bx, by, cx, by].map(round1).join(',');
      var o = opts.standalone
        ? '<polyline points="' + pts + '" style="fill:none;stroke:' + color + ';stroke-width:' +
          (opts.sw || V2.SW_MM).dim + ';stroke-linejoin:round"/>'
        : '<polyline class="rmline" points="' + pts + '" fill="none" stroke="' + color + '"/>';
      o += tri(qx, qy, sx, sy, al, color, 'rmarrow');
      o += label(bx + sx * ht / 2, by - fs * 0.5, str, color);
      box(Math.min(x, cx) - al, Math.min(qy, by) - al,
        Math.max(x, cx) + al, Math.max(qy, by) + al);
      return o;
    }

    /** 角度（a0/a90/a180/a270、ac*）—— 两条角边方向各一支切向箭头 */
    function drawA(r, len, str, color) {
      var x = +r[1] || 0, y = +r[2] || 0;
      var t = String(r[3]);
      var acw = t.charAt(1) === 'c';
      var base = parseFloat(t.substr(acw ? 2 : 1));
      if (!isFinite(base) || !isFinite(len)) return '';
      var a0 = acw ? base - len : base;           // 起始角
      var a1 = acw ? base : base + len;           // 终止角
      var c = a0 * Math.PI / 180, w = a1 * Math.PI / 180;
      var Rr = 20 * U;                            // 距锚点 20px 处
      var p0 = [x + Rr * Math.cos(c), y - Rr * Math.sin(c)];
      var p1 = [x + Rr * Math.cos(w), y - Rr * Math.sin(w)];
      var o = '';
      o += '<line x1="' + round1(x) + '" y1="' + round1(y) + '" x2="' + round1(p0[0]) +
        '" y2="' + round1(p0[1]) + '"' + lineAttr(color) + '/>';
      o += '<line x1="' + round1(x) + '" y1="' + round1(y) + '" x2="' + round1(p1[0]) +
        '" y2="' + round1(p1[1]) + '"' + lineAttr(color) + '/>';
      /* 箭头朝切向（角边 + 90° / -90°），像弧的两端各一个小箭头 */
      o += tri(p0[0], p0[1], Math.cos(c + Math.PI / 2), -Math.sin(c + Math.PI / 2), al, color, 'rmarrow');
      o += tri(p1[0], p1[1], Math.cos(w - Math.PI / 2), -Math.sin(w - Math.PI / 2), al, color, 'rmarrow');
      o += label(x + Rr * Math.cos(c) + textW(str, tfs) * Math.cos(c),
        y - Rr * Math.sin(c) - fs * Math.sin(c), str, color);
      box(x - Rr - al, y - Rr - al, x + Rr + al, y + Rr + al);
      return o;
    }

    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      if (!r || r.length < 5) continue;
      var isMain = Array.isArray(r[4]);
      if (isMain ? !onMain : !onOth) continue;
      var type = String(r[3] || '');
      if (!type) continue;
      var str = textOf(r);
      var len = rmLenOf(r);
      var color = isMain ? V2.RM_COLOR.main : V2.RM_COLOR.oth;
      var k = type.charAt(0);
      var o = '';
      if (k === 'x') o = drawX(r, len, str, color, isMain);
      else if (k === 'y') o = drawY(r, len, str, color, isMain);
      else if (k === 'r') o = drawR(r, len, str, color);
      else if (k === 'a') o = drawA(r, len, str, color);
      out += o;
    }
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

  /* ---------------- 主尺寸能不能改 ---------------- */

  V2.DIM_CN = { L: '长', W: '宽', D: '高' };

  /**
   * 长/宽/高 是否允许用户直接改。
   *
   * ❗ 判据是 **`op`（求解参数串）而不是 `pm`（参数表）**：
   *    改尺寸时回传的就是 op 那串（`buildPms()` 照它的 key 拼），op 里没有的 key
   *    上游会直接忽略 —— 于是输入框看着能改、数字本地也变了，几何却纹丝不动。
   *
   * 四种情况：
   *   edit    op 里有这一维，正常可改
   *   follow  op 里没有，但值和另一个可改的主尺寸相等（方盒：宽 = 长）→ 跟着它走
   *   auto    op 里没有，值由盒型结构推算出来（如高由「高1 + 高2」合成）→ 只能看
   *   none    这个盒型压根没有这一维（ce 里连值都没有）→ 显示「不含此项」
   */
  V2.dimControl = function (g) {
    var op = {};
    String((g && g.op) || '').split(',').forEach(function (kv) {
      var i = kv.indexOf('=');
      if (i > 0) op[kv.slice(0, i).trim().toUpperCase()] = 1;
    });
    var ce = (g && g.ce) || {};
    var out = {};
    ['L', 'W', 'D'].forEach(function (K) {
      var raw = ce[K.toLowerCase()];
      if (op[K]) { out[K] = { mode: 'edit' }; return; }
      var b = parseFloat(raw);
      /* 值为空或 0 都算「没有这一维」——宽为 0 的盒型（如 H009）实质是片状结构 */
      if (!(b > 0)) { out[K] = { mode: 'none' }; return; }
      var by = null;
      ['L', 'W', 'D'].forEach(function (J) {
        if (J === K || !op[J] || by) return;
        var a = parseFloat(ce[J.toLowerCase()]);
        if (isFinite(a) && Math.abs(a - b) < 0.05) by = J;
      });
      out[K] = by ? { mode: 'follow', by: by } : { mode: 'auto' };
    });
    return out;
  };

  /** 锁定的输入框下面那句说明（follow/auto/none 三种）；K = 'L'|'W'|'D' */
  V2.dimLockText = function (K, d) {
    if (d.mode === 'follow') return '与' + V2.DIM_CN[d.by] + '相同，改' + V2.DIM_CN[d.by] + '就会跟着变';
    if (d.mode === 'auto') return V2.DIM_CN[K] + '由盒型结构推算，不可单独调整';
    if (d.mode === 'none') return '此盒型不含' + V2.DIM_CN[K];
    return '';
  };

  /* ---------------- 盒型显示名 ---------------- */

  /* ❗ 源站把 SEO 关键词当盒型名抓下来了（约占全库四成），
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
