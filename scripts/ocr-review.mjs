#!/usr/bin/env node
// ocr-review.mjs — single-machine, deterministic OCR delegation preflight.
// It selects files and resolves rules; it never reviews, edits, commits, pushes,
// checks out, resets, or invokes an LLM.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isEntrypoint,
  parseOcrVersion,
  resolveWindowsCliExec,
  splitCommandLine,
} from "./lib-common.mjs";

// Oldest OCR release whose delegation contract was verified end-to-end.
// Compatibility is decided at run time by capability/schema probes; the
// version string is provenance recorded in the manifest, never an equality
// gate. (OCR_VERSION_UNSUPPORTED remains a valid code for consumers — the
// installer throws it when even a repair install cannot reach this baseline.)
export const OCR_BASELINE_VERSION = "1.8.10";
// Schema version of the manifest THIS wrapper emits (harness.wrapper_version).
// Bump when the manifest shape changes in a way consumers must notice.
export const OCR_WRAPPER_VERSION = "1";
export const OCR_ERROR_CODES = Object.freeze([
  "USAGE",
  "OCR_VERSION_UNSUPPORTED",
  "OCR_CAPABILITY_MISSING",
  "OCR_OUTPUT_SCHEMA_UNSUPPORTED",
  "NOT_GIT_REPOSITORY",
  "REVIEW_WORKSPACE_NOT_WORKTREE",
  "CANDIDATE_SHA_MISMATCH",
  "DIRTY_REVIEW_WORKSPACE",
  "OCR_UNAVAILABLE",
  "GIT_REF_INVALID",
  "PREVIEW_FAILED",
  "PREVIEW_INVALID",
  "RULES_FAILED",
  "RULES_INVALID",
  "REVIEW_WORKSPACE_CHANGED_DURING_REVIEW",
]);

