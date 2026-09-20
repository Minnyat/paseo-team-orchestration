// install-drift.test.mjs — "do the installed copies match this release?"
//
// The failure this guards is quiet by construction: `npm i -g` refreshes the
// CLI, the copies under ~/.pi/agent stay put, and both halves then report the
// same version number while enforcing different rules. So the test installs a
// pack into a throwaway HOME, asserts a clean install is silent, and then
// reproduces each way an install can go stale.

import assert from "node:assert/strict";
import {
	appendFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const piHome = mkdtempSync(join(tmpdir(), "paseo-drift-pi-"));
const claudeHome = mkdtempSync(join(tmpdir(), "paseo-drift-claude-"));
process.env.PI_HOME = piHome;
delete process.env.PI_CODING_AGENT_DIR;
// The Claude half needs the same sandbox, and for the same reason. Without it
// this file redirects pi into a throwaway home and then reads the DEVELOPER'S
// real ~/.claude/skills: a machine with the pack installed there reports its
// own installed copy as `changed`, so "an absent install is all missing" and
// "a faithful install reports no drift at all" both fail — on the machines
// where the pack is actually used, and nowhere else. CI passed because its
// runners have no ~/.claude to find.
process.env.CLAUDE_CONFIG_DIR = join(claudeHome, ".claude");

// Imported AFTER the env is set: config-walker resolves paths per call, but
// reading the module with the developer's real HOME in scope is the kind of
// test that edits the machine it runs on.
const { installDrift, installerSupportFiles, summarizeDrift } = await import(
	"../cli/lib/install-drift.mjs"
);


const extDir = join(piHome, "agent", "extensions");
const skillsDir = join(piHome, "agent", "skills");
const coreDir = join(extDir, "paseo-team-core");
const scriptsDir = join(extDir, "paseo-team-scripts");

const report = (env) => installDrift({ env: env ?? { ...process.env } });
const drift = (env) => report(env).drift;
const verdicts = (items, kind) =>
	items.filter((item) => item.kind === kind).map((item) => `${item.file}:${item.verdict}`);

// An install that never happened is every file missing — the honest answer, and
// the one the caller special-cases into a single "not installed" line.
{
	const initial = report();
	assert.equal(initial.installed, false, "the pi adapter is absent, so nothing is installed");
	assert.ok(initial.drift.length > 0);
	assert.ok(
		initial.drift.every((item) => item.verdict === "missing"),
		"an absent install reports missing, never changed or unexpected",
	);
}

// --- a faithful install, performed exactly the way scripts/install.sh does ----

function install() {
	mkdirSync(join(extDir, "prompts"), { recursive: true });
	mkdirSync(skillsDir, { recursive: true });
	cpSync(join(root, "extensions", "paseo-team-policy.ts"), join(extDir, "paseo-team-policy.ts"));
	rmSync(coreDir, { recursive: true, force: true });
	cpSync(join(root, "extensions", "paseo-team-core"), coreDir, { recursive: true });
	// install.sh deletes the built .js from the target: every loader prefers
	// .js, so an installed pair would let pi read the current rules while the
	// Claude hook reads stale ones.
	for (const name of ["policy-core", "claude-policy", "agent-directory"]) {
		rmSync(join(coreDir, `${name}.js`), { force: true });
	}
	for (const role of ["lead", "peer", "supervisor"]) {
		cpSync(join(root, "prompts", `${role}.md`), join(extDir, "prompts", `${role}.md`));
	}
	for (const name of ["paseo-team-lead", "paseo-ocr-reviewer"]) {
		rmSync(join(skillsDir, name), { recursive: true, force: true });
		cpSync(join(root, "skills", name), join(skillsDir, name), { recursive: true });
	}
	rmSync(scriptsDir, { recursive: true, force: true });
	mkdirSync(scriptsDir, { recursive: true });
	for (const file of supportFiles()) {
		cpSync(join(root, "scripts", file), join(scriptsDir, file));
	}
}

/**
 * The installers own the list, and the module under test reads it from
 * install.sh rather than keeping a copy. This test asserts that parse works
 * before relying on it — a drift checker whose own expectations have drifted is
 * worse than none, because it reports confidently about the wrong thing.
 */
function supportFiles() {
	const files = installerSupportFiles(root);
	assert.ok(files, "install.sh support-file list did not parse");
	assert.ok(files.length >= 4, "install.sh support-file list looks truncated");
	assert.ok(files.includes("lib-common.mjs"), "every other support script imports it");
	for (const name of files) {
		assert.ok(
			existsSync(join(root, "scripts", name)),
			`install.sh ships scripts/${name}, which does not exist`,
		);
	}
	return files;
}

install();
assert.deepEqual(drift(), [], "a faithful install reports no drift at all");
assert.deepEqual(summarizeDrift([]), []);

// --- the three ways an install goes stale ------------------------------------

// 1. A file edited in place, or left behind by an older release. This is the
//    one the policy-core load check cannot see: it still loads, still exports
//    the same API, and enforces different rules.
appendFileSync(join(coreDir, "policy-core.ts"), "\n// left over from an older release\n");
assert.deepEqual(verdicts(drift(), "policy-core"), ["policy-core.ts:changed"]);

// 2. A file this release ships that the install does not have.
rmSync(join(skillsDir, "paseo-ocr-reviewer", "SKILL.md"));
assert.deepEqual(verdicts(drift(), "skill"), ["paseo-ocr-reviewer/SKILL.md:missing"]);

// 3. A file the installers no longer ship, still sitting in a directory this
//    pack owns and replaces wholesale.
writeFileSync(join(scriptsDir, "retired-helper.mjs"), "from an older release");
assert.deepEqual(verdicts(drift(), "support-script"), ["retired-helper.mjs:unexpected"]);

// A support script this release ADDS is the half-upgrade case, and it is
// invisible to anything that only walks what was installed: the install looks
// complete and the first thing to import the new script fails at runtime on the
// user's machine. Checked against the installers' own list for that reason —
// and note the file still exists in scripts/, so "does the source have it?" is
// not a substitute.
install();
rmSync(join(scriptsDir, "lease-ledger.mjs"));
assert.deepEqual(verdicts(drift(), "support-script"), ["lease-ledger.mjs:missing"]);
assert.equal(report().installed, true, "one missing file is not an absent install");

// Even the pi adapter alone going missing is a STALE install, not an absent
// one. The distinction decides which message the caller prints, and the
// "not installed" one suppresses the filename that would fix it.
rmSync(join(extDir, "paseo-team-policy.ts"));
assert.equal(report().installed, true, "one absent artifact is not an absent install");
assert.deepEqual(verdicts(drift(), "extension"), ["paseo-team-policy.ts:missing"]);
install();

// An installer list that PARSES BUT IS EMPTY must not read as "the installers
// ship nothing": that walks every correctly-installed script into `unexpected`
// and hands a healthy host a page of findings whose remedy fixes none of them.
// Both ways of failing to read the list — unreadable, and readable but empty —
// have to reach the same `null`.
assert.equal(installerSupportFiles("/nonexistent-root"), null, "unreadable installer");
{
	const emptyList = mkdtempSync(join(tmpdir(), "paseo-drift-emptylist-"));
	mkdirSync(join(emptyList, "scripts"), { recursive: true });
	writeFileSync(join(emptyList, "scripts", "install.sh"), "TEAM_SUPPORT_FILES=(\n)\n");
	assert.equal(installerSupportFiles(emptyList), null, "parsed but empty is also unknown");
	rmSync(emptyList, { recursive: true, force: true });
}
{
	install();
	const bogus = installDrift({ root: "/nonexistent-root", env: { ...process.env } });
	assert.deepEqual(
		bogus.drift.filter((item) => item.kind === "support-script"),
		[],
		"an unknown support list reports nothing about support scripts",
	);
	assert.ok(
		bogus.unchecked.some((line) => line.startsWith("support-script:")),
		"and says so — a check that cannot run must not pass silently",
	);
	assert.equal(bogus.ok, false, "an unchecked comparison is not a clean result");
}

// A file in scripts/ that the installers do not ship is not expected to be
// installed, and its absence is not drift.
install();
writeFileSync(join(root, "scripts", "__drift_probe_not_shipped.mjs"), "// scratch\n");
try {
	assert.deepEqual(verdicts(drift(), "support-script"), []);
} finally {
	rmSync(join(root, "scripts", "__drift_probe_not_shipped.mjs"), { force: true });
}

// A built .js in the policy core is drift in its own right, for the reason
// install.sh deletes it: two sources of truth for one rule set, and the two
// runtimes would not agree on which they read.
install();
cpSync(join(root, "extensions", "paseo-team-core", "policy-core.js"), join(coreDir, "policy-core.js"));
assert.deepEqual(verdicts(drift(), "policy-core"), ["policy-core.js:unexpected"]);

// The prompts directory is SHARED with whatever else the user keeps under
// ~/.pi/agent/extensions/prompts/, so a file we did not install is not ours to
// call a leftover.
install();
writeFileSync(join(extDir, "prompts", "someone-elses.md"), "not ours");
assert.deepEqual(drift(), [], "an unknown file in the shared prompts dir is not drift");

// --- the Claude copies -------------------------------------------------------
//
// Checked only when that side was installed at all: a pi-only host is a
// supported configuration, and two permanently-missing skill packages there
// would be noise rather than a finding.
{
	install();
	const env = { ...process.env, CLAUDE_CONFIG_DIR: join(claudeHome, ".claude") };
	assert.deepEqual(drift(env), [], "no Claude install means nothing to compare");

	const claudeSkills = join(claudeHome, ".claude", "skills");
	mkdirSync(claudeSkills, { recursive: true });
	cpSync(join(root, "skills", "paseo-team-lead"), join(claudeSkills, "paseo-team-lead"), {
		recursive: true,
	});
	assert.deepEqual(drift(env), [], "a current Claude copy is not drift either");

	appendFileSync(join(claudeSkills, "paseo-team-lead", "SKILL.md"), "\nstale\n");
	assert.deepEqual(verdicts(drift(env), "claude-skill"), ["paseo-team-lead/SKILL.md:changed"]);

	// This block deliberately leaves a stale Claude copy behind, so it removes
	// it again. Every later block calls drift() with no env and would otherwise
	// inherit this one's damage and fail describing something else entirely.
	rmSync(claudeSkills, { recursive: true, force: true });
}

// --- CRLF is not a version difference ----------------------------------------
//
// The repo pins LF, but a file copied by PowerShell and re-saved by an editor
// comes back with CRLF. Reporting that as drift would make the check cry wolf
// on every Windows host.
{
	install();
	const promptPath = join(extDir, "prompts", "lead.md");
	writeFileSync(promptPath, readFileSync(promptPath, "utf8").replace(/\n/g, "\r\n"));
	assert.deepEqual(drift(), [], "a CRLF copy of the same content is not drift");
}

// --- the summary stays readable ----------------------------------------------
{
	rmSync(coreDir, { recursive: true, force: true });
	const lines = summarizeDrift(drift(), { perKind: 2 });
	assert.ok(lines.some((line) => line.startsWith("policy-core: ")));
	assert.ok(
		lines.every((line) => line.length < 200),
		"the summary is a preflight line, not a file listing",
	);
	assert.match(summarizeDrift(drift(), { perKind: 1 }).join("\n"), /\+\d+ more/);
}

// --- a customised prompt is drift, and must not be reported as a mistake -----
//
// `pteam prompts write` and `pteam skills write` are first-class commands that
// deliberately edit the installed copies. Reporting the result is right — the
// running agent is not on this release's rules — but the caller has to be able
// to tell that case apart, because the obvious remedy (`pteam install`)
// overwrites the edit.
{
	install();
	appendFileSync(join(extDir, "prompts", "lead.md"), "\n## Local house rule\n");
	const items = drift();
	assert.deepEqual(verdicts(items, "prompt"), ["lead.md:changed"]);
	assert.ok(
		items.every((item) => item.kind === "prompt" || item.kind === "skill"),
		"a prompt edit alone must be distinguishable from a stale install",
	);
}

rmSync(piHome, { recursive: true, force: true });
rmSync(claudeHome, { recursive: true, force: true });
console.log("install drift tests passed");
