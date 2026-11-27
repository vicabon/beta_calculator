/**
 * @fileoverview Multi-source (4-5 authoritative sources) stock price & FX adapters
 * designed for Cloudflare Workers (Pages Functions) and Node.js 20+.
 *
 * Taiwan sources: TWSE/TPEx Official, Yahoo Finance v8, FinMind, Fugle (optional key), GAS Bridge (optional).
 * US sources:     Yahoo Finance v8, Stooq CSV, FinMind USStockPrice, TwelveData/Finnhub (optional key), GAS Bridge.
 *
 * Security: Every outbound fetch passes strict validateAllowedUrl() SSRF allowlist.
 * Stability: Concurrent Promise.all fetching, query1->query2 failover, exponential backoff retries.
 */

import { WEB_CONFIG, normalizeAndValidateTicker, normalizeMarket, validateAllowedUrl } from './config.mjs';
import { alignAndReconcileSeries, parsePositivePrice, reconcilePrices } from './reconciler.mjs';

export function parseDateParts(input) {
  let y, m, d;
  if (typeof input === 'string' && /^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(input.trim())) {
    const match = input.trim().match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
    y = parseInt(match[1], 10);
    m = parseInt(match[2], 10);
    d = parseInt(match[3], 10);
  } else {
    const base = input instanceof Date && !isNaN(input.getTime()) ? input : new Date();
    const shifted = new Date(base.getTime() + 8 * 3600 * 1000);
    y = shifted.getUTCFullYear();
    m = shifted.getUTCMonth() + 1;
    d = shifted.getUTCDate();
  }
  const mm = String(m).padStart(2, '0');
  const dd = String(d).padStart(2, '0');
  return { year: y, month: m, day: d, ymd: `${y}-${mm}-${dd}`, yyyymmdd: `${y}${mm}${dd}`, yyyymm01: `${y}${mm}01` };
}

export function shiftDateParts(baseDate, deltaDays) {
  const p = parseDateParts(baseDate);
  const dt = new Date(Date.UTC(p.year, p.month - 1, p.day + deltaDays));
  const y = dt.getUTCFullYear();
  const m = dt.getUTCMonth() + 1;
  const d = dt.getUTCDate();
  const mm = String(m).padStart(2, '0');
  const dd = String(d).padStart(2, '0');
  return { year: y, month: m, day: d, ymd: `${y}-${mm}-${dd}`, yyyymmdd: `${y}${mm}${dd}`, yyyymm01: `${y}${mm}01` };
}

export function rocDateToIso(rocStr) {
  if (!rocStr) return null;
  const s = String(rocStr).replace(/＊/g, '').trim();
  const slash = s.match(/^(\d{2,3})\/(\d{1,2})\/(\d{1,2})$/);
  if (slash) {
    return `${parseInt(slash[1], 10) + 1911}-${slash[2].padStart(2, '0')}-${slash[3].padStart(2, '0')}`;
  }
  const compact = s.match(/^(\d{3})(\d{2})(\d{2})$/);
  if (compact) {
    return `${parseInt(compact[1], 10) + 1911}-${compact[2]}-${compact[3]}`;
  }
  return null;
}

export function toYahooSymbol(ticker, market) {
  const clean = normalizeAndValidateTicker(ticker);
  const m = normalizeMarket(market, clean);
  if (m === 'TWSE') return `${clean}.TW`;
  if (m === 'TPEX') return `${clean}.TWO`;
  return clean;
}

