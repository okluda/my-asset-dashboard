/*
 * app.js
 * Vue 3 應用進入點：定義共用 store（reactive，含 IndexedDB 自動存檔，見 js/db.js 的 ALD_DB）、
 * 4 個分頁元件（總覽/再平衡/明細/設定），以及底部分頁列。
 * 正式資料來源為 IndexedDB：App 啟動時透過 ALD_DB 讀取，並於 store 變更時 debounce 回寫；
 * store.js 僅保留 schema 定義、CSV 匯入匯出與計算工具函式，不再負責任何資料持久化。
 */

// 內部網路可能無法連到 unpkg.com，導致 Vue CDN 載入失敗。
// 此時整個 App 無法運作（按鈕全部失效），先給出明確提示而非讓程式拋出難懂錯誤。
if (typeof Vue === "undefined") {
  var __msg =
    "無法載入 Vue 函式庫（CDN：unpkg.com）。\n" +
    "常見原因：內部網路無法連外。\n" +
    "解法：改用可連外的網路開啟，或將 vue.global.prod.js 與 papaparse.min.js 下載到本機（例如 libs/ 目錄）後，改為本地路徑引用。";
  if (window.__showAppError) window.__showAppError(__msg);
  throw new Error(__msg);
}

const { createApp, reactive, computed, watch, ref, onMounted, onUnmounted, nextTick } = Vue;

// ---------- IndexedDB 初始化輔助（階段二：App 正式資料來源改為 IndexedDB） ----------

// 舊版股價來源設定 → 新版 Provider/Connection 解耦架構 的遷移規則：
//   - 舊 stockProviderTW/US === 'yahooProxy' → provider = 'yahoo'，connection 補為 'proxy'
//   - 舊 customProxyUrl（單一欄位，台美共用）→ 分別種入 proxyUrlTW / proxyUrlUS（尚未設定時才填入）
//   - 舊 stockProxyProvider（公開 proxy 選擇：corsproxy/allorigins/thingproxy）不保留，
//     因本次移除所有內建公開 CORS proxy；但保留「proxy 模式」本身（見上一點的 connectionMode 補值）
// 僅在讀到舊版 raw 設定時才動作，全新使用者（raw 為 null）不受影響。
function migrateLegacySettings(raw) {
  if (!raw) return raw;
  const s = { ...raw };
  ["TW", "US"].forEach((mkt) => {
    const providerKey = "stockProvider" + mkt;
    const connKey = "connectionMode" + mkt;
    if (s[providerKey] === "yahooProxy") {
      s[providerKey] = "yahoo";
      if (!s[connKey]) s[connKey] = "proxy";
    }
    const proxyUrlKey = "proxyUrl" + mkt;
    if (s.customProxyUrl && !s[proxyUrlKey]) {
      s[proxyUrlKey] = s.customProxyUrl;
    }
  });
  delete s.customProxyUrl;
  delete s.stockProxyProvider;
  return s;
}

// settings 合併規則：確保 IndexedDB 讀到的 settings 缺少新欄位時，仍套用目前的預設值
// 與正規化規則（與 ALD.DEFAULT_SETTINGS / ALD.normalizeCurrencies 的定義保持一致）。
function mergeSettings(raw) {
  const s = { ...ALD.DEFAULT_SETTINGS, ...migrateLegacySettings(raw) };
  ALD.normalizeCurrencies(s);
  return s;
}

// 帳戶設定正規化規則：確保 IndexedDB 讀到的帳戶資料型別正確、缺值時帶入合理預設值
// （與 ALD.emptyAccount 的預設規則一致：投資類型槓桿倍數預設 1，其餘為 0）。
// fallbackOrder：舊資料（IndexedDB getAll() 讀出，不保證順序）若無 sortOrder，
// 依目前載入順序補值（呼叫端傳入 1-based 索引），確保重新整理後仍有明確順序可排序。
function normalizeAccount(a, fallbackOrder, settings, records) {
  const category = ALD.TYPES.includes(a.category) ? a.category : "流動資金";
  const account = String(a.account == null ? "" : a.account).trim();
  const configuredCurrency = String(a.currency == null ? "" : a.currency).trim().toUpperCase();
  if (configuredCurrency && !ALD.currencyCodes(settings).includes(configuredCurrency)) {
    throw new Error(`存放帳戶「${account || "(未命名)"}」的幣別「${configuredCurrency}」不在幣別設定中。`);
  }
  const recordCurrencies = [
    ...new Set(
      (records || [])
        .filter((rec) => account && rec.account === account && rec.currency)
        .map((rec) => rec.currency)
    ),
  ];
  if (recordCurrencies.length > 1) {
    throw new Error(`存放帳戶「${account}」的既有明細使用多種幣別：${recordCurrencies.join("、")}。`);
  }
  const currency =
    ALD.currencyCodes(settings).includes(configuredCurrency)
      ? configuredCurrency
      : recordCurrencies[0] || settings.baseCurrency || "TWD";
  return {
    id: a.id || ALD.uid(),
    category,
    account,
    currency,
    price: Number(a.price) || 0,
    leverage: a.leverage == null ? (category === "投資" ? 1 : 0) : Number(a.leverage) || 0,
    sortOrder: a.sortOrder == null || isNaN(Number(a.sortOrder)) ? fallbackOrder : Number(a.sortOrder),
  };
}

// 「清除所有本地資料」用：就地把 settings 重設為最小必要設定，
// 不可整個替換 store.settings 物件參考（元件於 setup() 已持有舊物件參考，整個替換會失去響應）。
function applyDefaultSettingsInPlace(settingsObj) {
  const fresh = JSON.parse(JSON.stringify(ALD.DEFAULT_SETTINGS));
  Object.keys(settingsObj).forEach((k) => {
    if (!(k in fresh)) delete settingsObj[k];
  });
  Object.assign(settingsObj, fresh);
  ALD.normalizeCurrencies(settingsObj);
}

// 初始化載入/錯誤畫面：掛載主要 App 前尚無 Vue 元件可用，直接操作 #app 的 DOM。
function showInitLoading(msg) {
  const el = document.getElementById("app");
  if (el) el.innerHTML = '<div class="app-init-status">' + msg + "</div>";
}
function showInitError(msg) {
  const el = document.getElementById("app");
  if (el) {
    el.innerHTML =
      '<div class="app-init-status app-init-error">' + String(msg).replace(/\n/g, "<br>") + "</div>";
  }
  if (window.__showAppError) window.__showAppError(msg);
  console.error(msg);
}

// 依資料種類（records/settings/accounts）各自 debounce 後才寫回 IndexedDB，避免每個字元
// 輸入都建立一次 transaction；同一種資料的實際寫入以 Promise 串接（chain）依呼叫順序執行，
// 確保較舊的寫入不會晚於較新的寫入完成而覆蓋新狀態。寫入失敗只顯示錯誤，不中斷 App，
// 且錯誤一律於 saveFn 的 .catch 內處理，不會產生未處理的 Promise rejection。
function createDebouncedSaver(saveFn, label, delay) {
  let timer = null;
  let pending = null;
  let hasPending = false;
  let chain = Promise.resolve();
  function flush() {
    if (!hasPending) return;
    const snapshot = pending;
    pending = null;
    hasPending = false;
    chain = chain.then(() => saveFn(snapshot)).catch((e) => {
      const detail = e && e.stack ? e.stack : e && e.message ? e.message : String(e);
      console.error(label + " 寫入 IndexedDB 失敗：", e);
      if (window.__showAppError) {
        window.__showAppError(label + " 寫入 IndexedDB 失敗：\n" + detail);
      }
    });
  }
  return function schedule(value) {
    pending = value;
    hasPending = true;
    clearTimeout(timer);
    timer = setTimeout(flush, delay);
  };
}

const SAVE_DEBOUNCE_MS = 500;
const saveRecordsDebounced = createDebouncedSaver((v) => ALD_DB.replaceRecords(v), "明細", SAVE_DEBOUNCE_MS);
const saveSettingsDebounced = createDebouncedSaver((v) => ALD_DB.saveSettings(v), "系統設定", SAVE_DEBOUNCE_MS);
const saveAccountsDebounced = createDebouncedSaver((v) => ALD_DB.replaceAccounts(v), "帳戶設定", SAVE_DEBOUNCE_MS);
const saveSyncLogsDebounced = createDebouncedSaver((v) => ALD_DB.replaceSyncLogs(v), "同步記錄", SAVE_DEBOUNCE_MS);

// ---------- 共用 reactive store ----------
// 於非同步初始化流程（openDatabase -> 讀取三個 store -> 判斷首次使用 -> 建立 store）
// 完成後才會賦值；元件的 setup() 只在 app.mount() 之後才會實際執行，屆時 store 已就緒。
let store;

// ---------- 總覽 ----------
const TabOverview = {
  template: "#tpl-overview",
  setup() {
    const totalAssets = computed(() =>
      ALD.round2(
        store.records
          .filter((r) => !r.excluded && ALD.ASSET_TYPES.includes(r.type))
          .reduce((sum, r) => sum + ALD.amountTWD(r), 0)
      )
    );
    const totalLiabilities = computed(() =>
      ALD.round2(
        store.records
          .filter((r) => !r.excluded && r.type === "負債")
          .reduce((sum, r) => sum + ALD.amountTWD(r), 0)
      )
    );
    const netAssets = computed(() => ALD.round2(totalAssets.value - totalLiabilities.value));
    const liabilityRatio = computed(() =>
      totalAssets.value > 0 ? totalLiabilities.value / totalAssets.value : 0
    );

    const breakdown = computed(() => {
      return ALD.ASSET_TYPES.map((type) => {
        const amount = ALD.round2(
          store.records
            .filter((r) => !r.excluded && r.type === type)
            .reduce((sum, r) => sum + ALD.amountTWD(r), 0)
        );
        const ratio = totalAssets.value > 0 ? amount / totalAssets.value : 0;
        return { type, amount, ratio, color: ALD.chartColor(ALD.ASSET_TYPES.indexOf(type)) };
      });
    });

    const hidden = computed(() => !!store.settings.hideAmounts);
    function toggleHidden() {
      store.settings.hideAmounts = !store.settings.hideAmounts;
    }
    return {
      totalAssets,
      totalLiabilities,
      netAssets,
      liabilityRatio,
      breakdown,
      hidden,
      toggleHidden,
      fmt: (v) => (hidden.value ? "***" : ALD.formatAmount(v, store.settings)),
      fmtNum: (v) => (hidden.value ? "***" : ALD.formatAmountNum(v, store.settings)),
      pct: (v) => ALD.formatPercent(v),
      catName: (t) => ALD.categoryDisplayName(store.settings, t),
    };
  },
};

// ---------- 資產（負債） ----------
// 「我的資產／我的負債」切換狀態：模組層級 ref，供標題列（App）、底部分頁列文字與 TabAssets 共用；
// 不寫入設定，重新整理後回到「我的資產」。
const assetsView = ref("asset");

// 區段（segment）排序：現金 → 投資 → 應收款 → 固定資產；同類型內台幣/台股 → 美元/美股 → 其他幣別
const SEGMENT_KIND_ORDER = { cash: 0, inv: 1, recv: 2, fixed: 3 };
const SEGMENT_CUR_LABEL = {
  cash: { TWD: "台幣", USD: "美元" },
  inv: { TWD: "台股", USD: "美股" },
};

const SEGMENT_KIND_TYPE = { cash: "流動資金", inv: "投資", recv: "應收款", fixed: "固定資產" };

