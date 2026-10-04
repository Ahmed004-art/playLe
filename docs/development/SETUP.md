# Local Development Setup

## Prerequisites

| Tool | Notes |
|---|---|
| Node.js >= 22.22.2 | for `apps/api`, `apps/admin`, `packages/*` (the admin test tooling, `jsdom`, requires this floor) |
| npm | comes with Node; this repo uses npm workspaces |
| Flutter SDK (stable channel) | for `apps/mobile` |
| Android SDK + an emulator or device | for Android builds |
| Xcode (macOS only) | for iOS builds — not required on Windows/Linux |
| Docker Desktop (or Docker Engine + Compose) | for local PostgreSQL + Redis |
| Git | version control |

## 1. Clone and Install TypeScript Workspaces

```bash
git clone <repo-url> playle
cd playle
npm install
```

This installs dependencies for `apps/api`, `apps/admin`, `packages/shared`,
and `packages/config` via npm workspaces.

## 2. Start Local Infrastructure (PostgreSQL + Redis)

```bash
npm run docker:up
```

This starts PostgreSQL and Redis using
`infrastructure/docker/docker-compose.yml`. See that directory's `README.md`
for exact ports/credentials and the full set of commands (start, stop,
restart, logs, reset).

## 3. Configure Environment Variables

Copy each app's example env file and fill in local values (defaults match
the Docker Compose services):

```bash
cp apps/api/.env.example apps/api/.env
cp apps/admin/.env.example apps/admin/.env.local
```

Never commit the resulting `.env`/`.env.local` files — see `.gitignore`
and `docs/architecture/SECURITY.md`.

## 4. Generate the Prisma Client and Run Migrations

```bash
npm run db:generate
npm run db:migrate
```

## 5. Run the Backend

```bash
npm run dev:api
```

The API starts on `http://localhost:3000` by default (see
`apps/api/.env.example` for `PORT`). Health check:
`GET http://localhost:3000/api/v1/health`. Swagger docs:
`http://localhost:3000/api/docs`.

## 6. Run the Admin App

```bash
npm run dev:admin
```

Starts the Next.js admin app on `http://localhost:3001` (or Next's default
— see `apps/admin/package.json`).

## 7. Run the Mobile App

```bash
cd apps/mobile
flutter pub get
flutter run
```

Point the app at your local API by setting the development API base URL —
see `apps/mobile/lib/core/config/` for the environment configuration
strategy (development/staging/production).

## Verifying Your Setup

```bash
npm run typecheck     # apps/api + apps/admin
npm run lint           # apps/api + apps/admin
npm run test            # apps/api + apps/admin
npm run build            # apps/api + apps/admin

cd apps/mobile
flutter analyze
flutter test
flutter build apk --debug
```

All of the above should succeed on a clean checkout with infrastructure
running. If any step fails on a fresh clone, that's a setup bug — see
`docs/development/WORKFLOW.md` for how to report/fix it.
