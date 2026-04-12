/**
 * AES-256-GCM encryption abstraction for audit span payloads.
 *
 * Pluggable provider interface: local key (default) or Cloud KMS.
 * Follows the same pattern as `server/src/secrets/local-encrypted-provider.ts`
 * but scoped to audit data with key versioning for rotation.
 *
 * CISO §4.2: CMEK with rotation support. The key abstraction layer works
 * locally and can plug into GCP Cloud KMS in production.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

// ── Types ───────────────────────────────────────────────────────

export interface EncryptedPayload {
  /** Encryption scheme identifier */
  scheme: string;
  /** Key version for rotation tracking */
  keyVersion: number;
  /** 12-byte IV, base64-encoded */
  iv: string;
  /** GCM authentication tag, base64-encoded */
  tag: string;
  /** Ciphertext, base64-encoded */
  ciphertext: string;
}

export interface AuditEncryptionProvider {
  /** Unique scheme identifier stored alongside ciphertext */
  readonly scheme: string;
  /** Current key version */
  readonly keyVersion: number;
  /** Encrypt plaintext payload */
  encrypt(plaintext: string): EncryptedPayload;
  /** Decrypt an encrypted payload */
  decrypt(payload: EncryptedPayload): string;
}

// ── Local AES-256-GCM Provider ──────────────────────────────────

const ALGORITHM = "aes-256-gcm" as const;
const IV_BYTES = 12;
const LOCAL_SCHEME = "aes-256-gcm-local-v1";

/**
 * Resolve the audit encryption master key.
 * Uses a dedicated env var (separate from the secrets master key)
 * to maintain blast radius isolation per CISO §4.2.
 */
function resolveAuditMasterKey(): Buffer {
  const raw = process.env.PAPERCLIP_AUDIT_ENCRYPTION_KEY;
  if (raw && raw.trim().length > 0) {
    const trimmed = raw.trim();

    // 64-char hex → 32 bytes
    if (/^[A-Fa-f0-9]{64}$/.test(trimmed)) {
      return Buffer.from(trimmed, "hex");
    }

    // base64 → 32 bytes
    try {
      const decoded = Buffer.from(trimmed, "base64");
      if (decoded.length === 32) return decoded;
    } catch {
      // fall through
    }

    // raw 32-byte string
    if (Buffer.byteLength(trimmed, "utf8") === 32) {
      return Buffer.from(trimmed, "utf8");
    }

    throw new Error(
      "Invalid PAPERCLIP_AUDIT_ENCRYPTION_KEY: expected 32-byte base64, 64-char hex, or raw 32-char string",
    );
  }

  // Fall back to the general secrets master key for dev/testing
  const fallback = process.env.PAPERCLIP_SECRETS_MASTER_KEY;
  if (fallback && fallback.trim().length > 0) {
    const trimmed = fallback.trim();
    if (/^[A-Fa-f0-9]{64}$/.test(trimmed)) return Buffer.from(trimmed, "hex");
    try {
      const decoded = Buffer.from(trimmed, "base64");
      if (decoded.length === 32) return decoded;
    } catch {
      // fall through
    }
    if (Buffer.byteLength(trimmed, "utf8") === 32) return Buffer.from(trimmed, "utf8");
  }

  throw new Error(
    "No audit encryption key configured. Set PAPERCLIP_AUDIT_ENCRYPTION_KEY or PAPERCLIP_SECRETS_MASTER_KEY.",
  );
}

function resolveKeyVersion(): number {
  const v = process.env.PAPERCLIP_AUDIT_ENCRYPTION_KEY_VERSION;
  if (v && /^\d+$/.test(v.trim())) return parseInt(v.trim(), 10);
  return 1;
}

export function createLocalEncryptionProvider(): AuditEncryptionProvider {
  const masterKey = resolveAuditMasterKey();
  const keyVersion = resolveKeyVersion();

  return {
    scheme: LOCAL_SCHEME,
    keyVersion,

    encrypt(plaintext: string): EncryptedPayload {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv(ALGORITHM, masterKey, iv);
      const ciphertext = Buffer.concat([
        cipher.update(plaintext, "utf8"),
        cipher.final(),
      ]);
      const tag = cipher.getAuthTag();

      return {
        scheme: LOCAL_SCHEME,
        keyVersion,
        iv: iv.toString("base64"),
        tag: tag.toString("base64"),
        ciphertext: ciphertext.toString("base64"),
      };
    },

    decrypt(payload: EncryptedPayload): string {
      if (payload.scheme !== LOCAL_SCHEME) {
        throw new Error(`Cannot decrypt scheme "${payload.scheme}" with local provider`);
      }
      const iv = Buffer.from(payload.iv, "base64");
      const tag = Buffer.from(payload.tag, "base64");
      const ciphertext = Buffer.from(payload.ciphertext, "base64");
      const decipher = createDecipheriv(ALGORITHM, masterKey, iv);
      decipher.setAuthTag(tag);
      const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return plain.toString("utf8");
    },
  };
}

// ── KMS Provider Stub ───────────────────────────────────────────

const KMS_SCHEME = "aes-256-gcm-kms-v1";

/**
 * Stub for GCP Cloud KMS-backed encryption.
 * In production, this would use the KMS API to wrap/unwrap DEKs
 * (data encryption keys) with a KEK (key encryption key) in KMS.
 *
 * The pattern:
 *   encrypt: generate random DEK → encrypt payload with DEK → wrap DEK with KMS KEK
 *   decrypt: unwrap DEK with KMS KEK → decrypt payload with DEK
 */
export function createKmsEncryptionProvider(_kmsKeyResourceName: string): AuditEncryptionProvider {
  // TODO: Wire to @google-cloud/kms when GCP project is configured.
  // For now, throws to prevent accidental use.
  throw new Error(
    `KMS encryption provider not yet implemented. ` +
    `Key resource: ${_kmsKeyResourceName}. ` +
    `Set up GCP KMS and implement DEK wrap/unwrap pattern.`,
  );
}

// ── Provider Registry ───────────────────────────────────────────

let _defaultProvider: AuditEncryptionProvider | null = null;

/** Get or create the default encryption provider based on configuration. */
export function getAuditEncryptionProvider(): AuditEncryptionProvider {
  if (_defaultProvider) return _defaultProvider;

  const kmsKey = process.env.PAPERCLIP_AUDIT_KMS_KEY;
  if (kmsKey && kmsKey.trim().length > 0) {
    _defaultProvider = createKmsEncryptionProvider(kmsKey.trim());
  } else {
    _defaultProvider = createLocalEncryptionProvider();
  }

  return _defaultProvider;
}

/** Reset cached provider (for testing). */
export function resetAuditEncryptionProvider(): void {
  _defaultProvider = null;
}

// ── Utility ─────────────────────────────────────────────────────

/** SHA-256 hash of span IDs for deletion certificates. */
export function hashSpanIds(ids: string[]): string {
  const sorted = [...ids].sort();
  return createHash("sha256").update(sorted.join("\n")).digest("hex");
}
