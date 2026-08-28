/*
 * services.js
 * 外部資料來源（即時匯率 / 股票市值）的選用性整合。
 * 於「帳戶」頁的「同步匯率／同步價格」按鈕一次更新，預設仍以手動輸入為主。
 *
 * 匯率來源：open.er-api.com（免金鑰、支援新台幣 TWD、支援瀏覽器 CORS）。
 *
 * 股價來源依「設定 > 股價資料來源」分別為台股／美股選擇 provider：
 *   - 台股：TWSE OpenAPI（官方、原生支援 CORS、免 proxy，但為當日週期性快照非逐筆即時）
 *           或 Yahoo Finance（經 CORS proxy 轉發，準即時但需依賴第三方 proxy 穩定性）
 *   - 美股：Finnhub（免費層，需使用者自行申請 API Key，原生支援 CORS）
 *           或 Yahoo Finance（同上，經 CORS proxy 轉發）
 *   - 兩者皆可選「手動輸入」以完全略過該市場的自動查詢
 * 失敗時請改用手動輸入，不影響其餘功能運作。內部網路無法連外時，以下查詢都會失敗，屬正常現象。
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

  // 判斷正規化後的代號是否屬於台股（.TW / .TWO 結尾），非台股一律視為美股/其他市場。
  function isTaiwanSymbol(symbol) {
    return /\.(TW|TWO)$/i.test(symbol);
  }

  // 依「設定 > 股價資料來源」的 proxy 提供者設定，組出實際請求用的 proxy URL。
  // 自訂 proxy：若網址含 "{url}" 佔位字，會替換成編碼後的目標網址；否則視為
  // 「前綴字串」，直接在後面附加編碼後的目標網址（沿用 corsproxy.io 的慣例）。
  function buildProxyUrl(targetUrl, settings) {
    const provider = (settings && settings.stockProxyProvider) || "corsproxy";
    const encoded = encodeURIComponent(targetUrl);
    if (provider === "allorigins") {
      return `https://api.allorigins.win/raw?url=${encoded}`;
    }
    if (provider === "thingproxy") {
      return `https://thingproxy.freeboard.io/fetch/${targetUrl}`;
    }
    if (provider === "custom") {
      const base = (settings && settings.customProxyUrl) || "";
      if (!base) throw new Error("尚未設定自訂 Proxy URL");
      if (base.includes("{url}")) return base.replace("{url}", encoded);
      return base + encoded;
    }
    // 預設：corsproxy.io
    return `https://corsproxy.io/?url=${encoded}`;
  }

  // 股價來源（共用）：透過 CORS proxy 轉發 Yahoo Finance chart API。
  // 回傳值統一為 { value, requestUrl, responseText }，供「同步記錄」功能使用；
  // 失敗時同樣的資訊會掛在拋出的 Error 物件上（err.requestUrl / err.responseText）。
  async function fetchStockPriceYahoo(symbol, settings) {
    const target = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
      symbol
    )}`;
    let proxied = "";
    let responseText = "";
    try {
      proxied = buildProxyUrl(target, settings);
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

  // 台股來源：TWSE OpenAPI（openapi.twse.com.tw），官方原生支援 CORS，免 proxy。
  // 一次回傳「當日全部上市股票」收盤價快照（非逐筆即時，屬盤中週期性更新），
  // 呼叫端應在同一批次同步時共用同一份清單（透過 cache 參數），避免重複下載整份清單。
  const TWSE_STOCK_DAY_ALL_URL = "https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL";

  async function loadTwseDailyList() {
    let responseText = "";
    try {
      const res = await fetch(TWSE_STOCK_DAY_ALL_URL);
      responseText = await res.text();
      if (!res.ok) throw new Error("TWSE 股價清單查詢失敗 (" + res.status + ")");
      const data = JSON.parse(responseText);
      if (!Array.isArray(data)) throw new Error("TWSE 股價清單格式異常");
      return { list: data, requestUrl: TWSE_STOCK_DAY_ALL_URL, responseText };
    } catch (e) {
      e.requestUrl = TWSE_STOCK_DAY_ALL_URL;
      e.responseText = responseText;
      throw e;
    }
  }

  async function fetchStockPriceTWSE(symbol, cache) {
    const code = symbol.replace(/\.(TW|TWO)$/i, "");
    if (!cache) throw new Error("缺少 TWSE 股價清單快取");
    if (!cache.promise) {
      cache.promise = loadTwseDailyList();
    }
    const { list, requestUrl, responseText } = await cache.promise;
    const row = list.find((r) => r && r.Code === code);
    if (!row) throw new Error("TWSE 清單找不到股票代號：" + code);
    const price = parseFloat(String(row.ClosingPrice || "").replace(/,/g, ""));
    if (!price || Number.isNaN(price)) throw new Error("TWSE 收盤價格式異常：" + code);
    return { value: price, requestUrl, responseText };
  }

  // 美股來源：Finnhub 免費層（需使用者自行申請 API Key，token 放 query string 以支援瀏覽器 CORS）。
  async function fetchStockPriceFinnhub(symbol, apiKey) {
    if (!apiKey) throw new Error("尚未設定 Finnhub API Key");
    const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(
      symbol
    )}&token=${encodeURIComponent(apiKey)}`;
    let responseText = "";
    try {
      const res = await fetch(url);
      responseText = await res.text();
      if (!res.ok) throw new Error("Finnhub 股價查詢失敗 (" + res.status + ")");
      const data = JSON.parse(responseText);
      const price = data && data.c;
      if (!price) throw new Error("找不到股價資料：" + symbol);
      return { value: price, requestUrl: url, responseText };
    } catch (e) {
      e.requestUrl = url;
      e.responseText = responseText;
      throw e;
    }
  }

  // 特殊回傳值：代表該市場 provider 設為「手動輸入」，呼叫端應視為略過（非成功也非失敗）。
  const SKIP_MANUAL = Symbol("ALD_SERVICE_SKIP_MANUAL");

  // 依「設定 > 股價資料來源」的台股／美股個別 provider 設定分流查詢。
  // cache：呼叫端於同一批次同步時可共用傳入的同一個物件（{}），用於快取 TWSE 整份清單。
  async function fetchStockPrice(symbolRaw, settings, cache) {
    const symbol = normalizeSymbol(symbolRaw);
    if (!symbol) throw new Error("無效的股票代號");
    const isTW = isTaiwanSymbol(symbol);
    const provider = isTW
      ? (settings && settings.stockProviderTW) || "twse"
      : (settings && settings.stockProviderUS) || "manual";

    if (provider === "manual") return SKIP_MANUAL;
    if (isTW && provider === "twse") return fetchStockPriceTWSE(symbol, cache || {});
    if (!isTW && provider === "finnhub") {
      return fetchStockPriceFinnhub(symbol, settings && settings.finnhubApiKey);
    }
    // provider === 'yahooProxy'（台股/美股共用同一條路徑）
    return fetchStockPriceYahoo(symbol, settings);
  }

  return {
    fetchFxRate,
    fetchStockPrice,
    normalizeSymbol,
    isTaiwanSymbol,
    buildProxyUrl,
    SKIP_MANUAL,
  };
})();
