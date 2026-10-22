import assert from 'node:assert/strict';
import {existsSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {after, describe, it} from 'node:test';
import {runGit} from '../src/git.js';
import {applyStage, makeStage, removeStage} from '../src/stage.js';
import type {Session} from '../src/state.js';
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
		assert.deepEqual(await applyStage({layout, stage, git: runGit}), {files: 0});
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
		await assert.rejects(applyStage({layout, stage: clash, git: runGit}), /with conflicts[\s\S]*a\.txt/);
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
