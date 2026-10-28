# Notebook lessons and auto-checked homework

A **notebook** is a lesson students read and run in the browser: text cells (Markdown, images,
diagrams) between Java code cells that run in a sandbox. A teacher's notebook is attached to a
lesson and **published**; students open it read-only and press **Copy** to get their own. In
class the teacher uses **Present** (each `#`/`##` heading starts a slide) and the **Live** switch
(state kept between runs) instead of a PowerPoint deck.

An **auto-checked task** is homework where the student writes Java files in the task itself and
hidden JUnit tests check them. The teacher still approves (unless the task auto-approves).

## The authoring format: one Markdown file per notebook

````markdown
# Streams: filter, map, collect

> **Goal** By the end you can turn a loop into a stream pipeline.

Last week we filtered users with a `for` loop:

```java run
record User(String name, int age) {}
var users = List.of(new User("Ana", 31), new User("Ion", 17), new User("Mia", 22));
```

## filter keeps what matches

![Stream pipeline](img/pipeline.png)

```java run
users.stream().filter(u -> u.age() >= 18).toList()
```

> **Exercise** Change the predicate so only names starting with "M" remain. Run the cell again.

<!-- cell -->

## Check yourself

```java run
var adults = users.stream().filter(u -> u.age() >= 18).toList();
assertThat(adults).extracting(User::name).containsExactly("Ana", "Mia");
"passed"
```
````