const TabAssets = {
  template: "#tpl-assets",
  setup() {
    const settings = store.settings;
    const hidden = computed(() => !!settings.hideAmounts);
    const fmt = (v) => (hidden.value ? "***" : ALD.formatAmount(v, settings));
    const fmtNum = (v) => (hidden.value ? "***" : ALD.formatAmountNum(v, settings));
    const num = (v) =>
      hidden.value ? "***" : (Number(v) || 0).toLocaleString("zh-TW", { maximumFractionDigits: 2 });
    const pct = (v) => ALD.formatPercent(v);
    const pctWhole = (v) => `${Math.round((Number(v) || 0) * 100)}%`;
    const catName = (t) => ALD.categoryDisplayName(settings, t);

    const showExcludedAccounts = ref(false);
    const assetRecs = computed(() =>
      store.records.filter((r) => !r.excluded && ALD.ASSET_TYPES.includes(r.type))
    );
    const accountAssetRecs = computed(() =>
      store.records.filter(
        (r) =>
          ALD.ASSET_TYPES.includes(r.type) &&
          (showExcludedAccounts.value || !r.excluded)
      )
    );
    const totalAssets = computed(() =>
      ALD.round2(assetRecs.value.reduce((s, r) => s + ALD.amountTWD(r), 0))
    );
    const breakdown = computed(() =>
      ALD.ASSET_TYPES.map((type, i) => {
        const amount = ALD.round2(
          assetRecs.value.filter((r) => r.type === type).reduce((s, r) => s + ALD.amountTWD(r), 0)
        );
        return {
          type,
          amount,
          ratio: totalAssets.value > 0 ? amount / totalAssets.value : 0,
          color: ALD.chartColor(i),
        };
      })
    );

    // row 2：流動資金按幣別、投資按帳戶、固定資產與應收款各合併一組，僅顯示比例最高的五項。
    const ratioItems = computed(() => {
      const map = {};
      const add = (key, label, amount) => {
        if (!map[key]) map[key] = { key, label, amount: 0 };
        map[key].amount = ALD.round2(map[key].amount + amount);
      };
      assetRecs.value.forEach((rec) => {
        const amount = ALD.amountTWD(rec);
        if (rec.type === "流動資金") {
          const currency = rec.currency || settings.baseCurrency || "TWD";
          add(`cash:${currency}`, SEGMENT_CUR_LABEL.cash[currency] || currency, amount);
        } else if (rec.type === "投資") {
          add(`inv:${rec.account || "(未命名)"}`, rec.account || "(未命名)", amount);
        } else if (rec.type === "固定資產") {
          add("fixed", catName("固定資產"), amount);
        } else {
          add("recv", catName("應收款"), amount);
        }
      });
      return Object.values(map)
        .map((item) => ({
          ...item,
          ratio: totalAssets.value > 0 ? item.amount / totalAssets.value : 0,
        }))
        .sort((a, b) => b.ratio - a.ratio || a.label.localeCompare(b.label, "zh-Hant"))
        .slice(0, 5)
        .map((item, index) => ({ ...item, color: ALD.chartColor(index) }));
    });

    // 每筆資產紀錄對應到一個區段；固定的 5 個流動資產區段與固定資產區段即使沒有資料也保留（金額 0），
    // 其他幣別（設定中另外新增的幣別）有資料才出現。
    function makeSegment(kind, cur) {
      let key, label;
      if (kind === "recv") {
        key = "recv";
        label = catName("應收款");
      } else if (kind === "fixed") {
        key = "fixed";
        label = catName("固定資產");
      } else {
        key = kind + ":" + cur;
        label = SEGMENT_CUR_LABEL[kind][cur] || (kind === "cash" ? cur : cur + " 投資");
      }
      const curRank = cur === "TWD" ? 0 : cur === "USD" ? 1 : 2;
      return {
        key,
        kind,
        cur: kind === "recv" || kind === "fixed" ? "" : cur,
        label,
        group: kind === "fixed" ? "noncurrent" : "current",
        order: SEGMENT_KIND_ORDER[kind] * 10 + curRank,
        amount: 0,
        records: [],
      };
    }
    function segmentKeyOf(r) {
      const cur = r.currency || "TWD";
      if (r.type === "流動資金") return { kind: "cash", cur };
      if (r.type === "投資") return { kind: "inv", cur };
      if (r.type === "應收款") return { kind: "recv", cur: "" };
      return { kind: "fixed", cur: "" };
    }
    const segments = computed(() => {
      const map = {};
      const ensure = (kind, cur) => {
        const seg = makeSegment(kind, cur);
        if (!map[seg.key]) map[seg.key] = seg;
        return map[seg.key];
      };
      ensure("cash", "TWD");
      ensure("cash", "USD");
      ensure("inv", "TWD");
      ensure("inv", "USD");
      ensure("recv", "");
      ensure("fixed", "");
      accountAssetRecs.value.forEach((r) => {
        const { kind, cur } = segmentKeyOf(r);
        const seg = ensure(kind, cur);
        seg.records.push(r);
        if (!r.excluded) seg.amount = ALD.round2(seg.amount + ALD.amountTWD(r));
      });
      return Object.values(map).sort((a, b) => a.order - b.order || (a.key < b.key ? -1 : 1));
    });

    const row3 = ref("current");
    const row4 = ref(["all"]);
    const row3Amount = (g) =>
      ALD.round2(segments.value.filter((s) => s.group === g).reduce((sum, s) => sum + s.amount, 0));
    const currentAmount = computed(() => row3Amount("current"));
    const noncurrentAmount = computed(() => row3Amount("noncurrent"));
    const availableSegments = computed(() => segments.value.filter((s) => s.group === row3.value));
    const row4Chips = computed(() => [
      {
        key: "all",
        label: "全部",
        amount: row3.value === "current" ? currentAmount.value : noncurrentAmount.value,
      },
      ...availableSegments.value.map((s) => ({ key: s.key, label: s.label, amount: s.amount })),
    ]);

    function selectRow3(g) {
      if (row3.value === g) return;
      row3.value = g;
      row4.value = ["all"];
    }
    function toggleRow4(key) {
      if (key === "all") {
        row4.value = ["all"];
        return;
      }
      const cur = row4.value.filter((k) => k !== "all");
      const idx = cur.indexOf(key);
      if (idx === -1) cur.push(key);
      else cur.splice(idx, 1);
      row4.value = cur.length ? cur : ["all"];
    }

    const selectedSegments = computed(() => {
      if (row4.value.includes("all")) return availableSegments.value;
      const picked = availableSegments.value.filter((s) => row4.value.includes(s.key));
      return picked.length ? picked : availableSegments.value;
    });
    const denominator = computed(() =>
      ALD.round2(selectedSegments.value.reduce((s, seg) => s + seg.amount, 0))
    );

    // 帳戶匯總：流動資金與投資按幣別分組，固定資產與應收款各自合併為一組。
    const groups = computed(() =>
      Object.values(
        selectedSegments.value
          .filter((seg) => seg.records.length > 0)
          .reduce((groupMap, seg) => {
            const key = seg.kind === "cash" || seg.kind === "inv" ? `${seg.kind}:${seg.cur}` : seg.kind;
            if (!groupMap[key]) {
              groupMap[key] = {
                key,
                label: seg.kind === "inv" ? SEGMENT_CUR_LABEL.inv[seg.cur] || seg.cur : seg.label,
                type: SEGMENT_KIND_TYPE[seg.kind],
                cur: seg.cur,
                invest: seg.kind === "inv",
                order: seg.order,
                records: [],
              };
            }
            groupMap[key].records.push(...seg.records);
            return groupMap;
          }, {})
      )
        .sort((a, b) => a.order - b.order)
        .map((group) => {
          const acctMap = {};
          group.records.forEach((r) => {
            const name = r.account || "(未命名)";
            if (!acctMap[name]) {
              acctMap[name] = { account: name, amountTWD: 0, amountOrig: 0, units: 0, exposureTWD: 0, leverage: ALD.effLeverage(r) };
            }
            const a = acctMap[name];
            if (!r.excluded) {
              a.amountTWD = ALD.round2(a.amountTWD + ALD.amountTWD(r));
              a.exposureTWD = ALD.round2(a.exposureTWD + ALD.exposureTWD(r));
            }
            a.amountOrig = ALD.round2(a.amountOrig + ALD.origAmount(r));
            a.units = ALD.round2(a.units + (Number(r.units) || 0));
          });
          const isForeign = !!group.cur && group.cur !== settings.baseCurrency;
          const accounts = Object.values(acctMap).map((a) => {
            let priceText = "";
            if (group.invest) {
              let price = ALD.lookupAccountPrice(store.accounts, "投資", a.account);
              if (!price) price = a.units > 0 ? a.amountOrig / a.units : 0;
              priceText = "$" + (Number(price) || 0).toLocaleString("zh-TW", { maximumFractionDigits: 4 });
            }
            return {
              ...a,
              ratio: denominator.value > 0 ? a.amountTWD / denominator.value : 0,
              origText: isForeign ? group.cur + " $" + num(a.amountOrig) : "",
              priceText,
              leverageText: String(Math.round(a.leverage * 100) / 100) + "x",
            };
          });
          return {
            ...group,
            isForeign,
            amount: ALD.round2(accounts.reduce((sum, account) => sum + account.amountTWD, 0)),
            accounts,
          };
        })
    );

    const liabilityAccounts = computed(() => {
      const map = {};
      store.records
        .filter((r) => !r.excluded && r.type === "負債")
        .forEach((r) => {
          const name = r.account || "(未命名)";
          map[name] = ALD.round2((map[name] || 0) + ALD.amountTWD(r));
        });
      const list = Object.keys(map).map((account) => ({ account, amount: map[account] }));
      const total = ALD.round2(list.reduce((s, a) => s + a.amount, 0));
      return list.map((a, i) => ({
        ...a,
        ratio: total > 0 ? a.amount / total : 0,
        color: ALD.chartColor(i),
      }));
    });
    const totalLiabilities = computed(() =>
      ALD.round2(liabilityAccounts.value.reduce((s, a) => s + a.amount, 0))
    );

    // ---------- 共用 Bottom Sheet 與 [新增帳戶] ----------
    // sheet：目前開啟的彈窗（null=無，"new"=新增帳戶）；後續階段的帳戶增減/編輯/紀錄沿用同一個外框。
    const sheet = ref(null);
    const plain = (v) => (Number(v) || 0).toLocaleString("zh-TW", { maximumFractionDigits: 2 });

    // 彈窗為編輯情境，一律顯示實際數字，不套用隱藏金額；開啟時鎖住背景捲動，關閉/卸載時還原。
    watch(sheet, (v) => {
      document.body.style.overflow = v ? "hidden" : "";
    });
    onUnmounted(() => {
      document.body.style.overflow = "";
    });
    function closeSheet() {
      sheet.value = null;
      calc.open = false;
    }

    const newForm = reactive({
      type: "流動資金",
      currency: settings.baseCurrency || "TWD",
      excluded: false,
      account: "",
      units: "",
      note: "",
      price: 1, // 僅在輸入「設定中不存在的新帳戶」時使用
      leverage: 0,
    });
    const defaultLeverage = (type) => (type === "投資" ? 1 : 0);
    function openNewAccount() {
      newForm.type = assetsView.value === "liability" ? "負債" : "流動資金";
      newForm.currency = settings.baseCurrency || "TWD";
      newForm.excluded = false;
      newForm.account = "";
      newForm.units = "";
      newForm.note = "";
      newForm.price = 1;
      newForm.leverage = defaultLeverage(newForm.type);
      sheet.value = "new";
    }
    function onNewTypeChange() {
      newForm.account = "";
      newForm.price = 1;
      newForm.leverage = defaultLeverage(newForm.type);
    }

    // 單價：設定中帳戶價格；查無（或為 0）時用該帳戶最新一筆紀錄的成交價，再查無用 1
    function resolveUnitPrice(type, account) {
      const cfg = ALD.lookupAccountPrice(store.accounts, type, account);
      if (cfg) return cfg;
      let latest = null;
      store.records.forEach((r) => {
        if (r.type !== type || r.account !== account) return;
        if (!latest || ALD.normalizeDateTime(r.date) > ALD.normalizeDateTime(latest.date)) latest = r;
      });
      return latest && Number(latest.tradePrice) > 0 ? Number(latest.tradePrice) : 1;
    }
    // 槓桿：設定中帳戶槓桿；查無時依類型預設（投資 1，其餘 0）
    function resolveLeverage(type, account) {
      const cfg = ALD.lookupAccountLeverage(store.accounts, type, account);
      return cfg != null ? cfg : type === "投資" ? 1 : 0;
    }

    const newTypes = ALD.TYPES;
    const newAccountOptions = computed(() => ALD.accountsForCategory(store.accounts, newForm.type));
    const currencyOptions = computed(() => ALD.currencyCodes(settings));
    const newAccountName = computed(() => newForm.account.trim());
    const configuredNewAccount = computed(() => ALD.lookupAccount(store.accounts, newForm.type, newAccountName.value));
    // 輸入的名稱不在「設定 > 存放帳戶」中 → 視為新帳戶，儲存時一併加入設定
    const newIsNewAccount = computed(
      () => !!newAccountName.value && !configuredNewAccount.value
    );
    function onNewAccountNameChange() {
      const account = configuredNewAccount.value;
      if (!account) return;
      newForm.type = account.category;
      newForm.currency = account.currency;
    }
    const newPreview = computed(() => {
      const account = newAccountName.value;
      const isNew = newIsNewAccount.value;
      const rec = {
        unitPrice: !account ? 0 : isNew ? Number(newForm.price) || 0 : resolveUnitPrice(newForm.type, account),
        units: Number(newForm.units) || 0,
        fxRate: ALD.currencyRate(settings, newForm.currency) || 1,
        leverage: !account ? 0 : isNew ? Number(newForm.leverage) || 0 : resolveLeverage(newForm.type, account),
      };
      // 預覽資料尚未寫入（新帳戶也尚未加入設定），以指定的價格/匯率/槓桿計算
      const amount = ALD.calcAmountTWD(rec.unitPrice, rec.units, rec.fxRate);
      return { ...rec, amount, exposure: ALD.round2(amount * rec.leverage) };
    });
    const newValid = computed(() => {
      if (!newAccountName.value || !(Number(newForm.units) > 0)) return false;
      if (!newIsNewAccount.value) {
        return (
          configuredNewAccount.value.category === newForm.type &&
          configuredNewAccount.value.currency === newForm.currency
        );
      }
      return (
        newForm.price !== "" && Number(newForm.price) > 0 &&
        newForm.leverage !== "" && isFinite(Number(newForm.leverage)) && Number(newForm.leverage) >= 0
      );
    });

    let sheetSaving = false;
    function saveNewAccount() {
      if (sheetSaving || !newValid.value) return;
      sheetSaving = true;
      try {
        const p = newPreview.value;
        const accountName = newAccountName.value;
        if (newIsNewAccount.value) {
          const nextOrder = store.accounts.reduce((max, a) => Math.max(max, Number(a.sortOrder) || 0), 0) + 1;
          store.accounts.push({
            ...ALD.emptyAccount(newForm.type, nextOrder),
            account: accountName,
            currency: newForm.currency,
            price: p.unitPrice,
            leverage: p.leverage,
          });
        }
        const rec = ALD.normalizeRec({
          ...ALD.emptyRecord(newForm.type),
          account: accountName,
          currency: newForm.currency,
          tradeFxRate: p.fxRate,
          tradePrice: p.unitPrice,
          units: p.units,
          note: newForm.note.trim() || "初始建倉",
          excluded: newForm.excluded ? 1 : 0,
          date: ALD.nowStr(),
        });
        store.records.push(rec);
        closeSheet();
      } finally {
        sheetSaving = false;
      }
    }

    // ---------- 帳戶彈窗：[增減]（流動資金類／投資）與 [還款]（負債） ----------
    // 帳戶識別鍵（D1）：資債類型 + 帳戶 + 幣別。應收款／固定資產／負債在匯總區塊只依名稱分組，
    // 因此只用「資債類型 + 帳戶」比對紀錄，寫入時的幣別取該帳戶最新一筆紀錄的幣別。
    const acctCtx = reactive({ type: "", account: "", currency: "" });
    const sheetTab = ref("adjust");
    const TRANSFER_TYPES = ["流動資金", "固定資產", "應收款"];
    const adj = reactive({
      dir: "in", // in=存入/買入，out=提取/賣出
      kind: "external", // external | internal（內部轉移）
      qty: "",
      note: "",
      excluded: false,
      xType: "流動資金",
      xAccount: "",
      price: "",
      settleAccount: "",
      principal: "",
      interest: "",
    });
    const UNNAMED = "(未命名)";
    const r6 = (n) => Math.round((Number(n) || 0) * 1e6) / 1e6;
    const dtKey = (r) => ALD.normalizeDateTime(r.date);
    const isCurKeyed = (type) => type === "流動資金" || type === "投資";
    function latestOf(list) {
      let latest = null;
      list.forEach((r) => {
        if (!latest || dtKey(r) >= dtKey(latest)) latest = r;
      });
      return latest;
    }

    function openAccountSheet(type, account, cur) {
      let currency = cur;
      if (!currency) {
        const latest = latestOf(
          store.records.filter((r) => r.type === type && (r.account || UNNAMED) === account)
        );
        currency = (latest && latest.currency) || settings.baseCurrency || "TWD";
      }
      acctCtx.type = type;
      acctCtx.account = account;
      acctCtx.currency = currency;
      adj.dir = "in";
      adj.kind = "external";
      adj.qty = "";
      adj.note = "";
      adj.excluded = false;
      adj.xType = "流動資金";
      adj.xAccount = "";
      adj.price = "";
      adj.settleAccount = "";
      adj.principal = "";
      adj.interest = "";
      sheetTab.value = "adjust";
      editMsg.value = "";
      logExpanded.value = new Set();
      calc.open = false;
      sheet.value = "account";
    }
    function onXTypeChange() {
      adj.xAccount = "";
    }

    const acctKind = computed(() =>
      acctCtx.type === "投資" ? "invest" : acctCtx.type === "負債" ? "repay" : "cash"
    );
    // 全部紀錄（含不計入）：供「最後編輯」；持有數量只計入 excluded=0 的紀錄（D2）
    const acctRecs = computed(() =>
      store.records.filter(
        (r) =>
          r.type === acctCtx.type &&
          (r.account || UNNAMED) === acctCtx.account &&
          (!isCurKeyed(acctCtx.type) || (r.currency || "TWD") === acctCtx.currency)
      )
    );
    const holding = computed(() =>
      r6(acctRecs.value.filter((r) => !ALD.isExcluded(r)).reduce((s, r) => s + (Number(r.units) || 0), 0))
    );
    const acctPrice = computed(() => resolveUnitPrice(acctCtx.type, acctCtx.account === UNNAMED ? "" : acctCtx.account));
    const acctBalance = computed(() => ALD.round2(holding.value * acctPrice.value));
    const lastEditText = computed(() => {
      const latest = latestOf(acctRecs.value);
      const m = latest && dtKey(latest).match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/);
      return m ? `${m[1]}/${Number(m[2])}/${Number(m[3])} ${m[4]}:${m[5]}` : "—";
    });

    const adjSign = computed(() => (adj.dir === "in" ? 1 : -1));
    const adjQty = computed(() => Number(adj.qty) || 0);
    const adjTradePrice = computed(() => (Number(adj.price) > 0 ? Number(adj.price) : acctPrice.value));
    const repayTotal = computed(() => ALD.round2((Number(adj.principal) || 0) + (Number(adj.interest) || 0)));
    const adjAfter = computed(() => {
      if (acctKind.value === "repay") {
        return r6(holding.value - (Number(adj.principal) || 0) / (acctPrice.value || 1));
      }
      // 流動資金類勾選「不計入」時，這筆紀錄不計入持有數量
      if (acctKind.value === "cash" && adj.excluded) return holding.value;
      return r6(holding.value + adjSign.value * adjQty.value);
    });

    // 對方帳戶可選清單（D5）：設定中該資債類型的帳戶，排除自己，也排除「已有紀錄但全部是其他幣別」的帳戶
    function peerOptions(type) {
      return ALD.accountsForCategory(store.accounts, type).filter((name) => {
        if (type === acctCtx.type && name === acctCtx.account) return false;
        const recs = store.records.filter((r) => r.type === type && r.account === name);
        return recs.length === 0 || recs.some((r) => (r.currency || "TWD") === acctCtx.currency);
      });
    }
    const xOptions = computed(() => peerOptions(adj.xType));
    const settleOptions = computed(() => peerOptions("流動資金"));

    const adjValid = computed(() => {
      if (acctKind.value === "repay") {
        if (adj.principal === "" || adj.interest === "") return false;
        const p = Number(adj.principal), i = Number(adj.interest);
        return isFinite(p) && isFinite(i) && p >= 0 && i >= 0 && p + i > 0;
      }
      if (!(Number(adj.qty) > 0)) return false;
      if (acctKind.value === "invest" && adj.price !== "" && !(Number(adj.price) > 0)) return false;
      return true;
    });
    const adjBtnText = computed(() => {
      if (acctKind.value === "repay") return "儲存";
      if (acctKind.value === "invest") return adj.dir === "in" ? "確認買入" : "確認賣出";
      return adj.dir === "in" ? "確認存入" : "確認提取";
    });

    // 組出這次操作要寫入的所有紀錄（本帳戶＋對方帳戶），同一個時間戳，並在同一個 tick 推入 store.records
    function buildAdjustRecords() {
      const ts = ALD.nowStr();
      const cur = acctCtx.currency;
      const fx = ALD.currencyRate(settings, cur) || 1;
      const selfName = acctCtx.account === UNNAMED ? "" : acctCtx.account;
      // 「不計入」僅出現在流動資金類的 [增減]，本筆與對方帳戶紀錄一併套用
      const excluded = acctKind.value === "cash" && adj.excluded ? 1 : 0;
      const mk = (type, account, units, tradePrice, note) =>
        ALD.normalizeRec({
          ...ALD.emptyRecord(type),
          account,
          currency: cur,
          tradeFxRate: fx,
          tradePrice,
          units: r6(units),
          note,
          excluded,
          date: ts,
        });
      const recs = [];
      const kind = acctKind.value;
      if (kind === "cash") {
        const internal = adj.kind === "internal";
        const note = adj.note.trim() || (internal ? "轉移" : adj.dir === "in" ? "存入" : "支出");
        const selfPrice = acctPrice.value;
        recs.push(mk(acctCtx.type, selfName, adjSign.value * adjQty.value, selfPrice, note));
        if (internal && adj.xAccount) {
          const peerPrice = resolveUnitPrice(adj.xType, adj.xAccount);
          recs.push(
            mk(adj.xType, adj.xAccount, (-adjSign.value * adjQty.value * selfPrice) / peerPrice, peerPrice, note)
          );
        }
      } else if (kind === "invest") {
        const label = adj.dir === "in" ? "買入" : "賣出";
        const price = adjTradePrice.value;
        recs.push(mk(acctCtx.type, selfName, adjSign.value * adjQty.value, price, label));
        if (adj.settleAccount) {
          const sp = resolveUnitPrice("流動資金", adj.settleAccount);
          recs.push(
            mk("流動資金", adj.settleAccount, (-adjSign.value * adjQty.value * price) / sp, sp, label + " " + acctCtx.account)
          );
        }
      } else {
        const principal = Number(adj.principal) || 0;
        if (principal > 0) recs.push(mk(acctCtx.type, selfName, -principal / acctPrice.value, acctPrice.value, "還款"));
        if (adj.settleAccount) {
          const sp = resolveUnitPrice("流動資金", adj.settleAccount);
          recs.push(mk("流動資金", adj.settleAccount, -repayTotal.value / sp, sp, "還款 " + acctCtx.account));
        }
      }
      return recs;
    }

    function saveAdjust() {
      if (sheetSaving || !adjValid.value) return;
      const reduces = (acctKind.value === "repay" || adj.dir === "out") && !(acctKind.value === "cash" && adj.excluded);
      if (reduces && adjAfter.value < 0) {
        if (!window.confirm("調整後數量為 " + plain(adjAfter.value) + "，小於 0，仍要儲存嗎？")) return;
      }
      sheetSaving = true;
      try {
        buildAdjustRecords().forEach((r) => store.records.push(r));
        closeSheet();
      } finally {
        sheetSaving = false;
      }
    }

    // ---------- [增減]／[還款] 的計算機 ----------
    // 算式以顯示符號（− × ÷）儲存，自行解析（不使用 eval），支援括號、負號與先乘除後加減；
    // 結果依欄位四捨五入（數量 6 位、本金/利息 2 位）後寫回 adj[field]，負數照樣帶回交由 adjValid 擋下。
    const CALC_LABELS = { qty: "調整數量", principal: "還本金", interest: "繳利息" };
    const CALC_OPS = "+−×÷";
    const calc = reactive({ open: false, field: "qty", expr: "", msg: "" });
    const calcRound = (n) => (calc.field === "qty" ? r6(n) : ALD.round2(n));
    function calcFormat(n) {
      let s = String(n);
      if (/e/i.test(s)) s = n.toFixed(6).replace(/\.?0+$/, "");
      return s.replace("-", "−");
    }
    function calcParse(expr) {
      const tokens = expr.match(/\d+\.?\d*|\.\d+|[+−×÷()]/g) || [];
      if (tokens.join("") !== expr) throw new Error("算式不完整");
      let i = 0;
      const fail = () => {
        throw new Error("算式不完整");
      };
      function parseExpr() {
        let v = parseTerm();
        while (tokens[i] === "+" || tokens[i] === "−") {
          const op = tokens[i++];
          const r = parseTerm();
          v = op === "+" ? v + r : v - r;
        }
        return v;
      }
      function parseTerm() {
        let v = parseFactor();
        while (tokens[i] === "×" || tokens[i] === "÷") {
          const op = tokens[i++];
          const r = parseFactor();
          if (op === "÷" && r === 0) throw new Error("不可除以 0");
          v = op === "×" ? v * r : v / r;
        }
        return v;
      }
      function parseFactor() {
        const t = tokens[i];
        if (t === "−") {
          i++;
          return -parseFactor();
        }
        if (t === "(") {
          i++;
          const v = parseExpr();
          if (tokens[i] !== ")") fail();
          i++;
          return v;
        }
        if (t === undefined || CALC_OPS.includes(t) || t === ")") fail();
        i++;
        return Number(t);
      }
      const v = parseExpr();
      if (i !== tokens.length) fail();
      if (!isFinite(v)) throw new Error("結果超出範圍");
      return v;
    }
    function calcEval() {
      if (!calc.expr) return { ok: false, msg: "請輸入算式" };
      try {
        return { ok: true, value: calcRound(calcParse(calc.expr)) };
      } catch (e) {
        return { ok: false, msg: e.message };
      }
    }
    // 即時預覽：算式可解析且不是單一數字時才顯示結果，輸入過程中的不完整算式不提示錯誤
    const calcPreview = computed(() => {
      if (!calc.open || !calc.expr || /^\d+\.?\d*$|^\.\d+$/.test(calc.expr)) return "";
      const r = calcEval();
      return r.ok ? "= " + calcFormat(r.value) : "";
    });
    function openCalc(field) {
      const v = adj[field];
      const n = Number(v);
      calc.field = field;
      calc.expr = v === "" || v === null || !isFinite(n) ? "" : calcFormat(n);
      calc.msg = "";
      calc.open = true;
    }
    function closeCalc() {
      calc.open = false;
    }
    function calcPress(key) {
      const e = calc.expr;
      const last = e.slice(-1);
      const isOp = (c) => c !== "" && CALC_OPS.includes(c);
      // 結尾運算子為「開頭或左括號後的負號」時，視為一元負號，不可被其他運算子取代
      const unaryTail = last === "−" && (e.length === 1 || e.slice(-2, -1) === "(");
      const numMatch = e.match(/(\d+\.?\d*|\.\d+)$/);
      calc.msg = "";
      if (/^\d$/.test(key)) {
        if (last !== ")") calc.expr = e + key;
      } else if (key === ".") {
        if (last === ")" || (numMatch && numMatch[1].includes("."))) return;
        calc.expr = e + (numMatch ? "." : "0.");
      } else if (key === "C") {
        calc.expr = "";
      } else if (key === "⌫") {
        calc.expr = e.endsWith("(−") ? e.slice(0, -2) : e.slice(0, -1);
      } else if (key === "(") {
        if (!numMatch && last !== "." && last !== ")") calc.expr = e + "(";
      } else if (key === ")") {
        const open = (e.match(/\(/g) || []).length;
        const close = (e.match(/\)/g) || []).length;
        if (open > close && (numMatch || last === ")")) calc.expr = e + ")";
      } else if (key === "−") {
        if (e === "" || last === "(") calc.expr = e + "−";
        else if (isOp(last)) {
          if (!unaryTail) calc.expr = e.slice(0, -1) + "−";
        } else calc.expr = e + "−";
      } else if (isOp(key)) {
        if (e === "" || last === "(" || unaryTail) return;
        calc.expr = isOp(last) ? e.slice(0, -1) + key : e + key;
      } else if (key === "±") {
        const wrapped = e.match(/\(−(\d+\.?\d*|\.\d+)\)$/);
        if (wrapped) {
          calc.expr = e.slice(0, -wrapped[0].length) + wrapped[1];
        } else if (numMatch) {
          const before = e.slice(0, -numMatch[1].length);
          if (before.endsWith("(−")) calc.expr = before.slice(0, -2) + numMatch[1];
          else if (before === "−") calc.expr = numMatch[1];
          else calc.expr = before + "(−" + numMatch[1] + ")";
        } else if (e.endsWith("(−")) {
          calc.expr = e.slice(0, -2);
        } else if (last !== ")" && last !== ".") {
          calc.expr = e + "(−";
        }
      }
    }
    function calcEquals() {
      const r = calcEval();
      if (!r.ok) {
        calc.msg = r.msg;
        return false;
      }
      calc.expr = calcFormat(r.value);
      calc.msg = "";
      return true;
    }
    function calcApply() {
      const r = calcEval();
      if (!r.ok) {
        calc.msg = r.msg;
        return;
      }
      adj[calc.field] = r.value;
      calc.open = false;
    }

    // ---------- 帳戶彈窗：[編輯] 與 [紀錄] ----------
    // [編輯] 只可調整持有數量與備註：差值 = 輸入 − 目前持有，非 0 才新增一筆差額紀錄，不修改既有紀錄
    const editForm = reactive({ units: "", note: "", excluded: false });
    const editMsg = ref("");
    const editRec = computed(() => {
      const rec = {
        unitPrice: acctPrice.value,
        units: Number(editForm.units) || 0,
        fxRate: ALD.currencyRate(settings, acctCtx.currency) || 1,
        leverage: resolveLeverage(acctCtx.type, acctCtx.account === UNNAMED ? "" : acctCtx.account),
      };
      const amount = ALD.calcAmountTWD(rec.unitPrice, rec.units, rec.fxRate);
      return { ...rec, amount, exposure: ALD.round2(amount * rec.leverage) };
    });
    const editValid = computed(() => editForm.units !== "" && isFinite(Number(editForm.units)));
    function selectSheetTab(tab) {
      sheetTab.value = tab;
      editMsg.value = "";
      calc.open = false;
      if (tab === "edit") {
        editForm.units = holding.value;
        editForm.note = "";
        editForm.excluded = false;
      }
    }
    function saveEdit() {
      if (sheetSaving || !editValid.value) return;
      const target = Number(editForm.units);
      const diff = r6(target - holding.value);
      if (diff === 0) {
        editMsg.value = "持有數量未變更，不需寫入紀錄";
        return;
      }
      if (target < 0 && !window.confirm("持有數量設為 " + plain(target) + "，小於 0，仍要儲存嗎？")) return;
      sheetSaving = true;
      try {
        const invest = acctCtx.type === "投資";
        const fixedNote = invest ? (diff > 0 ? "買入" : "賣出") : diff > 0 ? "收入" : "支出";
        const account = acctCtx.account === UNNAMED ? "" : acctCtx.account;
        store.records.push(
          ALD.normalizeRec({
            ...ALD.emptyRecord(acctCtx.type),
            account,
            currency: acctCtx.currency,
            tradeFxRate: ALD.currencyRate(settings, acctCtx.currency) || 1,
            tradePrice: acctPrice.value,
            units: diff,
            note: editForm.note.trim() || fixedNote,
            excluded: editForm.excluded ? 1 : 0,
            date: ALD.nowStr(),
          })
        );
        closeSheet();
      } finally {
        sheetSaving = false;
      }
    }
    // 刪除此資產：刪除該帳戶（含不計入）的所有明細紀錄；不刪除「設定 > 存放帳戶」中的帳戶
    function deleteAccountRecords() {
      const ids = new Set(acctRecs.value.map((r) => r.id));
      if (ids.size === 0) return;
      const msg =
        "確定要刪除「" + acctCtx.account + "」（" + acctCtx.currency + "）的全部 " + ids.size +
        " 筆明細紀錄嗎？此操作無法復原（設定中的帳戶不會被刪除）。";
      if (!window.confirm(msg)) return;
      for (let i = store.records.length - 1; i >= 0; i--) {
        if (ids.has(store.records[i].id)) store.records.splice(i, 1);
      }
      closeSheet();
    }

    // [紀錄]：唯讀卡片，固定依完整日期時間新到舊（同時間者後寫入的在前），展開狀態獨立於明細頁
    const logExpanded = ref(new Set());
    const logRecords = computed(() =>
      acctRecs.value
        .map((r, i) => ({ r, i, k: dtKey(r) }))
        .sort((a, b) => (a.k < b.k ? 1 : a.k > b.k ? -1 : b.i - a.i))
        .map((x) => x.r)
    );
    const logOpen = (id) => logExpanded.value.has(id);
    function toggleLog(id) {
      const set = logExpanded.value;
      if (set.has(id)) set.delete(id);
      else set.add(id);
    }
    const logDateMD = (d) => (typeof d === "string" && d.length >= 10 ? d.slice(0, 16) : d || "");
    const logAmount = (rec) => ALD.amountTWD(rec);
    const logExposure = (rec) => ALD.exposureTWD(rec);

    return {
      editForm,
      editMsg,
      editRec,
      editValid,
      selectSheetTab,
      saveEdit,
      deleteAccountRecords,
      logRecords,
      logOpen,
      toggleLog,
      logDateMD,
      logAmount,
      logExposure,
      effPrice: ALD.effPrice,
      effFxRate: ALD.effFxRate,
      effLeverage: ALD.effLeverage,
      effCurrency: ALD.effCurrency,
      datePart: ALD.datePart,
      acctCtx,
      sheetTab,
      adj,
      TRANSFER_TYPES,
      acctKind,
      holding,
      acctPrice,
      acctBalance,
      lastEditText,
      adjAfter,
      repayTotal,
      xOptions,
      settleOptions,
      adjValid,
      adjBtnText,
      openAccountSheet,
      onXTypeChange,
      saveAdjust,
      calc,
      CALC_LABELS,
      calcPreview,
      openCalc,
      closeCalc,
      calcPress,
      calcEquals,
      calcApply,
      sheet,
      closeSheet,
      openNewAccount,
      onNewTypeChange,
      newForm,
      newTypes,
      newAccountOptions,
      onNewAccountNameChange,
      currencyOptions,
      newPreview,
      newIsNewAccount,
      newValid,
      saveNewAccount,
      plain,
      view: assetsView,
      totalAssets,
      breakdown,
      ratioItems,
      row3,
      row4,
      currentAmount,
      noncurrentAmount,
      row4Chips,
      selectRow3,
      toggleRow4,
      groups,
      liabilityAccounts,
      totalLiabilities,
      showExcludedAccounts,
      hidden,
      fmt,
      fmtNum,
      num,
      pct,
      pctWhole,
      toggleHidden: () => {
        settings.hideAmounts = !settings.hideAmounts;
      },
      catName,
    };
  },
};

