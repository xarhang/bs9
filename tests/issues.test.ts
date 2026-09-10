#!/usr/bin/env bun

/**
 * BS9 - Issues & Exception Tracker Unit Tests
 * 
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * Licensed under the MIT License
 */

import { describe, it, expect } from "bun:test";
import { parseErrorLogs, issuesCommand } from "../src/commands/issues.js";

describe("Issues & Exception Tracker", () => {
  it("should return empty array for empty log content", () => {
    expect(parseErrorLogs("", "my-app")).toEqual([]);
    expect(parseErrorLogs("   \n\n  ", "my-app")).toEqual([]);
  });

  it("should parse JavaScript/TypeScript TypeError with stack and file location", () => {
    const rawLog = `
2026-09-10 08:00:00 [INFO] Server started
TypeError: Cannot read properties of undefined (reading 'id')
    at handleRequest (src/server.ts:42:15)
    at dispatch (src/router.ts:88:5)
`;
    const issues = parseErrorLogs(rawLog, "api-service");
    expect(issues.length).toBe(1);
    expect(issues[0].service).toBe("api-service");
    expect(issues[0].errorType).toBe("TypeError");
    expect(issues[0].message).toBe("Cannot read properties of undefined (reading 'id')");
    expect(issues[0].fileLocation).toBe("src/server.ts:42:15");
    expect(issues[0].stackTrace.length).toBeGreaterThan(0);
    expect(issues[0].suggestedFix).toContain("Type error in code");
  });

  it("should provide actionable diagnostic hints for ECONNREFUSED", () => {
    const rawLog = `
Error: connect ECONNREFUSED 127.0.0.1:5432
    at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1494:16)
`;
    const issues = parseErrorLogs(rawLog, "db-service");
    expect(issues.length).toBe(1);
    expect(issues[0].suggestedFix).toContain("Database or remote service is unreachable");
  });

  it("should provide actionable diagnostic hints for EADDRINUSE", () => {
    const rawLog = `
Error: listen EADDRINUSE: address already in use :::3000
    at Server.setupListenHandle [as _listen2] (node:net:1740:14)
`;
    const issues = parseErrorLogs(rawLog, "web-app");
    expect(issues.length).toBe(1);
    expect(issues[0].suggestedFix).toContain("Port is already bound by another process");
  });

  it("should provide actionable diagnostic hints for missing module", () => {
    const rawLog = `
Error: Cannot find module 'lodash'
    at Function.Module._resolveFilename (node:internal/modules/cjs/loader:1077:15)
`;
    const issues = parseErrorLogs(rawLog, "worker-job");
    expect(issues.length).toBe(1);
    expect(issues[0].suggestedFix).toContain("bun install");
  });

  it("should parse Python Tracebacks with file and line", () => {
    const rawLog = `
Traceback (most recent call last):
  File "app/main.py", line 25, in <module>
    run_server()
  File "app/server.py", line 110, in run_server
    raise ValueError("Invalid configuration provided")
ValueError: Invalid configuration provided
`;
    const issues = parseErrorLogs(rawLog, "py-ml-service");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    const issue = issues[0];
    expect(issue.service).toBe("py-ml-service");
    expect(issue.fileLocation).toBe("app/main.py:25");
  });

  it("should parse Go panics", () => {
    const rawLog = `
2026/09/10 08:30:00 Starting Go service...
panic: runtime error: index out of range [5] with length 2

goroutine 1 [running]:
main.processItem(0x0, 0x5)
\t/home/user/go/src/app/main.go:34 +0x3f
`;
    const issues = parseErrorLogs(rawLog, "go-gateway");
    expect(issues.length).toBe(1);
    expect(issues[0].errorType).toBe("GoPanic");
    expect(issues[0].message).toContain("runtime error: index out of range");
  });

  it("should fallback to ProcessCrashLog if unstructured error logs exist", () => {
    const rawLog = `
Process terminated abruptly due to signal SIGSEGV
Segmentation fault (core dumped)
`;
    const issues = parseErrorLogs(rawLog, "native-service");
    expect(issues.length).toBe(1);
    expect(issues[0].errorType).toBe("ProcessCrashLog");
    expect(issues[0].message).toBe("Segmentation fault (core dumped)");
  });

  it("issuesCommand should execute without throwing", async () => {
    expect(typeof issuesCommand).toBe("function");
    // Verify running with json flag doesn't throw
    await expect(issuesCommand(undefined, { json: true })).resolves.toBeUndefined();
  });
});
