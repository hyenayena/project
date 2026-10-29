import {randomBytes} from 'node:crypto';
import {mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {isProjectName, NAME_RE, STATE_FILE, STATE_VERSION} from './public.js';

// The state file is read by other modules only through src/public.ts (accessReader, isolatedProjects),
// which must change together with this writer.
export {NAME_RE, STATE_FILE, STATE_VERSION};
const SESSION_RE = /^[0-9a-f]{8}$/;
const SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

export type Layout = {
	/** Mounted project folders: <workplace>/<name>. */
	workplace: string;
	/** Stage copies: <stage>/<name>-stage-<session>-<id>. */
	stage: string;
	/** Project docs in the md hub: <md>/<name>. */
	md: string;
};

export type StageRecord = {
	project: string;
	id: number;
	path: string;
	/** The project's HEAD when the stage was made; apply moves the stage's changes since then. */
	base: string | null;
	/** Repositories inside the project (relative paths); missing in records made before they were tracked. */
	nested?: NestedBase[];
	/** node_modules folders the stage links to instead of copying (relative paths). */
	links?: string[];
};

/** A repository inside the project, with its HEAD when the stage was made. */
export type NestedBase = {path: string; base: string | null};

export type Session = {
	id: string;
	startedAt: string;
	isolated: string[];
	nextStage: number;
	stages: StageRecord[];
};

export type ProjectState = Layout & {v: typeof STATE_VERSION; session: Session | null};

export const isName = isProjectName;

export function checkName(v: string | undefined): string {
	if (!isName(v)) throw new Error('Invalid project name: use letters, digits, ".", "_" or "-" (up to 64)');
	return v;
}

export const stageDir = (layout: Layout, project: string, session: string, id: number): string =>
	path.join(layout.stage, `${project}-stage-${session}-${id}`);

export const newSessionId = (): string => randomBytes(4).toString('hex');

export const emptyState = (layout: Layout): ProjectState => ({v: STATE_VERSION, ...layout, session: null});

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export const MAX_NESTED = 64;
export const MAX_LINKS = 256;
const REL_MAX = 4096;

/** A plain relative path inside a project: no `..`, `.`, `.git` or empty segments. */
export function isRelPath(v: unknown): v is string {
	if (typeof v !== 'string' || v === '' || v.length > REL_MAX || v.includes('\0')) return false;
	if (path.posix.isAbsolute(v) || path.posix.normalize(v) !== v) return false;
	return v.split('/').every(seg => seg !== '' && seg !== '.' && seg !== '..' && seg !== '.git');
}

const isBase = (v: unknown): v is string | null => v === null || (typeof v === 'string' && SHA_RE.test(v));

function parseNested(v: unknown): NestedBase[] {
	if (!Array.isArray(v) || v.length > MAX_NESTED) throw new Error('stage nested');
	const out: NestedBase[] = [];
	for (const n of v as unknown[]) {
		if (!isRecord(n) || !isRelPath(n.path) || !isBase(n.base)) throw new Error('stage nested');
		out.push({path: n.path, base: n.base});
	}
	if (new Set(out.map(n => n.path)).size !== out.length) throw new Error('stage nested');
	return out;
}

function parseLinks(v: unknown): string[] {
	if (!Array.isArray(v) || v.length > MAX_LINKS || !v.every(isRelPath) || new Set(v).size !== v.length) throw new Error('stage links');
	return [...v] as string[];
}

function parseSession(raw: unknown, layout: Layout): Session | null {
	if (raw === null) return null;
	if (!isRecord(raw)) throw new Error('session');
	const {id, startedAt, isolated, nextStage, stages} = raw;
	if (typeof id !== 'string' || !SESSION_RE.test(id)) throw new Error('session id');
	if (typeof startedAt !== 'string') throw new Error('startedAt');
	if (!Array.isArray(isolated) || !isolated.every(isName) || new Set(isolated).size !== isolated.length) throw new Error('isolated');
	if (!Number.isSafeInteger(nextStage) || (nextStage as number) < 1) throw new Error('nextStage');
	if (!Array.isArray(stages)) throw new Error('stages');
	const out: StageRecord[] = [];
	for (const s of stages as unknown[]) {
		if (!isRecord(s) || !isName(s.project) || !Number.isSafeInteger(s.id)) throw new Error('stage');
		const sid = s.id as number;
		if (sid < 1 || sid >= (nextStage as number)) throw new Error('stage id');
		// A stage path is always derived, so a tampered file cannot point finish at another folder.
		if (s.path !== stageDir(layout, s.project, id, sid)) throw new Error('stage path');
		if (!isBase(s.base)) throw new Error('stage base');
		const record: StageRecord = {project: s.project, id: sid, path: s.path, base: s.base};
		if (s.nested !== undefined) record.nested = parseNested(s.nested);
		if (s.links !== undefined) record.links = parseLinks(s.links);
		out.push(record);
	}
	return {id, startedAt, isolated: [...isolated] as string[], nextStage: nextStage as number, stages: out};
}

/** Missing file: a fresh state. Unreadable or invalid: throws, so stages are never forgotten silently. */
export function readState(file: string, layout: Layout): ProjectState {
	let text: string;
	try {
		text = readFileSync(file, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState(layout);
		throw new Error(`Cannot read the project state file ${file}`);
	}
	try {
		const raw: unknown = JSON.parse(text);
		if (!isRecord(raw) || raw.v !== STATE_VERSION) throw new Error('version');
		// Paths always come from the current layout; stage paths are checked against it.
		return {v: STATE_VERSION, ...layout, session: parseSession(raw.session ?? null, layout)};
	} catch {
		throw new Error(`The project state file ${file} is invalid; fix or delete it (stages listed in it are then not removed by finish)`);
	}
}

/** Atomic: readers (other processes) see either the old or the new file. */
export function writeState(file: string, state: ProjectState): void {
	mkdirSync(path.dirname(file), {recursive: true});
	const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(state, null, '\t')}\n`, {mode: 0o644});
	renameSync(tmp, file);
}
