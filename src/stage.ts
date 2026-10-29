import {appendFile, cp, copyFile, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import type {Logger} from '../../../src/api.js';
import type {Git} from './git.js';
import {noopLog} from './log.js';
import {isRelPath, type Layout, MAX_LINKS, MAX_NESTED, type NestedBase, type Session, stageDir, type StageRecord} from './state.js';

const ERR_MAX = 2000;

const clip = (s: string): string => {
	const t = s.trim();
	return t.length > ERR_MAX ? `${t.slice(0, ERR_MAX)}…` : t;
};

const oneLine = (s: string): string => clip(s.split('\n').map(l => l.trim()).filter(Boolean).join(', '));

async function isDir(p: string): Promise<boolean> {
	const st = await lstat(p).catch(() => undefined);
	return st?.isDirectory() === true;
}

async function head(git: Git, dir: string): Promise<string | null> {
	const r = await git(dir, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']).catch(() => undefined);
	if (!r || r.code !== 0) return null;
	return r.stdout.toString('utf8').trim() || null;
}

async function isTopLevel(git: Git, dir: string): Promise<boolean> {
	const r = await git(dir, ['rev-parse', '--show-toplevel']);
	const top = r.stdout.toString('utf8').trim();
	if (r.code !== 0 || top === '') return false;
	return (await realpath(top)) === (await realpath(dir));
}

async function requireRepo(git: Git, dir: string, what: string): Promise<void> {
	if (!(await isTopLevel(git, dir))) throw new Error(`The ${what} ${dir} is not the top level of a git repository`);
}

export type TreeScan = {repos: string[]; nodeModules: string[]};
export type ScanLimits = {depth: number; folders: number; repos: number; nodeModules: number};

const SCAN_LIMITS: ScanLimits = {depth: 6, folders: 50_000, repos: MAX_NESTED, nodeModules: MAX_LINKS};

export async function scanTree(root: string, limits: ScanLimits = SCAN_LIMITS): Promise<TreeScan> {
	const repos: string[] = [];
	const nodeModules: string[] = [];
	let level = [''];
	let visited = 0;
	for (let depth = 0; level.length > 0; depth++) {
		const next: string[] = [];
		for (const rel of level) {
			if (++visited > limits.folders) throw new Error(`${root} has too many folders to stage`);
			const dir = path.join(root, rel);
			const entries = await readdir(dir, {withFileTypes: true}).catch((error: NodeJS.ErrnoException) => {
				throw new Error(`Cannot read ${dir}: ${error.code ?? 'read failed'}`);
			});
			for (const e of entries) {
				const child = rel === '' ? e.name : `${rel}/${e.name}`;
				if (e.name === '.git') {
					if (rel !== '') repos.push(rel);
				} else if (e.isDirectory()) {
					if (e.name === 'node_modules') nodeModules.push(child);
					else if (depth < limits.depth) next.push(child);
				}
			}
			if (repos.length > limits.repos) throw new Error(`${root} has too many nested repositories to stage`);
			if (nodeModules.length > limits.nodeModules) throw new Error(`${root} has too many node_modules folders to stage`);
		}
		level = next;
	}
	return {repos: repos.sort(), nodeModules: nodeModules.sort()};
}

async function insideDir(root: string, rel: string): Promise<string> {
	if (!isRelPath(rel)) throw new Error(`Invalid path ${JSON.stringify(rel)} in ${root}`);
	let dir = root;
	for (const seg of rel.split('/')) {
		dir = path.join(dir, seg);
		if (!(await isDir(dir))) throw new Error(`${dir} is not a folder (or is a symlink)`);
	}
	return dir;
}

async function gitDirInside(git: Git, dir: string, root: string): Promise<void> {
	const r = await git(dir, ['rev-parse', '--absolute-git-dir']);
	const gitDir = r.stdout.toString('utf8').trim();
	if (r.code !== 0 || gitDir === '') throw new Error(`git rev-parse failed in ${dir}: ${clip(r.stderr)}`);
	const real = await realpath(gitDir);
	if (!real.startsWith((await realpath(root)) + path.sep)) throw new Error(`${dir} keeps its git data outside the stage`);
}

function owner(rel: string, repos: string[]): string {
	let best = '';
	for (const r of repos) if (rel.startsWith(`${r}/`) && r.length > best.length) best = r;
	return best;
}

const relTo = (repo: string, rel: string): string => (repo === '' ? rel : rel.slice(repo.length + 1));

const literalExcludes = (paths: string[]): string[] => paths.map(p => `:(exclude,literal)${p}`);

const excludeLine = (rel: string): string => `/${rel.replace(/[\\*?[\] ]/g, '\\$&')}\n`;

export async function makeStage(p: {layout: Layout; session: Session; project: string; id: number; git: Git; log?: Logger}): Promise<StageRecord> {
	const {git} = p;
	const log = p.log ?? noopLog;
	const src = path.join(p.layout.workplace, p.project);
	if (!(await isDir(src))) throw new Error(`${p.project} has no folder in ${p.layout.workplace}, so it cannot be staged`);
	const dst = stageDir(p.layout, p.project, p.session.id, p.id);
	await mkdir(p.layout.stage, {recursive: true});
	if (await lstat(dst).catch(() => undefined)) throw new Error(`${dst} already exists`);
	const base = await head(git, src);
	const scan = await scanTree(src);

	const nested: NestedBase[] = [];
	for (const rel of scan.repos) {
		const dir = path.join(src, rel);
		if (!(await isTopLevel(git, dir))) {
			log.debug('not a repository', {depth: rel.split('/').length});
			continue;
		}
		nested.push({path: rel, base: await head(git, dir)});
	}
	const repoPaths = nested.map(n => n.path);
	const outerRepo = base !== null || (await isTopLevel(git, src));

	const links: string[] = [];
	for (const rel of scan.nodeModules) {
		const own = owner(rel, repoPaths);
		if (own !== '' || outerRepo) {
			const dir = path.join(src, own);
			const sub = relTo(own, rel);
			const ignored = await git(dir, ['check-ignore', '-q', '--', sub]);
			if (ignored.code === 1) continue;
			if (ignored.code !== 0) throw new Error(`git check-ignore failed in ${dir}: ${clip(ignored.stderr)}`);
			const tracked = await git(dir, ['ls-files', '-z', '--', `:(literal)${sub}`]);
			if (tracked.code !== 0) throw new Error(`git ls-files failed in ${dir}: ${clip(tracked.stderr)}`);
			if (tracked.stdout.length > 0) continue;
		}
		links.push(rel);
	}
	if (![...repoPaths, ...links].every(isRelPath)) throw new Error(`${src} has a path that cannot be staged`);

	const linkAbs = new Set(links.map(rel => path.join(src, rel)));
	try {
		await cp(src, dst, {
			recursive: true,
			verbatimSymlinks: true,
			errorOnExist: true,
			force: false,
			preserveTimestamps: true,
			filter: s => !linkAbs.has(s),
		});
	} catch (error) {
		await rm(dst, {recursive: true, force: true}).catch(() => {});
		throw new Error(`Cannot copy ${src} to ${dst}: ${(error as NodeJS.ErrnoException).code ?? 'copy failed'}`);
	}
	try {
		for (const rel of links) {
			await symlink(path.join(src, rel), path.join(dst, rel), 'dir');
			const own = owner(rel, repoPaths);
			const gitDir = path.join(dst, own, '.git');
			if (!(await isDir(gitDir)) || rel.includes('\n') || rel.includes('\r')) continue;
			const info = path.join(gitDir, 'info');
			await mkdir(info, {recursive: true});
			const file = path.join(info, 'exclude');
			const old = await readFile(file, 'utf8').catch(() => '');
			await appendFile(file, `${old !== '' && !old.endsWith('\n') ? '\n' : ''}${excludeLine(relTo(own, rel))}`);
		}
	} catch (error) {
		await rm(dst, {recursive: true, force: true}).catch(() => {});
		throw error;
	}
	return {project: p.project, id: p.id, path: dst, base, nested, links};
}

export type RepoResult = {
	repo: string;
	files: number;
	outcome: 'unchanged' | 'applied' | 'conflicts' | 'failed';
	detail?: string;
};

export type ApplyResult = {
	files: number;
	repos: RepoResult[];
	legacy: boolean;
	legacyNested: boolean;
};

async function stagePatch(git: Git, dir: string, base: string | null, excludes: string[], tmp: string, name: string): Promise<Buffer> {
	let from = base ?? (await head(git, dir));
	if (from === null) {
		const empty = await git(dir, ['hash-object', '-t', 'tree', '/dev/null']);
		from = empty.stdout.toString('utf8').trim();
	}
	const known = await git(dir, ['cat-file', '-e', `${from}^{tree}`]);
	if (known.code !== 0) throw new Error(`The stage ${dir} no longer has its base commit ${from.slice(0, 12)}`);

	const index = path.join(tmp, `index-${name}`);
	const gitDir = (await git(dir, ['rev-parse', '--absolute-git-dir'])).stdout.toString('utf8').trim();
	await copyFile(path.join(gitDir, 'index'), index).catch(() => {});
	const env = {GIT_INDEX_FILE: index};
	const spec = ['--', '.', ...literalExcludes(excludes)];
	const add = await git(dir, ['-c', 'advice.addEmbeddedRepo=false', 'add', '-A'], {env});
	if (add.code !== 0) throw new Error(`git add failed in ${dir}: ${clip(add.stderr)}`);
	const diff = await git(
		dir,
		['diff', '--cached', '--binary', '--full-index', '--no-color', '--no-ext-diff', '--no-textconv', '--no-relative', '--src-prefix=a/', '--dst-prefix=b/', from, ...spec],
		{env},
	);
	if (diff.code !== 0) throw new Error(`git diff failed in ${dir}: ${clip(diff.stderr)}`);
	return diff.stdout;
}

type Planned = {repo: string; base: string | null; inner: string[]; excludes: string[]; patch: Buffer; files: number};

export async function applyStage(p: {layout: Layout; stage: StageRecord; git: Git}): Promise<ApplyResult> {
	const {git, stage} = p;
	const project = path.join(p.layout.workplace, stage.project);
	if (!(await isDir(project))) throw new Error(`${stage.project} has no folder in ${p.layout.workplace}`);
	if (!(await isDir(stage.path))) throw new Error(`The stage ${stage.path} is missing`);
	await requireRepo(git, project, 'project');
	await requireRepo(git, stage.path, 'stage');
	await gitDirInside(git, stage.path, stage.path);

	const legacy = stage.nested === undefined;
	const nested = [...(stage.nested ?? [])].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	let legacyNested = false;
	if (legacy) {
		legacyNested = await scanTree(stage.path).then(
			s => s.repos.length > 0,
			() => true,
		);
	} else {
		const scan = await scanTree(stage.path);
		const recorded = new Set(nested.map(n => n.path));
		const found = new Set(scan.repos);
		const missing = nested.filter(n => !found.has(n.path)).map(n => n.path);
		if (missing.length > 0) throw new Error(`Repositories recorded for stage ${stage.id} are missing from ${stage.path}: ${missing.join(', ')}`);
		const extra: string[] = [];
		for (const rel of scan.repos) if (!recorded.has(rel) && (await isTopLevel(git, path.join(stage.path, rel)))) extra.push(rel);
		if (extra.length > 0) {
			throw new Error(
				`${extra.join(', ')} in ${stage.path} were not in the project when the stage was made; remove them from the stage or copy them by hand`,
			);
		}
		for (const n of nested) {
			const dir = await insideDir(stage.path, n.path);
			await requireRepo(git, dir, 'stage repository');
			await gitDirInside(git, dir, stage.path);
		}
	}

	const repoPaths = nested.map(n => n.path);
	const links = stage.links ?? [];
	const plans: Planned[] = [{repo: '', base: stage.base}, ...nested.map(n => ({repo: n.path, base: n.base}))].map(r => {
		const inner = repoPaths.filter(x => r.repo === '' || x.startsWith(`${r.repo}/`)).filter(x => x !== r.repo);
		const owned = links.filter(l => owner(l, repoPaths) === r.repo);
		return {
			...r,
			inner: inner.map(x => relTo(r.repo, x)),
			excludes: [...inner, ...owned].map(x => relTo(r.repo, x)),
			patch: Buffer.alloc(0),
			files: 0,
		};
	});

	const tmp = await mkdtemp(path.join(tmpdir(), 'yena-project-'));
	try {
		for (const [i, plan] of plans.entries()) {
			plan.patch = await stagePatch(git, path.join(stage.path, plan.repo), plan.base, plan.excludes, tmp, String(i));
			plan.files = (plan.patch.toString('latin1').match(/^diff --git /gm) ?? []).length;
		}
	} finally {
		await rm(tmp, {recursive: true, force: true}).catch(() => {});
	}

	const changed = plans.filter(x => x.files > 0);
	const targets = new Map<string, string>();
	const problems: string[] = [];
	for (const plan of changed) {
		try {
			const target = plan.repo === '' ? project : await insideDir(project, plan.repo);
			await requireRepo(git, target, plan.repo === '' ? 'project' : 'project repository');
			const status = await git(target, ['status', '--porcelain', '--untracked-files=all', '--', '.', ...literalExcludes(plan.inner)]);
			if (status.code !== 0) throw new Error(`git status failed in ${target}: ${clip(status.stderr)}`);
			if (status.stdout.length > 0) throw new Error(`${target} has uncommitted changes; commit or stash them before applying a stage`);
			targets.set(plan.repo, target);
		} catch (error) {
			problems.push((error as Error).message);
		}
	}
	if (problems.length === 1) throw new Error(problems[0]);
	if (problems.length > 1) throw new Error(`Stage ${stage.id} was not applied; nothing was changed:\n${problems.map(m => `  ${m}`).join('\n')}`);

	const repos: RepoResult[] = [];
	for (const plan of plans) {
		const target = targets.get(plan.repo);
		if (plan.files === 0 || target === undefined) {
			repos.push({repo: plan.repo, files: 0, outcome: 'unchanged'});
			continue;
		}
		repos.push({repo: plan.repo, files: plan.files, ...(await applyPatch(git, target, plan.patch))});
	}
	return {files: repos.reduce((n, r) => n + r.files, 0), repos, legacy, legacyNested};
}

async function applyPatch(git: Git, target: string, patch: Buffer): Promise<Pick<RepoResult, 'outcome' | 'detail'>> {
	try {
		const apply = await git(target, ['apply', '--3way', '--whitespace=nowarn', '-'], {input: patch});
		if (apply.code !== 0) {
			const unmerged = await git(target, ['diff', '--name-only', '--diff-filter=U']);
			if (unmerged.code === 0 && unmerged.stdout.length > 0) return {outcome: 'conflicts', detail: oneLine(unmerged.stdout.toString('utf8'))};
			return {outcome: 'failed', detail: oneLine(apply.stderr)};
		}
		await git(target, ['reset', '--quiet']);
		return {outcome: 'applied'};
	} catch (error) {
		return {outcome: 'failed', detail: clip((error as Error).message)};
	}
}

export async function removeStage(layout: Layout, sessionId: string, stage: StageRecord): Promise<void> {
	const expected = stageDir(layout, stage.project, sessionId, stage.id);
	if (stage.path !== expected) throw new Error(`Refusing to remove ${stage.path}`);
	const st = await lstat(expected).catch(() => undefined);
	if (!st) return;
	if (!st.isDirectory()) throw new Error(`Refusing to remove ${expected}: not a folder`);
	await rm(expected, {recursive: true, force: true});
}
