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

/**
 * Shown privately to someone whose message was held back because this bridge requires a linked
 * Slack account. `{link}` is replaced with the /link URL; blank keeps the hold-back silent.
 */
export const DEFAULT_LINK_PROMPT = "Before you can post here, link your Slack account: {link}";
