# 🔥 Die With Zero × Portfolio Beta × 多源股價校對系統（雙平台完整版）

本專案同時提供兩套共享 100% 相同數學核心的個人財富自由與風險管理解決方案：
1. **☁️ 免費私密獨立網頁版（Cloudflare Pages ＋ Workers ＋ D1 ＋ Zero Trust ＋ 三軌零知識儲存）** — 零成本、Private GitHub Repo 不外洩 Commit History、本機自動記憶＋跨裝置零知識加密同步、免打開試算表即可用手機/電腦操作！
2. **📊 Google Drive 試算表版（Google Sheets 7 分頁 ＋ 綁定 Apps Script ＋ 仿 AlphaLab 側邊欄 ＋ `.xlsx` 範本）** — 原生支援 `=GOOGLEFINANCE()` 與自訂試算表公式。

---

## 核心功能（雙平台 100% 完整對齊）

1. **對齊 [`alphalab.site/fire`](https://www.alphalab.site/fire) 的 Die With Zero（死前財產歸零）計算機**：
   - 「還在工作 / 已經退休」模式切換、台灣內政部簡易生命表保守壽命參考。
   - **Fisher 實質報酬率**（所有數字以今日實際購買力呈現）、DWZ 退休目標與今日退休門檻、**反推每月最高可花金額**、DWZ vs 傳統 4% FIRE 最早退休年齡對比與一鍵套用。
2. **自訂股票持倉與整體 Beta 計算**：
   - 內建 6 項預設 Beta：**`0050 (1)`、`006208 (1)`、`00662 (1)`、`00685L (2)`、`00631L (2)`、`CASH / 現金Cash (0)`**。
   - 支援新增任意台股（TWSE/TPEx）與美股（自動 `USD/TWD` 換算）、自訂覆寫 Beta、含現金整體 Beta、純股 Beta、等效大盤曝險與大盤崩盤壓力測試。
3. **三源以上權威股價校對（今日即時 ＋ 歷史收盤 ＋ 區間追蹤）**：
   - 整合 **TWSE / TPEx 官方 API（美股 Stooq）**、**Yahoo Finance v8（未還原收盤）**、**FinMind OpenAPI**、**Fugle 富果免費官方 API / TwelveData** 及 **Google Finance（試算表原生 / GAS 橋接）**。
   - 中位數共識抗異常、強制 `≥3` 來源檢核、自動偵測離群來源（Outlier）與 D1 永久歷史快取。
4. **私密且免重打持倉儲存（網頁版三軌 `StorageAdapter`）**：
   - 預設本機 `IndexedDB` 自動保存（同裝置免重打）。
   - **模式 1（個人/親友 ≤50 人）**：Cloudflare Zero Trust Access 鎖站 ＋ Cloudflare D1 ＋ 前端 **AES-256-GCM (PBKDF2 60萬次)** 零知識加密（409 樂觀鎖衝突偵測 + 防 IDOR 隔離）。
   - **模式 2（公開多人 BYOS）**：Google Drive 非敏感權限 `drive.appdata` 同步至各使用者自有隱藏夾。
   - **模式 3**：離線 AES-256 加密檔（`.enc.json`）與安全 CSV 匯出入。

---

## 專案目錄結構

```text
BetaCalculator/
├── GEMINI.md / PROMPT.md / README.md
├── .gitignore                                 # 阻擋 .env、*.enc.json、*my_portfolio* 誤提交
├── .github/workflows/prewarm-prices.yml       # Private Repo 每日盤後 D1 預熱排程 (~22分/月)
├── packages/core/                             # 雙平台共享核心 (config / fire / beta / reconciler / crypto-vault / price-adapters)
├── web/                                       # ☁️ 免費私密 Cloudflare 網頁版
│   ├── wrangler.toml                          # Cloudflare Pages + D1 設定（零硬編碼密鑰）
│   ├── migrations/0001_init.sql               # D1 Schema (price_history_cache / user_vault / telemetry_events)
│   ├── functions/                             # Cloudflare Pages Functions API + CSP/CORS 安全中介層
│   ├── public/                                # 零框架相依 SPA 前端 (index.html / styles.css / app.js / charts.js / storage-adapters.js)
│   └── scripts/                               # sync_core.mjs / prewarm_prices.mjs / local_dev_server.mjs
├── gas/                                       # 📊 Google Drive 試算表 + Apps Script V8 版
├── dist/DieWithZero_BetaCalculator.xlsx       # 可直傳 Google Drive 開啟的 7 分頁試算表範本
├── scripts/generate_xlsx.py                   # OOXML .xlsx 生成腳本
├── tests/                                     # AI 六層驗證自動化測試 (網頁 16 項 + GAS 29 項 = 45/45 PASS)
├── docs/                                      # 架構設計、六層驗證、免費網頁與隱私儲存研究報告 (MD + HTML)
└── OUTPUT_REPORT.{md,html} / WEB_APP_DELIVERY_REPORT.{md,html}
```

---

## 快速啟動與部署

### 1. 本機 1 秒體驗免費私密網頁版（無需 `npm install`）
```bash
# 模擬 Cloudflare Access 登入 + 離線四源股價：
DEV_USER_EMAIL=you@gmail.com MOCK_QUOTES=1 node web/scripts/local_dev_server.mjs
# 瀏覽器開啟 http://127.0.0.1:8788
```

### 2. 部署網頁版至 Cloudflare Pages（保持 GitHub 為 **Private**）
```bash
# 1. 建立並遷移免費 D1 資料庫
npx wrangler d1 create betacalculator_db
npx wrangler d1 migrations apply betacalculator_db --remote --config=web/wrangler.toml

# 2. 於 Cloudflare Dashboard 連結 Private GitHub Repo（Output dir: web/public），綁定 DB，
#    並視需求於 Secrets 設定 FUGLE_API_KEY / FINMIND_TOKEN / GAS_BRIDGE_URL，
#    個人專用可於 Cloudflare Zero Trust (50人免費) 綁定網域開啟登入鎖！
```

### 3. 部署 Google Drive 試算表版
- 詳見 [OUTPUT_REPORT.md](./OUTPUT_REPORT.md) 或直接上傳 `dist/DieWithZero_BetaCalculator.xlsx` 並貼入 `gas/` 執行 `setupWorkbook`。

### 4. 執行全套 AI 六層自動化驗證（45 / 45）
```bash
node web/scripts/sync_core.mjs
node tests/run_web_verifications.mjs   # 網頁版 16/16 PASS
node tests/run_all_verifications.mjs   # Google Drive 版 29/29 PASS
```
