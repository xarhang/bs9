// TypeScript example for BSN
import { serve } from "bun";

interface RequestMetrics {
  method: string;
  route: string;
  timestamp: number;
}

const metrics: RequestMetrics[] = [];

serve({
  port: process.env.PORT || 3000,
  fetch(req) {
    const url = new URL(req.url);
    const method = req.method;
    const route = url.pathname;
    
    // Record metrics
    metrics.push({
      method,
      route,
      timestamp: Date.now(),
    });
    
    // Keep only last 100 metrics
    if (metrics.length > 100) {
      metrics.splice(0, metrics.length - 100);
    }
    
    if (url.pathname === "/healthz") {
      return new Response("ok");
    }
    
    if (url.pathname === "/readyz") {
      return new Response("ready");
    }
    
    if (url.pathname === "/metrics") {
      const recentMetrics = metrics.filter(m => Date.now() - m.timestamp < 60000);
      return new Response(JSON.stringify({
        total_requests: metrics.length,
        recent_requests: recentMetrics.length,
        uptime: process.uptime(),
      }, null, 2), {
        headers: { "Content-Type": "application/json" }
      });
    }
    
    return new Response(`Hello from TypeScript BSN app!\nMethod: ${method}\nRoute: ${route}`);
  },
});

console.log("TypeScript app started");
