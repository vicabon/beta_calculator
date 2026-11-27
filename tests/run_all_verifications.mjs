#!/usr/bin/env node
/**
 * Comprehensive AI 6-Layer Verification & Automated Test Suite
 * Validates all 5 executable engineering layers (L1-L5) + verifies L6 telemetry readiness
 * per GEMINI.md Rule C.
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

const Config = require(path.join(ROOT, 'gas', 'Config.gs'));
const FireEngine = require(path.join(ROOT, 'gas', 'FireEngine.gs'));
const BetaEngine = require(path.join(ROOT, 'gas', 'BetaEngine.gs'));
const PriceSources = require(path.join(ROOT, 'gas', 'PriceSources.gs'));
const Reconciler = require(path.join(ROOT, 'gas', 'Reconciler.gs'));

const results = {
  L1: [],
  L2: [],
  L3: [],
  L4: [],
  L5: [],
  metrics: {},
};

function check(layer, name, fn) {
  const t0 = performance.now();
  try {
    const detail = fn();
    results[layer].push({ name, pass: true, detail: detail || 'PASS', ms: Number((performance.now() - t0).toFixed(2)) });
  } catch (err) {
    results[layer].push({ name, pass: false, detail: err && err.message ? err.message : String(err), ms: Number((performance.now() - t0).toFixed(2)) });
  }
}

/* ============================================================================
 * LAYER 1: 形式審查 (Structure, Docs, Naming, Manifest, OOXML Integrity)
 * Standard: 100% required fields complete
 * ============================================================================ */

check('L1', 'All required project deliverables exist', () => {
  const required = [
    'GEMINI.md',
    'PROMPT.md',
    'README.md',
    'docs/ARCHITECTURE.md',
    'docs/VERIFICATION_6_LAYERS.md',
    'gas/appsscript.json',
    'gas/Config.gs',
    'gas/FireEngine.gs',
    'gas/BetaEngine.gs',
    'gas/PriceSources.gs',
    'gas/Reconciler.gs',
    'gas/SheetBuilder.gs',
    'gas/Main.gs',
    'gas/Sidebar.html',
    'scripts/generate_xlsx.py',
    'dist/DieWithZero_BetaCalculator.xlsx',
  ];
  const missing = required.filter((rel) => !fs.existsSync(path.join(ROOT, rel)));
  assert.equal(missing.length, 0, 'Missing files: ' + missing.join(', '));
  return `${required.length}/${required.length} files verified`;
});

check('L1', 'appsscript.json manifest schema & V8 runtime valid', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'gas', 'appsscript.json'), 'utf8'));
  assert.equal(manifest.runtimeVersion, 'V8');
  assert.equal(manifest.timeZone, 'Asia/Taipei');
  assert.ok(Array.isArray(manifest.oauthScopes) && manifest.oauthScopes.length === 3);
  assert.ok(manifest.oauthScopes.includes('https://www.googleapis.com/auth/spreadsheets.currentonly'));
  return `V8 / Asia/Taipei / ${manifest.oauthScopes.length} minimal scopes`;
});

check('L1', 'All 6 mandatory default Beta presets present & exact', () => {
  const map = Config.getDefaultBetaMap();
  const expected = { '0050': 1, '006208': 1, '00662': 1, '00685L': 2, '00631L': 2, CASH: 0 };
  for (const [k, v] of Object.entries(expected)) {
    assert.equal(map[k], v, `Default Beta mismatch for ${k}`);
  }
  return '0050=1, 006208=1, 00662=1, 00685L=2, 00631L=2, CASH=0';
});

check('L1', 'All GAS .gs source files parse cleanly as valid V8 JavaScript', () => {
  const gsFiles = fs.readdirSync(path.join(ROOT, 'gas')).filter((f) => f.endsWith('.gs'));
  for (const f of gsFiles) {
    const code = fs.readFileSync(path.join(ROOT, 'gas', f), 'utf8');
    new vm.Script(code, { filename: f });
  }
  return `${gsFiles.length} .gs modules syntax-verified`;
});

check('L1', 'Generated Google Drive .xlsx OOXML ZIP & XML structure valid', () => {
  const pyCheck = `
import zipfile, xml.etree.ElementTree as ET
path = ${JSON.stringify(path.join(ROOT, 'dist', 'DieWithZero_BetaCalculator.xlsx'))}
with zipfile.ZipFile(path, 'r') as zf:
    names = zf.namelist()
    assert '[Content_Types].xml' in names
    assert 'xl/workbook.xml' in names
    assert 'xl/styles.xml' in names
    wb = ET.fromstring(zf.read('xl/workbook.xml'))
    ns = {'m': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
    sheets = wb.findall('.//m:sheet', ns)
    assert len(sheets) == 7, f'Expected 7 sheets, got {len(sheets)}'
    for name in names:
        if name.endswith('.xml') or name.endswith('.rels'):
            root = ET.fromstring(zf.read(name))
            for f_el in root.findall('.//{http://schemas.openxmlformats.org/spreadsheetml/2006/main}f'):
                assert f_el.text and not f_el.text.startswith('='), f'Leading = in formula in {name}: {f_el.text}'
    print(f'OK: {len(names)} parts, {len(sheets)} sheets, all XML & formulas valid')
`;
  const out = execFileSync('python3', ['-c', pyCheck], { encoding: 'utf8' }).trim();
  assert.ok(out.startsWith('OK:'), out);
  return out;
});

