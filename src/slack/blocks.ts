import type { KnownBlock } from "@slack/web-api";

export const RESOLVE_ACTION_ID = "chatwoot_bridge_resolve";

/**
 * Welcome message with an optional Resolve button. The button's value carries the thread ts so the
 * handler doesn't have to trust the interaction payload's message context.
 */
export function welcomeBlocks(text: string, threadTs: string, buttonLabel: string | null): KnownBlock[] {
  const blocks: KnownBlock[] = [{ type: "section", text: { type: "mrkdwn", text } }];
  if (buttonLabel) {
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: RESOLVE_ACTION_ID,
          text: { type: "plain_text", text: buttonLabel, emoji: true },
          value: threadTs,
        },
      ],
    });
  }
  return blocks;
}
