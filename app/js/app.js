// Reflect & Commit — voice-first, low-attention rewrite.
//
// Flow (opened from a notification): [day-after check-in if a commitment is due]
//   -> starred question (the nightly minimum) -> commit (hold) -> done.
// From "done" you can optionally keep reflecting through the rest of the list.
//
// No next button: speaking + a pause advances you; Enter advances when typing.
// No accent color; the hold-rings fill with light. Everything autosaves so a
// half-finished night resumes exactly where you left it, on any device.

const LS_DRAFT = "rc_draft_v3";
const LS_QLIST = "rc_questions_v3";
const LS_SETTINGS = "rc_settings_v3";
const LS_LASTNOTIF = "rc_last_notif_v3";

let questions = [];
let settings = { notifyTime: "20:00" };
let commitments = [];
// draft holds a resumable snapshot of the whole night
let draft = { active: false, phase: null, qIndex: 0, isFullRun: false, answers: {}, checkinId: null };

const SILENCE_MS = 1900;  // pause-to-advance
const HOLD_MS = 1000;     // hold-to-confirm duration

// ---------- local persistence ----------
function loadLocal() {
  try { questions = JSON.parse(localStorage.getItem(LS_QLIST) || "[]"); } catch (_) {}
  try { settings = JSON.parse(localStorage.getItem(LS_SETTINGS) || "null") || settings; } catch (_) {}
  try { draft = JSON.parse(localStorage.getItem(LS_DRAFT) || "null") || draft; } catch (_) {}
}
function saveLocalQuestions() { localStorage.setItem(LS_QLIST, JSON.stringify(questions)); }
function saveLocalSettings() { localStorage.setItem(LS_SETTINGS, JSON.stringify(settings)); }
function saveDraft() {
  localStorage.setItem(LS_DRAFT, JSON.stringify(draft));
  window._saveDraft && window._saveDraft(draft);
}
loadLocal();

// ---------- firestore hooks ----------
window._onQuestionsUpdated = () => {
  if (window._questions && window._questions.length) {
    questions = window._questions.map((q) => ({ recall: false, star: false, ...q }));
    saveLocalQuestions();
    // don't rebuild the list while a question row is focused — that's what
    // was closing the mobile keyboard after one character. The array is
    // already up to date; just skip the re-render until focus moves on.
    const active = document.activeElement;
    if (active && active.classList && active.classList.contains("q-text")) return;
    renderQuestionEditor();
  }
};
window._onSettingsUpdated = () => {
  if (window._settings && window._settings.notifyTime) {
    settings = window._settings; saveLocalSettings(); renderSettings();
  }
};
window._onCommitmentsUpdated = () => { commitments = window._commitments || []; };
window._onDraftUpdated = () => {
  const rd = window._remoteDraft;
  if (rd && rd.active && !draft.active) { draft = { ...draft, ...rd }; localStorage.setItem(LS_DRAFT, JSON.stringify(draft)); }
};
window._onSignedIn = () => {
  renderQuestionEditor(); renderSettings(); scheduleNotificationLoop();
  routeAfterAuth(); maybeOpenFromUrl();
  if ("Notification" in window && Notification.permission === "granted") window._registerPush && window._registerPush();
};

// ---------- routing ----------
function showScreen(id) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("on"));
  document.getElementById(id).classList.add("on");
}
function goHome() { stopVoice(); showScreen(isStandalone() ? "homeScreen" : "landingScreen"); }

function isStandalone() {
  return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
}
function routeAfterAuth() { showScreen(isStandalone() ? "homeScreen" : "landingScreen"); }
function maybeOpenFromUrl() {
  const p = new URLSearchParams(location.search);
  if (p.get("reflect") === "1") { history.replaceState({}, "", location.pathname); openReflection(); }
}

// ---------- install ----------
let deferredInstallPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); deferredInstallPrompt = e; });
window.onGetStarted = async () => {
  if (deferredInstallPrompt) { deferredInstallPrompt.prompt(); await deferredInstallPrompt.userChoice; deferredInstallPrompt = null; return; }
  const url = location.href.split("?")[0];
  document.getElementById("landingQrImg").src = "https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=" + encodeURIComponent(url);
  document.getElementById("landingQrWrap").style.display = "block";
  document.getElementById("getStartedBtn").style.display = "none";
};

