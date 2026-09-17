import { describe, test, expect } from "bun:test";
import {
  encodeFrame,
  StreamingFrameDecoder,
  createEnvelope,
  generateNonce,
  computeHmac,
  verifyHmac,
  MAX_FRAME_SIZE,
  PROTOCOL_VERSION,
  type Bs9Envelope,
} from "../src/hub/protocol.js";

describe("Protocol Framing & Serialization", () => {
  test("should encode envelope with 4-byte big-endian length prefix", () => {
    const envelope = createEnvelope("TEST_EVENT", "my-app", { foo: "bar" });
    const frame = encodeFrame(envelope);

    expect(frame.length).toBeGreaterThan(4);
    const length = frame.readUInt32BE(0);
    expect(frame.length).toBe(4 + length);

    const payloadStr = frame.subarray(4).toString("utf-8");
    const parsed = JSON.parse(payloadStr);
    expect(parsed.type).toBe("TEST_EVENT");
    expect(parsed.namespace).toBe("my-app");
    expect(parsed.payload.foo).toBe("bar");
  });

  test("should decode a single complete frame", () => {
    const decoder = new StreamingFrameDecoder();
    const envelope = createEnvelope("TEST_EVENT", "my-app", { count: 42 });
    const frame = encodeFrame(envelope);

    const decoded = decoder.push(frame);
    expect(decoded.length).toBe(1);
    expect(decoded[0].type).toBe("TEST_EVENT");
    expect(decoded[0].payload).toEqual({ count: 42 });
    expect(decoder.pendingBytes).toBe(0);
  });

  test("should decode frame delivered across multiple fragmented chunks", () => {
    const decoder = new StreamingFrameDecoder();
    const envelope = createEnvelope("CHUNKED_EVENT", "test-ns", { text: "hello world" });
    const frame = encodeFrame(envelope);

    // Split frame into 3 parts
    const p1 = frame.subarray(0, 3); // partial length prefix
    const p2 = frame.subarray(3, 15); // rest of length prefix + partial payload
    const p3 = frame.subarray(15); // remainder of payload

    expect(decoder.push(p1)).toEqual([]);
    expect(decoder.pendingBytes).toBe(3);

    expect(decoder.push(p2)).toEqual([]);
    expect(decoder.pendingBytes).toBe(15);

    const result = decoder.push(p3);
    expect(result.length).toBe(1);
    expect(result[0].type).toBe("CHUNKED_EVENT");
    expect(result[0].payload).toEqual({ text: "hello world" });
    expect(decoder.pendingBytes).toBe(0);
  });

  test("should decode multiple frames delivered in a single buffer", () => {
    const decoder = new StreamingFrameDecoder();
    const env1 = createEnvelope("EVENT_1", "ns1", { id: 1 });
    const env2 = createEnvelope("EVENT_2", "ns1", { id: 2 });
    const combined = Buffer.concat([encodeFrame(env1), encodeFrame(env2)]);

    const decoded = decoder.push(combined);
    expect(decoded.length).toBe(2);
    expect(decoded[0].type).toBe("EVENT_1");
    expect(decoded[1].type).toBe("EVENT_2");
    expect(decoder.pendingBytes).toBe(0);
  });

  test("should reject frame exceeding MAX_FRAME_SIZE during decoding", () => {
    const decoder = new StreamingFrameDecoder();
    const header = Buffer.alloc(4);
    header.writeUInt32BE(MAX_FRAME_SIZE + 1, 0);

    expect(() => decoder.push(header)).toThrow(/exceeds maximum limit/);
  });
});

describe("Nonce & HMAC Authentication", () => {
  test("should generate 32-byte hex nonce", () => {
    const nonce = generateNonce();
    expect(typeof nonce).toBe("string");
    expect(nonce.length).toBe(64); // 32 bytes hex = 64 chars
  });

  test("should compute and verify valid HMAC", () => {
    const token = "super-secret-cluster-token-123";
    const nonce = generateNonce();
    const hmac = computeHmac(nonce, token);

    expect(verifyHmac(nonce, token, hmac)).toBe(true);
  });

  test("should reject incorrect token HMAC", () => {
    const token1 = "token-1";
    const token2 = "token-2";
    const nonce = generateNonce();
    const hmac1 = computeHmac(nonce, token1);

    expect(verifyHmac(nonce, token2, hmac1)).toBe(false);
  });

  test("should reject tampered nonce HMAC", () => {
    const token = "my-token";
    const nonce1 = generateNonce();
    const nonce2 = generateNonce();
    const hmac = computeHmac(nonce1, token);

    expect(verifyHmac(nonce2, token, hmac)).toBe(false);
  });
});
