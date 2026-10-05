# Agent API — creating learning content programmatically

The Learning Platform admin API can be driven by automation (an AI agent, a script, CI) with an
**API key** instead of a browser session. Typical use: have a Claude agent draft a whole learning
path (lessons + tasks) and publish it with one request.

## 1. Create an API key

In the app, as an admin: avatar menu → **API Keys** → enter a name (e.g. `Claude agent`) →
**Create key**. Copy the key immediately; only its SHA-256 hash is stored and it is never shown
again. Keys can be revoked from the same screen (revocation is immediate).

A key acts **as the admin who created it**: everything that admin can do through the API, the key
can do too. Keep it as a secret (environment variable), never in a repository.

```bash
export LEARNING_API_URL="https://learning.bsf.md/api"
export LEARNING_API_KEY="lp_…"
```

## 2. Authenticate

Send the key as a bearer token on every request:

```
Authorization: Bearer lp_…
```

No cookie or CSRF handling is needed. Requests are rate-limited (600 per 15 minutes per IP).
A revoked or unknown key, or a key whose owner is no longer an admin, gets `401 {"error":"Invalid API key"}`.

## 3. Courses and phases

Content is organised as **course → phases → lessons → tasks**. A *phase* is what the API calls a
*path* (`/api/paths`); students see all phases of a course as one continuous road. Each phase has:

| Field | Meaning |
|---|---|
| `course_id` | The course it belongs to (`null` = unassigned: an admin workspace, locked for students even through the legacy routes) |
| `order_index` | Position of the phase on the course road |
| `requires_previous` | `true` (default): locked until every mandatory task of the previous phase is approved |
| `stars_required` | Extra gate: students need this many stars (0 = none) |

Students **enrol** in a course (`POST /api/courses/:id/enroll`); only enrolled students can start
its road and they get notifications for new tasks in it. The gates are enforced by the server:
`GET /api/courses/:id` returns locked phases with their lesson titles, summaries and task titles
but without the task briefs, and `POST /api/tasks/:id/submit` answers `403 {"lockReasons":[…]}` for
a phase the student has not reached. Phases of a course are always numbered `1..n`: creating or importing a
phase appends it, and `PUT /api/paths/:id` with `order_index` (or a new `course_id`) re-sequences
the others.

| Method & path | Body | Purpose |
|---|---|---|
| `GET /api/courses` | — | List courses with phase/lesson counts, enrolment and (for students) progress |
| `GET /api/courses/:id` | — | The whole road: phases → lessons → tasks with the caller's completion flags and per-phase `locked` / `lockReasons` |
| `POST /api/courses` | `{name, description?}` | Create a course |
| `PUT /api/courses/:id` | `{name, description?}` | Update a course |
| `DELETE /api/courses/:id` | — | Delete a course; its phases are kept as unassigned |
| `POST` / `DELETE /api/courses/:id/enroll` | — | Enrol in / leave a course (as the caller) |

## 4. Import a whole path in one call (recommended)

