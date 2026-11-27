#!/usr/bin/env node
/**
 * Comprehensive AI 6-Layer Verification Suite for the Free Private Web Architecture
 * (Cloudflare Pages + Workers + D1 + Zero Trust Access + E2EE Vault + Google Drive BYOS).
 */

import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { WEB_CONFIG, normalizeAndValidateTicker, sanitizeCsvCell, validateAllowedUrl } from '../packages/core/config.mjs';
import { runFireSimulation } from '../packages/core/fire-engine.mjs';
import { calculatePortfolioBeta } from '../packages/core/beta-engine.mjs';
import { computeTelemetryMetrics, reconcilePrices } from '../packages/core/reconciler.mjs';
import {
  decryptVaultPayload,
  encryptVaultPayload,
  generateRecoveryKey,
  isEncryptedEnvelope,
} from '../packages/core/crypto-vault.mjs';
import { onRequest as middleware } from '../web/functions/_middleware.js';
import { onRequestGet as liveHandler } from '../web/functions/api/quote/live.js';
import { onRequestGet as historyHandler } from '../web/functions/api/quote/history.js';
import { onRequestGet as rangeHandler } from '../web/functions/api/quote/range.js';
import { onRequestGet as fxHandler } from '../web/functions/api/fx/usdtwd.js';
import { onRequestDelete as vaultDelete, onRequestGet as vaultGet, onRequestPut as vaultPut } from '../web/functions/api/vault.js';
import { onRequestGet as healthHandler } from '../web/functions/api/health.js';
import { InMemoryD1, createLocalServer, createOfflineMockFetch } from '../web/scripts/local_dev_server.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const GasFire = require(path.join(ROOT, 'gas', 'FireEngine.gs'));
const GasBeta = require(path.join(ROOT, 'gas', 'BetaEngine.gs'));

const results = { L1: [], L2: [], L3: [], L4: [], L5: [] };

async function check(layer, name, fn) {
  const t0 = performance.now();
  try {
    const detail = await fn();
    results[layer].push({ name, pass: true, detail: detail || 'PASS', ms: Number((performance.now() - t0).toFixed(2)) });
  } catch (err) {
    results[layer].push({ name, pass: false, detail: err?.message || String(err), ms: Number((performance.now() - t0).toFixed(2)) });
  }
}

/* ============================================================================
 * LAYER 1: 形式審查 (Structure, Schema, Core Sync, Gitignore, Manifest)
 * ============================================================================ */

await check('L1', 'All required Web App & Cloudflare deliverables exist', () => {
  const required = [
    '.gitignore',
    '.github/workflows/prewarm-prices.yml',
    'packages/core/config.mjs',
    'packages/core/fire-engine.mjs',
    'packages/core/beta-engine.mjs',
    'packages/core/reconciler.mjs',
    'packages/core/crypto-vault.mjs',
    'packages/core/price-adapters.mjs',
    'web/wrangler.toml',
    'web/migrations/0001_init.sql',
    'web/functions/_middleware.js',
    'web/functions/_lib/http.js',
    'web/functions/api/quote/live.js',
    'web/functions/api/quote/history.js',
    'web/functions/api/quote/range.js',
    'web/functions/api/fx/usdtwd.js',
    'web/functions/api/vault.js',
    'web/functions/api/health.js',
    'web/public/index.html',
    'web/public/manifest.webmanifest',
    'web/public/icon.svg',
    'web/public/sw.js',
    'web/public/css/styles.css',
    'web/public/js/app.js',
    'web/public/js/charts.js',
    'web/public/js/storage-adapters.js',
    'web/scripts/sync_core.mjs',
    'web/scripts/prewarm_prices.mjs',
    'web/scripts/local_dev_server.mjs',
  ];
  const missing = required.filter((rel) => !fs.existsSync(path.join(ROOT, rel)));
  assert.equal(missing.length, 0, 'Missing files: ' + missing.join(', '));
  return `${required.length}/${required.length} files verified`;
});

