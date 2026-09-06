'use strict';
const VERSION='shandong-family-2026-e38eb04bfc82';
const CACHE_PREFIX='shandong-family-2026-';
const FILES=['./','index.html','0908.html','0909.html','0910.html','0911.html','0912.html','0913.html','credits.html','assets/trip.css','assets/trip.js','assets/favicon.svg','assets/qingdao.webp','assets/jinan.webp'];
const urls=FILES.map(path=>new URL(path,self.registration.scope).href);
self.addEventListener('install',event=>{
  event.waitUntil(caches.open(VERSION).then(async cache=>{
    // Prepare every requested page before marking this revision ready.
    const responses=await Promise.all(urls.map(async url=>{
      const response=await fetch(new Request(url,{cache:'reload',credentials:'same-origin'}));
      if(!response.ok || response.redirected || response.url!==url)throw new Error('Offline asset unavailable');
      return [url,response];
    }));
    await Promise.all(responses.map(([url,response])=>cache.put(url,response)));
  }));
});
self.addEventListener('activate',event=>{
  event.waitUntil((async()=>{
    const keys=await caches.keys();
    await Promise.all(keys.filter(k=>k.startsWith(CACHE_PREFIX)&&k!==VERSION).map(k=>caches.delete(k)));
    await self.clients.claim();
    const windows=await self.clients.matchAll({type:'window'});
    windows.forEach(client=>{if(client.url.startsWith(self.registration.scope))client.postMessage({type:'TRIP_OFFLINE_READY'});});
  })());
});
self.addEventListener('message',event=>{
  if(event.data?.type==='TRIP_CACHE_STATUS')event.waitUntil((async()=>{
    const cache=await caches.open(VERSION);
    const results=await Promise.all(urls.map(url=>cache.match(url)));
    if(results.every(Boolean)&&event.source)event.source.postMessage({type:'TRIP_OFFLINE_READY'});
  })());
});
self.addEventListener('fetch',event=>{
  const request=event.request,url=new URL(request.url);
  if(request.method!=='GET' || url.origin!==self.location.origin || !url.href.startsWith(self.registration.scope))return;
  const canonical=new URL(url.href);canonical.search='';canonical.hash='';
  if(!urls.includes(canonical.href))return;
  // Cache-first keeps HTML, CSS and JS on the same installed revision.
  event.respondWith((async()=>{
    const cache=await caches.open(VERSION),cached=await cache.match(canonical.href);
    return cached || fetch(request);
  })());
});
