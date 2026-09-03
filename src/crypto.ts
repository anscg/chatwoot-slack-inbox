import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALG = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;
const VERSION = "v1";

/**
 * AES-256-GCM token encryption. Output format: `v1:<base64(iv|tag|ciphertext)>`.
 * The key must be exactly 32 bytes; config.ts validates that.
 */
export function encryptToken(plain: string, key: Buffer): string {
  if (key.length !== 32) throw new Error("encryption key must be 32 bytes");
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALG, key, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}:${Buffer.concat([iv, tag, ct]).toString("base64")}`;
}

export function decryptToken(enc: string, key: Buffer): string {
  if (key.length !== 32) throw new Error("encryption key must be 32 bytes");
  const [version, body] = enc.split(":");
  if (version !== VERSION || !body) throw new Error("unrecognized token ciphertext format");
  const buf = Buffer.from(body, "base64");
  if (buf.length < IV_LEN + TAG_LEN) throw new Error("ciphertext too short");
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALG, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}
