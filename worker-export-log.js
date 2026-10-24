/*
 * worker-export-log.js — 独立 Worker：刀模导出事件通知 + 每日导出日报
 *
 * 与 diecut-api 完全独立（新建 Worker + 精确路由 /api/export-log），
 * 不动原 worker.js / 不影响 /api/* -> diecut-api。
 *
 * 功能：
 *   A) 实时通知（前端 assets/export.js 每次导出 navigator.sendBeacon）
 *      1) 写入 KV（diecut-export-log）留痕：每条导出事件一条记录 + 累计计数
 *      2) 通过 Mailchannels(send_email 绑定) 发邮件通知到站长邮箱
 *
 *   B) 每日日报（Cloudflare Cron 定时触发，UTC 00:00 = 北京时间 08:00）
 *      统计「前一天」的导出数据并汇总成日报邮件发到站长邮箱：
 *      总次数 / 独立 IP 数 / 格式分布 / 热门盒型 Top10 / 全时段分布
 *
 * 部署：node deploy-export-worker.mjs （不走 pre-push 自动部署）
 */

const TARGET_EMAIL = 'baoshenfei@qq.com';
const FROM_EMAIL = 'noreply@057300.xyz';

// 日报统计口径用的时区偏移（北京时间 UTC+8）
const TZ_OFFSET_MIN = 8 * 60;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

/* ==================== 时间工具（全部按北京时间口径） ==================== */

/** 时间戳 → 北京时间的 YYYY-MM-DD */
function bjDateKey(ts) {
  return new Date(ts + TZ_OFFSET_MIN * 60 * 1000).toISOString().slice(0, 10);
}

/** 时间戳 → 北京时间的 HH:MM */
function bjTimeHM(ts) {
  return new Date(ts + TZ_OFFSET_MIN * 60 * 1000).toISOString().slice(11, 16);
}

/** 北京日期字符串 → 该日 [00:00, 次日00:00) 的毫秒区间 */
function bjDayRange(dateKey) {
  const start = Date.parse(dateKey + 'T00:00:00Z') - TZ_OFFSET_MIN * 60 * 1000;
  return { start, end: start + 24 * 3600 * 1000 };
}

/** 北京日期字符串 → 前一天的日期字符串 */
function prevDateKey(dateKey) {
  const { start } = bjDayRange(dateKey);
  return bjDateKey(start - 24 * 3600 * 1000);
}

/* ==================== KV 取数 ==================== */

/** 解析 exp:<ts>:<boxId> 形式的键 */
function parseExpKey(key) {
  if (!key.startsWith('exp:')) return null;
  const rest = key.slice(4);
  const i = rest.indexOf(':');
  if (i < 0) return null;
  const ts = Number(rest.slice(0, i));
  if (!Number.isFinite(ts) || ts <= 0) return null;
  return { ts, boxId: rest.slice(i + 1) };
}

/** 列出全部 exp:* 键（分页游标） */
async function listExpKeys(kv) {
  const out = [];
  let cursor = null;
  do {
    const opts = { prefix: 'exp:', limit: 1000 };
    if (cursor) opts.cursor = cursor;
    const res = await kv.list(opts);
    for (const k of res.keys || []) out.push(k.name);
    cursor = res.list_complete ? null : res.cursor;
  } while (cursor);
  return out;
}

/**
 * 一次扫描 KV，按北京日期分组返回若干天的汇总。
 * 只对命中目标区间的键做 get() 取明细，避免无谓读放大。
 *
 * @param kv       KV namespace
 * @param dateKeys 需要汇总的北京日期数组（按时间先后）
 */
async function summarizeDays(kv, dateKeys) {
  const want = new Map();
  for (const dk of dateKeys) {
    const { start, end } = bjDayRange(dk);
    want.set(dk, { dateKey: dk, start, end, total: 0, byType: {}, byBox: {}, byHour: {}, ips: new Set(), items: [] });
  }

  const keys = await listExpKeys(kv);

  // 先按时间戳把键分到各天，避免重复 get
  const buckets = new Map();
  for (const key of keys) {
    const meta = parseExpKey(key);
    if (!meta) continue;
    const dk = bjDateKey(meta.ts);
    if (!want.has(dk)) continue;
    if (!buckets.has(dk)) buckets.set(dk, []);
    buckets.get(dk).push({ key, ts: meta.ts, keyBoxId: meta.boxId });
  }

  // 逐天读明细并累加
  for (const [dk, list] of buckets) {
    const agg = want.get(dk);
    for (const it of list) {
      let rec = {};
      try {
        rec = JSON.parse((await kv.get(it.key)) || '{}');
      } catch (e) {
        rec = {};
      }
      const boxId = rec.boxId || it.keyBoxId || 'unknown';
      const type = rec.type || 'unknown';
      const ip = rec.ip || '';

      agg.total++;
      agg.byType[type] = (agg.byType[type] || 0) + 1;
      agg.byBox[boxId] = (agg.byBox[boxId] || 0) + 1;
      const h = bjTimeHM(it.ts).slice(0, 2);
      agg.byHour[h] = (agg.byHour[h] || 0) + 1;
      if (ip) agg.ips.add(ip);
      agg.items.push({ ts: it.ts, boxId, type, ip, ua: rec.ua || '' });
    }
  }

  const out = {};
  for (const dk of dateKeys) out[dk] = want.get(dk);
  return out;
}

