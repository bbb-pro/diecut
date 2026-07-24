/*
 * server.js — Node.js server for DieCut Designer
 * Serves static files + proxies packmage API for parametric box geometry
 *
 * Features:
 * - Request queue with minimum delay between API calls (prevents rate limiting)
 * - Auto-retry when API returns encrypted "code" instead of data
 * - User-Agent header for better API compatibility
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const querystring = require('querystring');

const PORT = 8093;
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/* ===== API Request Queue =====
 * packmage.cn rate-limits rapid successive requests by returning an encrypted
 * "code" field instead of actual geometry data. We serialize requests with a
 * minimum delay to avoid triggering this behavior.
 */
const MIN_API_INTERVAL = 1200; // ms between consecutive API calls
const MAX_RETRIES = 2;         // retry on rate-limited response
const RETRY_DELAY = 1500;      // ms to wait before retry
let _lastApiTime = 0;
let _pendingQueue = [];

function processQueue() {
  if (_pendingQueue.length === 0) return;
  var now = Date.now();
  var elapsed = now - _lastApiTime;
  var wait = Math.max(0, MIN_API_INTERVAL - elapsed);

  setTimeout(function() {
    var item = _pendingQueue.shift();
    _lastApiTime = Date.now();
    item.fn(function() {
      processQueue();
    });
  }, wait);
}

function enqueueApiCall(fn) {
  return new Promise(function(resolve, reject) {
    _pendingQueue.push({ fn: function(next) {
      fn(resolve, reject).then(function() {
        // schedule next queued item
        if (_pendingQueue.length > 0) {
          setTimeout(processQueue, MIN_API_INTERVAL);
        }
      }).catch(function() {
        if (_pendingQueue.length > 0) {
          setTimeout(processQueue, MIN_API_INTERVAL);
        }
      });
    }});
    if (_pendingQueue.length === 1) {
      processQueue();
    }
  });
}

/* ===== Static file server ===== */
function serveStatic(req, res) {
  let url = req.url.split('?')[0];
  if (url === '/') url = '/index.html';

  const filePath = path.join(ROOT, url);
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not Found: ' + url);
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0'
    };
    res.writeHead(200, headers);
    res.end(data);
  });
}

/* ===== Packmage API proxy with retry ===== */
function callPackmageAPI(params, attempt) {
  attempt = attempt || 0;
  return new Promise(function(resolve, reject) {
    var postData = querystring.stringify({
      boxID: params.boxID,
      inPms: params.inPms || '',
      getBox3D: 'true',
      getFullPmsDesc: 'true',
      getRemark: 'true',
      tran: params.tran || '0'
    });

    var options = {
      hostname: 'online.packmage.cn',
      path: '/Online/GetBoxData',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
        'Referer': 'https://online.packmage.cn/Online/Design/' + (params.boxID || ''),
        'Origin': 'https://online.packmage.cn',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      }
    };

    var proxyReq = https.request(options, function(proxyRes) {
      var data = '';
      proxyRes.on('data', function(chunk) { data += chunk; });
      proxyRes.on('end', function() {
        try {
          var json = JSON.parse(data);

          // Check if API returned actual data (not rate-limited)
          if (json.success && json.Data) {
            var inner = typeof json.Data === 'string' ? JSON.parse(json.Data) : json.Data;
            var d = typeof inner.data === 'string' ? JSON.parse(inner.data) : inner.data;
            var cadData = typeof inner.cadData === 'string' ? JSON.parse(inner.cadData) : inner.cadData;

            resolve({
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
                  face: d.de.Face || null
                }
              }
            });
          } else if (json.success && json.code && attempt < MAX_RETRIES) {
            // Rate limited — API returned encrypted code instead of data
            console.log('[PACKMAGE] Rate-limited (code returned), retry ' + (attempt + 1) + '/' + MAX_RETRIES + ' for ' + params.boxID);
            setTimeout(function() {
              callPackmageAPI(params, attempt + 1).then(resolve, reject);
            }, RETRY_DELAY);
          } else if (json.success && json.code) {
            // Exhausted retries
            console.log('[PACKMAGE] Rate-limited after ' + MAX_RETRIES + ' retries for ' + params.boxID);
            resolve({ success: false, error: 'API rate limited. Please try again in a moment.' });
          } else {
            resolve({ success: false, error: 'API returned failure' });
          }
        } catch (e) {
          console.error('[PACKMAGE] Parse error:', e.message);
          resolve({ success: false, error: 'Parse error: ' + e.message });
        }
      });
    });

    proxyReq.on('error', function(e) {
      console.error('[PACKMAGE] Request error:', e.message);
      resolve({ success: false, error: 'Proxy error: ' + e.message });
    });

    proxyReq.setTimeout(20000, function() {
      proxyReq.destroy();
      console.error('[PACKMAGE] Timeout for ' + params.boxID);
      resolve({ success: false, error: 'Timeout' });
    });

    proxyReq.write(postData);
    proxyReq.end();
  });
}

/* ===== HTTP server ===== */
const server = http.createServer(function(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  var url = req.url.split('?')[0];

  if (url === '/api/box' && req.method === 'POST') {
    let body = '';
    req.on('data', function(chunk) { body += chunk; });
    req.on('end', function() {
      try {
        var params = JSON.parse(body);
        console.log('[API] POST /api/box boxID=' + params.boxID + ' inPms=' + (params.inPms || ''));
        enqueueApiCall(function(resolve, reject) {
          return callPackmageAPI(params).then(function(result) {
            console.log('[API] Response: success=' + result.success + (result.box ? ' de.w=' + result.box.de.w : ' error=' + result.error));
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(result));
            resolve();
          }).catch(function(err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: err.message }));
            resolve();
          });
        });
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON' }));
      }
    });
  } else if (url === '/api/box' && req.method === 'GET') {
    var params = querystring.parse(req.url.split('?')[1] || '');
    enqueueApiCall(function(resolve, reject) {
      return callPackmageAPI(params).then(function(result) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(result));
        resolve();
      }).catch(function(err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
        resolve();
      });
    });
  } else {
    serveStatic(req, res);
  }
});

server.listen(PORT, function() {
  console.log('DieCut Designer server running at http://localhost:' + PORT);
  console.log('API proxy: POST /api/box { boxID, inPms }');
  console.log('Rate limit: ' + MIN_API_INTERVAL + 'ms between calls, ' + MAX_RETRIES + ' retries');
});
