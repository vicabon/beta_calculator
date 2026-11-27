/**
 * @fileoverview Google Sheets custom menu, interactive sidebar controllers,
 * one-click AlphaLab actions, and multi-source live/historical price reconciliation triggers.
 */

/**
 * Adds custom menu when the spreadsheet opens.
 */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('🔥 Die With Zero & Beta')
    .addItem('🎨 開啟 AlphaLab 風格互動試算側邊欄', 'openFireSidebar')
    .addSeparator()
    .addItem('🔄 同步今日股價並執行四源校對', 'syncLivePrices')
    .addItem('📅 校對指定歷史日期收盤價（四源比對）', 'syncHistoricalClosePrices')
    .addItem('📈 追蹤區間歷史收盤價並逐日校對', 'syncHistoricalTrackingRange')
    .addSeparator()
    .addItem('✨ 一鍵套用：Die With Zero 每月最高可花金額', 'applyMaxMonthlySpending')
    .addItem('🚀 一鍵套用：Die With Zero 最早可退休年齡', 'applyEarliestDwzRetireAge')
    .addSeparator()
    .addItem('🧪 執行系統自檢（六層驗證快速診斷）', 'runBuiltInDiagnostics')
    .addItem('🛠️ 初始化 / 重建完整 7 大分頁工作簿', 'setupWorkbookWithConfirm')
    .addToUi();
}

function setupWorkbookWithConfirm() {
  const ui = SpreadsheetApp.getUi();
  const resp = ui.alert(
    '初始化工作簿',
    '這將會建立或重置 7 個系統分頁與預設公式（既有輸入將會重置為預設範例）。是否繼續？',
    ui.ButtonSet.YES_NO
  );
  if (resp === ui.Button.YES) {
    setupWorkbook();
    ui.alert('✅ 建置完成！已生成 7 大分頁、預設 Beta 表、四源校對表與 Die With Zero 儀表板。');
  }
}

/**
 * Opens the AlphaLab-style Die With Zero interactive sidebar.
 */
function openFireSidebar() {
  const html = HtmlService.createHtmlOutputFromFile('Sidebar')
    .setTitle('🔥 Die With Zero × Beta 互動試算')
    .setWidth(420);
  SpreadsheetApp.getUi().showSidebar(html);
}

/**
 * Reads current Dashboard & Portfolio state for Sidebar initialization.
 * Exposed to google.script.run.
 */
function getSidebarInitialState() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const dash = ss.getSheetByName(APP_CONFIG.SHEETS.DASHBOARD);
  const port = ss.getSheetByName(APP_CONFIG.SHEETS.PORTFOLIO);
  if (!dash) {
    throw new Error('尚未初始化工作簿，請先執行 setupWorkbook()。');
  }
  const inputs = {
    status: String(dash.getRange('C5').getValue() || APP_CONFIG.FIRE_DEFAULTS.STATUS),
    currentAge: Number(dash.getRange('C6').getValue() || APP_CONFIG.FIRE_DEFAULTS.CURRENT_AGE),
    retireAge: Number(dash.getRange('C7').getValue() || APP_CONFIG.FIRE_DEFAULTS.RETIRE_AGE),
    lifeExpectancy: Number(dash.getRange('C8').getValue() || APP_CONFIG.FIRE_DEFAULTS.LIFE_EXPECTANCY),
    netWorthMode: String(dash.getRange('C11').getValue() || APP_CONFIG.FIRE_DEFAULTS.NET_WORTH_MODE),
    currentNetWorth: Number(dash.getRange('C13').getValue() || APP_CONFIG.FIRE_DEFAULTS.MANUAL_NET_WORTH),
    monthlySavings: Number(dash.getRange('C14').getValue() || APP_CONFIG.FIRE_DEFAULTS.MONTHLY_SAVINGS),
    monthlySpending: Number(dash.getRange('C15').getValue() || APP_CONFIG.FIRE_DEFAULTS.MONTHLY_SPENDING),
    monthlyPension: Number(dash.getRange('C16').getValue() || 0),
    pensionStartAge: Number(dash.getRange('C17').getValue() || 65),
    nominalReturn: Number(dash.getRange('C20').getValue() || APP_CONFIG.FIRE_DEFAULTS.NOMINAL_RETURN),
    inflationRate: Number(dash.getRange('C21').getValue() || APP_CONFIG.FIRE_DEFAULTS.INFLATION_RATE),
    classicFireSwr: Number(dash.getRange('C23').getValue() || APP_CONFIG.FIRE_DEFAULTS.CLASSIC_FIRE_SWR),
  };
  const sim = runFireSimulation(inputs);
  const portfolioSummary = {
    totalValueTwd: port ? Number(port.getRange('C4').getValue() || 0) : inputs.currentNetWorth,
    overallBeta: port ? Number(port.getRange('C5').getValue() || 0) : 0,
    equityOnlyBeta: port ? Number(port.getRange('F5').getValue() || 0) : 0,
    cashRatio: port ? Number(port.getRange('I5').getValue() || 0) : 0,
    capmReferenceReturn: Number(dash.getRange('C25').getValue() || 0.07),
  };
  return { inputs: inputs, simulation: sim, portfolio: portfolioSummary };
}