export class OcrReviewError extends Error {
  constructor(code, message, details = {}) {
    super(`${code}: ${message}`);
    this.name = "OcrReviewError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new OcrReviewError(code, message, details);
}

function splitOcrExecOverride(commandLine) {
  const { parts, unterminated } = splitCommandLine(commandLine);
  if (unterminated) {
    fail("OCR_UNAVAILABLE", "PASEO_TEAM_OCR_EXEC has an unterminated quote");
  }
  return parts;
}

export function resolveOcrExec() {
  const override = process.env.PASEO_TEAM_OCR_EXEC?.trim();
  if (override) {
    const parts = splitOcrExecOverride(override);
    if (parts.length === 0) fail("OCR_UNAVAILABLE", "PASEO_TEAM_OCR_EXEC is empty");
    return parts;
  }
  if (process.platform !== "win32") return ["ocr"];
  // Bare "ocr" as the fallback: let spawn surface the real ENOENT rather than
  // guessing at a layout the shim did not confirm.
  return resolveWindowsCliExec({ exe: "ocr.exe", shims: ["ocr.cmd", "ocr.bat"] }) ?? ["ocr"];
}

function runCommand(argv, options = {}) {
  const [bin, ...prefix] = options.executable ?? [process.platform === "win32" ? "git.exe" : "git"];
  try {
    return {
      ok: true,
      stdout: execFileSync(bin, [...prefix, ...argv], {
        cwd: options.cwd,
        encoding: "utf8",
        timeout: options.timeoutMs ?? 30_000,
        maxBuffer: 32 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
        windowsHide: true,
      }),
    };
  } catch (error) {
    return {
      ok: false,
      stdout: error?.stdout ? String(error.stdout) : "",
      stderr: error?.stderr ? String(error.stderr) : "",
      message: String(error?.message ?? error).split("\n")[0],
      code: error?.code,
    };
  }
}

function git(repo, args, code, message) {
  const result = runCommand(args, { cwd: repo });
  if (!result.ok) fail(code, message, { stderr: result.stderr.slice(0, 500) });
  return result.stdout.trim();
}

function parseStructuredOutput(result, commandCode, invalidCode, label, normalizeText) {
  if (!result.ok) {
    fail(commandCode, `${label} command failed`, { stderr: result.stderr.slice(0, 500), message: result.message });
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    try {
      return normalizeText(result.stdout);
    } catch (error) {
      if (error instanceof OcrReviewError) throw error;
      fail(invalidCode, `${label} returned malformed output`, { parseError: String(error?.message ?? error) });
    }
  }
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function canonicalJson(value) {
  return JSON.stringify(value);
}

function requireString(value, field, code) {
  if (typeof value !== "string" || value.trim() === "") {
    fail(code, `${field} must be a non-empty string`);
  }
  return value.trim();
}

function requireSha(value, field) {
  const sha = requireString(value, field, "USAGE");
  if (!/^[0-9a-f]{40}$/i.test(sha)) {
    fail("USAGE", `${field} must be a full 40-character Git SHA`);
  }
  return sha.toLowerCase();
}

function requireOcrPath(value, field) {
  const path = requireString(value, field, "PREVIEW_INVALID");
  if (
    path.includes("\0") ||
    path.startsWith("-") ||
    isAbsolute(path) ||
    /^[A-Za-z]:[\\/]/.test(path) ||
    path.split(/[\\/]+/).includes("..")
  ) {
    fail("PREVIEW_INVALID", `${field} must be a repository-relative path`);
  }
  return path;
}

export function parsePreviewText(text) {
  const lines = String(text).split(/\r?\n/);
  const mode = lines.find((line) => line.trim().startsWith("- mode:"))?.split(":").slice(1).join(":").trim();
  const from = lines.find((line) => line.trim().startsWith("- from:"))?.split(":").slice(1).join(":").trim();
  const to = lines.find((line) => line.trim().startsWith("- to:"))?.split(":").slice(1).join(":").trim();
  const mergeBase = lines.find((line) => line.trim().startsWith("- merge_base:"))?.split(":").slice(1).join(":").trim();
  if (!mode) fail("PREVIEW_INVALID", "preview text did not contain mode");
  const declared = lines.join("\n").match(/^# Files \((\d+) reviewable \/ (\d+) total\)$/m);
  const entries = [];
  for (const line of lines) {
    const match = line.match(/^\s*(?:~~)?- `([^`]+)` \[([^\]]+)\] \+(\d+)\/-([0-9]+)(?: \(excluded: ([^)]+)\))?(?:~~)?\s*$/);
    if (match) {
      entries.push({ path: match[1], status: match[2], insertions: Number(match[3]), deletions: Number(match[4]), ...(match[5] ? { exclude_reason: match[5] } : {}) });
      continue;
    }
    // File entries are indented bullets in the supported Markdown format.
    // An indented bullet that cannot be parsed is malformed output, not an
    // empty selection. Fail closed before downstream rule resolution.
    if (/^\s{2,}(?:~~)?-\s+/.test(line)) {
      fail("PREVIEW_INVALID", "preview contained a malformed file entry", { line: line.trim().slice(0, 300) });
    }
  }
  const reviewableFiles = entries.filter((entry) => !entry.exclude_reason);
  const excludedFiles = entries.filter((entry) => Boolean(entry.exclude_reason));
  if (declared && (Number(declared[1]) !== reviewableFiles.length || Number(declared[2]) !== entries.length)) {
    fail("PREVIEW_INVALID", "preview file counts do not match parsed entries", { declaredReviewable: Number(declared[1]), declaredTotal: Number(declared[2]), parsedReviewable: reviewableFiles.length, parsedTotal: entries.length });
  }
  return { schema_version: "1", mode, ...(from ? { from } : {}), ...(to ? { to } : {}), ...(mergeBase ? { merge_base: mergeBase } : {}), reviewable_files: reviewableFiles, excluded_files: excludedFiles };
}

export function normalizePreview(raw) {
  if (typeof raw === "string") raw = parsePreviewText(raw);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("PREVIEW_INVALID", "preview must be a JSON object or supported text output");
  if (raw.schema_version !== "1") fail("PREVIEW_INVALID", "preview schema_version must be \"1\"");
  const mode = requireString(raw.mode, "mode", "PREVIEW_INVALID");
  if (!["range", "commit", "workspace"].includes(mode)) fail("PREVIEW_INVALID", `unsupported preview mode "${mode}"`);
  const reviewable = raw.reviewable_files;
  const excluded = raw.excluded_files;
  if (!Array.isArray(reviewable)) fail("PREVIEW_INVALID", "reviewable_files must be an array");
  if (!Array.isArray(excluded)) fail("PREVIEW_INVALID", "excluded_files must be an array");
  const files = (entries, label, requireReason = false) => entries.map((entry, index) => {
    if (!entry || typeof entry !== "object") fail("PREVIEW_INVALID", `${label}[${index}] must be an object`);
    const path = requireOcrPath(entry.path, `${label}[${index}].path`);
    const status = requireString(entry.status, `${label}[${index}].status`, "PREVIEW_INVALID");
    if (requireReason && typeof entry.exclude_reason !== "string") fail("PREVIEW_INVALID", `${label}[${index}].exclude_reason must be present`);
    return {
      path,
      status,
      ...(Number.isInteger(entry.insertions) ? { insertions: entry.insertions } : {}),
      ...(Number.isInteger(entry.deletions) ? { deletions: entry.deletions } : {}),
      ...(typeof entry.exclude_reason === "string" && entry.exclude_reason ? { exclude_reason: entry.exclude_reason } : {}),
    };
  });
  const declaredReviewable = raw.reviewable_count ?? raw.reviewable_files_count;
  const declaredExcluded = raw.excluded_count ?? raw.excluded_files_count;
  const declaredTotal = raw.total_files;
  for (const [field, value] of [["reviewable_count", declaredReviewable], ["excluded_count", declaredExcluded], ["total_files", declaredTotal]]) {
    if (value !== undefined && (!Number.isInteger(value) || value < 0)) fail("PREVIEW_INVALID", `${field} must be a non-negative integer`);
  }
  if (declaredReviewable !== undefined && declaredReviewable !== reviewable.length) fail("PREVIEW_INVALID", "preview reviewable count does not match files", { declared: declaredReviewable, observed: reviewable.length });
  if (declaredExcluded !== undefined && declaredExcluded !== excluded.length) fail("PREVIEW_INVALID", "preview excluded count does not match files", { declared: declaredExcluded, observed: excluded.length });
  if (declaredTotal !== undefined && declaredTotal !== reviewable.length + excluded.length) fail("PREVIEW_INVALID", "preview total count does not match files", { declared: declaredTotal, observed: reviewable.length + excluded.length });
  if (reviewable.length === 0 && excluded.length === 0 && declaredReviewable === undefined && declaredExcluded === undefined && declaredTotal === undefined) {
    fail("PREVIEW_INVALID", "empty preview must include declared file counts");
  }
  return {
    mode,
    ...(typeof raw.from === "string" ? { from: raw.from } : {}),
    ...(typeof raw.to === "string" ? { to: raw.to } : {}),
    ...(typeof raw.commit === "string" ? { commit: raw.commit } : {}),
    merge_base: typeof raw.merge_base === "string" ? raw.merge_base : "",
    reviewable_files: files(reviewable, "reviewable_files"),
    excluded_files: files(excluded, "excluded_files", true),
  };
}

export function parseRulesText(text) {
  const lines = String(text).split(/\r?\n/);
  const groups = [];
  let current = null;
  let inApplies = false;
  let inContent = false;
  for (const line of lines) {
    const header = line.match(/^### Rule Group (\d+): (.*?)(?: \/ (.*))?\s*$/);
    if (header) {
      if (current) groups.push(current);
      current = { group_id: Number(header[1]), source: header[2].trim(), pattern: (header[3] ?? "*").trim(), files: [], ruleLines: [] };
      inApplies = false;
      inContent = false;
      continue;
    }
    if (!current) continue;
    if (line.trim() === "Applies to:") { inApplies = true; inContent = false; continue; }
    if (line.trim() === "#### Content") { inApplies = false; inContent = true; continue; }
    if (inApplies) {
      const file = line.match(/^\s*-\s+(.+)$/)?.[1]?.trim();
      if (file) current.files.push(file);
    } else if (inContent) {
      current.ruleLines.push(line);
    }
  }
  if (current) groups.push(current);
  return { schema_version: "1", groups: groups.map(({ ruleLines, ...group }) => ({ ...group, rule: ruleLines.join("\n").trim() })) };
}

export function normalizeRules(raw) {
  if (typeof raw === "string") raw = parseRulesText(raw);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("RULES_INVALID", "rules must be a JSON object or supported text output");
  if (raw.schema_version !== "1") fail("RULES_INVALID", "rules schema_version must be \"1\"");
  if (!Array.isArray(raw.groups)) fail("RULES_INVALID", "rules groups must be an array");
  if (raw.groups.length === 0) fail("OCR_OUTPUT_SCHEMA_UNSUPPORTED", "rules output contained no rule groups");
  return raw.groups.map((group, index) => {
    if (!group || typeof group !== "object") fail("RULES_INVALID", `groups[${index}] must be an object`);
    if (!Number.isInteger(group.group_id)) fail("RULES_INVALID", `groups[${index}].group_id must be an integer`);
    const files = group.files;
    if (!Array.isArray(files) || files.some((file) => typeof file !== "string" || file.trim() === "")) fail("RULES_INVALID", `groups[${index}].files must contain paths`);
    return {
      group_id: group.group_id,
      source: requireString(group.source, `groups[${index}].source`, "RULES_INVALID"),
      pattern: requireString(group.pattern, `groups[${index}].pattern`, "RULES_INVALID"),
      files: files.map((file) => requireOcrPath(file, `groups[${index}].files`)),
      rule: requireString(group.rule, `groups[${index}].rule`, "RULES_INVALID"),
    };
  });
}

function validateRuleCoverage(reviewableFiles, groups) {
  const selected = new Set(reviewableFiles.map((entry) => entry.path));
  const mapped = new Set(groups.flatMap((group) => group.files));
  const missing = [...selected].filter((path) => !mapped.has(path));
  const unrelated = [...mapped].filter((path) => !selected.has(path));
  if (missing.length > 0 || unrelated.length > 0) fail("RULES_INVALID", "rule output does not exactly match reviewable files", { missing, unrelated });
}

/**
 * The reviewer isolation invariant: the review workspace must be a LINKED git
 * worktree (created with `git worktree add` / Paseo `--isolation worktree`),
 * never the primary checkout or a standalone clone. In a linked worktree
 * `--git-dir` points under `<source>/.git/worktrees/<name>` and differs from
 * `--git-common-dir`; in a primary checkout or clone the two are identical.
 * A clean clone at the right SHA must NOT pass this gate.
 */
export function assertLinkedWorktree(repo) {
  const gitDir = git(repo, ["rev-parse", "--git-dir"], "NOT_GIT_REPOSITORY", "could not read the Git directory");
  const commonDir = git(repo, ["rev-parse", "--git-common-dir"], "NOT_GIT_REPOSITORY", "could not read the Git common directory");
  const resolvePath = (path) => {
    const absolute = isAbsolute(path) ? path : join(repo, path);
    try {
      return realpathSync(absolute);
    } catch {
      return absolute;
    }
  };
  const resolvedGitDir = resolvePath(gitDir);
  const resolvedCommonDir = resolvePath(commonDir);
  if (resolvedGitDir === resolvedCommonDir) {
    fail(
      "REVIEW_WORKSPACE_NOT_WORKTREE",
      "review workspace is a primary checkout or standalone clone, not a linked git worktree — create the reviewer workspace with worktree isolation from the source repository",
      { gitDir: resolvedGitDir },
    );
  }
  return { gitDir: resolvedGitDir, gitCommonDir: resolvedCommonDir };
}

function readGitState(repo, candidate) {
  const head = git(repo, ["rev-parse", "HEAD"], "NOT_GIT_REPOSITORY", "could not read Git HEAD");
  const status = git(repo, ["status", "--porcelain"], "NOT_GIT_REPOSITORY", "could not inspect Git status");
  const tree = git(repo, ["rev-parse", `${candidate}^{tree}`], "GIT_REF_INVALID", "could not read candidate tree");
  return { head, status, tree, clean: status === "" };
}

export function verifyReviewWorkspace(repo, candidate, expectedTree = undefined, phase = "exit") {
  const state = readGitState(repo, candidate);
  if (state.head !== candidate) fail("CANDIDATE_SHA_MISMATCH", `observed HEAD ${state.head} does not equal assigned candidate ${candidate}`, { observed: state.head, assigned: candidate });
  if (!state.clean) fail(phase === "entry" ? "DIRTY_REVIEW_WORKSPACE" : "REVIEW_WORKSPACE_CHANGED_DURING_REVIEW", phase === "entry" ? "review workspace is not clean" : "review workspace became dirty during review");
  if (expectedTree !== undefined && state.tree !== expectedTree) fail("REVIEW_WORKSPACE_CHANGED_DURING_REVIEW", "review candidate tree changed during review", { expectedTree, observedTree: state.tree });
  return { head: state.head, tree: state.tree, clean: state.clean };
}

function parseArgs(argv) {
  const options = { repo: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--verify") options.verify = true;
    else if (["--repo", "--base", "--candidate", "--tree"].includes(arg)) {
      const value = argv[++i];
      if (!value || value.startsWith("--")) fail("USAGE", `${arg} requires a value`);
      options[arg.slice(2)] = value;
    } else {
      fail("USAGE", `unknown argument "${arg}"`);
    }
  }
  if (!options.help) {
    if (!options.candidate) fail("USAGE", "--candidate <sha> is required");
    options.candidate = requireSha(options.candidate, "--candidate");
    if (options.verify) {
      options.tree = requireSha(options.tree, "--tree");
    } else {
      if (!options.base) fail("USAGE", "--base <sha> is required");
      options.base = requireSha(options.base, "--base");
    }
  }
  // OCR runs with cwd=repo, so a relative --repo must be made absolute once here.
  options.repo = resolve(options.repo);
  return options;
}

function main(options) {
  const repoCheck = runCommand(["rev-parse", "--is-inside-work-tree"], { cwd: options.repo });
  if (!repoCheck.ok || repoCheck.stdout.trim() !== "true") fail("NOT_GIT_REPOSITORY", `not inside a Git worktree: ${options.repo}`);

  const worktree = assertLinkedWorktree(options.repo);
  const entryState = verifyReviewWorkspace(options.repo, options.candidate, undefined, "entry");
  if (options.verify) {
    const verified = verifyReviewWorkspace(options.repo, options.candidate, options.tree);
    return { schema: "paseo.ocr-review-verification/v1", candidate_sha: verified.head, candidate_tree_sha: verified.tree, clean: verified.clean, linked_worktree: true };
  }
  git(options.repo, ["rev-parse", "--verify", `${options.base}^{commit}`], "GIT_REF_INVALID", `review base is not a valid commit: ${options.base}`);
  const actualMergeBase = git(options.repo, ["merge-base", options.base, options.candidate], "GIT_REF_INVALID", "could not calculate Git merge-base");

  const ocr = resolveOcrExec();
  const versionResult = runCommand(["version"], { cwd: options.repo, executable: ocr, timeoutMs: 30_000 });
  if (!versionResult.ok) fail("OCR_UNAVAILABLE", "OCR CLI is unavailable or failed `ocr version`", { message: versionResult.message });
  const ocrVersion = versionResult.stdout.trim().split(/\r?\n/)[0] ?? "";
  const ocrVersionNumber = parseOcrVersion(ocrVersion);
  if (!ocrVersionNumber) fail("OCR_OUTPUT_SCHEMA_UNSUPPORTED", "ocr version output did not contain a supported version string");
  // Compatibility is capability/schema-based: the version number is recorded
  // as provenance only. The probes below and the strict normalizers decide
  // whether this OCR is usable; a version that differs from the tested
  // baseline is not, by itself, a blocker.
  let formatJsonCapable = true;
  for (const command of ["preview", "rule"]) {
    const helpResult = runCommand(["delegate", command, "--help"], { cwd: options.repo, executable: ocr, timeoutMs: 30_000 });
    if (!helpResult.ok || !helpResult.stdout.includes("--repo") || !helpResult.stdout.includes("--from")) fail("OCR_CAPABILITY_MISSING", `OCR delegate ${command} capability is missing or unrecognized`);
    if (!helpResult.stdout.includes("--format")) formatJsonCapable = false;
  }
  // Prefer machine-readable output when this OCR advertises --format; older
  // releases (e.g. 1.8.10) reject the flag and emit the parseable Markdown.
  const formatArgs = formatJsonCapable ? ["--format", "json"] : [];

  const previewResult = runCommand(["delegate", "preview", "--repo", options.repo, "--from", options.base, "--to", options.candidate, ...formatArgs], { cwd: options.repo, executable: ocr, timeoutMs: 120_000 });
  const preview = normalizePreview(parseStructuredOutput(previewResult, "PREVIEW_FAILED", "PREVIEW_INVALID", "OCR preview", parsePreviewText));
  if (preview.mode !== "range") fail("PREVIEW_INVALID", `expected range preview, got ${preview.mode}`);
  if (preview.from !== options.base) fail("PREVIEW_INVALID", "preview.from does not equal requested base", { expected: options.base, observed: preview.from });
  if (preview.to !== options.candidate) fail("PREVIEW_INVALID", "preview.to does not equal requested candidate", { expected: options.candidate, observed: preview.to });
  if (!preview.merge_base || !/^[0-9a-f]{40}$/i.test(preview.merge_base)) fail("PREVIEW_INVALID", "range preview did not provide a full merge_base SHA");
  if (preview.merge_base !== actualMergeBase) fail("PREVIEW_INVALID", "preview.merge_base does not equal Git merge-base", { expected: actualMergeBase, observed: preview.merge_base });

  let ruleGroups = [];
  if (preview.reviewable_files.length > 0) {
    const ruleArgs = ["delegate", "rule", "--repo", options.repo, "--from", options.base, "--to", options.candidate, ...formatArgs, ...preview.reviewable_files.map((entry) => entry.path)];
    const rulesResult = runCommand(ruleArgs, { cwd: options.repo, executable: ocr, timeoutMs: 120_000 });
    ruleGroups = normalizeRules(parseStructuredOutput(rulesResult, "RULES_FAILED", "RULES_INVALID", "OCR rule", parseRulesText));
    validateRuleCoverage(preview.reviewable_files, ruleGroups);
  }

  const exitState = verifyReviewWorkspace(options.repo, options.candidate, entryState.tree);
  const selectedDigest = sha256(canonicalJson(preview.reviewable_files));
  const excludedDigest = sha256(canonicalJson(preview.excluded_files));
  const rulesDigest = sha256(canonicalJson(ruleGroups));
  let wrapperCommit = "unknown";
  const wrapperCommitResult = runCommand(["rev-parse", "HEAD"], { cwd: dirname(fileURLToPath(import.meta.url)), timeoutMs: 5_000 });
  if (wrapperCommitResult.ok) wrapperCommit = wrapperCommitResult.stdout.trim();
  const manifest = {
    schema: "paseo.ocr-review-manifest/v1",
    review: {
      base_sha: options.base,
      candidate_sha: options.candidate,
      merge_base_sha: preview.merge_base,
      candidate_tree_sha: exitState.tree,
    },
    harness: {
      wrapper_version: OCR_WRAPPER_VERSION,
      wrapper_commit_sha: wrapperCommit,
      ocr_version: ocrVersionNumber,
      ocr_output_format: formatJsonCapable ? "json" : "text",
    },
    scope: {
      discovered_count: preview.reviewable_files.length + preview.excluded_files.length,
      selected_count: preview.reviewable_files.length,
      excluded_count: preview.excluded_files.length,
      selected_digest: selectedDigest,
      excluded_digest: excludedDigest,
    },
    rules: {
      group_count: ruleGroups.length,
      resolution_digest: rulesDigest,
    },
    workspace: {
      head_entry: entryState.head,
      head_exit: exitState.head,
      clean_entry: entryState.clean,
      clean_exit: exitState.clean,
      linked_worktree: true,
      git_dir: worktree.gitDir,
    },
    // Backward-compatible top-level fields for simple consumers.
    base_sha: options.base,
    candidate_sha: options.candidate,
    merge_base: preview.merge_base,
    ocr_version: ocrVersion,
    mode: preview.mode,
    reviewable_files: preview.reviewable_files,
    excluded_files: preview.excluded_files,
    rule_groups: ruleGroups,
    empty_review: preview.reviewable_files.length === 0,
  };
  manifest.manifest_digest = sha256(canonicalJson(manifest));
  return manifest;
}

function help() {
  return `ocr-review.mjs — deterministic OpenCodeReview delegation preflight\n\nUsage:\n  node scripts/ocr-review.mjs --base <sha> --candidate <sha> [--repo <path>]\n  node scripts/ocr-review.mjs --verify --candidate <sha> --tree <tree-sha> [--repo <path>]\n\nRequires the review workspace to be a LINKED git worktree (worktree\nisolation), checks the exact clean HEAD, probes OCR delegation capabilities\n(version is provenance, not a gate), runs ocr delegate preview/rule in range\nmode, and emits a normalized manifest. --verify performs the post-review\nHEAD/status/tree check. It never edits code, changes Git state, or calls an LLM.`;
}

export function isMainModule(entry = process.argv[1], moduleUrl = import.meta.url) {
  return isEntrypoint(moduleUrl, entry);
}

if (isMainModule()) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(help());
    } else {
      console.log(JSON.stringify(main(options), null, 2));
    }
  } catch (error) {
    const code = error instanceof OcrReviewError ? error.code : "OCR_UNAVAILABLE";
    const message = error instanceof OcrReviewError ? error.message : String(error?.message ?? error);
    console.log(JSON.stringify({ ok: false, code, message, details: error instanceof OcrReviewError ? error.details : {} }));
    process.exitCode = 2;
  }
}
