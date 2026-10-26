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
// 英文站：/en/ 是入口，/en/box/ 是盒型库，盒型页在 /en/box/<ID>/
const EN_ROOT = path.join(ROOT, 'en');
const EN_DIR = path.join(EN_ROOT, 'box');
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

/* ---------------- 百度统计（全站页面统一注入） ----------------
   插在每个页面 </head> 之前（官方建议位置）。根 index.html 与 box.html
   不在本生成器管辖内，由各自文件手动维护同一段 STAT_HTML；
   CI 每月重跑本生成器，所以这里写死、别从别处 import。 */
const BAIDU_HM_ID = '87c8e0d5bc10316e4785ef9f6300beeb';
const STAT_HTML =
  '<script>\n' +
  'var _hmt = _hmt || [];\n' +
  '(function() {\n' +
  'var hm = document.createElement("script");\n' +
  'hm.src = "https://hm.baidu.com/hm.js?' + BAIDU_HM_ID + '";\n' +
  'var s = document.getElementsByTagName("script")[0];\n' +
  's.parentNode.insertBefore(hm, s);\n' +
  '})();\n' +
  '</script>\n';

/* ---------------- Google AdSense（全站页面统一注入） ----------------
   插在每个页面 </head> 之前（Google 官方要求放在 <head> 与 </head> 之间）。
   根 index.html 与 box.html 不在本生成器管辖内，由各自文件手动维护同一段 ADS_HTML；
   CI 每月重跑本生成器，所以这里写死、别从别处 import。
   ⚠️ 这段只是「启用 AdSense」；真正出广告还需要页面里有 <ins class="adsbygoogle"> 广告位，
      广告位由 AdSense 后台生成后另行插入。 */
const ADSENSE_CLIENT = 'ca-pub-1124987147181210';
const ADS_HTML =
  '<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=' + ADSENSE_CLIENT + '"\n' +
  'crossorigin="anonymous"></script>\n';

/* ---------------- robots.txt ----------------
   生成式引擎（AI 搜索/助手）的爬虫在这里显式放行 —— 这是 GEO 里少数
   「确定有用」的动作：被拦的爬虫不可能引用你的内容。
   ⚠️ Bytespider 有争议（大量站点选择屏蔽，且被指不严格遵守 robots），
   这里不显式声明，保持中立；要拦就单独加一段 Disallow。 */
const ROBOTS_TXT =
  'User-agent: *\nAllow: /\n\n' +
  'User-agent: GPTBot\nAllow: /\n\n' +
  'User-agent: OAI-SearchBot\nAllow: /\n\n' +
  'User-agent: ClaudeBot\nAllow: /\n\n' +
  'User-agent: PerplexityBot\nAllow: /\n\n' +
  'User-agent: CCBot\nAllow: /\n\n' +
  'User-agent: Google-Extended\nAllow: /\n\n' +
  'User-agent: Applebot-Extended\nAllow: /\n\n' +
  'Sitemap: ' + BASE + '/sitemap.xml\n';

/* ---------------- 分类英文名（英文站 /en/ 用） ----------------
   分类名只在 packmage 数据源里有中文版，英文版按结构含义手工定名，
   保留原前缀（A. / BQ. / JP.）以便与盒型编号对照。 */
const CAT_EN = {
  0: 'Recommended',
  1: 'A. Tube Boxes',
  2: 'B. Extended Tube Boxes',
  3: 'D. Tray Boxes',
  4: 'C. Rigid Lid-Base Boxes',
  5: 'E. Hinged Lid Boxes',
  6: 'I. Drawer Boxes',
  7: 'Z. Irregular Shaped Boxes',
  8: 'L. Display Boxes',
  9: 'J. Common Cartons',
  10: 'M. Inserts & Partitions',
  11: 'F. Paper Bags',
  12: 'G. Envelopes & Folders',
  13: 'S. Labels & Hang Tags',
  14: 'Q. Display Stands',
  15: 'R. Plastic Sheet Boxes',
  16: 'JP. Gift & Premium Boxes',
  17: 'BQ. Others',
  18: 'Y. Rounded Corner Boxes',
  19: 'U. Flexible Packaging',
  20: 'X. Imposition'
};

/* ---------------- 英文站文案 ----------------
   ⚠️ 刻意不翻译中文盒型名：数据源里根本没有 name 字段（只有中文 tags），
   硬翻既无依据又易错。英文页改用「盒型代码 + 分类英文名 + 真实几何数据」
   的组合 —— 代码本身就是国际通用名，而尺寸/线数是语言无关的原创数据，
   恰好也是生成式引擎最愿意引用的那类事实。 */
function enCatsOf(mask, cateName) {
  const out = [];
  for (let i = 1; i <= 20; i++) if (mask & (1 << i)) out.push(CAT_EN[i] || ('Category ' + i));
  return out;
}

/** 判断是不是 FEFCO 标准码：盒型编号以数字开头（如 0201 / 0312B / 0422） */
function isFefco(id) { return /^[0-9]/.test(id); }

/**
 * hreflang 三件套：中文页与英文页互指 + x-default 兜底。
 * ⚠️ 必须双向输出（中页指英页、英页指中页），单向 Google 会忽略。
 * 生成器渲染与本地批量插入脚本共用它，保证两条路径字节一致。
 */
function altLinks(id) {
  const p = encodeURIComponent(id);
  const zh = BASE + '/box/' + p + '/';
  const en = BASE + '/en/box/' + p + '/';
  return '<link rel="alternate" hreflang="zh-CN" href="' + esc(zh) + '">\n' +
    '<link rel="alternate" hreflang="en" href="' + esc(en) + '">\n' +
    '<link rel="alternate" hreflang="x-default" href="' + esc(zh) + '">\n';
}

