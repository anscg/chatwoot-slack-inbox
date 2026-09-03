import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Compact HMAC-signed tokens for OAuth `state` and the admin session cookie.
 * Derives a dedicated signing key from the encryption key so one env var covers both.
 */
export class Signer {
  private readonly key: Buffer;

  constructor(masterKey: Buffer, label = "chatwoot-slack-inbox/session") {
    this.key = createHmac("sha256", masterKey).update(label).digest();
  }

  sign(payload: Record<string, unknown>, ttlMs: number): string {
    const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + ttlMs })).toString("base64url");
    return `${body}.${this.mac(body)}`;
  }

  verify<T extends Record<string, unknown>>(token: string | undefined): (T & { exp: number }) | null {
    if (!token) return null;
    const dot = token.lastIndexOf(".");
    if (dot < 0) return null;
    const body = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const expected = this.mac(body);
    if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    try {
      const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T & { exp: number };
      if (typeof payload.exp !== "number" || payload.exp < Date.now()) return null;
      return payload;
    } catch {
      return null;
    }
  }

  private mac(body: string): string {
    return createHmac("sha256", this.key).update(body).digest("base64url");
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export const ADMIN_COOKIE = "cwsi_admin";
export const ADMIN_SESSION_TTL_MS = 12 * 60 * 60_000;

export interface AdminSession extends Record<string, unknown> {
  userId: string;
  name: string;
}