/** 读取累计总数 */
async function readTotal(kv) {
  const c = await kv.get('count');
  return parseInt(c || '0', 10) || 0;
}

/* ==================== 日报文本 ==================== */

/** 生成日报正文（纯文本） */
function buildDailyText(day, totalAll, prevTotal) {
  const L = [];
  const d = day.dateKey;

  L.push('刀模导出日报');
  L.push('日期：' + d + '（北京时间 00:00-24:00）');
  L.push('');
  L.push('【总览】');
  L.push('  昨日导出次数：' + day.total + ' 次');
  L.push('  独立访客 IP ：' + day.ips.size + ' 个');
  L.push('  累计导出总数：' + totalAll + ' 次');
  if (prevTotal > 0) {
    const delta = day.total - prevTotal;
    L.push('  较前一日     ：' + (delta >= 0 ? '+' : '') + delta + ' 次');
  }
  L.push('');

  // 格式分布
  const typeEntries = Object.entries(day.byType).sort((a, b) => b[1] - a[1]);
  L.push('【导出格式分布】');
  if (!typeEntries.length) {
    L.push('  （无）');
  } else {
    for (const [t, n] of typeEntries) {
      const pct = day.total ? ((n / day.total) * 100).toFixed(1) : '0.0';
      L.push('  ' + String(t).padEnd(6) + ' ' + String(n).padStart(4) + ' 次   ' + pct.padStart(5) + '%');
    }
  }
  L.push('');

  // 热门盒型
  const boxEntries = Object.entries(day.byBox).sort((a, b) => b[1] - a[1]);
  L.push('【热门盒型 Top 10】');
  if (!boxEntries.length) {
    L.push('  （无）');
  } else {
    boxEntries.slice(0, 10).forEach(([b, n], i) => {
      L.push('  ' + String(i + 1).padStart(2) + '. ' + String(b).padEnd(9) + ' ' + String(n).padStart(4) + ' 次');
    });
    if (boxEntries.length > 10) {
      L.push('  （另有 ' + (boxEntries.length - 10) + ' 个盒型各出现 1 次）');
    }
  }
  L.push('');

  // 时段分布
  L.push('【时段分布（北京时间）】');
  if (!day.total) {
    L.push('  （无）');
  } else {
    for (let h = 0; h < 24; h++) {
      const k = String(h).padStart(2, '0');
      const n = day.byHour[k] || 0;
      if (!n) continue;
      const bar = '█'.repeat(Math.max(1, Math.round((n / day.total) * 40)));
      L.push('  ' + k + ':00  ' + String(n).padStart(3) + '  ' + bar);
    }
  }
  L.push('');

  // 明细（最多 30 条）
  L.push('【导出明细（最多显示 30 条，按时间正序）】');
  if (!day.items.length) {
    L.push('  （昨日无导出记录）');
  } else {
    const show = day.items.slice().sort((a, b) => a.ts - b.ts).slice(-30);
    for (const it of show) {
      L.push('  ' + bjTimeHM(it.ts) + '  ' + String(it.boxId).padEnd(9) + ' ' + String(it.type).padEnd(5) + ' ' + (it.ip || '-'));
    }
    if (day.items.length > 30) {
      L.push('  （共 ' + day.items.length + ' 条，仅显示最近 30 条）');
    }
  }
  L.push('');
  L.push('—— 由刀模站自动生成');

  return L.join('\n');
}

/**
 * 统计并发送日报。
 * @param dateKey 要统计的北京日期；不传则默认「昨天」
 */
async function sendDailyReport(env, ctx, dateKey) {
  const kv = env.EXPORT_LOG;
  if (!kv) return { ok: false, error: 'no KV binding' };

  const target = dateKey || bjDateKey(Date.now() - 24 * 3600 * 1000);
  const prev = prevDateKey(target);

  // 一次扫描同时算出当天与前一天（环比）
  const days = await summarizeDays(kv, [target, prev]);
  const day = days[target];
  const prevTotal = days[prev] ? days[prev].total : 0;
  const totalAll = await readTotal(kv);

  const text = buildDailyText(day, totalAll, prevTotal);
  const subject = '刀模导出日报 · ' + target + ' · ' + day.total + ' 次';

  if (!env.MAILCHANNELS) {
    return { ok: false, error: 'no MAILCHANNELS binding', date: target, total: day.total, text };
  }

  try {
    await env.MAILCHANNELS.send({ from: FROM_EMAIL, to: TARGET_EMAIL, subject, text });
    return { ok: true, date: target, total: day.total, text };
  } catch (e) {
    console.error('Daily email failed:', (e && e.message) || e);
    return { ok: false, error: (e && e.message) || String(e), date: target, total: day.total, text };
  }
}

