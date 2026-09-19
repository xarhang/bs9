import { afterEach, describe, expect, it } from "bun:test";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, truncateSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("Log growth, rotation, and recovery", () => {
  const root = join(tmpdir(), `bs9-log-growth-${process.pid}`);
  const log = join(root, "service.out.log");

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("preserves every complete record during sustained multi-megabyte growth", () => {
    mkdirSync(root, { recursive: true });
    const fd = openSync(log, "w");
    const record = Buffer.from(`${"x".repeat(1014)}\n`);
    for (let i = 0; i < 16_384; i++) writeSync(fd, record);
    closeSync(fd);
    expect(statSync(log).size).toBe(record.length * 16_384);
  });

  it("continues writing after an external truncate", () => {
    mkdirSync(root, { recursive: true });
    writeFileSync(log, "before\n".repeat(10_000));
    truncateSync(log, 0);
    appendFileSync(log, "after-truncate\n");
    expect(readFileSync(log, "utf8")).toBe("after-truncate\n");
  });

  it("supports rename rotation while preserving the rotated generation", () => {
    mkdirSync(root, { recursive: true });
    writeFileSync(log, "generation-one\n");
    const rotated = `${log}.1`;
    renameSync(log, rotated);
    writeFileSync(log, "generation-two\n");
    expect(readFileSync(rotated, "utf8")).toBe("generation-one\n");
    expect(readFileSync(log, "utf8")).toBe("generation-two\n");
  });

  it("recreates a deleted active log path", () => {
    mkdirSync(root, { recursive: true });
    writeFileSync(log, "old\n");
    rmSync(log);
    appendFileSync(log, "recovered\n");
    expect(existsSync(log)).toBe(true);
    expect(readFileSync(log, "utf8")).toBe("recovered\n");
  });

  it("round-trips Unicode and embedded NUL output", () => {
    mkdirSync(root, { recursive: true });
    const payload = "ສະບາຍດີ 🌏 日本語\0tail\n".repeat(1_000);
    writeFileSync(log, payload);
    expect(readFileSync(log, "utf8")).toBe(payload);
  });

  it("keeps stdout and stderr growth isolated", () => {
    mkdirSync(root, { recursive: true });
    const err = join(root, "service.err.log");
    for (let i = 0; i < 2_000; i++) {
      appendFileSync(log, `out:${i}\n`);
      appendFileSync(err, `err:${i}\n`);
    }
    expect(readFileSync(log, "utf8")).not.toContain("err:");
    expect(readFileSync(err, "utf8")).not.toContain("out:");
  });
});
