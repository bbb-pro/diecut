#!/usr/bin/env node
/*
 * build_v2.js — 为 v2 界面（pacdora 风格）生成数据
 *
 * 输出：
 *   data/catalog.js          列表页元数据（全部盒型，无几何）
 *   data/geo/NN.js           几何分片（每片 100 盒，含几何 + 参数 + 尺寸）
 *
 * 设计要点：
 *   - 几何按「每 100 盒一片」切分，列表页/详情页均按需加载，避免首屏 6.7MB
 *   - 折线做 Douglas-Peucker 简化（容差 = 包围盒长边 0.1%）
 *   - 坐标保留 1 位小数
 *   - 尺寸模型：制造尺寸 = l/w/d；内尺寸 = 制造 - 2*inner；外尺寸 = 制造 + 2*outer
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
/* 2026-09-16：v2 已平移到仓库根、/v2/ 下架，产物直接落 data/。
   OUT_DIR 环境变量可覆盖输出目录，用于试跑比对而不动线上数据。 */
const OUT = process.env.OUT_DIR
  ? path.resolve(process.env.OUT_DIR)
  : path.join(ROOT, 'data');
const CHUNK_SIZE = 100;

/** 这些标签太笼统，不适合当盒型名 */
const GENERIC_TAG = /^(免费|其他|BQ|彩盒|纸盒|包装盒|包装设计)$/;

/* ================= 载入源数据 ================= */

function loadAll() {
  const D = new Function(
    fs.readFileSync(path.join(ROOT, 'packmage_data.js'), 'utf8') + '; return PackmageData;'
  )();
  const LIB = new Function(
    fs.readFileSync(path.join(ROOT, 'packmage_boxlib_zh.js'), 'utf8') +
    '; return { cates: boxTree.cates, rest: restBoxes };'
  )();
  return { D, LIB };
}

/* ================= 几何解析（对齐 packmage_boxtypes.js） ================= */

