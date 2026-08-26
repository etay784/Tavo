import { Pool } from "pg";
import { loadConfig } from "./config";
import { buildApp } from "./app";

async function main() {
  const config = loadConfig();
  const pool = new Pool({ connectionString: config.databaseUrl, max: 10 });
  const app = buildApp(config, pool);
  const port = Number(process.env["PORT"] ?? 3000);
  await app.listen({ port, host: "127.0.0.1" });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
