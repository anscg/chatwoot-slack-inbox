import { z } from "zod";

const nonEmpty = (name: string) => z.string().trim().min(1, `${name} is required`);

const keySchema = z
  .string()
  .trim()
  .min(1, "TOKEN_ENCRYPTION_KEY is required")
  .transform((raw, ctx) => {
    // Accept hex (64 chars) or base64 for a 32-byte key.
    const buf = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
    if (buf.length !== 32) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes (hex or base64). Generate with: openssl rand -base64 32",
      });
      return z.NEVER;
    }
    return buf;
  });

const envSchema = z.object({
  /**
   * The "hub" Slack app: admin sign-in, agent /link, and user profile lookups.
   * Each bridge has its own Slack app (bot) configured in the control panel.
   */
  SLACK_BOT_TOKEN: nonEmpty("SLACK_BOT_TOKEN").refine((t) => t.startsWith("xoxb-"), "SLACK_BOT_TOKEN must be a bot token (xoxb-...)"),
  SLACK_CLIENT_ID: nonEmpty("SLACK_CLIENT_ID"),
  SLACK_CLIENT_SECRET: nonEmpty("SLACK_CLIENT_SECRET"),

  /** One Chatwoot installation; bridges pick accounts/inboxes within it. */
  CHATWOOT_BASE_URL: z
    .string()
    .url("CHATWOOT_BASE_URL must be a URL")
    .transform((u) => u.replace(/\/+$/, "")),
  CHATWOOT_WEBHOOK_SECRET: z.string().trim().min(16, "CHATWOOT_WEBHOOK_SECRET must be at least 16 characters"),
  /**
   * Optional Platform App token (self-hosted Chatwoot, /super_admin -> Platform Apps). When set,
   * an agent's own Chatwoot access token is fetched automatically as they link, so their Slack
   * replies are attributed to them without an admin pasting a token per person.
   */
  CHATWOOT_PLATFORM_TOKEN: z.string().trim().min(1).optional(),

  /** Comma-separated Slack user IDs allowed into the control panel. */
  ADMIN_SLACK_USER_IDS: z
    .string()
    .trim()
    .min(1, "ADMIN_SLACK_USER_IDS is required (comma-separated Slack user IDs)")
    .transform((s) => s.split(",").map((x) => x.trim()).filter(Boolean))
    .refine((ids) => ids.length > 0 && ids.every((id) => /^[UW][A-Z0-9]+$/.test(id)), "ADMIN_SLACK_USER_IDS must be Slack user IDs like U0123456789"),

  DATABASE_URL: nonEmpty("DATABASE_URL"),
  TOKEN_ENCRYPTION_KEY: keySchema,
  PUBLIC_URL: z
    .string()
    .url("PUBLIC_URL must be a URL")
    .transform((u) => u.replace(/\/+$/, "")),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type Config = z.infer<typeof envSchema>;

export function parseConfig(env: NodeJS.ProcessEnv = process.env): { ok: true; config: Config } | { ok: false; issues: string[] } {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    return { ok: false, issues: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) };
  }
  return { ok: true, config: parsed.data };
}

/** Parse env or fail loudly, printing every problem at once. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = parseConfig(env);
  if (!result.ok) {
    console.error(`Invalid configuration:\n${result.issues.map((i) => `  - ${i}`).join("\n")}`);
    process.exit(1);
  }
  return result.config;
}