/* ============================================================================
 * LAYER 2: 功能驗證 (Functional Verification — Core Test Cases ≥95%)
 * ============================================================================ */

check('L2', 'DWZ: Fisher real return rate accuracy (7% nom, 3% inf)', () => {
  const r = FireEngine.calcRealReturnRate(0.07, 0.03);
  assert.ok(Math.abs(r - (1.07 / 1.03 - 1)) < 1e-12);
  assert.ok(Math.abs(r - 0.0388349514563) < 1e-9);
  return `realReturn=${(r * 100).toFixed(4)}%`;
});

check('L2', 'DWZ: Standard working scenario & Max Monthly Spending round-trip to exact $0', () => {
  const base = {
    status: '還在工作', currentAge: 35, retireAge: 55, lifeExpectancy: 85,
    currentNetWorth: 5000000, monthlySavings: 50000, monthlySpending: 60000,
    nominalReturn: 0.07, inflationRate: 0.03,
  };
  const sim = FireEngine.runFireSimulation(base);
  assert.ok(sim.maxMonthlySpending > 60000, 'Should have surplus spending capacity');
  assert.ok(sim.dwzTargetAtRetireAge < sim.classicFireTarget, 'DWZ target must be lower than 4% FIRE target');
  const rt = FireEngine.runFireSimulation({ ...base, monthlySpending: sim.maxMonthlySpending });
  assert.ok(Math.abs(rt.endingRealBalance) < 0.01, `Expected 0 balance, got ${rt.endingRealBalance}`);
  assert.equal(rt.diagnosisCode, 'OPTIMAL_DWZ');
  return `maxMonthly=${Math.round(sim.maxMonthlySpending)}, roundTripResidual=${rt.endingRealBalance.toFixed(6)}`;
});

check('L2', 'DWZ: Already Retired mode forces savings=0, retireAge=currentAge, round-trips to $0', () => {
  const base = {
    status: '已經退休', currentAge: 50, retireAge: 65, lifeExpectancy: 85,
    currentNetWorth: 15000000, monthlySavings: 80000, monthlySpending: 60000,
    nominalReturn: 0.06, inflationRate: 0.02,
  };
  const sim = FireEngine.runFireSimulation(base);
  assert.equal(sim.inputs.retireAge, 50);
  assert.equal(sim.inputs.monthlySavings, 0);
  assert.equal(sim.workingYears, 0);
  assert.equal(sim.retirementYears, 35);
  const rt = FireEngine.runFireSimulation({ ...base, monthlySpending: sim.maxMonthlySpending });
  assert.ok(Math.abs(rt.endingRealBalance) < 0.01);
  return `retiredMaxMonthly=${Math.round(sim.maxMonthlySpending)}, residual=${rt.endingRealBalance.toFixed(6)}`;
});

check('L2', 'DWZ: Edge case 0% real return (nominal == inflation)', () => {
  const base = {
    status: '還在工作', currentAge: 40, retireAge: 60, lifeExpectancy: 80,
    currentNetWorth: 4000000, monthlySavings: 30000, monthlySpending: 50000,
    nominalReturn: 0.03, inflationRate: 0.03,
  };
  const sim = FireEngine.runFireSimulation(base);
  assert.equal(sim.realReturnRate, 0);
  assert.equal(Math.round(sim.projectedAtRetire), 4000000 + 360000 * 20);
  assert.equal(Math.round(sim.dwzTargetAtRetireAge), 600000 * 20);
  const rt = FireEngine.runFireSimulation({ ...base, monthlySpending: sim.maxMonthlySpending });
  assert.ok(Math.abs(rt.endingRealBalance) < 0.01);
  return `zeroRealReturnTarget=${Math.round(sim.dwzTargetAtRetireAge)}`;
});

check('L2', 'DWZ: Edge case negative real return (inflation > nominal)', () => {
  const base = {
    status: '已經退休', currentAge: 60, retireAge: 60, lifeExpectancy: 85,
    currentNetWorth: 10000000, monthlySavings: 0, monthlySpending: 40000,
    nominalReturn: 0.01, inflationRate: 0.03,
  };
  const sim = FireEngine.runFireSimulation(base);
  assert.ok(sim.realReturnRate < 0);
  const rt = FireEngine.runFireSimulation({ ...base, monthlySpending: sim.maxMonthlySpending });
  assert.ok(Math.abs(rt.endingRealBalance) < 0.01);
  return `negRealMaxMonthly=${Math.round(sim.maxMonthlySpending)}`;
});

