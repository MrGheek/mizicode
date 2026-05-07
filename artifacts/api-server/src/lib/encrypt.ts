import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

const ALGO = "aes-256-gcm";
const PREFIX = "enc:v1:";

/**
 * Resolves the 32-byte AES key from MIZI_ENCRYPTION_KEY (64 hex chars).
 * Returns null when the env var is not set — plaintext mode (dev only).
 * Throws if the var is set but malformed.
 */
function getKey(): Buffer | null {
  const raw = process.env["MIZI_ENCRYPTION_KEY"];
  if (!raw) return null;
  if (raw.length !== 64) throw new Error("MIZI_ENCRYPTION_KEY must be exactly 64 hex chars (32 bytes)");
  return Buffer.from(raw, "hex");
}

/**
 * Encrypt a connection-string value for at-rest storage.
 * When MIZI_ENCRYPTION_KEY is not set the value is returned plaintext
 * (acceptable in dev; must be set in production).
 *
 * Output format: `enc:v1:<iv_hex>:<authTag_hex>:<ciphertext_hex>`
 */
export function encryptConnectionString(plain: string): string {
  const key = getKey();
  if (!key) return plain;

  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return `${PREFIX}${iv.toString("hex")}:${authTag.toString("hex")}:${ciphertext.toString("hex")}`;
}

/**
 * Decrypt a connection string previously encrypted by encryptConnectionString.
 * If the stored value does not start with the enc:v1: prefix it is returned
 * as-is (plaintext — legacy rows or dev without a key set).
 * Throws if decryption fails (bad key, corrupted data).
 */
export function decryptConnectionString(stored: string): string {
  if (!stored.startsWith(PREFIX)) return stored;

  const key = getKey();
  if (!key) {
    throw new Error("MIZI_ENCRYPTION_KEY must be set to decrypt connection strings");
  }

  const rest = stored.slice(PREFIX.length);
  const parts = rest.split(":");
  if (parts.length !== 3) throw new Error("Invalid encrypted connection string format");

  const [ivHex, authTagHex, ciphertextHex] = parts as [string, string, string];
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  const ciphertext = Buffer.from(ciphertextHex, "hex");

  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

/**
 * Decrypt and mask a stored connection string for safe display.
 * Returns the connection string with the password component replaced by ***.
 */
export function maskConnectionString(stored: string): string | null {
  if (!stored) return null;
  try {
    const plain = decryptConnectionString(stored);
    return plain.replace(/:([^:@]+)@/, ":***@");
  } catch {
    return "***";
  }
}