/**
 * Writes updated parameters from Sidebar back to Dashboard Sheet and returns refreshed simulation.
 * Exposed to google.script.run.
 */
function saveSidebarInputsToSheet(payload) {
  const normalized = normalizeFireInputs(payload);
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const dash = ss.getSheetByName(APP_CONFIG.SHEETS.DASHBOARD);
  if (!dash) {
    throw new Error('找不到儀表板分頁。');
  }
  dash.getRange('C5').setValue(normalized.status);
  dash.getRange('C6').setValue(normalized.currentAge);
  dash.getRange('C7').setValue(normalized.retireAge);
  dash.getRange('C8').setValue(normalized.lifeExpectancy);
  if (payload && payload.netWorthMode === '手動輸入') {
    dash.getRange('C11').setValue('手動輸入');
    dash.getRange('C12').setValue(normalized.currentNetWorth);
  }
  dash.getRange('C14').setValue(normalized.monthlySavings);
  dash.getRange('C15').setValue(normalized.monthlySpending);
  dash.getRange('C16').setValue(normalized.monthlyPension);
  dash.getRange('C17').setValue(normalized.pensionStartAge);
  dash.getRange('C20').setValue(normalized.nominalReturn);
  dash.getRange('C21').setValue(normalized.inflationRate);
  dash.getRange('C23').setValue(normalized.classicFireSwr);
  SpreadsheetApp.flush();
  return getSidebarInitialState();
}

/**
 * AlphaLab Signature Action 1: One-click apply reverse-solved Max Monthly Spending.
 */
function applyMaxMonthlySpending() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const dash = ss.getSheetByName(APP_CONFIG.SHEETS.DASHBOARD);
  const maxMonthly = Number(dash.getRange('G19').getValue());
  if (!Number.isFinite(maxMonthly) || maxMonthly <= 0) {
    SpreadsheetApp.getUi().alert('目前無法反推有效的每月最高可花金額，請確認淨資產與預期壽命設定。');
    return;
  }
  const rounded = Math.floor(maxMonthly);
  dash.getRange('C15').setValue(rounded);
  SpreadsheetApp.flush();
  appendAuditLog_(ss, 'FIRE', 'applyMaxMonthlySpending', 'OK', 0, '一鍵套用最高可花月開銷: ' + rounded);
  SpreadsheetApp.getUi().alert('✨ 已將「退休後每月開銷」一鍵更新為 ' + rounded.toLocaleString('en-US') + ' TWD，預期壽命終點將精準歸零！');
}

/**
 * AlphaLab Signature Action 2: One-click apply Earliest Die With Zero Retirement Age.
 */
