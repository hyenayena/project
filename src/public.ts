import {readFileSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {hubDirFor} from './deps/md.js';

export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export const isProjectName = (v: unknown): v is string => typeof v === 'string' && NAME_RE.test(v) && v !== '.' && v !== '..';

export const STATE_VERSION = 1;
export const STATE_FILE = 'state.json';
const MODULE = 'project';
const DOCS = 'projects';

export const projectDataDirFor = (moduleDataDir: string): string => path.join(path.dirname(moduleDataDir), MODULE);

export const stateFileFor = (moduleDataDir: string): string => path.join(projectDataDirFor(moduleDataDir), STATE_FILE);

export const docsRootFor = (moduleDataDir: string): string => path.join(hubDirFor(moduleDataDir), DOCS);

export type ProjectAccess = {
	roots: string[];
	docs: string;
	managed: string[];
	writable: string[];
};

const isRoot = (v: unknown): v is string =>
	typeof v === 'string' && path.isAbsolute(v) && path.normalize(v) === v && v !== '/' && !v.includes('\0');
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const locked = (docs: string): ProjectAccess => ({roots: [], docs, managed: [docs], writable: []});

export function parseProjectAccess(text: string, docs: string): ProjectAccess {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return locked(docs);
	}
	if (!isRecord(raw) || raw.v !== STATE_VERSION || !isRoot(raw.workplace) || !isRoot(raw.stage)) return locked(docs);
	const {workplace, stage} = raw;
	const access: ProjectAccess = {roots: [workplace, stage], docs, managed: [workplace, stage, docs], writable: []};
	const session = raw.session ?? null;
	if (session === null) return access;
	if (!isRecord(session) || !Array.isArray(session.isolated) || !Array.isArray(session.stages)) return locked(docs);
	if (!session.isolated.every(isProjectName)) return locked(docs);
	const isolated = new Set(session.isolated as string[]);
	for (const name of isolated) access.writable.push(path.join(workplace, name), path.join(docs, name));
	for (const s of session.stages as unknown[]) {
		if (!isRecord(s) || !isProjectName(s.project) || typeof s.path !== 'string') return locked(docs);
		if (path.dirname(s.path) !== stage || !path.basename(s.path).startsWith(`${s.project}-stage-`)) return locked(docs);
		if (isolated.has(s.project)) access.writable.push(s.path);
	}
	return access;
}

export type AccessReader = {
	dataDir: string;
	read(): Promise<ProjectAccess | undefined>;
	readSync(): ProjectAccess | undefined;
};

export function accessReader(moduleDataDir: string): AccessReader {
	const file = stateFileFor(moduleDataDir);
	const docs = docsRootFor(moduleDataDir);
	const onError = (error: unknown): ProjectAccess | undefined =>
		(error as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : locked(docs);
	return {
		dataDir: projectDataDirFor(moduleDataDir),
		read: async () => {
			try {
				return parseProjectAccess(await readFile(file, 'utf8'), docs);
			} catch (error) {
				return onError(error);
			}
		},
		readSync: () => {
			try {
				return parseProjectAccess(readFileSync(file, 'utf8'), docs);
			} catch (error) {
				return onError(error);
			}
		},
	};
}

export function isolatedProjects(moduleDataDir: string): string[] {
	try {
		const raw = JSON.parse(readFileSync(stateFileFor(moduleDataDir), 'utf8')) as unknown;
		if (!isRecord(raw) || raw.v !== STATE_VERSION || !isRecord(raw.session)) return [];
		const list = raw.session.isolated;
		return Array.isArray(list) && list.every(isProjectName) ? [...list] : [];
	} catch {
		return [];
	}
}
