/** The result as a Markdown table (for the terminal and a pull request) or JSON. */
import type { CheckResult } from './analyze.js';
import type { Measured, Verdict } from './compare.js';

const percent = (coverage: number) => `${Math.round(coverage * 100)}%`;

function crapCell(verdict: Verdict): string {
	const base = verdict.base?.crap;
	return base === undefined ? verdict.crap.toFixed(1) : `${base.toFixed(1)} → ${verdict.crap.toFixed(1)}`;
}

function resultCell(verdict: Verdict): string {
	const icon = { ok: '✓', warn: '⚠', fail: '✗' }[verdict.status];
	return verdict.reason ? `${icon} ${verdict.kind}: ${verdict.reason}` : `${icon} ${verdict.kind}`;
}

const escapeCell = (text: string) => text.replace(/\|/g, '\\|');

function row(verdict: Verdict): string {
	const where = `\`${escapeCell(`${verdict.file}:${verdict.startLine}`)}\` ${escapeCell(verdict.name)}`;
	return `| ${crapCell(verdict)} | ${verdict.complexity} | ${percent(verdict.coverage)} | ${where} | ${resultCell(verdict)} |`;
}

function tierLine(result: CheckResult): string {
	if (!result.tier) return 'Suggested review: none (no configured area touched)';
	const effort = result.tier.effort ? `, ${result.tier.effort}` : '';
	const note = result.tier.note ? `. ${result.tier.note}` : '';
	return `Suggested review: **${result.tier.name}**, ${result.tier.reviewers} reviewer(s)${effort}${note}`;
}

export function markdownReport(result: CheckResult, threshold: number): string {
	const lines: string[] = [];
	if (result.verdicts.length === 0) {
		lines.push('No changed JavaScript or TypeScript functions.');
	} else {
		lines.push('| CRAP | CC | Cov | Function | Result |', '| ---: | ---: | ---: | --- | --- |');
		lines.push(...result.verdicts.map(row));
		const failed = result.verdicts.filter((verdict) => verdict.status === 'fail').length;
		const warned = result.verdicts.filter((verdict) => verdict.status === 'warn').length;
		lines.push('', `${result.verdicts.length} function(s) checked against CRAP ${threshold}: ${failed} failed, ${warned} warned.`);
	}
	lines.push('', tierLine(result));
	for (const warning of result.warnings) lines.push('', `Warning: ${warning}`);
	return lines.join('\n');
}

export function jsonReport(result: CheckResult): string {
	return JSON.stringify(result, null, 2);
}

/** `--all`: the worst functions of the project, like a classic CRAP report. */
export function topReport(functions: Measured[], limit: number): string {
	const worst = [...functions].sort((a, b) => b.crap - a.crap).slice(0, limit);
	const lines = ['| CRAP | CC | Cov | Function |', '| ---: | ---: | ---: | --- |'];
	for (const fn of worst) {
		lines.push(`| ${fn.crap.toFixed(1)} | ${fn.complexity} | ${percent(fn.coverage)} | \`${escapeCell(`${fn.file}:${fn.startLine}`)}\` ${escapeCell(fn.name)} |`);
	}
	lines.push('', `${worst.length} of ${functions.length} functions, worst first.`);
	return lines.join('\n');
}
