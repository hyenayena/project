import {cp, copyFile, lstat, mkdir, mkdtemp, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import type {Git} from './git.js';
import {type Layout, type Session, stageDir, type StageRecord} from './state.js';

const ERR_MAX = 2000;

const clip = (s: string): string => {
	const t = s.trim();
	return t.length > ERR_MAX ? `${t.slice(0, ERR_MAX)}…` : t;
};

async function isDir(p: string): Promise<boolean> {
	const st = await lstat(p).catch(() => undefined);
	return st?.isDirectory() === true;
}

async function head(git: Git, dir: string): Promise<string | null> {
	const r = await git(dir, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']).catch(() => undefined);
	if (!r || r.code !== 0) return null;
	return r.stdout.toString('utf8').trim() || null;
}

/** The folder must be the top level of its own repository (not a folder inside another one). */
async function requireRepo(git: Git, dir: string, what: string): Promise<void> {
	const r = await git(dir, ['rev-parse', '--show-toplevel']);
	const top = r.stdout.toString('utf8').trim();
	if (r.code !== 0 || top === '' || (await realpath(top)) !== (await realpath(dir))) {
		throw new Error(`The ${what} ${dir} is not the top level of a git repository`);
	}
}

/** Copies the project folder as it is (uncommitted changes, ignored files, symlinks as links). */
export async function makeStage(p: {layout: Layout; session: Session; project: string; id: number; git: Git}): Promise<StageRecord> {
	const src = path.join(p.layout.workplace, p.project);
	if (!(await isDir(src))) throw new Error(`${p.project} has no folder in ${p.layout.workplace}, so it cannot be staged`);
	const dst = stageDir(p.layout, p.project, p.session.id, p.id);
	await mkdir(p.layout.stage, {recursive: true});
	if (await lstat(dst).catch(() => undefined)) throw new Error(`${dst} already exists`);
	const base = await head(p.git, src);
	try {
		await cp(src, dst, {recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false, preserveTimestamps: true});
	} catch (error) {
		await rm(dst, {recursive: true, force: true}).catch(() => {});
		throw new Error(`Cannot copy ${src} to ${dst}: ${(error as NodeJS.ErrnoException).code ?? 'copy failed'}`);
	}
	return {project: p.project, id: p.id, path: dst, base};
}

export type ApplyResult = {files: number};

/**
 * Moves everything the stage changed since it was made (commits and uncommitted work, untracked
 * files included, ignored files not) into the project as uncommitted changes. The stage itself and
 * its index are left untouched.
 */
export async function applyStage(p: {layout: Layout; stage: StageRecord; git: Git}): Promise<ApplyResult> {
	const {git, stage} = p;
	const project = path.join(p.layout.workplace, stage.project);
	if (!(await isDir(project))) throw new Error(`${stage.project} has no folder in ${p.layout.workplace}`);
	if (!(await isDir(stage.path))) throw new Error(`The stage ${stage.path} is missing`);
	await requireRepo(git, project, 'project');
	await requireRepo(git, stage.path, 'stage');

	const status = await git(project, ['status', '--porcelain', '--untracked-files=all']);
	if (status.code !== 0) throw new Error(`git status failed in ${project}: ${clip(status.stderr)}`);
	if (status.stdout.length > 0) {
		throw new Error(`${project} has uncommitted changes; commit or stash them before applying a stage`);
	}

	let base = stage.base ?? (await head(git, stage.path));
	if (base === null) {
		const empty = await git(stage.path, ['hash-object', '-t', 'tree', '/dev/null']);
		base = empty.stdout.toString('utf8').trim();
	}
	const known = await git(stage.path, ['cat-file', '-e', `${base}^{tree}`]);
	if (known.code !== 0) throw new Error(`The stage ${stage.path} no longer has its base commit ${base.slice(0, 12)}`);

	const tmp = await mkdtemp(path.join(tmpdir(), 'yena-project-'));
	try {
		// A private index, so the stage's own staging area stays as it is.
		const index = path.join(tmp, 'index');
		const gitDir = (await git(stage.path, ['rev-parse', '--absolute-git-dir'])).stdout.toString('utf8').trim();
		await copyFile(path.join(gitDir, 'index'), index).catch(() => {});
		const env = {GIT_INDEX_FILE: index};
		const add = await git(stage.path, ['add', '-A'], {env});
		if (add.code !== 0) throw new Error(`git add failed in ${stage.path}: ${clip(add.stderr)}`);
		const diff = await git(
			stage.path,
			['diff', '--cached', '--binary', '--full-index', '--no-color', '--no-ext-diff', '--no-textconv', '--no-relative', '--src-prefix=a/', '--dst-prefix=b/', base],
			{env},
		);
		if (diff.code !== 0) throw new Error(`git diff failed in ${stage.path}: ${clip(diff.stderr)}`);
		const patch = diff.stdout;
		const files = (patch.toString('latin1').match(/^diff --git /gm) ?? []).length;
		if (files === 0) return {files: 0};

		const apply = await git(project, ['apply', '--3way', '--whitespace=nowarn', '-'], {input: patch});
		if (apply.code !== 0) {
			const unmerged = await git(project, ['diff', '--name-only', '--diff-filter=U']);
			if (unmerged.code === 0 && unmerged.stdout.length > 0) {
				throw new Error(
					`Stage ${stage.id} was applied to ${project} with conflicts; resolve the conflict markers in:\n${clip(unmerged.stdout.toString('utf8'))}`,
				);
			}
			throw new Error(`Stage ${stage.id} could not be applied to ${project}; nothing was changed:\n${clip(apply.stderr)}`);
		}
		// --3way stages what it applies; leave the project with plain uncommitted changes, as in the stage.
		await git(project, ['reset', '--quiet']);
		return {files};
	} finally {
		await rm(tmp, {recursive: true, force: true}).catch(() => {});
	}
}

/** Removes a stage folder; refuses anything but the derived path of a real folder. */
export async function removeStage(layout: Layout, sessionId: string, stage: StageRecord): Promise<void> {
	const expected = stageDir(layout, stage.project, sessionId, stage.id);
	if (stage.path !== expected) throw new Error(`Refusing to remove ${stage.path}`);
	const st = await lstat(expected).catch(() => undefined);
	if (!st) return;
	if (!st.isDirectory()) throw new Error(`Refusing to remove ${expected}: not a folder`);
	await rm(expected, {recursive: true, force: true});
}
