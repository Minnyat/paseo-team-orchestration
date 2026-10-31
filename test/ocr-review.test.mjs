// ocr-review.test.mjs — deterministic OCR delegation preflight contract.
// Run: node test/ocr-review.test.mjs

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import {
  OCR_ERROR_CODES,
  OCR_BASELINE_VERSION,
  OCR_WRAPPER_VERSION,
  assertLinkedWorktree,
  normalizePreview,
  normalizeRules,
  parsePreviewText,
  parseRulesText,
  verifyReviewWorkspace,
} from "../scripts/ocr-review.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WRAPPER = join(ROOT, "scripts", "ocr-review.mjs");
const FAKE_OCR = join(ROOT, "test", "fixtures", "fake-ocr.mjs");
const OCR_FIXTURE_ROOT = join(ROOT, "test", "fixtures", "ocr", "v1.8.10");
const GIT = process.platform === "win32" ? "git.exe" : "git";
const NODE = process.execPath;
const toCrlf = (text) => text.replace(/\r?\n/g, "\n").replace(/\n/g, "\r\n");

function git(repo, ...args) {
  return execFileSync(GIT, args, { cwd: repo, encoding: "utf8" }).trim();
}

// The review workspace invariant: the wrapper only accepts a LINKED git
// worktree, so the default fixture is a source repo plus a detached worktree
// checked out at the candidate SHA. `source` is the primary checkout used by
// the negative isolation tests.
function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), "paseo-ocr-review-"));
  const source = join(root, "source");
  mkdirSync(source);
  git(source, "init", "-q");
  git(source, "config", "user.email", "test@example.invalid");
  git(source, "config", "user.name", "OCR Test");
  mkdirSync(join(source, "src"));
  writeFileSync(join(source, "src", "reviewed.js"), "export const value = 1;\n");
  git(source, "add", ".");
  git(source, "commit", "-qm", "initial");
  const base = git(source, "rev-parse", "HEAD");
  writeFileSync(join(source, "src", "reviewed.js"), "export const value = 2;\n");
  git(source, "commit", "-qam", "candidate");
  const candidate = git(source, "rev-parse", "HEAD");
  const repo = join(root, "review-worktree");
  git(source, "worktree", "add", "-q", "--detach", repo, candidate);
  return { repo, source, base, candidate };
}

function runWrapper(repo, base, candidate, extraEnv = {}, { cwd, repoArg = repo } = {}) {
  const env = {
    ...process.env,
    PASEO_TEAM_OCR_EXEC: `"${NODE}" "${FAKE_OCR}"`,
    OCR_FIXTURE_FILE: "src/reviewed.js",
    OCR_FIXTURE_MERGE_BASE: base,
    OCR_FIXTURE_FROM: base,
    OCR_FIXTURE_TO: candidate,
    ...extraEnv,
  };
  const result = spawnSync(
    NODE,
    [WRAPPER, "--repo", repoArg, "--base", base, "--candidate", candidate],
    { encoding: "utf8", env, timeout: 30_000, cwd },
  );
  let json;
  try {
    json = JSON.parse(result.stdout);
  } catch {
    json = null;
  }
  return { ...result, json };
}

// Real OCR resolves --repo against its own cwd, which the wrapper sets to the
// repo. This shim reproduces that and then defers to the fake OCR.
function makeCwdResolvingOcr() {
  const shim = join(mkdtempSync(join(tmpdir(), "paseo-ocr-shim-")), "shim.mjs");
  writeFileSync(shim, [
    'import { spawnSync } from "node:child_process";',
    'import { statSync } from "node:fs";',
    'import { resolve } from "node:path";',
    'const args = process.argv.slice(2);',
    'const at = args.indexOf("--repo");',
    'if (at >= 0) { try { statSync(resolve(process.cwd(), args[at + 1])); } catch (e) { console.error(`stat ${e.path}: no such file`); process.exit(1); } }',
    `const r = spawnSync(process.execPath, [${JSON.stringify(FAKE_OCR)}, ...args], { stdio: "inherit" });`,
    'process.exit(r.status ?? 1);',
    '',
  ].join("\n"));
  return `"${NODE}" "${shim}"`;
}

