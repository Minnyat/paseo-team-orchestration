// claude-policy.test.mjs — the Claude dialect of the role policy.
//
// The invariants are the same ones policy.test.mts pins for Pi; what is tested
// here is that they survive the TRANSLATION: different tool names, a different
// MCP shape (mcp__paseo__<tool> with args as the tool input), and a static
// disallowedTools layer that must not overlap with the per-turn decisions.

import assert from "node:assert/strict";
import { homedir } from "node:os";
import {
	claudeBaseTools,
	claudeDisallowedTools,
	claudeToolBlockReason,
	classifyClaudeTool,
	describeClaudePolicy,
	teamToolName,
	claudeReadPath,
	claudeSkillName,
	CLAUDE_PASEO_TOOL_NAMES,
} from "../extensions/paseo-team-core/claude-policy.ts";
import {
	parseTaskBrief,
	skillBlockReason,
} from "../extensions/paseo-team-core/policy-core.ts";

const brief = (lines) => parseTaskBrief(lines.join("\n"));

const writeBrief = brief([
	"PASEO_TEAM_TASK_V3_BEGIN",
	"TASK_ID: T-100",
	"MODE: write",
	"EDIT_AUTHORITY: allowed",
	"COMMIT_AUTHORITY: allowed",
	"PUSH_TASK_BRANCH_AUTHORITY: allowed",
	"PASEO_TEAM_TASK_V3_END",
	"",
	"Body text.",
]);
const readOnlyBrief = brief([
	"PASEO_TEAM_TASK_V3_BEGIN",
	"TASK_ID: T-101",
	"MODE: read-only",
	"PASEO_TEAM_TASK_V3_END",
]);
const browserBrief = brief([
	"PASEO_TEAM_TASK_V3_BEGIN",
	"TASK_ID: T-102",
	"MODE: read-only",
	"BROWSER_MCP_AUTHORITY: allowed",
	"PASEO_TEAM_TASK_V3_END",
]);
// Browser is the one authority a valid V3 brief grants by default, so the
// withheld case needs the field spelled out.
const noBrowserBrief = brief([
	"PASEO_TEAM_TASK_V3_BEGIN",
	"TASK_ID: T-104",
	"MODE: read-only",
	"BROWSER_MCP_AUTHORITY: denied",
	"PASEO_TEAM_TASK_V3_END",
]);
// MODE says write, EDIT_AUTHORITY says no: the narrower one wins.
const authorityMismatchBrief = brief([
	"PASEO_TEAM_TASK_V3_BEGIN",
	"TASK_ID: T-103",
	"MODE: write",
	"EDIT_AUTHORITY: denied",
	"PASEO_TEAM_TASK_V3_END",
]);

const decide = (role, toolName, toolInput, taskBrief = null) =>
	claudeToolBlockReason({ role, toolName, toolInput, brief: taskBrief });

// --- classification -----------------------------------------------------------

assert.deepEqual(classifyClaudeTool("Read"), { kind: "read" });
assert.deepEqual(classifyClaudeTool("Write"), { kind: "write" });
assert.deepEqual(classifyClaudeTool("NotebookEdit"), { kind: "edit" });
assert.deepEqual(classifyClaudeTool("Bash"), { kind: "bash" });
assert.deepEqual(classifyClaudeTool("Task"), { kind: "subagent" });
assert.deepEqual(classifyClaudeTool("mcp__paseo__create_agent"), {
	kind: "paseo-mcp",
	target: "create_agent",
});
assert.deepEqual(classifyClaudeTool("mcp__paseo-team__peer_ask_lead"), {
	kind: "team",
	target: "peer_ask_lead",
});
// Claude in Chrome is the runtime's own browser and classifies as browser
// authority, not as "some other MCP server".
assert.equal(classifyClaudeTool("mcp__claude-in-chrome__navigate").kind, "browser-mcp");
assert.equal(classifyClaudeTool("mcp__paseo__browser_click").kind, "browser-mcp");
// The agent-browser server the pack used to install is no longer special: it is
// an unrelated MCP server like any other.
assert.equal(classifyClaudeTool("mcp__agent-browser__open").kind, "other-mcp");
assert.equal(classifyClaudeTool("mcp__something-else__do").kind, "other-mcp");
// An unknown bare tool is "other" — and "other" is denied unless allowlisted.
assert.deepEqual(classifyClaudeTool("SomeFutureTool"), { kind: "other" });
assert.equal(teamToolName("mcp__paseo-team__team_watchdog"), "team_watchdog");
assert.equal(teamToolName("Read"), "Read");
assert.ok(CLAUDE_PASEO_TOOL_NAMES.includes("mcp__paseo__create_agent"));

