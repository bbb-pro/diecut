/*
 * worker.js - Cloudflare Worker for DieCut Designer API proxy
 *
 * Deploys to Cloudflare Workers to proxy packmage.cn API requests.
 * This solves the CORS problem when hosting on GitHub Pages.
 *
 * Deploy（⛔ 不要再手贴 Dashboard）:
 *   - 推送自动部署：git push 时 .git/hooks/pre-push 检测到本文件变更 → 自动调
 *     ~/.workbuddy/skills/cloudflare-worker-deploy/deploy.mjs 用 API Token 直传
 *   - 手动部署：node tools/hooks/pre-push.mjs --force
 *   - Worker 名 diecut-api，路由 057300.xyz/api/* 已存在；上传后立即生效
 *
 * Free tier: 100,000 requests/day (plenty for this app)
 */

const PACKMAGE_HOST = 'online.packmage.cn';
const PACKMAGE_PATH = '/Online/GetBoxData';
const MAX_RETRIES = 2;
const RETRY_DELAY = 1500; // ms

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

/**
 * 上游 cadData.PmItems → 站内参数表格式 {n, d, v, l, dl}。
 *
 * ❗ 必须规范化后再返回：上游字段是 Name / DefaultV / Layer / DownList，
 * 而详情页按 n / v / l / dl 读取。直接把 PmItems 丢过去，前端映射出的每项
 * 都是 {n: undefined} —— 首屏用的是内嵌数据看着正常，一旦重求解把 G.p 换成
 * 这份坏数据，**之后改任何参数都传不回上游**（实测踩到：改 d2 只在第一次生效）。
 * 值优先取 ce（上游按当前尺寸回传的实际值），取不到才用 DefaultV。
 */
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
      o.dl = Object.entries(it.DownList)
        .map(([k, val]) => ({ v: String(k).replace(/^_/, '').trim(), t: String(val).trim() }))
        .sort((a, b) => (parseFloat(a.v) || 0) - (parseFloat(b.v) || 0));
    }
    return o;
  });
}

export default {
  async fetch(request, env, ctx) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // Only allow POST to /api/box
    const url = new URL(request.url);
    if (url.pathname === '/api/box' && request.method === 'POST') {
      return handleBoxRequest(request, ctx);
    }

    // 按自定义尺寸现算 3D 折叠树
    if (url.pathname === '/api/box3d' && request.method === 'POST') {
      return handleBox3DRequest(request);
    }

    // Health check
    if (url.pathname === '/' || url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok', service: 'diecut-api-proxy' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      });
    }

    return new Response('Not Found', { status: 404, headers: CORS_HEADERS });
  }
};

async function handleBoxRequest(request, ctx) {
  try {
    const params = await request.json();

    if (!params.boxID) {
      return jsonResponse({ success: false, error: 'Missing boxID' }, 400);
    }

    const result = await callPackmageAPI(params, 0, ctx);

    return jsonResponse(result, 200);
  } catch (e) {
    return jsonResponse({ success: false, error: 'Server error: ' + e.message }, 500);
  }
}

async function handleBox3DRequest(request) {
  try {
    const params = await request.json();
    if (!params.boxID) {
      return jsonResponse({ success: false, error: 'Missing boxID' }, 400);
    }
    return await callPackmageLin3D(params);
  } catch (e) {
    return jsonResponse({ success: false, error: 'Server error: ' + e.message }, 500);
  }
}

function jsonResponse(data, status) {
  return new Response(JSON.stringify(data), {
    status: status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS },
  });
}

async function callPackmageAPI(params, attempt, ctx) {
  // Build form-encoded body (same as server.js)
  const formData = new URLSearchParams();
  formData.append('boxID', params.boxID);
  formData.append('inPms', params.inPms || '');
  formData.append('getBox3D', 'true');
  formData.append('getFullPmsDesc', 'true');
  formData.append('getRemark', 'true');
  formData.append('tran', params.tran || '0');

  const response = await fetch(`https://${PACKMAGE_HOST}${PACKMAGE_PATH}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Referer': `https://${PACKMAGE_HOST}/Online/Design/${params.boxID || ''}`,
      'Origin': `https://${PACKMAGE_HOST}`,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
    body: formData.toString(),
  });

  if (!response.ok) {
    return { success: false, error: `HTTP ${response.status} from packmage` };
  }

  const json = await response.json();

  // Check if API returned actual data (not rate-limited)
  if (json.success && json.Data) {
    // Parse nested JSON (packmage wraps data in multiple layers)
    let inner = typeof json.Data === 'string' ? JSON.parse(json.Data) : json.Data;
    let d = typeof inner.data === 'string' ? JSON.parse(inner.data) : inner.data;
    let cadData = typeof inner.cadData === 'string' ? JSON.parse(inner.cadData) : inner.cadData;

    return {
      success: true,
      box: {
        ce: d.ce,
        pm: normPm(cadData.PmItems, d.ce),
        /* 标注数据（尺寸线画在哪、标什么）—— 详情页改尺寸后靠它更新标注。
           原始锚点坐标，前端按 de.ox/oy 换成图面坐标 */
        rm: cadData.Remarks || [],
        fe: d.fe,
        de: {
          w: d.de.Width,
          h: d.de.Height,
          ox: d.de.OffsetX,
          oy: d.de.OffsetY,
          p: d.de.P,
          sl: d.de.SolidLength,
          dl: d.de.DashLength,
          op: d.de.OutPms,
          tran: d.de.Tran || 0,
          face: d.de.Face || null,
        }
      }
    };
  }

  // Rate limited - API returned encrypted "code" instead of data
  if (json.success && json.code) {
    if (attempt < MAX_RETRIES) {
      // Wait and retry
      await new Promise(r => setTimeout(r, RETRY_DELAY));
      return callPackmageAPI(params, attempt + 1, ctx);
    }
    return { success: false, error: 'API rate limited. Please try again in a moment.' };
  }

  return { success: false, error: 'API returned failure' };
}

/* ===== LinTest3D 代理：按给定尺寸现算 3D 折叠树 =====
 * 详情页改过尺寸后，3D 必须让官方按新参数重算 —— 抽样 24 盒发现约 1/5 的盒型
 * 折角会随尺寸变化，不能靠按比例缩放几何糊过去。
 * ❗响应**原样透传**上游文本：Worker 免费版每请求只有 10ms CPU，大盒型的
 *   Box3D 能到上兆，parse 再 stringify 会顶到上限。解析交给浏览器做。
 */
async function callPackmageLin3D(params) {
  const r = await fetch(`https://${PACKMAGE_HOST}/uc/LinTest3D`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json;charset=UTF-8',
      'Accept': 'application/json, text/javascript, */*; q=0.01',
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': `https://${PACKMAGE_HOST}/Online/Design/${params.boxID || ''}`,
      'Origin': `https://${PACKMAGE_HOST}`,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
    body: JSON.stringify({
      boxid: params.boxID,
      boxPms: params.inPms || 'CHOOSE=3',
      getBoxJson: 1,
      getLineExp: 1,
    }),
  });

  const headers = { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS };
  if (!r.ok) {
    return new Response(JSON.stringify({ success: false, error: `HTTP ${r.status} from packmage` }), { status: 502, headers });
  }
  const txt = await r.text();
  if (txt.trim().charAt(0) !== '{') {
    return new Response(JSON.stringify({ success: false, error: '上游返回异常' }), { status: 502, headers });
  }
  return new Response(txt, { status: 200, headers });
}
