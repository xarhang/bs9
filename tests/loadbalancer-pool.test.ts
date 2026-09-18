import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { DatabasePool } from "../src/database/pool.js";
import { buildOutboundHeaders, sanitizeHeaders } from "../src/loadbalancer/manager.js";

describe("DatabasePool & LoadBalancer Security and Resilience QA Suite", () => {
  describe("DatabasePool Security & Validation", () => {
    it("rejects invalid hosts with security errors", () => {
      expect(() => {
        new DatabasePool({
          host: "invalid host with spaces; rm -rf",
          port: 5432,
          database: "valid_db",
          username: "valid_user",
          password: "password",
          mock: true
        });
      }).toThrow(/Invalid database host/);
    });

    it("rejects invalid database names with path traversal or punctuation", () => {
      expect(() => {
        new DatabasePool({
          host: "localhost",
          port: 5432,
          database: "../../etc/shadow",
          username: "valid_user",
          password: "password",
          mock: true
        });
      }).toThrow(/Invalid database name/);
    });

    it("rejects invalid usernames with malicious characters", () => {
      expect(() => {
        new DatabasePool({
          host: "127.0.0.1",
          port: 5432,
          database: "mydb",
          username: "admin' OR 1=1 --",
          password: "password",
          mock: true
        });
      }).toThrow(/Invalid database username/);
    });

    it("rejects dangerous SQL queries with SQL injection patterns", async () => {
      const pool = new DatabasePool({
        host: "localhost",
        port: 5432,
        database: "test_db",
        username: "test_user",
        password: "secret",
        mock: true,
      });

      const conn = await pool.acquire();
      expect(conn).toBeDefined();

      // Attempt dangerous SQL injections
      await expect(conn.query("DROP TABLE users;")).rejects.toThrow(/Dangerous SQL pattern detected/);
      await expect(conn.query("SELECT * FROM test UNION SELECT 1, 2, 3;")).rejects.toThrow(/Dangerous SQL pattern detected/);
      await expect(conn.query("EXEC xp_cmdshell('whoami');")).rejects.toThrow(/Dangerous SQL pattern detected/);

      await pool.release(conn);
      await pool.close();
    });

    it("handles connection checkout, release, and queue timeout", async () => {
      const pool = new DatabasePool({
        host: "localhost",
        port: 5432,
        database: "test_db",
        username: "test_user",
        password: "secret",
        mock: true,
        maxConnections: 2,
        acquireTimeoutMillis: 50,
      });

      const c1 = await pool.acquire();
      const c2 = await pool.acquire();

      const stats = pool.getStats();
      expect(stats.activeConnections).toBe(2);

      // Third acquire should timeout because maxConnections = 2 and timeout = 50ms
      await expect(pool.acquire()).rejects.toThrow(/Connection acquire timeout/);

      // Release one connection and acquire again
      await pool.release(c1);
      const c3 = await pool.acquire();
      expect(c3).toBeDefined();

      await pool.release(c2);
      await pool.release(c3);
      await pool.close();
    });
  });

  describe("LoadBalancer Header Sanitization & Proxy Security", () => {
    const dummyBackend = {
      id: "127.0.0.1:3000",
      host: "127.0.0.1",
      port: 3000,
      connections: 0,
      healthy: true,
      lastHealthCheck: Date.now(),
      responseTime: 10,
    };

    it("strips hop-by-hop headers from outbound requests", () => {
      const inHeaders = new Headers();
      inHeaders.set("Connection", "keep-alive");
      inHeaders.set("Keep-Alive", "timeout=5");
      inHeaders.set("Upgrade", "websocket");
      inHeaders.set("Transfer-Encoding", "chunked");
      inHeaders.set("X-Custom-Header", "allowed-value");

      const outbound = buildOutboundHeaders(inHeaders, dummyBackend, "192.168.1.100");

      expect(outbound.has("connection")).toBe(false);
      expect(outbound.has("keep-alive")).toBe(false);
      expect(outbound.has("upgrade")).toBe(false);
      expect(outbound.has("transfer-encoding")).toBe(false);
      expect(outbound.get("x-custom-header")).toBe("allowed-value");
      expect(outbound.get("x-forwarded-for")).toBe("192.168.1.100");
    });

    it("neutralizes CRLF header injection in headers", () => {
      const raw = {
        "X-Exploit": "injected\r\nSet-Cookie: evil=1\r\n",
        "Valid-Header": "safe-value"
      };

      const sanitized = sanitizeHeaders(raw);
      expect(sanitized["X-Exploit"]).toBeDefined();
      expect(sanitized["X-Exploit"]).not.toContain("\r");
      expect(sanitized["X-Exploit"]).not.toContain("\n");
      expect(sanitized["X-Exploit"]).toBe("injectedSet-Cookie: evil=1");
    });

    it("sanitizes headers dictionary removing hop-by-hop fields", () => {
      const raw = {
        "Host": "example.com",
        "Connection": "close",
        "Keep-Alive": "max=100",
        "Content-Type": "application/json",
      };

      const sanitized = sanitizeHeaders(raw);
      expect(sanitized["Connection"]).toBeUndefined();
      expect(sanitized["Keep-Alive"]).toBeUndefined();
      expect(sanitized["Content-Type"]).toBe("application/json");
    });
  });
});
