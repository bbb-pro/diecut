/* ============================================================
   export.js — 刀模导出：SVG / DXF / PNG / PDF
   依赖 common.js：V2.svg / V2.geoOf / V2.bboxSize / V2.download
   ============================================================ */
(function () {
  'use strict';

  var V2 = window.V2;

  /* ---------------- 导出参数 ---------------- */

  /** 导出图纸上的文字高度（用户单位 = mm）——按 GB/T 14691 工程图惯例取值 */
  V2.exportFontSize = function (g) {
    var W = g.b[2] - g.b[0], H = g.b[3] - g.b[1];
    return Math.max(2, Math.min(8, Math.min(W, H) / 70));
  };

  function buildOpts(meta, px) {
    var g = meta.g;
    var fs = meta.fs || V2.exportFontSize(g);
    var o = {
      standalone: true,
      px: px || 0,
      dim: !!meta.dim,
      marks: !!meta.marks,
      dims: meta.dims,
      faces: meta.faces,
      markOffset: meta.markOffset,
      sizes: meta.sizes,
      dimType: meta.dimType,
      unit: meta.unit || 'mm',
      fs: fs,
      nameW: '展开宽',
      nameH: '展开高',
      pad: fs * 0.9,
      sw: V2.SW_MM,
      dash: V2.SW_MM.dash
    };
    return o;
  }

  function parseVB(svg) {
    var m = /viewBox="([^"]+)"/.exec(svg);
    if (!m) return { w: 0, h: 0 };
    var a = m[1].trim().split(/\s+/).map(Number);
    return { w: a[2], h: a[3] };
  }

  /** XML 合法性自检 —— 导出前拦掉「style 属性被引号截断」这类问题 */
  V2.svgWellFormed = function (svg) {
    try {
      var d = new DOMParser().parseFromString(svg, 'image/svg+xml');
      var e = d.querySelector('parsererror');
      return e ? String(e.textContent || 'XML 解析失败').split('\n')[0].slice(0, 160) : '';
    } catch (err) {
      return err.message;
    }
  };

  /** 生成可独立打开 / 打印的 SVG 字符串 */
  function standalone(meta, px, swPx) {
    var g = meta.g;
    var o = buildOpts(meta, px);
    if (px) {
      // 位图导出：按目标像素反推线宽，保证屏幕上粗细一致
      var probe = V2.svg(g, o);
      var vb = parseVB(probe);
      var scale = px / vb.w;
      o.sw = {
        cut: swPx / scale,
        crease: swPx / scale,
        dim: (swPx * 0.8) / scale
      };
      o.dash = [(swPx * 1.9) / scale, (swPx * 1.4) / scale];
    }
    var out = V2.svg(g, o);
    var bad = V2.svgWellFormed(out);
    if (bad) throw new Error('刀模图 XML 非法：' + bad);
    return out;
  }

  V2.standaloneSvg = standalone;

  function fileBase(meta) {
    var g = meta.g, b = meta.box || {};
    var L = b.L && b.L.m, W = b.W && b.W.m, D = b.D && b.D.m;
    var dim = (L || W || D) ? (V2.num(L) + 'x' + V2.num(W) + 'x' + V2.num(D) + 'mm') : '';
    return [meta.id, meta.name, dim].filter(Boolean).map(V2.safeName).join('_');
  }

  V2.exportName = fileBase;

  /* ---------------- SVG ---------------- */

  V2.exportSVG = function (meta) {
    var svg = standalone(meta, 0);
    var head = '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<!-- ' + (meta.name || '') + ' (' + meta.id + ') 刀模展开图 | ' +
      (meta.sizes ? '制造 ' + dims(meta, 'm') + ' / 内 ' + dims(meta, 'i') +
        ' / 外 ' + dims(meta, 'o') : '') + ' | 单位 mm -->\n';
    var blob = new Blob([head + svg], { type: 'image/svg+xml;charset=utf-8' });
    V2.download(blob, fileBase(meta) + '.svg');
    return true;
  };

  function dims(meta, k) {
    var s = meta.sizes;
    if (!s) return '—';
    return ['L', 'W', 'D'].map(function (d) {
      return s[d] ? V2.num(s[d][k]) : '—';
    }).join('×');
  }

  /* ---------------- DXF（R12，刀模厂可直接导入） ---------------- */

  function dxfNum(v) {
    return (Math.round(v * 1000) / 1000).toFixed(3);
  }

  V2.exportDXF = function (meta) {
    var txt = V2.buildDXF(meta);
    var blob = new Blob([txt], { type: 'application/dxf' });
    V2.download(blob, fileBase(meta) + '.dxf');
    return { cut: (meta.g.c || []).length, crease: (meta.g.k || []).length, bytes: txt.length };
  };

  /** 生成 DXF 文本（纯函数，便于测试） */
  V2.buildDXF = function (meta) {
    var g = meta.g;
    var b = g.b;
    var ox = b[0], oy = b[3];      // 平移原点
    var W = b[2] - b[0], H = b[3] - b[1];

    var L = [];
    function p(code, val) { L.push(String(code)); L.push(String(val)); }

    /* --- HEADER --- */
    p(0, 'SECTION'); p(2, 'HEADER');
    p(9, '$ACADVER'); p(1, 'AC1009');
    p(9, '$INSBASE'); p(10, '0.0'); p(20, '0.0'); p(30, '0.0');
    p(9, '$EXTMIN'); p(10, '0.0'); p(20, '0.0'); p(30, '0.0');
    p(9, '$EXTMAX'); p(10, dxfNum(W)); p(20, dxfNum(H)); p(30, '0.0');
    p(0, 'ENDSEC');

    /* --- TABLES --- */
    p(0, 'SECTION'); p(2, 'TABLES');

    p(0, 'TABLE'); p(2, 'LTYPE'); p(70, 2);
    p(0, 'LTYPE'); p(2, 'CONTINUOUS'); p(70, 64); p(3, 'Solid line');
    p(72, 65); p(73, 0); p(40, '0.0');
    p(0, 'LTYPE'); p(2, 'DASHED'); p(70, 64); p(3, 'Dashed line');
    p(72, 65); p(73, 2); p(40, '0.75'); p(49, '0.5'); p(49, '-0.25');
    p(0, 'ENDTAB');

    p(0, 'TABLE'); p(2, 'LAYER'); p(70, 3);
    p(0, 'LAYER'); p(2, '0'); p(70, 0); p(62, 7); p(6, 'CONTINUOUS');
    p(0, 'LAYER'); p(2, 'CUT'); p(70, 0); p(62, 1); p(6, 'CONTINUOUS');
    p(0, 'LAYER'); p(2, 'CREASE'); p(70, 0); p(62, 5); p(6, 'DASHED');
    p(0, 'ENDTAB');

    p(0, 'ENDSEC');

    /* --- ENTITIES --- */
    p(0, 'SECTION'); p(2, 'ENTITIES');

    function poly(layer, flat) {
      if (!flat || flat.length < 4) return;
      p(0, 'POLYLINE'); p(8, layer); p(66, 1); p(70, 0);
      p(10, '0.0'); p(20, '0.0'); p(30, '0.0');
      var n = 0;
      for (var i = 0; i + 1 < flat.length; i += 2) {
        var x = flat[i] - ox;
        var y = oy - flat[i + 1];          // SVG 的 y 轴向下 → DXF 向上
        p(0, 'VERTEX'); p(8, layer);
        p(10, dxfNum(x)); p(20, dxfNum(y)); p(30, '0.0');
        n++;
      }
      if (n >= 2) { p(0, 'SEQEND'); p(8, layer); }
    }

    (g.c || []).forEach(function (pl) { poly('CUT', pl); });
    (g.k || []).forEach(function (pl) { poly('CREASE', pl); });

    p(0, 'ENDSEC');
    p(0, 'EOF');

    return L.join('\r\n') + '\r\n';
  };

  /* ---------------- PNG ---------------- */

  V2.exportPNG = function (meta, opts) {
    opts = opts || {};
    var px = opts.px || 2400;
    var svg = '<?xml version="1.0" encoding="UTF-8"?>\n' + standalone(meta, px, opts.swPx || 2.2);
    var blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var img = new Image();

    return new Promise(function (resolve, reject) {
      img.onload = function () {
        try {
          var c = document.createElement('canvas');
          c.width = img.naturalWidth || px;
          c.height = img.naturalHeight || Math.round(px * 0.7);
          var ctx = c.getContext('2d');
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, c.width, c.height);
          ctx.drawImage(img, 0, 0, c.width, c.height);
          URL.revokeObjectURL(url);
          c.toBlob(function (b) {
            if (!b) return reject(new Error('PNG 编码失败'));
            V2.download(b, fileBase(meta) + '.png');
            resolve({ w: c.width, h: c.height });
          }, 'image/png');
        } catch (e) { reject(e); }
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('SVG 渲染失败')); };
      img.src = url;
    });
  };

  /* ---------------- PDF（1:1 打印 → 另存为 PDF） ---------------- */

  /**
   * 用隐藏 iframe 承载图纸再调 print()：不需要 window.open，
   * 因此不会被弹窗拦截。@page 尺寸设成图纸实际尺寸，打印出来就是 1:1。
   */
  V2.exportPDF = function (meta) {
    var svg = standalone(meta, 0);
    var vb = parseVB(svg);
    var w = vb.w, h = vb.h;

    var html = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
      '<title>' + V2.esc((meta.name || '') + ' ' + meta.id) + '</title><style>' +
      '@page{size:' + w.toFixed(1) + 'mm ' + h.toFixed(1) + 'mm;margin:0}' +
      'html,body{margin:0;padding:0;background:#fff}' +
      'svg{display:block;width:' + w.toFixed(1) + 'mm;height:' + h.toFixed(1) + 'mm}' +
      '#tip{position:fixed;left:0;right:0;bottom:0;padding:8px 12px;' +
      'font:12px/1.6 system-ui,sans-serif;color:#5b6472;background:#f6f8fa;' +
      'border-top:1px solid #e3e7ec}' +
      '@media print{#tip{display:none}}' +
      '</style></head><body>' + svg +
      '<div id="tip">打印时把「缩放」设为 <b>100%（实际大小）</b>，纸张选「自定义 / 与图纸同尺寸」，' +
      '目标选 <b>另存为 PDF</b>。图纸实际尺寸 ' + w.toFixed(1) + ' × ' + h.toFixed(1) + ' mm。</div>' +
      '</body></html>';

    var fr = document.createElement('iframe');
    fr.setAttribute('aria-hidden', 'true');
    fr.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
    document.body.appendChild(fr);

    return new Promise(function (resolve) {
      var win = fr.contentWindow;
      if (!win) {
        if (fr.parentNode) fr.parentNode.removeChild(fr);
        return resolve({ ok: false, reason: '当前浏览器不支持内嵌打印，请改用 SVG 或 PNG 导出' });
      }
      var doc = fr.contentDocument || win.document;
      doc.open();
      doc.write(html);
      doc.close();

      setTimeout(function () {
        try {
          win.focus();
          win.print();
          resolve({ ok: true, w: w, h: h });
        } catch (e) {
          resolve({ ok: false, reason: '打印失败：' + e.message });
        }
        setTimeout(function () { if (fr.parentNode) fr.parentNode.removeChild(fr); }, 90000);
      }, 400);
    });
  };
})();
