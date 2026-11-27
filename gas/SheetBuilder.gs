/**
 * @fileoverview One-click Google Sheets workbook builder (`setupWorkbook`).
 * Automatically creates and styles all 7 sheets, populates formulas, data validations,
 * conditional formatting, and native charts matching alphalab.site/fire + Portfolio Beta
 * + 4-Source Price Reconciliation.
 */

const THEME = Object.freeze({
  PRIMARY_DARK: '#0F172A',
  PRIMARY_BLUE: '#1D4ED8',
  ACCENT_TEAL: '#0F766E',
  HEADER_BG: '#1E293B',
  HEADER_TEXT: '#FFFFFF',
  SUBHEADER_BG: '#E2E8F0',
  INPUT_BG: '#FEF9C3',
  KPI_BG: '#EFF6FF',
  KPI_HIGHLIGHT_BG: '#ECFDF5',
  WARN_BG: '#FEF2F2',
  BORDER_COLOR: '#CBD5E1',
  ZEBRA_BG: '#F8FAFC',
});

/**
 * Main entry point: creates or rebuilds the entire 7-tab Die With Zero & Portfolio Beta Workbook.
 */
function setupWorkbook() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    throw new Error('setupWorkbook() must be executed from a container-bound Google Spreadsheet.');
  }

  ss.setSpreadsheetTimeZone(APP_CONFIG.TIMEZONE);
  ss.setSpreadsheetLocale('zh_TW');

  const sheetOrder = [
    APP_CONFIG.SHEETS.DASHBOARD,
    APP_CONFIG.SHEETS.PORTFOLIO,
    APP_CONFIG.SHEETS.RECONCILIATION,
    APP_CONFIG.SHEETS.HISTORY,
    APP_CONFIG.SHEETS.SETTINGS,
    APP_CONFIG.SHEETS.SIMULATION,
    APP_CONFIG.SHEETS.LOGS,
  ];

  // Ensure all sheets exist first so cross-sheet formulas resolve immediately
  const sheets = {};
  for (let i = 0; i < sheetOrder.length; i++) {
    const name = sheetOrder[i];
    let sh = ss.getSheetByName(name);
    if (!sh) {
      sh = ss.insertSheet(name);
    } else {
      sh.clear();
      sh.clearConditionalFormatRules();
      const charts = sh.getCharts();
      for (let c = 0; c < charts.length; c++) {
        sh.removeChart(charts[c]);
      }
    }
    sheets[name] = sh;
  }

  // Build each tab in dependency order
  buildSettingsSheet_(sheets[APP_CONFIG.SHEETS.SETTINGS]);
  buildPortfolioSheet_(sheets[APP_CONFIG.SHEETS.PORTFOLIO]);
  buildReconciliationSheet_(sheets[APP_CONFIG.SHEETS.RECONCILIATION]);
  buildHistorySheet_(sheets[APP_CONFIG.SHEETS.HISTORY]);
  buildSimulationSheet_(sheets[APP_CONFIG.SHEETS.SIMULATION]);
  buildDashboardSheet_(sheets[APP_CONFIG.SHEETS.DASHBOARD], sheets[APP_CONFIG.SHEETS.SIMULATION]);
  buildLogsSheet_(sheets[APP_CONFIG.SHEETS.LOGS]);

  // Arrange tabs in logical order
  for (let i = 0; i < sheetOrder.length; i++) {
    ss.setActiveSheet(sheets[sheetOrder[i]]);
    ss.moveActiveSheet(i + 1);
  }
  ss.setActiveSheet(sheets[APP_CONFIG.SHEETS.DASHBOARD]);

  // Remove default empty "工作表1" / "Sheet1" if present and unused
  ['工作表1', 'Sheet1'].forEach(function (defaultName) {
    const defSheet = ss.getSheetByName(defaultName);
    if (defSheet && ss.getSheets().length > 1) {
      ss.deleteSheet(defSheet);
    }
  });

  SpreadsheetApp.flush();
  appendAuditLog_(ss, 'SYSTEM', 'setupWorkbook', 'OK', 0, '成功建置 7 大分頁、公式與圖表');
  return true;
}

/**
 * Tab 5: ⚙️ 預設Beta與參數
 */
function buildSettingsSheet_(sh) {
  sh.setFrozenRows(4);
  sh.getRange('A1:K1').merge()
    .setValue('⚙️ 預設 Beta 對照表與系統校對參數設定')
    .setBackground(THEME.PRIMARY_DARK).setFontColor(THEME.HEADER_TEXT)
    .setFontSize(14).setFontWeight('bold').setVerticalAlignment('middle');
  sh.setRowHeight(1, 36);

  sh.getRange('A3:F3').merge().setValue('一、預設股票 Beta 對照表（可自由新增自訂標的）')
    .setBackground(THEME.SUBHEADER_BG).setFontWeight('bold');

  const betaHeaders = [['股票代號', '市場別', '資產名稱', '預設 Beta', '幣別', '說明']];
  sh.getRange('A4:F4').setValues(betaHeaders)
    .setBackground(THEME.HEADER_BG).setFontColor(THEME.HEADER_TEXT).setFontWeight('bold');

  const presetRows = APP_CONFIG.DEFAULT_BETA_PRESETS.map(function (p) {
    return [p.ticker, p.market, p.name, p.beta, p.currency, p.note];
  });
  sh.getRange(5, 1, presetRows.length, 6).setValues(presetRows);
  sh.getRange('A5:F30').setBorder(true, true, true, true, true, true, THEME.BORDER_COLOR, SpreadsheetApp.BorderStyle.SOLID);
  sh.getRange('D5:D30').setNumberFormat('0.00').setBackground(THEME.INPUT_BG);

  // Right side: System Parameters
  sh.getRange('H3:J3').merge().setValue('二、系統校對容差與 CAPM 參數')
    .setBackground(THEME.SUBHEADER_BG).setFontWeight('bold');
  sh.getRange('H4:J4').setValues([['參數項目', '設定值', '說明']])
    .setBackground(THEME.HEADER_BG).setFontColor(THEME.HEADER_TEXT).setFontWeight('bold');

  const paramRows = [
    ['CAPM 無風險利率 (Rf)', APP_CONFIG.FIRE_DEFAULTS.CAPM_RISK_FREE_RATE, '僅供 Beta 參考報酬估算'],
    ['CAPM 市場風險溢酬 (ERP)', APP_CONFIG.FIRE_DEFAULTS.CAPM_EQUITY_RISK_PREMIUM, 'Beta=1 時 Rf+ERP = 7.0%'],
    ['今日即時校對一致容差', APP_CONFIG.RECONCILIATION.LIVE_VERIFIED_SPREAD_PCT, '涵蓋 Google Finance 15-20 分延遲'],
    ['今日即時校對異常門檻', APP_CONFIG.RECONCILIATION.LIVE_MINOR_SPREAD_PCT, '超過即標記 🚨 異常價差'],
    ['歷史收盤精準一致容差', APP_CONFIG.RECONCILIATION.HISTORICAL_VERIFIED_SPREAD_PCT, '0.1% 或 0.05 元以內視為精準一致'],
    ['歷史收盤異常警示門檻', APP_CONFIG.RECONCILIATION.HISTORICAL_MINOR_SPREAD_PCT, '超過即自動偵測離群來源'],
    ['最低有效來源數要求', APP_CONFIG.RECONCILIATION.MIN_REQUIRED_SOURCES, '強制要求 ≥3 權威來源'],
    ['即時美元兌台幣匯率 (USD/TWD)', '=IFERROR(GOOGLEFINANCE("CURRENCY:USDTWD"),32.0)', '美股持倉自動換算台幣'],
  ];
  sh.getRange(5, 8, paramRows.length, 3).setValues(paramRows);
  sh.getRange('I5:I10').setNumberFormat('0.00%').setBackground(THEME.INPUT_BG);
  sh.getRange('I11').setNumberFormat('0').setBackground(THEME.INPUT_BG);
  sh.getRange('I12').setNumberFormat('0.000');
  sh.getRange('H5:J12').setBorder(true, true, true, true, true, true, THEME.BORDER_COLOR, SpreadsheetApp.BorderStyle.SOLID);

  // Taiwan MOI Life Expectancy Reference (aligned with alphalab.site/fire)
  sh.getRange('H15:J15').merge().setValue('三、台灣內政部簡易生命表參考（AlphaLab 保守壽命建議）')
    .setBackground(THEME.SUBHEADER_BG).setFontWeight('bold');
  sh.getRange('H16:J16').setValues([['對象分類', '平均餘命參考', '保守規劃建議壽命']])
    .setBackground(THEME.HEADER_BG).setFontColor(THEME.HEADER_TEXT).setFontWeight('bold');
  sh.getRange('H17:J19').setValues([
    ['全體國人平均', '約 80-81 歲', '85 歲（預設保守值）'],
    ['男性保守規劃', '約 77-78 歲', '84 - 85 歲'],
    ['女性保守規劃', '約 84-85 歲', '88 - 90 歲'],
  ]).setBorder(true, true, true, true, true, true, THEME.BORDER_COLOR, SpreadsheetApp.BorderStyle.SOLID);

  sh.setColumnWidths(1, 6, 130);
  sh.setColumnWidth(6, 260);
  sh.setColumnWidth(7, 24);
  sh.setColumnWidth(8, 220);
  sh.setColumnWidth(9, 120);
  sh.setColumnWidth(10, 240);
}