await check('L1', 'packages/core/ is byte-for-byte synced into web/public/core/ and web/functions/_lib/core/', () => {
  const srcFiles = fs.readdirSync(path.join(ROOT, 'packages', 'core')).filter((f) => f.endsWith('.mjs'));
  for (const f of srcFiles) {
    const src = fs.readFileSync(path.join(ROOT, 'packages', 'core', f), 'utf8');
    const pub = fs.readFileSync(path.join(ROOT, 'web', 'public', 'core', f), 'utf8');
    const fn = fs.readFileSync(path.join(ROOT, 'web', 'functions', '_lib', 'core', f), 'utf8');
    assert.equal(pub, src, `Out-of-sync web/public/core/${f}`);
    assert.equal(fn, src, `Out-of-sync web/functions/_lib/core/${f}`);
  }
  return `${srcFiles.length} core modules 100% synced`;
});

await check('L1', 'All 6 mandatory default Beta presets & .gitignore personal data guards verified', () => {
  const presets = Object.fromEntries(WEB_CONFIG.DEFAULT_BETA_PRESETS.map((p) => [p.ticker, p.beta]));
  assert.deepEqual(presets, { '0050': 1, '006208': 1, '00662': 1, '00685L': 2, '00631L': 2, CASH: 0 });
  const gi = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  for (const pat of ['.env', '*.enc.json', '*my_portfolio*', '.dev.vars']) {
    assert.ok(gi.includes(pat), `.gitignore missing ${pat}`);
  }
  return '6 presets exact + .gitignore protects personal files & secrets';
});

/* ============================================================================
 * LAYER 2: 功能驗證 (Cross-Platform Parity, E2EE Vault, D1 Cache, API Endpoints)
 * ============================================================================ */

await check('L2', 'Cross-Platform Parity: Web FireEngine === GAS FireEngine (< 1e-9 TWD drift)', () => {
  const cases = [
    { status: '還在工作', currentAge: 35, retireAge: 55, lifeExpectancy: 85, currentNetWorth: 5954750, monthlySavings: 50000, monthlySpending: 60000, nominalReturn: 0.07, inflationRate: 0.03 },
    { status: '已經退休', currentAge: 52, retireAge: 52, lifeExpectancy: 88, currentNetWorth: 18000000, monthlySavings: 0, monthlySpending: 70000, monthlyPension: 18000, pensionStartAge: 65, nominalReturn: 0.06, inflationRate: 0.025 },
    { status: '還在工作', currentAge: 40, retireAge: 60, lifeExpectancy: 85, currentNetWorth: 3000000, monthlySavings: 35000, monthlySpending: 50000, nominalReturn: 0.03, inflationRate: 0.03 },
  ];
  let maxDrift = 0;
  for (const c of cases) {
    const w = runFireSimulation(c);
    const g = GasFire.runFireSimulation(c);
    maxDrift = Math.max(maxDrift, Math.abs(w.maxMonthlySpending - g.maxMonthlySpending), Math.abs(w.endingRealBalance - g.endingRealBalance));
    assert.equal(w.earliestDwzRetireAge, g.earliestDwzRetireAge);
  }
  assert.ok(maxDrift < 1e-9, `Drift=${maxDrift}`);
  return `3 scenarios exact parity, maxDrift=${maxDrift.toExponential(2)}`;
});

await check('L2', 'Cross-Platform Parity: Web BetaEngine === GAS BetaEngine (all 6 defaults + custom)', () => {
  const sample = [...WEB_CONFIG.SAMPLE_DUMMY_HOLDINGS, { ticker: 'VOO', market: 'US', shares: 10, currency: 'USD', price: 540, customBeta: 1.0 }];
  const w = calculatePortfolioBeta(sample, { usdTwdRate: 32.15 });
  const g = GasBeta.calculatePortfolioBeta(sample, { usdTwdRate: 32.15 });
  assert.ok(Math.abs(w.overallPortfolioBeta - g.overallPortfolioBeta) < 1e-12);
  assert.ok(Math.abs(w.totalValueTwd - g.totalValueTwd) < 1e-9);
  return `totalTWD=${Math.round(w.totalValueTwd)}, overallBeta=${w.overallPortfolioBeta.toFixed(4)}`;
});

