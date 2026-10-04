import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { isAllowedAdminOrigin } from "../src/loadbalancer/manager.js";

const priorPublicOrigin = process.env.LB_PUBLIC_ORIGIN;

describe("load balancer admin origin checks", () => {
  beforeEach(() => {
    process.env.LB_PUBLIC_ORIGIN = "https://lb.example.test";
  });

  afterEach(() => {
    if (priorPublicOrigin === undefined) delete process.env.LB_PUBLIC_ORIGIN;
    else process.env.LB_PUBLIC_ORIGIN = priorPublicOrigin;
  });

  it("allows an authenticated safe same-origin browser GET without Origin", () => {
    const request = new Request("https://lb.example.test/lb-config", {
      headers: {
        Host: "lb.example.test",
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-Mode": "cors",
        Authorization: "Bearer test-secret",
      },
    });

    expect(isAllowedAdminOrigin(request, true)).toBe(true);
  });

  it("rejects same-origin metadata when Host does not match the configured origin", () => {
    const request = new Request("https://lb.example.test/lb-config", {
      headers: {
        Host: "attacker.example.test",
        "Sec-Fetch-Site": "same-origin",
      },
    });

    expect(isAllowedAdminOrigin(request, true)).toBe(false);
  });

  it("rejects cross-site browser requests even when they have no Origin", () => {
    const request = new Request("https://lb.example.test/lb-config", {
      headers: {
        Host: "lb.example.test",
        "Sec-Fetch-Site": "cross-site",
      },
    });

    expect(isAllowedAdminOrigin(request, true)).toBe(false);
  });

  it("does not allow the missing-Origin exception for POST or without explicit opt-in", () => {
    const headers = { Host: "lb.example.test", "Sec-Fetch-Site": "same-origin" };
    expect(isAllowedAdminOrigin(new Request("https://lb.example.test/lb-config", { method: "POST", headers }), true)).toBe(false);
    expect(isAllowedAdminOrigin(new Request("https://lb.example.test/lb-config", { headers }), false)).toBe(false);
  });

  it("preserves non-browser loopback/CLI calls when no public origin is configured", () => {
    delete process.env.LB_PUBLIC_ORIGIN;
    expect(isAllowedAdminOrigin(new Request("http://127.0.0.1/lb-stats"))).toBe(true);
  });
});
