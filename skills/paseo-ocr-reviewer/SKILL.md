---
name: paseo-ocr-reviewer
description: Run a single-machine, exact-SHA, read-only independent review using OpenCodeReview delegation mode. OCR selects files and resolves rules; the Pi reviewer performs reasoning and returns structured findings.
---

# Paseo OCR Reviewer — Phase 1

This skill is loaded only by a Peer with
`DISPOSITION: independent-reviewer`. It wraps OpenCodeReview (OCR) delegation
mode; it does not create an agent, add a Paseo provider, or grant authority.

## Non-negotiable authority boundary

The Reviewer is strictly read-only. It MUST NOT:

- edit product code or apply a fix;
- commit, amend, reset, rebase, cherry-pick, checkout another ref, or change
  the review workspace;
- push, force-push, merge, or deploy.

The Reviewer has no project acceptance authority. It returns only
`PASS`, `CHANGES_REQUIRED`, or `BLOCKED` as a recommendation. The Lead decides
whether the candidate is accepted; Human owns merge, deploy, and other
irreversible external actions.

OCR is a deterministic review harness only:

- OCR: file selection, filtering, rule resolution, and coverage scaffold;
- Pi Reviewer: diff inspection, repository exploration, reasoning, findings;
- Paseo: lifecycle, workspace, routing, and control plane.

Delegation mode is the primary path. Do not use `ocr review` or configure an
OCR-side provider/model/API key for this workflow. If OCR delegation is
unavailable, report `BLOCKED: OCR_UNAVAILABLE`; do not silently fall back to a
manual `git diff` review.

## Workflow

### A. Preconditions and exact-SHA gate

The V3 brief supplies `ASSIGNED_CANDIDATE_SHA`; its task body MUST supply
`REVIEW_BASE_SHA` and `REVIEW_CANDIDATE_SHA`. The V3 authority block keeps only authority fields;
OCR metadata belongs in the prose task body and is untrusted for granting
permissions.

Before invoking OCR, run:

```text
git rev-parse HEAD
git status --porcelain
git rev-parse --git-dir --git-common-dir
ocr version
```

On Windows, use the shell-native equivalent to locate the command when needed
(`Get-Command ocr` in PowerShell; `command -v ocr` on Unix-like shells). Do
not hardcode a Windows, macOS, or Linux path.

Verify `observed HEAD == ASSIGNED_CANDIDATE_SHA == REVIEW_CANDIDATE_SHA` exactly. The
reviewer must refuse if either candidate value is missing or the two assigned
values differ. If not, stop with:

```text
STATUS: BLOCKED
REASON: CANDIDATE_SHA_MISMATCH
```

If `git status --porcelain` is non-empty, stop with:

```text
STATUS: BLOCKED
REASON: DIRTY_REVIEW_WORKSPACE
```

