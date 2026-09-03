import type { KnownBlock } from "@slack/web-api";

export const RESOLVE_ACTION_ID = "chatwoot_bridge_resolve";

export type ButtonAction = "resolve" | "reopen";

export interface ThreadButton {
  label: string;
  action: ButtonAction;
}

/** Which button belongs on the welcome message for a conversation in this state. */
export function buttonForStatus(
  status: string | null | undefined,
  labels: { resolveButtonLabel: string | null; reopenButtonLabel: string | null },
): ThreadButton | null {
  if (status === "resolved") return labels.reopenButtonLabel ? { label: labels.reopenButtonLabel, action: "reopen" } : null;
  return labels.resolveButtonLabel ? { label: labels.resolveButtonLabel, action: "resolve" } : null;
}

/**
 * Welcome message, with an optional action button. The value carries both the intent and the thread
 * ts, so a click is unambiguous even if the button is stale.
 */
export function welcomeBlocks(text: string, threadTs: string, button: ThreadButton | null): KnownBlock[] {
  const blocks: KnownBlock[] = [{ type: "section", text: { type: "mrkdwn", text } }];
  if (button) {
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: RESOLVE_ACTION_ID,
          text: { type: "plain_text", text: button.label, emoji: true },
          value: `${button.action}:${threadTs}`,
        },
      ],
    });
  }
  return blocks;
}

/** Read a button value. Values written before the toggle existed are a bare thread ts. */
export function parseButtonValue(value: string | undefined): { action: ButtonAction; threadTs: string } | null {
  if (!value) return null;
  const i = value.indexOf(":");
  if (i < 0) return { action: "resolve", threadTs: value };
  const action = value.slice(0, i);
  if (action !== "resolve" && action !== "reopen") return null;
  return { action, threadTs: value.slice(i + 1) };
}