export async function safeFetchText(url, options = {}, deps = {}) {
  validateAllowedUrl(url);
  const fetchFn = deps.fetchFn || globalThis.fetch;
  const nowFn = deps.nowFn || (() => Date.now());
  const sleepFn = deps.sleepFn || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const maxAttempts = options.maxAttempts || WEB_CONFIG.RETRY_POLICY.MAX_ATTEMPTS;
  const baseDelay = WEB_CONFIG.RETRY_POLICY.BASE_DELAY_MS;
  const start = nowFn();
  let lastError = null;
  let lastStatus = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const resp = await fetchFn(url, {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; BetaCalculator-Edge/2.0)',
          Accept: 'application/json, text/csv, */*',
          ...(options.headers || {}),
        },
      });
      lastStatus = resp.status;
      if (resp.ok) {
        const body = await resp.text();
        return { ok: true, status: resp.status, body, latencyMs: Math.max(0, nowFn() - start), attempts: attempt, error: null };
      }
      lastError = `HTTP ${resp.status}`;
      if (resp.status >= 400 && resp.status < 500 && resp.status !== 429) break;
    } catch (err) {
      lastError = err?.message || String(err);
    }
    if (attempt < maxAttempts) {
      await sleepFn(baseDelay * Math.pow(2, attempt - 1));
    }
  }
  return { ok: false, status: lastStatus, body: '', latencyMs: Math.max(0, nowFn() - start), attempts: maxAttempts, error: lastError };
}

/* ---------------- Source: Yahoo Finance v8 (Live & Unadjusted Historical) ---------------- */

export async function fetchYahooLive(ticker, market, deps = {}) {
  const clean = normalizeAndValidateTicker(ticker);
  const m = normalizeMarket(market, clean);
  if (m === 'CASH') return { source: 'YahooFinance', ok: true, price: 1, tradingDate: parseDateParts(new Date()).ymd, latencyMs: 0, error: null };

  const sym = toYahooSymbol(clean, m);
  let totalLatency = 0;
  let lastError = 'Yahoo request failed';
  for (const host of ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']) {
    const url = `https://${host}/v8/finance/chart/${encodeURIComponent(sym)}?range=5d&interval=1d`;
    const res = await safeFetchText(url, {}, deps);
    totalLatency += res.latencyMs;
    if (!res.ok) { lastError = res.error; continue; }
    try {
      const json = JSON.parse(res.body);
      const meta = json?.chart?.result?.[0]?.meta;
      const price = parsePositivePrice(meta?.regularMarketPrice ?? meta?.previousClose ?? meta?.chartPreviousClose);
      if (price !== null) {
        const tsMs = meta?.regularMarketTime ? meta.regularMarketTime * 1000 : Date.now();
        return { source: 'YahooFinance', ok: true, price, tradingDate: parseDateParts(new Date(tsMs)).ymd, latencyMs: totalLatency, error: null };
      }
      lastError = 'No valid Yahoo price';
    } catch (e) {
      lastError = `Yahoo parse error: ${e.message}`;
    }
  }
  return { source: 'YahooFinance', ok: false, price: null, tradingDate: null, latencyMs: totalLatency, error: lastError };
}

export async function fetchYahooHistoricalSeries(ticker, market, startDate, endDate, deps = {}) {
  const clean = normalizeAndValidateTicker(ticker);
  const m = normalizeMarket(market, clean);
  const s = parseDateParts(startDate);
  const e = parseDateParts(endDate);
  if (m === 'CASH') return { source: 'YahooFinance', ok: true, series: [{ date: e.ymd, close: 1 }], latencyMs: 0, error: null };

  const sym = toYahooSymbol(clean, m);
  const p1 = Math.floor(Date.UTC(s.year, s.month - 1, s.day - 1) / 1000);
  const p2 = Math.floor(Date.UTC(e.year, e.month - 1, e.day + 2) / 1000);
  let totalLatency = 0;
  let lastError = 'Yahoo historical failed';

  for (const host of ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']) {
    const url = `https://${host}/v8/finance/chart/${encodeURIComponent(sym)}?period1=${p1}&period2=${p2}&interval=1d`;
    const res = await safeFetchText(url, {}, deps);
    totalLatency += res.latencyMs;
    if (!res.ok) { lastError = res.error; continue; }
    try {
      const json = JSON.parse(res.body);
      const result = json?.chart?.result?.[0];
      const ts = result?.timestamp || [];
      const closes = result?.indicators?.quote?.[0]?.close || [];
      const byDate = {};
      for (let i = 0; i < ts.length; i++) {
        const c = parsePositivePrice(closes[i]);
        if (c === null) continue;
        const ymd = parseDateParts(new Date(ts[i] * 1000)).ymd;
        if (ymd >= s.ymd && ymd <= e.ymd) {
          byDate[ymd] = { date: ymd, close: Number(c.toFixed(4)) };
        }
      }
      const series = Object.keys(byDate).sort().map((k) => byDate[k]);
      return { source: 'YahooFinance', ok: series.length > 0, series, latencyMs: totalLatency, error: series.length ? null : 'Empty series' };
    } catch (err) {
      lastError = `Yahoo historical parse error: ${err.message}`;
    }
  }
  return { source: 'YahooFinance', ok: false, series: [], latencyMs: totalLatency, error: lastError };
}

