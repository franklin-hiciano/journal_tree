// Reflect & Commit — voice-first, low-attention, with bounded branching.
//
// The question list is a tree walked top-to-bottom. Most nodes are free-text
// (voice or type; a pause advances). A node can be a 2-way CHOICE: the question
// shows two tap options, each leading into its own short branch of follow-ups.
// Branches rejoin the main line automatically (DFS over the tree). Branching is
// one level deep by design — enough for "did you meet it? → why / why not".
//
// The star marks where the nightly MINIMUM ends: the walk starts at the top and,
// on answering the starred node, offers commit (with "keep reflecting" to go on).
//
// Everything autosaves so a half-finished night resumes exactly where you left it.

const LS_DRAFT = "rc_draft_v4";
const LS_QLIST = "rc_questions_v4";
const LS_SETTINGS = "rc_settings_v3";
const LS_LASTNOTIF = "rc_last_notif_v3";

let questions = [];
let settings = { notifyTime: "20:00" };
let commitments = [];
let editMode = false;
let chatCollapsed = false;
let draft = blankDraft();

// phone = mobile UA, or a coarse-pointer device on a narrow screen. Used to
// (a) gate structural branch-editing to desktop, (b) show the desktop nudge.
function isPhone() { return isMobileUA() || (window.matchMedia("(pointer: coarse)").matches && window.innerWidth < 820); }
function canBranchHere() { return !isPhone(); }

function blankDraft() {
  return { active: false, phase: null, mode: "min", currentId: null, answers: {},
           history: [], checkinId: null, resumeId: null, lastQuestionId: null,
           commitText: "", commitDue: "", committed: false };
}

const SILENCE_MS = 1900;
const HOLD_MS = 1000;

// ---------- local persistence ----------
function loadLocal() {
  try { questions = JSON.parse(localStorage.getItem(LS_QLIST) || "[]"); } catch (_) {}
  try { settings = JSON.parse(localStorage.getItem(LS_SETTINGS) || "null") || settings; } catch (_) {}
  try { draft = JSON.parse(localStorage.getItem(LS_DRAFT) || "null") || draft; } catch (_) {}
}
function saveLocalQuestions() { localStorage.setItem(LS_QLIST, JSON.stringify(questions)); }
function saveLocalSettings() { localStorage.setItem(LS_SETTINGS, JSON.stringify(settings)); }
function saveDraft() { localStorage.setItem(LS_DRAFT, JSON.stringify(draft)); window._saveDraft && window._saveDraft(draft); }
loadLocal();

// ---------- tree helpers ----------
function ensureShape(node, isRoot) {
  node.type = node.type || "text";
  if (node.recall === undefined) node.recall = false;
  if (isRoot && node.star === undefined) node.star = false;
  if (node.type === "choice") {
    // migrate the old shape (each option owned its own branch) to the new one:
    // any number of options, each pointing at one of (at most) two branches A/B.
    if (node.options && node.options[0] && node.options[0].branch && !node.branches) {
      node.branches = node.options.map((o) => o.branch || []).slice(0, 2);
      node.options = node.options.map((o, i) => ({ label: o.label || "", exit: Math.min(i, 1) }));
    }
    node.options = node.options && node.options.length ? node.options : [{ label: "yes", exit: 0 }, { label: "no", exit: 1 }];
    node.branches = node.branches && node.branches.length ? node.branches.slice(0, 2) : [[], []];
    while (node.branches.length < 2) node.branches.push([]);
    node.options.forEach((o) => { o.label = o.label || ""; o.exit = o.exit === 1 ? 1 : 0; });
    node.branches.forEach((br) => br.forEach((b) => ensureShape(b, false)));
  }
  return node;
}
function normalizeTree(list) { (list || []).forEach((n) => ensureShape(n, true)); return list || []; }

