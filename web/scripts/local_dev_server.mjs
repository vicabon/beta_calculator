#!/usr/bin/env node
/**
 * @fileoverview Zero-dependency local full-stack dev server simulating:
 *  - Cloudflare Pages static assets (web/public/)
 *  - Cloudflare Pages Functions middleware & /api/* routes
 *  - In-memory Cloudflare D1 SQLite adapter (price_history_cache, user_vault, telemetry_events)
 *  - Optional simulated Cloudflare Zero Trust Access header (`DEV_USER_EMAIL=me@example.com`)
 *  - Optional offline mock quotes (`MOCK_QUOTES=1`)
 *
 * Usage:
 *   DEV_USER_EMAIL=you@gmail.com MOCK_QUOTES=1 node web/scripts/local_dev_server.mjs
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { onRequest as middleware } from '../functions/_middleware.js';
import { onRequestGet as liveHandler } from '../functions/api/quote/live.js';
import { onRequestGet as historyHandler } from '../functions/api/quote/history.js';
import { onRequestGet as rangeHandler } from '../functions/api/quote/range.js';
import { onRequestGet as fxHandler } from '../functions/api/fx/usdtwd.js';
import { onRequestDelete as vaultDelete, onRequestGet as vaultGet, onRequestPut as vaultPut } from '../functions/api/vault.js';
import { onRequestGet as healthHandler } from '../functions/api/health.js';

const WEB_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const PUBLIC_DIR = path.join(WEB_DIR, 'public');

const MIME_MAP = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

/**
 * Lightweight in-memory Cloudflare D1 mock supporting the exact SQL statements used by our APIs.
 */
export class InMemoryD1 {
  constructor() {
    this.priceHistory = new Map(); // key: `${ticker}|${market}|${trade_date}`
    this.userVaults = new Map(); // key: user_email
    this.telemetry = [];
  }

  prepare(sql) {
    const db = this;
    return {
      _params: [],
      bind(...args) {
        this._params = args;
        return this;
      },
      async first() {
        const res = await this.all();
        return res.results[0] || null;
      },
      async all() {
        const q = sql.replace(/\s+/g, ' ').trim();
        const p = this._params;
        if (q.startsWith('SELECT * FROM price_history_cache')) {
          const [ticker, market, maxDate] = p;
          const matches = [...db.priceHistory.values()]
            .filter((r) => r.ticker === ticker && r.market === market && r.trade_date <= maxDate)
            .sort((a, b) => b.trade_date.localeCompare(a.trade_date));
          return { results: matches.slice(0, 1) };
        }
        if (q.startsWith('SELECT COUNT(*) AS c FROM price_history_cache')) {
          return { results: [{ c: db.priceHistory.size }] };
        }
        if (q.startsWith('SELECT user_email, payload_json')) {
          const row = db.userVaults.get(p[0]);
          return { results: row ? [row] : [] };
        }
        if (q.startsWith('SELECT version, updated_at FROM user_vault')) {
          const row = db.userVaults.get(p[0]);
          return { results: row ? [{ version: row.version, updated_at: row.updated_at }] : [] };
        }
        if (q.startsWith('SELECT status, latency_ms, cache_hit FROM telemetry_events')) {
          return { results: [...db.telemetry].reverse().slice(0, 200) };
        }
        return { results: [] };
      },
      async run() {
        const q = sql.replace(/\s+/g, ' ').trim();
        const p = this._params;
        if (q.startsWith('INSERT OR REPLACE INTO price_history_cache')) {
          const [ticker, market, trade_date, consensus_price, valid_source_count, spread_pct, status_code, outlier_source, sources_json, verified_at] = p;
          db.priceHistory.set(`${ticker}|${market}|${trade_date}`, {
            ticker, market, trade_date, consensus_price, valid_source_count, spread_pct, status_code, outlier_source, sources_json, verified_at,
          });
          return { meta: { changes: 1 } };
        }
        if (q.startsWith('INSERT INTO user_vault')) {
          const [user_email, payload_json, is_encrypted, version, updated_at] = p;
          db.userVaults.set(user_email, { user_email, payload_json, is_encrypted, version, updated_at });
          return { meta: { changes: 1 } };
        }
        if (q.startsWith('DELETE FROM user_vault')) {
          const existed = db.userVaults.delete(p[0]);
          return { meta: { changes: existed ? 1 : 0 } };
        }
        if (q.startsWith('INSERT INTO telemetry_events')) {
          const [event_type, status, latency_ms, cache_hit, valid_sources, created_at] = p;
          db.telemetry.push({ event_type, status, latency_ms, cache_hit, valid_sources, created_at });
          return { meta: { changes: 1 } };
        }
        return { meta: { changes: 0 } };
      },
    };
  }
}

