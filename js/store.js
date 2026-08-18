/*
 * store.js
 * 負責資料持久化（localStorage）、資料 schema 定義、CSV 匯入匯出、
 * 以及跨頁面共用的計算工具函式。
 * 資料完全存放於瀏覽器本地（localStorage），不會上傳到任何伺服器。
 */

const ALD = (() => {
  const RECORDS_KEY = "ald_records_v1";
  const SETTINGS_KEY = "ald_settings_v1";

  // 資料來源類型（依規格固定五種）
  const TYPES = ["流動資金", "投資", "固定資產", "應收款", "負債"];

  // 屬於「資產」的類型（用於總覽資產加總、負債比計算）
  const ASSET_TYPES = ["流動資金", "投資", "固定資產", "應收款"];

  const DEFAULT_SETTINGS = {
    unit: "yuan", // 'yuan' = 元, 'wan' = 萬元
    autoFx: false, // 是否自動抓取即時匯率
    autoStock: false, // 是否自動抓取股票市值
    baseCurrency: "TWD",
    rebalanceRatio: 70, // 再平衡：投資目標佔比(%)，預設 70% -> 流動:投資 = 3:7
    themeMode: "dark", // 'dark' | 'light'
    themeColor: "blue", // 主題配色（見 THEME_COLORS）
    fontFamily: "system", // 字型（見 FONT_FAMILIES）
    fontSize: "md", // 字型大小（見 FONT_SIZES）
  };

  // 主題配色：切換 --accent（按鈕/選中狀態等主色）
  const THEME_COLORS = {
    blue: { label: "藍色", accent: "#5b8cff" },
    green: { label: "綠色", accent: "#35c98f" },
    purple: { label: "紫色", accent: "#9b6bff" },
    orange: { label: "橘色", accent: "#ff9f43" },
    pink: { label: "粉色", accent: "#ff6b9d" },
    beige: { label: "米色", accent: "#c9a875" },
    gray: { label: "灰色", accent: "#8a8d99" },
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

  function todayStr() {
    const d = new Date();
    return d.toISOString().slice(0, 10);
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

  // 正規化單筆資料：確保數值型別、非投資鎖定 單價=1/槓桿=1，並重算金額。
  // 同時提供舊資料遷移：舊版非投資把金額存在 amount，這裡改用 單位/額數 承載。
  function normalizeRec(rec) {
    rec.unitPrice = Number(rec.unitPrice) || 0;
    rec.units = Number(rec.units) || 0;
    rec.fxRate = Number(rec.fxRate) || 1;
    rec.leverage = Number(rec.leverage) || 1;
    rec.excluded = rec.excluded ? 1 : 0;
    if (rec.type !== "投資") {
      // 舊資料遷移：非投資若無單位/額數但有金額，把金額搬到單位/額數
      if (!rec.units && Number(rec.amount)) rec.units = Number(rec.amount) || 0;
      rec.unitPrice = 1;
      rec.leverage = 0; // 非投資槓桿倍數固定為 0
    }
    rec.amount = round2(rec.unitPrice * rec.units * rec.fxRate);
    return rec;
  }

  function loadRecords() {
    try {
      const raw = localStorage.getItem(RECORDS_KEY);
      // 只有「從未初始化」（null）時才載入模擬資料；
      // 已明確清空（[]）時應維持空白，避免清除後又被重新種入資料
      if (raw === null) return seedRecords();
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return seedRecords();
      return arr.map(normalizeRec);
    } catch (e) {
      console.error("讀取本地資料失敗", e);
      return seedRecords();
    }
  }

  function saveRecords(records) {
    localStorage.setItem(RECORDS_KEY, JSON.stringify(records));
  }

  function loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (!raw) return { ...DEFAULT_SETTINGS };
      return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    } catch (e) {
      return { ...DEFAULT_SETTINGS };
    }
  }

  function saveSettings(settings) {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
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

  function exportCSV(records) {
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

  function parseCSV(file) {
    return new Promise((resolve, reject) => {
      if (typeof Papa === "undefined") {
        reject(new Error("PapaParse 函式庫未載入（CDN 連線失敗），無法匯入 CSV。"));
        return;
      }
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

              // 類型：值域檢查，不符或空則跳過整列
              const type = String(raw.type == null ? "" : raw.type).trim();
              if (!TYPES.includes(type)) {
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
              // 幣別：值域 TWD/USD，空值或不符預設 TWD
              const cur = String(raw.currency == null ? "" : raw.currency).trim().toUpperCase();
              rec.currency = cur === "USD" || cur === "TWD" ? cur : "TWD";
              // 匯率：空值預設 1
              rec.fxRate = numOr(raw.fxRate, 1);
              // 單位數：空值預設 0
              rec.units = numOr(raw.units, 0);
              // 槓桿倍數：空值預設 0
              rec.leverage = numOr(raw.leverage, 0);
              // 不計入：值域 0/1，空值預設 0
              rec.excluded = numOr(raw.excluded, 0) === 1 ? 1 : 0;

              // 非投資：價格固定 1、槓桿倍數固定 0（維持資料模型一致）
              if (rec.type !== "投資") {
                rec.unitPrice = 1;
                rec.leverage = 0;
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

  // 依設定套用外觀主題：設定 CSS 變數（配色/字型/字型大小）與淺色模式 class
  function applyTheme(settings) {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    const color = THEME_COLORS[settings.themeColor] || THEME_COLORS.blue;
    const font = FONT_FAMILIES[settings.fontFamily] || FONT_FAMILIES.system;
    const size = FONT_SIZES[settings.fontSize] || FONT_SIZES.md;
    root.style.setProperty("--accent", color.accent);
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
    loadRecords,
    saveRecords,
    loadSettings,
    saveSettings,
    emptyRecord,
    uid,
    todayStr,
    round2,
    origAmount,
    amountTWD,
    exposureTWD,
    normalizeRec,
    formatAmount,
    formatPercent,
    exportCSV,
    parseCSV,
    seedRecords,
    applyTheme,
  };
})();
