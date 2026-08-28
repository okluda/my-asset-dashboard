/*
 * services.js
 * 外部資料來源（即時匯率 / 股票市值）的選用性整合。
 * 於「明細」頁的「市價/匯率」按鈕一次更新，預設仍以手動輸入為主。
 *
 * 匯率來源：open.er-api.com（免金鑰、支援新台幣 TWD、支援瀏覽器 CORS）。
 * 股價來源：透過公開 CORS proxy 轉發 Yahoo Finance chart API，屬非官方管道，
 * 穩定性無法保證，失敗時請改用手動輸入，不影響其餘功能運作。
 * 內部網路無法連外時，以下查詢都會失敗，屬正常現象。
 */

const ALD_SERVICE = (() => {
  // 匯率來源：open.er-api.com（免金鑰、支援 TWD、支援 CORS）
  // 回傳格式：{ result:"success", base_code:"USD", rates:{ TWD: 32.x, ... } }
  // 回傳值改為 { value, requestUrl, responseText }，讓呼叫端可取得完整請求 URL 與回應內容全文
  // 供「同步記錄」功能使用；失敗時同樣的資訊會掛在拋出的 Error 物件上（err.requestUrl / err.responseText）。
  async function fetchFxRate(currencyCode, baseCurrency = "TWD") {
    if (!currencyCode || currencyCode === baseCurrency) {
      return { value: 1, requestUrl: "", responseText: "" };
    }
    const url = `https://open.er-api.com/v6/latest/${encodeURIComponent(currencyCode)}`;
    let responseText = "";
    try {
      const res = await fetch(url);
      responseText = await res.text();
      if (!res.ok) throw new Error("匯率查詢失敗 (" + res.status + ")");
      const data = JSON.parse(responseText);
      if (data && data.result && data.result !== "success") {
        throw new Error("匯率查詢失敗：" + (data["error-type"] || "unknown"));
      }
      const rate = data && data.rates && data.rates[baseCurrency];
      if (!rate) throw new Error("找不到匯率資料：" + currencyCode + " -> " + baseCurrency);
      return { value: rate, requestUrl: url, responseText };
    } catch (e) {
      e.requestUrl = url;
      e.responseText = responseText;
      throw e;
    }
  }

  // 將使用者於「帳戶/項目」輸入的名稱/簡碼，正規化為 Yahoo Finance 代號。
  // 規則：
  //   - 取第一個空白前的 token（例："0050 元大台灣50" -> "0050"）
  //   - 已含「.」（如 0050.TW、2330.TWO）視為使用者已指定，直接沿用
  //   - 以數字開頭者視為台股，自動補上 .TW（上櫃股請自行填 .TWO）
  //   - 其餘（純英文字母）視為美股等，維持原樣（如 QQQ、VOO）
  function normalizeSymbol(raw) {
    if (!raw) return "";
    const token = String(raw).trim().split(/\s+/)[0];
    if (!token) return "";
    if (token.includes(".")) return token;
    if (/^\d/.test(token)) return token + ".TW";
    return token;
  }

  // 股價來源：透過公開 CORS proxy 轉發 Yahoo Finance chart API。
  // 回傳值同樣改為 { value, requestUrl, responseText }（詳見 fetchFxRate 的說明）。
  async function fetchStockPrice(symbolRaw) {
    const symbol = normalizeSymbol(symbolRaw);
    if (!symbol) throw new Error("無效的股票代號");
    const target = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
      symbol
    )}`;
    const proxied = `https://corsproxy.io/?url=${encodeURIComponent(target)}`;
    let responseText = "";
    try {
      const res = await fetch(proxied);
      responseText = await res.text();
      if (!res.ok) throw new Error("股價查詢失敗 (" + res.status + ")");
      const data = JSON.parse(responseText);
      const result = data && data.chart && data.chart.result && data.chart.result[0];
      const price =
        result &&
        result.meta &&
        (result.meta.regularMarketPrice ?? result.meta.previousClose);
      if (price == null) throw new Error("找不到股價資料：" + symbol);
      return { value: price, requestUrl: proxied, responseText };
    } catch (e) {
      e.requestUrl = proxied;
      e.responseText = responseText;
      throw e;
    }
  }

  return { fetchFxRate, fetchStockPrice, normalizeSymbol };
})();
