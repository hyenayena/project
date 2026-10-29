import {mkdir} from 'node:fs/promises';
import path from 'node:path';
import type {Command, Logger} from '../../../src/api.js';
import {type Git, runGit} from './git.js';
import {noopLog} from './log.js';
import {findProject, listProjects} from './projects.js';
import {checkName, type Layout, newSessionId, type ProjectState, readState, type Session, STATE_FILE, writeState} from './state.js';
import {applyStage, makeStage, removeStage} from './stage.js';

export type ProjectDeps = {
	layout: Layout;
	dataDir: string;
	log?: Logger;
	git?: Git;
	now?: () => Date;
};

const USAGE = 'project list | new <project> | isolate <project>… | stage make <project> | stage apply <project> <stageid> | finish';

const HELP = [
	`Usage: ${USAGE}`,
	'  list                              List the projects, what is isolated and the stages',
	'  new <project>                     Create a docs-only project: an empty docs folder, no workplace folder',
	'  isolate <project>…                Make projects and their docs writable for this work session',
	'  stage make <project>              Copy a project into a new stage; prints the stage path',
	'  stage apply <project> <stageid>   Move a stage\'s changes into the project (as uncommitted changes)',
	'  finish                            End the work session: everything read-only again, stages removed',
	'Every project is read-only until it is isolated.',
].join('\n');

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

