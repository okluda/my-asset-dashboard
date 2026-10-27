/*
 * WalletEgg PWA 支援：註冊 Service Worker、新版本提示、安裝提示、持久儲存申請。
 * 刻意不依賴 Vue：即使 App 掛載失敗，使用者仍能收到新版提示並更新（可能就是修正版）。
 * 對外提供 window.__pwa（state + 動作），狀態變更時發出 window 事件 "pwa:change"。
 */
(function () {
  "use strict";

  var ua = navigator.userAgent || "";
  var isIOS =
    /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

  function detectStandalone() {
    return (
      (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) ||
      navigator.standalone === true
    );
  }

  var state = {
    supported: "serviceWorker" in navigator,
    isIOS: isIOS,
    isStandalone: detectStandalone(),
    canInstall: false, // 是否已取得 beforeinstallprompt（Android / 桌機 Chrome、Edge）
    installed: false,
    updateAvailable: false,
    version: "",
    persisted: null, // null：未知或不支援
    swError: "",
  };

  var registration = null;
  var deferredPrompt = null;
  var updateRequested = false;
  var refreshing = false;
  var lastUpdateCheck = 0;

  function emit() {
    try {
      window.dispatchEvent(new CustomEvent("pwa:change", { detail: Object.assign({}, state) }));
    } catch (e) {
      /* 舊瀏覽器不支援 CustomEvent 建構子時忽略 */
    }
  }

  function setState(patch) {
    Object.assign(state, patch);
    emit();
  }

  // ---------- 新版本提示條 ----------
  var bar = null;
  function showUpdateBar() {
    if (bar || !document.body) return;
    bar = document.createElement("div");
    bar.id = "pwa-update-bar";
    bar.setAttribute("role", "status");

    var text = document.createElement("button");
    text.type = "button";
    text.className = "pwa-update-main";
    text.textContent = "有新版本，點此更新";
    text.addEventListener("click", applyUpdate);

    var close = document.createElement("button");
    close.type = "button";
    close.className = "pwa-update-close";
    close.setAttribute("aria-label", "稍後再說");
    close.textContent = "×";
    close.addEventListener("click", function () {
      if (bar) bar.remove();
      bar = null;
    });

    bar.appendChild(text);
    bar.appendChild(close);
    document.body.appendChild(bar);
  }

  function markUpdateAvailable() {
    if (!state.updateAvailable) setState({ updateAvailable: true });
    showUpdateBar();
  }

  function trackInstalling(worker) {
    if (!worker) return;
    worker.addEventListener("statechange", function () {
      // 已有 controller 代表是「更新」而非首次安裝
      if (worker.state === "installed" && navigator.serviceWorker.controller) markUpdateAvailable();
    });
  }

  function fetchVersion(worker) {
    if (!worker || typeof MessageChannel === "undefined") return;
    var channel = new MessageChannel();
    channel.port1.onmessage = function (e) {
      if (e.data && e.data.version) setState({ version: e.data.version });
    };
    worker.postMessage({ type: "GET_VERSION" }, [channel.port2]);
  }

  function applyUpdate() {
    updateRequested = true;
    if (registration && registration.waiting) {
      registration.waiting.postMessage({ type: "SKIP_WAITING" });
    } else {
      window.location.reload();
    }
  }

  // 回傳 Promise<string>：檢查結果說明文字
  function checkForUpdate() {
    if (!registration) {
      return Promise.resolve(state.supported ? "Service Worker 尚未就緒" : "此瀏覽器不支援離線功能");
    }
    lastUpdateCheck = Date.now();
    return registration
      .update()
      .then(function () {
        if (registration.waiting && navigator.serviceWorker.controller) {
          markUpdateAvailable();
          return "有新版本可更新";
        }
        if (registration.installing) {
          trackInstalling(registration.installing);
          return "發現新版本，下載中…";
        }
        return "已是最新版本";
      })
      .catch(function (e) {
        return "檢查更新失敗：" + (e && e.message ? e.message : e);
      });
  }

  function register() {
    navigator.serviceWorker
      .register("./sw.js", { scope: "./" })
      .then(function (reg) {
        registration = reg;
        if (reg.waiting && navigator.serviceWorker.controller) markUpdateAvailable();
        if (reg.installing) trackInstalling(reg.installing);
        reg.addEventListener("updatefound", function () {
          trackInstalling(reg.installing);
        });
        return navigator.serviceWorker.ready;
      })
      .then(function (reg) {
        fetchVersion(reg.active);
      })
      .catch(function (e) {
        // 離線功能失效不影響主要功能，不觸發錯誤橫幅，只記錄並顯示於設定頁
        console.warn("Service Worker 註冊失敗", e);
        setState({ swError: e && e.message ? e.message : String(e) });
      });
  }

  if (state.supported) {
    var hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener("controllerchange", function () {
      // 首次安裝時 clients.claim() 也會觸發此事件，此時不需重新載入
      if (refreshing || (!updateRequested && !hadController)) return;
      refreshing = true;
      window.location.reload();
    });

    if (document.readyState === "complete") register();
    else window.addEventListener("load", register);

    // iOS 主畫面 App 回到前景時通常不會重新載入頁面，需主動檢查更新（節流 60 秒）
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible" && registration && Date.now() - lastUpdateCheck > 60000) {
        checkForUpdate();
      }
    });
  }

  // ---------- 安裝 ----------
  window.addEventListener("beforeinstallprompt", function (e) {
    e.preventDefault();
    deferredPrompt = e;
    setState({ canInstall: true });
  });

  window.addEventListener("appinstalled", function () {
    deferredPrompt = null;
    setState({ canInstall: false, installed: true });
  });

  if (window.matchMedia) {
    var mq = window.matchMedia("(display-mode: standalone)");
    var onModeChange = function () {
      setState({ isStandalone: detectStandalone() });
    };
    if (mq.addEventListener) mq.addEventListener("change", onModeChange);
    else if (mq.addListener) mq.addListener(onModeChange);
  }

  // 回傳 Promise<string>：安裝結果（accepted / dismissed / unavailable）
  function promptInstall() {
    if (!deferredPrompt) return Promise.resolve("unavailable");
    var p = deferredPrompt;
    deferredPrompt = null;
    p.prompt();
    return p.userChoice
      .then(function (choice) {
        setState({ canInstall: false, installed: choice.outcome === "accepted" || state.installed });
        return choice.outcome;
      })
      .catch(function () {
        setState({ canInstall: false });
        return "dismissed";
      });
  }

  // ---------- 持久儲存：降低瀏覽器在空間不足時清除 IndexedDB 的機率 ----------
  if (navigator.storage && navigator.storage.persisted && navigator.storage.persist) {
    navigator.storage
      .persisted()
      .then(function (p) {
        return p ? p : navigator.storage.persist();
      })
      .then(function (p) {
        setState({ persisted: !!p });
      })
      .catch(function () {
        /* 不支援或被拒，維持 null */
      });
  }

  window.__pwa = {
    state: state,
    promptInstall: promptInstall,
    checkForUpdate: checkForUpdate,
    applyUpdate: applyUpdate,
  };
})();
