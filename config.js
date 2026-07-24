/*
 * config.js - DieCut Designer API configuration
 *
 * Both local and production use the relative path "/api/box":
 *   - Local dev:  server.js handles /api/box (Node.js proxy)
 *   - Production:  Cloudflare Worker Route handles /api/box
 *     (057300.xyz/api/* -> diecut-api Worker, same-origin, no CORS issues)
 *
 * SETUP (one-time, in Cloudflare Dashboard):
 *   1. Go to Workers & Pages -> diecut-api -> Settings -> Triggers -> Routes
 *   2. Add Route:  057300.xyz/api/*  (Zone: 057300.xyz)
 *   3. That's it — requests to /api/box are proxied to the Worker
 */

var DiecutConfig = {
  apiBase: '/api/box',
};
