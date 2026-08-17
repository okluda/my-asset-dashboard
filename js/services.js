/*
 * services.js
 * 外部資料來源（即時匯率 / 股票市值）的選用性整合。
 * 預設關閉，使用者可於「設定」頁開啟。
 *
 * 注意：股價來源（Yahoo Finance）並未提供正式公開 API，瀏覽器端直接呼叫
 * 常會被 CORS 政策擋下，此處以「盡力而為」方式實作，失敗時會提示使用者
 * 改回手動輸入，不影響其餘功能運作。
 */

const ALD_SERVICE = (() => {
  // 匯率來源：Frankfurter（免費、支援瀏覽器 CORS、不需 API Key）
  // https://frankfurter.dev
  async function fetchFxRate(currencyCode, baseCurrency = "TWD") {
    if (!currencyCode || currencyCode === baseCurrency) return 1;
    const url = `https://api.frankfurter.app/latest?from=${encodeURIComponent(
      currencyCode
    )}&to=${encodeURIComponent(baseCurrency)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error("匯率查詢失敗 (" + res.status + ")");
    const data = await res.json();
    const rate = data && data.rates && data.rates[baseCurrency];
    if (!rate) throw new Error("找不到匯率資料：" + currencyCode);
    return rate;
  }

  // 股價來源：嘗試透過公開 CORS proxy 轉發 Yahoo Finance chart API。
  // 因屬非官方管道，穩定性無法保證，失敗時請改用手動輸入單價。
  async function fetchStockPrice(symbol) {
    const target = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
      symbol
    )}`;
    const proxied = `https://corsproxy.io/?url=${encodeURIComponent(target)}`;
    const res = await fetch(proxied);
    if (!res.ok) throw new Error("股價查詢失敗 (" + res.status + ")");
    const data = await res.json();
    const result = data && data.chart && data.chart.result && data.chart.result[0];
    const price =
      result &&
      result.meta &&
      (result.meta.regularMarketPrice ?? result.meta.previousClose);
    if (price == null) throw new Error("找不到股價資料：" + symbol);
    return price;
  }

  return { fetchFxRate, fetchStockPrice };
})();
