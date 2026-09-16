#!/usr/bin/env node
/*
 * build_box_pages.js — 为盒型库批量生成静态 SEO 着陆页
 *
 * 输入：packmage_data.js（几何 + 参数）、packmage_boxlib_zh.js（中文标签 + 分类位掩码）
 * 输出：box/<ID>/index.html（每个盒型一页）、box/index.html（目录）、sitemap.xml、robots.txt
 *       + 回写根目录 index.html 的 SEO 头部数字（盒型总数 / 分类数）
 *
 * 几何解析逻辑与 packmage_boxtypes.js 的 convertPackmageGeometry() 保持一致，
 * 保证静态页上的刀模图与在线设计器渲染结果完全一样。
 *
 * 用法：node build_box_pages.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = __dirname;
const OUT_DIR = path.join(ROOT, 'box');
const BASE = 'https://057300.xyz/diecut';
const TODAY = new Date().toISOString().slice(0, 10);

/* ---------------- 载入数据 ---------------- */

function loadData() {
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'packmage_data.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'packmage_boxlib_zh.js'), 'utf8'), ctx);
  return {
    data: ctx.PackmageData,
    cates: ctx.boxTree ? ctx.boxTree.cates : [],
    restBoxes: ctx.restBoxes || []
  };
}

/* ---------------- 几何解析（对齐 convertPackmageGeometry） ---------------- */

function buildGeometry(box) {
  const de = box.de || {};
  const absOx = Math.abs(de.ox || 0);
  const absOy = Math.abs(de.oy || 0);
  const cuts = [];
  const creases = [];

  for (const e of (box.fe || [])) {
    const type = e[0];
    const style = e[1];

    if (type === 0) {
      const line = [[e[2] + absOx, e[3] + absOy], [e[4] + absOx, e[5] + absOy]];
      (style === 0 ? cuts : creases).push(line);
    } else if (type === 1) {
      const cx = e[2] + absOx, cy = e[3] + absOy, r = e[4], sa = e[5], ea = e[6];
      // 角度按数学坐标系解释（Y 轴向上），转换到 SVG 时 sin 取负
      let diff = ea - sa;
      while (diff < 0) diff += 360;
      while (diff >= 360) diff -= 360;
      if (diff === 0 && sa !== ea) diff = 360;
      const steps = Math.max(16, Math.ceil(Math.abs(diff) / 3));
      const pts = [];
      for (let s = 0; s <= steps; s++) {
        const a = (sa + diff * (s / steps)) * Math.PI / 180;
        pts.push([cx + r * Math.cos(a), cy - r * Math.sin(a)]);
      }
      (style === 0 ? cuts : creases).push(pts);
    } else if (type === 2) {
      const pts = [];
      for (let j = 2; j < e.length; j += 2) pts.push([e[j] + absOx, e[j + 1] + absOy]);
      if (pts.length >= 2) (style === 0 ? cuts : creases).push(pts);
    }
  }

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const upd = (p) => {
    if (p[0] < minX) minX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] > maxY) maxY = p[1];
  };
  cuts.forEach((pl) => pl.forEach(upd));
  creases.forEach((pl) => pl.forEach(upd));
  if (minX === Infinity) { minX = 0; minY = 0; maxX = 100; maxY = 100; }

  return { cuts, creases, bbox: { minX, minY, maxX, maxY } };
}

const n1 = (v) => (Math.round(v * 10) / 10);

function polylinePoints(pts) {
  return pts.map((p) => n1(p[0]) + ',' + n1(p[1])).join(' ');
}

function buildSvg(geo) {
  const b = geo.bbox;
  const pad = 12;
  const w = n1(b.maxX - b.minX + pad * 2);
  const h = n1(b.maxY - b.minY + pad * 2);
  const vb = n1(b.minX - pad) + ' ' + n1(b.minY - pad) + ' ' + w + ' ' + h;

  const crease = geo.creases.map((pl) => '<polyline points="' + polylinePoints(pl) + '"/>').join('');
  const cut = geo.cuts.map((pl) => '<polyline points="' + polylinePoints(pl) + '"/>').join('');

  return '<svg class="diecut" viewBox="' + vb + '" xmlns="http://www.w3.org/2000/svg" role="img">' +
    '<g class="crease" fill="none">' + crease + '</g>' +
    '<g class="cut" fill="none">' + cut + '</g>' +
    '</svg>';
}

