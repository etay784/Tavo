import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Client } from "pg";

const DEFAULT_BINS = [
  process.env["PGBIN"],
  "C:\\Program Files\\PostgreSQL\\17\\bin",
  "C:\\Program Files\\PostgreSQL\\16\\bin",
  "/usr/lib/postgresql/17/bin",
  "/usr/lib/postgresql/16/bin",
  "/usr/lib/postgresql/15/bin",
  "/usr/bin",
].filter((x): x is string => Boolean(x));

export function findPgBin(): string {
  for (const dir of DEFAULT_BINS) {
    const initdb = path.join(dir, process.platform === "win32" ? "initdb.exe" : "initdb");
    if (fs.existsSync(initdb)) {
      return dir;
    }
  }
  throw new Error(
    "PostgreSQL binaries not found. Set PGBIN to the directory containing initdb.",
  );
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      if (!addr || typeof addr === "string") {
        s.close();
        reject(new Error("port"));
        return;
      }
      const port = addr.port;
      s.close(() => resolve(port));
    });
  });
}

export type EphemeralPg = {
  port: number;
  dataDir: string;
  superuserUrl: string;
  appUrl: string;
  migratorUrl: string;
  stop: () => Promise<void>;
};

export async function startEphemeralPostgres(): Promise<EphemeralPg> {
  const bin = findPgBin();
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tavo-pg-"));
  const initdb = path.join(bin, process.platform === "win32" ? "initdb.exe" : "initdb");
  const pgCtl = path.join(bin, process.platform === "win32" ? "pg_ctl.exe" : "pg_ctl");
  execFileSync(
    initdb,
    ["-D", dataDir, "-U", "postgres", "-A", "trust", "--encoding=UTF8", "--locale=C"],
    { stdio: "pipe" },
  );
  const hba = path.join(dataDir, "pg_hba.conf");
  fs.writeFileSync(
    hba,
    [
      "local all all trust",
      "host all all 127.0.0.1/32 trust",
      "host all all ::1/128 trust",
      "",
    ].join("\n"),
    "utf8",
  );
  const logFile = path.join(dataDir, "pg.log");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      pgCtl,
      [
        "-D",
        dataDir,
        "-l",
        logFile,
        "-o",
        `-p ${port} -h 127.0.0.1`,
        "-w",
        "start",
      ],
      { stdio: "pipe" },
    );
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else {
        const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "";
        reject(new Error(`pg_ctl start failed: ${code} ${log}`));
      }
    });
  });

  const superuserUrl = `postgres://postgres@127.0.0.1:${port}/postgres`;
  const stop = async () => {
    try {
      execFileSync(pgCtl, ["-D", dataDir, "-m", "fast", "stop"], { stdio: "pipe" });
    } catch {
      /* already stopped */
    }
    const deadline = Date.now() + 5_000;
    let last: unknown;
    while (Date.now() < deadline) {
      try {
        fs.rmSync(dataDir, { recursive: true, force: true });
        last = undefined;
        break;
      } catch (e) {
        last = e;
        await new Promise((r) => setTimeout(r, 150));
      }
    }
    if (last && fs.existsSync(dataDir)) {
      /* Windows may hold the datadir briefly; tests already finished. */
    }
  };

  return {
    port,
    dataDir,
    superuserUrl,
    appUrl: `postgres://tavo_app@127.0.0.1:${port}/postgres`,
    migratorUrl: `postgres://tavo_migrator@127.0.0.1:${port}/postgres`,
    stop,
  };
}

export async function waitForPg(url: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  let last: unknown;
  while (Date.now() < deadline) {
    const c = new Client({ connectionString: url });
    try {
      await c.connect();
      await c.end();
      return;
    } catch (e) {
      last = e;
      await c.end().catch(() => undefined);
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  throw last;
}
