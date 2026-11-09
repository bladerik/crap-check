/**
 * Runs each package's tests with coverage and merges the reports. Failing tests do not stop the
 * check (it gates CRAP, not tests); they become a warning and their partial coverage still counts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { packageFor } from './config.js';
import { mergeCoverage, readCoverage } from './coverage.js';
import { buildCommand, DEFAULT_TEST_GLOBS, relativeToPackage, runTests, testsImporting } from './runner.js';
function testsFor(options, pkg, own) {
    const packageFiles = relativeToPackage(options.root, pkg.root, options.trackedFiles().filter((file) => packageFor(options.config, file) === pkg));
    const packageRoot = path.resolve(options.root, pkg.root);
    const read = (file) => {
        const absolute = path.resolve(packageRoot, file);
        return fs.existsSync(absolute) ? fs.readFileSync(absolute, 'utf8') : undefined;
    };
    return testsImporting(packageFiles, pkg.tests ?? DEFAULT_TEST_GLOBS, own, read);
}
function runPackage(options, pkg, report, warnings) {
    const command = pkg[options.mode];
    if (!options.run || !command)
        return;
    const own = options.files.filter((file) => packageFor(options.config, file) === pkg);
    const tests = command.includes('{tests}') ? testsFor(options, pkg, own) : [];
    if (command.includes('{tests}') && tests.length === 0)
        return; // nothing imports the change: untested
    fs.rmSync(report, { force: true }); // never read a report left by an earlier run
    const result = runTests(buildCommand(command, relativeToPackage(options.root, pkg.root, own), tests), path.resolve(options.root, pkg.root));
    if (!result.ok) {
        const tail = result.output.trim().split('\n').slice(-8).join('\n');
        warnings.push(`tests failed in ${pkg.root}; coverage may be incomplete:\n${tail}`);
    }
}
export function collectCoverage(options) {
    const coverage = new Map();
    const warnings = [];
    const packages = options.mode === 'testAll' ? options.config.packages : [...new Set(options.files.map((file) => packageFor(options.config, file)))];
    for (const pkg of packages) {
        if (!pkg)
            continue;
        const packageRoot = path.resolve(options.root, pkg.root);
        const report = path.resolve(packageRoot, pkg.coverage);
        runPackage(options, pkg, report, warnings);
        if (fs.existsSync(report))
            mergeCoverage(coverage, readCoverage(report, packageRoot));
        else
            warnings.push(`no coverage report at ${path.relative(options.root, report)}; functions there count as untested`);
    }
    return { coverage, warnings };
}
