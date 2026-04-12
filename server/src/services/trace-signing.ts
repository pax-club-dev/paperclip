/**
 * Ed25519 trace signing manager — per-run key derivation and span signing.
 *
 * Per CISO §8.3: Derive per-run signing keys from run JWT via HKDF-SHA256.
 * Per CISO §2.1: Each span is signed with Ed25519 for trace authenticity.
 *
 * Key lifecycle:
 * 1. When a heartbeat run starts, deriveRunKeyPair() is called with the run JWT
 * 2. The JWT's HMAC signature is used as IKM for HKDF-SHA256
 * 3. A 32-byte Ed25519 seed is derived, producing a deterministic keypair
 * 4. The keypair lives in memory only for the heartbeat duration
 * 5. On heartbeat completion, clearRunKey() zeros and removes the key material
 */

import {
  hkdfSync,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";

/** Ed25519 PKCS8 DER prefix for wrapping a 32-byte seed. */
const ED25519_PKCS8_PREFIX = Buffer.from(
  "302e020100300506032b657004220420",
  "hex",
);

/** Default HKDF info string for trace signing key derivation. */
const HKDF_INFO = "paperclip-trace-signing-v1";

/** Per-run key material held in memory. */
interface RunKeyMaterial {
  privateKey: KeyObject;
  publicKey: KeyObject;
  /** Raw seed — kept so we can zero it on cleanup. */
  seed: Buffer;
}

/**
 * Manages Ed25519 signing keys for audit trail span signing.
 *
 * One instance per server process. Keys are held in memory per-run
 * and explicitly zeroed after each heartbeat completes.
 */
export class TraceSigningManager {
  private readonly keys = new Map<string, RunKeyMaterial>();
  private readonly salt: Buffer;

  /**
   * @param salt Server-side salt for HKDF derivation (CISO §8.3: separate from JWT secret).
   */
  constructor(salt: string | Buffer) {
    this.salt = typeof salt === "string" ? Buffer.from(salt, "utf8") : salt;
  }

  /**
   * Derive an Ed25519 keypair from the run JWT's HMAC signature.
   *
   * The derivation is deterministic: same JWT signature + same salt = same keypair.
   * This allows the verification side to re-derive the public key.
   */
  deriveRunKeyPair(runId: string, jwtSignature: string): void {
    if (this.keys.has(runId)) return; // idempotent

    // Decode the JWT signature from base64url to raw bytes (IKM for HKDF)
    const ikm = Buffer.from(jwtSignature, "base64url");

    // HKDF-SHA256: extract + expand to produce 32-byte Ed25519 seed
    const seed = Buffer.from(hkdfSync("sha256", ikm, this.salt, HKDF_INFO, 32));

    // Construct Ed25519 private key from seed via PKCS8 DER encoding
    const pkcs8Der = Buffer.concat([ED25519_PKCS8_PREFIX, seed]);
    const privateKey = createPrivateKey({
      key: pkcs8Der,
      format: "der",
      type: "pkcs8",
    });
    const publicKey = createPublicKey(privateKey);

    this.keys.set(runId, { privateKey, publicKey, seed });
  }

  /**
   * Sign a canonical payload buffer with the run's Ed25519 private key.
   * Returns base64-encoded signature, or null if no key is registered for the run.
   */
  sign(runId: string, payload: Buffer): string | null {
    const material = this.keys.get(runId);
    if (!material) return null;

    const signature = sign(null, payload, material.privateKey);
    return signature.toString("base64");
  }

  /**
   * Verify a signature against a canonical payload using the run's public key.
   * Returns false if the run has no registered key or the signature is invalid.
   */
  verify(runId: string, payload: Buffer, signature: Buffer): boolean {
    const material = this.keys.get(runId);
    if (!material) return false;

    return verify(null, payload, material.publicKey, signature);
  }

  /**
   * Get the PEM-encoded public key for a run (for external verification).
   */
  getPublicKeyPem(runId: string): string | null {
    const material = this.keys.get(runId);
    if (!material) return null;
    return material.publicKey.export({ type: "spki", format: "pem" }) as string;
  }

  /**
   * Clear and zero the key material for a completed run.
   * Must be called after every heartbeat to prevent key accumulation.
   */
  clearRunKey(runId: string): void {
    const material = this.keys.get(runId);
    if (!material) return;

    // Zero the seed buffer to minimize in-memory exposure
    material.seed.fill(0);
    this.keys.delete(runId);
  }

  /** Check if a run has a registered signing key. */
  hasKey(runId: string): boolean {
    return this.keys.has(runId);
  }
}

/** Resolve the signing salt from environment (CISO §8.3: separate from JWT secret). */
function resolveSigningSalt(): string | null {
  return process.env.PAPERCLIP_TRACE_SIGNING_SALT ?? null;
}

/** Singleton signing manager. Initialized lazily when signing is enabled. */
let manager: TraceSigningManager | null = null;

/**
 * Get or create the singleton TraceSigningManager.
 * Returns null if the signing salt is not configured.
 */
export function getTraceSigningManager(): TraceSigningManager | null {
  if (manager) return manager;

  const salt = resolveSigningSalt();
  if (!salt) return null;

  manager = new TraceSigningManager(salt);
  return manager;
}

/**
 * Extract the signature component from a JWT string (third segment, base64url).
 */
export function extractJwtSignature(jwt: string): string | null {
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  return parts[2];
}
