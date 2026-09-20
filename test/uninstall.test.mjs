// uninstall.test.mjs — removing what install wrote, and nothing else.
//
// `cli/lib/uninstall.mjs` had no test at all until mutation testing pointed at
// it: making the Claude skill removal a no-op passed the whole suite. That is a
// bad module to leave uncovered, because its failure mode is silent in the
// worst direction — an uninstall that deletes a file it does not own is not
// something the user finds out about from an error message.
//
// The contract, in the module's own words: shared locations only ever lose
// NAMED items, never a whole directory or file another tool may also live in;
// a present-but-corrupt config is not "no config"; and removal never CREATES a
// file it was asked to clean.

import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SKILL_OWNER_MARKER } from "../scripts/claude-setup.mjs";

const home = mkdtempSync(join(tmpdir(), "paseo-uninstall-"));
const piHome = join(home, ".pi");
const agentDir = join(piHome, "agent");
const extDir = join(agentDir, "extensions");
const skillsDir = join(agentDir, "skills");
const claudeDir = join(home, ".claude");

process.env.PI_HOME = piHome;
delete process.env.PI_CODING_AGENT_DIR;
process.env.PST_TEAM_CONFIG_DIR = join(home, ".paseo-pi-team");
process.env.CLAUDE_CONFIG_DIR = claudeDir;
process.env.PASEO_TEAM_CLAUDE_USER_CONFIG = join(home, ".claude.json");
process.env.PASEO_CONFIG_JSON = join(home, "paseo-config.json");

// Imported after the env is set — config-walker resolves per call, but reading
// the module with the developer's real HOME in scope is how a test ends up
// uninstalling the pack from the machine running it.
const { removeMcpEntry, uninstall, MCP_ENTRY, teamScriptsDir } = await import(
	"../cli/lib/uninstall.mjs"
);

/** Everything the installers write, plus one file belonging to someone else. */
function install() {
	mkdirSync(join(extDir, "prompts"), { recursive: true });
	mkdirSync(join(extDir, "paseo-team-core"), { recursive: true });
	mkdirSync(teamScriptsDir(), { recursive: true });
	mkdirSync(claudeDir, { recursive: true });
	writeFileSync(join(extDir, "paseo-team-policy.ts"), "// adapter");
	writeFileSync(join(extDir, "paseo-team-core", "policy-core.ts"), "// core");
	for (const role of ["lead", "peer", "supervisor"]) {
		writeFileSync(join(extDir, "prompts", `${role}.md`), `# ${role}`);
	}
	for (const name of ["paseo-team-lead", "paseo-ocr-reviewer"]) {
		mkdirSync(join(skillsDir, name), { recursive: true });
		writeFileSync(join(skillsDir, name, "SKILL.md"), `# ${name}`);
		mkdirSync(join(claudeDir, "skills", name), { recursive: true });
		writeFileSync(join(claudeDir, "skills", name, "SKILL.md"), `# ${name}`);
		// The ownership marker a real install writes. Without it these are
		// indistinguishable from a skill the user wrote under the same name, and
		// uninstall deliberately leaves those alone — so a fixture that skips it
		// is not simulating an install, it is simulating a collision.
		writeFileSync(join(claudeDir, "skills", name, SKILL_OWNER_MARKER), "paseo-team-orchestration\n");
	}
	writeFileSync(join(teamScriptsDir(), "lib-common.mjs"), "// support");

	// The neighbours. Every one of these shares a directory with something the
	// pack owns, and every one must survive.
	writeFileSync(join(extDir, "someone-elses-extension.ts"), "// not ours");
	writeFileSync(join(extDir, "prompts", "their-prompt.md"), "# theirs");
	mkdirSync(join(skillsDir, "their-skill"), { recursive: true });
	writeFileSync(join(skillsDir, "their-skill", "SKILL.md"), "# theirs");
	mkdirSync(join(claudeDir, "skills", "their-skill"), { recursive: true });
	writeFileSync(join(claudeDir, "skills", "their-skill", "SKILL.md"), "# theirs");
}

const NEIGHBOURS = () => [
	join(extDir, "someone-elses-extension.ts"),
	join(extDir, "prompts", "their-prompt.md"),
	join(skillsDir, "their-skill", "SKILL.md"),
	join(claudeDir, "skills", "their-skill", "SKILL.md"),
];

test("removes every artifact the installers write", () => {
	install();
	const result = uninstall();
	assert.equal(result.summary.failed, 0, JSON.stringify(result, null, 1));
	for (const path of [
		join(extDir, "paseo-team-policy.ts"),
		join(extDir, "paseo-team-core"),
		join(extDir, "prompts", "lead.md"),
		join(skillsDir, "paseo-team-lead"),
		teamScriptsDir(),
	]) {
		assert.ok(!existsSync(path), `left behind: ${path}`);
	}
});

