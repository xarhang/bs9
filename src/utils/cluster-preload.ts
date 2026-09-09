/**
 * BS9 - Bun Native Cluster Preload Hook
 * Automatically injects `reusePort: true` into Bun.serve(...) when running in cluster mode.
 * 
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * Licensed under the MIT License
 */

if (process.env.BS9_REUSE_PORT === "true" && typeof Bun !== "undefined" && typeof Bun.serve === "function") {
  const originalServe = Bun.serve.bind(Bun);
  // @ts-ignore
  Bun.serve = function (options: any) {
    if (options && typeof options === "object") {
      if (options.reusePort === undefined) {
        options.reusePort = true;
      }
    }
    return originalServe(options);
  };
}