// Pure response validation cases.
assert.deepEqual(normalizePreview({
  schema_version: "1",
  mode: "range",
  from: "base",
  to: "candidate",
  merge_base: "merge",
  reviewable_files: [{ path: "src/a.js", status: "modified" }],
  excluded_files: [],
}), {
  mode: "range",
  from: "base",
  to: "candidate",
  merge_base: "merge",
  reviewable_files: [{ path: "src/a.js", status: "modified" }],
  excluded_files: [],
});
assert.throws(
  () => normalizePreview({ mode: "range", reviewable_files: [] }),
  (error) => error.code === "PREVIEW_INVALID" && error.message.includes("schema_version"),
);
assert.throws(
  () => parsePreviewText("# Files (1 reviewable / 1 total)\n- mode: range\n- from: base\n- to: candidate\n- merge_base: " + "a".repeat(40) + "\n  - malformed file entry"),
  (error) => error.code === "PREVIEW_INVALID" && error.message.includes("file entry"),
);
assert.throws(
  () => normalizeRules({ schema_version: "1", groups: [{ group_id: 1, files: ["src/a.js"] }] }),
  (error) => error.code === "RULES_INVALID" && error.message.includes("groups[0]"),
);
assert.deepEqual(normalizeRules({
  schema_version: "1",
  groups: [{ group_id: 1, source: "default", pattern: "*.js", files: ["src/a.js"], rule: "Check bugs." }],
}), [{ group_id: 1, source: "default", pattern: "*.js", files: ["src/a.js"], rule: "Check bugs." }]);

// Golden parser fixtures captured from the real v1.8.10 CLI, including CRLF.
const goldenPreview = readFileSync(join(OCR_FIXTURE_ROOT, "preview-range.txt"), "utf8");
const goldenRules = readFileSync(join(OCR_FIXTURE_ROOT, "rule-multiple-groups.txt"), "utf8");
const parsedGoldenPreview = normalizePreview(parsePreviewText(toCrlf(goldenPreview)));
assert.equal(parsedGoldenPreview.mode, "range");
assert.equal(parsedGoldenPreview.reviewable_files[0].path, "src/app.js");
assert.equal(parsedGoldenPreview.excluded_files[0].path, "docs/guide.md");
assert.equal(parsedGoldenPreview.excluded_files[0].exclude_reason, "unsupported_ext");
const parsedGoldenRules = normalizeRules(parseRulesText(toCrlf(goldenRules)));
assert.equal(parsedGoldenRules.length, 2);
assert.equal(parsedGoldenRules[0].files[0], "src/with space.js");
assert.equal(parsedGoldenRules[1].files[0], "scripts/tool.py");
const parsedSingleRules = normalizeRules(parseRulesText(readFileSync(join(OCR_FIXTURE_ROOT, "rule-single.txt"), "utf8")));
assert.equal(parsedSingleRules.length, 1);
assert.equal(parsedSingleRules[0].files[0], "src/app.js");
const parsedNoMatchRules = normalizeRules(parseRulesText(readFileSync(join(OCR_FIXTURE_ROOT, "rule-no-match.txt"), "utf8")));
assert.equal(parsedNoMatchRules.length, 1);
assert.equal(parsedNoMatchRules[0].files[0], "README.txt");
const parsedZeroPreview = normalizePreview(parsePreviewText(readFileSync(join(OCR_FIXTURE_ROOT, "preview-zero-files.txt"), "utf8")));
assert.equal(parsedZeroPreview.reviewable_files.length, 0);
assert.equal(parsedZeroPreview.excluded_files.length, 1);
const parsedRename = normalizePreview(parsePreviewText(readFileSync(join(OCR_FIXTURE_ROOT, "preview-renamed-file.txt"), "utf8")));
assert.equal(parsedRename.reviewable_files[0].status, "renamed");
const parsedDeleted = normalizePreview(parsePreviewText(readFileSync(join(OCR_FIXTURE_ROOT, "preview-deleted-file.txt"), "utf8")));
assert.equal(parsedDeleted.reviewable_files.length, 0);
assert.equal(parsedDeleted.excluded_files[0].status, "deleted");
const parsedUnicode = normalizePreview(parsePreviewText(readFileSync(join(OCR_FIXTURE_ROOT, "preview-unicode-file.txt"), "utf8")));
assert.equal(parsedUnicode.reviewable_files[0].path, "src/你好.js");
const parsedLong = normalizePreview(parsePreviewText(readFileSync(join(OCR_FIXTURE_ROOT, "preview-long-path.txt"), "utf8")));
assert.ok(parsedLong.reviewable_files[0].path.length > 100);
assert.throws(
  () => normalizePreview(parsePreviewText(readFileSync(join(OCR_FIXTURE_ROOT, "preview-leading-dash.txt"), "utf8"))),
  /repository-relative path/,
);
assert.throws(() => normalizePreview({
  schema_version: "1",
  mode: "range",
  merge_base: "a".repeat(40),
  reviewable_files: [{ path: "-unsafe.js", status: "modified" }],
  excluded_files: [],
}), /repository-relative path/);