/* ---------------- Source: TWSE / TPEx Official (TW) & Stooq CSV (US) ---------------- */

export async function fetchExchangeLive(ticker, market, deps = {}) {
  const clean = normalizeAndValidateTicker(ticker);
  const m = normalizeMarket(market, clean);
  if (m === 'CASH') return { source: 'TWSE/TPEx', ok: true, price: 1, tradingDate: parseDateParts(new Date()).ymd, latencyMs: 0, error: null };

  if (m === 'US') {
    const url = `https://stooq.com/q/l/?s=${encodeURIComponent(clean.toLowerCase() + '.us')}&f=sd2t2ohlcv&h&e=csv`;
    const res = await safeFetchText(url, {}, deps);
    if (!res.ok) return { source: 'Stooq', ok: false, price: null, tradingDate: null, latencyMs: res.latencyMs, error: res.error };
    const lines = res.body.trim().split(/\r?\n/);
    if (lines.length < 2) return { source: 'Stooq', ok: false, price: null, tradingDate: null, latencyMs: res.latencyMs, error: 'Empty Stooq CSV' };
    const cols = lines[1].split(',');
    const price = parsePositivePrice(cols[6]);
    const dt = cols[1] && cols[1] !== 'N/D' ? cols[1].trim() : null;
    return { source: 'Stooq', ok: price !== null, price, tradingDate: dt, latencyMs: res.latencyMs, error: price !== null ? null : 'Invalid Stooq price' };
  }

  const prefix = m === 'TPEX' ? 'otc' : 'tse';
  const misUrl = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${prefix}_${encodeURIComponent(clean)}.tw&json=1&delay=0`;
  const mis = await safeFetchText(misUrl, {}, deps);
  let totalLatency = mis.latencyMs;

  if (mis.ok) {
    try {
      const json = JSON.parse(mis.body);
      const item = json?.msgArray?.[0];
      if (item) {
        let price = parsePositivePrice(item.z);
        if (price === null && item.a && item.b) {
          const ask = parsePositivePrice(String(item.a).split('_')[0]);
          const bid = parsePositivePrice(String(item.b).split('_')[0]);
          if (ask !== null && bid !== null) price = Number(((ask + bid) / 2).toFixed(4));
        }
        if (price === null) price = parsePositivePrice(item.y);
        if (price !== null) {
          const dStr = item.d && item.d.length === 8
            ? `${item.d.slice(0, 4)}-${item.d.slice(4, 6)}-${item.d.slice(6, 8)}`
            : parseDateParts(new Date()).ymd;
          return { source: 'TWSE/TPEx', ok: true, price, tradingDate: dStr, latencyMs: totalLatency, error: null };
        }
      }
    } catch {
      // Fallback below
    }
  }

  // Lightweight fallback: current month STOCK_DAY (avoids 10ms CPU risk from full STOCK_DAY_ALL)
  const today = parseDateParts(new Date());
  const hist = await fetchExchangeHistoricalSeries(clean, m, shiftDateParts(today.ymd, -10).ymd, today.ymd, deps);
  totalLatency += hist.latencyMs;
  if (hist.ok && hist.series.length > 0) {
    const latest = hist.series[hist.series.length - 1];
    return { source: 'TWSE/TPEx', ok: true, price: latest.close, tradingDate: latest.date, latencyMs: totalLatency, error: null };
  }
  return { source: 'TWSE/TPEx', ok: false, price: null, tradingDate: null, latencyMs: totalLatency, error: mis.error || hist.error };
}

function enumerateMonths(startDate, endDate) {
  const s = parseDateParts(startDate);
  const e = parseDateParts(endDate);
  const out = [];
  let y = s.year;
  let m = s.month;
  while (y < e.year || (y === e.year && m <= e.month)) {
    out.push({ year: y, month: m, yyyymm01: `${y}${String(m).padStart(2, '0')}01` });
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return out;
}

export async function fetchExchangeHistoricalSeries(ticker, market, startDate, endDate, deps = {}) {
  const clean = normalizeAndValidateTicker(ticker);
  const m = normalizeMarket(market, clean);
  const s = parseDateParts(startDate);
  const e = parseDateParts(endDate);
  if (m === 'CASH') return { source: 'TWSE/TPEx', ok: true, series: [{ date: e.ymd, close: 1 }], latencyMs: 0, error: null };

  if (m === 'US') {
    const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(clean.toLowerCase() + '.us')}&d1=${s.yyyymmdd}&d2=${e.yyyymmdd}&i=d`;
    const res = await safeFetchText(url, {}, deps);
    if (!res.ok) return { source: 'Stooq', ok: false, series: [], latencyMs: res.latencyMs, error: res.error };
    const lines = res.body.trim().split(/\r?\n/);
    const series = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',');
      const c = parsePositivePrice(cols[4]);
      const ymd = cols[0]?.trim();
      if (c !== null && ymd && ymd >= s.ymd && ymd <= e.ymd) series.push({ date: ymd, close: c });
    }
    series.sort((a, b) => a.date.localeCompare(b.date));
    return { source: 'Stooq', ok: series.length > 0, series, latencyMs: res.latencyMs, error: series.length ? null : 'Empty Stooq series' };
  }

  const months = enumerateMonths(s.ymd, e.ymd);
  const byDate = {};
  let totalLatency = 0;
  let lastError = null;

  for (const ym of months) {
    const mm = String(ym.month).padStart(2, '0');
    const url = m === 'TPEX'
      ? `https://www.tpex.org.tw/www/zh-tw/afterTrading/tradingStock?date=${ym.year}/${mm}/01&code=${encodeURIComponent(clean)}&response=json`
      : `https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?response=json&date=${ym.yyyymm01}&stockNo=${encodeURIComponent(clean)}`;
    const res = await safeFetchText(url, {}, deps);
    totalLatency += res.latencyMs;
    if (!res.ok) { lastError = res.error; continue; }
    try {
      const json = JSON.parse(res.body);
      const rows = m === 'TPEX' ? (json?.tables?.[0]?.data || json?.aaData || []) : (json?.stat === 'OK' ? json.data || [] : []);
      for (const r of rows) {
        if (!Array.isArray(r) || r.length < 7) continue;
        const iso = rocDateToIso(r[0]);
        const c = parsePositivePrice(r[6]);
        if (iso && c !== null && iso >= s.ymd && iso <= e.ymd) {
          byDate[iso] = { date: iso, close: c };
        }
      }
    } catch (err) {
      lastError = err.message;
    }
  }

  const series = Object.keys(byDate).sort().map((k) => byDate[k]);
  return { source: 'TWSE/TPEx', ok: series.length > 0, series, latencyMs: totalLatency, error: series.length ? null : lastError };
}