// ---------- 再平衡 ----------
const TabRebalance = {
  template: "#tpl-rebalance",
  setup() {
    const settings = store.settings;
    const ratioOptions = [50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 100];

    const liquidTWD = computed(() =>
      ALD.round2(
        store.records
          .filter((r) => !r.excluded && r.type === "流動資金")
          .reduce((sum, r) => sum + ALD.amountTWD(r), 0)
      )
    );
    const investTWD = computed(() =>
      ALD.round2(
        store.records
          .filter((r) => !r.excluded && r.type === "投資")
          .reduce((sum, r) => sum + ALD.amountTWD(r), 0)
      )
    );
    const pool = computed(() => ALD.round2(liquidTWD.value + investTWD.value));
    const liquidRatio = computed(() => (pool.value > 0 ? liquidTWD.value / pool.value : 0));
    const investRatio = computed(() => (pool.value > 0 ? investTWD.value / pool.value : 0));

    const exposureTotal = computed(() =>
      ALD.round2(
        store.records
          .filter((r) => !r.excluded && (r.type === "流動資金" || r.type === "投資"))
          .reduce((sum, r) => sum + ALD.exposureTWD(r), 0)
      )
    );
    const exposureRatio = computed(() => (pool.value > 0 ? exposureTotal.value / pool.value : 0));

    // 1 倍槓桿投資合計（台幣換算），供槓桿再平衡建議使用；排除「不計入」資料。
    const invest1xTWD = computed(() =>
      ALD.round2(
        store.records
          .filter((r) => !r.excluded && r.type === "投資" && ALD.effLeverage(r) === 1)
          .reduce((sum, r) => sum + ALD.amountTWD(r), 0)
      )
    );
    const exposureLeveragedTotal = computed(() =>
      ALD.round2(exposureTotal.value - invest1xTWD.value)
    );
    const exposureLeveragedRatio = computed(() =>
      pool.value > 0 ? exposureLeveragedTotal.value / pool.value : 0
    );

    // 目標：投資佔比 = rebalanceRatio(%)，流動資金佔比 = 100 - rebalanceRatio
    // 修正：原本用「liquidTWD > investTWD」的原始金額比較來判斷買入/賣出，
    // 這與使用者選擇的目標比例（rebalanceRatio）完全無關，只要目標不是 50% 就會誤判。
    // 正確判斷應直接看 diff（目標投資金額 - 目前投資金額）的正負號：
    // diff > 0 代表投資佔比不足目標 -> 應買入（把流動資金轉入投資）
    // diff < 0 代表投資佔比超過目標 -> 應賣出（把投資轉回流動資金）
    const action = computed(() => {
      const targetInvestRatio = (Number(settings.rebalanceRatio) || 70) / 100;
      const targetInvest = pool.value * targetInvestRatio;
      const diff = ALD.round2(targetInvest - investTWD.value);
      if (Math.abs(diff) < 1) {
        return { type: "hold", label: "已達平衡，無需調整", amount: 0 };
      }
      if (diff > 0) {
        return { type: "buy", label: "買入", amount: Math.abs(diff) };
      }
      return { type: "sell", label: "賣出", amount: Math.abs(diff) };
    });

    // 槓桿再平衡建議：
    // 差額 = (流動現金 + 1倍槓桿投資) - (1 - 投資配置比) × (流動現金 + 全部投資)
    // 把「流動現金」與「1 倍槓桿投資」視為同一組非槓桿部位，跟原本 action 的
    // 「目標流動資金 = (1-投資配置比)×資金部位」比較：
    // diff > 0 代表非槓桿部位超過目標流動資金 -> 多餘資金應轉入投資（買入）
    // diff < 0 代表非槓桿部位不足目標流動資金 -> 應把（槓桿）投資部位轉回流動資金（賣出）
    // 與原本 action 的正負號慣例一致，故沿用相同的 buy/sell 判斷與容差。
    const actionLeveraged = computed(() => {
      const targetInvestRatio = (Number(settings.rebalanceRatio) || 70) / 100;
      const targetLiquid = pool.value * (1 - targetInvestRatio);
      const diff = ALD.round2(liquidTWD.value + invest1xTWD.value - targetLiquid);
      if (Math.abs(diff) < 1) {
        return { type: "hold", label: "已達平衡，無需調整", amount: 0 };
      }
      if (diff > 0) {
        return { type: "buy", label: "買入", amount: Math.abs(diff) };
      }
      return { type: "sell", label: "賣出", amount: Math.abs(diff) };
    });

    function onRatioChange() {
      // settings 為 reactive 物件的引用，v-model 已直接修改，watch 會自動存檔
    }

    return {
      settings,
      ratioOptions,
      liquidTWD,
      investTWD,
      liquidRatio,
      investRatio,
      pool,
      exposureTotal,
      exposureRatio,
      exposureLeveragedTotal,
      exposureLeveragedRatio,
      action,
      actionLeveraged,
      onRatioChange,
      fmt: (v) => ALD.formatAmount(v, store.settings),
      pct: (v) => ALD.formatPercent(v),
      catName: (t) => ALD.categoryDisplayName(store.settings, t),
    };
  },
};

