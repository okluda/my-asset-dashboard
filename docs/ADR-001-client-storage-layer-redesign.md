---
date: 2026-08-27
status: proposed
tags: [architecture, storage, sqlite, opfs]
---

# ADR-001：Client Storage Layer 重新設計（IndexedDB → SQLite WASM + OPFS）

## Context

資產負債看板為純前端 SPA（Vue 3 CDN + PapaParse，無 build 工具），部署於靜態託管平台，資料完全儲存於使用者瀏覽器本地，不上傳任何伺服器。主要使用場景為 **iPhone Safari**（含加入主畫面的全螢幕模式）。

現有儲存層 `js/db.js`（`ALD_DB`）以原生 IndexedDB 實作，提供 `records`（明細）、`settings`（系統設定）、`accounts`（帳戶/項目）三個 object store 的存取，並由 `app.js` 以 debounce（500ms）方式在 Vue reactive store 變動時寫回。

**部署平台變更**：本次評估確認未來將改部署於 **Cloudflare Pages**，該平台支援透過 `_headers` 檔案自訂 HTTP response header（含 `Cross-Origin-Opener-Policy` / `Cross-Origin-Embedder-Policy`），這解除了先前分析中「GitHub Pages 無法自訂 header」的關鍵限制，使得依賴跨源隔離（cross-origin isolation）的技術方案重新變得可行。

## Problem Statement

使用者提出三項具體動機，需要本次設計決策逐一回應：

1. **查詢能力（Query Ability）**：目前 IndexedDB 僅支援 key-based 存取與全量 `getAll()`，若未來需要多條件篩選、彙總、跨表關聯等分析型查詢，需在應用層（JS）自行實作，程式碼會逐漸複雜且效能隨資料量下降。
2. **資料增長（Data Growth）**：預期明細資料量成長至約 **3,000 筆上下**。
3. **資料安全性（Data Security）**：使用者關切資料儲存的安全性，目前 IndexedDB 內容為明文，任何能存取該裝置/瀏設定檔的人（或惡意瀏覽器擴充功能）皆可讀取。

需要決定：是否導入 SQLite WASM + OPFS 取代 IndexedDB，以及如何在維持 iPhone Safari 可用性、不犧牲離線能力、不過度增加維護複雜度的前提下達成。

## Decision

**採取分階段、風險受控的混合方案**，而非直接以 OPFS 全面取代 IndexedDB：

1. **導入 SQLite WASM（`@sqlite.org/sqlite-wasm`）作為查詢引擎**，解決「查詢能力」動機——3,000 筆等級的資料可完全載入記憶體中的 SQLite 執行 SQL 查詢/彙總/JOIN，效能遠優於手刻 JS 迴圈。
2. **持久化層採「雙軌自動偵測、以 OPFS 為優先、IndexedDB 為 fallback」**：
   - App 啟動時偵測 `navigator.storage.getDirectory` 與 `FileSystemSyncAccessHandle` 是否可用且運作正常（**必須實機在目標 iPhone 上以 PoC 驗證**，不可只憑桌面瀏覽器測試結果推論）。
   - 若 OPFS sync access handle 可用 → 使用官方 `opfs-sahpool` VFS，資料庫檔案直接持久化於 OPFS。
   - 若不可用（目前已知 iOS Safari 高機率屬此情況，見 Risk） → **退化為「SQLite in-memory + 序列化 blob 存回既有 IndexedDB」模式**（等同 `sql.js` 慣用模式）：每次寫入 debounce 後，將整個 SQLite 資料庫匯出成二進位 blob，存入 IndexedDB 既有的 object store（覆蓋現行以 JS 物件陣列存放的方式）；啟動時反向讀出 blob 還原記憶體資料庫。
   - 兩種模式**對外提供完全相同的 `ALD_DB` API**（`loadRecords/replaceRecords/loadSettings/saveSettings/loadAccounts/replaceAccounts/clearAllData` 等），`app.js`/`store.js` 不需感知底層差異。