/** 目录页的 hreflang（中英各一份目录，同样互指） */
function altLinksIndex() {
  const zh = BASE + '/box/';
  const en = BASE + '/en/box/';
  return '<link rel="alternate" hreflang="zh-CN" href="' + esc(zh) + '">\n' +
    '<link rel="alternate" hreflang="en" href="' + esc(en) + '">\n' +
    '<link rel="alternate" hreflang="x-default" href="' + esc(zh) + '">\n';
}

/** 英文盒型页：标题 / 描述 / FAQ，全部由真实数据拼出 */
function enCopy(d) {
  const catEn = d.catsEn.length ? d.catsEn.join(', ') : 'Uncategorized';
  const kind = isFefco(d.id) ? 'FEFCO ' + d.id : 'Box type ' + d.id;
  const title = kind + ' — ' + catEn + ' Die-cut Template Generator';
  const desc = kind + ' die-cut template (' + catEn + '). Flat size ' + d.w + ' × ' + d.h +
    ' mm, ' + d.nCut + ' cut lines and ' + d.nCrease + ' crease lines. Adjust length, width ' +
    'and depth online, recalculate instantly, and export SVG / DXF / PDF. Free, no signup.';
  const dims = [];
  if (d.ce) {
    ['l', 'w', 'd'].forEach((k) => {
      if (d.ce[k] != null) dims.push(k.toUpperCase() + ' ' + d.ce[k] + ' mm');
    });
  }
  const faq = [];
  faq.push(['What are the default dimensions of box type ' + d.id + '?',
    dims.length
      ? 'The default size is ' + dims.join(', ') + '. The flat (unfolded) sheet measures ' +
        d.w + ' × ' + d.h + ' mm.'
      : 'The flat (unfolded) sheet measures ' + d.w + ' × ' + d.h + ' mm.']);
  faq.push(['How many cut and crease lines does box type ' + d.id + ' have?',
    'The template contains ' + d.nCut + ' cut lines and ' + d.nCrease + ' crease lines.']);
  faq.push(['Can I change the dimensions of box type ' + d.id + '?',
    d.params.length
      ? 'Yes. ' + d.params.length + ' parameters are adjustable, including ' +
        d.params.slice(0, 6).join(', ') + '. The die-cut outline is recalculated on every change.'
      : 'This box type has no open editing parameters.']);
  faq.push(['Which export formats are supported?',
    'SVG, DXF (R12), PDF and PNG. Cut and crease lines are kept as separate layers in SVG.']);
  return {
    title: title,
    desc: desc,
    catEn: catEn,
    faq: faq,
    h1: kind + ' box template',
    lead: 'Box type ' + d.id + ' is classified under ' + catEn + '. The flat (unfolded) sheet ' +
      'measures ' + d.w + ' × ' + d.h + ' mm and contains ' + d.nCut + ' cut lines and ' +
      d.nCrease + ' crease lines. The drawing below is computed from the default parameters' +
      (d.op ? ' (' + d.op + ')' : '') + '. Open it in the designer to change the dimensions, ' +
      'recalculate in real time, and export SVG / DXF / PDF.',
    cap: 'Figure: ' + d.id + ' die-cut layout — solid lines are cut lines, ' +
      'dashed lines are crease lines',
    cta: 'Open ' + d.id + ' in the designer',
    secParam: 'Adjustable parameters',
    secStruct: 'Structure details',
    secFaq: 'Frequently asked questions',
    secTags: 'Structure & application tags',
    secRel: 'Related box types',
    thCode: 'Code',
    thDefault: 'Default',
    lbCode: 'Box code',
    lbCat: 'Category',
    lbFlat: 'Flat size',
    lbLines: 'Cut / crease lines',
    lbDefault: 'Default parameters',
    libLink: 'Box library',
    designerLink: 'Box die-cut designer',
    empty: 'No previewable geometry data is available for this box type yet. ' +
      'You can open it in the designer instead.'
  };
}

/** ce 是 'l=200,w=100,d=250,...' 形式的字符串（key 一律小写） */
function parseCe(s) {
  const o = {};
  String(s || '').split(',').forEach((kv) => {
    const i = kv.indexOf('=');
    if (i > 0) o[kv.slice(0, i).trim().toLowerCase()] = kv.slice(i + 1).trim();
  });
  return o;
}

/** FAQPage 结构化数据：问答内容全部来自上一步真实计算，不写死 */
function faqLd(faq) {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faq.map(([q, a]) => ({
      '@type': 'Question',
      name: q,
      acceptedAnswer: { '@type': 'Answer', text: a }
    }))
  };
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

/* ---------------- 英文工具页：从 box.html 派生 ---------------- */
/* /en/box.html 不另写一套界面，直接从中文 box.html 派生，只改五类东西：
   资源路径 / 语言标记 / 标题描述 / 站内导航 / 语言入口。
   这样以后改中文工具页，英文版自动跟上，不会出现两份 UI 漂移。
   （en/ 目录每月被 CI 整棵重建，所以必须由生成器写出，不能手工放进去。） */
