# project

Project management for yena, as a plugin (depends on `md`). yena can change its own code; this module lets it work on other projects too, without touching the ones a change is not about.

- Projects are folders mounted in `/workplace/<name>` (compose: `${YENA_WORKPLACE:-./workplace}:/workplace`).
- Each project's docs live in the md hub at `<YENA_DATA>/md/projects/<name>/`. A project may have docs only, with no folder in `/workplace`.
- Stages are copies of a project in `/stage/<name>-stage-<session>-<id>` (inside the container only).
- **Every project, its docs and its stages are read-only by default.** `isolate` makes chosen projects writable for the work session.

## Commands

| Command | Agent policy | What it does |
|---|---|---|
| `project list` | safe | Projects (files / docs), which are isolated, their stages, the work session |
| `project new <name>` | confirm | Creates a docs-only project: an empty docs folder `<YENA_DATA>/md/projects/<name>/`, no folder in `/workplace`. Refuses a name that is already a project (files or docs). The new project is not isolated. |
| `project isolate <name>…` | confirm | Makes the projects writable for the work session: folder, docs folder (created when missing) and stages. Adds to what is already isolated. |
| `project stage make <name>` | confirm | Copies the project folder into a new stage and prints only its absolute path |
| `project stage apply <name> <stageid>` | confirm | Moves the stage's changes into `/workplace/<name>` as uncommitted changes; the stage is kept |
| `project finish` | confirm | Ends the work session: every project read-only again, all its stages deleted |

`project` or `project help` prints the usage.

### Work session

Started by the first `isolate` or `stage make`, ended by `finish`. It is not tied to a chat: it survives new chats and yena restarts. The session id (8 hex) is part of every stage path; stage ids count up from 1 within a session and are never reused, even when a copy fails.

### Stages

- `stage make` copies the folder as it is: uncommitted changes, ignored files (`node_modules`), symlinks as links. It records the project's `HEAD` as the stage's base. A stage of a project that is not isolated is read-only too.
- `stage apply` requires the project to be isolated, both folders to be the top level of a git repository, and the project to have no uncommitted changes (untracked files count). It takes everything the stage changed since its base (commits and uncommitted work, untracked files included, ignored files not; read through a private index, so the stage's own index is untouched), applies it with `git apply --3way` and unstages it. The project ends up with plain uncommitted changes and no new commit. Conflicts leave conflict markers and fail the command with the list of files. A stage with no changes reports so.

## How the read-only rule is enforced

The module writes its state to `<YENA_DATA>/project/state.json` (atomically, also at load so the paths are known before any command). Other modules never read this file themselves: they use the public entry `src/public.ts` (`accessReader(dataDir)` with `read`/`readSync` returning roots, docs and writable folders, `isolatedProjects`, `docsRootFor`, `stateFileFor`, `isProjectName`), the one reader of the format. The claude module loads it as an optional dependency and asks it on every file access. The file looks like this:

```json
{
	"v": 1,
	"workplace": "/workplace",
	"stage": "/stage",
	"md": "/data/md/projects",
	"session": {
		"id": "3f9a1c2e",
		"startedAt": "2026-10-23T00:00:00.000Z",
		"isolated": ["web"],
		"nextStage": 2,
		"stages": [{"project": "web", "id": 1, "path": "/stage/web-stage-3f9a1c2e-1", "base": "<sha or null>"}]
	}
}
```

`session` is `null` outside a work session. The claude module allows Edit/Write under the workplace, the stage dir and the hub's `projects/` folder only inside the isolated projects' folders, docs folders and stages; see the claude README, "Projects". An invalid file locks every project there and makes this module's commands refuse to run until it is fixed or deleted.

## Workflow

Before a change, the user says which projects it touches, or the architect asks (unless it is obvious). The architect then isolates exactly those projects, plans, and the pipeline goes on as usual. Stages are for parallel work on one project (e.g. different branches): one stage per coder, applied back one at a time. `project finish` when the work is done. The details are in the md hub (`CLAUDE.md`, `agents/architect.md`, `commands/pipeline.md`).

## Layout

`src/`: `public.ts` (the public entry above; pure), `deps/md.ts` (the only import of another module: md's `hubDirFor`), `index.ts` (plugin, layout, state at load), `commands.ts` (the `project` command, one state change at a time), `state.ts` (names, state file), `projects.ts` (listing), `stage.ts` (make, apply, remove), `git.ts` (the only place that spawns: `git` without a shell, `safe.directory` for that call only, credential variables removed, 120 s timeout).

Tests: `npm test` in this directory (they need `git`).

## Residual risks

- Only Edit and Write are confined. Bash can write anywhere; the claude module only refuses Bash commands that name this module's data dir.
- Symlinked project folders are not listed (the write check resolves symlinks, so they could never be written).
- A stage copy cannot be cancelled midway and may take long for big folders; the assistant's command timeout still applies to the result.
- `finish` deletes stages whose changes were never applied.
- Absolute symlinks inside a project point to the same targets from its stage.
