# 資產負債看板（Asset & Liability Dashboard）

個人資產負債總覽網頁 App，專為手機（iPhone Safari）瀏覽設計，資料完全儲存於瀏覽器本地（IndexedDB），不上傳至任何伺服器。

## 技術架構

- 純 HTML + CSS + JavaScript，**不需 npm / build 工具**
- [Vue 3](https://vuejs.org/)（CDN 全域版本，`vue.global.prod.js`）
- [PapaParse](https://www.papaparse.com/)（CDN，處理 CSV 匯入/匯出）
- 資料儲存：瀏覽器 IndexedDB（資料庫名稱 `my_asset_dashboard`，見 `js/db.js`）
- 部署：GitHub Pages（純靜態檔案）

選擇免 build 方案的原因：避免本機/公司網路環境的憑證與套件安裝限制，同時降低維護成本（無需 `npm install`、無版本相依問題）。

> **修改 `js/*.js` 後必讀**：`index.html` 以 `<script src="js/xxx.js?v=版本號">` 引入本地程式檔，
> 每次修改 `js/store.js`、`js/db.js`、`js/services.js`、`js/app.js` 任何內容後，
> **務必同步更新這 4 個 `<script>` 標籤的 `?v=` 版本號**（比照 CDN 的 `?cb=` 慣例），
> 否則瀏覽器（尤其手機 Safari）或 GitHub Pages 邊緣 CDN 可能沿用舊版快取，
> 導致「畫面（HTML）已更新、但實際執行邏輯仍是舊版」的不一致現象（例如設定頁選項已改變，
> 但實際查詢行為看起來像沒套用新設定）。若懷疑遇到此情形，可請使用者先強制重新整理
> （iOS Safari：長按重新整理鈕選「重新載入無快取內容的網頁」）排除快取因素再回報問題。

## 本地開發/預覽

任何靜態檔案伺服器皆可，例如：

```powershell
# Python
python -m http.server 8765

# 或使用 VS Code 的 Live Server 擴充功能
```

開啟瀏覽器至 `http://localhost:8765`。

> 不可直接用 `file://` 開啟 `index.html`，部分瀏覽器會擋下模組化的 fetch/CSV 檔案操作，請務必透過本地伺服器預覽。

## 功能總覽

4 個分頁（畫面下方圓角分頁列切換）：

| 分頁 | 內容 |
|------|------|
| 總覽 | 資產／負債／淨資產 KPI、負債比、各資產子項目金額與佔比條 |
| 再平衡 | 曝險金額／曝險比、資金再平衡率設定、買入/賣出建議金額 |
| 明細 | 分類彙總、逐筆資料表格（新增/編輯/刪除）、CSV 匯入/匯出 |
| 設定 | 子分頁：系統（顯示單位、股價資料來源）／帳戶（幣別、資產類別、帳戶項目）／備份（CSV 匯出入、清除本地資料） |

### 資料欄位（明細）

類型、帳戶/項目、日期、備註、單價、幣別、匯率、單位數、金額、槓桿率（曝險金額為計算欄位）。

### 即時資料來源（選用，預設多數為手動輸入）

- **匯率**：[open.er-api.com](https://www.exchangerate-api.com/)（免費、支援瀏覽器 CORS、無需 API Key）
- **股價**：於「設定 > 股價資料來源」可分別為**台股**與**美股**選擇 provider：

  | 市場 | Provider | 是否需 proxy | 是否需申請 Key | 說明 |
  |------|----------|:---:|:---:|------|
  | 台股（預設） | TWSE OpenAPI | 否 | 否 | 官方開放資料，原生支援 CORS；為當日週期性快照，非逐筆即時 |
  | 台股 | Yahoo Finance | 是 | 否 | 經 CORS proxy 轉發，準即時，屬非官方管道 |
  | 美股（預設） | 手動輸入 | - | - | 需自行申請 Finnhub Key 才能改用自動查詢 |
  | 美股 | Finnhub | 否 | 是（免費註冊） | 原生支援 CORS，免費層限每分鐘 60 次查詢 |
  | 美股/台股 | 手動輸入 | - | - | 完全略過該市場的自動查詢 |

  選擇 Yahoo Finance 時，另需於「CORS Proxy 提供者」選擇轉發服務：`corsproxy.io`、`api.allorigins.win`、
  `thingproxy.freeboard.io`（皆為第三方免費服務，可能隨時限流或關閉，穩定性無法保證），或填入「自訂 Proxy URL」
  使用自建的 proxy（例如自建 Cloudflare Workers，見 [`docs/cloudflare-worker-proxy-佈建手冊.md`](docs/cloudflare-worker-proxy-佈建手冊.md)）。

  > **已知現況**：`corsproxy.io` 目前已改為需付費 API Key，匿名用法會回應 `401 A valid API key is required`。
  > 若查詢持續失敗，請優先改選 `thingproxy.freeboard.io` 或 `api.allorigins.win`，或改用免 proxy 的
  > `TWSE OpenAPI`（台股）/ `Finnhub`（美股）選項。

於「帳戶」頁可按「同步匯率」「同步價格」按鈕依上述設定一次更新，查詢失敗時請改回手動輸入。

## 部署到 GitHub Pages

1. 建立 GitHub repo（public，免費方案 GitHub Pages 僅支援 public repo）
2. 將本目錄內容 push 到該 repo 的 `main` 分支
3. Repo → Settings → Pages → Source 選擇 `main` branch / `root`
4. 幾分鐘後即可透過 `https://<username>.github.io/<repo>/` 存取

## 資料備份與風險提醒

所有資料僅存在單一瀏覽器的 IndexedDB（資料庫 `my_asset_dashboard`，四個 object store：`records`、`settings`、`accounts`、`syncLogs`）：

- 清除瀏覽器資料、換裝置、換瀏覽器（含 Safari 無痕模式）都會遺失資料
- **請定期使用「明細」頁的「匯出 CSV」與「帳戶/項目設定」頁的「匯出帳戶設定」功能備份**
- `syncLogs`（同步記錄）為選用性除錯資訊，需於「設定 > 帳戶」的「同步記錄」開關手動開啟才會寫入，
  僅保留最近 50 筆，可另外「匯出記錄（JSON）」或「清除記錄」，不影響其餘資料備份/還原流程

### CSV 匯入模式（沿用既有行為，未變更）

- 「匯入 CSV」（明細）與「載入模擬資料」皆為**附加**：會加在現有明細之後，**重複匯入會產生重複資料**，不會自動去重。
- 「匯入帳戶設定」為**取代**：會整批覆蓋現有的帳戶/項目設定（匯入前會再次跳出確認）。
- 若要用備份 CSV 還原改版前的資料，建議先在「設定」頁按「清除所有本地資料」清空後，再匯入 CSV。

### 系統設定（settings）不包含在 CSV 內，需手動重新設定

明細 CSV 與帳戶設定 CSV 只涵蓋各自的資料列，以下 `settings` 項目不會被匯出/匯入，換裝置或清除資料後需自行於「設定」頁重新設定：

- 顯示單位（元 / 萬元）
- 主題模式（深色 / 淺色）
- 主題配色（含自訂配色）
- 字型與字型大小
- 投資配置比（再平衡目標比例）
- 幣別清單與各幣別匯率、基準幣別
- 資產子類別顯示名稱（自訂類別名稱）
- 股價資料來源設定（台股/美股 provider、Finnhub API Key、CORS Proxy 提供者、自訂 Proxy URL）

## iPhone 使用注意事項

- 已加入 `viewport-fit=cover` 與 `env(safe-area-inset-*)` 處理瀏海/底部安全區域
- 已加入 `apple-mobile-web-app-capable` meta，可「加入主畫面」以類似 App 的全螢幕方式開啟
- Vue 3 需要 `Proxy` 支援，iOS Safari 10.3+ 皆相容，不需額外處理