function buildEnBoxTool() {
  let html = fs.readFileSync(path.join(ROOT, 'box.html'), 'utf8');

  /* 1) 资源路径：en/ 比站点根多一层 */
  html = html.replace(/(href|src)="assets\//g, '$1="../assets/');
  html = html.replace(/(href|src)="favicon\./g, '$1="../favicon.');

  /* 2) 语言标记：i18n.js 靠它决定是否翻译 */
  html = html.replace('<html lang="zh-CN">', '<html lang="en">');

  /* 3) 标题 / 描述（工具页是 noindex，但社交分享与浏览器标签仍要用英文） */
  html = html.replace(/<title>[\s\S]*?<\/title>/,
    '<title>Box template designer · Universal Box Template Library</title>');
  html = html.replace(/<meta name="description" content="[^"]*">/,
    '<meta name="description" content="Interactive die-cut designer: adjust length, width and depth, recalculate the die line in real time, preview it in 3D and export SVG / DXF / PDF / PNG at 1:1 actual size.">');

  /* 4) 站内导航：品牌 / 返回 / 面包屑都指向英文盒型库，而不是中文首页 */
  html = html.replace(/href="index\.html"/g, 'href="box/"');

  /* 5) 语言入口兜底（JS 会再算一次，这里防 JS 失效） */
  html = html.replace(
    'id="langEn" href="en/" title="Switch to the English version">English',
    'id="langEn" href="../box.html" title="Switch to Chinese">中文');

  fs.writeFileSync(path.join(EN_ROOT, 'box.html'), html);
  return true;
}

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
  // 英文目录整棵重建，保证与本次数据完全同步（en/ 纯生成物，不含手写内容）
  fs.rmSync(EN_ROOT, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(EN_DIR, { recursive: true });

  boxTotal = ids.length;
  fs.writeFileSync(path.join(OUT_DIR, 'box.css'), CSS);
  fs.writeFileSync(path.join(EN_DIR, 'box.css'), CSS);

  let count = 0;
  let noGeom = 0;

  for (const id of ids) {
    const box = boxes[id];
    const geo = buildGeometry(box);
    const de = box.de || {};
    const w = n1(de.w || (geo.bbox.maxX - geo.bbox.minX));
    const h = n1(de.h || (geo.bbox.maxY - geo.bbox.minY));
    const tags = tagsOf(id);
    const mask = meta[id] ? meta[id].mask : 0;
    const cats = decodeCats(mask);
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
      id, box, geo, w, h, tags, cats, editable, rel, title, desc, hasGeom,
      mask   // 英文页分类名（CAT_EN）依赖它；漏传会让 en 标题集体退化成 Uncategorized
    });
    const dir = path.join(OUT_DIR, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), html);
    count++;
  }

  // 目录页（中英各一份）
  fs.writeFileSync(path.join(OUT_DIR, 'index.html'), renderIndex(ids, byCat, cateName, meta, 'zh'));
  /* 英文盒型库：左分类栏 + 右缩略图卡片（与中文首页同一套 list.js） */
  fs.writeFileSync(path.join(EN_DIR, 'index.html'), renderEnLib(ids, byCat, cateName, meta));

  // 英文站入口页 /en/
  fs.writeFileSync(path.join(EN_ROOT, 'index.html'), renderEnHome(ids, byCat, cateName, ids.length));

  // 英文设计器 /en/box.html（从 box.html 派生，界面与逻辑共用一套）
  buildEnBoxTool();

  // sitemap：中英成对，条目里直接带 hreflang 互指
  const urls = [];
  urls.push(locAlt(BASE + '/', BASE + '/en/', '1.0'));
  urls.push(locAlt(BASE + '/box/', BASE + '/en/box/', '0.8'));
  ids.forEach((id) => {
    const p = encodeURIComponent(id);
    urls.push(locAlt(BASE + '/box/' + p + '/', BASE + '/en/box/' + p + '/', '0.6'));
  });
  fs.writeFileSync(path.join(ROOT, 'sitemap.xml'),
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" ' +
    'xmlns:xhtml="http://www.w3.org/1999/xhtml">\n' +
    urls.join('\n') + '\n</urlset>\n');

  fs.writeFileSync(path.join(ROOT, 'robots.txt'), ROBOTS_TXT);

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

/** sitemap 条目：中英**各一条** <url>，每条都带 hreflang 互指。
    早期版本只把英文页写成 alternate，英文页没有独立 <loc>，收录完全依赖 Google 解析 hreflang；
    给出独立条目后英文页可被直接抓取，对英文引流更快见效。 */
function locAlt(uZh, uEn, pri) {
  const links =
    '    <xhtml:link rel="alternate" hreflang="zh-CN" href="' + esc(uZh) + '"/>\n' +
    '    <xhtml:link rel="alternate" hreflang="en" href="' + esc(uEn) + '"/>\n' +
    '    <xhtml:link rel="alternate" hreflang="x-default" href="' + esc(uZh) + '"/>\n';
  const one = (loc, p) =>
    '  <url>\n' +
    '    <loc>' + esc(loc) + '</loc>\n' +
    '    <lastmod>' + TODAY + '</lastmod>\n' +
    '<changefreq>monthly</changefreq><priority>' + p + '</priority>\n' +
    links +
    '  </url>';
  return one(uZh, pri) + '\n' + one(uEn, pri);
}

/* ---------------- 页面模板 ---------------- */