// --- peer: write authority is per-turn ----------------------------------------

assert.equal(decide("peer", "Write", { file_path: "a" }, writeBrief), null);
assert.equal(decide("peer", "Edit", {}, writeBrief), null);
assert.match(
	decide("peer", "Write", {}, readOnlyBrief) ?? "",
	/read-only/,
	"read-only brief blocks writes",
);
assert.match(
	decide("peer", "Write", {}, null) ?? "",
	/read-only/,
	"no brief at all is read-only, never write",
);
assert.match(
	decide("peer", "Write", {}, authorityMismatchBrief) ?? "",
	/AUTHORITY_MISMATCH/,
	"MODE: write without EDIT_AUTHORITY still blocks",
);
// A legacy V1/V2 brief can never grant write on Claude either.
assert.match(
	decide(
		"peer",
		"Write",
		{},
		brief(["PASEO_TEAM_TASK_V2", "TASK_ID: T-9", "MODE: write", "EDIT_AUTHORITY: allowed"]),
	) ?? "",
	/read-only/,
);

// --- peer: bash guards --------------------------------------------------------

assert.equal(decide("peer", "Bash", { command: "npm test" }, writeBrief), null);
assert.match(
	decide("peer", "Bash", { command: "paseo run --provider claude-peer 'x'" }, writeBrief) ?? "",
	/Paseo CLI/,
);
// There is no browser-CLI guard any more, and there is nothing left for it to
// guard: neither replacement browser has a CLI a Peer could shell out to.
// Running a stray `agent-browser` binary a user happens to have installed is
// just an ordinary bash command that will fail on its own.
assert.equal(
	decide("peer", "Bash", { command: "agent-browser open https://x" }, browserBrief),
	null,
);
assert.equal(
	decide("peer", "Bash", { command: "git push -u origin HEAD:refs/heads/agent/T-100" }, writeBrief),
	null,
	"exact branch-scoped push is the one allowed form",
);
assert.match(
	decide("peer", "Bash", { command: "git push -u origin HEAD:refs/heads/main" }, writeBrief) ?? "",
	/branch-scoped/,
);
assert.match(
	decide("peer", "Bash", { command: "git push --force origin HEAD:refs/heads/agent/T-100" }, writeBrief) ?? "",
	/FORCE_PUSH_AUTHORITY/,
);
assert.match(
	decide("peer", "Bash", { command: "git commit -m x" }, readOnlyBrief) ?? "",
	/COMMIT_AUTHORITY/,
);
// A non-string command must not slip past the guard as an empty string.
assert.equal(decide("peer", "Bash", { command: 42 }, writeBrief), null);

// --- peer: MCP surface --------------------------------------------------------

assert.match(
	decide("peer", "mcp__paseo__create_agent", {}, writeBrief) ?? "",
	/DEPENDENCY_REQUEST/,
	"peers never orchestrate, whatever the brief says",
);
assert.match(
	decide("peer", "mcp__paseo__list_agents", {}, writeBrief) ?? "",
	/DEPENDENCY_REQUEST/,
);
// A brief that says nothing about the browser leaves it ON: the Peer keeps the
// runtime's default browser surface, and only an explicit denial removes it.
assert.equal(decide("peer", "mcp__claude-in-chrome__navigate", {}, writeBrief), null);
assert.equal(decide("peer", "mcp__claude-in-chrome__navigate", {}, browserBrief), null);
assert.match(
	decide("peer", "mcp__claude-in-chrome__navigate", {}, noBrowserBrief) ?? "",
	/BROWSER_MCP_AUTHORITY: denied/,
);
assert.equal(decide("lead", "mcp__claude-in-chrome__computer", {}, null), null);
assert.match(
	decide("supervisor", "mcp__claude-in-chrome__navigate", {}, null) ?? "",
	/no browser authority/,
);
// agent-browser is gone: it now falls through to the unrelated-MCP wall, for
// every role, brief or no brief.
assert.match(
	decide("peer", "mcp__agent-browser__open", {}, browserBrief) ?? "",
	/outside the peer role surface/,
);
// Paseo registers its own Browser Control on the SAME MCP server as
// create_agent. It is browser authority, not orchestration — classifying by
// server would switch the Peer's browser off with the orchestration wall.
assert.deepEqual(classifyClaudeTool("mcp__paseo__browser_navigate"), {
	kind: "browser-mcp",
	target: "browser_navigate",
});
assert.equal(decide("peer", "mcp__paseo__browser_navigate", { url: "http://x" }, writeBrief), null);
assert.equal(decide("lead", "mcp__paseo__browser_snapshot", {}, null), null);
assert.match(
	decide("peer", "mcp__paseo__browser_navigate", { url: "http://x" }, noBrowserBrief) ?? "",
	/BROWSER_MCP_AUTHORITY: denied/,
);
assert.match(
	decide("supervisor", "mcp__paseo__browser_navigate", { url: "http://x" }, null) ?? "",
	/no browser authority/,
);
assert.match(
	decide("peer", "mcp__unrelated__do", {}, browserBrief) ?? "",
	/outside the peer role surface/,
);
assert.match(
	decide("peer", "Task", { prompt: "x" }, writeBrief) ?? "",
	/subagents are denied/,
	"a peer must not fan out outside Paseo",
);
assert.match(decide("peer", "SomeFutureTool", {}, writeBrief) ?? "", /blocked by the peer role/);
// Schema lookup for deferred tools is allowed for every role: it reveals no
// capability on its own, and every resulting call still passes this policy.
// (Denying it was found in live verification to strand a Lead that was
// reaching for Paseo tools it WAS allowed to call.)
for (const role of ["supervisor", "lead", "peer"]) {
	assert.equal(decide(role, "ToolSearch", { query: "select:Read" }, writeBrief), null);
	assert.ok(!claudeDisallowedTools(role).includes("ToolSearch"));
}

