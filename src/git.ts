import {spawn} from 'node:child_process';

export type GitResult = {code: number; stdout: Buffer; stderr: string};
export type GitOptions = {input?: Buffer; env?: Record<string, string>};
export type Git = (cwd: string, args: string[], options?: GitOptions) => Promise<GitResult>;

const TIMEOUT_MS = 120_000;
const STDOUT_MAX = 256 * 1024 * 1024;
const STDERR_MAX = 64 * 1024;
const DROP_ENV = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'NODE_TEST_CONTEXT'];

function childEnv(extra: Record<string, string> | undefined): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {...process.env, GIT_TERMINAL_PROMPT: '0', ...extra};
	for (const name of DROP_ENV) delete env[name];
	return env;
}

export const runGit: Git = (cwd, args, options = {}) =>
	new Promise((resolve, reject) => {
		const child = spawn('git', ['-c', `safe.directory=${cwd}`, ...args], {
			cwd,
			env: childEnv(options.env),
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		const out: Buffer[] = [];
		let outLen = 0;
		let err = '';
		let failure: Error | undefined;
		const timer = setTimeout(() => {
			failure = new Error(`git ${args[0] ?? ''} timed out`);
			child.kill('SIGKILL');
		}, TIMEOUT_MS);
		child.stdout.on('data', (chunk: Buffer) => {
			outLen += chunk.length;
			if (outLen > STDOUT_MAX) {
				failure = new Error(`git ${args[0] ?? ''} output is too large`);
				child.kill('SIGKILL');
				return;
			}
			out.push(chunk);
		});
		child.stderr.on('data', (chunk: Buffer) => {
			if (err.length < STDERR_MAX) err += chunk.toString('utf8');
		});
		child.on('error', error => {
			clearTimeout(timer);
			reject(new Error(`Cannot run git: ${(error as NodeJS.ErrnoException).code ?? error.message}`));
		});
		child.on('close', code => {
			clearTimeout(timer);
			if (failure) reject(failure);
			else resolve({code: code ?? 1, stdout: Buffer.concat(out), stderr: err.slice(0, STDERR_MAX)});
		});
		child.stdin.on('error', () => {});
		child.stdin.end(options.input);
	});
