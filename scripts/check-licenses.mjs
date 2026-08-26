import { collectProductionLicenses, LICENSE_ALLOWLIST } from "./prod-licenses.mjs";

const merged = collectProductionLicenses();
if (merged.size === 0) {
  process.stderr.write("license check found no production packages\n");
  process.exit(1);
}
const allow = new Set(LICENSE_ALLOWLIST);
let failed = false;
for (const [pkg, info] of [...merged.entries()].sort()) {
  if (!allow.has(info.license)) {
    failed = true;
    process.stderr.write(`disallowed or unknown license ${info.license} for ${pkg}\n`);
  }
}
if (failed) process.exit(1);
