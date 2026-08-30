/*
 * store.js
 * 負責資料 schema 定義、CSV 匯入匯出，以及跨頁面共用的計算工具函式。
 * 資料持久化已改由 js/db.js 的 ALD_DB（IndexedDB）負責，本檔案不再讀寫任何儲存媒介；
 * 資料完全存放於使用者本機瀏覽器（IndexedDB），不會上傳到任何伺服器。
 */

const ALD = (() => {
  // 資料來源類型（依規格固定五種）
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
    stockProviderTW: "twse",
    stockProviderUS: "manual",
    connectionModeTW: "proxy",
    connectionModeUS: "direct",
    proxyUrlTW: "", // connectionModeTW === 'proxy' 時使用，格式如 https://example.workers.dev/?url={url}
    proxyUrlUS: "", // connectionModeUS === 'proxy' 時使用，格式同上
    customStockApiTW: "", // stockProviderTW === 'custom' 時使用，URL 樣板，含 {symbol} 佔位字
    customStockApiUS: "", // stockProviderUS === 'custom' 時使用，同上
    customPricePathTW: "", // stockProviderTW === 'custom' 時使用，JSON Path，如 data.quote.close
    customPricePathUS: "", // stockProviderUS === 'custom' 時使用，同上
    finnhubApiKey: "", // 美股 provider 為 'finnhub' 時使用，存於本機瀏覽器，不會上傳
    rebalanceRatio: 70, // 再平衡：投資目標佔比(%)，預設 70% -> 流動:投資 = 3:7
    lastTab: "overview", // 上次所在主分頁（overview/rebalance/detail/settings），重新整理後用於還原
    syncLogEnabled: false, // 是否記錄「同步價格/匯率」的詳細執行資訊（含 API 請求/回應內容），預設關閉
    themeMode: "dark", // 'dark' | 'light'
    themeColor: "grayBlue", // 主題配色（見 THEME_COLORS）；'custom' 時改用 customColor
    customColor: "#5b8cff", // 自訂配色（themeColor === 'custom' 時生效）
    fontFamily: "system", // 字型（見 FONT_FAMILIES）
    fontSize: "md", // 字型大小（見 FONT_SIZES）
    // 資產子類別顯示名稱：可自訂 4 個資產類別的呈現名稱，空白時以內部鍵為預設。
    // 影響畫面呈現（總覽/明細/再平衡）與 CSV 匯出入的「類型」欄位值。負債名稱固定不可改。
    categoryNames: {
      流動資金: "流動資金",
      投資: "投資",
      固定資產: "固定資產",
      應收款: "應收款",
    },
    // 幣別設定：每個幣別對應一個匯率（換算為 baseCurrency 台幣）。
    // baseCurrency（TWD）匯率固定為 1。明細輸入與 CSV 匯出入的幣別/匯率皆與此連動。
    currencies: [
      { code: "TWD", rate: 1 },
      { code: "USD", rate: 32.5 },
    ],
  };

  // 主題配色：切換 --accent（按鈕/選中狀態等主色）。莫蘭迪低飽和色系。
  const THEME_COLORS = {
    morandiPink: { label: "莫蘭迪粉", accent: "#D4C2C1" },
    grayBlue: { label: "灰藍", accent: "#B7C9D9" },
    terracotta: { label: "淡陶土", accent: "#E2B7A0" },
    oliveGray: { label: "橄欖灰綠", accent: "#A4A37A" },
    fogPurple: { label: "霧紫灰", accent: "#C9C0C9" },
    almond: { label: "米杏", accent: "#D8CFC4" },
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

  function emptyRecord(type) {
    const t = type || "流動資金";
    const isInvest = t === "投資";
    return {
      id: uid(),
      type: t,
      account: "",
      date: todayStr(),
      note: "",
      unitPrice: 1, // 非投資固定為 1；投資可由市價帶入
      currency: "TWD",
      fxRate: 1,
      units: 0,
      amount: 0,
      leverage: isInvest ? 1 : 0, // 非投資固定為 0
      excluded: 0, // 1=不計入所有計算，0=計入
    };
  }

  // 正規化單筆資料：確保數值型別並重算金額。
  // 價格改由「設定 > 帳戶」帶入，故此處不再強制非投資單價=1，保留原有價格快照。
  // 槓桿倍數改由「設定 > 帳戶」帶入（可套用於任一類別），故不再強制非投資槓桿=0，保留既有值。
  // 同時提供舊資料遷移：舊版非投資把金額存在 amount，這裡改用 單位 承載。
  function normalizeRec(rec) {
    rec.unitPrice = Number(rec.unitPrice) || 0;
    rec.units = Number(rec.units) || 0;
    rec.fxRate = Number(rec.fxRate) || 1;
    // 槓桿倍數：缺值時依類別帶預設（投資=1，其餘=0）
    rec.leverage =
      rec.leverage == null || isNaN(Number(rec.leverage))
        ? (rec.type === "投資" ? 1 : 0)
        : Number(rec.leverage);
    rec.excluded = rec.excluded ? 1 : 0;
    if (rec.type !== "投資") {
      // 舊資料遷移：非投資若無單位但有金額，把金額搬到單位
      if (!rec.units && Number(rec.amount)) rec.units = Number(rec.amount) || 0;
      // 舊資料相容：非投資若無有效價格，帶入預設 1（維持 金額 = 1 × 單位 × 匯率）
      if (!rec.unitPrice) rec.unitPrice = 1;
    }
    rec.amount = round2(rec.unitPrice * rec.units * rec.fxRate);
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

  // 取所有幣別代碼（供明細下拉與 CSV 驗證使用）
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

  // ---------- 資產子類別顯示名稱 ----------
  // 取得類別 key 的顯示名稱；空白或無設定時回傳內部鍵。負債固定為「負債」。
  function categoryDisplayName(settings, key) {
    if (key === "負債") return "負債";
    const names = (settings && settings.categoryNames) || {};
    const n = names[key];
    return n && String(n).trim() ? String(n).trim() : key;
  }

  // 建立「顯示名稱/內部鍵 -> 內部鍵」的反查表（供 CSV 匯入時把類型名稱轉回內部鍵）
  function buildTypeNameToKey(settings) {
    const map = {};
    TYPES.forEach((k) => {
      map[k] = k; // 內部鍵本身
      map[categoryDisplayName(settings, k)] = k; // 顯示名稱
    });
    return map;
  }

  // ---------- 帳戶/項目設定 ----------
  // 每筆：{ id, category(內部類別鍵), account(帳戶/項目名稱), price(價格), leverage(槓桿倍數), sortOrder(顯示順序) }
  // 槓桿倍數預設：類別為「投資」時為 1，其餘為 0。
  // sortOrder 由呼叫端指派（例如新增帳戶時取目前最大值 + 1），此函式不自行依陣列長度計算，
  // 避免呼叫端尚未把新帳戶塞入陣列時算出重複或錯誤的順序。
  function emptyAccount(category, sortOrder) {
    const cat = category || "流動資金";
    return {
      id: uid(),
      category: cat,
      account: "",
      price: 1,
      leverage: cat === "投資" ? 1 : 0,
      sortOrder: Number(sortOrder) || 0,
    };
  }

  function seedAccounts() {
    const raw = [
      { category: "流動資金", account: "銀行活存-台幣", price: 1, leverage: 0 },
      { category: "流動資金", account: "銀行活存-美金", price: 1, leverage: 0 },
      { category: "投資", account: "0050 元大台灣50", price: 140, leverage: 1 },
      { category: "投資", account: "VOO", price: 480, leverage: 1 },
      { category: "固定資產", account: "自住房產", price: 1, leverage: 0 },
      { category: "應收款", account: "親友借款", price: 1, leverage: 0 },
      { category: "負債", account: "房屋貸款", price: 1, leverage: 0 },
    ];
    return raw.map((r, i) => ({ id: uid(), ...r, sortOrder: i + 1 }));
  }

  // 依「類別 + 帳戶/項目」查對應帳戶設定物件；找不到回傳 null
  function lookupAccount(accounts, category, account) {
    if (!Array.isArray(accounts)) return null;
    return (
      accounts.find((a) => a.category === category && a.account === account) || null
    );
  }

  // 依「類別 + 帳戶/項目」查對應價格；找不到回傳 null
  function lookupAccountPrice(accounts, category, account) {
    const found = lookupAccount(accounts, category, account);
    return found ? Number(found.price) || 0 : null;
  }

  // 依「類別 + 帳戶/項目」查對應槓桿倍數；找不到回傳 null
  function lookupAccountLeverage(accounts, category, account) {
    const found = lookupAccount(accounts, category, account);
    return found ? Number(found.leverage) || 0 : null;
  }

  // 取某類別下的所有帳戶/項目名稱（供明細下拉選單使用）
  function accountsForCategory(accounts, category) {
    if (!Array.isArray(accounts)) return [];
    return accounts
      .filter((a) => a.category === category && String(a.account).trim() !== "")
      .map((a) => a.account);
  }

  // 首次使用提供的範例資料，方便使用者了解畫面呈現方式。
  // 金額為計算欄位（單價 × 單位/額數 × 匯率），這裡透過 normalizeRec 重算。
  function seedRecords() {
    const today = todayStr();
    const raw = [
      { type: "流動資金", account: "銀行活存-台幣", currency: "TWD", fxRate: 1, unitPrice: 1, units: 300000, leverage: 0 },
      { type: "流動資金", account: "銀行活存-美金", currency: "USD", fxRate: 32.5, unitPrice: 1, units: 5000, leverage: 0 },
      { type: "投資", account: "0050 元大台灣50", currency: "TWD", fxRate: 1, unitPrice: 140, units: 2000, leverage: 1 },
      { type: "投資", account: "VOO", currency: "USD", fxRate: 32.5, unitPrice: 480, units: 30, leverage: 1.5, note: "美股ETF" },
      { type: "固定資產", account: "自住房產", currency: "TWD", fxRate: 1, unitPrice: 1, units: 8000000, leverage: 0 },
      { type: "應收款", account: "親友借款", currency: "TWD", fxRate: 1, unitPrice: 1, units: 100000, leverage: 0 },
      { type: "負債", account: "房屋貸款", currency: "TWD", fxRate: 1, unitPrice: 1, units: 5000000, leverage: 0 },
    ];
    return raw.map((r) =>
      normalizeRec({ id: uid(), date: today, note: r.note || "", amount: 0, ...r })
    );
  }

  function round2(n) {
    return Math.round((Number(n) || 0) * 100) / 100;
  }

  // 原幣金額（未換算台幣）＝ 單價 × 單位/額數
  function origAmount(rec) {
    return round2((Number(rec.unitPrice) || 0) * (Number(rec.units) || 0));
  }

  // 金額（台幣）＝ 單價 × 單位/額數 × 匯率
  function amountTWD(rec) {
    return round2(
      (Number(rec.unitPrice) || 0) * (Number(rec.units) || 0) * (Number(rec.fxRate) || 1)
    );
  }

  // 曝險金額 = 台幣金額 * 槓桿倍數（非投資槓桿=0，曝險金額即為 0）
  function exposureTWD(rec) {
    const lev = Number(rec.leverage);
    return round2(amountTWD(rec) * (isNaN(lev) ? 1 : lev));
  }

  // 判斷單筆資料是否為「不計入」：統一處理 1/true 為不計入，0/false/null/undefined/
  // 欄位不存在一律視為「計入」，避免舊資料或型別不一致造成篩選誤判。
  function isExcluded(rec) {
    return !!rec && (rec.excluded === 1 || rec.excluded === true);
  }

  // 依設定單位（元/萬元）格式化金額顯示
  function formatAmount(value, settings) {
    const v = Number(value) || 0;
    if (settings && settings.unit === "wan") {
      return (v / 10000).toLocaleString("zh-TW", { maximumFractionDigits: 2 }) + " 萬元";
    }
    return Math.round(v).toLocaleString("zh-TW") + " 元";
  }

  function formatPercent(value, digits = 1) {
    if (!isFinite(value)) return "-";
    return (value * 100).toFixed(digits) + "%";
  }

  // ---------- CSV 匯出/匯入（使用 PapaParse） ----------
  const CSV_COLUMNS = [
    { key: "type", label: "類型" },
    { key: "account", label: "帳戶/項目" },
    { key: "date", label: "日期" },
    { key: "note", label: "備註" },
    { key: "currency", label: "幣別" },
    { key: "unitPrice", label: "價格" },
    { key: "fxRate", label: "匯率" },
    { key: "units", label: "單位" },
    { key: "amount", label: "金額" },
    { key: "leverage", label: "槓桿倍數" },
    { key: "exposure", label: "曝險金額" },
    { key: "excluded", label: "不計入" },
  ];

  // 匯入時忽略的欄位（金額、曝險金額為計算欄位，以程式計算為準）
  const CSV_IGNORE_ON_IMPORT = ["amount", "exposure"];

  function exportCSV(records, settings) {
    if (typeof Papa === "undefined") {
      throw new Error("PapaParse 函式庫未載入（CDN 連線失敗），無法匯出 CSV。");
    }
    const rows = records.map((r) => {
      const o = {};
      CSV_COLUMNS.forEach((c) => {
        if (c.key === "amount") o[c.label] = amountTWD(r);
        else if (c.key === "exposure") o[c.label] = exposureTWD(r);
        else if (c.key === "excluded") o[c.label] = r.excluded ? 1 : 0;
        else if (c.key === "date") o[c.label] = normalizeDate(r.date);
        else if (c.key === "type") o[c.label] = categoryDisplayName(settings, r.type);
        else o[c.label] = r[c.key];
      });
      return o;
    });
    const csv = Papa.unparse(rows, { columns: CSV_COLUMNS.map((c) => c.label) });
    const bom = "\uFEFF"; // 確保 Excel 開啟中文不亂碼
    const blob = new Blob([bom + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `資產負債明細_${todayStr()}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // 解析數字（去除千分位逗號、空白），空值或非數字則回傳預設值
  function numOr(val, dflt) {
    const s = String(val == null ? "" : val).replace(/,/g, "").trim();
    if (s === "") return dflt;
    const n = Number(s);
    return isNaN(n) ? dflt : n;
  }

  // 正規化日期：接受 yyyy/mm/dd 或 yyyy-mm-dd，輸出 yyyy-mm-dd；空值或無法解析則回傳 ""
  function normalizeDate(val) {
    const s = String(val == null ? "" : val).trim();
    if (s === "") return "";
    const m = s.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
    if (!m) return "";
    const y = m[1];
    const mo = String(m[2]).padStart(2, "0");
    const d = String(m[3]).padStart(2, "0");
    return `${y}-${mo}-${d}`;
  }

  function parseCSV(file, settings, accounts) {
    return new Promise((resolve, reject) => {
      if (typeof Papa === "undefined") {
        reject(new Error("PapaParse 函式庫未載入（CDN 連線失敗），無法匯入 CSV。"));
        return;
      }
      const typeNameToKey = buildTypeNameToKey(settings);
      Papa.parse(file, {
        header: true,
        skipEmptyLines: true,
        encoding: "UTF-8",
        complete: (result) => {
          try {
            const labelToKey = {};
            CSV_COLUMNS.forEach((c) => (labelToKey[c.label] = c.key));
            // 相容舊版匯出的欄位名稱
            labelToKey["單價"] = "unitPrice";
            labelToKey["單位數"] = "units";
            labelToKey["槓桿率"] = "leverage";

            let skipped = 0;
            const records = [];
            result.data.forEach((row) => {
              // 先把每個欄位標題對應到 raw 值
              const raw = {};
              Object.keys(row).forEach((label) => {
                const key = labelToKey[label.trim()];
                if (key) raw[key] = row[label];
              });

              // 類型：接受內部鍵或自訂顯示名稱，轉回內部鍵；不符或空則跳過整列
              const rawType = String(raw.type == null ? "" : raw.type).trim();
              const type = typeNameToKey[rawType];
              if (!type) {
                skipped++;
                return;
              }

              const rec = emptyRecord(type);
              rec.type = type;
              // 帳戶/項目、備註：文字，空值可匯入
              rec.account = String(raw.account == null ? "" : raw.account).trim();
              rec.note = String(raw.note == null ? "" : raw.note).trim();
              // 日期：yyyy/mm/dd 或 yyyy-mm-dd，空值可匯入（留空）
              rec.date = normalizeDate(raw.date);
              // 單價：數字，空值預設 1
              rec.unitPrice = numOr(raw.unitPrice, 1);
              // 幣別：值域為「設定 > 幣別」清單，空值或不符預設 baseCurrency
              const cur = String(raw.currency == null ? "" : raw.currency).trim().toUpperCase();
              const codes = currencyCodes(settings);
              rec.currency = codes.includes(cur) ? cur : settings.baseCurrency || "TWD";
              // 匯率：與「設定 > 幣別」連動——依幣別代入設定匯率；查無則退回 CSV 值或 1
              const settingRate = currencyRate(settings, rec.currency);
              rec.fxRate = settingRate != null ? settingRate : numOr(raw.fxRate, 1);
              // 單位數：空值預設 0
              rec.units = numOr(raw.units, 0);
              // 槓桿倍數：優先讀取「設定 > 帳戶」對應項目的設定值並寫入明細；
              // 查無設定時退回 CSV 值（空值預設：投資=1，其餘=0）
              const cfgLev = lookupAccountLeverage(accounts, type, rec.account);
              rec.leverage =
                cfgLev != null ? cfgLev : numOr(raw.leverage, type === "投資" ? 1 : 0);
              // 不計入：值域 0/1，空值預設 0
              rec.excluded = numOr(raw.excluded, 0) === 1 ? 1 : 0;

              // 非投資：價格固定 1（槓桿倍數改由帳戶設定決定，不再固定 0）
              if (rec.type !== "投資") {
                rec.unitPrice = 1;
              }

              // 金額、曝險金額為計算欄位，匯入時不寫入，由功能計算
              rec.amount = amountTWD(rec);
              rec.id = uid();
              records.push(rec);
            });
            records.__skipped = skipped;
            resolve(records);
          } catch (e) {
            reject(e);
          }
        },
        error: (err) => reject(err),
      });
    });
  }

  // ---------- 帳戶/項目設定 CSV 匯出/匯入 ----------
  // 欄位：類別（顯示名稱）、帳戶/項目、價格、槓桿倍數
  const ACCOUNT_CSV_COLUMNS = [
    { key: "category", label: "類別" },
    { key: "account", label: "帳戶/項目" },
    { key: "price", label: "價格" },
    { key: "leverage", label: "槓桿倍數" },
  ];

  function exportAccountsCSV(accounts, settings) {
    if (typeof Papa === "undefined") {
      throw new Error("PapaParse 函式庫未載入（CDN 連線失敗），無法匯出 CSV。");
    }
    const rows = (accounts || []).map((a) => ({
      類別: categoryDisplayName(settings, a.category),
      "帳戶/項目": a.account,
      價格: Number(a.price) || 0,
      槓桿倍數: Number(a.leverage) || 0,
    }));
    const csv = Papa.unparse(rows, { columns: ACCOUNT_CSV_COLUMNS.map((c) => c.label) });
    const bom = "\uFEFF";
    const blob = new Blob([bom + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `帳戶項目設定_${todayStr()}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // 解析帳戶/項目設定 CSV，回傳帳戶物件陣列（含新 id）。類別不符或空白則跳過整列。
  function parseAccountsCSV(file, settings) {
    return new Promise((resolve, reject) => {
      if (typeof Papa === "undefined") {
        reject(new Error("PapaParse 函式庫未載入（CDN 連線失敗），無法匯入 CSV。"));
        return;
      }
      const typeNameToKey = buildTypeNameToKey(settings);
      Papa.parse(file, {
        header: true,
        skipEmptyLines: true,
        encoding: "UTF-8",
        complete: (result) => {
          try {
            let skipped = 0;
            const accounts = [];
            result.data.forEach((row) => {
              const get = (label) => {
                const k = Object.keys(row).find((x) => x.trim() === label);
                return k ? row[k] : "";
              };
              // 類別：接受內部鍵或自訂顯示名稱，轉回內部鍵；不符或空則跳過整列
              const rawCat = String(get("類別") || "").trim();
              const category = typeNameToKey[rawCat];
              if (!category) {
                skipped++;
                return;
              }
              const account = String(get("帳戶/項目") || "").trim();
              const price = numOr(get("價格"), 1);
              // 槓桿倍數：空值預設依類別（投資=1，其餘=0）
              const leverage = numOr(get("槓桿倍數"), category === "投資" ? 1 : 0);
              // CSV 格式不含 sortOrder 欄位，依匯入（解析）順序補上 1,2,3...，
              // 確保重新整理後帳戶順序與匯入時一致。
              accounts.push({ id: uid(), category, account, price, leverage, sortOrder: accounts.length + 1 });
            });
            accounts.__skipped = skipped;
            resolve(accounts);
          } catch (e) {
            reject(e);
          }
        },
        error: (err) => reject(err),
      });
    });
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
    a.download = `同步記錄_${todayStr()}.json`;
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
        ? (settings.customColor || "#5b8cff")
        : (THEME_COLORS[settings.themeColor] || THEME_COLORS.grayBlue).accent;
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
    CSV_COLUMNS,
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
    categoryDisplayName,
    buildTypeNameToKey,
    normalizeCurrencies,
    currencyCodes,
    currencyRate,
    emptyCurrency,
    exportAccountsCSV,
    parseAccountsCSV,
    appendSyncLog,
    exportSyncLogsJSON,
    SYNC_LOG_MAX,
    SYNC_LOG_PREVIEW_MAX,
    SYNC_LOG_TOTAL_PREVIEW_MAX,
    emptyRecord,
    uid,
    todayStr,
    round2,
    origAmount,
    amountTWD,
    exposureTWD,
    isExcluded,
    normalizeRec,
    formatAmount,
    formatPercent,
    exportCSV,
    parseCSV,
    seedRecords,
    applyTheme,
  };
})();
