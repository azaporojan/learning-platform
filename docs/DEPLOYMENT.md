# Deployment on Dokploy — runbook

**URL:** https://learning.bsf.md · **Deployed from:** every push/merge to `main`

The Learning Platform runs as **one container** on the Dokploy host (`https://dokploy.bsf.md`):
Express serves the API under `/api`, Socket.IO under `/socket.io`, and the built React client at `/`
(same origin, so the `HttpOnly; SameSite=Strict` session cookie just works). Data lives in a dedicated
database on the **shared PostgreSQL** service; uploads live on a Docker volume.

| | Value |
|---|---|
| Dokploy project / environment | `Learning Platform` (`IpqeEf033j2hBJvtEOm3L`) / `production` (`D6Wl3rulrLVTdT3kys_jE`) |
| Application | **Learning Platform** (`applicationId tf5ZCaPpA3nFcxC1rcjpx`, appName `learning-platform-dhh8ns`) |
| Source | Docker image `ghcr.io/azaporojan/learning-platform:latest` (moving tag; `:<sha>` for rollback) |
| Deployed by | push to `main` → `deploy` job → `DOKPLOY_WEBHOOK_URL` |
| Domain | `learning.bsf.md` → container port 3001, Let's Encrypt |
| Database | `learning_platform` / role `learning_platform` on the shared Postgres (`common-stuff-postgres-vmlpfq:5432`, project **Infrastructure**) |
| Uploads | volume `learning-platform-uploads` mounted at `/app/server/uploads` |
| Health check | `GET /api/health` → `{"status":"ok"}` (Docker `HEALTHCHECK`) |
| Rollback | redeploy a previous `:<sha>` tag from the Dokploy UI |

## Pipeline (`.github/workflows/ci-cd.yml`)

```
PR → main                      push main
    │                              │
    ▼                              ▼
  ci  ∥  claude-review           ci ──► build ──► deploy
  (client tsc+vite build,        (image :latest + :<sha> → GHCR,
   server syntax check + tests    POST Dokploy webhook)
   against a Postgres service,
   Trivy)
```

`ci` gates every leg. The `deploy` job **fails** when `DOKPLOY_WEBHOOK_URL` is missing (a silent
non-deploy is worse than red). SonarCloud runs as *Automatic Analysis* on the SonarCloud side, so
there is no Sonar step in CI (CI-based and automatic analysis are mutually exclusive).

### GitHub repository secrets

