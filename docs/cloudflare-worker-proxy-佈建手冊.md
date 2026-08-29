# 自建 Cloudflare Workers CORS Proxy 佈建手冊

適用情境：設定頁「系統」子分頁的「股價資料來源」中，台股或美股任一邊的「連線模式」選擇「經 Proxy 轉發」，
且不想依賴不穩定的公開免費 proxy 時，可依本手冊自建屬於自己的 proxy，填入對應的「Proxy URL」欄位
（本專案**不內建任何公開 CORS proxy**，Proxy URL 需自行配置）。

Cloudflare Workers 免費層額度（每日 10 萬次請求）對個人使用完全足夠，且不需要維運伺服器。

## 步驟

1. **申請 Cloudflare 帳號**：至 [dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up) 免費註冊（信箱即可，不需綁定網域）。
2. **建立 Worker**：登入後左側選單「Workers & Pages」→「Create」→「Create Worker」，輸入名稱（例如 `my-cors-proxy`）→「Deploy」。
3. **編輯程式碼**：部署完成後點「Edit code」，把預設程式碼整段換成下方內容，再按「Deploy」：

   ```js
   // Cloudflare Worker：簡易 CORS Proxy
   // 用法：https://<你的worker網址>/?url=<編碼後的目標網址>
   export default {
     async fetch(request) {
       const incoming = new URL(request.url);
       const target = incoming.searchParams.get("url");
       if (!target) {
         return new Response("Missing url parameter", { status: 400 });
       }

       // 白名單：僅允許轉發到本 App 會用到的股價來源網域，避免此 Worker 被濫用當成任意網址代理。
       // 若日後改用自訂 API（provider = custom）連到其他網域，請自行將該網域加入下方陣列。
       const ALLOWED_HOSTS = [
         "query1.finance.yahoo.com", // Yahoo Finance
         "openapi.twse.com.tw", // TWSE OpenAPI（官方端點無 CORS 標頭，必須經此 proxy 才能查詢）
       ];
       let targetUrl;
       try {
         targetUrl = new URL(target);
       } catch (e) {
         return new Response("Invalid url parameter", { status: 400 });
       }
       if (!ALLOWED_HOSTS.includes(targetUrl.hostname)) {
         return new Response("Host not allowed", { status: 403 });
       }

       const upstream = await fetch(targetUrl.toString(), {
         headers: { "User-Agent": "Mozilla/5.0" },
       });
       const body = await upstream.text();
       return new Response(body, {
         status: upstream.status,
         headers: {
           "Content-Type": upstream.headers.get("Content-Type") || "application/json",
           "Access-Control-Allow-Origin": "*",
         },
       });
     },
   };
   ```

4. **取得 Worker 網址**：部署後於 Worker 總覽頁可看到網址，格式類似
   `https://my-cors-proxy.<你的帳號>.workers.dev`。
5. **填入 App 設定**：回到本 App「設定 > 系統」的「股價資料來源」，將對應市場（台股/美股）的
   「連線模式」選為「經 Proxy 轉發」，「Proxy URL」填入（`{url}` 佔位字會被自動替換成編碼後的目標網址）：

   ```text
   https://my-cors-proxy.<你的帳號>.workers.dev/?url={url}
   ```

   台股與美股的 Proxy URL 為獨立欄位（`proxyUrlTW` / `proxyUrlUS`），可填入同一個 Worker 網址，
   或分別自建不同 Worker。設定完成後，建議至「設定 > 連線測試」子分頁實際測試一次，確認可正常連線。

## 安全提醒

- 上方範例程式碼已限制只能轉發到 `query1.finance.yahoo.com` 與 `openapi.twse.com.tw` 兩個網域，
  避免 Worker 網址外流後被他人當成任意網址代理濫用。若改用自訂 API（`provider = custom`）連到
  其他網域，請自行將該網域加入白名單，勿直接開放任意網域。
- Cloudflare Workers 網址一經部署即為公開網址（知道網址者皆可呼叫），不含任何個人資料，風險有限，但仍建議勿將網址公開分享。
- 若要停用，回 Cloudflare 「Workers & Pages」介面刪除該 Worker 即可，不影響 App 其餘功能（可改回手動輸入或其他 provider）。
