/**
 * @fileoverview Portfolio valuation, weighted overall Beta calculation,
 * custom ticker Beta override resolution, and crash stress testing engine.
 */

import { getDefaultBetaMap, normalizeAndValidateTicker, normalizeMarket } from './config.mjs';

export function resolveHoldingBeta(ticker, market, customOverrideBeta, betaMap) {
  const map = betaMap || getDefaultBetaMap();
  const normalizedMarket = normalizeMarket(market, ticker);
  const defaultBeta = Object.prototype.hasOwnProperty.call(map, ticker)
    ? Number(map[ticker])
    : (normalizedMarket === 'CASH' || ticker === 'CASH' ? 0 : null);

  const hasOverride =
    customOverrideBeta !== null &&
    customOverrideBeta !== undefined &&
    customOverrideBeta !== '' &&
    Number.isFinite(Number(customOverrideBeta));

  if (hasOverride) {
    return { defaultBeta, effectiveBeta: Number(customOverrideBeta), source: 'CUSTOM_OVERRIDE' };
  }
  if (defaultBeta !== null && Number.isFinite(defaultBeta)) {
    return { defaultBeta, effectiveBeta: defaultBeta, source: 'PRESET' };
  }
  return { defaultBeta: null, effectiveBeta: 1.0, source: 'FALLBACK_DEFAULT_1' };
}

export function calculatePortfolioBeta(holdings, options = {}) {
  const usdTwdRate = Number.isFinite(Number(options.usdTwdRate)) && Number(options.usdTwdRate) > 0
    ? Number(options.usdTwdRate)
    : 32.0;
  const betaMap = options.betaMap || getDefaultBetaMap();

  const evaluated = [];
  let totalValueTwd = 0;
  let equityValueTwd = 0;
  let cashValueTwd = 0;
  let totalWeightedExposureTwd = 0;
  let equityWeightedExposureTwd = 0;

  for (const raw of Array.isArray(holdings) ? holdings : []) {
    if (!raw || !raw.ticker || String(raw.ticker).trim() === '') continue;
    const ticker = normalizeAndValidateTicker(raw.ticker);
    const market = normalizeMarket(raw.market, ticker);
    const shares = Number(raw.shares || 0);
    if (!Number.isFinite(shares) || shares < 0) {
      throw new Error(`Shares/Amount must be non-negative for ticker: ${ticker}`);
    }
    const currency = String(raw.currency || (market === 'US' ? 'USD' : 'TWD')).trim().toUpperCase();
    const fxRate = currency === 'USD' ? usdTwdRate : 1.0;
    const price = market === 'CASH' || ticker === 'CASH' ? 1.0 : Number(raw.price || 0);
    if (!Number.isFinite(price) || price < 0) {
      throw new Error(`Price must be non-negative for ticker: ${ticker}`);
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
      ticker,
      market,
      name: raw.name ? String(raw.name) : ticker,
      shares,
      currency,
      fxRate,
      price,
      marketValueTwd,
      defaultBeta: betaInfo.defaultBeta,
      effectiveBeta: betaInfo.effectiveBeta,
      betaSource: betaInfo.source,
      exposureTwd,
      weight: 0,
      weightedBetaContribution: 0,
    });
  }

  for (const row of evaluated) {
    row.weight = totalValueTwd > 0 ? row.marketValueTwd / totalValueTwd : 0;
    row.weightedBetaContribution = row.weight * row.effectiveBeta;
  }

  const overallPortfolioBeta = totalValueTwd > 0 ? totalWeightedExposureTwd / totalValueTwd : 0;
  const equityOnlyBeta = equityValueTwd > 0 ? equityWeightedExposureTwd / equityValueTwd : 0;
  const cashRatio = totalValueTwd > 0 ? cashValueTwd / totalValueTwd : 0;

  const shocks = [
    { label: '極端股災 (-50%)', marketMove: -0.50 },
    { label: '深度熊市 (-30%)', marketMove: -0.30 },
    { label: '技術熊市 (-20%)', marketMove: -0.20 },
    { label: '健康回檔 (-10%)', marketMove: -0.10 },
    { label: '溫和上漲 (+15%)', marketMove: 0.15 },
    { label: '多頭強漲 (+30%)', marketMove: 0.30 },
  ];

  const stressTests = shocks.map((s) => {
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
    totalValueTwd,
    equityValueTwd,
    cashValueTwd,
    cashRatio,
    overallPortfolioBeta,
    equityOnlyBeta,
    equivalentMarketExposureTwd: totalWeightedExposureTwd,
    stressTests,
  };
}
