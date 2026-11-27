/**
 * @fileoverview Multi-source authoritative stock price adapters supporting:
 *  - Source 1: Google Finance (via Sheet GOOGLEFINANCE formula bridge)
 *  - Source 2: Yahoo Finance Chart API v8 (query1 + query2 failover; Live & Unadjusted Historical Close)
 *  - Source 3: TWSE MIS + TWSE OpenAPI / STOCK_DAY + TPEx OpenAPI / tradingStock (Taiwan)
 *              and Stooq CSV (US)
 *  - Source 4: FinMind Open Financial API (TaiwanStockPrice / USStockPrice)
 *
 * Security: Strict HTTPS + host allowlist via validateAllowedUrl(), strict ticker validation,
 * zero hardcoded secrets (optional FinMind token from ScriptProperties).
 * Stability: CacheService caching, exponential backoff retries, TWSE rate-limit throttling,
 * full latency & status telemetry per request.
 */

if (typeof APP_CONFIG === 'undefined' && typeof require !== 'undefined') {
  var _cfg = require('./Config.gs');
  var APP_CONFIG = _cfg.APP_CONFIG;
  var normalizeAndValidateTicker = _cfg.normalizeAndValidateTicker;
  var validateAllowedUrl = _cfg.validateAllowedUrl;
}

// In-memory request-scope snapshot cache (avoids redundant fetches within a single GAS execution)
var _MEMORY_CACHE = {};

/**
 * Formats a Date or YYYY-MM-DD string into canonical Taipei calendar date parts.
 * @param {Date|string} input
 * @return {{year: number, month: number, day: number, ymd: string, yyyymmdd: string, yyyymm01: string}}
 */
function parseDateParts(input) {
  let y, m, d;
  if (typeof input === 'string') {
    const trimmed = input.trim();
    const match = trimmed.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
    if (match) {
      y = parseInt(match[1], 10);
      m = parseInt(match[2], 10);
      d = parseInt(match[3], 10);
    } else {
      const parsed = new Date(trimmed);
      if (isNaN(parsed.getTime())) {
        throw new Error('Invalid date string: ' + input);
      }
      const shifted = new Date(parsed.getTime() + 8 * 3600 * 1000);
      y = shifted.getUTCFullYear();
      m = shifted.getUTCMonth() + 1;
      d = shifted.getUTCDate();
    }
  } else if (input instanceof Date && !isNaN(input.getTime())) {
    const shifted = new Date(input.getTime() + 8 * 3600 * 1000);
    y = shifted.getUTCFullYear();
    m = shifted.getUTCMonth() + 1;
    d = shifted.getUTCDate();
  } else {
    const nowShifted = new Date(Date.now() + 8 * 3600 * 1000);
    y = nowShifted.getUTCFullYear();
    m = nowShifted.getUTCMonth() + 1;
    d = nowShifted.getUTCDate();
  }
  const mm = String(m).padStart(2, '0');
  const dd = String(d).padStart(2, '0');
  return {
    year: y,
    month: m,
    day: d,
    ymd: y + '-' + mm + '-' + dd,
    yyyymmdd: '' + y + mm + dd,
    yyyymm01: '' + y + mm + '01',
  };
}

/**
 * Adds deltaDays to a YYYY-MM-DD string and returns parseDateParts().
 * @param {string|Date} baseDate
 * @param {number} deltaDays
 */
function shiftDateParts(baseDate, deltaDays) {
  const parts = parseDateParts(baseDate);
  const utc = Date.UTC(parts.year, parts.month - 1, parts.day + deltaDays);
  const dt = new Date(utc);
  const y = dt.getUTCFullYear();
  const m = dt.getUTCMonth() + 1;
  const d = dt.getUTCDate();
  const mm = String(m).padStart(2, '0');
  const dd = String(d).padStart(2, '0');
  return {
    year: y,
    month: m,
    day: d,
    ymd: y + '-' + mm + '-' + dd,
    yyyymmdd: '' + y + mm + dd,
    yyyymm01: '' + y + mm + '01',
  };
}

/**
 * Converts ROC date string ("115/11/26" or "1151126") to ISO "YYYY-MM-DD".
 * @param {string} rocDateStr
 * @return {string|null}
 */
function rocDateToIso(rocDateStr) {
  if (!rocDateStr) return null;
  const s = String(rocDateStr).trim();
  const slashMatch = s.match(/^(\d{2,3})\/(\d{1,2})\/(\d{1,2})$/);
  if (slashMatch) {
    const y = parseInt(slashMatch[1], 10) + 1911;
    const m = String(parseInt(slashMatch[2], 10)).padStart(2, '0');
    const d = String(parseInt(slashMatch[3], 10)).padStart(2, '0');
    return y + '-' + m + '-' + d;
  }
  const compactMatch = s.match(/^(\d{3})(\d{2})(\d{2})$/);
  if (compactMatch) {
    const y = parseInt(compactMatch[1], 10) + 1911;
    return y + '-' + compactMatch[2] + '-' + compactMatch[3];
  }
  return null;
}

