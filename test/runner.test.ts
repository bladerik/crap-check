import { describe, expect, it } from 'vitest';
import { buildCommand, DEFAULT_TEST_GLOBS, relativeToPackage, testsImporting } from '../src/runner.js';

describe('test commands', () => {
	it('puts quoted changed files and test files into the placeholders', () => {
		expect(buildCommand('vitest run {tests} --x {files}', ["src/it's.ts"], ['a.test.ts'])).toBe(
			`vitest run 'a.test.ts' --x 'src/it'\\''s.ts'`
		);
	});

	it('makes repo paths relative to the package', () => {
		expect(relativeToPackage('/repo', 'packages/api', ['packages/api/src/a.ts'])).toEqual(['src/a.ts']);
	});
});

describe('tests importing a change', () => {
	const files: Record<string, string> = {
		'src/price.test.ts': "import { price } from '../src/price';",
		'src/other.test.ts': "import { priceList } from './priceList.js';",
		'convex/__tests__/x.test.ts': 'import { run } from "../recipes/tasks/price.js";',
		'convex/__tests__/y.test.ts': 'await t.mutation(internal.recipes.tasks.price.store, {});',
		'convex/__tests__/z.test.ts': 'const priceless = 1; // a longer word does not count',
		'src/price.ts': "export const price = () => 1; // not a test file, ignored"
	};

	it('finds test files that import the changed module or reach it through a generated API', () => {
		expect(testsImporting(Object.keys(files), DEFAULT_TEST_GLOBS, ['src/price.ts'], (file) => files[file])).toEqual([
			'src/price.test.ts',
			'convex/__tests__/x.test.ts',
			'convex/__tests__/y.test.ts'
		]);
	});

	it('returns nothing when no test imports the change', () => {
		expect(testsImporting(Object.keys(files), DEFAULT_TEST_GLOBS, ['src/cart.ts'], (file) => files[file])).toEqual([]);
	});
});
