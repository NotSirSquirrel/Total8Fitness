const V='tw-shell-v2',CDN='tw-cdn';
const HOSTS=/^(cdn\.jsdelivr\.net|tessdata\.projectnaptha\.com|fonts\.googleapis\.com|fonts\.gstatic\.com)$/;
self.addEventListener('install',e=>{e.waitUntil(caches.open(V).then(c=>c.addAll(['./','index.html','manifest.webmanifest'])).then(()=>self.skipWaiting()));});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==V&&x!==CDN).map(x=>caches.delete(x)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',e=>{
  const r=e.request,u=new URL(r.url);if(r.method!=='GET')return;
  if(u.origin===location.origin){
    if(u.pathname.includes('/data/'))return;
    e.respondWith(fetch(r).then(x=>{const c=x.clone();caches.open(V).then(h=>h.put(r,c));return x;}).catch(()=>caches.match(r,{ignoreSearch:true})));
  }else if(HOSTS.test(u.hostname)){
    e.respondWith(caches.open(CDN).then(async c=>{const h=await c.match(r);if(h)return h;const x=await fetch(r);c.put(r,x.clone());return x;}));
  }
});
