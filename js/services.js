/*
 * services.js
 * 外部資料來源（即時匯率 / 股票市值）的選用性整合。
 * 於「帳戶」頁的「同步匯率／同步價格」按鈕一次更新，預設仍以手動輸入為主。
 *
 * 架構（Provider / Connection / Proxy 三者互相解耦）：
 *   - Provider（資料來源）：台股 twse | yahoo | custom | manual；美股 finnhub | yahoo | custom | manual
 *   - Connection（連線模式）：direct（瀏覽器直接連線）| proxy（透過使用者自行設定的 proxy URL 轉發）
 *   - Proxy：不內建任何公開 CORS proxy，僅使用 settings.proxyUrlTW / proxyUrlUS（使用者自行配置，
 *     例如自建 Cloudflare Workers），格式為含 {url} 佔位字的樣板，或前綴字串。
 *   - Custom API：settings.customStockApiTW/US（URL 樣板，含 {symbol} 佔位字）
 *     + settings.customPricePathTW/US（JSON Path，如 data.quote.close，不使用 eval，僅手動解析）。
 *
 * 匯率來源：open.er-api.com（免金鑰、支援新台幣 TWD、支援瀏覽器 CORS），不受本次重構影響。
 *
 * 所有正式同步（fetchStockPrice）與「連線測試中心」（testMarketConfig / testEndpoint）
 * 皆共用同一組底層 request executor（requestRaw → executeRequestForUrl），確保行為一致、
 * 測試結果為真實網路請求結果，不會假造成功。
 *
 * 失敗時請改用手動輸入，不影響其餘功能運作。內部網路無法連外時，以下查詢都會失敗，屬正常現象。
 */