function parseGeo(box) {
  const de = box.de || {};
  const ax = Math.abs(de.ox || 0);
  const ay = Math.abs(de.oy || 0);
  const cuts = [];
  const creases = [];

  for (const e of (box.fe || [])) {
    const type = e[0];
    const style = e[1];
    const dst = style === 0 ? cuts : creases;

    if (type === 0) {
      dst.push([[e[2] + ax, e[3] + ay], [e[4] + ax, e[5] + ay]]);
    } else if (type === 1) {
      const cx = e[2] + ax, cy = e[3] + ay, r = e[4], sa = e[5], ea = e[6];
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
      dst.push(pts);
    } else if (type === 2) {
      const pts = [];
      for (let j = 2; j < e.length; j += 2) pts.push([e[j] + ax, e[j + 1] + ay]);
      if (pts.length >= 2) dst.push(pts);
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

  return { cuts, creases, minX, minY, maxX, maxY };
}

/* ================= Douglas-Peucker 简化 ================= */

function simplify(pts, tol) {
  const n = pts.length;
  if (n <= 2) return pts;
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  const t2 = tol * tol;

  while (stack.length) {
    const seg = stack.pop();
    const a = seg[0], b = seg[1];
    if (b - a < 2) continue;
    const ax = pts[a][0], ay = pts[a][1];
    const bx = pts[b][0], by = pts[b][1];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let best = -1, bi = -1;
    for (let i = a + 1; i < b; i++) {
      const px = pts[i][0], py = pts[i][1];
      let d2;
      if (len2 === 0) {
        const ex = px - ax, ey = py - ay;
        d2 = ex * ex + ey * ey;
      } else {
        let t = ((px - ax) * dx + (py - ay) * dy) / len2;
        t = t < 0 ? 0 : (t > 1 ? 1 : t);
        const ex = px - (ax + t * dx), ey = py - (ay + t * dy);
        d2 = ex * ex + ey * ey;
      }
      if (d2 > best) { best = d2; bi = i; }
    }
    if (best > t2) { keep[bi] = 1; stack.push([a, bi], [bi, b]); }
  }

  const r = [];
  for (let i = 0; i < n; i++) if (keep[i]) r.push(pts[i]);
  return r;
}

/* ================= 工具 ================= */

const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

function parseCe(ce) {
  const m = {};
  String(ce || '').split(',').forEach((s) => {
    const i = s.indexOf('=');
    if (i > 0) m[s.slice(0, i).trim()] = s.slice(i + 1).trim();
  });
  return m;
}

/** 折线数组 -> [[x1,y1,x2,y2,...], ...]，1 位小数 */
function flat(polys) {
  const out = [];
  for (const pl of polys) {
    const arr = [];
    for (let i = 0; i < pl.length; i++) { arr.push(r1(pl[i][0]), r1(pl[i][1])); }
    out.push(arr);
  }
  return out;
}

/* ================= 主流程 ================= */

function main() {
  const t0 = Date.now();
  const { D, LIB } = loadAll();
  const boxes = D.boxes;
  const ids = Object.keys(boxes);

  const cateName = {};
  LIB.cates.forEach((c) => { cateName[c.Idx] = c.Name; });

  const meta = {};
  LIB.rest.forEach((row) => { meta[String(row[0])] = { mask: row[2] || 0 }; });

  const decodeCats = (mask) => {
    const out = [];
    for (let i = 1; i <= 20; i++) if (mask & (1 << i)) out.push(i);
    return out;
  };

  /* 参数中文标签全局表 */
  const labelMap = {};
  for (const id of ids) {
    for (const p of (boxes[id].pm || [])) {
      if (p.n && p.d && !labelMap[p.n]) labelMap[p.n] = String(p.d);
    }
  }
  Object.assign(labelMap, {
    l: '长', w: '宽', d: '高', cal: '纸板厚度',
    inl: '内长', inw: '内宽', ind: '内高',
    inner: '向内补偿', outer: '向外补偿', choose: '盒型选择'
  });

  const UNITLESS = /^(sty|choose|of|ct|nan|insty|tran)/i;
  const isUnitless = (n) => UNITLESS.test(n) || n === 'cal';

  /* 只清生成物。data/ 下还有 thumbs/（packmage 官方缩略图，与盒型一一对应），
     所以绝不能用 rmSync(OUT, recursive) 整目录删 —— 那会把缩略图一起删光。 */
  fs.rmSync(path.join(OUT, 'geo'), { recursive: true, force: true });
  fs.rmSync(path.join(OUT, 'catalog.js'), { force: true });
  fs.mkdirSync(path.join(OUT, 'geo'), { recursive: true });

  const catCount = {};
  const listItems = [];
  const chunks = [];

  /* 按「主分类」把盒型排序，使同一分类的盒型在分片里连续 —— 切换分类只需 1~3 个分片 */
  const catOfId = {};
  for (const id of ids) {
    const m = (meta[id] || {}).mask || 0;
    const cs = decodeCats(m);
    catOfId[id] = cs.length ? cs[0] : 0;
  }
  const ordered = ids.slice().sort((a, b) => (catOfId[a] - catOfId[b]) || a.localeCompare(b));
  let cur = {};
  let curCount = 0;
  let chunkIdx = 0;
  let totalPts = 0;
  let savePts = 0;
  let noGeom = 0;

  const flush = () => {
    if (!curCount) return;
    const name = String(chunkIdx).padStart(2, '0');
    fs.writeFileSync(
      path.join(OUT, 'geo', name + '.js'),
      'window.V2_GEO=window.V2_GEO||{};Object.assign(window.V2_GEO,' + JSON.stringify(cur) + ');\n'
    );
    chunks.push({ i: chunkIdx, f: name, n: curCount });
    chunkIdx++;
    cur = {};
    curCount = 0;
  };

  for (const id of ordered) {
    const box = boxes[id];
    const ce = parseCe(box.ce);
    const geo = parseGeo(box);
    const hasGeom = geo.cuts.length + geo.creases.length >= 2;
    if (!hasGeom) noGeom++;

    const mask = (meta[id] || {}).mask || 0;
    const cats = decodeCats(mask);
    const cat = cats.length ? cats[0] : 0;
    catCount[cat] = (catCount[cat] || 0) + 1;

    const tags = String(box.tags || '').split(',').map((s) => s.trim()).filter(Boolean);
    let name = '';
    for (const t of tags) {
      if (!GENERIC_TAG.test(t)) { name = t; break; }
    }
    if (!name) name = (cateName[cat] || '纸盒').replace(/^[A-Za-z]{1,2}\./, '');
    if (name === '免费') name = '未分类盒型';

    const L = num(ce.l, null), W = num(ce.w, null), Dp = num(ce.d, null);
    const inner = num(ce.inner, 0), outer = num(ce.outer, 0);
    const th = num(ce.cal, r2(inner + outer));
    /* 内外补偿是「单边」量，一个尺寸跨两块纸板，故 ×2（2026-09-16 飞哥确认口径） */
    const mk = (v) => (v == null ? null
      : { m: r2(v), i: r2(v - 2 * inner), o: r2(v + 2 * outer) });

    const maxDim = Math.max(geo.maxX - geo.minX, geo.maxY - geo.minY) || 1;
    const tol = maxDim * 0.001;
    const simp = (polys) => polys.map((pl) => {
      totalPts += pl.length;
      const s = simplify(pl, tol);
      savePts += s.length;
      return s;
    });

    const cutsFlat = flat(simp(geo.cuts));
    const creasesFlat = flat(simp(geo.creases));

    const params = (box.pm || []).filter((p) => p.n).map((p) => {
      const o = { n: p.n, v: p.v, l: p.l || 0 };
      const lb = p.d || labelMap[p.n];
      if (lb) o.d = String(lb);
      if (!isUnitless(p.n)) o.u = 1;
      return o;
    });

    cur[id] = {
      b: [r1(geo.minX), r1(geo.minY), r1(geo.maxX), r1(geo.maxY)],
      c: cutsFlat,
      k: creasesFlat,
      p: params,
      ce: ce,
      op: (box.de || {}).op || '',
      cal: box.cal || null
    };
    curCount++;

    listItems.push({
      id: id,
      name: name,
      cat: cat,
      cats: cats.length ? cats : [0],
      tags: tags.slice(0, 6),
      L: mk(L), W: mk(W), D: mk(Dp),
      t: r2(th),
      inner: r2(inner),
      outer: r2(outer),
      ew: r1(num((box.de || {}).w, 0)),
      eh: r1(num((box.de || {}).h, 0)),
      sl: r1(num((box.de || {}).sl, 0)),
      dl: r1(num((box.de || {}).dl, 0)),
      cut: geo.cuts.length,
      cre: geo.creases.length,
      cal: box.cal || null,
      ch: chunkIdx,
      ok: hasGeom ? 1 : 0
    });

    if (curCount >= CHUNK_SIZE) flush();
  }
  flush();

  const cats = LIB.cates
    .filter((c) => catCount[c.Idx])
    .map((c) => ({ idx: c.Idx, name: c.Name, count: catCount[c.Idx] || 0 }));

  const catalog = {
    total: ids.length,
    built: new Date().toISOString().slice(0, 10),
    chunkSize: CHUNK_SIZE,
    chunks: chunks,
    cats: cats,
    labels: labelMap,
    boxes: listItems
  };
  fs.writeFileSync(
    path.join(OUT, 'catalog.js'),
    'window.V2_CATALOG=' + JSON.stringify(catalog) + ';\n'
  );

  const sz = (p) => (fs.statSync(p).size / 1024).toFixed(0) + 'KB';
  let geoSz = 0;
  chunks.forEach((c) => { geoSz += fs.statSync(path.join(OUT, 'geo', c.f + '.js')).size; });

  console.log('盒型: ' + listItems.length + ' | 无几何: ' + noGeom);
  console.log('分类: ' + cats.length);
  cats.forEach((c) => console.log('   ' + c.idx + ' ' + c.name + ' -> ' + c.count));
  console.log('catalog.js: ' + sz(path.join(OUT, 'catalog.js')));
  console.log('geo 分片: ' + chunks.length + ' 个, 合计 ' + (geoSz / 1024 / 1024).toFixed(2) + ' MB, 平均 ' + (geoSz / chunks.length / 1024).toFixed(0) + 'KB');
  console.log('顶点: ' + totalPts + ' -> ' + savePts + ' (' + (100 * savePts / totalPts).toFixed(0) + '%) | 耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
}

main();
