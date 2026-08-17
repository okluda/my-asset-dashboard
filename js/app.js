/*
 * app.js
 * Vue 3 應用進入點：定義共用 store（reactive，含 localStorage 自動存檔）、
 * 4 個分頁元件（總覽/再平衡/明細/設定），以及底部分頁列。
 */

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
          .filter((r) => ALD.ASSET_TYPES.includes(r.type))
          .reduce((sum, r) => sum + ALD.amountTWD(r), 0)
      )
    );
    const totalLiabilities = computed(() =>
      ALD.round2(
        store.records
          .filter((r) => r.type === "負債")
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
            .filter((r) => r.type === type)
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
          .filter((r) => r.type === "流動資產")
          .reduce((sum, r) => sum + ALD.amountTWD(r), 0)
      )
    );
    const investTWD = computed(() =>
      ALD.round2(
        store.records
          .filter((r) => r.type === "投資")
          .reduce((sum, r) => sum + ALD.amountTWD(r), 0)
      )
    );
    const pool = computed(() => ALD.round2(liquidTWD.value + investTWD.value));
    const liquidRatio = computed(() => (pool.value > 0 ? liquidTWD.value / pool.value : 0));
    const investRatio = computed(() => (pool.value > 0 ? investTWD.value / pool.value : 0));

    const exposureTotal = computed(() =>
      ALD.round2(
        store.records
          .filter((r) => r.type === "流動資產" || r.type === "投資")
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
    const records = store.records;
    const settings = store.settings;
    const types = ALD.TYPES;

    const groupedSummary = computed(() => {
      const groups = {};
      records.forEach((r) => {
        if (!["流動資產", "負債", "投資"].includes(r.type)) return;
        const key = `${r.type}|${r.account}|${r.currency}`;
        if (!groups[key]) {
          groups[key] = {
            type: r.type,
            account: r.account || "(未命名)",
            currency: r.currency || "TWD",
            amountSum: 0,
            amountTWDSum: 0,
            unitsSum: 0,
          };
        }
        groups[key].amountSum = ALD.round2(groups[key].amountSum + (Number(r.amount) || 0));
        groups[key].amountTWDSum = ALD.round2(groups[key].amountTWDSum + ALD.amountTWD(r));
        groups[key].unitsSum = ALD.round2(groups[key].unitsSum + (Number(r.units) || 0));
      });
      return Object.values(groups);
    });

    function addRow() {
      records.push(ALD.emptyRecord());
    }

    function removeRow(id) {
      const idx = records.findIndex((r) => r.id === id);
      if (idx !== -1) records.splice(idx, 1);
    }

    // 投資類別：單價 * 單位數 自動帶入金額
    function recalc(rec) {
      if (rec.type === "投資" && rec.unitPrice > 0 && rec.units > 0) {
        rec.amount = ALD.round2(rec.unitPrice * rec.units);
      }
    }

    function exposure(rec) {
      return ALD.exposureTWD(rec);
    }

    async function updateFx(rec) {
      try {
        rec.fxRate = ALD.round2(
          await ALD_SERVICE.fetchFxRate(rec.currency, settings.baseCurrency)
        );
      } catch (e) {
        alert("匯率查詢失敗，請改用手動輸入：" + e.message);
      }
    }

    async function updateStock(rec) {
      try {
        rec.unitPrice = ALD.round2(await ALD_SERVICE.fetchStockPrice(rec.account));
        recalc(rec);
      } catch (e) {
        alert("股價查詢失敗，請改用手動輸入單價：" + e.message);
      }
    }

    return {
      records,
      settings,
      types,
      groupedSummary,
      addRow,
      removeRow,
      recalc,
      exposure,
      updateFx,
      updateStock,
      fmt: (v) => ALD.formatAmount(v, store.settings),
    };
  },
};

// ---------- 設定 ----------
const TabSettings = {
  template: "#tpl-settings",
  setup() {
    const settings = store.settings;

    function exportCsv() {
      ALD.exportCSV(store.records);
    }

    async function importCsv(evt) {
      const file = evt.target.files[0];
      if (!file) return;
      try {
        const imported = await ALD.parseCSV(file);
        store.records.push(...imported);
        alert("已匯入 " + imported.length + " 筆資料");
      } catch (e) {
        alert("CSV 匯入失敗：" + e.message);
      } finally {
        evt.target.value = "";
      }
    }

    function loadSample() {
      if (
        store.records.length > 0 &&
        !confirm("載入模擬資料會「附加」在現有資料之後，確定要載入嗎？")
      ) {
        return;
      }
      store.records.push(...ALD.seedRecords());
      alert("已載入模擬資料");
    }

    function resetData() {
      if (!confirm("確定要清除所有本地資料嗎？此動作無法復原，建議先匯出 CSV 備份。")) return;
      store.records.splice(0, store.records.length);
      localStorage.removeItem("ald_records_v1");
      alert("已清除本地資料");
    }

    return { settings, exportCsv, importCsv, loadSample, resetData };
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
    window.__showAppError((err && err.message ? err.message : String(err)) + "\n(" + info + ")");
  }
};
app.mount("#app");