/**
 * Parses a numeric price string with optional commas and whitespace.
 * @param {*} raw
 * @return {number|null}
 */
function parsePositivePrice(raw) {
  if (raw === null || raw === undefined || raw === '' || raw === '-' || raw === '--' || raw === 'N/A') {
    return null;
  }
  const cleaned = String(raw).replace(/,/g, '').trim();
  const num = Number(cleaned);
  if (!Number.isFinite(num) || num <= 0) {
    return null;
  }
  return num;
}

/**
 * Converts Yahoo Finance ticker symbol for given market.
 * @param {string} ticker
 * @param {string} market 'TWSE' | 'TPEX' | 'US' | 'CASH'
 * @return {string}
 */
function toYahooSymbol(ticker, market) {
  const clean = normalizeAndValidateTicker(ticker);
  const m = String(market || 'TWSE').trim().toUpperCase();
  if (m === 'TWSE') return clean + '.TW';
  if (m === 'TPEX') return clean + '.TWO';
  return clean;
}

/**
 * Builds native Google Sheets GOOGLEFINANCE formula for live price.
 * @param {string} tickerCellRef
 * @param {string} marketCellRef
 * @return {string}
 */
function buildGoogleFinanceLiveFormula(tickerCellRef, marketCellRef) {
  return (
    '=IF(' + tickerCellRef + '="","",IF(' + marketCellRef + '="CASH",1,' +
    'IFERROR(GOOGLEFINANCE(IF(' + marketCellRef + '="US",' + tickerCellRef + ',"TPE:"&' + tickerCellRef + '),"price"),"N/A")))'
  );
}

/**
 * Builds native Google Sheets GOOGLEFINANCE formula for historical closing price on or before targetDateCellRef.
 * Uses `< date (target + 1)` to safely include 13:30 / 16:00 close timestamps on targetDate.
 * @param {string} tickerCellRef
 * @param {string} marketCellRef
 * @param {string} targetDateCellRef
 * @return {string}
 */
function buildGoogleFinanceHistoricalFormula(tickerCellRef, marketCellRef, targetDateCellRef) {
  const symExpr = 'IF(' + marketCellRef + '="US",' + tickerCellRef + ',"TPE:"&' + tickerCellRef + ')';
  return (
    '=IF(' + tickerCellRef + '="","",IF(' + marketCellRef + '="CASH",1,' +
    'IFERROR(INDEX(QUERY(GOOGLEFINANCE(' + symExpr + ',"close",' + targetDateCellRef + '-10,' + targetDateCellRef + '+1),' +
    '"select Col2 where Col1 < date \'"&TEXT(' + targetDateCellRef + '+1,"yyyy-mm-dd")&"\' order by Col1 desc limit 1",1),2,1),"N/A")))'
  );
}

/**
 * Cache abstraction wrapping Apps Script CacheService + in-memory fallback.
 */
function getCacheValue(key, deps) {
  if (_MEMORY_CACHE[key] && _MEMORY_CACHE[key].expiresAt > Date.now()) {
    return _MEMORY_CACHE[key].value;
  }
  const cacheObj = (deps && deps.cache) || (typeof CacheService !== 'undefined' ? CacheService.getScriptCache() : null);
  if (cacheObj) {
    try {
      const hit = cacheObj.get(key);
      if (hit !== null && hit !== undefined) {
        return JSON.parse(hit);
      }
    } catch (e) {
      // Ignore cache deserialization issues
    }
  }
  return null;
}

function setCacheValue(key, value, ttlSec, deps) {
  _MEMORY_CACHE[key] = { value: value, expiresAt: Date.now() + ttlSec * 1000 };
  const cacheObj = (deps && deps.cache) || (typeof CacheService !== 'undefined' ? CacheService.getScriptCache() : null);
  if (cacheObj) {
    try {
      const serialized = JSON.stringify(value);
      // CacheService limit is 100KB per key
      if (serialized.length < 95000) {
        cacheObj.put(key, serialized, Math.min(21600, Math.max(10, ttlSec)));
      }
    } catch (e) {
      // Non-fatal cache write error
    }
  }
}

/**
 * Clears in-memory cache (helpful in unit tests).
 */
function clearInMemoryPriceCache() {
  _MEMORY_CACHE = {};
}

/**
 * Secure HTTP GET with allowlist validation, exponential backoff retry, and latency tracking.
 * @param {string} url
 * @param {Object} options {headers?, maxAttempts?}
 * @param {Object} deps {httpFetch?, sleep?, now?}
 * @return {{ok: boolean, statusCode: number, body: string, latencyMs: number, attempts: number, error: (string|null)}}
 */
