import { describe, expect, it, afterEach } from "vitest";
import { TraceSigningManager, extractJwtSignature } from "../services/trace-signing.js";
import {
  buildCanonicalPayload,
  hrTimeToNanosString,
} from "@paperclipai/shared/telemetry/signing-span-processor.js";
import {
  verifySpanSignature,
  extractVerificationInput,
} from "../services/trace-verification.js";
import { AUDIT_ATTR } from "@paperclipai/shared/telemetry/audit-types.js";

describe("TraceSigningManager", () => {
  const salt = "test-signing-salt-for-unit-tests";
  let manager: TraceSigningManager;

  afterEach(() => {
    // Ensure no keys leak between tests
    manager?.clearRunKey("run-1");
    manager?.clearRunKey("run-2");
  });

  it("derives deterministic keypairs from the same JWT signature", () => {
    manager = new TraceSigningManager(salt);
    const jwtSig = "dGVzdC1zaWduYXR1cmUtYmFzZTY0dXJs"; // base64url test value

    manager.deriveRunKeyPair("run-1", jwtSig);
    const pubKey1 = manager.getPublicKeyPem("run-1");

    // Derive again with a fresh manager — same salt + sig = same key
    const manager2 = new TraceSigningManager(salt);
    manager2.deriveRunKeyPair("run-1", jwtSig);
    const pubKey2 = manager2.getPublicKeyPem("run-1");

    expect(pubKey1).toBeTruthy();
    expect(pubKey1).toBe(pubKey2);

    manager2.clearRunKey("run-1");
  });

  it("derives different keypairs for different JWT signatures", () => {
    manager = new TraceSigningManager(salt);

    manager.deriveRunKeyPair("run-1", "sig-aaa");
    manager.deriveRunKeyPair("run-2", "sig-bbb");

    const pubKey1 = manager.getPublicKeyPem("run-1");
    const pubKey2 = manager.getPublicKeyPem("run-2");

    expect(pubKey1).toBeTruthy();
    expect(pubKey2).toBeTruthy();
    expect(pubKey1).not.toBe(pubKey2);
  });

  it("derives different keypairs for different salts", () => {
    const manager1 = new TraceSigningManager("salt-a");
    const manager2 = new TraceSigningManager("salt-b");
    const jwtSig = "same-signature";

    manager1.deriveRunKeyPair("run-1", jwtSig);
    manager2.deriveRunKeyPair("run-1", jwtSig);

    expect(manager1.getPublicKeyPem("run-1")).not.toBe(
      manager2.getPublicKeyPem("run-1"),
    );

    manager1.clearRunKey("run-1");
    manager2.clearRunKey("run-1");
  });

  it("signs and verifies a payload successfully", () => {
    manager = new TraceSigningManager(salt);
    manager.deriveRunKeyPair("run-1", "test-jwt-sig");

    const payload = buildCanonicalPayload(
      "abc123def456abc123def456abc12345",
      "1234567890abcdef",
      "agent-1",
      "run-1",
      "1700000000000000000",
      "heartbeat.execute",
      "issue/PAX-100",
      "success",
    );

    const signature = manager.sign("run-1", payload);
    expect(signature).toBeTruthy();

    const sigBuf = Buffer.from(signature!, "base64");
    expect(manager.verify("run-1", payload, sigBuf)).toBe(true);
  });

  it("rejects tampered payloads", () => {
    manager = new TraceSigningManager(salt);
    manager.deriveRunKeyPair("run-1", "test-jwt-sig");

    const payload = buildCanonicalPayload(
      "abc123def456abc123def456abc12345",
      "1234567890abcdef",
      "agent-1",
      "run-1",
      "1700000000000000000",
      "heartbeat.execute",
      "issue/PAX-100",
      "success",
    );

    const signature = manager.sign("run-1", payload);
    expect(signature).toBeTruthy();

    // Tamper with the payload
    const tampered = buildCanonicalPayload(
      "abc123def456abc123def456abc12345",
      "1234567890abcdef",
      "agent-1",
      "run-1",
      "1700000000000000000",
      "heartbeat.execute",
      "issue/PAX-100",
      "failure", // changed from "success"
    );

    const sigBuf = Buffer.from(signature!, "base64");
    expect(manager.verify("run-1", tampered, sigBuf)).toBe(false);
  });

  it("returns null when signing with unknown run ID", () => {
    manager = new TraceSigningManager(salt);
    const payload = Buffer.from("test");

    expect(manager.sign("unknown-run", payload)).toBeNull();
  });

  it("returns false when verifying with unknown run ID", () => {
    manager = new TraceSigningManager(salt);
    expect(
      manager.verify("unknown-run", Buffer.from("test"), Buffer.from("sig")),
    ).toBe(false);
  });

  it("clears key material and prevents subsequent signing", () => {
    manager = new TraceSigningManager(salt);
    manager.deriveRunKeyPair("run-1", "test-sig");

    expect(manager.hasKey("run-1")).toBe(true);
    manager.clearRunKey("run-1");
    expect(manager.hasKey("run-1")).toBe(false);
    expect(manager.sign("run-1", Buffer.from("test"))).toBeNull();
    expect(manager.getPublicKeyPem("run-1")).toBeNull();
  });

  it("is idempotent on deriveRunKeyPair", () => {
    manager = new TraceSigningManager(salt);
    manager.deriveRunKeyPair("run-1", "test-sig");
    const key1 = manager.getPublicKeyPem("run-1");

    // Calling again with same run ID should not change the key
    manager.deriveRunKeyPair("run-1", "different-sig");
    const key2 = manager.getPublicKeyPem("run-1");

    expect(key1).toBe(key2);
  });
});