Rules of the format (the server's parser, `server/notebookMarkdown.js`):
- Every ` ```java run ` fence becomes a **code cell**. Everything between code cells is one **text cell**.
- An ` ```input ` fence **right after** a ` ```java run ` fence (only blank lines between) is that
  cell's **input**: what `Scanner` / `System.in` reads when it runs, one value per line. Students see it
  in an Input box under the cell and can change it.

  ````markdown
  ```java run
  var sc = new Scanner(System.in);
  int a = sc.nextInt(), b = sc.nextInt();
  System.out.println(a + b);
  ```

  ```input
  5 7
  ```
  ````
- `<!-- cell -->` on its own line splits two text cells (use it before a new `##` you want as its own cell).
- Other fences stay in the text cell: ` ```java ` (no `run`) is highlighted but not runnable,
  ` ```mermaid ` is drawn as a diagram.
- The first `# ` heading is the notebook title unless a title is given when publishing.
- Images: `![alt](img/file.png)` with the file next to the Markdown (PNG, JPEG, GIF, WebP, SVG, 5 MB).
  `lp.mjs notebook-put` uploads them; the server rewrites the links.
- Callouts: a blockquote starting with a bold word becomes a coloured box:
  `> **Goal**`, `> **Note**`, `> **Tip**`, `> **Warning**`, `> **Important**`, `> **ISTQB**`, `> **Exercise**`.

## How code cells run (JShell)

- Each run executes the code cells from the top **down to the cell that was run**, in one fresh JVM,
  so later cells see earlier variables, classes and methods. A failing cell stops the run there.
- **No `class Main` and no `main` method**: write statements directly. Declarations (records,
  classes, methods) are fine. `package` declarations are not allowed in a cell.
- The **value of the last expression** is shown as `Out`, so end a cell with the thing to look at
  (`adults`, `"passed"`, `map.size()`), or print with `System.out.println`.
- Imported in every notebook: `java.util.*`, `java.util.function.*`, `java.util.stream.*`, `java.io.*`,
  `java.math.*`, `java.time.*`, `java.nio.file.*`, and AssertJ's `assertThat` (static).
  JUnit 5 and AssertJ are on the class path for anything else (`import org.junit.jupiter.api.*;`).
- Limits per run: **15 s**, **384 MB**, **no network**, no files outside a small temp folder. Keep loops
  bounded and data small.
- **Input**: `Scanner(System.in)` reads the cell's Input box (an ` ```input ` fence in Markdown), never a
  live keyboard. Each cell has its own input, so **create the Scanner in the cell that reads**. Prompts
  print without the typed values (`Two numbers: ` then the result), as on online judges. A cell that
  reads more values than its input holds fails with "the cell's input ran out".
- Compile errors show the line inside the cell; exceptions show the line and the stack.

## How to write a good notebook lesson

- **Rhythm: explain → run → change.** A short text cell (2–6 sentences, A2–B1 English, the term in
  bold the first time), then a code cell the student runs, then an **Exercise** callout asking them
  to change one thing and run again. Avoid long code cells: 3–12 lines each.
- **One running example** through the whole notebook (the same records/data), ideally the one from
  the lesson script and the homework.
- **Every code cell must run clean** in order from the top, except a cell that deliberately shows an
  error; then say so in the text right before it ("This cell fails on purpose: read the error").
- **Slides come from headings.** `#` for the title slide, one `##` per idea. Keep each `##` section
  to one screen when presented: a text cell, one or two code cells.
- **End with a check-yourself cell** that uses `assertThat` and evaluates to `"passed"`.
- Diagrams: Mermaid flowcharts for pipelines and flows; keep labels short. Images for screenshots
  of tools (IntelliJ, Postman) with alt text.
- Standards and definitions follow `references/content-standards.md` and `references/industry-sources.md`;
  ISTQB terms go in `> **ISTQB**` callouts with the glossary wording.

## Publishing (API mode)

```bash
# 1. Lint and run every cell before students see it (makes a private playground, runs it, deletes it)
node .claude/skills/course-content/scripts/check_notebook.mjs streams.md --run

# 2. Create it attached to the lesson and published (images next to the .md are uploaded)
node .claude/skills/course-content/scripts/lp.mjs notebook-put 42 streams.md --publish

# Update an existing notebook later (refuses if it changed since you read it)
node .claude/skills/course-content/scripts/lp.mjs notebook-get 17 streams.md
node .claude/skills/course-content/scripts/lp.mjs notebook-put 42 streams.md --id 17

# Run it in place and print each cell's status
node .claude/skills/course-content/scripts/lp.mjs notebook-run 17
```

Replacing a notebook's cells clears its outputs; students' **copies are not touched** (they see
"updated since you copied" and can copy again). Changing a published notebook during a lesson is
fine; deleting one is not (ask first: copies keep working, but the lesson loses it).

## Auto-checked homework

Hidden tests are JUnit 5 + AssertJ classes in the same package as the student's code. Students see
**test names and assertion messages**, never the test source, so:
- give every test a `@DisplayName` a student understands ("returns 0 for an empty cart");
- use AssertJ's `.as("…")` for a clear failure message where the default is cryptic;
- test behaviour the task text asks for, one rule per test; 3–10 tests per task;
- name classes and method signatures **exactly as the task text says**, and repeat them in the task
  text: a mismatch shows as "Your code compiles, but the tests cannot use it";
- one test class per student class, named `<Class>Test` (`BubbleSortTest` for `BubbleSort`): students
  and the "Try with a solution" tab can then check one class on its own (`check-try … --only BubbleSort`);
- give **starter files** with the class and method signatures and `// TODO` bodies for early weeks;
  later weeks can start from an empty file.

```bash
# tests/ and starter/ hold .java files with their package folders (shop/CartTest.java …)
node .claude/skills/course-content/scripts/lp.mjs check-put 118 tests/ --starter starter/ --timeout 20
# Run the hidden tests against your reference solution: every test must pass
node .claude/skills/course-content/scripts/lp.mjs check-try 118 solution/
node .claude/skills/course-content/scripts/lp.mjs check-get 118
```

Auto-approve (`--auto`) approves a pending submission when every test passes. Student code runs in
the same JVM as the checker, so a determined student could fake a pass: keep it **off** for graded
work and use it only for practice tasks; say so to the teacher if they ask for it.