/* ---------------- 工具 ---------------- */

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ---------------- 根页 SEO 头部的数字回写 ---------------- */

/**
 * 根目录 index.html 是站点主入口，它的 <title> / description / og / ld+json
 * 里写死了「N 个免费刀模展开图」「N 个分类」。盒型库一更新这些数字就会漂，
 * 所以每次生成都按本次真实数量改写一遍（幂等：数字已对就不写盘）。
 *
 * 只替换这几个特定句式里的数字，其余字节原样保留（含行尾，不做任何归一化）。
 */
function syncIndexCounts(total, cateCount) {
  const file = path.join(ROOT, 'index.html');
  if (!fs.existsSync(file)) return { changed: false, replaced: 0, missing: true };

  const src = fs.readFileSync(file, 'utf8');
  let replaced = 0;
  let out = src;

  const rules = [
    [/(\d+)(\s*个免费刀模展开图)/g, total],          // <title>、og:title
    [/(\d+)(\s*个专业包装盒型刀模展开图)/g, total],   // description、og:description
    [/(\d+)(\s*种包装盒型刀模展开图)/g, total],       // ld+json
    [/(\d+)(\s*个分类)/g, cateCount],                 // description 里的分类数
  ];

  rules.forEach(([re, n]) => {
    out = out.replace(re, (m, d, tail) => {
      if (d !== String(n)) replaced++;
      return n + tail;
    });
  });

  if (out === src) return { changed: false, replaced: 0 };
  fs.writeFileSync(file, out);
  return { changed: true, replaced: replaced };
}

/* ---------------- 主流程 ---------------- */

function main() {
  const { data, cates, restBoxes } = loadData();
  const boxes = data.boxes;
  const ids = Object.keys(boxes);

  // 分类映射：Idx -> 名称
  const cateName = {};
  cates.forEach((c) => { cateName[c.Idx] = c.Name; });

  // 盒型 -> { mask, tags }
  const meta = {};
  restBoxes.forEach((r) => { meta[r[0]] = { mask: r[2], tags: r[6] || '' }; });

  function decodeCats(mask) {
    const out = [];
    for (let i = 1; i <= 20; i++) if (mask & (1 << i)) out.push(cateName[i] || ('分类' + i));
    return out;
  }
  function primaryCat(mask) {
    for (let i = 1; i <= 20; i++) if (mask & (1 << i)) return i;
    return 0;
  }
  function tagsOf(id) {
    const t = (meta[id] && meta[id].tags) || boxes[id].tags || '';
    return t ? t.split(',').map((s) => s.trim()).filter(Boolean) : [];
  }

  // 按主分类分桶，用于「相关盒型」互链
  const byCat = {};
  ids.forEach((id) => {
    const c = primaryCat(meta[id] ? meta[id].mask : 0);
    (byCat[c] = byCat[c] || []).push(id);
  });

  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  boxTotal = ids.length;
  fs.writeFileSync(path.join(OUT_DIR, 'box.css'), CSS);

  let count = 0;
  let noGeom = 0;

  for (const id of ids) {
    const box = boxes[id];
    const geo = buildGeometry(box);
    const de = box.de || {};
    const w = n1(de.w || (geo.bbox.maxX - geo.bbox.minX));
    const h = n1(de.h || (geo.bbox.maxY - geo.bbox.minY));
    const tags = tagsOf(id);
    const cats = decodeCats(meta[id] ? meta[id].mask : 0);
    const editable = (box.pm || []).filter((p) => p.l === 0);
    const hasGeom = geo.cuts.length + geo.creases.length >= 2;
    if (!hasGeom) noGeom++;

    const titleTag = tags[0] || (cats[0] || '纸盒').replace(/^[A-Za-z]{1,2}\./, '');
    const title = id + ' 盒型刀模图 - ' + titleTag + ' | 纸盒刀模库';
    const desc = id + '（' + (tags.slice(0, 3).join('、') || '纸盒盒型') + '）刀模展开图，' +
      '默认展开尺寸 ' + w + ' × ' + h + ' mm，共 ' + geo.cuts.length + ' 条切割线、' +
      geo.creases.length + ' 条压痕线。可在线调整长宽高实时重算刀模，并导出 SVG / DXF / PDF。';

    // 相关盒型（同主分类，最多 10 个）
    const cat = primaryCat(meta[id] ? meta[id].mask : 0);
    const rel = (byCat[cat] || []).filter((x) => x !== id).slice(0, 10);

    const html = renderPage({
      id, box, geo, w, h, tags, cats, editable, rel, title, desc, hasGeom
    });
    const dir = path.join(OUT_DIR, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), html);
    count++;
  }

  // 目录页
  fs.writeFileSync(path.join(OUT_DIR, 'index.html'), renderIndex(ids, byCat, cateName, meta));

  // sitemap
  const urls = [];
  urls.push(loc(BASE + '/', '1.0'));
  urls.push(loc(BASE + '/box/', '0.8'));
  ids.forEach((id) => urls.push(loc(BASE + '/box/' + encodeURIComponent(id) + '/', '0.6')));
  fs.writeFileSync(path.join(ROOT, 'sitemap.xml'),
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls.join('\n') + '\n</urlset>\n');

  fs.writeFileSync(path.join(ROOT, 'robots.txt'),
    'User-agent: *\nAllow: /\n\nSitemap: ' + BASE + '/sitemap.xml\n');

  // 根页 SEO 头部的盒型数 / 分类数跟着一起走，免得上线后标题还挂着旧数字
  const idxSync = syncIndexCounts(ids.length, cates.length);

  console.log('生成盒型页: ' + count + ' 个（无有效几何: ' + noGeom + '）');
  console.log('输出目录: ' + OUT_DIR);
  console.log('sitemap.xml / robots.txt 已写入仓库根目录');
  if (idxSync.missing) {
    console.log('⚠ 未找到 index.html，跳过 SEO 头部数字回写');
  } else if (idxSync.changed) {
    console.log('index.html SEO 头部已更新: 盒型 ' + ids.length + ' 个 / 分类 ' + cates.length
      + ' 个（改写 ' + idxSync.replaced + ' 处）');
  } else {
    console.log('index.html SEO 头部数字已是最新（' + ids.length + ' 盒 / ' + cates.length + ' 分类）');
  }
}

