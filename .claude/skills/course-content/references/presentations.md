# Lesson decks from a lesson script

The teacher's existing decks (e.g. lesson 21's `Presentation 2.pdf`, 34 slides) set the style: 16:9,
off-white slides with a teal top bar, dark navy cover and section slides, full-sentence headlines,
teal/amber accents, dark terminal blocks for code, a tinted "QA-мостик" takeaway bar at the bottom,
footer `QA Automation · Урок N.K` with page numbers. `assets/deck-theme.css` reproduces it, and
`scripts/build_deck.mjs` turns slide HTML into the PDF students open on the platform.

## Workflow

1. **Read the script** (`lp.mjs script-get <lessonId> script.md`) and the lesson's tasks/study sets
   (`lp.mjs tree 1`). Also look at the most recent deck on a neighbouring lesson if there is one
   (`lp.mjs download <fileId> prev.pdf`, then `pdftoppm -r 40 -png prev.pdf prev` to see it) —
   continuity matters.
2. **Outline first.** One slide per idea, following the script's timed blocks:
   cover → lesson plan → for each block: (section divider) → 1–4 content slides → … → homework →
   sources. A 60-minute theory lesson is typically 20–30 slides; a 90-minute live-coding lesson
   15–25 (more terminal, fewer concepts). Write the outline as a list of headlines and check it
   reads as the lesson's story on its own.
3. **Write the deck HTML**: copy `assets/deck-template.html` to the working directory and replace
   the slides. The template is a component sample (built on lesson 2.1 content); use its markup,
   not its text. Keep the `<body data-footer>` and `lang` attributes.
4. **Build and look**:
   ```bash
   # only if .claude/skills/course-content/scripts/node_modules is missing:
   npm install --prefix .claude/skills/course-content/scripts
   node .claude/skills/course-content/scripts/build_deck.mjs deck.html \
     --out "Урок 2.1 — Что такое тестирование.pdf" --sheet sheet.png --png png/
   ```
   The builder exits non-zero and prints `OVERFLOW slide N …` when content leaves the safe area,
   and `PROBLEM …` for failed assets, Mermaid errors, or a page count that differs from the slide
   count. Fix them all. Then **look at the contact
   sheet and at every slide PNG** — the overflow check doesn't catch a cramped or empty slide,
   unreadable diagram, or a wrong icon. Iterate until each slide looks deliberate.
5. **Verify every link and quote** the builder lists (WebFetch / WebSearch). A dead or wrong link on
   a slide students open is worse than no link. When the sandbox can only search (WebFetch failing
   is common here), a link counts as verified if search returns that exact URL with a matching
   title; a quote counts as verified only if a search result shows the same wording attributed to
   the same source. Report each link/quote with how it was checked, and list syllabus quotes the
   teacher should compare against the PDF before uploading.
6. **Deliver**: send the PDF to the user (SendUserFile) and attach it to the lesson only when they
   asked for that (`lp.mjs upload <lessonId> deck.pdf`). Name the file like the lesson,
   e.g. `Урок 2.1 — Что такое тестирование.pdf`. To replace an older version, upload the new file,
   then delete the old one (`DELETE /lesson-files/:id`) only after confirming with the user.

If the user needs an editable PowerPoint, build the same slide content with the `pptx` skill (when
available) using the same palette and structure; the PDF stays the version uploaded for students.

## Content rules

- **Language**: follow the script and the existing decks — Russian slide text, with English terms,
  English quotes and English "phrase of the day" / interview answers (those are what the student must
  say). Use English only throughout if the user asks for it.
- **Headline = the point of the slide**, as a sentence ("Компилятор переводит код, JVM его исполняет"),
  not a topic label ("Компиляция").
- **Fill the frame.** A slide with one idea and little text gets `class="slide roomy"` (larger type);
  don't leave the lower half empty.
- **≤ ~40 words of body text per slide.** The deck supports the teacher talking; the script holds the
  detail. Prefer a diagram, table, or code block over bullets.
- **Practice blocks** from the script ("клавиатура у него", самостоятельная проверка) become task
  slides: a `kicker` with "ЗАДАНИЕ · 30–45 мин", the instruction in English, and the checkpoint.
- **Every factual claim from a standard carries its source**: a `.source` line on the slide
  (`ISTQB CTFL v4.0 §1.2.3`, linked) and an entry on the final "Источники" slide with what it
  supports. Use `references/industry-sources.md`; never invent section numbers.
- **Quotes**: only verifiable ones with author, work, year, link (see industry-sources.md).
- **Interview angle**: where the script has "Пробы интервьюера", add a slide with the question and a
  model English answer — the student's goal is passing Endava/Grid Dynamics interviews.
- The homework slide must match the platform task text.

## Components (all in `assets/deck-template.html`)

| Need | Markup |
|---|---|
| Cover / section divider | `<section class="slide dark">` with `.kicker`, `h1` (`<span class="accent">`), `.lead`, `.big-num` |
| Content slide | `<section class="slide">` + `h2` headline |
| Columns | `.cols` (2), `.cols.c3`, `.cols.c4`, `.cols.w-60-40`, `.cols.w-40-60` |
| Cards | `.card` (white), `.card.teal`, `.card.dark`, `.card.bad`, `.card.good`; `.label` for the small caps line |
| Numbered steps | `<div class="numbered"><span class="num">1</span><div>…</div></div>` |
| Takeaway bar | `<div class="callout"><b>QA-мостик:</b> …</div>` (also `.amber`, `.red`); placed directly in the slide it sits at the bottom |
| Quote | `.quote` (dark) or `.quote.light` with `<blockquote>` and `.src` |
| Source line | `<p class="source"><a href="…">ISTQB CTFL v4.0 §1.1.1</a></p>` |
| Code / console | `<div class="terminal" data-title="SimpleInterest.java">…</div>`; spans `.c` comment, `.k` keyword, `.s` string, `.e` error, `.ok` success |
| Simple chain diagram | `.flow` with `.card`s and `<div class="arrow"></div>` between them |
| Any other diagram | `<div class="diagram"><pre class="mermaid">flowchart LR …</pre></div>` (flowchart, sequenceDiagram, stateDiagram-v2, classDiagram, erDiagram, timeline…) or hand-written inline `<svg>` |
| Lesson plan | `.plan` rows with `.bar` / `.bar.practice` and `--from` / `--len` in % |
| Icon | `<i data-icon="bug"></i>` — any Lucide name (`ls scripts/node_modules/lucide-static/icons`); useful: bug, shield-check, gauge, git-branch, git-pull-request, terminal, code, database, globe, server, list-checks, clipboard-check, search, user, users, clock, target, triangle-alert, book-open, lightbulb |
| Table | plain `<table>` |
| Highlight | `<span class="hl">` (amber), `<code>` |

Mermaid scales a diagram down to fit its box, so a big diagram ends up with tiny text. Keep a diagram
to about 6 nodes or 6 messages; split a longer process over two slides, or draw a simple chain with
`.flow` cards, which keep full-size text. Check the PNG: diagram text should read like body text.

Diagrams to reach for in this course: V-model and SDLC models, test levels pyramid, defect
lifecycle (`stateDiagram-v2`), error → defect → failure chain, client–server / HTTP request–response
(`sequenceDiagram`), Git branches and PRs (`gitGraph`), Page Object Model (`classDiagram`), SQL
joins/ER (`erDiagram`), equivalence partitions and boundary values (a hand-drawn SVG number line),
state transition diagrams for test design (`stateDiagram-v2`).
