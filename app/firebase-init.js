import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut as fbSignOut,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  getFirestore,
  doc,
  collection,
  setDoc,
  getDoc,
  onSnapshot,
  query,
  orderBy,
  serverTimestamp,
  getDocs,
  writeBatch,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const cfg = {
  apiKey: "AIzaSyBZQvIOvSOsmkW100IoZVsOiclEeAYm-V8",
  authDomain: "wisdom-tree-29e66.firebaseapp.com",
  projectId: "wisdom-tree-29e66",
  storageBucket: "wisdom-tree-29e66.firebasestorage.app",
  messagingSenderId: "716611475015",
  appId: "1:716611475015:web:0ecd11c22788b1c87dc362",
};
const fbApp = initializeApp(cfg);
const auth = getAuth(fbApp);
const db = getFirestore(fbApp);
const gProvider = new GoogleAuthProvider();

let uid = null,
  srcTimers = {},
  notesTimer = null,
  unsubbers = [];

const setSyncDot = (s) => {
  const d = document.getElementById("syncDot");
  if (d) d.className = "sync-dot" + (s ? " " + s : "");
};

window.doSignIn = async () => {
  try {
    await signInWithPopup(auth, gProvider);
  } catch (e) {
    console.error(e);
  }
};
window.doSignOut = async () => {
  unsubbers.forEach((u) => u && u());
  await fbSignOut(auth);
};
document.getElementById("btnSignIn").addEventListener("click", window.doSignIn);

// ── STRIPE PAYWALL ────────────────────────────────────────────────────────────────
// To turn it on: create a Payment Link in your Stripe dashboard, set its success URL to
// this app's URL with ?paid=1 appended, paste the link below, and set enabled:true.
// NOTE: this is a soft, client-side gate (fine for selling to a few trusted people).
// Anyone who reads the page source can bypass it. For real enforcement, deploy the
// Stripe webhook (Cloud Function) that sets users/{uid}/state/account.paid = true and
// add a Firestore rule so the client can't set 'paid' itself. Ask me for that code.
const PAY = {
  enabled: true,
  link: "https://buy.stripe.com/28E14g3ntcCt15dcRtRC01",
  price: "$29 · lifetime",
  blurb: "Unlock unlimited reflections and commitments.",
};
async function checkAccess(user) {
  if (!PAY.enabled) return true;
  const params = new URLSearchParams(location.search);
  if (params.get("paid") === "1") {
    try {
      await setDoc(
        uDoc("state", "account"),
        { paid: true, paidAt: serverTimestamp() },
        { merge: true },
      );
    } catch (e) {}
    try {
      history.replaceState({}, "", location.pathname);
    } catch (e) {}
    return true;
  }
  try {
    const snap = await getDoc(uDoc("state", "account"));
    return !!(snap.exists() && snap.data().paid);
  } catch (e) {
    return false;
  }
}
function showPaywall(user) {
  setSyncDot("");
  const pw = document.getElementById("paywall");
  if (!pw) return;
  const pp = document.getElementById("payPrice");
  if (pp) pp.textContent = PAY.price;
  const bl = document.getElementById("payBlurb");
  if (bl) bl.textContent = PAY.blurb;
  const btn = document.getElementById("payBtn");
  if (btn)
    btn.onclick = () => {
      const u =
        PAY.link +
        (PAY.link.includes("?") ? "&" : "?") +
        "client_reference_id=" +
        encodeURIComponent(uid) +
        (user.email
          ? "&prefilled_email=" + encodeURIComponent(user.email)
          : "");
      window.location.href = u;
    };
  pw.classList.add("on");
}
function hidePaywall() {
  const pw = document.getElementById("paywall");
  if (pw) pw.classList.remove("on");
}

onAuthStateChanged(auth, async (user) => {
  if (user) {
    uid = user.uid;
    document.getElementById("authScreen").classList.add("hidden");
    document.getElementById("userAvatar").src = user.photoURL || "";
    const un = document.getElementById("userName");
    if (un) un.textContent = user.displayName || user.email || "";
    setSyncDot("syncing");
    const access = await checkAccess(user);
    if (!access) {
      showPaywall(user);
      return;
    }
    hidePaywall();
    await migrateIfNeeded();
    window._uid = uid;
    subscribe();
    // show intro video on first entry (teaches how to design a question);
    // after dismissal it chains to the compound card.
    window._maybeShowIntroVideo && window._maybeShowIntroVideo();
  } else {
    uid = null;
    window._uid = null;
    document.getElementById("authScreen").classList.remove("hidden");
    hidePaywall();
    setSyncDot("");
  }
});