await check('L2', 'Zero-Knowledge E2EE Vault: AES-256-GCM encrypt/decrypt, wrong password & tamper rejection', async () => {
  const recovery = generateRecoveryKey();
  assert.ok(recovery.length >= 40);
  const secretPortfolio = {
    fireInputs: { ...WEB_CONFIG.FIRE_DEFAULTS, currentAge: 42 },
    holdings: [{ ticker: '00631L', market: 'TWSE', shares: 8888, price: 248.55, currency: 'TWD' }],
    usdTwdRate: 32.1,
  };
  const envelope = await encryptVaultPayload(secretPortfolio, 'MySuperSecretPass123!', { iterations: 20000 });
  assert.equal(isEncryptedEnvelope(envelope), true);
  // Ciphertext MUST NOT contain any readable plaintext
  const rawStr = JSON.stringify(envelope);
  assert.ok(!rawStr.includes('00631L'), 'Plaintext ticker leaked into ciphertext!');
  assert.ok(!rawStr.includes('8888'), 'Plaintext shares leaked into ciphertext!');

  const decrypted = await decryptVaultPayload(envelope, 'MySuperSecretPass123!');
  assert.equal(decrypted.holdings[0].shares, 8888);
  assert.equal(decrypted.fireInputs.currentAge, 42);

  await assert.rejects(() => decryptVaultPayload(envelope, 'WrongPassword999!'), /解密失敗/);
  const tampered = { ...envelope, ciphertext: envelope.ciphertext.slice(0, -4) + 'AAAA' };
  await assert.rejects(() => decryptVaultPayload(tampered, 'MySuperSecretPass123!'), /解密失敗/);
  return 'AES-256-GCM round-trip + zero-plaintext + wrong-key & tamper rejection PASS';
});

await check('L2', '/api/vault: Zero Trust auth, E2EE D1 persistence, 409 conflict & IDOR isolation', async () => {
  const db = new InMemoryD1();
  const env = { DB: db };

  // 1. Unauthenticated caller must get 401
  const unauthResp = await vaultGet({ request: new Request('https://app.test/api/vault'), env });
  assert.equal(unauthResp.status, 401);

  // 2. Alice encrypts & saves vault (v1)
  const aliceHeaders = { 'Cf-Access-Authenticated-User-Email': 'alice@example.com', 'Content-Type': 'application/json' };
  const encEnv = await encryptVaultPayload({ holdings: [{ ticker: '0050', shares: 7777, price: 195 }] }, 'AliceSecretKey88!', { iterations: 20000 });
  const put1 = await vaultPut({
    request: new Request('https://app.test/api/vault', { method: 'PUT', headers: aliceHeaders, body: JSON.stringify({ payload: encEnv, expectedVersion: 0 }) }),
    env,
  });
  assert.equal(put1.status, 200);
  const put1Json = await put1.json();
  assert.equal(put1Json.version, 1);
  assert.equal(put1Json.isEncrypted, true);

  // Verify raw D1 row contains ZERO plaintext!
  const rawDbRow = db.userVaults.get('alice@example.com');
  assert.ok(rawDbRow && !rawDbRow.payload_json.includes('7777') && !rawDbRow.payload_json.includes('0050'));

  // 3. Stale device conflict test -> 409 Conflict
  const conflictResp = await vaultPut({
    request: new Request('https://app.test/api/vault', { method: 'PUT', headers: aliceHeaders, body: JSON.stringify({ payload: encEnv, expectedVersion: 0 }) }),
    env,
  });
  assert.equal(conflictResp.status, 409);

  // 4. IDOR Cross-User Attack: Bob passes ?user_email=alice@example.com -> must NOT see Alice's vault!
  const bobHeaders = { 'Cf-Access-Authenticated-User-Email': 'bob@example.com' };
  const bobGet = await vaultGet({
    request: new Request('https://app.test/api/vault?user_email=alice@example.com', { headers: bobHeaders }),
    env,
  });
  const bobJson = await bobGet.json();
  assert.equal(bobJson.exists, false);
  assert.equal(bobJson.userEmail, 'bob@example.com');

  // Bob delete must NOT delete Alice's vault
  await vaultDelete({ request: new Request('https://app.test/api/vault?user_email=alice@example.com', { method: 'DELETE', headers: bobHeaders }), env });
  const aliceStillThere = await (await vaultGet({ request: new Request('https://app.test/api/vault', { headers: aliceHeaders }), env })).json();
  assert.equal(aliceStillThere.exists, true);
  assert.equal(aliceStillThere.version, 1);

  return '401 unauth + D1 ciphertext-only + 409 optimistic lock + IDOR isolation verified';
});

