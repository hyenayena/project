import {readdirSync} from 'node:fs';
import {isName, type Layout} from './state.js';

export type ProjectInfo = {
	name: string;
	files: boolean;
	docs: boolean;
};

function folders(dir: string): string[] {
	try {
		return readdirSync(dir, {withFileTypes: true})
			.filter(e => e.isDirectory() && isName(e.name) && !e.name.startsWith('.'))
			.map(e => e.name);
	} catch {
		return [];
	}
}

export function listProjects(layout: Layout): ProjectInfo[] {
	const files = new Set(folders(layout.workplace));
	const docs = new Set(folders(layout.md));
	return [...new Set([...files, ...docs])]
		.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
		.map(name => ({name, files: files.has(name), docs: docs.has(name)}));
}

export const findProject = (layout: Layout, name: string): ProjectInfo | undefined =>
	listProjects(layout).find(p => p.name === name);
