/**
 * Runs each package's tests with coverage and merges the reports. Failing tests do not stop the
 * check (it gates CRAP, not tests); they become a warning and their partial coverage still counts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { packageFor } from './config.js';
import { mergeCoverage, readCoverage } from './coverage.js';
import { buildCommand, DEFAULT_TEST_GLOBS, relativeToPackage, runTests, testsImporting } from './runner.js';
import { sourceFileFilter } from './tiers.js';
function testsFor(options, pkg, own) {
    const repoFiles = options.trackedFiles().filter((file) => packageFor(options.config, file) === pkg);
    const packageRoot = path.resolve(options.root, pkg.root);
    const isSource = sourceFileFilter(options.config);
    return testsImporting({
        packageFiles: relativeToPackage(options.root, pkg.root, repoFiles),
        testGlobs: pkg.tests ?? DEFAULT_TEST_GLOBS,
        changed: relativeToPackage(options.root, pkg.root, own),
        read: (file) => {
            const absolute = path.resolve(packageRoot, file);
            return fs.existsSync(absolute) ? fs.readFileSync(absolute, 'utf8') : undefined;
        },
        isLinkingSource: (file) => isSource(path.relative(options.root, path.resolve(packageRoot, file))),
        depth: pkg.testsDepth
    });
}
/** Runs the package's tests, so that a fresh report can be read. */
function runPackage(options, pkg, report, warnings) {
    const command = pkg[options.mode];
    if (!options.run)
        return 'ran';
    if (!command) {
        warnings.push(`${pkg.root} has no "${options.mode}" command: its functions count as untested`);
        return 'no command';
    }
    fs.rmSync(report, { force: true }); // never read a report left by an earlier run
    const own = options.files.filter((file) => packageFor(options.config, file) === pkg);
    const tests = command.includes('{tests}') ? testsFor(options, pkg, own) : [];
    if (command.includes('{tests}') && tests.length === 0)
        return 'untested'; // no test reaches the change
    const result = runTests(buildCommand(command, relativeToPackage(options.root, pkg.root, own), tests), path.resolve(options.root, pkg.root));
    if (!result.ok) {
        const tail = result.output.trim().split('\n').slice(-8).join('\n');
        warnings.push(`tests failed in ${pkg.root}; coverage may be incomplete:\n${tail}`);
    }
    return 'ran';
}
export function collectCoverage(options) {
    const coverage = new Map();
    const warnings = [];
    const unmeasured = [];
    const reported = [];
    const packages = options.mode === 'testAll' ? options.config.packages : [...new Set(options.files.map((file) => packageFor(options.config, file)))];
    for (const pkg of packages) {
        if (!pkg)
            continue;
        const packageRoot = path.resolve(options.root, pkg.root);
        const report = path.resolve(packageRoot, pkg.coverage);
        const outcome = runPackage(options, pkg, report, warnings);
        if (outcome !== 'ran')
            continue;
        if (fs.existsSync(report)) {
            mergeCoverage(coverage, readCoverage(report, packageRoot));
            reported.push(pkg.root);
        }
        // A first run without a report only sends its files on to the full run.
        else if (options.mode !== 'testFirst') {
            unmeasured.push(pkg.root);
            warnings.push(`no coverage report at ${path.relative(options.root, report) || report}: the tests did not start or wrote no coverage ` +
                '(missing dependencies or coverage provider?). Functions there are not measured.');
        }
    }
    return { coverage, warnings, unmeasured, reported };
}
