/**
 * @fileoverview Main SPA controller integrating:
 *  - AlphaLab Die With Zero calculator (real-time 60fps sliders + one-click apply)
 *  - Custom portfolio & overall Beta calculation + crash stress tests
 *  - Multi-source live / historical / range stock price reconciliation via /api/quote/*
 *  - Progressive private storage (Local IndexedDB + Cloudflare D1 E2EE + Google Drive drive.appdata)
 *
 * Security: 100% DOM API / textContent rendering (ZERO innerHTML).
 */

import { WEB_CONFIG, sanitizeCsvCell } from '../core/config.mjs';
import { calcCapmReferenceReturn, runFireSimulation } from '../core/fire-engine.mjs';
import { calculatePortfolioBeta } from '../core/beta-engine.mjs';
import {
  decryptVaultPayload,
  encryptVaultPayload,
  generateRecoveryKey,
  isEncryptedEnvelope,
  validateVaultPayload,
} from '../core/crypto-vault.mjs';
import {
  CloudflareD1EncryptedAdapter,
  GoogleDriveAppDataAdapter,
  LocalIndexedDBAdapter,
} from './storage-adapters.js';
import {
  renderBetaExposureChart,
  renderFireTrajectoryChart,
  renderHistoryPriceChart,
} from './charts.js';

const $ = (id) => document.getElementById(id);
const localStore = new LocalIndexedDBAdapter();
const cfVault = new CloudflareD1EncryptedAdapter();
const gdriveVault = new GoogleDriveAppDataAdapter();

const appState = {
  fireInputs: { ...WEB_CONFIG.FIRE_DEFAULTS },
  holdings: WEB_CONFIG.SAMPLE_DUMMY_HOLDINGS.map((h) => ({ ...h })),
  customPresets: {},
  usdTwdRate: 32.0,
  lastPortfolioResult: null,
  lastFireResult: null,
  liveReconciliations: [],
  histReconciliations: [],
  rangeReport: null,
  saveTimer: null,
};

function fmtMoney(n) {
  if (!Number.isFinite(n)) return '--';
  return Math.round(n).toLocaleString('en-US');
}

function fmtWan(n) {
  if (!Number.isFinite(n)) return '--';
  if (Math.abs(n) >= 10000) return `${(n / 10000).toFixed(1)} 萬`;
  return fmtMoney(n);
}

function showToast(msg, type = 'ok') {
  const bar = $('toastBar');
  bar.textContent = msg;
  bar.className = `toast${type === 'warn' ? ' warn' : type === 'error' ? ' error' : ''}`;
  clearTimeout(bar._hideTimer);
  bar._hideTimer = setTimeout(() => bar.classList.add('hidden'), 5000);
}

function scheduleLocalAutoSave() {
  clearTimeout(appState.saveTimer);
  appState.saveTimer = setTimeout(async () => {
    const saved = await localStore.save({
      fireInputs: appState.fireInputs,
      holdings: appState.holdings,
      customPresets: appState.customPresets,
      usdTwdRate: appState.usdTwdRate,
    });
    const t = new Date(saved.updatedAt).toLocaleTimeString('zh-TW', { hour12: false });
    $('topSyncPill').textContent = `💾 本機已自動保存 (${t})`;
  }, 250);
}

/* ============================================================================
 * PORTFOLIO & BETA RENDERING
 * ============================================================================ */
function recalcPortfolio() {
  let port;
  try {
    port = calculatePortfolioBeta(appState.holdings, { usdTwdRate: appState.usdTwdRate });
  } catch (err) {
    showToast(err.message, 'error');
    return;
  }
  appState.lastPortfolioResult = port;

  $('topBetaPill').textContent = `整體 Beta: ${port.overallPortfolioBeta.toFixed(2)}`;
  $('portTotalVal').textContent = `${fmtMoney(port.totalValueTwd)} TWD`;
  $('portCashSub').textContent = `現金比例：${(port.cashRatio * 100).toFixed(1)}% (${fmtMoney(port.cashValueTwd)})`;
  $('portOverallBeta').textContent = port.overallPortfolioBeta.toFixed(2);
  $('portEquityBeta').textContent = port.equityOnlyBeta.toFixed(2);
  $('portEquityValSub').textContent = `純股票市值：${fmtMoney(port.equityValueTwd)} TWD`;
  $('portExposure').textContent = `${fmtMoney(port.equivalentMarketExposureTwd)} TWD`;
  $('portFxSub').textContent = `USD/TWD 匯率：${appState.usdTwdRate.toFixed(3)}`;

  const capmRef = calcCapmReferenceReturn(port.overallPortfolioBeta);
  $('capmHint').textContent = `依持倉整體 Beta (${port.overallPortfolioBeta.toFixed(2)}) CAPM 參考報酬：${(capmRef * 100).toFixed(2)}%`;

  renderBetaExposureChart($('betaBarSvg'), port.holdings);
  renderStressTable(port.stressTests);

  if (appState.fireInputs.netWorthMode === '連動持倉總市值') {
    $('fireNetWorth').value = Math.round(port.totalValueTwd);
  }
  recalcFire();
}

