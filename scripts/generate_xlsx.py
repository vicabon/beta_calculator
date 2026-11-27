#!/usr/bin/env python3
"""
Zero-dependency OOXML (.xlsx) generator producing a ready-to-upload Google Drive
starter workbook (`dist/DieWithZero_BetaCalculator.xlsx`) with all 7 tabs,
styling, column widths, number formats, and exact formulas synchronized with
`gas/SheetBuilder.gs`.
"""

import os
import zipfile
from xml.sax.saxutils import escape

OUTPUT_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "dist",
    "DieWithZero_BetaCalculator.xlsx",
)

SHEETS = [
    "📊 FIRE儀表板",
    "💼 持倉與Beta",
    "🔍 多源股價校對",
    "📈 歷史股價追蹤",
    "⚙️ 預設Beta與參數",
    "📉 逐年資產模擬",
    "🛡️ 驗證與監控日誌",
]

# Style IDs in xl/styles.xml
STYLE_DEFAULT = 0
STYLE_TITLE = 1
STYLE_HEADER = 2
STYLE_SUBHEADER = 3
STYLE_INPUT = 4
STYLE_INPUT_INT = 5
STYLE_INPUT_PCT = 6
STYLE_KPI_INT = 7
STYLE_KPI_DEC = 8
STYLE_KPI_PCT = 9
STYLE_INT = 10
STYLE_DEC = 11
STYLE_PCT = 12
STYLE_DATE = 13
STYLE_HIGHLIGHT = 14
STYLE_BOLD = 15


def col_letter(col_idx: int) -> str:
    """1-based column index to Excel column letters (1->A, 27->AA)."""
    res = []
    n = col_idx
    while n > 0:
        n, rem = divmod(n - 1, 26)
        res.append(chr(65 + rem))
    return "".join(reversed(res))


def cell_ref(row: int, col: int) -> str:
    return f"{col_letter(col)}{row}"


class SheetData:
    def __init__(self, name: str):
        self.name = name
        self.rows = {}  # row -> {col: (value, style)}
        self.merges = []
        self.col_widths = {}

    def set(self, row: int, col: int, value, style: int = STYLE_DEFAULT):
        self.rows.setdefault(row, {})[col] = (value, style)

    def set_row(self, row: int, start_col: int, values, styles=None):
        for i, v in enumerate(values):
            st = styles[i] if isinstance(styles, list) else (styles if styles is not None else STYLE_DEFAULT)
            self.set(row, start_col + i, v, st)

    def merge(self, r1: int, c1: int, r2: int, c2: int):
        self.merges.append(f"{cell_ref(r1, c1)}:{cell_ref(r2, c2)}")

    def to_xml(self) -> str:
        parts = [
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
            '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
        ]
        if self.col_widths:
            parts.append("<cols>")
            for c_idx in sorted(self.col_widths.keys()):
                w = self.col_widths[c_idx]
                parts.append(f'<col min="{c_idx}" max="{c_idx}" width="{w}" customWidth="1"/>')
            parts.append("</cols>")

        parts.append("<sheetData>")
        for r_idx in sorted(self.rows.keys()):
            parts.append(f'<row r="{r_idx}">')
            for c_idx in sorted(self.rows[r_idx].keys()):
                val, st = self.rows[r_idx][c_idx]
                ref = cell_ref(r_idx, c_idx)
                s_attr = f' s="{st}"' if st else ""
                if val is None or val == "":
                    if st:
                        parts.append(f'<c r="{ref}"{s_attr}/>')
                    continue
                if isinstance(val, bool):
                    parts.append(f'<c r="{ref}" t="b"{s_attr}><v>{1 if val else 0}</v></c>')
                elif isinstance(val, (int, float)):
                    parts.append(f'<c r="{ref}"{s_attr}><v>{val}</v></c>')
                elif isinstance(val, str) and val.startswith("="):
                    formula_body = escape(val[1:])
                    parts.append(f'<c r="{ref}"{s_attr}><f>{formula_body}</f></c>')
                else:
                    txt = escape(str(val))
                    parts.append(f'<c r="{ref}" t="inlineStr"{s_attr}><is><t xml:space="preserve">{txt}</t></is></c>')
            parts.append("</row>")
        parts.append("</sheetData>")

        if self.merges:
            parts.append(f'<mergeCells count="{len(self.merges)}">')
            for m in self.merges:
                parts.append(f'<mergeCell ref="{m}"/>')
            parts.append("</mergeCells>")

        parts.append("</worksheet>")
        return "".join(parts)