// ---------- 明細 ----------
const TabDetail = {
  template: "#tpl-detail",
  setup() {
    const settings = store.settings;
    const types = ALD.TYPES;
    const activeType = ref(types[0]);
    // 帳戶/幣別篩選：多選，陣列中每筆為 { account, currency } 一組。
    // 空陣列代表不篩選。同名但不同幣別的帳戶視為不同選項（幣別取自該帳戶所屬
    // 分組，不寫死支援哪些幣別），多選之間為 OR 關係。
    const selectedAccountFilters = ref([]);
    // 不計入三態篩選：'all' 全部 / 'excluded' 已勾選不計入 / 'included' 未勾選不計入。
    // 僅影響「顯示」，不會修改任何一筆資料的 excluded 值。
    const excludedFilters = reactive({ excluded: true, included: true });

    // 明細卡片收折：依 record.id 管理是否展開，預設全部收合；不寫入原始資料，
    // 也不受篩選/排序/新增/刪除影響（僅是額外的 UI 狀態，用 Set 記錄哪些 id 已展開）。
    const expandedIds = ref(new Set());
    function isExpanded(id) {
      return expandedIds.value.has(id);
    }
    function toggleExpand(id) {
      const set = expandedIds.value;
      if (set.has(id)) set.delete(id);
      else set.add(id);
    }

    // 收合摘要用日期顯示：只取 MM-DD，實際欄位（rec.date）仍完整保留 yyyy-mm-dd hh:mi:ss，
    // 編輯與儲存皆不受影響（此函式僅用於畫面顯示）。
    function dateDisplay(d) {
      if (!d || typeof d !== "string" || d.length < 10) return d || "";
      return d.slice(0, 16);
    }

    // 展開卡片的日期欄：原生 date input 只處理日期部分，改日期時保留原本的時分秒；清空則寫入 ""。
    function onRecDateChange(rec, event) {
      const v = event.target.value;
      if (!v) {
        rec.date = "";
        return;
      }
      const time = typeof rec.date === "string" && rec.date.length >= 19 ? rec.date.slice(10) : " 00:00:00";
      rec.date = v + time;
    }

    const isInvest = computed(() => activeType.value === "投資");

    // 目前子分頁資債類型的所有明細
    const typeRecords = computed(() =>
      store.records.filter((r) => r.type === activeType.value)
    );

    // 日期篩選：「顯示日期」(dateFilterValue) 與「是否套用篩選」(dateFilterActive) 分開管理，
    // 兩者互不強制連動：前一天/後一天、日曆選日期都只改變顯示日期，是否套用篩選（dateFilterActive）
    // 維持原本狀態不變——若原本已套用篩選則立即改篩選新日期，若原本未套用則仍顯示全部。
    const dateFilterValue = ref(ALD.todayStr());
    const dateFilterActive = ref(false);

    // 以本地年/月/日組出 Date 物件做位移，避免用 `new Date("YYYY-MM-DD")`（會被當 UTC 解析）
    // 或 toISOString() 造成日期偏移一天的問題。
    function shiftDateStr(dateStr, deltaDays) {
      const [y, m, d] = (dateStr || ALD.todayStr()).split("-").map(Number);
      const dt = new Date(y, (m || 1) - 1, d || 1);
      dt.setDate(dt.getDate() + deltaDays);
      const yy = dt.getFullYear();
      const mm = String(dt.getMonth() + 1).padStart(2, "0");
      const dd = String(dt.getDate()).padStart(2, "0");
      return `${yy}-${mm}-${dd}`;
    }

    // 短按：切換是否套用「篩選對應日期的資料」
    function onDateFilterClick() {
      dateFilterActive.value = !dateFilterActive.value;
    }

    // 前一天／後一天：只切換顯示日期，不改變是否套用篩選（dateFilterActive 維持原狀）
    function goPrevDay() {
      dateFilterValue.value = shiftDateStr(dateFilterValue.value, -1);
    }
    function goNextDay() {
      dateFilterValue.value = shiftDateStr(dateFilterValue.value, 1);
    }

    // 使用者透過原生 date input（真實尺寸、可直接點擊，非隱藏元素）選好日期後，
    // 只更新顯示日期，是否套用篩選維持原狀（不強制開啟，也不會被關閉）；
    // 若使用者取消選擇，原生 input 不會觸發 change，日期與篩選條件皆維持不變。
    function onDateFilterInputChange() {
      // 不改變 dateFilterActive；v-model 已同步 dateFilterValue，此函式保留供後續擴充。
    }

    // 未命名紀錄在目前資債類型內永遠顯示；命名紀錄才套用帳戶/幣別（多選 OR）、不計入、日期篩選。
    // 這個例外不跨資債類型，且不改變 store.records 的原始資料。
    const visibleRecords = computed(() => {
      const unnamed = typeRecords.value.filter((r) => !String(r.account || "").trim());
      let list = typeRecords.value.filter((r) => String(r.account || "").trim());
      const sel = selectedAccountFilters.value;
      if (sel.length > 0) {
        list = list.filter((r) =>
          sel.some(
            (s) => (r.account || "(未命名)") === s.account && (r.currency || "TWD") === s.currency
          )
        );
      }
      if (!excludedFilters.excluded || !excludedFilters.included) {
        list = list.filter((r) =>
          ALD.isExcluded(r) ? excludedFilters.excluded : excludedFilters.included
        );
      }
      if (dateFilterActive.value) {
        list = list.filter((r) => ALD.datePart(r.date) === dateFilterValue.value);
      }
      return { unnamed, named: list };
    });

    // 目前是否有任何一種篩選條件生效（供摘要列與空狀態顯示判斷）
    const hasActiveFilter = computed(
      () => selectedAccountFilters.value.length > 0 || !excludedFilters.excluded || !excludedFilters.included || dateFilterActive.value
    );

    // 清除全部篩選：帳戶/幣別（全部取消選取）、不計入、日期篩選狀態與卡片高亮一併重設。
    // 日期文字回到「今天」——與「日期篩選預設值＝當天」的既有邏輯一致，
    // 避免清除後按鈕仍停留在使用者先前長按選過的日期，造成混淆。
    function clearFilters() {
      selectedAccountFilters.value = [];
      excludedFilters.excluded = true;
      excludedFilters.included = true;
      dateFilterActive.value = false;
      dateFilterValue.value = ALD.todayStr();
    }

    // ---------- 排序（帳戶／幣別／日期，最多三層優先順序） ----------
    // 排序條件為陣列，索引即優先順序（先比對 index 0，相同才比對下一層）。
    // 每個欄位只能出現一次；帳戶/幣別支援升冪/降冪，日期支援新到舊/舊到新。
    // 預設排序為「日期新到舊」，符合既有頁面慣例（最新一筆在最上面）。
    const SORT_FIELDS = ["date", "account", "currency"];
    const sortRules = ref([{ field: "date", order: "desc" }]);

    const availableSortFields = computed(() =>
      SORT_FIELDS.filter((f) => !sortRules.value.some((r) => r.field === f))
    );

    function sortFieldLabel(field) {
      return { date: "日期", account: "帳戶", currency: "幣別" }[field] || field;
    }

    function sortOrderLabel(rule) {
      if (rule.field === "date") return rule.order === "desc" ? "新到舊" : "舊到新";
      return rule.order === "desc" ? "降冪" : "升冪";
    }

    // 新增排序條件：日期預設「新到舊」，帳戶/幣別預設「升冪」；最多三層（欄位僅 3 種，無需額外上限判斷）
    function addSortRule(field) {
      if (!field || sortRules.value.some((r) => r.field === field)) return;
      sortRules.value.push({ field, order: field === "date" ? "desc" : "asc" });
    }

    // 供排序條件新增下拉選單使用：選定後立即新增，並重置下拉選項避免殘留選取值
    function onAddSortField(event) {
      const field = event.target.value;
      if (field) addSortRule(field);
      event.target.value = "";
    }

    function removeSortRule(index) {
      sortRules.value.splice(index, 1);
    }

    function toggleSortOrder(index) {
      const rule = sortRules.value[index];
      if (!rule) return;
      rule.order = rule.order === "desc" ? "asc" : "desc";
    }

    // 調整排序條件優先順序：與相鄰一筆互換位置
    function moveSortRule(index, delta) {
      const arr = sortRules.value;
      const target = index + delta;
      if (target < 0 || target >= arr.length) return;
      const tmp = arr[index];
      arr[index] = arr[target];
      arr[target] = tmp;
    }

    function resetSort() {
      sortRules.value = [{ field: "date", order: "desc" }];
    }

    // 日期格式檢查（嚴格檢查年月日組合是否為真實存在的日期，避免如 2026-02-30 誤判為有效）
    function isValidDateStr(s) {
      if (!s || typeof s !== "string") return false;
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
      if (!m) return false;
      const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
      const dt = new Date(y, mo - 1, d);
      return dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === d;
    }

    // 依單一排序條件比較兩筆資料；空值/無效日期一律排在最後（不論升冪或降冪）
    function compareByRule(a, b, rule) {
      if (rule.field === "date") {
        const validA = isValidDateStr(ALD.datePart(a.date)), validB = isValidDateStr(ALD.datePart(b.date));
        if (!validA && !validB) return 0;
        if (!validA) return 1;
        if (!validB) return -1;
        // 以完整日期時間比較；Array.prototype.sort 為穩定排序，同時間維持原順序
        const va = ALD.normalizeDateTime(a.date), vb = ALD.normalizeDateTime(b.date);
        const cmp = va < vb ? -1 : va > vb ? 1 : 0;
        return rule.order === "desc" ? -cmp : cmp;
      }
      const va = a[rule.field] || "";
      const vb = b[rule.field] || "";
      const emptyA = va === "", emptyB = vb === "";
      if (emptyA && emptyB) return 0;
      if (emptyA) return 1;
      if (emptyB) return -1;
      const cmp = va.localeCompare(vb, "zh-Hant");
      return rule.order === "desc" ? -cmp : cmp;
    }

    // 命名紀錄先套用既有篩選及排序；未命名紀錄獨立保留並固定排在最前。
    // 所有排序皆對複製陣列執行，不會影響 store.records 與 IndexedDB 的儲存順序。
    const sortedRecords = computed(() => {
      const rules = sortRules.value;
      const sort = (records) => {
        const arr = records.slice();
        if (rules.length === 0) return arr;
        arr.sort((a, b) => {
          for (const rule of rules) {
            const cmp = compareByRule(a, b, rule);
            if (cmp !== 0) return cmp;
          }
          return 0;
        });
        return arr;
      };
      return [...sort(visibleRecords.value.unnamed), ...sort(visibleRecords.value.named)];
    });

    // 幣別分組標籤：投資用「台股/美股」，非投資用「台幣/美元」
    function groupLabel(type, currency) {
      if (type === "投資") {
        const m = { TWD: "台股", USD: "美股" };
        return m[currency] || currency;
      }
      const m = { TWD: "台幣", USD: "美元" };
      return m[currency] || currency;
    }

    // 依幣別 -> 存放帳戶 兩層分組彙總。金額一律用「金額(台幣)」加總。
    const summary = computed(() => {
      const recs = typeRecords.value.filter((r) => !ALD.isExcluded(r));
      const invest = activeType.value === "投資";
      const groupsMap = {};
      let exposureTotal = 0;
      recs.forEach((r) => {
        const cur = r.currency || "TWD";
        exposureTotal = ALD.round2(exposureTotal + ALD.exposureTWD(r));
        if (!groupsMap[cur]) {
          groupsMap[cur] = {
            key: cur,
            currency: cur,
            subtotalTWD: 0,
            subtotalOrig: 0,
            accounts: {},
          };
        }
        const g = groupsMap[cur];
        g.subtotalTWD = ALD.round2(g.subtotalTWD + ALD.amountTWD(r));
        g.subtotalOrig = ALD.round2(g.subtotalOrig + ALD.origAmount(r));
        const acctKey = r.account || "(未命名)";
        if (!g.accounts[acctKey]) {
          g.accounts[acctKey] = {
            key: acctKey,
            account: acctKey,
            currency: cur,
            amountTWD: 0,
            amountOrig: 0,
            units: 0,
          };
        }
        const a = g.accounts[acctKey];
        a.amountTWD = ALD.round2(a.amountTWD + ALD.amountTWD(r));
        a.amountOrig = ALD.round2(a.amountOrig + ALD.origAmount(r));
        a.units = ALD.round2(a.units + (Number(r.units) || 0));
      });
      const groups = Object.values(groupsMap).map((g) => ({
        key: g.key,
        currency: g.currency,
        isForeign: g.currency !== settings.baseCurrency,
        label: groupLabel(activeType.value, g.currency),
        subtotalTWD: g.subtotalTWD,
        subtotalOrig: g.subtotalOrig,
        accounts: Object.values(g.accounts).map((a) => ({
          ...a,
          isForeign: a.currency !== settings.baseCurrency,
        })),
      }));
      const totalTWD = ALD.round2(groups.reduce((s, g) => s + g.subtotalTWD, 0));
      return { groups, totalTWD, exposureTotal, invest };
    });

    // 切換子分頁時，帳戶/幣別篩選對象已不存在於新資債類型中，故重設；
    // 不計入、日期篩選為跨資債類型的通用條件，維持不變。
    watch(activeType, () => {
      selectedAccountFilters.value = [];
    });

    // 點選幣別分組下的存放帳戶卡片：多選（OR）。以「存放帳戶＋幣別」為篩選條件（幣別取自
    // 該卡片所屬分組，不寫死 TWD/USD，動態支援設定中新增的任何幣別）。
    // 點擊未選存放帳戶為加入選取，點擊已選存放帳戶則從選取清單移除（取消）。
    function toggleAccountFilter(account, currency) {
      const arr = selectedAccountFilters.value;
      const idx = arr.findIndex((s) => s.account === account && s.currency === currency);
      if (idx === -1) arr.push({ account, currency });
      else arr.splice(idx, 1);
    }

    function isAccountSelected(account, currency) {
      return selectedAccountFilters.value.some(
        (s) => s.account === account && s.currency === currency
      );
    }

    // 移除單筆已選帳戶/幣別（供篩選摘要 Chip 的個別移除按鈕使用）
    function removeAccountFilter(account, currency) {
      const arr = selectedAccountFilters.value;
      const idx = arr.findIndex((s) => s.account === account && s.currency === currency);
      if (idx !== -1) arr.splice(idx, 1);
    }

    // 新增時預設帶入目前子分頁的資債類型
    function addRow() {
      store.records.push(ALD.emptyRecord(activeType.value));
    }

    function removeRow(id) {
      const idx = store.records.findIndex((r) => r.id === id);
      if (idx !== -1) store.records.splice(idx, 1);
      expandedIds.value.delete(id); // 清除已刪除項目殘留的展開狀態，避免累積無用資料
    }

    // 依「設定 > 帳戶」對應存放帳戶帶入幣別（維持明細幣別與帳戶幣別一致的驗證契約）；
    // 價格/匯率/槓桿/金額已改由 ALD.eff* 即時解析，不再寫入明細
    function applyAccountConfig(rec) {
      const account = ALD.lookupAccount(store.accounts, rec.type, rec.account);
      if (account) rec.currency = account.currency;
    }

    // 該資債類型可選的存放帳戶清單（含目前值，避免現有資料的帳戶不在清單時消失）
    function accountOptions(rec) {
      const opts = ALD.accountsForCategory(store.accounts, rec.type);
      if (rec.account && !opts.includes(rec.account)) return [rec.account, ...opts];
      return opts;
    }

    // 選擇存放帳戶時，帶入對應幣別
    function onAccountChange(rec) {
      applyAccountConfig(rec);
    }

    // 資債類型變更時，重新帶入對應幣別
    function onTypeChange(rec) {
      applyAccountConfig(rec);
    }

    // 幣別下拉選項：取自「設定 > 幣別」
    const currencyOptions = computed(() => ALD.currencyCodes(store.settings));

    // 選擇幣別時，已對應帳戶者只能使用帳戶幣別
    function onCurrencyChange(rec) {
      const account = ALD.lookupAccount(store.accounts, rec.type, rec.account);
      if (account && rec.currency !== account.currency) {
        rec.currency = account.currency;
        alert(`存放帳戶「${account.account}」只能使用 ${account.currency}。`);
      }
    }

    function money(rec) {
      return ALD.amountTWD(rec);
    }

    function exposure(rec) {
      return ALD.exposureTWD(rec);
    }

    // 明細頁唯讀顯示用：實際用於估值的價格/匯率/槓桿
    function effPrice(rec) {
      return ALD.effPrice(rec);
    }

    function effFxRate(rec) {
      return ALD.effFxRate(rec);
    }

    function effLeverage(rec) {
      return ALD.effLeverage(rec);
    }

    // 是否已對應「設定 > 帳戶」：已對應時幣別以帳戶設定為準，明細幣別改為唯讀
    function isMappedAccount(rec) {
      return !!ALD.lookupAccount(store.accounts, rec.type, rec.account);
    }

    return {
      settings,
      types,
      activeType,
      isInvest,
      typeRecords,
      visibleRecords,
      summary,
      selectedAccountFilters,
      toggleAccountFilter,
      isAccountSelected,
      removeAccountFilter,
      excludedFilters,
      expandedIds,
      isExpanded,
      toggleExpand,
      dateDisplay,
      datePart: ALD.datePart,
      onRecDateChange,
      hasActiveFilter,
      clearFilters,
      sortRules,
      availableSortFields,
      sortFieldLabel,
      sortOrderLabel,
      onAddSortField,
      removeSortRule,
      toggleSortOrder,
      moveSortRule,
      resetSort,
      sortedRecords,
      addRow,
      removeRow,
      onTypeChange,
      onAccountChange,
      accountOptions,
      currencyOptions,
      onCurrencyChange,
      money,
      exposure,
      effPrice,
      effFxRate,
      effLeverage,
      isMappedAccount,
      dateFilterValue,
      dateFilterActive,
      goPrevDay,
      goNextDay,
      onDateFilterClick,
      onDateFilterInputChange,
      num: (v) => (Number(v) || 0).toLocaleString("zh-TW"),
      fmt: (v) => ALD.formatAmount(v, store.settings),
      catName: (t) => ALD.categoryDisplayName(store.settings, t),
    };
  },
};

