/**
 * Unit tests for the Merkle tree integrity module.
 * Tests the core computation logic (no DB required).
 */

import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { computeLeafHash, computeMerkleRoot } from "../services/merkle-integrity.js";

function sha256(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

describe("computeLeafHash", () => {
  it("produces deterministic hashes for the same inputs", () => {
    const h1 = computeLeafHash("trace1", "span1", "agent1", "run1", "1000000000000", "heartbeat.start", "/api", "success");
    const h2 = computeLeafHash("trace1", "span1", "agent1", "run1", "1000000000000", "heartbeat.start", "/api", "success");
    expect(h1).toBe(h2);
  });

  it("produces different hashes for different inputs", () => {
    const h1 = computeLeafHash("trace1", "span1", "agent1", "run1", "1000000000000", "heartbeat.start", "/api", "success");
    const h2 = computeLeafHash("trace2", "span1", "agent1", "run1", "1000000000000", "heartbeat.start", "/api", "success");
    expect(h1).not.toBe(h2);
  });

  it("includes the signature in the hash when provided", () => {
    const withoutSig = computeLeafHash("trace1", "span1", "agent1", "run1", "1000000000000", "heartbeat.start", "/api", "success");
    const withSig = computeLeafHash("trace1", "span1", "agent1", "run1", "1000000000000", "heartbeat.start", "/api", "success", "base64sig==");
    expect(withoutSig).not.toBe(withSig);
  });

  it("returns a 64-character hex string (SHA-256)", () => {
    const hash = computeLeafHash("trace1", "span1", "agent1", "run1", "1000000000000", "heartbeat.start", "/api", "success");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("computeMerkleRoot", () => {
  it("returns a well-known hash for empty input", () => {
    const root = computeMerkleRoot([]);
    expect(root).toBe(sha256("EMPTY_MERKLE_TREE"));
  });

  it("returns the leaf itself for a single leaf", () => {
    const leaf = sha256("leaf0");
    const root = computeMerkleRoot([leaf]);
    expect(root).toBe(leaf);
  });

  it("hashes two leaves correctly", () => {
    const leaf0 = sha256("leaf0");
    const leaf1 = sha256("leaf1");
    const root = computeMerkleRoot([leaf0, leaf1]);
    expect(root).toBe(sha256(leaf0 + leaf1));
  });

  it("handles odd number of leaves by promoting the last one", () => {
    const leaf0 = sha256("leaf0");
    const leaf1 = sha256("leaf1");
    const leaf2 = sha256("leaf2");

    // Level 1: [hash(leaf0+leaf1), leaf2]
    // Level 2: [hash(hash(leaf0+leaf1) + leaf2)]
    const expectedL1Left = sha256(leaf0 + leaf1);
    const expectedRoot = sha256(expectedL1Left + leaf2);

    const root = computeMerkleRoot([leaf0, leaf1, leaf2]);
    expect(root).toBe(expectedRoot);
  });

  it("handles four leaves (balanced tree)", () => {
    const leaves = [sha256("a"), sha256("b"), sha256("c"), sha256("d")];

    const l1 = sha256(leaves[0] + leaves[1]);
    const r1 = sha256(leaves[2] + leaves[3]);
    const expectedRoot = sha256(l1 + r1);

    const root = computeMerkleRoot(leaves);
    expect(root).toBe(expectedRoot);
  });

  it("produces deterministic roots", () => {
    const leaves = Array.from({ length: 10 }, (_, i) => sha256(`leaf${i}`));
    const root1 = computeMerkleRoot(leaves);
    const root2 = computeMerkleRoot(leaves);
    expect(root1).toBe(root2);
  });

  it("different leaf order produces different root", () => {
    const leaves = [sha256("a"), sha256("b"), sha256("c")];
    const reversed = [...leaves].reverse();
    expect(computeMerkleRoot(leaves)).not.toBe(computeMerkleRoot(reversed));
  });

  it("modifying a single leaf changes the root", () => {
    const leaves = Array.from({ length: 8 }, (_, i) => sha256(`leaf${i}`));
    const root1 = computeMerkleRoot(leaves);

    const modified = [...leaves];
    modified[3] = sha256("TAMPERED");
    const root2 = computeMerkleRoot(modified);

    expect(root1).not.toBe(root2);
  });
});