await check('L2', '/api/quote/live: 4-source concurrent reconciliation + batch cap <= 10 enforced', async () => {
  const db = new InMemoryD1();
  const env = { DB: db, FUGLE_API_KEY: 'mock_fugle_placeholder' };
  const fetchFn = createOfflineMockFetch();

  const resp = await liveHandler({
    request: new Request('https://app.test/api/quote/live?tickers=0050,00631L&markets=TWSE,TWSE'),
    env, fetchFn,
  });
  assert.equal(resp.status, 200);
  const data = await resp.json();
  assert.equal(data.results.length, 2);
  assert.equal(data.results[0].validSourceCount, 4);
  assert.equal(data.results[0].statusCode, 'VERIFIED');
  assert.equal(data.results[1].consensusPrice, 248.55);

  // Exceeding 10 tickers cap must return 400
  const tooMany = await liveHandler({
    request: new Request('https://app.test/api/quote/live?tickers=A,B,C,D,E,F,G,H,I,J,K'),
    env, fetchFn,
  });
  assert.equal(tooMany.status, 400);
  return `4/4 sources VERIFIED (0050 & 00631L) + batch cap enforced`;
});

await check('L2', '/api/quote/history: D1 permanent cache MISS -> HIT (0 upstream fetches on 2nd call)', async () => {
  const db = new InMemoryD1();
  const env = { DB: db, FUGLE_API_KEY: 'mock_fugle_placeholder' };
  let fetchCalls = 0;
  const baseMock = createOfflineMockFetch();
  const countingFetch = async (url, opts) => { fetchCalls++; return baseMock(url, opts); };

  const r1 = await historyHandler({
    request: new Request('https://app.test/api/quote/history?ticker=00631L&market=TWSE&date=2026-11-20'),
    env, fetchFn: countingFetch,
  });
  const d1 = await r1.json();
  assert.equal(r1.headers.get('X-Cache'), 'MISS');
  assert.equal(d1.statusCode, 'VERIFIED');
  assert.equal(d1.consensusPrice, 248.55);
  const firstFetchCalls = fetchCalls;
  assert.ok(firstFetchCalls >= 3);

  // Second request MUST hit D1 with ZERO upstream fetch calls!
  const r2 = await historyHandler({
    request: new Request('https://app.test/api/quote/history?ticker=00631L&market=TWSE&date=2026-11-20'),
    env, fetchFn: countingFetch,
  });
  const d2 = await r2.json();
  assert.equal(r2.headers.get('X-Cache'), 'D1-HIT');
  assert.equal(d2.cached, true);
  assert.equal(d2.consensusPrice, 248.55);
  assert.equal(fetchCalls, firstFetchCalls, 'D1 cache hit must trigger 0 upstream fetches!');
  return `MISS (${firstFetchCalls} calls) -> D1-HIT (0 calls) @ ${d2.consensusPrice}`;
});

await check('L2', '/api/quote/range + /api/fx/usdtwd + /api/health + Live HTTP Local Dev Server E2E', async () => {
  const { server } = createLocalServer({ port: 0, devUserEmail: 'e2e@example.com', mockQuotes: true });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  try {
    const htmlResp = await fetch(`${baseUrl}/`);
    assert.equal(htmlResp.status, 200);
    assert.ok(htmlResp.headers.get('content-security-policy')?.includes("object-src 'none'"));

    const manifestResp = await fetch(`${baseUrl}/manifest.webmanifest`);
    assert.equal(manifestResp.status, 200);
    assert.ok(manifestResp.headers.get('content-type')?.includes('manifest+json'));

    const swResp = await fetch(`${baseUrl}/sw.js`);
    assert.equal(swResp.status, 200);

    const fxJson = await (await fetch(`${baseUrl}/api/fx/usdtwd`)).json();
    assert.equal(fxJson.rate, 32.15);

    const rangeJson = await (await fetch(`${baseUrl}/api/quote/range?ticker=VOO&market=US&start=2026-11-18&end=2026-11-20`)).json();
    assert.equal(rangeJson.totalTradingDays, 2);
    assert.equal(rangeJson.verifiedDays, 2);

    const healthJson = await (await fetch(`${baseUrl}/api/health`)).json();
    assert.equal(healthJson.status, 'OK');
    assert.equal(healthJson.authenticatedUser, 'e2e@example.com');
    assert.equal(healthJson.d1Connected, true);
    return `HTTP E2E OK (SPA + CSP + FX=${fxJson.rate} + Range 2/2 verified + Health)`;
  } finally {
    server.close();
  }
});

