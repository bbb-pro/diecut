/*
 * config.js - DieCut Designer API configuration
 *
 * Automatically detects environment:
 *   - localhost / 127.0.0.1  ->  uses Node.js proxy (server.js at /api/box)
 *   - GitHub Pages / other    ->  uses Cloudflare Worker proxy
 *
 * DEPLOYMENT INSTRUCTIONS:
 *   1. Deploy worker.js to Cloudflare Workers
 *      (dash.cloudflare.com -> Workers & Pages -> Create Worker)
 *   2. Copy the Worker URL (e.g. https://diecut-api.abc123.workers.dev)
 *   3. Replace the URL below in PRODUCTION_API_URL
 */

var DiecutConfig = (function () {
  var host = location.hostname;

  // Local development - server.js handles /api/box
  var isLocal = host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0';

  // === Replace this with your Cloudflare Worker URL ===
  var PRODUCTION_API_URL = 'https://diecut-api.baoshenfei.workers.dev/api/box';
  // ===================================================

  return {
    isLocal: isLocal,
    apiBase: isLocal ? '/api/box' : PRODUCTION_API_URL,
  };
})();
