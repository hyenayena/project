import assert from 'node:assert/strict';
import {mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {after, describe, it} from 'node:test';
import {accessReader, docsRootFor, isolatedProjects, isProjectName, parseProjectAccess, projectDataDirFor, stateFileFor} from '../src/public.js';
import {sandbox} from './helpers.js';

const box = sandbox('public');
after(box.cleanup);
const workplace = '/w';
const stage = '/s';
const docs = '/data/md/projects';
const state = (session: unknown) => JSON.stringify({v: 1, workplace, stage, md: '/elsewhere', session});

describe('public paths', () => {
	it('are derived from any module data dir', () => {
		assert.equal(projectDataDirFor('/data/claude'), '/data/project');
		assert.equal(stateFileFor('/data/task'), '/data/project/state.json');
		assert.equal(docsRootFor('/data/claude'), '/data/md/projects');
		assert.ok(isProjectName('web') && !isProjectName('..') && !isProjectName('a/b'));
	});
});

describe('parseProjectAccess', () => {
	it('gives roots and writable folders of the isolated projects only', () => {
		const access = parseProjectAccess(
			state({isolated: ['web'], stages: [{project: 'web', path: '/s/web-stage-ab12cd34-1'}, {project: 'api', path: '/s/api-stage-ab12cd34-2'}]}),
			docs,
		);
		assert.deepEqual(access.roots, [workplace, stage]);
		assert.equal(access.docs, docs, 'docs come from the caller, not from the file');
		assert.deepEqual(access.writable, ['/w/web', '/data/md/projects/web', '/s/web-stage-ab12cd34-1']);
	});

	it('locks everything when the file is invalid or tampered', () => {
		const locked = {roots: [], docs, managed: [docs], writable: []};
		for (const text of [
			'{',
			JSON.stringify({v: 2, workplace, stage, session: null}),
			JSON.stringify({v: 1, workplace: 'rel', stage, session: null}),
			JSON.stringify({v: 1, workplace: '/', stage, session: null}),
			state({isolated: ['../x'], stages: []}),
			state({isolated: ['web'], stages: [{project: 'web', path: '/w/web'}]}),
			state({isolated: ['web'], stages: [{project: 'web', path: '/s/api-stage-1'}]}),
		]) {
			assert.deepEqual(parseProjectAccess(text, docs), locked, text);
		}
	});
});

describe('readers', () => {
	const dataDir = path.join(box.root, 'data', 'task');
	const file = stateFileFor(dataDir);

	it('a missing file means nothing managed; an unreadable one locks', async () => {
		const reader = accessReader(dataDir);
		assert.equal(reader.dataDir, path.join(box.root, 'data', 'project'));
		assert.equal(await reader.read(), undefined);
		assert.equal(reader.readSync(), undefined);
		assert.deepEqual(isolatedProjects(dataDir), []);
		mkdirSync(file, {recursive: true});
		assert.deepEqual((await reader.read())?.writable, []);
		assert.deepEqual(reader.readSync()?.roots, []);
	});

	it('read the current file on every call', async () => {
		const dir = path.join(box.root, 'data2', 'claude');
		const f = stateFileFor(dir);
		mkdirSync(path.dirname(f), {recursive: true});
		const reader = accessReader(dir);
		writeFileSync(f, state(null));
		assert.deepEqual((await reader.read())?.writable, []);
		writeFileSync(f, state({id: 'ab12cd34', isolated: ['web'], stages: []}));
		assert.deepEqual(reader.readSync()?.writable, ['/w/web', path.join(docsRootFor(dir), 'web')]);
		assert.deepEqual(isolatedProjects(dir), ['web']);
		writeFileSync(f, state({id: 'ab12cd34', isolated: ['web', '../x'], stages: []}));
		assert.deepEqual(isolatedProjects(dir), []);
	});
});