function safeHttpGet(url, options, deps) {
  validateAllowedUrl(url);
  const opts = options || {};
  const d = deps || {};
  const nowFn = d.now || function () { return Date.now(); };
  const sleepFn = d.sleep || (typeof Utilities !== 'undefined' ? function (ms) { Utilities.sleep(ms); } : function () {});
  const fetchFn = d.httpFetch || function (targetUrl, fetchParams) {
    const resp = UrlFetchApp.fetch(targetUrl, fetchParams);
    return { statusCode: resp.getResponseCode(), body: resp.getContentText() };
  };

  const maxAttempts = opts.maxAttempts || APP_CONFIG.RETRY_POLICY.MAX_ATTEMPTS;
  const baseDelay = APP_CONFIG.RETRY_POLICY.BASE_DELAY_MS;
  const start = nowFn();
  let lastError = null;
  let lastStatus = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = fetchFn(url, {
        method: 'get',
        muteHttpExceptions: true,
        followRedirects: true,
        headers: Object.assign({
          'User-Agent': 'Mozilla/5.0 (compatible; BetaCalculator-GAS/1.0)',
          'Accept': 'application/json, text/csv, */*',
        }, opts.headers || {}),
      });
      lastStatus = res.statusCode;
      if (res.statusCode >= 200 && res.statusCode < 300) {
        return {
          ok: true,
          statusCode: res.statusCode,
          body: res.body,
          latencyMs: Math.max(0, nowFn() - start),
          attempts: attempt,
          error: null,
        };
      }
      lastError = 'HTTP ' + res.statusCode;
      // Do not retry 4xx client errors except 429 Too Many Requests
      if (res.statusCode >= 400 && res.statusCode < 500 && res.statusCode !== 429) {
        break;
      }
    } catch (err) {
      lastError = err && err.message ? err.message : String(err);
    }
    if (attempt < maxAttempts) {
      sleepFn(baseDelay * Math.pow(2, attempt - 1));
    }
  }

  return {
    ok: false,
    statusCode: lastStatus,
    body: '',
    latencyMs: Math.max(0, nowFn() - start),
    attempts: maxAttempts,
    error: lastError || 'Unknown HTTP error',
  };
}

/**
 * Helper to fetch optional FinMind token from ScriptProperties (never hardcoded).
 * @param {Object} deps
 * @return {string|null}
 */
function getFinMindToken(deps) {
  if (deps && deps.finMindToken) {
    return deps.finMindToken;
  }
  if (typeof PropertiesService !== 'undefined') {
    try {
      const token = PropertiesService.getScriptProperties().getProperty('FINMIND_TOKEN');
      return token && token.trim() ? token.trim() : null;
    } catch (e) {
      return null;
    }
  }
  return null;
}

/* ============================================================================
 * SOURCE 2: YAHOO FINANCE CHART API v8 (Live & Historical Unadjusted Close)
 * ============================================================================ */

function fetchYahooLiveQuote(ticker, market, deps) {
  const cleanTicker = normalizeAndValidateTicker(ticker);
  if (market === 'CASH' || cleanTicker === 'CASH') {
    return { source: 'YahooFinance', ok: true, price: 1, tradingDate: parseDateParts(new Date()).ymd, latencyMs: 0, error: null };
  }
  const cacheKey = 'yf_live_' + cleanTicker + '_' + market;
  const cached = getCacheValue(cacheKey, deps);
  if (cached) return Object.assign({}, cached, { cached: true, latencyMs: 0 });

  const symbol = toYahooSymbol(cleanTicker, market);
  const hosts = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
  let totalLatency = 0;
  let lastError = 'Yahoo Finance request failed';

  for (let i = 0; i < hosts.length; i++) {
    const url = 'https://' + hosts[i] + '/v8/finance/chart/' + encodeURIComponent(symbol) + '?range=5d&interval=1d';
    const res = safeHttpGet(url, {}, deps);
    totalLatency += res.latencyMs;
    if (!res.ok) {
      lastError = res.error;
      continue;
    }
    try {
      const json = JSON.parse(res.body);
      const result = json && json.chart && json.chart.result && json.chart.result[0];
      const meta = result && result.meta;
      const price = parsePositivePrice(meta && (meta.regularMarketPrice || meta.previousClose || meta.chartPreviousClose));
      if (price !== null) {
        const tsMs = meta.regularMarketTime ? meta.regularMarketTime * 1000 : Date.now();
        const quote = {
          source: 'YahooFinance',
          ok: true,
          price: price,
          tradingDate: parseDateParts(new Date(tsMs)).ymd,
          latencyMs: totalLatency,
          error: null,
        };
        setCacheValue(cacheKey, quote, APP_CONFIG.CACHE_TTL_SEC.LIVE_QUOTE, deps);
        return quote;
      }
      lastError = 'No valid price in Yahoo response';
    } catch (e) {
      lastError = 'Yahoo JSON parse error: ' + e.message;
    }
  }

  return { source: 'YahooFinance', ok: false, price: null, tradingDate: null, latencyMs: totalLatency, error: lastError };
}