function applyEarliestDwzRetireAge() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const dash = ss.getSheetByName(APP_CONFIG.SHEETS.DASHBOARD);
  const earliestAge = dash.getRange('G20').getValue();
  if (!Number.isFinite(Number(earliestAge))) {
    SpreadsheetApp.getUi().alert('目前資產與儲蓄設定尚無法於預期壽命前達成 Die With Zero 退休門檻。');
    return;
  }
  dash.getRange('C7').setValue(Number(earliestAge));
  SpreadsheetApp.flush();
  appendAuditLog_(ss, 'FIRE', 'applyEarliestDwzRetireAge', 'OK', 0, '一鍵套用最早退休年齡: ' + earliestAge);
  SpreadsheetApp.getUi().alert('🚀 已將「想幾歲退休」更新為 Die With Zero 最早可退休年齡：' + earliestAge + ' 歲！');
}

/**
 * Multi-Source Live / Today Price Reconciliation Trigger (4 Authoritative Sources).
 */
function syncLivePrices() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const recon = ss.getSheetByName(APP_CONFIG.SHEETS.RECONCILIATION);
  if (!recon) throw new Error('請先執行 setupWorkbook() 建立分頁。');

  SpreadsheetApp.flush(); // Ensure GOOGLEFINANCE cells are evaluated
  const tickers = recon.getRange('A6:D25').getValues();
  const nowStr = Utilities.formatDate(new Date(), APP_CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm');
  const writeColsEtoG = [];
  const writeColsMtoN = [];
  let processed = 0;
  let verifiedCount = 0;

  for (let i = 0; i < tickers.length; i++) {
    const rawTicker = String(tickers[i][0] || '').trim();
    const market = String(tickers[i][1] || 'TWSE').trim().toUpperCase();
    const gfVal = tickers[i][3];

    if (!rawTicker) {
      writeColsEtoG.push(['', '', '']);
      writeColsMtoN.push(['', '']);
      continue;
    }

    processed++;
    if (market === 'CASH' || rawTicker.toUpperCase() === 'CASH') {
      writeColsEtoG.push([1, 1, 1]);
      writeColsMtoN.push(['無', nowStr]);
      verifiedCount++;
      continue;
    }

    const startMs = Date.now();
    try {
      const ticker = normalizeAndValidateTicker(rawTicker);
      const res = fetchAndReconcileLiveTicker(ticker, market, gfVal);
      const yfPrice = res.bySource.yahooFinance.ok ? res.bySource.yahooFinance.price : 'N/A';
      const exPrice = res.bySource.exchangeOfficial.ok ? res.bySource.exchangeOfficial.price : 'N/A';
      const fmPrice = res.bySource.finMind.ok ? res.bySource.finMind.price : 'N/A';
      writeColsEtoG.push([yfPrice, exPrice, fmPrice]);
      const dateInfo = res.matchedDates.length > 0 ? res.matchedDates[res.matchedDates.length - 1] + ' | ' + nowStr : nowStr;
      writeColsMtoN.push([sanitizeSheetText(res.outlierSource), dateInfo]);

      if (res.statusCode === 'VERIFIED') verifiedCount++;
      const elapsed = Date.now() - startMs;
      appendAuditLog_(
        ss,
        'RECON_LIVE',
        ticker + ' (' + market + ')',
        res.meetsThreeSourceRule ? 'OK' : 'WARN',
        elapsed,
        res.statusLabel + ' | 共識價=' + res.consensusPrice + ' | 價差=' + ((res.spreadPct || 0) * 100).toFixed(2) + '%',
        res.validSourceCount,
        res.outlierSource
      );
    } catch (err) {
      writeColsEtoG.push(['ERR', 'ERR', 'ERR']);
      writeColsMtoN.push([sanitizeSheetText(err.message), nowStr]);
      appendAuditLog_(ss, 'RECON_LIVE', rawTicker, 'ERROR', Date.now() - startMs, err.message, 0, '');
    }
  }

  recon.getRange(6, 5, writeColsEtoG.length, 3).setValues(writeColsEtoG);
  recon.getRange(6, 13, writeColsMtoN.length, 2).setValues(writeColsMtoN);
  SpreadsheetApp.flush();

  if (typeof SpreadsheetApp.getUi === 'function') {
    try {
      SpreadsheetApp.getUi().alert(
        '✅ 今日股價四源校對完成！\n共處理 ' + processed + ' 檔標的，其中 ' + verifiedCount + ' 檔達三源以上一致標準。\n詳細結果請見「🔍 多源股價校對」與「🛡️ 驗證與監控日誌」。'
      );
    } catch (e) {
      // Headless / time-driven trigger context
    }
  }
}

