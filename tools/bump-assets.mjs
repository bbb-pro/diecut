#!/usr/bin/env node
/* ============================================================
   tools/bump-assets.mjs —— 静态资源缓存版本串（cache-busting）

   为什么需要：
     GitHub Pages / Cloudflare 对静态资源的缓存策略是
         box.html / index.html   cache-control: max-age=600    (10 分钟)
         assets/*.js  style.css  cache-control: max-age=14400  (4 小时)
     两者不同步 → 发版后最长 4 小时内，老用户会拿到
         「新 HTML + 缓存的旧 JS」
     2026-09-22 就因此崩过一次：新版 box.html 删掉了 #advParams / #advWrap，
     而浏览器里缓存的旧 detail.js 仍在写它们 →
         TypeError: Cannot set properties of null (setting 'innerHTML')
     被启动链的 catch 写进状态栏，用户看到报错、刀模图不显示。

   做法：
     按「会被前端加载的脚本 + 样式」的内容算一个哈希，写进两个 HTML 的资源 URL：
         <script src="assets/common.js?v=<hash>">
     内容一变哈希就变 → URL 变 → 浏览器/CDN 立即回源，不再命中旧缓存。
     common.js / detail.js 再把版本串继承给它们动态加载的文件
     （data/catalog.js、data/geo/NN.js、assets/view3d.js），全站一次发版一起换。

   用法：
     node tools/bump-assets.mjs            # 写入（幂等）
     node tools/bump-assets.mjs --check    # 只检查是否已同步，退出码 1 = 未同步
   ============================================================ */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGES = ['index.html', 'box.html'];

/** 参与哈希的文件：所有会被浏览器加载的脚本 + 样式 */
function hashSources() {
  const files = [];

  // assets/ 顶层的 .js（不含 vendor/ mat/ 等大体积子目录）
  const assetsDir = path.join(ROOT, 'assets');
  if (fs.existsSync(assetsDir)) {
    for (const e of fs.readdirSync(assetsDir, { withFileTypes: true })) {
      if (e.isFile() && e.name.endsWith('.js')) files.push(path.join('assets', e.name));
    }
  }
  if (fs.existsSync(path.join(assetsDir, 'style.css'))) files.push(path.join('assets', 'style.css'));

  // 数据脚本（catalog + 13 个几何分片）—— 结构变了同样会让旧 JS 读崩
  const dataDir = path.join(ROOT, 'data');
  if (fs.existsSync(path.join(dataDir, 'catalog.js'))) files.push(path.join('data', 'catalog.js'));
  const geoDir = path.join(dataDir, 'geo');
  if (fs.existsSync(geoDir)) {
    for (const n of fs.readdirSync(geoDir).filter((n) => n.endsWith('.js')).sort()) {
      files.push(path.join('data', 'geo', n));
    }
  }

  files.sort();
  const h = crypto.createHash('sha1');
  for (const rel of files) {
    h.update(rel.replace(/\\/g, '/'));
    h.update('\0');
    h.update(fs.readFileSync(path.join(ROOT, rel)));
    h.update('\0');
  }
  return { hash: h.digest('hex').slice(0, 10), files };
}

/** 给 HTML 里所有 assets/*.js|css 引用写上/更新 ?v=<hash> */
function stamp(html, hash) {
  return html.replace(
    /(["'])(assets\/[A-Za-z0-9_./-]+\.(?:js|css))(?:\?v=[A-Za-z0-9]+)?(["'])/g,
    (_m, q1, p, q2) => q1 + p + '?v=' + hash + q2
  );
}

const check = process.argv.includes('--check');
const { hash, files } = hashSources();
const rows = [];
let dirty = 0;

for (const page of PAGES) {
  const p = path.join(ROOT, page);
  if (!fs.existsSync(p)) continue;
  const src = fs.readFileSync(p, 'utf8');
  const out = stamp(src, hash);
  const cur = (src.match(/\?v=([A-Za-z0-9]+)/) || [])[1] || '(无)';
  const ok = src === out;
  if (!ok) dirty++;
  rows.push({ page, cur, next: hash, changed: !ok });
  if (!ok && !check) fs.writeFileSync(p, out);
}

console.log('版本哈希: ' + hash + '   （参与计算 ' + files.length + ' 个文件）');
for (const r of rows) {
  console.log('  ' + r.page.padEnd(12) + ' ' + (r.changed ? r.cur + ' → ' + hash + (check ? '   ← 未同步' : '   已写入') : r.cur + '  已是最新'));
}

if (check) {
  if (dirty) {
    console.error('\n✘ ' + dirty + ' 个页面的资源版本串未同步。');
    console.error('  跑一次 `node tools/bump-assets.mjs` 后再提交 —— 否则发版后 ');
    console.error('  老浏览器会「新 HTML + 旧 JS」，可能直接报 Cannot set properties of null。');
    process.exit(1);
  }
  console.log('\n✓ 全部页面的资源版本串已与当前源码同步。');
} else if (dirty) {
  console.log('\n✓ 已写入。记得把 ' + PAGES.join(' / ') + ' 一起提交。');
} else {
  console.log('\n✓ 本就同步，无需改动。');
}
