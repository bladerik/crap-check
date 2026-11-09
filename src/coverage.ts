/**
 * Line coverage from the report a test runner writes: LCOV (`lcov.info`, vitest and jest) or an
 * istanbul/v8 JSON report (`coverage-final.json`). Both become hit counts per line per file.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { FunctionInfo } from './functions.js';

/**
 * Hits per line of one file. `calls` holds the report's function records, when it has them:
 * start line -> function key -> times called. They tell a function that ran from a line that only
 * ran because the module loaded.
 */
export class FileLines extends Map<number, number> {
	calls = new Map<number, Map<string, number>>();
}

/** Absolute file path -> line number -> hits. */
export type LineCoverage = Map<string, Map<number, number>>;

function fileLines(coverage: LineCoverage, file: string): FileLines {
	const existing = coverage.get(file);
	if (existing instanceof FileLines) return existing;
	const lines = new FileLines(existing ?? []);
	coverage.set(file, lines);
	return lines;
}

function addHits(coverage: LineCoverage, file: string, line: number, hits: number) {
	const lines = fileLines(coverage, file);
	lines.set(line, Math.max(lines.get(line) ?? 0, hits));
}

function addCalls(coverage: LineCoverage, file: string, line: number, key: string, hits: number) {
	const calls = fileLines(coverage, file).calls;
	let onLine = calls.get(line);
	if (!onLine) calls.set(line, (onLine = new Map()));
	onLine.set(key, Math.max(onLine.get(key) ?? 0, hits));
}

/**
 * `SF:` starts a file, `DA:<line>,<hits>` gives a line, `FN:<line>[,<end>],<name>` and
 * `FNDA:<hits>,<name>` give a function's calls; paths are resolved against `root`.
 */
export function parseLcov(text: string, root: string): LineCoverage {
	const coverage: LineCoverage = new Map();
	let file: string | undefined;
	let starts = new Map<string, number>();
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (line.startsWith('SF:')) {
			file = path.resolve(root, line.slice(3));
			starts = new Map();
		} else if (line === 'end_of_record') file = undefined;
		else if (!file) continue;
		else if (line.startsWith('DA:')) {
			const [lineNo, hits] = line.slice(3).split(',').map(Number);
			if (Number.isFinite(lineNo) && Number.isFinite(hits)) addHits(coverage, file, lineNo, hits);
		} else readFunctionRecord(coverage, file, line, starts);
	}
	return coverage;
}

function readFunctionRecord(coverage: LineCoverage, file: string, line: string, starts: Map<string, number>) {
	const declared = /^FN:(\d+)(?:,\d+)?,(.+)$/.exec(line);
	if (declared) {
		starts.set(declared[2], Number(declared[1]));
		return;
	}
	const called = /^FNDA:(\d+),(.+)$/.exec(line);
	const start = called ? starts.get(called[2]) : undefined;
	if (called && start !== undefined) addCalls(coverage, file, start, called[2], Number(called[1]));
}

type Position = { start: { line: number } };
type IstanbulFile = {
	path?: string;
	statementMap?: Record<string, Position>;
	s?: Record<string, number>;
	fnMap?: Record<string, { name?: string; decl?: Position; loc?: Position }>;
	f?: Record<string, number>;
};

/** A statement counts on the line it starts; a function on the line it is declared. */
export function parseIstanbulJson(text: string, root: string): LineCoverage {
	const coverage: LineCoverage = new Map();
	const report = JSON.parse(text) as Record<string, IstanbulFile>;
	for (const [key, entry] of Object.entries(report)) {
		const file = path.resolve(root, entry.path ?? key);
		for (const [id, location] of Object.entries(entry.statementMap ?? {})) {
			addHits(coverage, file, location.start.line, entry.s?.[id] ?? 0);
		}
		for (const [id, fn] of Object.entries(entry.fnMap ?? {})) {
			const start = (fn.decl ?? fn.loc)?.start.line;
			if (start !== undefined) addCalls(coverage, file, start, fn.name ?? id, entry.f?.[id] ?? 0);
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
		if (!(lines instanceof FileLines)) continue;
		for (const [line, onLine] of lines.calls) {
			for (const [key, hits] of onLine) addCalls(target, file, line, key, hits);
		}
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
	const own = [...lines].filter(([line]) => line >= fn.startLine && line <= fn.endLine && !inNestedBody(line, fn.nestedRanges));
	// Shared first/last lines run with the surrounding code; drop them unless they are all there is
	// (a one-line function). Then they ran when the module loaded, so they count only when the
	// report's function records show every function starting there was called.
	const unshared = own.filter(([line]) => !fn.sharedLines?.includes(line));
	if (unshared.length === 0 && own.length > 0 && neverCalled(fn, lines)) return 0;
	const counted = unshared.length > 0 ? unshared : own;
	if (counted.length === 0) return 0;
	return counted.filter(([, hits]) => hits > 0).length / counted.length;
}

/** A function record within the function's lines that shows no calls. No records: unknown, false. */
function neverCalled(fn: FunctionInfo, lines: Map<number, number>): boolean {
	if (!(lines instanceof FileLines)) return false;
	for (let line = fn.startLine; line <= fn.endLine; line++) {
		for (const hits of lines.calls.get(line)?.values() ?? []) if (hits === 0) return true;
	}
	return false;
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
