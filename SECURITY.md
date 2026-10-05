# Security

## Review before the first public deployment (2026-09-27)

The pre-deployment review found and fixed the following (all in `server/index.js` unless noted):

| # | Finding | Severity | Fix |
|---|---|---|---|
| 1 | `JWT_SECRET` fell back to the literal `secret_fallback_dev` when unset — anyone could forge an admin session cookie | Critical | The server refuses to start in production without a `JWT_SECRET` of ≥ 32 chars. |
| 2 | `POST/PUT/DELETE /lessons`, `POST/PUT/DELETE /tasks` had **no authentication at all** — any visitor could create or delete course content | Critical | `authenticateToken` + `requireAdmin` (role re-read from the DB on every request). |
| 3 | `POST /tasks/:id/submit` trusted a `userId` from the request body (submit as anyone) and required no login | High | Login required; the user id comes from the session. |
| 4 | `POST /upload-image` was anonymous and accepted HTML/JS; uploads were served inline from the same origin → stored XSS / phishing pages hosted on the site | High | Login required; the image endpoint accepts JPEG/PNG/GIF only; `/api/uploads` sends non-image files as `Content-Disposition: attachment` with `nosniff`. |
| 5 | Uploaded file names were used verbatim (`../` sequences, spaces, unicode) | Medium | Names are reduced to a safe basename `[A-Za-z0-9._-]`. |
| 6 | `GET /submissions/download/:id` and `GET /submissions/:filename` let anyone download any student's file by id/name | High | Login required; only the owner or an admin may download; the by-filename route was removed. |
| 7 | `GET /tasks/:id/submissions` returned every student's submissions (with emails) to any logged-in user | Medium | Students get only their own rows; admins get all. |
| 8 | 6-digit login code could be brute-forced (no attempt limit, no rate limit) | High | Rate limiting on `/login`, `/verify-code`, `/register` (20 / 15 min per IP), max 5 wrong codes per login, constant-time compare, CSPRNG code. |
| 9 | Socket.IO broadcast every chat message, notification and typing event to **all** connected clients | High | Sockets authenticate with the session cookie; events go to `user:<id>` / `chat:<id>` rooms only. The client-supplied `userId` for presence is ignored. |
| 10 | User-controlled text (names, task titles, rejection comments) interpolated into HTML emails | Low | Escaped with `escapeHtml`. |
| 11 | Internal error messages (`err.message`) returned to clients | Low | Generic error bodies; details stay in the logs. |
| 12 | `avatar_url` accepted any string (e.g. external tracking URLs) | Low | Must be a path under `/uploads/`. |
| 13 | No security headers, no `trust proxy` behind Traefik | Low | `helmet`, `trust proxy`, JSON body limit. |
| 14 | Vulnerable dependencies (`bcrypt` 5 → node-tar, `ws`, `socket.io-parser`, `nodemailer` 7, `react-router` 7.11) | High | Upgraded; `npm audit --omit=dev` is clean for both packages. |
| 15 | A default admin (`admin@learning.dev` / `admin123`) was seeded by a dev SQL script | Medium | Removed with the MySQL scripts; the admin is bootstrapped via `BOOTSTRAP_ADMIN_EMAIL`. |
| 16 | SonarCloud: bcrypt hash of a default admin committed in `setup_dev_extras.sql` (blocker), `Math.random` for login codes and upload names, 100 MB upload limit, filesystem-oracle route `/submissions/:filename` | Medium | All removed/replaced (CSPRNG, 25 MB default, route deleted). |
| 17 | Client TypeScript build was broken (`class=` instead of `className=`, stale types) so CI could not type-check | Low | Fixed; `tsc && vite build` passes and gates CI. |

## Operating rules

- Every admin route uses `authenticateToken, requireAdmin`; every user route uses `authenticateToken`.
  Only `/api/health`, `/api/login`, `/api/verify-code`, `/api/register`, `/api/users` (leaderboard),
  `/api/paths*` and `/api/courses*` (course catalogue, read-only) are reachable without a session.
  For phases a caller has not reached (not enrolled, previous phase unfinished, stars gate),
  `GET /api/courses/:id` keeps lesson titles, summaries and task titles visible but omits the task
  briefs, and `POST /api/tasks/:id/submit` enforces the same gates server-side (403); the legacy
  read routes (`GET /api/paths/:id/details`, `GET /api/tasks/:id`) follow the same rule.
- `GET /api/users/directory` (the Users page) shows every approved user's name, role, stars and
  avatar to any logged-in user — by design, it replaces the old public leaderboard. Emails and
  approval state stay admin-only (`/api/admin/users`).
- Secrets live only in the Dokploy **Environment** tab (never in git): `JWT_SECRET` (≥ 32 random
  chars), `DB_PASSWORD`, `EMAIL_PASS`. `.env` files are git-ignored.
- The database role `learning_platform` is not a superuser and owns only its own database
  (`scripts/sql/create-database.sql`).
- The container runs as the unprivileged `node` user; only port 3001 is exposed (behind Traefik/TLS).
- Uploads: max 25 MB per file (10 MB for images; `MAX_UPLOAD_MB` / `MAX_IMAGE_UPLOAD_MB`),
  extension allow-list, random file names, never rendered inline unless JPEG/PNG/GIF.
- Dependencies: `npm audit --omit=dev` in `server/` and `client/` before releasing; Trivy runs in CI.
- API keys (`docs/AGENT_API.md`): created/revoked by admins only, stored as SHA-256 hashes,
  shown once, act as their creator and stop working when revoked or when the creator loses the
  admin role. Sent as `Authorization: Bearer`, so the session cookie/CSRF surface is untouched.
  Content imported through the API is published immediately and its descriptions are rendered as
  HTML, exactly like admin-typed content, so agent-authored paths should be reviewed by a human
  before students can unlock them (see `docs/AGENT_API.md` §5).

## Known follow-ups (not blocking deployment)

- A strict Content-Security-Policy is disabled because the client loads Tailwind and fonts from CDNs
  and `index.html` carries an `esm.sh` import map; bundle those locally and enable CSP.
- The presence list (`/api/online-users`) and global events (`leaderboard:update`, `task:*`,
  `lesson:*`) are broadcast to all logged-in users by design.
- Session cookies last 24 h and are not revocable before expiry (no server-side session store).
- The `/api/users` leaderboard (names, stars, avatars) is public; make it login-only if the platform
  should not expose student names to visitors.