/**
 * Fetches Yahoo Finance daily unadjusted closing price series between startDate and endDate.
 * @return {{source: string, ok: boolean, series: Array<{date: string, close: number, adjClose: (number|null)}>, latencyMs: number, error: (string|null)}}
 */
function fetchYahooHistoricalSeries(ticker, market, startDate, endDate, deps) {
  const cleanTicker = normalizeAndValidateTicker(ticker);
  const startParts = parseDateParts(startDate);
  const endParts = parseDateParts(endDate);
  if (market === 'CASH' || cleanTicker === 'CASH') {
    return { source: 'YahooFinance', ok: true, series: [{ date: endParts.ymd, close: 1, adjClose: 1 }], latencyMs: 0, error: null };
  }

  const cacheKey = 'yf_hist_' + cleanTicker + '_' + market + '_' + startParts.yyyymmdd + '_' + endParts.yyyymmdd;
  const cached = getCacheValue(cacheKey, deps);
  if (cached) return Object.assign({}, cached, { cached: true, latencyMs: 0 });

  const symbol = toYahooSymbol(cleanTicker, market);
  // Expand window slightly to account for timezone differences
  const p1 = Math.floor(Date.UTC(startParts.year, startParts.month - 1, startParts.day - 1) / 1000);
  const p2 = Math.floor(Date.UTC(endParts.year, endParts.month - 1, endParts.day + 2) / 1000);
  const hosts = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
  let totalLatency = 0;
  let lastError = 'Yahoo historical fetch failed';

  for (let i = 0; i < hosts.length; i++) {
    const url =
      'https://' + hosts[i] + '/v8/finance/chart/' + encodeURIComponent(symbol) +
      '?period1=' + p1 + '&period2=' + p2 + '&interval=1d';
    const res = safeHttpGet(url, {}, deps);
    totalLatency += res.latencyMs;
    if (!res.ok) {
      lastError = res.error;
      continue;
    }
    try {
      const json = JSON.parse(res.body);
      const result = json && json.chart && json.chart.result && json.chart.result[0];
      const timestamps = (result && result.timestamp) || [];
      const quoteBlock = result && result.indicators && result.indicators.quote && result.indicators.quote[0];
      const closes = (quoteBlock && quoteBlock.close) || [];
      const adjBlock = result && result.indicators && result.indicators.adjclose && result.indicators.adjclose[0];
      const adjCloses = (adjBlock && adjBlock.adjclose) || [];

      const byDate = {};
      for (let idx = 0; idx < timestamps.length; idx++) {
        const c = parsePositivePrice(closes[idx]);
        if (c === null) continue;
        const ymd = parseDateParts(new Date(timestamps[idx] * 1000)).ymd;
        if (ymd >= startParts.ymd && ymd <= endParts.ymd) {
          byDate[ymd] = {
            date: ymd,
            close: Number(c.toFixed(4)),
            adjClose: parsePositivePrice(adjCloses[idx]),
          };
        }
      }
      const series = Object.keys(byDate).sort().map(function (k) { return byDate[k]; });
      const out = { source: 'YahooFinance', ok: series.length > 0, series: series, latencyMs: totalLatency, error: series.length > 0 ? null : 'Empty series' };
      if (out.ok) {
        setCacheValue(cacheKey, out, APP_CONFIG.CACHE_TTL_SEC.HISTORICAL_CLOSE, deps);
      }
      return out;
    } catch (e) {
      lastError = 'Yahoo historical parse error: ' + e.message;
    }
  }

  return { source: 'YahooFinance', ok: false, series: [], latencyMs: totalLatency, error: lastError };
}

function fetchYahooHistoricalClose(ticker, market, targetDate, deps) {
  const lookbackStart = shiftDateParts(targetDate, -10).ymd;
  const targetYmd = parseDateParts(targetDate).ymd;
  const res = fetchYahooHistoricalSeries(ticker, market, lookbackStart, targetYmd, deps);
  if (!res.ok || res.series.length === 0) {
    return { source: 'YahooFinance', ok: false, price: null, tradingDate: null, latencyMs: res.latencyMs, error: res.error };
  }
  const latest = res.series[res.series.length - 1];
  return {
    source: 'YahooFinance',
    ok: true,
    price: latest.close,
    tradingDate: latest.date,
    latencyMs: res.latencyMs,
    error: null,
  };
}

/* ============================================================================
 * SOURCE 3: TWSE / TPEx OFFICIAL API (Taiwan) & STOOQ CSV (US)
 * ============================================================================ */

