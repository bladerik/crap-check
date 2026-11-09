import { describe, expect, it } from 'vitest';
import { judge, pairFunctions, similarity, touchedFunctions, type BaseFunction, type Measured } from '../src/compare.js';
import { findFunctions } from '../src/functions.js';
import { parseUnifiedDiff, unquoteGitPath } from '../src/git.js';

const fn = (overrides: Partial<Measured> = {}): Measured => ({
	name: 'f',
	file: 'a.ts',
	startLine: 10,
	endLine: 20,
	complexity: 8,
	nestedRanges: [],
	bodyHash: 'h1',
	bodyText: '{ return x; }',
	coverage: 0,
	crap: 72,
	...overrides
});

const asBase = (source: string): BaseFunction[] =>
	findFunctions('a.ts', source).map(({ name, bodyHash, bodyText, complexity }) => ({ name, bodyHash, bodyText, complexity }));

/** Which base function name each head function pairs with ('-' when none). */
function pairedNames(headSource: string, baseSource: string): string[] {
	const head = findFunctions('a.ts', headSource);
	const base = asBase(baseSource);
	const pairs = pairFunctions(head, base);
	return head.map((f, index) => `${f.name} -> ${pairs.has(index) ? base[pairs.get(index)!].name : '-'}`);
}

describe('touched functions', () => {
	it('picks functions containing an added line, including the outer ones', () => {
		const outer = fn({ name: 'outer', startLine: 1, endLine: 30 });
		const inner = fn({ name: 'inner', startLine: 10, endLine: 12 });
		const other = fn({ name: 'other', startLine: 40, endLine: 50 });
		expect(touchedFunctions([outer, inner, other], new Set([11])).map((f) => f.name)).toEqual(['outer', 'inner']);
	});
});

describe('pairing with base', () => {
	const effects = `function C() {
	useEffect(() => { log(); });
	useEffect(() => { if (a) b(); if (c) d(); if (e) f(); });
}`;

	it('pairs by name when nothing was inserted', () => {
		expect(pairedNames('function f() { return 2; }', 'function f() { return 1; }')).toEqual(['f -> f']);
	});

	it('does not let a callback inserted above shift the pairing of the old ones', () => {
		const head = `function C() {
	useEffect(() => { track(); });
	useEffect(() => { log(); });
	useEffect(() => { if (a) b(); if (c) d(); if (e) g(); });
}`;
		expect(pairedNames(head, effects)).toEqual([
			'C -> C',
			'C/useEffect(<callback>) -> -',
			'C/useEffect(<callback>)#2 -> C/useEffect(<callback>)',
			'C/useEffect(<callback>)#3 -> C/useEffect(<callback>)#2'
		]);
	});

	it('keeps a callback paired when its deps or route change along with its body', () => {
		const base = "useEffect(() => { if (x.id) load(x.id); if (x.ok) show(); }, [x.id]);\napp.get('/orders', (req) => { if (req.a) return 1; return 2; });";
		const head = "useEffect(() => { if (x.id) load(x.id, x.user); if (x.ok) show(); }, [x.id, x.user]);\napp.get('/api/orders', (req) => { if (req.a) return 1; return 3; });";
		expect(pairedNames(head, base)).toEqual([
			'useEffect(<callback>, [x.id, x.user]) -> useEffect(<callback>, [x.id])',
			"app.get('/api/orders', <callback>) -> app.get('/orders', <callback>)"
		]);
	});

	it('pairs the best matches first, so a similar new callback above cannot take the old one', () => {
		const base = 'function C() {\n\tuseEffect(() => { if (a) load(a); if (b) save(b); if (c) send(c); });\n}';
		const head =
			'function C() {\n\tuseEffect(() => { if (a) load(a); if (d) other(d); });\n\tuseEffect(() => { if (a) load(a); if (b) save(b); if (c) send(c, 1); });\n}';
		expect(pairedNames(head, base)).toEqual([
			'C -> C',
			'C/useEffect(<callback>) -> -',
			'C/useEffect(<callback>)#2 -> C/useEffect(<callback>)'
		]);
	});

	it('keeps an edited route paired with itself when a new route reuses its old body', () => {
		const old = '(req) => { if (req.a) return 1; if (req.b) return 2; return 3; }';
		const base = `app.get('/legacy', ${old});`;
		const head = `app.get('/legacy', (req) => 1);\napp.get('/reports', ${old});`;
		expect(pairedNames(head, base)).toEqual([
			"app.get('/legacy', <callback>) -> app.get('/legacy', <callback>)",
			"app.get('/reports', <callback>) -> -"
		]);
	});

	it('tells calls apart by their other arguments', () => {
		const names = findFunctions('a.ts', "app.get('/a', (r) => 1);\napp.get('/b', (r) => 2);").map((f) => f.name);
		expect(names).toEqual(["app.get('/a', <callback>)", "app.get('/b', <callback>)"]);
	});

	it('scores body similarity by shared identifiers', () => {
		expect(similarity('{ if (a) b(); }', '{ if (a) c(); }')).toBeCloseTo(2 / 4);
		expect(similarity('{ x }', '{ y }')).toBe(0);
	});
});

describe('verdicts', () => {
	it('passes a new function at or under the threshold and fails one above it', () => {
		expect(judge(fn({ crap: 30 }), { kind: 'new' }, 30).status).toBe('ok');
		expect(judge(fn({ crap: 30.1 }), { kind: 'new' }, 30)).toMatchObject({ status: 'fail', kind: 'new' });
	});

	it('passes a changed function under the threshold whatever it was before', () => {
		expect(judge(fn({ crap: 12 }), { kind: 'changed', base: { name: 'f', bodyHash: 'x', complexity: 2 } }, 30).status).toBe('ok');
	});

	it('lets through an old function over the threshold that did not get more complex, saying why', () => {
		const over = judge(fn(), { kind: 'changed', base: { name: 'f', bodyHash: 'x', complexity: 8, crap: 72 } }, 30);
		expect(over).toMatchObject({ status: 'warn', reason: 'over 30 before too, not more complex' });
		const lostTests = judge(fn(), { kind: 'changed', base: { name: 'f', bodyHash: 'x', complexity: 8, crap: 8 } }, 30);
		expect(lostTests.reason).toBe('was CRAP 8.0 in the baseline: it lost coverage, or the related tests miss it');
		const lower = judge(fn(), { kind: 'changed', base: { name: 'f', bodyHash: 'x', complexity: 8, crap: 40 } }, 30);
		expect(lower.reason).toMatch(/CRAP rose from 40.0/);
	});

	it('fails an old function over the threshold that got more complex', () => {
		const verdict = judge(fn({ complexity: 9, crap: 90 }), { kind: 'changed', base: { name: 'f', bodyHash: 'x', complexity: 8 } }, 30);
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
