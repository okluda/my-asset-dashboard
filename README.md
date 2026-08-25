# 資產負債看板（Asset & Liability Dashboard）

個人資產負債總覽網頁 App，專為手機（iPhone Safari）瀏覽設計，資料完全儲存於瀏覽器本地（IndexedDB），不上傳至任何伺服器。

## 技術架構

- 純 HTML + CSS + JavaScript，**不需 npm / build 工具**
- [Vue 3](https://vuejs.org/)（CDN 全域版本，`vue.global.prod.js`）
- [PapaParse](https://www.papaparse.com/)（CDN，處理 CSV 匯入/匯出）
- 資料儲存：瀏覽器 IndexedDB（資料庫名稱 `my_asset_dashboard`，見 `js/db.js`）
- 部署：GitHub Pages（純靜態檔案）

選擇免 build 方案的原因：避免本機/公司網路環境的憑證與套件安裝限制，同時降低維護成本（無需 `npm install`、無版本相依問題）。

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
| 設定 | 顯示單位（元/萬元）、即時匯率/股價自動更新開關、清除本地資料 |

### 資料欄位（明細）

類型、帳戶/項目、日期、備註、單價、幣別、匯率、單位數、金額、槓桿率（曝險金額為計算欄位）。

### 即時資料來源（選用，預設關閉，手動輸入為預設）

- **匯率**：[Frankfurter API](https://frankfurter.dev/)（免費、支援瀏覽器 CORS、無需 API Key）
- **股價**：透過公開 CORS proxy 轉發 Yahoo Finance chart API，屬非官方管道，穩定性無法保證，失敗時請改回手動輸入單價。

於「設定」頁開啟後，「明細」頁的匯率/單價欄位會出現「抓」按鈕可個別更新。

## 部署到 GitHub Pages

1. 建立 GitHub repo（public，免費方案 GitHub Pages 僅支援 public repo）
2. 將本目錄內容 push 到該 repo 的 `main` 分支
3. Repo → Settings → Pages → Source 選擇 `main` branch / `root`
4. 幾分鐘後即可透過 `https://<username>.github.io/<repo>/` 存取

## 資料備份與風險提醒

所有資料僅存在單一瀏覽器的 IndexedDB（資料庫 `my_asset_dashboard`，三個 object store：`records`、`settings`、`accounts`）：

- 清除瀏覽器資料、換裝置、換瀏覽器（含 Safari 無痕模式）都會遺失資料
- **請定期使用「明細」頁的「匯出 CSV」與「帳戶/項目設定」頁的「匯出帳戶設定」功能備份**

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
- 即時匯率／股價自動更新開關

## iPhone 使用注意事項

- 已加入 `viewport-fit=cover` 與 `env(safe-area-inset-*)` 處理瀏海/底部安全區域
- 已加入 `apple-mobile-web-app-capable` meta，可「加入主畫面」以類似 App 的全螢幕方式開啟
- Vue 3 需要 `Proxy` 支援，iOS Safari 10.3+ 皆相容，不需額外處理