3. **HTTP Cache Header 僅作用於「引擎資源」而非「使用者資料」**：於 Cloudflare Pages 的 `_headers` 設定 wasm/js 引擎檔案 `Cache-Control: public, max-age=31536000, immutable`（配合檔名帶版本 hash），降低 wasm binary（約 0.5–1.5MB）在重複造訪時的載入成本；同時設定 `Cross-Origin-Opener-Policy: same-origin` 與 `Cross-Origin-Embedder-Policy: require-corp`，為「OPFS 可用時」的高效能路徑鋪路。**使用者資料本身不經過 HTTP，不適用 HTTP 快取策略**，此為釐清後的正確語意。
4. **資料安全性以獨立於儲存引擎的加密層處理**：無論最終落地於 OPFS 或 IndexedDB，SQLite WASM 與 OPFS **預設皆不提供資料加密**，與現行 IndexedDB 安全性本質相同（明文、依賴裝置/瀏覽器帳號層級的存取控制）。若要實質提升安全性，決定另外導入 **應用層加密**：以 WebCrypto `AES-GCM`，使用者自訂密碼（PBKDF2/Argon2 衍生金鑰）加密後才寫入儲存介質，讀取時在記憶體解密。此為**獨立於本次儲存引擎替換的加值功能**，建議列為後續可選的第二階段（見 Migration Plan）。

## Alternatives

| 方案 | 說明 | 未採用原因 |
|---|---|---|
| A. 全面採用 OPFS `opfs`／`opfs-sahpool` VFS，不做 fallback | 依原始需求圖示直接實作 | iOS Safari 目前無法保證 `createSyncAccessHandle` 可用（見 Risk），一旦不可用且無 fallback，App 在主要目標裝置上會直接無法啟動，風險不可接受 |
| B. 維持 IndexedDB 不變，僅在應用層優化查詢（建索引、快取彙總結果） | 成本最低 | 無法根本解決「多條件/關聯查詢需手刻 JS」的維護負擔，隨欄位需求增加會持續累積技術債；且完全無法回應「查詢能力不足」的核心動機 |
| C. `sql.js`（純記憶體 SQLite，無 OPFS，序列化存回 IndexedDB） | 即本決策中的 fallback 模式 | 單獨採用可解決查詢能力，但放棄 OPFS 帶來的「大檔案下不必整包讀寫」優勢；資料量僅 3,000 筆時此優勢並不明顯，故僅作 fallback 而非主方案 |
| D. 導入正式後端（伺服器 + 資料庫）搭配同步機制 | 可徹底解決查詢、備份、跨裝置同步、加密金鑰託管等問題 | 與專案「純前端、資料不上傳」的既定原則直接衝突，且大幅提高維護成本（需伺服器、需資安維運），超出本次需求範圍 |

## Consequences

**正面**：
- 3,000 筆等級資料的多條件查詢、彙總計算可用標準 SQL 表達，降低 `store.js`/`app.js` 中手刻篩選邏輯的複雜度與 bug 風險
- 對外 API 介面不變，`app.js` 呼叫端改動最小化
- Cloudflare Pages 可控 header，為未來高效能 OPFS 路徑保留彈性
- 加密層若後續導入，可讓「資料安全性」動機得到實質改善（而非僅止於儲存引擎替換本身）

**負面**：
- 新增 sqlite-wasm 依賴（~0.5–1.5MB wasm binary），首次載入時間增加，與專案「輕量、免 build」定位有一定張力
- 雙軌（OPFS / IndexedDB-blob）並存邏輯提高 `db.js` 內部複雜度與測試面向（需覆蓋兩種路徑）
- 除錯難度上升：SQLite 檔案／blob 為二進位格式，不能像現行 IndexedDB 直接於 DevTools「Application」分頁肉眼檢視，需額外撰寫匯出工具或使用 sqlite3 CLI 開啟
- fallback 模式下（in-memory + 整包序列化寫回），每次 debounce 儲存都是「整個資料庫匯出」而非增量寫入，3,000 筆等級下預期仍可接受，但需實測寫入耗時

## Risk

