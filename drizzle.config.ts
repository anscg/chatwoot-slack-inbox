import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://chatwoot_slack:chatwoot_slack@localhost:5432/chatwoot_slack",
  },
  strict: true,
  verbose: true,
});