function indexTree(list, owner) {
  list.forEach((n, i) => {
    n._list = list; n._i = i; n._owner = owner || null;
    if (n.type === "choice" && n.branches) n.branches.forEach((br, bi) => indexTree(br || (n.branches[bi] = []), { choice: n, exit: bi }));
  });
}
function reindex() { indexTree(questions, null); }
function findNode(id, list) {
  list = list || questions;
  for (const n of list) {
    if (n.id === id) return n;
    if (n.type === "choice" && n.branches) for (const br of n.branches) { const f = findNode(id, br || []); if (f) return f; }
  }
  return null;
}
function siblingAfter(node) {
  const list = node._list, i = node._i;
  if (list[i + 1]) return list[i + 1];
  if (node._owner) return siblingAfter(node._owner.choice);
  return null;
}
function computeNext(node) {
  if (node.type === "choice") {
    const a = draft.answers[node.id];
    const exit = a && typeof a === "object" ? a.exit : null;
    if (exit != null && node.branches[exit] && node.branches[exit].length) return node.branches[exit][0];
    return siblingAfter(node);
  }
  return siblingAfter(node);
}
function starNode() { return questions.find((q) => q.star) || null; }
function currentNode() { return findNode(draft.currentId); }

// ---------- firestore hooks ----------
window._onQuestionsUpdated = () => {
  if (window._questions && window._questions.length) {
    questions = normalizeTree(window._questions);
    saveLocalQuestions();
    const ae = document.activeElement;
    if (ae && ae.closest && ae.closest("#qList") && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA")) return;
    renderQuestionEditor();
  }
};
window._onSettingsUpdated = () => { if (window._settings && window._settings.notifyTime) { settings = window._settings; saveLocalSettings(); renderSettings(); } };
window._onCommitmentsUpdated = () => { commitments = window._commitments || []; };
window._onDraftUpdated = () => { const rd = window._remoteDraft; if (rd && rd.active && !draft.active) { draft = { ...blankDraft(), ...rd }; localStorage.setItem(LS_DRAFT, JSON.stringify(draft)); } };
window._onSignedIn = () => {
  normalizeTree(questions); renderQuestionEditor(); renderSettings(); scheduleNotificationLoop();
  routeAfterAuth(); maybeOpenFromUrl();
  if ("Notification" in window && Notification.permission === "granted") window._registerPush && window._registerPush(deviceKind());
};
function deviceKind() { return isPhone() ? "mobile" : "desktop"; }

// ---------- routing ----------
function showScreen(id) { document.querySelectorAll(".screen").forEach((s) => s.classList.remove("on")); document.getElementById(id).classList.add("on"); }
function goHome() { stopVoice(); showScreen(isStandalone() ? "homeScreen" : "landingScreen"); }
function isStandalone() { return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true; }
// install is required on every device before use — phone AND desktop each
// get their own install prompt the first time they sign in on that device.
function routeAfterAuth() { showScreen(isStandalone() ? "homeScreen" : "landingScreen"); }
function maybeOpenFromUrl() { const p = new URLSearchParams(location.search); if (p.get("reflect") === "1") { history.replaceState({}, "", location.pathname); openReflection(); } }

// ---------- install ----------
let deferredInstallPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); deferredInstallPrompt = e; });
function isMobileUA() { return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.userAgentData && navigator.userAgentData.mobile); }
window.onGetStarted = async () => {
  if (deferredInstallPrompt) { deferredInstallPrompt.prompt(); await deferredInstallPrompt.userChoice; deferredInstallPrompt = null; return; }
  document.getElementById("getStartedBtn").style.display = "none";
  document.getElementById("landingManual").style.display = "block";
  document.getElementById("landingManual").textContent = isMobileUA()
    ? "tap ⋮ in your browser's toolbar, then Add to Home screen."
    : "click the install icon (⊕) in your address bar, or ⋮ menu → Install Reflect & Commit.";
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
  if ("serviceWorker" in navigator) navigator.serviceWorker.ready.then((reg) => reg.showNotification(title, { body, tag: "reflect" })).catch(() => fallbackNotify(title, body));
  else fallbackNotify(title, body);
}
function fallbackNotify(title, body) { const n = new Notification(title, { body }); n.onclick = () => { window.focus(); openReflection(); n.close(); }; }
async function requestNotifPermission() { if (!("Notification" in window)) return false; if (Notification.permission === "granted") return true; return (await Notification.requestPermission()) === "granted"; }
window.sendSelfNotification = async () => {
  const ok = await requestNotifPermission();
  if (!ok) { alert("Notifications are blocked — enable them in your browser/OS settings."); return; }
  window._registerPush && window._registerPush(deviceKind()); fireNotification("manual"); alert("Sent. Valid for 2 hours.");
};
let lastFiredDateKey = localStorage.getItem("rc_last_fired_date") || "";
function scheduleNotificationLoop() {
  setInterval(() => {
    const now = new Date(); const [h, m] = (settings.notifyTime || "20:00").split(":").map(Number); const key = now.toDateString();
    if (key !== lastFiredDateKey && now.getHours() === h && now.getMinutes() >= m && now.getMinutes() < m + 2) { lastFiredDateKey = key; localStorage.setItem("rc_last_fired_date", key); fireNotification("schedule"); }
  }, 30000);
}
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
  navigator.serviceWorker.addEventListener("message", (e) => { if (e.data && e.data.type === "notif-confirmed") { setLastNotif("schedule"); openReflection(); } });
}