async function migrateIfNeeded() {
  const newSrcRef = doc(db, "users", uid, "trees", "default", "meta", "source");
  try {
    const snap = await getDoc(newSrcRef);
    if (!snap.exists()) {
      const oldSnap = await getDoc(doc(db, "users", uid, "tree", "source"));
      if (oldSnap.exists()) {
        await setDoc(newSrcRef, {
          source: oldSnap.data().source || "",
          updatedAt: serverTimestamp(),
        });
        await setDoc(
          doc(db, "users", uid, "trees", "default"),
          {
            name: "my reflections",
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          },
          { merge: true },
        );
      }
    }
  } catch (e) {
    console.error("migrate:", e);
  }
}

// single-framework model: if the user has no framework at all, seed a valid starter
// (a small live tree — one branch, a recall, every path ending at the commitment node)
// so reflect works immediately and they can see what a real tree looks like.
const STARTER_SRC = [
  "What did you actually do with today? Hours, not vibes.",
  "  >> Did you move the thing that matters most right now?",
  "",
  "Did you move the thing that matters most right now?",
  "  yes >> What made today work? Name it so tomorrow can copy it.",
  "  no >> What did you avoid, and what were you afraid would happen?",
  "",
  "What made today work? Name it so tomorrow can copy it.",
  "  >> done",
  "",
  "What did you avoid, and what were you afraid would happen?",
  "  @[What did you avoid, and what were you afraid would happen?] [1,7d]",
  "  >> done",
].join("\n");
async function ensureDefaultFramework() {
  try {
    await setDoc(
      tDoc("default"),
      {
        name: "my reflections",
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      },
      { merge: true },
    );
    // CRITICAL: only seed the starter source if the user has NO source yet.
    // Using {merge:true} still overwrites the 'source' field — so we must
    // check first and bail out if there's already content. This was the root
    // cause of data loss (a transient empty-trees snapshot triggered this and
    // overwrote whatever the user had written).
    const srcSnap = await getDoc(tDoc("default", "meta", "source"));
    if (!srcSnap.exists() || !srcSnap.data().source) {
      await setDoc(tDoc("default", "meta", "source"), {
        source: STARTER_SRC,
        updatedAt: serverTimestamp(),
      });
    }
  } catch (e) {
    console.error("ensureDefaultFramework:", e);
  }
}

function uCol(...s) {
  return collection(db, "users", uid, ...s);
}
function uDoc(...s) {
  return doc(db, "users", uid, ...s);
}
function tDoc(treeId, ...s) {
  return doc(db, "users", uid, "trees", treeId, ...s);
}
function tCol(treeId, ...s) {
  return collection(db, "users", uid, "trees", treeId, ...s);
}

function subscribe() {
  let fwEnsured = false;
  unsubbers.push(
    onSnapshot(
      uCol("trees"),
      async (snap) => {
        setSyncDot("ok");
        window._userTrees = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        if (!snap.size && !fwEnsured) {
          fwEnsured = true;
          await ensureDefaultFramework();
          return;
        }
        window._onTreesUpdated && window._onTreesUpdated();
      },
      () => setSyncDot("err"),
    ),
  );

  unsubbers.push(
    onSnapshot(
      query(uCol("runs"), orderBy("savedAt", "desc")),
      (snap) => {
        window._userRuns = snap.docs.map((d) => ({
          id: d.id,
          ...d.data(),
          savedAt:
            d.data().savedAt?.toDate?.()?.toISOString?.() ?? d.data().savedAt,
        }));
      },
      () => {},
    ),
  );

  // commitments (life-level, not per tree)
  unsubbers.push(
    onSnapshot(
      uCol("commitments"),
      (snap) => {
        window._commitments = snap.docs.map((d) => ({
          id: d.id,
          ...d.data(),
          createdAt:
            d.data().createdAt?.toDate?.()?.toISOString?.() ??
            d.data().createdAt,
        }));
        window._onCommitmentsUpdated && window._onCommitmentsUpdated();
      },
      () => {},
    ),
  );

  // scratch notes
  unsubbers.push(
    onSnapshot(
      uDoc("state", "scratch"),
      (snap) => {
        window._notes = snap.exists() ? snap.data().notes || "" : "";
        window._onNotesUpdated && window._onNotesUpdated();
      },
      () => {},
    ),
  );
}

