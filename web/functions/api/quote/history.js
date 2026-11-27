/**
 * @fileoverview GET /api/quote/history?ticker=00631L&market=TWSE&date=2026-11-20
 * Checks Cloudflare D1 permanent cache first; on miss fetches 4+ authoritative sources
 * concurrently and permanently stores VERIFIED consensus closes into D1.
 */

import { normalizeAndValidateTicker, normalizeMarket } from '../../_lib/core/config.mjs';
import { parseDateParts, reconcileHistoricalDateMultiSource } from '../../_lib/core/price-adapters.mjs';
import { jsonResponse, recordTelemetry } from '../../_lib/http.js';

export async function onRequestGet(context) {
  const { request, env, waitUntil } = context;
  const startMs = Date.now();
  const url = new URL(request.url);
  const rawTicker = url.searchParams.get('ticker');
  const rawMarket = url.searchParams.get('market') || '';
  const rawDate = url.searchParams.get('date');

  if (!rawTicker || !rawDate) {
    return jsonResponse({ error: 'Missing required parameters: ticker and date (YYYY-MM-DD).' }, 400);
  }

  let ticker, market, dateYmd;
  try {
    ticker = normalizeAndValidateTicker(rawTicker);
    market = normalizeMarket(rawMarket, ticker);
    dateYmd = parseDateParts(rawDate).ymd;
  } catch (err) {
    return jsonResponse({ error: err.message }, 400);
  }

  // Step 1: Check Cloudflare D1 permanent verified historical cache
  if (env?.DB) {
    try {
      const row = await env.DB.prepare(
        'SELECT * FROM price_history_cache WHERE ticker = ? AND market = ? AND trade_date <= ? ORDER BY trade_date DESC LIMIT 1'
      )
        .bind(ticker, market, dateYmd)
        .first();
      // Only serve from D1 if exact date matched (avoid masking newer trading days)
      if (row && row.trade_date === dateYmd && row.status_code === 'VERIFIED') {
        const latencyMs = Date.now() - startMs;
        await recordTelemetry(env, 'QUOTE_HISTORY', 'OK', latencyMs, 1, row.valid_source_count, waitUntil);
        return jsonResponse({
          mode: 'HISTORICAL',
          cached: true,
          cacheLayer: 'CLOUDFLARE_D1',
          ticker,
          market,
          requestedDate: dateYmd,
          matchedDates: [row.trade_date],
          consensusPrice: row.consensus_price,
          validSourceCount: row.valid_source_count,
          meetsThreeSourceRule: row.valid_source_count >= 3,
          spreadPct: row.spread_pct,
          statusCode: row.status_code,
          statusLabel: '✅ 三源精準一致 (D1 永久快取)',
          outlierSource: row.outlier_source || '無',
          quotes: JSON.parse(row.sources_json || '[]'),
          latencyMs,
        }, 200, { 'X-Cache': 'D1-HIT' });
      }
    } catch {
      // Fallback to live upstream fetch on D1 error
    }
  }

  // Step 2: Cache miss -> concurrent 4+ source fetch
  const deps = { env, fetchFn: context.fetchFn, sleepFn: context.sleepFn, nowFn: context.nowFn };
  const result = await reconcileHistoricalDateMultiSource(ticker, market, dateYmd, deps);
  const latencyMs = Date.now() - startMs;

  // Step 3: Permanently cache VERIFIED closes in D1
  if (env?.DB && result.statusCode === 'VERIFIED' && result.consensusPrice !== null && result.matchedDates.length === 1) {
    const tradeDate = result.matchedDates[0];
    const persist = async () => {
      try {
        await env.DB.prepare(
          `INSERT OR REPLACE INTO price_history_cache
           (ticker, market, trade_date, consensus_price, valid_source_count, spread_pct, status_code, outlier_source, sources_json, verified_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
          .bind(
            ticker, market, tradeDate, result.consensusPrice, result.validSourceCount,
            result.spreadPct || 0, result.statusCode, result.outlierSource || '無',
            JSON.stringify(result.quotes || []), new Date().toISOString()
          )
          .run();
      } catch {
        // Non-fatal
      }
    };
    if (typeof waitUntil === 'function') waitUntil(persist());
    else await persist();
  }

  await recordTelemetry(env, 'QUOTE_HISTORY', result.meetsThreeSourceRule ? 'OK' : 'WARN', latencyMs, 0, result.validSourceCount, waitUntil);
  return jsonResponse({ ...result, cached: false, latencyMs }, 200, { 'X-Cache': 'MISS' });
}
