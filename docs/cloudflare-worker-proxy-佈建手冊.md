# 自建 Cloudflare Workers CORS Proxy 佈建手冊

適用情境：設定頁「股價資料來源」中，台股或美股任一邊選擇「Yahoo Finance（需 CORS proxy）」，
且不想依賴公開免費 proxy（corsproxy.io / allorigins.win / thingproxy.freeboard.io，穩定性無法保證）時，
可依本手冊自建屬於自己的 proxy，填入設定頁「CORS Proxy 提供者 > 自訂」欄位。

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

       // 白名單：僅允許轉發到 Yahoo Finance，避免此 Worker 被濫用當成任意網址代理。
       let targetUrl;
       try {
         targetUrl = new URL(target);
       } catch (e) {
         return new Response("Invalid url parameter", { status: 400 });
       }
       if (targetUrl.hostname !== "query1.finance.yahoo.com") {
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
5. **填入 App 設定**：回到本 App「設定 > 股價資料來源」，「CORS Proxy 提供者」選「自訂」，
   「自訂 Proxy URL」填入：

   ```text
   https://my-cors-proxy.<你的帳號>.workers.dev/?url=
   ```

   （App 會直接在後面附加編碼後的目標網址，等同 corsproxy.io 的使用慣例；也支援填含 `{url}` 佔位字的樣板寫法。）

## 安全提醒

- 上方範例程式碼已限制只能轉發到 `query1.finance.yahoo.com`，避免 Worker 網址外流後被他人當成任意網址代理濫用。若要延伸支援其他來源，請自行擴充白名單，勿直接開放任意網域。
- Cloudflare Workers 網址一經部署即為公開網址（知道網址者皆可呼叫），不含任何個人資料，風險有限，但仍建議勿將網址公開分享。
- 若要停用，回 Cloudflare 「Workers & Pages」介面刪除該 Worker 即可，不影響 App 其餘功能（可改回其他 proxy 或 provider）。
