import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectProductionLicenses } from "./prod-licenses.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const merged = collectProductionLicenses();
if (merged.size === 0) {
  process.stderr.write("no production packages for notices\n");
  process.exit(1);
}

const unknown = [...merged.entries()].filter(([, v]) => v.license === "UNKNOWN" || !v.license);
if (unknown.length > 0) {
  process.stderr.write(`UNKNOWN license for: ${unknown.map(([k]) => k).join(", ")}\n`);
  process.exit(1);
}

const lines = [
  "# Third-party notices",
  "",
  "Generated from `npm ls --omit=dev --all --json --package-lock-only` and each installed package's `package.json` `license` field.",
  "Regenerate with `npm run notices`. Do not invent license names.",
  "",
  `Generated: ${new Date().toISOString().slice(0, 10)}`,
  "",
];

for (const name of [...merged.keys()].sort()) {
  const info = merged.get(name);
  if (!info) continue;
  lines.push(`## ${name}`);
  lines.push("");
  lines.push(`- License: ${info.license}`);
  if (info.resolved) {
    lines.push(`- Resolved: ${info.resolved}`);
  }
  lines.push("");
}

writeFileSync(path.join(root, "THIRD_PARTY_NOTICES.md"), lines.join("\n"), "utf8");
