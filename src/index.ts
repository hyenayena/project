import {mkdirSync} from 'node:fs';
import path from 'node:path';
import type {ModulePlugin} from '../../../src/api.js';
import {createProjectCommand} from './commands.js';
import {noopLog} from './log.js';
import {docsRootFor} from './public.js';
import {type Layout, readState, STATE_FILE, writeState} from './state.js';

export const WORKPLACE_DIR = '/workplace';
export const STAGE_DIR = '/stage';

export const layoutFor = (dataDir: string, base: Partial<Layout> = {}): Layout => ({
	workplace: base.workplace ?? WORKPLACE_DIR,
	stage: base.stage ?? STAGE_DIR,
	md: base.md ?? docsRootFor(dataDir),
});

export function createPlugin(base: Partial<Layout> = {}): ModulePlugin {
	return host => {
		const log = host.log ?? noopLog;
		const layout = layoutFor(host.dataDir, base);
		const file = path.join(host.dataDir, STATE_FILE);
		try {
			writeState(file, readState(file, layout));
		} catch (error) {
			log.warn('state not written', {err: error});
		}
		try {
			mkdirSync(layout.stage, {recursive: true});
		} catch (error) {
			log.warn('stage dir not created', {err: error});
		}
		return [createProjectCommand({layout, dataDir: host.dataDir, log})];
	};
}

export default createPlugin();
