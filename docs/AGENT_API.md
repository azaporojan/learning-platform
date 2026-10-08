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
| `requires_previous` | `true` (default): locked until every mandatory task of the previous phase is approved. A previous phase with no mandatory tasks (e.g. one you are still filling) counts as done, so it never blocks the next one |
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
| `lessons[].study_sets[]` | no | 0–20 quizzes / flashcard decks, same shape as `POST /api/study-sets` without `lessonId` (see §5b) |
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
      "tasks": [ { "id": 40, "title": "Install Git…", "type": "mandatory", "order_index": 1 } ],
      "study_sets": [] }
  ],
  "counts": { "lessons": 2, "tasks": 4, "study_sets": 0 }
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
| `DELETE /api/paths/:id` | — | Delete a path and everything in it (its course is renumbered) |

Removed in this release: `POST /api/paths/:id/unlock` (the old stars-only unlock). Access to a phase is
now decided by course enrolment and the phase gates above; the call answers 404.
| `POST /api/lessons` | `{pathId, title, description?, x, y, order, parentId?}` | Create one lesson (you supply the graph position) |
| `PUT /api/lessons/:id` | `{title, description?, order?, x?, y?, parentId?}` | Update a lesson; the optional graph fields move it without deleting it (keeps tasks and submissions) |
| `DELETE /api/lessons/:id` | — | Delete a lesson and its tasks |
| `GET /api/lessons/:id/script` | — | `{id, title, script, script_updated_at}` — the teacher's Markdown script (admin only; never shown to students) |
| `PUT /api/lessons/:id/script` | `{script, expected_script_updated_at?}` | Save the script (Markdown, ≤ 200 000 chars) → `{success, script_updated_at}`. With `expected_script_updated_at` (the value last read, `null` if none) the write is atomic and a newer server copy answers `409` instead of being overwritten; **omit the field and the save overwrites unconditionally** (the app always sends it) |
| `POST /api/tasks` | `{lessonId, title, type?, xp?, deadline?, x, y, order?, description?}` | Create one task; emails students who unlocked the path |
| `GET /api/tasks/:id` | — | Task details |
| `PUT /api/tasks/:id` | `{title, type, xp?, deadline?, description?, order?, x?, y?}` | Update a task; `order`/`x`/`y` move it on the graph |
| `DELETE /api/tasks/:id` | — | Delete a task |
| `GET /api/admin/users` | — | All users (admin view) |
| `GET /api/admin/submissions` | `?status=pending\|approved\|rejected\|all&limit=&before=` | Review inbox → `{submissions: [{id, status, submitted_at, is_viewed, file_name, file_size, comment, user_id, user_name, user_avatar, task_id, task_title, task_type, xp_reward, lesson_id, lesson_title, path_id, path_name, phase_order, course_id, course_name}], counts: {pending, approved, rejected} | null, limit, has_more, next_cursor}`. Newest first, `limit` rows per page (default 50, max 500); pass `before=<next_cursor>` for the next page (`counts` is only on the first page; a malformed `before` is a 400); `comment` is a 300-char preview (full text on `GET /api/tasks/:id/submissions`) |
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

## 5b. Quizzes and flashcards (study sets)

A lesson can carry **study sets**: quizzes and flashcard decks for prep. They appear as extra
bubbles under the lesson on the course road (after its tasks), purple for quizzes and pink for
flashcards. They never lock the next lesson and grant no stars. A student sees a set as soon as
its phase is open to them; the API answers `403 {"lockReasons":[…]}` for a set in a locked phase.

| Method & path | Body | Purpose |
|---|---|---|
| `GET /api/lessons/:id/study-sets` | — | All sets of a lesson, with their items and the caller's `progress` |
| `POST /api/study-sets` | `{lessonId, kind, title, description?, items, order?}` | Create a set (appended after the lesson's other sets unless `order` is given) → `201` with the set |
| `GET /api/study-sets/:id` | — | One set with its items |
| `PUT /api/study-sets/:id` | `{title?, description?, items?, order?}` | Update; `items` **replaces the whole list**. `kind` cannot change |
| `DELETE /api/study-sets/:id` | — | Delete the set and the students' results on it |
| `POST /api/study-sets/:id/attempts` | quiz: `{answers}` · flashcards: `{known}` | Record a practice run (what the app does for students) |

`kind` is `"quiz"` or `"flashcards"`. Items, by kind (Markdown is allowed in every text field and
is rendered without raw HTML, so code such as `` `final` `` or fenced blocks displays well):

```json
{ "lessonId": 12, "kind": "quiz", "title": "Java basics check", "items": [
  { "question": "Which keyword declares a constant in Java?",
    "options": ["`const`", "`final`", "`static`"], "correct": 1,
    "explanation": "`final` prevents reassignment." },
  { "question": "Which of these are primitive types?",
    "options": ["int", "String", "boolean"], "correct": [0, 2] }
] }
```

```json
{ "lessonId": 12, "kind": "flashcards", "title": "Java terms", "items": [
  { "front": "JDK", "back": "Java Development Kit: compiler + JRE + tools" }
] }
```

| Item field | Notes |
|---|---|
| `question` | Required, ≤ 4000 chars |
| `options` | 2–10 non-empty strings, ≤ 1000 chars each |
| `correct` | 0-based index into `options`, or an array of indexes. More than one makes it a "select all that apply" question; the answer counts only when the selection matches exactly |
| `explanation` | Optional, ≤ 4000 chars, shown after grading |
| `front` / `back` | Required, ≤ 4000 chars each |

Limits: 300 items per set, 20 sets per lesson. Validation errors come back as
`400 {"error":"Invalid study set","details":[...]}`, one message per problem.

**Who sees the answers.** Admin callers (API keys included) get every field. Students get quiz
items as `{question, options, multiple}`: `correct` and `explanation` stay on the server, which grades
`POST /attempts` with `{"answers": [1, [0, 2], null, …]}` (one entry per question) and returns
`{score, total, results: [{correct, selected, correct_options, explanation}], progress}`. A flashcard
run posts `{"known": n}`, the number of cards known on first sight. `progress` is
`{best_score, last_score, total, attempts}`. A set counts as mastered (✓ on the road) when
`best_score` equals the current number of items. When an edit changes the number of items, the old best score stops counting and the next run starts a new one.

`GET /api/courses/:id` lists each lesson's `study_sets` as `{id, lesson_id, kind, title, description,
order_index, item_count, progress}`, without items. Read a set with `GET /api/study-sets/:id`
before you rewrite it with `PUT`.

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

For practice material on lessons that already exist:

> Find the lesson ids with `GET $LEARNING_API_URL/courses/<courseId>` (phases → lessons; each lesson
> lists its existing `study_sets`). For each lesson, write a 5–10 question quiz and a flashcard deck
> covering its key terms, as described in §5b of `docs/AGENT_API.md`, and `POST /study-sets`. To
> revise an existing set, `GET /study-sets/:id`, edit the items, then `PUT` the full `items` list.

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
