/**
 * @fileoverview Global Cloudflare Pages Functions security middleware:
 *  - Strict CSP, X-Frame-Options, Referrer-Policy, X-Content-Type-Options
 *  - Strict CORS Origin allowlist on /api/* (blocks third-party proxy freeloading)
 *  - Lightweight per-IP sliding-window rate guard (60 req/min/IP)
 */

const ipBuckets = new Map();
const RATE_LIMIT_WINDOW_MS = 60000;
const RATE_LIMIT_MAX_REQ = 90;

export function buildSecurityHeaders() {
  return {
    'Content-Security-Policy':
      "default-src 'self'; " +
      "script-src 'self' https://accounts.google.com/gsi/client; " +
      "style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data:; " +
      "connect-src 'self' https://www.googleapis.com https://accounts.google.com; " +
      "frame-src https://accounts.google.com; " +
      "manifest-src 'self'; " +
      "worker-src 'self'; " +
      "object-src 'none'; " +
      "base-uri 'self'; " +
      "frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  };
}

export function isOriginAllowed(origin, requestUrl, env = {}) {
  if (!origin) return true; // Same-origin navigations / non-browser requests without Origin
  try {
    const reqOrigin = new URL(requestUrl).origin;
    if (origin === reqOrigin) return true;
  } catch {
    return false;
  }
  const allowList = String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return allowList.includes(origin);
}

function checkRateLimit(ip, nowMs = Date.now()) {
  const key = ip || 'unknown';
  let timestamps = ipBuckets.get(key) || [];
  timestamps = timestamps.filter((t) => nowMs - t < RATE_LIMIT_WINDOW_MS);
  if (timestamps.length >= RATE_LIMIT_MAX_REQ) {
    ipBuckets.set(key, timestamps);
    return false;
  }
  timestamps.push(nowMs);
  ipBuckets.set(key, timestamps);
  return true;
}

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);
  const isApi = url.pathname.startsWith('/api/');
  const origin = request.headers.get('Origin');

  if (isApi) {
    if (!isOriginAllowed(origin, request.url, env)) {
      return new Response(JSON.stringify({ error: 'CORS Origin rejected.' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json; charset=utf-8', ...buildSecurityHeaders() },
      });
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          ...(origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {}),
          'Access-Control-Allow-Methods': 'GET, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '600',
          ...buildSecurityHeaders(),
        },
      });
    }

    const clientIp = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'local';
    if (!checkRateLimit(clientIp)) {
      return new Response(JSON.stringify({ error: 'Rate limit exceeded. Please retry in 60 seconds.' }), {
        status: 429,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': '60', ...buildSecurityHeaders() },
      });
    }
  }

  const response = await next();
  const patched = new Response(response.body, response);
  const secHeaders = buildSecurityHeaders();
  for (const [k, v] of Object.entries(secHeaders)) {
    patched.headers.set(k, v);
  }
  if (isApi && origin && isOriginAllowed(origin, request.url, env)) {
    patched.headers.set('Access-Control-Allow-Origin', origin);
    patched.headers.set('Vary', 'Origin');
  }
  return patched;
}
