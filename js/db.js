/*
 * db.js
 * IndexedDB 儲存層：提供 records / settings / accounts 三個 object store 的
 * 統一非同步存取 API，是 App 目前唯一的正式資料讀寫來源（見 app.js 的初始化與 watch 保存流程）。
 */

const ALD_DB = (() => {
  const DB_NAME = "my_asset_dashboard";
  // v2：新增 syncLogs store（同步價格/匯率的執行記錄），既有 3 個 store 結構不變。
  const DB_VERSION = 2;

  const STORE_RECORDS = "records";
  const STORE_SETTINGS = "settings";
  const STORE_ACCOUNTS = "accounts";
  const STORE_SYNC_LOGS = "syncLogs";
  const ALL_STORES = [STORE_RECORDS, STORE_SETTINGS, STORE_ACCOUNTS, STORE_SYNC_LOGS];

  // settings 採「固定 key 的單筆設計」：整個 settings 物件以此固定 key 存成一筆記錄，
  // 不可拆成多筆，避免破壞其物件結構。
  const SETTINGS_KEY = "app-settings";

  // 快取資料庫連線的 Promise，避免重複開啟連線。
  let dbPromise = null;

  // 開啟（並視需要建立）資料庫。失敗時 reject Error，不吞錯誤。
  function openDatabase() {
    if (dbPromise) return dbPromise;

    dbPromise = new Promise((resolve, reject) => {
      let request;
      try {
        request = indexedDB.open(DB_NAME, DB_VERSION);
      } catch (e) {
        dbPromise = null;
        reject(e instanceof Error ? e : new Error(String(e)));
        return;
      }

      request.onupgradeneeded = (event) => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_RECORDS)) {
          db.createObjectStore(STORE_RECORDS, { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains(STORE_SETTINGS)) {
          // settings 不使用 keyPath，改由呼叫端指定固定 key（out-of-line key）。
          db.createObjectStore(STORE_SETTINGS);
        }
        if (!db.objectStoreNames.contains(STORE_ACCOUNTS)) {
          db.createObjectStore(STORE_ACCOUNTS, { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains(STORE_SYNC_LOGS)) {
          db.createObjectStore(STORE_SYNC_LOGS, { keyPath: "id" });
        }
      };

      request.onsuccess = () => {
        const db = request.result;
        // 若資料庫在其他分頁被要求升級版本而關閉，清除快取，讓下次呼叫重新開啟。
        db.onversionchange = () => {
          db.close();
          dbPromise = null;
        };
        resolve(db);
      };

      request.onerror = () => {
        dbPromise = null;
        reject(request.error || new Error("IndexedDB 開啟失敗"));
      };

      // 有其他分頁持有舊版本連線未關閉，導致升級被阻擋。
      request.onblocked = () => {
        dbPromise = null;
        reject(new Error("IndexedDB 開啟被阻擋：請關閉其他開啟本應用程式的分頁後再試一次"));
      };
    });

    return dbPromise;
  }

  function assertKnownStore(storeName) {
    if (!ALL_STORES.includes(storeName)) {
      throw new Error(`未知的 object store：${storeName}`);
    }
  }

  // 讀取指定 store 內所有記錄（僅適用於 keyPath store：records、accounts）。
  function getAll(storeName) {
    return openDatabase().then(
      (db) =>
        new Promise((resolve, reject) => {
          let tx;
          try {
            tx = db.transaction(storeName, "readonly");
          } catch (e) {
            reject(e instanceof Error ? e : new Error(String(e)));
            return;
          }
          const store = tx.objectStore(storeName);
          const request = store.getAll();

          request.onerror = () => reject(request.error || new Error(`讀取 ${storeName} 失敗`));
          tx.onerror = () => reject(tx.error || new Error(`讀取 ${storeName} 的 transaction 失敗`));
          tx.onabort = () => reject(tx.error || new Error(`讀取 ${storeName} 的 transaction 被中止`));
          tx.oncomplete = () => resolve(request.result || []);
        })
    );
  }

  // 以單一 transaction 完整取代指定 keyPath store 的內容（先清空，再逐筆寫入）。
  function replaceAll(storeName, items) {
    if (!Array.isArray(items)) {
      return Promise.reject(new Error(`${storeName} 的資料必須為陣列`));
    }
    return openDatabase().then(
      (db) =>
        new Promise((resolve, reject) => {
          let tx;
          try {
            tx = db.transaction(storeName, "readwrite");
          } catch (e) {
            reject(e instanceof Error ? e : new Error(String(e)));
            return;
          }
          const store = tx.objectStore(storeName);

          tx.onerror = () => reject(tx.error || new Error(`寫入 ${storeName} 的 transaction 失敗`));
          tx.onabort = () => reject(tx.error || new Error(`寫入 ${storeName} 的 transaction 被中止`));
          tx.oncomplete = () => resolve();

          try {
            store.clear();
            items.forEach((item) => store.put(item));
          } catch (e) {
            // 同步例外（例如資料不含有效 keyPath）會中止 transaction，
            // 由上方 tx.onabort/tx.onerror 負責 reject，這裡不需重複處理。
          }
        })
    );
  }

  function loadRecords() {
    return getAll(STORE_RECORDS);
  }

  function replaceRecords(records) {
    return replaceAll(STORE_RECORDS, records);
  }

  function loadAccounts() {
    return getAll(STORE_ACCOUNTS);
  }

  function replaceAccounts(accounts) {
    return replaceAll(STORE_ACCOUNTS, accounts);
  }

  // 同步記錄（同步價格/匯率的執行記錄，含 API 請求/回應內容）。
  function loadSyncLogs() {
    return getAll(STORE_SYNC_LOGS);
  }

  function replaceSyncLogs(logs) {
    return replaceAll(STORE_SYNC_LOGS, logs);
  }

  // 讀取 settings（固定 key 單筆物件）。從未儲存過時回傳 null。
  function loadSettings() {
    return openDatabase().then(
      (db) =>
        new Promise((resolve, reject) => {
          let tx;
          try {
            tx = db.transaction(STORE_SETTINGS, "readonly");
          } catch (e) {
            reject(e instanceof Error ? e : new Error(String(e)));
            return;
          }
          const store = tx.objectStore(STORE_SETTINGS);
          const request = store.get(SETTINGS_KEY);

          request.onerror = () => reject(request.error || new Error("讀取 settings 失敗"));
          tx.onerror = () => reject(tx.error || new Error("讀取 settings 的 transaction 失敗"));
          tx.onabort = () => reject(tx.error || new Error("讀取 settings 的 transaction 被中止"));
          tx.oncomplete = () => resolve(request.result === undefined ? null : request.result);
        })
    );
  }

  // 寫入 settings（固定 key，整個物件視為單筆記錄覆寫，不拆成多筆）。
  function saveSettings(settings) {
    if (settings === undefined) {
      return Promise.reject(new Error("settings 不可為 undefined"));
    }
    return openDatabase().then(
      (db) =>
        new Promise((resolve, reject) => {
          let tx;
          try {
            tx = db.transaction(STORE_SETTINGS, "readwrite");
          } catch (e) {
            reject(e instanceof Error ? e : new Error(String(e)));
            return;
          }
          const store = tx.objectStore(STORE_SETTINGS);

          tx.onerror = () => reject(tx.error || new Error("寫入 settings 的 transaction 失敗"));
          tx.onabort = () => reject(tx.error || new Error("寫入 settings 的 transaction 被中止"));
          tx.oncomplete = () => resolve();

          store.put(settings, SETTINGS_KEY);
        })
    );
  }

  // 清空單一 store，但不刪除資料庫結構（store 本身仍存在，僅內容清空）。
  function clearStore(storeName) {
    try {
      assertKnownStore(storeName);
    } catch (e) {
      return Promise.reject(e);
    }
    return openDatabase().then(
      (db) =>
        new Promise((resolve, reject) => {
          let tx;
          try {
            tx = db.transaction(storeName, "readwrite");
          } catch (e) {
            reject(e instanceof Error ? e : new Error(String(e)));
            return;
          }
          const store = tx.objectStore(storeName);

          tx.onerror = () => reject(tx.error || new Error(`清空 ${storeName} 的 transaction 失敗`));
          tx.onabort = () => reject(tx.error || new Error(`清空 ${storeName} 的 transaction 被中止`));
          tx.oncomplete = () => resolve();

          store.clear();
        })
    );
  }

  // 以單一 transaction 同時清空 records、settings、accounts 三個 store，不刪除資料庫結構。
  function clearAllData() {
    return openDatabase().then(
      (db) =>
        new Promise((resolve, reject) => {
          let tx;
          try {
            tx = db.transaction(ALL_STORES, "readwrite");
          } catch (e) {
            reject(e instanceof Error ? e : new Error(String(e)));
            return;
          }

          tx.onerror = () => reject(tx.error || new Error("清空所有資料的 transaction 失敗"));
          tx.onabort = () => reject(tx.error || new Error("清空所有資料的 transaction 被中止"));
          tx.oncomplete = () => resolve();

          ALL_STORES.forEach((storeName) => {
            tx.objectStore(storeName).clear();
          });
        })
    );
  }

  return {
    DB_NAME,
    DB_VERSION,
    STORE_RECORDS,
    STORE_SETTINGS,
    STORE_ACCOUNTS,
    STORE_SYNC_LOGS,
    openDatabase,
    loadRecords,
    replaceRecords,
    loadSettings,
    saveSettings,
    loadAccounts,
    replaceAccounts,
    loadSyncLogs,
    replaceSyncLogs,
    clearStore,
    clearAllData,
  };
})();