// --- the escalation chain owns the route to the Human -------------------------
//
// Peer -> Lead -> Supervisor -> Human. Only the Supervisor's escalation target
// IS the Human, so only the Supervisor keeps the structured ask-the-user tool;
// for the other two it is the door that puts a delegated decision back on the
// Human's desk. Pi exposes no such tool to any role, so leaving it open on
// Claude was also a cross-runtime authority asymmetry.
assert.equal(decide("supervisor", "AskUserQuestion", { questions: [] }, null), null);
assert.ok(!claudeDisallowedTools("supervisor").includes("AskUserQuestion"));
assert.match(
	decide("lead", "AskUserQuestion", { questions: [] }, null) ?? "",
	/lead_ask_supervisor/,
);
assert.match(
	decide("peer", "AskUserQuestion", { questions: [] }, writeBrief) ?? "",
	/peer_ask_lead/,
);
for (const role of ["lead", "peer"]) {
	assert.ok(
		claudeDisallowedTools(role).includes("AskUserQuestion"),
		"the static layer must strip it too, so the model never sees the door",
	);
	assert.ok(!claudeBaseTools(role).includes("AskUserQuestion"));
}

// --- peer: team tools ---------------------------------------------------------

assert.equal(decide("peer", "mcp__paseo-team__peer_ask_lead", {}, writeBrief), null);
assert.match(
	decide("peer", "mcp__paseo-team__peer_ask_lead", {}, null) ?? "",
	/valid current V3 task brief/,
	"asking the Lead requires a real brief to attribute the message to",
);
assert.match(
	decide("peer", "mcp__paseo-team__team_watchdog", {}, writeBrief) ?? "",
	/Lead and Supervisor/,
);

// --- supervisor ---------------------------------------------------------------

