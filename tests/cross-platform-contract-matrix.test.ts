import { describe, expect, it } from "bun:test";
import { isValidServiceName as isValidWindowsServiceName } from "../src/windows/service.js";
import { isValidServiceName as isValidMacServiceName } from "../src/macos/launchd.js";
import { isValidServiceName as isValidDeleteTarget } from "../src/commands/delete.js";
import { isValidHost } from "../src/commands/start.js";
import { isValidVersion } from "../src/commands/update.js";
import { parseWorkerSlot } from "../src/utils/service-discovery.js";
import { escapeSystemdArg, escapeSystemdEnv, escapeSystemdValue } from "../src/utils/systemd.js";

// These deterministic matrices intentionally register each input as a separate
// logical test. A failure therefore identifies the exact contract and seed on
// every supported operating system instead of hiding hundreds of assertions in
// one loop.
describe("Cross-platform contract matrix", () => {
  describe("service names accepted consistently by every manager", () => {
    for (let seed = 0; seed < 300; seed++) {
      const name = `service_${seed}-worker.${seed % 17}`;
      it(`accepts valid service-name seed ${seed}`, () => {
        expect(isValidWindowsServiceName(name)).toBe(true);
        expect(isValidMacServiceName(name)).toBe(true);
        expect(isValidDeleteTarget(name)).toBe(true);
      });
    }
  });

  describe("service names rejected consistently by every manager", () => {
    const makeInvalidName = (seed: number): string => {
      switch (seed % 6) {
        case 0: return `service ${seed}`;
        case 1: return `service/${seed}`;
        case 2: return `service\\${seed}`;
        case 3: return `service..${seed}`;
        case 4: return `service;${seed}`;
        default: return `service-${"x".repeat(65 + (seed % 8))}`;
      }
    };

    for (let seed = 0; seed < 300; seed++) {
      const name = makeInvalidName(seed);
      it(`rejects unsafe service-name seed ${seed}`, () => {
        expect(isValidWindowsServiceName(name)).toBe(false);
        expect(isValidMacServiceName(name)).toBe(false);
        expect(isValidDeleteTarget(name)).toBe(false);
      });
    }
  });

  describe("physical worker names round-trip into logical slots", () => {
    for (let seed = 0; seed < 400; seed++) {
      const appName = `api-${seed % 23}`;
      const slot = seed;
      const generation = (seed % 97) + 1;
      const prefix = seed % 2 === 0 ? "BS9_" : "bs9.";
      const physicalName = `${appName}-${slot}-g${generation}`;

      it(`parses worker identity seed ${seed}`, () => {
        const parsed = parseWorkerSlot(`${prefix}${physicalName}`);
        expect(parsed).not.toBeNull();
        expect(parsed?.appName).toBe(appName);
        expect(parsed?.slot).toBe(slot);
        expect(parsed?.generation).toBe(generation);
        expect(parsed?.logicalSlot).toBe(`${appName}-${slot}`);
        expect(parsed?.physicalName).toBe(physicalName);
        expect(parsed?.hasGenerationSuffix).toBe(true);
      });
    }
  });

  describe("semantic versions accepted without shell metacharacters", () => {
    for (let seed = 0; seed < 300; seed++) {
      const version = `${seed}.${seed % 101}.${seed % 29}-${seed % 2 ? "rc" : "beta"}.${seed}`;
      it(`accepts safe semantic version seed ${seed}`, () => {
        expect(isValidVersion(version)).toBe(true);
        expect(isValidVersion(`${version};echo injected`)).toBe(false);
        expect(isValidVersion(`${version} && whoami`)).toBe(false);
      });
    }
  });

  describe("IPv4 hosts enforce every octet boundary", () => {
    for (let seed = 0; seed < 300; seed++) {
      const valid = `${seed % 256}.${(seed * 3) % 256}.${(seed * 7) % 256}.${(seed * 11) % 256}`;
      const invalid = `${256 + seed}.${seed % 256}.0.1`;
      it(`validates IPv4 boundary seed ${seed}`, () => {
        expect(isValidHost(valid)).toBe(true);
        expect(isValidHost(invalid)).toBe(false);
      });
    }
  });

  describe("systemd escaping prevents directive injection", () => {
    for (let seed = 0; seed < 400; seed++) {
      const raw = `value-${seed}\\segment\"quoted\nEnvironment=INJECTED_${seed}\rExecStart=/tmp/pwn`;
      it(`escapes systemd value seed ${seed}`, () => {
        const value = escapeSystemdValue(raw);
        const env = escapeSystemdEnv(`KEY-${seed}`, raw);
        const arg = escapeSystemdArg(raw);
        expect(value).not.toContain("\n");
        expect(value).not.toContain("\r");
        expect(value).toContain("\\\\segment");
        expect(value).toContain('\\"quoted');
        expect(env.startsWith(`Environment=\"KEY_${seed}=`)).toBe(true);
        expect(env.split("\n")).toHaveLength(1);
        expect(arg.startsWith('"')).toBe(true);
        expect(arg.endsWith('"')).toBe(true);
      });
    }
  });
});
