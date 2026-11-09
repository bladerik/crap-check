/** Runs a package's test command with coverage. */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import picomatch from 'picomatch';

export const DEFAULT_TEST_GLOBS = ['**/*.{test,spec}.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'];

const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/** `{files}` and `{tests}` become the quoted paths; a command without them runs as written. */
export function buildCommand(template: string, files: string[], tests: string[] = []): string {
	return template.replace('{files}', files.map(shellQuote).join(' ')).replace('{tests}', tests.map(shellQuote).join(' '));
}

export type RunResult = { ok: boolean; output: string };

export function runTests(command: string, cwd: string): RunResult {
	const result = spawnSync(command, { cwd, shell: true, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
	return { ok: result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

/** Repo-relative files made relative to the package root, as test runners expect them. */
export function relativeToPackage(repoRoot: string, packageRoot: string, files: string[]): string[] {
	const absoluteRoot = path.resolve(repoRoot, packageRoot);
	return files.map((file) => path.relative(absoluteRoot, path.resolve(repoRoot, file)));
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Matches the module's file name as a whole word: an import (`'../module.js'`) as well as a
 * reference through a generated API (`internal.tasks.module`). A common name only adds tests.
 */
function referencePattern(file: string): RegExp {
	const stem = escapeRegExp(path.basename(file).replace(/\.[cm]?[jt]sx?$/, ''));
	return new RegExp(`(?:^|[^A-Za-z0-9_$])${stem}(?:[^A-Za-z0-9_$]|$)`);
}

/**
 * Test files (package-relative) that mention one of the changed files by name. A cheap stand-in
 * for the import graph when the runner's own one reaches every test.
 */
export function testsImporting(
	packageFiles: string[],
	testGlobs: string[],
	changed: string[],
	read: (file: string) => string | undefined
): string[] {
	const isTest = picomatch(testGlobs, { dot: true });
	const patterns = changed.map(referencePattern);
	return packageFiles.filter((file) => {
		if (!isTest(file)) return false;
		const text = read(file);
		return text !== undefined && patterns.some((pattern) => pattern.test(text));
	});
}
