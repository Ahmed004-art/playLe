# Local Development Infrastructure

Docker Compose configuration for PostgreSQL and Redis — local development
only. No Kubernetes, no cloud infrastructure (see `CLAUDE.md`, "avoid
over-engineering").

## Commands

Run from the repo root (these wrap `docker compose -f
infrastructure/docker/docker-compose.yml`):

```bash
npm run docker:up        # start Postgres + Redis (detached)
npm run docker:down      # stop containers (keeps data volumes)
npm run docker:restart   # down then up
npm run docker:logs      # follow logs from both services
npm run docker:reset     # stop containers AND delete data volumes, then start fresh
```

Or directly:

```bash
docker compose -f infrastructure/docker/docker-compose.yml up -d
docker compose -f infrastructure/docker/docker-compose.yml down
docker compose -f infrastructure/docker/docker-compose.yml logs -f
docker compose -f infrastructure/docker/docker-compose.yml down -v   # reset (destroys data)
```

## Services

| Service | Image | Default Port | Default Credentials |
|---|---|---|---|
| PostgreSQL | `postgres:16-alpine` | `5432` | user `playle`, password `playle_dev_password`, db `playle_dev` |
| Redis | `redis:7-alpine` | `6379` | none (no auth locally) |

Override any of these via a `.env` file in this directory — see
`.env.example`. **These default credentials are for local development
only** and must never be reused in staging/production (see
`docs/architecture/SECURITY.md`).

## Resetting the Development Database

```bash
npm run docker:reset
```

This stops the containers, deletes the named volumes
(`playle_postgres_data`, `playle_redis_data`), and starts fresh containers.
After a reset, re-run migrations:

```bash
npm run db:migrate
```

## Connecting Manually

```bash
docker exec -it playle-postgres psql -U playle -d playle_dev
docker exec -it playle-redis redis-cli
```
