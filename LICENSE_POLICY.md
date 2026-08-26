# License policy

Production and distributed tooling dependencies may be added automatically only if the **resolved package version** uses an allowlisted license:

- MIT
- Apache-2.0
- BSD-2-Clause
- BSD-3-Clause
- ISC
- PostgreSQL License

All other licenses (including AGPL, GPL, LGPL, SSPL, BSL, unknown, UNLICENSED) require explicit written approval.

This applies to direct and production transitive dependencies. CI must fail on disallowed or missing licenses unless a dated waiver exists.

Before `npm install <package>`: verify the package license and production transitives. Do not copy code of unknown provenance.

Do not add Turborepo (MPL-2.0) without approval. Phase 1 uses npm workspaces.

Verified CI/tooling licenses before add:

- ESLint, `@eslint/js`, `typescript-eslint`: MIT
- Gitleaks CLI: MIT (do not use `gitleaks/gitleaks-action`; that action is not allowlisted)
- `@cyclonedx/cyclonedx-npm`: Apache-2.0
- `license-checker`: BSD-3-Clause