// ---------- 設定 ----------
// 設定頁目前所在子分頁（null = 設定主頁）；App 標題列與 TabSettings 共用，不寫入 settings/IndexedDB，
// 重新整理或切換底部分頁後一律回到設定主頁。
const settingsSubPage = ref(null);
const SETTINGS_SUBPAGE_TITLES = {
  appearance: "外觀",
  currency: "幣別",
  category: "資債類型",
  accounts: "存放帳戶",
  quoteTW: "台股",
  quoteUS: "美股",
  test: "連線測試",
};

const TabSettings = {
  template: "#tpl-settings",
  setup() {
    const settings = store.settings;
    const accounts = store.accounts;
    const syncLogs = store.syncLogs;
    const currencyOptions = computed(() => ALD.currencyCodes(settings));
    const accountNamesBeforeEdit = new Map();
    const accountCurrenciesBeforeEdit = new Map();

    function openSubPage(key) {
      settingsSubPage.value = key;
      window.scrollTo(0, 0);
    }
    const assetCategoryKeys = ALD.ASSET_TYPES;
    const types = ALD.TYPES;
    const syncing = ref(false);
    const syncingFx = ref(false);
    const catName = (t) => ALD.categoryDisplayName(store.settings, t);

    // 將例外完整資訊（含 stack）顯示到畫面錯誤橫幅，方便截圖回報
    function reportError(prefix, e) {
      const detail =
        (e && e.stack ? e.stack : e && e.message ? e.message : String(e)) || "未知錯誤";
      if (window.__showAppError) window.__showAppError(prefix + "\n" + detail);
      console.error(prefix, e);
    }

    // 資債類型名稱：留空時回填預設（等於鍵）
    function onCategoryNameBlur(key) {
      if (!settings.categoryNames[key] || !settings.categoryNames[key].trim()) {
        settings.categoryNames[key] = key;
      }
    }

    // ---------- 幣別設定 ----------
    // 新增一個空白幣別
    function addCurrency() {
      settings.currencies.push(ALD.emptyCurrency());
    }

    function removeCurrency(code) {
      if (code === settings.baseCurrency) return; // 基準幣別不可刪除
      const idx = settings.currencies.findIndex((c) => c.code === code);
      if (idx !== -1) settings.currencies.splice(idx, 1);
    }

    // 幣別代碼輸入完成：正規化（大寫、去重、確保基準幣別）；明細匯率由 ALD.effFxRate 即時解析
    function onCurrencyCodeBlur() {
      ALD.normalizeCurrencies(settings);
    }

    // 記錄一筆同步執行資訊（僅在 settings.syncLogEnabled 開啟時才寫入，避免預設就累積資料；
    // 但 logKind === 'connectionTest' 時一律寫入，因為那是使用者於「連線測試中心」明確觸發的
    // 診斷動作，需要保留結果供排查，不受一般同步記錄開關影響）。
    // syncType：'fxRate' | 'stockPrice' | 'endpoint'；target：幣別代碼或存放帳戶名稱或測試網址。
    // logKind：'sync'（預設，正式同步） | 'connectionTest'（連線測試中心）。
    function recordSyncLog(syncType, target, success, errorMessage, requestUrl, responseText, logKind) {
      const kind = logKind || "sync";
      if (!settings.syncLogEnabled && kind !== "connectionTest") return;
      ALD.appendSyncLog(syncLogs, {
        id: ALD.uid(),
        timestamp: new Date().toISOString(),
        syncType,
        logKind: kind,
        target: target || "",
        success: !!success,
        errorMessage: success ? "" : String(errorMessage || ""),
        requestUrl: requestUrl || "",
        responseText: responseText || "",
      });
    }

    // 匯出同步記錄為 JSON 檔
    function exportSyncLogs() {
      try {
        ALD.exportSyncLogsJSON(syncLogs);
      } catch (e) {
        reportError("匯出同步記錄失敗：", e);
      }
    }

    // 清除同步記錄（不影響 records/settings/accounts）
    async function clearSyncLogs() {
      if (syncLogs.length === 0) return;
      if (!confirm("確定要清除所有同步記錄嗎？此動作無法復原。")) return;
      try {
        syncLogs.splice(0, syncLogs.length);
        await ALD_DB.replaceSyncLogs([]);
      } catch (e) {
        reportError("清除同步記錄失敗：", e);
        alert("清除同步記錄失敗：" + (e && e.message ? e.message : e));
      }
    }

    // 同步各幣別對基準幣別的即時匯率；明細估值由 ALD.effFxRate 即時讀取幣別匯率
    async function syncFxRates() {
      if (syncingFx.value) return;
      syncingFx.value = true;
      let ok = 0;
      let fail = 0;
      try {
        for (const cur of settings.currencies) {
          if (cur.code === settings.baseCurrency) {
            cur.rate = 1;
            continue;
          }
          if (!cur.code) continue;
          try {
            const result = await ALD_SERVICE.fetchFxRate(cur.code, settings.baseCurrency);
            cur.rate = ALD.round2(result.value);
            ok++;
            recordSyncLog("fxRate", cur.code, true, "", result.requestUrl, result.responseText);
          } catch (e) {
            fail++;
            recordSyncLog("fxRate", cur.code, false, e && e.message, e && e.requestUrl, e && e.responseText);
          }
        }
        alert(
          "匯率同步完成：成功 " + ok + " 筆，失敗 " + fail + " 筆" +
            (fail > 0 ? "（失敗可能因無法連外，請改用手動輸入）" : "")
        );
      } catch (e) {
        reportError("匯率同步失敗：", e);
      } finally {
        syncingFx.value = false;
      }
    }

    // 新增一筆存放帳戶設定，預設資債類型為第一個資債類型；sortOrder 由呼叫端指派為目前最大值 + 1，
    // 確保新帳戶固定排在最後（Test 6：A、B、C 新增 D → A、B、C、D）。
    function addAccount() {
      const nextOrder =
        store.accounts.reduce((max, a) => Math.max(max, Number(a.sortOrder) || 0), 0) + 1;
      store.accounts.push(ALD.emptyAccount(assetCategoryKeys[0], nextOrder, settings.baseCurrency));
    }

    function removeAccount(id) {
      const idx = store.accounts.findIndex((a) => a.id === id);
      if (idx !== -1) store.accounts.splice(idx, 1);
    }

    // 帳戶排序：在 store.accounts 陣列中交換相鄰兩筆位置，並重新產生連續的 sortOrder（1,2,3...），
    // 避免多次移動後 sortOrder 出現跳號（例如 1,5,9,20）。不實作拖曳，只支援上移/下移一格。
    function moveAccount(id, direction) {
      const idx = store.accounts.findIndex((a) => a.id === id);
      if (idx === -1) return;
      const targetIdx = idx + direction;
      if (targetIdx < 0 || targetIdx >= store.accounts.length) return;
      const arr = store.accounts;
      const tmp = arr[idx];
      arr[idx] = arr[targetIdx];
      arr[targetIdx] = tmp;
      arr.forEach((a, i) => {
        a.sortOrder = i + 1;
      });
    }

    function moveAccountUp(id) {
      moveAccount(id, -1);
    }

    function moveAccountDown(id) {
      moveAccount(id, 1);
    }

    // 存放帳戶變更時，若槓桿倍數仍為預設值則依新存放帳戶調整（投資=1，其餘=0）
    function onAccountCategoryChange(acc) {
      const cur = Number(acc.leverage) || 0;
      if (cur === 0 || cur === 1) {
        acc.leverage = acc.category === "投資" ? 1 : 0;
      }
    }

    function rememberAccountName(acc) {
      accountNamesBeforeEdit.set(acc.id, acc.account);
    }

    function rememberAccountCurrency(acc) {
      accountCurrenciesBeforeEdit.set(acc.id, acc.currency);
    }

    function accountValidationWith(candidate) {
      return ALD.validateAccounts(
        accounts.map((acc) => (acc.id === candidate.id ? candidate : acc)),
        settings,
        true
      );
    }

    function onAccountNameChange(acc) {
      const previous = accountNamesBeforeEdit.get(acc.id);
      acc.account = String(acc.account || "").trim();
      const validation = accountValidationWith(acc);
      if (!validation.valid) {
        acc.account = previous || "";
        alert(validation.message);
        return;
      }
      const currencyValidation = ALD.validateAccountRecordCurrencies(
        accounts.map((item) => (item.id === acc.id ? acc : item)),
        store.records
      );
      if (!currencyValidation.valid) {
        acc.account = previous || "";
        alert(currencyValidation.message);
        return;
      }
      // 帳戶改名連動：把舊名稱的明細改為新名稱，避免明細變成查無帳戶設定的孤兒紀錄
      if (previous && previous !== acc.account) {
        store.records.forEach((rec) => {
          if (rec.account === previous) rec.account = acc.account;
        });
      }
      accountNamesBeforeEdit.set(acc.id, acc.account);
    }

    function onAccountCurrencyChange(acc) {
      const previous = accountCurrenciesBeforeEdit.get(acc.id);
      const validation = accountValidationWith(acc);
      if (!validation.valid) {
        acc.currency = previous || settings.baseCurrency || "TWD";
        alert(validation.message);
        return;
      }
      const currencyValidation = ALD.validateAccountRecordCurrencies(accounts, store.records);
      if (!currencyValidation.valid) {
        acc.currency = previous || settings.baseCurrency || "TWD";
        alert(currencyValidation.message);
        return;
      }
    }

    // 匯出存放帳戶設定為 CSV
    function exportAccountsCsv() {
      try {
        ALD.exportAccountsCSV(store.accounts, store.settings);
      } catch (e) {
        reportError("匯出帳戶設定失敗：", e);
      }
    }

    // 匯入存放帳戶設定 CSV（取代現有設定）
    async function importAccountsCsv(evt) {
      const file = evt.target.files[0];
      if (!file) return;
      try {
        const imported = await ALD.parseAccountsCSV(file, store.settings);
        if (
          store.accounts.length > 0 &&
          !confirm("匯入將「取代」現有的存放帳戶設定，確定要繼續嗎？")
        ) {
          return;
        }
        const skipped = imported.__skipped || 0;
        store.accounts.splice(0, store.accounts.length, ...imported);
        // 明確等待 IndexedDB 保存完成後才顯示「匯入成功」，避免寫入失敗卻誤報成功；
        // watch 之後仍會 debounce 回寫同一份資料，屬冪等操作，不影響正確性。
        await ALD_DB.replaceAccounts(JSON.parse(JSON.stringify(store.accounts)));
        alert(
          "已匯入 " + imported.length + " 筆存放帳戶設定" +
            (skipped > 0 ? "\n（略過 " + skipped + " 筆：空白或不符值域）" : "")
        );
      } catch (e) {
        reportError("帳戶設定匯入失敗：", e);
        alert("帳戶設定匯入失敗：" + (e && e.message ? e.message : e));
      } finally {
        evt.target.value = "";
      }
    }

    // 同步「投資」類型帳戶的即時價格（市值）；明細估值由 ALD.effPrice 即時讀取帳戶價格。
    // 依「設定 > 股價資料來源」分台股/美股 provider 查詢；provider 為「手動輸入」的帳戶會被略過，
    // 不計入成功/失敗筆數。同一批次共用 twseCache，避免台股 provider 為 TWSE 時重複下載整份清單。
    async function syncPrices() {
      if (syncing.value) return;
      syncing.value = true;
      let ok = 0;
      let fail = 0;
      let skipped = 0;
      const twseCache = {};
      try {
        for (const acc of store.accounts) {
          if (acc.category === "投資" && acc.account) {
            try {
              const result = await ALD_SERVICE.fetchStockPrice(acc.account, store.settings, twseCache);
              if (result === ALD_SERVICE.SKIP_MANUAL) {
                skipped++;
                continue;
              }
              acc.price = ALD.round2(result.value);
              ok++;
              recordSyncLog("stockPrice", acc.account, true, "", result.requestUrl, result.responseText);
            } catch (e) {
              fail++;
              recordSyncLog("stockPrice", acc.account, false, e && e.message, e && e.requestUrl, e && e.responseText);
            }
          }
        }
        alert(
          "報價同步完成：成功 " + ok + " 筆，失敗 " + fail + " 筆" +
            (skipped > 0 ? "，略過 " + skipped + " 筆（資料來源設為手動輸入）" : "") +
            (fail > 0 ? "（失敗可能因無法連外或該來源查無此代號，請改用手動輸入）" : "")
        );
      } catch (e) {
        reportError("報價同步失敗：", e);
      } finally {
        syncing.value = false;
      }
    }

    // ---------- 連線測試中心 ----------
    // 與正式「同步價格」共用同一個 request executor（ALD_SERVICE.testMarketConfig /
    // testEndpoint 內部皆呼叫與 fetchStockPrice 相同的底層 requestRaw/executeRequestForUrl）。
    // 僅用於診斷，測試過程「不會」更新 acc.price 或任何明細資料；結果一律為真實請求結果，不假造成功。
    const testingTW = ref(false);
    const testingUS = ref(false);
    const testResultTW = ref(null);
    const testResultUS = ref(null);
    const testSymbolTW = ref("2330.TW");
    const testSymbolUS = ref("AAPL");

    const testEndpointUrl = ref("");
    const testEndpointConnection = ref("direct");
    const testEndpointProxyUrl = ref("");
    const testEndpointPricePath = ref("");
    const testingEndpoint = ref(false);
    const testEndpointResult = ref(null);

    async function testMarketConfigTW() {
      if (testingTW.value) return;
      testingTW.value = true;
      try {
        const result = await ALD_SERVICE.testMarketConfig("TW", settings, testSymbolTW.value);
        testResultTW.value = result;
        recordSyncLog(
          "stockPrice",
          testSymbolTW.value || "(台股設定測試)",
          result.ok,
          result.errorMessage,
          result.requestUrl,
          result.responseText,
          "connectionTest"
        );
      } catch (e) {
        reportError("台股設定測試失敗：", e);
      } finally {
        testingTW.value = false;
      }
    }

    async function testMarketConfigUS() {
      if (testingUS.value) return;
      testingUS.value = true;
      try {
        const result = await ALD_SERVICE.testMarketConfig("US", settings, testSymbolUS.value);
        testResultUS.value = result;
        recordSyncLog(
          "stockPrice",
          testSymbolUS.value || "(美股設定測試)",
          result.ok,
          result.errorMessage,
          result.requestUrl,
          result.responseText,
          "connectionTest"
        );
      } catch (e) {
        reportError("美股設定測試失敗：", e);
      } finally {
        testingUS.value = false;
      }
    }

    async function runTestEndpoint() {
      if (testingEndpoint.value) return;
      testingEndpoint.value = true;
      try {
        const result = await ALD_SERVICE.testEndpoint({
          url: testEndpointUrl.value,
          connection: testEndpointConnection.value,
          proxyUrl: testEndpointProxyUrl.value,
          pricePath: testEndpointPricePath.value,
        });
        testEndpointResult.value = result;
        recordSyncLog(
          "endpoint",
          testEndpointUrl.value || "(任意 Endpoint 測試)",
          result.ok,
          result.errorMessage,
          result.requestUrl,
          result.responseText,
          "connectionTest"
        );
      } catch (e) {
        reportError("Endpoint 測試失敗：", e);
      } finally {
        testingEndpoint.value = false;
      }
    }

    function exportCsv() {
      try {
        ALD.exportCSV(store.records, store.settings);
      } catch (e) {
        reportError("匯出 CSV 失敗：", e);
      }
    }

    function openDetail() {
      window.dispatchEvent(new Event("ald-open-detail"));
    }

    async function importCsv(evt) {
      const file = evt.target.files[0];
      if (!file) return;
      try {
        const imported = await ALD.parseCSV(file, store.settings, store.accounts);
        store.records.push(...imported);
        // 明確等待 IndexedDB 保存完成後才顯示「匯入成功」，避免寫入失敗卻誤報成功；
        // watch 之後仍會 debounce 回寫同一份資料，屬冪等操作，不影響正確性。
        await ALD_DB.replaceRecords(JSON.parse(JSON.stringify(store.records)));
        const skipped = imported.__skipped || 0;
        alert(
          "已匯入 " + imported.length + " 筆資料" +
            (skipped > 0 ? "\n（略過 " + skipped + " 筆：資債類型空白或不符值域）" : "")
        );
      } catch (e) {
        reportError("CSV 匯入失敗：", e);
        alert("CSV 匯入失敗：" + (e && e.message ? e.message : e));
      } finally {
        evt.target.value = "";
      }
    }

    function loadSample() {
      try {
        if (
          store.records.length > 0 &&
          !confirm("載入模擬資料會「附加」在現有資料之後，確定要載入嗎？")
        ) {
          return;
        }
        const sample = ALD.seedRecords();
        store.records.push(...sample);
        alert("已載入模擬資料 " + sample.length + " 筆");
      } catch (e) {
        reportError("載入模擬資料失敗：", e);
        alert("載入模擬資料失敗：" + (e && e.message ? e.message : e));
      }
    }

    // 清除所有本地資料：清空 records、accounts，settings 重設為最小必要設定（不可整個
    // 替換物件參考）。除了讓 watch 之後自動 debounce 回寫，這裡也立即明確寫回 IndexedDB，
    // 避免使用者在防抖時間內就重新整理，導致清除結果尚未真正持久化。
    async function resetData() {
      if (!confirm("確定要清除所有本地資料嗎？此動作無法復原，建議先匯出 CSV 備份。")) return;
      try {
        store.records.splice(0, store.records.length);
        store.accounts.splice(0, store.accounts.length);
        store.syncLogs.splice(0, store.syncLogs.length);
        applyDefaultSettingsInPlace(store.settings);
        await ALD_DB.replaceRecords([]);
        await ALD_DB.replaceAccounts([]);
        await ALD_DB.replaceSyncLogs([]);
        await ALD_DB.saveSettings(JSON.parse(JSON.stringify(store.settings)));
        alert("已清除本地資料");
      } catch (e) {
        reportError("清除資料失敗：", e);
        alert("清除資料失敗：" + (e && e.message ? e.message : e));
      }
    }

    return {
      settings,
      accounts,
      currencyOptions,
      syncLogs,
      syncLogMax: ALD.SYNC_LOG_MAX,
      settingsSubPage,
      openSubPage,
      openDetail,
      assetCategoryKeys,
      types,
      syncing,
      syncingFx,
      catName,
      onCategoryNameBlur,
      addCurrency,
      removeCurrency,
      onCurrencyCodeBlur,
      syncFxRates,
      addAccount,
      removeAccount,
      moveAccountUp,
      moveAccountDown,
      onAccountCategoryChange,
      rememberAccountName,
      rememberAccountCurrency,
      onAccountNameChange,
      onAccountCurrencyChange,
      exportAccountsCsv,
      importAccountsCsv,
      syncPrices,
      testingTW,
      testingUS,
      testResultTW,
      testResultUS,
      testSymbolTW,
      testSymbolUS,
      testMarketConfigTW,
      testMarketConfigUS,
      testEndpointUrl,
      testEndpointConnection,
      testEndpointProxyUrl,
      testEndpointPricePath,
      testingEndpoint,
      testEndpointResult,
      runTestEndpoint,
      exportSyncLogs,
      clearSyncLogs,
      exportCsv,
      importCsv,
      loadSample,
      resetData,
      themeColors: ALD.THEME_COLORS,
      fontFamilies: ALD.FONT_FAMILIES,
      fontSizes: ALD.FONT_SIZES,
    };
  },
};