for (const code of [
  "CANDIDATE_SHA_MISMATCH",
  "DIRTY_REVIEW_WORKSPACE",
  "OCR_UNAVAILABLE",
  "PREVIEW_INVALID",
  "RULES_INVALID",
  "REVIEW_WORKSPACE_NOT_WORKTREE",
]) {
  assert.ok(OCR_ERROR_CODES.includes(code), `exports ${code}`);
}
assert.equal(OCR_BASELINE_VERSION, "1.8.10");

// Ref inputs must be full immutable SHAs, not branch names or shell-like values.
{
  const { repo, base, candidate } = makeRepo();
  const result = runWrapper(repo, base, "HEAD");
  assert.equal(result.status, 2);
  assert.equal(result.json.code, "USAGE");
}

// A missing delegate capability fails before selection.
{
  const { repo, base, candidate } = makeRepo();
  const result = runWrapper(repo, base, candidate, { OCR_FIXTURE_MODE: "missing-capability" });
  assert.equal(result.status, 2);
  assert.equal(result.json.code, "OCR_CAPABILITY_MISSING");
}

// Version drift alone is NOT a blocker: compatibility is capability/schema
// based and the version is recorded as provenance only.
{
  const { repo, base, candidate } = makeRepo();
  const result = runWrapper(repo, base, candidate, { OCR_FIXTURE_MODE: "old-version" });
  assert.equal(result.status, 0, result.stdout);
  assert.equal(result.json.harness.ocr_version, "1.8.9");
  assert.equal(result.json.harness.ocr_output_format, "text");
}

// A format-capable OCR is invoked with --format json (the fixture rejects the
// invocation otherwise) and the manifest records the machine-readable format.
{
  const { repo, base, candidate } = makeRepo();
  const result = runWrapper(repo, base, candidate, { OCR_FIXTURE_MODE: "format-capable" });
  assert.equal(result.status, 0, result.stdout);
  assert.equal(result.json.harness.ocr_version, "1.9.2");
  assert.equal(result.json.harness.ocr_output_format, "json");
}

// A relative --repo is resolved once against the invoking cwd; OCR runs with
// cwd=repo and would otherwise resolve the same relative path a second time.
{
  const { repo, base, candidate } = makeRepo();
  const cwd = dirname(repo);
  const result = runWrapper(repo, base, candidate, { PASEO_TEAM_OCR_EXEC: makeCwdResolvingOcr() }, { cwd, repoArg: relative(cwd, repo) });
  assert.equal(result.status, 0, result.stdout);
  assert.equal(result.json.harness.ocr_version, "1.8.10");
}

// The reviewer isolation invariant: a primary checkout is rejected even when
// clean and at the exact candidate SHA.
{
  const { source, base, candidate } = makeRepo();
  const result = runWrapper(source, base, candidate);
  assert.equal(result.status, 2);
  assert.equal(result.json.code, "REVIEW_WORKSPACE_NOT_WORKTREE");
}

// A standalone CLONE at the exact candidate SHA is also rejected — HEAD and
// cleanliness alone must never satisfy the isolation gate.
{
  const { source, base, candidate } = makeRepo();
  const clone = join(mkdtempSync(join(tmpdir(), "paseo-ocr-clone-")), "clone");
  execFileSync(GIT, ["clone", "-q", source, clone], { encoding: "utf8" });
  git(clone, "checkout", "-q", candidate);
  const result = runWrapper(clone, base, candidate);
  assert.equal(result.status, 2);
  assert.equal(result.json.code, "REVIEW_WORKSPACE_NOT_WORKTREE");
  assert.throws(
    () => assertLinkedWorktree(clone),
    (error) => error.code === "REVIEW_WORKSPACE_NOT_WORKTREE",
  );
}

// Candidate SHA must match current HEAD before OCR is invoked.
{
  const { repo, base, candidate } = makeRepo();
  const result = runWrapper(repo, candidate, base);
  assert.equal(result.status, 2);
  assert.equal(result.json.code, "CANDIDATE_SHA_MISMATCH");
}

// Dirty review workspace is a hard blocker, not an implicit cleanup request.
{
  const { repo, base, candidate } = makeRepo();
  writeFileSync(join(repo, "unrelated.txt"), "do not discard\n");
  const result = runWrapper(repo, base, candidate);
  assert.equal(result.status, 2);
  assert.equal(result.json.code, "DIRTY_REVIEW_WORKSPACE");
}

// Missing OCR executable is explicit and never falls back to manual selection.
{
  const { repo, base, candidate } = makeRepo();
  const result = runWrapper(repo, base, candidate, {
    PASEO_TEAM_OCR_EXEC: join(repo, "does-not-exist-ocr"),
  });
  assert.equal(result.status, 2);
  assert.equal(result.json.code, "OCR_UNAVAILABLE");
}