check('L2', 'DWZ: Optional pension starting at 65 reduces target & round-trips cleanly', () => {
  const withoutPen = FireEngine.runFireSimulation({
    status: '還在工作', currentAge: 35, retireAge: 55, lifeExpectancy: 85,
    currentNetWorth: 5000000, monthlySavings: 40000, monthlySpending: 60000,
    monthlyPension: 0, pensionStartAge: 65, nominalReturn: 0.07, inflationRate: 0.03,
  });
  const withPenInputs = {
    status: '還在工作', currentAge: 35, retireAge: 55, lifeExpectancy: 85,
    currentNetWorth: 5000000, monthlySavings: 40000, monthlySpending: 60000,
    monthlyPension: 20000, pensionStartAge: 65, nominalReturn: 0.07, inflationRate: 0.03,
  };
  const withPen = FireEngine.runFireSimulation(withPenInputs);
  assert.ok(withPen.dwzTargetAtRetireAge < withoutPen.dwzTargetAtRetireAge);
  const rt = FireEngine.runFireSimulation({ ...withPenInputs, monthlySpending: withPen.maxMonthlySpending });
  assert.ok(Math.abs(rt.endingRealBalance) < 0.01);
  return `targetReduction=${Math.round(withoutPen.dwzTargetAtRetireAge - withPen.dwzTargetAtRetireAge)}`;
});

check('L2', 'DWZ: Depletion detection & Earliest Retirement Age (DWZ <= 4% FIRE)', () => {
  const dep = FireEngine.runFireSimulation({
    status: '已經退休', currentAge: 50, retireAge: 50, lifeExpectancy: 85,
    currentNetWorth: 3000000, monthlySavings: 0, monthlySpending: 80000,
    nominalReturn: 0.05, inflationRate: 0.02,
  });
  assert.equal(dep.diagnosisCode, 'DEPLETED');
  assert.ok(dep.depletionAge !== null && dep.depletionAge < 60);

  const cmp = FireEngine.runFireSimulation({
    status: '還在工作', currentAge: 30, retireAge: 55, lifeExpectancy: 85,
    currentNetWorth: 2000000, monthlySavings: 45000, monthlySpending: 55000,
    nominalReturn: 0.07, inflationRate: 0.03,
  });
  assert.ok(cmp.earliestDwzRetireAge !== null && cmp.earliestClassicFireAge !== null);
  assert.ok(cmp.earliestDwzRetireAge < cmp.earliestClassicFireAge, 'DWZ must allow earlier retirement than 4% FIRE');
  // Verify retiring at earliestDwzRetireAge survives without depletion
  const checkEarly = FireEngine.runFireSimulation({ ...cmp.inputs, retireAge: cmp.earliestDwzRetireAge });
  assert.equal(checkEarly.depletionAge, null);
  return `depletionAge=${dep.depletionAge}, DWZ=${cmp.earliestDwzRetireAge} vs FIRE=${cmp.earliestClassicFireAge} (${cmp.yearsEarlierThanFire} yrs earlier)`;
});

check('L2', 'Portfolio Beta: 50% 00631L (Beta=2) + 50% CASH (Beta=0) => Overall Beta = 1.00', () => {
  const res = BetaEngine.calculatePortfolioBeta([
    { ticker: '00631L', market: 'TWSE', shares: 10000, price: 200 },
    { ticker: 'CASH', market: 'CASH', shares: 2000000, price: 1 },
  ]);
  assert.equal(res.totalValueTwd, 4000000);
  assert.ok(Math.abs(res.overallPortfolioBeta - 1.0) < 1e-9);
  assert.ok(Math.abs(res.equityOnlyBeta - 2.0) < 1e-9);
  assert.ok(Math.abs(res.cashRatio - 0.5) < 1e-9);
  assert.equal(res.equivalentMarketExposureTwd, 4000000);
  return `overallBeta=${res.overallPortfolioBeta}, equityBeta=${res.equityOnlyBeta}`;
});

