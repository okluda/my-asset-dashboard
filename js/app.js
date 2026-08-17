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
    const settings = store.settings;
    const types = ALD.TYPES;
    const activeType = ref(types[0]);
    const refreshing = ref(false);

    const isInvest = computed(() => activeType.value === "投資");

    // 僅顯示目前子分頁類別的明細
    const visibleRecords = computed(() =>
      store.records.filter((r) => r.type === activeType.value)
    );

    // 幣別分組標籤：投資用「台股/美股」，其餘用「類別(台幣/美元)」
    function groupLabel(type, currency) {
      if (type === "投資") {
        const m = { TWD: "台股", USD: "美股" };
        return m[currency] || currency;
      }
      const m = { TWD: "台幣", USD: "美元" };
      const cur = m[currency] || currency;
      return `${type}(${cur})`;
    }

    // 依幣別 -> 帳戶/項目 兩層分組彙總
    const summary = computed(() => {
      const recs = visibleRecords.value;
      const groupsMap = {};
      recs.forEach((r) => {
        const cur = r.currency || "TWD";
        if (!groupsMap[cur]) {
          groupsMap[cur] = { key: cur, currency: cur, subtotalTWD: 0, accounts: {} };
        }
        const g = groupsMap[cur];
        g.subtotalTWD = ALD.round2(g.subtotalTWD + ALD.amountTWD(r));
        const acctKey = r.account || "(未命名)";
        if (!g.accounts[acctKey]) {
          g.accounts[acctKey] = {
            key: acctKey,
            account: acctKey,
            currency: cur,
            amountOrig: 0,
            amountTWD: 0,
            units: 0,
          };
        }
        const a = g.accounts[acctKey];
        a.amountOrig = ALD.round2(a.amountOrig + (Number(r.amount) || 0));
        a.amountTWD = ALD.round2(a.amountTWD + ALD.amountTWD(r));
        a.units = ALD.round2(a.units + (Number(r.units) || 0));
      });
      const groups = Object.values(groupsMap).map((g) => ({
        key: g.key,
        label: groupLabel(activeType.value, g.currency),
        subtotalTWD: g.subtotalTWD,
        accounts: Object.values(g.accounts),
      }));
      const totalTWD = ALD.round2(groups.reduce((s, g) => s + g.subtotalTWD, 0));
      return { groups, totalTWD };
    });

    // 新增時預設帶入目前子分頁的類別
    function addRow() {
      store.records.push(ALD.emptyRecord(activeType.value));
    }

    function removeRow(id) {
      const idx = store.records.findIndex((r) => r.id === id);
      if (idx !== -1) store.records.splice(idx, 1);
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
            recalc(rec);
          }
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
      visibleRecords,
      summary,
      refreshing,
      addRow,
      removeRow,
      recalc,
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