function fetchTwseOpenApiSnapshotMap(deps) {
  const cacheKey = 'twse_openapi_stock_day_all';
  const cached = getCacheValue(cacheKey, deps);
  if (cached) return { ok: true, map: cached, latencyMs: 0, error: null };

  const url = 'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL';
  const res = safeHttpGet(url, {}, deps);
  if (!res.ok) return { ok: false, map: {}, latencyMs: res.latencyMs, error: res.error };

  try {
    const arr = JSON.parse(res.body);
    const map = {};
    if (Array.isArray(arr)) {
      for (let i = 0; i < arr.length; i++) {
        const row = arr[i];
        if (!row || !row.Code) continue;
        const close = parsePositivePrice(row.ClosingPrice);
        if (close !== null) {
          map[String(row.Code).trim().toUpperCase()] = {
            price: close,
            tradingDate: rocDateToIso(row.Date) || parseDateParts(new Date()).ymd,
            name: row.Name || '',
          };
        }
      }
    }
    setCacheValue(cacheKey, map, APP_CONFIG.CACHE_TTL_SEC.MARKET_SNAPSHOT, deps);
    return { ok: true, map: map, latencyMs: res.latencyMs, error: null };
  } catch (e) {
    return { ok: false, map: {}, latencyMs: res.latencyMs, error: 'TWSE OpenAPI parse error: ' + e.message };
  }
}

function fetchTpexOpenApiSnapshotMap(deps) {
  const cacheKey = 'tpex_openapi_daily_close';
  const cached = getCacheValue(cacheKey, deps);
  if (cached) return { ok: true, map: cached, latencyMs: 0, error: null };

  const url = 'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes';
  const res = safeHttpGet(url, {}, deps);
  if (!res.ok) return { ok: false, map: {}, latencyMs: res.latencyMs, error: res.error };

  try {
    const arr = JSON.parse(res.body);
    const map = {};
    if (Array.isArray(arr)) {
      for (let i = 0; i < arr.length; i++) {
        const row = arr[i];
        const code = row && (row.SecuritiesCompanyCode || row.Code);
        if (!code) continue;
        const close = parsePositivePrice(row.Close);
        if (close !== null) {
          map[String(code).trim().toUpperCase()] = {
            price: close,
            tradingDate: rocDateToIso(row.Date) || parseDateParts(new Date()).ymd,
            name: row.CompanyName || '',
          };
        }
      }
    }
    setCacheValue(cacheKey, map, APP_CONFIG.CACHE_TTL_SEC.MARKET_SNAPSHOT, deps);
    return { ok: true, map: map, latencyMs: res.latencyMs, error: null };
  } catch (e) {
    return { ok: false, map: {}, latencyMs: res.latencyMs, error: 'TPEx OpenAPI parse error: ' + e.message };
  }
}

function fetchStooqLiveQuote(ticker, deps) {
  const clean = normalizeAndValidateTicker(ticker);
  const url = 'https://stooq.com/q/l/?s=' + encodeURIComponent(clean.toLowerCase() + '.us') + '&f=sd2t2ohlcv&h&e=csv';
  const res = safeHttpGet(url, {}, deps);
  if (!res.ok) {
    return { source: 'Stooq', ok: false, price: null, tradingDate: null, latencyMs: res.latencyMs, error: res.error };
  }
  const lines = res.body.trim().split(/\r?\n/);
  if (lines.length < 2) {
    return { source: 'Stooq', ok: false, price: null, tradingDate: null, latencyMs: res.latencyMs, error: 'Stooq empty CSV' };
  }
  const cols = lines[1].split(',');
  const dateStr = cols[1] && cols[1] !== 'N/D' ? cols[1].trim() : null;
  const closePrice = parsePositivePrice(cols[6]);
  if (closePrice === null) {
    return { source: 'Stooq', ok: false, price: null, tradingDate: dateStr, latencyMs: res.latencyMs, error: 'Stooq no valid price' };
  }
  return { source: 'Stooq', ok: true, price: closePrice, tradingDate: dateStr, latencyMs: res.latencyMs, error: null };
}

function fetchStooqHistoricalSeries(ticker, startDate, endDate, deps) {
  const clean = normalizeAndValidateTicker(ticker);
  const s = parseDateParts(startDate);
  const e = parseDateParts(endDate);
  const url =
    'https://stooq.com/q/d/l/?s=' + encodeURIComponent(clean.toLowerCase() + '.us') +
    '&d1=' + s.yyyymmdd + '&d2=' + e.yyyymmdd + '&i=d';
  const res = safeHttpGet(url, {}, deps);
  if (!res.ok) {
    return { source: 'Stooq', ok: false, series: [], latencyMs: res.latencyMs, error: res.error };
  }
  const lines = res.body.trim().split(/\r?\n/);
  const series = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    if (cols.length < 5) continue;
    const ymd = cols[0].trim();
    const close = parsePositivePrice(cols[4]);
    if (close !== null && ymd >= s.ymd && ymd <= e.ymd) {
      series.push({ date: ymd, close: close });
    }
  }
  series.sort(function (a, b) { return a.date.localeCompare(b.date); });
  return { source: 'Stooq', ok: series.length > 0, series: series, latencyMs: res.latencyMs, error: series.length > 0 ? null : 'Empty Stooq series' };
}

