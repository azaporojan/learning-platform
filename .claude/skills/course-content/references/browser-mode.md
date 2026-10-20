# Browser mode: no API access (claude.ai, or no LEARNING_API_KEY)

When you can't call the platform API, you still do the same work to the same standards; you hand
the teacher paste-ready pieces and say exactly where each one goes in the admin UI. All admin
actions start from the course page (`learning.bsf.md` → the course). In the left outline, a row's
action icons appear when you hover over it.

## Getting the inputs

You can't read the course, scripts, or tasks yourself, so ask for what the task needs, in one message:
- the **lesson title** (and week/date) you're working on;
- the **lesson script** — on the script page, switch to **Edit** and copy the Markdown, or attach
  the file; it holds the examples, the homework, and often a quiz draft in its appendix;
- for homework edits, the current **task text**;
- for a deck, optionally an **existing deck PDF** of a neighbouring lesson, for continuity.
If the user gives only a topic, work from it, and say which details (examples from the student's
own homework, dates) they should check.

## What to hand over, and where it goes

| Content | What you give | Where the teacher pastes it |
|---|---|---|
| Quiz | **Title**, **Description**, and the **items JSON array** in a code block | Hover the lesson in the outline → **Add quiz** (or lesson → PRACTICE → Add quiz). Fill **Title** and **Description (optional)**, click **Edit as JSON**, paste the array, then **Create quiz** |
| Flashcards | Same three parts, items `[{"front","back"}]` | **Add flashcards** → same steps → **Create flashcards** |
| Fixing an existing quiz/deck | The full new items array | Open the set → **Edit** tab → **Edit as JSON** → replace everything → save. Warn: changing items resets students' results on that set |
| Lesson script | The whole script as one Markdown code block | Hover the lesson → **Lesson script (admin only)** → **Edit** → select all, paste → **Save** (Ctrl+S) |
| Homework task | Title, type, stars, deadline, and the **Requirements** text as Markdown | New: hover the lesson → **Add task** (title, type, XP, deadline) → **Add Task**; then open the task → **Edit** → paste into **Requirements** → **Save Changes** (the create form has no description field) |
| New lesson | Title and summary | End of the expanded phase → **Add lesson** → **Lesson Title**, **Lesson Summary** → **Create**. It is added at the end of the phase |
| New phase | Name, description, gating | Header **Phase** or **Add phase** → **Phase Name**, **Description**, **Course**, "Locked until the previous phase is finished", "Stars required" → **Create Phase**. It goes to the end; reorder with **Edit phase** → "Order in course" |
| Deck | A standalone HTML file (below) | Open it in Chrome → save as PDF → lesson → MATERIALS → **Attach files** |
| Notebook lesson | The notebook as one `.md` file (format in `references/notebooks.md`), plus its images | Header **Notebooks** → **Import .md** → open the new notebook → **Settings** (sliders icon) → **Lesson** and **Published to students** → **Save**. Images: open a text cell → image button, or paste them into the cell. Then **Run all** once to check every cell |
| Auto-checked homework | Hidden test files, starter files and a reference solution, each as a code block with its path (`shop/CartTest.java`) | Open the task → **Task Details** → AUTO-CHECK **Set up** → **Hidden tests** (one tab per file: **+ File**, double-click a tab to rename) → **Starter code** → **Try with a solution** → paste the solution → **Save and run the tests** (all must pass) → **Save** |

Notes for the hand-over:
- The quiz/flashcards JSON mode accepts **only the items array** (`[ … ]`), not `{title, items}`.
  Title and description go in their own fields. `correct` is 0-based.
- Give each paste-ready piece in its own code block so it copies cleanly.
- The lesson summary is a rich-text editor (paste plain text; formatting by toolbar). Task
  **Requirements** and study-set fields are Markdown.
- Many new lessons/tasks at once: suggest Claude Code on the repo (API mode) instead — doing a whole
  phase by hand is slow and error-prone.

## Checking without the API

If you can run code, `scripts/check_study_set.py` works on its own (Python 3, no packages). Save
the set as `{"kind": "quiz", "title": …, "items": […]}` and run it; fix every error and warning.
If you can't run code, apply the same rules by hand (content-standards.md): count answer positions
per letter, compare option lengths, check every question has an explanation and every card front is
a question with an example on the back.

## Decks without Node/Chromium

Write the deck HTML exactly as in presentations.md (same components). Then:

```bash
python3 scripts/standalone_deck.py deck.html "Урок 2.1 — Что такое тестирование.html"
```

This inlines the theme and loads fonts, Lucide icons and Mermaid from pinned CDN versions, so it
needs no installs. Give the file to the teacher with the steps (they are also on a banner in the
file, which doesn't print): open in **Chrome or Edge** → **Ctrl/Cmd + P** → **Save as PDF** →
Margins **None** → **Background graphics** on → Save. Then attach the PDF to the lesson.

If you can't run Python either, produce the same single file yourself: copy `assets/deck-theme.css`
into a `<style>` in the head and add the CDN tags and script from `scripts/standalone_deck.py`
(`HEAD`), using `<i data-lucide="name"></i>` for icons. Configure Mermaid at the top level of the
script, not inside the load handler, or its own automatic pass renders the diagrams first with the
default settings.

You can't look at the rendered slides in this mode, so be conservative: ≤ ~40 words per slide,
diagrams ≤ ~6 nodes, `class="slide roomy"` on sparse slides, and ask the teacher to scroll through
the file once and tell you which slides overflow or look empty.