`POST /api/admin/paths/import` creates a path with all its lessons and tasks inside a single
transaction and lays the nodes out exactly like the admin UI does (lessons left→right, each
lesson's task chain alternating above/below). Either everything is created or nothing is.

```bash
curl -sS -X POST "$LEARNING_API_URL/admin/paths/import" \
  -H "Authorization: Bearer $LEARNING_API_KEY" \
  -H "Content-Type: application/json" \
  --data @path.json
```

`path.json`:

```json
{
  "name": "Git & GitHub",
  "description": "Version control from zero to pull requests",
  "stars_required": 0,
  "courseId": 1,
  "requires_previous": true,
  "lessons": [
    {
      "title": "Repositories and commits",
      "description": "<p>What a repository is, how commits record history.</p>",
      "tasks": [
        { "title": "Install Git and configure your name/email", "type": "mandatory", "xp": 10 },
        { "title": "Create a repo with three commits", "type": "mandatory", "xp": 20, "deadline": "2026-10-15" },
        { "title": "Read: Git internals (optional)", "type": "optional", "xp": 5 }
      ]
    },
    {
      "title": "Branches and merges",
      "tasks": [
        { "title": "Create a feature branch and merge it", "xp": 20 }
      ]
    }
  ]
}
```

Fields:

| Field | Required | Notes |
|---|---|---|
| `name` | yes (new path) | Path title, ≤ 255 chars |
| `description` | no | Plain text |
| `stars_required` | no | Extra gate: stars a student needs to start the phase (default 0 = none) |
| `courseId` | no | Course the new phase is appended to (last position on its road). Omit for an unassigned phase |
| `requires_previous` | no | Lock the phase until the previous phase of the course is finished (default `true`) |
| `pathId` | instead of `name` | Append the lessons to an existing path, continuing its chain |
| `lessons[]` | yes | 1–200 lessons, in order |
| `lessons[].title` | yes | ≤ 255 chars |
| `lessons[].description` | no | HTML is allowed (the UI uses a rich-text editor) |
| `lessons[].tasks[]` | no | 0–50 tasks, in order |
| `tasks[].title` | yes | ≤ 255 chars |
| `tasks[].description` | no | HTML allowed |
| `tasks[].type` | no | `mandatory` (default) or `optional`. Mandatory tasks gate the next lesson |
| `tasks[].xp` | no | Stars granted when approved (default 10) |
| `tasks[].deadline` | no | `YYYY-MM-DD` (end of that day) or an ISO timestamp |

Response `201`:

```json
{
  "path": { "id": 3, "name": "Git & GitHub" },
  "lessons": [
    { "id": 10, "title": "Repositories and commits", "order_index": 1,
      "tasks": [ { "id": 40, "title": "Install Git…", "type": "mandatory", "order_index": 1 } ] }
  ],
  "counts": { "lessons": 2, "tasks": 4 }
}
```

Validation problems come back as `400 {"error":"Invalid import document","details":[...]}` with one
message per problem; nothing is created in that case. Students who have already unlocked the path
are **not** emailed by the import (unlike single `POST /api/tasks` calls); the graph updates live
in open browsers.

## 5. Fine-grained endpoints

All accept the same bearer header. Ids in responses are integers; `GET /api/paths` returns ids as strings.

| Method & path | Body | Purpose |
|---|---|---|
| `GET /api/paths` | — | List paths (`id`, `title`, `description`, `requiredScore`, `status`, `course_id`, `order_index`, `requires_previous`) |
| `GET /api/paths/:id/details` | — | Lessons of a path with their tasks, positions and completion flags |
| `POST /api/paths` | `{name, description?, stars_required?, course_id?, requires_previous?}` | Create an empty path (appended to the end of its course) |
| `PUT /api/paths/:id` | `{name, description?, stars_required?, course_id?, order_index?, requires_previous?}` | Update a path; the course fields are optional |
| `DELETE /api/paths/:id` | — | Delete a path and everything in it |
| `POST /api/lessons` | `{pathId, title, description?, x, y, order, parentId?}` | Create one lesson (you supply the graph position) |
| `PUT /api/lessons/:id` | `{title, description?, order?, x?, y?, parentId?}` | Update a lesson; the optional graph fields move it without deleting it (keeps tasks and submissions) |
| `DELETE /api/lessons/:id` | — | Delete a lesson and its tasks |
| `POST /api/tasks` | `{lessonId, title, type?, xp?, deadline?, x, y, order?, description?}` | Create one task; emails students who unlocked the path |
| `GET /api/tasks/:id` | — | Task details |
| `PUT /api/tasks/:id` | `{title, type, xp?, deadline?, description?, order?, x?, y?}` | Update a task; `order`/`x`/`y` move it on the graph |
| `DELETE /api/tasks/:id` | — | Delete a task |
| `GET /api/admin/users` | — | All users (admin view) |
| `GET /api/admin/api-keys` | — | List keys (names/prefixes only) |
| `POST /api/admin/api-keys` | `{name}` | Create a key (plaintext returned once) |
| `DELETE /api/admin/api-keys/:id` | — | Revoke a key |

To restructure an existing path (insert lessons between existing ones, renumber weeks) prefer
`PUT` with `order`/`x`/`y`/`parentId` over delete-and-recreate: deleting a lesson cascades to its
tasks and to every student submission on them. Students see lessons ordered by `order`, and a
lesson is locked until all mandatory tasks of every lesson before it are approved.
`scripts/restructure-weeks.mjs` is a worked example (dry-run by default, `--apply` to execute).

For the graph position convention used by `POST /lessons` / `POST /tasks`: the first lesson sits at
`x=80, y=250`; each next lesson is `+250` on x with `parentId` = previous lesson; a lesson's first
task is at `(lesson.x + 120, lesson.y ∓ 120)` (minus for odd `order`, plus for even) and each further
task `+150` on x. The import endpoint does this for you. (The course road in the UI is laid out from
`order` alone; the stored positions are kept for compatibility.)

## 6. Using it from a Claude agent

**Review before students see it.** Imported content goes live immediately, and lesson/task
descriptions are rendered as HTML in the app (the same as content typed into the rich-text editor).
An agent working from untrusted input (web pages, uploaded documents, user messages) can be
prompt-injected into publishing wrong or malicious content. Keep a human in the loop: create the
path with `stars_required` high enough that no student can open it yet (or review it as an admin
right after the import), check it in the admin UI, then lower `stars_required` via
`PUT /api/paths/:id`. Revoke the agent's key when the job is done.

Give the agent the base URL and the key as environment variables and a short instruction such as:

> You can publish learning content to the Learning Platform. Build the path as the JSON document
> described in `docs/AGENT_API.md` (path → lessons → tasks, mandatory tasks gate the next lesson,
> descriptions may contain simple HTML), then `POST $LEARNING_API_URL/admin/paths/import` with
> `Authorization: Bearer $LEARNING_API_KEY`. Check the `counts` in the response and report the
> path id. Use `GET /api/paths` first to avoid creating a path that already exists; use `pathId`
> to add lessons to an existing one.

A minimal helper the agent can run (Node 18+, no dependencies):

```bash
node -e '
const doc = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
fetch(process.env.LEARNING_API_URL + "/admin/paths/import", {
  method: "POST",
  headers: { "Authorization": "Bearer " + process.env.LEARNING_API_KEY, "Content-Type": "application/json" },
  body: JSON.stringify(doc)
}).then(async r => { console.log(r.status, await r.text()); process.exit(r.ok ? 0 : 1); });
' path.json
```