function loc(u, pri) {
  return '  <url><loc>' + esc(u) + '</loc><lastmod>' + TODAY + '</lastmod>' +
    '<changefreq>monthly</changefreq><priority>' + pri + '</priority></url>';
}

/* ---------------- 页面模板 ---------------- */

function renderPage(o) {
  const { id, box, geo, w, h, tags, cats, editable, rel, title, desc, hasGeom } = o;
  const url = BASE + '/box/' + encodeURIComponent(id) + '/';
  const catText = cats.length ? cats.join('、') : '未分类';
  const op = (box.de && box.de.op) ? box.de.op : '';

  const svgBlock = hasGeom
    ? buildSvg(geo)
    : '<p class="empty">该盒型暂未提供可预览的几何数据，可到设计器中查看。</p>';

  const paramRows = editable.length
    ? editable.map((p) => {
      const key = String(p.n || '').toLowerCase();
      // 样式类 / 选项类参数无单位，尺寸类参数才是 mm
      const unitless = /^sty/.test(key) || key === 'choose' || key === 'cal';
      return '<tr><td>' + esc(p.d || p.n) + '</td><td><code>' + esc(p.n) + '</code></td>' +
        '<td>' + esc(p.v) + (unitless ? '' : ' mm') + '</td></tr>';
    }).join('\n      ')
    : '<tr><td colspan="3">该盒型无开放编辑参数</td></tr>';

  const tagChips = tags.map((t) => '<span class="chip">' + esc(t) + '</span>').join('');

  const relLinks = rel.map((r) =>
    '<a href="../' + encodeURIComponent(r) + '/">' + esc(r) + '</a>').join('\n      ');

  const ld = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: '纸盒刀模设计器', item: BASE + '/' },
      { '@type': 'ListItem', position: 2, name: '盒型库', item: BASE + '/box/' },
      { '@type': 'ListItem', position: 3, name: id + ' 盒型刀模图', item: url }
    ]
  };

  return '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n' +
    '<meta charset="UTF-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
    '<title>' + esc(title) + '</title>\n' +
    '<meta name="description" content="' + esc(desc) + '">\n' +
    '<meta name="keywords" content="' + esc([id, id + '刀模', id + '盒型'].concat(tags.slice(0, 6)).join(',')) + '">\n' +
    '<link rel="canonical" href="' + esc(url) + '">\n' +
    '<link rel="stylesheet" href="../box.css">\n' +
    '<meta property="og:type" content="article">\n' +
    '<meta property="og:title" content="' + esc(title) + '">\n' +
    '<meta property="og:description" content="' + esc(desc) + '">\n' +
    '<meta property="og:url" content="' + esc(url) + '">\n' +
    '<meta name="twitter:card" content="summary">\n' +
    '<script type="application/ld+json">' + JSON.stringify(ld) + '</script>\n' +
    '</head>\n<body>\n' +

    '<nav class="crumb"><a href="../index.html">盒型库</a> &rsaquo; ' +
    esc(catText) + ' &rsaquo; <strong>' + esc(id) + '</strong></nav>\n' +

    '<h1>' + esc(id) + ' 盒型刀模图</h1>\n' +
    '<p class="lead">' + esc(id) + ' 属于 ' + esc(catText) + ' 类盒型' +
    (tags.length ? '，结构关键词：' + esc(tags.slice(0, 5).join('、')) : '') +
    '。默认展开尺寸 ' + w + ' × ' + h + ' mm，含 ' + geo.cuts.length + ' 条切割线、' +
    geo.creases.length + ' 条压痕线。下图为按默认参数计算的刀模展开图' +
    (op ? '（' + esc(op) + '）' : '') + '，可在设计器中调整尺寸实时重算并导出 SVG / DXF / PDF。</p>\n' +

    '<div class="fig">' + svgBlock +
    '<p class="cap">图：' + esc(id) + ' 刀模展开图 — 实线为切割线，虚线为压痕线</p></div>\n' +

    '<p class="cta"><a class="btn" href="../../index.html?box=' + encodeURIComponent(id) + '">' +
    '在设计器中打开 ' + esc(id) + '</a></p>\n' +

    '<h2>可调参数</h2>\n' +
    '<table class="ptab">\n  <thead><tr><th>参数</th><th>代号</th><th>默认值</th></tr></thead>\n' +
    '  <tbody>\n      ' + paramRows + '\n  </tbody>\n</table>\n' +

    '<h2>结构信息</h2>\n' +
    '<table class="ptab">\n  <tbody>\n' +
    '      <tr><td>盒型编号</td><td>' + esc(id) + '</td></tr>\n' +
    '      <tr><td>所属分类</td><td>' + esc(catText) + '</td></tr>\n' +
    '      <tr><td>展开尺寸</td><td>' + w + ' × ' + h + ' mm</td></tr>\n' +
    '      <tr><td>切割线 / 压痕线</td><td>' + geo.cuts.length + ' / ' + geo.creases.length + ' 条</td></tr>\n' +
    (op ? '      <tr><td>默认参数</td><td><code>' + esc(op) + '</code></td></tr>\n' : '') +
    '  </tbody>\n</table>\n' +

    (tagChips ? '<h2>结构与用途标签</h2>\n<div class="chips">' + tagChips + '</div>\n' : '') +

    (rel.length ? '<h2>同类盒型</h2>\n<div class="rel">\n      ' + relLinks + '\n</div>\n' : '') +

    '<footer><a href="' + BASE + '/box/">盒型库</a> &middot; 全站 ' + boxTotal + ' 个盒型 &middot; ' +
    '<a href="../../index.html">纸盒刀模设计器</a></footer>\n' +
    '</body>\n</html>\n';
}

