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

- `stage make` copies the folder as it is: uncommitted changes, ignored files, symlinks as links. It records the project's `HEAD` as the stage's base. A stage of a project that is not isolated is read-only too. It first scans the tree (no symlinks followed, `node_modules` contents skipped; depth 6, 50 000 folders, 64 repos, 256 links; going over a limit fails):
  - every git-ignored `node_modules` without tracked files is not copied: the stage gets an absolute symlink to the original (so typecheck and tests work there) and an `info/exclude` line in the owning repo's `.git`, so the stage's status stays clean. A `node_modules` that is tracked or holds tracked files is copied.
  - every nested git repo (a folder that is the top level of its own repo) gets its `HEAD` recorded as its own base.
- `stage apply` requires the project to be isolated and, for every repo with changes, a clean top-level repo (untracked files count). It works in three phases:
  1. Read the stage, no writes: recorded repos must be present, unrecorded repos in the stage are refused, git dirs must be inside the stage. For each repo (the outer one and each nested one) it takes everything changed since its base (commits and uncommitted work, untracked files included, ignored files not; read through a private index, so the stage's own index is untouched); nested repos and links are excluded from the outer patch.
  2. Check the targets that have changes: clean, real folders (no symlinks in the path), top level of a repo. All failures are listed together and nothing is changed.
  3. Apply with `git apply --3way` and unstage, outer repo first, then nested by path. A conflict or failure in one repo does not stop the others. The repos end up with plain uncommitted changes and no new commit.
  
  Conflicts leave markers. A project without nested repos reports as before (conflicts fail the command with the list of files; a stage with no changes reports so). Otherwise there is one line per repo (`  . : N files changed`, `  modules/x: conflicts in: …`, `  modules/y: not applied: …`) and the footer `Left uncommitted. The stage is kept.`; the command fails when any repo had conflicts or failed. A stage made before nested repos were recorded (no `nested` in its record) applies only the outer repo and says so when the stage has nested repos.
- `finish` removes the links without touching the originals.

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
		"stages": [{"project": "web", "id": 1, "path": "/stage/web-stage-3f9a1c2e-1", "base": "<sha or null>", "nested": [{"path": "modules/x", "base": "<sha or null>"}], "links": ["node_modules"]}]
	}
}
```

`nested` and `links` (relative paths, checked on load) are always written; a record without them predates nested support. `src/public.ts` ignores both. `session` is `null` outside a work session. The claude module allows Edit/Write under the workplace, the stage dir and the hub's `projects/` folder only inside the isolated projects' folders, docs folders and stages; see the claude README, "Projects". An invalid file locks every project there and makes this module's commands refuse to run until it is fixed or deleted.

## Workflow

Before a change, the user says which projects it touches, or the architect asks (unless it is obvious). The architect then isolates exactly those projects, plans, and the pipeline goes on as usual. Stages are for parallel work on one project (e.g. different branches): one stage per coder, applied back one at a time. `project finish` when the work is done. The details are in the md hub (`CLAUDE.md`, `agents/architect.md`, `commands/pipeline.md`).

## Layout

`src/`: `public.ts` (the public entry above; pure), `deps/md.ts` (the only import of another module: md's `hubDirFor`), `index.ts` (plugin, layout, state at load), `commands.ts` (the `project` command, one state change at a time), `state.ts` (names, state file), `projects.ts` (listing), `stage.ts` (make, apply, remove), `git.ts` (the only place that spawns: `git` without a shell, `safe.directory` for that call only, credential variables removed, 120 s timeout).

Tests: `npm test` in this directory (they need `git`).

## Residual risks

- Edit and Write are confined by the claude module's policy hook; Bash by its sandbox (bubblewrap, claude's `src/chat/sandbox.ts`), which denies writes to every folder that is not isolated and follows isolation changes before each command. On an image without bubblewrap Bash can write anywhere (the chat warns); the claude module then only refuses Bash commands that name this module's data dir.
- Symlinked project folders are not listed (the write check resolves symlinks, so they could never be written).
- A stage copy cannot be cancelled midway and may take long for big folders; the assistant's command timeout still applies to the result.
- `finish` deletes stages whose changes were never applied.
- Absolute symlinks inside a project point to the same targets from its stage.
- `node_modules` in a stage is a link to the project's own: `npm install` (or anything else writing there) in a stage changes the real project, while it is isolated. No package installs in a stage.
- Repos deeper than 6 levels are not found.
- After a conflict or failure in one repo the others stay applied (partial apply, by design; the report names each).
