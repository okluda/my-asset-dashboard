/*
 * store.js
 * 負責資料 schema 定義、完整備份（JSON）匯出/還原，以及跨頁面共用的計算工具函式。
 * 資料持久化已改由 js/db.js 的 ALD_DB（IndexedDB）負責，本檔案不再讀寫任何儲存媒介；
 * 資料完全存放於使用者本機瀏覽器（IndexedDB），不會上傳到任何伺服器。
 */

const ALD = (() => {
  // 資料來源資債類型（依規格固定五種）
  const TYPES = ["流動資金", "投資", "固定資產", "應收款", "負債"];

  // 屬於「資產」的類型（用於總覽資產加總、負債比計算）
  const ASSET_TYPES = ["流動資金", "投資", "固定資產", "應收款"];

  const DEFAULT_SETTINGS = {
    unit: "yuan", // 'yuan' = 元, 'wan' = 萬元
    baseCurrency: "TWD",
    // 股價資料來源（見 js/services.js）：Provider / Connection / Proxy 互相解耦，
    // 不內建任何公開 CORS proxy，僅使用使用者自行配置的 proxyUrlTW/US（如自建 Cloudflare Workers）。
    //   台股 stockProviderTW：'twse'（官方 OpenAPI，預設） | 'yahoo' | 'custom' | 'manual'（略過自動查詢）
    //   美股 stockProviderUS：'finnhub'（需自行申請 API Key） | 'yahoo' | 'custom' | 'manual'（預設）
    //   connectionModeTW/US：'direct'（瀏覽器直接連線） | 'proxy'（經 proxyUrlTW/US 轉發）
    //     台股 TWSE OpenAPI 官方端點實測不支援瀏覽器 CORS，預設須經 proxy 才能查詢。
    stockProviderTW: "yahoo",
    stockProviderUS: "yahoo",
    connectionModeTW: "proxy",
    connectionModeUS: "proxy",
    proxyUrlTW: "", // connectionModeTW === 'proxy' 時使用，格式如 https://example.workers.dev/?url={url}
    proxyUrlUS: "", // connectionModeUS === 'proxy' 時使用，格式同上
    customStockApiTW: "", // stockProviderTW === 'custom' 時使用，URL 樣板，含 {symbol} 佔位字
    customStockApiUS: "", // stockProviderUS === 'custom' 時使用，同上
    customPricePathTW: "", // stockProviderTW === 'custom' 時使用，JSON Path，如 data.quote.close
    customPricePathUS: "", // stockProviderUS === 'custom' 時使用，同上
    finnhubApiKey: "", // 美股 provider 為 'finnhub' 時使用，存於本機瀏覽器，不會上傳
    rebalanceRatio: 70, // 再平衡：投資目標佔比(%)，預設 70% -> 流動:投資 = 3:7
    lastTab: "overview", // 上次所在主分頁（overview/rebalance/assets/detail/settings），重新整理後用於還原
    hideAmounts: false, // 全域隱藏金額（總覽眼睛鈕切換）：true 時所有金額顯示為 ***，比例（%）照常顯示
    showExcludedAccounts: false, // 資產頁「顯示不計入帳戶」開關：我的資產與我的負債共用，重新整理後保留
    syncLogEnabled: false, // 是否記錄「同步價格/匯率」的詳細執行資訊（含 API 請求/回應內容），預設關閉
    // 啟動驗證（見 js/lock.js）：僅為畫面鎖定，資料本身未加密；以下欄位不納入完整備份。
    appLockEnabled: false, // 是否於開啟 App／背景超過 5 分鐘回前景時要求驗證
    appLockMethod: "pin", // 'pin'（4–6 位數字）| 'biometric'（WebAuthn：Face ID/Touch ID/指紋等），後者失敗時改用 PIN
    appLockPinHash: "", // PBKDF2-SHA256 雜湊（base64）
    appLockPinSalt: "", // 隨機 salt（base64）
    appLockCredentialId: "", // WebAuthn credential rawId（base64url），僅 appLockMethod === 'biometric' 時使用
    themeMode: "dark", // 'dark' | 'light'
    themeColor: "OatmealTaupe", // 主題配色（見 THEME_COLORS）；'custom' 時改用 customColor
    customColor: "#707070", // 自訂配色（themeColor === 'custom' 時生效）
    fontFamily: "system", // 字型（見 FONT_FAMILIES）
    fontSize: "md", // 字型大小（見 FONT_SIZES）
    // 資債類型顯示名稱：可自訂 4 個資債類型的呈現名稱，空白時以內部鍵為預設。
    // 影響畫面呈現（總覽/明細/再平衡）；完整備份以內部鍵儲存，不受此名稱影響。負債名稱固定不可改。
    categoryNames: {
      流動資金: "流動資金",
      投資: "投資",
      固定資產: "固定資產",
      應收款: "應收款",
    },
    // 幣別設定：每個幣別對應一個匯率（換算為 baseCurrency 台幣）。
    // baseCurrency（TWD）匯率固定為 1。明細輸入與完整備份的幣別/匯率皆與此連動。
    currencies: [
      { code: "TWD", rate: 1 },
      { code: "USD", rate: 32.5 },
    ],
  };

  // 主題配色：切換 --accent（按鈕/選中狀態等主色）。莫蘭迪低飽和色系。
  const THEME_COLORS = {
    OatmealTaupe: { label: "燕麥灰褐", accent: "#7A7571" },
    PineFog: { label: "霧松灰綠", accent: "#606F6A" },
    SmokyBlue: { label: "煙燻藍灰", accent: "#6A7785" },
    PebbleGray: { label: "鵝卵石灰", accent: "#D2D7DF" },
  };

  // 字型選項：切換 --font-family
  const FONT_FAMILIES = {
    system: {
      label: "系統預設",
      value: '-apple-system, BlinkMacSystemFont, "PingFang TC", "Helvetica Neue", Arial, sans-serif',
    },
    serif: {
      label: "明體（襯線）",
      value: '"Songti TC", "PMingLiU", Georgia, serif',
    },
    rounded: {
      label: "圓體",
      value: '"PingFang TC", "Hiragino Sans", "Microsoft JhengHei", sans-serif',
    },
    mono: {
      label: "等寬",
      value: '"SF Mono", Menlo, Consolas, monospace',
    },
  };

  // 字型大小：切換 --font-scale（所有文字級距的乘數）
  const FONT_SIZES = {
    sm: { label: "小", scale: 0.9 },
    md: { label: "中（預設）", scale: 1 },
    lg: { label: "大", scale: 1.15 },
    xl: { label: "特大", scale: 1.3 },
  };

  function uid() {
    return "r" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  // 取得「本地時區」今天日期字串（YYYY-MM-DD）。
  // 注意：不可用 d.toISOString() 取日期，那會先轉為 UTC，在本地時區為 UTC+8 的
  // 凌晨 00:00~07:59 時會被換算成「前一天」的 UTC 日期，導致日期篩選/新增資料
  // 預設日期偏移一天。改用本地年/月/日組字串，避免此時區偏移問題。
  function todayStr() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  // 取得「本地時區」目前時間字串（hh-mi-ss）。
  function timeStr() {
    const d = new Date();
    const p2 = (n) => String(n).padStart(2, "0");
    return `${p2(d.getHours())}-${p2(d.getMinutes())}-${p2(d.getSeconds())}`;
  }
  
  // 取得「本地時區」目前時間字串（yyyy-mm-dd hh:mi:ss），同樣不使用 toISOString() 以避免 UTC 偏移。
  function nowStr() {
    const d = new Date();
    const p2 = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(
      d.getMinutes()
    )}:${p2(d.getSeconds())}`;
  }

  // 正規化日期時間：接受 yyyy-mm-dd / yyyy/mm/dd，可選 " hh:mi" 或 " hh:mi:ss"（也接受 T 分隔）；
  // 輸出 yyyy-mm-dd hh:mi:ss，缺時間補 00:00:00；空值或無法解析回傳 ""。
  function normalizeDateTime(val) {
    const s = String(val == null ? "" : val).trim();
    if (s === "") return "";
    const m = s.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
    if (!m) return "";
    const p2 = (x) => String(x == null ? 0 : x).padStart(2, "0");
    return `${m[1]}-${p2(m[2])}-${p2(m[3])} ${p2(m[4])}:${p2(m[5])}:${p2(m[6])}`;
  }

  // 取前 10 碼 yyyy-mm-dd（畫面顯示、日期篩選、date input 使用）；非字串回傳 ""
  function datePart(val) {
    return typeof val === "string" ? val.slice(0, 10) : "";
  }

  // 明細正規化後只保存交易事實：價格/匯率/槓桿/金額改由帳戶設定與幣別設定即時解析（見 eff* 解析器）。
  // tradePrice／tradeFxRate 為成交當下的歷史紀錄，僅在查無帳戶或幣別設定時作為備援。
  function emptyRecord(type) {
    const t = type || "流動資金";
    return {
      id: uid(),
      type: t,
      account: "",
      date: nowStr(),
      note: "",
      currency: "TWD",
      tradePrice: 1,
      tradeFxRate: 1,
      units: 0,
      excluded: 0, // 1=不計入所有計算，0=計入
    };
  }

  // 已由正規化移除的明細欄位（遷移時刪除；開機時據此判斷是否需寫回 IndexedDB）
  const LEGACY_RECORD_FIELDS = ["unitPrice", "fxRate", "leverage", "amount"];

  function hasLegacyFields(rec) {
    return !!rec && LEGACY_RECORD_FIELDS.some((k) => k in rec);
  }

  // 正規化單筆資料：確保數值型別，並把舊版反正規化欄位遷移為正規化欄位。
  // 遷移規則：unitPrice → tradePrice、fxRate → tradeFxRate；leverage／amount 直接刪除（改由帳戶設定與即時計算取得）。
  // 舊資料遷移：舊版非投資把金額存在 amount，這裡改用 單位 承載。
  function normalizeRec(rec) {
    if (rec.tradePrice == null && rec.unitPrice != null) rec.tradePrice = rec.unitPrice;
    if (rec.tradeFxRate == null && rec.fxRate != null) rec.tradeFxRate = rec.fxRate;
    if (rec.type !== "投資" && !Number(rec.units) && Number(rec.amount)) {
      rec.units = Number(rec.amount) || 0;
    }
    rec.units = Number(rec.units) || 0;
    rec.tradePrice = Number(rec.tradePrice) || 0;
    // 舊資料相容：非投資若無有效價格，帶入預設 1（維持 金額 = 1 × 單位 × 匯率）
    if (rec.type !== "投資" && !rec.tradePrice) rec.tradePrice = 1;
    rec.tradeFxRate = Number(rec.tradeFxRate) || 1;
    rec.excluded = rec.excluded ? 1 : 0;
    // 日期擴欄遷移：純日期（yyyy-mm-dd / yyyy/mm/dd）補 " 00:00:00"；空值或無法解析者維持原樣
    if (rec.date) {
      const dt = normalizeDateTime(rec.date);
      if (dt) rec.date = dt;
    }
    LEGACY_RECORD_FIELDS.forEach((k) => delete rec[k]);
    return rec;
  }


  function normalizeCurrencies(settings) {
    const base = settings.baseCurrency || "TWD";
    let list = Array.isArray(settings.currencies) ? settings.currencies : [];
    const seen = {};
    const out = [];
    list.forEach((c) => {
      const code = String(c && c.code != null ? c.code : "").trim().toUpperCase();
      if (!code || seen[code]) return;
      seen[code] = true;
      out.push({ code, rate: code === base ? 1 : Number(c.rate) || 0 });
    });
    // 確保 base 幣別存在且置頂、匯率為 1
    if (!seen[base]) out.unshift({ code: base, rate: 1 });
    settings.currencies = out;
    return out;
  }

  // 取所有幣別代碼（供明細下拉與備份驗證使用）
  function currencyCodes(settings) {
    return (Array.isArray(settings.currencies) ? settings.currencies : []).map((c) => c.code);
  }

  // 依幣別代碼取匯率；找不到回傳 null
  function currencyRate(settings, code) {
    const c = (Array.isArray(settings.currencies) ? settings.currencies : []).find(
      (x) => x.code === code
    );
    return c ? Number(c.rate) || 0 : null;
  }

  function emptyCurrency() {
    return { code: "", rate: 0 };
  }

  // ---------- 資債類型顯示名稱 ----------
  // 取得資債類型 key 的顯示名稱；空白或無設定時回傳內部鍵。負債固定為「負債」。
  function categoryDisplayName(settings, key) {
    if (key === "負債") return "負債";
    const names = (settings && settings.categoryNames) || {};
    const n = names[key];
    return n && String(n).trim() ? String(n).trim() : key;
  }

  // ---------- 存放帳戶設定 ----------
  // 每筆：{ id, category(內部類型鍵), account(全域唯一存放帳戶名稱), currency(限制幣別), price(價格), leverage(槓桿倍數), sortOrder(顯示順序) }
  // 槓桿倍數預設：資債類型為「投資」時為 1，其餘為 0。
  // sortOrder 由呼叫端指派（例如新增帳戶時取目前最大值 + 1），此函式不自行依陣列長度計算，
  // 避免呼叫端尚未把新帳戶塞入陣列時算出重複或錯誤的順序。
  function emptyAccount(category, sortOrder, currency) {
    const cat = category || "流動資金";
    return {
      id: uid(),
      category: cat,
      account: "",
      currency: currency || "TWD",
      price: 1,
      leverage: cat === "投資" ? 1 : 0,
      sortOrder: Number(sortOrder) || 0,
    };
  }

  function seedAccounts() {
    const raw = [
      { category: "流動資金", account: "銀行活存-台幣", currency: "TWD", price: 1, leverage: 0 },
      { category: "流動資金", account: "銀行活存-美金", currency: "USD", price: 1, leverage: 0 },
      { category: "投資", account: "0050 元大台灣50", currency: "TWD", price: 140, leverage: 1 },
      { category: "投資", account: "VOO", currency: "USD", price: 480, leverage: 1 },
      { category: "固定資產", account: "自住房產", currency: "TWD", price: 1, leverage: 0 },
      { category: "應收款", account: "親友借款", currency: "TWD", price: 1, leverage: 0 },
      { category: "負債", account: "房屋貸款", currency: "TWD", price: 1, leverage: 0 },
    ];
    return raw.map((r, i) => ({ id: uid(), ...r, sortOrder: i + 1 }));
  }

  // 存放帳戶名稱在所有資債類型中全域唯一，category 參數為既有呼叫端相容保留。
  function lookupAccount(accounts, category, account) {
    if (!Array.isArray(accounts) || !String(account == null ? "" : account).trim()) return null;
    return accounts.find((a) => a.account === account) || null;
  }

  // 依全域唯一存放帳戶名稱查對應價格；找不到回傳 null
  function lookupAccountPrice(accounts, category, account) {
    const found = lookupAccount(accounts, category, account);
    return found ? Number(found.price) || 0 : null;
  }

  // 依全域唯一存放帳戶名稱查對應槓桿倍數；找不到回傳 null
  function lookupAccountLeverage(accounts, category, account) {
    const found = lookupAccount(accounts, category, account);
    return found ? Number(found.leverage) || 0 : null;
  }

  // 取某資債類型下的所有存放帳戶名稱（供明細下拉選單使用）
  function accountsForCategory(accounts, category) {
    if (!Array.isArray(accounts)) return [];
    return accounts
      .filter((a) => a.category === category && String(a.account).trim() !== "")
      .map((a) => a.account);
  }

  function validateAccounts(accounts, settings, allowBlank) {
    const names = new Set();
    const codes = new Set(currencyCodes(settings));
    for (const account of accounts || []) {
      const name = String(account && account.account != null ? account.account : "").trim();
      if (!name) {
        if (allowBlank) continue;
        return { valid: false, message: "存放帳戶名稱不可空白。" };
      }
      if (names.has(name)) {
        return { valid: false, message: `存放帳戶名稱「${name}」重複；名稱必須全域唯一。` };
      }
      names.add(name);
      if (!codes.has(account.currency)) {
        return {
          valid: false,
          message: `存放帳戶「${name}」的幣別「${account.currency || "未設定"}」不在幣別設定中。`,
        };
      }
    }
    return { valid: true, message: "" };
  }

  function validateAccountRecordCurrencies(accounts, records) {
    for (const rec of records || []) {
      const account = lookupAccount(accounts, rec.type, rec.account);
      if (account && rec.currency !== account.currency) {
        return {
          valid: false,
          message:
            `存放帳戶「${account.account}」設定為 ${account.currency}，` +
            `但存在 ${rec.currency || "未設定"} 的明細紀錄；請先修正資料後再啟動。`,
        };
      }
    }
    return { valid: true, message: "" };
  }

  // 首次使用提供的範例資料，方便使用者了解畫面呈現方式。
  // 金額為計算欄位（單價 × 單位/額數 × 匯率），這裡透過 normalizeRec 重算。
  function seedRecords() {
    const today = nowStr();
    const raw = [
      { type: "流動資金", account: "銀行活存-台幣", currency: "TWD", tradeFxRate: 1, tradePrice: 1, units: 300000 },
      { type: "流動資金", account: "銀行活存-美金", currency: "USD", tradeFxRate: 32.5, tradePrice: 1, units: 5000 },
      { type: "投資", account: "0050 元大台灣50", currency: "TWD", tradeFxRate: 1, tradePrice: 140, units: 2000 },
      { type: "投資", account: "VOO", currency: "USD", tradeFxRate: 32.5, tradePrice: 480, units: 30, note: "美股ETF" },
      { type: "固定資產", account: "自住房產", currency: "TWD", tradeFxRate: 1, tradePrice: 1, units: 8000000 },
      { type: "應收款", account: "親友借款", currency: "TWD", tradeFxRate: 1, tradePrice: 1, units: 100000 },
      { type: "負債", account: "房屋貸款", currency: "TWD", tradeFxRate: 1, tradePrice: 1, units: 5000000 },
    ];
    return raw.map((r) =>
      normalizeRec({ id: uid(), date: today, note: r.note || "", excluded: 0, ...r })
    );
  }

  function round2(n) {
    return Math.round((Number(n) || 0) * 100) / 100;
  }

  // ---------- 有效值解析（明細 → 帳戶設定／幣別設定） ----------
  // 開機時綁定 reactive store（需含 accounts 與 settings），每次解析即時讀取，
  // 讓 Vue computed 能追蹤帳戶價格/槓桿與幣別匯率的變更；未綁定時只用明細自身的備援值。
  let boundSource = null;

  function bindRefs(source) {
    boundSource = source || null;
  }

  function boundAccount(rec) {
    if (!boundSource || !rec) return null;
    return lookupAccount(boundSource.accounts, rec.type, rec.account);
  }

  // 有效幣別：有對應帳戶用帳戶幣別，否則用明細幣別
  function effCurrency(rec) {
    const a = boundAccount(rec);
    if (a) return a.currency;
    const base = boundSource && boundSource.settings ? boundSource.settings.baseCurrency : "";
    return rec.currency || base || "TWD";
  }

  // 有效價格：有對應帳戶用帳戶價格，否則用成交價，再沒有用 1
  function effPrice(rec) {
    const a = boundAccount(rec);
    if (a) return Number(a.price) || 0;
    return Number(rec.tradePrice) > 0 ? Number(rec.tradePrice) : 1;
  }

  // 有效匯率：有對應幣別設定用目前匯率，否則用成交匯率，再沒有用 1
  function effFxRate(rec) {
    const settings = boundSource && boundSource.settings;
    const rate = settings ? currencyRate(settings, effCurrency(rec)) : null;
    if (rate != null) return rate || 1;
    return Number(rec.tradeFxRate) > 0 ? Number(rec.tradeFxRate) : 1;
  }

  // 有效槓桿：有對應帳戶用帳戶槓桿，否則依資債類型預設（投資=1，其餘=0）
  function effLeverage(rec) {
    const a = boundAccount(rec);
    if (a) return Number(a.leverage) || 0;
    return rec && rec.type === "投資" ? 1 : 0;
  }

  // 依指定價格/單位/匯率計算台幣金額（供彈窗預覽等尚未寫入的虛擬資料使用）
  function calcAmountTWD(price, units, fx) {
    return round2((Number(price) || 0) * (Number(units) || 0) * (Number(fx) || 1));
  }

  // 原幣金額（未換算台幣）＝ 有效價格 × 單位/額數
  function origAmount(rec) {
    return round2(effPrice(rec) * (Number(rec.units) || 0));
  }

  // 金額（台幣）＝ 有效價格 × 單位/額數 × 有效匯率
  function amountTWD(rec) {
    return calcAmountTWD(effPrice(rec), rec.units, effFxRate(rec));
  }

  // 曝險金額 = 台幣金額 × 有效槓桿（槓桿=0 時曝險金額即為 0）
  function exposureTWD(rec) {
    return round2(amountTWD(rec) * effLeverage(rec));
  }

  // 判斷單筆資料是否為「不計入」：統一處理 1/true 為不計入，0/false/null/undefined/
  // 欄位不存在一律視為「計入」，避免舊資料或型別不一致造成篩選誤判。
  function isExcluded(rec) {
    return !!rec && (rec.excluded === 1 || rec.excluded === true);
  }

  // 全站金額統一顯示為 $ 加分位數字，不受顯示單位設定影響。
  function formatAmount(value, settings) {
    const v = Number(value) || 0;
    return "$" + Math.round(v).toLocaleString("zh-TW");
  }

  // 保留既有呼叫端名稱，金額輸出與 formatAmount 一致。
  function formatAmountNum(value, settings) {
    return formatAmount(value, settings);
  }

  function unitLabel(settings) {
    return settings && settings.unit === "wan" ? "萬元" : "元";
  }

  // 比例條/圖例用色（莫蘭迪低飽和色系），超過 6 個時以 chartColor 循環取用
  const CHART_COLORS = ["#8E9AAF", "#A3B18A", "#D4A373", "#B5838D", "#84A59D", "#C9B79C"];

  function chartColor(index) {
    return CHART_COLORS[((index % CHART_COLORS.length) + CHART_COLORS.length) % CHART_COLORS.length];
  }

  function formatPercent(value, digits = 1) {
    if (!isFinite(value)) return "-";
    return (value * 100).toFixed(digits) + "%";
  }

  // ---------- 完整備份（JSON）匯出/還原 ----------
  // 單一 JSON 檔包含：幣別清單與匯率、資產類型名稱、股價資料來源、存放帳戶、明細。
  // 帳戶 category 與明細 type 一律存內部鍵，還原時不依賴目前的自訂類型名稱。
  // 不包含：Finnhub API Key、啟動驗證設定（appLock*）、外觀/顯示單位等其他一般設定。
  // 還原為「完整取代」：五個區塊皆必填，任一欄位不合法即整份拒絕；不接受舊版 CSV 與舊版設定備份。
  const BACKUP_KIND = "walletegg-backup";
  const BACKUP_VERSION = 1;
  const BACKUP_SECTIONS = ["currencies", "categoryNames", "stockSource", "accounts", "records"];
  const STOCK_SOURCE_KEYS = [
    "stockProviderTW",
    "stockProviderUS",
    "connectionModeTW",
    "connectionModeUS",
    "proxyUrlTW",
    "proxyUrlUS",
    "customStockApiTW",
    "customStockApiUS",
    "customPricePathTW",
    "customPricePathUS",
  ];
  const STOCK_SOURCE_ENUMS = {
    stockProviderTW: ["twse", "yahoo", "custom", "manual"],
    stockProviderUS: ["finnhub", "yahoo", "custom", "manual"],
    connectionModeTW: ["direct", "proxy"],
    connectionModeUS: ["direct", "proxy"],
  };
  const RECORD_BACKUP_FIELDS = [
    "id",
    "type",
    "account",
    "date",
    "note",
    "currency",
    "tradePrice",
    "tradeFxRate",
    "units",
    "excluded",
  ];

  // 解析數字（去除千分位逗號、空白），空值或非數字則回傳預設值
  function numOr(val, dflt) {
    const s = String(val == null ? "" : val).replace(/,/g, "").trim();
    if (s === "") return dflt;
    const n = Number(s);
    return isNaN(n) ? dflt : n;
  }

  function isPlainObject(v) {
    return v !== null && typeof v === "object" && !Array.isArray(v);
  }

  // 必須為有限數字（允許數字字串）；空值回傳 dflt，非數字則拋出錯誤
  function strictNum(val, dflt, label) {
    if (val == null || String(val).trim() === "") return dflt;
    const n = Number(String(val).replace(/,/g, "").trim());
    if (!isFinite(n)) throw new Error(`${label} 必須是數字（目前為「${val}」）。`);
    return n;
  }

  function exportBackup(records, accounts, settings) {
    const categoryNames = {};
    ASSET_TYPES.forEach((k) => {
      categoryNames[k] = categoryDisplayName(settings, k);
    });
    const stockSource = {};
    STOCK_SOURCE_KEYS.forEach((k) => {
      stockSource[k] = settings[k] == null ? "" : settings[k];
    });
    const data = {
      kind: BACKUP_KIND,
      version: BACKUP_VERSION,
      exportedAt: nowStr(),
      currencies: (Array.isArray(settings.currencies) ? settings.currencies : []).map((c) => ({
        code: c.code,
        rate: Number(c.rate) || 0,
      })),
      categoryNames,
      stockSource,
      accounts: (accounts || []).map((a, i) => ({
        category: a.category,
        account: a.account,
        currency: a.currency,
        price: Number(a.price) || 0,
        leverage: Number(a.leverage) || 0,
        sortOrder: i + 1,
      })),
      records: (records || []).map((r) => {
        const o = {};
        RECORD_BACKUP_FIELDS.forEach((k) => {
          o[k] = r[k];
        });
        o.excluded = r.excluded ? 1 : 0;
        return o;
      }),
    };
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: "application/json;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `WalletEgg完整備份_${todayStr()}_${timeStr()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // 解析並驗證完整備份檔，回傳 { currencies, categoryNames, stockSource, accounts, records }，不修改任何 store。
  // 任一欄位不合法即 throw，呼叫端不得套用任何區塊（整份拒絕）。
  async function parseBackup(file, settings) {
    const text = await file.text();
    let data;
    try {
      data = JSON.parse(text.replace(/^\uFEFF/, ""));
    } catch (e) {
      throw new Error("不是有效的完整備份檔（JSON 格式錯誤）。");
    }
    if (isPlainObject(data) && data.kind === "ald-config-backup") {
      throw new Error("這是舊版「設定備份」檔，新版不再支援；請使用「匯出完整備份」產生的檔案。");
    }
    if (!isPlainObject(data) || data.kind !== BACKUP_KIND) {
      throw new Error("不是有效的完整備份檔（缺少或不符的 kind）。");
    }
    if (data.version !== BACKUP_VERSION) {
      throw new Error(`不支援的完整備份版本：${data.version}。`);
    }
    BACKUP_SECTIONS.forEach((k) => {
      if (data[k] === undefined) throw new Error(`完整備份檔缺少「${k}」區塊。`);
    });

    // 幣別：代碼不可空白/重複，須含基準幣別；基準幣別匯率固定為 1
    const base = settings.baseCurrency || "TWD";
    if (!Array.isArray(data.currencies)) throw new Error("currencies 必須是陣列。");
    const currencies = [];
    const seenCodes = new Set();
    data.currencies.forEach((c, i) => {
      const no = i + 1;
      if (!isPlainObject(c)) throw new Error(`currencies 第 ${no} 筆格式錯誤。`);
      const code = String(c.code == null ? "" : c.code).trim().toUpperCase();
      if (!code) throw new Error(`currencies 第 ${no} 筆的幣別代碼不可空白。`);
      if (seenCodes.has(code)) throw new Error(`currencies 的幣別代碼「${code}」重複。`);
      seenCodes.add(code);
      const rate = strictNum(c.rate, 0, `currencies「${code}」的匯率`);
      if (rate < 0) throw new Error(`currencies「${code}」的匯率不可為負數。`);
      currencies.push({ code, rate: code === base ? 1 : rate });
    });
    if (!seenCodes.has(base)) throw new Error(`currencies 必須包含基準幣別 ${base}。`);
    const codes = currencies.map((c) => c.code);

    if (!isPlainObject(data.categoryNames)) throw new Error("categoryNames 必須是物件。");
    const categoryNames = {};
    ASSET_TYPES.forEach((k) => {
      categoryNames[k] = k;
    });
    Object.keys(data.categoryNames).forEach((k) => {
      if (!ASSET_TYPES.includes(k)) throw new Error(`categoryNames 含不支援的類型「${k}」。`);
      const v = data.categoryNames[k];
      if (typeof v !== "string") throw new Error(`categoryNames「${k}」的名稱必須是文字。`);
      categoryNames[k] = v.trim() ? v.trim() : k;
    });

    // 報價來源：缺少的鍵帶入預設值；其他鍵（包含 finnhubApiKey）一律忽略
    if (!isPlainObject(data.stockSource)) throw new Error("stockSource 必須是物件。");
    const stockSource = {};
    STOCK_SOURCE_KEYS.forEach((k) => {
      if (!(k in data.stockSource)) {
        stockSource[k] = DEFAULT_SETTINGS[k];
        return;
      }
      const v = data.stockSource[k];
      if (typeof v !== "string") throw new Error(`stockSource.${k} 必須是文字。`);
      const enums = STOCK_SOURCE_ENUMS[k];
      if (enums && !enums.includes(v)) {
        throw new Error(`stockSource.${k} 的值「${v}」不合法，可用值：${enums.join(" / ")}。`);
      }
      stockSource[k] = enums ? v : v.trim();
    });

    if (!Array.isArray(data.accounts)) throw new Error("accounts 必須是陣列。");
    const accounts = data.accounts.map((a, i) => {
      const no = i + 1;
      if (!isPlainObject(a)) throw new Error(`accounts 第 ${no} 筆格式錯誤。`);
      if (!TYPES.includes(a.category)) {
        throw new Error(`accounts 第 ${no} 筆的資債類型「${a.category}」不合法。`);
      }
      const account = String(a.account == null ? "" : a.account).trim();
      if (!account) throw new Error(`accounts 第 ${no} 筆的存放帳戶名稱不可空白。`);
      const currency = String(a.currency == null ? "" : a.currency).trim().toUpperCase();
      if (!codes.includes(currency)) {
        throw new Error(`accounts 第 ${no} 筆的幣別「${currency || "未設定"}」不在備份的幣別清單中。`);
      }
      return {
        id: uid(),
        category: a.category,
        account,
        currency,
        price: strictNum(a.price, 1, `accounts 第 ${no} 筆的價格`),
        leverage: strictNum(a.leverage, a.category === "投資" ? 1 : 0, `accounts 第 ${no} 筆的槓桿倍數`),
        sortOrder: no,
      };
    });
    const accountValidation = validateAccounts(accounts, { baseCurrency: base, currencies }, false);
    if (!accountValidation.valid) throw new Error(accountValidation.message);

    if (!Array.isArray(data.records)) throw new Error("records 必須是陣列。");
    const seenIds = new Set();
    const records = data.records.map((r, i) => {
      const no = i + 1;
      if (!isPlainObject(r)) throw new Error(`records 第 ${no} 筆格式錯誤。`);
      if (!TYPES.includes(r.type)) {
        throw new Error(`records 第 ${no} 筆的資債類型「${r.type}」不合法。`);
      }
      const rawDate = r.date == null ? "" : String(r.date).trim();
      const date = rawDate ? normalizeDateTime(rawDate) : "";
      if (rawDate && !date) throw new Error(`records 第 ${no} 筆的日期「${rawDate}」格式錯誤。`);
      const currency = String(r.currency == null ? "" : r.currency).trim().toUpperCase();
      if (!codes.includes(currency)) {
        throw new Error(`records 第 ${no} 筆的幣別「${currency || "未設定"}」不在備份的幣別清單中。`);
      }
      let id = typeof r.id === "string" ? r.id.trim() : "";
      if (!id || seenIds.has(id)) id = uid();
      seenIds.add(id);
      const rec = {
        id,
        type: r.type,
        account: String(r.account == null ? "" : r.account).trim(),
        date,
        note: String(r.note == null ? "" : r.note).trim(),
        currency,
        tradePrice: strictNum(r.tradePrice, 1, `records 第 ${no} 筆的成交價`),
        tradeFxRate: strictNum(r.tradeFxRate, 1, `records 第 ${no} 筆的成交匯率`),
        units: strictNum(r.units, 0, `records 第 ${no} 筆的單位`),
        excluded: Number(r.excluded) === 1 || r.excluded === true ? 1 : 0,
      };
      return normalizeRec(rec);
    });
    const currencyValidation = validateAccountRecordCurrencies(accounts, records);
    if (!currencyValidation.valid) throw new Error(currencyValidation.message);

    return { currencies, categoryNames, stockSource, accounts, records };
  }

  // ---------- 同步記錄（同步價格/匯率/連線測試的執行記錄，沿用既有 syncLogs store，不新增 store） ----------
  // 保留上限：僅保留最近 500 筆，避免 IndexedDB 無限成長。
  const SYNC_LOG_MAX = 500;
  // 單筆記錄的 responseText preview 上限（字元數）；js/services.js 的 requestRaw 已先行截斷，
  // 這裡再次防禦性裁切，避免任何非經 services.js 產生的記錄（例如未來擴充）超出上限。
  const SYNC_LOG_PREVIEW_MAX = 5000;
  // 所有記錄的 responseText 總字元數上限；超過時從最舊的記錄開始移除，直到符合上限為止
  // （即使尚未達到 SYNC_LOG_MAX 筆數上限也會提前裁減，兩個上限同時生效）。
  const SYNC_LOG_TOTAL_PREVIEW_MAX = 500000;

  // 附加一筆同步記錄（假設呼叫端依時間順序附加在陣列尾端＝最新）；
  // entry.logKind：'sync'（正式同步） | 'connectionTest'（連線測試中心），呼叫端未提供時預設 'sync'。
  // 超過筆數上限時從陣列開頭（最舊）裁掉多餘筆數；超過總 preview 字數上限時同樣從最舊開始移除。
  function appendSyncLog(logs, entry) {
    if (!Array.isArray(logs)) return;
    const capped = Object.assign({}, entry, { logKind: (entry && entry.logKind) || "sync" });
    if (typeof capped.responseText === "string" && capped.responseText.length > SYNC_LOG_PREVIEW_MAX) {
      capped.responseText = capped.responseText.slice(0, SYNC_LOG_PREVIEW_MAX) + "…（已截斷）";
    }
    logs.push(capped);
    const overflow = logs.length - SYNC_LOG_MAX;
    if (overflow > 0) logs.splice(0, overflow);
    let total = logs.reduce((sum, l) => sum + (l.responseText ? l.responseText.length : 0), 0);
    while (total > SYNC_LOG_TOTAL_PREVIEW_MAX && logs.length > 0) {
      const removed = logs.shift();
      total -= removed.responseText ? removed.responseText.length : 0;
    }
  }

  // 匯出同步記錄為 JSON（內容含完整 API 請求 URL 與回應內容全文，適合結構化保留，不適合 CSV）。
  function exportSyncLogsJSON(logs) {
    const json = JSON.stringify(logs || [], null, 2);
    const blob = new Blob([json], { type: "application/json;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `同步記錄_${todayStr()}_${timeStr()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // 依設定套用外觀主題：設定 CSS 變數（配色/字型/字型大小）與淺色模式 class
  function applyTheme(settings) {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    // 配色：themeColor === 'custom' 時使用自訂色，否則用預設配色表
    const accent =
      settings.themeColor === "custom"
        ? (settings.customColor || "#707070")
        : (THEME_COLORS[settings.themeColor] || THEME_COLORS.OatmealTaupe).accent;
    const font = FONT_FAMILIES[settings.fontFamily] || FONT_FAMILIES.system;
    const size = FONT_SIZES[settings.fontSize] || FONT_SIZES.md;
    root.style.setProperty("--accent", accent);
    root.style.setProperty("--font-family", font.value);
    root.style.setProperty("--font-scale", size.scale);
    // 淺色模式套用在 <html>（documentElement）而非只有 <body>：
    // 若只切換 body 的 class，<html> 本身的 --bg 仍是預設深色，iOS Safari 的
    // 橡皮筋回彈捲動（overscroll bounce）會露出 <html> 背景，導致「捲動後背景變深色」的錯覺。
    root.classList.toggle("theme-light", settings.themeMode === "light");
  }

  return {
    TYPES,
    ASSET_TYPES,
    DEFAULT_SETTINGS,
    THEME_COLORS,
    FONT_FAMILIES,
    FONT_SIZES,
    seedAccounts,
    emptyAccount,
    lookupAccount,
    lookupAccountPrice,
    lookupAccountLeverage,
    accountsForCategory,
    validateAccounts,
    validateAccountRecordCurrencies,
    categoryDisplayName,
    normalizeCurrencies,
    currencyCodes,
    currencyRate,
    emptyCurrency,
    STOCK_SOURCE_KEYS,
    exportBackup,
    parseBackup,
    appendSyncLog,
    exportSyncLogsJSON,
    SYNC_LOG_MAX,
    SYNC_LOG_PREVIEW_MAX,
    SYNC_LOG_TOTAL_PREVIEW_MAX,
    emptyRecord,
    uid,
    todayStr,
    timeStr,
    nowStr,
    normalizeDateTime,
    datePart,
    round2,
    bindRefs,
    effCurrency,
    effPrice,
    effFxRate,
    effLeverage,
    calcAmountTWD,
    hasLegacyFields,
    origAmount,
    amountTWD,
    exposureTWD,
    isExcluded,
    normalizeRec,
    formatAmount,
    formatAmountNum,
    unitLabel,
    CHART_COLORS,
    chartColor,
    formatPercent,
    seedRecords,
    applyTheme,
  };
})();
