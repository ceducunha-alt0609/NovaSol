const CACHE='novasol-v1.0-build501-pwa21';
const BASE='/NovaSol/';
const SHELL=[BASE,BASE+'index.html',BASE+'manifest.json',BASE+'firebase-config.js',BASE+'firebase-bridge.js',BASE+'icons/icon-192.png',BASE+'icons/icon-512.png'];

self.addEventListener('install',event=>{
  event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate',event=>{
  event.waitUntil(
    caches.keys().then(keys=>Promise.all(keys.filter(key=>key!==CACHE).map(key=>caches.delete(key))))
  );
  self.clients.claim();
});

self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET') return;
  event.respondWith(
    fetch(event.request).then(response=>{
      const copy=response.clone();
      caches.open(CACHE).then(cache=>cache.put(event.request,copy));
      return response;
    }).catch(()=>caches.match(event.request).then(cached=>cached||caches.match(BASE+'index.html')))
  );
});