| Secret | Used by | Value |
|---|---|---|
| `DOKPLOY_WEBHOOK_URL` | `deploy` | Dokploy → project Learning Platform → application → **Deployments** tab → *Webhook URL* (`https://dokploy.bsf.md/api/deploy/<token>`). |
| `CLAUDE_CODE_OAUTH_TOKEN` | `claude-review.yml` | Token from `claude setup-token`; the [Claude GitHub App](https://github.com/apps/claude) must be installed on the repo. Advisory only. |
| `DOKPLOY_DASHBOARD_URL` | `rollback` (manual) | `https://dokploy.bsf.md` — informational only. |

`GITHUB_TOKEN` (automatic) pushes the image to GHCR. Dokploy pulls it with the GHCR credentials
stored on the application (Provider tab); if the package is made **public** those can be removed.

## First-time bring-up checklist

1. **Create the database and app role** on the shared Postgres — run
   [`scripts/sql/create-database.sql`](../scripts/sql/create-database.sql) as the `postgres`
   superuser (instructions in the file header; the password is passed as a `psql` variable, never
   committed). The server applies its own migrations (`server/db/migrations/`) on first start.
2. **Fill in the secrets** in Dokploy → *Learning Platform* → **Environment**: every `CHANGE_ME` in
   `DB_PASSWORD` (same value as step 1), `EMAIL_USER` / `EMAIL_PASS` (Gmail app password — login
   codes are sent by email, so this is required for anyone to log in), `BOOTSTRAP_ADMIN_EMAIL`
   (the email you will register with; that account becomes admin automatically). `JWT_SECRET` is
   already a random value; the non-secret values (`DB_HOST/PORT/NAME/USER`, `FRONTEND_URL`,
   `UPLOADS_DIR`, `PORT`, `NODE_ENV`) are set.
3. **Add `DOKPLOY_WEBHOOK_URL`** (and `CLAUDE_CODE_OAUTH_TOKEN`) to the GitHub repo secrets.
4. **Merge to `main`.** CI pushes `ghcr.io/azaporojan/learning-platform:latest` and POSTs the
   webhook; Dokploy pulls and starts the container. The first deploy issues the Let's Encrypt
   certificate for `learning.bsf.md` (wildcard DNS for the bsf.md zone already points at the VPS).
   If the webhook secret was not set yet, press **Deploy** in Dokploy once the image exists.
5. **Verify:** `curl -s https://learning.bsf.md/api/health` → `{"status":"ok"}`; open the site,
   register with the bootstrap admin email, log in with the emailed code.

## Day-2 operations

- **Redeploy the current `:latest` manually:** Dokploy → *Learning Platform* → **Deploy**, or
  `POST https://dokploy.bsf.md/api/application.deploy {"applicationId":"tf5ZCaPpA3nFcxC1rcjpx"}`
  with an `x-api-key` header.
- **Roll back:** Dokploy → **Deployments** → pick an earlier deployment → *Rollback*, or set the
  image to `ghcr.io/azaporojan/learning-platform:<sha>` and deploy.
- **Promote another admin:** either set `BOOTSTRAP_ADMIN_EMAIL` before they register, or use the
  admin UI (Users → role), or from the container terminal:
  `node scripts/promote_admin.js user@example.com`.
- **Schema changes:** add a new `server/db/migrations/NNN_name.sql` (forward-only; never edit an
  applied file). It is applied automatically on the next start.
- **Backups:** the shared Postgres has a Dokploy backup schedule for other databases — add
  `learning_platform` to it (Infrastructure → postgres → Backups). Uploads are in the
  `learning-platform-uploads` volume; back it up with the rest of `/var/lib/docker/volumes`.
- **Reset the database:** as `postgres`: `DROP DATABASE learning_platform;` then re-run
  `scripts/sql/create-database.sql`; the next start re-applies all migrations.

## Local development

```bash
docker compose up -d                 # PostgreSQL 16 on localhost:5432 (learning/learning)
cd server && cp .env.example .env    # set JWT_SECRET (>= 32 chars); email can stay empty (codes are logged)
npm install && npm run dev           # API on http://localhost:3001/api
cd ../client && cp .env.example .env # VITE_API_URL=http://localhost:3001/api
npm install && npm run dev           # client on http://localhost:3000
```

Run the tests with a database available: `cd server && DB_NAME=learning npm test` (the
integration test **drops and recreates** the `public` schema of the database it is pointed at —
use a scratch database such as `learning_test`).

## Troubleshooting

| Symptom | Check |
|---|---|
| `deploy` job red: "DOKPLOY_WEBHOOK_URL secret is not set" | Copy the Webhook URL from Dokploy → Deployments and add the repo secret; re-run the job. |
| Dokploy deploy fails with `manifest unknown` / `denied` | No `:latest` tag yet (merge to `main` first) or the GHCR credentials on the Provider tab are invalid / the package is private. |
| Container exits immediately: `JWT_SECRET must be set...` | Set a 32+ char `JWT_SECRET` in the Environment tab. |
| Container exits: `Database migration failed` / `password authentication failed` | `DB_PASSWORD` differs from the one used in `create-database.sql` (`ALTER ROLE learning_platform PASSWORD ...`), or the DB was not created. |
| Login says "Code sent" but no email arrives | `EMAIL_USER`/`EMAIL_PASS` unset (codes are only logged) or the Gmail app password is wrong — see container logs. |
| Uploads disappear after a redeploy | The `learning-platform-uploads` volume mount is missing (Advanced → Volumes). |
| Certificate not issued | Cloudflare proxy must allow the HTTP-01 challenge (same setup as the other `*.bsf.md` apps); check Traefik logs in Dokploy. |