// ---------- HOME / settings ----------
function renderSettings() { const el = document.getElementById("notifyTimeInput"); if (el) el.value = settings.notifyTime || "20:00"; renderNotifyLabel(); }
function renderNotifyLabel() {
  const el = document.getElementById("notifyCountdown"); if (!el) return;
  const [h, m] = (settings.notifyTime || "20:00").split(":").map(Number);
  const d = new Date(); d.setHours(h, m, 0, 0);
  el.textContent = "reflects at " + d.toLocaleTimeString(undefined, { hour: "numeric", minute: m ? "2-digit" : undefined });
}
window.onNotifyTimeChange = (v) => { settings.notifyTime = v; saveLocalSettings(); renderNotifyLabel(); window._saveSettings && window._saveSettings({ notifyTime: v }); };
window.openTimePicker = () => { const el = document.getElementById("notifyTimeInput"); if (!el) return; if (el.showPicker) { try { el.showPicker(); return; } catch (_) {} } el.focus(); };

// ---------- editor ----------
window.toggleEditMode = () => {
  editMode = !editMode;
  const b = document.getElementById("editToggle"); if (b) b.textContent = editMode ? "done" : "edit";
  const list = document.getElementById("qList"); if (list) list.classList.toggle("editing", editMode);
  renderQuestionEditor();
};
function persistQuestions() { saveLocalQuestions(); window._saveQuestions && window._saveQuestions(questions); }
function escapeHtml(s) { return (s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

function iconBtn(txt, cls, title, fn) { const b = document.createElement("button"); b.className = "q-icon-btn " + cls; b.textContent = txt; if (title) b.title = title; b.onclick = fn; return b; }

function renderQuestionEditor() {
  const list = document.getElementById("qList"); if (!list) return;
  normalizeTree(questions);
  const nudge = document.getElementById("desktopNudge");
  if (nudge) {
    nudge.style.display = isPhone() ? "block" : "none";
    const u = document.getElementById("desktopUrl"); if (u) u.textContent = location.host + location.pathname.replace(/\/$/, "");
  }
  list.innerHTML = "";
  questions.forEach((node, i) => list.appendChild(buildNode(node, questions, i, true)));
}

function buildNode(node, siblings, index, isRoot) {
  ensureShape(node, isRoot);
  const wrap = document.createElement("div"); wrap.className = "q-node" + (node.type === "choice" ? " is-choice" : "");
  wrap.dataset.dragIndex = index;
  const row = document.createElement("div"); row.className = "q-row";

  if (editMode) {
    const handle = document.createElement("button"); handle.className = "q-drag-handle"; handle.textContent = "⋮⋮"; handle.title = "drag to reorder";
    wireDrag(handle, wrap, siblings, index);
    row.appendChild(handle);
  }

  if (isRoot && editMode) {
    const star = document.createElement("button");
    star.className = "q-star" + (node.star ? " on" : ""); star.textContent = node.star ? "★" : "☆"; star.title = "where your minimum ends";
    star.onclick = () => { const was = node.star; questions.forEach((q) => (q.star = false)); node.star = !was; persistQuestions(); renderQuestionEditor(); };
    row.appendChild(star);
  }

  const input = document.createElement("input"); input.className = "q-text"; input.value = node.text || ""; input.placeholder = "write a question…";
  input.oninput = () => { node.text = input.value; persistQuestions(); };
  row.appendChild(input);

  const struct = canBranchHere(); // structural (branch) edits = desktop only, but the icon itself is always visible there
  const icons = document.createElement("div"); icons.className = "q-icons";
  if (isRoot && struct) {
    if (node.type === "choice") icons.appendChild(iconBtn("merge", "q-split", "remove branches", () => mergeNode(node)));
    else icons.appendChild(iconBtn("split", "q-split", "branch into two", () => splitNode(node)));
  }
  icons.appendChild(iconBtn("↺", "q-recall-icon" + (node.recall ? " on" : ""), "recall past answers", () => { node.recall = !node.recall; persistQuestions(); renderQuestionEditor(); }));
  if (editMode) icons.appendChild(iconBtn("✕", "q-del-icon", "remove", () => { siblings.splice(index, 1); persistQuestions(); renderQuestionEditor(); }));
  row.appendChild(icons);
  wrap.appendChild(row);

  if (node.type === "choice") {
    if (!editMode) {
      // compact, read-only summary outside edit mode
      const compact = document.createElement("div"); compact.className = "q-branch-compact";
      compact.textContent = node.options.map((o) => o.label || "…").join(" · ");
      wrap.appendChild(compact);
      return wrap;
    }
    const box = document.createElement("div"); box.className = "q-branches";

    // options: any number of labels, each pointing at exit A or B
    const optsWrap = document.createElement("div"); optsWrap.className = "q-opts";
    node.options.forEach((opt, oi) => {
      const orow = document.createElement("div"); orow.className = "q-opt-row";
      const lbl = document.createElement("input"); lbl.className = "q-opt-label"; lbl.value = opt.label || ""; lbl.placeholder = "option";
      lbl.oninput = () => { opt.label = lbl.value; persistQuestions(); };
      orow.appendChild(lbl);
      const ex = document.createElement("button"); ex.className = "q-exit-toggle exit-" + (opt.exit === 1 ? "b" : "a"); ex.textContent = opt.exit === 1 ? "B" : "A"; ex.title = "which branch this leads to";
      if (struct) ex.onclick = () => { opt.exit = opt.exit === 1 ? 0 : 1; persistQuestions(); renderQuestionEditor(); };
      else ex.disabled = true;
      orow.appendChild(ex);
      if (struct && node.options.length > 1) {
        const del = document.createElement("button"); del.className = "q-icon-btn q-del-icon"; del.textContent = "✕"; del.title = "remove option";
        del.onclick = () => { node.options.splice(oi, 1); persistQuestions(); renderQuestionEditor(); };
        orow.appendChild(del);
      }
      optsWrap.appendChild(orow);
    });
    if (struct) {
      const addOpt = document.createElement("button"); addOpt.className = "q-branch-add"; addOpt.textContent = "+ option";
      addOpt.onclick = () => { node.options.push({ label: "", exit: 0 }); persistQuestions(); renderQuestionEditor(); };
      optsWrap.appendChild(addOpt);
    }
    box.appendChild(optsWrap);
    if (editMode && !struct) { const note = document.createElement("div"); note.className = "q-desktop-note"; note.textContent = "branch structure edits on your computer"; box.appendChild(note); }

    // up to two branch lanes (A / B). Outside edit mode, an unused lane is hidden.
    [0, 1].forEach((bi) => {
      const used = node.options.some((o) => (o.exit || 0) === bi);
      if (!editMode && !used) return;
      const lane = document.createElement("div"); lane.className = "q-lane";
      const head = document.createElement("div"); head.className = "q-lane-head";
      const badge = document.createElement("span"); badge.className = "q-lane-badge exit-" + (bi === 1 ? "b" : "a"); badge.textContent = bi === 1 ? "B" : "A"; head.appendChild(badge);
      const arrow = document.createElement("span"); arrow.className = "q-lane-arrow"; arrow.textContent = "→"; head.appendChild(arrow);
      lane.appendChild(head);
      const bl = document.createElement("div"); bl.className = "q-branch-list";
      (node.branches[bi] || []).forEach((bn, xi) => bl.appendChild(buildNode(bn, node.branches[bi], xi, false)));
      lane.appendChild(bl);
      if (struct) {
        const add = document.createElement("button"); add.className = "q-branch-add"; add.textContent = "+ follow-up";
        add.onclick = () => { node.branches[bi].push({ id: "q_" + Date.now() + "_" + bi, text: "", recall: false, type: "text" }); persistQuestions(); renderQuestionEditor(); };
        lane.appendChild(add);
      }
      box.appendChild(lane);
    });
    wrap.appendChild(box);
  }
  return wrap;
}

// drag-to-reorder: native HTML5 DnD, drag only starts from the ⋮⋮ handle
// (dragstart is cancelled unless it originated there, so typing/clicking the
// text field never triggers a drag). A hairline indicator shows where the
// row will land; the array only reorders on drop, then everything fades
// back in via the .q-node animation in CSS for a clean, non-janky settle.
function wireDrag(handle, wrap, list, index) {
  wrap.draggable = true;
  wrap.addEventListener("dragstart", (e) => {
    if (e.target !== handle) { e.preventDefault(); return; }
    wrap.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(index));
    window._dragList = list; window._dragFrom = index;
  });
  wrap.addEventListener("dragend", () => {
    wrap.classList.remove("dragging");
    document.querySelectorAll(".drag-over,.drag-over-below").forEach((n) => n.classList.remove("drag-over", "drag-over-below"));
  });
  wrap.addEventListener("dragover", (e) => {
    if (window._dragList !== list) return;
    e.preventDefault();
    const rect = wrap.getBoundingClientRect();
    const before = e.clientY - rect.top < rect.height / 2;
    document.querySelectorAll(".drag-over,.drag-over-below").forEach((n) => n.classList.remove("drag-over", "drag-over-below"));
    wrap.classList.add(before ? "drag-over" : "drag-over-below");
  });
  wrap.addEventListener("drop", (e) => {
    e.preventDefault();
    if (window._dragList !== list) return;
    const from = window._dragFrom;
    const rect = wrap.getBoundingClientRect();
    const before = e.clientY - rect.top < rect.height / 2;
    let to = index + (before ? 0 : 1);
    if (to > from) to--;
    if (from !== to) { const [moved] = list.splice(from, 1); list.splice(to, 0, moved); persistQuestions(); }
    renderQuestionEditor();
  });
}
function splitNode(node) { node.type = "choice"; node.options = [{ label: "yes", exit: 0 }, { label: "no", exit: 1 }]; node.branches = [[], []]; persistQuestions(); renderQuestionEditor(); }
function mergeNode(node) {
  const has = (node.branches || []).some((br) => (br || []).length);
  if (has && !confirm("Remove both branches and their follow-up questions?")) return;
  node.type = "text"; delete node.options; delete node.branches; persistQuestions(); renderQuestionEditor();
}
window.addQuestion = () => {
  questions.push({ id: "q_" + Date.now(), text: "", recall: false, star: !questions.some((q) => q.star), type: "text" });
  persistQuestions(); renderQuestionEditor();
  const list = document.getElementById("qList");
  const inputs = list.querySelectorAll(":scope > .q-node > .q-row > .q-text");
  inputs[inputs.length - 1] && inputs[inputs.length - 1].focus();
};

// ---------- day-after check-in gate ----------
function dueCommitment() { const today = new Date(); today.setHours(0, 0, 0, 0); return (commitments || []).find((c) => c.status === "active" && c.dueDate && new Date(c.dueDate) <= today); }

// ---------- reflection ----------
function openReflection() {
  if (!withinReflectWindow()) { document.getElementById("nextAvailLabel").textContent = nextScheduledLabel(); showScreen("unavailableScreen"); return; }
  showScreen("reflectScreen"); reindex();
  if (draft.active && draft.phase) return resumePhase();
  draft = blankDraft(); draft.active = true;
  const due = dueCommitment();
  if (due) { draft.phase = "checkin"; draft.checkinId = due.id; saveDraft(); return enterCheckin(due); }
  startWalk();
}
function resumePhase() {
  reindex();
  if (draft.phase === "checkin") { const due = dueCommitment(); return due ? enterCheckin(due) : startWalk(); }
  if (draft.phase === "question") return renderChat();
  if (draft.phase === "commit") return enterCommit();
  if (draft.phase === "done") return enterDone(draft.committed);
  startWalk();
}
function startWalk() {
  reindex();
  const first = questions[0];
  if (!first) return enterCommit();
  draft.phase = "question"; draft.currentId = first.id; draft.history = []; saveDraft();
  renderChat();
}

function setPhase(id) { document.querySelectorAll(".phase").forEach((p) => p.classList.remove("on")); document.getElementById(id).classList.add("on"); }
function setBackVisible(v) { const b = document.getElementById("reflectBack"); if (b) b.style.display = v ? "flex" : "none"; }

// -- check-in --
function enterCheckin(cmt) { stopVoice(); setPhase("phaseCheckin"); setBackVisible(false); setCollapseVisible(false); document.getElementById("checkinText").textContent = cmt.text; wireHold("checkinHold", "checkinRingFill", () => resolveCheckin("done")); }
window.resolveCheckin = (status) => { if (draft.checkinId) window._resolveCommitment && window._resolveCommitment(draft.checkinId, status); draft.checkinId = null; startWalk(); };

// -- questions rendered as a chat transcript --
function setCollapseVisible(v) { const c = document.getElementById("reflectCollapse"); if (c) c.style.display = v ? "block" : "none"; }

function renderChat() {
  reindex();
  const node = currentNode();
  if (!node) return afterQuestions();
  setPhase("phaseChat");
  setBackVisible(draft.history.length > 0);
  setCollapseVisible(draft.history.length > 0);

  const scroll = document.getElementById("chatScroll");
  scroll.classList.toggle("collapsed", chatCollapsed);
  scroll.innerHTML = "";
  draft.history.forEach((id) => {
    const n = findNode(id); if (!n) return;
    const a = draft.answers[id];
    const ans = a && typeof a === "object" ? a.label : (a || "");
    const item = document.createElement("div"); item.className = "chat-item past";
    item.innerHTML = `<div class="chat-q">${escapeHtml(n.text)}</div><div class="chat-a">${escapeHtml(ans)}</div>`;
    scroll.appendChild(item);
  });
  const cur = document.createElement("div"); cur.className = "chat-item current";
  cur.innerHTML = `<div class="chat-q big">${escapeHtml(node.text)}</div>`;
  scroll.appendChild(cur);
  scroll.scrollTop = scroll.scrollHeight;

  const choices = document.getElementById("chatChoices");
  const bar = document.getElementById("composerBar");
  const recall = document.getElementById("chatRecall"), rlist = document.getElementById("chatRecallList");
  recall.classList.remove("open"); rlist.classList.remove("open"); rlist.innerHTML = "";

  if (node.type === "choice") {
    stopVoice();
    bar.style.display = "none"; recall.style.display = "none";
    choices.style.display = "flex"; choices.innerHTML = "";
    node.options.forEach((opt, k) => {
      const b = document.createElement("button"); b.className = "q-choice"; b.textContent = opt.label || (k === 0 ? "yes" : "no");
      b.onclick = () => { b.classList.add("chosen"); chooseOption(node, k); };
      choices.appendChild(b);
    });
  } else {
    choices.style.display = "none"; bar.style.display = "flex";
    const field = document.getElementById("answerField");
    field.value = typeof draft.answers[node.id] === "string" ? draft.answers[node.id] : "";
    autoGrow(field);
    field.oninput = () => { draft.answers[node.id] = field.value; autoGrow(field); saveDraft(); };
    field.onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); composerSend(); } };
    if (node.recall) { recall.style.display = "inline-flex"; recall.onclick = () => { const open = recall.classList.toggle("open"); rlist.classList.toggle("open", open); if (open) fillRecall(node, rlist); }; }
    else recall.style.display = "none";
    updateMicBtn();
    setTimeout(() => field.focus(), 60);
  }
  const cd = document.getElementById("continueDesktop"); if (cd) cd.style.display = isPhone() ? "block" : "none";
}

