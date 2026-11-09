const percent = (coverage) => `${Math.round(coverage * 100)}%`;
function crapCell(verdict) {
    const base = verdict.base?.crap;
    return base === undefined ? verdict.crap.toFixed(1) : `${base.toFixed(1)} → ${verdict.crap.toFixed(1)}`;
}
function resultCell(verdict) {
    if (verdict.status === 'warn')
        return `⚠ ${verdict.kind}: let through`;
    const icon = verdict.status === 'ok' ? '✓' : '✗';
    return verdict.reason ? `${icon} ${verdict.kind}: ${verdict.reason}` : `${icon} ${verdict.kind}`;
}
/** Old functions over the threshold that passed because they did not get more complex. */
function letThroughLines(verdicts, threshold) {
    const warned = verdicts.filter((verdict) => verdict.status === 'warn');
    if (warned.length === 0)
        return [];
    return [
        '',
        `Let through, not blocked: ${warned.length} existing function(s) over CRAP ${threshold} that did not get more complex. Tell the user; a test is the fix.`,
        ...warned.map((verdict) => `- \`${escapeCell(`${verdict.file}:${verdict.startLine}`)}\` ${escapeCell(verdict.name)}: ${verdict.reason}`)
    ];
}
const escapeCell = (text) => text.replace(/\|/g, '\\|');
function row(verdict) {
    const where = `\`${escapeCell(`${verdict.file}:${verdict.startLine}`)}\` ${escapeCell(verdict.name)}`;
    return `| ${crapCell(verdict)} | ${verdict.complexity} | ${percent(verdict.coverage)} | ${where} | ${resultCell(verdict)} |`;
}
function tierLine(result) {
    if (!result.tier)
        return 'Suggested review: none (no configured area touched)';
    const effort = result.tier.effort ? `, ${result.tier.effort}` : '';
    const note = result.tier.note ? `. ${result.tier.note}` : '';
    return `Suggested review: **${result.tier.name}**, ${result.tier.reviewers} reviewer(s)${effort}${note}`;
}
export function markdownReport(result, threshold) {
    const lines = [];
    if (result.verdicts.length === 0) {
        lines.push('No changed JavaScript or TypeScript functions.');
    }
    else {
        lines.push('| CRAP | CC | Cov | Function | Result |', '| ---: | ---: | ---: | --- | --- |');
        lines.push(...result.verdicts.map(row));
        const failed = result.verdicts.filter((verdict) => verdict.status === 'fail').length;
        const warned = result.verdicts.filter((verdict) => verdict.status === 'warn').length;
        lines.push('', `${result.verdicts.length} function(s) checked against CRAP ${threshold}: ${failed} failed, ${warned} let through.`);
        lines.push(...letThroughLines(result.verdicts, threshold));
    }
    lines.push('', tierLine(result));
    for (const warning of result.warnings)
        lines.push('', `Warning: ${warning}`);
    return lines.join('\n');
}
export function jsonReport(result) {
    return JSON.stringify(result, null, 2);
}
/** `--all`: the worst functions of the project, like a classic CRAP report. */
export function topReport(functions, limit) {
    const worst = [...functions].sort((a, b) => b.crap - a.crap).slice(0, limit);
    const lines = ['| CRAP | CC | Cov | Function |', '| ---: | ---: | ---: | --- |'];
    for (const fn of worst) {
        lines.push(`| ${fn.crap.toFixed(1)} | ${fn.complexity} | ${percent(fn.coverage)} | \`${escapeCell(`${fn.file}:${fn.startLine}`)}\` ${escapeCell(fn.name)} |`);
    }
    lines.push('', `${worst.length} of ${functions.length} functions, worst first.`);
    return lines.join('\n');
}