check('L2', 'Portfolio Beta: All 6 defaults + custom tickers + override Beta + USD FX + Chinese CASH alias', () => {
  const res = BetaEngine.calculatePortfolioBeta(
    [
      { ticker: '0050', market: 'TWSE', shares: 1000, price: 200 }, // 200k * 1 = 200k
      { ticker: '006208', market: 'TWSE', shares: 1000, price: 100 }, // 100k * 1 = 100k
      { ticker: '00662', market: 'TWSE', shares: 1000, price: 100 }, // 100k * 1 = 100k
      { ticker: '00685L', market: 'TWSE', shares: 1000, price: 100 }, // 100k * 2 = 200k
      { ticker: '00631L', market: 'TWSE', shares: 1000, price: 200 }, // 200k * 2 = 400k
      { ticker: '現金Cash', market: 'CASH', shares: 300000, price: 1 }, // 300k * 0 = 0
      { ticker: '2330', market: 'TWSE', shares: 100, price: 1000, customBeta: 1.3 }, // 100k * 1.3 = 130k
      { ticker: 'VOO', market: 'US', shares: 10, currency: 'USD', price: 500, customBeta: 1.0 }, // 10*500*32 = 160k * 1 = 160k
    ],
    { usdTwdRate: 32.0 }
  );
  // Total Value = 200+100+100+100+200+300+100+160 = 1,260,000
  // Exposure = 200+100+100+200+400+0+130+160 = 1,290,000
  assert.equal(res.totalValueTwd, 1260000);
  assert.ok(Math.abs(res.equivalentMarketExposureTwd - 1290000) < 1e-6);
  assert.ok(Math.abs(res.overallPortfolioBeta - 1290000 / 1260000) < 1e-9);
  const weightSum = res.holdings.reduce((s, h) => s + h.weight, 0);
  assert.ok(Math.abs(weightSum - 1.0) < 1e-9);
  return `totalTWD=${res.totalValueTwd}, overallBeta=${res.overallPortfolioBeta.toFixed(4)}`;
});

check('L2', 'Portfolio Beta: Stress Test loss floor capped at -100%', () => {
  const res = BetaEngine.calculatePortfolioBeta([
    { ticker: '00631L', market: 'TWSE', shares: 1000, price: 200, customBeta: 2.5 },
  ]);
  const crash50 = res.stressTests.find((s) => s.marketMove === -0.50);
  assert.equal(crash50.estimatedPortfolioMove, -1.0);
  assert.equal(crash50.postShockValueTwd, 0);
  return 'Beta=2.5 under -50% shock safely floored at -100% / 0 TWD';
});

check('L2', 'Multi-Source Live Reconciliation: 4 authoritative sources agree (0050)', () => {
  PriceSources.clearInMemoryPriceCache();
  const mockDeps = {
    sleep: () => {},
    httpFetch: (url) => {
      if (url.includes('finance.yahoo.com')) {
        return { statusCode: 200, body: JSON.stringify({ chart: { result: [{ meta: { regularMarketPrice: 195.5, regularMarketTime: 1764221400 } }] } }) };
      }
      if (url.includes('mis.twse.com.tw')) {
        return { statusCode: 200, body: JSON.stringify({ rtcode: '0000', msgArray: [{ z: '195.6000', d: '20261127' }] }) };
      }
      if (url.includes('api.finmindtrade.com')) {
        return { statusCode: 200, body: JSON.stringify({ status: 200, data: [{ date: '2026-11-27', close: 195.5 }] }) };
      }
      throw new Error('Unexpected URL: ' + url);
    },
  };
  const res = Reconciler.fetchAndReconcileLiveTicker('0050', 'TWSE', 195.4, mockDeps);
  assert.equal(res.validSourceCount, 4);
  assert.equal(res.meetsThreeSourceRule, true);
  assert.equal(res.statusCode, 'VERIFIED');
  assert.equal(res.consensusPrice, 195.5);
  return `4/4 sources VERIFIED, consensus=${res.consensusPrice}, spread=${(res.spreadPct * 100).toFixed(3)}%`;
});

check('L2', 'Multi-Source Historical Close Reconciliation: ROC date parsing & exact 4-source match (00631L)', () => {
  PriceSources.clearInMemoryPriceCache();
  const mockDeps = {
    sleep: () => {},
    httpFetch: (url) => {
      if (url.includes('finance.yahoo.com')) {
        // 2026-11-20 09:00 Taipei = 2026-11-20 01:00 UTC = 1795136400
        return {
          statusCode: 200,
          body: JSON.stringify({
            chart: {
              result: [{
                timestamp: [Math.floor(Date.UTC(2026, 10, 20, 5, 30, 0) / 1000)],
                indicators: { quote: [{ close: [248.55] }], adjclose: [{ adjclose: [248.55] }] },
              }],
            },
          }),
        };
      }
      if (url.includes('www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY')) {
        return {
          statusCode: 200,
          body: JSON.stringify({
            stat: 'OK',
            data: [['115/11/19', '1,000', '245,000', '245.00', '247.00', '244.00', '246.00', '+1.00', '100'],
                   ['115/11/20', '2,000', '497,100', '247.00', '249.00', '246.50', '248.55', '+2.55', '200']],
          }),
        };
      }
      if (url.includes('api.finmindtrade.com')) {
        return { statusCode: 200, body: JSON.stringify({ status: 200, data: [{ date: '2026-11-20', close: 248.55 }] }) };
      }
      throw new Error('Unexpected URL: ' + url);
    },
  };
  const res = Reconciler.fetchAndReconcileHistoricalTicker('00631L', 'TWSE', '2026-11-20', 248.55, mockDeps);
  assert.equal(res.validSourceCount, 4);
  assert.equal(res.statusCode, 'VERIFIED');
  assert.equal(res.consensusPrice, 248.55);
  assert.deepEqual(res.matchedDates, ['2026-11-20']);
  return `ROC 115/11/20 -> 2026-11-20, 4/4 sources exact match @ ${res.consensusPrice}`;
});