export function createProjectCommand(deps: ProjectDeps): Command {
	const {layout} = deps;
	const log = deps.log ?? noopLog;
	const git = deps.git ?? runGit;
	const now = deps.now ?? (() => new Date());
	const file = path.join(deps.dataDir, STATE_FILE);

	// Commands may come from the console and an assistant at once; state changes go one at a time.
	let queue: Promise<unknown> = Promise.resolve();
	const serial = <T>(fn: () => Promise<T>): Promise<T> => {
		const next = queue.then(fn, fn);
		queue = next.catch(() => {});
		return next;
	};

	const load = (): ProjectState => readState(file, layout);
	const save = (state: ProjectState): void => writeState(file, state);
	const startSession = (state: ProjectState): Session => {
		state.session ??= {id: newSessionId(), startedAt: now().toISOString(), isolated: [], nextStage: 1, stages: []};
		return state.session;
	};

	const list = (): string => {
		const state = load();
		const projects = listProjects(layout);
		const s = state.session;
		const lines: string[] = [];
		if (projects.length === 0) lines.push(`No projects in ${layout.workplace} or ${layout.md}`);
		else {
			lines.push(`Projects (files in ${layout.workplace}, docs in ${layout.md}):`);
			const width = Math.max(...projects.map(p => p.name.length));
			for (const p of projects) {
				const where = p.files && p.docs ? 'files, docs' : p.files ? 'files' : 'docs only';
				const parts = [p.name.padEnd(width), where.padEnd(11)];
				if (s?.isolated.includes(p.name)) parts.push('isolated');
				const stages = s?.stages.filter(x => x.project === p.name).map(x => x.id) ?? [];
				if (stages.length > 0) parts.push(`stages ${stages.join(', ')}`);
				lines.push(`  ${parts.join('  ').trimEnd()}`);
			}
		}
		if (!s) lines.push('No work session: every project is read-only.');
		else {
			const iso = s.isolated.length > 0 ? `isolated ${s.isolated.join(', ')}` : 'nothing isolated';
			lines.push(`Work session ${s.id}: ${iso}, ${plural(s.stages.length, 'stage')}.`);
		}
		return lines.join('\n');
	};

	const create = async (name: string): Promise<string> => {
		const project = checkName(name);
		if (findProject(layout, project)) throw new Error(`Project ${project} already exists. Run "project list"`);
		const dir = path.join(layout.md, project);
		await mkdir(dir, {recursive: true});
		log.info('project created');
		return [
			`Created docs-only project ${project}: ${dir}`,
			`It is read-only like every project; run "project isolate ${project}" to work on it.`,
		].join('\n');
	};

	const isolate = async (names: string[]): Promise<string> => {
		if (names.length === 0) throw new Error('Usage: project isolate <project>…');
		const wanted = [...new Set(names.map(checkName))];
		for (const name of wanted) {
			if (!findProject(layout, name)) throw new Error(`Unknown project: ${name}. Run "project list"`);
		}
		const state = load();
		const s = startSession(state);
		for (const name of wanted) if (!s.isolated.includes(name)) s.isolated.push(name);
		for (const name of wanted) await mkdir(path.join(layout.md, name), {recursive: true});
		save(state);
		log.info('isolated', {count: wanted.length, total: s.isolated.length});
		const writable = wanted.flatMap(n => [
			...(findProject(layout, n)?.files ? [path.join(layout.workplace, n)] : []),
			path.join(layout.md, n),
		]);
		return [
			`Isolated ${wanted.join(', ')} (work session ${s.id}). Writable now: ${s.isolated.join(', ')}; every other project stays read-only.`,
			...writable.map(p => `  ${p}`),
		].join('\n');
	};

	const stageMake = async (name: string): Promise<string> => {
		const project = checkName(name);
		const info = findProject(layout, project);
		if (!info) throw new Error(`Unknown project: ${project}. Run "project list"`);
		if (!info.files) throw new Error(`${project} has docs only, nothing to stage`);
		const state = load();
		const s = startSession(state);
		const id = s.nextStage;
		// The id is used up even if the copy fails, so a half-copied leftover is never reused.
		s.nextStage += 1;
		save(state);
		const record = await makeStage({layout, session: s, project, id, git, log});
		const fresh = load();
		if (!fresh.session || fresh.session.id !== s.id) throw new Error('The work session ended while the stage was being made');
		fresh.session.stages.push(record);
		save(fresh);
		log.info('stage made', {id, isolated: fresh.session.isolated.includes(project), nested: record.nested?.length ?? 0, links: record.links?.length ?? 0});
		return record.path;
	};

	const stageApply = async (name: string, rawId: string): Promise<string> => {
		const project = checkName(name);
		if (!/^[1-9][0-9]{0,8}$/.test(rawId)) throw new Error('The stage id must be a number');
		const id = Number(rawId);
		const s = load().session;
		const stage = s?.stages.find(x => x.project === project && x.id === id);
		if (!s || !stage) throw new Error(`No stage ${id} of ${project} in this work session. Run "project list"`);
		if (!s.isolated.includes(project)) throw new Error(`${project} is read-only; run "project isolate ${project}" first`);
		const result = await applyStage({layout, stage, git});
		const changed = result.repos.filter(r => r.outcome !== 'unchanged');
		const conflicts = changed.filter(r => r.outcome === 'conflicts').length;
		const failed = changed.filter(r => r.outcome === 'failed').length;
		log.info('stage applied', {id, files: result.files, repos: changed.length, conflicts, failed, legacy: result.legacy});
		const target = path.join(layout.workplace, project);
		const note = result.legacy && result.legacyNested
			? [`Stage ${id} was made before nested repositories were recorded; only the outer repository was applied.`]
			: [];
		if (changed.length === 0) return [`Stage ${id} has no changes; ${target} is unchanged.`, ...note].join('\n');
		const only = changed[0];
		if (changed.length === 1 && only?.repo === '' && only.outcome === 'applied') {
			return [`Applied stage ${id} to ${target}: ${plural(result.files, 'file')} changed, left uncommitted. The stage is kept.`, ...note].join('\n');
		}
		const lines = changed.map(r => {
			const label = r.repo === '' ? '. ' : r.repo;
			if (r.outcome === 'applied') return `  ${label}: ${plural(r.files, 'file')} changed`;
			if (r.outcome === 'conflicts') return `  ${label}: conflicts in: ${r.detail ?? ''}`;
			return `  ${label}: not applied: ${r.detail ?? ''}`;
		});
		const report = [`Applied stage ${id} to ${target}:`, ...lines, ...note, 'Left uncommitted. The stage is kept.'].join('\n');
		if (conflicts > 0 || failed > 0) throw new Error(report);
		return report;
	};

	const finish = async (): Promise<string> => {
		const state = load();
		const s = state.session;
		if (!s) return 'No work session to finish; every project is already read-only.';
		const failed = [];
		for (const stage of s.stages) {
			try {
				await removeStage(layout, s.id, stage);
			} catch (error) {
				log.warn('stage not removed', {id: stage.id, err: error});
				failed.push(stage);
			}
		}
		if (failed.length > 0) {
			// Read-only again at once; the stages that could not be removed stay listed for the next finish.
			s.isolated = [];
			s.stages = failed;
			save(state);
			throw new Error(`Could not remove ${plural(failed.length, 'stage')}: ${failed.map(f => f.path).join(', ')}. Run "project finish" again`);
		}
		const removed = s.stages.length;
		state.session = null;
		save(state);
		log.info('session finished', {stages: removed});
		return `Work session ${s.id} finished: every project is read-only, ${plural(removed, 'stage')} removed.`;
	};

	return {
		name: 'project',
		description: 'Projects in the workplace: isolate them for writing, stage copies',
		usage: USAGE,
		agent: 'confirm',
		subcommands: [
			{name: 'list', aliases: ['ls'], usage: 'project list', description: 'List projects, isolation and stages', agent: 'safe'},
			{name: 'new', usage: 'project new <project>', description: 'Create a docs-only project', agent: 'confirm'},
			{name: 'isolate', usage: 'project isolate <project>…', description: 'Make projects writable for this work session', agent: 'confirm'},
			{
				name: 'stage',
				usage: 'project stage make <project> | apply <project> <stageid>',
				description: 'Make a stage copy or apply its changes',
				agent: 'confirm',
			},
			{name: 'finish', usage: 'project finish', description: 'End the work session and remove its stages', agent: 'confirm'},
			{name: 'help', usage: 'project help', description: 'Show the usage', agent: 'safe'},
		],
		async run(args, ctx) {
			const [sub, ...rest] = args;
			const exact = (n: number, usage: string): void => {
				if (rest.length !== n) throw new Error(`Usage: ${usage}`);
			};
			switch (sub) {
				case undefined:
				case 'help':
					ctx.print(HELP);
					return;
				case 'list':
				case 'ls':
					exact(0, 'project list');
					ctx.print(await serial(async () => list()));
					return;
				case 'new':
					exact(1, 'project new <project>');
					ctx.print(await serial(() => create(rest[0] as string)));
					return;
				case 'isolate':
					ctx.print(await serial(() => isolate(rest)));
					return;
				case 'stage': {
					const [action, ...more] = rest;
					if (action === 'make' && more.length === 1) ctx.print(await serial(() => stageMake(more[0] as string)));
					else if (action === 'apply' && more.length === 2) ctx.print(await serial(() => stageApply(more[0] as string, more[1] as string)));
					else throw new Error('Usage: project stage make <project> | project stage apply <project> <stageid>');
					return;
				}
				case 'finish':
					exact(0, 'project finish');
					ctx.print(await serial(finish));
					return;
				default:
					throw new Error(`Unknown subcommand: ${sub.slice(0, 64)}. Usage: ${USAGE}`);
			}
		},
	};
}
