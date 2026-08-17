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
  const TYPES = ["流動資產", "投資", "固定資產", "應收款", "負債"];

  // 屬於「資產」的類型（用於總覽資產加總、負債比計算）
  const ASSET_TYPES = ["流動資產", "投資", "固定資產", "應收款"];

  const DEFAULT_SETTINGS = {
    unit: "yuan", // 'yuan' = 元, 'wan' = 萬元
    autoFx: false, // 是否自動抓取即時匯率
    autoStock: false, // 是否自動抓取股票市值
    baseCurrency: "TWD",
    rebalanceRatio: 70, // 再平衡：投資目標佔比(%)，預設 70% -> 流動:投資 = 3:7
  };

  function uid() {
    return "r" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function todayStr() {
    const d = new Date();
    return d.toISOString().slice(0, 10);
  }

  function emptyRecord(type) {
    return {
      id: uid(),
      type: type || "流動資產",
      account: "",
      date: todayStr(),
      note: "",
      unitPrice: 0,
      currency: "TWD",
      fxRate: 1,
      units: 0,
      amount: 0,
      leverage: 1,
    };
  }

  function loadRecords() {
    try {
      const raw = localStorage.getItem(RECORDS_KEY);
      if (!raw) return seedRecords();
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr) || arr.length === 0) return seedRecords();
      return arr;
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

  // 首次使用提供的範例資料，方便使用者了解畫面呈現方式
  function seedRecords() {
    const today = todayStr();
    return [
      { id: uid(), type: "流動資產", account: "銀行活存-台幣", date: today, note: "", unitPrice: 0, currency: "TWD", fxRate: 1, units: 0, amount: 300000, leverage: 1 },
      { id: uid(), type: "流動資產", account: "銀行活存-美金", date: today, note: "", unitPrice: 0, currency: "USD", fxRate: 32.5, units: 0, amount: 5000, leverage: 1 },
      { id: uid(), type: "投資", account: "0050 元大台灣50", date: today, note: "", unitPrice: 140, currency: "TWD", fxRate: 1, units: 2000, amount: 280000, leverage: 1 },
      { id: uid(), type: "投資", account: "VOO", date: today, note: "美股ETF", unitPrice: 480, currency: "USD", fxRate: 32.5, units: 30, amount: 14400, leverage: 1.5 },
      { id: uid(), type: "固定資產", account: "自住房產", date: today, note: "", unitPrice: 0, currency: "TWD", fxRate: 1, units: 0, amount: 8000000, leverage: 1 },
      { id: uid(), type: "應收款", account: "親友借款", date: today, note: "", unitPrice: 0, currency: "TWD", fxRate: 1, units: 0, amount: 100000, leverage: 1 },
      { id: uid(), type: "負債", account: "房屋貸款", date: today, note: "", unitPrice: 0, currency: "TWD", fxRate: 1, units: 0, amount: 5000000, leverage: 1 },
    ];
  }

  function round2(n) {
    return Math.round((Number(n) || 0) * 100) / 100;
  }

  // 換算為台幣（金額 * 匯率）
  function amountTWD(rec) {
    return round2((Number(rec.amount) || 0) * (Number(rec.fxRate) || 1));
  }

  // 曝險金額 = 台幣金額 * 槓桿率
  function exposureTWD(rec) {
    return round2(amountTWD(rec) * (Number(rec.leverage) || 1));
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
    { key: "unitPrice", label: "單價" },
    { key: "currency", label: "幣別" },
    { key: "fxRate", label: "匯率" },
    { key: "units", label: "單位數" },
    { key: "amount", label: "金額" },
    { key: "leverage", label: "槓桿率" },
  ];

  function exportCSV(records) {
    const rows = records.map((r) => {
      const o = {};
      CSV_COLUMNS.forEach((c) => (o[c.label] = r[c.key]));
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

  function parseCSV(file) {
    return new Promise((resolve, reject) => {
      Papa.parse(file, {
        header: true,
        skipEmptyLines: true,
        encoding: "UTF-8",
        complete: (result) => {
          try {
            const labelToKey = {};
            CSV_COLUMNS.forEach((c) => (labelToKey[c.label] = c.key));
            const records = result.data.map((row) => {
              const rec = emptyRecord();
              Object.keys(row).forEach((label) => {
                const key = labelToKey[label.trim()];
                if (!key) return;
                if (["unitPrice", "fxRate", "units", "amount", "leverage"].includes(key)) {
                  rec[key] = Number(row[label]) || 0;
                } else {
                  rec[key] = row[label] || "";
                }
              });
              rec.id = uid();
              if (!TYPES.includes(rec.type)) rec.type = "流動資產";
              return rec;
            });
            resolve(records);
          } catch (e) {
            reject(e);
          }
        },
        error: (err) => reject(err),
      });
    });
  }

  return {
    TYPES,
    ASSET_TYPES,
    CSV_COLUMNS,
    loadRecords,
    saveRecords,
    loadSettings,
    saveSettings,
    emptyRecord,
    uid,
    todayStr,
    round2,
    amountTWD,
    exposureTWD,
    formatAmount,
    formatPercent,
    exportCSV,
    parseCSV,
    seedRecords,
  };
})();
