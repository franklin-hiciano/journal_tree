// ── "Make it a habit": install-PWA popup ────────────────────────────────────────────
// Shows automatically after a commitment (called from run-engine.js's endCommit, chained
// through the compound card in onboarding.js so they never stack) — and any time via the
// floating button in the bottom-right corner.
// Desktop: a QR code to the install page below. Mobile: a real "Install app" button
// when the browser can prompt natively (beforeinstallprompt fired); otherwise — e.g.
// iOS Safari, which never fires that event — plain "Add to Home Screen" instructions,
// since there's no way to make those browsers show their own install prompt on demand.
//
// Set the real install page here once it's live:
const _INSTALL_URL = "https://reflectandcommit.com/install";
const _HABIT_DISMISSED_KEY = "rc_habit_dismissed_forever";

let _deferredInstallPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  _deferredInstallPrompt = e;
});
window.addEventListener("appinstalled", () => {
  _deferredInstallPrompt = null;
  try {
    localStorage.setItem("rc_pwa_installed", "1");
  } catch (e) {}
  updateHabitFabVisibility();
});

function isStandalonePWA() {
  return (
    (window.matchMedia &&
      window.matchMedia("(display-mode: standalone)").matches) ||
    window.navigator.standalone === true
  );
}

// no point offering to install the PWA when we're already running as one
function updateHabitFabVisibility() {
  const fab = document.getElementById("habitFabBtn");
  if (!fab) return;
  fab.style.display = isStandalonePWA() ? "none" : "";
}
document.addEventListener("DOMContentLoaded", updateHabitFabVisibility);
updateHabitFabVisibility();

// fired by the native "Install app" button
window._installPWA = async function () {
  if (!_deferredInstallPrompt) return;
  const evt = _deferredInstallPrompt;
  _deferredInstallPrompt = null;
  evt.prompt();
  try {
    await evt.userChoice;
  } catch (e) {}
  window._dismissHabitPopup();
};

// "not now" — closes for this time only, will still show again later
window._dismissHabitPopup = function () {
  const ov = document.getElementById("habitOv");
  if (ov) ov.classList.remove("on");
};

// "do not ask again" — closes and stops the automatic (post-commitment) popup for good.
// The floating button still opens it manually any time, since that's an explicit ask.
window._dismissHabitPopupForever = function () {
  try {
    localStorage.setItem(_HABIT_DISMISSED_KEY, "1");
  } catch (e) {}
  window._dismissHabitPopup();
};

// called automatically after a commitment
window._maybeShowHabitPopup = function () {
  try {
    if (localStorage.getItem(_HABIT_DISMISSED_KEY) === "1") return;
  } catch (e) {}
  window._showHabitPopup();
};

// the floating button calls this directly — it shows even if "do not ask again" was
// set, since an explicit tap always wins. Either way, skip it if the app's already
// installed, since there's nothing left to do.
window._showHabitPopup = function () {
  try {
    if (isStandalonePWA() || localStorage.getItem("rc_pwa_installed") === "1")
      return;
  } catch (e) {}
  const ov = document.getElementById("habitOv");
  if (!ov) return;
  // never stack on top of auth / paywall
  const auth = document.getElementById("authScreen");
  if (auth && !auth.classList.contains("hidden")) return;
  const pw = document.getElementById("paywall");
  if (pw && pw.classList.contains("on")) return;

  const native = document.getElementById("habitInstallNative");
  const manual = document.getElementById("habitInstallManual");
  const manualSteps = document.getElementById("habitManualSteps");
  const qrWrap = document.getElementById("habitQrWrap");
  const qrUrlEl = document.getElementById("habitQrUrl");
  if (native) native.style.display = "none";
  if (manual) manual.style.display = "none";
  if (qrWrap) qrWrap.style.display = "none";

  const mobile =
    typeof isMobile === "function" ? isMobile() : window.innerWidth <= 680;

  if (mobile && _deferredInstallPrompt) {
    // the browser is offering to prompt for us — use it directly, no QR needed
    if (native) native.style.display = "";
  } else if (mobile) {
    // on this phone the browser won't hand us a native prompt — a QR to scan on the
    // same device you're already holding makes no sense, so give manual steps instead
    if (manual) manual.style.display = "";
    if (manualSteps) {
      const ua = navigator.userAgent || "";
      manualSteps.textContent = /iphone|ipad|ipod/i.test(ua)
        ? 'Tap the Share icon, then "Add to Home Screen."'
        : 'Open your browser menu and tap "Add to Home screen" or "Install app."';
    }
  } else {
    // desktop — hand the install flow to the phone via QR
    if (qrWrap) qrWrap.style.display = "";
    if (qrUrlEl) qrUrlEl.textContent = _INSTALL_URL.replace(/^https?:\/\//, "");
    renderHabitQR();
  }

  ov.classList.add("on");
  if (!ov._bound) {
    ov._bound = true;
    ov.addEventListener("click", (e) => {
      if (e.target === ov) window._dismissHabitPopup();
    });
  }
};

function renderHabitQR() {
  const el = document.getElementById("habitQr");
  if (!el) return;
  const src =
    "https://api.qrserver.com/v1/create-qr-code/?size=336x336&margin=8&data=" +
    encodeURIComponent(_INSTALL_URL);
  el.innerHTML = '<img alt="scan to install" width="168" height="168" src="' + src + '">';
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") window._dismissHabitPopup();
});