function renderPage(o, lang) {
  lang = lang || 'zh';
  const en = lang === 'en';
  const { id, box, geo, w, h, tags, cats, editable, rel, hasGeom } = o;

  // 中文页在 /box/<ID>/，英文页在 /en/box/<ID>/ —— 站内相对路径按这个前提写
  const langRoot = en ? BASE + '/en' : BASE;   // /diecut/en 或 /diecut
  const url = langRoot + '/box/' + encodeURIComponent(id) + '/';
  // 中文页 /box/<ID>/，英文页 /en/box/<ID>/ —— 两者都只需退一级就到各自的盒型库目录
  // （box.css 就放在那里：/box/box.css 与 /en/box/box.css），所以 toLib 对两种语言是一样的。
  // 早期版本给英文写成 '../../' 会退到 /en/box.css → 404、整页无样式（页面看起来像"无数据"）。
  const toSite = en ? '../../../' : '../../';   // 回到 /diecut/
  const toLib = '../';                          // 回到各自的盒型库目录

  const catsEn = en ? enCatsOf(o.mask || 0) : [];
  const catText = en
    ? (catsEn.length ? catsEn.join(', ') : 'Uncategorized')
    : (cats.length ? cats.join('、') : '未分类');
  const op = (box.de && box.de.op) ? box.de.op : '';

  // 英文页的标题/描述/FAQ 全部由真实几何数据拼出，不是写死的模板句
  const cp = en ? enCopy({
    id: id, w: w, h: h,
    nCut: geo.cuts.length, nCrease: geo.creases.length,
    catsEn: catsEn, ce: parseCe(box.ce), op: op,
    params: editable.map((p) => String(p.n || ''))
  }) : null;
  const title = en ? cp.title : o.title;
  const desc = en ? cp.desc : o.desc;

  const svgBlock = hasGeom
    ? buildSvg(geo)
    : en
      ? '<p class="empty">No previewable geometry data is available for this box type yet. You can open it in the designer instead.</p>'
      : '<p class="empty">该盒型暂未提供可预览的几何数据，可到设计器中查看。</p>';

  // 英文页只给「代号 + 默认值」两列：数据源里没有英文参数名，不硬翻
  const paramRows = editable.length
    ? editable.map((p) => {
      const key = String(p.n || '').toLowerCase();
      // 样式类 / 选项类参数无单位，尺寸类参数才是 mm
      const unitless = /^sty/.test(key) || key === 'choose' || key === 'cal';
      return en
        ? '<tr><td><code>' + esc(p.n) + '</code></td><td>' + esc(p.v) +
          (unitless ? '' : ' mm') + '</td></tr>'
        : '<tr><td>' + esc(p.d || p.n) + '</td><td><code>' + esc(p.n) + '</code></td>' +
          '<td>' + esc(p.v) + (unitless ? '' : ' mm') + '</td></tr>';
    }).join('\n      ')
    : (en
      ? '<tr><td colspan="2">This box type has no open editing parameters</td></tr>'
      : '<tr><td colspan="3">该盒型无开放编辑参数</td></tr>');

  const tagChips = tags.map((t) => '<span class="chip">' + esc(t) + '</span>').join('');

  const relLinks = rel.map((r) =>
    '<a href="../' + encodeURIComponent(r) + '/">' + esc(r) + '</a>').join('\n      ');

  const ld = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: en
      ? [
        { '@type': 'ListItem', position: 1, name: 'Box template library', item: langRoot + '/' },
        { '@type': 'ListItem', position: 2, name: 'Box library', item: langRoot + '/box/' },
        { '@type': 'ListItem', position: 3, name: id + ' box template', item: url }
      ]
      : [
        { '@type': 'ListItem', position: 1, name: '纸盒刀模设计器', item: BASE + '/' },
        { '@type': 'ListItem', position: 2, name: '盒型库', item: BASE + '/box/' },
        { '@type': 'ListItem', position: 3, name: id + ' 盒型刀模图', item: url }
      ]
  };

  // hreflang：中文页与英文页互指（两个语言版本都会输出这一段）
  const enUrl = BASE + '/en/box/' + encodeURIComponent(id) + '/';
  const altHtml = altLinks(id);

  // 英文页不输出中文标签云（英文读者看不懂，且中英混排拉低可读性）
  const tagChipsEn = '';

  const kw = en
    ? (isFefco(id)
      ? [id, 'FEFCO ' + id, id + ' box template', 'corrugated carton', 'die-cut template', 'packaging box'].join(', ')
      : [id, id + ' box template', 'packaging box template', 'die-cut template'].join(', '))
    : [id, id + '刀模', id + '盒型'].concat(tags.slice(0, 6)).join(',');

  // 英文页在 /en/box/<ID>/，「中文版」得退三级回站点根才能到 /box/<ID>/。
  // 早期版本写成 '../../box/<ID>/' 会解析成 /en/box/<ID>/ —— 等于链回自己。
  const langSwitch = en
    ? '<p class="langswitch"><a href="' + toSite + 'box/' + encodeURIComponent(id) + '/">中文版</a></p>\n'
    : '<p class="langswitch"><a href="' + enUrl + '">English version</a></p>\n';

  return '<!DOCTYPE html>\n<html lang="' + (en ? 'en' : 'zh-CN') + '">\n<head>\n' +
    '<meta charset="UTF-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
    '<title>' + esc(title) + '</title>\n' +
    '<meta name="description" content="' + esc(desc) + '">\n' +
    '<meta name="keywords" content="' + esc(kw) + '">\n' +
    '<link rel="canonical" href="' + esc(url) + '">\n' +
    altHtml +
    // 中文页在 /box/<ID>/ 退两级取图标，英文页在 /en/box/<ID>/ 得退三级
    '<link rel="icon" href="' + toSite + 'favicon.ico" sizes="any">\n' +
    '<link rel="icon" href="' + toSite + 'favicon.svg" type="image/svg+xml">\n' +
    '<link rel="stylesheet" href="' + toLib + 'box.css">\n' +
    '<meta property="og:type" content="article">\n' +
    '<meta property="og:title" content="' + esc(title) + '">\n' +
    '<meta property="og:description" content="' + esc(desc) + '">\n' +
    '<meta property="og:url" content="' + esc(url) + '">\n' +
    '<meta property="og:locale" content="' + (en ? 'en_US' : 'zh_CN') + '">\n' +
    '<meta name="twitter:card" content="summary">\n' +
    '<script type="application/ld+json">' + JSON.stringify(ld) + '</script>\n' +
    (en ? '<script type="application/ld+json">' + JSON.stringify(faqLd(cp.faq)) + '</script>\n' : '') +
    STAT_HTML +
    ADS_HTML +
    '</head>\n<body>\n' +

    '<nav class="crumb"><a href="../index.html">' +
    (en ? 'Box library' : '盒型库') + '</a> &rsaquo; ' +
    esc(catText) + ' &rsaquo; <strong>' + esc(id) + '</strong></nav>\n' +

    '<h1>' + esc(en ? cp.h1 : (id + ' 盒型刀模图')) + '</h1>\n' +
    '<p class="lead">' + (en ? esc(cp.lead) : (
      esc(id) + ' 属于 ' + esc(catText) + ' 类盒型' +
      (tags.length ? '，结构关键词：' + esc(tags.slice(0, 5).join('、')) : '') +
      '。默认展开尺寸 ' + w + ' × ' + h + ' mm，含 ' + geo.cuts.length + ' 条切割线、' +
      geo.creases.length + ' 条压痕线。下图为按默认参数计算的刀模展开图' +
      (op ? '（' + esc(op) + '）' : '') +
      '，可在设计器中调整尺寸实时重算并导出 SVG / DXF / PDF。'
    )) + '</p>\n' +

    '<div class="fig">' + svgBlock +
    '<p class="cap">' + esc(en ? cp.cap : ('图：' + id + ' 刀模展开图 — 实线为切割线，虚线为压痕线')) +
    '</p></div>\n' +

    '<p class="cta"><a class="btn" href="' + toSite + (en ? 'en/box.html?id=' : 'index.html?box=') +
    encodeURIComponent(id) + '">' +
    (en ? ('Open ' + esc(id) + ' in the designer') : ('在设计器中打开 ' + esc(id))) +
    '</a></p>\n' +

    '<h2>' + (en ? cp.secParam : '可调参数') + '</h2>\n' +
    '<table class="ptab">\n  <thead><tr>' +
    (en
      ? '<th>' + cp.thCode + '</th><th>' + cp.thDefault + '</th>'
      : '<th>参数</th><th>代号</th><th>默认值</th>') +
    '</tr></thead>\n' +
    '  <tbody>\n      ' + paramRows + '\n  </tbody>\n</table>\n' +

    '<h2>' + (en ? cp.secStruct : '结构信息') + '</h2>\n' +
    '<table class="ptab">\n  <tbody>\n' +
    '      <tr><td>' + (en ? cp.lbCode : '盒型编号') + '</td><td>' + esc(id) + '</td></tr>\n' +
    '      <tr><td>' + (en ? cp.lbCat : '所属分类') + '</td><td>' + esc(catText) + '</td></tr>\n' +
    '      <tr><td>' + (en ? cp.lbFlat : '展开尺寸') + '</td><td>' + w + ' × ' + h + ' mm</td></tr>\n' +
    '      <tr><td>' + (en ? cp.lbLines : '切割线 / 压痕线') + '</td><td>' + geo.cuts.length +
    ' / ' + geo.creases.length + (en ? '' : ' 条') + '</td></tr>\n' +
    (op ? '      <tr><td>' + (en ? cp.lbDefault : '默认参数') + '</td><td><code>' +
      esc(op) + '</code></td></tr>\n' : '') +
    '  </tbody>\n</table>\n' +

    (en
      ? '<h2>' + cp.secFaq + '</h2>\n<div class="faq">\n' +
        cp.faq.map(([q, a]) =>
          '  <h3>' + esc(q) + '</h3>\n  <p>' + esc(a) + '</p>\n').join('') + '</div>\n'
      : (tagChips ? '<h2>结构与用途标签</h2>\n<div class="chips">' + tagChips + '</div>\n' : '')) +

    (rel.length ? '<h2>' + (en ? cp.secRel : '同类盒型') + '</h2>\n<div class="rel">\n      ' +
      relLinks + '\n</div>\n' : '') +

    langSwitch +

    '<footer><a href="' + langRoot + '/box/">' + (en ? cp.libLink : '盒型库') + '</a> &middot; ' +
    (en ? (boxTotal + ' box types in total') : ('全站 ' + boxTotal + ' 个盒型')) + ' &middot; ' +
    '<a href="' + toSite + 'index.html">' + (en ? cp.designerLink : '纸盒刀模设计器') +
    '</a></footer>\n' +
    '</body>\n</html>\n';
}

