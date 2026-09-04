/** Default bot messages for a new bridge. Editable per bridge in the control panel; blank disables. */
export const DEFAULT_WELCOME_MESSAGE = "Hi there :neocat_approve: a helper should be with you soon to help you! Please be patient in the meantime.";
export const DEFAULT_RESOLVE_MESSAGE = ":neocat: Help request marked as resolved.";
export const DEFAULT_REOPEN_MESSAGE = "Thread reopened.";
export const DEFAULT_RESOLVE_BUTTON_LABEL = "Resolve";
export const DEFAULT_REOPEN_BUTTON_LABEL = "Reopen";
export const DEFAULT_RESOLVED_EMOJI = "white_check_mark";

/** Shown privately to whoever reopened a resolved ticket by replying. */
export const DEFAULT_REOPEN_PROMPT =
  "Your message reopened this help ticket. Do you have a question, or is it accidental?";
export const REOPEN_PROMPT_ACCIDENTAL_LABEL = "No, I don't have a question";
export const REOPEN_PROMPT_KEEP_LABEL = "I have a question, reopen";
/** No answer within this long counts as "no, I don't have a question" and resolves the ticket again. */
export const REOPEN_PROMPT_TIMEOUT_MS = 4 * 60_000;
export const REOPEN_PROMPT_TIMEOUT_MESSAGE =
  "No answer, so I've assumed this was accidental and marked the ticket as resolved again. Reply again if you do need help.";

/**
 * Shown privately to someone whose message was held back because this bridge requires a linked
 * Slack account. `{link}` is replaced with the /link URL; blank keeps the hold-back silent.
 */
export const DEFAULT_LINK_PROMPT = "Before you can post here, link your Slack account: {link}";

/**
 * Shown privately to someone who replied with "Also send to #channel" ticked. The copy Slack posts
 * in the channel is not part of the thread, so only they can tidy it away.
 */
export const BROADCAST_NOTICE_MESSAGE =
  "Heads up: you sent that reply to the channel as well as to this thread. Could you delete the copy in the channel to keep things tidy? Your reply here is safe and has already reached the helpers. Thank you!";

/**
 * Shown privately to someone who posts a fresh question in the channel within
 * `FOLLOWUP_PROMPT_WINDOW_MS` of their last one. Nothing reaches Chatwoot until they answer, so a
 * follow-up that belongs in the earlier thread never opens a second ticket. Blank disables.
 */
export const DEFAULT_FOLLOWUP_PROMPT =
  "You asked something here a few minutes ago. Is this a separate question, or more about that one? Nothing has been sent to the helpers yet.";
export const FOLLOWUP_PROMPT_SEPARATE_LABEL = "It's a separate question";
export const FOLLOWUP_PROMPT_RELATED_LABEL = "It's about my earlier one";
/** How recently they must have asked for the prompt to appear at all. */
export const FOLLOWUP_PROMPT_WINDOW_MS = 5 * 60_000;
/** No answer within this long means we take them at their word that it's a new question. */
export const FOLLOWUP_PROMPT_TIMEOUT_MS = 10 * 60_000;
export const FOLLOWUP_SEPARATE_MESSAGE = "Thanks! I've opened a ticket for it.";
export const FOLLOWUP_RELATED_MESSAGE =
  "Got it, no second ticket then. Could you delete this message and post it as a reply in your earlier thread instead? Keeping one question per thread is how the helpers keep track. Thank you!";
/** Shown when someone answers the follow-up prompt after the hold already timed out. */
export const FOLLOWUP_ALREADY_SENT_MESSAGE = "That one had already gone to the helpers while this was waiting.";

/** Marks a Chatwoot message whose Slack original was deleted. Agents keep the text, struck through. */
export const DELETED_PREFIX = "[DELETED]";

/** `[DELETED]` in front, the rest struck through line by line so multi-line text still renders. */
export function struckThrough(content: string): string {
  const struck = content
    .split("\n")
    .map((line) => (line.trim() ? `~~${line}~~` : line))
    .join("\n");
  return `${DELETED_PREFIX} ${struck}`;
}
