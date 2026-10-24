#!/usr/bin/env node
/*
 * 部署独立 Worker diecut-export-log（刀模导出事件通知）。
 * 与 diecut-api 完全独立；pre-push 只部署 worker.js，本脚本手动跑。
 *
 * 步骤：
 *   1) GET 线上 settings（保留 compat_date / flags）
 *   2) 查找或创建 KV namespace 'diecut-export-log'
 *   3) PUT 脚本（worker-export-log.js）并携带 KV + send_email 两个绑定
 *   4) 查找或创建精确路由 057300.xyz/api/export-log -> diecut-export-log
 *   5) 配置 Cron 定时触发器（UTC 00:00 = 北京时间 08:00 发日报）
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ENV_FILE = path.join(os.homedir(), '.workbuddy', 'cf-worker-deploy.env');
const env = {};
fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/).forEach((l) => {
  if (/^\s*#/.test(l)) return;
  const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/.exec(l);
  if (m) env[m[1]] = m[2];
});
const TOKEN = env.CF_API_TOKEN;
const ACC = env.CF_ACCOUNT_ID || 'cba5e4540ec02cc4b90f7ea0d8077e57';
const ZONE = env.CF_ZONE_ID || '48fe0dc25465336fa22755d34f10698c';
const NAME = 'diecut-export-log';
const TARGET = 'baoshenfei@qq.com';
// 每日日报 Cron：UTC 00:00 = 北京时间 08:00
const CRON = '0 0 * * *';
const BASE = 'https://api.cloudflare.com/client/v4';
const H = { Authorization: 'Bearer ' + TOKEN };

async function api(p, opts) {
  const r = await fetch(BASE + p, Object.assign({ headers: H }, opts || {}));
  const t = await r.text();
  let b; try { b = JSON.parse(t); } catch { b = t.slice(0, 300); }
  return { status: r.status, ok: b && b.success, body: b };
}
const j = (o) => ({ 'Content-Type': 'application/json', ...H });

async function main() {
  // 1) settings
  const st = await api(`/accounts/${ACC}/workers/scripts/${NAME}/settings`);
  const old = (st.ok && st.body.result) || {};
  const compatDate = old.compatibility_date || '2026-07-24';
  const flags = old.compatibility_flags || [];
  console.log(`compat_date=${compatDate} flags=${JSON.stringify(flags)}`);

  // 2) KV namespace
  let nsId = null;
  const list = await api(`/accounts/${ACC}/storage/kv/namespaces`);
  if (list.ok) {
    const found = (list.body.result || []).find((n) => n.title === NAME);
    if (found) nsId = found.id;
  }
  if (!nsId) {
    const mk = await api(`/accounts/${ACC}/storage/kv/namespaces`, {
      method: 'POST', headers: j(), body: JSON.stringify({ title: NAME }),
    });
    if (!mk.ok) { console.error('✗ 创建 KV 失败', mk.status, JSON.stringify(mk.body).slice(0, 400)); process.exit(1); }
    nsId = mk.body.result.id;
    console.log('✓ 新建 KV namespace id=', nsId);
  } else {
    console.log('→ 复用 KV namespace id=', nsId);
  }

  // 3) PUT 脚本 + 绑定
  const code = fs.readFileSync(path.join(process.cwd(), 'worker-export-log.js'), 'utf8');
  // 手动补发日报用的 token（secret_text 绑定，Worker 侧只读不回显）
  let reportToken = env.CF_REPORT_TOKEN;
  if (!reportToken) {
    reportToken = crypto.randomUUID().replace(/-/g, '');
    console.log('→ 未配置 CF_REPORT_TOKEN，本次自动生成:', reportToken);
  }
  const bindings = [
    { type: 'kv_namespace', name: 'EXPORT_LOG', namespace_id: nsId },
    { type: 'send_email', name: 'MAILCHANNELS', destination_address: TARGET },
    { type: 'secret_text', name: 'REPORT_TOKEN', text: reportToken },
  ];
  const metadata = {
    main_module: 'worker-export-log.js',
    compatibility_date: compatDate,
    compatibility_flags: flags,
    bindings,
  };
  const fd = new FormData();
  fd.set('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  fd.set('worker-export-log.js', new Blob([code], { type: 'application/javascript+module' }), 'worker-export-log.js');
  const up = await fetch(`${BASE}/accounts/${ACC}/workers/scripts/${NAME}`, {
    method: 'PUT', headers: H, body: fd,
  });
  const ut = await up.text();
  let ub; try { ub = JSON.parse(ut); } catch { ub = ut.slice(0, 300); }
  if (!ub.success) { console.error('✗ 部署脚本失败', up.status, JSON.stringify(ub).slice(0, 800)); process.exit(1); }
  console.log('✓ 部署脚本成功，handlers=', JSON.stringify((ub.result && ub.result.handlers) || []));

  // 4) 路由（通配路径，优先于 /api/*，且兼容带 query 的访问）
  const routes = await api(`/zones/${ZONE}/workers/routes`);
  const PATTERN = '057300.xyz/api/export-log*';
  let routeId = null;
  if (routes.ok) {
    const f = (routes.body.result || []).find(
      (r) => r.script_name === NAME || r.pattern === PATTERN || r.pattern === '057300.xyz/api/export-log'
    );
    if (f) routeId = f.id;
  }
  if (!routeId) {
    const mk = await api(`/zones/${ZONE}/workers/routes`, {
      method: 'POST', headers: j(),
      body: JSON.stringify({ pattern: PATTERN, script: NAME, script_name: NAME }),
    });
    if (!mk.ok) { console.error('✗ 创建路由失败', mk.status, JSON.stringify(mk.body).slice(0, 400)); process.exit(1); }
    console.log('✓ 新建路由', PATTERN, '->', NAME);
  } else {
    // 已存在：确保 pattern 是通配（PATCH 更新）
    const cur = (routes.body.result || []).find((r) => r.id === routeId);
    if (cur && cur.pattern !== PATTERN) {
      const up = await api(`/zones/${ZONE}/workers/routes/${routeId}`, {
        method: 'PUT', headers: j(),
        body: JSON.stringify({ pattern: PATTERN, script: NAME, script_name: NAME }),
      });
      if (!up.ok) { console.error('✗ 更新路由失败', up.status, JSON.stringify(up.body).slice(0, 400)); process.exit(1); }
      console.log('✓ 更新路由为通配', PATTERN);
    } else {
      console.log('→ 路由已存在', PATTERN);
    }
  }

  // 5) Cron 定时触发器（每日北京时间 08:00 发日报）
  const cur = await api(`/accounts/${ACC}/workers/scripts/${NAME}/schedules`);
  const curCron = cur.ok && cur.body.result && cur.body.result.schedules && cur.body.result.schedules[0]
    ? cur.body.result.schedules[0].cron : null;
  if (curCron === CRON) {
    console.log('→ Cron 已配置', CRON);
  } else {
    const set = await api(`/accounts/${ACC}/workers/scripts/${NAME}/schedules`, {
      method: 'PUT', headers: j(),
      // 该端点 body 是裸数组（不是 {schedules:[...]}）
      body: JSON.stringify([{ cron: CRON }]),
    });
    if (!set.ok) { console.error('✗ 配置 Cron 失败', set.status, JSON.stringify(set.body).slice(0, 400)); process.exit(1); }
    console.log('✓ 配置 Cron', CRON, '(UTC) = 北京时间 08:00');
  }

  console.log('\n完成。Worker 立即生效。Cron 定时器已配置，每日北京时间 08:00 自动发日报。');
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