// main() 一开始就会按真实盒型数覆盖它，这里只是占位（不要在别处假设它非 0）
let boxTotal = 0;

/**
 * 不走 main()（比如只生成英文站）时必须先调它灌入真实盒型数，
 * 否则页脚的「全站 N 个盒型」会渲染成 0。
 */
function setBoxTotal(n) { boxTotal = n; }

function renderIndex(ids, byCat, cateName, meta, lang) {
  lang = lang || 'zh';
  const en = lang === 'en';
  const total = ids.length;
  // 目录页在 /box/（中文）或 /en/box/（英文），退一级都是各自的语言根
  const toSite = en ? '../../' : '../';
  const langRoot = en ? BASE + '/en' : BASE;

  let body = '';
  Object.keys(byCat).sort((a, b) => a - b).forEach((c) => {
    const name = en ? (CAT_EN[c] || ('Category ' + c)) : (cateName[c] || ('分类' + c));
    const links = byCat[c].map((id) =>
      '<a href="./' + encodeURIComponent(id) + '/">' + esc(id) + '</a>').join(' ');
    body += '<h2 id="c' + c + '">' + esc(name) + ' <span class="cnt">' + byCat[c].length + '</span></h2>\n' +
      '<div class="rel">' + links + '</div>\n';
  });

  const title = en
    ? 'Packaging box template library - ' + total + ' die-cut box types online'
    : '纸盒盒型库 - ' + total + ' 种盒型刀模图在线浏览';
  const desc = en
    ? total + ' packaging box die-cut templates covering tube boxes, tray boxes, rigid lid-base boxes, drawer boxes, gift boxes and corrugated cartons. Each box type includes a flat layout, adjustable parameters and structure tags. Export SVG / DXF / PDF.'
    : '收录 ' + total + ' 种纸盒盒型刀模图，涵盖管式盒、盘式盒、天地盖、抽屉盒、礼盒、纸箱等分类，每种盒型均提供展开图、可调参数与结构标签，支持导出 SVG / DXF / PDF。';

  // hreflang：目录页同样中英双向 + x-default
  const altHtml = altLinksIndex();

  const langSwitch = en
    ? '<p class="langswitch"><a href="../../box/">中文版</a></p>\n'
    : '<p class="langswitch"><a href="' + BASE + '/en/box/">English version</a></p>\n';

  return '<!DOCTYPE html>\n<html lang="' + (en ? 'en' : 'zh-CN') + '">\n<head>\n' +
    '<meta charset="UTF-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
    '<title>' + esc(title) + '</title>\n' +
    '<meta name="description" content="' + esc(desc) + '">\n' +
    '<meta name="keywords" content="' + esc(
      en ? 'packaging box template, die-cut template, corrugated carton, FEFCO, box dieline'
        : '纸盒盒型,刀模图,包装盒型,纸箱盒型') + '">\n' +
    '<link rel="canonical" href="' + esc(langRoot + '/box/') + '">\n' +
    altHtml +
    '<link rel="icon" href="' + toSite + 'favicon.ico" sizes="any">\n' +
    '<link rel="icon" href="' + toSite + 'favicon.svg" type="image/svg+xml">\n' +
    '<link rel="stylesheet" href="box.css">\n' +
    '<meta property="og:type" content="website">\n' +
    '<meta property="og:title" content="' + esc(title) + '">\n' +
    '<meta property="og:description" content="' + esc(desc) + '">\n' +
    '<meta property="og:url" content="' + esc(langRoot + '/box/') + '">\n' +
    '<meta property="og:locale" content="' + (en ? 'en_US' : 'zh_CN') + '">\n' +
    '<meta name="twitter:card" content="summary">\n' +
    STAT_HTML +
    ADS_HTML +
    '</head>\n<body>\n' +
    '<nav class="crumb"><a href="' + toSite + 'index.html">' +
    (en ? 'Box die-cut designer' : '纸盒刀模设计器') + '</a> &rsaquo; <strong>' +
    (en ? 'Box library' : '盒型库') + '</strong></nav>\n' +
    '<h1>' + (en
      ? 'Packaging box library (' + total + ' types)'
      : '纸盒盒型库（' + total + ' 种）') + '</h1>\n' +
    '<p class="lead">' + (en
      ? 'Browse all ' + total + ' box types by structure category. Click any box type to see its die-cut layout, adjustable parameters and structure tags.'
      : '按结构分类浏览全部 ' + total + ' 种盒型，点击进入可查看该盒型的刀模展开图、可调参数与结构标签。') +
    '</p>\n' +
    '<p class="cta"><a class="btn" href="' + toSite + 'index.html">' +
    (en ? 'Open the die-cut designer' : '打开刀模设计器') + '</a></p>\n' +
    body +
    langSwitch +
    '</body>\n</html>\n';
}

