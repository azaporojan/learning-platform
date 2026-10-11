# Learning Platform API — what you need for content work

Full reference: `docs/AGENT_API.md` in this repo (read it when you need a field this page doesn't cover).
Base URL `https://learning.bsf.md/api`, auth `Authorization: Bearer $LEARNING_API_KEY`.

Use `scripts/lp.mjs` (Node fetch) or `curl`. From the repo root:

```bash
LP=.claude/skills/course-content/scripts/lp.mjs
node $LP tree 1                          # ids of everything
node $LP get /tasks/35                   # any GET
node $LP post /study-sets quiz.json      # POST / PUT a JSON body from a file
node $LP put /tasks/35 task.json
node $LP script-get 25 script25.md       # lesson script
node $LP script-put 25 script25.md
node $LP upload 25 deck.pdf              # attach files
```

**Not Python urllib/requests**: Cloudflare answers `403 error code: 1010` to their user agent.

## Data model

```
course (1 = "QA Automation Engineer")
 └─ phase   (= "path" in the API: /api/paths)   gated by requires_previous / stars_required
     └─ lesson                                    ordered by order_index; has description (HTML), script (Markdown, admin only)
         ├─ task       homework; mandatory tasks gate the next lesson; description = Markdown
         ├─ study set  quiz | flashcards; never gate anything, no stars
         └─ file       PDF / DOCX / PPTX / TXT / MD materials (PDF, TXT, MD open in-app)
```

Ids are not stable knowledge: always start with `node $LP tree 1` and work from what it prints.

## Recipes

| Goal | Call |
|---|---|
| See everything | `node $LP tree 1` |
| New phase at the end of the course | `POST /paths {name, description, course_id: 1, requires_previous: true, stars_required: 0}` |
| Phase + lessons + tasks + study sets in one transaction | `POST /admin/paths/import` (`name`+`courseId` for a new phase, or `pathId` to append lessons to an existing one). See AGENT_API §4 |
| Append lessons to an existing phase | `POST /admin/paths/import {pathId, lessons:[…]}` |
| Insert a lesson between existing ones | create it, then `PUT /lessons/:id {order, x, y, parentId}` on it and on the following lessons; `scripts/restructure-weeks.mjs` in the repo is a worked example. Never delete-and-recreate (cascades to tasks and student submissions) |
| Edit a lesson title/description | `PUT /lessons/:id {title, description}` (send the current title back if you only change the description) |
| Homework task | `POST /tasks {lessonId, title, type, xp, deadline, description, x, y, order}` (emails enrolled students) or `PUT /tasks/:id` to edit. Read it first: `GET /tasks/:id` |
| Quiz / flashcards | `POST /study-sets {lessonId, kind, title, description, items}`; edit with `PUT /study-sets/:id` |
| Lesson script | `node $LP script-get <lessonId> file.md` → edit → `node $LP script-put <lessonId> file.md` |
| Attach a deck or handout | `node $LP upload <lessonId> deck.pdf` |
| Rename / reorder / remove a file | `PUT /lesson-files/:id {name, order}`, `DELETE /lesson-files/:id` |

`POST /tasks` needs graph coordinates. Lesson positions come from `GET /paths/:id/details`; a lesson's
first task sits at `(lesson.x + 120, lesson.y ∓ 120)` (minus for odd `order`, plus for even), each
further task `+150` on x. The import endpoint computes these for you, so prefer it for new lessons.

## Study-set item shapes

```json
{ "lessonId": 25, "kind": "quiz", "title": "Self-quiz: ISTQB §1.3–1.5 (15 questions)",
  "description": "… **Pass mark: 11 / 15 (70%).** …",
  "items": [
    { "question": "Which principle …?", "options": ["…", "…", "…", "…"],
      "correct": 2, "explanation": "… (§1.3)" },
    { "question": "Which are test work products (testware)? Select all.", "options": ["…", "…", "…"],
      "correct": [0, 2], "explanation": "…" } ] }
```
`correct` is a **0-based** index (or an array of them for "select all that apply").

```json
{ "lessonId": 25, "kind": "flashcards", "title": "…", "description": "…",
  "items": [ { "front": "What is **testware**?", "back": "**ISTQB definition:** …\n\n**In simple words:** …\n\n**Example:** …" } ] }
```

## Things that bite

- **`PUT /study-sets/:id` with `items` deletes every student's results on that set.** Renaming or
  reordering keeps them. Before rewriting items of a set that has existed for more than a few hours,
  tell the user that results will reset.
- **Everything is live immediately.** There is no draft state. A new task emails enrolled students
  (the import endpoint does not). For a whole new phase, the safe pattern is to create it with a high
  `stars_required`, let the user check it, then lower it.
- **Deleting a lesson or task cascades** to submissions. Deleting a study set deletes results.
  Only delete when the user asked for that exact thing.
- **Script saves**: `lp.mjs script-put` sends `expected_script_updated_at`, so a script edited by
  the teacher in the app meanwhile answers `409` instead of being overwritten. On 409, re-read,
  merge, and retry; never overwrite blindly.
- Lesson `description` is HTML (`<p>…</p>`). Task `description` is **Markdown** (the app's task editor
  is a Markdown editor); older tasks are still stored as HTML and the app renders both. When you edit
  an HTML task, rewrite the whole description as Markdown rather than mixing the two. Study-set text
  fields are Markdown.
- `deadline` is `YYYY-MM-DD` (end of that day) or an ISO timestamp.
- Limits: 20 study sets per lesson, 300 items per set, 50 files per lesson (50 MB each).
