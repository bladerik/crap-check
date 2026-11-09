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

describe('tests reaching a change', () => {
	const files: Record<string, string> = {
		'src/price.test.ts': "import { price } from '../src/price';",
		'src/other.test.ts': "import { priceList } from './priceList.js';",
		'convex/__tests__/x.test.ts': 'import { run } from "../recipes/tasks/price.js";',
		'convex/__tests__/y.test.ts': 'await t.mutation(internal.recipes.tasks.price.store, {});',
		'convex/__tests__/z.test.ts': 'const priceless = 1; // a longer word does not count',
		'convex/__tests__/checkout.test.ts': "import { start } from '../checkout';",
		'convex/checkout.ts': 'await ctx.runMutation(internal.price.charge, {});',
		'convex/_generated/api.d.ts': "import type * as price from '../price.js';",
		'convex/__tests__/everything.test.ts': "import { api } from '../_generated/api';",
		'src/price.ts': 'export const price = () => 1;'
	};
	const search = (changed: string[], depth?: number) =>
		testsImporting({
			packageFiles: Object.keys(files),
			testGlobs: DEFAULT_TEST_GLOBS,
			changed,
			read: (file) => files[file],
			isLinkingSource: (file) => !file.includes('_generated'),
			depth
		});

	it('finds tests that import the changed module or reach it through a generated API name', () => {
		expect(search(['src/price.ts'], 1)).toEqual([
			'src/price.test.ts',
			'convex/__tests__/x.test.ts',
			'convex/__tests__/y.test.ts'
		]);
	});

	it('by default also finds tests of a module that uses the changed one, but not via generated files', () => {
		expect(search(['src/price.ts'])).toEqual([
			'src/price.test.ts',
			'convex/__tests__/x.test.ts',
			'convex/__tests__/y.test.ts',
			'convex/__tests__/checkout.test.ts'
		]);
	});

	it('returns nothing when no test reaches the change', () => {
		expect(search(['src/cart.ts'])).toEqual([]);
	});
});