/* ---------------- 英文站首页（/en/）----------------
   英文流量的入口页：首屏一句话说清能干什么，再分流到分类。
   刻意不堆关键词 —— 这一页的可读性比密度重要。 */
function renderEnHome(ids, byCat, cateName, total) {
  let cats = '';
  Object.keys(byCat).sort((a, b) => a - b).forEach((c) => {
    const name = CAT_EN[c] || ('Category ' + c);
    cats += '<li><a href="box/?cat=' + c + '">' + esc(name) + '</a> ' +
      '<span class="cnt">(' + byCat[c].length + ')</span></li>\n';
  });

  const homeUrl = BASE + '/en/';
  const title = 'Free packaging box die-cut template generator - ' + total + ' box types';
  const desc = 'Generate die-cut (dieline) templates for ' + total + ' packaging box types ' +
    'online. Adjust length, width and depth, preview the flat layout and the 3D folding, ' +
    'then export SVG, DXF, PDF or PNG. Free, no signup required.';

  const altHtml =
    '<link rel="alternate" hreflang="zh-CN" href="' + esc(BASE + '/') + '">\n' +
    '<link rel="alternate" hreflang="en" href="' + esc(homeUrl) + '">\n' +
    '<link rel="alternate" hreflang="x-default" href="' + esc(BASE + '/') + '">\n';

  const ld = {
    '@context': 'https://schema.org',
    '@type': 'WebApplication',
    name: 'Packaging box die-cut template generator',
    url: homeUrl,
    applicationCategory: 'DesignApplication',
    operatingSystem: 'Web Browser',
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    description: desc
  };

  return '<!DOCTYPE html>\n<html lang="en">\n<head>\n' +
    '<meta charset="UTF-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
    '<title>' + esc(title) + '</title>\n' +
    '<meta name="description" content="' + esc(desc) + '">\n' +
    '<meta name="keywords" content="packaging box template, die-cut template, dieline, ' +
    'corrugated carton, FEFCO, box design">' + '\n' +
    '<link rel="canonical" href="' + esc(homeUrl) + '">\n' +
    altHtml +
    // 本页在 /en/ 下，退一级取站点根图标
    '<link rel="icon" href="../favicon.ico" sizes="any">\n' +
    '<link rel="icon" href="../favicon.svg" type="image/svg+xml">\n' +
    '<link rel="stylesheet" href="box/box.css">\n' +
    '<meta property="og:type" content="website">\n' +
    '<meta property="og:title" content="' + esc(title) + '">\n' +
    '<meta property="og:description" content="' + esc(desc) + '">\n' +
    '<meta property="og:url" content="' + esc(homeUrl) + '">\n' +
    '<meta property="og:locale" content="en_US">\n' +
    '<meta name="twitter:card" content="summary">\n' +
    '<script type="application/ld+json">' + JSON.stringify(ld) + '</script>\n' +
    STAT_HTML +
    ADS_HTML +
    '</head>\n<body>\n' +
    '<nav class="crumb"><strong>Box template library</strong></nav>\n' +
    '<h1>Packaging box die-cut template generator</h1>\n' +
    '<p class="lead">' + total + ' standard box types with real geometry. ' +
    'Pick a box type, set length, width and depth, and get an accurate dieline ' +
    'you can export to SVG, DXF, PDF or PNG. No signup, no paywall.</p>\n' +
    '<p class="cta"><a class="btn" href="box/">Browse all ' + total +
    ' box types</a></p>\n' +
    '<h2>Categories</h2>\n<ul class="cats">\n' + cats + '</ul>\n' +
    '<p class="langswitch"><a href="../">中文版</a></p>\n' +
    '<footer><a href="box/">Box library</a> &middot; ' + total +
    ' box types in total &middot; <a href="../">Box die-cut designer</a></footer>\n' +
    '</body>\n</html>\n';
}

