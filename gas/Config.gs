/**
 * @fileoverview Global configuration, constants, default Beta mapping,
 * security allowlists, and SLA thresholds for Die With Zero & Portfolio Beta Calculator.
 * Compatible with both Google Apps Script (V8) and Node.js test runner.
 */

const APP_CONFIG = Object.freeze({
  APP_NAME: 'Die With Zero × Portfolio Beta 計算機',
  VERSION: '1.0.0',
  TIMEZONE: 'Asia/Taipei',

  SHEETS: Object.freeze({
    DASHBOARD: '📊 FIRE儀表板',
    PORTFOLIO: '💼 持倉與Beta',
    RECONCILIATION: '🔍 多源股價校對',
    HISTORY: '📈 歷史股價追蹤',
    SETTINGS: '⚙️ 預設Beta與參數',
    SIMULATION: '📉 逐年資產模擬',
    LOGS: '🛡️ 驗證與監控日誌',
  }),

  /**
   * Required default Beta presets per specification:
   * 0050: 1, 006208: 1, 00662: 1, 00685L: 2, 00631L: 2, CASH: 0
   */
  DEFAULT_BETA_PRESETS: Object.freeze([
    Object.freeze({ ticker: '0050', market: 'TWSE', name: '元大台灣50', beta: 1, currency: 'TWD', note: '台灣市值型 ETF (預設 Beta=1)' }),
    Object.freeze({ ticker: '006208', market: 'TWSE', name: '富邦台50', beta: 1, currency: 'TWD', note: '台灣市值型 ETF (預設 Beta=1)' }),
    Object.freeze({ ticker: '00662', market: 'TWSE', name: '富邦NASDAQ', beta: 1, currency: 'TWD', note: '美國那斯達克100 ETF (預設 Beta=1)' }),
    Object.freeze({ ticker: '00685L', market: 'TWSE', name: '群益臺灣加權正2', beta: 2, currency: 'TWD', note: '台股單日正向2倍槓桿 ETF (預設 Beta=2)' }),
    Object.freeze({ ticker: '00631L', market: 'TWSE', name: '元大台灣50正2', beta: 2, currency: 'TWD', note: '台灣50單日正向2倍槓桿 ETF (預設 Beta=2)' }),
    Object.freeze({ ticker: 'CASH', market: 'CASH', name: '現金 Cash', beta: 0, currency: 'TWD', note: '現金 / 活定存無風險部位 (預設 Beta=0)' }),
  ]),

  /**
   * Default Die With Zero parameters aligned with alphalab.site/fire
   */
  FIRE_DEFAULTS: Object.freeze({
    STATUS: '還在工作', // '還在工作' | '已經退休'
    CURRENT_AGE: 35,
    RETIRE_AGE: 55,
    LIFE_EXPECTANCY: 85, // Conservative upper side per Taiwan MOI life table
    NET_WORTH_MODE: '連動持倉總市值', // '連動持倉總市值' | '手動輸入'
    MANUAL_NET_WORTH: 5000000,
    MONTHLY_SAVINGS: 50000,
    MONTHLY_SPENDING: 60000,
    MONTHLY_PENSION: 0, // AlphaLab default excludes pension for conservative planning
    PENSION_START_AGE: 65,
    NOMINAL_RETURN: 0.07, // 7.0%
    INFLATION_RATE: 0.03, // 3.0%
    CLASSIC_FIRE_SWR: 0.04, // 4.0% (25x rule)
    CAPM_RISK_FREE_RATE: 0.015, // 1.5%
    CAPM_EQUITY_RISK_PREMIUM: 0.055, // 5.5% -> Beta=1 => 7.0%
  }),

  /**
   * Multi-source reconciliation tolerances & SLA thresholds
   */
  RECONCILIATION: Object.freeze({
    MIN_REQUIRED_SOURCES: 3,
    HISTORICAL_VERIFIED_SPREAD_PCT: 0.001, // 0.1%
    HISTORICAL_VERIFIED_ABS_DIFF: 0.05, // 0.05 TWD/USD rounding grace
    HISTORICAL_MINOR_SPREAD_PCT: 0.01, // 1.0%
    LIVE_VERIFIED_SPREAD_PCT: 0.005, // 0.5% (accounts for 15-20m GF delay)
    LIVE_MINOR_SPREAD_PCT: 0.02, // 2.0%
    OUTLIER_Z_DEVIATION_PCT: 0.005, // >0.5% off median flagged when spread breached
  }),

  /**
   * Cache TTLs (seconds) & retry policy (Layer 5 Stability & Performance)
   */
  CACHE_TTL_SEC: Object.freeze({
    LIVE_QUOTE: 60,
    MARKET_SNAPSHOT: 600, // TWSE/TPEx all-market daily snapshot
    HISTORICAL_CLOSE: 21600, // 6 hours (GAS max CacheService TTL)
  }),

  RETRY_POLICY: Object.freeze({
    MAX_ATTEMPTS: 3,
    BASE_DELAY_MS: 300,
    TWSE_THROTTLE_MS: 350,
    SLA_COMPUTE_P95_MS: 200,
    SLA_FETCH_P95_MS: 3000,
    SLA_MIN_SUCCESS_RATE: 0.98,
  }),

  /**
   * Security controls (Layer 4 Security & Governance)
   */
  SECURITY: Object.freeze({
    ALLOWED_HOSTS: Object.freeze([
      'query1.finance.yahoo.com',
      'query2.finance.yahoo.com',
      'www.twse.com.tw',
      'openapi.twse.com.tw',
      'mis.twse.com.tw',
      'www.tpex.org.tw',
      'api.finmindtrade.com',
      'stooq.com',
    ]),
    TICKER_REGEX: /^[A-Z0-9.\-]{1,12}$/,
    MAX_PORTFOLIO_ROWS: 42,
    MAX_HISTORY_DAYS: 366,
  }),
});

