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

const { createApp, reactive, computed, watch, ref, onMounted, onUnmounted, nextTick } = Vue;

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
    // 帳戶/幣別篩選：多選，陣列中每筆為 { account, currency } 一組。
    // 空陣列代表不篩選。同名但不同幣別的帳戶視為不同選項（幣別取自該帳戶所屬
    // 分組，不寫死支援哪些幣別），多選之間為 OR 關係。
    const selectedAccountFilters = ref([]);
    // 不計入三態篩選：'all' 全部 / 'excluded' 已勾選不計入 / 'included' 未勾選不計入。
    // 僅影響「顯示」，不會修改任何一筆資料的 excluded 值。
    const excludedStatus = ref("all");

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

    // 收合摘要用日期顯示：只取 MM-DD，實際欄位（rec.date）仍完整保留 YYYY-MM-DD，
    // 編輯與儲存皆不受影響（此函式僅用於畫面顯示）。
    function dateMD(d) {
      if (!d || typeof d !== "string" || d.length < 10) return d || "";
      return d.slice(5);
    }

    const isInvest = computed(() => activeType.value === "投資");

    // 目前子分頁類別的所有明細
    const typeRecords = computed(() =>
      store.records.filter((r) => r.type === activeType.value)
    );

    // 日期篩選：「顯示日期」(dateFilterValue) 與「是否套用篩選」(dateFilterActive) 分開管理。
    // 短按日期按鈕：切換是否套用篩選；前一天/後一天按鈕：切換顯示日期並立即套用篩選；
    // 日曆按鈕：開啟原生 date input 選擇日期，選定後立即套用，取消則維持原狀。
    const dateFilterValue = ref(ALD.todayStr());
    const dateFilterActive = ref(false);
    const dateFilterInput = ref(null);

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

    // 前一天／後一天：切換顯示日期後立即套用篩選
    function goPrevDay() {
      dateFilterValue.value = shiftDateStr(dateFilterValue.value, -1);
      dateFilterActive.value = true;
    }
    function goNextDay() {
      dateFilterValue.value = shiftDateStr(dateFilterValue.value, 1);
      dateFilterActive.value = true;
    }

    // 日曆入口：直接開啟原生 date input 選擇日期，不再依賴長按。
    // showPicker() 並非所有瀏覽器/裝置都支援，故先做功能檢測並包 try/catch，
    // 失敗時 fallback 為直接觸發 input 的 click（多數手機瀏覽器點擊 date input 即會跳出原生選擇器）。
    function openDatePicker() {
      const el = dateFilterInput.value;
      if (!el) return;
      try {
        if (typeof el.showPicker === "function") {
          el.showPicker();
          return;
        }
      } catch (e) {
        // 部分瀏覽器（如需使用者手勢觸發）showPicker 可能拋出例外，改用 fallback
      }
      el.click();
    }

    // 使用者透過日曆選好日期並確認後，原生 input 觸發 change，立即套用篩選
    // （若使用者按「取消」，change 不會觸發，日期與篩選條件維持不變）
    function onDateFilterInputChange() {
      dateFilterActive.value = true;
    }

    // 套用帳戶/幣別（多選 OR）、不計入、日期三種篩選後，實際顯示於下方明細的資料。
    // 帳戶/幣別多選之間為 OR，選取結果再與不計入、日期條件做 AND；
    // 此為唯一計算篩選結果的地方，資料新增/刪除/修改後（store.records 變動）
    // 會自動重新計算，不需額外處理。
    const visibleRecords = computed(() => {
      let list = typeRecords.value;
      const sel = selectedAccountFilters.value;
      if (sel.length > 0) {
        list = list.filter((r) =>
          sel.some(
            (s) => (r.account || "(未命名)") === s.account && (r.currency || "TWD") === s.currency
          )
        );
      }
      if (excludedStatus.value === "excluded") {
        list = list.filter((r) => ALD.isExcluded(r));
      } else if (excludedStatus.value === "included") {
        list = list.filter((r) => !ALD.isExcluded(r));
      }
      if (dateFilterActive.value) {
        list = list.filter((r) => r.date === dateFilterValue.value);
      }
      return list;
    });

    // 目前是否有任何一種篩選條件生效（供摘要列與空狀態顯示判斷）
    const hasActiveFilter = computed(
      () => selectedAccountFilters.value.length > 0 || excludedStatus.value !== "all" || dateFilterActive.value
    );

    // 清除全部篩選：帳戶/幣別（全部取消選取）、不計入、日期篩選狀態與卡片高亮一併重設。
    // 日期文字回到「今天」——與「日期篩選預設值＝當天」的既有邏輯一致，
    // 避免清除後按鈕仍停留在使用者先前長按選過的日期，造成混淆。
    function clearFilters() {
      selectedAccountFilters.value = [];
      excludedStatus.value = "all";
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
        const va = a.date, vb = b.date;
        const validA = isValidDateStr(va), validB = isValidDateStr(vb);
        if (!validA && !validB) return 0;
        if (!validA) return 1;
        if (!validB) return -1;
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

    // 先套用既有篩選（visibleRecords），再依排序條件排序；用 slice() 複製陣列後排序，
    // 不直接對原始資料呼叫 sort()，故不會影響 store.records 與 localStorage 的儲存順序。
    const sortedRecords = computed(() => {
      const rules = sortRules.value;
      const arr = visibleRecords.value.slice();
      if (rules.length === 0) return arr;
      arr.sort((a, b) => {
        for (const rule of rules) {
          const cmp = compareByRule(a, b, rule);
          if (cmp !== 0) return cmp;
        }
        return 0;
      });
      return arr;
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

    // 切換子分頁時，帳戶/幣別篩選對象已不存在於新類別中，故重設；
    // 不計入、日期篩選為跨類別的通用條件，維持不變。
    watch(activeType, () => {
      selectedAccountFilters.value = [];
    });

    // 點選幣別分組下的帳戶卡片：多選（OR）。以「帳戶＋幣別」為篩選條件（幣別取自
    // 該卡片所屬分組，不寫死 TWD/USD，動態支援設定中新增的任何幣別）。
    // 點擊未選帳戶為加入選取，點擊已選帳戶則從選取清單移除（取消）。
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

    // 新增時預設帶入目前子分頁的類別
    function addRow() {
      store.records.push(ALD.emptyRecord(activeType.value));
    }

    function removeRow(id) {
      const idx = store.records.findIndex((r) => r.id === id);
      if (idx !== -1) store.records.splice(idx, 1);
      expandedIds.value.delete(id); // 清除已刪除項目殘留的展開狀態，避免累積無用資料
    }

    // 金額 = 價格 × 單位 × 匯率（計算欄位）
    function recalc(rec) {
      rec.amount = ALD.amountTWD(rec);
    }

    // 依「設定 > 帳戶」中該類別對應帳戶/項目的價格與槓桿倍數，寫入此筆明細
    function applyAccountConfig(rec) {
      const p = ALD.lookupAccountPrice(store.accounts, rec.type, rec.account);
      if (p !== null) rec.unitPrice = p;
      const lev = ALD.lookupAccountLeverage(store.accounts, rec.type, rec.account);
      if (lev !== null) rec.leverage = lev;
    }

    // 該類別可選的帳戶/項目清單（含目前值，避免現有資料的帳戶不在清單時消失）
    function accountOptions(rec) {
      const opts = ALD.accountsForCategory(store.accounts, rec.type);
      if (rec.account && !opts.includes(rec.account)) return [rec.account, ...opts];
      return opts;
    }

    // 選擇帳戶/項目時，帶入對應價格與槓桿倍數並重算金額
    function onAccountChange(rec) {
      applyAccountConfig(rec);
      recalc(rec);
    }

    // 類別變更時，重新帶入對應價格/槓桿倍數並重算金額
    function onTypeChange(rec) {
      applyAccountConfig(rec);
      recalc(rec);
    }

    // 幣別下拉選項：取自「設定 > 幣別」
    const currencyOptions = computed(() => ALD.currencyCodes(store.settings));

    // 選擇幣別時，依「設定 > 幣別」帶入對應匯率並重算金額
    function onCurrencyChange(rec) {
      const r = ALD.currencyRate(store.settings, rec.currency);
      if (r !== null) rec.fxRate = r;
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
      selectedAccountFilters,
      toggleAccountFilter,
      isAccountSelected,
      removeAccountFilter,
      excludedStatus,
      expandedIds,
      isExpanded,
      toggleExpand,
      dateMD,
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
      recalc,
      onTypeChange,
      onAccountChange,
      accountOptions,
      currencyOptions,
      onCurrencyChange,
      money,
      exposure,
      dateFilterValue,
      dateFilterActive,
      dateFilterInput,
      goPrevDay,
      goNextDay,
      openDatePicker,
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
    const syncingFx = ref(false);
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

    // 幣別代碼輸入完成：正規化（大寫、去重、確保基準幣別），並套回明細
    function onCurrencyCodeBlur() {
      ALD.normalizeCurrencies(settings);
      applyFxToRecords();
    }

    // 依「設定 > 幣別」的匯率，套回所有明細的匯率並重算金額
    function applyFxToRecords() {
      for (const rec of store.records) {
        const r = ALD.currencyRate(store.settings, rec.currency);
        if (r !== null) rec.fxRate = r;
        rec.amount = ALD.amountTWD(rec);
      }
    }

    // 同步各幣別對基準幣別的即時匯率，完成後套回明細
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
            cur.rate = ALD.round2(
              await ALD_SERVICE.fetchFxRate(cur.code, settings.baseCurrency)
            );
            ok++;
          } catch (e) {
            fail++;
          }
        }
        applyFxToRecords();
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

    // 新增一筆帳戶/項目設定，預設類別為第一個資產子類別
    function addAccount() {
      store.accounts.push(ALD.emptyAccount(assetCategoryKeys[0]));
    }

    function removeAccount(id) {
      const idx = store.accounts.findIndex((a) => a.id === id);
      if (idx !== -1) store.accounts.splice(idx, 1);
    }

    // 帳戶類別變更時，若槓桿倍數仍為預設值則依新類別調整（投資=1，其餘=0）
    function onAccountCategoryChange(acc) {
      const cur = Number(acc.leverage) || 0;
      if (cur === 0 || cur === 1) {
        acc.leverage = acc.category === "投資" ? 1 : 0;
      }
    }

    // 把帳戶設定中的價格套回對應的明細資料並重算金額
    function applyPricesToRecords() {
      for (const rec of store.records) {
        const p = ALD.lookupAccountPrice(store.accounts, rec.type, rec.account);
        if (p !== null) rec.unitPrice = p;
        rec.amount = ALD.amountTWD(rec);
      }
    }

    // 把帳戶設定中的槓桿倍數套回對應的明細資料並重算金額
    function applyLeverageToRecords() {
      for (const rec of store.records) {
        const lev = ALD.lookupAccountLeverage(store.accounts, rec.type, rec.account);
        if (lev !== null) rec.leverage = lev;
        rec.amount = ALD.amountTWD(rec);
      }
    }

    // 一次套用匯率、價格、槓桿倍數至所有明細
    function applyAllToRecords() {
      applyFxToRecords();
      applyPricesToRecords();
      applyLeverageToRecords();
    }

    // 匯出帳戶/項目設定為 CSV
    function exportAccountsCsv() {
      try {
        ALD.exportAccountsCSV(store.accounts, store.settings);
      } catch (e) {
        reportError("匯出帳戶設定失敗：", e);
      }
    }

    // 匯入帳戶/項目設定 CSV（取代現有設定）
    async function importAccountsCsv(evt) {
      const file = evt.target.files[0];
      if (!file) return;
      try {
        const imported = await ALD.parseAccountsCSV(file, store.settings);
        if (
          store.accounts.length > 0 &&
          !confirm("匯入將「取代」現有的帳戶/項目設定，確定要繼續嗎？")
        ) {
          return;
        }
        const skipped = imported.__skipped || 0;
        store.accounts.splice(0, store.accounts.length, ...imported);
        alert(
          "已匯入 " + imported.length + " 筆帳戶/項目設定" +
            (skipped > 0 ? "\n（略過 " + skipped + " 筆：類別空白或不符值域）" : "")
        );
      } catch (e) {
        reportError("帳戶設定匯入失敗：", e);
        alert("帳戶設定匯入失敗：" + (e && e.message ? e.message : e));
      } finally {
        evt.target.value = "";
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
        const imported = await ALD.parseCSV(file, store.settings, store.accounts);
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
      syncingFx,
      catName,
      onCategoryNameBlur,
      addCurrency,
      removeCurrency,
      onCurrencyCodeBlur,
      applyFxToRecords,
      syncFxRates,
      addAccount,
      removeAccount,
      onAccountCategoryChange,
      applyPricesToRecords,
      applyLeverageToRecords,
      applyAllToRecords,
      exportAccountsCsv,
      importAccountsCsv,
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
    <div class="page-header" ref="pageHeaderRef">
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
    <button
      v-if="activeTab === 'detail' && fabVisible"
      class="scroll-fab"
      @click="onScrollFab"
      aria-label="捲動至頂端或底部"
    >↑↓</button>
  `,
  setup() {
    const activeTab = ref("overview");
    const tabs = [
      { key: "overview", label: "總覽", icon: "⬠", component: "TabOverview" },
      { key: "rebalance", label: "再平衡", icon: "⟠", component: "TabRebalance" },
      { key: "detail", label: "明細", icon: "≣", component: "TabDetail" },
      { key: "settings", label: "設定", icon: "⛯", component: "TabSettings" },
    ];
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
      tabs,
      tabTitles,
      activeComponent,
      onScrollFab,
      fabVisible,
      pageHeaderRef,
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
app.mount("#app");
// 明確標記「App 已成功掛載」，供錯誤橫幅判斷健康狀態使用；
// 避免用 DOM 子節點數量判斷（掛載前一瞬間會誤判為不健康）。
window.__appMounted = true;
if (window.__refreshErrorBanner) window.__refreshErrorBanner();