/* ---------------- 英文站盒型库（/en/box/）----------------
   与中文首页 index.html 同一套界面：左分类栏 + 右缩略图卡片网格，
   由 assets/list.js 驱动（中英共用一份 JS，英文页注入分类英文名与卡片链接前缀）。
   卡片标题用「编号 + 英文分类名」：数据源里盒型名只有中文，硬翻既无依据又易错，
   辨识主要靠缩略图与编号 —— 编号本身就是国际通用的盒型代码。
   底部保留 A–Z 纯文本索引：给搜索引擎和无 JS 环境留一条可达路径（含 #cN 锚点）。 */

/** 读 index.html 上已写好的静态资源版本串，保证和主站同一次发版一起换 */
function assetVer() {
  try {
    const s = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const m = /assets\/common\.js\?v=([A-Za-z0-9._-]+)/.exec(s);
    return m ? m[1] : '';
  } catch (e) {
    return '';
  }
}

function renderEnLib(ids, byCat, cateName, meta) {
  const total = ids.length;
  const url = BASE + '/en/box/';
  const v = assetVer();
  const q = (f) => f + (v ? '?v=' + v : '');

  const title = 'Box template library - ' + total + ' die-cut box types with previews';
  const desc = 'Browse ' + total + ' packaging box die-cut templates by structure category — ' +
    'tube boxes, trays, lid-and-base boxes, drawer boxes, gift boxes and corrugated cartons. ' +
    'Preview each box type, open it in the designer, adjust sizes and export SVG / DXF / PDF.';

  const altHtml =
    '<link rel="alternate" hreflang="zh-CN" href="' + esc(BASE + '/box/') + '">\n' +
    '<link rel="alternate" hreflang="en" href="' + esc(url) + '">\n' +
    '<link rel="alternate" hreflang="x-default" href="' + esc(BASE + '/box/') + '">\n';

  /* 分类英文名注入给 list.js（common.js 的 catName 会优先用它） */
  const catMap = {};
  Object.keys(byCat).sort((a, b) => a - b).forEach((c) => {
    catMap[c] = CAT_EN[c] || ('Category ' + c);
  });

  /* A–Z 纯文本索引（SEO / 无 JS 兜底） */
  let seoIndex = '';
  Object.keys(byCat).sort((a, b) => a - b).forEach((c) => {
    const links = byCat[c].map((id) =>
      '<a href="./' + encodeURIComponent(id) + '/">' + esc(id) + '</a>').join(' ');
    seoIndex += '<h2 id="c' + c + '">' + esc(catMap[c]) + ' <span class="cnt">' +
      byCat[c].length + '</span></h2>\n<div class="rel">' + links + '</div>\n';
  });

  return '<!DOCTYPE html>\n<html lang="en">\n<head>\n' +
    '<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    '<title>' + esc(title) + '</title>\n' +
    '<meta name="description" content="' + esc(desc) + '">\n' +
    '<meta name="keywords" content="packaging box template, die-cut template, box dieline, ' +
    'corrugated carton, FEFCO, gift box template">\n' +
    '<link rel="canonical" href="' + esc(url) + '">\n' +
    altHtml +
    '<link rel="icon" href="../../favicon.ico" sizes="any">\n' +
    '<link rel="icon" href="../../favicon.svg" type="image/svg+xml">\n' +
    '<link rel="stylesheet" href="' + q('../../assets/style.css') + '">\n' +
    '<meta property="og:type" content="website">\n' +
    '<meta property="og:title" content="' + esc(title) + '">\n' +
    '<meta property="og:description" content="' + esc(desc) + '">\n' +
    '<meta property="og:url" content="' + esc(url) + '">\n' +
    '<meta property="og:locale" content="en_US">\n' +
    '<meta name="twitter:card" content="summary">\n' +
    '<style>\n' +
    '.search-hint{display:flex;gap:16px;flex-wrap:wrap;margin-top:4px}\n' +
    '.sug-box{position:absolute;top:calc(100% + 6px);left:0;right:0;background:#fff;' +
    'border:1px solid var(--border);border-radius:10px;box-shadow:var(--shadow-lg);' +
    'overflow:hidden;display:none;z-index:60}\n' +
    '.sug{display:flex;align-items:baseline;gap:8px;padding:9px 12px;border-bottom:1px solid var(--border)}\n' +
    '.sug:last-child{border-bottom:0}\n' +
    '.sug:hover{background:var(--accent-weak)}\n' +
    '.sug b{font-weight:600;font-size:13px}\n' +
    '.sug span{font-size:11.5px;color:var(--muted);margin-left:auto;font-family:ui-monospace,Menlo,monospace}\n' +
    '.seo-all{margin:36px 0 8px;border-top:1px solid var(--border);padding-top:16px}\n' +
    '.seo-all summary{cursor:pointer;font-size:13.5px;color:var(--muted);font-weight:600}\n' +
    '.seo-all h2{font-size:14px;margin:20px 0 8px;border:0;padding:0}\n' +
    '.seo-all .rel{display:flex;flex-wrap:wrap;gap:6px}\n' +
    '.seo-all .rel a{font-size:12px;color:var(--muted);text-decoration:none;' +
    'border:1px solid var(--border);border-radius:6px;padding:2px 6px}\n' +
    '</style>\n' +
    STAT_HTML +
    ADS_HTML +
    '</head>\n<body>\n' +
    '<header class="topbar">\n' +
    '  <a class="brand" href="../">\n' +
    '    <span class="brand-mark">P</span>\n' +
    '    Universal Box Template Library\n' +
    '    <span class="brand-sub">Die-cut layouts · parametric design</span>\n' +
    '  </a>\n' +
    '  <div class="topbar-search">\n' +
    '    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/>' +
    '<path d="M20 20l-3.5-3.5"/></svg>\n' +
    '    <input id="q" type="search" placeholder="Search by box code or category, e.g. &quot;0201&quot;, &quot;tray&quot;" autocomplete="off">\n' +
    '    <div class="sug-box" id="qbox"></div>\n' +
    '  </div>\n' +
    '  <div class="topbar-right">\n' +
    '    <a class="btn btn-sm" href="../../box/" title="Switch to the Chinese version">中文版</a>\n' +
    '    <a class="btn btn-sm" href="../box.html" title="Open the die-cut designer">Open designer</a>\n' +
    '  </div>\n' +
    '</header>\n' +
    '<div class="loadbar" id="loadbar"><i></i></div>\n' +
    '<div class="layout">\n' +
    '  <aside class="sidebar" id="cats"></aside>\n' +
    '  <main class="content">\n' +
    '    <div class="hero">\n' +
    '      <h1 id="heroTitle">All box types</h1>\n' +
    '      <p id="heroDesc">Loading box data…</p>\n' +
    '      <div class="hero-stats">\n' +
    '        <div class="stat"><b id="statTotal">—</b><span>Box types</span></div>\n' +
    '        <div class="stat"><b id="statCat">—</b><span>Categories</span></div>\n' +
    '        <div class="stat"><b id="statChunk">—</b><span>Data chunks</span></div>\n' +
    '        <div class="stat"><b>3</b><span>Size systems</span></div>\n' +
    '      </div>\n' +
    '    </div>\n' +
    '    <div class="grid" id="grid">\n' +
    '      <div class="empty" style="grid-column:1/-1"><b>Loading…</b>about 0.5 MB on first load</div>\n' +
    '    </div>\n' +
    '    <details class="seo-all">\n' +
    '      <summary>All ' + total + ' box types — text index</summary>\n' +
    seoIndex +
    '    </details>\n' +
    '  </main>\n' +
    '</div>\n' +
    '<div class="hvp" id="hvp" hidden>\n' +
    '  <div class="hvp-label">Box reference</div>\n' +
    '  <div class="hvp-stage"><div class="hvp-flat"></div><div class="hvp-iso"></div></div>\n' +
    '  <div class="hvp-cap"><b id="hvpId">—</b><span id="hvpName"></span><i id="hvpDim"></i></div>\n' +
    '</div>\n' +
    '<script>\n' +
    '/* 英文分类名（生成器 CAT_EN）+ 卡片链接前缀：英文选型点开后进英文设计器 */\n' +
    'window.V2_CAT_EN = ' + JSON.stringify(catMap) + ';\n' +
    'window.V2_CARD_HREF = \'../box.html?id=\';\n' +
    '</script>\n' +
    '<script src="' + q('../../assets/common.js') + '"></script>\n' +
    '<script src="' + q('../../assets/i18n.js') + '"></script>\n' +
    '<script src="' + q('../../assets/list.js') + '"></script>\n' +
    '</body>\n</html>\n';
}

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
  '.langswitch{margin:20px 0 0;font-size:14px}\n' +
  '.langswitch a{color:#0969da;text-decoration:none;border:1px solid #e5e7eb;' +
  'border-radius:5px;padding:4px 12px}\n' +
  '.langswitch a:hover{background:#f2f4f7}\n' +
  'ul.cats{margin:8px 0;padding-left:20px;line-height:1.9}\n' +
  'ul.cats a{color:#0969da;text-decoration:none}\n' +
  '.faq h3{font-size:14px;margin:18px 0 4px}\n' +
  '.faq p{margin:0 0 6px;color:#333}\n' +
  '@media(max-width:600px){h1{font-size:20px}.fig{padding:8px}}\n';