/* ---------------- Source: FinMind OpenAPI (TW & US) ---------------- */

export async function fetchFinMindHistoricalSeries(ticker, market, startDate, endDate, deps = {}) {
  const clean = normalizeAndValidateTicker(ticker);
  const m = normalizeMarket(market, clean);
  const s = parseDateParts(startDate);
  const e = parseDateParts(endDate);
  if (m === 'CASH') return { source: 'FinMind', ok: true, series: [{ date: e.ymd, close: 1 }], latencyMs: 0, error: null };

  const dataset = m === 'US' ? 'USStockPrice' : 'TaiwanStockPrice';
  const url = `https://api.finmindtrade.com/v4/data?dataset=${dataset}&data_id=${encodeURIComponent(clean)}&start_date=${s.ymd}&end_date=${e.ymd}`;
  const headers = {};
  const token = deps.env?.FINMIND_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await safeFetchText(url, { headers }, deps);
  if (!res.ok) return { source: 'FinMind', ok: false, series: [], latencyMs: res.latencyMs, error: res.error };
  try {
    const json = JSON.parse(res.body);
    if (json?.status !== 200 || !Array.isArray(json.data)) {
      return { source: 'FinMind', ok: false, series: [], latencyMs: res.latencyMs, error: json?.msg || 'FinMind error' };
    }
    const series = [];
    for (const row of json.data) {
      const c = parsePositivePrice(row.close ?? row.Close);
      const dt = String(row.date || row.Date || '').slice(0, 10);
      if (c !== null && dt >= s.ymd && dt <= e.ymd) series.push({ date: dt, close: c });
    }
    series.sort((a, b) => a.date.localeCompare(b.date));
    return { source: 'FinMind', ok: series.length > 0, series, latencyMs: res.latencyMs, error: series.length ? null : 'Empty FinMind series' };
  } catch (err) {
    return { source: 'FinMind', ok: false, series: [], latencyMs: res.latencyMs, error: err.message };
  }
}