window.composerSend = () => { const n = currentNode(); if (n && n.type !== "choice") submitText(n); };
window.toggleTranscript = () => { chatCollapsed = !chatCollapsed; renderChat(); };

// ---------- hand-off to desktop ----------
// The draft is already synced continuously (saveDraft -> _saveDraft), so the
// content was never actually at risk. What this adds is a deliberate,
// visible confirmation: the phone parks itself, and the *other* device picks
// up instantly if it's already open (real-time Firestore listener below), or
// via a push notification within a few minutes otherwise (fallback, piggy-
// backed on the existing free GitHub Actions cron — see scripts/send-notifications.js).
window.showDesktopHint = () => {
  stopVoice();
  window._requestHandoff && window._requestHandoff();
  setPhase("phaseParked"); setBackVisible(false); setCollapseVisible(false);
  const u = document.getElementById("parkedUrl"); if (u) u.textContent = location.host + location.pathname.replace(/\/$/, "");
};
window.resumeHere = () => { renderChat(); };

window._onHandoffUpdated = () => {
  const h = window._handoff;
  if (!h || h.consumed || isPhone()) return; // only a non-phone device ever consumes a hand-off
  const requestedAt = h.requestedAt && h.requestedAt.toMillis ? h.requestedAt.toMillis() : (h.requestedAt ? new Date(h.requestedAt).getTime() : 0);
  if (requestedAt && Date.now() - requestedAt > 10 * 60 * 1000) return; // stale — ignore
  window._consumeHandoff && window._consumeHandoff();
  setLastNotif("handoff"); // deliberate continuation — always opens, regardless of the usual notification window
  if (draft.active) { showScreen("reflectScreen"); reindex(); resumePhase(); }
  else openReflection();
};

