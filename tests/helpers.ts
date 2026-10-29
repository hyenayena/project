import {execFileSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import type {CommandContext, Logger} from '../../../src/api.js';
import type {Layout} from '../src/state.js';

export const noopLog: Logger = {error() {}, warn() {}, info() {}, debug() {}, child: () => noopLog, addRedactor() {}};

export type Sandbox = {root: string; dataDir: string; layout: Layout; cleanup: () => void};

export function sandbox(prefix: string): Sandbox {
	const root = realpathSync(mkdtempSync(path.join(tmpdir(), `project-${prefix}-`)));
	const layout: Layout = {
		workplace: path.join(root, 'workplace'),
		stage: path.join(root, 'stage'),
		md: path.join(root, 'data', 'md', 'projects'),
	};
	mkdirSync(layout.workplace, {recursive: true});
	mkdirSync(layout.md, {recursive: true});
	return {root, dataDir: path.join(root, 'data', 'project'), layout, cleanup: () => rmSync(root, {recursive: true, force: true})};
}

export const git = (cwd: string, ...args: string[]): string =>
	execFileSync('git', ['-c', `safe.directory=${cwd}`, ...args], {
		cwd,
		encoding: 'utf8',
		env: {...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t'},
	});

export function repo(dir: string, files: Record<string, string>): void {
	mkdirSync(dir, {recursive: true});
	git(dir, 'init', '-q', '-b', 'main');
	for (const [name, text] of Object.entries(files)) {
		mkdirSync(path.dirname(path.join(dir, name)), {recursive: true});
		writeFileSync(path.join(dir, name), text);
	}
	git(dir, 'add', '-A');
	git(dir, 'commit', '-q', '-m', 'init');
}

export function context(): {printed: string[]; ctx: CommandContext} {
	const printed: string[] = [];
	return {printed, ctx: {print: t => void printed.push(t), clear() {}, exit() {}}};
}
