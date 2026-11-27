#!/usr/bin/env node
/* ============================================================
   build_boxinfo.js —— 上游盒型信息 → data/info/NN.js 分片

   数据源：boxinfo_raw.json（由 fetch_boxinfo.mjs 抓取）
     每条 { name, tags, desc }，全部来自上游 /Online/Design/{id} 的
     服务端渲染内容（「盒型信息」面板 + <meta name="description">）。

   为什么要另起一套数据：
     现在详情页「用途标签」那一栏用的是 tags 关键词串过滤后的残留，
     结构词 / 材质词 / SEO 词 / 用途词混在一起，全库 25% 的盒型一个词都不剩。
     上游描述是人工撰写的成段说明，100% 有内容，且明确写了「通常用于…」。

   产出（每片 ≈110 KB，与 geo 同分片号，详情页只请求自己那一片）：
     data/info/00.js … 12.js
       n = 清洗后的盒型名称（拿不到给空串，前端照旧走 displayName 兜底）
       u = 适用场景，逗号串（断言句提取 ∪ 标签里的行业词）
       s = 结构与材质，逗号串（标签去掉 SEO 词与行业词后的剩余）
       d = 结构说明全文（已清洗品牌名；上游本来没有正文的给空串）

   用法：node build_boxinfo.js [--check]
     --check 只比对不写入，退出码 1 = 分片与数据源不一致
   ============================================================ */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = __dirname;
const SRC = path.join(ROOT, 'boxinfo_raw.json');
const OUT = path.join(ROOT, 'data', 'info');
const CHECK = process.argv.includes('--check');

const L = require('./tools/boxinfo-lib.js');
const { buildRecord, splitChips } = L;

/* ---------------- 主流程 ---------------- */

function loadCatalog() {
  const ctx = { window: {} };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'data', 'catalog.js'), 'utf8'), ctx);
  return ctx.window.V2_CATALOG;
}

const raw = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const cat = loadCatalog();
/* ❗ catalog.js 里的 boxes 是**数组**（[{id,name,…}]），不是 id→对象 的字典 */
const boxArr = cat.boxes || [];
const byId = {};
boxArr.forEach((b) => { byId[b.id] = b; });
const ids = boxArr.map((b) => b.id);
console.log('清单 ' + ids.length + ' 个盒型，信息源 ' + Object.keys(raw).length + ' 条');

const info = {};
const stat = { noName: 0, noScene: 0, noStruct: 0, noDesc: 0, brandFixed: 0, shell: 0 };
const samples = [];

ids.forEach((id) => {
  const r = raw[id];
  if (!r) { stat.noName++; stat.noScene++; stat.noStruct++; stat.noDesc++; return; }

  const rec = buildRecord(id, r, byId[id].tags || [], byId[id].name || '');
  info[id] = rec;

  if (/包装魔术师|packmage/i.test(String(r.desc || ''))) stat.brandFixed++;
  if (!rec.d && String(r.desc || '').trim()) stat.shell++;

  if (!rec.n) stat.noName++;
  if (!rec.u) stat.noScene++;
  if (!rec.s) stat.noStruct++;
  if (!rec.d) stat.noDesc++;
  const sample = samples.length < 8 && rec.n && rec.d;
  if (sample) samples.push([id, rec.n, rec.u ? rec.u.split(',') : [], rec.s ? rec.s.split(',') : [], rec.d.slice(0, 60)]);
});

/* 分片：沿用 catalog 的 ch（与 geo 完全同号，前端一次请求只取一片） */
const chunks = {};
ids.forEach((id) => {
  const c = byId[id].ch == null ? 0 : byId[id].ch;
  (chunks[c] = chunks[c] || []).push(id);
});

if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

let dirty = 0;
const written = [];
Object.keys(chunks).sort((a, b) => a - b).forEach((c) => {
  const f = String(c).padStart(2, '0');
  const list = chunks[c];
  const body = list.map((id) => {
    const rec = info[id] || {};
    return '"' + id + '":' + JSON.stringify(rec);
  }).join(',\n');
  const js = '/* data/info/' + f + '.js —— 盒型信息分片 ' + c + '（' + list.length + ' 个）\n' +
    '   由 build_boxinfo.js 从 boxinfo_raw.json 生成，勿手改。\n' +
    '   字段：n 名称 / u 适用场景 / s 结构与材质 / d 结构说明全文 */\n' +
    'Object.assign((window.V2_INFO = window.V2_INFO || {}), {\n' + body + '\n});\n';
  const p = path.join(OUT, f + '.js');
  const old = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
  if (old !== js) {
    dirty++;
    if (!CHECK) fs.writeFileSync(p, js);
  }
  written.push([f, list.length, (Buffer.byteLength(js) / 1024).toFixed(0)]);
});

const totalKB = written.reduce((s, x) => s + Number(x[2]), 0);
console.log('\n分片 ' + written.length + ' 个，合计 ' + totalKB + ' KB');
console.log('  片号/盒数/KB: ' + written.map((x) => x[0] + ':' + x[1] + '/' + x[2]).join('  '));
console.log('\n覆盖率：名称 ' + (ids.length - stat.noName) + '/' + ids.length +
  ' | 适用场景 ' + (ids.length - stat.noScene) +
  ' | 结构材质 ' + (ids.length - stat.noStruct) +
  ' | 结构说明 ' + (ids.length - stat.noDesc));
console.log('清洗：品牌名替换 ' + stat.brandFixed + ' 条 | 空壳描述丢弃 ' + stat.shell + ' 条');

console.log('\n样本：');
samples.forEach(([id, n, u, s, d]) => {
  console.log('  ' + id.padEnd(7) + n.padEnd(12) + '| 场景 ' + (u.join('/') || '—').padEnd(14) +
    '| 结构 ' + (s.join('/') || '—').slice(0, 28));
  console.log('         ' + d + '…');
});

if (CHECK) {
  if (dirty) {
    console.error('\n✘ ' + dirty + ' 个分片与 boxinfo_raw.json 不同步，跑一次 node build_boxinfo.js');
    process.exit(1);
  }
  console.log('\n✓ 分片与数据源一致');
} else {
  console.log('\n' + (dirty ? '✓ 已写入 ' + dirty + ' 个分片' : '✓ 本就同步，无需改动'));
}