check('L2', 'Reconciler: Median consensus immune to outlier & pinpoints outlier source', () => {
  const rec = Reconciler.reconcilePrices([
    { source: 'GoogleFinance', ok: true, price: 215.0, tradingDate: '2026-11-20' }, // bad outlier
    { source: 'YahooFinance', ok: true, price: 195.0, tradingDate: '2026-11-20' },
    { source: 'TWSE/TPEx', ok: true, price: 195.0, tradingDate: '2026-11-20' },
    { source: 'FinMind', ok: true, price: 195.0, tradingDate: '2026-11-20' },
  ], 'HISTORICAL');
  assert.equal(rec.consensusPrice, 195.0);
  assert.equal(rec.statusCode, 'DISCREPANCY');
  assert.ok(rec.outlierSource.startsWith('GoogleFinance'), `Got outlierSource=${rec.outlierSource}`);
  return `consensus=${rec.consensusPrice}, outlier=${rec.outlierSource}`;
});

check('L2', 'Reconciler: Enforces >=3 sources rule & flags insufficient sources (<3)', () => {
  const rec = Reconciler.reconcilePrices([
    { source: 'GoogleFinance', ok: true, price: 195.0, tradingDate: '2026-11-20' },
    { source: 'YahooFinance', ok: true, price: 195.0, tradingDate: '2026-11-20' },
    { source: 'TWSE/TPEx', ok: false, price: null, error: 'timeout' },
    { source: 'FinMind', ok: false, price: null, error: 'rate limit' },
  ], 'HISTORICAL');
  assert.equal(rec.meetsThreeSourceRule, false);
  assert.equal(rec.statusCode, 'INSUFFICIENT_SOURCES');
  return `validCount=${rec.validSourceCount}, status=${rec.statusCode}`;
});

check('L2', 'Failover: TWSE MIS "-" falls back to OpenAPI & Yahoo query1 429 fails over to query2', () => {
  PriceSources.clearInMemoryPriceCache();
  let yahooQuery2Hit = false;
  let openApiHit = false;
  const mockDeps = {
    sleep: () => {},
    httpFetch: (url) => {
      if (url.includes('query1.finance.yahoo.com')) return { statusCode: 429, body: 'Rate limited' };
      if (url.includes('query2.finance.yahoo.com')) {
        yahooQuery2Hit = true;
        return { statusCode: 200, body: JSON.stringify({ chart: { result: [{ meta: { regularMarketPrice: 112.4, regularMarketTime: 1764221400 } }] } }) };
      }
      if (url.includes('mis.twse.com.tw')) {
        return { statusCode: 200, body: JSON.stringify({ rtcode: '0000', msgArray: [{ z: '-', d: '20261127' }] }) };
      }
      if (url.includes('openapi.twse.com.tw')) {
        openApiHit = true;
        return { statusCode: 200, body: JSON.stringify([{ Date: '1151127', Code: '006208', Name: '富邦台50', ClosingPrice: '112.40' }]) };
      }
      if (url.includes('api.finmindtrade.com')) {
        return { statusCode: 200, body: JSON.stringify({ status: 200, data: [{ date: '2026-11-27', close: 112.4 }] }) };
      }
      throw new Error('Unexpected URL: ' + url);
    },
  };
  const res = Reconciler.fetchAndReconcileLiveTicker('006208', 'TWSE', 112.4, mockDeps);
  assert.equal(yahooQuery2Hit, true);
  assert.equal(openApiHit, true);
  assert.equal(res.statusCode, 'VERIFIED');
  assert.equal(res.consensusPrice, 112.4);
  return 'Yahoo query1->query2 & TWSE MIS->OpenAPI failover verified';
});