function submitText(node) {
  const ans = (draft.answers[node.id] || "").trim();
  if (ans) { const k = "rc_answer_hist_" + node.id; let h = []; try { h = JSON.parse(localStorage.getItem(k) || "[]"); } catch (_) {} h.unshift({ a: ans, t: Date.now() }); localStorage.setItem(k, JSON.stringify(h.slice(0, 30))); }
  advanceFrom(node);
}
function chooseOption(node, k) {
  const opt = node.options[k];
  draft.answers[node.id] = { optIndex: k, label: opt.label, exit: opt.exit || 0 }; saveDraft();
  advanceFrom(node);
}
function advanceFrom(node) {
  stopVoice(); reindex();
  const fresh = findNode(node.id) || node;
  const star = starNode();
  if (draft.mode !== "full" && star && star.id === fresh.id) {
    const nx = computeNext(fresh); draft.resumeId = nx ? nx.id : null; draft.lastQuestionId = fresh.id; saveDraft(); return enterCommit();
  }
  const nx = computeNext(fresh);
  if (!nx) { draft.lastQuestionId = fresh.id; draft.resumeId = null; saveDraft(); return afterQuestions(); }
  draft.history.push(fresh.id); draft.currentId = nx.id; saveDraft(); renderChat();
}
function afterQuestions() { stopVoice(); if (draft.mode === "full") return finishSession(); enterCommit(); }

