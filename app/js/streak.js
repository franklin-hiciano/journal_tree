// ── Reflection streak: consecutive days with at least one completed reflection ─────
// Reads window._userRuns (life-level, synced across every tree by firebase-init.js) —
// a day "counts" toward the streak if any run saved on it has complete === true.
function _streakDayKey(ts) {
  const d = new Date(ts);
  if (isNaN(d)) return null;
  return d.toISOString().slice(0, 10);
}

function computeStreak() {
  const runs = window._userRuns || [];
  const days = new Set();
  runs.forEach((r) => {
    if (!r || !r.complete || !r.savedAt) return;
    const k = _streakDayKey(r.savedAt);
    if (k) days.add(k);
  });
  if (!days.size) return 0;

  let cursor = new Date();
  cursor.setHours(0, 0, 0, 0);
  let key = cursor.toISOString().slice(0, 10);
  if (!days.has(key)) {
    // today hasn't happened yet — the streak stays alive as long as yesterday counts
    cursor.setDate(cursor.getDate() - 1);
    key = cursor.toISOString().slice(0, 10);
    if (!days.has(key)) return 0;
  }
  let streak = 0;
  while (days.has(key)) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
    key = cursor.toISOString().slice(0, 10);
  }
  return streak;
}

function renderStreak() {
  const n = computeStreak();
  document.querySelectorAll(".streak-pill").forEach((pill) => {
    const num = pill.querySelector(".streak-n");
    if (num) num.textContent = n;
    pill.classList.toggle("on", n > 0);
    pill.title = n
      ? n + " day" + (n === 1 ? "" : "s") + " in a row — don't break it."
      : "reflect today to start a streak";
  });
}

// recompute whenever the data that could move it changes
(function () {
  const origOnRunsUpdated = window._onRunsUpdated;
  window._onRunsUpdated = function (treeId) {
    if (origOnRunsUpdated) origOnRunsUpdated(treeId);
    renderStreak();
    setTimeout(renderStreak, 900); // life-level "runs" listener can land a beat later
  };
  const origOnTreesUpdated = window._onTreesUpdated;
  window._onTreesUpdated = function () {
    if (origOnTreesUpdated) origOnTreesUpdated();
    renderStreak();
  };
})();

document.addEventListener("DOMContentLoaded", renderStreak);
renderStreak();

// ── streak / help swap ──────────────────────────────────────────────────────────────
// The streak pill stays out of the top bar entirely until the user has made at least
// one commitment — until then the help "?" button sits in that spot instead. Once
// unlocked (permanently — it doesn't re-lock if the streak later drops to 0), the
// streak takes the top-bar slot and help moves to a floating button bottom-right.
function hasEverCommitted() {
  return (window._commitments || []).length > 0;
}

function updateStreakHelpLayout() {
  const unlocked = hasEverCommitted();
  const streakPill = document.getElementById("streakPill");
  const topHelpWrap = document.querySelector(".top-bar .help-btn-wrap");
  const helpFab = document.getElementById("helpFabBtn");
  if (streakPill) streakPill.style.display = unlocked ? "" : "none";
  if (topHelpWrap) topHelpWrap.style.display = unlocked ? "none" : "";
  if (helpFab) helpFab.style.display = unlocked ? "" : "none";
}

(function () {
  const origOnCommitmentsUpdated = window._onCommitmentsUpdated;
  window._onCommitmentsUpdated = function () {
    if (origOnCommitmentsUpdated) origOnCommitmentsUpdated();
    updateStreakHelpLayout();
  };
})();

document.addEventListener("DOMContentLoaded", updateStreakHelpLayout);
updateStreakHelpLayout();
