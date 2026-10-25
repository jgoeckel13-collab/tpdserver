const C='pd-shared-v6';
self.addEventListener('install',e=>{e.waitUntil(caches.open(C).then(c=>c.addAll(['./','index.html','manifest.webmanifest','icon-192.png','icon-512.png','vendor/pdf-lib.min.js','vendor/pdf.min.mjs','vendor/pdf.worker.min.mjs'])).then(()=>self.skipWaiting()))});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==C).map(x=>caches.delete(x)))).then(()=>self.clients.claim()))});
self.addEventListener('fetch',e=>{const r=e.request;if(r.method!=='GET'||new URL(r.url).origin!==location.origin)return;const pn=new URL(r.url).pathname;if(/\/api\//.test(pn)||/\/officer$/.test(pn))return;const off=/\/officer\//.test(pn);
 const p=fetch(r).then(n=>{if(n.ok){const cp=n.clone();caches.open(C).then(c=>c.put(r,cp))}return n});
 e.respondWith(Promise.race([p,new Promise((_,no)=>setTimeout(no,7000))]).catch(()=>caches.match(r).then(x=>x||(r.mode==='navigate'&&!off?caches.match('index.html'):Response.error()))))});
