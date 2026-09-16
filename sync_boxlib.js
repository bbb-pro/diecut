#!/usr/bin/env node
/*
 * sync_boxlib.js — 一键同步 packmage 盒型库（本地 / GitHub Actions 共用同一条链路）
 *
 * 用法：
 *   node sync_boxlib.js                    # 月度同步：刷新清单 → 补几何 → 编译前端数据 → 生成 SEO 页 → 抓缩略图
 *   node sync_boxlib.js --force            # 几何全量重下（慢，约 1294 次请求）
 *   node sync_boxlib.js --skip-thumbs      # 跳过缩略图（本地网络慢时用）
 *   node sync_boxlib.js --skip-geo         # 只刷新清单，不抓几何
 *   node sync_boxlib.js --only=thumbs      # 只跑某一步（lib|build|pages|thumbs）
 *
 * 链路（每一步都能单独重跑、幂等）：
 *   1. download_all_boxes.js --refresh-lib   上游清单 + 缺失几何 → packmage_boxlib_zh.js / packmage_data.js
 *   2. build_v2.js                           → data/catalog.js + data/geo/NN.js
 *   3. build_box_pages.js                    → box/<ID>/index.html ×N + box/index.html + sitemap.xml
 *   4. tools/fetch_thumbs.py                 → data/thumbs/{id}-M.png（只补缺）
 *
 * 说明：产物必须进仓库（静态站点直接读），所以本脚本不负责 commit/push，
 *       推送由 .github/workflows/sync-boxlib.yml 或人工完成。
 *       缩略图排在最后：缺图只是回退到上游图/矢量兜底，不该拖累 SEO 页生成。
 */

'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const onlyArg = (argv.find((a) => a.startsWith('--only=')) || '').split('=')[1];

const IS_WIN = process.platform === 'win32';
const NODE = process.execPath;
const PY = process.env.PYTHON || (IS_WIN ? 'python' : 'python3');

const STEPS = [
  { key: 'lib',    name: '① 同步清单 + 几何', script: [NODE, ['download_all_boxes.js', '--refresh-lib'].concat(has('--force') ? ['--force'] : [])] },
  { key: 'build',  name: '② 编译前端数据',   script: [NODE, ['build_v2.js']] },
  { key: 'pages',  name: '③ 生成 SEO 落地页', script: [NODE, ['build_box_pages.js']] },
  { key: 'thumbs', name: '④ 抓立体缩略图',   script: [PY,   ['tools/fetch_thumbs.py', '--allow-missing']] },
];

function run(step) {
  const [cmd, args] = step.script;
  console.log('\n' + '─'.repeat(58));
  console.log('  ' + step.name);
  console.log('─'.repeat(58));
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit' });
  if (r.error) {
    console.error('  ✗ 无法执行 ' + step.name + ': ' + r.error.message);
    if (cmd === PY) console.error('    提示：需要 Python 3（可用环境变量 PYTHON 指定解释器）');
    return { ok: false, code: -1 };
  }
  return { ok: r.status === 0, code: r.status === 0 ? 0 : r.status };
}

function main() {
  const t0 = Date.now();
  const todo = STEPS.filter((s) => {
    if (onlyArg) return s.key === onlyArg;
    if (has('--skip-geo') && s.key === 'lib') return false;
    if (has('--skip-thumbs') && s.key === 'thumbs') return false;
    return true;
  });

  if (!todo.length) {
    console.error('没有可执行的步骤（检查 --only / --skip-* 参数）');
    process.exit(1);
  }

  // 前置：确认输入文件在
  if (todo.some((s) => s.key !== 'lib') && !fs.existsSync(path.join(ROOT, 'packmage_data.js'))) {
    console.error('缺少 packmage_data.js，无法继续（先跑 download_all_boxes.js）');
    process.exit(1);
  }

  const results = [];
  for (const step of todo) {
    const r = run(step);
    results.push({ step: step.name, code: r.code });
    if (!r.ok) {
      console.error('\n✗ ' + step.name + ' 失败（退出码 ' + r.code + '），中止后续步骤');
      summarize(results, t0, false);
      process.exit(1);
    }
  }
  summarize(results, t0, true);
}

function summarize(results, t0, allOk) {
  let report = null;
  try { report = JSON.parse(fs.readFileSync(path.join(ROOT, '_sync_report.json'), 'utf8')); } catch (e) { /* ignore */ }

  console.log('\n' + '='.repeat(58));
  console.log(allOk ? '✓ 同步完成' : '✗ 同步中断');
  results.forEach((r) => console.log('   ' + (r.code === 0 ? '✓' : '✗') + ' ' + r.step + (r.code === 0 ? '' : ' (code ' + r.code + ')')));
  if (report) {
    console.log('   —— 清单 ' + report.catalog + ' 个盒型 / 几何 ' + report.geometry
      + ' 个 / 新增 ' + report.added.length + ' / 消失 ' + report.removed.length
      + ' / 本次抓取 ' + report.fetched
      + ((report.rejected || []).length ? ' / 上游无数据 ' + report.rejected.length : '')
      + ((report.failed || []).length ? ' / 失败 ' + report.failed.length : ''));
    if (report.added.length) console.log('   新增: ' + report.added.join(', '));
    if (report.removed.length) console.log('   消失: ' + report.removed.join(', '));
  }
  console.log('   总耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
  console.log('='.repeat(58));
}

main();
