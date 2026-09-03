import type { WebClient } from "@slack/web-api";
import { getSlackProfile } from "./users.js";

/**
 * Render Slack mrkdwn into plain-ish markdown for Chatwoot: resolve user/channel
 * mentions, unwrap links, decode HTML entities. Best effort.
 */
export async function slackToChatwootText(slack: WebClient, text: string): Promise<string> {
  let out = text;
  const userIds = [...new Set([...out.matchAll(/<@([UW][A-Z0-9_]+)(?:\|[^>]*)?>/g)].map((m) => m[1]!))];
  const names = new Map<string, string>();
  await Promise.all(
    userIds.map(async (id) => {
      try {
        names.set(id, (await getSlackProfile(slack, id)).name);
      } catch {
        names.set(id, id);
      }
    }),
  );
  out = out.replace(/<@([UW][A-Z0-9_]+)(?:\|[^>]*)?>/g, (_m, id: string) => `@${names.get(id) ?? id}`);
  out = out.replace(/<#[A-Z0-9]+\|([^>]*)>/g, "#$1");
  out = out.replace(/<!(channel|here|everyone)>/g, "@$1");
  out = out.replace(/<!subteam\^[A-Z0-9]+\|@?([^>]*)>/g, "@$1");
  out = out.replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, "[$2]($1)");
  out = out.replace(/<(https?:\/\/[^>]+)>/g, "$1");
  out = out.replace(/<mailto:([^|>]+)(?:\|[^>]*)?>/g, "$1");
  out = out.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  return out;
}

/** Chatwoot markdown -> Slack mrkdwn. Best effort: links, bold, italics. */
export function chatwootToSlackText(text: string): string {
  let out = text;
  out = out.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, "<$2|$1>");
  out = out.replace(/\*\*([^*\n]+)\*\*/g, "\u0000$1\u0000"); // bold -> placeholder so italics pass ignores it
  out = out.replace(/(^|[^*\w])\*([^*\n]+)\*(?![*\w])/g, "$1_$2_"); // markdown single-star italics
  out = out.replace(/\u0000/g, "*");
  return out;
}
