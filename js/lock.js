/*
 * lock.js
 * 啟動驗證（畫面鎖定）：App 開啟時，以及切到背景超過 5 分鐘後回到前景時，要求輸入 PIN 或生物辨識才能使用。
 * 刻意不依賴 Vue：冷啟動時在 app.mount() 之前就要顯示，避免任何金額先出現在 DOM。
 *
 * 安全性說明：這只是「畫面鎖定」，IndexedDB 內的資料並未加密；無後端可驗簽，
 * 能阻擋拿到裝置的人隨手打開，無法阻擋可使用開發者工具或直接讀取瀏覽器檔案的人。
 *
 * 生物辨識：網頁無法直接呼叫 Face ID，改用 WebAuthn 平台驗證器（passkey）觸發裝置的使用者驗證，
 * 實際可能是 Face ID / Touch ID / 指紋 / Windows Hello；不支援或失敗時一律可改用 PIN。
 * 憑證綁定目前網域（rp.id），更換部署網域後需重新設定。
 */

const AppLock = (() => {
  const PIN_RE = /^\d{4,6}$/;
  const PBKDF2_ITERATIONS = 100000;
  const RELOCK_AFTER_MS = 5 * 60 * 1000;
  const MAX_FAILS = 5;
  const COOLDOWN_MS = 30 * 1000;
  // 連續錯誤次數存於 localStorage，避免以重新整理頁面繞過冷卻時間
  const FAIL_KEY = "walletegg_lock_fails";

  let overlay = null;
  let hiddenAt = 0;

  // ---------- 編碼工具 ----------
  function bytesToB64(bytes) {
    let s = "";
    new Uint8Array(bytes).forEach((b) => {
      s += String.fromCharCode(b);
    });
    return btoa(s);
  }
  function b64ToBytes(b64) {
    const s = atob(b64);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }
  function bytesToB64Url(bytes) {
    return bytesToB64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function b64UrlToBytes(s) {
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
    return b64ToBytes(b64 + "===".slice((b64.length + 3) % 4));
  }
  function randomBytes(n) {
    return crypto.getRandomValues(new Uint8Array(n));
  }

  // ---------- PIN ----------
  function isValidPin(pin) {
    return PIN_RE.test(String(pin == null ? "" : pin));
  }

  function hasSecureCrypto() {
    return typeof crypto !== "undefined" && !!crypto.subtle;
  }

  async function hashPin(pin, saltB64) {
    if (!hasSecureCrypto()) {
      throw new Error("此瀏覽器環境不支援 WebCrypto（需 HTTPS 或 localhost），無法使用啟動驗證。");
    }
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(String(pin)), "PBKDF2", false, [
      "deriveBits",
    ]);
    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", salt: b64ToBytes(saltB64), iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
      key,
      256
    );
    return bytesToB64(bits);
  }

  // 產生新的 PIN 雜湊與 salt，回傳 { appLockPinHash, appLockPinSalt }
  async function createPinFields(pin) {
    if (!isValidPin(pin)) throw new Error("PIN 碼必須是 4–6 位數字。");
    const salt = bytesToB64(randomBytes(16));
    const hash = await hashPin(pin, salt);
    return { appLockPinHash: hash, appLockPinSalt: salt };
  }

  async function verifyPin(settings, pin) {
    if (!isValidPin(pin) || !settings.appLockPinHash || !settings.appLockPinSalt) return false;
    const hash = await hashPin(pin, settings.appLockPinSalt);
    return hash === settings.appLockPinHash;
  }

  // ---------- 生物辨識（WebAuthn 平台驗證器） ----------
  async function isBiometricAvailable() {
    try {
      if (!window.isSecureContext || typeof PublicKeyCredential === "undefined") return false;
      if (typeof PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable !== "function") return false;
      return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
    } catch (e) {
      return false;
    }
  }

  // 註冊此裝置的平台驗證器，回傳 credential rawId（base64url）。
  // 需由使用者點按直接觸發（呼叫前不可先 await 其他非同步動作，否則 iOS 可能判定沒有使用者手勢）。
  async function registerBiometric() {
    const cred = await navigator.credentials.create({
      publicKey: {
        challenge: randomBytes(32),
        rp: { name: "WalletEgg" },
        user: { id: randomBytes(16), name: "walletegg-local", displayName: "WalletEgg" },
        pubKeyCredParams: [
          { type: "public-key", alg: -7 },
          { type: "public-key", alg: -257 },
        ],
        authenticatorSelection: {
          authenticatorAttachment: "platform",
          userVerification: "required",
          residentKey: "discouraged",
        },
        attestation: "none",
        timeout: 60000,
      },
    });
    if (!cred || !cred.rawId) throw new Error("生物辨識註冊未完成。");
    return bytesToB64Url(cred.rawId);
  }

  // 以已註冊的憑證要求使用者驗證；成功回傳 true，使用者取消或失敗時 throw。
  async function verifyBiometric(credentialId) {
    const assertion = await navigator.credentials.get({
      publicKey: {
        challenge: randomBytes(32),
        allowCredentials: [{ type: "public-key", id: b64UrlToBytes(credentialId), transports: ["internal"] }],
        userVerification: "required",
        timeout: 60000,
      },
    });
    if (!assertion || bytesToB64Url(assertion.rawId) !== credentialId) {
      throw new Error("生物辨識驗證失敗。");
    }
    // authenticatorData 第 33 個 byte 為 flags：0x01 = 使用者在場（UP），0x04 = 已完成使用者驗證（UV）
    const authData = new Uint8Array(assertion.response.authenticatorData);
    if (authData.length < 33 || (authData[32] & 0x05) !== 0x05) {
      throw new Error("裝置未完成使用者驗證。");
    }
    return true;
  }

  // ---------- 連續錯誤冷卻 ----------
  function readFails() {
    try {
      const v = JSON.parse(localStorage.getItem(FAIL_KEY) || "{}");
      return { count: Number(v.count) || 0, until: Number(v.until) || 0 };
    } catch (e) {
      return { count: 0, until: 0 };
    }
  }
  function writeFails(v) {
    try {
      localStorage.setItem(FAIL_KEY, JSON.stringify(v));
    } catch (e) {}
  }
  function clearFails() {
    try {
      localStorage.removeItem(FAIL_KEY);
    } catch (e) {}
  }
  function recordFail() {
    const f = readFails();
    f.count += 1;
    if (f.count >= MAX_FAILS) {
      f.count = 0;
      f.until = Date.now() + COOLDOWN_MS;
    }
    writeFails(f);
    return f;
  }

  // ---------- 鎖定畫面 ----------
  function isEnabled(settings) {
    return !!(settings && settings.appLockEnabled && settings.appLockPinHash && settings.appLockPinSalt);
  }

  function isLocked() {
    return !!overlay;
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // 顯示鎖定畫面，解鎖後 resolve。options.onReset：使用者確認「清除所有資料並重設」時呼叫（應清除資料並重新載入）。
  function show(settings, options) {
    const opts = options || {};
    if (overlay) return overlay.__promise;

    let resolveFn;
    const promise = new Promise((r) => {
      resolveFn = r;
    });

    overlay = el("div", "app-lock");
    overlay.__promise = promise;
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "WalletEgg 已鎖定");

    const box = el("div", "app-lock-box");
    box.appendChild(el("div", "app-lock-icon", "🔒"));
    box.appendChild(el("div", "app-lock-title", "WalletEgg 已鎖定"));
    const msg = el("div", "app-lock-msg", "");
    box.appendChild(msg);

    const useBio = settings.appLockMethod === "biometric" && !!settings.appLockCredentialId;
    let bioBtn = null;
    if (useBio) {
      bioBtn = el("button", "app-lock-btn app-lock-btn-primary", "使用生物辨識解鎖（Face ID 等）");
      bioBtn.type = "button";
      box.appendChild(bioBtn);
      box.appendChild(el("div", "app-lock-or", "或輸入 PIN 碼"));
    }

    const form = el("form", "app-lock-form");
    // 停用瀏覽器內建驗證，改由下方訊息統一提示
    form.noValidate = true;
    const input = el("input", "app-lock-input");
    input.type = "password";
    input.inputMode = "numeric";
    input.autocomplete = "off";
    input.maxLength = 6;
    input.pattern = "[0-9]*";
    input.placeholder = "PIN 碼（4–6 位數字）";
    input.setAttribute("aria-label", "PIN 碼");
    const submit = el("button", "app-lock-btn" + (useBio ? "" : " app-lock-btn-primary"), "解鎖");
    submit.type = "submit";
    form.appendChild(input);
    form.appendChild(submit);
    box.appendChild(form);

    const reset = el("button", "app-lock-link", "忘記 PIN 碼？清除所有資料並重設");
    reset.type = "button";
    box.appendChild(reset);

    overlay.appendChild(box);
    document.body.appendChild(overlay);
    document.documentElement.classList.add("app-locked");

    let cooldownTimer = null;
    function setMsg(text, isError) {
      msg.textContent = text || "";
      msg.classList.toggle("app-lock-msg-error", !!isError);
    }
    function applyCooldown() {
      clearInterval(cooldownTimer);
      const tick = () => {
        const left = readFails().until - Date.now();
        const cooling = left > 0;
        input.disabled = cooling;
        submit.disabled = cooling;
        if (cooling) {
          setMsg(`錯誤次數過多，請於 ${Math.ceil(left / 1000)} 秒後再試。`, true);
        } else {
          clearInterval(cooldownTimer);
          if (msg.textContent.indexOf("錯誤次數過多") === 0) setMsg("");
        }
      };
      tick();
      cooldownTimer = setInterval(tick, 1000);
    }

    function unlock() {
      clearInterval(cooldownTimer);
      clearFails();
      document.documentElement.classList.remove("app-locked");
      if (overlay) overlay.remove();
      overlay = null;
      resolveFn();
    }

    let bioBusy = false;
    async function tryBiometric(silent) {
      if (!bioBtn || bioBusy) return;
      bioBusy = true;
      bioBtn.disabled = true;
      try {
        await verifyBiometric(settings.appLockCredentialId);
        unlock();
      } catch (e) {
        // 使用者取消、未點按（舊版 iOS 需手勢）或裝置不支援：改用 PIN，不視為錯誤次數
        if (!silent) setMsg("生物辨識未完成，請再試一次或改用 PIN 碼。", true);
      } finally {
        bioBusy = false;
        if (bioBtn) bioBtn.disabled = false;
      }
    }
    if (bioBtn) bioBtn.addEventListener("click", () => tryBiometric(false));

    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      if (readFails().until > Date.now()) {
        applyCooldown();
        return;
      }
      const pin = input.value;
      submit.disabled = true;
      let ok = false;
      try {
        ok = await verifyPin(settings, pin);
      } catch (e) {
        setMsg(e && e.message ? e.message : String(e), true);
        submit.disabled = false;
        return;
      }
      if (ok) {
        unlock();
        return;
      }
      input.value = "";
      submit.disabled = false;
      const f = recordFail();
      if (f.until > Date.now()) applyCooldown();
      else setMsg(`PIN 碼錯誤（再錯 ${MAX_FAILS - f.count} 次需等待 ${COOLDOWN_MS / 1000} 秒）。`, true);
      input.focus();
    });

    reset.addEventListener("click", () => {
      if (!confirm("忘記 PIN 碼只能清除本機所有資料（明細、存放帳戶、所有設定）後重新開始，此動作無法復原。確定要繼續嗎？")) return;
      if (!confirm("再次確認：清除後無法還原，除非你另有「完整備份」檔。確定清除所有資料並重設？")) return;
      clearInterval(cooldownTimer);
      clearFails();
      if (typeof opts.onReset === "function") opts.onReset();
    });

    applyCooldown();
    if (useBio) {
      // iOS 17.4+ 可不經點按直接觸發；較舊版本會失敗，此時保留按鈕讓使用者點按
      tryBiometric(true);
    } else if (!input.disabled) {
      setTimeout(() => input.focus(), 50);
    }
    return promise;
  }

  // 切到背景超過 RELOCK_AFTER_MS 後回到前景時重新鎖定。getSettings 回傳最新的 settings。
  function startAutoRelock(getSettings, options) {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        hiddenAt = Date.now();
        return;
      }
      const settings = getSettings();
      if (hiddenAt && Date.now() - hiddenAt >= RELOCK_AFTER_MS && isEnabled(settings) && !overlay) {
        show(settings, options);
      }
      hiddenAt = 0;
    });
  }

  return {
    RELOCK_AFTER_MS,
    isValidPin,
    createPinFields,
    verifyPin,
    isBiometricAvailable,
    registerBiometric,
    verifyBiometric,
    isEnabled,
    isLocked,
    show,
    startAutoRelock,
  };
})();
