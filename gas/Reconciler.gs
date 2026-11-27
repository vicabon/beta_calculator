/**
 * @fileoverview Multi-source (3+) price consensus, spread verification,
 * outlier detection, historical time-series alignment, and Layer 5 SLA telemetry.
 */

if (typeof APP_CONFIG === 'undefined' && typeof require !== 'undefined') {
  var _cfg = require('./Config.gs');
  var APP_CONFIG = _cfg.APP_CONFIG;
  var _ps = require('./PriceSources.gs');
  var fetchYahooLiveQuote = _ps.fetchYahooLiveQuote;
  var fetchYahooHistoricalClose = _ps.fetchYahooHistoricalClose;
  var fetchYahooHistoricalSeries = _ps.fetchYahooHistoricalSeries;
  var fetchExchangeOfficialLiveQuote = _ps.fetchExchangeOfficialLiveQuote;
  var fetchExchangeOfficialHistoricalClose = _ps.fetchExchangeOfficialHistoricalClose;
  var fetchExchangeOfficialHistoricalSeries = _ps.fetchExchangeOfficialHistoricalSeries;
  var fetchFinMindLatestClose = _ps.fetchFinMindLatestClose;
  var fetchFinMindHistoricalSeries = _ps.fetchFinMindHistoricalSeries;
  var parsePositivePrice = _ps.parsePositivePrice;
  var parseDateParts = _ps.parseDateParts;
}

/**
 * Computes exact median of a non-empty sorted numeric array.
 * @param {Array<number>} sortedNums
 * @return {number}
 */
function computeMedian(sortedNums) {
  const n = sortedNums.length;
  if (n === 0) return null;
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? sortedNums[mid] : (sortedNums[mid - 1] + sortedNums[mid]) / 2;
}

/**
 * Reconciles quotes from 3+ authoritative sources using median consensus & outlier detection.
 * @param {Array<{source: string, ok: boolean, price: (number|null), tradingDate?: (string|null), latencyMs?: number, error?: (string|null)}>} quotes
 * @param {string} mode 'LIVE' | 'HISTORICAL'
 * @return {Object}
 */