assert.equal(decide("supervisor", "Read", {}), null);
assert.equal(decide("supervisor", "mcp__paseo__list_agents", {}), null);
assert.equal(decide("supervisor", "mcp__paseo__send_agent_prompt", {}), null);
assert.match(decide("supervisor", "Write", {}) ?? "", /cannot modify product code/);
assert.match(decide("supervisor", "Bash", { command: "ls" }) ?? "", /blocked by the supervisor role/);
assert.match(decide("supervisor", "mcp__paseo__create_workspace", {}) ?? "", /monitoring tools/);
assert.match(decide("supervisor", "mcp__paseo__browser_navigate", {}) ?? "", /no browser authority/);
// create_agent is the one gated orchestration action, and the ARGS are the gate.
// On Claude the arguments ARE the tool input, so a missing input is the
// unclassifiable case that must fail closed.
assert.match(
	decide("supervisor", "mcp__paseo__create_agent", undefined) ?? "",
	/args object/,
);
assert.match(decide("supervisor", "mcp__paseo__create_agent", {}) ?? "", /lead-recovery only/);
assert.match(
	decide("supervisor", "mcp__paseo__create_agent", {
		provider: "claude-peer/claude-opus-5",
		labels: { purpose: "recovery", recovery_for: "p" },
		settings: { thinkingOptionId: "high" },
	}) ?? "",
	/lead-recovery only/,
	"a peer provider is not a lead recovery",
);
assert.match(
	decide("supervisor", "mcp__paseo__create_agent", {
		provider: "claude-lead",
		labels: { purpose: "recovery", recovery_for: "p" },
		settings: { thinkingOptionId: "high" },
	}) ?? "",
	/lead-recovery only/,
	"a lead provider without a model would take a daemon default",
);
assert.equal(
	decide("supervisor", "mcp__paseo__create_agent", {
		provider: "claude-lead/claude-opus-5",
		labels: { purpose: "recovery", recovery_for: "content-analysis" },
		settings: { thinkingOptionId: "high", modeId: "auto" },
	}),
	null,
	"a Claude lead recovery passes the same gate as a pi one",
);
// The recovery seat needs a mode for the same reason it needs a thinking level:
// Paseo applies no defaultMode at create time, and a successor Lead that comes
// up on "default" parks every call it makes — with nobody left to triage them,
// since the Lead it replaces is the one that failed.
assert.match(
	decide("supervisor", "mcp__paseo__create_agent", {
		provider: "claude-lead/claude-opus-5",
		labels: { purpose: "recovery", recovery_for: "content-analysis" },
		settings: { thinkingOptionId: "high" },
	}) ?? "",
	/settings\.modeId/,
	"a lead-recovery seat without a mode is refused too",
);
assert.equal(
	decide("supervisor", "mcp__paseo__create_agent", {
		provider: "pi-lead/Minnyat/gpt-5.6-sol",
		labels: { purpose: "bootstrap", recovery_for: "pod" },
		settings: { thinkingOptionId: "high" },
	}),
	null,
);
assert.match(
	decide("supervisor", "mcp__paseo__create_agent", {
		provider: "claude-lead/claude-opus-5",
		labels: { purpose: "recovery", recovery_for: "p" },
	}) ?? "",
	/thinkingOptionId/,
	"no daemon-default model",
);

// --- lead ---------------------------------------------------------------------

assert.equal(decide("lead", "mcp__paseo__create_agent", { provider: "x" }), null);
assert.equal(decide("lead", "mcp__paseo__respond_to_permission", {}), null);
assert.equal(decide("lead", "Bash", { command: "git status" }), null);
assert.equal(decide("lead", "mcp__claude-in-chrome__navigate", {}), null);
assert.match(decide("lead", "Write", {}) ?? "", /blocked by the lead role/);
assert.match(decide("lead", "mcp__paseo__create_terminal", {}) ?? "", /not in the lead MCP allowlist/);
// Reviewer isolation, layer 1: a review workspace must be a worktree.
assert.match(
	decide("lead", "mcp__paseo__create_workspace", { isolation: "local", title: "review:T-1" }) ?? "",
	/must use isolation "worktree"/,
);
assert.equal(
	decide("lead", "mcp__paseo__create_workspace", { isolation: "worktree", title: "review:T-1" }),
	null,
);
assert.match(
	decide("lead", "mcp__paseo__create_workspace", { title: "anything" }) ?? "",
	/explicit isolation/,
	"never rely on a daemon default",
);

// --- create_agent: the cluster-label gate, parity with policy.test.mts -------
// `decide()` never passes `cluster`, so none of the calls above trip this gate
// (same reasoning as the Pi suite: an unresolved own cluster disables it). The
// calls below pass it explicitly, exactly as claude-hook.mjs's pre-tool-use
// handler always does via `core.selfCluster(env)`.
assert.match(
	claudeToolBlockReason({
		role: "lead",
		toolName: "mcp__paseo__create_agent",
		toolInput: { provider: "x" },
		brief: null,
		cluster: "d:/code/shop",
	}) ?? "",
	/labels\["team\.cluster"\] is required and must be "d:\/code\/shop"/,
	"a Lead creating an agent without a cluster label is refused on Claude too",
);
assert.match(
	claudeToolBlockReason({
		role: "lead",
		toolName: "mcp__paseo__create_agent",
		toolInput: { provider: "x", labels: { "team.cluster": "d:/code/blog" } },
		brief: null,
		cluster: "d:/code/shop",
	}) ?? "",
	/is "d:\/code\/blog", but this seat's own cluster is "d:\/code\/shop"/,
	"a label naming a different cluster is refused",
);
assert.equal(
	claudeToolBlockReason({
		role: "lead",
		toolName: "mcp__paseo__create_agent",
		toolInput: { provider: "x", labels: { "team.cluster": "D:\\Code\\Shop" } },
		brief: null,
		cluster: "d:/code/shop",
	}),
	null,
	"a matching label passes — compared through normalizeCluster",
);
assert.equal(
	claudeToolBlockReason({
		role: "lead",
		toolName: "mcp__paseo__create_agent",
		toolInput: { provider: "x" },
		brief: null,
		cluster: null,
	}),
	null,
	"an unresolvable own cluster disables the gate on this runtime too",
);
assert.equal(
	claudeToolBlockReason({
		role: "lead",
		toolName: "mcp__paseo__create_workspace",
		toolInput: { isolation: "local" },
		brief: null,
		cluster: "d:/code/shop",
	}),
	null,
	"create_workspace carries no team.cluster requirement",
);
{
	const recovery = {
		provider: "claude-lead/claude-opus-5",
		labels: { purpose: "recovery", recovery_for: "content-analysis" },
		// modeId for the same reason as thinkingOptionId: Paseo applies no
		// provider default at create time, so a successor Lead without one comes
		// up on "default" and parks every call it makes.
		settings: { thinkingOptionId: "high", modeId: "auto" },
	};
	assert.match(
		claudeToolBlockReason({
			role: "supervisor",
			toolName: "mcp__paseo__create_agent",
			toolInput: recovery,
			brief: null,
			cluster: "d:/code/shop",
		}) ?? "",
		/labels\["team\.cluster"\] is required/,
		"a Supervisor's lead-recovery create_agent needs the cluster label too, on Claude",
	);
	assert.equal(
		claudeToolBlockReason({
			role: "supervisor",
			toolName: "mcp__paseo__create_agent",
			toolInput: { ...recovery, labels: { ...recovery.labels, "team.cluster": "d:/code/shop" } },
			brief: null,
			cluster: "d:/code/shop",
		}),
		null,
		"a gated recovery create_agent with a matching cluster label passes both gates",
	);
}

