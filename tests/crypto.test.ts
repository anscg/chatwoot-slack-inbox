import { describe, expect, it } from "vitest";
import { decryptToken, encryptToken } from "../src/crypto.js";
import { TEST_KEY } from "./helpers.js";

describe("token encryption", () => {
  it("round-trips and uses a fresh IV each time", () => {
    const a = encryptToken("xoxp-secret", TEST_KEY);
    const b = encryptToken("xoxp-secret", TEST_KEY);
    expect(a).not.toEqual(b);
    expect(decryptToken(a, TEST_KEY)).toBe("xoxp-secret");
    expect(decryptToken(b, TEST_KEY)).toBe("xoxp-secret");
  });

  it("rejects tampering and wrong keys", () => {
    const enc = encryptToken("token", TEST_KEY);
    expect(() => decryptToken(enc, Buffer.alloc(32, 9))).toThrow();
    const [v, body] = enc.split(":");
    const tampered = Buffer.from(body!, "base64");
    tampered[tampered.length - 1] ^= 0xff;
    expect(() => decryptToken(`${v}:${tampered.toString("base64")}`, TEST_KEY)).toThrow();
  });
});
