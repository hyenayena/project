import {mkdirSync} from 'node:fs';
import path from 'node:path';
import type {ModulePlugin} from '../../../src/api.js';
import {createProjectCommand} from './commands.js';
import {noopLog} from './log.js';
import {type Layout, readState, STATE_FILE, writeState} from './state.js';

export const WORKPLACE_DIR = '/workplace';
export const STAGE_DIR = '/stage';

/** md/projects/<name> in the md module's hub (<YENA_DATA>/md). */
export const layoutFor = (dataDir: string, base: Partial<Layout> = {}): Layout => ({
	workplace: base.workplace ?? WORKPLACE_DIR,
	stage: base.stage ?? STAGE_DIR,
	md: base.md ?? path.join(path.dirname(dataDir), 'md', 'projects'),
});

export function createPlugin(base: Partial<Layout> = {}): ModulePlugin {
	return host => {
		const log = host.log ?? noopLog;
		const layout = layoutFor(host.dataDir, base);
		// The state file also tells the claude module where projects live, so it is written at load.
		const file = path.join(host.dataDir, STATE_FILE);
		try {
			writeState(file, readState(file, layout));
		} catch (error) {
			log.warn('state not written', {err: error});
		}
		// Present before a chat starts, so the chat can register it as a working dir.
		try {
			mkdirSync(layout.stage, {recursive: true});
		} catch (error) {
			log.warn('stage dir not created', {err: error});
		}
		return [createProjectCommand({layout, dataDir: host.dataDir, log})];
	};
}

export default createPlugin();
