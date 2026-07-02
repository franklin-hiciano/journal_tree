// ── Help overlay: "How to design a good reality check" ─────────────────────────────
// Paste the ID from your Loom share link (loom.com/share/<id>) here when the video is
// ready — same placeholder pattern as the intro video in onboarding.js.
const _HELP_LOOM_ID = ""; // e.g. '3b6b2b1e9e6b4c2c8f0a7d4e2b9c1a3d'

window._openHelpOv = function () {
  const ov = document.getElementById("helpOv");
  if (!ov) return;
  if (_HELP_LOOM_ID) {
    const ph = document.getElementById("helpVideoPh");
    const fr = document.getElementById("helpVideoFrame");
    if (ph) ph.style.display = "none";
    if (fr) {
      fr.src = "https://www.loom.com/embed/" + _HELP_LOOM_ID;
      fr.style.display = "";
    }
  }
  ov.classList.add("on");
  if (!ov._bound) {
    ov._bound = true;
    ov.addEventListener("click", (e) => {
      if (e.target === ov) window._closeHelpOv();
    });
  }
};

window._closeHelpOv = function () {
  const ov = document.getElementById("helpOv");
  if (ov) ov.classList.remove("on");
  const fr = document.getElementById("helpVideoFrame");
  if (fr) {
    fr.src = ""; // stop playback
    fr.style.display = "none";
  }
  const ph = document.getElementById("helpVideoPh");
  if (ph) ph.style.display = "";
};

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") window._closeHelpOv();
});