/**
 * Validates and normalizes a ticker symbol to prevent injection and malformed requests.
 * @param {string} rawTicker
 * @return {string} Normalized uppercase ticker
 */
function normalizeAndValidateTicker(rawTicker) {
  if (rawTicker === null || rawTicker === undefined) {
    throw new Error('Ticker cannot be empty.');
  }
  const cleaned = String(rawTicker).trim().toUpperCase();
  if (cleaned === '現金' || cleaned === '現金CASH' || cleaned === '現金 CASH') {
    return 'CASH';
  }
  if (!APP_CONFIG.SECURITY.TICKER_REGEX.test(cleaned)) {
    throw new Error('Invalid ticker format: "' + cleaned + '". Allowed: A-Z, 0-9, ., - (max 12 chars).');
  }
  return cleaned;
}

/**
 * Validates that an outbound URL uses HTTPS and matches the strict host allowlist (SSRF protection).
 * @param {string} url
 * @return {string} Validated URL
 */
function validateAllowedUrl(url) {
  if (typeof url !== 'string' || !url.startsWith('https://')) {
    throw new Error('SecurityError: Only HTTPS URLs are permitted.');
  }
  const match = url.match(/^https:\/\/([a-zA-Z0-9.-]+)(?::\d+)?(\/|\?|$)/);
  if (!match) {
    throw new Error('SecurityError: Malformed URL.');
  }
  const host = match[1].toLowerCase();
  if (APP_CONFIG.SECURITY.ALLOWED_HOSTS.indexOf(host) === -1) {
    throw new Error('SecurityError: Host "' + host + '" is not in the approved allowlist.');
  }
  if (/[\r\n]/.test(url)) {
    throw new Error('SecurityError: Control characters detected in URL.');
  }
  return url;
}

/**
 * Sanitizes untrusted text before writing into Google Sheets cells to prevent Formula Injection.
 * @param {*} value
 * @return {string}
 */
function sanitizeSheetText(value) {
  if (value === null || value === undefined) {
    return '';
  }
  const str = String(value).replace(/[\r\n\t]+/g, ' ').trim();
  if (str.length === 0) {
    return '';
  }
  const firstChar = str.charAt(0);
  if (firstChar === '=' || firstChar === '+' || firstChar === '-' || firstChar === '@') {
    return "'" + str;
  }
  return str;
}

/**
 * Builds a lookup map of default Beta presets keyed by normalized uppercase ticker.
 * @return {Object.<string, number>}
 */
function getDefaultBetaMap() {
  const map = {};
  for (let i = 0; i < APP_CONFIG.DEFAULT_BETA_PRESETS.length; i++) {
    const item = APP_CONFIG.DEFAULT_BETA_PRESETS[i];
    map[item.ticker] = item.beta;
  }
  return map;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    APP_CONFIG,
    normalizeAndValidateTicker,
    validateAllowedUrl,
    sanitizeSheetText,
    getDefaultBetaMap,
  };
}
