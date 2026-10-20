# Runner: sandboxed Java for notebooks and checked tasks

The Learning Platform server sends Java cells and homework submissions here. Each run happens
in a throwaway container with no network, a hard memory limit and a timeout.

```
platform (Express) ──HTTP, RUNNER_TOKEN──▶ runner ──HTTP, GATE_TOKEN──▶ gate ──/var/run/docker.sock──▶ sandbox containers
                                          (no Docker access)            (builds every container itself)   (java lp.Kernel …)
```

One image (`ghcr.io/azaporojan/learning-platform-runner`) plays all three roles:

| Role | Command | Runs as | Notes |
|---|---|---|---|
| runner | `node src/runner.js` (default) | uid 10001 (drops root at start) | HTTP API, pool, warm containers, queue, teacher sessions |
| gate | `node src/gate.js` | root (needs the Docker socket) | Five operations on sandbox containers only. It never takes an image, command, mount or network from the caller |
| sandbox | `java lp.Kernel jshell` / `check` | uid 10001 | Created by the gate from the image the gate itself runs, so the host always has it |

## Kernel

`kernel/src/lp/Kernel.java` runs inside the sandbox:

- **jshell**: one JShell with local execution (a single JVM). Cells arrive one at a time; each is
  split into snippets, evaluated, and answered with stdout, stderr, the value of the last
  expression, or the first compile or runtime error with its line in the cell. State is kept
  between cells until the container ends.
- **check**: compiles the student's files, then the hidden tests against them, and runs only the
  hidden tests with the JUnit Platform launcher. A `@Test` the student writes is never counted.

The image ships JUnit 5 (console standalone 1.11.4), AssertJ 3.27.3 and Byte Buddy, pinned by
SHA-256. AssertJ's `assertThat` is imported in every notebook.

How a check keeps its verdict honest:

- **The hidden tests never touch the sandbox's filesystem.** They arrive over stdin, are compiled
  in memory, and are defined by a class loader that serves no resources; their bytes are dropped
  once loaded. Student code cannot list, read or decompile them.
- **Results carry a per-run nonce** that the kernel reads from stdin before any student code
  runs and keeps only in local variables, never in a static field, so reflection from student
  code has no path to it. Text a student prints cannot pose as a result.
- **Only planned tests count.** The test plan is fixed by discovery before student code runs; each
  planned test is counted once, a `@Test` the student writes is never run, and a planned test
  that never reports counts as failed.

Student code still shares the kernel's JVM, so someone determined enough to scan the process
memory could in theory forge a verdict. Treat check results as a strong signal, and keep
auto-approve off where a forged pass would matter.

## Sandbox limits

| | jshell | check |
|---|---|---|
| Memory (no swap) | 384 MiB | 512 MiB |
| JVM heap | 256 MiB | 320 MiB |
| CPU | 1 | 1 |
| Timeout | 15 s per run (all cells), per cell in a session | 30 s, up to 60 s per task |
| Processes | 64 | 64 |
| Network | none | none |
| Filesystem | read-only root, 32 MiB tmpfs `/work`, 16 MiB `/tmp` | same |
| Privileges | all capabilities dropped, no-new-privileges, uid 10001 | same |

The pool keeps at most `RUNNER_MAX_CONTAINERS` (4) sandboxes alive in any state: booting,
warm, running, or held by a session. Two warm jshell containers (about 90 MiB each idle) wait
when there is room, so a notebook run starts in about 100 ms. Requests beyond the ceiling
queue for up to 20 s (checks up to 2 min, always after waiting notebook runs) and then get 429.

## API

All routes except `/health` need `Authorization: Bearer $RUNNER_TOKEN`.

