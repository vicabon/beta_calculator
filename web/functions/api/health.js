/**
 * @fileoverview GET /api/health — System status, configured free data sources count,
 * authenticated session check, and Layer 5 SLA telemetry summary (zero PII).
 */

import { WEB_CONFIG } from '../_lib/core/config.mjs';
import { computeTelemetryMetrics } from '../_lib/core/reconciler.mjs';
import { jsonResponse, resolveAuthenticatedUser } from '../_lib/http.js';

export async function onRequestGet(context) {
  const { request, env } = context;
  const auth = await resolveAuthenticatedUser(request, env, { fetchFn: context.fetchFn });

  let telemetrySummary = null;
  let cachedHistoryCount = 0;
  if (env?.DB) {
    try {
      const events = await env.DB.prepare(
        'SELECT status, latency_ms, cache_hit FROM telemetry_events ORDER BY id DESC LIMIT 200'
      ).all();
      const rows = (events?.results || []).map((r) => ({
        ok: r.status === 'OK',
        latencyMs: Number(r.latency_ms || 0),
        cacheHit: r.cache_hit === 1,
      }));
      const stats = computeTelemetryMetrics(rows);
      const cacheHitRate = rows.length ? rows.filter((r) => r.cacheHit).length / rows.length : 0;
      telemetrySummary = { ...stats, cacheHitRate: Number(cacheHitRate.toFixed(4)) };

      const cnt = await env.DB.prepare('SELECT COUNT(*) AS c FROM price_history_cache').first();
      cachedHistoryCount = Number(cnt?.c || 0);
    } catch {
      // Ignore if schema not migrated yet
    }
  }

  return jsonResponse({
    app: WEB_CONFIG.APP_NAME,
    version: WEB_CONFIG.VERSION,
    status: 'OK',
    d1Connected: Boolean(env?.DB),
    cachedHistoryCount,
    authenticatedUser: auth.authenticated ? auth.email : null,
    configuredSources: {
      twseTpex: true,
      yahooFinance: true,
      finMind: true,
      stooqUs: true,
      fugle: Boolean(env?.FUGLE_API_KEY),
      twelveData: Boolean(env?.TWELVEDATA_API_KEY),
      finnhub: Boolean(env?.FINNHUB_API_KEY),
      googleFinanceGasBridge: Boolean(env?.GAS_BRIDGE_URL),
    },
    slaTelemetry: telemetrySummary,
    timestamp: new Date().toISOString(),
  });
}