/* ==================== Worker 入口 ==================== */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 手动预览日报（只返回文本，不发邮件）：GET /api/export-log?daily=1[&date=YYYY-MM-DD]
    if (request.method === 'GET' && url.searchParams.get('daily')) {
      const kv = env.EXPORT_LOG;
      if (!kv) return new Response('no KV binding', { status: 500, headers: CORS });
      const target = url.searchParams.get('date') || bjDateKey(Date.now() - 24 * 3600 * 1000);
      const prev = prevDateKey(target);
      const days = await summarizeDays(kv, [target, prev]);
      const totalAll = await readTotal(kv);
      const text = buildDailyText(days[target], totalAll, days[prev] ? days[prev].total : 0);
      return new Response(text, {
        status: 200,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', ...CORS },
      });
    }

    // 手动补发日报（真正发邮件）：GET /api/export-log?daily-send=1&date=YYYY-MM-DD
    // 需要带 token 参数（REPORT_TOKEN），防止被他人任意触发发信
    if (request.method === 'GET' && url.searchParams.get('daily-send')) {
      const token = url.searchParams.get('token') || '';
      if (!env.REPORT_TOKEN || token !== env.REPORT_TOKEN) {
        return new Response('Forbidden', { status: 403, headers: CORS });
      }
      const target = url.searchParams.get('date') || null;
      const r = await sendDailyReport(env, ctx, target);
      return new Response(
        JSON.stringify({ ok: r.ok, date: r.date, total: r.total, error: r.error || null }, null, 2),
        { status: r.ok ? 200 : 500, headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS } }
      );
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 200, headers: CORS });
    }
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405, headers: CORS });
    }

    // 解析 beacon 负载（sendBeacon 默认 text/plain 或 application/json）
    let data = {};
    try {
      const raw = await request.text();
      if (raw) data = JSON.parse(raw);
    } catch (e) { /* 忽略坏负载 */ }

    const boxId = data.boxId || data.box || 'unknown';
    const type = data.type || 'unknown';
    const ts = Date.now();
    const when = new Date(ts).toISOString();
    const ua = request.headers.get('user-agent') || '';
    const ip = request.headers.get('cf-connecting-ip') || '';

    // 1) KV 留痕（务必成功，catch 兜底）
    try {
      if (env.EXPORT_LOG) {
        const key = 'exp:' + ts + ':' + String(boxId).replace(/[^a-zA-Z0-9_-]/g, '_');
        await env.EXPORT_LOG.put(key, JSON.stringify({ boxId, type, ts, when, ua, ip }));
        const c = await env.EXPORT_LOG.get('count');
        const n = (parseInt(c || '0', 10) || 0) + 1;
        await env.EXPORT_LOG.put('count', String(n));
      }
    } catch (e) {
      console.error('KV write failed:', e.message);
    }

    // 2) 邮件通知（后台异步发送，失败只记日志，不影响记录与响应）
    try {
      if (env.MAILCHANNELS) {
        const mailPromise = env.MAILCHANNELS.send({
          from: FROM_EMAIL,
          to: TARGET_EMAIL,
          subject: `刀模导出通知 · ${boxId} · ${type}`,
          text:
            `有人导出了刀模文件。\n` +
            `盒型: ${boxId}\n` +
            `格式: ${type}\n` +
            `时间: ${when}\n` +
            `IP:   ${ip}\n` +
            `UA:   ${ua}\n`,
        });
        if (ctx && typeof ctx.waitUntil === 'function') {
          ctx.waitUntil(mailPromise.catch((e) => console.error('Email failed:', (e && e.message) || e)));
        } else {
          await mailPromise.catch((e) => console.error('Email failed:', (e && e.message) || e));
        }
      }
    } catch (e) {
      console.error('Email setup failed:', (e && e.message) || e);
    }

    return new Response('ok', { status: 200, headers: CORS });
  },

  /**
   * Cron 定时入口：每天 UTC 00:00（北京时间 08:00）触发，
   * 统计前一天（北京时间）的导出数据并发日报邮件。
   */
  async scheduled(event, env, ctx) {
    console.log('scheduled fired at', new Date().toISOString(), 'cron=', event && event.cron);
    try {
      const r = await sendDailyReport(env, ctx, null);
      console.log('daily report result:', JSON.stringify({ ok: r.ok, date: r.date, total: r.total, error: r.error }));
    } catch (e) {
      console.error('daily report failed:', (e && e.stack) || e);
    }
  },
};
