import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "8.30.1";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const ARTIFACTS = {
  "linux-x64": {
    file: `gitleaks_${VERSION}_linux_x64.tar.gz`,
    sha256: "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb",
    extract: "tar",
    bin: "gitleaks",
  },
  "win32-x64": {
    file: `gitleaks_${VERSION}_windows_x64.zip`,
    sha256: "d29144deff3a68aa93ced33dddf84b7fdc26070add4aa0f4513094c8332afc4e",
    extract: "zip",
    bin: "gitleaks.exe",
  },
};

function platformKey() {
  const plat = process.platform;
  const arch = process.arch;
  if (plat === "linux" && arch === "x64") return "linux-x64";
  if (plat === "win32" && arch === "x64") return "win32-x64";
  throw new Error(`gitleaks helper has no artifact for ${plat}-${arch}; install gitleaks ${VERSION} on PATH`);
}

async function ensureBinary() {
  const onPath = process.env["GITLEAKS_BIN"];
  if (onPath && existsSync(onPath)) return onPath;
  const key = platformKey();
  const spec = ARTIFACTS[key];
  const cache = path.join(os.tmpdir(), "tavo-gitleaks", VERSION);
  const binPath = path.join(cache, spec.bin);
  if (existsSync(binPath)) return binPath;
  mkdirSync(cache, { recursive: true });
  const url = `https://github.com/gitleaks/gitleaks/releases/download/v${VERSION}/${spec.file}`;
  const archive = path.join(cache, spec.file);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed ${res.status} ${url}`);
  writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
  const hash = createHash("sha256").update(readFileSync(archive)).digest("hex");
  if (hash !== spec.sha256) {
    throw new Error(`gitleaks checksum mismatch for ${spec.file}: got ${hash}`);
  }
  if (spec.extract === "tar") {
    execFileSync("tar", ["-xzf", archive, "-C", cache], { stdio: "inherit" });
  } else {
    execFileSync("tar", ["-xf", archive, "-C", cache], { stdio: "inherit" });
  }
  if (process.platform !== "win32") {
    chmodSync(binPath, 0o755);
  }
  return binPath;
}

const bin = await ensureBinary();
const config = path.join(ROOT, ".gitleaks.toml");

function detect(args) {
  execFileSync(bin, args, { stdio: "inherit", cwd: ROOT });
}

// Git history reachable from HEAD (CI uses fetch-depth: 0). Then the working tree
// so uncommitted files are scanned too. Never rely on --no-git alone in CI.
if (existsSync(path.join(ROOT, ".git"))) {
  detect(["detect", "--source", ROOT, "--redact", "--config", config, "--exit-code", "1"]);
}
detect([
  "detect",
  "--source",
  ROOT,
  "--no-git",
  "--redact",
  "--config",
  config,
  "--exit-code",
  "1",
]);

