'use strict';
const VERSION='shandong-trip-v1-5-20260906-b';
const FILES=['./','index.html','0908.html','0909.html','0910.html','0911.html','0912.html','0913.html','assets/v1-enhance.css','assets/v1-enhance.js'];
self.addEventListener('install',e=>e.waitUntil(caches.open(VERSION).then(c=>c.addAll(FILES)).then(()=>self.skipWaiting())));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('shandong-trip-v1-')&&k!==VERSION).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',e=>{
 if(e.request.method!=='GET')return;
 const u=new URL(e.request.url);
 if(u.origin!==location.origin||!u.pathname.includes('/shandong-trip-2026/'))return;
 const isHtml=e.request.mode==='navigate'||u.pathname.endsWith('.html')||u.pathname.endsWith('/shandong-trip-2026/');
 if(isHtml){
   e.respondWith(fetch(e.request).then(r=>{const cp=r.clone();caches.open(VERSION).then(c=>c.put(e.request,cp));return r}).catch(()=>caches.match(e.request).then(c=>c||caches.match('./'))));
 }else{
   e.respondWith(caches.match(e.request).then(c=>c||fetch(e.request).then(r=>{const cp=r.clone();caches.open(VERSION).then(cache=>cache.put(e.request,cp));return r})));
 }
});