function fillRecall(node, el) {
  let h = []; try { h = JSON.parse(localStorage.getItem("rc_answer_hist_" + node.id) || "[]"); } catch (_) {}
  if (!h.length) { el.innerHTML = "<div class='recall-empty'>nothing here yet</div>"; return; }
  el.innerHTML = h.slice(0, 10).map((x) => `<div class="recall-item"><span class="recall-date">${new Date(x.t).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>${escapeHtml(x.a)}</div>`).join("");
}

// -- back --
window.goBackPhase = () => {
  if (draft.phase === "question") { if (draft.history.length) { draft.currentId = draft.history.pop(); saveDraft(); renderChat(); } }
  else if (draft.phase === "commit") { draft.phase = "question"; draft.currentId = draft.lastQuestionId; saveDraft(); renderChat(); }
  else if (draft.phase === "done") { enterCommit(); }
};

// -- commit --
function enterCommit() {
  stopVoice(); draft.phase = "commit"; saveDraft(); setPhase("phaseCommit"); setBackVisible(true); setCollapseVisible(false);
  const field = document.getElementById("commitField");
  field.value = draft.commitText || ""; autoGrow(field);
  field.oninput = () => { draft.commitText = field.value; autoGrow(field); saveDraft(); };
  field.onkeydown = (e) => { if (e.key === "Enter") e.preventDefault(); };
  renderDueSelect();
  wireHold("commitHold", "commitRingFill", doCommit);
  setTimeout(() => field.focus(), 60);
}
function renderDueSelect() {
  const sel = document.getElementById("commitDueSelect"); if (!sel) return;
  sel.innerHTML = "";
  for (let i = 1; i <= 7; i++) {
    const d = new Date(); d.setDate(d.getDate() + i);
    const opt = document.createElement("option"); opt.value = d.toISOString().slice(0, 10);
    opt.textContent = i === 1 ? "tomorrow" : d.toLocaleDateString(undefined, { weekday: "long" }).toLowerCase();
    sel.appendChild(opt);
  }
  sel.value = draft.commitDue && sel.querySelector(`option[value="${draft.commitDue}"]`) ? draft.commitDue : sel.options[0].value;
  draft.commitDue = sel.value; saveDraft();
}
window.onCommitDueChange = (v) => { draft.commitDue = v; saveDraft(); };
function doCommit() { const text = (draft.commitText || "").trim(); if (text) window._addCommitment && window._addCommitment({ text, dueDate: draft.commitDue }); if (navigator.vibrate) navigator.vibrate(12); draft.committed = true; enterDone(true); }
window.skipCommit = () => { draft.committed = false; enterDone(false); };