/**
 * Multi-Source Historical Closing Price Reconciliation on Target Date (`🔍 多源股價校對!C3`).
 */
function syncHistoricalClosePrices() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const recon = ss.getSheetByName(APP_CONFIG.SHEETS.RECONCILIATION);
  if (!recon) throw new Error('請先執行 setupWorkbook() 建立分頁。');

  SpreadsheetApp.flush();
  const targetDateVal = recon.getRange('C3').getValue();
  const targetYmd = parseDateParts(targetDateVal).ymd;
  const rows = recon.getRange('A30:D49').getValues();
  const writeColsEtoG = [];
  const writeColsMtoN = [];
  let processed = 0;
  let verifiedCount = 0;

  for (let i = 0; i < rows.length; i++) {
    const rawTicker = String(rows[i][0] || '').trim();
    const market = String(rows[i][1] || 'TWSE').trim().toUpperCase();
    const gfHistVal = rows[i][3];

    if (!rawTicker) {
      writeColsEtoG.push(['', '', '']);
      writeColsMtoN.push(['', '']);
      continue;
    }

    processed++;
    if (market === 'CASH' || rawTicker.toUpperCase() === 'CASH') {
      writeColsEtoG.push([1, 1, 1]);
      writeColsMtoN.push(['無', targetYmd]);
      verifiedCount++;
      continue;
    }

    const startMs = Date.now();
    try {
      const ticker = normalizeAndValidateTicker(rawTicker);
      const res = fetchAndReconcileHistoricalTicker(ticker, market, targetYmd, gfHistVal);
      const yfPrice = res.bySource.yahooFinance.ok ? res.bySource.yahooFinance.price : 'N/A';
      const exPrice = res.bySource.exchangeOfficial.ok ? res.bySource.exchangeOfficial.price : 'N/A';
      const fmPrice = res.bySource.finMind.ok ? res.bySource.finMind.price : 'N/A';
      writeColsEtoG.push([yfPrice, exPrice, fmPrice]);
      const matchedStr = res.matchedDates.length > 0 ? res.matchedDates.join(', ') : targetYmd;
      writeColsMtoN.push([sanitizeSheetText(res.outlierSource), matchedStr]);

      if (res.statusCode === 'VERIFIED') verifiedCount++;
      appendAuditLog_(
        ss,
        'RECON_HIST',
        ticker + ' @ ' + targetYmd,
        res.meetsThreeSourceRule ? 'OK' : 'WARN',
        Date.now() - startMs,
        res.statusLabel + ' | 共識收盤=' + res.consensusPrice + ' | 價差=' + ((res.spreadPct || 0) * 100).toFixed(3) + '%',
        res.validSourceCount,
        res.outlierSource
      );
    } catch (err) {
      writeColsEtoG.push(['ERR', 'ERR', 'ERR']);
      writeColsMtoN.push([sanitizeSheetText(err.message), targetYmd]);
      appendAuditLog_(ss, 'RECON_HIST', rawTicker + ' @ ' + targetYmd, 'ERROR', Date.now() - startMs, err.message, 0, '');
    }
  }

  recon.getRange(30, 5, writeColsEtoG.length, 3).setValues(writeColsEtoG);
  recon.getRange(30, 13, writeColsMtoN.length, 2).setValues(writeColsMtoN);
  SpreadsheetApp.flush();

  try {
    SpreadsheetApp.getUi().alert(
      '📅 歷史收盤價 (' + targetYmd + ') 四源校對完成！\n共處理 ' + processed + ' 檔標的，其中 ' + verifiedCount + ' 檔達三源以上精準一致標準。'
    );
  } catch (e) {}
}

