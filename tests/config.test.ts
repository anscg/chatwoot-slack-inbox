import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";

const valid = {
  SLACK_BOT_TOKEN: "xoxb-1",
  SLACK_SIGNING_SECRET: "s",
  SLACK_CLIENT_ID: "c",
  SLACK_CLIENT_SECRET: "c",
  CHATWOOT_BASE_URL: "https://chatwoot.example.com/",
  ADMIN_SLACK_USER_IDS: "U0AAA, U0BBB",
  CHATWOOT_WEBHOOK_SECRET: "0123456789abcdef",
  DATABASE_URL: "postgres://x",
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
  PUBLIC_URL: "https://bridge.example.com",
};

describe("config", () => {
  afterEach(() => vi.restoreAllMocks());

  it("parses and normalizes a valid env", () => {
    const c = loadConfig(valid);
    expect(c.CHATWOOT_BASE_URL).toBe("https://chatwoot.example.com");
    expect(c.ADMIN_SLACK_USER_IDS).toEqual(["U0AAA", "U0BBB"]);
    expect(c.TOKEN_ENCRYPTION_KEY.length).toBe(32);
    expect(c.PORT).toBe(3000);
  });

  it("treats an optional variable left blank in a .env file as unset", () => {
    const c = loadConfig({ ...valid, CHATWOOT_PLATFORM_TOKEN: "", HCA_CLIENT_ID: "", HCA_CLIENT_SECRET: "", HCA_ISSUER: "" });
    expect(c.CHATWOOT_PLATFORM_TOKEN).toBeUndefined();
    expect(c.HCA_CLIENT_ID).toBeUndefined();
    expect(c.HCA_ISSUER).toBe("https://auth.hackclub.com");
  });

  it("exits loudly listing every missing variable", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { SLACK_BOT_TOKEN: _a, PUBLIC_URL: _b, ...missing } = valid;
    expect(() => loadConfig({ ...missing, TOKEN_ENCRYPTION_KEY: "short" })).toThrow("exit");
    expect(exit).toHaveBeenCalledWith(1);
    const msg = String(err.mock.calls[0]?.[0]);
    expect(msg).toContain("SLACK_BOT_TOKEN");
    expect(msg).toContain("PUBLIC_URL");
    expect(msg).toContain("TOKEN_ENCRYPTION_KEY");
  });
});
