/**
 * @fileoverview Multi-source (3+) stock price consensus engine, outlier detection,
 * historical time-series alignment, and Layer 5 SLA telemetry.
 */

import { WEB_CONFIG } from './config.mjs';

export function parsePositivePrice(raw) {
  if (raw === null || raw === undefined || raw === '' || raw === '-' || raw === '--' || raw === 'N/A') {
    return null;
  }
  const num = Number(String(raw).replace(/,/g, '').trim());
  return Number.isFinite(num) && num > 0 ? num : null;
}

export function computeMedian(sortedNums) {
  const n = sortedNums.length;
  if (n === 0) return null;
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? sortedNums[mid] : (sortedNums[mid - 1] + sortedNums[mid]) / 2;
}

export function reconcilePrices(quotes, mode = 'LIVE') {
  const normalizedMode = mode === 'HISTORICAL' ? 'HISTORICAL' : 'LIVE';
  const list = Array.isArray(quotes) ? quotes : [];
  const validQuotes = [];

  for (let i = 0; i < list.length; i++) {
    const q = list[i];
    const p = q && q.ok ? parsePositivePrice(q.price) : null;
    if (p !== null) {
      validQuotes.push({
        source: q.source || `Source_${i + 1}`,
        price: p,
        tradingDate: q.tradingDate || null,
        latencyMs: Number(q.latencyMs || 0),
      });
    }
  }

  const validCount = validQuotes.length;
  const totalCount = list.length;
  if (validCount === 0) {
    return {
      mode: normalizedMode,
      validSourceCount: 0,
      totalSourceCount: totalCount,
      meetsThreeSourceRule: false,
      consensusPrice: null,
      meanPrice: null,
      minPrice: null,
      maxPrice: null,
      absSpread: null,
      spreadPct: null,
      dateMismatch: false,
      matchedDates: [],
      outlierSource: '無有效報價',
      statusCode: 'FAILED',
      statusLabel: '❌ 無法取得報價',
      quotes: list,
    };
  }

  const sortedPrices = validQuotes.map((q) => q.price).sort((a, b) => a - b);
  const consensusPrice = computeMedian(sortedPrices);
  const meanPrice = sortedPrices.reduce((a, b) => a + b, 0) / validCount;
  const minPrice = sortedPrices[0];
  const maxPrice = sortedPrices[sortedPrices.length - 1];
  const absSpread = maxPrice - minPrice;
  const spreadPct = consensusPrice > 0 ? absSpread / consensusPrice : 0;

  const matchedDates = [...new Set(validQuotes.map((q) => q.tradingDate).filter(Boolean))].sort();
  const dateMismatch = matchedDates.length > 1;

  const cfg = WEB_CONFIG.RECONCILIATION;
  const meetsThreeSourceRule = validCount >= cfg.MIN_REQUIRED_SOURCES;
  const verifiedLimit = normalizedMode === 'HISTORICAL'
    ? cfg.HISTORICAL_VERIFIED_SPREAD_PCT
    : cfg.LIVE_VERIFIED_SPREAD_PCT;
  const minorLimit = normalizedMode === 'HISTORICAL'
    ? cfg.HISTORICAL_MINOR_SPREAD_PCT
    : cfg.LIVE_MINOR_SPREAD_PCT;

  const isWithinVerified =
    spreadPct <= verifiedLimit ||
    (normalizedMode === 'HISTORICAL' && absSpread <= cfg.HISTORICAL_VERIFIED_ABS_DIFF);

  let statusCode;
  let statusLabel;
  if (!meetsThreeSourceRule) {
    statusCode = 'INSUFFICIENT_SOURCES';
    statusLabel = `⚠️ 來源不足 (${validCount}/3)`;
  } else if (isWithinVerified) {
    statusCode = 'VERIFIED';
    statusLabel = normalizedMode === 'HISTORICAL' ? '✅ 三源精準一致' : '✅ 三源一致';
    if (dateMismatch) statusLabel += ' (注意日期差)';
  } else if (spreadPct <= minorLimit) {
    statusCode = normalizedMode === 'HISTORICAL' ? 'MINOR_DIFF' : 'DELAY_DIFF';
    statusLabel = normalizedMode === 'HISTORICAL' ? '⚠️ 輕微差異' : '⚠️ 延遲/輕微價差';
  } else {
    statusCode = 'DISCREPANCY';
    statusLabel = '🚨 異常價差警示';
  }

  let outlierSource = '無';
  if (!isWithinVerified && validCount >= 3) {
    let worst = null;
    let worstAbs = -1;
    for (const q of validQuotes) {
      const devPct = (q.price - consensusPrice) / consensusPrice;
      if (Math.abs(devPct) > worstAbs) {
        worstAbs = Math.abs(devPct);
        worst = { source: q.source, signedPct: devPct };
      }
    }
    if (worst && worstAbs > 0) {
      const sign = worst.signedPct >= 0 ? '+' : '';
      outlierSource = `${worst.source} (${sign}${(worst.signedPct * 100).toFixed(2)}%)`;
    }
  } else if (dateMismatch) {
    outlierSource = `交易日不同: ${matchedDates.join(' vs ')}`;
  }

  return {
    mode: normalizedMode,
    validSourceCount: validCount,
    totalSourceCount: totalCount,
    meetsThreeSourceRule,
    consensusPrice: Number(consensusPrice.toFixed(4)),
    meanPrice: Number(meanPrice.toFixed(4)),
    minPrice: Number(minPrice.toFixed(4)),
    maxPrice: Number(maxPrice.toFixed(4)),
    absSpread: Number(absSpread.toFixed(4)),
    spreadPct,
    dateMismatch,
    matchedDates,
    outlierSource,
    statusCode,
    statusLabel,
    quotes: list,
  };
}