/**
 * Source 3 Live Quote: TWSE MIS intraday (+ OpenAPI fallback) for Taiwan, Stooq for US.
 */
function fetchExchangeOfficialLiveQuote(ticker, market, deps) {
  const clean = normalizeAndValidateTicker(ticker);
  const m = String(market || 'TWSE').trim().toUpperCase();
  if (m === 'CASH' || clean === 'CASH') {
    return { source: 'TWSE/TPEx', ok: true, price: 1, tradingDate: parseDateParts(new Date()).ymd, latencyMs: 0, error: null };
  }
  if (m === 'US') {
    return fetchStooqLiveQuote(clean, deps);
  }

  const cacheKey = 'exch_live_' + m + '_' + clean;
  const cached = getCacheValue(cacheKey, deps);
  if (cached) return Object.assign({}, cached, { cached: true, latencyMs: 0 });

  const exPrefix = m === 'TPEX' ? 'otc' : 'tse';
  const misUrl = 'https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=' + exPrefix + '_' + encodeURIComponent(clean) + '.tw&json=1&delay=0';
  const misRes = safeHttpGet(misUrl, {}, deps);
  let totalLatency = misRes.latencyMs;

  if (misRes.ok) {
    try {
      const json = JSON.parse(misRes.body);
      const item = json && Array.isArray(json.msgArray) && json.msgArray[0];
      if (item) {
        let price = parsePositivePrice(item.z);
        // If no current tick match (e.g. between ticks or closed), check midpoint of best bid/ask or OpenAPI
        if (price === null && item.a && item.b) {
          const ask = parsePositivePrice(String(item.a).split('_')[0]);
          const bid = parsePositivePrice(String(item.b).split('_')[0]);
          if (ask !== null && bid !== null) {
            price = Number(((ask + bid) / 2).toFixed(4));
          }
        }
        if (price !== null) {
          const dStr = item.d && item.d.length === 8
            ? item.d.slice(0, 4) + '-' + item.d.slice(4, 6) + '-' + item.d.slice(6, 8)
            : parseDateParts(new Date()).ymd;
          const out = { source: 'TWSE/TPEx', ok: true, price: price, tradingDate: dStr, latencyMs: totalLatency, error: null };
          setCacheValue(cacheKey, out, APP_CONFIG.CACHE_TTL_SEC.LIVE_QUOTE, deps);
          return out;
        }
      }
    } catch (e) {
      // Fallback to OpenAPI below
    }
  }

  // Fallback to official OpenAPI daily close snapshot
  const snap = m === 'TPEX' ? fetchTpexOpenApiSnapshotMap(deps) : fetchTwseOpenApiSnapshotMap(deps);
  totalLatency += snap.latencyMs;
  if (snap.ok && snap.map[clean]) {
    const out = {
      source: 'TWSE/TPEx',
      ok: true,
      price: snap.map[clean].price,
      tradingDate: snap.map[clean].tradingDate,
      latencyMs: totalLatency,
      error: null,
    };
    setCacheValue(cacheKey, out, APP_CONFIG.CACHE_TTL_SEC.LIVE_QUOTE, deps);
    return out;
  }

  return { source: 'TWSE/TPEx', ok: false, price: null, tradingDate: null, latencyMs: totalLatency, error: snap.error || misRes.error || 'TWSE/TPEx lookup failed' };
}

/**
 * Fetches one month of TWSE official daily closing prices via STOCK_DAY.
 */
function fetchTwseMonthlyStockDay(ticker, yyyymm01, deps) {
  const clean = normalizeAndValidateTicker(ticker);
  const cacheKey = 'twse_stock_day_' + clean + '_' + yyyymm01;
  const cached = getCacheValue(cacheKey, deps);
  if (cached) return Object.assign({}, cached, { cached: true, latencyMs: 0 });

  const url = 'https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?response=json&date=' + yyyymm01 + '&stockNo=' + encodeURIComponent(clean);
  const res = safeHttpGet(url, {}, deps);
  if (!res.ok) {
    return { ok: false, rows: [], latencyMs: res.latencyMs, error: res.error };
  }
  try {
    const json = JSON.parse(res.body);
    if (!json || json.stat !== 'OK' || !Array.isArray(json.data)) {
      return { ok: false, rows: [], latencyMs: res.latencyMs, error: (json && json.stat) || 'TWSE stat not OK' };
    }
    const rows = [];
    for (let i = 0; i < json.data.length; i++) {
      const r = json.data[i];
      if (!Array.isArray(r) || r.length < 7) continue;
      const isoDate = rocDateToIso(r[0]);
      const close = parsePositivePrice(r[6]);
      if (isoDate && close !== null) {
        rows.push({ date: isoDate, close: close });
      }
    }
    const out = { ok: rows.length > 0, rows: rows, latencyMs: res.latencyMs, error: null };
    if (out.ok) setCacheValue(cacheKey, out, APP_CONFIG.CACHE_TTL_SEC.HISTORICAL_CLOSE, deps);
    return out;
  } catch (e) {
    return { ok: false, rows: [], latencyMs: res.latencyMs, error: 'TWSE STOCK_DAY parse error: ' + e.message };
  }
}