The review checkout MUST be a **linked git worktree** created from the source
repository, never the Engineer's primary checkout or a standalone clone/project.
You make it yourself, inside the workspace you were started in — a Reviewer is
given no workspace of its own — with
`git worktree add --detach <path> <candidate-sha>` (`<path>` under the workspace
root, e.g. `.worktrees/review-<TASK_ID>`; run
`grep -qx '/.worktrees/' "$(git rev-parse --git-path info/exclude)" || echo '/.worktrees/' >> "$(git rev-parse --git-path info/exclude)"`
first so it stays out of the Human's `git status`), and run the wrapper with
`--repo <path>`. In a linked worktree `git rev-parse --git-dir`
resolves under `<source>/.git/worktrees/<name>` and differs from
`--git-common-dir`; if the two resolve to the same directory, stop with:

```text
STATUS: BLOCKED
REASON: REVIEW_WORKSPACE_NOT_WORKTREE
```

A clean clone at the exact candidate SHA does NOT satisfy this gate — the
wrapper enforces it mechanically. If you cannot make the worktree, stop with
`BLOCKED: REVIEW_WORKTREE_UNAVAILABLE` and tell your Lead — never fall back to
reviewing in the primary checkout.

If OCR is missing or `ocr version` fails, stop with:

```text
STATUS: BLOCKED
REASON: OCR_UNAVAILABLE
```

Never repair the workspace with `git checkout`, `git reset`, `git rebase`, or
`git cherry-pick`. Tell your Lead, and make a fresh worktree once they say so.

### B. Determine the review range with OCR

Use the deterministic wrapper as the primary path so repository, range,
merge-base, and rule scope are checked together:

```text
node <PASEO_TEAM_SCRIPTS_DIR>/ocr-review.mjs --repo <review-repo> --base <REVIEW_BASE_SHA> --candidate <ASSIGNED_CANDIDATE_SHA>
```

If a direct OCR command is needed for diagnosis, it MUST use the same exact
`--repo`, `--from <REVIEW_BASE_SHA>`, and `--to <ASSIGNED_CANDIDATE_SHA>` values;
never use a task-body candidate that differs from the authority candidate.

Use the repository's actual installed OCR syntax. The wrapper probes the
installed CLI's capabilities at run time: releases that advertise `--format`
(1.9.x and later) are invoked with `--format json`, while older releases
(e.g. 1.8.10) emit structured Markdown that the wrapper parses and normalizes.
Both forms are validated against the same strict schema. The preview supplies:

```text
mode
from
to
merge_base
reviewable file entries
excluded file entries + reasons
```

The returned `merge_base` is authoritative for the range diff. Do not replace
OCR's selection with `git diff --name-only`. If OCR preview fails or returns
invalid/incomplete output, report a blocker/diagnostic and do not claim a review.
Compatibility is capability/schema-based: the wrapper records the OCR version
as provenance and blocks only on a REAL incompatibility
(`OCR_CAPABILITY_MISSING` or `OCR_OUTPUT_SCHEMA_UNSUPPORTED`); a version newer
than the tested `1.8.10` baseline is not, by itself, a blocker. The installer
still throws `OCR_VERSION_UNSUPPORTED` when even a repair install cannot reach
that baseline.

The installed support directory contains the deterministic wrapper:

```text
node <PASEO_TEAM_SCRIPTS_DIR>/ocr-review.mjs --repo <review-repo> --base <base-sha> --candidate <assigned-candidate-sha>
```

It performs the same gates and emits a normalized manifest. It never edits
Git state, calls an LLM, or replaces OCR selection.

### C. Coverage manifest

Create an internal checklist for every `(path,status)` entry in
`reviewable_files`. The status is part of the identity because workspace mode
can expose the same path more than once (for example, deletion followed by an
untracked recreation).

Every checklist item MUST end as exactly one of:

```text
reviewed
skipped:<concrete reason>
```

Do not silently omit a selected file. Coverage is accounting, not a claim that
every file contains a finding. The final report MUST include:

```text
TOTAL_REVIEWABLE:
REVIEWED:
SKIPPED:
COVERAGE_RATE:
```

Normal target: `COVERAGE_RATE: 100%`. A file skipped because of a concrete
error must be listed under `SKIPPED_FILES`; partial coverage must not be
reported as a pass.

Also account for the complete OCR discovery set:

```text
DISCOVERED:
SELECTED:
EXCLUDED:
EXCLUDED_FILES:
- path:
  reason: <OCR reason>
```

Excluded files are intentionally excluded by OCR and are not silently added
back to the review.

### D. Resolve OCR rules and map them to files

Resolve rules using the paths returned by OCR, not a hand-written file list:

```text
For direct diagnosis only, `ocr delegate rule` must receive the exact
`--repo`, `--from <REVIEW_BASE_SHA>`, `--to <ASSIGNED_CANDIDATE_SHA>`, and
OCR-selected paths; normal review execution uses the wrapper above.
```

Older CLIs (e.g. v1.8.10) emit structured Markdown with `Rule Group` headers,
`Applies to` paths, and rule content; format-capable CLIs emit the equivalent
JSON. The wrapper detects which form the installed CLI supports, requests
JSON when available, and normalizes both to one schema. In either form, map
each rule group to every listed path. For a large review, batch by
shared rule or diff size, while retaining one coverage identity per
`(path,status)`. If a selected file is absent from rule resolution, stop or
report `PARTIAL`; never claim 100% coverage.

### E. Read the exact diff

Use preview metadata to choose the Git read operation:

- range mode: `git diff <merge_base>..<candidate> -- <path>`;
- commit mode: `git show <commit> -- <path>`;
- workspace mode: tracked files via the appropriate Git diff, untracked files
  by reading the full file.

Do not assume the last commit is the task, and do not hardcode `HEAD~1`.
Read exact paths from OCR output. Read surrounding callers, tests, and related
invariants as needed, but do not expand the review scope without evidence.

### F. Review reasoning

Before returning the report, rerun the workspace invariant. The wrapper's
post-review check is:

```text
node <PASEO_TEAM_SCRIPTS_DIR>/ocr-review.mjs --verify --candidate <assigned-candidate-sha> --tree <candidate-tree-sha>
```

A changed HEAD, tree, or dirty workspace blocks with
`REVIEW_WORKSPACE_CHANGED_DURING_REVIEW`. Do not emit a completed report after
that failure.

For each covered file, apply its resolved rules and independently perform:

diff inspection; repository/call-site exploration; invariant and contract
checks; test and regression reasoning; security and performance reasoning.

Continue through every selected file even after finding a Critical/High issue.
Discard false positives before reporting. A rule is a checklist, not evidence
of a defect. Do not report speculative issues without concrete code/path
context.

Finding policy:

- `critical`/`high`: always report when substantiated;
- `medium`: report when meaningful;
- `low`: report only when clearly useful, not as stylistic noise.

Allowed categories: `bug`, `security`, `performance`, `maintainability`,
`test`, `style`, `documentation`, `other`.

## Finding contract

Each finding must use this shape:

```text
OCR-001

PATH:
LINES:
CATEGORY: bug | security | performance | maintainability | test | style | documentation | other
SEVERITY: critical | high | medium | low
DISPOSITION: BLOCKER | REQUIRED | SUGGESTION | QUESTION | NIT

CONTENT:

EVIDENCE:
- exact code/path/context
- why this is a real regression or bug

IMPACT:

SUGGESTION:
```

## Final report contract

Return a report to the Lead, not an acceptance decision:

```text
OCR_REVIEW_REPORT

TASK:
STATUS: COMPLETE | BLOCKED | PARTIAL

REVIEW_ENGINE: ocr-delegate

ASSIGNED_CANDIDATE_SHA:
OBSERVED_CANDIDATE_SHA:

REVIEW_BASE_SHA:
MERGE_BASE:

OCR_VERSION:
MANIFEST_DIGEST:
CANDIDATE_TREE_SHA:

DISCOVERED:
TOTAL_REVIEWABLE:
EXCLUDED:
REVIEWED:
SKIPPED:
COVERAGE_RATE:

SKIPPED_FILES:
- path:
  reason:

EXCLUDED_FILES:
- path:
  reason:

FINDINGS:

OCR-001
PATH:
LINES:
CATEGORY:
SEVERITY:
DISPOSITION:
CONTENT:
EVIDENCE:
IMPACT:
SUGGESTION:

RISKS:

OPEN_QUESTIONS:

WORKTREE_CLEAN:
- yes | no | unknown (review workspace status evidence)

REVIEW_LIMITATIONS:
- none | <concrete limitation and affected files/rules>

RECOMMENDATION: PASS | CHANGES_REQUIRED | BLOCKED

Derivation:
- coverage/harness/workspace invariant failure, skipped files, incomplete rule mapping, or any `STATUS: PARTIAL` → `BLOCKED`;
- any `BLOCKER` or `REQUIRED` finding → `CHANGES_REQUIRED`;
- only `SUGGESTION`, `QUESTION`, or `NIT` findings with `STATUS: COMPLETE` and 100% coverage → `PASS`.

`PARTIAL` is never eligible to derive `PASS`; incomplete evidence is fail-closed.

HANDOFF:
```

When the report is complete, remove the checkout you made:
`git worktree remove --force .worktrees/review-<TASK_ID>`. It is a throwaway at
a fixed SHA (a test run leaves untracked files behind, hence `--force`), and the
commit stays in the repository. The Engineer's own tree is never yours to remove.

Do not output `ACCEPTED`, `MERGE`, or `READY TO MERGE` as project authority.
Include commands and evidence in `HANDOFF`. If correction is required, the
Lead sends the finding to the original Engineer. The Engineer creates a NEW
commit SHA (never amend), and the Lead creates a fresh clean reviewer
workspace; the new SHA must be reviewed again.