function renderHoldingsTable() {
  const tbody = $('holdingsTbody');
  while (tbody.firstChild) tbody.removeChild(tbody.firstChild);
  const port = appState.lastPortfolioResult;
  const evalMap = new Map((port?.holdings || []).map((h, i) => [i, h]));

  appState.holdings.forEach((h, idx) => {
    const ev = evalMap.get(idx);
    const tr = document.createElement('tr');

    const addCell = (node, label, cls = '') => {
      const td = document.createElement('td');
      if (label) td.dataset.label = label;
      if (cls) td.className = cls;
      if (typeof node === 'string') td.textContent = node;
      else td.appendChild(node);
      tr.appendChild(td);
    };

    const inTicker = document.createElement('input');
    inTicker.className = 'narrow';
    inTicker.value = h.ticker;
    inTicker.setAttribute('autocapitalize', 'characters');
    inTicker.addEventListener('change', () => {
      h.ticker = inTicker.value.trim().toUpperCase();
      if (h.ticker === 'CASH' || h.ticker === '現金') { h.ticker = 'CASH'; h.market = 'CASH'; h.price = 1; h.currency = 'TWD'; }
      recalcPortfolio(); renderHoldingsTable(); scheduleLocalAutoSave();
    });
    addCell(inTicker, '股票代號');

    const selMarket = document.createElement('select');
    ['TWSE', 'TPEX', 'US', 'CASH'].forEach((m) => {
      const opt = document.createElement('option');
      opt.value = m; opt.textContent = m;
      if (h.market === m) opt.selected = true;
      selMarket.appendChild(opt);
    });
    selMarket.addEventListener('change', () => {
      h.market = selMarket.value;
      if (h.market === 'US') h.currency = 'USD';
      else if (h.market === 'CASH') { h.currency = 'TWD'; h.price = 1; }
      else h.currency = 'TWD';
      recalcPortfolio(); renderHoldingsTable(); scheduleLocalAutoSave();
    });
    addCell(selMarket, '市場別');

    const inName = document.createElement('input');
    inName.value = h.name || '';
    inName.style.width = '125px';
    inName.addEventListener('change', () => { h.name = inName.value; scheduleLocalAutoSave(); });
    addCell(inName, '資產名稱');

    const inShares = document.createElement('input');
    inShares.type = 'number'; inShares.inputMode = 'decimal'; inShares.className = 'num-in'; inShares.min = '0'; inShares.step = 'any';
    inShares.value = h.shares;
    inShares.addEventListener('input', () => {
      h.shares = Math.max(0, Number(inShares.value) || 0);
      recalcPortfolio(); updateHoldingsComputedCells(); scheduleLocalAutoSave();
    });
    addCell(inShares, '持有股數 / 金額', 'num');

    const selCurr = document.createElement('select');
    ['TWD', 'USD'].forEach((c) => {
      const opt = document.createElement('option');
      opt.value = c; opt.textContent = c;
      if ((h.currency || 'TWD') === c) opt.selected = true;
      selCurr.appendChild(opt);
    });
    selCurr.addEventListener('change', () => { h.currency = selCurr.value; recalcPortfolio(); updateHoldingsComputedCells(); scheduleLocalAutoSave(); });
    addCell(selCurr, '幣別');

    const inPrice = document.createElement('input');
    inPrice.type = 'number'; inPrice.inputMode = 'decimal'; inPrice.className = 'num-in'; inPrice.min = '0'; inPrice.step = 'any';
    inPrice.value = h.market === 'CASH' ? 1 : h.price;
    inPrice.disabled = h.market === 'CASH';
    inPrice.addEventListener('input', () => {
      h.price = Math.max(0, Number(inPrice.value) || 0);
      recalcPortfolio(); updateHoldingsComputedCells(); scheduleLocalAutoSave();
    });
    addCell(inPrice, '股價（共識價）', 'num');

    const mvTd = document.createElement('td'); mvTd.dataset.label = '市值 (TWD)'; mvTd.className = 'num'; mvTd.dataset.col = 'mv'; mvTd.textContent = ev ? fmtMoney(ev.marketValueTwd) : '--'; tr.appendChild(mvTd);
    const wtTd = document.createElement('td'); wtTd.dataset.label = '權重'; wtTd.className = 'num'; wtTd.dataset.col = 'wt'; wtTd.textContent = ev ? `${(ev.weight * 100).toFixed(2)}%` : '--'; tr.appendChild(wtTd);
    const dbTd = document.createElement('td'); dbTd.dataset.label = '預設 Beta'; dbTd.className = 'num'; dbTd.dataset.col = 'db'; dbTd.textContent = ev?.defaultBeta !== null && ev?.defaultBeta !== undefined ? ev.defaultBeta.toFixed(2) : '未預設(1)'; tr.appendChild(dbTd);

    const inBeta = document.createElement('input');
    inBeta.type = 'number'; inBeta.inputMode = 'decimal'; inBeta.className = 'num-in'; inBeta.step = '0.05'; inBeta.placeholder = '自動';
    inBeta.value = h.customBeta !== undefined && h.customBeta !== null ? h.customBeta : '';
    inBeta.addEventListener('input', () => {
      h.customBeta = inBeta.value === '' ? '' : Number(inBeta.value);
      recalcPortfolio(); updateHoldingsComputedCells(); scheduleLocalAutoSave();
    });
    addCell(inBeta, '自訂覆寫 Beta', 'num');

    const ebTd = document.createElement('td'); ebTd.dataset.label = '採用 Beta'; ebTd.className = 'num'; ebTd.dataset.col = 'eb'; ebTd.textContent = ev ? ev.effectiveBeta.toFixed(2) : '--'; tr.appendChild(ebTd);
    const wbTd = document.createElement('td'); wbTd.dataset.label = '加權貢獻'; wbTd.className = 'num'; wbTd.dataset.col = 'wb'; wbTd.textContent = ev ? ev.weightedBetaContribution.toFixed(4) : '--'; tr.appendChild(wbTd);

    const delBtn = document.createElement('button');
    delBtn.type = 'button'; delBtn.className = 'chip'; delBtn.textContent = '刪除';
    delBtn.addEventListener('click', () => {
      appState.holdings.splice(idx, 1);
      recalcPortfolio(); renderHoldingsTable(); scheduleLocalAutoSave();
    });
    addCell(delBtn, '操作');

    tbody.appendChild(tr);
  });
}

