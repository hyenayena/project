import assert from 'node:assert/strict';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {after, describe, it} from 'node:test';
import {createProjectCommand} from '../src/commands.js';
import plugin, {createPlugin, layoutFor} from '../src/index.js';
import {STATE_FILE} from '../src/state.js';
import {context, git, noopLog, repo, sandbox} from './helpers.js';

const box = sandbox('commands');
after(box.cleanup);
const {layout} = box;
repo(path.join(layout.workplace, 'web'), {'a.txt': 'a\n'});
repo(path.join(layout.workplace, 'api'), {'b.txt': 'b\n'});
mkdirSync(path.join(layout.md, 'notes'));
mkdirSync(path.join(layout.md, 'web'));

const command = createProjectCommand({layout, dataDir: box.dataDir, log: noopLog});
const stateFile = path.join(box.dataDir, STATE_FILE);
const state = () => (existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : {session: null});
const run = async (...args: string[]): Promise<string> => {
	const {printed, ctx} = context();
	await command.run(args, ctx);
	return printed.join('\n');
};

describe('project command', () => {
	it('declares agent policies: list is safe, everything that changes access asks', () => {
		const policy = Object.fromEntries((command.subcommands ?? []).map(s => [s.name, s.agent]));
		assert.deepEqual(policy, {list: 'safe', new: 'confirm', isolate: 'confirm', stage: 'confirm', finish: 'confirm', help: 'safe'});
		assert.equal(command.agent, 'confirm');
	});

	it('lists workplace and docs-only projects with no session', async () => {
		const out = await run('list');
		assert.match(out, /^ {2}api +files$/m);
		assert.match(out, /^ {2}notes +docs only$/m);
		assert.match(out, /^ {2}web +files, docs$/m);
		assert.match(out, /No work session: every project is read-only/);
		assert.match(await run(), /^Usage: project list/);
	});

	it('isolates known projects only, creating their docs folder', async () => {
		await assert.rejects(run('isolate'), /Usage: project isolate/);
		await assert.rejects(run('isolate', 'ghost'), /Unknown project: ghost/);
		await assert.rejects(run('isolate', '../web'), /Invalid project name/);
		assert.equal(state().session, null, 'a failed isolate starts no session');
		const out = await run('isolate', 'api', 'notes', 'api');
		assert.match(out, /Isolated api, notes \(work session [0-9a-f]{8}\)/);
		assert.ok(existsSync(path.join(layout.md, 'api')));
		assert.deepEqual(state().session.isolated, ['api', 'notes']);
		assert.match(await run('list'), /^ {2}api +files, docs +isolated$/m);
	});

	it('creates docs-only projects, never over an existing one', async () => {
		await assert.rejects(run('new'), /Usage: project new <project>/);
		await assert.rejects(run('new', 'a', 'b'), /Usage: project new <project>/);
		await assert.rejects(run('new', '../evil'), /Invalid project name/);
		await assert.rejects(run('new', 'api'), /Project api already exists/);
		await assert.rejects(run('new', 'notes'), /Project notes already exists/);
		const out = await run('new', 'draft');
		assert.match(out, /^Created docs-only project draft: /);
		assert.match(out, /run "project isolate draft"/);
		assert.ok(existsSync(path.join(layout.md, 'draft')));
		assert.ok(!existsSync(path.join(layout.workplace, 'draft')));
		assert.match(await run('list'), /^ {2}draft +docs only$/m);
		assert.ok(!state().session?.isolated.includes('draft'), 'a new project is not isolated');
	});

	it('makes stages with unique ids and prints only the absolute path', async () => {
		const sid = state().session.id;
		const first = await run('stage', 'make', 'web');
		const second = await run('stage', 'make', 'web');
		assert.equal(first, path.join(layout.stage, `web-stage-${sid}-1`));
		assert.equal(second, path.join(layout.stage, `web-stage-${sid}-2`));
		assert.ok(existsSync(path.join(second, 'a.txt')));
		await assert.rejects(run('stage', 'make', 'notes'), /docs only/);
		await assert.rejects(run('stage', 'make'), /Usage: project stage make/);
		assert.match(await run('list'), /web .*stages 1, 2/);
	});

	it('applies only stages of isolated projects', async () => {
		const sid = state().session.id;
		const stage = path.join(layout.stage, `web-stage-${sid}-1`);
		writeFileSync(path.join(stage, 'a.txt'), 'staged\n');
		await assert.rejects(run('stage', 'apply', 'web', '1'), /web is read-only; run "project isolate web" first/);
		await run('isolate', 'web');
		await assert.rejects(run('stage', 'apply', 'web', '9'), /No stage 9 of web/);
		await assert.rejects(run('stage', 'apply', 'web', 'x'), /must be a number/);
		assert.match(await run('stage', 'apply', 'web', '1'), /Applied stage 1 to .*web: 1 file changed, left uncommitted/);
		assert.equal(readFileSync(path.join(layout.workplace, 'web', 'a.txt'), 'utf8'), 'staged\n');
		assert.ok(existsSync(stage), 'the stage is kept');
		git(path.join(layout.workplace, 'web'), 'checkout', '--', '.');
	});

	it('finish removes the stages and ends the session', async () => {
		const sid = state().session.id;
		const out = await run('finish');
		assert.match(out, new RegExp(`Work session ${sid} finished: every project is read-only, 2 stages removed`));
		assert.ok(!existsSync(path.join(layout.stage, `web-stage-${sid}-1`)));
		assert.equal(state().session, null);
		assert.match(await run('finish'), /No work session to finish/);
		const next = await run('stage', 'make', 'api');
		assert.doesNotMatch(next, new RegExp(sid), 'a new session gets a new id');
		await run('finish');
	});

	it('rejects unknown subcommands and extra arguments', async () => {
		await assert.rejects(run('nope'), /Unknown subcommand: nope/);
		await assert.rejects(run('list', 'x'), /Usage: project list/);
		await assert.rejects(run('finish', 'x'), /Usage: project finish/);
	});
});

