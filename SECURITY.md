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
| 8 | 6-digit login code could be brute-forced (no attempt limit, no rate limit) | High | Rate limiting on `/login`, `/verify-code`, `/register`, `/me/password` (20 / 15 min per IP, `AUTH_RATE_LIMIT`), max 5 wrong codes per login, constant-time compare, CSPRNG code. |
| 9 | Socket.IO broadcast every chat message, notification and typing event to **all** connected clients | High | Sockets authenticate with the session cookie; events go to `user:<id>` / `chat:<id>` rooms only. The client-supplied `userId` for presence is ignored. |
| 10 | User-controlled text (names, task titles, rejection comments) interpolated into HTML emails | Low | Escaped with `escapeHtml`. |
| 11 | Internal error messages (`err.message`) returned to clients | Low | Generic error bodies; details stay in the logs. |
| 12 | `avatar_url` accepted any string (e.g. external tracking URLs) | Low | Must be a path under `/uploads/`. |
| 13 | No security headers, no `trust proxy` behind Traefik | Low | `helmet`, `trust proxy`, JSON body limit. |
| 14 | Vulnerable dependencies (`bcrypt` 5 → node-tar, `ws`, `socket.io-parser`, `nodemailer` 7, `react-router` 7.11) | High | Upgraded; `npm audit --omit=dev` is clean for both packages. |
| 15 | A default admin (`admin@learning.dev` / `admin123`) was seeded by a dev SQL script | Medium | Removed with the MySQL scripts; the admin is bootstrapped via `BOOTSTRAP_ADMIN_EMAIL`. |
| 16 | SonarCloud: bcrypt hash of a default admin committed in `setup_dev_extras.sql` (blocker), `Math.random` for login codes and upload names, 100 MB upload limit, filesystem-oracle route `/submissions/:filename` | Medium | All removed/replaced (CSPRNG, 25 MB default, route deleted). |
| 17 | Client TypeScript build was broken (`class=` instead of `className=`, stale types) so CI could not type-check | Low | Fixed; `tsc && vite build` passes and gates CI. |

## Password review (2026-10-08)

| # | Finding | Severity | Fix (`server/passwords.js`, `server/index.js`, migration `008`) |
|---|---|---|---|
| 18 | Password guessing was limited per IP only: an attacker rotating IPs could keep testing one account. A correct password is confirmed before the email-code step, so a guessed password could then be tried on the student's other sites | High | Per-account lock: 10 wrong passwords lock the account for 15 minutes (on top of the per-IP limit) |
| 19 | Login timing revealed which emails have an account (unknown email answered without running bcrypt) | Medium | Unknown emails are checked against a dummy bcrypt hash; both cases return the same 401 body in the same time |
| 20 | bcrypt reads only the first 72 bytes: passwords of up to 128 characters were accepted and silently truncated | Medium | Passwords over 72 UTF-8 bytes are refused |
| 21 | bcrypt cost 10 | Low | Cost 12; older hashes are upgraded on the next successful login |
| 22 | Any 8+ character password was accepted (`password123`, `12345678`, the user's own name) | High | Common passwords and name/email-based passwords are refused, and new passwords are checked against Have I Been Pwned (k-anonymity: only 5 hex characters of the SHA-1 leave the server; fails open; `PASSWORD_BREACH_CHECK=false` disables it) |
| 23 | Users could not change their password, and a stolen session cookie stayed valid for its full 24 h | High | `PUT /api/me/password` (needs the current password): bumps `users.session_version`, which every session cookie and socket carries, so all other devices are signed out at once; the user is emailed |
| 24 | The emailed login code was stored in clear in `users.login_code` | Low | Only its SHA-256 is stored; codes are compared in constant time |
| 25 | Login matched the email case-sensitively, and the admin editor stored emails as typed | Low | Emails are trimmed and lowercased everywhere |
| 26 | JWT verification did not pin the algorithm | Low | `HS256` only |

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
- Passwords: bcrypt cost 12, 8–72 bytes, no common/breached/name-based passwords
  (`server/passwords.js`). Password hashes are never selected into an API response (every user
  listing names its columns), and nothing logs request bodies. Without SMTP outside production
  the server prints login codes to its log so you can still sign in; in production it never does.
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
- Session cookies last 24 h. They are revoked early only by a password change (session version);
  logging out clears the cookie on that device only.
- There is no self-service "forgot password" flow yet: an admin deletes the account and the user
  registers again. A reset link by email (hashed single-use token, 30 min expiry) is the next step.
- `BOOTSTRAP_ADMIN_EMAIL` makes the first account registered with that email an admin: register
  that account right after deploying, then remove the variable.
- `POST /api/register` answers 409 for an email that is already registered (needed for a usable
  sign-up form); it is rate-limited like the other credential endpoints.
- The `/api/users` leaderboard (names, stars, avatars) is public; make it login-only if the platform
  should not expose student names to visitors.
