// Simple BS9-managed app example
import { serve } from "bun";

serve({
  port: process.env.PORT || 3000,
  fetch(req) {
    const url = new URL(req.url);
    
    if (url.pathname === "/") {
      return new Response("Hello from BS9-managed app!");
    }
    
    if (url.pathname === "/healthz") {
      return new Response("ok");
    }
    
    if (url.pathname === "/readyz") {
      return new Response("ready");
    }
    
    if (url.pathname === "/metrics") {
      return new Response(JSON.stringify({
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        timestamp: new Date().toISOString(),
        requests: Math.floor(Math.random() * 1000),
      }), {
        headers: { "Content-Type": "application/json" }
      });
    }
    
    return new Response("404 Not Found");
  },
});

console.log("Simple app started");