// ---------- 根元件：底部分頁列 + 分頁切換 ----------
const App = {
  components: { TabOverview, TabRebalance, TabAssets, TabDetail, TabSettings },
  template: `
    <div class="page-header" :class="{ 'has-back': inSettingsSubPage }" ref="pageHeaderRef">
      <template v-if="inSettingsSubPage">
        <button type="button" class="set-back-btn" @click="closeSubPage" aria-label="返回設定">‹</button>
        <div class="set-page-title">{{ settingsSubPageTitles[settingsSubPage] }}</div>
      </template>
      <button
        v-else-if="activeTab === 'assets'"
        type="button"
        class="as-title-btn"
        @click="toggleAssetsView"
        :aria-label="assetsView === 'asset' ? '切換到我的負債' : '切換到我的資產'"
      >{{ assetsView === 'asset' ? '我的資產 ›' : '‹ 我的負債' }}</button>
      <template v-else>{{ tabTitles[activeTab] }}</template>
    </div>
    <component :is="activeComponent"></component>
    <nav class="tab-bar">
      <button
        v-for="tab in visibleTabs"
        :key="tab.key"
        class="tab-btn"
        :class="{ active: activeTab === tab.key }"
        @click="setActiveTab(tab.key)"
      >
        <span class="tab-icon">{{ tab.icon }}</span>
        <span>{{ tabLabel(tab) }}</span>
      </button>
    </nav>
    <button
      v-if="activeTab === 'detail' && fabVisible"
      class="scroll-fab"
      @click="onScrollFab"
      aria-label="捲動至頂端或底部"
    >↑↓</button>
  `,
  setup() {
    const tabs = [
      { key: "overview", label: "總覽", icon: "⬠", component: "TabOverview" },
      { key: "assets", label: "資產", icon: "◧", component: "TabAssets" },
      { key: "rebalance", label: "再平衡", icon: "⟠", component: "TabRebalance" },
      { key: "detail", label: "明細", icon: "≣", component: "TabDetail" },
      { key: "settings", label: "設定", icon: "⛯", component: "TabSettings" },
    ];
    const visibleTabs = computed(() => tabs.filter((tab) => tab.key !== "detail"));
    // 主分頁狀態改由 settings.lastTab 還原，重新整理頁面後可維持上次所在分頁；
    // settings.lastTab 不存在（舊資料）或非上述五種合法值時，一律回退為 overview。
    const validTabKeys = tabs.map((t) => t.key);
    const initialTab = validTabKeys.includes(store.settings.lastTab)
      ? store.settings.lastTab
      : "overview";
    const activeTab = ref(initialTab);
    function setActiveTab(key) {
      activeTab.value = key;
      settingsSubPage.value = null;
      // 沿用既有 settings 機制回寫 IndexedDB（由既有的 store.settings watch 統一 debounce 儲存）。
      store.settings.lastTab = key;
    }
    function openDetailFromSettings() {
      setActiveTab("detail");
      window.scrollTo(0, 0);
    }
    onMounted(() => window.addEventListener("ald-open-detail", openDetailFromSettings));
    onUnmounted(() => window.removeEventListener("ald-open-detail", openDetailFromSettings));
    const inSettingsSubPage = computed(
      () => activeTab.value === "settings" && !!settingsSubPage.value
    );
    function closeSubPage() {
      settingsSubPage.value = null;
      window.scrollTo(0, 0);
    }
    // 「資產」分頁的按鈕文字隨我的資產／我的負債切換
    function tabLabel(tab) {
      if (tab.key === "assets") return assetsView.value === "asset" ? "資產" : "負債";
      return tab.label;
    }
    function toggleAssetsView() {
      assetsView.value = assetsView.value === "asset" ? "liability" : "asset";
    }
    const tabTitles = Object.fromEntries(tabs.map((t) => [t.key, t.label]));
    const activeComponent = computed(
      () => tabs.find((t) => t.key === activeTab.value).component
    );

    // 明細浮動捲動鈕：預設捲到最底部；若已接近底部則改捲到最頂端。
    function onScrollFab() {
      const doc = document.documentElement;
      const scrollTop = window.pageYOffset || doc.scrollTop || 0;
      const maxScroll = doc.scrollHeight - window.innerHeight;
      const atBottom = maxScroll - scrollTop < 8; // 已在（或非常接近）底部
      window.scrollTo({ top: atBottom ? 0 : maxScroll, behavior: "smooth" });
    }

    // 是否顯示浮動捲動鈕：僅當頁面內容高度「超過」裝置可視高度時才需要捲動，
    // 此時才顯示按鈕；內容未超出（例如資料筆數很少）就不需要捲動、隱藏按鈕避免遮擋畫面。
    const fabVisible = ref(false);
    const OVERFLOW_THRESHOLD = 24; // 容許誤差（px），避免臨界值時按鈕閃爍
    function checkOverflow() {
      const doc = document.documentElement;
      fabVisible.value = doc.scrollHeight - window.innerHeight > OVERFLOW_THRESHOLD;
    }
    let resizeTimer = null;
    function onResize() {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(checkOverflow, 150);
    }

    onMounted(() => {
      checkOverflow();
      window.addEventListener("resize", onResize);
      // 內容高度會隨分頁切換、資料新增/刪除、篩選而變動，這裡在 DOM 更新後統一重新檢查
      watch(
        () => [activeTab.value, store.records.length],
        () => nextTick(checkOverflow),
        { flush: "post" }
      );
      watch(store.records, () => nextTick(checkOverflow), { deep: true, flush: "post" });
    });
    onUnmounted(() => {
      window.removeEventListener("resize", onResize);
      clearTimeout(resizeTimer);
    });

    // 分類按鈕列（.subtab-bar，明細/設定共用）需以 sticky 固定在標題列正下方。
    // 標題列高度會隨安全區域（瀏海機型）、字型大小設定而變動，不寫死像素值，
    // 改用 ResizeObserver 即時量測實際高度，寫入 CSS 變數供 .subtab-bar 的 top 使用。
    const pageHeaderRef = ref(null);
    let headerObserver = null;
    function applyHeaderHeight() {
      const h = pageHeaderRef.value ? pageHeaderRef.value.offsetHeight : 0;
      if (h > 0) {
        document.documentElement.style.setProperty("--page-header-height", h + "px");
      }
    }
    onMounted(() => {
      applyHeaderHeight();
      if (window.ResizeObserver && pageHeaderRef.value) {
        headerObserver = new ResizeObserver(applyHeaderHeight);
        headerObserver.observe(pageHeaderRef.value);
      } else {
        // 無 ResizeObserver 支援時退而求其次，依賴 resize 事件重新量測
        window.addEventListener("resize", applyHeaderHeight);
      }
    });
    onUnmounted(() => {
      if (headerObserver) headerObserver.disconnect();
      window.removeEventListener("resize", applyHeaderHeight);
    });

    return {
      activeTab,
      setActiveTab,
      tabs,
      visibleTabs,
      tabTitles,
      tabLabel,
      assetsView,
      toggleAssetsView,
      activeComponent,
      onScrollFab,
      fabVisible,
      pageHeaderRef,
      settingsSubPage,
      settingsSubPageTitles: SETTINGS_SUBPAGE_TITLES,
      inSettingsSubPage,
      closeSubPage,
    };
  },
};

