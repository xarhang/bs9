// @bun
var{serve:i}=globalThis.Bun;var e=[];i({port:process.env.PORT||3000,fetch(n){let t=new URL(n.url),r=n.method,s=t.pathname;if(e.push({method:r,route:s,timestamp:Date.now()}),e.length>100)e.splice(0,e.length-100);if(t.pathname==="/healthz")return new Response("ok");if(t.pathname==="/readyz")return new Response("ready");if(t.pathname==="/metrics"){let o=e.filter((p)=>Date.now()-p.timestamp<60000);return new Response(JSON.stringify({total_requests:e.length,recent_requests:o.length,uptime:process.uptime()},null,2),{headers:{"Content-Type":"application/json"}})}return new Response(`Hello from TypeScript BSN app!
Method: ${r}
Route: ${s}`)}});console.log("TypeScript app started");