/**
 * Evaluates GOOGLEFINANCE daily close series via hidden helper range P2:Q on History tab,
 * then runs 4-source day-by-day reconciliation across [startDate, endDate].
 */
function syncHistoricalTrackingRange() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const histSh = ss.getSheetByName(APP_CONFIG.SHEETS.HISTORY);
  if (!histSh) throw new Error('請先執行 setupWorkbook() 建立分頁。');

  const rawTicker = String(histSh.getRange('A4').getValue() || '0050').trim();
  const market = String(histSh.getRange('B4').getValue() || 'TWSE').trim().toUpperCase();
  const startParts = parseDateParts(histSh.getRange('C4').getValue());
  const endParts = parseDateParts(histSh.getRange('D4').getValue());
  const ticker = normalizeAndValidateTicker(rawTicker);

  // Guard date span (max 366 days for GAS execution budget)
  const daySpan = Math.round((Date.UTC(endParts.year, endParts.month - 1, endParts.day) - Date.UTC(startParts.year, startParts.month - 1, startParts.day)) / 86400000);
  if (daySpan < 0 || daySpan > APP_CONFIG.SECURITY.MAX_HISTORY_DAYS) {
    throw new Error('追蹤區間須介於 0 至 ' + APP_CONFIG.SECURITY.MAX_HISTORY_DAYS + ' 天之間。');
  }

  const startMs = Date.now();
  // Step 1: Evaluate Google Finance historical range via helper cell P2
  const gfSymbol = market === 'US' ? ticker : 'TPE:' + ticker;
  histSh.getRange('P2:Q400').clearContent();
  histSh.getRange('P2').setFormula(
    '=IFERROR(GOOGLEFINANCE("' + gfSymbol + '","close",DATE(' + startParts.year + ',' + startParts.month + ',' + startParts.day + '),DATE(' + endParts.year + ',' + endParts.month + ',' + endParts.day + ')+1),"")'
  );
  SpreadsheetApp.flush();

  const gfBridgeValues = histSh.getRange('P2:Q400').getValues();
  const gfSeriesMap = {};
  for (let i = 1; i < gfBridgeValues.length; i++) {
    const dtVal = gfBridgeValues[i][0];
    const closeVal = parsePositivePrice(gfBridgeValues[i][1]);
    if (dtVal && closeVal !== null) {
      const ymd = parseDateParts(dtVal).ymd;
      if (ymd >= startParts.ymd && ymd <= endParts.ymd) {
        gfSeriesMap[ymd] = closeVal;
      }
    }
  }
  histSh.getRange('P2:Q400').clearContent();

  // Step 2: Reconcile all 4 sources across every trading day
  const report = trackAndReconcileHistoricalRange(ticker, market, startParts.ymd, endParts.ymd, gfSeriesMap);

  // Step 3: Write results to History sheet
  const lastRow = Math.max(7, histSh.getLastRow());
  if (lastRow >= 7) {
    histSh.getRange(7, 1, lastRow - 6, 13).clearContent();
  }

  if (report.rows.length > 0) {
    const output = report.rows.map(function (r) {
      return [
        r.date,
        r.ticker,
        r.market,
        r.googleFinance !== null ? r.googleFinance : 'N/A',
        r.yahooFinance !== null ? r.yahooFinance : 'N/A',
        r.exchangeOfficial !== null ? r.exchangeOfficial : 'N/A',
        r.finMind !== null ? r.finMind : 'N/A',
        r.validSourceCount,
        r.consensusPrice !== null ? r.consensusPrice : 'N/A',
        r.spreadPct !== null ? r.spreadPct : 0,
        r.statusCode,
        r.statusLabel,
        sanitizeSheetText(r.outlierSource),
      ];
    });
    histSh.getRange(7, 1, output.length, 13).setValues(output);
    histSh.getRange(7, 4, output.length, 4).setNumberFormat('#,##0.00');
    histSh.getRange(7, 9, output.length, 1).setNumberFormat('#,##0.00');
    histSh.getRange(7, 10, output.length, 1).setNumberFormat('0.00%');
  }

  appendAuditLog_(
    ss,
    'HIST_TRACK',
    ticker + ' (' + startParts.ymd + '~' + endParts.ymd + ')',
    report.totalTradingDays > 0 ? 'OK' : 'WARN',
    Date.now() - startMs,
    '共 ' + report.totalTradingDays + ' 個交易日，三源精準 ' + report.verifiedDays + ' 天，異常 ' + report.discrepancyDays + ' 天',
    4,
    ''
  );

  try {
    SpreadsheetApp.getUi().alert(
      '📈 歷史股價追蹤完成 (' + ticker + ')！\n區間：' + startParts.ymd + ' ~ ' + endParts.ymd +
      '\n共追蹤 ' + report.totalTradingDays + ' 個交易日，三源精準一致：' + report.verifiedDays + ' 天，異常：' + report.discrepancyDays + ' 天。'
    );
  } catch (e) {}
}

