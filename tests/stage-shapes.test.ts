import assert from 'node:assert/strict';
import {existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {after, describe, it} from 'node:test';
import {runGit} from '../src/git.js';
import {applyStage, makeStage, removeStage} from '../src/stage.js';
import type {Session, StageRecord} from '../src/state.js';
import {git, repo, sandbox} from './helpers.js';

const box = sandbox('shapes');
after(box.cleanup);
const {layout} = box;
const session: Session = {id: 'cd34ef56', startedAt: 'x', isolated: ['yena'], nextStage: 1, stages: []};
let next = 1;
const make = (project: string) => makeStage({layout, session, project, id: next++, git: runGit});
const apply = (stage: StageRecord) => applyStage({layout, stage, git: runGit});
const status = (dir: string) => git(dir, 'status', '--porcelain', '--untracked-files=all');

describe('a workplace project shaped like yena', () => {
	const yena = path.join(layout.workplace, 'yena');
	const mods = ['core', 'claude', 'project'];
	repo(yena, {'.gitignore': 'modules/\nnode_modules/\n', 'src/cli.ts': 'cli\n'});
	mkdirSync(path.join(yena, 'node_modules', '.bin'), {recursive: true});
	writeFileSync(path.join(yena, 'node_modules', '.bin', 'tsc'), 'tsc');
	for (const m of mods) {
		const dir = path.join(yena, 'modules', m);
		repo(dir, {'.gitignore': 'node_modules/\n', 'src/index.ts': `${m}\n`, 'bin/blob.bin': 'bin\u0000ary'});
		mkdirSync(path.join(dir, 'node_modules', 'dep'), {recursive: true});
		writeFileSync(path.join(dir, 'node_modules', 'dep', 'i.js'), 'dep');
	}
	repo(path.join(yena, 'modules', 'tracked'), {'node_modules/keep.js': 'k\n', 'a.txt': 'a\n'});

	it('links every ignored node_modules, keeps stage repositories clean and the state free of absolute paths', async () => {
		const stage = await make('yena');
		assert.equal(readlinkSync(path.join(stage.path, 'node_modules')), path.join(yena, 'node_modules'));
		for (const m of mods) {
			const link = path.join(stage.path, 'modules', m, 'node_modules');
			assert.ok(lstatSync(link).isSymbolicLink());
			assert.ok(path.isAbsolute(readlinkSync(link)));
			assert.equal(status(path.join(stage.path, 'modules', m)), '');
		}
		assert.ok(lstatSync(path.join(stage.path, 'modules', 'tracked', 'node_modules')).isDirectory());
		assert.equal(status(stage.path), '');
		const json = JSON.stringify(stage.nested) + JSON.stringify(stage.links);
		assert.ok(!json.includes(layout.workplace) && !json.includes(layout.stage), json);
		assert.ok([...(stage.links ?? []), ...(stage.nested ?? []).map(n => n.path)].every(p => !path.isAbsolute(p)));
		await removeStage(layout, session.id, stage);
		assert.equal(readFileSync(path.join(yena, 'modules', 'core', 'node_modules', 'dep', 'i.js'), 'utf8'), 'dep');
		assert.equal(readFileSync(path.join(yena, 'node_modules', '.bin', 'tsc'), 'utf8'), 'tsc');
	});

	it('brings edits in two modules and the outer repository over, nothing staged, links untouched', async () => {
		const stage = await make('yena');
		writeFileSync(path.join(stage.path, 'src', 'cli.ts'), 'cli2\n');
		const core = path.join(stage.path, 'modules', 'core');
		writeFileSync(path.join(core, 'src', 'index.ts'), 'core2\n');
		git(core, 'commit', '-qam', 'work in the stage');
		writeFileSync(path.join(stage.path, 'modules', 'project', 'src', 'new.ts'), 'new\n');
		const result = await apply(stage);
		assert.equal(result.files, 3);
		assert.equal(result.legacy, false);
		assert.equal(status(yena), ' M src/cli.ts\n');
		assert.equal(status(path.join(yena, 'modules', 'core')), ' M src/index.ts\n');
		assert.equal(status(path.join(yena, 'modules', 'project')), '?? src/new.ts\n');
		assert.equal(status(path.join(yena, 'modules', 'claude')), '');
		for (const dir of [yena, path.join(yena, 'modules', 'core')]) assert.equal(git(dir, 'diff', '--cached', '--name-only'), '');
		assert.ok(lstatSync(path.join(yena, 'node_modules')).isDirectory());
		for (const dir of [yena, ...mods.map(m => path.join(yena, 'modules', m))]) {
			git(dir, 'reset', '-q', '--hard');
			git(dir, 'clean', '-qfd');
		}
	});

	it('brings deleted, renamed, binary and committed work in a nested repository over', async () => {
		const stage = await make('yena');
		const claude = path.join(stage.path, 'modules', 'claude');
		git(claude, 'mv', 'src/index.ts', 'src/main.ts');
		writeFileSync(path.join(claude, 'bin', 'blob.bin'), Buffer.from([0, 1, 2, 255, 0, 7]));
		writeFileSync(path.join(claude, 'bin', 'extra.bin'), Buffer.from([9, 0, 9]));
		git(claude, 'commit', '-qm', 'rename');
		rmSync(path.join(stage.path, 'modules', 'tracked', 'a.txt'));
		const result = await apply(stage);
		assert.ok(result.repos.every(r => r.outcome === 'applied' || r.outcome === 'unchanged'));
		const target = path.join(yena, 'modules', 'claude');
		assert.ok(!existsSync(path.join(target, 'src', 'index.ts')));
		assert.equal(readFileSync(path.join(target, 'src', 'main.ts'), 'utf8'), 'claude\n');
		assert.deepEqual([...readFileSync(path.join(target, 'bin', 'blob.bin'))], [0, 1, 2, 255, 0, 7]);
		assert.deepEqual([...readFileSync(path.join(target, 'bin', 'extra.bin'))], [9, 0, 9]);
		assert.ok(!existsSync(path.join(yena, 'modules', 'tracked', 'a.txt')));
		assert.equal(git(target, 'diff', '--cached', '--name-only'), '');
		assert.equal(git(target, 'log', '--oneline').trim().split('\n').length, 1);
		for (const dir of [target, path.join(yena, 'modules', 'tracked')]) {
			git(dir, 'reset', '-q', '--hard');
			git(dir, 'clean', '-qfd');
		}
	});

	it('lists every problem together and changes nothing', async () => {
		const stage = await make('yena');
		writeFileSync(path.join(stage.path, 'src', 'cli.ts'), 'x\n');
		writeFileSync(path.join(stage.path, 'modules', 'core', 'src', 'index.ts'), 'x\n');
		writeFileSync(path.join(stage.path, 'modules', 'claude', 'src', 'index.ts'), 'x\n');
		writeFileSync(path.join(yena, 'modules', 'core', 'dirty'), 'd');
		writeFileSync(path.join(yena, 'modules', 'claude', 'dirty'), 'd');
		await assert.rejects(apply(stage), (e: Error) => /nothing was changed/.test(e.message) && /modules\/core/.test(e.message) && /modules\/claude/.test(e.message));
		assert.equal(readFileSync(path.join(yena, 'src', 'cli.ts'), 'utf8'), 'cli\n');
		rmSync(path.join(yena, 'modules', 'core', 'dirty'));
		rmSync(path.join(yena, 'modules', 'claude', 'dirty'));
	});

	it('refuses a stage repository reached through a symlink named like a module', async () => {
		const stage = await make('yena');
		writeFileSync(path.join(stage.path, 'modules', 'core', 'src', 'index.ts'), 'x\n');
		const real = path.join(yena, 'modules', 'core');
		renameSync(real, path.join(yena, 'core-real'));
		symlinkSync(path.join(yena, 'core-real'), real);
		try {
			await assert.rejects(apply(stage), /is not a folder \(or is a symlink\)/);
			assert.equal(status(path.join(yena, 'core-real')), '');
		} finally {
			rmSync(real);
			renameSync(path.join(yena, 'core-real'), real);
		}
	});
});

describe('awkward repositories', () => {
	it('handles a nested repository without commits and names with spaces, unicode and a leading dash', async () => {
		const dir = path.join(layout.workplace, 'odd');
		repo(dir, {'.gitignore': 'mods/\n', 'r.txt': 'r\n'});
		for (const name of ['with space', 'ünï', '-dash']) repo(path.join(dir, 'mods', name), {'f.txt': `${name}\n`});
		const empty = path.join(dir, 'mods', 'empty');
		mkdirSync(empty, {recursive: true});
		git(empty, 'init', '-q', '-b', 'main');
		const stage = await make('odd');
		assert.equal(stage.nested?.find(n => n.path === 'mods/empty')?.base, null);
		for (const name of ['with space', 'ünï', '-dash']) writeFileSync(path.join(stage.path, 'mods', name, 'f.txt'), 'changed\n');
		writeFileSync(path.join(stage.path, 'mods', 'empty', 'first.txt'), 'first\n');
		const result = await apply(stage);
		assert.ok(result.repos.every(r => r.repo === '' ? r.outcome === 'unchanged' : r.outcome === 'applied'), JSON.stringify(result.repos));
		for (const name of ['with space', 'ünï', '-dash']) assert.equal(readFileSync(path.join(dir, 'mods', name, 'f.txt'), 'utf8'), 'changed\n');
		assert.equal(readFileSync(path.join(empty, 'first.txt'), 'utf8'), 'first\n');
		assert.equal(git(empty, 'diff', '--cached', '--name-only'), '');
	});

	it('refuses a worktree-style stage repository whose .git file points at the original', async () => {
		const dir = path.join(layout.workplace, 'wt');
		repo(dir, {'.gitignore': 'm/\n', 'r.txt': 'r\n'});
		repo(path.join(dir, 'm', 'one'), {'f.txt': 'f\n'});
		const stage = await make('wt');
		const one = path.join(stage.path, 'm', 'one');
		rmSync(path.join(one, '.git'), {recursive: true});
		writeFileSync(path.join(one, '.git'), `gitdir: ${path.join(dir, 'm', 'one', '.git')}\n`);
		writeFileSync(path.join(one, 'f.txt'), 'changed\n');
		await assert.rejects(apply(stage), /keeps its git data outside the stage/);
		assert.equal(readFileSync(path.join(dir, 'm', 'one', 'f.txt'), 'utf8'), 'f\n');
	});

	it('applies a record without nested fields as before, with the legacy note', async () => {
		const dir = path.join(layout.workplace, 'old');
		repo(dir, {'a.txt': 'a\n'});
		const stage = await make('old');
		const legacy: StageRecord = {project: stage.project, id: stage.id, path: stage.path, base: stage.base};
		writeFileSync(path.join(stage.path, 'a.txt'), 'b\n');
		const result = await apply(legacy);
		assert.equal(result.legacy, true);
		assert.equal(result.legacyNested, false);
		assert.equal(result.files, 1);
		assert.equal(readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'b\n');
	});
});
