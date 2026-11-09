# crap-check

A CRAP score gate for the functions a change touches, in JavaScript and TypeScript projects.

```
| CRAP | CC | Cov | Function | Result |
| ---: | ---: | ---: | --- | --- |
| 42.0 | 6 | 0% | `src/billing/price.ts:1` price | ✗ new: new function over 30 |
| 30.0 | 5 | 0% | `src/worker.ts:1228` detectFaces | ✓ changed |
| 13.0 | 13 | 100% | `src/results.ts:140` summarizeRun | ✓ new |

3 function(s) checked against CRAP 30: 1 failed, 0 warned.

Suggested review: **billing**, 2 reviewer(s), xhigh
```

## What CRAP is

CRAP (Change Risk Anti-Patterns), by Alberto Savoia and Bob Evans, scores one function:

```
CRAP = complexity² × (1 − coverage)³ + complexity
```

`complexity` is the cyclomatic complexity, `coverage` the share of the function's lines the tests
ran. Simple code scores low whatever its tests. Complex code scores low only when it is tested.
30 is the usual limit.

## Why a gate, not a report

Most CRAP tools report the whole project, worst first. On a codebase with history that list is
mostly old code, so it cannot stop anything. crap-check scores only the functions a change adds or
modifies:

- a **new** function must score at most the threshold (30);
- a **changed** function may stay above it only if it did not get worse than on the base branch,
  so a one-line fix in old code does not force a rewrite;
- a change without functions (text, markup, images) passes at once.

It also suggests how much review the change needs, from paths you configure (billing code: two
reviewers; copy changes: none).

## Install

```sh
npm install --save-dev @bladerik/crap-check
```

Requires Node 20+ and git. Your tests must write a coverage report (LCOV or istanbul JSON); vitest
needs `@vitest/coverage-v8`, jest has coverage built in.

## Configure

`crap.config.json` at the repository root:

```json
{
	"threshold": 30,
	"base": "origin/main",
	"packages": [
		{
			"root": ".",
			"test": "npx vitest related --run --coverage.enabled --coverage.reporter=lcov {files}",
			"testAll": "npx vitest run --coverage.enabled --coverage.reporter=lcov",
			"coverage": "coverage/lcov.info"
		}
	],
	"reviewTiers": [
		{ "name": "billing", "paths": ["src/billing/**"], "reviewers": 2, "effort": "xhigh" },
		{ "name": "code", "paths": ["src/**/*.ts"], "reviewers": 1, "effort": "high" }
	]
}
```

| Key | Meaning |
| --- | --- |
| `threshold` | CRAP limit for new functions. Default 30. |
| `base` | Branch the change is compared with. Default `origin/main`. |
| `packages[].root` | Package directory. Monorepos list one entry per package. |
| `packages[].test` | Runs the tests for the change, with coverage. `{files}` becomes the changed files, `{tests}` the test files that mention them, both relative to `root`. |
| `packages[].tests` | Globs of test files for `{tests}`. Default `**/*.{test,spec}.*`. |
| `packages[].testAll` | Runs the whole suite with coverage, for `baseline` and `--all`. |
| `packages[].coverage` | The report the test command writes (`lcov.info` or `coverage-final.json`), relative to `root`. |
| `include`, `exclude` | Globs of source files. Tests, `node_modules`, builds, `.d.ts` and generated folders are excluded by default. |
| `reviewTiers` | Most demanding first; the first tier with a path matching any changed file is suggested. |

Use `{tests}` instead of the runner's own "related tests" when one module imports everything (a
generated API, for example) and "related" would run the whole suite.

Test commands with jest and ts-jest need source maps (`tsconfig: { sourceMap: true }` in the
ts-jest options), or coverage points at the lines of the compiled output. crap-check warns when a
report's lines do not match the source.

## Use

```sh
npx crap-check            # check the change against the base branch; exit 1 on a failure
npx crap-check --all      # the worst functions of the whole project, like a classic CRAP report
npx crap-check baseline   # store the CRAP of every function at HEAD (run on the base branch)
```

| Option | |
| --- | --- |
| `--base <ref>` | Compare with another branch. |
| `--no-run` | Do not run tests; read the coverage reports already on disk. |
| `--json` | JSON instead of the Markdown table. |
| `--baseline <file>` | Use this baseline file instead of the cached one. |
| `--output <file>` | Where `baseline` writes (default: the cache). |
| `--limit <n>` | Rows for `--all` (default 20). |
| `--config <file>` | Another config file. |

Exit codes: `0` passed, `1` a function failed, `2` crap-check itself could not run.

Failing tests do not stop the check: it gates CRAP, not tests. They show up as a warning and their
partial coverage counts.

### Baseline

To know whether a changed function got worse, crap-check needs its CRAP on the base branch. Run
`crap-check baseline` on a checkout of the base branch (locally, or in CI on every push to main).
It is stored in the repository's git directory, shared by all worktrees, keyed by commit. Without
one, changed functions over the threshold are compared by complexity only, and the report says so.

### Git hook

```sh
# .githooks/pre-push
#!/bin/sh
exec npx --no-install crap-check
```

```sh
git config core.hooksPath .githooks
```

### GitHub Actions

```yaml
- run: npm ci
- run: npx crap-check --base origin/${{ github.base_ref }} >> "$GITHUB_STEP_SUMMARY"
```

Fetch the base branch first (`actions/checkout` with `fetch-depth: 0`).

## How it measures

- **Functions:** declarations, expressions, arrows, methods, accessors and constructors, read with
  the TypeScript compiler from `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`. Names are qualified:
  `outer/inner`, `Class.method`, `object.property`, `mutation.handler`.
- **Complexity:** 1 plus each `if`, `?:`, `case`, loop, `catch`, `&&`, `||` and `??`. Branches of a
  nested function count for that function.
- **Coverage:** the instrumented lines inside the function that ran, without the lines of nested
  functions. A function missing from the report is untested.
- **Changed:** a function containing an added or modified line. A function is matched with base
  by name, or by an identical body when it only moved or was renamed.

## Credits

The metric is by Alberto Savoia and Bob Evans (crap4j, 2007). Robert C. Martin's
[crap4clj](https://github.com/unclebob/crap4clj), [crap4go](https://github.com/unclebob/crap4go)
and [crap4java](https://github.com/unclebob/crap4java) brought it back. The baseline comparison and
the recognition of moved functions follow ideas from
[crap4ts](https://github.com/danibram/crap4ts).

## License

MIT