// --- env-driven surfaces ------------------------------------------------------

{
	const previous = process.env.PASEO_TEAM_LEAD_WRITE;
	process.env.PASEO_TEAM_LEAD_WRITE = "1";
	assert.equal(decide("lead", "Write", {}), null, "documented opt-in grants lead write");
	assert.ok(!claudeDisallowedTools("lead").includes("Write"));
	if (previous === undefined) delete process.env.PASEO_TEAM_LEAD_WRITE;
	else process.env.PASEO_TEAM_LEAD_WRITE = previous;
}
{
	const previous = process.env.PASEO_TEAM_EXTRA_TOOLS;
	process.env.PASEO_TEAM_EXTRA_TOOLS = "WebFetch,mcp__unrelated__do";
	assert.equal(decide("peer", "WebFetch", {}, writeBrief), null);
	assert.equal(decide("peer", "mcp__unrelated__do", {}, writeBrief), null);
	assert.ok(!claudeDisallowedTools("peer").includes("WebFetch"));
	if (previous === undefined) delete process.env.PASEO_TEAM_EXTRA_TOOLS;
	else process.env.PASEO_TEAM_EXTRA_TOOLS = previous;
}

// --- static layer: provider disallowedTools -----------------------------------
//
// The static list must remove what the role can NEVER use, and must NOT remove
// what the per-turn decision needs to be able to grant (peer write/edit).
for (const role of ["supervisor", "lead", "peer"]) {
	const denied = new Set(claudeDisallowedTools(role));
	const allowed = new Set(claudeBaseTools(role));
	for (const tool of allowed) {
		assert.ok(!denied.has(tool), `${role}: ${tool} is both allowed and disallowed`);
	}
	assert.ok(denied.has("Task"), `${role}: Claude subagents must be stripped statically`);
}
assert.ok(claudeDisallowedTools("supervisor").includes("Bash"));
assert.ok(claudeDisallowedTools("supervisor").includes("Write"));
assert.ok(!claudeDisallowedTools("peer").includes("Write"), "a write peer needs the tool present");
assert.ok(!claudeDisallowedTools("peer").includes("Bash"));

// --- diagnostics --------------------------------------------------------------

