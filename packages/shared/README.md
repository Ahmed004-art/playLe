# @playle/shared

TypeScript contracts and constants shared between `apps/api` and
`apps/admin` **only**. Not consumable by the Flutter mobile app (Dart
cannot import TypeScript packages) — see `CLAUDE.md`, "Cross-Language
Architecture Note".

- `src/constants.ts` — cross-cutting constants (currency code, platform
  fee percentage, API version, match size limits).
- `src/http.ts` — standard HTTP response/error shapes used by the API's
  global exception filter and the admin app's API client.

Run `npm run build --workspace=packages/shared` after changing anything
here (also runs automatically via the root `postinstall` script).
