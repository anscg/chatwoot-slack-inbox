import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import * as schema from "./schema.js";

export type Db = NodePgDatabase<typeof schema>;

export function createDb(databaseUrl: string): { db: Db; pool: pg.Pool } {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
  const db = drizzle(pool, { schema });
  return { db, pool };
}

/** Apply pending drizzle migrations from ./drizzle at startup. */
export async function runMigrations(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder: new URL("../../drizzle", import.meta.url).pathname });
}