const described = describeClaudePolicy("peer", writeBrief);
assert.match(described, /role=peer/);
assert.match(described, /peerMode=write/);
assert.match(described, /edit=true/);
assert.match(describeClaudePolicy("peer", null), /brief=none/);
assert.match(describeClaudePolicy("lead", null), /paseoMcp=\[/);

// --- OCR-001 parity: the support-script side door is shut on Claude too ----
{
	const bash = (role, command) =>
		claudeToolBlockReason({ role, toolName: "Bash", toolInput: { command }, brief: null });

	assert.match(String(bash("peer", "node /x/paseo-team-scripts/team-lease.mjs claim {}")), /support script/i);
	assert.match(String(bash("peer", "node /x/paseo-team-scripts/remote-paseo.mjs run")), /support script/i);
	// The Reviewer Peer runs this one by design.
	assert.equal(bash("peer", "node /x/paseo-team-scripts/ocr-review.mjs --repo r"), null);
	assert.equal(bash("peer", "node /x/paseo-team-scripts/team-communication.mjs ask-lead {}"), null);
}

// --- scope lease: the same rule reaches the Claude runtime -------------------
// The rule itself is pinned in scope-lease.test.mts. What is pinned HERE is that
// the Claude adapter actually consults it — the leg that, for an earlier guard,
// was missing on this runtime and would have made `claude-lead` a one-provider
// bypass.
{
	const { resolveLeases } = await import("../extensions/paseo-team-core/policy-core.ts");
	const LEAD_A = "aaaaaaaa-1111-4111-8111-111111111111";
	const LEAD_B = "bbbbbbbb-2222-4222-8222-222222222222";
	const now = 10_000_000;
	const claim = (author, scope) => ({
		author,
		createdAt: new Date(now - 1000).toISOString(),
		body: `LEASE_V1\nACTION: claim\nSCOPE: ${scope}\nTTL_MS: 3600000`,
	});
	const writerBrief = [
		"PASEO_TEAM_TASK_V3_BEGIN",
		"TASK_ID: T-1",
		"DISPOSITION: engineer",
		"MODE: write",
		"OWNED_SCOPE: src/auth",
		"EDIT_AUTHORITY: allowed",
		"PASEO_TEAM_TASK_V3_END",
	].join("\n");
	const createAgent = (leases, selfAgentId, prompt = writerBrief) =>
		claudeToolBlockReason({
			role: "lead",
			toolName: "mcp__paseo__create_agent",
			toolInput: { initialPrompt: prompt },
			brief: null,
			leases,
			selfAgentId,
		});

	assert.equal(
		createAgent(resolveLeases([claim(LEAD_A, "src/auth")], { now }), LEAD_A),
		null,
		"the holder may staff its own scope",
	);
	assert.match(
		String(createAgent(resolveLeases([claim(LEAD_B, "src/auth")], { now }), LEAD_A)),
		/SCOPE_LEASE_HELD/,
		"another Lead's scope is refused on this runtime too",
	);
	assert.match(
		String(createAgent(resolveLeases([], { now }), LEAD_A)),
		/SCOPE_LEASE_MISSING/,
		"and staffing an unclaimed scope is refused",
	);
	// The hook could not read the ledger. Fail closed: a Lead that cannot create
	// a writer is a visible incident, two writers on one scope is a silent one.
	assert.match(String(createAgent(null, LEAD_A)), /LEASE_UNVERIFIABLE/);
	assert.match(String(createAgent(undefined, LEAD_A)), /LEASE_UNVERIFIABLE/, "a caller that forgot to fetch is not a free pass");

	// OCR-002: the brief arms a Peer whether it arrives at creation or in a later
	// turn, so send_agent_prompt is gated exactly like create_agent. Otherwise the
	// two-step — create something benign, then send the write brief — walks past
	// the lease untouched.
	assert.match(
		String(
			claudeToolBlockReason({
				role: "lead",
				toolName: "mcp__paseo__send_agent_prompt",
				toolInput: { agentId: "x", prompt: writerBrief },
				brief: null,
				leases: resolveLeases([claim(LEAD_B, "src/auth")], { now }),
				selfAgentId: LEAD_A,
			}),
			/SCOPE_LEASE_HELD/,
		),
		/SCOPE_LEASE_HELD/,
	);

	// OCR-007: the Supervisor may read the lease board but not move it, on this
	// runtime as well — an authority that exists on one adapter only is the exact
	// asymmetry the shared core exists to prevent.
	const leaseTool = (role, action) =>
		claudeToolBlockReason({
			role,
			toolName: "mcp__paseo-team__team_lease",
			toolInput: { action, scope: "src/auth" },
			brief: null,
		});
	assert.equal(leaseTool("supervisor", "status"), null, "reading the board is governance");
	assert.match(String(leaseTool("supervisor", "claim")), /not claim, renew or release/);
	assert.match(String(leaseTool("supervisor", "release")), /not claim, renew or release/);
	assert.equal(leaseTool("lead", "claim"), null);

	// A read-only peer shares the tree by design and is never gated.
	assert.equal(
		createAgent(resolveLeases([claim(LEAD_B, "src/auth")], { now }), LEAD_A, writerBrief.replace("MODE: write", "MODE: read-only")),
		null,
	);
}

// --- PR-D governance: the same three walls reach the Claude runtime ---------
// Parity, not repetition: the rules are pinned in governance.test.mts, and what
// is pinned HERE is that the Claude adapter consults them. A governance rule
// present on one runtime only would let an operator pick a provider to escape
// it — the exact failure a bash guard hit before the core split.
{
	const LEAD_A = "aaaaaaaa-3333-4333-8333-333333333333";
	const LEAD_B = "bbbbbbbb-4444-4444-8444-444444444444";
	const PEER_OF_B = "cccccccc-5555-4555-8555-555555555555";

	const peerOfB = {
		agentId: PEER_OF_B,
		parentAgentId: LEAD_B,
		provider: "pi-peer/anthropic/model",
		role: "peer",
		domain: null,
	};
	const promptCall = (over = {}) =>
		claudeToolBlockReason({
			role: "lead",
			toolName: "mcp__paseo__send_agent_prompt",
			toolInput: { agentId: PEER_OF_B, prompt: "status?" },
			brief: null,
			selfAgentId: LEAD_A,
			topology: "multi",
			promptTarget: peerOfB,
			...over,
		});

	assert.match(String(promptCall()), /PROMPT_TARGET_NOT_OWNED/);
	assert.match(String(promptCall()), /bbbbbbbb/, "and names the owning Lead");
	assert.equal(
		promptCall({ promptTarget: { ...peerOfB, parentAgentId: LEAD_A } }),
		null,
		"this Lead's own Peer is reachable",
	);
	assert.equal(
		promptCall({ promptTarget: { ...peerOfB, role: "lead" } }),
		null,
		"another Lead is reachable — that is the coordination path",
	);
	assert.match(
		String(promptCall({ promptTarget: null })),
		/PROMPT_TARGET_UNKNOWN/,
		"an unresolvable target is fail-closed on this runtime too",
	);
	assert.equal(
		promptCall({ topology: "single" }),
		null,
		"single topology leaves send_agent_prompt exactly as it was",
	);
	assert.equal(
		claudeToolBlockReason({
			role: "lead",
			toolName: "mcp__paseo__send_agent_prompt",
			toolInput: { agentId: PEER_OF_B, prompt: "status?" },
			brief: null,
			selfAgentId: LEAD_A,
		}),
		null,
		"a caller that passes no topology gets the pre-PR-D behaviour",
	);

	// recovery_for must stay inside the Supervisor's own jurisdiction here too.
	const recovery = (over = {}) =>
		claudeToolBlockReason({
			role: "supervisor",
			toolName: "mcp__paseo__create_agent",
			toolInput: {
				provider: "claude-lead/claude-opus-5",
				labels: { purpose: "recovery", recovery_for: "frontend.shell" },
				settings: { thinkingOptionId: "high", modeId: "auto" },
			},
			brief: null,
			topology: "multi",
			selfDomain: "backend",
			...over,
		});
	assert.match(String(recovery()), /RECOVERY_OUT_OF_JURISDICTION/);
	assert.equal(recovery({ selfDomain: "frontend" }), null);
	assert.match(String(recovery({ selfDomain: null })), /JURISDICTION_UNDECLARED/);
	assert.equal(recovery({ topology: "single" }), null, "single topology keeps the old recovery gate");

	// The observation loop's heartbeat is allowed for both coordinating roles —
	// it is what replaces polling list_agents.
	for (const role of ["supervisor", "lead"]) {
		assert.equal(
			claudeToolBlockReason({
				role,
				toolName: "mcp__paseo__create_heartbeat",
				toolInput: { prompt: "observation round", cron: "*/15 * * * *" },
				brief: null,
			}),
			null,
			`${role} may arm an observation heartbeat`,
		);
	}
	// A schedule starts a fresh AGENT on a cron. That is orchestration, and the
	// Supervisor does not orchestrate.
	assert.match(
		String(
			claudeToolBlockReason({
				role: "supervisor",
				toolName: "mcp__paseo__create_schedule",
				toolInput: { prompt: "x", cron: "* * * * *", provider: "pi-peer/x/y" },
				brief: null,
			}),
		),
		/blocked/i,
	);
	assert.match(
		String(
			claudeToolBlockReason({
				role: "peer",
				toolName: "mcp__paseo__create_heartbeat",
				toolInput: { prompt: "x", cron: "* * * * *" },
				brief: null,
			}),
		),
		/Peer cannot orchestrate/,
	);
}

// --- Skill admission, Claude dialect -----------------------------------------
//
// `Skill` itself stays allowed for every role — the user's own skills go
// through it — so what is pinned here is the package-level gate and the fact
// that it reads the same table the Pi adapter does.
{
	const skillCall = (role, skill, brief = null) =>
		claudeToolBlockReason({ role, toolName: "Skill", toolInput: { skill }, brief });

	assert.ok(claudeBaseTools("peer").includes("Skill"), "the tool stays available");
	assert.ok(!claudeDisallowedTools("peer").includes("Skill"));

	assert.equal(skillCall("lead", "paseo-team-lead"), null);
	assert.match(String(skillCall("peer", "paseo-team-lead")), /not admitted for the peer/);
	assert.match(
		String(skillCall("supervisor", "paseo-team-lead")),
		/not admitted for the supervisor/,
	);

	// The user's own skills are untouched, and so is a call whose name we
	// cannot read — see the leniency note on skillBlockReason.
	assert.equal(skillCall("peer", "anthropic-skills:pdf"), null);
	assert.equal(
		claudeToolBlockReason({ role: "peer", toolName: "Skill", toolInput: {}, brief: null }),
		null,
	);
	assert.equal(
		claudeToolBlockReason({ role: "peer", toolName: "Skill", toolInput: null, brief: null }),
		null,
	);

	// The reviewer harness follows the brief, exactly as on Pi.
	const reviewerBrief = brief([
		"PASEO_TEAM_TASK_V3_BEGIN",
		"TASK_ID: T-900",
		"MODE: read-only",
		"DISPOSITION: independent-reviewer",
		"PASEO_TEAM_TASK_V3_END",
	]);
	assert.equal(skillCall("peer", "paseo-ocr-reviewer", reviewerBrief), null);
	assert.match(String(skillCall("peer", "paseo-ocr-reviewer", readOnlyBrief)), /reviewer/i);
	assert.match(String(skillCall("lead", "paseo-ocr-reviewer")), /Reviewer Peer/);

	// Same verdict on both runtimes, for every role and both pack skills. This
	// is the asymmetry guard the shared core exists for.
	for (const role of ["lead", "peer", "supervisor"]) {
		for (const skill of ["paseo-team-lead", "paseo-ocr-reviewer"]) {
			assert.equal(
				skillCall(role, skill, reviewerBrief),
				skillBlockReason(role, skill, reviewerBrief),
				`${role} + ${skill} must resolve identically on both runtimes`,
			);
		}
	}

	// The OTHER door, and the one that makes the first mean anything: pi has no
	// `Skill` tool and gates the READ of the installed SKILL.md, so a Claude Peer
	// refused Skill(paseo-team-lead) must not simply Read the same bytes. That is
	// the cross-runtime asymmetry the shared table exists to prevent.
	const readCall = (role, file_path, toolName = "Read") =>
		claudeToolBlockReason({ role, toolName, toolInput: { file_path }, brief: null });
	const installed = `${homedir()}/.claude/skills/paseo-team-lead/SKILL.md`;

	assert.match(String(readCall("peer", installed)), /not admitted for the peer/);
	assert.match(String(readCall("supervisor", installed)), /not admitted/);
	assert.equal(readCall("lead", installed), null, "the Lead's own procedure stays readable");
	assert.match(
		String(readCall("peer", `${homedir()}/.pi/agent/skills/paseo-team-lead/SKILL.md`)),
		/not admitted/,
		"the pi install location is gated on Claude too — one machine, both copies",
	);
	// Glob/Grep carry a `path` rather than a `file_path`.
	assert.match(
		String(
			claudeToolBlockReason({
				role: "peer",
				toolName: "Grep",
				toolInput: { pattern: "x", path: installed },
				brief: null,
			}),
		),
		/not admitted/,
	);
	// A repository checkout of the same file is ordinary work — this repo is one,
	// and a Peer assigned to edit the Lead skill has to be able to read it.
	assert.equal(readCall("peer", `${process.cwd()}/skills/paseo-team-lead/SKILL.md`), null);
	assert.equal(readCall("peer", "skills/paseo-team-lead/SKILL.md"), null);
	// Everything else a seat reads is untouched.
	assert.equal(readCall("peer", `${homedir()}/.claude/skills/my-own-skill/SKILL.md`), null);
	assert.equal(readCall("peer", "README.md"), null);
	assert.equal(claudeReadPath({ path: "a" }), "a");
	assert.equal(claudeReadPath({ file_path: "a", path: "b" }), "a");
	assert.equal(claudeReadPath("nope"), "");

	// The field the name is read from, and the wrapper spellings.
	assert.equal(claudeSkillName({ skill: "a" }), "a");
	assert.equal(claudeSkillName({ name: "b" }), "b");
	assert.equal(claudeSkillName({ skill_name: "c" }), "c");
	assert.equal(claudeSkillName({ skill: "   " }), "");
	assert.equal(claudeSkillName("paseo-team-lead"), "");
}

console.log("claude policy tests passed");