/**
 * Tab 2: 💼 持倉與Beta
 */
function buildPortfolioSheet_(sh) {
  sh.setFrozenRows(8);
  sh.getRange('A1:N1').merge()
    .setValue('💼 個人股票持倉與整體 Beta 值計算器（支援自訂持倉、預設/覆寫 Beta、美股匯率自動換算）')
    .setBackground(THEME.PRIMARY_DARK).setFontColor(THEME.HEADER_TEXT)
    .setFontSize(14).setFontWeight('bold').setVerticalAlignment('middle');
  sh.setRowHeight(1, 36);

  // KPI Summary Banner (Rows 3-6)
  sh.getRange('A3:N3').merge().setValue('📌 投資組合整體風險與 Beta 總覽（自動即時連動）')
    .setBackground(THEME.SUBHEADER_BG).setFontWeight('bold');

  const kpiLayout = [
    ['總資產市值 (TWD)', '=SUM(H9:H50)', '', '純股票市值 (不含現金)', '=SUMIF(B9:B50,"<>CASH",H9:H50)', '', '等效大盤曝險 (Beta=1)', '=SUM(N9:N50)', '', 'USD/TWD 即時匯率', "='⚙️ 預設Beta與參數'!I12"],
    ['整體組合 Beta (含現金)', '=IF(C4>0,SUM(M9:M50),0)', '', '純股票部位 Beta', '=IF(F4>0,SUMIFS(N9:N50,B9:B50,"<>CASH")/F4,0)', '', '現金配置比例 (%)', '=IF(C4>0,SUMIF(B9:B50,"CASH",H9:H50)/C4,0)', '', 'CAPM 參考報酬率', "='⚙️ 預設Beta與參數'!I5+C5*'⚙️ 預設Beta與參數'!I6"],
  ];
  sh.getRange('B4:L5').setValues(kpiLayout);
  sh.getRange('B4:C5').setBackground(THEME.KPI_HIGHLIGHT_BG).setFontWeight('bold');
  sh.getRange('E4:F5').setBackground(THEME.KPI_BG).setFontWeight('bold');
  sh.getRange('H4:I5').setBackground(THEME.KPI_BG).setFontWeight('bold');
  sh.getRange('K4:L5').setBackground(THEME.ZEBRA_BG);

  sh.getRange('C4').setNumberFormat('#,##0').setFontSize(12);
  sh.getRange('C5').setNumberFormat('0.00').setFontSize(13).setFontColor(THEME.PRIMARY_BLUE);
  sh.getRange('F4').setNumberFormat('#,##0');
  sh.getRange('F5').setNumberFormat('0.00');
  sh.getRange('I4').setNumberFormat('#,##0');
  sh.getRange('I5').setNumberFormat('0.0%');
  sh.getRange('L4').setNumberFormat('0.000');
  sh.getRange('L5').setNumberFormat('0.00%');
  sh.getRange('B4:L5').setBorder(true, true, true, true, true, true, THEME.BORDER_COLOR, SpreadsheetApp.BorderStyle.SOLID);

  // Holdings Table Headers (Row 8)
  const headers = [[
    '股票代號\n(可自由新增)', '市場別', '資產名稱', '持有股數\n/ 現金金額', '幣別',
    '採用股價\n(共識價優先)', '匯率', '市值 (TWD)', '權重 (%)',
    '預設 Beta\n(自動查表)', '自訂覆寫 Beta\n(選填)', '採用 Beta', '加權 Beta 貢獻', '等效大盤曝險\n(TWD)',
  ]];
  sh.getRange('A8:N8').setValues(headers)
    .setBackground(THEME.HEADER_BG).setFontColor(THEME.HEADER_TEXT)
    .setFontWeight('bold').setWrap(true).setHorizontalAlignment('center');
  sh.setRowHeight(8, 34);

  // Pre-populated sample portfolio covering all 6 mandatory defaults
  const sampleHoldings = [
    ['0050', 'TWSE', '元大台灣50', 10000, 'TWD'],
    ['006208', 'TWSE', '富邦台50', 5000, 'TWD'],
    ['00662', 'TWSE', '富邦NASDAQ', 5000, 'TWD'],
    ['00685L', 'TWSE', '群益臺灣加權正2', 3000, 'TWD'],
    ['00631L', 'TWSE', '元大台灣50正2', 5000, 'TWD'],
    ['CASH', 'CASH', '現金 Cash', 1500000, 'TWD'],
  ];

  const formulaRows = [];
  for (let r = 9; r <= 50; r++) {
    const idx = r - 9;
    const base = idx < sampleHoldings.length ? sampleHoldings[idx] : ['', '', '', '', ''];
    const consensusLookup = "IFERROR(INDEX('🔍 多源股價校對'!$I$6:$I$25,MATCH(A" + r + ",'🔍 多源股價校對'!$A$6:$A$25,0)),\"\")";
    const gfFallback = 'IFERROR(GOOGLEFINANCE(IF(B' + r + '="US",A' + r + ',"TPE:"&A' + r + '),"price"),0)';
    const priceFormula = '=IF(A' + r + '="","",IF(B' + r + '="CASH",1,IF(ISNUMBER(' + consensusLookup + '),' + consensusLookup + ',' + gfFallback + ')))';
    const fxFormula = '=IF(A' + r + '="","",IF(E' + r + '="USD",\'⚙️ 預設Beta與參數\'!$I$12,1))';
    const mvFormula = '=IF(A' + r + '="","",IF(AND(ISNUMBER(D' + r + '),ISNUMBER(F' + r + '),ISNUMBER(G' + r + ')),D' + r + '*F' + r + '*G' + r + ',0))';
    const weightFormula = '=IF(A' + r + '="","",IF($C$4>0,H' + r + '/$C$4,0))';
    const defaultBetaFormula = '=IF(A' + r + '="","",IF(B' + r + '="CASH",0,IFERROR(VLOOKUP(A' + r + ',\'⚙️ 預設Beta與參數\'!$A$5:$D$30,4,FALSE),"未預設(暫採1)")))';
    const effBetaFormula = '=IF(A' + r + '="","",IF(ISNUMBER(K' + r + '),K' + r + ',IF(ISNUMBER(J' + r + '),J' + r + ',1)))';
    const weightedBetaFormula = '=IF(A' + r + '="","",I' + r + '*L' + r + ')';
    const exposureFormula = '=IF(A' + r + '="","",H' + r + '*L' + r + ')';

    formulaRows.push([
      base[0], base[1], base[2], base[3], base[4],
      priceFormula, fxFormula, mvFormula, weightFormula,
      defaultBetaFormula, '', effBetaFormula, weightedBetaFormula, exposureFormula,
    ]);
  }
  sh.getRange(9, 1, formulaRows.length, 14).setValues(formulaRows);

  // Input highlighting & Data Validations
  sh.getRange('A9:E50').setBackground(THEME.INPUT_BG);
  sh.getRange('K9:K50').setBackground(THEME.INPUT_BG);
  sh.getRange('A9:N50').setBorder(true, true, true, true, true, true, THEME.BORDER_COLOR, SpreadsheetApp.BorderStyle.SOLID);

  const marketRule = SpreadsheetApp.newDataValidation().requireValueInList(['TWSE', 'TPEX', 'US', 'CASH'], true).build();
  const currRule = SpreadsheetApp.newDataValidation().requireValueInList(['TWD', 'USD'], true).build();
  sh.getRange('B9:B50').setDataValidation(marketRule);
  sh.getRange('E9:E50').setDataValidation(currRule);

  // Number formats
  sh.getRange('D9:D50').setNumberFormat('#,##0.####');
  sh.getRange('F9:F50').setNumberFormat('#,##0.00');
  sh.getRange('G9:G50').setNumberFormat('0.000');
  sh.getRange('H9:H50').setNumberFormat('#,##0');
  sh.getRange('I9:I50').setNumberFormat('0.00%');
  sh.getRange('J9:M50').setNumberFormat('0.00');
  sh.getRange('N9:N50').setNumberFormat('#,##0');

  // Market Shock Stress Test Table (Rows 53-60)
  sh.getRange('A52:F52').merge().setValue('⚡ 投資組合大盤波動壓力測試（依整體 Beta 推估，槓桿 ETF 具每日複利耗損僅供情境參考）')
    .setBackground(THEME.SUBHEADER_BG).setFontWeight('bold');
  sh.getRange('A53:F53').setValues([['情境名稱', '大盤漲跌幅', '預估組合漲跌幅', '預估損益金額 (TWD)', '衝擊後淨資產 (TWD)', '風險備註']])
    .setBackground(THEME.HEADER_BG).setFontColor(THEME.HEADER_TEXT).setFontWeight('bold');

  const stressScenarios = [
    ['極端股災 (-50%)', -0.50, '高槓桿注意保證金/波動耗損'],
    ['深度熊市 (-30%)', -0.30, '檢視現金緩衝是否足夠生活 2-3 年'],
    ['技術熊市 (-20%)', -0.20, '常見熊市回檔幅度'],
    ['健康回檔 (-10%)', -0.10, '正常年度波動區間'],
    ['溫和上漲 (+15%)', 0.15, '偏多年度情景'],
    ['多頭強漲 (+30%)', 0.30, '強勢多頭情景'],
  ];
  const stressRows = stressScenarios.map(function (s, idx) {
    const rowNum = 54 + idx;
    return [
      s[0],
      s[1],
      '=MAX(-1, B' + rowNum + '*$C$5)',
      '=$C$4*C' + rowNum,
      '=MAX(0, $C$4+D' + rowNum + ')',
      s[2],
    ];
  });
  sh.getRange(54, 1, stressRows.length, 6).setValues(stressRows)
    .setBorder(true, true, true, true, true, true, THEME.BORDER_COLOR, SpreadsheetApp.BorderStyle.SOLID);
  sh.getRange('B54:C59').setNumberFormat('+0.0%;-0.0%;0.0%');
  sh.getRange('D54:E59').setNumberFormat('#,##0');

  sh.setColumnWidth(1, 110);
  sh.setColumnWidth(2, 85);
  sh.setColumnWidth(3, 150);
  sh.setColumnWidth(4, 125);
  sh.setColumnWidth(5, 65);
  sh.setColumnWidths(6, 9, 115);
}

