/**
 * @fileoverview Canonical shared configuration for both Cloudflare Web App and core verification.
 * Maintains 100% parity with gas/Config.gs default Beta table, tolerances, and security allowlists.
 */

export const WEB_CONFIG = Object.freeze({
  APP_NAME: 'Die With Zero × Portfolio Beta 計算機',
  VERSION: '2.0.0',
  VAULT_SCHEMA_VERSION: 1,
  TIMEZONE: 'Asia/Taipei',

  DEFAULT_BETA_PRESETS: Object.freeze([
    Object.freeze({ ticker: '0050', market: 'TWSE', name: '元大台灣50', beta: 1, currency: 'TWD', note: '台灣市值型 ETF (預設 Beta=1)' }),
    Object.freeze({ ticker: '006208', market: 'TWSE', name: '富邦台50', beta: 1, currency: 'TWD', note: '台灣市值型 ETF (預設 Beta=1)' }),
    Object.freeze({ ticker: '00662', market: 'TWSE', name: '富邦NASDAQ', beta: 1, currency: 'TWD', note: '美國那斯達克100 ETF (預設 Beta=1)' }),
    Object.freeze({ ticker: '00685L', market: 'TWSE', name: '群益臺灣加權正2', beta: 2, currency: 'TWD', note: '台股單日正向2倍槓桿 ETF (預設 Beta=2)' }),
    Object.freeze({ ticker: '00631L', market: 'TWSE', name: '元大台灣50正2', beta: 2, currency: 'TWD', note: '台灣50單日正向2倍槓桿 ETF (預設 Beta=2)' }),
    Object.freeze({ ticker: 'CASH', market: 'CASH', name: '現金 Cash', beta: 0, currency: 'TWD', note: '現金 / 活定存無風險部位 (預設 Beta=0)' }),
  ]),

  SAMPLE_DUMMY_HOLDINGS: Object.freeze([
    Object.freeze({ ticker: '0050', market: 'TWSE', name: '元大台灣50', shares: 10000, currency: 'TWD', price: 195.5, customBeta: '' }),
    Object.freeze({ ticker: '006208', market: 'TWSE', name: '富邦台50', shares: 5000, currency: 'TWD', price: 112.4, customBeta: '' }),
    Object.freeze({ ticker: '00662', market: 'TWSE', name: '富邦NASDAQ', shares: 5000, currency: 'TWD', price: 88.0, customBeta: '' }),
    Object.freeze({ ticker: '00685L', market: 'TWSE', name: '群益臺灣加權正2', shares: 3000, currency: 'TWD', price: 85.0, customBeta: '' }),
    Object.freeze({ ticker: '00631L', market: 'TWSE', name: '元大台灣50正2', shares: 5000, currency: 'TWD', price: 248.55, customBeta: '' }),
    Object.freeze({ ticker: 'CASH', market: 'CASH', name: '現金 Cash', shares: 1500000, currency: 'TWD', price: 1.0, customBeta: '' }),
  ]),

  FIRE_DEFAULTS: Object.freeze({
    status: '還在工作',
    currentAge: 35,
    retireAge: 55,
    lifeExpectancy: 85,
    netWorthMode: '連動持倉總市值',
    manualNetWorth: 5000000,
    monthlySavings: 50000,
    monthlySpending: 60000,
    monthlyPension: 0,
    pensionStartAge: 65,
    nominalReturn: 0.07,
    inflationRate: 0.03,
    classicFireSwr: 0.04,
    capmRiskFreeRate: 0.015,
    capmEquityRiskPremium: 0.055,
  }),

  RECONCILIATION: Object.freeze({
    MIN_REQUIRED_SOURCES: 3,
    HISTORICAL_VERIFIED_SPREAD_PCT: 0.001,
    HISTORICAL_VERIFIED_ABS_DIFF: 0.05,
    HISTORICAL_MINOR_SPREAD_PCT: 0.01,
    LIVE_VERIFIED_SPREAD_PCT: 0.005,
    LIVE_MINOR_SPREAD_PCT: 0.02,
  }),

  CACHE_TTL_SEC: Object.freeze({
    LIVE_QUOTE: 60,
    FX_RATE: 300,
    MARKET_SNAPSHOT: 600,
  }),

  RETRY_POLICY: Object.freeze({
    MAX_ATTEMPTS: 3,
    BASE_DELAY_MS: 250,
    SLA_COMPUTE_P95_MS: 200,
    SLA_CACHE_HIT_P95_MS: 150,
    SLA_LIVE_FETCH_P95_MS: 2500,
    SLA_MIN_SUCCESS_RATE: 0.98,
  }),

  SECURITY: Object.freeze({
    ALLOWED_HOSTS: Object.freeze([
      'query1.finance.yahoo.com',
      'query2.finance.yahoo.com',
      'www.twse.com.tw',
      'openapi.twse.com.tw',
      'mis.twse.com.tw',
      'www.tpex.org.tw',
      'api.finmindtrade.com',
      'api.fugle.tw',
      'stooq.com',
      'api.twelvedata.com',
      'finnhub.io',
      'script.google.com',
      'script.googleusercontent.com',
    ]),
    TICKER_REGEX: /^[A-Z0-9.\-]{1,12}$/,
    MAX_BATCH_TICKERS: 25,
    MAX_HISTORY_DAYS: 366,
    MAX_VAULT_BYTES: 262144, // 256 KB generous limit for portfolio JSON
  }),
});

