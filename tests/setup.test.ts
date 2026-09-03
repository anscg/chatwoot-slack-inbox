import express from "express";
import { describe, expect, it } from "vitest";
import { registerSetupRoutes } from "../src/setup.js";
import { bridgeManifest, hubManifest } from "../src/slack/manifest.js";
import { testConfig } from "./helpers.js";

describe("manifests", () => {
  it("hub manifest carries this instance's redirect URLs and no bot channel scopes", () => {
    const m = hubManifest({ publicUrl: "https://bridge.test" });
    expect(m).toContain("- https://bridge.test/link/callback");
    expect(m).toContain("- https://bridge.test/admin/callback");
    expect(m).toContain("users:read.email");
    expect(m).not.toContain("channels:history");
    expect(m).not.toContain("event_subscriptions");
  });

  it("bridge manifest points events at the slug and has no OAuth redirects", () => {
    const m = bridgeManifest({ name: "HCB Support", slug: "hcb-support", publicUrl: "https://bridge.test" });
    expect(m).toContain("request_url: https://bridge.test/slack/events/hcb-support");
    expect(m).toContain('name: "HCB Support"');
    expect(m).not.toContain("redirect_urls");
  });

  it("serves the hub manifest and setup page without authentication", async () => {
    const app = express();
    registerSetupRoutes(app, testConfig());
    const server = app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const res = await fetch(`${base}/setup/hub-manifest.yml`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-disposition")).toContain("attachment");
      expect(await res.text()).toContain("https://bridge.test/admin/callback");
      const page = await fetch(`${base}/setup`);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain("Download hub manifest");
    } finally {
      server.close();
    }
  });
});
