import { describe, expect, it } from 'vitest';
import { judge, matchBase, touchedFunctions, type BaseContext, type Measured } from '../src/compare.js';
import { parseUnifiedDiff, unquoteGitPath } from '../src/git.js';

const fn = (overrides: Partial<Measured> = {}): Measured => ({
	name: 'f',
	file: 'a.ts',
	startLine: 10,
	endLine: 20,
	complexity: 8,
	nestedRanges: [],
	bodyHash: 'h1',
	coverage: 0,
	crap: 72,
	...overrides
});

const context = (sameFile: BaseContext['sameFile'], pool: BaseContext['pool'] = [], atHead: string[] = []): BaseContext => ({
	sameFile,
	pool: [...sameFile.map((base) => ({ ...base, file: 'a.ts' })), ...pool],
	atHead: new Set(atHead)
});

describe('touched functions', () => {
	it('picks functions containing an added line, including the outer ones', () => {
		const outer = fn({ name: 'outer', startLine: 1, endLine: 30 });
		const inner = fn({ name: 'inner', startLine: 10, endLine: 12 });
		const other = fn({ name: 'other', startLine: 40, endLine: 50 });
		expect(touchedFunctions([outer, inner, other], new Set([11])).map((f) => f.name)).toEqual(['outer', 'inner']);
	});
});

describe('matching the base', () => {
	const legacy = { name: 'legacy', bodyHash: 'h1', complexity: 8 };

	it('matches by name in the same file', () => {
		expect(matchBase(fn({ name: 'legacy' }), context([legacy])).kind).toBe('changed');
	});

	it('treats an identical body whose original is gone as moved, also from another file', () => {
		expect(matchBase(fn({ name: 'renamed' }), context([legacy])).kind).toBe('moved');
		const fromOtherFile = context([], [{ ...legacy, file: 'old.ts' }]);
		expect(matchBase(fn({ name: 'legacy', file: 'new.ts' }), fromOtherFile).kind).toBe('moved');
	});

	it('treats a copy of a function that still exists as new', () => {
		expect(matchBase(fn({ name: 'legacyCopy' }), context([legacy], [], ['a.ts::legacy'])).kind).toBe('new');
	});

	it('treats a different body under a new name as new', () => {
		expect(matchBase(fn({ name: 'fresh', bodyHash: 'h9' }), context([legacy])).kind).toBe('new');
	});
});

describe('verdicts', () => {
	it('passes a new function at or under the threshold and fails one above it', () => {
		expect(judge(fn({ crap: 30 }), context([]), 30).status).toBe('ok');
		expect(judge(fn({ crap: 30.1 }), context([]), 30)).toMatchObject({ status: 'fail', kind: 'new' });
	});

	it('passes a changed function under the threshold whatever it was before', () => {
		expect(judge(fn({ crap: 12 }), context([{ name: 'f', bodyHash: 'x', complexity: 2, crap: 2 }]), 30).status).toBe('ok');
	});

	it('only warns about an old function over the threshold that did not get more complex', () => {
		const base = context([{ name: 'f', bodyHash: 'x', complexity: 8, crap: 20 }]);
		expect(judge(fn({ crap: 72 }), base, 30)).toMatchObject({ status: 'warn', kind: 'changed' });
	});

	it('fails an old function over the threshold that got more complex', () => {
		const verdict = judge(fn({ complexity: 9, crap: 90 }), context([{ name: 'f', bodyHash: 'x', complexity: 8 }]), 30);
		expect(verdict).toMatchObject({ status: 'fail', reason: 'complexity rose from 8 and CRAP is over 30' });
	});
});

describe('diff parsing', () => {
	it('collects added lines per new file, renames with their old path, and deletions', () => {
		const diff = [
			'diff --git a/src/a.ts b/src/a.ts',
			'--- a/src/a.ts',
			'+++ b/src/a.ts',
			'@@ -3,0 +4,2 @@',
			'+one',
			'+two',
			'@@ -10 +12 @@',
			'diff --git a/old.ts b/new.ts',
			'similarity index 90%',
			'rename from old.ts',
			'rename to new.ts',
			'--- a/old.ts',
			'+++ b/new.ts',
			'@@ -1,0 +2 @@',
			'diff --git a/gone.ts b/gone.ts',
			'deleted file mode 100644',
			'--- a/gone.ts',
			'+++ /dev/null',
			'@@ -1,3 +0,0 @@'
		].join('\n');
		expect(parseUnifiedDiff(diff)).toEqual([
			{ file: 'src/a.ts', addedLines: new Set([4, 5, 12]) },
			{ file: 'new.ts', previousFile: 'old.ts', addedLines: new Set([2]) },
			{ file: 'gone.ts', previousFile: 'gone.ts', deleted: true, addedLines: new Set() }
		]);
	});

	it('reads names git quotes or ends with a tab', () => {
		const diff = [
			'diff --git "a/src/\\303\\274n\\303\\257.ts" "b/src/\\303\\274n\\303\\257.ts"',
			'--- /dev/null',
			'+++ "b/src/\\303\\274n\\303\\257.ts"',
			'@@ -0,0 +1 @@',
			'diff --git a/src/with space.ts b/src/with space.ts',
			'--- /dev/null',
			'+++ b/src/with space.ts\t',
			'@@ -0,0 +1 @@'
		].join('\n');
		expect(parseUnifiedDiff(diff).map((change) => change.file)).toEqual(['src/ünï.ts', 'src/with space.ts']);
	});

	it('decodes C-quoted paths', () => {
		expect(unquoteGitPath('"a\\tb\\"c\\\\d"')).toBe('a\tb"c\\d');
		expect(unquoteGitPath('plain.ts')).toBe('plain.ts');
	});
});
