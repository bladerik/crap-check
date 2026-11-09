import { describe, expect, it } from 'vitest';
import { findFunctions } from '../src/functions.js';

const byName = (source: string, file = 'a.ts') =>
	Object.fromEntries(findFunctions(file, source).map((fn) => [fn.name, fn]));

describe('cyclomatic complexity', () => {
	it('counts 1 plus every branch: if, ternary, case, loops, catch, &&, ||, ??', () => {
		const fns = byName(`
function f(a, b) {
	if (a && b) return 1;
	for (const x of a) { while (x) {} }
	switch (b) { case 1: break; case 2: break; default: break; }
	try { g(); } catch { h(); }
	return a ? b ?? 0 : a || b;
}`);
		// if, &&, for-of, while, 2 cases, catch, ?:, ??, || = 10
		expect(fns.f.complexity).toBe(11);
	});

	it('leaves branches of nested functions to those functions', () => {
		const fns = byName(`
const outer = (items) => items.map((item) => (item ? 1 : 2));`);
		expect(fns.outer.complexity).toBe(1);
		expect(fns['outer/items.map(<callback>)'].complexity).toBe(2);
	});
});

describe('names and ranges', () => {
	it('names declarations, arrow functions, methods, object properties and defaults', () => {
		const names = findFunctions(
			'a.ts',
			`
export function plain() {}
const arrow = () => 1;
class Store { constructor() {} save() {} get size() { return 1; } }
const api = { load() {}, parse: function () {} };
export const save = mutation({ args: {}, handler: async () => {} });
export default function () {}
`
		).map((fn) => fn.name);
		expect(names).toEqual([
			'plain',
			'arrow',
			'Store.constructor',
			'Store.save',
			'Store.size',
			'api.load',
			'api.parse',
			'save.handler',
			'default'
		]);
	});

	it('gives line ranges and the ranges of directly nested functions', () => {
		const [outer, inner] = findFunctions('a.ts', 'function outer() {\n\tconst x = 1;\n\tfunction inner() {\n\t\treturn x;\n\t}\n\treturn inner;\n}\n');
		expect(outer).toMatchObject({ name: 'outer', startLine: 1, endLine: 7, nestedRanges: [[3, 5]] });
		expect(inner).toMatchObject({ name: 'outer/inner', startLine: 3, endLine: 5, nestedRanges: [] });
	});

	it('hashes the body so a moved or re-indented function is recognised', () => {
		const [a] = findFunctions('a.ts', 'function a(x) { return x + 1; }');
		const [b] = findFunctions('b.ts', '\n\nexport   function b(x) {\n  return x + 1;\n}');
		expect(a.bodyHash).toBe(b.bodyHash);
	});

	it('marks first and last lines that other code shares', () => {
		const [route, plain] = findFunctions('a.ts', "app.get('/x', (req) => {\n\treturn 1;\n});\nfunction plain() {\n\treturn 2;\n}\n");
		expect(route.sharedLines).toEqual([1, 3]);
		expect(plain.sharedLines).toEqual([]);
	});

	it('reads JavaScript and JSX too', () => {
		expect(findFunctions('c.jsx', 'export const C = () => <div>{ok ? 1 : 2}</div>;')[0]).toMatchObject({
			name: 'C',
			complexity: 2
		});
	});
});

describe('callbacks', () => {
	it('names a function passed to a call after the call and numbers repeats', () => {
		const names = findFunctions(
			'a.ts',
			`
app.get('/a', (req) => req.ok ? 1 : 2);
app.post('/b', function (req) { return 1; });
function Component() {
	useEffect(() => {}, []);
	useEffect(() => { if (x) y(); }, [x]);
}
`
		).map((fn) => fn.name);
		expect(names).toEqual([
			"app.get('/a', <callback>)",
			"app.post('/b', <callback>)",
			'Component',
			'Component/useEffect(<callback>, [])',
			'Component/useEffect(<callback>, [x])'
		]);
	});
});
