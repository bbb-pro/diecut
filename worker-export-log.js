/*
 * worker-export-log.js — 独立 Worker：刀模导出事件通知
 *
 * 与 diecut-api 完全独立（新建 Worker + 精确路由 /api/export-log），
 * 不动原 worker.js / 不影响 /api/* -> diecut-api。
 *
 * 功能：
 *   前端 assets/export.js 在每次导出时 navigator.sendBeacon('/api/export-log', JSON)
 *   本 Worker：
 *     1) 写入 KV（diecut-export-log）留痕：每条导出事件一条记录 + 累计计数
 *     2) 通过 Mailchannels(send_email 绑定) 发邮件通知到站长邮箱
 *
 * 部署：node _deploy_export_worker.mjs （不走 pre-push 自动部署）
 */

const TARGET_EMAIL = 'baoshenfei@qq.com';
const FROM_EMAIL = 'noreply@057300.xyz';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env, ctx) {
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
          subject: `[Packmage] 刀模导出通知 · ${boxId} · ${type}`,
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
};
