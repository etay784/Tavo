import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
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

export function migrationChecksum(sql: string): string {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

async function relationExists(client: Client, name: string): Promise<boolean> {
  const r = await client.query<{ t: string | null }>(
    `SELECT to_regclass($1) AS t`,
    [`public.${name}`],
  );
  return r.rows[0]?.t != null;
}

async function stamp(client: Client, filename: string, checksum: string): Promise<void> {
  await client.query(
    `INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)
     ON CONFLICT (filename) DO UPDATE SET checksum = COALESCE(schema_migrations.checksum, EXCLUDED.checksum)`,
    [filename, checksum],
  );
}

async function ensureStampTable(client: Client): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now(),
      checksum text
    )
  `);
  await client.query(`ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum text`);
}

async function assertChecksum(client: Client, filename: string, checksum: string): Promise<void> {
  const row = await client.query<{ checksum: string | null }>(
    `SELECT checksum FROM schema_migrations WHERE filename = $1`,
    [filename],
  );
  const stored = row.rows[0]?.checksum;
  if (stored && stored !== checksum) {
    throw new Error(`migration ${filename} checksum mismatch (file was edited after apply)`);
  }
  if (!stored) {
    await client.query(`UPDATE schema_migrations SET checksum = $2 WHERE filename = $1`, [
      filename,
      checksum,
    ]);
  }
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
      const sql = fs.readFileSync(file, "utf8");
      const checksum = migrationChecksum(sql);
      const done = await client.query(`SELECT 1 FROM schema_migrations WHERE filename = $1`, [
        filename,
      ]);
      if ((done.rowCount ?? 0) > 0) {
        await assertChecksum(client, filename, checksum);
        continue;
      }

      const skipReplay =
        legacy &&
        (filename === "000_roles.sql" ||
          filename === "001_btree_gist.sql" ||
          filename === "002_schema.sql");
      if (skipReplay) {
        await stamp(client, filename, checksum);
        continue;
      }

      await client.query(sql);
      await stamp(client, filename, checksum);
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
