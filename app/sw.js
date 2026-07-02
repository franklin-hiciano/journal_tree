// Service worker: lets reminder notifications carry a real action button and reports
// back to the page when the user taps "Yes" (or the notification body) so we can confirm.
//
// v2 — deliberately does NOT cache anything. An earlier version of this file precached
// the app shell (including style.css), and that cache is exactly what made CSS/JS edits
// look like they "weren't loading" — the service worker kept serving the old cached
// copies straight past new deploys. skipWaiting()+clients.claim() take over immediately,
// and this activate handler nukes every cache this origin has ever created (including
// that old 'rc-shell-v1' bucket), so once this version installs once, it self-heals.
// The fetch handler is a pure passthrough — every request always goes to the network.
// (Some browsers still want to see a fetch handler at all to consider the app
// installable, which is the only reason it exists.)
self.addEventListener('install', e => {
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil(Promise.all([
    self.clients.claim(),
    caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k)))),
  ]));
});

self.addEventListener('fetch', e => {
  e.respondWith(fetch(e.request));
});

self.addEventListener('notificationclick',e=>{
  e.notification.close();
  e.waitUntil((async()=>{
    const cs=await self.clients.matchAll({type:'window',includeUncontrolled:true});
    for(const c of cs)c.postMessage({type:'notif-confirmed',action:e.action||'body'});
    if(cs[0]&&'focus'in cs[0]){try{await cs[0].focus();}catch(_){}}
  })());
});
