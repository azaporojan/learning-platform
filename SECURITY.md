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
| 18 | Password guessing was limited per IP only: an attacker rotating IPs could keep testing one account. A correct password is confirmed before the email-code step, so a guessed password could then be tried on the student's other sites | High | Per-account lock: 10 wrong passwords lock the account for 15 minutes (on top of the per-IP limit). While locked, every attempt — even the right password — gets the same 401 as an unknown email, in the same time, so the lock reveals neither the account nor a correct guess; the owner is emailed when the lock starts. Wrong "current password" attempts on `PUT /me/password` count toward the same lock (a stolen session cannot brute-force it), and locking voids any login code already sent. Trade-off: anyone who knows an email can trigger the lock (an admin can lift it early with `POST /api/users/:id/unlock`) |
| 19 | Login timing revealed which emails have an account (unknown email answered without running bcrypt) | Medium | Unknown emails are checked against a dummy bcrypt hash; both cases return the same 401 body in the same time |
| 20 | bcrypt reads only the first 72 bytes: passwords of up to 128 characters were accepted and silently truncated | Medium | Superseded by #27: scrypt has no input limit (passwords up to 256 characters) |
| 21 | bcrypt cost 10 | Low | Superseded by #27 |
| 22 | Any 8+ character password was accepted (`password123`, `12345678`, the user's own name) | High | Common passwords and name/email-based passwords are refused, and new passwords are checked against Have I Been Pwned (k-anonymity: only 5 hex characters of the SHA-1 leave the server; fails open; `PASSWORD_BREACH_CHECK=false` disables it) |
| 23 | Users could not change their password, and a stolen session cookie stayed valid for its full 24 h | High | `PUT /api/me/password` (needs the current password): bumps `users.session_version`, which every session cookie and socket carries, so all other devices are signed out at once; the user is emailed |
| 24 | The emailed login code was stored in clear in `users.login_code` | Low | Stored as HMAC-SHA256 under `PASSWORD_PEPPER` (a bare hash of a 6-digit code is reversed instantly); compared in constant time |
| 25 | Login matched the email case-sensitively, and the admin editor stored emails as typed | Low | Emails are trimmed and lowercased everywhere; migration `010` lowercases existing rows (skipping any that would collide) |
| 26 | JWT verification did not pin the algorithm | Low | `HS256` only |
| 27 | A stolen database (dump, backup, SQL injection) exposed bcrypt hashes to unlimited offline guessing, so weak or reused passwords could be recovered and tried elsewhere | High | Hashes are **sealed**: scrypt (N=2^16, r=8, p=2 — 64 MiB per guess) then AES-256-GCM-encrypted with `PASSWORD_PEPPER`, a key held only in the server environment (migration `009`, `server/passwords.js`). The database alone holds nothing to attack. Existing bcrypt hashes are sealed at startup without needing the password, and become scrypt at the user's next login. Production refuses to start without the key, and also when stored hashes are sealed with a key it does not have (instead of failing every login and locking everyone out); it rotates via `PASSWORD_PEPPER_PREVIOUS` |

| 28 | (new feature) Lesson materials must not become a way around the phase gates or a way to host pages on this origin | — | Stored under `uploads/lesson-files/`, which the public `/api/uploads` route refuses (404); read only through `/api/lesson-files/:id/view|download`, which apply the lesson's phase gates. Allow-list PDF / DOC(X) / PPT(X) / TXT / MD with a content check (PDF magic, Office container signatures, no NUL bytes in text), so an HTML file renamed `.pdf` is refused. `view` serves PDF as `application/pdf` and TXT/MD as `text/plain` with `nosniff` and a `sandbox` CSP; the app renders Markdown without raw HTML |
| 30 | (review) Startup cleanup deleted lesson files without a DB row — after restoring an older DB backup that would destroy newer materials | Low | Such files are moved to `lesson-files/.orphaned/` and logged, never deleted |
| 29 | Multipart file names were decoded as latin1 (`Temă` → `TemÄƒ`) | Low | Lesson files and task submissions keep UTF-8 names |

### What a stolen database does and does not give

| The attacker has | Passwords |
|---|---|
| The database or a backup only | Safe: each hash is encrypted with a key that is not in the database; there is nothing to run guesses against |
| The database **and** `PASSWORD_PEPPER` (full server compromise) | Every guess costs 64 MiB and ~0.3 s of scrypt per account; passwords that are common, breached, or based on the name/email were refused at creation, so only long-shot guesses remain |
| Emails, names, stars, submissions, course data | Not protected by this — they are ordinary rows |

Keep `PASSWORD_PEPPER` out of every place the database goes (backups, dumps, staging copies),
and keep a copy in a password manager: without it, no existing password can be verified.

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
- Passwords: scrypt + AES-256-GCM sealing under `PASSWORD_PEPPER`, 8–256 characters, no
  common/breached/name-based passwords (`server/passwords.js`). Password hashes are never selected into an API response (every user
  listing names its columns), and nothing logs request bodies. Without SMTP, a dev/CI server
  prints login codes to its log only with `LOG_LOGIN_CODES=true` (never in production, never by
  default).
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
