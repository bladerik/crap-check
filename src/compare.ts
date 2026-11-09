/**
 * The verdict for each function a change touches. New functions must stay at or under the
 * threshold. Changed functions may sit above it only when they did not get worse than on base,
 * so a one-line fix in old code does not force a rewrite.
 */
import type { FunctionInfo } from './functions.js';

export type Measured = FunctionInfo & { file: string; coverage: number; crap: number };

/** What base knew about a function: always its complexity, its CRAP when a baseline exists. */
export type BaseFunction = { name: string; bodyHash: string; complexity: number; crap?: number };

export type Kind = 'new' | 'changed' | 'moved';
export type Status = 'ok' | 'warn' | 'fail';

export type Verdict = Measured & {
	kind: Kind;
	status: Status;
	base?: BaseFunction;
	reason?: string;
};

const touches = (fn: FunctionInfo, lines: Set<number>) => {
	for (const line of lines) if (line >= fn.startLine && line <= fn.endLine) return true;
	return false;
};

/** Functions containing an added or modified line. Outer functions count too: their range changed. */
export function touchedFunctions<T extends FunctionInfo>(functions: T[], addedLines: Set<number>): T[] {
	return functions.filter((fn) => touches(fn, addedLines));
}

/** Same name first; else an identical body elsewhere in the old file(s) means it only moved. */
export function matchBase(fn: FunctionInfo, base: BaseFunction[]): { kind: Kind; base?: BaseFunction } {
	const byName = base.find((candidate) => candidate.name === fn.name);
	if (byName) return { kind: 'changed', base: byName };
	const byBody = base.find((candidate) => candidate.bodyHash === fn.bodyHash);
	if (byBody) return { kind: 'moved', base: byBody };
	return { kind: 'new' };
}

function judgeExisting(fn: Measured, base: BaseFunction, threshold: number): { status: Status; reason?: string } {
	if (fn.crap <= threshold) return { status: 'ok' };
	if (base.crap !== undefined) {
		return fn.crap > base.crap + 0.05
			? { status: 'fail', reason: `CRAP rose from ${base.crap.toFixed(1)} and is over ${threshold}` }
			: { status: 'warn', reason: `over ${threshold}, not worse than before` };
	}
	return fn.complexity > base.complexity
		? { status: 'fail', reason: `complexity rose from ${base.complexity} and CRAP is over ${threshold}` }
		: { status: 'warn', reason: `over ${threshold}, complexity not higher (no baseline coverage)` };
}

export function judge(fn: Measured, base: BaseFunction[], threshold: number): Verdict {
	const match = matchBase(fn, base);
	if (match.kind === 'new' || !match.base) {
		return fn.crap <= threshold
			? { ...fn, kind: 'new', status: 'ok' }
			: { ...fn, kind: 'new', status: 'fail', reason: `new function over ${threshold}` };
	}
	return { ...fn, kind: match.kind, base: match.base, ...judgeExisting(fn, match.base, threshold) };
}