/* ============================================================================
 * LAYER 3: 品質評估 (AlphaLab Parity, Dual Cloud Adapters, Formula Safety)
 * ============================================================================ */

await check('L3', 'Full AlphaLab parity + Dual Private Storage Adapters + Disclaimer audit', () => {
  const html = fs.readFileSync(path.join(ROOT, 'web', 'public', 'index.html'), 'utf8');
  const adapters = fs.readFileSync(path.join(ROOT, 'web', 'public', 'js', 'storage-adapters.js'), 'utf8');
  for (const token of ['還在工作', '已經退休', '內政部生命表', '一鍵套用此開銷', '一鍵套用 DWZ 最早退休年齡', '免責聲明', 'drive.appdata']) {
    assert.ok(html.includes(token), `index.html missing UX requirement: ${token}`);
  }
  for (const cls of ['LocalIndexedDBAdapter', 'CloudflareD1EncryptedAdapter', 'GoogleDriveAppDataAdapter']) {
    assert.ok(adapters.includes(cls), `storage-adapters.js missing ${cls}`);
  }
  assert.equal(sanitizeCsvCell('=IMPORTXML("http://evil","//")'), "'=IMPORTXML(\"http://evil\",\"//\")");
  return 'AlphaLab 7/7 UX checks + 3 StorageAdapters + CSV sanitizer verified';
});

await check('L3', 'iPhone (iOS Safari/PWA) & Android Chrome Mobile Compatibility Audit', () => {
  const html = fs.readFileSync(path.join(ROOT, 'web', 'public', 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'web', 'public', 'css', 'styles.css'), 'utf8');
  const appJs = fs.readFileSync(path.join(ROOT, 'web', 'public', 'js', 'app.js'), 'utf8');
  const swJs = fs.readFileSync(path.join(ROOT, 'web', 'public', 'sw.js'), 'utf8');
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'web', 'public', 'manifest.webmanifest'), 'utf8'));

  assert.equal(manifest.display, 'standalone');
  assert.ok(html.includes('viewport-fit=cover'), 'Missing viewport-fit=cover for iPhone notch/Dynamic Island');
  assert.ok(html.includes('apple-mobile-web-app-capable'), 'Missing iOS PWA meta tag');
  assert.ok(html.includes('manifest.webmanifest'), 'Missing PWA manifest link');
  assert.ok(html.includes('inputmode="decimal"'), 'Missing mobile numeric keypad inputmode');
  assert.ok(!html.includes('preserveAspectRatio="none"'), 'SVG preserveAspectRatio="none" distorts mobile labels');
  assert.ok(css.includes('font-size: 16px !important'), 'Missing iOS 16px anti-autozoom input rule');
  assert.ok(css.includes('env(safe-area-inset-bottom)'), 'Missing safe-area-inset-bottom padding');
  assert.ok(css.includes('.holdings-table'), 'Missing mobile responsive card layout for holdings table');
  assert.ok(appJs.includes('navigator.storage.persist'), 'Missing Android/Web persistent storage request');
  assert.ok(appJs.includes("register('./sw.js')"), 'Missing Service Worker registration');
  assert.ok(swJs.includes("url.pathname.startsWith('/api/')"), 'Service Worker MUST exclude /api/* from caching');

  // Verify ONLY the holdings table uses holdings-table class (reconciliation tables stay horizontal scroll)
  const holdingsTableMatches = html.match(/class="holdings-table"/g) || [];
  assert.equal(holdingsTableMatches.length, 1, `Expected exactly 1 holdings-table, found ${holdingsTableMatches.length}`);
  return 'PWA manifest + sw.js (API-excluded) + 16px anti-zoom + safe-area + mobile cards + undistorted SVG verified';
});

/* ============================================================================
 * LAYER 4: 安全與治理 (CORS, CSP, SSRF, XSS, Secrets, Zero-PII Telemetry)
 * ============================================================================ */

await check('L4', 'Security Middleware: Strict CSP headers + CORS blocks untrusted third-party origins (403)', async () => {
  const env = { ALLOWED_ORIGINS: 'https://my-app.pages.dev' };
  const blocked = await middleware({
    request: new Request('https://my-app.pages.dev/api/quote/live?tickers=0050', { headers: { Origin: 'https://evil-freeloader.com' } }),
    env,
    next: async () => new Response('ok'),
  });
  assert.equal(blocked.status, 403);

  const allowed = await middleware({
    request: new Request('https://my-app.pages.dev/api/health', { headers: { Origin: 'https://my-app.pages.dev' } }),
    env,
    next: async () => new Response(JSON.stringify({ ok: true })),
  });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get('X-Frame-Options'), 'DENY');
  assert.equal(allowed.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(allowed.headers.get('Referrer-Policy'), 'no-referrer');
  assert.ok(allowed.headers.get('Content-Security-Policy').includes("frame-ancestors 'none'"));
  return 'Untrusted Origin blocked (403) + CSP/XFO/nosniff/no-referrer verified';
});