describe("extractJwtSignature", () => {
  it("extracts the third segment of a JWT", () => {
    const jwt = "header.payload.thesignature";
    expect(extractJwtSignature(jwt)).toBe("thesignature");
  });

  it("returns null for malformed JWTs", () => {
    expect(extractJwtSignature("notajwt")).toBeNull();
    expect(extractJwtSignature("only.two")).toBeNull();
    expect(extractJwtSignature("")).toBeNull();
  });
});

describe("buildCanonicalPayload", () => {
  it("produces deterministic pipe-delimited output", () => {
    const payload = buildCanonicalPayload(
      "trace1",
      "span1",
      "agent1",
      "run1",
      "1700000000000000000",
      "heartbeat.execute",
      "resource",
      "success",
    );

    expect(payload.toString("utf8")).toBe(
      "trace1|span1|agent1|run1|1700000000000000000|heartbeat.execute|resource|success",
    );
  });

  it("handles empty fields correctly", () => {
    const payload = buildCanonicalPayload("t", "s", "", "r", "0", "", "", "");
    expect(payload.toString("utf8")).toBe("t|s||r|0|||");
  });
});

describe("hrTimeToNanosString", () => {
  it("converts [seconds, nanos] to padded nanosecond string", () => {
    expect(hrTimeToNanosString([1700000000, 123456789])).toBe(
      "1700000000123456789",
    );
  });

  it("pads nanoseconds to 9 digits", () => {
    expect(hrTimeToNanosString([1700000000, 1])).toBe(
      "1700000000000000001",
    );
  });

  it("handles zero correctly", () => {
    expect(hrTimeToNanosString([0, 0])).toBe("0000000000");
  });
});

describe("verifySpanSignature (end-to-end)", () => {
  it("verifies a signature produced by TraceSigningManager", () => {
    const manager = new TraceSigningManager("e2e-salt");
    manager.deriveRunKeyPair("run-e2e", "jwt-sig-e2e");

    const pubKeyPem = manager.getPublicKeyPem("run-e2e")!;

    const payload = buildCanonicalPayload(
      "aaaabbbbccccddddeeeeffffaaaabbbb",
      "1122334455667788",
      "agent-e2e",
      "run-e2e",
      "1700000000500000000",
      "data.file_write",
      "/src/index.ts",
      "success",
    );

    const signature = manager.sign("run-e2e", payload)!;

    const result = verifySpanSignature(
      {
        traceId: "aaaabbbbccccddddeeeeffffaaaabbbb",
        spanId: "1122334455667788",
        agentId: "agent-e2e",
        runId: "run-e2e",
        startTime: [1700000000, 500000000],
        actionType: "data.file_write",
        targetResource: "/src/index.ts",
        outcome: "success",
        signature,
      },
      pubKeyPem,
    );

    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();

    manager.clearRunKey("run-e2e");
  });

  it("rejects with wrong public key", () => {
    const manager1 = new TraceSigningManager("salt-1");
    const manager2 = new TraceSigningManager("salt-2");
    manager1.deriveRunKeyPair("run-1", "sig");
    manager2.deriveRunKeyPair("run-1", "sig");

    const payload = buildCanonicalPayload(
      "trace", "span", "agent", "run-1", "0", "type", "res", "ok",
    );

    const signature = manager1.sign("run-1", payload)!;
    const wrongPubKey = manager2.getPublicKeyPem("run-1")!;

    const result = verifySpanSignature(
      {
        traceId: "trace",
        spanId: "span",
        agentId: "agent",
        runId: "run-1",
        startTime: [0, 0],
        actionType: "type",
        targetResource: "res",
        outcome: "ok",
        signature,
      },
      wrongPubKey,
    );

    expect(result.valid).toBe(false);

    manager1.clearRunKey("run-1");
    manager2.clearRunKey("run-1");
  });
});

describe("extractVerificationInput", () => {
  it("extracts fields from span attributes", () => {
    const attrs = {
      [AUDIT_ATTR.RUN_ID]: "run-1",
      [AUDIT_ATTR.AGENT_ID]: "agent-1",
      [AUDIT_ATTR.ACTION_TYPE]: "heartbeat.execute",
      [AUDIT_ATTR.TARGET_RESOURCE]: "issue/PAX-1",
      [AUDIT_ATTR.OUTCOME]: "success",
      [AUDIT_ATTR.SPAN_SIGNATURE]: "c2lnbmF0dXJl",
    };

    const input = extractVerificationInput(
      "trace-id",
      "span-id",
      [1700000000, 0],
      attrs,
    );

    expect(input).toEqual({
      traceId: "trace-id",
      spanId: "span-id",
      agentId: "agent-1",
      runId: "run-1",
      startTime: [1700000000, 0],
      actionType: "heartbeat.execute",
      targetResource: "issue/PAX-1",
      outcome: "success",
      signature: "c2lnbmF0dXJl",
    });
  });

  it("returns null when signature is missing", () => {
    const attrs = { [AUDIT_ATTR.RUN_ID]: "run-1" };
    expect(
      extractVerificationInput("t", "s", [0, 0], attrs),
    ).toBeNull();
  });

  it("returns null when run_id is missing", () => {
    const attrs = { [AUDIT_ATTR.SPAN_SIGNATURE]: "sig" };
    expect(
      extractVerificationInput("t", "s", [0, 0], attrs),
    ).toBeNull();
  });
});
