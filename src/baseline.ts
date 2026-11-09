/**
 * A baseline is the CRAP of every function at one commit of the base branch. It is computed once
 * per commit (`crap-check baseline`, on main or in CI) and kept in the repository's git directory,
 * shared by all worktrees, so checking a change does not rerun the base's tests.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { BaseFunction } from './compare.js';

export type Baseline = {
	sha: string;
	createdAt: string;
	/** Repo-relative file -> its functions. */
	files: Record<string, BaseFunction[]>;
};

export const baselinePath = (gitCommonDir: string, sha: string) =>
	path.join(gitCommonDir, 'crap-check', `baseline-${sha}.json`);

export function writeBaseline(file: string, baseline: Baseline): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(baseline)}\n`);
}

export function readBaseline(file: string): Baseline | undefined {
	if (!fs.existsSync(file)) return undefined;
	const baseline = JSON.parse(fs.readFileSync(file, 'utf8')) as Baseline;
	return baseline && typeof baseline.files === 'object' ? baseline : undefined;
}
