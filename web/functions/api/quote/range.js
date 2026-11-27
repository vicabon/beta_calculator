/**
 * @fileoverview GET /api/quote/range?ticker=0050&market=TWSE&start=2026-10-01&end=2026-11-27
 * Tracks multi-day historical closing prices across 4+ sources and reconciles every trading day.
 */

import { normalizeAndValidateTicker, normalizeMarket } from '../../_lib/core/config.mjs';
import { reconcileHistoricalRangeMultiSource } from '../../_lib/core/price-adapters.mjs';
import { jsonResponse, recordTelemetry } from '../../_lib/http.js';

export async function onRequestGet(context) {
  const { request, env, waitUntil } = context;
  const startMs = Date.now();
  const url = new URL(request.url);
  const rawTicker = url.searchParams.get('ticker');
  const rawMarket = url.searchParams.get('market') || '';
  const start = url.searchParams.get('start');
  const end = url.searchParams.get('end');

  if (!rawTicker || !start || !end) {
    return jsonResponse({ error: 'Missing required parameters: ticker, start, end (YYYY-MM-DD).' }, 400);
  }

  let ticker, market;
  try {
    ticker = normalizeAndValidateTicker(rawTicker);
    market = normalizeMarket(rawMarket, ticker);
  } catch (err) {
    return jsonResponse({ error: err.message }, 400);
  }

  try {
    const deps = { env, fetchFn: context.fetchFn, sleepFn: context.sleepFn, nowFn: context.nowFn };
    const report = await reconcileHistoricalRangeMultiSource(ticker, market, start, end, deps);
    const latencyMs = Date.now() - startMs;

    // Persist newly verified daily rows into D1 (batch upsert)
    if (env?.DB && report.rows.length > 0) {
      const verifiedRows = report.rows.filter((r) => r.statusCode === 'VERIFIED' && r.consensusPrice !== null);
      const persistBatch = async () => {
        try {
          const nowIso = new Date().toISOString();
          for (const r of verifiedRows.slice(0, 40)) {
            await env.DB.prepare(
              `INSERT OR REPLACE INTO price_history_cache
               (ticker, market, trade_date, consensus_price, valid_source_count, spread_pct, status_code, outlier_source, sources_json, verified_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
              .bind(
                ticker, market, r.date, r.consensusPrice, r.validSourceCount,
                r.spreadPct || 0, r.statusCode, r.outlierSource || '無',
                JSON.stringify(r.sources || {}), nowIso
              )
              .run();
          }
        } catch {
          // Non-fatal
        }
      };
      if (typeof waitUntil === 'function') waitUntil(persistBatch());
      else await persistBatch();
    }

    await recordTelemetry(env, 'QUOTE_RANGE', report.totalTradingDays > 0 ? 'OK' : 'WARN', latencyMs, 0, 3, waitUntil);
    return jsonResponse({ ...report, latencyMs });
  } catch (err) {
    return jsonResponse({ error: err.message }, 400);
  }
}