const app = createApp(App);
// Vue 元件渲染/setup 過程中的例外，預設只會出現在 console，這裡額外顯示在畫面上
app.config.errorHandler = (err, instance, info) => {
  console.error("Vue error:", err, info);
  if (window.__showAppError) {
    const detail = err && err.stack ? err.stack : err && err.message ? err.message : String(err);
    window.__showAppError("Vue 元件錯誤（" + info + "）：\n" + detail);
  }
};

// ---------- 非同步初始化 ----------
// 順序：顯示載入狀態 -> 開啟 IndexedDB -> 讀取 records/settings/accounts -> 判斷是否首次使用
// -> （首次才）建立並寫入預設資料 -> 建立 reactive store -> 設定 watch -> 最後才 mount()。
// 任何一步失敗都會顯示明確錯誤並中止初始化，不會建立預設資料覆蓋既有狀態，也不會掛載 App。
(async function initApp() {
  showInitLoading("資料載入中…");

  let db;
  try {
    db = await ALD_DB.openDatabase();
  } catch (e) {
    showInitError("IndexedDB 開啟失敗，App 無法啟動：\n" + (e && e.message ? e.message : String(e)));
    return;
  }
  void db; // 僅需確認開啟成功，實際讀寫透過 ALD_DB 的其他 API 呼叫

  let rawRecords, rawSettings, rawAccounts, rawSyncLogs;
  try {
    rawRecords = await ALD_DB.loadRecords();
    rawSettings = await ALD_DB.loadSettings();
    rawAccounts = await ALD_DB.loadAccounts();
    rawSyncLogs = await ALD_DB.loadSyncLogs();
  } catch (e) {
    showInitError("讀取本地資料失敗，App 無法啟動：\n" + (e && e.message ? e.message : String(e)));
    return;
  }

  // 首次使用判斷：settings 為固定 key 單筆記錄，從未寫入時 loadSettings() 回傳 null；
  // 不可用 records/accounts 陣列長度判斷——已初始化但清空為 [] 屬合法狀態，重新整理仍須維持空白。
  const isFirstRun = rawSettings === null;

  let initialRecords, initialSettings, initialAccounts, initialSyncLogs;
  if (isFirstRun) {
    initialSettings = mergeSettings(null);
    initialRecords = ALD.seedRecords();
    initialAccounts = ALD.seedAccounts();
    initialSyncLogs = [];
    try {
      await ALD_DB.replaceRecords(initialRecords);
      await ALD_DB.saveSettings(initialSettings);
      await ALD_DB.replaceAccounts(initialAccounts);
    } catch (e) {
      showInitError(
        "首次初始化寫入 IndexedDB 失敗，App 無法啟動：\n" + (e && e.message ? e.message : String(e))
      );
      return;
    }
  } else {
    initialSettings = mergeSettings(rawSettings);
    const rawDates = Array.isArray(rawRecords) ? rawRecords.map((r) => r && r.date) : [];
    // 欄位正規化遷移判斷需在 normalizeRec（會就地刪除舊欄位）之前執行
    const recordsHadLegacyFields = Array.isArray(rawRecords) && rawRecords.some(ALD.hasLegacyFields);
    initialRecords = Array.isArray(rawRecords) ? rawRecords.map(ALD.normalizeRec) : [];
    // 日期擴欄一次性遷移：normalizeRec 已把純日期補成 yyyy-mm-dd hh:mi:ss，有任何一筆被補時間就整批寫回。
    // 欄位正規化一次性遷移：unitPrice/fxRate 搬到 tradePrice/tradeFxRate，刪除 leverage/amount，同樣整批寫回。
    // 寫回失敗只顯示錯誤，不中止啟動（記憶體中的資料已是新格式，之後 store 的 watch 會再次嘗試寫回）。
    if (recordsHadLegacyFields || initialRecords.some((r, i) => r.date !== rawDates[i])) {
      try {
        await ALD_DB.replaceRecords(initialRecords);
      } catch (e) {
        const detail = e && e.stack ? e.stack : e && e.message ? e.message : String(e);
        console.error("明細資料遷移寫回 IndexedDB 失敗：", e);
        if (window.__showAppError) window.__showAppError("明細資料遷移寫回 IndexedDB 失敗：\n" + detail);
      }
    }
    try {
      initialAccounts = Array.isArray(rawAccounts)
        ? rawAccounts.map((a, i) => normalizeAccount(a, i + 1, initialSettings, initialRecords))
        : [];
      const accountValidation = ALD.validateAccounts(initialAccounts, initialSettings, true);
      if (!accountValidation.valid) throw new Error(accountValidation.message);
      const recordCurrencyValidation = ALD.validateAccountRecordCurrencies(initialAccounts, initialRecords);
      if (!recordCurrencyValidation.valid) throw new Error(recordCurrencyValidation.message);
      const accountsMigrated = (rawAccounts || []).some(
        (raw, i) =>
          raw.currency !== initialAccounts[i].currency ||
          String(raw.account == null ? "" : raw.account) !== initialAccounts[i].account
      );
      if (accountsMigrated) {
        await ALD_DB.replaceAccounts(initialAccounts);
      }
    } catch (e) {
      showInitError(
        "帳戶設定資料不符合名稱唯一或限制幣別規則，App 無法啟動：\n" +
          (e && e.message ? e.message : String(e))
      );
      return;
    }
    // 依時間戳排序（舊到新），IndexedDB getAll() 不保證回傳順序，維持顯示/匯出時的時序一致。
    initialSyncLogs = Array.isArray(rawSyncLogs)
      ? rawSyncLogs.slice().sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)))
      : [];
  }

  // 帳戶顯示/儲存順序一律依 sortOrder ASC；IndexedDB getAll() 不保證回傳順序，
  // 在建立 store.accounts 前先排序，確保 Safari / IndexedDB / CSV 匯入都得到一致順序。
  initialAccounts.sort((a, b) => (Number(a.sortOrder) || 0) - (Number(b.sortOrder) || 0));

  // ---------- 建立 reactive store ----------
  store = reactive({
    records: initialRecords,
    settings: initialSettings,
    accounts: initialAccounts,
    syncLogs: initialSyncLogs,
  });
  // 明細估值改由帳戶設定/幣別設定即時解析：綁定 reactive store，讓 computed 追蹤帳戶與匯率變更
  ALD.bindRefs(store);

  // ---------- 設定 watch（初始化完成、store 已有正確資料後才註冊，避免載入期間回寫空資料） ----------
  watch(
    () => store.records,
    (val) => saveRecordsDebounced(JSON.parse(JSON.stringify(val))),
    { deep: true }
  );
  watch(
    () => store.settings,
    (val) => saveSettingsDebounced(JSON.parse(JSON.stringify(val))),
    { deep: true }
  );
  watch(
    () => store.accounts,
    (val) => saveAccountsDebounced(JSON.parse(JSON.stringify(val))),
    { deep: true }
  );
  watch(
    () => store.syncLogs,
    (val) => saveSyncLogsDebounced(JSON.parse(JSON.stringify(val))),
    { deep: true }
  );
  // 外觀主題（配色/字型/字型大小）：載入時立即套用，設定變更時即時反映（純畫面效果，非資料寫入）
  watch(() => store.settings, (val) => ALD.applyTheme(val), { deep: true, immediate: true });

  // ---------- 最後才 mount() ----------
  app.mount("#app");
  // 明確標記「App 已成功掛載」，供錯誤橫幅判斷健康狀態使用；
  // 避免用 DOM 子節點數量判斷（掛載前一瞬間會誤判為不健康）。
  window.__appMounted = true;
  if (window.__refreshErrorBanner) window.__refreshErrorBanner();
})().catch((e) => {
  // 保底：理論上以上流程皆已個別 try/catch，此處僅防止遺漏情境造成未處理的 Promise rejection。
  showInitError("App 初始化發生未預期錯誤：\n" + (e && e.message ? e.message : String(e)));
});
