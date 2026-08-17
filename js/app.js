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
          .filter((r) => !r.excluded && r.type === "流動資產")
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
          .filter((r) => !r.excluded && (r.type === "流動資產" || r.type === "投資"))
          .reduce((sum, r) => sum + ALD.exposureTWD(r), 0)
      )
    );
    const exposureRatio = computed(() => (pool.value > 0 ? exposureTotal.value / pool.value : 0));

    // 目標：投資佔比 = rebalanceRatio(%)，流動資產佔比 = 100 - rebalanceRatio
    const action = computed(() => {
      const targetInvestRatio = (Number(settings.rebalanceRatio) || 70) / 100;
      const targetInvest = pool.value * targetInvestRatio;
      const diff = ALD.round2(targetInvest - investTWD.value);
      if (Math.abs(diff) < 1) {
        return { type: "hold", label: "已達平衡，無需調整", amount: 0 };
      }
      if (liquidTWD.value > investTWD.value) {
        // 流動資產偏高 -> 買入（將現金轉入投資）
        return { type: "buy", label: "建議：買入", amount: Math.abs(diff) };
      }
      // 投資偏高 -> 賣出（將投資轉回現金）
      return { type: "sell", label: "建議：賣出", amount: Math.abs(diff) };
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
    const refreshing = ref(false);
    // 第三層（帳戶/項目）篩選：空陣列代表顯示全部
    const selectedAccounts = ref([]);

    const isInvest = computed(() => activeType.value === "投資");

    // 目前子分頁類別的所有明細
    const typeRecords = computed(() =>
      store.records.filter((r) => r.type === activeType.value)
    );

    // 套用第三層篩選後、實際顯示於下方明細的資料
    const visibleRecords = computed(() => {
      if (selectedAccounts.value.length === 0) return typeRecords.value;
      return typeRecords.value.filter((r) =>
        selectedAccounts.value.includes(r.account || "(未命名)")
      );
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

    // 金額 = 單價 × 單位/額數 × 匯率（計算欄位）；非投資鎖定單價=1、槓桿=0
    function recalc(rec) {
      if (rec.type !== "投資") {
        rec.unitPrice = 1;
        rec.leverage = 0;
      }
      rec.amount = ALD.amountTWD(rec);
    }

    // 類別變更時，套用非投資的固定值並重算金額
    function onTypeChange(rec) {
      recalc(rec);
    }

    function money(rec) {
      return ALD.amountTWD(rec);
    }

    function exposure(rec) {
      return ALD.exposureTWD(rec);
    }

    // 一次更新所有資料的匯率與（投資的）市價
    async function refreshAll() {
      if (refreshing.value) return;
      refreshing.value = true;
      let ok = 0;
      let fail = 0;
      for (const rec of store.records) {
        try {
          if (rec.currency && rec.currency !== settings.baseCurrency) {
            rec.fxRate = ALD.round2(
              await ALD_SERVICE.fetchFxRate(rec.currency, settings.baseCurrency)
            );
          }
          if (rec.type === "投資" && rec.account) {
            rec.unitPrice = ALD.round2(await ALD_SERVICE.fetchStockPrice(rec.account));
          }
          recalc(rec);
          ok++;
        } catch (e) {
          fail++;
        }
      }
      refreshing.value = false;
      alert(
        `更新完成：成功 ${ok} 筆，失敗 ${fail} 筆` +
          (fail > 0 ? "（失敗可能因無法連外，請改用手動輸入）" : "")
      );
    }

    return {
      settings,
      types,
      activeType,
      isInvest,
      typeRecords,
      visibleRecords,
      summary,
      refreshing,
      selectedAccounts,
      toggleSelect,
      isSelected,
      addRow,
      removeRow,
      recalc,
      onTypeChange,
      money,
      exposure,
      refreshAll,
      num: (v) => (Number(v) || 0).toLocaleString("zh-TW"),
    };
  },
};

// ---------- 設定 ----------
const TabSettings = {
  template: "#tpl-settings",
  setup() {
    const settings = store.settings;

    // 將例外完整資訊（含 stack）顯示到畫面錯誤橫幅，方便截圖回報
    function reportError(prefix, e) {
      const detail =
        (e && e.stack ? e.stack : e && e.message ? e.message : String(e)) || "未知錯誤";
      if (window.__showAppError) window.__showAppError(prefix + "\n" + detail);
      console.error(prefix, e);
    }

    function exportCsv() {
      try {
        ALD.exportCSV(store.records);
      } catch (e) {
        reportError("匯出 CSV 失敗：", e);
      }
    }

    async function importCsv(evt) {
      const file = evt.target.files[0];
      if (!file) return;
      try {
        const imported = await ALD.parseCSV(file);
        store.records.push(...imported);
        alert("已匯入 " + imported.length + " 筆資料");
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

    // 強制清除：直接移除 localStorage 所有本 App 的鍵並重新整理，
    // 用於資料損毀導致一般清除失效時
    function forceReset() {
      if (!confirm("強制清除會移除所有本地資料與設定並重新載入頁面，確定嗎？")) return;
      try {
        localStorage.removeItem("ald_records_v1");
        localStorage.removeItem("ald_settings_v1");
      } catch (e) {
        // 即使個別 removeItem 失敗，仍嘗試整體清空
        try { localStorage.clear(); } catch (_) {}
      }
      location.reload();
    }

    return { settings, exportCsv, importCsv, loadSample, resetData, forceReset };
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
