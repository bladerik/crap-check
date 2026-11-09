# crap-check

A CRAP score gate for the functions a change touches, in JavaScript and TypeScript projects.

```
| CRAP | CC | Cov | Function | Result |
| ---: | ---: | ---: | --- | --- |
| 42.0 | 6 | 0% | `src/billing/price.ts:1` price | ✗ new: new function over 30 |
| 48.0 | 7 | 10% | `src/worker.ts:1228` detectFaces | ⚠ changed: let through |
| 13.0 | 13 | 100% | `src/results.ts:140` summarizeRun | ✓ new |

3 function(s) checked against CRAP 30: 1 failed, 1 let through.

Let through, not blocked: 1 existing function(s) over CRAP 30 that did not get more complex. Tell the user; a test is the fix.
- `src/worker.ts:1228` detectFaces: over 30 before too, not more complex

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
- a **changed** function may stay above it only if it did not get more complex than on the base
  branch, so a one-line fix in old code does not force a rewrite. It is not blocked, but listed
  under "Let through" with the reason, so nobody misses it;
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
| `packages[].testsDepth` | `{tests}`: 1 = tests that mention a changed module; 2 (default) = also tests of modules that mention it. |
| `packages[].testAll` | Runs the whole suite with coverage, for `baseline` and `--all`. |
| `packages[].coverage` | The report the test command writes (`lcov.info` or `coverage-final.json`), relative to `root`. |
| `include`, `exclude` | Globs of source files. `exclude` adds to the defaults (tests, `node_modules`, builds, `.d.ts`, generated folders, `*.config.*`); set `excludeDefaults: false` to replace them. |
| `reviewTiers` | Most demanding first; the first tier with a path matching any changed file is suggested. |

Only files inside a configured package are scored: a file without a test command could only
count as untested.

Use `{tests}` instead of the runner's own "related tests" when one module imports everything (a
generated API, for example) and "related" would run the whole suite. It finds test files by the
changed module's file name, also one module away (`testsDepth`).

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
| `--ref <commit>` | Judge this commit instead of the working tree (what a pre-push hook needs). Tests run on the working tree, so uncommitted changes in the checked packages (untracked files included) stop the check with exit 2. |
| `--no-run` | Do not run tests; read the coverage reports already on disk. |
| `--json` | JSON instead of the Markdown table. |
| `--baseline <file>` | Use this baseline file instead of the cached one. |
| `--output <file>` | Where `baseline` writes (default: the cache). |
| `--limit <n>` | Rows for `--all` (default 20). |
| `--config <file>` | Another config file. |

Exit codes: `0` passed, `1` a function failed, `2` crap-check itself could not run.

Failing tests do not stop the check: it gates CRAP, not tests. They show up as a warning and their
partial coverage counts.

### Changed functions and the baseline

A changed function over the threshold fails only when its complexity rose. Complexity, not CRAP:
the check measures coverage with the tests related to the change, while a full run measures it with
the whole suite, so the two CRAP values are not comparable. When the baseline knows the function,
"Let through" says whether it was already over the limit, or was under it and lost coverage (or the
related tests miss it).

`crap-check baseline` stores the CRAP of every function at a commit (run it on a checkout of the
base branch). It lives in the repository's git directory, shared by all worktrees, keyed by
commit, and the report then shows `base → now` for changed functions. In CI, build it in the same
job from a worktree of the base branch and pass it with `--baseline` (see below).

### Git hook

The hook must judge what is pushed, not the working tree, so it passes each pushed commit as
`--ref`:

```sh
#!/bin/sh
# .githooks/pre-push
head=$(git rev-parse HEAD)
status=0
while read -r local_ref local_sha remote_ref remote_sha; do
	case "$local_sha" in *[!0]*) ;; *) continue ;; esac # branch deletion
	if [ "$local_sha" != "$head" ]; then
		echo "crap-check: $local_ref is not checked out; check it from its own checkout." >&2
		continue
	fi
	npx --no-install crap-check --ref "$local_sha" || status=$?
done
exit $status
```

```sh
chmod +x .githooks/pre-push && git config core.hooksPath .githooks
```

### GitHub Actions

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0
- name: Baseline on the base branch
  run: |
    git worktree add ../base "origin/${{ github.base_ref }}"
    cd ../base && npm ci && npx crap-check baseline --output "$RUNNER_TEMP/crap-baseline.json"
- run: npm ci
- name: Check the change
  shell: bash -o pipefail {0}
  run: npx crap-check --base "origin/${{ github.base_ref }}" --baseline "$RUNNER_TEMP/crap-baseline.json" | tee -a "$GITHUB_STEP_SUMMARY"
```

## How it measures

- **Functions:** declarations, expressions, arrows, methods, accessors and constructors, read with
  the TypeScript compiler from `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`. Names are qualified:
  `outer/inner`, `Class.method`, `object.property`, `mutation.handler`; a function passed to a call
  is named after the call and its other arguments (`app.get('/orders', <callback>)`,
  `useEffect(<callback>, [id])`), and repeated names get `#2`, `#3` in source order.
- **Complexity:** 1 plus each `if`, `?:`, `case`, loop, `catch`, `&&`, `||` and `??`. Branches of a
  nested function count for that function.
- **Coverage:** the instrumented lines inside the function that ran, without the body of nested
  functions (their first and last line also hold the outer code). A function missing from the
  report is untested.
- **Changed:** a function containing an added or modified line. It is paired with its base version
  in the same file by an identical body first, then by name when no function of that name was added
  or removed, then by the most similar body of that name (at least half of the identifiers shared).
  An unpaired function with the identical body of a removed one moved (renamed, or to another
  changed file); each removed function moves once, so a copy is new. Names and complexity on base
  always come from the base source; the baseline only adds the base CRAP shown in the table.
- **Git:** diffs ignore the user's diff settings (external diff, textconv, prefixes, path quoting),
  and file names with spaces, tabs or non-ASCII characters are read correctly.

## Credits

The metric is by Alberto Savoia and Bob Evans (crap4j, 2007). Robert C. Martin's
[crap4clj](https://github.com/unclebob/crap4clj), [crap4go](https://github.com/unclebob/crap4go)
and [crap4java](https://github.com/unclebob/crap4java) brought it back. The baseline comparison and
the recognition of moved functions follow ideas from
[crap4ts](https://github.com/danibram/crap4ts).

## License

MIT
