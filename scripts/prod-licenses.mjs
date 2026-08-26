import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const LICENSE_ALLOWLIST = [
  "MIT",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "PostgreSQL",
];

function pkgDir(name) {
  const segs = name.startsWith("@") ? name.split("/") : [name];
  return path.join(root, "node_modules", ...segs);
}

function licenseFromName(name) {
  const pkgFile = path.join(pkgDir(name), "package.json");
  if (!existsSync(pkgFile)) return "UNKNOWN";
  const pkg = JSON.parse(readFileSync(pkgFile, "utf8"));
  if (typeof pkg.license === "string") return pkg.license;
  if (Array.isArray(pkg.licenses)) {
    return pkg.licenses
      .map((l) => (typeof l === "string" ? l : l.type))
      .filter(Boolean)
      .join(" OR ");
  }
  return "UNKNOWN";
}

function walk(node, nameFromKey, acc) {
  if (!node || typeof node !== "object") return;
  const name = typeof node.name === "string" ? node.name : nameFromKey;
  const version = node.version;
  if (name && version && name !== "tavo" && !name.startsWith("@tavo/")) {
    acc.set(`${name}@${version}`, {
      license: licenseFromName(name),
      resolved: typeof node.resolved === "string" ? node.resolved : undefined,
    });
  }
  const deps = node.dependencies;
  if (deps && typeof deps === "object") {
    for (const [depName, child] of Object.entries(deps)) {
      walk(child, depName, acc);
    }
  }
}

export function collectProductionLicenses() {
  const result = spawnSync(
    "npm",
    ["ls", "--omit=dev", "--all", "--json", "--package-lock-only"],
    { cwd: root, encoding: "utf8", shell: true },
  );
  if (!result.stdout) {
    throw new Error(result.stderr || "npm ls produced no output");
  }
  const tree = JSON.parse(result.stdout);
  const merged = new Map();
  walk(tree, tree.name, merged);
  return merged;
}
