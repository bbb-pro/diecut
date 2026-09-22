#!/usr/bin/env node
/*
 * download_all_boxes.js — 从 packmage 同步盒型库（清单 + 几何）
 *
 * 用法：
 *   node download_all_boxes.js                 # 增量：沿用本地清单，只补缺几何
 *   node download_all_boxes.js --refresh-lib   # 先从上游刷新清单，再增量补几何【定时任务用这个】
 *   node download_all_boxes.js --force         # 全部重下几何（~1294 次请求，慢）
 *   node download_all_boxes.js --dry-run       # 只报告差异，不写任何文件
 *   node download_all_boxes.js --strict        # 有盒型抓取失败时返回非 0（默认只告警）
 *
 * 数据来源（两个端点都匿名开放，无需登录）：
 *   清单  GET   https://online.packmage.cn/diy/worktable/boxlib_zh.min.js
 *               → `var boxTree = {cates, restBoxes}`；restBoxes 每行 = [id, ?, 分类位掩码, 0, 0, 0, tags]
 *   几何  POST  https://online.packmage.cn/Online/GetBoxData  {boxID, inPms:''}
 *
 * 输出（--dry-run 时全部跳过）：
 *   packmage_boxlib_zh.js    清单快照（--refresh-lib 时覆盖）
 *   packmage_data.js         {categories, catalog, boxes} —— 下游 build_v2.js / build_box_pages.js 的唯一输入
 *   _sync_report.json        本次同步摘要（供 sync_boxlib.js / CI 生成提交信息）
 *
 * 说明：
 *   - catalog 是「权威清单」，每次都由上游 restBoxes 重建（1279 → 1294 这类新增会自己冒出来）
 *   - boxes 只增不减：不在新 catalog 里的盒型会被剔除（上游删掉的盒型同步消失）
 *   - 不再写 packmage_all_boxes.json —— 它只是 packmage_data.js 的重复副本，仓库里没人读
 */

'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');
const querystring = require('querystring');
const vm = require('vm');

const ROOT = __dirname;
const HOST = 'online.packmage.cn';
const API_PATH = '/Online/GetBoxData';
const LIB_PATH = '/diy/worktable/boxlib_zh.min.js';
const LIB_URL = 'https://' + HOST + LIB_PATH;

const BATCH_SIZE = 10;      // 并发请求数（上游无鉴权无限流，实测 12 路 102ms 全通）
const TIMEOUT = 20000;

const argv = process.argv.slice(2);
const REFRESH_LIB = argv.includes('--refresh-lib');
const FORCE = argv.includes('--force');
const DRY = argv.includes('--dry-run');
const STRICT = argv.includes('--strict');

/* ================= 基础工具 ================= */

const log = (...a) => console.log(...a);

function download(url, redirects) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.get({
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; diecut-sync/1.0)',
        'Referer': 'https://online.packmage.cn/online/boxes',
      },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && (redirects || 0) < 5) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        resolve(download(next, (redirects || 0) + 1));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error('HTTP ' + res.statusCode + ' @ ' + url));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.setTimeout(TIMEOUT, () => { req.destroy(new Error('timeout')); });
  });
}

/** 从 boxlib JS 文本里抽 {cates, rest}；用 vm 执行，不依赖正则 */
function parseLib(src) {
  const ctx = { boxTree: null, restBoxes: null };
  vm.createContext(ctx);
  vm.runInContext(src, ctx, { timeout: 10000 });
  const cates = (ctx.boxTree && ctx.boxTree.cates) || [];
  const rest = ctx.restBoxes || [];
  if (!cates.length || !rest.length) throw new Error('boxlib 解析失败：cates 或 restBoxes 为空');
  return { cates, rest };
}

function loadLocalData() {
  const p = path.join(ROOT, 'packmage_data.js');
  if (!fs.existsSync(p)) return null;
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(p, 'utf8'), ctx, { timeout: 30000 });
  return ctx.PackmageData || null;
}

/** catalog = restBoxes 的一比一映射（已核验：1279 条逐字段相同） */
function buildCatalog(rest) {
  return rest.map((row) => ({
    id: String(row[0]),
    tid: row[2] || 0,
    tags: String(row[6] || ''),
  }));
}

/** 分类表：Idx 0 上游叫「免费」，站点上叫「常用」，保持既有口径 */
function buildCategories(cates) {
  return cates.map((c) => ({
    tid: c.TID,
    name: c.Idx === 0 ? '常用' : c.Name,
    idx: c.Idx,
  }));
}