export function alignAndReconcileSeries(ticker, market, seriesList) {
  const datesSet = new Set();
  const bySource = {};
  for (const s of seriesList) {
    bySource[s.source] = {};
    for (const pt of s.series || []) {
      const p = parsePositivePrice(pt.close);
      if (pt.date && p !== null) {
        bySource[s.source][pt.date] = p;
        datesSet.add(pt.date);
      }
    }
  }

  const dates = [...datesSet].sort();
  const rows = [];
  let verifiedDays = 0;
  let discrepancyDays = 0;

  for (const dt of dates) {
    const quotes = seriesList.map((s) => {
      const p = bySource[s.source][dt] ?? null;
      return { source: s.source, ok: p !== null, price: p, tradingDate: dt };
    });
    const rec = reconcilePrices(quotes, 'HISTORICAL');
    if (rec.statusCode === 'VERIFIED') verifiedDays++;
    if (rec.statusCode === 'DISCREPANCY') discrepancyDays++;

    const sourcesObj = {};
    for (const q of quotes) {
      sourcesObj[q.source] = q.price;
    }

    rows.push({
      date: dt,
      ticker,
      market,
      sources: sourcesObj,
      validSourceCount: rec.validSourceCount,
      consensusPrice: rec.consensusPrice,
      spreadPct: rec.spreadPct,
      statusCode: rec.statusCode,
      statusLabel: rec.statusLabel,
      outlierSource: rec.outlierSource,
    });
  }

  return {
    ticker,
    market,
    totalTradingDays: rows.length,
    verifiedDays,
    discrepancyDays,
    rows,
  };
}

export function computeTelemetryMetrics(records) {
  const list = Array.isArray(records) ? records : [];
  if (list.length === 0) {
    return { total: 0, successes: 0, successRate: 1, avgMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0 };
  }
  let successes = 0;
  const latencies = [];
  for (const r of list) {
    if (r.ok) successes++;
    latencies.push(Math.max(0, Number(r.latencyMs || 0)));
  }
  latencies.sort((a, b) => a - b);
  const sum = latencies.reduce((a, b) => a + b, 0);
  const pct = (p) => latencies[Math.min(latencies.length - 1, Math.max(0, Math.ceil((p / 100) * latencies.length) - 1))];
  return {
    total: list.length,
    successes,
    successRate: successes / list.length,
    avgMs: Number((sum / list.length).toFixed(2)),
    p50Ms: pct(50),
    p95Ms: pct(95),
    p99Ms: pct(99),
  };
}
