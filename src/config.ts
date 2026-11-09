/** `crap.config.json` at the repository root, with defaults for everything but the packages. */
import fs from 'node:fs';
import path from 'node:path';

export type PackageConfig = {
	/** Package directory, relative to the repository root. */
	root: string;
	/**
	 * Runs the tests for the changed files with coverage. `{files}` becomes the changed files and
	 * `{tests}` the test files that import them, both relative to `root`. Use `{tests}` when the
	 * runner's own "related tests" pulls in too much (a module that imports everything).
	 */
	test?: string;
	/** Globs of test files, relative to `root`, searched for `{tests}`. */
	tests?: string[];
	/** `{tests}`: 1 = tests that mention the changed module, 2 (default) = also through one module between. */
	testsDepth?: number;
	/** Runs the whole test suite with coverage, for `crap-check baseline` and `--all`. */
	testAll?: string;
	/** Coverage report the test command writes (LCOV or istanbul JSON), relative to `root`. */
	coverage: string;
};

export type ReviewTier = {
	name: string;
	/** Globs, relative to the repository root. */
	paths: string[];
	reviewers: number;
	effort?: string;
	note?: string;
};

export type Config = {
	threshold: number;
	/** Branch the change is compared with. */
	base: string;
	include: string[];
	/** Added to the default excludes (tests, builds, generated, config) unless `excludeDefaults` is false. */
	exclude: string[];
	excludeDefaults?: boolean;
	packages: PackageConfig[];
	/** Most demanding first: the first tier matching any changed file is suggested. */
	reviewTiers: ReviewTier[];
};

export const CONFIG_FILE = 'crap.config.json';

export const DEFAULTS: Omit<Config, 'packages'> = {
	threshold: 30,
	base: 'origin/main',
	include: ['**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'],
	exclude: [
		'**/node_modules/**',
		'**/dist/**',
		'**/build/**',
		'**/coverage/**',
		'**/*.d.ts',
		'**/*.{test,spec}.*',
		'**/__tests__/**',
		'**/tests/**',
		'**/test/**',
		'**/_generated/**',
		'**/*.config.*'
	],
	reviewTiers: []
};

/**
 * Reads the config. `readText` overrides where it comes from: with `--ref` it is the judged commit,
 * so an uncommitted config edit cannot change the verdict.
 */
export function loadConfig(repoRoot: string, file = CONFIG_FILE, readText?: (file: string) => string | undefined): Config {
	const configPath = path.resolve(repoRoot, file);
	// At a ref the file is looked up by its repo-relative path, also when given as an absolute one.
	const text = readText ? readText(path.relative(repoRoot, configPath)) : fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : undefined;
	const raw = text === undefined ? {} : (JSON.parse(text) as Partial<Config>);
	const config: Config = { ...DEFAULTS, packages: [{ root: '.', coverage: 'coverage/lcov.info' }], ...raw };
	if (raw.exclude && raw.excludeDefaults !== false) config.exclude = [...DEFAULTS.exclude, ...raw.exclude];
	if (!Array.isArray(config.packages) || config.packages.length === 0) {
		throw new Error(`${file}: "packages" must list at least one package`);
	}
	return config;
}

/** The package a repo-relative file belongs to: the one with the longest matching root. */
export function packageFor(config: Config, file: string): PackageConfig | undefined {
	const normalized = (root: string) => (root === '.' || root === '' ? '' : `${root.replace(/\/+$/, '')}/`);
	return [...config.packages]
		.sort((a, b) => normalized(b.root).length - normalized(a.root).length)
		.find((pkg) => file.startsWith(normalized(pkg.root)));
}