export function createOfflineMockFetch() {
  const BASE = { '0050': 195.5, '006208': 112.4, '00662': 88.0, '00685L': 85.0, '00631L': 248.55, '2330': 1030.0, VOO: 542.5 };
  return async (url) => {
    const u = String(url);
    const findPrice = () => {
      for (const [k, v] of Object.entries(BASE)) {
        if (u.toUpperCase().includes(k)) return v;
      }
      return 100.0;
    };
    const px = findPrice();
    if (u.includes('TWD%3DX')) {
      return new Response(JSON.stringify({ chart: { result: [{ meta: { regularMarketPrice: 32.15 } }] } }), { status: 200 });
    }
    if (u.includes('finance.yahoo.com')) {
      const ts = [Math.floor(Date.UTC(2026, 10, 19, 5, 30) / 1000), Math.floor(Date.UTC(2026, 10, 20, 5, 30) / 1000)];
      return new Response(JSON.stringify({
        chart: { result: [{ meta: { regularMarketPrice: px, regularMarketTime: ts[1] }, timestamp: ts, indicators: { quote: [{ close: [px - 1, px] }] } }] },
      }), { status: 200 });
    }
    if (u.includes('mis.twse.com.tw')) {
      return new Response(JSON.stringify({ rtcode: '0000', msgArray: [{ z: (px + 0.05).toFixed(2), d: '20261127' }] }), { status: 200 });
    }
    if (u.includes('twse.com.tw/rwd/zh/afterTrading/STOCK_DAY')) {
      return new Response(JSON.stringify({
        stat: 'OK',
        data: [
          ['115/11/19', '1000', '100000', String(px - 1), String(px), String(px - 2), String(px - 1), '0', '10'],
          ['115/11/20', '1000', '100000', String(px), String(px + 1), String(px - 1), String(px), '+1', '10'],
        ],
      }), { status: 200 });
    }
    if (u.includes('api.finmindtrade.com')) {
      return new Response(JSON.stringify({ status: 200, data: [{ date: '2026-11-19', close: px - 1 }, { date: '2026-11-20', close: px }] }), { status: 200 });
    }
    if (u.includes('stooq.com')) {
      return new Response(`Date,Open,High,Low,Close,Volume\n2026-11-19,${px - 1},${px},${px - 2},${px - 1},1000\n2026-11-20,${px},${px + 1},${px - 1},${px},1200\n`, { status: 200 });
    }
    if (u.includes('api.fugle.tw')) {
      return new Response(JSON.stringify({ lastPrice: px, date: '2026-11-27', data: [{ date: '2026-11-19', close: px - 1 }, { date: '2026-11-20', close: px }] }), { status: 200 });
    }
    return new Response('Not Found', { status: 404 });
  };
}

export function createLocalServer({ port = 8788, devUserEmail = null, mockQuotes = false } = {}) {
  const db = new InMemoryD1();
  const env = {
    APP_ENV: 'development',
    ALLOWED_ORIGINS: `http://localhost:${port},http://127.0.0.1:${port}`,
    DB: db,
    FUGLE_API_KEY: mockQuotes ? 'mock_dev_key_placeholder' : process.env.FUGLE_API_KEY,
    FINMIND_TOKEN: process.env.FINMIND_TOKEN,
  };
  const fetchFn = mockQuotes ? createOfflineMockFetch() : globalThis.fetch;

  const server = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const bodyBuf = Buffer.concat(chunks);
      const fullUrl = `http://127.0.0.1:${port}${req.url}`;
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (Array.isArray(v)) headers.set(k, v.join(', '));
        else if (v !== undefined) headers.set(k, v);
      }
      if (devUserEmail && !headers.has('Cf-Access-Authenticated-User-Email')) {
        headers.set('Cf-Access-Authenticated-User-Email', devUserEmail);
      }

      const webReq = new Request(fullUrl, {
        method: req.method,
        headers,
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : bodyBuf,
      });

      const pathname = new URL(fullUrl).pathname;
      const dispatch = async () => {
        const ctx = { request: webReq, env, fetchFn, waitUntil: (p) => p };
        if (pathname === '/api/quote/live' && req.method === 'GET') return liveHandler(ctx);
        if (pathname === '/api/quote/history' && req.method === 'GET') return historyHandler(ctx);
        if (pathname === '/api/quote/range' && req.method === 'GET') return rangeHandler(ctx);
        if (pathname === '/api/fx/usdtwd' && req.method === 'GET') return fxHandler(ctx);
        if (pathname === '/api/health' && req.method === 'GET') return healthHandler(ctx);
        if (pathname === '/api/vault') {
          if (req.method === 'GET') return vaultGet(ctx);
          if (req.method === 'PUT') return vaultPut(ctx);
          if (req.method === 'DELETE') return vaultDelete(ctx);
        }

        // Static file hosting from web/public/
        const safeRel = path.normalize(pathname === '/' ? '/index.html' : pathname).replace(/^(\.\.[/\\])+/, '');
        const filePath = path.join(PUBLIC_DIR, safeRel);
        if (filePath.startsWith(PUBLIC_DIR) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
          const ext = path.extname(filePath);
          return new Response(fs.readFileSync(filePath), {
            status: 200,
            headers: { 'Content-Type': MIME_MAP[ext] || 'application/octet-stream' },
          });
        }
        return new Response('Not Found', { status: 404 });
      };

      const webResp = await middleware({ request: webReq, env, next: dispatch });
      res.writeHead(webResp.status, Object.fromEntries(webResp.headers.entries()));
      const outBuf = Buffer.from(await webResp.arrayBuffer());
      res.end(outBuf);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });

  return { server, db, env };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT || 8788);
  const host = process.env.HOST || '127.0.0.1';
  const devUserEmail = process.env.DEV_USER_EMAIL || 'local-dev@example.com';
  const mockQuotes = process.env.MOCK_QUOTES === '1';
  const { server } = createLocalServer({ port, devUserEmail, mockQuotes });
  server.listen(port, host, () => {
    console.log(`🔥 BetaCalculator Local Dev Server listening on http://${host}:${port}`);
    console.log(`   Simulated Cloudflare Access User: ${devUserEmail} | MOCK_QUOTES=${mockQuotes}`);
    if (host === '0.0.0.0') {
      console.log(`   📱 LAN Mobile Access enabled: open http://<YOUR_PC_LAN_IP>:${port} on iPhone/Android (Note: Web Crypto E2EE requires HTTPS or localhost; use Cloudflare Pages HTTPS in production).`);
    }
  });
}