/**
 * Tab 3: 🔍 多源股價校對 (Live + Specified Historical Date across 4 Authoritative Sources)
 */
function buildReconciliationSheet_(sh) {
  sh.setFrozenRows(5);
  sh.getRange('A1:N1').merge()
    .setValue('🔍 三源以上權威股價校對中心（Google Finance × Yahoo Finance v8 × TWSE/TPEx/Stooq × FinMind）')
    .setBackground(THEME.PRIMARY_DARK).setFontColor(THEME.HEADER_TEXT)
    .setFontSize(14).setFontWeight('bold').setVerticalAlignment('middle');
  sh.setRowHeight(1, 36);

  // Control bar Row 3
  sh.getRange('A3:N3').setBackground(THEME.KPI_BG);
  sh.getRange('A3:B3').merge().setValue('📅 歷史收盤校對目標日期：').setFontWeight('bold');
  sh.getRange('C3').setFormula('=WORKDAY(TODAY(),-5)').setNumberFormat('yyyy-mm-dd').setBackground(THEME.INPUT_BG).setFontWeight('bold');
  sh.getRange('E3').setValue('今日三源一致率：').setFontWeight('bold');
  sh.getRange('F3').setFormula('=IF(COUNTA(A6:A25)>0,COUNTIF(L6:L25,"✅*")/COUNTA(A6:A25),0)').setNumberFormat('0.0%');
  sh.getRange('H3').setValue('歷史三源精準率：').setFontWeight('bold');
  sh.getRange('I3').setFormula('=IF(COUNTA(A30:A49)>0,COUNTIF(L30:L49,"✅*")/COUNTA(A30:A49),0)').setNumberFormat('0.0%');
  sh.getRange('K3:N3').merge().setValue('💡 請從上方選單「🔥 Die With Zero & Beta」執行同步校對');

  // Section A: Today / Live Price Reconciliation (Rows 4-25)
  sh.getRange('A4:N4').merge().setValue('一、今日 / 目前股價四源校對表（前 20 檔自動同步自「💼 持倉與Beta」）')
    .setBackground(THEME.SUBHEADER_BG).setFontWeight('bold');

  const headers = [[
    '股票代號', '市場別', '名稱',
    '來源1\nGoogle Finance', '來源2\nYahoo Finance', '來源3\nTWSE/TPEx/Stooq', '來源4\nFinMind',
    '有效來源數', '共識價\n(中位數)', '最大價差', '最大價差率', '校對狀態', '離群來源偵測', '交易日 / 更新時間',
  ]];
  sh.getRange('A5:N5').setValues(headers)
    .setBackground(THEME.HEADER_BG).setFontColor(THEME.HEADER_TEXT)
    .setFontWeight('bold').setWrap(true).setHorizontalAlignment('center');
  sh.setRowHeight(5, 34);

  const liveRows = [];
  for (let i = 0; i < 20; i++) {
    const r = 6 + i;
    const pRow = 9 + i;
    liveRows.push([
      "=IF('💼 持倉與Beta'!A" + pRow + '="","",\'💼 持倉與Beta\'!A' + pRow + ')',
      "=IF(A" + r + '="","",\'💼 持倉與Beta\'!B' + pRow + ')',
      "=IF(A" + r + '="","",\'💼 持倉與Beta\'!C' + pRow + ')',
      buildGoogleFinanceLiveFormula('A' + r, 'B' + r),
      '', '', '',
      '=IF(A' + r + '="","",COUNT(D' + r + ':G' + r + '))',
      '=IF(A' + r + '="","",IF(H' + r + '>0,MEDIAN(D' + r + ':G' + r + '),""))',
      '=IF(A' + r + '="","",IF(H' + r + '>=2,MAX(D' + r + ':G' + r + ')-MIN(D' + r + ':G' + r + '),0))',
      '=IF(A' + r + '="","",IF(AND(H' + r + '>=2,ISNUMBER(I' + r + '),I' + r + '>0),J' + r + '/I' + r + ',0))',
      '=IF(A' + r + '="","",IF(B' + r + '="CASH","✅ 現金固定值",IF(H' + r + '=0,"❌ 無報價",IF(H' + r + "<'⚙️ 預設Beta與參數'!$I$11,\"⚠️ 來源不足(\" & H" + r + ' & "/3)",IF(K' + r + "<='⚙️ 預設Beta與參數'!$I$7,\"✅ 三源一致\",IF(K" + r + "<='⚙️ 預設Beta與參數'!$I$8,\"⚠️ 延遲/輕微價差\",\"🚨 異常價差警示\"))))))",
      '', '',
    ]);
  }
  sh.getRange(6, 1, liveRows.length, 14).setValues(liveRows)
    .setBorder(true, true, true, true, true, true, THEME.BORDER_COLOR, SpreadsheetApp.BorderStyle.SOLID);

  // Section B: Historical Closing Price Reconciliation on Target Date C3 (Rows 28-49)
  sh.getRange('A28:N28').merge().setValue('二、指定歷史日期收盤價四源校對表（統一採用「未還原收盤價」比對，目標日期見 C3）')
    .setBackground(THEME.SUBHEADER_BG).setFontWeight('bold');
  sh.getRange('A29:N29').setValues(headers)
    .setBackground(THEME.ACCENT_TEAL).setFontColor(THEME.HEADER_TEXT)
    .setFontWeight('bold').setWrap(true).setHorizontalAlignment('center');
  sh.setRowHeight(29, 34);

  const histRows = [];
  for (let i = 0; i < 20; i++) {
    const r = 30 + i;
    const pRow = 9 + i;
    histRows.push([
      "=IF('💼 持倉與Beta'!A" + pRow + '="","",\'💼 持倉與Beta\'!A' + pRow + ')',
      "=IF(A" + r + '="","",\'💼 持倉與Beta\'!B' + pRow + ')',
      "=IF(A" + r + '="","",\'💼 持倉與Beta\'!C' + pRow + ')',
      buildGoogleFinanceHistoricalFormula('A' + r, 'B' + r, '$C$3'),
      '', '', '',
      '=IF(A' + r + '="","",COUNT(D' + r + ':G' + r + '))',
      '=IF(A' + r + '="","",IF(H' + r + '>0,MEDIAN(D' + r + ':G' + r + '),""))',
      '=IF(A' + r + '="","",IF(H' + r + '>=2,MAX(D' + r + ':G' + r + ')-MIN(D' + r + ':G' + r + '),0))',
      '=IF(A' + r + '="","",IF(AND(H' + r + '>=2,ISNUMBER(I' + r + '),I' + r + '>0),J' + r + '/I' + r + ',0))',
      '=IF(A' + r + '="","",IF(B' + r + '="CASH","✅ 現金固定值",IF(H' + r + '=0,"❌ 無報價",IF(H' + r + "<'⚙️ 預設Beta與參數'!$I$11,\"⚠️ 來源不足(\" & H" + r + ' & "/3)",IF(OR(K' + r + "<='⚙️ 預設Beta與參數'!$I$9,J" + r + "<=0.05),\"✅ 三源精準一致\",IF(K" + r + "<='⚙️ 預設Beta與參數'!$I$10,\"⚠️ 輕微差異\",\"🚨 異常價差警示\"))))))",
      '', '',
    ]);
  }
  sh.getRange(30, 1, histRows.length, 14).setValues(histRows)
    .setBorder(true, true, true, true, true, true, THEME.BORDER_COLOR, SpreadsheetApp.BorderStyle.SOLID);

  // Formats
  sh.getRange('D6:G25').setNumberFormat('#,##0.00');
  sh.getRange('I6:J25').setNumberFormat('#,##0.00');
  sh.getRange('K6:K25').setNumberFormat('0.00%');
  sh.getRange('D30:G49').setNumberFormat('#,##0.00');
  sh.getRange('I30:J49').setNumberFormat('#,##0.00');
  sh.getRange('K30:K49').setNumberFormat('0.00%');

  // Conditional Formatting for status column L
  const statusRange1 = sh.getRange('L6:L25');
  const statusRange2 = sh.getRange('L30:L49');
  const rules = [
    SpreadsheetApp.newConditionalFormatRule().whenTextStartsWith('✅').setBackground('#DCFCE7').setFontColor('#166534').setRanges([statusRange1, statusRange2]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextStartsWith('⚠️').setBackground('#FEF9C3').setFontColor('#854D0E').setRanges([statusRange1, statusRange2]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextStartsWith('🚨').setBackground('#FEE2E2').setFontColor('#991B1B').setRanges([statusRange1, statusRange2]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextStartsWith('❌').setBackground('#FEE2E2').setFontColor('#991B1B').setRanges([statusRange1, statusRange2]).build(),
  ];
  sh.setConditionalFormatRules(rules);

  sh.setColumnWidths(1, 3, 100);
  sh.setColumnWidth(3, 130);
  sh.setColumnWidths(4, 8, 105);
  sh.setColumnWidth(12, 145);
  sh.setColumnWidth(13, 155);
  sh.setColumnWidth(14, 155);
}

/**
 * Tab 4: 📈 歷史股價追蹤 (Multi-day range tracking across 4 sources)
 */
function buildHistorySheet_(sh) {
  sh.setFrozenRows(6);
  sh.getRange('A1:M1').merge()
    .setValue('📈 區間歷史收盤價多源追蹤與逐日比對報表')
    .setBackground(THEME.PRIMARY_DARK).setFontColor(THEME.HEADER_TEXT)
    .setFontSize(14).setFontWeight('bold').setVerticalAlignment('middle');
  sh.setRowHeight(1, 36);

  // Query Parameter Bar
  sh.getRange('A3:M4').setBackground(THEME.KPI_BG);
  sh.getRange('A3:H3').setValues([['追蹤代號', '市場別', '起始日期', '結束日期', '總交易日數', '三源精準日數', '異常日數', '操作提示']]).setFontWeight('bold');
  sh.getRange('A4:H4').setValues([[
    '0050',
    'TWSE',
    '=WORKDAY(TODAY(),-22)',
    '=TODAY()',
    '=COUNTA(A7:A500)',
    '=COUNTIF(L7:L500,"✅*")',
    '=COUNTIF(L7:L500,"🚨*")',
    '於選單點選「📈 追蹤區間歷史收盤價並校對」',
  ]]);
  sh.getRange('A4:D4').setBackground(THEME.INPUT_BG);
  sh.getRange('C4:D4').setNumberFormat('yyyy-mm-dd');
  sh.getRange('B4').setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['TWSE', 'TPEX', 'US'], true).build());

  const headers = [[
    '交易日期', '代號', '市場別',
    '來源1\nGoogle Finance', '來源2\nYahoo Finance', '來源3\nTWSE/TPEx/Stooq', '來源4\nFinMind',
    '有效來源數', '共識收盤價\n(中位數)', '最大價差率', '狀態碼', '校對狀態', '離群來源',
  ]];
  sh.getRange('A6:M6').setValues(headers)
    .setBackground(THEME.HEADER_BG).setFontColor(THEME.HEADER_TEXT)
    .setFontWeight('bold').setWrap(true).setHorizontalAlignment('center');
  sh.setRowHeight(6, 32);

  // Hidden helper area (columns P:Q) used temporarily by Apps Script to evaluate GOOGLEFINANCE date-range series
  sh.getRange('P1').setValue('GF_RANGE_BRIDGE').setFontColor('#94A3B8');
  sh.setColumnWidths(1, 13, 110);
  sh.setColumnWidth(12, 145);
  sh.setColumnWidth(13, 155);
}

/**
 * Tab 6: 📉 逐年資產模擬 (Full Year-by-Year Simulation powering Dashboard & Charts)
 */
function buildSimulationSheet_(sh) {
  sh.setFrozenRows(4);
  sh.getRange('A1:R1').merge()
    .setValue('📉 逐年資產軌跡模擬表（今日實質幣值 × 理想歸零曲線 × 4% FIRE 對照）')
    .setBackground(THEME.PRIMARY_DARK).setFontColor(THEME.HEADER_TEXT)
    .setFontSize(14).setFontWeight('bold').setVerticalAlignment('middle');
  sh.setRowHeight(1, 36);

  // Summary helpers Row 2 (referenced cleanly by Dashboard without circular refs)
  sh.getRange('J2:N2').setValues([[
    '輔助彙總：',
    '退休金折現總值 =>',
    '=SUM(K5:K90)',
    '=SUM(J5:J90)',
    '=SUM(L5:L90)',
  ]]).setBackground(THEME.ZEBRA_BG).setFontWeight('bold');
  sh.getRange('L2:N2').setNumberFormat('#,##0');

  const headers = [[
    '年序', '年齡', '階段', '期初資產\n(今日幣值)', '實質投資收益', '年度淨現金流\n(儲蓄+/提領-)',
    '實際路徑資產\n(今日幣值)', '理想歸零曲線\n(套用最高月花)', '持續工作資產',
    '退休期淨支出折現', '退休金折現', '今日起淨支出折現',
    '該歲立即退休\nDWZ 門檻', '達標DWZ', '傳統 4% FIRE\n目標線', '達標FIRE', '名目資產\n(含通膨)', '耗盡標記',
  ]];
  sh.getRange('A4:R4').setValues(headers)
    .setBackground(THEME.HEADER_BG).setFontColor(THEME.HEADER_TEXT)
    .setFontWeight('bold').setWrap(true).setHorizontalAlignment('center');
  sh.setRowHeight(4, 34);

  const dash = "'" + APP_CONFIG.SHEETS.DASHBOARD + "'!";
  const rows = [];
  for (let yr = 0; yr <= 85; yr++) {
    const r = 5 + yr;
    const isFirst = yr === 0;
    const colA = '=IF(ROW()-5<=' + dash + '$C$8-' + dash + '$C$6,ROW()-5,"")';
    const colB = '=IF(A' + r + '="","",' + dash + '$C$6+A' + r + ')';
    const colC = '=IF(A' + r + '="","",IF(B' + r + '=' + dash + '$C$8,"預期壽命終點",IF(B' + r + '<' + dash + '$G$5,"工作累積期","退休提領期")))';
    const colD = isFirst ? ('=' + dash + '$C$13') : ('=IF(A' + r + '="","",G' + (r - 1) + ')');
    const colE = '=IF(A' + r + '="","",IF(B' + r + '=' + dash + '$C$8,0,D' + r + '*' + dash + '$C$22))';
    const colF = '=IF(A' + r + '="","",IF(B' + r + '=' + dash + '$C$8,0,IF(B' + r + '<' + dash + '$G$5,' + dash + '$G$8,-(' + dash + '$G$9-IF(B' + r + '>=' + dash + '$C$17,' + dash + '$C$16*12,0)))))';
    const colG = '=IF(A' + r + '="","",IF(B' + r + '=' + dash + '$C$8,D' + r + ',D' + r + '+E' + r + '+F' + r + '))';

    const prevH = isFirst ? (dash + '$C$13') : ('H' + (r - 1));
    const colH = '=IF(A' + r + '="","",IF(B' + r + '=' + dash + '$C$8,' + prevH + ',IF(B' + r + '<' + dash + '$G$5,' + prevH + '*(1+' + dash + '$C$22)+' + dash + '$G$8,' + prevH + '*(1+' + dash + '$C$22)-(' + dash + '$G$19*12-IF(B' + r + '>=' + dash + '$C$17,' + dash + '$C$16*12,0)))))';

    const colI = isFirst ? ('=' + dash + '$C$13') : ('=IF(A' + r + '="","",I' + (r - 1) + '*(1+' + dash + '$C$22)+' + dash + '$G$8)');
    const colJ = '=IF(A' + r + '="","",IF(AND(B' + r + '>=' + dash + '$G$5,B' + r + '<' + dash + '$C$8),MAX(0,' + dash + '$G$9-IF(B' + r + '>=' + dash + '$C$17,' + dash + '$C$16*12,0))/(1+' + dash + '$C$22)^(B' + r + '-' + dash + '$G$5+1),0))';
    const colK = '=IF(A' + r + '="","",IF(AND(B' + r + '>=' + dash + '$G$5,B' + r + '<' + dash + '$C$8),IF(B' + r + '>=' + dash + '$C$17,' + dash + '$C$16*12,0)/(1+' + dash + '$C$22)^(B' + r + '-' + dash + '$G$5+1),0))';
    const colL = '=IF(A' + r + '="","",IF(B' + r + '<' + dash + '$C$8,MAX(0,' + dash + '$G$9-IF(B' + r + '>=' + dash + '$C$17,' + dash + '$C$16*12,0))/(1+' + dash + '$C$22)^(B' + r + '-' + dash + '$C$6+1),0))';
    const colM = '=IF(A' + r + '="","",SUM(L' + r + ':$L$90)*(1+' + dash + '$C$22)^(B' + r + '-' + dash + '$C$6))';
    const colN = '=IF(A' + r + '="","",IF(I' + r + '>=M' + r + '-0.01,1,0))';
    const colO = '=IF(A' + r + '="","",' + dash + '$G$14)';
    const colP = '=IF(A' + r + '="","",IF(I' + r + '>=O' + r + '-0.01,1,0))';
    const colQ = '=IF(A' + r + '="","",G' + r + '*(1+' + dash + '$C$21)^A' + r + ')';
    const colR = '=IF(A' + r + '="","",IF(G' + r + '<-0.01,1,0))';

    rows.push([colA, colB, colC, colD, colE, colF, colG, colH, colI, colJ, colK, colL, colM, colN, colO, colP, colQ, colR]);
  }
  sh.getRange(5, 1, rows.length, 18).setValues(rows);
  sh.getRange('D5:M90').setNumberFormat('#,##0');
  sh.getRange('O5:O90').setNumberFormat('#,##0');
  sh.getRange('Q5:Q90').setNumberFormat('#,##0');
  sh.setColumnWidths(1, 18, 110);
}

/**
 * Tab 1: 📊 FIRE儀表板 (Faithful alphalab.site/fire Die With Zero Calculator + Charts)
 */
function buildDashboardSheet_(sh, simSheet) {
  const d = APP_CONFIG.FIRE_DEFAULTS;
  const port = "'" + APP_CONFIG.SHEETS.PORTFOLIO + "'!";
  const sim = "'" + APP_CONFIG.SHEETS.SIMULATION + "'!";
  const cfg = "'" + APP_CONFIG.SHEETS.SETTINGS + "'!";

  sh.getRange('A1:J1').merge()
    .setValue('🔥 財富自由 FIRE 退休試算｜Die With Zero 死前財產歸零計算機 × 投資組合 Beta')
    .setBackground(THEME.PRIMARY_DARK).setFontColor(THEME.HEADER_TEXT)
    .setFontSize(15).setFontWeight('bold').setVerticalAlignment('middle');
  sh.setRowHeight(1, 40);

  sh.getRange('A2:J2').merge()
    .setValue('完全對齊 alphalab.site/fire 設計：所有試算金額皆自動透過 Fisher 公式扣除通膨，以「今日實際購買力（幣值）」呈現。黃色底為可編輯輸入欄。')
    .setBackground('#F1F5F9').setFontColor('#334155').setFontStyle('italic');

  // === LEFT PANEL: Inputs (Cols A-D) ===
  sh.getRange('A4:D4').merge().setValue('1️⃣ 關於你（About You）')
    .setBackground(THEME.HEADER_BG).setFontColor(THEME.HEADER_TEXT).setFontWeight('bold');
  sh.getRange('A5:D8').setValues([
    ['你目前的狀態', '', d.STATUS, '選擇「還在工作」或「已經退休」'],
    ['現在幾歲', '', d.CURRENT_AGE, '歲'],
    ['想幾歲退休', '', d.RETIRE_AGE, '歲（若已退休則自動等於現在年齡）'],
    ['預計活到幾歲', '', d.LIFE_EXPECTANCY, '歲（預設參考內政部生命表保守長壽側）'],
  ]);
  sh.getRange('C5').setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['還在工作', '已經退休'], true).build());
  sh.getRange('C5:C8').setBackground(THEME.INPUT_BG).setFontWeight('bold');
  sh.getRange('C6:C8').setNumberFormat('0');

  sh.getRange('A10:D10').merge().setValue('2️⃣ 資產與收支（今日幣值 / TWD）')
    .setBackground(THEME.HEADER_BG).setFontColor(THEME.HEADER_TEXT).setFontWeight('bold');
  sh.getRange('A11:D17').setValues([
    ['淨資產資料來源', '', d.NET_WORTH_MODE, '可自動連動「💼 持倉與Beta」或手動試算'],
    ['手動輸入淨資產', '', d.MANUAL_NET_WORTH, '僅「手動輸入」模式使用'],
    ['實際採用淨資產', '', '=IF(C11="連動持倉總市值",' + port + 'C4,C12)', '含投資、現金等淨資產總額'],
    ['每月能存 / 投入多少', '', d.MONTHLY_SAVINGS, '工作期間每月投入（已退休自動歸 0）'],
    ['退休後每月開銷多少', '', d.MONTHLY_SPENDING, '今日幣值，維持理想退休生活開銷'],
    ['退休後每月退休金（選填）', '', d.MONTHLY_PENSION, 'AlphaLab 預設 0（不含勞保/勞退最保守）'],
    ['退休金開始領取年齡', '', d.PENSION_START_AGE, '歲（僅上方退休金 > 0 時生效）'],
  ]);
  sh.getRange('C11').setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['連動持倉總市值', '手動輸入'], true).build());
  sh.getRange('C11:C12').setBackground(THEME.INPUT_BG);
  sh.getRange('C13').setBackground(THEME.KPI_HIGHLIGHT_BG).setFontWeight('bold');
  sh.getRange('C14:C17').setBackground(THEME.INPUT_BG);
  sh.getRange('C12:C16').setNumberFormat('#,##0');
  sh.getRange('C17').setNumberFormat('0');

  sh.getRange('A19:D19').merge().setValue('3️⃣ 進階假設（Advanced Assumptions）')
    .setBackground(THEME.HEADER_BG).setFontColor(THEME.HEADER_TEXT).setFontWeight('bold');
  sh.getRange('A20:D25').setValues([
    ['預期年化投資報酬率 (名目)', '', d.NOMINAL_RETURN, '全球分散組合歷史約 6-8%'],
    ['預期年通貨膨脹率', '', d.INFLATION_RATE, '台灣約 1-2%，美國約 3%（保守抓 3%）'],
    ['實質年化報酬率 (Fisher)', '', '=(1+C20)/(1+C21)-1', '=(1+名目)/(1+通膨)-1'],
    ['傳統 FIRE 安全提領率', '', d.CLASSIC_FIRE_SWR, '預設 4.0%（25 倍法則對照基準）'],
    ['目前持倉整體 Beta (含現金)', '', '=' + port + 'C5', '自動連動「💼 持倉與Beta」'],
    ['Beta CAPM 參考年化報酬', '', '=' + cfg + 'I5+C24*' + cfg + 'I6', '僅供參考（槓桿 ETF 具波動耗損）'],
  ]);
  sh.getRange('C20:C21').setBackground(THEME.INPUT_BG);
  sh.getRange('C22').setBackground(THEME.KPI_BG).setFontWeight('bold');
  sh.getRange('C23').setBackground(THEME.INPUT_BG);
  sh.getRange('C24:C25').setBackground(THEME.ZEBRA_BG);
  sh.getRange('C20:C23').setNumberFormat('0.00%');
  sh.getRange('C24').setNumberFormat('0.00');
  sh.getRange('C25').setNumberFormat('0.00%');

  sh.getRange('A5:D8').setBorder(true, true, true, true, true, true, THEME.BORDER_COLOR, SpreadsheetApp.BorderStyle.SOLID);
  sh.getRange('A11:D17').setBorder(true, true, true, true, true, true, THEME.BORDER_COLOR, SpreadsheetApp.BorderStyle.SOLID);
  sh.getRange('A20:D25').setBorder(true, true, true, true, true, true, THEME.BORDER_COLOR, SpreadsheetApp.BorderStyle.SOLID);

  // === RIGHT PANEL: Die With Zero & FIRE KPIs (Cols F-J) ===
  sh.getRange('F4:J4').merge().setValue('📊 試算核心參數摘要')
    .setBackground(THEME.ACCENT_TEAL).setFontColor(THEME.HEADER_TEXT).setFontWeight('bold');
  sh.getRange('F5:J9').setValues([
    ['有效退休年齡', '=IF(C5="已經退休",C6,MAX(C6,C7))', '歲', '工作累積年數', '=MAX(0,G5-C6)'],
    ['尚餘工作年數', '=MAX(0,G5-C6)', '年', '退休支應年數', '=MAX(0,C8-G5)'],
    ['退休提領總年數', '=MAX(0,C8-G5)', '年', '持倉等效大盤曝險', '=' + port + 'I4'],
    ['年度儲蓄金額', '=IF(C5="已經退休",0,C14*12)', 'TWD/年', '現金配置比例', '=' + port + 'I5'],
    ['退休年度開銷', '=C15*12', 'TWD/年', '今日股價三源一致率', "='🔍 多源股價校對'!F3"],
  ]);
  sh.getRange('G5:G7').setNumberFormat('0');
  sh.getRange('G8:G9').setNumberFormat('#,##0');
  sh.getRange('J5:J6').setNumberFormat('0');
  sh.getRange('J7').setNumberFormat('#,##0');
  sh.getRange('J8:J9').setNumberFormat('0.0%');
  sh.getRange('F5:J9').setBorder(true, true, true, true, true, true, THEME.BORDER_COLOR, SpreadsheetApp.BorderStyle.SOLID);

  sh.getRange('F11:J11').merge().setValue('🎯 Die With Zero（死前財產歸零）vs 傳統 4% FIRE 試算結果')
    .setBackground(THEME.PRIMARY_BLUE).setFontColor(THEME.HEADER_TEXT).setFontWeight('bold');

  const kpiRows = [
    ['Die With Zero 退休目標金額（退休當下）', '=' + sim + 'M2', 'TWD', '退休時達此金額即可花到預期壽命剛好歸零', ''],
    ['今日立刻退休所需 DWZ 本金', '=' + sim + 'N2', 'TWD', '假設今天退休且剛好在預計壽命歸零', ''],
    ['傳統 FIRE (4% 法則) 目標金額', '=IF(C23>0,G9/C23,0)', 'TWD', '本金永遠不動（年支出 ÷ 安全提領率）', ''],
    ['預計退休時累積淨資產（今日幣值）', '=IF(ABS(C22)<0.000000001,C13+G8*G6,C13*(1+C22)^G6+G8*((1+C22)^G6-1)/C22)', 'TWD', '依目前儲蓄與實質報酬估算', ''],
    ['預期壽命終點結餘（未花完遺產）', '=IFERROR(INDEX(' + sim + 'G5:G90,MATCH(C8,' + sim + 'B5:B90,0)),0)', 'TWD', '正值代表留有遺產；負值代表資金不足', ''],
    ['資產耗盡年齡', '=IFERROR(INDEX(' + sim + 'B5:B90,MATCH(1,' + sim + 'R5:R90,0))+1,"安全（不耗盡）")', '', '若提早見底將顯示耗盡年齡', ''],
    ['Die With Zero 狀態診斷', '=IF(G17<>"安全（不耗盡）","⚠️ 資金將於 "&G17&" 歲耗盡，建議調整儲蓄/開銷或退休年齡",IF(ABS(G16)<=MAX(10000,G9*0.1),"🎯 完美達成 Die With Zero 歸零目標！","💰 資產充裕：預計留下 "&TEXT(G16,"#,##0")&" 元（今日幣值），可提早退休或提高開銷"))', '', '', ''],
    ['✨ 每月最高可花金額（DWZ 反推）', '=IF(G7<=0,0,MAX(0,(G15+' + sim + 'L2)/IF(ABS(C22)<0.000000001,G7,(1-(1+C22)^(-G7))/C22))/12)', 'TWD/月', '選單可「一鍵套用此開銷」完美歸零', ''],
    ['🚀 Die With Zero 最早可退休年齡', '=IFERROR(INDEX(' + sim + 'B5:B90,MATCH(1,' + sim + 'N5:N90,0)),"尚未達標")', '歲', '允許逐年動用本金至壽命歸零', ''],
    ['🏛️ 傳統 4% FIRE 最早可退休年齡', '=IFERROR(INDEX(' + sim + 'B5:B90,MATCH(1,' + sim + 'P5:P90,0)),"尚未達標")', '歲', '本金不動、永續提領 4%', ''],
    ['⏱️ Die With Zero 可提早退休年數', '=IF(AND(ISNUMBER(G20),ISNUMBER(G21)),G21-G20,"—")', '年', 'Die With Zero 幫你省下的人生光陰', ''],
  ];
  sh.getRange(12, 6, kpiRows.length, 5).setValues(kpiRows);

  // Merge description / diagnosis nicely
  sh.getRange('G18:J18').merge().setWrap(true).setFontWeight('bold').setBackground('#FFFBEB');
  sh.setRowHeight(18, 36);
  for (let r = 12; r <= 22; r++) {
    if (r !== 18) {
      sh.getRange('I' + r + ':J' + r).merge();
    }
  }
  sh.getRange('F12:J22').setBorder(true, true, true, true, true, true, THEME.BORDER_COLOR, SpreadsheetApp.BorderStyle.SOLID);
  sh.getRange('G12:G16').setNumberFormat('#,##0').setFontWeight('bold');
  sh.getRange('G19').setNumberFormat('#,##0').setFontWeight('bold').setFontSize(12).setBackground(THEME.KPI_HIGHLIGHT_BG);
  sh.getRange('G20:G22').setNumberFormat('0').setFontWeight('bold').setBackground(THEME.KPI_BG);

  // Embed Native Google Sheets Asset Trajectory Chart below row 26
  const chart = sh.newChart()
    .setChartType(Charts.ChartType.LINE)
    .addRange(simSheet.getRange('B4:B60')) // Age X-axis
    .addRange(simSheet.getRange('G4:H60')) // Actual DWZ vs Ideal Zero Curve
    .addRange(simSheet.getRange('O4:O60')) // Classic 4% FIRE Target Line
    .setPosition(27, 1, 10, 10)
    .setOption('title', '資產走勢模擬：Die With Zero 實際路徑 vs 理想歸零曲線 vs 傳統 4% FIRE 目標（今日幣值）')
    .setOption('hAxis', { title: '年齡（歲）' })
    .setOption('vAxis', { title: '淨資產（TWD，今日幣值）', format: 'short' })
    .setOption('legend', { position: 'top' })
    .setOption('curveType', 'function')
    .setOption('width', 980)
    .setOption('height', 380)
    .setOption('series', {
      0: { color: '#2563EB', lineWidth: 3 },
      1: { color: '#10B981', lineWidth: 2, lineDashStyle: [6, 3] },
      2: { color: '#F59E0B', lineWidth: 2, lineDashStyle: [2, 2] },
    })
    .build();
  sh.insertChart(chart);

  sh.setColumnWidth(1, 210);
  sh.setColumnWidth(2, 16);
  sh.setColumnWidth(3, 140);
  sh.setColumnWidth(4, 240);
  sh.setColumnWidth(5, 24);
  sh.setColumnWidth(6, 240);
  sh.setColumnWidth(7, 145);
  sh.setColumnWidth(8, 70);
  sh.setColumnWidth(9, 145);
  sh.setColumnWidth(10, 145);
}