function reconcilePrices(quotes, mode) {
  const normalizedMode = mode === 'HISTORICAL' ? 'HISTORICAL' : 'LIVE';
  const list = Array.isArray(quotes) ? quotes : [];
  const validQuotes = [];

  for (let i = 0; i < list.length; i++) {
    const q = list[i];
    const p = q && q.ok ? parsePositivePrice(q.price) : null;
    if (p !== null) {
      validQuotes.push({
        source: q.source || ('Source_' + (i + 1)),
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

  const sortedPrices = validQuotes.map(function (q) { return q.price; }).sort(function (a, b) { return a - b; });
  const consensusPrice = computeMedian(sortedPrices);
  const sum = sortedPrices.reduce(function (acc, val) { return acc + val; }, 0);
  const meanPrice = sum / validCount;
  const minPrice = sortedPrices[0];
  const maxPrice = sortedPrices[sortedPrices.length - 1];
  const absSpread = maxPrice - minPrice;
  const spreadPct = consensusPrice > 0 ? absSpread / consensusPrice : 0;

  // Check if sources reported differing trading dates
  const distinctDatesMap = {};
  for (let i = 0; i < validQuotes.length; i++) {
    if (validQuotes[i].tradingDate) {
      distinctDatesMap[validQuotes[i].tradingDate] = true;
    }
  }
  const matchedDates = Object.keys(distinctDatesMap).sort();
  const dateMismatch = matchedDates.length > 1;

  // Thresholds
  const cfg = APP_CONFIG.RECONCILIATION;
  const meetsThreeSourceRule = validCount >= cfg.MIN_REQUIRED_SOURCES;
  const verifiedSpreadLimit = normalizedMode === 'HISTORICAL'
    ? cfg.HISTORICAL_VERIFIED_SPREAD_PCT
    : cfg.LIVE_VERIFIED_SPREAD_PCT;
  const minorSpreadLimit = normalizedMode === 'HISTORICAL'
    ? cfg.HISTORICAL_MINOR_SPREAD_PCT
    : cfg.LIVE_MINOR_SPREAD_PCT;

  const isWithinVerified =
    spreadPct <= verifiedSpreadLimit ||
    (normalizedMode === 'HISTORICAL' && absSpread <= cfg.HISTORICAL_VERIFIED_ABS_DIFF);

  let statusCode;
  let statusLabel;
  if (!meetsThreeSourceRule) {
    statusCode = 'INSUFFICIENT_SOURCES';
    statusLabel = '⚠️ 來源不足 (' + validCount + '/3)';
  } else if (isWithinVerified) {
    statusCode = 'VERIFIED';
    statusLabel = normalizedMode === 'HISTORICAL' ? '✅ 三源精準一致' : '✅ 三源一致';
    if (dateMismatch) {
      statusLabel += ' (注意日期差)';
    }
  } else if (spreadPct <= minorSpreadLimit) {
    statusCode = normalizedMode === 'HISTORICAL' ? 'MINOR_DIFF' : 'DELAY_DIFF';
    statusLabel = normalizedMode === 'HISTORICAL' ? '⚠️ 輕微差異' : '⚠️ 延遲/輕微價差';
  } else {
    statusCode = 'DISCREPANCY';
    statusLabel = '🚨 異常價差警示';
  }

  // Outlier identification (source furthest from median when spread exceeds verified threshold)
  let outlierSource = '無';
  if (!isWithinVerified && validCount >= 3) {
    let worst = null;
    let worstDevPct = -1;
    for (let i = 0; i < validQuotes.length; i++) {
      const q = validQuotes[i];
      const devPct = (q.price - consensusPrice) / consensusPrice;
      if (Math.abs(devPct) > worstDevPct) {
        worstDevPct = Math.abs(devPct);
        worst = { source: q.source, signedPct: devPct };
      }
    }
    if (worst && worstDevPct > 0) {
      const sign = worst.signedPct >= 0 ? '+' : '';
      outlierSource = worst.source + ' (' + sign + (worst.signedPct * 100).toFixed(2) + '%)';
    }
  } else if (dateMismatch) {
    outlierSource = '交易日不同: ' + matchedDates.join(' vs ');
  }

  return {
    mode: normalizedMode,
    validSourceCount: validCount,
    totalSourceCount: totalCount,
    meetsThreeSourceRule: meetsThreeSourceRule,
    consensusPrice: Number(consensusPrice.toFixed(4)),
    meanPrice: Number(meanPrice.toFixed(4)),
    minPrice: Number(minPrice.toFixed(4)),
    maxPrice: Number(maxPrice.toFixed(4)),
    absSpread: Number(absSpread.toFixed(4)),
    spreadPct: spreadPct,
    dateMismatch: dateMismatch,
    matchedDates: matchedDates,
    outlierSource: outlierSource,
    statusCode: statusCode,
    statusLabel: statusLabel,
    quotes: list,
  };
}

/**
 * Fetches live/today prices from 4 authoritative sources and reconciles them.
 * @param {string} ticker
 * @param {string} market
 * @param {number|null} googleFinancePrice Pre-evaluated from Sheet =GOOGLEFINANCE(...) cell
 * @param {Object} deps Optional injected dependencies for testing
 */
function fetchAndReconcileLiveTicker(ticker, market, googleFinancePrice, deps) {
  const todayYmd = parseDateParts(new Date()).ymd;
  const gfNum = parsePositivePrice(googleFinancePrice);
  const q1 = {
    source: 'GoogleFinance',
    ok: gfNum !== null,
    price: gfNum,
    tradingDate: gfNum !== null ? todayYmd : null,
    latencyMs: 0,
    error: gfNum !== null ? null : 'GOOGLEFINANCE cell unavailable',
  };
  const q2 = fetchYahooLiveQuote(ticker, market, deps);
  const q3 = fetchExchangeOfficialLiveQuote(ticker, market, deps);
  const q4 = fetchFinMindLatestClose(ticker, market, todayYmd, deps);

  const result = reconcilePrices([q1, q2, q3, q4], 'LIVE');
  result.ticker = ticker;
  result.market = market;
  result.bySource = {
    googleFinance: q1,
    yahooFinance: q2,
    exchangeOfficial: q3,
    finMind: q4,
  };
  return result;
}

/**
 * Fetches historical closing prices on (or immediately prior to) targetDate from 4 sources and reconciles them.
 */
function fetchAndReconcileHistoricalTicker(ticker, market, targetDate, googleFinanceHistPrice, deps) {
  const targetYmd = parseDateParts(targetDate).ymd;
  const gfNum = parsePositivePrice(googleFinanceHistPrice);
  const q1 = {
    source: 'GoogleFinance',
    ok: gfNum !== null,
    price: gfNum,
    tradingDate: gfNum !== null ? targetYmd : null,
    latencyMs: 0,
    error: gfNum !== null ? null : 'GOOGLEFINANCE historical unavailable',
  };
  const q2 = fetchYahooHistoricalClose(ticker, market, targetYmd, deps);
  const q3 = fetchExchangeOfficialHistoricalClose(ticker, market, targetYmd, deps);
  const q4 = fetchFinMindLatestClose(ticker, market, targetYmd, deps);

  // Align GoogleFinance date to consensus date if GF returned valid number on weekend/holiday lookup
  if (q1.ok) {
    const refDates = [q2, q3, q4].filter(function (x) { return x.ok && x.tradingDate; }).map(function (x) { return x.tradingDate; });
    if (refDates.length > 0) {
      q1.tradingDate = refDates[0];
    }
  }

  const result = reconcilePrices([q1, q2, q3, q4], 'HISTORICAL');
  result.ticker = ticker;
  result.market = market;
  result.requestedDate = targetYmd;
  result.bySource = {
    googleFinance: q1,
    yahooFinance: q2,
    exchangeOfficial: q3,
    finMind: q4,
  };
  return result;
}

/**
 * Aligns multi-day historical series across GoogleFinance map, Yahoo, TWSE/TPEx/Stooq, and FinMind,
 * performing day-by-day 3+ source reconciliation.
 * @param {string} ticker
 * @param {string} market
 * @param {string} startDate
 * @param {string} endDate
 * @param {Object.<string, number>} googleFinanceSeriesMap Optional map { 'YYYY-MM-DD': close }
 * @param {Object} deps
 */
function trackAndReconcileHistoricalRange(ticker, market, startDate, endDate, googleFinanceSeriesMap, deps) {
  const gfMap = googleFinanceSeriesMap || {};
  const yfRes = fetchYahooHistoricalSeries(ticker, market, startDate, endDate, deps);
  const exRes = fetchExchangeOfficialHistoricalSeries(ticker, market, startDate, endDate, deps);
  const fmRes = fetchFinMindHistoricalSeries(ticker, market, startDate, endDate, deps);

  const mapBySource = {
    GoogleFinance: gfMap,
    YahooFinance: {},
    ExchangeOfficial: {},
    FinMind: {},
  };
  const allDatesSet = {};

  Object.keys(gfMap).forEach(function (d) { allDatesSet[d] = true; });
  (yfRes.series || []).forEach(function (pt) { mapBySource.YahooFinance[pt.date] = pt.close; allDatesSet[pt.date] = true; });
  (exRes.series || []).forEach(function (pt) { mapBySource.ExchangeOfficial[pt.date] = pt.close; allDatesSet[pt.date] = true; });
  (fmRes.series || []).forEach(function (pt) { mapBySource.FinMind[pt.date] = pt.close; allDatesSet[pt.date] = true; });

  const dates = Object.keys(allDatesSet).sort();
  const dailyRows = [];
  let verifiedDays = 0;
  let discrepancyDays = 0;

  for (let i = 0; i < dates.length; i++) {
    const dt = dates[i];
    const quotes = [
      { source: 'GoogleFinance', ok: parsePositivePrice(mapBySource.GoogleFinance[dt]) !== null, price: mapBySource.GoogleFinance[dt] || null, tradingDate: dt },
      { source: 'YahooFinance', ok: parsePositivePrice(mapBySource.YahooFinance[dt]) !== null, price: mapBySource.YahooFinance[dt] || null, tradingDate: dt },
      { source: exRes.source || 'TWSE/TPEx', ok: parsePositivePrice(mapBySource.ExchangeOfficial[dt]) !== null, price: mapBySource.ExchangeOfficial[dt] || null, tradingDate: dt },
      { source: 'FinMind', ok: parsePositivePrice(mapBySource.FinMind[dt]) !== null, price: mapBySource.FinMind[dt] || null, tradingDate: dt },
    ];
    const rec = reconcilePrices(quotes, 'HISTORICAL');
    if (rec.statusCode === 'VERIFIED') verifiedDays++;
    if (rec.statusCode === 'DISCREPANCY') discrepancyDays++;

    dailyRows.push({
      date: dt,
      ticker: ticker,
      market: market,
      googleFinance: quotes[0].ok ? quotes[0].price : null,
      yahooFinance: quotes[1].ok ? quotes[1].price : null,
      exchangeOfficial: quotes[2].ok ? quotes[2].price : null,
      finMind: quotes[3].ok ? quotes[3].price : null,
      validSourceCount: rec.validSourceCount,
      consensusPrice: rec.consensusPrice,
      spreadPct: rec.spreadPct,
      statusCode: rec.statusCode,
      statusLabel: rec.statusLabel,
      outlierSource: rec.outlierSource,
    });
  }

  return {
    ticker: ticker,
    market: market,
    startDate: parseDateParts(startDate).ymd,
    endDate: parseDateParts(endDate).ymd,
    totalTradingDays: dailyRows.length,
    verifiedDays: verifiedDays,
    discrepancyDays: discrepancyDays,
    sourceMeta: [
      { source: 'YahooFinance', ok: yfRes.ok, latencyMs: yfRes.latencyMs, error: yfRes.error },
      { source: exRes.source || 'TWSE/TPEx', ok: exRes.ok, latencyMs: exRes.latencyMs, error: exRes.error },
      { source: 'FinMind', ok: fmRes.ok, latencyMs: fmRes.latencyMs, error: fmRes.error },
    ],
    rows: dailyRows,
  };
}

/**
 * Computes Layer 5 Stability & Performance SLA telemetry statistics.
 * @param {Array<{ok: boolean, latencyMs: number}>} records
 */
function computeTelemetryMetrics(records) {
  const list = Array.isArray(records) ? records : [];
  if (list.length === 0) {
    return { total: 0, successes: 0, successRate: 1, avgMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0 };
  }
  let successes = 0;
  const latencies = [];
  for (let i = 0; i < list.length; i++) {
    if (list[i].ok) successes++;
    latencies.push(Math.max(0, Number(list[i].latencyMs || 0)));
  }
  latencies.sort(function (a, b) { return a - b; });
  const sum = latencies.reduce(function (a, b) { return a + b; }, 0);
  const percentile = function (p) {
    const idx = Math.min(latencies.length - 1, Math.max(0, Math.ceil((p / 100) * latencies.length) - 1));
    return latencies[idx];
  };
  return {
    total: list.length,
    successes: successes,
    successRate: successes / list.length,
    avgMs: Number((sum / list.length).toFixed(2)),
    p50Ms: percentile(50),
    p95Ms: percentile(95),
    p99Ms: percentile(99),
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    computeMedian,
    reconcilePrices,
    fetchAndReconcileLiveTicker,
    fetchAndReconcileHistoricalTicker,
    trackAndReconcileHistoricalRange,
    computeTelemetryMetrics,
  };
}