// -- done --
function enterDone(committed) {
  stopVoice(); draft.phase = "done"; saveDraft(); setPhase("phaseDone"); setBackVisible(true); setCollapseVisible(false);
  document.getElementById("doneText").textContent = committed ? "committed. see you tomorrow." : "logged. see you tomorrow.";
  const kg = document.getElementById("keepGoingBtn"); kg.style.display = draft.resumeId ? "block" : "none";
}
window.keepReflecting = () => { draft.mode = "full"; draft.commitText = ""; draft.history = []; draft.currentId = draft.resumeId; draft.phase = "question"; saveDraft(); renderChat(); };

function finishSession() { window._saveSession && window._saveSession({ answers: draft.answers }); draft = blankDraft(); saveDraft(); window._clearDraft && window._clearDraft(); goHome(); }
window.exitReflection = () => { stopVoice(); goHome(); };

// textareas grow vertically; the single-line answer input instead scrolls
// horizontally so a long answer runs off the right edge (and fades) rather
// than wrapping onto a second line.
function autoGrow(el) {
  if (el.tagName === "TEXTAREA") { el.style.height = "auto"; el.style.height = el.scrollHeight + "px"; }
  else { el.scrollLeft = el.scrollWidth; }
}

// ---------- hold-to-confirm ----------
function wireHold(btnId, fillId, onComplete) {
  const btn = document.getElementById(btnId), fill = document.getElementById(fillId);
  const CIRC = 207.3; let raf = null, start = 0, done = false;
  fill.style.strokeDashoffset = CIRC;
  const tick = (ts) => { if (!start) start = ts; const p = Math.min((ts - start) / HOLD_MS, 1); fill.style.strokeDashoffset = CIRC * (1 - p); if (p >= 1) { done = true; btn.classList.add("done"); release(true); return; } raf = requestAnimationFrame(tick); };
  const press = (e) => { e.preventDefault(); if (done) return; start = 0; raf = requestAnimationFrame(tick); };
  const release = (complete) => { if (raf) cancelAnimationFrame(raf); raf = null; if (complete) onComplete(); else { fill.style.transition = "stroke-dashoffset .25s ease"; fill.style.strokeDashoffset = CIRC; setTimeout(() => (fill.style.transition = ""), 260); } };
  btn.onpointerdown = press; btn.onpointerup = () => { if (!done) release(false); }; btn.onpointerleave = () => { if (!done) release(false); };
}