/**
 * Tab 7: 🛡️ 驗證與監控日誌 (Layer 5 SLA Telemetry & Audit Trail)
 */
function buildLogsSheet_(sh) {
  sh.setFrozenRows(5);
  sh.getRange('A1:H1').merge()
    .setValue('🛡️ AI 六層驗證與 API 穩定性/效能監控日誌（SLA 目標：成功率 ≥98%，P95 延遲 <3000ms）')
    .setBackground(THEME.PRIMARY_DARK).setFontColor(THEME.HEADER_TEXT)
    .setFontSize(13).setFontWeight('bold').setVerticalAlignment('middle');
  sh.setRowHeight(1, 34);

  sh.getRange('A3:H3').setValues([[
    '總執行次數', '=COUNTA(A6:A5000)',
    '成功率 (%)', '=IF(B3>0,COUNTIF(D6:D5000,"OK")/B3,1)',
    '平均延遲 (ms)', '=IF(B3>0,AVERAGE(E6:E5000),0)',
    'P95 延遲 (ms)', '=IF(B3>0,PERCENTILE(E6:E5000,0.95),0)',
  ]]).setBackground(THEME.KPI_BG).setFontWeight('bold');
  sh.getRange('D3').setNumberFormat('0.00%');
  sh.getRange('F3').setNumberFormat('#,##0.0');
  sh.getRange('H3').setNumberFormat('#,##0.0');

  sh.getRange('A5:H5').setValues([['時間戳記', '模組', '操作/來源', '狀態', '耗時 (ms)', '詳細訊息', '校對有效來源數', '備註']])
    .setBackground(THEME.HEADER_BG).setFontColor(THEME.HEADER_TEXT).setFontWeight('bold');

  sh.setColumnWidth(1, 165);
  sh.setColumnWidth(2, 110);
  sh.setColumnWidth(3, 165);
  sh.setColumnWidth(4, 90);
  sh.setColumnWidth(5, 95);
  sh.setColumnWidth(6, 360);
  sh.setColumnWidth(7, 110);
  sh.setColumnWidth(8, 160);
}

/**
 * Appends a structured telemetry record to the audit log sheet (sanitized against formula injection).
 */
function appendAuditLog_(ss, moduleName, action, status, latencyMs, message, validSources, note) {
  try {
    const sh = ss.getSheetByName(APP_CONFIG.SHEETS.LOGS);
    if (!sh) return;
    const nowStr = Utilities.formatDate(new Date(), APP_CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm:ss');
    sh.appendRow([
      nowStr,
      sanitizeSheetText(moduleName),
      sanitizeSheetText(action),
      sanitizeSheetText(status),
      Number(latencyMs || 0),
      sanitizeSheetText(message),
      validSources !== undefined ? validSources : '',
      sanitizeSheetText(note || ''),
    ]);
  } catch (e) {
    // Logging must never crash primary workflow
  }
}
