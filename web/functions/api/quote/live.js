/**
 * @fileoverview GET /api/quote/live?tickers=0050,00631L&markets=TWSE,TWSE
 * Runs 4+ source live reconciliation with 60s Cloudflare Edge Cache and
 * strict batch cap (<= 10 tickers/request to stay safely under 50 subrequests/invocation).
 */

import { WEB_CONFIG, normalizeAndValidateTicker, normalizeMarket } from '../../_lib/core/config.mjs';
import { reconcileLiveTickerMultiSource } from '../../_lib/core/price-adapters.mjs';
import { edgeCacheGet, edgeCachePut, jsonResponse, recordTelemetry } from '../../_lib/http.js';

const MAX_LIVE_BATCH_PER_CALL = 10;

export async function onRequestGet(context) {
  const { request, env, waitUntil } = context;
  const startMs = Date.now();
  const url = new URL(request.url);
  const tickersParam = url.searchParams.get('tickers') || url.searchParams.get('ticker') || '';
  const marketsParam = url.searchParams.get('markets') || url.searchParams.get('market') || '';

  const rawTickers = tickersParam.split(',').map((s) => s.trim()).filter(Boolean);
  const rawMarkets = marketsParam.split(',').map((s) => s.trim());

  if (rawTickers.length === 0) {
    return jsonResponse({ error: 'Missing required query parameter: tickers' }, 400);
  }
  if (rawTickers.length > MAX_LIVE_BATCH_PER_CALL) {
    return jsonResponse({ error: `Max ${MAX_LIVE_BATCH_PER_CALL} tickers per live request to respect Cloudflare Free subrequest limits.` }, 400);
  }

  let pairs;
  try {
    pairs = rawTickers.map((t, idx) => {
      const ticker = normalizeAndValidateTicker(t);
      const market = normalizeMarket(rawMarkets[idx] || '', ticker);
      return { ticker, market };
    });
  } catch (err) {
    return jsonResponse({ error: err.message }, 400);
  }

  const cacheKey = `${url.origin}/api/quote/live?k=${pairs.map((p) => `${p.market}:${p.ticker}`).join(',')}`;
  const cachedResp = await edgeCacheGet(cacheKey);
  if (cachedResp) {
    await recordTelemetry(env, 'QUOTE_LIVE', 'OK', Date.now() - startMs, 1, null, waitUntil);
    const out = new Response(cachedResp.body, cachedResp);
    out.headers.set('X-Cache', 'HIT');
    return out;
  }

  const deps = { env, fetchFn: context.fetchFn, sleepFn: context.sleepFn, nowFn: context.nowFn };
  const results = await Promise.all(
    pairs.map((p) => reconcileLiveTickerMultiSource(p.ticker, p.market, deps))
  );

  const latencyMs = Date.now() - startMs;
  const minValid = Math.min(...results.map((r) => r.validSourceCount));
  await recordTelemetry(env, 'QUOTE_LIVE', minValid >= 3 ? 'OK' : 'WARN', latencyMs, 0, minValid, waitUntil);

  const response = jsonResponse({
    mode: 'LIVE',
    cached: false,
    fetchedAt: new Date().toISOString(),
    latencyMs,
    results,
  }, 200, { 'X-Cache': 'MISS' });

  await edgeCachePut(cacheKey, response, WEB_CONFIG.CACHE_TTL_SEC.LIVE_QUOTE, waitUntil);
  return response;
}
