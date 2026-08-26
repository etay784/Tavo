import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export function migrationFiles(): string[] {
  const dir = path.join(__dirname, "..", "sql");
  return fs
    .readdirSync(dir)
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .sort()
    .map((f) => path.join(dir, f));
}

async function relationExists(client: Client, name: string): Promise<boolean> {
  const r = await client.query<{ t: string | null }>(
    `SELECT to_regclass($1) AS t`,
    [`public.${name}`],
  );
  return r.rows[0]?.t != null;
}

async function stamp(client: Client, filename: string): Promise<void> {
  await client.query(
    `INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT (filename) DO NOTHING`,
    [filename],
  );
}

async function ensureStampTable(client: Client): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

/**
 * Apply versioned SQL migrations exactly once. Does not set role passwords;
 * credentials are provisioned outside this module (secrets / test trust auth).
 */
export async function applyMigrations(superuserUrl: string): Promise<void> {
  const client = new Client({ connectionString: superuserUrl });
  await client.connect();
  try {
    await ensureStampTable(client);
    const legacy = await relationExists(client, "appointments");
    for (const file of migrationFiles()) {
      const filename = path.basename(file);
      const done = await client.query(`SELECT 1 FROM schema_migrations WHERE filename = $1`, [
        filename,
      ]);
      if ((done.rowCount ?? 0) > 0) continue;

      const skipReplay =
        legacy &&
        (filename === "000_roles.sql" ||
          filename === "001_btree_gist.sql" ||
          filename === "002_schema.sql");
      if (skipReplay) {
        await stamp(client, filename);
        continue;
      }

      const sql = fs.readFileSync(file, "utf8");
      await client.query(sql);
      await stamp(client, filename);
    }

    const db = await client.query<{ name: string }>(`SELECT current_database() AS name`);
    const dbName = db.rows[0]?.name;
    if (!dbName) throw new Error("current_database missing");
    await client.query(
      `GRANT CONNECT ON DATABASE ${quoteIdent(dbName)} TO tavo_migrator, tavo_app`,
    );
  } finally {
    await client.end();
  }
}

/** @deprecated use applyMigrations */
export const bootstrapRolesAndSchema = applyMigrations;
