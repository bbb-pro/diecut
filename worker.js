/*
 * worker.js - Cloudflare Worker for DieCut Designer API proxy
 *
 * Deploys to Cloudflare Workers to proxy packmage.cn API requests.
 * This solves the CORS problem when hosting on GitHub Pages.
 *
 * Deploy:
 *   1. Go to https://dash.cloudflare.com -> Workers & Pages
 *   2. Create Worker (name it "diecut-api")
 *   3. Paste this entire file into the editor
 *   4. Click "Deploy"
 *   5. Copy the Worker URL (e.g. https://diecut-api.<subdomain>.workers.dev)
 *   6. Update config.js with this URL
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
        pm: cadData.PmItems || [],
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
