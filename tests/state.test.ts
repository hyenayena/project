import assert from 'node:assert/strict';
import {readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {after, describe, it} from 'node:test';
import {checkName, emptyState, isName, readState, stageDir, STATE_FILE, writeState} from '../src/state.js';
import {sandbox} from './helpers.js';

const box = sandbox('state');
after(box.cleanup);
const file = path.join(box.dataDir, STATE_FILE);

describe('names', () => {
	it('accepts plain names and rejects paths', () => {
		for (const ok of ['web', 'api-2', 'my.app', 'A_b']) assert.ok(isName(ok), ok);
		for (const bad of ['', '.', '..', '.hidden', '-x', 'a/b', '../x', 'a b', 'x'.repeat(65), 7]) assert.ok(!isName(bad), String(bad));
		assert.throws(() => checkName('../etc'), /Invalid project name/);
	});

	it('derives stage folders from project, session and id', () => {
		assert.equal(stageDir(box.layout, 'web', 'ab12cd34', 3), path.join(box.layout.stage, 'web-stage-ab12cd34-3'));
	});
});

describe('state file', () => {
	it('is fresh when missing', () => {
		assert.deepEqual(readState(file, box.layout), emptyState(box.layout));
	});

	it('round-trips a session and takes paths from the current layout', () => {
		const state = {
			...emptyState(box.layout),
			session: {
				id: 'ab12cd34',
				startedAt: '2026-10-23T00:00:00.000Z',
				isolated: ['web'],
				nextStage: 2,
				stages: [{project: 'web', id: 1, path: stageDir(box.layout, 'web', 'ab12cd34', 1), base: null}],
			},
		};
		writeState(file, state);
		assert.deepEqual(readState(file, box.layout), state);
		const raw = JSON.parse(readFileSync(file, 'utf8'));
		assert.equal(raw.v, 1);
		assert.equal(raw.workplace, box.layout.workplace);
	});

	it('refuses an invalid or tampered file instead of forgetting stages', () => {
		const bad = (session: unknown) => {
			writeFileSync(file, JSON.stringify({v: 1, session}));
			assert.throws(() => readState(file, box.layout), /is invalid/);
		};
		writeFileSync(file, '{');
		assert.throws(() => readState(file, box.layout), /is invalid/);
		bad({id: 'ab12cd34', startedAt: 'x', isolated: ['../x'], nextStage: 1, stages: []});
		bad({id: 'ab12cd34', startedAt: 'x', isolated: [], nextStage: 2, stages: [{project: 'web', id: 1, path: '/etc', base: null}]});
		bad({id: 'ab12cd34', startedAt: 'x', isolated: [], nextStage: 1, stages: [{project: 'web', id: 1, path: stageDir(box.layout, 'web', 'ab12cd34', 1), base: null}]});
		bad({id: 'nope', startedAt: 'x', isolated: [], nextStage: 1, stages: []});
		writeFileSync(file, JSON.stringify({v: 2, session: null}));
		assert.throws(() => readState(file, box.layout), /is invalid/);
	});
});