def build_styles_xml() -> str:
    return """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <numFmts count="5">
    <numFmt numFmtId="164" formatCode="#,##0"/>
    <numFmt numFmtId="165" formatCode="#,##0.00"/>
    <numFmt numFmtId="166" formatCode="0.00%"/>
    <numFmt numFmtId="167" formatCode="yyyy-mm-dd"/>
    <numFmt numFmtId="168" formatCode="0.000"/>
  </numFmts>
  <fonts count="4">
    <font><sz val="10"/><name val="Noto Sans TC"/></font>
    <font><b/><sz val="13"/><color rgb="FFFFFFFF"/><name val="Noto Sans TC"/></font>
    <font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="Noto Sans TC"/></font>
    <font><b/><sz val="10"/><color rgb="FF0F172A"/><name val="Noto Sans TC"/></font>
  </fonts>
  <fills count="7">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF0F172A"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF1E293B"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFE2E8F0"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFFEF9C3"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFECFDF5"/></patternFill></fill>
  </fills>
  <borders count="2">
    <border><left/><right/><top/><bottom/><diagonal/></border>
    <border>
      <left style="thin"><color rgb="FFCBD5E1"/></left>
      <right style="thin"><color rgb="FFCBD5E1"/></right>
      <top style="thin"><color rgb="FFCBD5E1"/></top>
      <bottom style="thin"><color rgb="FFCBD5E1"/></bottom>
    </border>
  </borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="16">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
    <xf numFmtId="0" fontId="2" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"><alignment horizontal="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="3" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>
    <xf numFmtId="0" fontId="3" fillId="5" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>
    <xf numFmtId="164" fontId="3" fillId="5" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/>
    <xf numFmtId="166" fontId="3" fillId="5" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/>
    <xf numFmtId="164" fontId="3" fillId="6" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/>
    <xf numFmtId="165" fontId="3" fillId="6" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/>
    <xf numFmtId="166" fontId="3" fillId="6" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/>
    <xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/>
    <xf numFmtId="165" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/>
    <xf numFmtId="166" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/>
    <xf numFmtId="167" fontId="3" fillId="5" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/>
    <xf numFmtId="0" fontId="3" fillId="6" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>
    <xf numFmtId="0" fontId="3" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1"/>
  </cellXfs>
</styleSheet>"""