check('L2', 'US Stock (VOO) 4-source reconciliation with Stooq CSV + Multi-day historical tracking', () => {
  PriceSources.clearInMemoryPriceCache();
  const mockDeps = {
    sleep: () => {},
    httpFetch: (url) => {
      if (url.includes('finance.yahoo.com')) {
        return {
          statusCode: 200,
          body: JSON.stringify({
            chart: {
              result: [{
                timestamp: [
                  Math.floor(Date.UTC(2026, 10, 18, 21, 0) / 1000),
                  Math.floor(Date.UTC(2026, 10, 19, 21, 0) / 1000),
                ],
                indicators: { quote: [{ close: [540.1, 542.5] }] },
              }],
            },
          }),
        };
      }
      if (url.includes('stooq.com')) {
        return {
          statusCode: 200,
          body: 'Date,Open,High,Low,Close,Volume\n2026-11-18,539,541,538,540.12,1000\n2026-11-19,541,543,540,542.50,1200\n',
        };
      }
      if (url.includes('api.finmindtrade.com')) {
        return {
          statusCode: 200,
          body: JSON.stringify({
            status: 200,
            data: [{ date: '2026-11-18', close: 540.10 }, { date: '2026-11-19', close: 542.50 }],
          }),
        };
      }
      throw new Error('Unexpected URL: ' + url);
    },
  };
  const gfMap = { '2026-11-18': 540.10, '2026-11-19': 560.00 }; // Day 2 injected discrepancy
  const report = Reconciler.trackAndReconcileHistoricalRange('VOO', 'US', '2026-11-18', '2026-11-19', gfMap, mockDeps);
  assert.equal(report.totalTradingDays, 2);
  assert.equal(report.verifiedDays, 1);
  assert.equal(report.discrepancyDays, 1);
  assert.equal(report.rows[1].consensusPrice, 542.5);
  assert.ok(report.rows[1].outlierSource.startsWith('GoogleFinance'));
  return `US VOO 2-day track: verified=1, discrepancy=1 (detected GF outlier)`;
});

/* ============================================================================
 * LAYER 3: 品質評估 (Quality Rubric — Correctness, Completeness, Executability)
 * Standard: >= 4/5
 * ============================================================================ */

check('L3', 'AlphaLab alphalab.site/fire full feature parity check', () => {
  const builderCode = fs.readFileSync(path.join(ROOT, 'gas', 'SheetBuilder.gs'), 'utf8');
  const sidebarCode = fs.readFileSync(path.join(ROOT, 'gas', 'Sidebar.html'), 'utf8');
  const features = [
    ['Working/Retired toggle', builderCode.includes('還在工作') && builderCode.includes('已經退休') && sidebarCode.includes('已經退休')],
    ['Fisher Real Return', builderCode.includes('(1+C20)/(1+C21)-1')],
    ['DWZ Target Capital', builderCode.includes('Die With Zero 退休目標金額')],
    ['Today Retire DWZ Target', builderCode.includes('今日立刻退休所需 DWZ 本金')],
    ['Reverse Max Monthly Spend + One-Click Apply', builderCode.includes('每月最高可花金額') && sidebarCode.includes('套用此開銷')],
    ['DWZ vs 4% FIRE Comparison', builderCode.includes('傳統 FIRE (4% 法則)') && builderCode.includes('可提早退休年數')],
    ['Taiwan MOI Life Expectancy Reference', builderCode.includes('內政部簡易生命表')],
    ['Unadjusted Close Alignment Note', builderCode.includes('未還原收盤價')],
  ];
  const failed = features.filter(([, ok]) => !ok).map(([name]) => name);
  assert.equal(failed.length, 0, 'Missing AlphaLab parity features: ' + failed.join(', '));
  return `${features.length}/${features.length} AlphaLab features verified`;
});

check('L3', 'Sheet formula algebra matches FireEngine.gs output (< 0.01 TWD drift)', () => {
  // Independently emulate Sheet formula column M (`SUM(L_r:L_90) * (1+r)^(age - currentAge)`)
  // and compare against FireEngine.calcDwzCapitalNeededAtAge across every age!
  const p = {
    currentAge: 35, retireAge: 55, lifeExpectancy: 85,
    annualSpending: 720000, annualPension: 240000, pensionStartAge: 65,
    r: FireEngine.calcRealReturnRate(0.07, 0.03),
  };
  const colL = [];
  for (let age = p.currentAge; age <= p.lifeExpectancy; age++) {
    if (age < p.lifeExpectancy) {
      const pen = age >= p.pensionStartAge ? p.annualPension : 0;
      colL.push(Math.max(0, p.annualSpending - pen) / Math.pow(1 + p.r, age - p.currentAge + 1));
    } else {
      colL.push(0);
    }
  }
  let maxDrift = 0;
  for (let idx = 0; idx < colL.length; idx++) {
    const age = p.currentAge + idx;
    const sumL = colL.slice(idx).reduce((a, b) => a + b, 0);
    const sheetFormulaVal = sumL * Math.pow(1 + p.r, age - p.currentAge);
    const engineVal = FireEngine.calcDwzCapitalNeededAtAge(age, p.lifeExpectancy, p.annualSpending, p.annualPension, p.pensionStartAge, p.r).dwzTarget;
    maxDrift = Math.max(maxDrift, Math.abs(sheetFormulaVal - engineVal));
  }
  assert.ok(maxDrift < 1e-6, `Max drift too large: ${maxDrift}`);
  return `51-year cross-verification maxDrift=${maxDrift.toExponential(2)} TWD`;
});

