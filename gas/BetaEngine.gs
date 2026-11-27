/**
 * @fileoverview Portfolio valuation, weighted Beta calculation, custom ticker Beta resolution,
 * and market shock stress testing engine.
 */

if (typeof APP_CONFIG === 'undefined' && typeof require !== 'undefined') {
  var _cfg = require('./Config.gs');
  var APP_CONFIG = _cfg.APP_CONFIG;
  var normalizeAndValidateTicker = _cfg.normalizeAndValidateTicker;
  var getDefaultBetaMap = _cfg.getDefaultBetaMap;
}

/**
 * Resolves effective Beta for a single holding.
 * Priority:
 *  1. User explicit custom override Beta (if valid finite number)
 *  2. Preset Beta map (user-editable settings sheet + mandatory defaults)
 *  3. Cash market => 0
 *  4. Unmapped custom equity fallback => 1.0 (flagged as fallback so user knows to review)
 *
 * @param {string} ticker
 * @param {string} market
 * @param {*} customOverrideBeta
 * @param {Object.<string, number>} betaMap
 * @return {{defaultBeta: (number|null), effectiveBeta: number, source: string}}
 */
function resolveHoldingBeta(ticker, market, customOverrideBeta, betaMap) {
  const map = betaMap || getDefaultBetaMap();
  const normalizedMarket = String(market || '').trim().toUpperCase();
  const defaultBeta = Object.prototype.hasOwnProperty.call(map, ticker)
    ? Number(map[ticker])
    : (normalizedMarket === 'CASH' || ticker === 'CASH' ? 0 : null);

  const hasOverride =
    customOverrideBeta !== null &&
    customOverrideBeta !== undefined &&
    customOverrideBeta !== '' &&
    Number.isFinite(Number(customOverrideBeta));

  if (hasOverride) {
    return {
      defaultBeta: defaultBeta,
      effectiveBeta: Number(customOverrideBeta),
      source: 'CUSTOM_OVERRIDE',
    };
  }
  if (defaultBeta !== null && Number.isFinite(defaultBeta)) {
    return {
      defaultBeta: defaultBeta,
      effectiveBeta: defaultBeta,
      source: 'PRESET',
    };
  }
  return {
    defaultBeta: null,
    effectiveBeta: 1.0,
    source: 'FALLBACK_DEFAULT_1',
  };
}

/**
 * Computes full portfolio summary, per-holding weights, overall Beta (with & without Cash),
 * equivalent market exposure (Beta=1 TWD), and crash/rally stress test scenarios.
 *
 * @param {Array<Object>} holdings Array of {ticker, market, name, shares, currency, price, customBeta}
 * @param {Object} options {usdTwdRate?: number, betaMap?: Object.<string, number>}
 * @return {Object}
 */
function calculatePortfolioBeta(holdings, options) {
  const opts = options || {};
  const usdTwdRate = Number.isFinite(Number(opts.usdTwdRate)) && Number(opts.usdTwdRate) > 0
    ? Number(opts.usdTwdRate)
    : 32.0;
  const betaMap = opts.betaMap || getDefaultBetaMap();

  const evaluated = [];
  let totalValueTwd = 0;
  let equityValueTwd = 0;
  let cashValueTwd = 0;
  let totalWeightedExposureTwd = 0;
  let equityWeightedExposureTwd = 0;

  const list = Array.isArray(holdings) ? holdings : [];
  for (let i = 0; i < list.length; i++) {
    const raw = list[i];
    if (!raw || !raw.ticker || String(raw.ticker).trim() === '') {
      continue;
    }
    const ticker = normalizeAndValidateTicker(raw.ticker);
    const market = String(raw.market || (ticker === 'CASH' ? 'CASH' : 'TWSE')).trim().toUpperCase();
    const shares = Number(raw.shares || 0);
    if (!Number.isFinite(shares) || shares < 0) {
      throw new Error('Shares/Amount must be a non-negative number for ticker: ' + ticker);
    }
    const currency = String(raw.currency || (market === 'US' ? 'USD' : 'TWD')).trim().toUpperCase();
    const fxRate = currency === 'USD' ? usdTwdRate : 1.0;
    const price = market === 'CASH' || ticker === 'CASH' ? 1.0 : Number(raw.price || 0);
    if (!Number.isFinite(price) || price < 0) {
      throw new Error('Price must be a non-negative number for ticker: ' + ticker);
    }

    const marketValueTwd = shares * price * fxRate;
    const betaInfo = resolveHoldingBeta(ticker, market, raw.customBeta, betaMap);
    const exposureTwd = marketValueTwd * betaInfo.effectiveBeta;

    totalValueTwd += marketValueTwd;
    totalWeightedExposureTwd += exposureTwd;

    if (market === 'CASH' || ticker === 'CASH') {
      cashValueTwd += marketValueTwd;
    } else {
      equityValueTwd += marketValueTwd;
      equityWeightedExposureTwd += exposureTwd;
    }

    evaluated.push({
      ticker: ticker,
      market: market,
      name: raw.name ? String(raw.name) : ticker,
      shares: shares,
      currency: currency,
      fxRate: fxRate,
      price: price,
      marketValueTwd: marketValueTwd,
      defaultBeta: betaInfo.defaultBeta,
      effectiveBeta: betaInfo.effectiveBeta,
      betaSource: betaInfo.source,
      exposureTwd: exposureTwd,
      weight: 0,
      weightedBetaContribution: 0,
    });
  }

  for (let j = 0; j < evaluated.length; j++) {
    const row = evaluated[j];
    row.weight = totalValueTwd > 0 ? row.marketValueTwd / totalValueTwd : 0;
    row.weightedBetaContribution = row.weight * row.effectiveBeta;
  }

  const overallPortfolioBeta = totalValueTwd > 0 ? totalWeightedExposureTwd / totalValueTwd : 0;
  const equityOnlyBeta = equityValueTwd > 0 ? equityWeightedExposureTwd / equityValueTwd : 0;
  const cashRatio = totalValueTwd > 0 ? cashValueTwd / totalValueTwd : 0;

  // Stress test scenarios
  const shocks = [
    { label: '極端股災 (-50%)', marketMove: -0.50 },
    { label: '深度熊市 (-30%)', marketMove: -0.30 },
    { label: '技術熊市 (-20%)', marketMove: -0.20 },
    { label: '健康回檔 (-10%)', marketMove: -0.10 },
    { label: '溫和上漲 (+15%)', marketMove: 0.15 },
    { label: '多頭強漲 (+30%)', marketMove: 0.30 },
  ];

  const stressTests = shocks.map(function (s) {
    const estPctChange = Math.max(-1.0, s.marketMove * overallPortfolioBeta);
    const estValueChange = totalValueTwd * estPctChange;
    const postShockValue = Math.max(0, totalValueTwd + estValueChange);
    return {
      label: s.label,
      marketMove: s.marketMove,
      estimatedPortfolioMove: estPctChange,
      estimatedValueChangeTwd: estValueChange,
      postShockValueTwd: postShockValue,
    };
  });

  return {
    holdings: evaluated,
    totalValueTwd: totalValueTwd,
    equityValueTwd: equityValueTwd,
    cashValueTwd: cashValueTwd,
    cashRatio: cashRatio,
    overallPortfolioBeta: overallPortfolioBeta,
    equityOnlyBeta: equityOnlyBeta,
    equivalentMarketExposureTwd: totalWeightedExposureTwd,
    stressTests: stressTests,
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    resolveHoldingBeta,
    calculatePortfolioBeta,
  };
}
