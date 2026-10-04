# @playle/config

Shared TypeScript tooling configuration.

- `typescript/tsconfig.base.json` — strict base compiler options available
  for a TypeScript app/package to extend. `apps/api` and `apps/admin`
  currently keep their framework-generated tsconfigs (NestJS/Next.js both
  require specific compiler options their tooling depends on) rather than
  extending this file; it exists so new TypeScript packages that don't
  have framework constraints have a single strict baseline to start from.
- `prettier/index.js` — the Prettier config re-exported by the root
  `.prettierrc.cjs`, applied repo-wide.
