#!/usr/bin/env node
/*
 * 查看刀模导出通知记录（diecut-export-log Worker 写入的 KV）。
 * 与 deploy-export-worker.mjs 共用同一套 CF 凭证与 KV namespace。
 *
 * 用法：
 *   node tools/export-log-viewer.mjs            # 累计数 + 最近 20 条
 *   node tools/export-log-viewer.mjs 50         # 累计数 + 最近 50 条
 *   node tools/export-log-viewer.mjs all        # 列出全部（最多 1000 条）
 *   node tools/export-log-viewer.mjs daily      # 昨日日报（北京时间口径，预览不发信）
 *   node tools/export-log-viewer.mjs daily 2026-10-23   # 指定日期的日报
 *   node tools/export-log-viewer.mjs send [日期]          # 补发日报邮件（需 CF_REPORT_TOKEN）
 *
 * 输出：
 *   - 累计导出总数（来自 KV 'count' 键）
 *   - 最近 N 条明细（盒型 / 格式 / 时间 / IP / UA）
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
const NS = '4a4732ce93284e20b9e2a991247deaeb'; // diecut-export-log KV namespace
const BASE = 'https://api.cloudflare.com/client/v4';
const H = { Authorization: 'Bearer ' + TOKEN };

function getLimit() {
  const a = process.argv[2];
  if (!a || a === 'all') return 'all';
  const n = parseInt(a, 10);
  return Number.isFinite(n) && n > 0 ? n : 20;
}

async function kvGet(key) {
  const r = await fetch(`${BASE}/accounts/${ACC}/storage/kv/namespaces/${NS}/values/${encodeURIComponent(key)}`, { headers: H });
  if (r.status === 404) return null;
  return r.text();
}

async function listKeys() {
  const out = [];
  let cursor = null;
  do {
    let u = `${BASE}/accounts/${ACC}/storage/kv/namespaces/${NS}/keys?limit=1000`;
    if (cursor) u += '&cursor=' + cursor;
    const r = await fetch(u, { headers: H });
    const b = await r.json();
    const arr = (b.result || []).map((k) => k.name);
    out.push(...arr);
    cursor = b.result_info && b.result_info.cursor;
  } while (cursor);
  return out;
}

async function main() {
  const mode = process.argv[2];

  // 日报模式：daily [日期] 预览 / send [日期] 补发
  if (mode === 'daily' || mode === 'send') {
    const arg = process.argv[3];
    const isSend = mode === 'send';
    const q = new URLSearchParams();
    if (arg) q.set('date', arg);
    if (isSend) {
      const token = env.CF_REPORT_TOKEN;
      if (!token) {
        console.error('✗ 未配置 CF_REPORT_TOKEN（~/.workbuddy/cf-worker-deploy.env），无法补发');
        process.exit(1);
      }
      q.set('daily-send', '1');
      q.set('token', token);
    } else {
      q.set('daily', '1');
    }
    const r = await fetch(`https://057300.xyz/api/export-log?${q.toString()}`);
    const text = await r.text();
    if (r.status !== 200) {
      console.error('✗ 请求失败', r.status, text.slice(0, 300));
      process.exit(1);
    }
    if (isSend) {
      console.log('✓ 已触发补发');
      console.log(text);
    } else {
      console.log(text);
    }
    return;
  }

  const limit = getLimit();

  // 1) 累计总数
  const countRaw = await kvGet('count');
  const total = parseInt(countRaw || '0', 10) || 0;

  // 2) 列出 exp:* 键并本地按时间戳降序
  const allKeys = (await listKeys()).filter((k) => k.startsWith('exp:'));
  const parsed = allKeys
    .map((k) => {
      const parts = k.split(':');
      const ts = Number(parts[1]) || 0;
      const boxId = parts.slice(2).join(':') || 'unknown';
      return { key: k, ts, boxId };
    })
    .sort((a, b) => b.ts - a.ts);

  const show = limit === 'all' ? parsed : parsed.slice(0, limit);

  // 3) 读取明细
  const rows = [];
  for (const p of show) {
    let rec = {};
    try { rec = JSON.parse((await kvGet(p.key)) || '{}'); } catch { /* 坏数据忽略 */ }
    rows.push({ ts: p.ts, boxId: rec.boxId || p.boxId, type: rec.type || '?', when: rec.when || new Date(p.ts).toISOString(), ip: rec.ip || '', ua: rec.ua || '' });
  }

  // 4) 输出
  console.log('══════════════════════════════════════════════');
  console.log(`刀模导出通知 · 累计总数：${total}`);
  console.log(`KV 内 exp:* 记录：${parsed.length} 条`);
  console.log(`本次显示：${limit === 'all' ? '全部' : limit} 条（按时间倒序）`);
  console.log('══════════════════════════════════════════════');
  if (!rows.length) {
    console.log('（暂无导出记录）');
    return;
  }
  for (const r of rows) {
    const when = (r.when || '').replace('T', ' ').replace(/\.\d+Z$/, ' UTC').replace('Z', ' UTC');
    const ua = r.ua ? r.ua.slice(0, 60) : '';
    console.log(`· ${r.boxId.padEnd(8)} | ${String(r.type).padEnd(4)} | ${when} | ${r.ip || '-'}`);
    if (ua) console.log(`    UA: ${ua}`);
  }
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
