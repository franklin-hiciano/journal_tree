// Runs on a GitHub Actions schedule (see .github/workflows/notify.yml).
// No Blaze plan / Cloud Functions needed — just the free Admin SDK talking to
// Firestore + FCM directly from GitHub's own runners. Every 5 minutes it does
// two independent passes per user:
//
// 1. SCHEDULED — reads state/settings.notifyTime ("HH:MM", their local time)
//    and each registered device's tzOffsetMin, converts to a UTC minute-of-day,
//    and — if that matches "now" within tolerance — sends to every device.
//
// 2. HAND-OFF FALLBACK — "continue on your computer" (app.js showDesktopHint)
//    writes state/handoff{requestedAt, consumed:false}. The primary path for
//    that is a real-time Firestore listener on whichever device is already
//    open — instant, and this script never even sees it (it gets consumed
//    client-side first). This pass is only the fallback for when the target
//    device *isn't* open: it pushes to that user's desktop-kind device(s) so
//    opening the notification resumes the session, at most a few minutes late.
//
// Devices live at users/{uid}/devices/{deviceId} — {token, kind, tzOffsetMin}.
// kind is "mobile" or "desktop", set client-side from the registering device.

const admin = require("firebase-admin");

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();
const messaging = admin.messaging();

const TOLERANCE_MIN = 5;
const HANDOFF_MAX_AGE_MIN = 10;

function utcMinuteOfDay(date) {
  return date.getUTCHours() * 60 + date.getUTCMinutes();
}

async function sendTo(token, title, body) {
  await messaging.send({
    token,
    data: { title, body },
    webpush: { headers: { Urgency: "high" } },
  });
}

async function main() {
  const now = new Date();
  const nowUtcMin = utcMinuteOfDay(now);
  const todayKey = now.toISOString().slice(0, 10);

  const usersSnap = await db.collection("users").get();
  let scheduledSent = 0, handoffSent = 0;

  for (const userDoc of usersSnap.docs) {
    const uid = userDoc.id;
    const [settingsSnap, devicesSnap, lastPushSnap, handoffSnap] = await Promise.all([
      db.doc(`users/${uid}/state/settings`).get(),
      db.collection(`users/${uid}/devices`).get(),
      db.doc(`users/${uid}/state/lastPush`).get(),
      db.doc(`users/${uid}/state/handoff`).get(),
    ]);
    const devices = devicesSnap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((d) => d.token);
    if (!devices.length) continue;

    // -- pass 1: scheduled nightly notification --
    if (settingsSnap.exists && settingsSnap.data().notifyTime) {
      const { notifyTime } = settingsSnap.data();
      const [h, m] = notifyTime.split(":").map(Number);
      const localMin = h * 60 + m;
      const last = lastPushSnap.exists ? lastPushSnap.data() : {};
      if (last.dateKey !== todayKey) {
        for (const dev of devices) {
          if (typeof dev.tzOffsetMin !== "number") continue;
          let targetUtcMin = localMin - dev.tzOffsetMin;
          targetUtcMin = ((targetUtcMin % 1440) + 1440) % 1440;
          const diff = Math.min(Math.abs(nowUtcMin - targetUtcMin), 1440 - Math.abs(nowUtcMin - targetUtcMin));
          if (diff > TOLERANCE_MIN) continue;
          try {
            await sendTo(dev.token, "Time to reflect", "Your questions are ready.");
            scheduledSent++;
          } catch (e) { console.error(`scheduled send failed for ${uid}/${dev.id}:`, e.message); }
        }
        await db.doc(`users/${uid}/state/lastPush`).set({ dateKey: todayKey, sentAt: now.toISOString() });
      }
    }

    // -- pass 2: hand-off fallback (only if not already consumed client-side) --
    if (handoffSnap.exists) {
      const h = handoffSnap.data();
      const requestedAt = h.requestedAt && h.requestedAt.toMillis ? h.requestedAt.toMillis() : 0;
      const ageMin = requestedAt ? (now.getTime() - requestedAt) / 60000 : Infinity;
      if (!h.consumed && ageMin <= HANDOFF_MAX_AGE_MIN) {
        const desktops = devices.filter((d) => d.kind === "desktop");
        for (const dev of desktops) {
          try {
            await sendTo(dev.token, "Continue your reflection", "Picking up where you left off.");
            handoffSent++;
          } catch (e) { console.error(`handoff send failed for ${uid}/${dev.id}:`, e.message); }
        }
        // mark handled either way (even zero desktops) so this doesn't retry forever
        await db.doc(`users/${uid}/state/handoff`).set({ consumed: true }, { merge: true });
      }
    }
  }

  console.log(`checked ${usersSnap.size} users — scheduled: ${scheduledSent}, handoff: ${handoffSent}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
