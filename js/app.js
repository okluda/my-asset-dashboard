/*
 * app.js
 * Vue 3 應用進入點：定義共用 store（reactive，含 localStorage 自動存檔）、
 * 4 個分頁元件（總覽/再平衡/明細/設定），以及底部分頁列。
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

const { createApp, reactive, computed, watch, ref } = Vue;

// ---------- 共用 reactive store ----------
const store = reactive({
  records: ALD.loadRecords(),
  settings: ALD.loadSettings(),
  accounts: ALD.loadAccounts(),
});

watch(
  () => store.records,
  (val) => ALD.saveRecords(val),
  { deep: true }
);

watch(
  () => store.settings,
  (val) => ALD.saveSettings(val),
  { deep: true }
);

watch(
  () => store.accounts,
  (val) => ALD.saveAccounts(val),
  { deep: true }
);

// 外觀主題（配色/字型/字型大小）：載入時立即套用，設定變更時即時反映
watch(() => store.settings, (val) => ALD.applyTheme(val), { deep: true, immediate: true });

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
        return { type, amount, ratio };
      });
    });

    return {
      totalAssets,
      totalLiabilities,
      netAssets,
      liabilityRatio,
      breakdown,
      fmt: (v) => ALD.formatAmount(v, store.settings),
      pct: (v) => ALD.formatPercent(v),
      catName: (t) => ALD.categoryDisplayName(store.settings, t),
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
      action,
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
    // 第三層（帳戶/項目）篩選：空陣列代表顯示全部
    const selectedAccounts = ref([]);

    const isInvest = computed(() => activeType.value === "投資");

    // 目前子分頁類別的所有明細
    const typeRecords = computed(() =>
      store.records.filter((r) => r.type === activeType.value)
    );

    // 日期篩選：預設當天。點一下切換是否套用篩選；長按開啟日期選擇器修改要篩選的日期。
    const dateFilterValue = ref(ALD.todayStr());
    const dateFilterActive = ref(false);
    const dateFilterInput = ref(null);
    let longPressTimer = null;
    let longPressTriggered = false;

    function startLongPress() {
      longPressTriggered = false;
      longPressTimer = setTimeout(() => {
        longPressTriggered = true;
        const el = dateFilterInput.value;
        if (!el) return;
        if (typeof el.showPicker === "function") el.showPicker();
        else el.click();
      }, 550);
    }

    function cancelLongPress() {
      if (longPressTimer) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
      }
    }

    // 短按：切換是否套用「篩選對應日期的資料」；長按觸發後的這次 click 不切換篩選狀態
    function onDateFilterClick() {
      if (longPressTriggered) {
        longPressTriggered = false;
        return;
      }
      dateFilterActive.value = !dateFilterActive.value;
    }

    // 長按選好新日期後，直接套用篩選（讓使用者能立即看到該日期的資料）
    function onDateFilterInputChange() {
      dateFilterActive.value = true;
    }

    // 套用第三層篩選、日期篩選後，實際顯示於下方明細的資料
    const visibleRecords = computed(() => {
      let list = typeRecords.value;
      if (selectedAccounts.value.length > 0) {
        list = list.filter((r) => selectedAccounts.value.includes(r.account || "(未命名)"));
      }
      if (dateFilterActive.value) {
        list = list.filter((r) => r.date === dateFilterValue.value);
      }
      return list;
    });

    // 幣別分組標籤：投資用「台股/美股」，非投資用「台幣合計/美元合計」
    function groupLabel(type, currency) {
      if (type === "投資") {
        const m = { TWD: "台股", USD: "美股" };
        return m[currency] || currency;
      }
      const m = { TWD: "台幣合計", USD: "美元合計" };
      return m[currency] || currency + " 合計";
    }

    // 依幣別 -> 帳戶/項目 兩層分組彙總。金額一律用「金額(台幣)」加總。
    const summary = computed(() => {
      const recs = typeRecords.value.filter((r) => !r.excluded);
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

    // 切換子分頁時清除篩選
    watch(activeType, () => {
      selectedAccounts.value = [];
    });

    function toggleSelect(accountName) {
      const arr = selectedAccounts.value;
      const idx = arr.indexOf(accountName);
      if (idx === -1) arr.push(accountName);
      else arr.splice(idx, 1);
    }

    function isSelected(accountName) {
      return selectedAccounts.value.includes(accountName);
    }

    // 新增時預設帶入目前子分頁的類別
    function addRow() {
      store.records.push(ALD.emptyRecord(activeType.value));
    }

    function removeRow(id) {
      const idx = store.records.findIndex((r) => r.id === id);
      if (idx !== -1) store.records.splice(idx, 1);
    }

    // 金額 = 價格 × 單位 × 匯率（計算欄位）；非投資鎖定槓桿=0（價格改由帳戶設定帶入）
    function recalc(rec) {
      if (rec.type !== "投資") {
        rec.leverage = 0;
      }
      rec.amount = ALD.amountTWD(rec);
    }

    // 依「設定 > 帳戶」中該類別對應帳戶/項目的價格，寫入此筆明細的價格
    function applyAccountPrice(rec) {
      const p = ALD.lookupAccountPrice(store.accounts, rec.type, rec.account);
      if (p !== null) rec.unitPrice = p;
    }

    // 該類別可選的帳戶/項目清單（含目前值，避免現有資料的帳戶不在清單時消失）
    function accountOptions(rec) {
      const opts = ALD.accountsForCategory(store.accounts, rec.type);
      if (rec.account && !opts.includes(rec.account)) return [rec.account, ...opts];
      return opts;
    }

    // 選擇帳戶/項目時，帶入對應價格並重算金額
    function onAccountChange(rec) {
      applyAccountPrice(rec);
      recalc(rec);
    }

    // 類別變更時，重新帶入對應價格、套用非投資固定值並重算金額
    function onTypeChange(rec) {
      applyAccountPrice(rec);
      recalc(rec);
    }

    function money(rec) {
      return ALD.amountTWD(rec);
    }

    function exposure(rec) {
      return ALD.exposureTWD(rec);
    }

    return {
      settings,
      types,
      activeType,
      isInvest,
      typeRecords,
      visibleRecords,
      summary,
      selectedAccounts,
      toggleSelect,
      isSelected,
      addRow,
      removeRow,
      recalc,
      onTypeChange,
      onAccountChange,
      accountOptions,
      money,
      exposure,
      dateFilterValue,
      dateFilterActive,
      dateFilterInput,
      startLongPress,
      cancelLongPress,
      onDateFilterClick,
      onDateFilterInputChange,
      num: (v) => (Number(v) || 0).toLocaleString("zh-TW"),
      fmt: (v) => ALD.formatAmount(v, store.settings),
      catName: (t) => ALD.categoryDisplayName(store.settings, t),
    };
  },
};

// ---------- 設定 ----------
const TabSettings = {
  template: "#tpl-settings",
  setup() {
    const settings = store.settings;
    const accounts = store.accounts;
    const settingsTab = ref("system");
    const assetCategoryKeys = ALD.ASSET_TYPES;
    const types = ALD.TYPES;
    const syncing = ref(false);
    const catName = (t) => ALD.categoryDisplayName(store.settings, t);

    // 將例外完整資訊（含 stack）顯示到畫面錯誤橫幅，方便截圖回報
    function reportError(prefix, e) {
      const detail =
        (e && e.stack ? e.stack : e && e.message ? e.message : String(e)) || "未知錯誤";
      if (window.__showAppError) window.__showAppError(prefix + "\n" + detail);
      console.error(prefix, e);
    }

    // 資產子類別名稱：留空時回填預設（等於鍵）
    function onCategoryNameBlur(key) {
      if (!settings.categoryNames[key] || !settings.categoryNames[key].trim()) {
        settings.categoryNames[key] = key;
      }
    }

    // 新增一筆帳戶/項目設定，預設類別為第一個資產子類別
    function addAccount() {
      store.accounts.push(ALD.emptyAccount(assetCategoryKeys[0]));
    }

    function removeAccount(id) {
      const idx = store.accounts.findIndex((a) => a.id === id);
      if (idx !== -1) store.accounts.splice(idx, 1);
    }

    // 把帳戶設定中的價格套回對應的明細資料並重算金額
    function applyPricesToRecords() {
      for (const rec of store.records) {
        const p = ALD.lookupAccountPrice(store.accounts, rec.type, rec.account);
        if (p !== null) rec.unitPrice = p;
        if (rec.type !== "投資") rec.leverage = 0;
        rec.amount = ALD.amountTWD(rec);
      }
    }

    // 同步「投資」類別帳戶的即時價格（市值），完成後套回明細
    async function syncPrices() {
      if (syncing.value) return;
      syncing.value = true;
      let ok = 0;
      let fail = 0;
      try {
        for (const acc of store.accounts) {
          if (acc.category === "投資" && acc.account) {
            try {
              acc.price = ALD.round2(await ALD_SERVICE.fetchStockPrice(acc.account));
              ok++;
            } catch (e) {
              fail++;
            }
          }
        }
        applyPricesToRecords();
        alert(
          "價格同步完成：成功 " + ok + " 筆，失敗 " + fail + " 筆" +
            (fail > 0 ? "（失敗可能因無法連外，請改用手動輸入）" : "")
        );
      } catch (e) {
        reportError("價格同步失敗：", e);
      } finally {
        syncing.value = false;
      }
    }

    function exportCsv() {
      try {
        ALD.exportCSV(store.records, store.settings);
      } catch (e) {
        reportError("匯出 CSV 失敗：", e);
      }
    }

    async function importCsv(evt) {
      const file = evt.target.files[0];
      if (!file) return;
      try {
        const imported = await ALD.parseCSV(file, store.settings);
        store.records.push(...imported);
        const skipped = imported.__skipped || 0;
        alert(
          "已匯入 " + imported.length + " 筆資料" +
            (skipped > 0 ? "\n（略過 " + skipped + " 筆：類型空白或不符值域）" : "")
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

    function resetData() {
      try {
        if (!confirm("確定要清除所有本地資料嗎？此動作無法復原，建議先匯出 CSV 備份。")) return;
        store.records.splice(0, store.records.length);
        // 明確寫入空陣列，避免 deep watch 之後又蓋回，且下次載入不會重新種入模擬資料
        ALD.saveRecords([]);
        alert("已清除本地資料");
      } catch (e) {
        reportError("清除資料失敗：", e);
        alert("清除資料失敗：" + (e && e.message ? e.message : e));
      }
    }

    // 強制清除：用於一般清除按鈕因資料損毀（例如 localStorage 內容非合法 JSON）而失效時。
    // 修正：不可用 removeItem 直接移除金鑰——那會讓 loadRecords() 誤判為「App 從未初始化」
    // 而自動重新種入模擬資料，造成「看起來沒清除成功」的假象。改為明確寫入空陣列/預設設定。
    function forceReset() {
      if (!confirm("強制清除會移除所有本地資料與設定並重新載入頁面，確定嗎？")) return;
      try {
        localStorage.setItem("ald_records_v1", "[]");
        localStorage.setItem("ald_settings_v1", JSON.stringify(ALD.DEFAULT_SETTINGS));
      } catch (e) {
        // 寫入也失敗（例如 localStorage 損毀無法存取）時，才退回整體清空
        try { localStorage.clear(); } catch (_) {}
      }
      location.reload();
    }

    return {
      settings,
      accounts,
      settingsTab,
      assetCategoryKeys,
      types,
      syncing,
      catName,
      onCategoryNameBlur,
      addAccount,
      removeAccount,
      syncPrices,
      exportCsv,
      importCsv,
      loadSample,
      resetData,
      forceReset,
      themeColors: ALD.THEME_COLORS,
      fontFamilies: ALD.FONT_FAMILIES,
      fontSizes: ALD.FONT_SIZES,
    };
  },
};

// ---------- 根元件：底部分頁列 + 分頁切換 ----------
const App = {
  components: { TabOverview, TabRebalance, TabDetail, TabSettings },
  template: `
    <div class="page-header">
      {{ tabTitles[activeTab] }}
    </div>
    <component :is="activeComponent"></component>
    <nav class="tab-bar">
      <button
        v-for="tab in tabs"
        :key="tab.key"
        class="tab-btn"
        :class="{ active: activeTab === tab.key }"
        @click="activeTab = tab.key"
      >
        <span class="tab-icon">{{ tab.icon }}</span>
        <span>{{ tab.label }}</span>
      </button>
    </nav>
  `,
  setup() {
    const activeTab = ref("overview");
    const tabs = [
      { key: "overview", label: "總覽", icon: "📊", component: "TabOverview" },
      { key: "rebalance", label: "再平衡", icon: "⚖️", component: "TabRebalance" },
      { key: "detail", label: "明細", icon: "📋", component: "TabDetail" },
      { key: "settings", label: "設定", icon: "⚙️", component: "TabSettings" },
    ];
    const tabTitles = Object.fromEntries(tabs.map((t) => [t.key, t.label]));
    const activeComponent = computed(
      () => tabs.find((t) => t.key === activeTab.value).component
    );
    return { activeTab, tabs, tabTitles, activeComponent };
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
app.mount("#app");
// 明確標記「App 已成功掛載」，供錯誤橫幅判斷健康狀態使用；
// 避免用 DOM 子節點數量判斷（掛載前一瞬間會誤判為不健康）。
window.__appMounted = true;
if (window.__refreshErrorBanner) window.__refreshErrorBanner();
