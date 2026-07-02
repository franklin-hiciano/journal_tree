// ── Intro video overlay (shown once on first entry, after auth) ──────────────────
// Set this to your Vimeo video ID when the video is ready:
const _INTRO_VIDEO_ID = '';   // e.g. '1204235305'
const _INTRO_KEY = 'rc_intro_seen';

window._dismissIntroVideo = function () {
  const ov = document.getElementById('introVideoOv');
  if (ov) ov.classList.remove('on');
  try { localStorage.setItem(_INTRO_KEY, '1'); } catch (e) {}
  // show the compound card next (existing flow)
  window._maybeShowCompoundCard && window._maybeShowCompoundCard();
};

window._maybeShowIntroVideo = function () {
  try { if (localStorage.getItem(_INTRO_KEY) === '1') { window._maybeShowCompoundCard && window._maybeShowCompoundCard(); return; } } catch (e) {}
  // don't show on top of auth / paywall
  const auth = document.getElementById('authScreen');
  if (auth && !auth.classList.contains('hidden')) return;
  const pw = document.getElementById('paywall');
  if (pw && pw.classList.contains('on')) return;
  const ov = document.getElementById('introVideoOv');
  if (!ov) return;
  // wire up the video iframe if we have an ID
  if (_INTRO_VIDEO_ID) {
    const ph = document.getElementById('introVideoPh');
    const fr = document.getElementById('introVideoFrame');
    if (ph) ph.style.display = 'none';
    if (fr) { fr.src = 'https://player.vimeo.com/video/' + _INTRO_VIDEO_ID + '?autoplay=1&title=0&byline=0&portrait=0&color=e0793f'; fr.style.display = ''; }
  }
  ov.classList.add('on');
  // tap backdrop to skip
  if (!ov._bound) {
    ov._bound = true;
    ov.addEventListener('click', e => { if (e.target === ov) window._dismissIntroVideo(); });
  }
};

// ── First-run teaching card: most forks don't matter, a few change everything ─────
// Shown once per browser, right after sign-in. The message: the tree's job is to help
// you tell low-leverage forks (barely move you) apart from high-leverage ones (change
// everything) — and to act on the latter while they're still open.
const _CC_KEY = 'rc_compound_seen';

window._dismissCompoundCard = function () {
  const card = document.getElementById('compoundCard');
  if (card) card.classList.remove('on');
  try { localStorage.setItem(_CC_KEY, '1'); } catch (e) {}
  // chain into the "make it a habit" install popup so the two never show at once
  window._maybeShowHabitPopup && window._maybeShowHabitPopup();
};

window._maybeShowCompoundCard = function () {
  try { if (localStorage.getItem(_CC_KEY) === '1') return; } catch (e) {}
  const card = document.getElementById('compoundCard');
  if (!card) return;
  // only over the app itself — never on top of the auth or paywall screens
  const auth = document.getElementById('authScreen');
  if (auth && !auth.classList.contains('hidden')) return;
  const pw = document.getElementById('paywall');
  if (pw && pw.classList.contains('on')) return;
  card.classList.add('on');
  if (!card._bound) {
    card._bound = true;
    // tap the backdrop to dismiss
    card.addEventListener('click', e => { if (e.target === card) window._dismissCompoundCard(); });
  }
};