test("a shared directory only ever loses NAMED items", () => {
	install();
	uninstall();
	for (const path of NEIGHBOURS()) {
		assert.ok(existsSync(path), `uninstall deleted something it does not own: ${path}`);
	}
	// The directories themselves survive too — they are the user's, not ours.
	assert.ok(existsSync(join(extDir, "prompts")));
	assert.ok(existsSync(skillsDir));
});

test("the Claude side is removed, its neighbours are not", () => {
	install();
	const result = uninstall();
	assert.ok(result.claude, "the Claude integration must be part of the result");
	for (const name of ["paseo-team-lead", "paseo-ocr-reviewer"]) {
		assert.ok(
			!existsSync(join(claudeDir, "skills", name)),
			`~/.claude/skills/${name} survived an uninstall`,
		);
	}
	assert.ok(existsSync(join(claudeDir, "skills", "their-skill", "SKILL.md")));

	// The receipt must match the effect. An uninstall that removes the packages
	// but reports nothing removed is how a roll-up ends up saying "missing" for
	// work that was done — and the roll-up is all the caller prints.
	assert.deepEqual(
		[...(result.claude.skills?.skills ?? [])].sort(),
		["paseo-ocr-reviewer", "paseo-team-lead"],
		"uninstall must report the packages it actually deleted",
	);
	assert.equal(result.claude.status, "removed");
});

test("is idempotent, and never creates what it was asked to clean", () => {
	rmSync(home, { recursive: true, force: true });
	mkdirSync(home, { recursive: true });
	const result = uninstall();
	assert.equal(result.summary.failed, 0);
	assert.ok(result.summary.missing > 0, "a second run reports missing, not failed");
	assert.ok(!existsSync(piHome), "removal must not create the tree it is removing");
	assert.ok(!existsSync(claudeDir));
});

test("the audit log survives without --purge, and only --purge takes it", () => {
	install();
	const teamDir = process.env.PST_TEAM_CONFIG_DIR;
	mkdirSync(teamDir, { recursive: true });
	writeFileSync(join(teamDir, "permits.log"), "an accountability record");

	const kept = uninstall();
	assert.equal(kept.teamData.status, "kept");
	assert.match(kept.teamData.reason, /--purge/);
	assert.ok(existsSync(join(teamDir, "permits.log")), "the permit log is evidence, not litter");

	install();
	writeFileSync(join(teamDir, "permits.log"), "an accountability record");
	const purged = uninstall({ purge: true });
	assert.equal(purged.teamData.status, "removed");
	assert.ok(!existsSync(teamDir));
});

// --- the mcp.json entry -------------------------------------------------------

test("removeMcpEntry takes only our server, and backs the file up", () => {
	const mcpPath = join(agentDir, "mcp.json");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		mcpPath,
		JSON.stringify({ mcpServers: { [MCP_ENTRY]: { command: "x" }, other: { command: "y" } } }),
	);
	assert.equal(removeMcpEntry(mcpPath).status, "removed");
	const after = JSON.parse(readFileSync(mcpPath, "utf8"));
	assert.deepEqual(Object.keys(after.mcpServers), ["other"]);
	assert.equal(removeMcpEntry(mcpPath).status, "entry-missing", "idempotent");
});

test("a corrupt mcp.json is reported, never rewritten", () => {
	// The entry may still be in there and the file may hold whatever else the
	// user has; guessing at its contents is how an uninstall destroys a config.
	const mcpPath = join(agentDir, "mcp-corrupt.json");
	mkdirSync(agentDir, { recursive: true });
	const bytes = "{ not json at all";
	writeFileSync(mcpPath, bytes);
	const result = removeMcpEntry(mcpPath);
	assert.equal(result.status, "mcp-config-unreadable");
	assert.equal(readFileSync(mcpPath, "utf8"), bytes, "the bytes must be untouched");
});

test("an absent mcp.json is missing, and stays absent", () => {
	const mcpPath = join(agentDir, "no-such-mcp.json");
	assert.equal(removeMcpEntry(mcpPath).status, "mcp-config-missing");
	assert.ok(!existsSync(mcpPath));
});

test("a well-formed config without our entry is left exactly as it was", () => {
	const mcpPath = join(agentDir, "mcp-other.json");
	mkdirSync(agentDir, { recursive: true });
	const bytes = JSON.stringify({ mcpServers: { other: { command: "y" } } });
	writeFileSync(mcpPath, bytes);
	assert.equal(removeMcpEntry(mcpPath).status, "entry-missing");
	assert.equal(readFileSync(mcpPath, "utf8"), bytes);
});

test.after(() => rmSync(home, { recursive: true, force: true }));