window._subscribeTree = function (treeId) {
  window._treeUnsubs?.forEach((u) => u && u());
  window._treeUnsubs = [];
  window._treeUnsubs.push(
    onSnapshot(
      tDoc(treeId, "meta", "source"),
      (snap) => {
        if (!snap.exists()) return;
        const remote = snap.data().source || "";
        const t = document.getElementById("src-ta");
        if (t && remote !== t.value && document.activeElement !== t) {
          t.value = remote;
          window._currentSrc = remote;
          window._onSrcChange && window._onSrcChange(false);
        }
      },
      () => {},
    ),
  );
  window._treeUnsubs.push(
    onSnapshot(
      query(tCol(treeId, "runs"), orderBy("savedAt", "desc")),
      (snap) => {
        window._treeRuns = window._treeRuns || {};
        window._treeRuns[treeId] = snap.docs.map((d) => ({
          id: d.id,
          ...d.data(),
          savedAt:
            d.data().savedAt?.toDate?.()?.toISOString?.() ?? d.data().savedAt,
        }));
        window._onRunsUpdated && window._onRunsUpdated(treeId);
      },
      () => {},
    ),
  );
};

window._writeSrc = function (treeId, src) {
  if (!uid) return;
  // Guard: never write an empty source — this would silently erase the user's
  // tree if called during initialisation before the textarea is populated.
  if (!src || !src.trim()) return;
  clearTimeout(srcTimers[treeId]);
  setSyncDot("syncing");
  srcTimers[treeId] = setTimeout(async () => {
    try {
      await setDoc(tDoc(treeId, "meta", "source"), {
        source: src,
        updatedAt: serverTimestamp(),
      });
      setSyncDot("ok");
      // Save a local snapshot for version history (last 10)
      try {
        const hKey = "rc_history_" + treeId;
        const hist = JSON.parse(localStorage.getItem(hKey) || "[]");
        // Don't add a duplicate of the most-recent snapshot
        if (!hist.length || hist[0].src !== src) {
          hist.unshift({ src, ts: Date.now() });
          localStorage.setItem(hKey, JSON.stringify(hist.slice(0, 10)));
        }
      } catch (_) {}
    } catch (e) {
      setSyncDot("err");
    }
  }, 1200);
};

window._getHistory = function (treeId) {
  try {
    return JSON.parse(localStorage.getItem("rc_history_" + treeId) || "[]");
  } catch (_) {
    return [];
  }
};

window._createTree = async function (name) {
  if (!uid) return null;
  const id = "tree_" + Date.now();
  await setDoc(tDoc(id), {
    name,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  await setDoc(tDoc(id, "meta", "source"), {
    source: "",
    updatedAt: serverTimestamp(),
  });
  return id;
};
window._renameTree = async function (treeId, name) {
  if (uid)
    await setDoc(
      tDoc(treeId),
      { name, updatedAt: serverTimestamp() },
      { merge: true },
    );
};
window._deleteTree = async function (treeId) {
  if (!uid) return;
  const batch = writeBatch(db);
  (await getDocs(tCol(treeId, "runs"))).docs.forEach((d) =>
    batch.delete(d.ref),
  );
  batch.delete(tDoc(treeId, "meta", "source"));
  batch.delete(tDoc(treeId));
  await batch.commit();
};

window._saveRun = async function (treeId, run) {
  if (!uid || !run || !run.runId) return;
  setSyncDot("syncing");
  try {
    const payload = { ...run, savedAt: serverTimestamp() };
    await setDoc(tDoc(treeId, "runs", run.runId), payload, { merge: true });
    await setDoc(
      uDoc("runs", run.runId),
      { ...payload, treeId },
      { merge: true },
    );
    setSyncDot("ok");
  } catch (e) {
    setSyncDot("err");
    console.error("saveRun:", e);
  }
};

// ── Commitments ──  date = ISO check-in date (locked once set); status: active|done|missed|abandoned
window._addCommitment = async function (text, date) {
  if (!uid) return null;
  const id = "cmt_" + Date.now();
  await setDoc(uDoc("commitments", id), {
    text: text || "",
    date: date || "",
    status: "active",
    checkedIn: false,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  return id;
};
window._resolveCommitment = async function (id, status) {
  if (uid)
    await setDoc(
      uDoc("commitments", id),
      { status, checkedIn: true, resolvedAt: serverTimestamp() },
      { merge: true },
    );
};

// ── Scratch notes ──
window._saveNotes = function (text) {
  if (!uid) return;
  clearTimeout(notesTimer);
  notesTimer = setTimeout(async () => {
    try {
      await setDoc(
        uDoc("state", "scratch"),
        { notes: text, updatedAt: serverTimestamp() },
        { merge: true },
      );
    } catch (e) {}
  }, 900);
};

window._fbReady = true;