function updateHoldingsComputedCells() {
  const rows = $('holdingsTbody').querySelectorAll('tr');
  const evaluated = appState.lastPortfolioResult?.holdings || [];
  rows.forEach((tr, idx) => {
    const ev = evaluated[idx];
    if (!ev) return;
    tr.querySelector('[data-col="mv"]').textContent = fmtMoney(ev.marketValueTwd);
    tr.querySelector('[data-col="wt"]').textContent = `${(ev.weight * 100).toFixed(2)}%`;
    tr.querySelector('[data-col="db"]').textContent = ev.defaultBeta !== null ? ev.defaultBeta.toFixed(2) : '未預設(1)';
    tr.querySelector('[data-col="eb"]').textContent = ev.effectiveBeta.toFixed(2);
    tr.querySelector('[data-col="wb"]').textContent = ev.weightedBetaContribution.toFixed(4);
  });
}

function renderStressTable(tests) {
  const tbody = $('stressTbody');
  while (tbody.firstChild) tbody.removeChild(tbody.firstChild);
  for (const s of tests || []) {
    const tr = document.createElement('tr');
    [
      [s.label, ''],
      [`${s.marketMove >= 0 ? '+' : ''}${(s.marketMove * 100).toFixed(0)}%`, 'num'],
      [`${s.estimatedPortfolioMove >= 0 ? '+' : ''}${(s.estimatedPortfolioMove * 100).toFixed(1)}%`, 'num'],
      [`${s.estimatedValueChangeTwd >= 0 ? '+' : ''}${fmtMoney(s.estimatedValueChangeTwd)}`, 'num'],
      [fmtMoney(s.postShockValueTwd), 'num'],
    ].forEach(([txt, cls]) => {
      const td = document.createElement('td');
      if (cls) td.className = cls;
      td.textContent = txt;
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  }
}

/* ============================================================================
 * DIE WITH ZERO CALCULATOR RENDERING
 * ============================================================================ */
function readFireInputsFromDom() {
  const nw = appState.fireInputs.netWorthMode === '連動持倉總市值'
    ? (appState.lastPortfolioResult?.totalValueTwd ?? Number($('fireNetWorth').value) ?? 0)
    : (Number($('fireNetWorth').value) || 0);

  appState.fireInputs = {
    ...appState.fireInputs,
    currentAge: Number($('fireAge').value) || 35,
    retireAge: Number($('fireRetireAge').value) || 55,
    lifeExpectancy: Math.max((Number($('fireAge').value) || 35) + 1, Number($('fireLifeExp').value) || 85),
    manualNetWorth: appState.fireInputs.netWorthMode === '手動輸入' ? nw : appState.fireInputs.manualNetWorth,
    currentNetWorth: nw,
    monthlySavings: Number($('fireMonthlySavings').value) || 0,
    monthlySpending: Number($('fireMonthlySpending').value) || 0,
    monthlyPension: Number($('fireMonthlyPension').value) || 0,
    pensionStartAge: Number($('firePensionAge').value) || 65,
    nominalReturn: (Number($('fireNominalReturn').value) || 0) / 100,
    inflationRate: (Number($('fireInflation').value) || 0) / 100,
    classicFireSwr: Math.max(0.005, (Number($('fireSwr').value) || 4.0) / 100),
  };
  return appState.fireInputs;
}

function syncDomFromFireInputs() {
  const f = appState.fireInputs;
  $('statusWorkingBtn').className = `toggle-btn${f.status === '還在工作' ? ' active' : ''}`;
  $('statusRetiredBtn').className = `toggle-btn${f.status === '已經退休' ? ' active' : ''}`;
  $('fireRetireWrap').style.display = f.status === '還在工作' ? 'block' : 'none';
  $('fireSavingsWrap').style.display = f.status === '還在工作' ? 'block' : 'none';

  $('nwLinkedBtn').className = `toggle-btn${f.netWorthMode === '連動持倉總市值' ? ' active' : ''}`;
  $('nwManualBtn').className = `toggle-btn${f.netWorthMode === '手動輸入' ? ' active' : ''}`;
  $('fireNetWorth').disabled = f.netWorthMode === '連動持倉總市值';

  $('fireAge').value = f.currentAge; $('fireAgeRange').value = f.currentAge;
  $('fireRetireAge').value = f.retireAge; $('fireRetireAgeRange').value = f.retireAge;
  $('fireLifeExp').value = f.lifeExpectancy; $('fireLifeExpRange').value = f.lifeExpectancy;
  $('fireNetWorth').value = Math.round(f.netWorthMode === '連動持倉總市值' ? (appState.lastPortfolioResult?.totalValueTwd ?? f.manualNetWorth) : f.manualNetWorth);
  $('fireMonthlySavings').value = f.monthlySavings;
  $('fireMonthlySpending').value = f.monthlySpending;
  $('fireMonthlyPension').value = f.monthlyPension || 0;
  $('firePensionAge').value = f.pensionStartAge || 65;
  $('fireNominalReturn').value = (f.nominalReturn * 100).toFixed(1); $('fireNominalReturnRange').value = (f.nominalReturn * 100).toFixed(1);
  $('fireInflation').value = (f.inflationRate * 100).toFixed(1); $('fireInflationRange').value = (f.inflationRate * 100).toFixed(1);
  $('fireSwr').value = ((f.classicFireSwr || 0.04) * 100).toFixed(1);
}

function recalcFire() {
  const inputs = readFireInputsFromDom();
  let sim;
  try {
    sim = runFireSimulation(inputs);
  } catch (err) {
    $('fireDiagnosisBox').textContent = `⚠️ 參數錯誤：${err.message}`;
    $('fireDiagnosisBox').className = 'diag-banner warn';
    return;
  }
  appState.lastFireResult = sim;

  $('realReturnBadge').textContent = `Fisher 實質報酬：${(sim.realReturnRate * 100).toFixed(2)}%`;
  $('fireDiagnosisBox').textContent = sim.diagnosisText;
  $('fireDiagnosisBox').className = `diag-banner${sim.diagnosisCode === 'DEPLETED' ? ' warn' : ''}`;

  $('kpiMaxMonthly').textContent = `${fmtMoney(sim.maxMonthlySpending)} /月`;
  $('kpiDwzRetire').textContent = fmtWan(sim.dwzTargetAtRetireAge);
  $('kpiDwzTodaySub').textContent = `今日立刻退休需：${fmtWan(sim.dwzTargetToday)}`;
  $('kpiEndBalance').textContent = fmtWan(sim.endingRealBalance);
  $('kpiClassicFireSub').textContent = `傳統 4% FIRE 目標：${fmtWan(sim.classicFireTarget)}`;

  const dwzAge = sim.earliestDwzRetireAge !== null ? `${sim.earliestDwzRetireAge}歲` : '未達';
  const fireAge = sim.earliestClassicFireAge !== null ? `${sim.earliestClassicFireAge}歲` : '未達';
  $('kpiEarliest').textContent = `${dwzAge} vs ${fireAge}`;
  $('kpiYearsSaved').textContent = sim.yearsEarlierThanFire !== null
    ? `Die With Zero 可提早 ${sim.yearsEarlierThanFire} 年退休`
    : '持續累積以達成財務自由';

  renderFireTrajectoryChart($('fireChartSvg'), sim.trajectory);

  const tbody = $('trajectoryTbody');
  while (tbody.firstChild) tbody.removeChild(tbody.firstChild);
  for (const row of sim.trajectory) {
    const tr = document.createElement('tr');
    [
      [`${row.age}歲`, ''],
      [row.phase, ''],
      [fmtMoney(row.startRealBalance), 'num'],
      [fmtMoney(row.realInvestmentGain), 'num'],
      [fmtMoney(row.netAnnualCashFlow), 'num'],
      [fmtMoney(row.endRealBalance), 'num'],
      [fmtMoney(row.idealDwzBalance), 'num'],
      [fmtMoney(row.nominalBalance), 'num'],
    ].forEach(([txt, cls]) => {
      const td = document.createElement('td');
      if (cls) td.className = cls;
      td.textContent = txt;
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  }
}

/* ============================================================================
 * MULTI-SOURCE PRICE RECONCILIATION & HISTORICAL TRACKING
 * ============================================================================ */
async function syncLiveQuotesAndUpdatePortfolio() {
  const nonCash = appState.holdings.filter((h) => h.ticker && h.market !== 'CASH' && h.ticker !== 'CASH');
  if (nonCash.length === 0) {
    showToast('目前無需同步的股票持倉。', 'warn');
    return;
  }
  showToast(`正在並行查詢 ${nonCash.length} 檔標的之多源即時股價...`);

  // Auto-chunk <= 8 tickers per request to stay safely within Cloudflare Free 50 subrequest limit
  const allResults = [];
  for (let i = 0; i < nonCash.length; i += 8) {
    const chunk = nonCash.slice(i, i + 8);
    const tParam = chunk.map((h) => h.ticker).join(',');
    const mParam = chunk.map((h) => h.market).join(',');
    const resp = await fetch(`/api/quote/live?tickers=${encodeURIComponent(tParam)}&markets=${encodeURIComponent(mParam)}`);
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
    allResults.push(...(data.results || []));
  }

  appState.liveReconciliations = allResults;
  let updatedCount = 0;
  for (const res of allResults) {
    if (res.consensusPrice !== null) {
      for (const h of appState.holdings) {
        if (h.ticker === res.ticker && h.market === res.market) {
          h.price = res.consensusPrice;
          updatedCount++;
        }
      }
    }
  }
  renderLiveReconTable(allResults);
  recalcPortfolio();
  renderHoldingsTable();
  scheduleLocalAutoSave();
  const verified = allResults.filter((r) => r.statusCode === 'VERIFIED').length;
  showToast(`✅ 今日多源校對完成：已更新 ${updatedCount} 檔股價（${verified}/${allResults.length} 檔三源一致）。`);
}

function formatSourcesDetail(quotes) {
  return (quotes || [])
    .map((q) => `${q.source}: ${q.ok && q.price !== null ? q.price.toFixed(2) : 'N/A'}`)
    .join(' | ');
}

function renderLiveReconTable(results) {
  const tbody = $('liveReconTbody');
  while (tbody.firstChild) tbody.removeChild(tbody.firstChild);
  for (const r of results) {
    const tr = document.createElement('tr');
    [
      [r.ticker, ''],
      [r.market, ''],
      [formatSourcesDetail(r.quotes), ''],
      [`${r.validSourceCount}/${r.totalSourceCount}`, 'num'],
      [r.consensusPrice !== null ? r.consensusPrice.toFixed(2) : 'N/A', 'num'],
      [r.spreadPct !== null ? `${(r.spreadPct * 100).toFixed(2)}%` : '--', 'num'],
      [r.statusLabel, ''],
      [r.outlierSource || '無', ''],
    ].forEach(([txt, cls]) => {
      const td = document.createElement('td');
      if (cls) td.className = cls;
      td.textContent = txt;
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  }
}

async function runHistoricalDateReconciliation() {
  const dt = $('histDateInput').value;
  if (!dt) { showToast('請先選擇歷史校對日期。', 'warn'); return; }
  const nonCash = appState.holdings.filter((h) => h.ticker && h.market !== 'CASH' && h.ticker !== 'CASH');
  showToast(`正在校對 ${nonCash.length} 檔標的於 ${dt} 的歷史收盤價...`);

  const results = await Promise.all(
    nonCash.map(async (h) => {
      const resp = await fetch(`/api/quote/history?ticker=${encodeURIComponent(h.ticker)}&market=${encodeURIComponent(h.market)}&date=${encodeURIComponent(dt)}`);
      return resp.json();
    })
  );
  appState.histReconciliations = results;
  const tbody = $('histReconTbody');
  while (tbody.firstChild) tbody.removeChild(tbody.firstChild);
  for (const r of results) {
    const tr = document.createElement('tr');
    [
      [r.ticker || '--', ''],
      [r.market || '--', ''],
      [`${(r.matchedDates || [dt]).join(', ')} ${r.cached ? '(D1-HIT)' : '(LIVE)'}`, ''],
      [formatSourcesDetail(r.quotes), ''],
      [`${r.validSourceCount ?? 0}/${r.totalSourceCount ?? 3}`, 'num'],
      [r.consensusPrice !== null && r.consensusPrice !== undefined ? Number(r.consensusPrice).toFixed(2) : 'N/A', 'num'],
      [r.spreadPct !== null && r.spreadPct !== undefined ? `${(r.spreadPct * 100).toFixed(3)}%` : '--', 'num'],
      [r.statusLabel || r.error || '--', ''],
      [r.outlierSource || '無', ''],
    ].forEach(([txt, cls]) => {
      const td = document.createElement('td');
      if (cls) td.className = cls;
      td.textContent = txt;
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  }
  showToast(`📅 歷史收盤價 (${dt}) 四源校對完成！`);
}

async function runHistoricalRangeTracking() {
  const ticker = $('rangeTicker').value.trim().toUpperCase();
  const market = $('rangeMarket').value;
  const start = $('rangeStart').value;
  const end = $('rangeEnd').value;
  if (!ticker || !start || !end) { showToast('請完整填寫代號與起訖日期。', 'warn'); return; }
  showToast(`正在抓取 ${ticker} (${start} ~ ${end}) 區間歷史收盤並逐日比對...`);

  const resp = await fetch(`/api/quote/range?ticker=${encodeURIComponent(ticker)}&market=${encodeURIComponent(market)}&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`);
  const report = await resp.json();
  if (!resp.ok) throw new Error(report.error || `HTTP ${resp.status}`);
  appState.rangeReport = report;
  renderHistoryPriceChart($('historyChartSvg'), report.rows);

  const tbody = $('rangeTbody');
  while (tbody.firstChild) tbody.removeChild(tbody.firstChild);
  for (const r of [...(report.rows || [])].reverse()) {
    const srcText = Object.entries(r.sources || {}).map(([k, v]) => `${k}:${v !== null ? Number(v).toFixed(2) : 'N/A'}`).join(' | ');
    const tr = document.createElement('tr');
    [
      [r.date, ''],
      [r.ticker, ''],
      [srcText, ''],
      [String(r.validSourceCount), 'num'],
      [r.consensusPrice !== null ? r.consensusPrice.toFixed(2) : 'N/A', 'num'],
      [r.spreadPct !== null ? `${(r.spreadPct * 100).toFixed(3)}%` : '--', 'num'],
      [r.statusLabel, ''],
      [r.outlierSource || '無', ''],
    ].forEach(([txt, cls]) => {
      const td = document.createElement('td');
      if (cls) td.className = cls;
      td.textContent = txt;
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  }
  showToast(`📈 區間追蹤完成：共 ${report.totalTradingDays} 個交易日，三源精準 ${report.verifiedDays} 天，異常 ${report.discrepancyDays} 天。`);
}

/* ============================================================================
 * VAULT SYNC, BACKUP & TELEMETRY
 * ============================================================================ */
function getCurrentVaultPayload() {
  return validateVaultPayload({
    fireInputs: appState.fireInputs,
    holdings: appState.holdings,
    customPresets: appState.customPresets,
    usdTwdRate: appState.usdTwdRate,
  });
}

function applyLoadedVault(payload) {
  const valid = validateVaultPayload(payload);
  appState.fireInputs = { ...WEB_CONFIG.FIRE_DEFAULTS, ...valid.fireInputs };
  appState.holdings = valid.holdings.length ? valid.holdings : WEB_CONFIG.SAMPLE_DUMMY_HOLDINGS.map((h) => ({ ...h }));
  appState.customPresets = valid.customPresets || {};
  appState.usdTwdRate = valid.usdTwdRate || 32.0;
  syncDomFromFireInputs();
  recalcPortfolio();
  renderHoldingsTable();
  scheduleLocalAutoSave();
}

async function refreshHealthAndAuth() {
  try {
    const resp = await fetch('/api/health');
    const h = await resp.json();
    $('hlthStatus').textContent = h.d1Connected ? '✅ 正常 (D1 已連線)' : '⚠️ 本機 / 無 D1';
    $('hlthCacheCount').textContent = `${h.cachedHistoryCount ?? 0} 筆`;
    if (h.slaTelemetry) {
      $('hlthSuccessRate').textContent = `${(h.slaTelemetry.successRate * 100).toFixed(1)}%`;
      $('hlthP95').textContent = `${h.slaTelemetry.p95Ms}ms / ${(h.slaTelemetry.cacheHitRate * 100).toFixed(0)}%`;
    } else {
      $('hlthSuccessRate').textContent = '100.0%';
      $('hlthP95').textContent = '待累積請求';
    }

    if (h.authenticatedUser) {
      $('topAuthPill').textContent = `🔐 已登入: ${h.authenticatedUser}`;
      $('cfVaultStatus').textContent = `✅ 已透過 Cloudflare Zero Trust Access 驗證身分：${h.authenticatedUser}，可安全存取個人隔離 D1 加密保險庫。`;
    } else {
      $('topAuthPill').textContent = '🔒 本機私密模式';
      $('cfVaultStatus').textContent = 'ℹ️ 未偵測到 Cloudflare Access 登入標頭（本機預覽或公開部署時，可使用下方 Google Drive 同步或加密檔備份）。';
    }

    const list = $('sourcesBadgeList');
    while (list.firstChild) list.removeChild(list.firstChild);
    Object.entries(h.configuredSources || {}).forEach(([k, active]) => {
      const span = document.createElement('span');
      span.className = `pill ${active ? 'green' : ''}`;
      span.textContent = `${active ? '✅' : '⚪'} ${k}`;
      list.appendChild(span);
    });
  } catch {
    $('hlthStatus').textContent = '⚪ 離線模式';
    $('cfVaultStatus').textContent = 'ℹ️ 目前為純離線檢視模式（本機 IndexedDB 仍會自動保存您的持倉）。';
  }
}

function downloadBlob(filename, content, mime = 'application/json') {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  // Delay revokeObjectURL so iOS Safari finishes reading the Blob before release
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function initMobilePwaSupport() {
  // 1. Register offline shell Service Worker (HTTPS or localhost)
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
  // 2. Request persistent storage (protects Android Chrome IndexedDB from eviction)
  if (navigator.storage && typeof navigator.storage.persist === 'function') {
    navigator.storage.persist().catch(() => {});
  }
  // 3. Friendly iOS Safari 7-day ITP reminder when not installed as Home Screen PWA
  const ua = navigator.userAgent || '';
  const isIos = /iPhone|iPad|iPod/i.test(ua);
  const isStandalone = window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true;
  const dismissed = globalThis.localStorage?.getItem('dwz_ios_hint_dismissed') === '1';
  if (isIos && !isStandalone && !dismissed) {
    $('iosPwaHint')?.classList.remove('hidden');
  }
  $('btnDismissIosHint')?.addEventListener('click', () => {
    $('iosPwaHint')?.classList.add('hidden');
    try { globalThis.localStorage?.setItem('dwz_ios_hint_dismissed', '1'); } catch {}
  });
}

/* ============================================================================
 * EVENT BINDINGS & INITIALIZATION
 * ============================================================================ */
function initDates() {
  const today = new Date();
  const fmt = (d) => d.toISOString().slice(0, 10);
  const d5 = new Date(today.getTime() - 5 * 86400000);
  const d30 = new Date(today.getTime() - 30 * 86400000);
  $('histDateInput').value = fmt(d5);
  $('rangeStart').value = fmt(d30);
  $('rangeEnd').value = fmt(today);
}

function bindEvents() {
  // Tabs
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
      btn.classList.add('active');
      $(`tab-${btn.dataset.tab}`).classList.add('active');
    });
  });

  // FIRE status & net worth toggles
  $('statusWorkingBtn').addEventListener('click', () => { appState.fireInputs.status = '還在工作'; syncDomFromFireInputs(); recalcFire(); scheduleLocalAutoSave(); });
  $('statusRetiredBtn').addEventListener('click', () => { appState.fireInputs.status = '已經退休'; syncDomFromFireInputs(); recalcFire(); scheduleLocalAutoSave(); });
  $('nwLinkedBtn').addEventListener('click', () => { appState.fireInputs.netWorthMode = '連動持倉總市值'; syncDomFromFireInputs(); recalcFire(); scheduleLocalAutoSave(); });
  $('nwManualBtn').addEventListener('click', () => { appState.fireInputs.netWorthMode = '手動輸入'; syncDomFromFireInputs(); recalcFire(); scheduleLocalAutoSave(); });

  // Paired slider + number inputs
  [['fireAge', 'fireAgeRange'], ['fireRetireAge', 'fireRetireAgeRange'], ['fireLifeExp', 'fireLifeExpRange'], ['fireNominalReturn', 'fireNominalReturnRange'], ['fireInflation', 'fireInflationRange']].forEach(([nId, rId]) => {
    $(nId).addEventListener('input', () => { $(rId).value = $(nId).value; recalcFire(); scheduleLocalAutoSave(); });
    $(rId).addEventListener('input', () => { $(nId).value = $(rId).value; recalcFire(); scheduleLocalAutoSave(); });
  });
  ['fireNetWorth', 'fireMonthlySavings', 'fireMonthlySpending', 'fireMonthlyPension', 'firePensionAge', 'fireSwr'].forEach((id) => {
    $(id).addEventListener('input', () => { recalcFire(); scheduleLocalAutoSave(); });
  });

  document.querySelectorAll('[data-life]').forEach((chip) => {
    chip.addEventListener('click', () => {
      $('fireLifeExp').value = chip.dataset.life;
      $('fireLifeExpRange').value = chip.dataset.life;
      recalcFire(); scheduleLocalAutoSave();
    });
  });

  $('applyCapmBtn').addEventListener('click', () => {
    const beta = appState.lastPortfolioResult?.overallPortfolioBeta ?? 1;
    const capmPct = (calcCapmReferenceReturn(beta) * 100).toFixed(1);
    $('fireNominalReturn').value = capmPct;
    $('fireNominalReturnRange').value = capmPct;
    recalcFire(); scheduleLocalAutoSave();
    showToast(`已套用 CAPM 參考報酬率 ${capmPct}%（請注意槓桿 ETF 具波動耗損風險）。`, 'warn');
  });

  $('btnApplyMaxSpend').addEventListener('click', () => {
    if (!appState.lastFireResult) return;
    $('fireMonthlySpending').value = Math.floor(appState.lastFireResult.maxMonthlySpending);
    recalcFire(); scheduleLocalAutoSave();
    showToast('✨ 已一鍵套用 Die With Zero 最高可花月開銷，預期壽命終點將完美歸零！');
  });

  $('btnApplyEarliestAge').addEventListener('click', () => {
    const early = appState.lastFireResult?.earliestDwzRetireAge;
    if (early === null || early === undefined) { showToast('目前條件尚無法於預期壽命內達成 DWZ 門檻。', 'warn'); return; }
    $('fireRetireAge').value = early; $('fireRetireAgeRange').value = early;
    recalcFire(); scheduleLocalAutoSave();
    showToast(`🚀 已一鍵套用 Die With Zero 最早可退休年齡：${early} 歲！`);
  });

  // Portfolio buttons
  $('btnAddHolding').addEventListener('click', () => {
    appState.holdings.push({ ticker: '2330', market: 'TWSE', name: '台積電', shares: 0, currency: 'TWD', price: 0, customBeta: '' });
    recalcPortfolio(); renderHoldingsTable(); scheduleLocalAutoSave();
  });
  $('btnResetDummy').addEventListener('click', () => {
    appState.holdings = WEB_CONFIG.SAMPLE_DUMMY_HOLDINGS.map((h) => ({ ...h }));
    recalcPortfolio(); renderHoldingsTable(); scheduleLocalAutoSave();
    showToast('已重置為 6 檔預設範例持倉。');
  });
  $('btnRefreshFx').addEventListener('click', async () => {
    try {
      const r = await (await fetch('/api/fx/usdtwd')).json();
      if (r.rate) { appState.usdTwdRate = r.rate; recalcPortfolio(); scheduleLocalAutoSave(); showToast(`💱 已更新匯率 USD/TWD = ${r.rate} (${r.source})`); }
    } catch (e) { showToast(`匯率更新失敗：${e.message}`, 'error'); }
  });

  const runLive = () => syncLiveQuotesAndUpdatePortfolio().catch((e) => showToast(`今日股價同步失敗：${e.message}`, 'error'));
  $('btnSyncLivePrices').addEventListener('click', runLive);
  $('btnReconLiveNow').addEventListener('click', runLive);
  $('btnReconHistDate').addEventListener('click', () => runHistoricalDateReconciliation().catch((e) => showToast(e.message, 'error')));
  $('btnFetchRange').addEventListener('click', () => runHistoricalRangeTracking().catch((e) => showToast(e.message, 'error')));

  // Vault / Backup controls
  $('chkE2eeMode').addEventListener('change', () => {
    $('e2eePassWrap').style.display = $('chkE2eeMode').checked ? 'block' : 'none';
  });
  $('btnGenRecovery').addEventListener('click', () => {
    const key = generateRecoveryKey();
    $('vaultPassphrase').value = key;
    $('recoveryKeyDisplay').textContent = `已填入隨機金鑰（請妥善抄存）：${key}`;
  });
  $('btnCfUpload').addEventListener('click', async () => {
    try {
      const useE2ee = $('chkE2eeMode').checked;
      const res = await cfVault.upload(getCurrentVaultPayload(), { useE2ee, passphrase: $('vaultPassphrase').value });
      showToast(`☁️ 已成功${res.isEncrypted ? '加密' : ''}同步至 Cloudflare D1 (版本 v${res.version})！`);
    } catch (e) { showToast(`上傳失敗：${e.message}`, 'error'); }
  });
  $('btnCfDownload').addEventListener('click', async () => {
    try {
      const res = await cfVault.download({ passphrase: $('vaultPassphrase').value });
      if (!res.exists) { showToast('雲端尚無您的持倉紀錄，請先上傳。', 'warn'); return; }
      applyLoadedVault(res.payload);
      showToast(`✅ 已從 Cloudflare D1 載入並還原持倉 (版本 v${res.version})！`);
    } catch (e) { showToast(`下載失敗：${e.message}`, 'error'); }
  });
  $('btnCfDelete').addEventListener('click', async () => {
    try {
      await cfVault.remove();
      showToast('🗑️ 已清除您於 Cloudflare D1 的雲端持倉資料。', 'warn');
    } catch (e) { showToast(`清除失敗：${e.message}`, 'error'); }
  });

  $('btnGdriveUpload').addEventListener('click', async () => {
    try {
      const cid = $('gdriveClientId').value.trim();
      const useE2ee = $('chkE2eeMode').checked && $('vaultPassphrase').value.length >= 8;
      const res = await gdriveVault.upload(cid, getCurrentVaultPayload(), { useE2ee, passphrase: $('vaultPassphrase').value });
      showToast(`☁️ 已同步至您的個人 Google Drive 隱藏資料夾 (${res.encrypted ? 'AES-256 加密' : 'Google 帳戶私密'})！`);
    } catch (e) { showToast(`Google Drive 同步失敗：${e.message}`, 'error'); }
  });
  $('btnGdriveDownload').addEventListener('click', async () => {
    try {
      const cid = $('gdriveClientId').value.trim();
      const res = await gdriveVault.download(cid, { passphrase: $('vaultPassphrase').value });
      if (!res.exists) { showToast('您的 Google Drive 尚無同步紀錄。', 'warn'); return; }
      applyLoadedVault(res.payload);
      showToast('✅ 已從您的個人 Google Drive 成功還原全部持倉！');
    } catch (e) { showToast(`Google Drive 還原失敗：${e.message}`, 'error'); }
  });

  $('btnExportEnc').addEventListener('click', async () => {
    try {
      const pass = $('vaultPassphrase').value;
      if (!pass || pass.length < 8) { showToast('匯出加密備份前，請先輸入至少 8 碼主密碼（或點選產生隨機金鑰）。', 'warn'); return; }
      const env = await encryptVaultPayload(getCurrentVaultPayload(), pass);
      downloadBlob(`betacalc_encrypted_${new Date().toISOString().slice(0, 10)}.enc.json`, JSON.stringify(env, null, 2));
      showToast('🔒 已匯出 AES-256-GCM 零知識加密備份檔！');
    } catch (e) { showToast(e.message, 'error'); }
  });

  $('fileImportBackup').addEventListener('change', async (ev) => {
    const file = ev.target.files?.[0];
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      const payload = isEncryptedEnvelope(parsed)
        ? await decryptVaultPayload(parsed, $('vaultPassphrase').value)
        : validateVaultPayload(parsed);
      applyLoadedVault(payload);
      showToast('🔓 已成功還原備份持倉與 Die With Zero 設定！');
    } catch (e) { showToast(`匯入失敗：${e.message}`, 'error'); }
    ev.target.value = '';
  });

  $('btnExportCsv').addEventListener('click', () => {
    const headers = ['Ticker', 'Market', 'Name', 'Shares', 'Currency', 'Price', 'CustomBeta'];
    const lines = [headers.join(',')];
    for (const h of appState.holdings) {
      lines.push([h.ticker, h.market, h.name, h.shares, h.currency, h.price, h.customBeta ?? '']
        .map((v) => `"${sanitizeCsvCell(v).replace(/"/g, '""')}"`).join(','));
    }
    downloadBlob(`betacalc_portfolio_${new Date().toISOString().slice(0, 10)}.csv`, '\uFEFF' + lines.join('\n'), 'text/csv;charset=utf-8');
    showToast('📊 已匯出防公式注入安全 CSV，可直接匯入 Google 試算表！');
  });

  $('btnRefreshHealth').addEventListener('click', refreshHealthAndAuth);
}

async function bootstrap() {
  initDates();
  bindEvents();
  initMobilePwaSupport();
  const saved = await localStore.load();
  if (saved) {
    applyLoadedVault(saved);
    const t = new Date(saved.updatedAt).toLocaleString('zh-TW', { hour12: false });
    $('topSyncPill').textContent = `💾 已還原本機持倉 (${t})`;
  } else {
    syncDomFromFireInputs();
    recalcPortfolio();
    renderHoldingsTable();
  }
  refreshHealthAndAuth();
}

bootstrap();