def build_all_sheets():
    dash_ref = "'📊 FIRE儀表板'!"
    port_ref = "'💼 持倉與Beta'!"
    recon_ref = "'🔍 多源股價校對'!"
    cfg_ref = "'⚙️ 預設Beta與參數'!"
    sim_ref = "'📉 逐年資產模擬'!"

    # 1. 📊 FIRE儀表板
    s_dash = SheetData(SHEETS[0])
    s_dash.col_widths = {1: 28, 2: 3, 3: 18, 4: 34, 5: 4, 6: 34, 7: 20, 8: 10, 9: 20, 10: 20}
    s_dash.set(1, 1, "🔥 財富自由 FIRE 退休試算｜Die With Zero 死前財產歸零計算機 × 投資組合 Beta", STYLE_TITLE)
    s_dash.merge(1, 1, 1, 10)
    s_dash.set(2, 1, "完全對齊 alphalab.site/fire 設計：所有試算金額皆以 Fisher 公式扣除通膨，呈現「今日實際購買力」。黃底欄位可直接編輯。")
    s_dash.merge(2, 1, 2, 10)

    s_dash.set(4, 1, "1️⃣ 關於你（About You）", STYLE_HEADER)
    s_dash.merge(4, 1, 4, 4)
    about_rows = [
        (5, "你目前的狀態", "還在工作", STYLE_INPUT, "輸入「還在工作」或「已經退休」"),
        (6, "現在幾歲", 35, STYLE_INPUT_INT, "歲"),
        (7, "想幾歲退休", 55, STYLE_INPUT_INT, "歲（已退休自動等同現在年齡）"),
        (8, "預計活到幾歲", 85, STYLE_INPUT_INT, "歲（參考台灣內政部簡易生命表保守長壽側）"),
    ]
    for r, lbl, val, st, desc in about_rows:
        s_dash.set(r, 1, lbl, STYLE_BOLD)
        s_dash.set(r, 3, val, st)
        s_dash.set(r, 4, desc)

    s_dash.set(10, 1, "2️⃣ 資產與收支（今日幣值 / TWD）", STYLE_HEADER)
    s_dash.merge(10, 1, 10, 4)
    cash_rows = [
        (11, "淨資產資料來源", "連動持倉總市值", STYLE_INPUT, "「連動持倉總市值」或「手動輸入」"),
        (12, "手動輸入淨資產", 5000000, STYLE_INPUT_INT, "僅手動模式使用"),
        (13, "實際採用淨資產", f'=IF(C11="連動持倉總市值",{port_ref}C4,C12)', STYLE_KPI_INT, "自動連動或手動淨資產"),
        (14, "每月能存 / 投入多少", 50000, STYLE_INPUT_INT, "工作期間每月投入（已退休歸 0）"),
        (15, "退休後每月開銷多少", 60000, STYLE_INPUT_INT, "今日幣值每月生活開銷"),
        (16, "退休後每月退休金（選填）", 0, STYLE_INPUT_INT, "AlphaLab 預設 0（不含勞保勞退）"),
        (17, "退休金開始領取年齡", 65, STYLE_INPUT_INT, "歲"),
    ]
    for r, lbl, val, st, desc in cash_rows:
        s_dash.set(r, 1, lbl, STYLE_BOLD)
        s_dash.set(r, 3, val, st)
        s_dash.set(r, 4, desc)

    s_dash.set(19, 1, "3️⃣ 進階假設（Advanced Assumptions）", STYLE_HEADER)
    s_dash.merge(19, 1, 19, 4)
    adv_rows = [
        (20, "預期年化投資報酬率 (名目)", 0.07, STYLE_INPUT_PCT, "分散股債組合歷史約 6-8%"),
        (21, "預期年通貨膨脹率", 0.03, STYLE_INPUT_PCT, "保守抓 3%（台灣長期約 1-2%）"),
        (22, "實質年化報酬率 (Fisher)", "=(1+C20)/(1+C21)-1", STYLE_KPI_PCT, "=(1+名目)/(1+通膨)-1"),
        (23, "傳統 FIRE 安全提領率", 0.04, STYLE_INPUT_PCT, "預設 4.0%（25 倍法則）"),
        (24, "目前持倉整體 Beta (含現金)", f"={port_ref}C5", STYLE_KPI_DEC, "自動連動「💼 持倉與Beta」"),
        (25, "Beta CAPM 參考年化報酬", f"={cfg_ref}I5+C24*{cfg_ref}I6", STYLE_PCT, "僅供參考（槓桿具波動耗損）"),
    ]
    for r, lbl, val, st, desc in adv_rows:
        s_dash.set(r, 1, lbl, STYLE_BOLD)
        s_dash.set(r, 3, val, st)
        s_dash.set(r, 4, desc)

    s_dash.set(4, 6, "📊 試算核心參數摘要", STYLE_HEADER)
    s_dash.merge(4, 6, 4, 10)
    summary_rows = [
        (5, "有效退休年齡", '=IF(C5="已經退休",C6,MAX(C6,C7))', STYLE_INT, "歲", "工作累積年數", "=MAX(0,G5-C6)", STYLE_INT),
        (6, "尚餘工作年數", "=MAX(0,G5-C6)", STYLE_INT, "年", "退休支應年數", "=MAX(0,C8-G5)", STYLE_INT),
        (7, "退休提領總年數", "=MAX(0,C8-G5)", STYLE_INT, "年", "持倉等效大盤曝險", f"={port_ref}I4", STYLE_INT),
        (8, "年度儲蓄金額", '=IF(C5="已經退休",0,C14*12)', STYLE_INT, "TWD/年", "現金配置比例", f"={port_ref}I5", STYLE_PCT),
        (9, "退休年度開銷", "=C15*12", STYLE_INT, "TWD/年", "今日股價三源一致率", f"={recon_ref}F3", STYLE_PCT),
    ]
    for r, l1, f1, st1, u1, l2, f2, st2 in summary_rows:
        s_dash.set(r, 6, l1, STYLE_BOLD)
        s_dash.set(r, 7, f1, st1)
        s_dash.set(r, 8, u1)
        s_dash.set(r, 9, l2, STYLE_BOLD)
        s_dash.set(r, 10, f2, st2)

    s_dash.set(11, 6, "🎯 Die With Zero（死前財產歸零）vs 傳統 4% FIRE 試算結果", STYLE_HEADER)
    s_dash.merge(11, 6, 11, 10)
    kpis = [
        (12, "Die With Zero 退休目標金額（退休當下）", f"={sim_ref}M2", STYLE_KPI_INT, "TWD", "退休時達此金額即可花到預期壽命歸零"),
        (13, "今日立刻退休所需 DWZ 本金", f"={sim_ref}N2", STYLE_KPI_INT, "TWD", "假設今天退休且剛好在預計壽命歸零"),
        (14, "傳統 FIRE (4% 法則) 目標金額", "=IF(C23>0,G9/C23,0)", STYLE_INT, "TWD", "本金永遠不動（年支出 ÷ 提領率）"),
        (15, "預計退休時累積淨資產（今日幣值）", "=IF(ABS(C22)<0.000000001,C13+G8*G6,C13*(1+C22)^G6+G8*((1+C22)^G6-1)/C22)", STYLE_INT, "TWD", "依目前儲蓄與實質報酬估算"),
        (16, "預期壽命終點結餘（未花完遺產）", f"=IFERROR(INDEX({sim_ref}G5:G90,MATCH(C8,{sim_ref}B5:B90,0)),0)", STYLE_KPI_INT, "TWD", "正值代表留有遺產；負值代表資金不足"),
        (17, "資產耗盡年齡", f'=IFERROR(INDEX({sim_ref}B5:B90,MATCH(1,{sim_ref}R5:R90,0))+1,"安全（不耗盡）")', STYLE_HIGHLIGHT, "", "若提早見底將顯示耗盡年齡"),
        (18, "Die With Zero 狀態診斷", '=IF(G17<>"安全（不耗盡）","⚠️ 資金將於 "&G17&" 歲耗盡，建議調整儲蓄/開銷或退休年齡",IF(ABS(G16)<=MAX(10000,G9*0.1),"🎯 完美達成 Die With Zero 歸零目標！","💰 資產充裕：預計留下 "&TEXT(G16,"#,##0")&" 元（今日幣值）"))', STYLE_HIGHLIGHT, "", ""),
        (19, "✨ 每月最高可花金額（DWZ 反推）", f"=IF(G7<=0,0,MAX(0,(G15+{sim_ref}L2)/IF(ABS(C22)<0.000000001,G7,(1-(1+C22)^(-G7))/C22))/12)", STYLE_KPI_INT, "TWD/月", "可於選單一鍵套用達成完美歸零"),
        (20, "🚀 Die With Zero 最早可退休年齡", f'=IFERROR(INDEX({sim_ref}B5:B90,MATCH(1,{sim_ref}N5:N90,0)),"尚未達標")', STYLE_KPI_INT, "歲", "允許逐年動用本金至壽命歸零"),
        (21, "🏛️ 傳統 4% FIRE 最早可退休年齡", f'=IFERROR(INDEX({sim_ref}B5:B90,MATCH(1,{sim_ref}P5:P90,0)),"尚未達標")', STYLE_INT, "歲", "本金不動、永續提領 4%"),
        (22, "⏱️ Die With Zero 可提早退休年數", '=IF(AND(ISNUMBER(G20),ISNUMBER(G21)),G21-G20,"—")', STYLE_KPI_INT, "年", "Die With Zero 幫你提早享受自由"),
    ]
    for r, lbl, form, st, unit, desc in kpis:
        s_dash.set(r, 6, lbl, STYLE_BOLD)
        s_dash.set(r, 7, form, st)
        if r == 18:
            s_dash.merge(18, 7, 18, 10)
        else:
            s_dash.set(r, 8, unit)
            s_dash.set(r, 9, desc)
            s_dash.merge(r, 9, r, 10)

    # 2. 💼 持倉與Beta
    s_port = SheetData(SHEETS[1])
    s_port.col_widths = {1: 15, 2: 10, 3: 18, 4: 16, 5: 8, 6: 16, 7: 10, 8: 16, 9: 12, 10: 15, 11: 15, 12: 12, 13: 14, 14: 18}
    s_port.set(1, 1, "💼 個人股票持倉與整體 Beta 值計算器（支援自訂持倉、預設/覆寫 Beta、美股匯率自動換算）", STYLE_TITLE)
    s_port.merge(1, 1, 1, 14)
    s_port.set(3, 1, "📌 投資組合整體風險與 Beta 總覽（自動即時連動）", STYLE_SUBHEADER)
    s_port.merge(3, 1, 3, 14)

    s_port.set_row(4, 2, [
        "總資產市值 (TWD)", "=SUM(H9:H50)", "",
        "純股票市值 (不含現金)", '=SUMIF(B9:B50,"<>CASH",H9:H50)', "",
        "等效大盤曝險 (Beta=1)", "=SUM(N9:N50)", "",
        "USD/TWD 即時匯率", f"={cfg_ref}I12",
    ], [STYLE_BOLD, STYLE_KPI_INT, 0, STYLE_BOLD, STYLE_INT, 0, STYLE_BOLD, STYLE_INT, 0, STYLE_BOLD, STYLE_DEC])
    s_port.set_row(5, 2, [
        "整體組合 Beta (含現金)", "=IF(C4>0,SUM(M9:M50),0)", "",
        "純股票部位 Beta", '=IF(F4>0,SUMIFS(N9:N50,B9:B50,"<>CASH")/F4,0)', "",
        "現金配置比例 (%)", '=IF(C4>0,SUMIF(B9:B50,"CASH",H9:H50)/C4,0)', "",
        "CAPM 參考報酬率", f"={cfg_ref}I5+C5*{cfg_ref}I6",
    ], [STYLE_BOLD, STYLE_KPI_DEC, 0, STYLE_BOLD, STYLE_DEC, 0, STYLE_BOLD, STYLE_PCT, 0, STYLE_BOLD, STYLE_PCT])

    s_port.set_row(8, 1, [
        "股票代號", "市場別", "資產名稱", "持有股數/現金金額", "幣別",
        "採用股價(共識價優先)", "匯率", "市值 (TWD)", "權重 (%)",
        "預設 Beta", "自訂覆寫 Beta", "採用 Beta", "加權 Beta 貢獻", "等效大盤曝險 (TWD)",
    ], STYLE_HEADER)

    samples = [
        ("0050", "TWSE", "元大台灣50", 10000, "TWD"),
        ("006208", "TWSE", "富邦台50", 5000, "TWD"),
        ("00662", "TWSE", "富邦NASDAQ", 5000, "TWD"),
        ("00685L", "TWSE", "群益臺灣加權正2", 3000, "TWD"),
        ("00631L", "TWSE", "元大台灣50正2", 5000, "TWD"),
        ("CASH", "CASH", "現金 Cash", 1500000, "TWD"),
    ]
    for r in range(9, 51):
        idx = r - 9
        base = samples[idx] if idx < len(samples) else ("", "", "", "", "")
        c_lkp = f'IFERROR(INDEX({recon_ref}$I$6:$I$25,MATCH(A{r},{recon_ref}$A$6:$A$25,0)),"")'
        gf_fb = f'IFERROR(GOOGLEFINANCE(IF(B{r}="US",A{r},"TPE:"&A{r}),"price"),0)'
        s_port.set_row(r, 1, [
            base[0], base[1], base[2], base[3], base[4],
            f'=IF(A{r}="","",IF(B{r}="CASH",1,IF(ISNUMBER({c_lkp}),{c_lkp},{gf_fb})))',
            f'=IF(A{r}="","",IF(E{r}="USD",{cfg_ref}$I$12,1))',
            f'=IF(A{r}="","",IF(AND(ISNUMBER(D{r}),ISNUMBER(F{r}),ISNUMBER(G{r})),D{r}*F{r}*G{r},0))',
            f'=IF(A{r}="","",IF($C$4>0,H{r}/$C$4,0))',
            f'=IF(A{r}="","",IF(B{r}="CASH",0,IFERROR(VLOOKUP(A{r},{cfg_ref}$A$5:$D$30,4,FALSE),"未預設(暫採1)")))',
            "",
            f'=IF(A{r}="","",IF(ISNUMBER(K{r}),K{r},IF(ISNUMBER(J{r}),J{r},1)))',
            f'=IF(A{r}="","",I{r}*L{r})',
            f'=IF(A{r}="","",H{r}*L{r})',
        ], [
            STYLE_INPUT, STYLE_INPUT, STYLE_INPUT, STYLE_INPUT_INT, STYLE_INPUT,
            STYLE_DEC, STYLE_DEC, STYLE_INT, STYLE_PCT,
            STYLE_DEC, STYLE_INPUT, STYLE_DEC, STYLE_DEC, STYLE_INT,
        ])

    s_port.set(52, 1, "⚡ 投資組合大盤波動壓力測試（依整體 Beta 推估）", STYLE_SUBHEADER)
    s_port.merge(52, 1, 52, 6)
    s_port.set_row(53, 1, ["情境名稱", "大盤漲跌幅", "預估組合漲跌幅", "預估損益金額 (TWD)", "衝擊後淨資產 (TWD)", "風險備註"], STYLE_HEADER)
    shocks = [
        ("極端股災 (-50%)", -0.50, "高槓桿注意波動耗損"),
        ("深度熊市 (-30%)", -0.30, "檢視現金緩衝是否足夠 2-3 年"),
        ("技術熊市 (-20%)", -0.20, "常見熊市回檔幅度"),
        ("健康回檔 (-10%)", -0.10, "正常年度波動區間"),
        ("溫和上漲 (+15%)", 0.15, "偏多年度情景"),
        ("多頭強漲 (+30%)", 0.30, "強勢多頭情景"),
    ]
    for i, (lbl, mv, note) in enumerate(shocks):
        rr = 54 + i
        s_port.set_row(rr, 1, [lbl, mv, f"=MAX(-1,B{rr}*$C$5)", f"=$C$4*C{rr}", f"=MAX(0,$C$4+D{rr})", note],
                       [STYLE_BOLD, STYLE_PCT, STYLE_PCT, STYLE_INT, STYLE_INT, STYLE_DEFAULT])

    # 3. 🔍 多源股價校對
    s_recon = SheetData(SHEETS[2])
    s_recon.col_widths = {i: 15 for i in range(1, 15)}
    s_recon.col_widths[12] = 19
    s_recon.col_widths[13] = 20
    s_recon.col_widths[14] = 20
    s_recon.set(1, 1, "🔍 三源以上權威股價校對中心（Google Finance × Yahoo Finance v8 × TWSE/TPEx/Stooq × FinMind）", STYLE_TITLE)
    s_recon.merge(1, 1, 1, 14)
    s_recon.set(3, 1, "📅 歷史收盤校對目標日期：", STYLE_BOLD)
    s_recon.merge(3, 1, 3, 2)
    s_recon.set(3, 3, "=WORKDAY(TODAY(),-5)", STYLE_DATE)
    s_recon.set(3, 5, "今日三源一致率：", STYLE_BOLD)
    s_recon.set(3, 6, '=IF(COUNTA(A6:A25)>0,COUNTIF(L6:L25,"✅*")/COUNTA(A6:A25),0)', STYLE_KPI_PCT)
    s_recon.set(3, 8, "歷史三源精準率：", STYLE_BOLD)
    s_recon.set(3, 9, '=IF(COUNTA(A30:A49)>0,COUNTIF(L30:L49,"✅*")/COUNTA(A30:A49),0)', STYLE_KPI_PCT)

    s_recon.set(4, 1, "一、今日 / 目前股價四源校對表", STYLE_SUBHEADER)
    s_recon.merge(4, 1, 4, 14)
    recon_headers = [
        "股票代號", "市場別", "名稱", "來源1 GoogleFinance", "來源2 YahooFinance",
        "來源3 TWSE/TPEx/Stooq", "來源4 FinMind", "有效來源數", "共識價(中位數)",
        "最大價差", "最大價差率", "校對狀態", "離群來源偵測", "交易日/更新時間",
    ]
    s_recon.set_row(5, 1, recon_headers, STYLE_HEADER)
    for i in range(20):
        r = 6 + i
        pr = 9 + i
        gf_live = f'=IF(A{r}="","",IF(B{r}="CASH",1,IFERROR(GOOGLEFINANCE(IF(B{r}="US",A{r},"TPE:"&A{r}),"price"),"N/A")))'
        st_live = f'=IF(A{r}="","",IF(B{r}="CASH","✅ 現金固定值",IF(H{r}=0,"❌ 無報價",IF(H{r}<{cfg_ref}$I$11,"⚠️ 來源不足("&H{r}&"/3)",IF(K{r}<={cfg_ref}$I$7,"✅ 三源一致",IF(K{r}<={cfg_ref}$I$8,"⚠️ 延遲/輕微價差","🚨 異常價差警示"))))))'
        s_recon.set_row(r, 1, [
            f'=IF({port_ref}A{pr}="","",{port_ref}A{pr})',
            f'=IF(A{r}="","",{port_ref}B{pr})',
            f'=IF(A{r}="","",{port_ref}C{pr})',
            gf_live, "", "", "",
            f'=IF(A{r}="","",COUNT(D{r}:G{r}))',
            f'=IF(A{r}="","",IF(H{r}>0,MEDIAN(D{r}:G{r}),""))',
            f'=IF(A{r}="","",IF(H{r}>=2,MAX(D{r}:G{r})-MIN(D{r}:G{r}),0))',
            f'=IF(A{r}="","",IF(AND(H{r}>=2,ISNUMBER(I{r}),I{r}>0),J{r}/I{r},0))',
            st_live, "", "",
        ], [STYLE_DEFAULT, STYLE_DEFAULT, STYLE_DEFAULT, STYLE_DEC, STYLE_DEC, STYLE_DEC, STYLE_DEC, STYLE_INT, STYLE_KPI_DEC, STYLE_DEC, STYLE_PCT, STYLE_DEFAULT, STYLE_DEFAULT, STYLE_DEFAULT])

    s_recon.set(28, 1, "二、指定歷史日期收盤價四源校對表（目標日期見 C3，統一採未還原收盤價）", STYLE_SUBHEADER)
    s_recon.merge(28, 1, 28, 14)
    s_recon.set_row(29, 1, recon_headers, STYLE_HEADER)
    for i in range(20):
        r = 30 + i
        pr = 9 + i
        sym_expr = f'IF(B{r}="US",A{r},"TPE:"&A{r})'
        gf_hist = f'=IF(A{r}="","",IF(B{r}="CASH",1,IFERROR(INDEX(QUERY(GOOGLEFINANCE({sym_expr},"close",$C$3-10,$C$3+1),"select Col2 where Col1 < date \'"&TEXT($C$3+1,"yyyy-mm-dd")&"\' order by Col1 desc limit 1",1),2,1),"N/A")))'
        st_hist = f'=IF(A{r}="","",IF(B{r}="CASH","✅ 現金固定值",IF(H{r}=0,"❌ 無報價",IF(H{r}<{cfg_ref}$I$11,"⚠️ 來源不足("&H{r}&"/3)",IF(OR(K{r}<={cfg_ref}$I$9,J{r}<=0.05),"✅ 三源精準一致",IF(K{r}<={cfg_ref}$I$10,"⚠️ 輕微差異","🚨 異常價差警示"))))))'
        s_recon.set_row(r, 1, [
            f'=IF({port_ref}A{pr}="","",{port_ref}A{pr})',
            f'=IF(A{r}="","",{port_ref}B{pr})',
            f'=IF(A{r}="","",{port_ref}C{pr})',
            gf_hist, "", "", "",
            f'=IF(A{r}="","",COUNT(D{r}:G{r}))',
            f'=IF(A{r}="","",IF(H{r}>0,MEDIAN(D{r}:G{r}),""))',
            f'=IF(A{r}="","",IF(H{r}>=2,MAX(D{r}:G{r})-MIN(D{r}:G{r}),0))',
            f'=IF(A{r}="","",IF(AND(H{r}>=2,ISNUMBER(I{r}),I{r}>0),J{r}/I{r},0))',
            st_hist, "", "",
        ], [STYLE_DEFAULT, STYLE_DEFAULT, STYLE_DEFAULT, STYLE_DEC, STYLE_DEC, STYLE_DEC, STYLE_DEC, STYLE_INT, STYLE_KPI_DEC, STYLE_DEC, STYLE_PCT, STYLE_DEFAULT, STYLE_DEFAULT, STYLE_DEFAULT])

    # 4. 📈 歷史股價追蹤
    s_hist = SheetData(SHEETS[3])
    s_hist.col_widths = {i: 15 for i in range(1, 14)}
    s_hist.set(1, 1, "📈 區間歷史收盤價多源追蹤與逐日比對報表", STYLE_TITLE)
    s_hist.merge(1, 1, 1, 13)
    s_hist.set_row(3, 1, ["追蹤代號", "市場別", "起始日期", "結束日期", "總交易日數", "三源精準日數", "異常日數", "操作提示"], STYLE_SUBHEADER)
    s_hist.set_row(4, 1, [
        "0050", "TWSE", "=WORKDAY(TODAY(),-22)", "=TODAY()",
        "=COUNTA(A7:A500)", '=COUNTIF(L7:L500,"✅*")', '=COUNTIF(L7:L500,"🚨*")',
        "附加 Apps Script 後從選單執行追蹤",
    ], [STYLE_INPUT, STYLE_INPUT, STYLE_DATE, STYLE_DATE, STYLE_INT, STYLE_KPI_INT, STYLE_INT, STYLE_DEFAULT])
    s_hist.set_row(6, 1, [
        "交易日期", "代號", "市場別", "來源1 GoogleFinance", "來源2 YahooFinance",
        "來源3 TWSE/TPEx/Stooq", "來源4 FinMind", "有效來源數", "共識收盤價",
        "最大價差率", "狀態碼", "校對狀態", "離群來源",
    ], STYLE_HEADER)

    # 5. ⚙️ 預設Beta與參數
    s_cfg = SheetData(SHEETS[4])
    s_cfg.col_widths = {1: 14, 2: 10, 3: 18, 4: 13, 5: 10, 6: 34, 7: 4, 8: 28, 9: 15, 10: 30}
    s_cfg.set(1, 1, "⚙️ 預設 Beta 對照表與系統校對參數設定", STYLE_TITLE)
    s_cfg.merge(1, 1, 1, 10)
    s_cfg.set(3, 1, "一、預設股票 Beta 對照表（可自由新增或修改）", STYLE_SUBHEADER)
    s_cfg.merge(3, 1, 3, 6)
    s_cfg.set_row(4, 1, ["股票代號", "市場別", "資產名稱", "預設 Beta", "幣別", "說明"], STYLE_HEADER)
    presets = [
        ("0050", "TWSE", "元大台灣50", 1, "TWD", "台灣市值型 ETF (預設 Beta=1)"),
        ("006208", "TWSE", "富邦台50", 1, "TWD", "台灣市值型 ETF (預設 Beta=1)"),
        ("00662", "TWSE", "富邦NASDAQ", 1, "TWD", "美國那斯達克100 ETF (預設 Beta=1)"),
        ("00685L", "TWSE", "群益臺灣加權正2", 2, "TWD", "台股單日正向2倍槓桿 ETF (預設 Beta=2)"),
        ("00631L", "TWSE", "元大台灣50正2", 2, "TWD", "台灣50單日正向2倍槓桿 ETF (預設 Beta=2)"),
        ("CASH", "CASH", "現金 Cash", 0, "TWD", "現金 / 活定存無風險部位 (預設 Beta=0)"),
    ]
    for i, row in enumerate(presets):
        s_cfg.set_row(5 + i, 1, list(row), [STYLE_DEFAULT, STYLE_DEFAULT, STYLE_DEFAULT, STYLE_INPUT, STYLE_DEFAULT, STYLE_DEFAULT])

    s_cfg.set(3, 8, "二、系統校對容差與 CAPM 參數", STYLE_SUBHEADER)
    s_cfg.merge(3, 8, 3, 10)
    s_cfg.set_row(4, 8, ["參數項目", "設定值", "說明"], STYLE_HEADER)
    params = [
        ("CAPM 無風險利率 (Rf)", 0.015, STYLE_INPUT_PCT, "僅供 Beta 參考報酬估算"),
        ("CAPM 市場風險溢酬 (ERP)", 0.055, STYLE_INPUT_PCT, "Beta=1 時 Rf+ERP = 7.0%"),
        ("今日即時校對一致容差", 0.005, STYLE_INPUT_PCT, "涵蓋 Google Finance 延遲"),
        ("今日即時校對異常門檻", 0.02, STYLE_INPUT_PCT, "超過即標記異常價差"),
        ("歷史收盤精準一致容差", 0.001, STYLE_INPUT_PCT, "0.1% 或 0.05 元以內一致"),
        ("歷史收盤異常警示門檻", 0.01, STYLE_INPUT_PCT, "超過即偵測離群來源"),
        ("最低有效來源數要求", 3, STYLE_INPUT_INT, "強制要求 ≥3 權威來源"),
        ("即時匯率 (USD/TWD)", '=IFERROR(GOOGLEFINANCE("CURRENCY:USDTWD"),32.0)', STYLE_DEC, "美股持倉自動換算台幣"),
    ]
    for i, (k, v, st, note) in enumerate(params):
        s_cfg.set_row(5 + i, 8, [k, v, note], [STYLE_BOLD, st, STYLE_DEFAULT])

    # 6. 📉 逐年資產模擬
    s_sim = SheetData(SHEETS[5])
    s_sim.col_widths = {i: 15 for i in range(1, 19)}
    s_sim.set(1, 1, "📉 逐年資產軌跡模擬表（今日實質幣值 × 理想歸零曲線 × 4% FIRE 對照）", STYLE_TITLE)
    s_sim.merge(1, 1, 1, 18)
    s_sim.set_row(2, 10, ["輔助彙總：", "退休金折現總值 =>", "=SUM(K5:K90)", "=SUM(J5:J90)", "=SUM(L5:L90)"], [STYLE_BOLD, STYLE_BOLD, STYLE_INT, STYLE_INT, STYLE_INT])
    s_sim.set_row(4, 1, [
        "年序", "年齡", "階段", "期初資產(今日幣值)", "實質投資收益", "年度淨現金流",
        "實際路徑資產(今日幣值)", "理想歸零曲線", "持續工作資產", "退休期淨支出折現",
        "退休金折現", "今日起淨支出折現", "該歲立即退休DWZ門檻", "達標DWZ",
        "傳統4% FIRE目標線", "達標FIRE", "名目資產(含通膨)", "耗盡標記",
    ], STYLE_HEADER)

    for yr in range(86):
        r = 5 + yr
        first = yr == 0
        prev_h = f"{dash_ref}$C$13" if first else f"H{r-1}"
        s_sim.set_row(r, 1, [
            f'=IF(ROW()-5<={dash_ref}$C$8-{dash_ref}$C$6,ROW()-5,"")',
            f'=IF(A{r}="","",{dash_ref}$C$6+A{r})',
            f'=IF(A{r}="","",IF(B{r}={dash_ref}$C$8,"預期壽命終點",IF(B{r}<{dash_ref}$G$5,"工作累積期","退休提領期")))',
            f"={dash_ref}$C$13" if first else f'=IF(A{r}="","",G{r-1})',
            f'=IF(A{r}="","",IF(B{r}={dash_ref}$C$8,0,D{r}*{dash_ref}$C$22))',
            f'=IF(A{r}="","",IF(B{r}={dash_ref}$C$8,0,IF(B{r}<{dash_ref}$G$5,{dash_ref}$G$8,-({dash_ref}$G$9-IF(B{r}>={dash_ref}$C$17,{dash_ref}$C$16*12,0)))))',
            f'=IF(A{r}="","",IF(B{r}={dash_ref}$C$8,D{r},D{r}+E{r}+F{r}))',
            f'=IF(A{r}="","",IF(B{r}={dash_ref}$C$8,{prev_h},IF(B{r}<{dash_ref}$G$5,{prev_h}*(1+{dash_ref}$C$22)+{dash_ref}$G$8,{prev_h}*(1+{dash_ref}$C$22)-({dash_ref}$G$19*12-IF(B{r}>={dash_ref}$C$17,{dash_ref}$C$16*12,0)))))',
            f"={dash_ref}$C$13" if first else f'=IF(A{r}="","",I{r-1}*(1+{dash_ref}$C$22)+{dash_ref}$G$8)',
            f'=IF(A{r}="","",IF(AND(B{r}>={dash_ref}$G$5,B{r}<{dash_ref}$C$8),MAX(0,{dash_ref}$G$9-IF(B{r}>={dash_ref}$C$17,{dash_ref}$C$16*12,0))/(1+{dash_ref}$C$22)^(B{r}-{dash_ref}$G$5+1),0))',
            f'=IF(A{r}="","",IF(AND(B{r}>={dash_ref}$G$5,B{r}<{dash_ref}$C$8),IF(B{r}>={dash_ref}$C$17,{dash_ref}$C$16*12,0)/(1+{dash_ref}$C$22)^(B{r}-{dash_ref}$G$5+1),0))',
            f'=IF(A{r}="","",IF(B{r}<{dash_ref}$C$8,MAX(0,{dash_ref}$G$9-IF(B{r}>={dash_ref}$C$17,{dash_ref}$C$16*12,0))/(1+{dash_ref}$C$22)^(B{r}-{dash_ref}$C$6+1),0))',
            f'=IF(A{r}="","",SUM(L{r}:$L$90)*(1+{dash_ref}$C$22)^(B{r}-{dash_ref}$C$6))',
            f'=IF(A{r}="","",IF(I{r}>=M{r}-0.01,1,0))',
            f'=IF(A{r}="","",{dash_ref}$G$14)',
            f'=IF(A{r}="","",IF(I{r}>=O{r}-0.01,1,0))',
            f'=IF(A{r}="","",G{r}*(1+{dash_ref}$C$21)^A{r})',
            f'=IF(A{r}="","",IF(G{r}<-0.01,1,0))',
        ], [STYLE_INT, STYLE_INT, STYLE_DEFAULT, STYLE_INT, STYLE_INT, STYLE_INT, STYLE_INT, STYLE_INT, STYLE_INT, STYLE_INT, STYLE_INT, STYLE_INT, STYLE_INT, STYLE_INT, STYLE_INT, STYLE_INT, STYLE_INT, STYLE_INT])

    # 7. 🛡️ 驗證與監控日誌
    s_log = SheetData(SHEETS[6])
    s_log.col_widths = {1: 22, 2: 14, 3: 20, 4: 10, 5: 12, 6: 44, 7: 14, 8: 20}
    s_log.set(1, 1, "🛡️ AI 六層驗證與 API 穩定性/效能監控日誌（SLA 目標：成功率 ≥98%，P95 延遲 <3000ms）", STYLE_TITLE)
    s_log.merge(1, 1, 1, 8)
    s_log.set_row(3, 1, [
        "總執行次數", "=COUNTA(A6:A5000)", "成功率 (%)", '=IF(B3>0,COUNTIF(D6:D5000,"OK")/B3,1)',
        "平均延遲 (ms)", "=IF(B3>0,AVERAGE(E6:E5000),0)", "P95 延遲 (ms)", "=IF(B3>0,PERCENTILE(E6:E5000,0.95),0)",
    ], [STYLE_BOLD, STYLE_INT, STYLE_BOLD, STYLE_KPI_PCT, STYLE_BOLD, STYLE_DEC, STYLE_BOLD, STYLE_DEC])
    s_log.set_row(5, 1, ["時間戳記", "模組", "操作/來源", "狀態", "耗時 (ms)", "詳細訊息", "有效來源數", "備註"], STYLE_HEADER)

    return [s_dash, s_port, s_recon, s_hist, s_cfg, s_sim, s_log]