export function normalizeAndValidateTicker(rawTicker) {
  if (rawTicker === null || rawTicker === undefined) {
    throw new Error('Ticker cannot be empty.');
  }
  const cleaned = String(rawTicker).trim().toUpperCase();
  if (cleaned === '現金' || cleaned === '現金CASH' || cleaned === '現金 CASH') {
    return 'CASH';
  }
  if (!WEB_CONFIG.SECURITY.TICKER_REGEX.test(cleaned)) {
    throw new Error(`Invalid ticker format: "${cleaned}". Allowed: A-Z, 0-9, ., - (max 12 chars).`);
  }
  return cleaned;
}

export function normalizeMarket(rawMarket, ticker = '') {
  const t = String(ticker || '').trim().toUpperCase();
  const m = String(rawMarket || '').trim().toUpperCase();
  if (t === 'CASH' || m === 'CASH') return 'CASH';
  if (m === 'TWSE' || m === 'TPEX' || m === 'US') return m;
  return /^\d{4,6}[A-Z]?$/.test(t) ? 'TWSE' : 'US';
}

export function validateAllowedUrl(url) {
  if (typeof url !== 'string' || !url.startsWith('https://')) {
    throw new Error('SecurityError: Only HTTPS URLs are permitted.');
  }
  if (/[\r\n]/.test(url)) {
    throw new Error('SecurityError: Control characters detected in URL.');
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('SecurityError: Malformed URL.');
  }
  const host = parsed.hostname.toLowerCase();
  if (!WEB_CONFIG.SECURITY.ALLOWED_HOSTS.includes(host)) {
    throw new Error(`SecurityError: Host "${host}" is not in the approved allowlist.`);
  }
  return url;
}

export function sanitizeCsvCell(value) {
  if (value === null || value === undefined) return '';
  const str = String(value).replace(/[\r\n\t]+/g, ' ').trim();
  if (!str) return '';
  const first = str.charAt(0);
  if (first === '=' || first === '+' || first === '-' || first === '@') {
    return "'" + str;
  }
  return str;
}

export function getDefaultBetaMap(customPresets = null) {
  const map = {};
  for (const item of WEB_CONFIG.DEFAULT_BETA_PRESETS) {
    map[item.ticker] = item.beta;
  }
  if (customPresets && typeof customPresets === 'object') {
    for (const [k, v] of Object.entries(customPresets)) {
      if (Number.isFinite(Number(v))) {
        map[String(k).trim().toUpperCase()] = Number(v);
      }
    }
  }
  return map;
}