// main() 一开始就会按真实盒型数覆盖它，这里只是占位（不要在别处假设它非 0）
let boxTotal = 0;

function renderIndex(ids, byCat, cateName, meta) {
  const total = ids.length;

  let body = '';
  Object.keys(byCat).sort((a, b) => a - b).forEach((c) => {
    const name = cateName[c] || ('分类' + c);
    const links = byCat[c].map((id) =>
      '<a href="./' + encodeURIComponent(id) + '/">' + esc(id) + '</a>').join(' ');
    body += '<h2 id="c' + c + '">' + esc(name) + ' <span class="cnt">' + byCat[c].length + '</span></h2>\n' +
      '<div class="rel">' + links + '</div>\n';
  });

  return '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n' +
    '<meta charset="UTF-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
    '<title>纸盒盒型库 - ' + total + ' 种盒型刀模图在线浏览</title>\n' +
    '<meta name="description" content="收录 ' + total + ' 种纸盒盒型刀模图，涵盖管式盒、盘式盒、天地盖、抽屉盒、礼盒、纸箱等分类，每种盒型均提供展开图、可调参数与结构标签，支持导出 SVG / DXF / PDF。">\n' +
    '<link rel="canonical" href="' + BASE + '/box/">\n' +
    '<link rel="stylesheet" href="box.css">\n' +
    '</head>\n<body>\n' +
    '<nav class="crumb"><a href="../../index.html">纸盒刀模设计器</a> &rsaquo; <strong>盒型库</strong></nav>\n' +
    '<h1>纸盒盒型库（' + total + ' 种）</h1>\n' +
    '<p class="lead">按结构分类浏览全部 ' + total + ' 种盒型，点击进入可查看该盒型的刀模展开图、可调参数与结构标签。</p>\n' +
    '<p class="cta"><a class="btn" href="../index.html">打开刀模设计器</a></p>\n' +
    body +
    '</body>\n</html>\n';
}