/* ================= 几何抓取 ================= */

function fetchBox(boxID) {
  return new Promise((resolve) => {
    const postData = querystring.stringify({
      boxID: boxID,
      inPms: '', // 空 = 用上游默认参数
      getBox3D: 'false',
      getFullPmsDesc: 'true',
      getRemark: 'true',
      tran: '0',
    });

    const req = https.request({
      hostname: HOST,
      path: API_PATH,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
        'Referer': 'https://online.packmage.cn/Online/Design/' + boxID,
        'Origin': 'https://online.packmage.cn',
        'User-Agent': 'Mozilla/5.0 (compatible; diecut-sync/1.0)',
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          /* success:false = 上游明确表示「这个盒型没有数据」（如 Q002，清单里有但几何为空）。
             这不是网络故障，不该算抓取失败，也不该重试 —— 用哨兵值区分。 */
          if (!json.success) return resolve({ __rejected: true });
          const inner = typeof json.Data === 'string' ? JSON.parse(json.Data) : json.Data;
          const d = typeof inner.data === 'string' ? JSON.parse(inner.data) : inner.data;
          const cadData = typeof inner.cadData === 'string' ? JSON.parse(inner.cadData) : inner.cadData;
          resolve({
            tags: '',
            tid: 0,
            cal: { min: cadData.CalMin || 1, max: cadData.CalMax || 3 },
            de: {
              w: d.de.Width,
              h: d.de.Height,
              ox: d.de.OffsetX,
              oy: d.de.OffsetY,
              p: d.de.P,
              sl: d.de.SolidLength,
              dl: d.de.DashLength,
              op: d.de.OutPms,
            },
            ce: d.ce,
            pm: normPm(cadData.PmItems, d.ce),
            rm: normRm(cadData.Remarks, d.de.OffsetX, d.de.OffsetY),
            fe: d.fe,
          });
        } catch (e) {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(TIMEOUT, () => { req.destroy(); resolve(null); });
    req.write(postData);
    req.end();
  });
}

/** 抓到的原始 PmItems（Name/Desc/DefaultV/DownList/Layer）→ 站内紧凑格式 {n,d,v,l,dl}
 *  - v 优先取该盒 ce 里的**实际值**（ce 是 "l=300,w=200,…" 字符串），没有才用 DefaultV
 *  - ❗ DownList 的 **key（去掉下划线）才是要传回后端的数值**，value 只是显示文案，
 *    所以必须存成 [{v,t}]，只取文本会把「上插舌样式=2」变成「锁扣」这种非数值，
 *    回传求解时直接被上游当非法参数 */
function normPm(items, ceStr) {
  const ce = {};
  String(ceStr || '').split(',').forEach((kv) => {
    const i = kv.indexOf('=');
    if (i > 0) ce[kv.slice(0, i).trim().toLowerCase()] = kv.slice(i + 1).trim();
  });
  return (items || []).filter((it) => it && it.Name).map((it) => {
    const n = String(it.Name).toLowerCase();
    const o = { n: n, l: it.Layer || 0, d: it.Desc || '' };
    const v = ce[n];
    if (v != null && v !== '') {
      const num = parseFloat(v);
      o.v = isFinite(num) && String(num) === v ? num : v;
    } else {
      o.v = it.DefaultV == null ? '' : it.DefaultV;
    }
    if (it.DownList) {
      o.dl = Object.entries(it.DownList).map(([k, val]) => ({
        v: String(k).replace(/^_/, '').trim(),
        t: String(val).trim(),
      })).sort((a, b) => (parseFloat(a.v) || 0) - (parseFloat(b.v) || 0));
    }
    return o;
  });
}

/** 官方标注数据 cadData.Remarks → 站内紧凑格式
 *
 *  源格式：[参数名, 锚点x, 锚点y, 类型, 值]
 *    · 类型  x/xb 水平尺寸、y/yl 垂直尺寸、r1~r4 半径、a* 与 ac* 角度
 *    · 值    数组 = 主尺寸 [内尺寸, 外尺寸, 刀模尺寸]；单值 = 普通参数
 *    · 上游已经把 sty* / cal* / inner / outer / choose 这类不标注的参数滤掉了，
 *      前端不需要再筛一遍
 *
 *  ❗坐标是「锚点坐标」，官方渲染时也要减 OffsetX/OffsetY 才落到图面上。
 *    站内几何同样平移了 |Offset|（实测 OffsetX/OffsetY 恒 ≤ 0，两种写法等价），
 *    这里直接存成图面坐标，前端就不必再换算 —— 两端必须用同一套坐标，
 *    否则标注会整体偏掉一个 Offset（E055 就是 110 × 303）。
 */
function normRm(items, ox, oy) {
  const ax = Math.abs(ox || 0);
  const ay = Math.abs(oy || 0);
  const r1 = (v) => Math.round(v * 10) / 10;
  const r2 = (v) => Math.round(v * 100) / 100;
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  return (items || []).filter((r) => r && r.length >= 5 && r[3]).map((r) => [
    String(r[0]), r1(num(r[1]) + ax), r1(num(r[2]) + ay), String(r[3]),
    Array.isArray(r[4]) ? r[4].map((v) => r2(num(v))) : r2(num(r[4])),
  ]);
}

/** 带重试的抓取（CI 网络抖动兜底） */
async function fetchBoxRetry(id, attempts) {
  for (let i = 0; i < (attempts || 3); i++) {
    const b = await fetchBox(id);
    if (b) return b;
    await new Promise((r) => setTimeout(r, 500 * (i + 1)));
  }
  return null;
}

/* ================= 主流程 ================= */

async function main() {
  const t0 = Date.now();
  const local = loadLocalData();
  const localCatalog = (local && local.catalog) || [];
  const localBoxes = (local && local.boxes) || {};
  log('本地快照: catalog ' + localCatalog.length + ' 条 / 几何 ' + Object.keys(localBoxes).length + ' 个');

  /* --- 1) 刷新清单 --- */
  let libSrc = null;
  if (REFRESH_LIB) {
    log('拉取上游清单 ' + LIB_URL + ' …');
    const buf = await download(LIB_URL);
    libSrc = buf.toString('utf8');
    log('  上游清单 ' + (buf.length / 1024).toFixed(0) + ' KB');
    if (!DRY) fs.writeFileSync(path.join(ROOT, 'packmage_boxlib_zh.js'), buf);
  } else {
    libSrc = fs.readFileSync(path.join(ROOT, 'packmage_boxlib_zh.js'), 'utf8');
    log('使用本地清单 packmage_boxlib_zh.js（加 --refresh-lib 才会从上游刷新）');
  }

  const { cates, rest } = parseLib(libSrc);
  const catalog = buildCatalog(rest);
  const categories = buildCategories(cates);
  log('上游清单: cates ' + cates.length + ' 个 / 盒型 ' + catalog.length + ' 个');

  /* --- 2) 差异 --- */
  const newIds = new Set(catalog.map((c) => c.id));
  const oldIds = new Set(localCatalog.map((c) => c.id));
  const added = catalog.filter((c) => !oldIds.has(c.id)).map((c) => c.id);
  const removed = localCatalog.filter((c) => !newIds.has(c.id)).map((c) => c.id);
  const tagsChanged = catalog.filter((c) => {
    const old = localCatalog.find((o) => o.id === c.id);
    return old && (old.tags !== c.tags || old.tid !== c.tid);
  }).map((c) => c.id);

  log('清单差异: 新增 ' + added.length + ' / 消失 ' + removed.length + ' / 元数据变化 ' + tagsChanged.length);
  if (added.length) log('  新增: ' + added.join(', '));
  if (removed.length) log('  消失: ' + removed.join(', '));
  if (tagsChanged.length) log('  元数据变化: ' + tagsChanged.slice(0, 20).join(', ') + (tagsChanged.length > 20 ? ' …' : ''));

  const catalogLookup = {};
  catalog.forEach((c) => { catalogLookup[c.id] = c; });

  /* --- 3) 决定要抓哪些几何 --- */
  // 只保留还在清单里的盒型 → 上游删掉的盒型同步消失
  const allBoxes = {};
  for (const id of Object.keys(localBoxes)) if (newIds.has(id)) allBoxes[id] = localBoxes[id];

  /* 要抓的有三类：
     ① 本地没有几何的盒型
     ② 几何有、但参数表（pm）为空的 —— 老快照当年抓到的是空 PmItems，
        上游现在每盒都返回 18~80 项参数，按这条补上，否则参数面板永远是空的
     ③ 几何有、但缺标注数据（rm）的 —— 尺寸标注改成读上游 Remarks 之后，
        老快照没有这一项，不补的话展开图上一条标注都不会有 */
  const missing = catalog.map((c) => c.id)
    .filter((id) => !allBoxes[id] || !((allBoxes[id].pm || []).length)
      || !((allBoxes[id].rm || []).length));
  const targets = FORCE ? catalog.map((c) => c.id) : missing;
  log('需要抓取: ' + targets.length + ' 个' + (FORCE ? '（--force 全量重下）' : '（缺几何 / 参数表 / 标注数据的盒型）'));

  /* --- 4) 抓几何 --- */
  let ok = 0;
  let failed = [];
  let rejected = [];
  if (!DRY) {
    for (let i = 0; i < targets.length; i += BATCH_SIZE) {
      const batch = targets.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(batch.map((id) => fetchBoxRetry(id)));
      results.forEach((box, j) => {
        const id = batch[j];
        if (!box) { failed.push(id); return; }
        if (box.__rejected) { rejected.push(id); return; }   // 上游确认无几何
        const cat = catalogLookup[id];
        if (cat) { box.tags = cat.tags; box.tid = cat.tid; }
        allBoxes[id] = box;
        ok++;
      });
      process.stdout.write('\r  进度 ' + Math.min(i + BATCH_SIZE, targets.length) + '/' + targets.length
        + ' | 成功 ' + ok + ' | 上游无数据 ' + rejected.length + ' | 失败 ' + failed.length);
    }
    if (targets.length) process.stdout.write('\n');

    // 未重下的盒型也要把 tags/tid 对齐新清单
    for (const id of Object.keys(allBoxes)) {
      const cat = catalogLookup[id];
      if (cat) { allBoxes[id].tags = cat.tags || allBoxes[id].tags; allBoxes[id].tid = cat.tid; }
    }
  } else {
    log('（--dry-run：不抓取、不写文件）');
  }

  /* --- 5) 落盘 --- */
  const geomIds = Object.keys(allBoxes);
  const noGeom = catalog.filter((c) => !allBoxes[c.id]).map((c) => c.id);

  const report = {
    at: new Date().toISOString(),
    libRefreshed: REFRESH_LIB,
    force: FORCE,
    catalog: catalog.length,
    geometry: geomIds.length,
    noGeometry: noGeom,
    added: added,
    removed: removed,
    metaChanged: tagsChanged,
    fetched: ok,
    failed: failed,
    rejected: rejected,
    seconds: Math.round((Date.now() - t0) / 1000),
  };

  if (!DRY) {
    const output = { categories: categories, catalog: catalog, boxes: allBoxes };
    const jsonStr = JSON.stringify(output);
    fs.writeFileSync(path.join(ROOT, 'packmage_data.js'),
      '// Packmage Box Library Data - ' + geomIds.length + ' boxes\n' +
      '// Auto-generated from online.packmage.cn API\n\n' +
      'var PackmageData = ' + jsonStr + ';\n');
    fs.writeFileSync(path.join(ROOT, '_sync_report.json'), JSON.stringify(report, null, 2) + '\n');
    log('已写入 packmage_data.js (' + (jsonStr.length / 1048576).toFixed(1) + ' MB)');
    log('已写入 _sync_report.json');
  }

  log('');
  log('清单 ' + catalog.length + ' | 几何 ' + geomIds.length + ' | 新增 ' + added.length
    + ' | 消失 ' + removed.length + ' | 抓取成功 ' + ok
    + (rejected.length ? ' | 上游无数据 ' + rejected.length : '')
    + (failed.length ? ' | 失败 ' + failed.length : '')
    + ' | 耗时 ' + report.seconds + 's');
  if (noGeom.length) log('ℹ 清单里有但无几何（上游未提供，站点显示占位）: ' + noGeom.join(', '));
  if (failed.length) log('⚠ 抓取失败（下次同步自动重试）: ' + failed.join(', '));

  /* --- 6) 退出码 --- */
  // 判定「上游不可达」必须看**真实抓取失败**，不能看 ok===0：
  // 若本次唯一待抓的就是 Q002 这种上游确认无数据的盒型（rejected），ok 天然是 0，但那不是故障。
  if (!DRY && failed.length > 0 && ok === 0) {
    console.error('❌ 需要抓取 ' + targets.length + ' 个盒型，' + failed.length + ' 个失败且无一成功，判定为上游不可达');
    process.exit(1);
  }
  if (!DRY && failed.length > 0) {
    console.error('⚠ 有 ' + failed.length + ' 个盒型抓取失败，已跳过（下次同步会自动重试）');
    if (STRICT) process.exit(2);
  }
}

main().catch((e) => { console.error('Fatal:', e.message); process.exit(1); });