describe('stage apply with nested repositories', () => {
	const mono = path.join(layout.workplace, 'mono');
	repo(mono, {'.gitignore': 'modules/\n', 'a.txt': 'a\n'});
	repo(path.join(mono, 'modules', 'a'), {'x.txt': 'x\n'});
	repo(path.join(mono, 'modules', 'b'), {'y.txt': 'y\n'});

	it('reports every changed repository, and fails when one has conflicts', async () => {
		await run('isolate', 'mono');
		const first = await run('stage', 'make', 'mono');
		const id = path.basename(first).split('-').pop();
		writeFileSync(path.join(first, 'a.txt'), 'outer\n');
		writeFileSync(path.join(first, 'modules', 'a', 'x.txt'), 'nested\n');
		assert.equal(
			await run('stage', 'apply', 'mono', id ?? ''),
			`Applied stage ${id} to ${mono}:\n  . : 1 file changed\n  modules/a: 1 file changed\nLeft uncommitted. The stage is kept.`,
		);
		git(mono, 'checkout', '--', '.');
		git(path.join(mono, 'modules', 'a'), 'checkout', '--', '.');

		const second = await run('stage', 'make', 'mono');
		const id2 = path.basename(second).split('-').pop() ?? '';
		writeFileSync(path.join(second, 'modules', 'a', 'x.txt'), 'stage side\n');
		writeFileSync(path.join(second, 'modules', 'b', 'y.txt'), 'y changed\n');
		writeFileSync(path.join(mono, 'modules', 'a', 'x.txt'), 'project side\n');
		git(path.join(mono, 'modules', 'a'), 'commit', '-qam', 'project side');
		await assert.rejects(
			run('stage', 'apply', 'mono', id2),
			/Error: Applied stage \d+ to .*mono:\n {2}modules\/a: conflicts in: x\.txt\n {2}modules\/b: 1 file changed\nLeft uncommitted/,
		);
		assert.equal(readFileSync(path.join(mono, 'modules', 'b', 'y.txt'), 'utf8'), 'y changed\n');
		await run('finish');
	});
});

describe('plugin', () => {
	it('puts docs in the md hub next to its data dir and writes the state at load', async () => {
		assert.equal(layoutFor('/data/project').md, '/data/md/projects');
		assert.equal(layoutFor('/data/project').workplace, '/workplace');
		const dataDir = path.join(box.root, 'other', 'project');
		const commands = await createPlugin({workplace: layout.workplace, stage: layout.stage})({dataDir, log: noopLog, events: {emit() {}, on: () => () => {}}});
		assert.deepEqual(commands.map(c => c.name), ['project']);
		const written = JSON.parse(readFileSync(path.join(dataDir, STATE_FILE), 'utf8'));
		assert.deepEqual(written, {v: 1, workplace: layout.workplace, stage: layout.stage, md: path.join(box.root, 'other', 'md', 'projects'), session: null});
		assert.equal(typeof plugin, 'function');
	});
});