/**
 * Fetches one month of TPEx official daily closing prices.
 */
function fetchTpexMonthlyStockDay(ticker, year, month, deps) {
  const clean = normalizeAndValidateTicker(ticker);
  const mm = String(month).padStart(2, '0');
  const cacheKey = 'tpex_stock_day_' + clean + '_' + year + mm;
  const cached = getCacheValue(cacheKey, deps);
  if (cached) return Object.assign({}, cached, { cached: true, latencyMs: 0 });

  const url = 'https://www.tpex.org.tw/www/zh-tw/afterTrading/tradingStock?date=' + year + '/' + mm + '/01&code=' + encodeURIComponent(clean) + '&response=json';
  const res = safeHttpGet(url, {}, deps);
  if (!res.ok) return { ok: false, rows: [], latencyMs: res.latencyMs, error: res.error };

  try {
    const json = JSON.parse(res.body);
    const rawRows = (json && json.tables && json.tables[0] && json.tables[0].data) || (json && json.aaData) || [];
    const rows = [];
    for (let i = 0; i < rawRows.length; i++) {
      const r = rawRows[i];
      if (!Array.isArray(r) || r.length < 7) continue;
      const isoDate = rocDateToIso(String(r[0]).replace(/＊/g, '').trim());
      const close = parsePositivePrice(r[6]);
      if (isoDate && close !== null) {
        rows.push({ date: isoDate, close: close });
      }
    }
    const out = { ok: rows.length > 0, rows: rows, latencyMs: res.latencyMs, error: null };
    if (out.ok) setCacheValue(cacheKey, out, APP_CONFIG.CACHE_TTL_SEC.HISTORICAL_CLOSE, deps);
    return out;
  } catch (e) {
    return { ok: false, rows: [], latencyMs: res.latencyMs, error: 'TPEx parse error: ' + e.message };
  }
}

/**
 * Lists all YYYY-MM months covering [startDate, endDate].
 */