// Valid preview + rule output becomes a normalized manifest.
{
  const { repo, base, candidate } = makeRepo();
  const result = runWrapper(repo, base, candidate);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.json.schema, "paseo.ocr-review-manifest/v1");
  // The emitted manifest must carry the exported constant, not a stray literal.
  assert.equal(result.json.harness.wrapper_version, OCR_WRAPPER_VERSION);
  assert.equal(result.json.base_sha, base);
  assert.equal(result.json.candidate_sha, candidate);
  assert.equal(result.json.reviewable_files.length, 1);
  assert.equal(result.json.rule_groups[0].files[0], "src/reviewed.js");
  assert.match(result.json.ocr_version, /open-code-review/);
  assert.equal(result.json.review.candidate_sha, candidate);
  assert.equal(result.json.review.candidate_tree_sha.length, 40);
  assert.equal(result.json.workspace.clean_entry, true);
  assert.equal(result.json.workspace.linked_worktree, true);
  assert.equal(result.json.scope.selected_count, 1);
  assert.equal(result.json.scope.excluded_count, 0);
  assert.equal(result.json.scope.discovered_count, 1);
  assert.match(result.json.scope.selected_digest, /^sha256:/);
  assert.match(result.json.rules.resolution_digest, /^sha256:/);
}

// Zero selected files is observable, not silently treated as a manual diff.
{
  const { repo, base, candidate } = makeRepo();
  const result = runWrapper(repo, base, candidate, { OCR_FIXTURE_ZERO: "1" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.json.reviewable_files.length, 0);
  assert.equal(result.json.empty_review, true);
}

// Exit verification catches a workspace mutation after the harness ran.
{
  const { repo, base, candidate } = makeRepo();
  const entry = verifyReviewWorkspace(repo, candidate);
  assert.equal(entry.clean, true);
  writeFileSync(join(repo, "changed-during-review.txt"), "external mutation\n");
  assert.throws(
    () => verifyReviewWorkspace(repo, candidate, entry.tree),
    (error) => error.code === "REVIEW_WORKSPACE_CHANGED_DURING_REVIEW",
  );
  const cleanRepo = makeRepo();
  const cleanTree = verifyReviewWorkspace(cleanRepo.repo, cleanRepo.candidate).tree;
  const verifyResult = spawnSync(
    NODE,
    [WRAPPER, "--verify", "--repo", cleanRepo.repo, "--candidate", cleanRepo.candidate, "--tree", cleanTree],
    { encoding: "utf8", env: process.env, timeout: 30_000 },
  );
  assert.equal(verifyResult.status, 0);
  assert.match(verifyResult.stdout, /paseo\.ocr-review-verification\/v1/);
  const uppercaseTree = spawnSync(
    NODE,
    [WRAPPER, "--verify", "--repo", cleanRepo.repo, "--candidate", cleanRepo.candidate, "--tree", cleanTree.toUpperCase()],
    { encoding: "utf8", env: process.env, timeout: 30_000 },
  );
  assert.equal(uppercaseTree.status, 0);
}

// Malformed preview/rule JSON is a blocker.
for (const mode of ["preview-malformed", "rules-malformed"]) {
  const { repo, base, candidate } = makeRepo();
  const result = runWrapper(repo, base, candidate, { OCR_FIXTURE_MODE: mode });
  assert.equal(result.status, 2, mode);
  assert.equal(result.json.code, mode === "preview-malformed" ? "PREVIEW_INVALID" : "RULES_INVALID");
}

// Range binding is exact and merge_base must be Git's actual merge base.
for (const [env, expectedCode] of [
  [{ OCR_FIXTURE_FROM: "0" }, "PREVIEW_INVALID"],
  [{ OCR_FIXTURE_TO: "0" }, "PREVIEW_INVALID"],
  [{ OCR_FIXTURE_MERGE_BASE: "0".repeat(40) }, "PREVIEW_INVALID"],
]) {
  const { repo, base, candidate } = makeRepo();
  const result = runWrapper(repo, base, candidate, env);
  assert.equal(result.status, 2);
  assert.equal(result.json.code, expectedCode);
}

// Rule output may not introduce unrelated repository files.
{
  const { repo, base, candidate } = makeRepo();
  const result = runWrapper(repo, base, candidate, { OCR_FIXTURE_EXTRA_RULE_FILE: "README.md" });
  assert.equal(result.status, 2);
  assert.equal(result.json.code, "RULES_INVALID");
}

console.log("ocr-review tests passed");