const ALD_SERVICE = (() => {
  // ---------- 共用常數 ----------
  const DEFAULT_TIMEOUT_MS = 15000; // 所有 API 共用逾時：15 秒
  const RESPONSE_PREVIEW_MAX = 5000; // 單筆回應內容 preview 上限（字元數），與 store.js 的 SYNC_LOG 上限呼應

  // 錯誤代碼（掛在拋出的 Error 物件的 .code 屬性）
  const ERROR_CODES = {
    INVALID_CONFIG: "INVALID_CONFIG",
    INVALID_SYMBOL: "INVALID_SYMBOL",
    UNSUPPORTED_SYMBOL: "UNSUPPORTED_SYMBOL",
    UNSUPPORTED_PROVIDER: "UNSUPPORTED_PROVIDER",
    PROXY_NOT_CONFIGURED: "PROXY_NOT_CONFIGURED",
    TIMEOUT: "TIMEOUT",
    NETWORK_OR_CORS: "NETWORK_OR_CORS",
    HTTP_ERROR: "HTTP_ERROR",
    INVALID_JSON: "INVALID_JSON",
    PRICE_PATH_NOT_FOUND: "PRICE_PATH_NOT_FOUND",
    INVALID_PRICE: "INVALID_PRICE",
    API_RATE_LIMIT: "API_RATE_LIMIT",
  };

  function makeError(code, message, extra) {
    const e = new Error(message || code);
    e.code = code;
    if (extra) Object.assign(e, extra);
    return e;
  }

  // ---------- API Key 安全遮罩 ----------
  // 需遮罩的欄位名稱（不分大小寫）：token / apikey / api_key / api-key / access_token /
  // authorization / x-api-key。套用於任何要顯示於 UI / Log / Error / 匯出 JSON / Console 的
  // 網址或內容文字，避免金鑰外流。
  const SENSITIVE_KEYS = [
    "token",
    "apikey",
    "api_key",
    "api-key",
    "access_token",
    "authorization",
    "x-api-key",
  ];

  function maskSensitive(text) {
    if (text == null) return text;
    let out = String(text);
    SENSITIVE_KEYS.forEach((key) => {
      const esc = key.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
      // query string 樣式：key=value（值於 & 或字串結尾前結束）
      out = out.replace(new RegExp("(" + esc + "=)[^&\"'\\s]+", "gi"), "$1******");
      // JSON / header 樣式："key": "value" 或 key: value
      out = out.replace(
        new RegExp('("?' + esc + '"?\\s*[:]\\s*"?)[^",\\s}]+', "gi"),
        "$1******"
      );
    });
    return out;
  }

  function truncatePreview(text) {
    if (text == null) return "";
    const s = String(text);
    if (s.length <= RESPONSE_PREVIEW_MAX) return s;
    return s.slice(0, RESPONSE_PREVIEW_MAX) + "…（內容過長，已截斷）";
  }

  // 遮罩＋截斷後的「安全版本」，僅用於回傳給呼叫端顯示/記錄，不得再用於解析
  function safePreview(text) {
    return maskSensitive(truncatePreview(text));
  }

  // ---------- 價格驗證：統一拒絕 null / undefined / NaN / Infinity / <=0 ----------
  function validatePrice(raw) {
    const v = typeof raw === "string" ? parseFloat(raw.replace(/,/g, "")) : Number(raw);
    if (raw == null || v === null || Number.isNaN(v) || !Number.isFinite(v) || v <= 0) {
      throw makeError(ERROR_CODES.INVALID_PRICE, "股價數值無效：" + raw);
    }
    return v;
  }

  // ---------- 安全 JSON Path 解析（不使用 eval / 任意 JS parser） ----------
  // 支援以「.」分隔的路徑，純數字片段視為陣列索引，例如：
  //   price / data.price / data.quote.close / chart.result.0.meta.regularMarketPrice
  function resolveJsonPath(obj, path) {
    if (!path) throw makeError(ERROR_CODES.PRICE_PATH_NOT_FOUND, "尚未設定 JSON Path");
    const segments = String(path)
      .split(".")
      .map((s) => s.trim())
      .filter((s) => s !== "");
    if (segments.length === 0) {
      throw makeError(ERROR_CODES.PRICE_PATH_NOT_FOUND, "JSON Path 格式無效：" + path);
    }
    let cur = obj;
    for (const seg of segments) {
      if (cur == null) {
        throw makeError(ERROR_CODES.PRICE_PATH_NOT_FOUND, "JSON Path 找不到資料：" + path);
      }
      cur = /^\d+$/.test(seg) ? cur[Number(seg)] : cur[seg];
    }
    if (cur == null) {
      throw makeError(ERROR_CODES.PRICE_PATH_NOT_FOUND, "JSON Path 找不到資料：" + path);
    }
    return cur;
  }

  // ---------- 統一 Request Executor（正式同步與連線測試中心共用） ----------
  // 回傳：{ requestUrl, responseText, httpStatus, latencyMs, rawResponseText }。
  // requestUrl/responseText 皆已遮罩+截斷，可安全記錄/顯示；rawResponseText 為未遮罩/未截斷的
  // 完整內容，僅供本檔內部解析價格使用，不得回傳給外部呼叫端或寫入記錄。
  async function requestRaw(url, timeoutMs) {
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = controller
      ? setTimeout(() => controller.abort(), timeoutMs || DEFAULT_TIMEOUT_MS)
      : null;
    const nowFn = typeof performance !== "undefined" ? () => performance.now() : () => Date.now();
    const start = nowFn();
    try {
      let res;
      try {
        res = await fetch(url, controller ? { signal: controller.signal } : undefined);
      } catch (e) {
        if (e && e.name === "AbortError") {
          throw makeError(
            ERROR_CODES.TIMEOUT,
            "請求逾時（" + (timeoutMs || DEFAULT_TIMEOUT_MS) + "ms）",
            { requestUrl: maskSensitive(url), latencyMs: Math.round(nowFn() - start) }
          );
        }
        throw makeError(
          ERROR_CODES.NETWORK_OR_CORS,
          "網路或 CORS 錯誤：" + (e && e.message ? e.message : String(e)),
          { requestUrl: maskSensitive(url), latencyMs: Math.round(nowFn() - start) }
        );
      }
      const rawText = await res.text();
      const latencyMs = Math.round(nowFn() - start);
      if (!res.ok) {
        const code = res.status === 429 ? ERROR_CODES.API_RATE_LIMIT : ERROR_CODES.HTTP_ERROR;
        throw makeError(code, "HTTP 錯誤（" + res.status + "）", {
          requestUrl: maskSensitive(url),
          httpStatus: res.status,
          responseText: safePreview(rawText),
          latencyMs,
        });
      }
      return {
        requestUrl: maskSensitive(url),
        httpStatus: res.status,
        latencyMs,
        rawResponseText: rawText,
        responseText: safePreview(rawText),
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // ---------- Proxy URL 組合（不內建任何公開 proxy，僅使用者自行配置） ----------
  // 格式：https://example.workers.dev/?url={url}（含 {url} 佔位字會被替換成編碼後的目標網址）；
  // 若無 {url} 佔位字，視為「前綴字串」，直接在後面附加編碼後的目標網址。
  function buildProxyUrl(targetUrl, proxyUrl) {
    if (!proxyUrl || !/^https?:\/\//i.test(proxyUrl)) {
      throw makeError(ERROR_CODES.PROXY_NOT_CONFIGURED, "尚未設定合法的 Proxy URL");
    }
    const encoded = encodeURIComponent(targetUrl);
    if (proxyUrl.includes("{url}")) return proxyUrl.replace("{url}", encoded);
    return proxyUrl + encoded;
  }

  // 依 connection（direct/proxy）組出最終請求網址並執行請求
  async function executeRequestForUrl(targetUrl, connection, proxyUrl, timeoutMs) {
    let requestUrl = targetUrl;
    if (connection === "proxy") {
      requestUrl = buildProxyUrl(targetUrl, proxyUrl);
    } else if (connection !== "direct") {
      throw makeError(ERROR_CODES.INVALID_CONFIG, "未知的連線模式：" + connection);
    }
    return requestRaw(requestUrl, timeoutMs);
  }

  // ---------- 匯率 ----------
  // 回傳值 { value, requestUrl, responseText }，requestUrl/responseText 皆已遮罩+截斷，
  // 供「同步記錄」功能使用；失敗時同樣的資訊會掛在拋出的 Error 物件上。
  async function fetchFxRate(currencyCode, baseCurrency = "TWD") {
    if (!currencyCode || currencyCode === baseCurrency) {
      return { value: 1, requestUrl: "", responseText: "" };
    }
    const url = `https://open.er-api.com/v6/latest/${encodeURIComponent(currencyCode)}`;
    try {
      const raw = await requestRaw(url, DEFAULT_TIMEOUT_MS);
      let data;
      try {
        data = JSON.parse(raw.rawResponseText);
      } catch (e) {
        throw makeError(ERROR_CODES.INVALID_JSON, "匯率回應 JSON 解析失敗", {
          requestUrl: raw.requestUrl,
          responseText: raw.responseText,
        });
      }
      if (data && data.result && data.result !== "success") {
        throw makeError(
          ERROR_CODES.HTTP_ERROR,
          "匯率查詢失敗：" + (data["error-type"] || "unknown"),
          { requestUrl: raw.requestUrl, responseText: raw.responseText }
        );
      }
      const rate = data && data.rates && data.rates[baseCurrency];
      if (!rate) {
        throw makeError(
          ERROR_CODES.PRICE_PATH_NOT_FOUND,
          "找不到匯率資料：" + currencyCode + " -> " + baseCurrency,
          { requestUrl: raw.requestUrl, responseText: raw.responseText }
        );
      }
      return { value: rate, requestUrl: raw.requestUrl, responseText: raw.responseText };
    } catch (e) {
      if (!e.requestUrl) e.requestUrl = maskSensitive(url);
      throw e;
    }
  }

  // ---------- 股票代號正規化 ----------
  // 將使用者於「帳戶/項目」輸入的名稱/簡碼，正規化為查詢用代號。
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

  // ---------- 各 Provider 的價格解析（不使用 eval） ----------
  function extractTwsePrice(rawResponseText, code) {
    let data;
    try {
      data = JSON.parse(rawResponseText);
    } catch (e) {
      throw makeError(ERROR_CODES.INVALID_JSON, "TWSE 清單 JSON 解析失敗");
    }
    if (!Array.isArray(data)) {
      throw makeError(ERROR_CODES.INVALID_JSON, "TWSE 清單格式異常（非陣列）");
    }
    const row = data.find((r) => r && r.Code === code);
    if (!row) {
      throw makeError(ERROR_CODES.PRICE_PATH_NOT_FOUND, "TWSE 清單找不到股票代號：" + code);
    }
    return validatePrice(row.ClosingPrice);
  }

  function extractYahooPrice(rawResponseText) {
    let data;
    try {
      data = JSON.parse(rawResponseText);
    } catch (e) {
      throw makeError(ERROR_CODES.INVALID_JSON, "Yahoo 回應 JSON 解析失敗");
    }
    const result = data && data.chart && data.chart.result && data.chart.result[0];
    const price = result && result.meta && (result.meta.regularMarketPrice ?? result.meta.previousClose);
    if (price == null) {
      throw makeError(ERROR_CODES.PRICE_PATH_NOT_FOUND, "找不到 Yahoo 股價欄位（regularMarketPrice）");
    }
    return validatePrice(price);
  }

  function extractFinnhubPrice(rawResponseText) {
    let data;
    try {
      data = JSON.parse(rawResponseText);
    } catch (e) {
      throw makeError(ERROR_CODES.INVALID_JSON, "Finnhub 回應 JSON 解析失敗");
    }
    const price = data && data.c;
    if (price == null) {
      throw makeError(ERROR_CODES.PRICE_PATH_NOT_FOUND, "找不到 Finnhub 股價欄位（c）");
    }
    return validatePrice(price);
  }

  function extractCustomPrice(rawResponseText, pricePath) {
    let data;
    try {
      data = JSON.parse(rawResponseText);
    } catch (e) {
      throw makeError(ERROR_CODES.INVALID_JSON, "自訂 API 回應 JSON 解析失敗");
    }
    const raw = resolveJsonPath(data, pricePath);
    return validatePrice(raw);
  }

  // ---------- TWSE 當日全部上市股票清單（同一批次同步只下載一次，見 cache 參數） ----------
  const TWSE_STOCK_DAY_ALL_URL = "https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL";

  // 依「設定 > 股價資料來源」取出台股／美股個別的 Provider / Connection / Proxy / 自訂 API 設定。
  function resolveMarketConfig(market, settings) {
    const s = settings || {};
    const isTW = market === "TW";
    return {
      provider: isTW ? s.stockProviderTW : s.stockProviderUS,
      connection: isTW ? s.connectionModeTW : s.connectionModeUS,
      proxyUrl: isTW ? s.proxyUrlTW : s.proxyUrlUS,
      customApi: isTW ? s.customStockApiTW : s.customStockApiUS,
      pricePath: isTW ? s.customPricePathTW : s.customPricePathUS,
    };
  }

  // 特殊回傳值：代表該市場 provider 設為「手動輸入」，呼叫端應視為略過（非成功也非失敗）。
  const SKIP_MANUAL = Symbol("ALD_SERVICE_SKIP_MANUAL");

  // 依「設定 > 股價資料來源」的台股／美股個別設定，查詢單一股票代號的價格。
  // cache：呼叫端於同一批次同步時可共用傳入的同一個物件（{}），用於快取 TWSE 整份清單
  //（cache.twsePromise），避免同一次同步重複下載整份 STOCK_DAY_ALL。
  // 回傳：{ value, requestUrl, responseText, latencyMs, httpStatus, provider, connection } 或 SKIP_MANUAL；
  // 失敗時拋出帶 .code（見 ERROR_CODES）、.requestUrl、.responseText、.latencyMs、.httpStatus 的 Error。
  async function fetchStockPrice(symbolRaw, settings, cache) {
    const symbol = normalizeSymbol(symbolRaw);
    if (!symbol) throw makeError(ERROR_CODES.INVALID_SYMBOL, "無效的股票代號：" + symbolRaw);
    const isTW = isTaiwanSymbol(symbol);
    const market = isTW ? "TW" : "US";
    const cfg = resolveMarketConfig(market, settings);
    const { provider, connection, proxyUrl } = cfg;

    if (provider === "manual") return SKIP_MANUAL;

    const validProviders = isTW ? ["twse", "yahoo", "custom"] : ["finnhub", "yahoo", "custom"];
    if (!validProviders.includes(provider)) {
      throw makeError(ERROR_CODES.UNSUPPORTED_PROVIDER, "不支援的股價來源設定：" + provider);
    }

    if (provider === "twse" && /\.TWO$/i.test(symbol)) {
      // TWSE OpenAPI 僅涵蓋上市股票，不涵蓋上櫃（.TWO），不得自動 fallback 到其他 provider。
      throw makeError(ERROR_CODES.UNSUPPORTED_SYMBOL, "TWSE 不支援上櫃代號（.TWO）：" + symbol);
    }
    if (provider === "finnhub" && !(settings && settings.finnhubApiKey)) {
      throw makeError(ERROR_CODES.INVALID_CONFIG, "尚未設定 Finnhub API Key");
    }
    if (provider === "custom" && !cfg.customApi) {
      throw makeError(ERROR_CODES.INVALID_CONFIG, "尚未設定自訂 API URL");
    }
    if (provider === "custom" && !cfg.pricePath) {
      throw makeError(ERROR_CODES.INVALID_CONFIG, "尚未設定自訂 API 的 JSON Path");
    }

    const code = symbol.replace(/\.(TW|TWO)$/i, "");

    try {
      if (provider === "twse") {
        const batchCache = cache || {};
        if (!batchCache.twsePromise) {
          batchCache.twsePromise = executeRequestForUrl(TWSE_STOCK_DAY_ALL_URL, connection, proxyUrl);
        }
        const raw = await batchCache.twsePromise;
        const value = extractTwsePrice(raw.rawResponseText, code);
        return {
          value,
          requestUrl: raw.requestUrl,
          responseText: raw.responseText,
          latencyMs: raw.latencyMs,
          httpStatus: raw.httpStatus,
          provider,
          connection,
        };
      }

      let targetUrl;
      let parseFn;
      if (provider === "yahoo") {
        targetUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`;
        parseFn = extractYahooPrice;
      } else if (provider === "finnhub") {
        targetUrl =
          `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}` +
          `&token=${encodeURIComponent(settings.finnhubApiKey)}`;
        parseFn = extractFinnhubPrice;
      } else {
        // custom
        targetUrl = cfg.customApi.replace("{symbol}", encodeURIComponent(symbol));
        parseFn = (text) => extractCustomPrice(text, cfg.pricePath);
      }

      const raw = await executeRequestForUrl(targetUrl, connection, proxyUrl);
      const value = parseFn(raw.rawResponseText);
      return {
        value,
        requestUrl: raw.requestUrl,
        responseText: raw.responseText,
        latencyMs: raw.latencyMs,
        httpStatus: raw.httpStatus,
        provider,
        connection,
      };
    } catch (e) {
      if (e.provider === undefined) e.provider = provider;
      if (e.connection === undefined) e.connection = connection;
      throw e;
    }
  }

  // ---------- 連線測試中心 ----------
  // 「市場設定測試」：套用目前 settings 的台股/美股設定，對指定測試代號執行一次與正式同步
  // 完全相同的流程（共用 fetchStockPrice → requestRaw），但不更新任何帳戶價格/明細資料。
  // 回傳統一格式，永遠反映真實請求結果，不假造成功。
  async function testMarketConfig(market, settings, testSymbol) {
    const isTW = market === "TW";
    const cfg = resolveMarketConfig(market, settings);
    const fallbackSymbol = isTW ? "2330.TW" : "AAPL";
    const symbol = testSymbol && String(testSymbol).trim() ? testSymbol : fallbackSymbol;
    const base = { market, provider: cfg.provider, connection: cfg.connection };
    try {
      const result = await fetchStockPrice(symbol, settings, {});
      if (result === SKIP_MANUAL) {
        return {
          ...base,
          ok: false,
          requestUrl: "",
          httpStatus: null,
          latencyMs: 0,
          responseText: "",
          value: null,
          errorCode: ERROR_CODES.INVALID_CONFIG,
          errorMessage: "目前 provider 設為「手動輸入」，無需連線測試",
        };
      }
      return {
        ...base,
        ok: true,
        requestUrl: result.requestUrl,
        httpStatus: result.httpStatus,
        latencyMs: result.latencyMs,
        responseText: result.responseText,
        value: result.value,
        errorCode: "",
        errorMessage: "",
      };
    } catch (e) {
      return {
        ...base,
        ok: false,
        requestUrl: e.requestUrl || "",
        httpStatus: e.httpStatus || null,
        latencyMs: e.latencyMs || 0,
        responseText: e.responseText || "",
        value: null,
        errorCode: e.code || "UNKNOWN",
        errorMessage: e.message || String(e),
      };
    }
  }

  // 「任意 Endpoint 測試」：使用者自行輸入網址（可選 direct/proxy 與 JSON Path），
  // 透過與正式同步相同的 executeRequestForUrl 執行請求，不解析/更新任何帳戶資料。
  async function testEndpoint(cfg) {
    const { url, connection, proxyUrl, pricePath, timeoutMs } = cfg || {};
    const base = { provider: "custom", connection: connection || "direct" };
    if (!url) {
      return {
        ...base,
        ok: false,
        requestUrl: "",
        httpStatus: null,
        latencyMs: 0,
        responseText: "",
        parsedValue: null,
        errorCode: ERROR_CODES.INVALID_CONFIG,
        errorMessage: "請輸入要測試的網址",
      };
    }
    try {
      const raw = await executeRequestForUrl(url, connection || "direct", proxyUrl, timeoutMs);
      let parsedValue = null;
      let parseErrorMessage = "";
      if (pricePath) {
        try {
          const data = JSON.parse(raw.rawResponseText);
          parsedValue = resolveJsonPath(data, pricePath);
        } catch (e) {
          parseErrorMessage = e && e.message ? e.message : String(e);
        }
      }
      return {
        ...base,
        ok: true,
        requestUrl: raw.requestUrl,
        httpStatus: raw.httpStatus,
        latencyMs: raw.latencyMs,
        responseText: raw.responseText,
        parsedValue,
        errorCode: parseErrorMessage ? ERROR_CODES.PRICE_PATH_NOT_FOUND : "",
        errorMessage: parseErrorMessage,
      };
    } catch (e) {
      return {
        ...base,
        ok: false,
        requestUrl: e.requestUrl || "",
        httpStatus: e.httpStatus || null,
        latencyMs: e.latencyMs || 0,
        responseText: e.responseText || "",
        parsedValue: null,
        errorCode: e.code || "UNKNOWN",
        errorMessage: e.message || String(e),
      };
    }
  }

  return {
    ERROR_CODES,
    fetchFxRate,
    fetchStockPrice,
    normalizeSymbol,
    isTaiwanSymbol,
    buildProxyUrl,
    maskSensitive,
    resolveJsonPath,
    testMarketConfig,
    testEndpoint,
    SKIP_MANUAL,
  };
})();
