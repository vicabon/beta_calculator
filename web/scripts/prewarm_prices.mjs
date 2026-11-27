#!/usr/bin/env node
/**
 * @fileoverview Post-market daily pre-warm script for Private GitHub Actions.
 * Fetches 3-4 authoritative sources for default presets + popular ETFs and generates
 * idempotent SQLite UPSERT statements to populate Cloudflare D1 `price_history_cache`.
 *
 * Usage:
 *   node web/scripts/prewarm_prices.mjs [--date=YYYY-MM-DD] [--out=web/migrations/prewarm_latest.sql]
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseDateParts, reconcileHistoricalDateMultiSource } from '../../packages/core/price-adapters.mjs';

const DEFAULT_WATCHLIST = [
  { ticker: '0050', market: 'TWSE' },
  { ticker: '006208', market: 'TWSE' },
  { ticker: '00662', market: 'TWSE' },
  { ticker: '00685L', market: 'TWSE' },
  { ticker: '00631L', market: 'TWSE' },
  { ticker: '0056', market: 'TWSE' },
  { ticker: '00878', market: 'TWSE' },
  { ticker: '00713', market: 'TWSE' },
  { ticker: '2330', market: 'TWSE' },
  { ticker: 'VOO', market: 'US' },
  { ticker: 'VT', market: 'US' },
  { ticker: 'QQQ', market: 'US' },
];

function sqlEscape(str) {
  return String(str ?? '').replace(/'/g, "''");
}

function parseArg(prefix, fallback = null) {
  const found = process.argv.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

async function main() {
  const targetDate = parseDateParts(parseArg('--date=', new Date())).ymd;
  const outPath = parseArg('--out=', path.resolve('web', '.prewarm_upserts.sql'));
  const dryRun = process.argv.includes('--dry-run');

  console.log(`[Prewarm] Target date: ${targetDate}, tickers: ${DEFAULT_WATCHLIST.length}, dryRun=${dryRun}`);
  const sqlStatements = [];
  let verifiedCount = 0;

  for (const item of DEFAULT_WATCHLIST) {
    if (dryRun) {
      console.log(`  [DRY-RUN] Would reconcile ${item.market}:${item.ticker} @ ${targetDate}`);
      continue;
    }
    const res = await reconcileHistoricalDateMultiSource(item.ticker, item.market, targetDate, { env: process.env });
    console.log(`  [${res.statusCode}] ${item.ticker} (${item.market}): consensus=${res.consensusPrice}, valid=${res.validSourceCount}, dates=${res.matchedDates.join(',')}`);
    if (res.statusCode === 'VERIFIED' && res.consensusPrice !== null && res.matchedDates.length === 1) {
      verifiedCount++;
      const tradeDate = res.matchedDates[0];
      sqlStatements.push(
        `INSERT OR REPLACE INTO price_history_cache (ticker, market, trade_date, consensus_price, valid_source_count, spread_pct, status_code, outlier_source, sources_json, verified_at) VALUES ('${sqlEscape(item.ticker)}', '${sqlEscape(item.market)}', '${sqlEscape(tradeDate)}', ${Number(res.consensusPrice)}, ${Number(res.validSourceCount)}, ${Number(res.spreadPct || 0)}, '${sqlEscape(res.statusCode)}', '${sqlEscape(res.outlierSource || '無')}', '${sqlEscape(JSON.stringify(res.quotes || []))}', '${new Date().toISOString()}');`
      );
    }
  }

  if (!dryRun && sqlStatements.length > 0) {
    fs.writeFileSync(outPath, sqlStatements.join('\n') + '\n', 'utf8');
    console.log(`[Prewarm] Wrote ${sqlStatements.length} verified D1 upserts to ${outPath}`);
  } else {
    console.log(`[Prewarm] Finished (verified=${verifiedCount}, dryRun=${dryRun})`);
  }
}

main().catch((err) => {
  console.error('[Prewarm] Fatal error:', err.message);
  process.exit(1);
});