function enumerateYearMonths(startDate, endDate) {
  const s = parseDateParts(startDate);
  const e = parseDateParts(endDate);
  const months = [];
  let y = s.year;
  let m = s.month;
  while (y < e.year || (y === e.year && m <= e.month)) {
    months.push({ year: y, month: m, yyyymm01: '' + y + String(m).padStart(2, '0') + '01' });
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return months;
}

function fetchExchangeOfficialHistoricalSeries(ticker, market, startDate, endDate, deps) {
  const clean = normalizeAndValidateTicker(ticker);
  const m = String(market || 'TWSE').trim().toUpperCase();
  const s = parseDateParts(startDate);
  const e = parseDateParts(endDate);
  if (m === 'CASH' || clean === 'CASH') {
    return { source: 'TWSE/TPEx', ok: true, series: [{ date: e.ymd, close: 1 }], latencyMs: 0, error: null };
  }
  if (m === 'US') {
    return fetchStooqHistoricalSeries(clean, s.ymd, e.ymd, deps);
  }

  const sleepFn = (deps && deps.sleep) || (typeof Utilities !== 'undefined' ? function (ms) { Utilities.sleep(ms); } : function () {});
  const months = enumerateYearMonths(s.ymd, e.ymd);
  const byDate = {};
  let totalLatency = 0;
  let lastError = null;

  for (let i = 0; i < months.length; i++) {
    const ym = months[i];
    const monthly = m === 'TPEX'
      ? fetchTpexMonthlyStockDay(clean, ym.year, ym.month, deps)
      : fetchTwseMonthlyStockDay(clean, ym.yyyymm01, deps);
    totalLatency += monthly.latencyMs;
    if (monthly.ok) {
      for (let j = 0; j < monthly.rows.length; j++) {
        const row = monthly.rows[j];
        if (row.date >= s.ymd && row.date <= e.ymd) {
          byDate[row.date] = row;
        }
      }
    } else {
      lastError = monthly.error;
    }
    if (i < months.length - 1 && !monthly.cached) {
      sleepFn(APP_CONFIG.RETRY_POLICY.TWSE_THROTTLE_MS);
    }
  }

  const series = Object.keys(byDate).sort().map(function (k) { return byDate[k]; });
  return {
    source: 'TWSE/TPEx',
    ok: series.length > 0,
    series: series,
    latencyMs: totalLatency,
    error: series.length > 0 ? null : (lastError || 'No official exchange data in range'),
  };
}

function fetchExchangeOfficialHistoricalClose(ticker, market, targetDate, deps) {
  const lookbackStart = shiftDateParts(targetDate, -10).ymd;
  const targetYmd = parseDateParts(targetDate).ymd;
  const res = fetchExchangeOfficialHistoricalSeries(ticker, market, lookbackStart, targetYmd, deps);
  if (!res.ok || res.series.length === 0) {
    return { source: res.source, ok: false, price: null, tradingDate: null, latencyMs: res.latencyMs, error: res.error };
  }
  const latest = res.series[res.series.length - 1];
  return { source: res.source, ok: true, price: latest.close, tradingDate: latest.date, latencyMs: res.latencyMs, error: null };
}

/* ============================================================================
 * SOURCE 4: FINMIND OPEN FINANCIAL API (Taiwan & US Backup)
 * ============================================================================ */

function fetchFinMindHistoricalSeries(ticker, market, startDate, endDate, deps) {
  const clean = normalizeAndValidateTicker(ticker);
  const m = String(market || 'TWSE').trim().toUpperCase();
  const s = parseDateParts(startDate);
  const e = parseDateParts(endDate);
  if (m === 'CASH' || clean === 'CASH') {
    return { source: 'FinMind', ok: true, series: [{ date: e.ymd, close: 1 }], latencyMs: 0, error: null };
  }

  const cacheKey = 'fm_hist_' + m + '_' + clean + '_' + s.yyyymmdd + '_' + e.yyyymmdd;
  const cached = getCacheValue(cacheKey, deps);
  if (cached) return Object.assign({}, cached, { cached: true, latencyMs: 0 });

  const dataset = m === 'US' ? 'USStockPrice' : 'TaiwanStockPrice';
  const token = getFinMindToken(deps);
  let url =
    'https://api.finmindtrade.com/v4/data?dataset=' + dataset +
    '&data_id=' + encodeURIComponent(clean) +
    '&start_date=' + s.ymd +
    '&end_date=' + e.ymd;
  const headers = {};
  if (token) {
    headers['Authorization'] = 'Bearer ' + token;
  }

  const res = safeHttpGet(url, { headers: headers }, deps);
  if (!res.ok) {
    return { source: 'FinMind', ok: false, series: [], latencyMs: res.latencyMs, error: res.error };
  }
  try {
    const json = JSON.parse(res.body);
    if (!json || json.status !== 200 || !Array.isArray(json.data)) {
      return { source: 'FinMind', ok: false, series: [], latencyMs: res.latencyMs, error: (json && json.msg) || 'FinMind error' };
    }
    const series = [];
    for (let i = 0; i < json.data.length; i++) {
      const row = json.data[i];
      const close = parsePositivePrice(row.close !== undefined ? row.close : row.Close);
      const dt = row.date || row.Date;
      if (close !== null && dt && dt >= s.ymd && dt <= e.ymd) {
        series.push({ date: String(dt).slice(0, 10), close: close });
      }
    }
    series.sort(function (a, b) { return a.date.localeCompare(b.date); });
    const out = { source: 'FinMind', ok: series.length > 0, series: series, latencyMs: res.latencyMs, error: series.length > 0 ? null : 'Empty FinMind series' };
    if (out.ok) setCacheValue(cacheKey, out, APP_CONFIG.CACHE_TTL_SEC.HISTORICAL_CLOSE, deps);
    return out;
  } catch (err) {
    return { source: 'FinMind', ok: false, series: [], latencyMs: res.latencyMs, error: 'FinMind parse error: ' + err.message };
  }
}

function fetchFinMindLatestClose(ticker, market, refDate, deps) {
  const target = parseDateParts(refDate || new Date()).ymd;
  const lookbackStart = shiftDateParts(target, -10).ymd;
  const res = fetchFinMindHistoricalSeries(ticker, market, lookbackStart, target, deps);
  if (!res.ok || res.series.length === 0) {
    return { source: 'FinMind', ok: false, price: null, tradingDate: null, latencyMs: res.latencyMs, error: res.error };
  }
  const latest = res.series[res.series.length - 1];
  return { source: 'FinMind', ok: true, price: latest.close, tradingDate: latest.date, latencyMs: res.latencyMs, error: null };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    parseDateParts,
    shiftDateParts,
    rocDateToIso,
    parsePositivePrice,
    toYahooSymbol,
    buildGoogleFinanceLiveFormula,
    buildGoogleFinanceHistoricalFormula,
    safeHttpGet,
    clearInMemoryPriceCache,
    fetchYahooLiveQuote,
    fetchYahooHistoricalSeries,
    fetchYahooHistoricalClose,
    fetchExchangeOfficialLiveQuote,
    fetchExchangeOfficialHistoricalSeries,
    fetchExchangeOfficialHistoricalClose,
    fetchFinMindHistoricalSeries,
    fetchFinMindLatestClose,
  };
}
