import type { Request, Response, Router } from "express";
import type { Config } from "./config.js";
import { hubManifest } from "./slack/manifest.js";

/**
 * Unauthenticated setup helpers. Nothing here is secret: the hub manifest only
 * contains public URLs and scope names, and is needed *before* anyone can sign in.
 */
export function registerSetupRoutes(router: Router, config: Config): void {
  router.get("/setup/hub-manifest.yml", (_req: Request, res: Response) => {
    res.type("text/yaml").attachment("chatwoot-slack-inbox-hub.manifest.yml").send(hubManifest({ publicUrl: config.PUBLIC_URL }));
  });

  router.get("/setup", (_req: Request, res: Response) => {
    const manifest = hubManifest({ publicUrl: config.PUBLIC_URL });
    res.type("html").send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Setup · chatwoot-slack-inbox</title>
<style>body{font:15px/1.55 system-ui,sans-serif;max-width:44rem;margin:3rem auto;padding:0 1rem;color:#1b1f24}h1{font-size:1.4rem}h2{font-size:1.05rem;margin-top:2rem}code{background:#f2f2f2;padding:.1em .3em;border-radius:3px}pre{background:#f6f7f9;border:1px solid #e3e6ea;border-radius:6px;padding:10px 12px;font-size:12px;overflow:auto}.btn{display:inline-block;background:#1f93ff;color:#fff;padding:7px 12px;border-radius:6px;text-decoration:none}ol li{margin:.35rem 0}</style>
<h1>chatwoot-slack-inbox setup</h1>
<p>This instance is at <code>${esc(config.PUBLIC_URL)}</code>. One-time steps for whoever is setting it up:</p>
<h2>1. Create the hub Slack app</h2>
<ol>
<li><a class="btn" href="/setup/hub-manifest.yml">Download hub manifest</a> (pre-filled with this server's URLs)</li>
<li>At <a href="https://api.slack.com/apps?new_app=1">api.slack.com/apps</a> choose <em>Create New App → From a manifest</em>, pick your workspace, paste the file's contents.</li>
<li><em>Install to Workspace</em>. Copy the <strong>Bot User OAuth Token</strong> (OAuth &amp; Permissions) and the <strong>Client ID</strong> / <strong>Client Secret</strong> (Basic Information).</li>
<li>Set them as <code>SLACK_BOT_TOKEN</code>, <code>SLACK_CLIENT_ID</code>, <code>SLACK_CLIENT_SECRET</code> on the server and restart. Put the admins' Slack user IDs in <code>ADMIN_SLACK_USER_IDS</code>.</li>
</ol>
<h2>2. Open the control panel</h2>
<p><a href="/admin/">${esc(config.PUBLIC_URL)}/admin/</a> → Sign in with Slack → <em>New bridge</em>. The form generates the per-team Slack app manifest for you.</p>
<h2>Hub manifest</h2>
<pre>${esc(manifest)}</pre>
<p style="color:#6b7280">Unofficial; not affiliated with Chatwoot or Slack.</p>`);
  });
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
