# Production deployment and Monime Live activation

PlayLe's production target is Render, described by `render.yaml` at the repository
root: the API and the admin app as web services in Frankfurt (the closest Render
region to Sierra Leone), managed PostgreSQL and a Key Value (Redis) instance, with
HTTPS and secrets handled by Render. It is a single, small setup; nothing here is
needed for local development.

Why Render: one Blueprint file creates every piece, HTTPS is automatic, secrets are
entered in its dashboard, migrations run before each deploy, and the previous deploy
can be restored from the dashboard. Free plans are unsuitable for money (free web
services sleep after 15 minutes idle, free Postgres is deleted after 30 days plus a
14-day grace period, free Key Value loses its data on restart), so the Blueprint
uses paid plans. Check Render's current pricing before creating them.

## 1. One-time setup (owner)

1. **Domain.** Use a domain you control with two subdomains, e.g.
   `api.example.com` and `admin.example.com`. Required: the admin login uses
   `SameSite=Lax` cookies, which a browser does not send between two different
   `*.onrender.com` sites.
2. **Render account** with billing, connected to the GitHub repository.
3. **Create the Blueprint**: Render dashboard > New > Blueprint > this repository.
   Render asks for every `sync: false` value:
   - `MFA_ENCRYPTION_KEY`: 64 hex characters (`openssl rand -hex 32`). Keep a copy
     in your password manager; never change it.
   - `CORS_ORIGINS`: `https://admin.example.com`
   - `NEXT_PUBLIC_API_BASE_URL`: `https://api.example.com/api/v1`
   - `MONIME_SPACE_ID`, `MONIME_API_KEY`, `MONIME_WEBHOOK_SECRET`: see section 3.
     Never reuse the Test values.
4. **Custom domains**: add `api.example.com` to `playle-api` and
   `admin.example.com` to `playle-admin` in Render, and create the DNS records
   Render shows.
5. **First admin user**: register through the API, then promote that account to
   `ADMIN` once in the database (Render Postgres shell):
   `UPDATE users SET role = 'ADMIN' WHERE email = '<your email>';`

## 2. Deploys, migrations, rollback

- Every merge to `main` deploys automatically (CI runs on the PR first).
- `preDeployCommand` applies Prisma migrations before the new version starts; a
  failing migration stops the deploy and the old version keeps running.
- Rollback: Render dashboard > service > Events > the previous deploy > Rollback.
  Migrations are additive (new tables, columns, enum values), so the previous
  version runs against the newer schema; there are no down-migrations. Never
  edit or delete an applied migration.
- Health check: `GET /api/v1/health` (503 if PostgreSQL or Redis is down).

## 3. Monime Live configuration

All in the Monime dashboard with **Live** mode (Test mode off):

| Setting | Value |
|---|---|
| Space ID | the Live Space id (`spc-...`) → `MONIME_SPACE_ID` |
| API token | a Live token (`mon_...`, no `_test_`) → `MONIME_API_KEY` |
| API base URL | `https://api.monime.io` (the same for Test and Live; the token decides) |
| Webhook URL | `https://api.example.com/api/v1/payments/webhooks/monime` |
| Webhook API release | `caph` |
| Webhook verification | HMAC (HS256); its secret → `MONIME_WEBHOOK_SECRET` (32-100 characters) |
| Webhook events | `payment_code.completed`, `payment_code.expired`, `payment_code.processed`, `payout.completed`, `payout.failed` |

With a Live token, PlayLe makes **no** Monime call until
`MONIME_LIVE_PAYMENTS_ENABLED=true` (deposit and payout creation return
"unavailable" instead).

## 4. Monitoring and alerts

- Payment problems appear in the admin app (**Payment problems** page) and are
  re-checked every 15 minutes; provider statuses are polled every 5 minutes.
- Every new problem logs a line starting `PAYMENT ALERT` at ERROR level. Configure
  a Render log stream to a log service and an alert on that text; nothing pages a
  person until this is done.

## 5. Activation (owner authorization required)

Before the first Live transaction, confirm every item:

1. Monime's written approval of PlayLe's real-money competitive-gaming use case,
   for both collections and payouts.
2. Legal decisions recorded: minimum age, jurisdictions, KYC, terms of service and
   privacy policy (none exist in this repository yet).
3. The deployment is healthy on the custom domains; the first admin can log in.
4. Live webhook created as in section 3; Live secrets entered in Render.
5. Payment problems page empty (or every item explained).
6. Owner authorization recorded. Then set `MONIME_LIVE_PAYMENTS_ENABLED=true` and
   redeploy. `REAL_MONEY_GAMING_ENABLED` and `ELIGIBILITY_POLICY_CONFIGURED` are a
   separate decision (staked matches; see ADR-021) and can stay `false` while
   deposits and withdrawals are verified.
7. First transactions: one small deposit by the owner, then one small withdrawal,
   approved in the admin app. Check the wallet, the ledger, the Payment problems
   page and the Monime dashboard after each. The deposit is credited only from a
   signed webhook whose paid amount is confirmed against Monime's payment code.

Note: Monime's Test mode does not support payouts (`/v1/payouts` returns
"Test mode is not supported for this endpoint"), so the first Live withdrawal is
also the first real end-to-end payout. Keep it small.