/* ---------------- 入口 ----------------
   ⚠️ require.main 守卫必须有：main() 里第一行就 rmSync(box/)，
   没有守卫的话任何 require('./build_box_pages.js') 都会连带删掉 box/ 重建，
   一次 1300 文件 diff。加了这个守卫，直接执行才跑 main()。 */
if (require.main === module) main();

module.exports = {
  main: main,
  setBoxTotal: setBoxTotal,
  altLinks: altLinks,
  altLinksIndex: altLinksIndex,
  renderPage: renderPage,
  renderIndex: renderIndex,
  renderEnHome: renderEnHome,
  renderEnLib: renderEnLib,
  assetVer: assetVer,
  buildEnBoxTool: buildEnBoxTool,
  loadData: loadData,
  buildGeometry: buildGeometry,
  buildSvg: buildSvg,
  parseCe: parseCe,
  n1: n1,
  esc: esc,
  locAlt: locAlt,
  CSS: CSS,
  STAT_HTML: STAT_HTML,
  ADS_HTML: ADS_HTML,
  ADSENSE_CLIENT: ADSENSE_CLIENT,
  ROBOTS_TXT: ROBOTS_TXT,
  CAT_EN: CAT_EN,
  BASE: BASE,
  OUT_DIR: OUT_DIR,
  EN_ROOT: EN_ROOT,
  EN_DIR: EN_DIR
};
