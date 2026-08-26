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

export async function bootstrapRolesAndSchema(superuserUrl: string): Promise<void> {
  const client = new Client({ connectionString: superuserUrl });
  await client.connect();
  try {
    for (const file of migrationFiles()) {
      const sql = fs.readFileSync(file, "utf8");
      await client.query(sql);
    }
    const db = await client.query<{ name: string }>(`SELECT current_database() AS name`);
    const dbName = db.rows[0]?.name;
    if (!dbName) throw new Error("current_database missing");
    await client.query(
      `GRANT CONNECT ON DATABASE ${quoteIdent(dbName)} TO tavo_migrator, tavo_app`,
    );
    await client.query(`ALTER ROLE tavo_migrator WITH PASSWORD 'migrator-secret'`);
    await client.query(`ALTER ROLE tavo_app WITH PASSWORD 'app-secret'`);
  } finally {
    await client.end();
  }
}