// ---------- notification window ----------
const REFLECT_WINDOW_MS = 2 * 60 * 60 * 1000;
function getLastNotif() { try { return JSON.parse(localStorage.getItem(LS_LASTNOTIF) || "null"); } catch (_) { return null; } }
function setLastNotif(src) { localStorage.setItem(LS_LASTNOTIF, JSON.stringify({ sentAt: Date.now(), source: src })); }
function withinReflectWindow() { const n = getLastNotif(); return n ? Date.now() - n.sentAt < REFLECT_WINDOW_MS : false; }
function nextScheduledLabel() {
  const [h, m] = (settings.notifyTime || "20:00").split(":").map(Number);
  const now = new Date(), next = new Date(now); next.setHours(h, m, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" }).toLowerCase();
}

// ---------- notifications ----------
function fireNotification(src) {
  setLastNotif(src);
  const title = "Time to reflect", body = "Your questions are ready.";
  if (Notification.permission !== "granted") return;
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.ready.then((reg) => reg.showNotification(title, { body, tag: "reflect" })).catch(() => fallbackNotify(title, body));
  } else fallbackNotify(title, body);
}
function fallbackNotify(title, body) { const n = new Notification(title, { body }); n.onclick = () => { window.focus(); openReflection(); n.close(); }; }
async function requestNotifPermission() {
  if (!("Notification" in window)) return false;
  if (Notification.permission === "granted") return true;
  return (await Notification.requestPermission()) === "granted";
}
window.sendSelfNotification = async () => {
  const ok = await requestNotifPermission();
  if (!ok) { alert("Notifications are blocked — enable them in your browser/OS settings."); return; }
  window._registerPush && window._registerPush();
  fireNotification("manual");
  alert("Sent. Valid for 2 hours.");
};
let lastFiredDateKey = localStorage.getItem("rc_last_fired_date") || "";
function scheduleNotificationLoop() {
  setInterval(() => {
    const now = new Date(); const [h, m] = (settings.notifyTime || "20:00").split(":").map(Number);
    const key = now.toDateString();
    if (key !== lastFiredDateKey && now.getHours() === h && now.getMinutes() >= m && now.getMinutes() < m + 2) {
      lastFiredDateKey = key; localStorage.setItem("rc_last_fired_date", key); fireNotification("schedule");
    }
  }, 30000);
}
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
  navigator.serviceWorker.addEventListener("message", (e) => {
    if (e.data && e.data.type === "notif-confirmed") { setLastNotif("schedule"); openReflection(); }
  });
}

// ---------- HOME / editor ----------
function renderSettings() {
  const el = document.getElementById("notifyTimeInput");
  if (el) el.value = settings.notifyTime || "20:00";
  renderNotifyLabel();
}
// plain-language restatement of the absolute time — not a countdown. The point
// is a fixed sentence that sticks in memory, so any glance at a real clock
// later is an instant match, rather than a number that's different every time.
function renderNotifyLabel() {
  const el = document.getElementById("notifyCountdown");
  if (!el) return;
  const [h, m] = (settings.notifyTime || "20:00").split(":").map(Number);
  const d = new Date(); d.setHours(h, m, 0, 0);
  const label = d.toLocaleTimeString(undefined, { hour: "numeric", minute: m ? "2-digit" : undefined });
  el.textContent = "reflects at " + label;
}
window.onNotifyTimeChange = (v) => {
  settings.notifyTime = v; saveLocalSettings(); renderNotifyLabel();
  window._saveSettings && window._saveSettings({ notifyTime: v });
};
// the visible "reflects at 8:00 PM" button is the only place the time is
// ever stated — tapping it opens the (invisible) native time input beneath it.
window.openTimePicker = () => {
  const el = document.getElementById("notifyTimeInput");
  if (!el) return;
  if (el.showPicker) { try { el.showPicker(); return; } catch (_) {} }
  el.focus();
};