/* ---------------- 共享样式 ---------------- */

const CSS = 'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;' +
  'max-width:960px;margin:0 auto;padding:20px 16px 48px;line-height:1.7;color:#1f2328;background:#fff}\n' +
  'h1{font-size:24px;font-weight:600;margin:12px 0}\n' +
  'h2{font-size:18px;font-weight:600;margin:28px 0 10px;padding-bottom:6px;border-bottom:1px solid #e5e7eb}\n' +
  '.lead{color:#444;font-size:15px}\n' +
  '.crumb{font-size:13px;color:#666;margin-bottom:8px}\n' +
  '.crumb a{color:#0969da;text-decoration:none}\n' +
  '.fig{border:1px solid #e5e7eb;border-radius:8px;padding:12px;margin:16px 0;background:#fafbfc;overflow:auto}\n' +
  'svg.diecut{display:block;width:100%;height:auto;max-height:620px}\n' +
  'svg.diecut .cut polyline{stroke:#111;stroke-width:1.4;stroke-linejoin:round;stroke-linecap:round}\n' +
  'svg.diecut .crease polyline{stroke:#c0392b;stroke-width:1.1;stroke-dasharray:7 5}\n' +
  '.cap{font-size:12px;color:#888;margin:8px 0 0;text-align:center}\n' +
  '.empty{color:#888;font-size:14px;text-align:center;padding:32px 0}\n' +
  '.cta{margin:18px 0}\n' +
  '.btn{display:inline-block;background:#111;color:#fff;text-decoration:none;padding:9px 18px;border-radius:6px;font-size:14px}\n' +
  'table.ptab{border-collapse:collapse;width:100%;font-size:14px}\n' +
  'table.ptab th,table.ptab td{border:1px solid #e5e7eb;padding:7px 10px;text-align:left}\n' +
  'table.ptab th{background:#f6f8fa;font-weight:600}\n' +
  'code{background:#f2f4f7;padding:1px 5px;border-radius:4px;font-size:13px}\n' +
  '.chips{margin:8px 0}\n' +
  '.chip{display:inline-block;background:#f2f4f7;border:1px solid #e5e7eb;border-radius:14px;padding:3px 11px;margin:3px 5px 3px 0;font-size:13px;color:#333}\n' +
  '.rel{display:flex;flex-wrap:wrap;gap:6px 10px;margin:8px 0 4px}\n' +
  '.rel a{color:#0969da;text-decoration:none;font-size:14px;border:1px solid #e5e7eb;border-radius:5px;padding:3px 9px}\n' +
  '.rel a:hover{background:#f2f4f7}\n' +
  '.cnt{font-weight:400;color:#888;font-size:14px}\n' +
  'footer{margin-top:36px;padding-top:14px;border-top:1px solid #e5e7eb;font-size:13px;color:#666}\n' +
  'footer a{color:#0969da;text-decoration:none}\n' +
  '@media(max-width:600px){h1{font-size:20px}.fig{padding:8px}}\n';

main();