/* ============================================================================
 * LAYER 4: 安全與治理 (Security & Governance — Zero Critical/High Risks)
 * ============================================================================ */

check('L4', 'SSRF & Protocol Downgrade Protection blocks all malicious URLs', () => {
  const maliciousUrls = [
    'http://query1.finance.yahoo.com/v8/finance/chart/0050.TW',
    'https://evil.example.com/steal',
    'https://query1.finance.yahoo.com.evil.com/v8/chart',
    'https://169.254.169.254/latest/meta-data/',
    'https://localhost:8080/internal',
    'https://query1.finance.yahoo.com/test\r\nX-Injected: true',
  ];
  for (const u of maliciousUrls) {
    assert.throws(() => Config.validateAllowedUrl(u), /SecurityError/, `Failed to block: ${u}`);
  }
  // Confirm approved URLs pass
  assert.equal(Config.validateAllowedUrl('https://query1.finance.yahoo.com/v8/finance/chart/0050.TW'), 'https://query1.finance.yahoo.com/v8/finance/chart/0050.TW');
  return `${maliciousUrls.length}/${maliciousUrls.length} SSRF/CRLF vectors blocked`;
});

check('L4', 'Ticker Input Validation blocks path traversal, query injection & XSS', () => {
  const badTickers = ['0050&evil=1', '../etc/passwd', '<script>alert(1)</script>', '=IMPORTXML("a","b")', 'TICKER_TOO_LONG_12345', ''];
  for (const t of badTickers) {
    assert.throws(() => Config.normalizeAndValidateTicker(t), /Invalid ticker|cannot be empty/, `Failed to reject: ${t}`);
  }
  return `${badTickers.length}/${badTickers.length} malicious ticker inputs rejected`;
});

check('L4', 'Spreadsheet Formula Injection (CSV/DDE) Sanitizer neutralizes all payloads', () => {
  const payloads = [
    '=IMPORTXML("https://evil.com","//")',
    '+cmd|\' /C calc\'!A0',
    '-2+3+cmd|\' /C calc\'!A0',
    '@SUM(1+1)*cmd|\' /C calc\'!A0',
  ];
  for (const p of payloads) {
    const clean = Config.sanitizeSheetText(p);
    assert.ok(clean.startsWith("'"), `Payload not escaped: ${p} -> ${clean}`);
  }
  assert.equal(Config.sanitizeSheetText('元大台灣50'), '元大台灣50');
  return `${payloads.length}/${payloads.length} formula injection payloads neutralized`;
});