function renderQuestionEditor() {
  const list = document.getElementById("qList"); if (!list) return;
  list.innerHTML = "";
  questions.forEach((q, i) => {
    const row = document.createElement("div");
    row.className = "q-row";
    row.innerHTML =
      `<button class="q-star ${q.star ? "on" : ""}" data-i="${i}" title="minimum for the night">${q.star ? "★" : "☆"}</button>` +
      `<input class="q-text" value="${escapeAttr(q.text)}" data-i="${i}" placeholder="write a question…" />` +
      `<div class="q-icons">` +
        `<button class="q-icon-btn q-recall-icon ${q.recall ? "on" : ""}" data-i="${i}" title="show past answers during reflection">↺</button>` +
        `<button class="q-icon-btn q-del-icon" data-i="${i}" title="remove">✕</button>` +
      `</div>`;
    list.appendChild(row);
  });
  list.querySelectorAll(".q-text").forEach((inp) => inp.addEventListener("input", (e) => { questions[+e.target.dataset.i].text = e.target.value; persistQuestions(); }));
  list.querySelectorAll(".q-star").forEach((b) => b.addEventListener("click", (e) => {
    const i = +e.currentTarget.dataset.i;
    const wasOn = questions[i].star;
    questions.forEach((q) => (q.star = false));
    questions[i].star = !wasOn; // allow toggling the only star off, though one is recommended
    persistQuestions(); renderQuestionEditor();
  }));
  list.querySelectorAll(".q-recall-icon").forEach((b) => b.addEventListener("click", (e) => { const i = +e.currentTarget.dataset.i; questions[i].recall = !questions[i].recall; persistQuestions(); renderQuestionEditor(); }));
  list.querySelectorAll(".q-del-icon").forEach((b) => b.addEventListener("click", (e) => { questions.splice(+e.currentTarget.dataset.i, 1); persistQuestions(); renderQuestionEditor(); }));
}
function escapeAttr(s) { return (s || "").replace(/"/g, "&quot;"); }
function escapeHtml(s) { return (s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function persistQuestions() { saveLocalQuestions(); window._saveQuestions && window._saveQuestions(questions); }
window.addQuestion = () => {
  questions.push({ id: "q_" + Date.now(), text: "", recall: false, star: !questions.some((q) => q.star) });
  persistQuestions(); renderQuestionEditor();
  const inputs = document.querySelectorAll(".q-text"); inputs[inputs.length - 1] && inputs[inputs.length - 1].focus();
};

// ---------- reflection state machine ----------
function starredQuestion() { return questions.find((q) => q.star) || questions[0]; }
function otherQuestions() { const s = starredQuestion(); return questions.filter((q) => q !== s); }

function dueCommitment() {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return (commitments || []).find((c) => c.status === "active" && c.dueDate && new Date(c.dueDate) <= today);
}

function openReflection() {
  if (!withinReflectWindow()) {
    document.getElementById("nextAvailLabel").textContent = nextScheduledLabel();
    showScreen("unavailableScreen"); return;
  }
  showScreen("reflectScreen");
  if (draft.active && draft.phase) { resumePhase(); return; }
  draft = { active: true, phase: null, qIndex: 0, isFullRun: false, answers: {}, checkinId: null };
  const due = dueCommitment();
  if (due) { draft.phase = "checkin"; draft.checkinId = due.id; saveDraft(); enterCheckin(due); }
  else startQuestions(false);
}
function resumePhase() {
  if (draft.phase === "checkin") { const due = dueCommitment(); if (due) return enterCheckin(due); return startQuestions(false); }
  if (draft.phase === "question") return renderQuestion();
  if (draft.phase === "commit") return enterCommit();
  if (draft.phase === "done") return enterDone();
  startQuestions(false);
}

function setPhase(id) {
  document.querySelectorAll(".phase").forEach((p) => p.classList.remove("on"));
  document.getElementById(id).classList.add("on");
}

// subtle back button — deliberately hidden on the first phase of a session
// (checkin, or the very first question) so there's nowhere "accidental" to
// step back into. It only appears once there's somewhere real to undo to.
function setBackVisible(v) {
  const b = document.getElementById("reflectBack");
  if (b) b.style.display = v ? "flex" : "none";
}
window.goBackPhase = () => {
  if (draft.phase === "commit") {
    const queue = activeQueue();
    draft.phase = "question"; draft.qIndex = Math.max(0, queue.length - 1); saveDraft();
    renderQuestion();
  } else if (draft.phase === "question" && draft.qIndex > 0) {
    draft.qIndex -= 1; saveDraft(); renderQuestion();
  } else if (draft.phase === "done") {
    enterCommit();
  }
};

// -- check-in --
function enterCheckin(cmt) {
  stopVoice(); setPhase("phaseCheckin"); setBackVisible(false);
  document.getElementById("checkinText").textContent = cmt.text;
  wireHold("checkinHold", "checkinRingFill", () => resolveCheckin("done"));
}
window.resolveCheckin = (status) => {
  const id = draft.checkinId;
  if (id) { window._resolveCommitment && window._resolveCommitment(id, status); }
  draft.checkinId = null;
  startQuestions(false);
};

// -- questions --
function startQuestions(isFull) {
  draft.phase = "question"; draft.isFullRun = isFull; draft.qIndex = 0; saveDraft();
  renderQuestion();
}
function activeQueue() { return draft.isFullRun ? otherQuestions() : [starredQuestion()].filter(Boolean); }

function renderQuestion() {
  setPhase("phaseQuestion");
  const queue = activeQueue();
  const q = queue[draft.qIndex];
  if (!q) return afterQuestions();
  setBackVisible(draft.qIndex > 0);

  document.getElementById("qPhaseIndex").textContent = draft.isFullRun ? `${draft.qIndex + 1} / ${queue.length}` : "tonight";
  const qt = document.getElementById("qText"); qt.textContent = q.text;
  const field = document.getElementById("answerField");
  field.value = draft.answers[q.id] || "";
  autoGrow(field);

  field.oninput = () => { draft.answers[q.id] = field.value; autoGrow(field); saveDraft(); };
  field.onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); commitAnswerAndAdvance(); } };

  // recall
  const q2 = q;
  const chev = document.getElementById("recallChevron"), rlist = document.getElementById("recallList");
  chev.classList.remove("open"); rlist.classList.remove("open"); rlist.innerHTML = "";
  if (q2.recall) {
    chev.style.display = "inline-flex";
    chev.onclick = () => {
      const open = chev.classList.toggle("open"); rlist.classList.toggle("open", open);
      if (open) fillRecall(q2, rlist);
    };
  } else chev.style.display = "none";

  startVoice(field);
  setTimeout(() => field.focus(), 60);
}

function commitAnswerAndAdvance() {
  const queue = activeQueue(); const q = queue[draft.qIndex]; if (!q) return;
  const ans = (draft.answers[q.id] || "").trim();
  if (ans) {
    const k = "rc_answer_hist_" + q.id; let h = [];
    try { h = JSON.parse(localStorage.getItem(k) || "[]"); } catch (_) {}
    h.unshift({ a: ans, t: Date.now() }); localStorage.setItem(k, JSON.stringify(h.slice(0, 30)));
  }
  driftTo(() => {
    if (draft.qIndex >= queue.length - 1) afterQuestions();
    else { draft.qIndex += 1; saveDraft(); renderQuestion(); }
  });
}
function afterQuestions() {
  stopVoice();
  if (draft.isFullRun) { finishSession(); return; } // full run just ends
  enterCommit();
}

function driftTo(fn) {
  stopVoice();
  const phase = document.getElementById("phaseQuestion");
  phase.classList.add("leaving");
  setTimeout(() => { phase.classList.remove("leaving"); fn(); }, 380);
}

function fillRecall(q, el) {
  let h = []; try { h = JSON.parse(localStorage.getItem("rc_answer_hist_" + q.id) || "[]"); } catch (_) {}
  if (!h.length) { el.innerHTML = "<div class='recall-empty'>nothing here yet</div>"; return; }
  el.innerHTML = h.slice(0, 10).map((x) =>
    `<div class="recall-item"><span class="recall-date">${new Date(x.t).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>${escapeHtml(x.a)}</div>`
  ).join("");
}

// -- commit --
function enterCommit() {
  stopVoice(); draft.phase = "commit"; saveDraft(); setPhase("phaseCommit"); setBackVisible(true);
  const field = document.getElementById("commitField");
  field.value = draft.commitText || ""; autoGrow(field);
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
  draft.commitDue = tomorrow.toISOString().slice(0, 10);
  document.getElementById("commitDue").textContent = "by " + tomorrow.toLocaleDateString(undefined, { weekday: "long" }).toLowerCase();
  field.oninput = () => { draft.commitText = field.value; autoGrow(field); saveDraft(); };
  field.onkeydown = (e) => { if (e.key === "Enter") e.preventDefault(); };
  wireHold("commitHold", "commitRingFill", doCommit);
  startVoice(field);
  setTimeout(() => field.focus(), 60);
}
function doCommit() {
  const text = (draft.commitText || "").trim();
  if (text) window._addCommitment && window._addCommitment({ text, dueDate: draft.commitDue });
  if (navigator.vibrate) navigator.vibrate(12);
  enterDone(!!text);
}
window.skipCommit = () => enterDone(false);

// -- done --
function enterDone(committed) {
  stopVoice(); draft.phase = "done"; saveDraft(); setPhase("phaseDone"); setBackVisible(true);
  document.getElementById("doneText").textContent = committed ? "committed. see you tomorrow." : "logged. see you tomorrow.";
  const kg = document.getElementById("keepGoingBtn");
  kg.style.display = otherQuestions().length ? "block" : "none";
}
window.keepReflecting = () => { draft.commitText = ""; startQuestions(true); };

function finishSession() {
  window._saveSession && window._saveSession({ answers: draft.answers });
  draft = { active: false, phase: null, qIndex: 0, isFullRun: false, answers: {}, checkinId: null };
  saveDraft(); window._clearDraft && window._clearDraft();
  goHome();
}
window.exitReflection = () => { stopVoice(); goHome(); }; // keeps draft -> resumes next open

function autoGrow(el) { el.style.height = "auto"; el.style.height = el.scrollHeight + "px"; }

// ---------- hold-to-confirm ----------
function wireHold(btnId, fillId, onComplete) {
  const btn = document.getElementById(btnId), fill = document.getElementById(fillId);
  const CIRC = 207.3; let raf = null, start = 0, done = false;
  fill.style.strokeDashoffset = CIRC;
  const tick = (ts) => {
    if (!start) start = ts;
    const p = Math.min((ts - start) / HOLD_MS, 1);
    fill.style.strokeDashoffset = CIRC * (1 - p);
    if (p >= 1) { done = true; btn.classList.add("done"); release(true); return; }
    raf = requestAnimationFrame(tick);
  };
  const press = (e) => { e.preventDefault(); if (done) return; start = 0; raf = requestAnimationFrame(tick); };
  const release = (complete) => {
    if (raf) cancelAnimationFrame(raf); raf = null;
    if (complete) { onComplete(); }
    else { fill.style.transition = "stroke-dashoffset .25s ease"; fill.style.strokeDashoffset = CIRC; setTimeout(() => (fill.style.transition = ""), 260); }
  };
  btn.onpointerdown = press;
  btn.onpointerup = () => { if (!done) release(false); };
  btn.onpointerleave = () => { if (!done) release(false); };
}

// ---------- voice (Web Speech; graceful fallback to typing) ----------
let recog = null, silenceTimer = null, voiceField = null, voiceBase = "";
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

function startVoice(field) {
  const dot = document.getElementById("listeningDot");
  if (!SR) { if (dot) dot.classList.remove("on"); return; } // iOS etc: keyboard dictation covers voice
  stopVoice();
  voiceField = field; voiceBase = field.value ? field.value + " " : "";
  try {
    recog = new SR(); recog.continuous = true; recog.interimResults = true; recog.lang = navigator.language || "en-US";
    recog.onresult = (e) => {
      let interim = "", final = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) final += t; else interim += t;
      }
      if (final) voiceBase = (voiceBase + final).replace(/\s+/g, " ").replace(/^\s/, "") + " ";
      voiceField.value = (voiceBase + interim).trimStart();
      autoGrow(voiceField);
      if (draft.phase === "commit") { draft.commitText = voiceField.value; } else { const q = activeQueue()[draft.qIndex]; if (q) draft.answers[q.id] = voiceField.value; }
      saveDraft();
      resetSilence();
    };
    recog.onerror = () => {};
    recog.onend = () => { if (recog && listeningWanted) { try { recog.start(); } catch (_) {} } };
    listeningWanted = true;
    recog.start();
    if (dot) dot.classList.add("on");
  } catch (_) { if (dot) dot.classList.remove("on"); }
}
let listeningWanted = false;
function resetSilence() {
  clearTimeout(silenceTimer);
  silenceTimer = setTimeout(() => {
    const v = (voiceField && voiceField.value || "").trim();
    if (!v) return; // don't advance on empty
    if (draft.phase === "question") commitAnswerAndAdvance();
    // on commit we don't auto-advance; the hold is the deliberate act
  }, SILENCE_MS);
}
function stopVoice() {
  listeningWanted = false;
  clearTimeout(silenceTimer);
  const dot = document.getElementById("listeningDot"); if (dot) dot.classList.remove("on");
  if (recog) { try { recog.onend = null; recog.stop(); } catch (_) {} recog = null; }
}

// ---------- boot ----------
document.addEventListener("DOMContentLoaded", () => { renderQuestionEditor(); renderSettings(); });
