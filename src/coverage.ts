/**
 * Line coverage from the report a test runner writes: LCOV (`lcov.info`, vitest and jest) or an
 * istanbul/v8 JSON report (`coverage-final.json`). Both become hit counts per line per file.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { FunctionInfo } from './functions.js';

/** Absolute file path -> line number -> hits. */
export type LineCoverage = Map<string, Map<number, number>>;

function addHits(coverage: LineCoverage, file: string, line: number, hits: number) {
	let lines = coverage.get(file);
	if (!lines) coverage.set(file, (lines = new Map()));
	lines.set(line, Math.max(lines.get(line) ?? 0, hits));
}

/** `SF:` starts a file, `DA:<line>,<hits>` gives a line; paths are resolved against `root`. */
export function parseLcov(text: string, root: string): LineCoverage {
	const coverage: LineCoverage = new Map();
	let file: string | undefined;
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (line.startsWith('SF:')) file = path.resolve(root, line.slice(3));
		else if (line === 'end_of_record') file = undefined;
		else if (file && line.startsWith('DA:')) {
			const [lineNo, hits] = line.slice(3).split(',').map(Number);
			if (Number.isFinite(lineNo) && Number.isFinite(hits)) addHits(coverage, file, lineNo, hits);
		}
	}
	return coverage;
}

type IstanbulFile = {
	path?: string;
	statementMap?: Record<string, { start: { line: number } }>;
	s?: Record<string, number>;
};

/** A statement counts on the line it starts. */
export function parseIstanbulJson(text: string, root: string): LineCoverage {
	const coverage: LineCoverage = new Map();
	const report = JSON.parse(text) as Record<string, IstanbulFile>;
	for (const [key, entry] of Object.entries(report)) {
		const file = path.resolve(root, entry.path ?? key);
		for (const [id, location] of Object.entries(entry.statementMap ?? {})) {
			addHits(coverage, file, location.start.line, entry.s?.[id] ?? 0);
		}
	}
	return coverage;
}

export function readCoverage(file: string, root: string): LineCoverage {
	const text = fs.readFileSync(file, 'utf8');
	return file.endsWith('.json') ? parseIstanbulJson(text, root) : parseLcov(text, root);
}

export function mergeCoverage(target: LineCoverage, source: LineCoverage): LineCoverage {
	for (const [file, lines] of source) {
		for (const [line, hits] of lines) addHits(target, file, line, hits);
	}
	return target;
}

/** Inside a nested function: its first and last line also hold the outer code around it. */
const inNestedBody = (line: number, ranges: Array<[number, number]>) =>
	ranges.some(([start, end]) => line > start && line < end);

/**
 * Share of the function's own instrumented lines that ran: without the bodies of nested functions,
 * and without its first or last line when other code shares it. No such lines: untested, 0.
 */
export function functionCoverage(fn: FunctionInfo, lines: Map<number, number> | undefined): number {
	if (!lines) return 0;
	let total = 0;
	let covered = 0;
	for (const [line, hits] of lines) {
		if (line < fn.startLine || line > fn.endLine || inNestedBody(line, fn.nestedRanges)) continue;
		if (fn.sharedLines?.includes(line)) continue; // runs with the surrounding code, not the function
		total++;
		if (hits > 0) covered++;
	}
	return total === 0 ? 0 : covered / total;
}

/**
 * Whether a file's coverage looks mapped onto its source lines. Coverage of transpiled output (a
 * test runner without source maps) points at lines past the end or at blank lines.
 */
export function looksSourceMapped(sourceText: string, lines: Map<number, number> | undefined): boolean {
	if (!lines || lines.size === 0) return true;
	const sourceLines = sourceText.split(/\r?\n/);
	let suspicious = 0;
	for (const line of lines.keys()) {
		const text = sourceLines[line - 1];
		if (text === undefined || text.trim() === '' || /^\s*(\/\/|\*|\/\*)/.test(text)) suspicious++;
	}
	return suspicious / lines.size <= 0.1;
}