check('L4', 'Static Security Audit: Zero hardcoded secrets, zero eval/innerHTML, minimal OAuth scopes', () => {
  const gasDir = path.join(ROOT, 'gas');
  const files = fs.readdirSync(gasDir);
  const findings = [];
  const secretRegex = /((?:api_?key|secret|password|finmind_?token)\s*[:=]\s*['"`][A-Za-z0-9_\-\.]{8,}['"`]|bearer\s+[A-Za-z0-9_\-\.]{16,})/i;
  // Self-verify scanner catches a real leaked secret
  assert.ok(secretRegex.test('const api_key = "sk_live_1234567890abcdef";'), 'Secret scanner must catch real leaks');
  for (const f of files) {
    const content = fs.readFileSync(path.join(gasDir, f), 'utf8');
    if (/\beval\s*\(/.test(content) || /\bnew\s+Function\s*\(/.test(content)) {
      findings.push(`${f}: unsafe eval/Function`);
    }
    if (f.endsWith('.html') && /\.innerHTML\s*=/.test(content)) {
      findings.push(`${f}: unsafe innerHTML assignment`);
    }
    if (secretRegex.test(content)) {
      findings.push(`${f}: potential hardcoded secret`);
    }
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(gasDir, 'appsscript.json'), 'utf8'));
  const overBroad = manifest.oauthScopes.filter((s) => s.endsWith('/auth/drive') || s.endsWith('/auth/spreadsheets'));
  assert.equal(overBroad.length, 0, 'Overly broad OAuth scopes: ' + overBroad.join(', '));
  assert.equal(findings.length, 0, 'Security findings: ' + findings.join('; '));
  return `0 Critical / 0 High findings across ${files.length} GAS files`;
});

/* ============================================================================
 * LAYER 5: 穩定性與效能 (Stability, Fault Injection & Performance SLA)
 * Standard: Success rate >= 98%, P95 latency within SLA (<200ms compute / <3000ms fetch)
 * ============================================================================ */

check('L5', 'Compute Performance SLA: 500 full DWZ + Beta simulations P95 < 200ms', () => {
  const records = [];
  for (let i = 0; i < 500; i++) {
    const t0 = performance.now();
    const sim = FireEngine.runFireSimulation({
      status: i % 5 === 0 ? '已經退休' : '還在工作',
      currentAge: 25 + (i % 30),
      retireAge: 55 + (i % 10),
      lifeExpectancy: 85 + (i % 10),
      currentNetWorth: 3000000 + i * 10000,
      monthlySavings: 40000,
      monthlySpending: 55000,
      nominalReturn: 0.07,
      inflationRate: 0.03,
    });
    const beta = BetaEngine.calculatePortfolioBeta([
      { ticker: '0050', market: 'TWSE', shares: 10000, price: 195 },
      { ticker: '00631L', market: 'TWSE', shares: 5000, price: 245 },
      { ticker: 'CASH', market: 'CASH', shares: 1000000, price: 1 },
    ]);
    records.push({ ok: Number.isFinite(sim.maxMonthlySpending) && Number.isFinite(beta.overallPortfolioBeta), latencyMs: performance.now() - t0 });
  }
  const m = Reconciler.computeTelemetryMetrics(records);
  results.metrics.compute = m;
  assert.equal(m.successRate, 1.0);
  assert.ok(m.p95Ms < Config.APP_CONFIG.RETRY_POLICY.SLA_COMPUTE_P95_MS, `Compute P95 ${m.p95Ms}ms exceeded SLA`);
  return `500 runs: success=${(m.successRate * 100).toFixed(1)}%, avg=${m.avgMs}ms, P95=${m.p95Ms.toFixed(2)}ms (SLA <200ms)`;
});

check('L5', 'Fault-Injection Resilience SLA: Retry + Failover under 10% transient API errors (>=98% success)', () => {
  const records = [];
  let callCounter = 0;
  for (let i = 0; i < 100; i++) {
    PriceSources.clearInMemoryPriceCache();
    let simulatedClock = 0;
    const t0 = simulatedClock;
    const mockDeps = {
      now: () => simulatedClock,
      sleep: (ms) => { simulatedClock += ms; },
      httpFetch: (url) => {
        callCounter++;
        simulatedClock += 80; // Simulated 80ms network RTT
        // Inject 10% transient 503 failure on first attempts
        if (callCounter % 10 === 0) {
          return { statusCode: 503, body: 'Service Temporarily Unavailable' };
        }
        if (url.includes('finance.yahoo.com')) {
          return { statusCode: 200, body: JSON.stringify({ chart: { result: [{ meta: { regularMarketPrice: 195.5, regularMarketTime: 1764221400 } }] } }) };
        }
        if (url.includes('mis.twse.com.tw')) {
          return { statusCode: 200, body: JSON.stringify({ rtcode: '0000', msgArray: [{ z: '195.55', d: '20261127' }] }) };
        }
        if (url.includes('api.finmindtrade.com')) {
          return { statusCode: 200, body: JSON.stringify({ status: 200, data: [{ date: '2026-11-27', close: 195.5 }] }) };
        }
        return { statusCode: 404, body: '' };
      },
    };
    const res = Reconciler.fetchAndReconcileLiveTicker('0050', 'TWSE', 195.5, mockDeps);
    records.push({ ok: res.meetsThreeSourceRule && res.statusCode === 'VERIFIED', latencyMs: simulatedClock - t0 });
  }
  const m = Reconciler.computeTelemetryMetrics(records);
  results.metrics.faultInjection = m;
  assert.ok(m.successRate >= Config.APP_CONFIG.RETRY_POLICY.SLA_MIN_SUCCESS_RATE, `Success rate ${m.successRate} below 98% SLA`);
  assert.ok(m.p95Ms < Config.APP_CONFIG.RETRY_POLICY.SLA_FETCH_P95_MS, `Fetch P95 ${m.p95Ms}ms exceeded 3000ms SLA`);
  return `100 fault-injected runs: success=${(m.successRate * 100).toFixed(1)}% (>=98%), P95=${m.p95Ms}ms (SLA <3000ms)`;
});

/* ============================================================================
 * SUMMARY REPORT
 * ============================================================================ */
let totalPass = 0;
let totalFail = 0;
console.log('=====================================================================');
console.log(' AI 6-LAYER VERIFICATION EXECUTION REPORT (Layers 1 - 5 Automated)');
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
console.log(`TOTAL: ${totalPass}/${totalPass + totalFail} passed, ${totalFail} failed`);
console.log('---------------------------------------------------------------------');

if (totalFail > 0) {
  process.exit(1);
}
