import assert from 'node:assert/strict';
import {existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {after, describe, it} from 'node:test';
import {runGit} from '../src/git.js';
import {applyStage, makeStage, removeStage, scanTree} from '../src/stage.js';
import type {Session, StageRecord} from '../src/state.js';
import {git, repo, sandbox} from './helpers.js';

const box = sandbox('stage');
after(box.cleanup);
const {layout} = box;
const session: Session = {id: 'ab12cd34', startedAt: 'x', isolated: ['web'], nextStage: 1, stages: []};
let next = 1;
const make = (project: string) => makeStage({layout, session, project, id: next++, git: runGit});
const status = (dir: string) => git(dir, 'status', '--porcelain', '--untracked-files=all');

describe('makeStage', () => {
	it('copies the folder as it is, uncommitted and ignored files and symlinks included', async () => {
		const web = path.join(layout.workplace, 'web');
		repo(web, {'a.txt': 'a\n', '.gitignore': 'deps/\n'});
		writeFileSync(path.join(web, 'a.txt'), 'a changed\n');
		mkdirSync(path.join(web, 'deps'));
		writeFileSync(path.join(web, 'deps', 'lib.js'), 'x');
		symlinkSync('a.txt', path.join(web, 'link'));
		const stage = await make('web');
		assert.equal(stage.path, path.join(layout.stage, `web-stage-ab12cd34-${stage.id}`));
		assert.match(stage.base ?? '', /^[0-9a-f]{40}/);
		assert.equal(readFileSync(path.join(stage.path, 'a.txt'), 'utf8'), 'a changed\n');
		assert.ok(existsSync(path.join(stage.path, 'deps', 'lib.js')));
		assert.equal(readlinkSync(path.join(stage.path, 'link')), 'a.txt');
		git(web, 'checkout', '--', 'a.txt');
		rmSync(path.join(web, 'link'));
	});

	it('refuses a project without a folder and an existing target', async () => {
		await assert.rejects(make('missing'), /has no folder/);
		const stage = await make('web');
		await assert.rejects(makeStage({layout, session, project: 'web', id: stage.id, git: runGit}), /already exists/);
	});
});

describe('applyStage', () => {
	it('moves committed and uncommitted stage changes into the project, uncommitted', async () => {
		const web = path.join(layout.workplace, 'web');
		const stage = await make('web');
		writeFileSync(path.join(stage.path, 'a.txt'), 'a from stage\n');
		git(stage.path, 'commit', '-qam', 'stage commit');
		writeFileSync(path.join(stage.path, 'new.txt'), 'new\n');
		writeFileSync(path.join(stage.path, 'deps', 'ignored.js'), 'x');
		git(stage.path, 'add', 'new.txt');
		const stagedBefore = git(stage.path, 'diff', '--cached', '--name-only');

		const result = await applyStage({layout, stage, git: runGit});
		assert.equal(result.files, 2);
		assert.equal(readFileSync(path.join(web, 'a.txt'), 'utf8'), 'a from stage\n');
		assert.equal(readFileSync(path.join(web, 'new.txt'), 'utf8'), 'new\n');
		assert.ok(!existsSync(path.join(web, 'deps', 'ignored.js')));
		assert.equal(git(web, 'diff', '--cached', '--name-only'), '', 'nothing is left staged');
		assert.equal(git(web, 'log', '--oneline').trim().split('\n').length, 1, 'no commit is made');
		assert.equal(git(stage.path, 'diff', '--cached', '--name-only'), stagedBefore, "the stage's index is untouched");
		git(web, 'checkout', '--', '.');
		rmSync(path.join(web, 'new.txt'));
	});

	it('refuses a project with uncommitted changes', async () => {
		const web = path.join(layout.workplace, 'web');
		const stage = await make('web');
		writeFileSync(path.join(stage.path, 'a.txt'), 'b\n');
		writeFileSync(path.join(web, 'other.txt'), 'dirty');
		await assert.rejects(applyStage({layout, stage, git: runGit}), /has uncommitted changes/);
		rmSync(path.join(web, 'other.txt'));
		assert.equal(status(web), '');
	});

	it('reports no changes for an untouched stage', async () => {
		const stage = await make('web');
		assert.deepEqual(await applyStage({layout, stage, git: runGit}), {
			files: 0,
			repos: [{repo: '', files: 0, outcome: 'unchanged'}],
			legacy: false,
			legacyNested: false,
		});
	});

	it('applies onto a project that moved on, and reports conflicts', async () => {
		const web = path.join(layout.workplace, 'web');
		const stage = await make('web');
		writeFileSync(path.join(web, 'b.txt'), 'b\n');
		git(web, 'add', 'b.txt');
		git(web, 'commit', '-qm', 'b');
		writeFileSync(path.join(stage.path, 'c.txt'), 'c\n');
		assert.equal((await applyStage({layout, stage, git: runGit})).files, 1);
		rmSync(path.join(web, 'c.txt'));

		const clash = await make('web');
		writeFileSync(path.join(clash.path, 'a.txt'), 'stage side\n');
		writeFileSync(path.join(web, 'a.txt'), 'project side\n');
		git(web, 'commit', '-qam', 'project side');
		const result = await applyStage({layout, stage: clash, git: runGit});
		assert.equal(result.repos[0]?.outcome, 'conflicts');
		assert.match(result.repos[0]?.detail ?? '', /a\.txt/);
		assert.match(readFileSync(path.join(web, 'a.txt'), 'utf8'), /<<<<<<<|>>>>>>>/);
		git(web, 'reset', '-q', '--hard');
	});

	it('refuses a folder that is not its own repository', async () => {
		const plain = path.join(layout.workplace, 'plain');
		mkdirSync(plain);
		writeFileSync(path.join(plain, 'x'), 'x');
		const stage = await make('plain');
		assert.equal(stage.base, null);
		await assert.rejects(applyStage({layout, stage, git: runGit}), /not the top level of a git repository/);
	});
});

describe('removeStage', () => {
	it('removes the derived folder only', async () => {
		const stage = await make('web');
		await removeStage(layout, session.id, stage);
		assert.ok(!existsSync(stage.path));
		await removeStage(layout, session.id, stage);
		await assert.rejects(removeStage(layout, session.id, {...stage, path: layout.workplace}), /Refusing/);
		const other = {...stage, id: 999, path: path.join(layout.stage, 'web-stage-ab12cd34-999')};
		symlinkSync(layout.workplace, other.path);
		await assert.rejects(removeStage(layout, session.id, other), /not a folder/);
		assert.ok(existsSync(path.join(layout.workplace, 'web')));
	});
});

describe('scanTree', () => {
	const root = path.join(box.root, 'scan');
	const outside = path.join(box.root, 'scan-outside');
	mkdirSync(path.join(root, '.git'), {recursive: true});
	mkdirSync(path.join(root, 'modules', 'a', '.git'), {recursive: true});
	mkdirSync(path.join(root, 'modules', 'a', 'inner', 'deep'), {recursive: true});
	writeFileSync(path.join(root, 'modules', 'a', 'inner', 'deep', '.git'), 'gitdir: x\n');
	mkdirSync(path.join(root, 'node_modules', 'pkg', '.git'), {recursive: true});
	mkdirSync(path.join(root, 'lib', 'node_modules'), {recursive: true});
	mkdirSync(path.join(root, '1', '2', '3', '4', '5', '6', '7', '.git'), {recursive: true});
	mkdirSync(path.join(root, '1', '2', '3', '4', '5', '6', '.git'), {recursive: true});
	mkdirSync(path.join(outside, '.git'), {recursive: true});
	symlinkSync(path.join(root, 'modules', 'a'), path.join(root, 'linked'));
	symlinkSync(outside, path.join(root, 'out'));
	const limits = {depth: 6, folders: 50_000, repos: 64, nodeModules: 256};

	it('finds nested repositories and node_modules folders without following symlinks', async () => {
		assert.deepEqual(await scanTree(root), {
			repos: ['1/2/3/4/5/6', 'modules/a', 'modules/a/inner/deep'],
			nodeModules: ['lib/node_modules', 'node_modules'],
		});
	});

	it('refuses trees with too many repositories, node_modules or folders', async () => {
		await assert.rejects(scanTree(root, {...limits, repos: 2}), /too many nested repositories/);
		await assert.rejects(scanTree(root, {...limits, nodeModules: 1}), /too many node_modules/);
		await assert.rejects(scanTree(root, {...limits, folders: 3}), /too many folders/);
	});
});

describe('nested repositories', () => {
	const mono = path.join(layout.workplace, 'mono');
	repo(mono, {'.gitignore': 'node_modules/\nmodules/\n', 'a.txt': 'a\n'});
	mkdirSync(path.join(mono, 'node_modules', 'pkg'), {recursive: true});
	writeFileSync(path.join(mono, 'node_modules', 'pkg', 'index.js'), 'pkg');
	repo(path.join(mono, 'modules', 'a'), {'.gitignore': 'node_modules/\n', 'x.txt': 'x\n'});
	mkdirSync(path.join(mono, 'modules', 'a', 'node_modules', 'dep'), {recursive: true});
	writeFileSync(path.join(mono, 'modules', 'a', 'node_modules', 'dep', 'i.js'), 'dep');
	repo(path.join(mono, 'modules', 'b'), {'node_modules/keep.js': 'k\n', 'y.txt': 'y\n'});
	repo(path.join(mono, 'modules', 'c'), {'z.txt': 'z\n'});
	const headOf = (dir: string) => git(dir, 'rev-parse', 'HEAD').trim();
	const apply = (stage: StageRecord) => applyStage({layout, stage, git: runGit});
	const clean = () => {
		for (const dir of [mono, ...['a', 'b', 'c'].map(m => path.join(mono, 'modules', m))]) {
			git(dir, 'reset', '-q', '--hard');
			git(dir, 'clean', '-qfd');
		}
	};

	it('links ignored node_modules, copies tracked ones and records the nested repositories', async () => {
		const stage = await make('mono');
		assert.deepEqual(stage.nested, ['a', 'b', 'c'].map(m => ({path: `modules/${m}`, base: headOf(path.join(mono, 'modules', m))})));
		assert.deepEqual(stage.links, ['modules/a/node_modules', 'node_modules']);
		assert.equal(readlinkSync(path.join(stage.path, 'node_modules')), path.join(mono, 'node_modules'));
		assert.equal(readlinkSync(path.join(stage.path, 'modules', 'a', 'node_modules')), path.join(mono, 'modules', 'a', 'node_modules'));
		assert.ok(lstatSync(path.join(stage.path, 'modules', 'b', 'node_modules')).isDirectory());
		assert.ok(lstatSync(path.join(stage.path, 'modules', 'a', '.git')).isDirectory());
		assert.equal(status(stage.path), '');
		assert.equal(status(path.join(stage.path, 'modules', 'a')), '');
	});

	it('applies the outer and every changed nested repository, uncommitted', async () => {
		const stage = await make('mono');
		const a = path.join(stage.path, 'modules', 'a');
		writeFileSync(path.join(a, 'new.txt'), 'committed\n');
		git(a, 'add', 'new.txt');
		git(a, 'commit', '-qm', 'stage commit');
		writeFileSync(path.join(a, 'x.txt'), 'x changed\n');
		writeFileSync(path.join(a, 'u.txt'), 'untracked\n');
		writeFileSync(path.join(stage.path, 'a.txt'), 'a changed\n');
		writeFileSync(path.join(mono, 'modules', 'c', 'dirty.txt'), 'unrelated work');

		const result = await apply(stage);
		assert.deepEqual(result.repos.map(r => [r.repo, r.outcome, r.files]), [
			['', 'applied', 1],
			['modules/a', 'applied', 3],
			['modules/b', 'unchanged', 0],
			['modules/c', 'unchanged', 0],
		]);
		assert.equal(result.files, 4);
		const target = path.join(mono, 'modules', 'a');
		assert.equal(readFileSync(path.join(target, 'x.txt'), 'utf8'), 'x changed\n');
		assert.equal(readFileSync(path.join(target, 'new.txt'), 'utf8'), 'committed\n');
		assert.equal(readFileSync(path.join(target, 'u.txt'), 'utf8'), 'untracked\n');
		assert.equal(readFileSync(path.join(mono, 'a.txt'), 'utf8'), 'a changed\n');
		for (const dir of [mono, target]) {
			assert.equal(git(dir, 'diff', '--cached', '--name-only'), '', 'nothing is left staged');
			assert.equal(git(dir, 'log', '--oneline').trim().split('\n').length, 1, 'no commit is made');
		}
		assert.ok(lstatSync(path.join(mono, 'node_modules')).isDirectory());
		assert.ok(lstatSync(path.join(target, 'node_modules')).isDirectory());
		assert.doesNotMatch(status(mono), /node_modules/);
		assert.doesNotMatch(status(target), /node_modules/);
		clean();
	});

	it('changes nothing when a changed target repository is dirty', async () => {
		const stage = await make('mono');
		writeFileSync(path.join(stage.path, 'a.txt'), 'outer\n');
		writeFileSync(path.join(stage.path, 'modules', 'a', 'x.txt'), 'nested\n');
		writeFileSync(path.join(mono, 'modules', 'a', 'dirty.txt'), 'dirty');
		await assert.rejects(apply(stage), /modules\/a has uncommitted changes/);
		assert.equal(readFileSync(path.join(mono, 'a.txt'), 'utf8'), 'a\n');
		clean();
	});

	it('refuses repositories added to or removed from the stage', async () => {
		const added = await make('mono');
		repo(path.join(added.path, 'modules', 'new'), {'n.txt': 'n\n'});
		await assert.rejects(apply(added), /modules\/new .*were not in the project when the stage was made/);
		const removed = await make('mono');
		rmSync(path.join(removed.path, 'modules', 'c'), {recursive: true});
		await assert.rejects(apply(removed), /missing from .*modules\/c/);
	});

	it('refuses a nested repository whose git data is outside the stage', async () => {
		const stage = await make('mono');
		const c = path.join(stage.path, 'modules', 'c');
		rmSync(path.join(c, '.git'), {recursive: true});
		writeFileSync(path.join(c, '.git'), `gitdir: ${path.join(mono, 'modules', 'c', '.git')}\n`);
		await assert.rejects(apply(stage), /keeps its git data outside the stage/);
	});

	it('refuses a target repository reached through a symlink', async () => {
		const stage = await make('mono');
		writeFileSync(path.join(stage.path, 'modules', 'c', 'z.txt'), 'z changed\n');
		renameSync(path.join(mono, 'modules', 'c'), path.join(mono, 'c-real'));
		symlinkSync(path.join(mono, 'c-real'), path.join(mono, 'modules', 'c'));
		try {
			await assert.rejects(apply(stage), /is not a folder \(or is a symlink\)/);
			assert.equal(readFileSync(path.join(mono, 'c-real', 'z.txt'), 'utf8'), 'z\n');
		} finally {
			rmSync(path.join(mono, 'modules', 'c'));
			renameSync(path.join(mono, 'c-real'), path.join(mono, 'modules', 'c'));
		}
	});

	it('applies the other repositories when one has conflicts', async () => {
		const stage = await make('mono');
		writeFileSync(path.join(stage.path, 'modules', 'a', 'x.txt'), 'stage side\n');
		writeFileSync(path.join(stage.path, 'modules', 'b', 'y.txt'), 'y changed\n');
		const target = path.join(mono, 'modules', 'a');
		writeFileSync(path.join(target, 'x.txt'), 'project side\n');
		git(target, 'commit', '-qam', 'project side');
		const result = await apply(stage);
		assert.deepEqual(result.repos.map(r => [r.repo, r.outcome]), [
			['', 'unchanged'],
			['modules/a', 'conflicts'],
			['modules/b', 'applied'],
			['modules/c', 'unchanged'],
		]);
		assert.match(result.repos[1]?.detail ?? '', /x\.txt/);
		assert.equal(readFileSync(path.join(mono, 'modules', 'b', 'y.txt'), 'utf8'), 'y changed\n');
		git(target, 'reset', '-q', '--hard', 'HEAD~1');
		clean();
	});

	it('applies only the outer repository of a legacy record', async () => {
		const stage = await make('mono');
		const legacy: StageRecord = {project: stage.project, id: stage.id, path: stage.path, base: stage.base};
		writeFileSync(path.join(stage.path, 'a.txt'), 'legacy\n');
		writeFileSync(path.join(stage.path, 'modules', 'a', 'x.txt'), 'not applied\n');
		const result = await apply(legacy);
		assert.equal(result.legacy, true);
		assert.equal(result.legacyNested, true);
		assert.deepEqual(result.repos.map(r => [r.repo, r.outcome]), [['', 'applied']]);
		assert.equal(readFileSync(path.join(mono, 'a.txt'), 'utf8'), 'legacy\n');
		assert.equal(readFileSync(path.join(mono, 'modules', 'a', 'x.txt'), 'utf8'), 'x\n');
		clean();
	});

	it('removes a stage with links without touching the linked folders', async () => {
		const stage = await make('mono');
		await removeStage(layout, session.id, stage);
		assert.ok(!existsSync(stage.path));
		assert.equal(readFileSync(path.join(mono, 'node_modules', 'pkg', 'index.js'), 'utf8'), 'pkg');
		assert.equal(readFileSync(path.join(mono, 'modules', 'a', 'node_modules', 'dep', 'i.js'), 'utf8'), 'dep');
	});
});