| 風險 | 等級 | 說明與因應 |
|---|---|---|
| iOS Safari `createSyncAccessHandle` 支援度不明確 | **高** | 已查證：截至 2025 年，iOS Safari（含 18.5）呼叫 `createSyncAccessHandle` 會出現 `invalid platform file handle` 錯誤，僅支援非同步 `createWritable()`；桌面 Safari 17+ 雖已支援 OPFS，但行動版落後。**這是本方案最大不確定性**，必須在正式導入前於**真實 iPhone 裝置**（非模擬器）以 PoC 驗證目標 iOS 版本的實際行為，並以此結果決定是否真的啟用 OPFS 路徑，或直接固定使用 IndexedDB-blob fallback |
| COOP/COEP 造成第三方資源相容性問題 | 中 | 設定 `require-corp` 後，若未來想加入其他跨源第三方 CDN 資源（圖片、字型等），需該資源支援 CORP header，否則會被瀏覽器封鎖；需盤點現有 CDN 資源（Vue、PapaParse）是否相容 |
| 資料遷移過程失敗導致資料遺失 | 高 | 詳見 Migration Plan 的保留策略；遷移前**強制提示使用者手動匯出 CSV 備份** |
| 應用層加密金鑰遺失即資料永久不可讀 | 中（若導入加密） | 需明確告知使用者：忘記密碼＝資料無法救回，且無「忘記密碼」救援機制（純前端無伺服器可託管金鑰） |
| wasm binary 載入失敗（離線/網路不穩） | 中 | 需搭配 Service Worker 預先快取 wasm/js 引擎檔案，否則離線或首次載入失敗時 App 無法啟動；若不做 Service Worker，需保留「引擎初始化失敗→顯示錯誤，不覆蓋既有資料」的防呆邏輯（與現行 `initApp` 錯誤處理原則一致） |
| 專案維護複雜度上升 | 中 | 需持續評估此改動的長期維護成本是否符合個人專案定位；若日後查詢需求未如預期增加，可考慮回退至方案 B |

## Migration Plan

1. **PoC 驗證（先行，不涉及正式資料）**：在獨立分支/測試頁面驗證目標 iPhone 機型與 iOS 版本下，OPFS `createSyncAccessHandle` 實際可用性；同時驗證 Cloudflare Pages `_headers` 設定 COOP/COEP 後，現有 Vue/PapaParse CDN 資源與既有功能是否正常運作
2. **提示使用者備份**：於「設定」頁強制引導使用者先執行「匯出 CSV」與「匯出帳戶設定」，作為遷移失敗時的最後防線
3. **重寫 `db.js` 內部實作**（對外 API 不變）：
   - 新增 SQLite schema（`records`/`accounts` 對應資料表，`settings` 對應單列設定表）
   - 依 PoC 結果決定 VFS 策略（OPFS `opfs-sahpool` 或 in-memory + IndexedDB blob fallback），並實作啟動時的自動偵測與降級邏輯
4. **一次性資料搬遷**：App 啟動時偵測「舊 IndexedDB 陣列格式資料存在」且「新 SQLite 儲存尚無資料」→ 讀出舊資料寫入 SQLite → 寫入 migration 完成標記（存於 SQLite 內一張 `_meta` 表或既有 settings 表新增欄位）→ **保留舊 IndexedDB 資料，不主動刪除**，作為至少一次版本迭代的備援
5. **Feature flag**：提供隱藏開關（如 `localStorage` 旗標）可強制切回舊 IndexedDB 實作，供上線初期出狀況時快速回退
6. **灰度觀察期**：正式上線後觀察至少一段時間（建議 2–4 週個人使用週期）確認無資料遺失、無 iOS 啟動失敗回報，再移除舊 IndexedDB 相容程式碼與遷移邏輯
7. **（可選）第二階段：應用層加密**：待儲存引擎替換穩定後，再評估是否導入 WebCrypto AES-GCM 加密層；此階段獨立於本 ADR 的儲存引擎決策，應另立 ADR 討論金鑰管理、使用者體驗（密碼輸入時機）與救援機制的取捨
8. **文件更新**：`README.md` 的「技術架構」「資料備份與風險提醒」章節需同步更新，說明新的儲存位置（OPFS 或 IndexedDB blob）、跨裝置/清除瀏覽器資料的影響、以及（若導入）加密密碼遺失的風險提醒