def write_xlsx(output_path: str):
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    sheet_objs = build_all_sheets()

    content_types = [
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
        '<Default Extension="xml" ContentType="application/xml"/>',
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>',
    ]
    for i in range(1, len(sheet_objs) + 1):
        content_types.append(
            f'<Override PartName="/xl/worksheets/sheet{i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        )
    content_types.append("</Types>")

    root_rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
        "</Relationships>"
    )

    wb_sheets = []
    wb_rels = [
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    ]
    for idx, sh in enumerate(sheet_objs, start=1):
        wb_sheets.append(f'<sheet name="{escape(sh.name)}" sheetId="{idx}" r:id="rId{idx}"/>')
        wb_rels.append(
            f'<Relationship Id="rId{idx}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet{idx}.xml"/>'
        )
    wb_rels.append(
        f'<Relationship Id="rId{len(sheet_objs)+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
    )
    wb_rels.append("</Relationships>")

    workbook_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        "<sheets>" + "".join(wb_sheets) + "</sheets></workbook>"
    )

    with zipfile.ZipFile(output_path, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("[Content_Types].xml", "".join(content_types))
        zf.writestr("_rels/.rels", root_rels)
        zf.writestr("xl/workbook.xml", workbook_xml)
        zf.writestr("xl/_rels/workbook.xml.rels", "".join(wb_rels))
        zf.writestr("xl/styles.xml", build_styles_xml())
        for idx, sh in enumerate(sheet_objs, start=1):
            zf.writestr(f"xl/worksheets/sheet{idx}.xml", sh.to_xml())

    print(f"Generated {output_path} ({os.path.getsize(output_path)} bytes, {len(sheet_objs)} sheets)")


if __name__ == "__main__":
    write_xlsx(OUTPUT_PATH)