await check('L4', 'SSRF Allowlist, Ticker Validation & Zero-PII Telemetry Schema Audit', () => {
  for (const badUrl of ['http://api.fugle.tw/x', 'https://169.254.169.254/latest', 'https://api.fugle.tw.evil.com/x', 'https://query1.finance.yahoo.com/a\r\nX:1']) {
    assert.throws(() => validateAllowedUrl(badUrl), /SecurityError/);
  }
  for (const badTicker of ['../etc/passwd', '0050&x=1', '<script>', '=CMD()']) {
    assert.throws(() => normalizeAndValidateTicker(badTicker));
  }
  const sql = fs.readFileSync(path.join(ROOT, 'web', 'migrations', '0001_init.sql'), 'utf8');
  const telBlock = sql.slice(sql.indexOf('CREATE TABLE IF NOT EXISTS telemetry_events'));
  assert.ok(!/user_email|shares|net_worth|payload/i.test(telBlock), 'telemetry_events must never store PII or asset columns');
  return 'SSRF/Ticker attacks blocked + telemetry_events strictly zero-PII';
});

await check('L4', 'Static Security Scan across packages/core & web/: 0 innerHTML, 0 eval, 0 hardcoded secrets', () => {
  const dirs = [
    path.join(ROOT, 'packages', 'core'),
    path.join(ROOT, 'web', 'functions'),
    path.join(ROOT, 'web', 'functions', '_lib'),
    path.join(ROOT, 'web', 'functions', 'api'),
    path.join(ROOT, 'web', 'functions', 'api', 'quote'),
    path.join(ROOT, 'web', 'functions', 'api', 'fx'),
    path.join(ROOT, 'web', 'public', 'js'),
    path.join(ROOT, 'web', 'scripts'),
  ];
  const secretRegex = /((?:api_?key|secret|password|finmind_?token|fugle_?api_?key)\s*[:=]\s*['"`](?!mock_)[A-Za-z0-9_\-\.]{12,}['"`]|bearer\s+[A-Za-z0-9_\-\.]{16,})/i;
  const findings = [];
  let fileCount = 0;
  for (const d of dirs) {
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d)) {
      const full = path.join(d, f);
      if (!fs.statSync(full).isFile() || (!f.endsWith('.js') && !f.endsWith('.mjs'))) continue;
      fileCount++;
      const txt = fs.readFileSync(full, 'utf8');
      if (/\beval\s*\(/.test(txt) || /\bnew\s+Function\s*\(/.test(txt)) findings.push(`${f}: eval/Function`);
      if (/\.innerHTML\s*=/.test(txt)) findings.push(`${f}: innerHTML`);
      if (secretRegex.test(txt)) findings.push(`${f}: hardcoded secret`);
    }
  }
  assert.equal(findings.length, 0, 'Findings: ' + findings.join('; '));
  return `0 Critical / 0 High findings across ${fileCount} JS/MJS modules`;
});

/* ============================================================================
 * LAYER 5: 穩定性與效能 (Compute SLA, D1 Cache Hit SLA, Fault-Injection 4-of-3 SLA)
 * ============================================================================ */

await check('L5', 'Compute & D1 Cache Hit Performance SLA (Compute P95 <200ms, D1 Hit P95 <150ms)', async () => {
  const compRecs = [];
  for (let i = 0; i < 500; i++) {
    const t0 = performance.now();
    const s = runFireSimulation({ ...WEB_CONFIG.FIRE_DEFAULTS, currentNetWorth: 5000000 + i * 5000 });
    const b = calculatePortfolioBeta(WEB_CONFIG.SAMPLE_DUMMY_HOLDINGS);
    compRecs.push({ ok: Number.isFinite(s.maxMonthlySpending) && Number.isFinite(b.overallPortfolioBeta), latencyMs: performance.now() - t0 });
  }
  const cm = computeTelemetryMetrics(compRecs);
  assert.equal(cm.successRate, 1);
  assert.ok(cm.p95Ms < WEB_CONFIG.RETRY_POLICY.SLA_COMPUTE_P95_MS);

  // D1 permanent cache hit benchmark (50 hits)
  const db = new InMemoryD1();
  const env = { DB: db, FUGLE_API_KEY: 'mock_fugle_placeholder' };
  const mockFetch = createOfflineMockFetch();
  await historyHandler({ request: new Request('https://app.test/api/quote/history?ticker=0050&market=TWSE&date=2026-11-20'), env, fetchFn: mockFetch });
  const hitRecs = [];
  for (let i = 0; i < 50; i++) {
    const t0 = performance.now();
    const r = await historyHandler({ request: new Request('https://app.test/api/quote/history?ticker=0050&market=TWSE&date=2026-11-20'), env, fetchFn: mockFetch });
    hitRecs.push({ ok: r.headers.get('X-Cache') === 'D1-HIT', latencyMs: performance.now() - t0 });
  }
  const hm = computeTelemetryMetrics(hitRecs);
  assert.equal(hm.successRate, 1);
  assert.ok(hm.p95Ms < WEB_CONFIG.RETRY_POLICY.SLA_CACHE_HIT_P95_MS);
  return `Compute 500x P95=${cm.p95Ms.toFixed(2)}ms (<200ms) | D1-HIT 50x P95=${hm.p95Ms.toFixed(2)}ms (<150ms)`;
});

await check('L5', 'Fault-Injection Resilience SLA: 100 concurrent 4-source live runs under 10% HTTP 503 (>=98% success, P95 <2500ms)', async () => {
  const baseMock = createOfflineMockFetch();
  let reqCount = 0;
  const recs = [];
  for (let i = 0; i < 100; i++) {
    let clock = 0;
    const t0 = clock;
    const faultyFetch = async (url, opts) => {
      reqCount++;
      clock += 60;
      if (reqCount % 10 === 0) return new Response('Service Unavailable', { status: 503 });
      return baseMock(url, opts);
    };
    const resp = await liveHandler({
      request: new Request('https://app.test/api/quote/live?tickers=0050&markets=TWSE'),
      env: { FUGLE_API_KEY: 'mock_fugle_placeholder' },
      fetchFn: faultyFetch,
      nowFn: () => clock,
      sleepFn: async (ms) => { clock += ms; },
    });
    const data = await resp.json();
    const r = data.results[0];
    recs.push({ ok: r.meetsThreeSourceRule && r.statusCode === 'VERIFIED', latencyMs: clock - t0 });
  }
  const m = computeTelemetryMetrics(recs);
  assert.ok(m.successRate >= WEB_CONFIG.RETRY_POLICY.SLA_MIN_SUCCESS_RATE, `Success rate ${m.successRate} < 98%`);
  assert.ok(m.p95Ms < WEB_CONFIG.RETRY_POLICY.SLA_LIVE_FETCH_P95_MS, `P95 ${m.p95Ms}ms >= 2500ms`);
  return `100 fault-injected runs: success=${(m.successRate * 100).toFixed(1)}% (>=98%), P95=${m.p95Ms}ms (<2500ms)`;
});

/* ============================================================================
 * SUMMARY OUTPUT
 * ============================================================================ */
let totalPass = 0;
let totalFail = 0;
console.log('=====================================================================');
console.log(' WEB APP AI 6-LAYER VERIFICATION REPORT (Layers 1 - 5 Automated)');
console.log('=====================================================================');
for (const layer of ['L1', 'L2', 'L3', 'L4', 'L5']) {
  const items = results[layer];
  const passed = items.filter((x) => x.pass).length;
  const failed = items.length - passed;
  totalPass += passed;
  totalFail += failed;
  console.log(`\n[${layer}] ${passed}/${items.length} passed (${((passed / items.length) * 100).toFixed(1)}%)`);
  for (const item of items) {
    console.log(`  ${item.pass ? '✅' : '❌'} ${item.name} — ${item.detail} (${item.ms}ms)`);
  }
}
console.log('\n---------------------------------------------------------------------');
console.log(`WEB APP TOTAL: ${totalPass}/${totalPass + totalFail} passed, ${totalFail} failed`);
console.log('---------------------------------------------------------------------');

if (totalFail > 0) process.exit(1);
