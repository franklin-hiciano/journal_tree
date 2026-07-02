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
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { registerForPush } from "./firebase-messaging-setup.js";

// same firebase project as before — schema is new/simplified, old collections
// (trees/runs/commitments) are just left alone and unused now.
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

let uid = null;

const DEFAULT_QUESTIONS = [
  { id: "q_" + Date.now() + "_1", text: "Did you move the thing that matters most right now?", recall: false, star: true },
  { id: "q_" + Date.now() + "_2", text: "What did you actually do with today? Hours, not vibes.", recall: false, star: false },
  { id: "q_" + Date.now() + "_3", text: "What did you avoid, and what were you afraid would happen?", recall: true, star: false },
];

function uDoc(...s) {
  return doc(db, "users", uid, ...s);
}
function uCol(...s) {
  return collection(db, "users", uid, ...s);
}

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
  await fbSignOut(auth);
};

onAuthStateChanged(auth, async (user) => {
  if (user) {
    uid = user.uid;
    window._uid = uid;
    document.getElementById("authScreen").classList.add("hidden");
    setSyncDot("syncing");

    // seed default question list if none exists yet
    try {
      const qSnap = await getDoc(uDoc("state", "questions"));
      if (!qSnap.exists() || !(qSnap.data().list || []).length) {
        await setDoc(uDoc("state", "questions"), {
          list: DEFAULT_QUESTIONS,
          updatedAt: serverTimestamp(),
        });
      }
    } catch (e) {
      console.error(e);
    }

    onSnapshot(uDoc("state", "questions"), (snap) => {
      window._questions = snap.exists() ? snap.data().list || [] : [];
      window._onQuestionsUpdated && window._onQuestionsUpdated();
      setSyncDot("ok");
    }, () => setSyncDot("err"));

    onSnapshot(uDoc("state", "settings"), (snap) => {
      window._settings = snap.exists() ? snap.data() : {};
      window._onSettingsUpdated && window._onSettingsUpdated();
    }, () => {});

    onSnapshot(uDoc("state", "draft"), (snap) => {
      window._remoteDraft = snap.exists() ? snap.data() : null;
      window._onDraftUpdated && window._onDraftUpdated();
    }, () => {});

    onSnapshot(query(uCol("commitments"), orderBy("createdAt", "desc")), (snap) => {
      window._commitments = snap.docs.map((d) => ({
        id: d.id,
        ...d.data(),
        createdAt: d.data().createdAt?.toDate?.()?.toISOString?.() ?? d.data().createdAt,
      }));
      window._onCommitmentsUpdated && window._onCommitmentsUpdated();
    }, () => {});

    window._onSignedIn && window._onSignedIn();
  } else {
    uid = null;
    window._uid = null;
    document.getElementById("authScreen").classList.remove("hidden");
    setSyncDot("");
  }
});

let qSaveTimer = null;
window._saveQuestions = function (list) {
  if (!uid) return;
  // debounced: writing on every keystroke round-trips through the onSnapshot
  // listener fast enough to rebuild the question list mid-type and steal focus
  // (the mobile keyboard-closing bug). Batch rapid edits into one write.
  clearTimeout(qSaveTimer);
  qSaveTimer = setTimeout(async () => {
    setSyncDot("syncing");
    try {
      await setDoc(uDoc("state", "questions"), { list, updatedAt: serverTimestamp() });
      setSyncDot("ok");
    } catch (e) {
      setSyncDot("err");
    }
  }, 500);
};

window._saveSettings = async function (patch) {
  if (!uid) return;
  try {
    await setDoc(uDoc("state", "settings"), { ...patch, updatedAt: serverTimestamp() }, { merge: true });
  } catch (e) {}
};

let draftTimer = null;
window._saveDraft = function (draft) {
  if (!uid) return;
  clearTimeout(draftTimer);
  draftTimer = setTimeout(async () => {
    try {
      await setDoc(uDoc("state", "draft"), { ...draft, updatedAt: serverTimestamp() });
    } catch (e) {}
  }, 400);
};

window._clearDraft = async function () {
  if (!uid) return;
  try {
    await setDoc(uDoc("state", "draft"), { answers: {}, index: 0, active: false, updatedAt: serverTimestamp() });
  } catch (e) {}
};

window._saveSession = async function (session) {
  if (!uid) return;
  try {
    await setDoc(uDoc("sessions", "s_" + Date.now()), { ...session, savedAt: serverTimestamp() });
  } catch (e) {}
};

window._addCommitment = async function (cmt) {
  if (!uid) return null;
  const id = "cmt_" + Date.now();
  try {
    await setDoc(uDoc("commitments", id), {
      text: cmt.text || "",
      dueDate: cmt.dueDate || "",
      status: "active",
      createdAt: serverTimestamp(),
    });
  } catch (e) {}
  return id;
};
window._resolveCommitment = async function (id, status) {
  if (!uid) return;
  try {
    await setDoc(uDoc("commitments", id), { status, resolvedAt: serverTimestamp() }, { merge: true });
  } catch (e) {}
};

window._registerPush = function () {
  if (!uid) return;
  registerForPush(fbApp, uid, async (token, tzOffsetMin) => {
    try {
      await setDoc(uDoc("state", "push"), { token, tzOffsetMin, updatedAt: serverTimestamp() });
    } catch (e) {}
  });
};

window._fbReady = true;