/**
 * In-Sheet self-diagnostic covering core formulas, default Betas, and security validators.
 */
function runBuiltInDiagnostics() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const checks = [];

  // Layer 1: Structure
  const requiredSheets = Object.values(APP_CONFIG.SHEETS);
  const missingSheets = requiredSheets.filter(function (name) { return !ss.getSheetByName(name); });
  checks.push({ layer: 'L1 形式審查', ok: missingSheets.length === 0, detail: missingSheets.length === 0 ? '7/7 分頁完整' : '缺少分頁: ' + missingSheets.join(',') });

  // Layer 2: Core Math Verification
  const sim = runFireSimulation({
    status: '還在工作', currentAge: 35, retireAge: 55, lifeExpectancy: 85,
    currentNetWorth: 5000000, monthlySavings: 50000, monthlySpending: 60000,
    nominalReturn: 0.07, inflationRate: 0.03,
  });
  const roundTrip = runFireSimulation(Object.assign({}, sim.inputs, { monthlySpending: sim.maxMonthlySpending }));
  const mathOk = Math.abs(roundTrip.endingRealBalance) < 1.0;
  checks.push({ layer: 'L2 功能驗證 (DWZ)', ok: mathOk, detail: '反推歸零殘差=' + roundTrip.endingRealBalance.toFixed(4) });

  // Layer 2: Beta Presets Check
  const betaTest = calculatePortfolioBeta([
    { ticker: '00631L', market: 'TWSE', shares: 1000, price: 200 },
    { ticker: 'CASH', market: 'CASH', shares: 200000, price: 1 },
  ]);
  const betaOk = Math.abs(betaTest.overallPortfolioBeta - 1.0) < 1e-6;
  checks.push({ layer: 'L2 功能驗證 (Beta)', ok: betaOk, detail: '50%正2+50%現金 Beta=' + betaTest.overallPortfolioBeta.toFixed(4) });

  // Layer 4: Security Check
  let ssrfBlocked = false;
  try {
    validateAllowedUrl('https://evil.example.com/steal');
  } catch (e) {
    ssrfBlocked = true;
  }
  const injSanitized = sanitizeSheetText('=IMPORTXML("http://evil","//")').startsWith("'");
  checks.push({ layer: 'L4 安全與治理', ok: ssrfBlocked && injSanitized, detail: 'SSRF阻斷=' + ssrfBlocked + ', 公式注入過濾=' + injSanitized });

  const allPass = checks.every(function (c) { return c.ok; });
  const summary = checks.map(function (c) { return (c.ok ? '✅ ' : '❌ ') + c.layer + '：' + c.detail; }).join('\n');
  appendAuditLog_(ss, 'DIAGNOSTIC', 'runBuiltInDiagnostics', allPass ? 'OK' : 'ERROR', 0, summary.replace(/\n/g, ' ; '), '', '');

  try {
    SpreadsheetApp.getUi().alert((allPass ? '✅ 系統快速自檢全部通過！\n\n' : '⚠️ 部分自檢未通過：\n\n') + summary);
  } catch (e) {}
  return { ok: allPass, checks: checks };
}