| Route | Body | Answer |
|---|---|---|
| `GET /health` | | `{ok}` |
| `GET /stats` | | pool, sessions, limits |
| `POST /run` | `{cells: [string], requestId?}` | `{status, cells: [{index, status, stdout, stderr, value, error, durationMs, truncated}], durationMs, warm, queuedMs}` |
| `GET /queue/:requestId` | | `{position}`; 0 when the request is no longer waiting |
| `POST /check` | `{files: [{path, content}], tests: [{path, content}], timeoutMs?}` (clamped to 5-60 s) | `{status, summary, diagnostics, tests: {total, passed, failed: [{name, message}]}, stdout, durationMs}` |
| `GET /sessions` | | live teacher sessions |
| `POST /sessions` | `{owner}` | the owner's session (opened if needed) |
| `POST /sessions/:id/cells` | `{owner, source}` | one cell result plus `executionCount` and `sessionEnded` |
| `DELETE /sessions/:id?owner=…` | | `{closed}` |

Run status: `ok`, `error` (a cell failed to compile or threw), `timeout`, `oom`, `crashed`
(System.exit or a JVM crash). Cell status adds `not_run` for cells after the failing one.
Check status: `passed`, `failed`, `compile_error`, `no_tests`, `timeout`, `oom`, `crashed`, `error`.

## Configuration

| Variable | Used by | Default |
|---|---|---|
| `RUNNER_TOKEN` | runner | required, 24+ chars; the platform sends it |
| `GATE_TOKEN` | runner, gate | required, 24+ chars, **different from `RUNNER_TOKEN`** (the runner refuses to start otherwise): only the runner may hold it |
| `GATE_URL` | runner | `http://gate:2376` |
| `PORT` / `GATE_PORT` | runner / gate | `8080` / `2376` |
| `RUNNER_MAX_CONTAINERS`, `RUNNER_WARM`, `RUNNER_MAX_SESSIONS` | runner | 4, 2, 2 |
| `RUNNER_RUN_TIMEOUT_MS`, `RUNNER_CHECK_TIMEOUT_MS`, `RUNNER_SESSION_IDLE_MS` | runner | 15000, 30000, 600000 |
| `GATE_JSHELL_MEMORY_MB`, `GATE_CHECK_MEMORY_MB`, `GATE_SANDBOX_CPUS` | gate | 384, 512, 1 |
| `SANDBOX_IMAGE` | gate | the gate's own image |
| `GATE_MAX_SANDBOXES` | gate | 6; the gate's own ceiling, independent of the runner's pool |
| `HOST` / `GATE_HOST` | runner / gate | `0.0.0.0`; keep both on an internal network with no published port or domain |
| `GATE_MAX_AGE_MS` | gate | 2 h; no sandbox outlives it |

## Deployment (Dokploy)

Two applications in the **Learning Platform** project, both from the runner image with the same
GHCR credentials as the platform app:

- **runner-gate**: command `node src/gate.js`, bind mount `/var/run/docker.sock`, env `GATE_TOKEN`,
  limits 128 MiB / 0.25 CPU. No domain.
- **runner**: default command, env `RUNNER_TOKEN`, `GATE_TOKEN`, `GATE_URL=http://<gate appName>:2376`,
  limits 128 MiB / 0.5 CPU. No domain.

The platform app gets `RUNNER_URL=http://<runner appName>:8080` and `RUNNER_TOKEN`.

- **One replica each.** On start the runner removes labelled sandboxes older than two minutes that
  it does not know, so a second runner would remove the first one's sandboxes.
- **Session owners come from the platform**, which sets them from the signed-in teacher and the
  notebook (`<user id>:nb<notebook id>`); nothing a student sends ever becomes an owner.
- **Keep both images in step.** Sandboxes start from the gate's own image; if a cleanup removes it
  while the gate still runs, the gate falls back to the image name (the newest pulled runner image). CI builds and
pushes the image on every push to `main`; set the `DOKPLOY_RUNNER_WEBHOOK_URL` and
`DOKPLOY_GATE_WEBHOOK_URL` repository secrets to redeploy both automatically.

## Development

```bash
npm test --prefix runner                       # unit tests
docker build -t lp-runner:test runner
RUNNER_IT=1 SANDBOX_IMAGE=lp-runner:test npm test --prefix runner   # real sandboxes (needs Docker)
```
