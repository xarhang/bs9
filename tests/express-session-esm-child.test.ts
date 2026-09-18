import { describe, it, expect, afterEach } from "bun:test";
import { spawn } from "node:child_process";
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HubServer } from "../src/hub/server.js";
import { HubClient } from "../src/hub/client.js";
import { getPlatformInfo } from "../src/platform/detect.js";

describe("ESM Child-Process Zero-Code express-session Interception", () => {
  let hubServer: HubServer | null = null;
  let hubClient: HubClient | null = null;
  let childProcess: any = null;

  const testId = Date.now();
  const platformInfo = getPlatformInfo();
  const hubSocket = platformInfo.isWindows
    ? `\\\\.\\pipe\\bs9-test-esm-hub-${testId}`
    : join(platformInfo.runtimeDir, `esm-hub-${testId}.sock`);

  const port = 48500 + Math.floor(Math.random() * 800);
  const esmAppFile = join(process.cwd(), `.tmp-esm-session-app-${testId}.mjs`);

  afterEach(async () => {
    if (childProcess) {
      try {
        childProcess.kill("SIGKILL");
      } catch {}
      childProcess = null;
    }
    if (hubClient) {
      hubClient.disconnect();
      hubClient = null;
    }
    if (hubServer) {
      await hubServer.stop();
      hubServer = null;
    }
    try { unlinkSync(esmAppFile); } catch {}
  });

  it("should transparently intercept ESM import session from 'express-session' in a real child process without user code changes", async () => {
    // 1. Start BS9 State Hub Server
    hubServer = new HubServer({
      socketPath: hubSocket,
    });
    const { token } = hubServer.registerNamespaceToken("esm-session-test");
    await hubServer.start();

    hubClient = new HubClient({
      socketPath: hubSocket,
      namespace: "esm-session-test",
      authToken: token,
    });
    await hubClient.connect();

    // 2. Create pure ESM application file using `import session from "express-session"`
    // Notice: ZERO references to BS9, ZERO store configuration!
    const esmSource = `
      import http from "node:http";
      import session from "express-session";

      const sessionMiddleware = session({
        secret: "bs9-esm-secret-key",
        resave: false,
        saveUninitialized: false,
        cookie: { maxAge: 3600000 },
      });

      const server = http.createServer((req, res) => {
        sessionMiddleware(req, res, () => {
          const url = new URL(req.url, "http://localhost:" + process.env.PORT);

          if (url.pathname === "/login") {
            req.session.userId = "user_esm_99";
            req.session.authenticatedAt = 123456789;
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: true, userId: req.session.userId }));
            return;
          }

          if (url.pathname === "/profile") {
            if (!req.session.userId) {
              res.writeHead(401, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "unauthorized" }));
              return;
            }
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              userId: req.session.userId,
              authenticatedAt: req.session.authenticatedAt
            }));
            return;
          }

          res.writeHead(404);
          res.end();
        });
      });

      server.listen(parseInt(process.env.PORT, 10), () => {
        console.log("ESM_SERVER_LISTENING_PORT_" + process.env.PORT);
      });
    `;

    writeFileSync(esmAppFile, esmSource, "utf-8");

    // 3. Spawn real child process executing the .mjs ESM file with BS9 cluster preload
    const preloadPath = join(process.cwd(), "src", "utils", "cluster-preload.ts");

    childProcess = spawn(
      process.execPath,
      ["--preload", preloadPath, esmAppFile],
      {
        cwd: process.cwd(),
        stdio: ["ignore", "pipe", "inherit"],
        env: {
          ...process.env,
          BS9_CLUSTER: "true",
          BS9_CLUSTER_NAME: "esm-session-test",
          BS9_HUB_SOCKET: hubSocket,
          BS9_AUTH_TOKEN: token,
          PORT: String(port),
        },
        windowsHide: true,
      }
    );

    childProcess.stdout.pipe(process.stdout);

    // Wait for child process to be ready
    const readyPromise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timeout waiting for child to start")), 5000);
      childProcess.stdout.on("data", (chunk: Buffer) => {
        if (chunk.toString().includes("ESM_SERVER_LISTENING_PORT_")) {
          clearTimeout(timeout);
          resolve();
        }
      });
    });

    await readyPromise;

    // 4. Request 1: Login and establish session
    const loginRes = await fetch(`http://localhost:${port}/login`);
    expect(loginRes.status).toBe(200);
    const loginData = (await loginRes.json()) as any;
    expect(loginData.success).toBe(true);
    expect(loginData.userId).toBe("user_esm_99");

    // Extract cookie from response
    const setCookie = loginRes.headers.get("set-cookie");
    expect(setCookie).not.toBeNull();
    const sidMatch = setCookie!.match(/connect\.sid=([^;]+)/);
    expect(sidMatch).not.toBeNull();
    const rawSidCookie = sidMatch![0]; // e.g. "connect.sid=s%3A..."

    // Parse session ID from signed cookie
    // Format: connect.sid=s:<sid>.<signature>
    const decodedVal = decodeURIComponent(sidMatch![1]);
    const cleanSid = decodedVal.startsWith("s:")
      ? decodedVal.slice(2).split(".")[0]
      : decodedVal;

    // 5. Verify the session was automatically persisted into BS9 State Hub KV Engine!
    // Standard express-session key prefix is "sess:"
    const hubSession = await hubClient.get<any>(`sess:${cleanSid}`);
    expect(hubSession).not.toBeNull();
    expect(hubSession.userId).toBe("user_esm_99");
    expect(hubSession.authenticatedAt).toBe(123456789);

    // 6. Request 2: Access profile using the cookie, verifying retrieval from State Hub
    const profileRes = await fetch(`http://localhost:${port}/profile`, {
      headers: {
        Cookie: rawSidCookie,
      },
    });
    expect(profileRes.status).toBe(200);
    const profileData = (await profileRes.json()) as any;
    expect(profileData.userId).toBe("user_esm_99");
    expect(profileData.authenticatedAt).toBe(123456789);
  });
});