// ---------- voice (demoted: opt-in dictation via the mic button) ----------
let recog = null, voiceField = null, voiceBase = "", listeningWanted = false, micActive = false;
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
window.toggleMic = () => {
  if (!SR) { alert("Voice dictation isn't supported in this browser — just type."); return; }
  if (micActive) stopVoice(); else startVoice(document.getElementById("answerField"));
};
function updateMicBtn() { const b = document.getElementById("micBtn"); if (b) { b.classList.toggle("active", micActive); b.style.display = SR ? "flex" : "none"; } }
function startVoice(field) {
  if (!SR || !field) return;
  stopVoice(); voiceField = field; voiceBase = field.value ? field.value + " " : "";
  try {
    recog = new SR(); recog.continuous = true; recog.interimResults = true; recog.lang = navigator.language || "en-US";
    recog.onresult = (e) => {
      let interim = "", final = "";
      for (let i = e.resultIndex; i < e.results.length; i++) { const t = e.results[i][0].transcript; if (e.results[i].isFinal) final += t; else interim += t; }
      if (final) voiceBase = (voiceBase + final).replace(/\s+/g, " ").replace(/^\s/, "") + " ";
      voiceField.value = (voiceBase + interim).trimStart(); autoGrow(voiceField);
      const n = currentNode(); if (n) draft.answers[n.id] = voiceField.value;
      saveDraft();
    };
    recog.onerror = () => {};
    recog.onend = () => { if (recog && listeningWanted) { try { recog.start(); } catch (_) {} } };
    listeningWanted = true; micActive = true; recog.start(); updateMicBtn(); field.focus();
  } catch (_) { micActive = false; updateMicBtn(); }
}
function stopVoice() {
  listeningWanted = false; micActive = false;
  const b = document.getElementById("micBtn"); if (b) b.classList.remove("active");
  if (recog) { try { recog.onend = null; recog.stop(); } catch (_) {} recog = null; }
}

// ---------- boot ----------
document.addEventListener("DOMContentLoaded", () => { normalizeTree(questions); renderQuestionEditor(); renderSettings(); });