/* ---------------- Source: Fugle 富果官方免費 API (TW) & TwelveData/Finnhub (US) ---------------- */

export async function fetchFourthOfficialLive(ticker, market, deps = {}) {
  const clean = normalizeAndValidateTicker(ticker);
  const m = normalizeMarket(market, clean);
  if (m === 'CASH') return { source: 'Fugle', ok: true, price: 1, tradingDate: parseDateParts(new Date()).ymd, latencyMs: 0, error: null };

  if (m === 'TWSE' || m === 'TPEX') {
    const apiKey = deps.env?.FUGLE_API_KEY;
    if (!apiKey) return { source: 'Fugle', ok: false, price: null, tradingDate: null, latencyMs: 0, error: 'FUGLE_API_KEY not configured' };
    const url = `https://api.fugle.tw/marketdata/v1.0/stock/intraday/quote/${encodeURIComponent(clean)}`;
    const res = await safeFetchText(url, { headers: { 'X-API-KEY': apiKey } }, deps);
    if (!res.ok) return { source: 'Fugle', ok: false, price: null, tradingDate: null, latencyMs: res.latencyMs, error: res.error };
    try {
      const json = JSON.parse(res.body);
      const price = parsePositivePrice(json.lastPrice ?? json.closePrice ?? json.previousClose);
      return { source: 'Fugle', ok: price !== null, price, tradingDate: json.date || parseDateParts(new Date()).ymd, latencyMs: res.latencyMs, error: price !== null ? null : 'No Fugle price' };
    } catch (e) {
      return { source: 'Fugle', ok: false, price: null, tradingDate: null, latencyMs: res.latencyMs, error: e.message };
    }
  }

  // US 4th source: Twelve Data or Finnhub
  if (deps.env?.TWELVEDATA_API_KEY) {
    const url = `https://api.twelvedata.com/price?symbol=${encodeURIComponent(clean)}&apikey=${encodeURIComponent(deps.env.TWELVEDATA_API_KEY)}`;
    const res = await safeFetchText(url, {}, deps);
    if (res.ok) {
      try {
        const j = JSON.parse(res.body);
        const price = parsePositivePrice(j.price);
        return { source: 'TwelveData', ok: price !== null, price, tradingDate: parseDateParts(new Date()).ymd, latencyMs: res.latencyMs, error: price !== null ? null : j.message };
      } catch (e) {
        return { source: 'TwelveData', ok: false, price: null, tradingDate: null, latencyMs: res.latencyMs, error: e.message };
      }
    }
    return { source: 'TwelveData', ok: false, price: null, tradingDate: null, latencyMs: res.latencyMs, error: res.error };
  }

  if (deps.env?.FINNHUB_API_KEY) {
    const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(clean)}&token=${encodeURIComponent(deps.env.FINNHUB_API_KEY)}`;
    const res = await safeFetchText(url, {}, deps);
    if (res.ok) {
      try {
        const j = JSON.parse(res.body);
        const price = parsePositivePrice(j.c);
        return { source: 'Finnhub', ok: price !== null, price, tradingDate: parseDateParts(new Date()).ymd, latencyMs: res.latencyMs, error: price !== null ? null : 'No Finnhub quote' };
      } catch (e) {
        return { source: 'Finnhub', ok: false, price: null, tradingDate: null, latencyMs: res.latencyMs, error: e.message };
      }
    }
    return { source: 'Finnhub', ok: false, price: null, tradingDate: null, latencyMs: res.latencyMs, error: res.error };
  }

  return { source: 'TwelveData/Finnhub', ok: false, price: null, tradingDate: null, latencyMs: 0, error: 'Optional US 4th source key not configured' };
}

export async function fetchFourthOfficialHistoricalSeries(ticker, market, startDate, endDate, deps = {}) {
  const clean = normalizeAndValidateTicker(ticker);
  const m = normalizeMarket(market, clean);
  const s = parseDateParts(startDate);
  const e = parseDateParts(endDate);
  if (m === 'CASH') return { source: 'Fugle', ok: true, series: [{ date: e.ymd, close: 1 }], latencyMs: 0, error: null };

  if ((m === 'TWSE' || m === 'TPEX') && deps.env?.FUGLE_API_KEY) {
    const url = `https://api.fugle.tw/marketdata/v1.0/stock/historical/candles/${encodeURIComponent(clean)}?from=${s.ymd}&to=${e.ymd}&fields=close`;
    const res = await safeFetchText(url, { headers: { 'X-API-KEY': deps.env.FUGLE_API_KEY } }, deps);
    if (!res.ok) return { source: 'Fugle', ok: false, series: [], latencyMs: res.latencyMs, error: res.error };
    try {
      const j = JSON.parse(res.body);
      const series = (j.data || [])
        .map((r) => ({ date: String(r.date).slice(0, 10), close: parsePositivePrice(r.close) }))
        .filter((r) => r.close !== null && r.date >= s.ymd && r.date <= e.ymd)
        .sort((a, b) => a.date.localeCompare(b.date));
      return { source: 'Fugle', ok: series.length > 0, series, latencyMs: res.latencyMs, error: series.length ? null : 'Empty Fugle series' };
    } catch (err) {
      return { source: 'Fugle', ok: false, series: [], latencyMs: res.latencyMs, error: err.message };
    }
  }

  if (m === 'US' && deps.env?.TWELVEDATA_API_KEY) {
    const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(clean)}&interval=1day&start_date=${s.ymd}&end_date=${e.ymd}&apikey=${encodeURIComponent(deps.env.TWELVEDATA_API_KEY)}`;
    const res = await safeFetchText(url, {}, deps);
    if (!res.ok) return { source: 'TwelveData', ok: false, series: [], latencyMs: res.latencyMs, error: res.error };
    try {
      const j = JSON.parse(res.body);
      const series = (j.values || [])
        .map((r) => ({ date: String(r.datetime).slice(0, 10), close: parsePositivePrice(r.close) }))
        .filter((r) => r.close !== null)
        .sort((a, b) => a.date.localeCompare(b.date));
      return { source: 'TwelveData', ok: series.length > 0, series, latencyMs: res.latencyMs, error: series.length ? null : 'Empty TwelveData series' };
    } catch (err) {
      return { source: 'TwelveData', ok: false, series: [], latencyMs: res.latencyMs, error: err.message };
    }
  }

  return { source: m === 'US' ? 'TwelveData' : 'Fugle', ok: false, series: [], latencyMs: 0, error: 'Optional 4th API key not configured' };
}

/* ---------------- Optional Source 5: Google Finance via GAS Bridge ---------------- */

export async function fetchGasGoogleFinanceBridge(ticker, market, mode, targetDate, deps = {}) {
  const baseUrl = deps.env?.GAS_BRIDGE_URL;
  if (!baseUrl) return null;
  const clean = normalizeAndValidateTicker(ticker);
  const m = normalizeMarket(market, clean);
  const sep = baseUrl.includes('?') ? '&' : '?';
  const url = `${baseUrl}${sep}mode=${encodeURIComponent(mode)}&ticker=${encodeURIComponent(clean)}&market=${encodeURIComponent(m)}${targetDate ? '&date=' + encodeURIComponent(targetDate) : ''}`;
  const res = await safeFetchText(url, {}, deps);
  if (!res.ok) return { source: 'GoogleFinance(GAS)', ok: false, price: null, tradingDate: null, latencyMs: res.latencyMs, error: res.error };
  try {
    const j = JSON.parse(res.body);
    const price = parsePositivePrice(j.price);
    return { source: 'GoogleFinance(GAS)', ok: price !== null, price, tradingDate: j.tradingDate || targetDate || null, latencyMs: res.latencyMs, error: price !== null ? null : 'Invalid GAS bridge quote' };
  } catch (e) {
    return { source: 'GoogleFinance(GAS)', ok: false, price: null, tradingDate: null, latencyMs: res.latencyMs, error: e.message };
  }
}

/* ---------------- Orchestrators: Concurrent Multi-Source Reconciliation ---------------- */

export async function reconcileLiveTickerMultiSource(ticker, market, deps = {}) {
  const clean = normalizeAndValidateTicker(ticker);
  const m = normalizeMarket(market, clean);
  const todayYmd = parseDateParts(new Date()).ymd;

  if (m === 'CASH') {
    return {
      ticker: 'CASH',
      market: 'CASH',
      ...reconcilePrices([
        { source: 'TWSE/TPEx', ok: true, price: 1, tradingDate: todayYmd, latencyMs: 0 },
        { source: 'YahooFinance', ok: true, price: 1, tradingDate: todayYmd, latencyMs: 0 },
        { source: 'FinMind', ok: true, price: 1, tradingDate: todayYmd, latencyMs: 0 },
      ], 'LIVE'),
    };
  }

  const lookbackStart = shiftDateParts(todayYmd, -10).ymd;
  const tasks = [
    fetchExchangeLive(clean, m, deps),
    fetchYahooLive(clean, m, deps),
    fetchFinMindHistoricalSeries(clean, m, lookbackStart, todayYmd, deps).then((r) => {
      const last = r.ok && r.series.length ? r.series[r.series.length - 1] : null;
      return { source: 'FinMind', ok: Boolean(last), price: last?.close ?? null, tradingDate: last?.date ?? null, latencyMs: r.latencyMs, error: r.error };
    }),
  ];
  if (deps.env?.FUGLE_API_KEY || deps.env?.TWELVEDATA_API_KEY || deps.env?.FINNHUB_API_KEY) {
    tasks.push(fetchFourthOfficialLive(clean, m, deps));
  }
  if (deps.env?.GAS_BRIDGE_URL) {
    tasks.push(fetchGasGoogleFinanceBridge(clean, m, 'live', null, deps));
  }

  const quotes = (await Promise.all(tasks)).filter(Boolean);
  return { ticker: clean, market: m, ...reconcilePrices(quotes, 'LIVE') };
}

export async function reconcileHistoricalDateMultiSource(ticker, market, targetDate, deps = {}) {
  const clean = normalizeAndValidateTicker(ticker);
  const m = normalizeMarket(market, clean);
  const targetYmd = parseDateParts(targetDate).ymd;

  if (m === 'CASH') {
    return {
      ticker: 'CASH',
      market: 'CASH',
      requestedDate: targetYmd,
      ...reconcilePrices([
        { source: 'TWSE/TPEx', ok: true, price: 1, tradingDate: targetYmd, latencyMs: 0 },
        { source: 'YahooFinance', ok: true, price: 1, tradingDate: targetYmd, latencyMs: 0 },
        { source: 'FinMind', ok: true, price: 1, tradingDate: targetYmd, latencyMs: 0 },
      ], 'HISTORICAL'),
    };
  }

  const startYmd = shiftDateParts(targetYmd, -10).ymd;
  const pickLatest = (res) => {
    const last = res.ok && res.series.length ? res.series[res.series.length - 1] : null;
    return { source: res.source, ok: Boolean(last), price: last?.close ?? null, tradingDate: last?.date ?? null, latencyMs: res.latencyMs, error: res.error };
  };

  const tasks = [
    fetchExchangeHistoricalSeries(clean, m, startYmd, targetYmd, deps).then(pickLatest),
    fetchYahooHistoricalSeries(clean, m, startYmd, targetYmd, deps).then(pickLatest),
    fetchFinMindHistoricalSeries(clean, m, startYmd, targetYmd, deps).then(pickLatest),
  ];
  if (deps.env?.FUGLE_API_KEY || deps.env?.TWELVEDATA_API_KEY) {
    tasks.push(fetchFourthOfficialHistoricalSeries(clean, m, startYmd, targetYmd, deps).then(pickLatest));
  }
  if (deps.env?.GAS_BRIDGE_URL) {
    tasks.push(fetchGasGoogleFinanceBridge(clean, m, 'historical', targetYmd, deps));
  }

  const quotes = (await Promise.all(tasks)).filter(Boolean);
  return { ticker: clean, market: m, requestedDate: targetYmd, ...reconcilePrices(quotes, 'HISTORICAL') };
}

export async function reconcileHistoricalRangeMultiSource(ticker, market, startDate, endDate, deps = {}) {
  const clean = normalizeAndValidateTicker(ticker);
  const m = normalizeMarket(market, clean);
  const s = parseDateParts(startDate);
  const e = parseDateParts(endDate);
  const daySpan = Math.round((Date.UTC(e.year, e.month - 1, e.day) - Date.UTC(s.year, s.month - 1, s.day)) / 86400000);
  if (daySpan < 0 || daySpan > WEB_CONFIG.SECURITY.MAX_HISTORY_DAYS) {
    throw new Error(`Date range must be between 0 and ${WEB_CONFIG.SECURITY.MAX_HISTORY_DAYS} days.`);
  }

  const tasks = [
    fetchExchangeHistoricalSeries(clean, m, s.ymd, e.ymd, deps),
    fetchYahooHistoricalSeries(clean, m, s.ymd, e.ymd, deps),
    fetchFinMindHistoricalSeries(clean, m, s.ymd, e.ymd, deps),
  ];
  if (deps.env?.FUGLE_API_KEY || deps.env?.TWELVEDATA_API_KEY) {
    tasks.push(fetchFourthOfficialHistoricalSeries(clean, m, s.ymd, e.ymd, deps));
  }

  const seriesList = await Promise.all(tasks);
  const aligned = alignAndReconcileSeries(clean, m, seriesList);
  return {
    ...aligned,
    startDate: s.ymd,
    endDate: e.ymd,
    sourceMeta: seriesList.map((x) => ({ source: x.source, ok: x.ok, latencyMs: x.latencyMs, error: x.error })),
  };
}

export async function fetchUsdTwdRate(deps = {}) {
  for (const host of ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']) {
    const res = await safeFetchText(`https://${host}/v8/finance/chart/TWD%3DX?range=5d&interval=1d`, {}, deps);
    if (res.ok) {
      try {
        const j = JSON.parse(res.body);
        const rate = parsePositivePrice(j?.chart?.result?.[0]?.meta?.regularMarketPrice);
        if (rate && rate > 20 && rate < 45) {
          return { ok: true, rate: Number(rate.toFixed(4)), source: 'YahooFinance(TWD=X)', latencyMs: res.latencyMs };
        }
      } catch {
        // fallback next host
      }
    }
  }
  const stooq = await safeFetchText('https://stooq.com/q/l/?s=usdtwd&f=sd2t2ohlcv&h&e=csv', {}, deps);
  if (stooq.ok) {
    const cols = stooq.body.trim().split(/\r?\n/)[1]?.split(',') || [];
    const rate = parsePositivePrice(cols[6]);
    if (rate && rate > 20 && rate < 45) {
      return { ok: true, rate: Number(rate.toFixed(4)), source: 'Stooq(usdtwd)', latencyMs: stooq.latencyMs };
    }
  }
  return { ok: false, rate: 32.0, source: 'FallbackDefault', latencyMs: 0 };
}
