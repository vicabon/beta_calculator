/**
 * @fileoverview Shared HTTP, Cloudflare Access auth verification, Edge Cache,
 * and anonymous SLA telemetry helpers for Cloudflare Pages Functions.
 */

export function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });
}

function base64UrlToUint8Array(b64url) {
  const padded = b64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64url.length % 4)) % 4);
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(padded, 'base64'));
  }
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Verifies Cloudflare Access RS256 JWT assertion when CF_ACCESS_TEAM_DOMAIN & CF_ACCESS_AUD are configured.
 */
export async function verifyCloudflareAccessJwt(jwtToken, teamDomain, expectedAud, fetchFn = globalThis.fetch) {
  const parts = String(jwtToken || '').split('.');
  if (parts.length !== 3) throw new Error('Malformed Access JWT.');
  const header = JSON.parse(new TextDecoder().decode(base64UrlToUint8Array(parts[0])));
  const payload = JSON.parse(new TextDecoder().decode(base64UrlToUint8Array(parts[1])));
  const nowSec = Math.floor(Date.now() / 1000);
  if (payload.exp && nowSec >= payload.exp) throw new Error('Access JWT expired.');
  if (expectedAud) {
    const audList = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!audList.includes(expectedAud)) throw new Error('Access JWT audience mismatch.');
  }

  const certsResp = await fetchFn(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!certsResp.ok) throw new Error('Unable to fetch Cloudflare Access certs.');
  const jwks = await certsResp.json();
  const jwk = (jwks.keys || []).find((k) => k.kid === header.kid);
  if (!jwk) throw new Error('Matching JWKS key not found.');

  const key = await globalThis.crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );
  const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const sig = base64UrlToUint8Array(parts[2]);
  const valid = await globalThis.crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sig, data);
  if (!valid) throw new Error('Invalid Access JWT signature.');
  return payload;
}

/**
 * Extracts authenticated user identity strictly from Cloudflare Access edge context/headers.
 * NEVER trusts user_email passed from request query/body (IDOR protection).
 */
export async function resolveAuthenticatedUser(request, env = {}, deps = {}) {
  const emailHeader = request.headers.get('Cf-Access-Authenticated-User-Email');
  const jwtHeader = request.headers.get('Cf-Access-Jwt-Assertion');

  if (env.CF_ACCESS_TEAM_DOMAIN && env.CF_ACCESS_AUD) {
    if (!jwtHeader) {
      return { authenticated: false, email: null, reason: 'Missing Cf-Access-Jwt-Assertion header' };
    }
    try {
      const payload = await verifyCloudflareAccessJwt(jwtHeader, env.CF_ACCESS_TEAM_DOMAIN, env.CF_ACCESS_AUD, deps.fetchFn);
      const verifiedEmail = String(payload.email || emailHeader || '').trim().toLowerCase();
      if (!verifiedEmail) return { authenticated: false, email: null, reason: 'Email missing in JWT' };
      return { authenticated: true, email: verifiedEmail, method: 'CF_ACCESS_JWT' };
    } catch (err) {
      return { authenticated: false, email: null, reason: err.message };
    }
  }

  // Standard Cloudflare Access deployment (edge strips spoofed headers & injects verified email)
  if (emailHeader && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailHeader.trim())) {
    // Reject unsigned header attempts if explicitly configured to require JWT
    if (env.REQUIRE_CF_JWT === 'true' && !jwtHeader) {
      return { authenticated: false, email: null, reason: 'JWT assertion required' };
    }
    return { authenticated: true, email: emailHeader.trim().toLowerCase(), method: 'CF_ACCESS_EDGE_HEADER' };
  }

  return { authenticated: false, email: null, reason: 'Unauthenticated: Cloudflare Zero Trust Access login required.' };
}

export async function edgeCacheGet(cacheKeyUrl) {
  try {
    if (typeof caches !== 'undefined' && caches.default) {
      return await caches.default.match(new Request(cacheKeyUrl, { method: 'GET' }));
    }
  } catch {
    // Ignore when running outside Cloudflare Workers runtime
  }
  return null;
}

export async function edgeCachePut(cacheKeyUrl, response, ttlSec, waitUntil) {
  try {
    if (typeof caches !== 'undefined' && caches.default) {
      const clone = new Response(response.clone().body, response);
      clone.headers.set('Cache-Control', `public, max-age=${ttlSec}`);
      const p = caches.default.put(new Request(cacheKeyUrl, { method: 'GET' }), clone);
      if (typeof waitUntil === 'function') waitUntil(p);
      else await p;
    }
  } catch {
    // Non-fatal
  }
}

export async function recordTelemetry(env, eventType, status, latencyMs, cacheHit = 0, validSources = null, waitUntil = null) {
  if (!env?.DB) return;
  const run = async () => {
    try {
      await env.DB.prepare(
        'INSERT INTO telemetry_events (event_type, status, latency_ms, cache_hit, valid_sources, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      )
        .bind(eventType, status, Number(latencyMs || 0), cacheHit ? 1 : 0, validSources, new Date().toISOString())
        .run();
    } catch {
      // Telemetry failures must never disrupt primary response
    }
  };
  if (typeof waitUntil === 'function') waitUntil(run());
  else await run();
}
