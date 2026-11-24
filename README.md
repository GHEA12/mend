# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/GHEA12/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/GHEA12/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

One patch tool for every AI edit format. `mend` applies an edit that an AI model
wrote to a tree of text files. Models write edits in four formats, and `mend`
reads all four to one specification (`SPEC.md` in the bounty kit):

- unified diffs, often with wrong line numbers
- SEARCH/REPLACE blocks
- V4A patches
- text-editor tool calls as JSON

It finds the lines an edit names even when the model drifted their whitespace or
indentation, and changes every file or none: when any edit fails, no file is
written and every failure is reported.

## Usage

```
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- The working directory is the root of the tree. Every path in a patch is
  relative to it.
- `PATCH` is the path of the patch file. When it is absent or `-`, the patch is
  read from standard input.
- `--format=NAME` reads the patch in one format: `unified`, `search-replace`,
  `v4a` or `json`. `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code as
  without it, and no file is created, changed or deleted.
- `--strict` matches lines exactly.
- Options and `PATCH` may come in any order. `--` ends the options.

## Output and exit codes

Standard output holds lines, each ended by a line feed, and nothing else.

- Exit 0: the tree is written. One line per changed path (`A`, `D`, `M`, or
  `R <old> -> <new>` for a move), then `ok: <n> files`.
- Exit 1: one `error: <code> <path>` line per failed edit, in patch order,
  then `failed: <k> of <n> edits`. Codes: `no-match`, `ambiguous`, `missing`,
  `exists`, `unsafe`.
- Exit 2: one line, nothing else written: `error: usage`, `error: no-patch`,
  `error: format`, or `error: parse <N>`.

## Matching

An edit's old lines are found at the first of three tiers at which they occur:
exact, ignoring trailing spaces and tabs, then ignoring leading and trailing
spaces and tabs. At the loosest tier, replacement lines are re-indented to the
file's indentation. A unified hunk takes the occurrence nearest its (possibly
wrong) line number; a SEARCH/REPLACE block requires exactly one occurrence.

## Running the practice checks

The bounty kit ships 100 practice checks with the house reference's outputs
(`program/generator/practice.json`) and three practice trials
(`practice/trial-0` to `practice/trial-2`). From the kit's starter directory:

```
node check.ts <kit>/program/generator/practice.json
```

Score on the practice set: 1000 (100 of 100 passed), and 100 of 100 on each
of the three practice trials, run on Node 22.

## Requirements

Node 22 and its standard library only; nothing is installed. Deterministic:
the same check gives the same exit code, stdout and files every run.

## License

MIT. See `LICENSE`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=s6jwdspv&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
