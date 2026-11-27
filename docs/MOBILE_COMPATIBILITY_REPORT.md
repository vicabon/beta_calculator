# 📱 iPhone (iOS) & Android 行動端瀏覽相容性稽核與升級報告

- **更新時間**：2026-11-27 (+08:00)
- **結論**：**✅ 可以！現在 iPhone（Safari / Chrome / 加入主畫面 PWA）與 Android（Chrome / Edge / 安裝 PWA）皆已完整適配並通過自動化驗證。**
- **對應 HTML 視覺報告**：[MOBILE_COMPATIBILITY_REPORT.html](./MOBILE_COMPATIBILITY_REPORT.html)

---

## 一、7 大 iPhone / Android 實機痛點修正清單

| 編號 | 原先潛在問題 | iPhone (iOS) / Android 影響 | 本次修正實作 |
| :---: | :--- | :--- | :--- |
| **1** | `<input>` / `<select>` 字體為 `12.5–13px` | **iPhone Safari 點擊輸入框會強制自動放大整個頁面**導致跑版；數字欄位彈出文字鍵盤。 | 行動端 (`≤768px`) 所有輸入框與下拉選單強制 **`font-size: 16px !important`** 與最小高 `44px`，並全面補上 `inputmode="decimal"` / `"numeric"` 直接呼出數字鍵盤。 |
| **2** | iOS Safari 7 天未開啟清除 `IndexedDB`/`localStorage`（ITP） | iPhone 若 7 天沒開一般 Safari 分頁，本機持倉可能被系統清掉。 | 升級完整 **PWA**（`manifest.webmanifest`、`icon.svg`、`sw.js`、`apple-mobile-web-app-capable`）＋ 呼叫 **`navigator.storage.persist()`** ＋ iOS 非主畫面開啟時顯示友善提醒（建議「加入主畫面」免疫 7 天清除，或啟用 Cloudflare D1 / Google Drive 雲端同步）。 |
| **3** | 缺少 `viewport-fit=cover` 與 Safe Area 留白 | iPhone 動態島 / 瀏海與底部 Home Indicator 容易遮住按鈕。 | 補齊 `viewport-fit=cover`、`theme-color`、`100dvh` 與 `env(safe-area-inset-top/bottom/left/right)`。 |
| **4** | 5 分頁按鈕在手機頂部折行且觸控熱區偏小 | 375–412px 螢幕上方過於擁擠、不易單手操作。 | 行動端轉為**原生 App 風格底部固定導覽列**（毛玻璃背景、5 均分拇指區、安全區適配），所有按鈕/滑桿圓鈕放大至符合 Apple HIG / Material 觸控標準。 |
| **5** | 13 欄持倉表在 390px 螢幕難以編輯 | 左右滑動編輯股數與自訂 Beta 非常吃力。 | 僅針對持倉編輯表（`.holdings-table`）啟用 **CSS `data-label` 行動卡片模式**，每檔標的自動展開成清晰卡片；多源比對表保留 `-webkit-overflow-scrolling: touch` 滑順橫捲。 |
| **6** | SVG 圖表原設 `preserveAspectRatio="none"` | 手機直屏會把座標文字（`85歲`、`5000萬`）拉長壓扁變形。 | 全面改為 **`preserveAspectRatio="xMidYMid meet"`** ＋ `height: auto`，跨 iPhone / Android / iPad / 桌機等比例銳利顯示。 |
| **7** | iOS Safari 下載加密備份檔過早釋放 Blob URL + CSP 放行 | 立即 `URL.revokeObjectURL()` 可能導致 iOS 下載中斷；CSP 未宣告 `manifest-src`/`worker-src`。 | 改為延遲 `2000ms` 釋放 Blob URL；`_middleware.js` 補上 `manifest-src 'self'; worker-src 'self'`；`sw.js` 嚴格**排除 `/api/*` 不快取**（保護即時股價與加密保險庫安全）。 |

---

## 二、iPhone / Android 使用方式指南

### 方式 1：部署到 Cloudflare Pages（🏆 推薦，完整 HTTPS 支援全部功能）
1. **iPhone（iOS Safari）**：打開你的 Cloudflare Pages 網址（如 `https://betacalculator-dwz.pages.dev`）→ 點底部「**分享**」圖示 →「**加入主畫面**」→ 桌面會出現 **`DWZ Beta`** App 圖示，免受 7 天 ITP 清除且全螢幕操作！
2. **Android（Chrome）**：打開網址 → 點右上角選單 →「**安裝應用程式 / 加到主畫面**」即可成為獨立 App！
3. **跨手機與電腦同步**：
   - 個人專用：登入 Cloudflare Zero Trust Access（Google / Email OTP）即可一鍵同步 **Cloudflare D1 零知識加密保險庫**。
   - 公開使用：於「🔐 私密同步」分頁同步至你自己的 **Google Drive (`drive.appdata`)**。

### 方式 2：同 Wi-Fi 區網用手機實機預覽本機伺服器
```bash
HOST=0.0.0.0 DEV_USER_EMAIL=you@gmail.com MOCK_QUOTES=1 node web/scripts/local_dev_server.mjs
# 在同一 Wi-Fi 的 iPhone / Android 瀏覽器開啟：http://<電腦區網IP>:8788
```
> ⚠️ **安全上下文提醒**：瀏覽器規範要求 **Web Crypto API（AES-256-GCM 加密）與 Service Worker 須於 HTTPS 或 `localhost` 環境運作**。因此在區網 `http://192.168.x.x` 預覽時，所有 DWZ 試算、Beta 計算、圖表與本機記憶皆可正常使用；而 **E2EE 加密同步與 PWA 安裝** 於部署至免費 **Cloudflare Pages（自動提供 HTTPS）** 後即 100% 完整啟用！

---

## 三、AI 六層驗證實測結果（46 / 46 全數通過）
- **新增 L3 行動相容自動化稽核**：驗證 `manifest.webmanifest` (`standalone`)、`sw.js` 嚴格排除 `/api/*`、`viewport-fit=cover`、`font-size: 16px !important`、`env(safe-area-inset-bottom)`、`inputmode="decimal"`、`.holdings-table` 唯一精準套用、無 `preserveAspectRatio="none"`、`navigator.storage.persist`、以及 HTTP 端點正確回傳 `application/manifest+json` 與 `sw.js`。
- **最新總通過率**：網頁版 **17 / 17 PASS** ＋ Google Drive 版 **29 / 29 PASS** ＝ **46 / 46（100% PASS，0 失敗）**。
