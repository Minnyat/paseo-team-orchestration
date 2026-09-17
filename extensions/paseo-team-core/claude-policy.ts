/**
 * claude-policy.ts — Claude Code dialect of the Paseo team role policy.
 *
 * Same three roles, same fail-closed invariants, different runtime surface.
 * Every RULE is imported from ./policy-core.ts; this module only translates
 * between Claude's tool vocabulary and the core's decisions:
 *
 *   Pi                        Claude Code
 *   ------------------------  ---------------------------------------------
 *   read / write / edit       Read,Glob,Grep / Write / Edit,NotebookEdit
 *   bash                      Bash (+ BashOutput, KillShell)
 *   mcp({tool,args}) proxy    mcp__paseo__<tool>, args ARE the tool input
 *   setActiveTools()          provider disallowedTools + PreToolUse deny
 *   tool_call block           PreToolUse permissionDecision: "deny"
 *
 * Layering, mirroring the Pi adapter's allowlist + backstop:
 *   1. STATIC — claudeDisallowedTools(role) goes into the Paseo provider
 *      override so the model never sees the tool at all;
 *   2. DYNAMIC — claudeToolBlockReason() runs per call in the PreToolUse hook,
 *      because peer write/browser/git authority is a property of the CURRENT
 *      V3 brief and cannot be expressed in static config.
 *
 * Unknown tools are DENIED for every role (allowlist, not blocklist): a new
 * Claude tool must be classified deliberately, never inherited silently.
 */

import {
	ALL_PASEO_TOOLS,
	callsPaseoCli,
	clusterLabelBlockReason,
	createAgentModeArgsBlockReason,
	leaseBlockReason,
	sendAgentPromptBlockReason,
	sendAgentPromptTargetId,
	teamLeaseToolBlockReason,
	type AgentOwnership,
	type LeaseHolder,
	type TeamTopology,
	supportScriptBlockReason,
	writerScopeFromCreateAgent,
	extraTools,
	gitAuthorityBlockReason,
	isBrowserMcpTarget,
	isPaseoBrowserTool,
	leadCreateWorkspaceArgsBlockReason,
	leadWriteEnabled,
	matchesPaseoToolName,
	mcpAllowedTargets,
	peerAuthority,
	peerGitAuthority,
	packSkillFromPath,
	resolvePeerMode,
	skillBlockReason,
	leadCreateSupervisorArgsBlockReason,
	supervisorCreateAgentArgsBlockReason,
	teamToolBlockReason,
	LEAD_CONSULT_TOOL,
	PEER_COMMUNICATION_TOOL,
	SUPERVISOR_ALLOWED_MCP_TARGETS,
	TEAM_WATCHDOG_TOOL,
	type ParsedTaskBrief,
	type TeamRole,
} from "./policy-core.ts";

/** Paseo injects its own MCP server under exactly this name (daemon-side). */
export const PASEO_MCP_SERVER = "paseo";
/** The pack's own stdio MCP server: peer_ask_lead + team_watchdog. */
export const TEAM_MCP_SERVER = "paseo-team";

export type ClaudeToolKind =
	| "read"
	| "write"
	| "edit"
	| "bash"
	| "subagent"
	| "paseo-mcp"
	| "browser-mcp"
	| "team"
	| "other-mcp"
	| "other";

export interface ClaudeToolClass {
	kind: ClaudeToolKind;
	/** For MCP tools: the name with the mcp__<server>__ prefix stripped. */
	target?: string;
}

const CLAUDE_READ_TOOLS = ["Read", "Glob", "Grep", "NotebookRead"];
const CLAUDE_WRITE_TOOLS = ["Write"];
const CLAUDE_EDIT_TOOLS = ["Edit", "MultiEdit", "NotebookEdit"];
const CLAUDE_BASH_TOOLS = ["Bash", "BashOutput", "KillShell"];
const CLAUDE_SUBAGENT_TOOLS = ["Task", "Agent"];

/**
 * Session-local tools with no filesystem, network or orchestration reach.
 * Allowed for every role so the agent can still plan, ask, and run the pack's
 * own skills.
 */
const CLAUDE_NEUTRAL_TOOLS = [
	"TodoWrite",
	"ExitPlanMode",
	"Skill",
	// ToolSearch only loads the SCHEMA of a deferred tool; every actual call
	// still passes this policy. Live verification showed a Lead blocked here
	// while trying to reach Paseo tools it was allowed to use — denying schema
	// lookup buys no safety and costs the role its own surface.
	"ToolSearch",
];

/**
 * The structured "stop and ask the human" tool.
 *
 * Only the Supervisor may reach the Human that way. The escalation chain is
 * Peer -> Lead (`peer_ask_lead`) -> Supervisor (`lead_ask_supervisor`) ->
 * Human, and the role prompts already say so — but a tool the model can still
 * call is the door it will use under pressure, which is how a delegated
 * decision ends up back on the Human's desk. Pi never exposed an ask-the-user
 * tool to any role, so leaving this one open to Lead and Peer was also a
 * cross-runtime authority asymmetry, the one thing the shared core exists to
 * prevent.
 *
 * This removes the structured interrupt, not the ability to speak: a Lead's
 * own turn output still reaches the Human it is talking to, which is the right
 * channel for the irreversible actions lead.md reserves for them.
 */
const CLAUDE_HUMAN_QUESTION_TOOL = "AskUserQuestion";

/** The skill loader. Allowed for every role; the PACKAGE is what gets gated. */
const CLAUDE_SKILL_TOOL = "Skill";

/**
 * The path out of a Read/Glob/Grep call. Claude spells it `file_path`; the
 * others carry a `path`, and either can name a file inside an installed skill
 * package.
 *
 * Like the bash guards further down, this closes the obvious door rather than
 * drawing an authorization boundary: a Grep scoped to the package DIRECTORY
 * still runs, and reassembling a 50 KB procedure out of match output is a
 * possible but self-defeating way to spend a turn. The boundary that matters
 * is the tool policy, which already denies the wrong role everything the
 * procedure would tell it to do.
 */
export function claudeReadPath(toolInput: unknown): string {
	if (typeof toolInput !== "object" || toolInput === null) return "";
	const args = toolInput as Record<string, unknown>;
	for (const key of ["file_path", "path", "notebook_path"]) {
		const value = args[key];
		if (typeof value === "string" && value.trim() !== "") return value;
	}
	return "";
}

/**
 * The package name out of a `Skill` call.
 *
 * `skill` is the documented field; `name` and `skill_name` are accepted because
 * an unreadable name is treated as "not ours" and allowed (see
 * skillBlockReason), so the cost of a field rename landing here is a gate that
 * quietly stops gating — the failure a couple of extra keys buys off cheaply.
 */
export function claudeSkillName(toolInput: unknown): string {
	if (typeof toolInput !== "object" || toolInput === null) return "";
	const args = toolInput as Record<string, unknown>;
	for (const key of ["skill", "name", "skill_name"]) {
		const value = args[key];
		if (typeof value === "string" && value.trim() !== "") return value;
	}
	return "";
}

export function classifyClaudeTool(name: string): ClaudeToolClass {
	const tool = name.trim();
	if (tool.startsWith("mcp__")) {
		const rest = tool.slice("mcp__".length);
		const separator = rest.indexOf("__");
		const server = separator < 0 ? rest : rest.slice(0, separator);
		const target = separator < 0 ? "" : rest.slice(separator + 2);
		// Claude in Chrome — the runtime's own browser, and the one a Claude seat
		// should reach for first.
		if (isBrowserMcpTarget(tool)) return { kind: "browser-mcp", target };
		// Paseo registers Browser Control on its own MCP server, alongside
		// create_agent. Classify by tool family, not by server, or every role's
		// browser surface disappears behind the orchestration wall.
		if (server === PASEO_MCP_SERVER && isPaseoBrowserTool(target)) {
			return { kind: "browser-mcp", target };
		}
		if (server === PASEO_MCP_SERVER) return { kind: "paseo-mcp", target };
		if (server === TEAM_MCP_SERVER) return { kind: "team", target };
		return { kind: "other-mcp", target };
	}
	if (
		tool === PEER_COMMUNICATION_TOOL ||
		tool === TEAM_WATCHDOG_TOOL ||
		tool === LEAD_CONSULT_TOOL
	) {
		return { kind: "team", target: tool };
	}
	if (CLAUDE_READ_TOOLS.includes(tool)) return { kind: "read" };
	if (CLAUDE_WRITE_TOOLS.includes(tool)) return { kind: "write" };
	if (CLAUDE_EDIT_TOOLS.includes(tool)) return { kind: "edit" };
	if (CLAUDE_BASH_TOOLS.includes(tool)) return { kind: "bash" };
	if (CLAUDE_SUBAGENT_TOOLS.includes(tool)) return { kind: "subagent" };
	return { kind: "other" };
}

/** Bare (unprefixed) team tool name for a possibly mcp__-prefixed call. */
export function teamToolName(toolName: string): string {
	const classified = classifyClaudeTool(toolName);
	return classified.kind === "team" && classified.target
		? classified.target
		: toolName;
}

/**
 * Non-MCP Claude tools a role may use at all. Write/edit tools appear for the
 * Peer because a write-mode brief needs them; whether THIS turn may use them
 * is decided per call in claudeToolBlockReason.
 */
export function claudeBaseTools(role: TeamRole): string[] {
	switch (role) {
		case "supervisor":
			return [
				...CLAUDE_READ_TOOLS,
				...CLAUDE_NEUTRAL_TOOLS,
				// The Supervisor is the only seat whose escalation target IS the
				// Human; see CLAUDE_HUMAN_QUESTION_TOOL.
				CLAUDE_HUMAN_QUESTION_TOOL,
			];
		case "lead":
			return [
				...CLAUDE_READ_TOOLS,
				...CLAUDE_BASH_TOOLS,
				...CLAUDE_NEUTRAL_TOOLS,
				...(leadWriteEnabled()
					? [...CLAUDE_WRITE_TOOLS, ...CLAUDE_EDIT_TOOLS]
					: []),
			];
		case "peer":
			return [
				...CLAUDE_READ_TOOLS,
				...CLAUDE_BASH_TOOLS,
				...CLAUDE_NEUTRAL_TOOLS,
				...CLAUDE_WRITE_TOOLS,
				...CLAUDE_EDIT_TOOLS,
			];
	}
}

/**
 * Well-known Claude tools stripped from the provider itself.
 *
 * This is the STATIC layer: it removes tools the role can never use under any
 * brief, so they never reach the model. Peer write/edit tools are deliberately
 * absent here — their availability depends on the per-turn brief and is
 * enforced by the hook instead.
 */
const CLAUDE_KNOWN_TOOLS = [
	...CLAUDE_READ_TOOLS,
	...CLAUDE_WRITE_TOOLS,
	...CLAUDE_EDIT_TOOLS,
	...CLAUDE_BASH_TOOLS,
	...CLAUDE_SUBAGENT_TOOLS,
	...CLAUDE_NEUTRAL_TOOLS,
	CLAUDE_HUMAN_QUESTION_TOOL,
	"WebFetch",
	"WebSearch",
];

export function claudeDisallowedTools(role: TeamRole): string[] {
	const allowed = new Set([...claudeBaseTools(role), ...extraTools()]);
	return [...new Set(CLAUDE_KNOWN_TOOLS.filter((tool) => !allowed.has(tool)))];
}

export interface ClaudeToolDecisionInput {
	role: TeamRole;
	toolName: string;
	toolInput?: unknown;
	brief: ParsedTaskBrief | null;
	/** Live scope leases, resolved by policy-core. Required only when the call
	 *  staffs a writer; null means the ledger could not be read (fail-closed). */
	leases?: Map<string, LeaseHolder> | null;
	/** This agent's own Paseo id, to match against the lease holder. */
	selfAgentId?: string | null;
	/** PR-D governance. Defaults keep the single-supervisor behaviour exactly. */
	topology?: TeamTopology;
	/** This seat's own `team.domain`, for the lead-recovery jurisdiction gate. */
	selfDomain?: string | null;
	/** Ownership of a send_agent_prompt target, resolved by the hook. Undefined
	 *  means "not needed"; null means "could not be resolved" (fail-closed). */
	promptTarget?: AgentOwnership | null;
	/** This seat's own cluster, resolved by the hook; see selfCluster. Scopes the
	 *  lease board and the coordinator-to-coordinator prompt rule to one
	 *  workspace. Undefined leaves both exactly as they were. */
	cluster?: string | null;
}

function bashCommand(toolInput: unknown): string {
	if (typeof toolInput !== "object" || toolInput === null) return "";
	const command = (toolInput as Record<string, unknown>).command;
	return typeof command === "string" ? command : "";
}

/**
 * The single decision point for a Claude tool call. Returns a deny reason, or
 * null when the call is allowed. Fail-closed on every axis: unknown tool,
 * unknown MCP server, missing brief and unclassifiable arguments all deny.
 */
export function claudeToolBlockReason(
	input: ClaudeToolDecisionInput,
): string | null {
	const { role, toolName, brief } = input;
	const classified = classifyClaudeTool(toolName);
	const allowedExtra = new Set(extraTools());
	const authority = peerAuthority(brief);
	const peerMode = resolvePeerMode(brief);

	// Checked before the generic allowlist so the seat gets the route to take,
	// not a bare "blocked by the role policy" it cannot act on.
	if (toolName === CLAUDE_HUMAN_QUESTION_TOOL && role !== "supervisor") {
		return role === "lead"
			? "A Lead does not put questions to the Human directly — the Supervisor decides them. Call lead_ask_supervisor with the question, the options and your recommendation. Reach the Human yourself only for something irreversible (merge, deploy, delete, external comms, spend), when the Supervisor answered HUMAN_DECISION_REQUIRED: yes, or when the consult reported NO_SUPERVISOR_SEAT — and then say in your own reply which of those it was, rather than opening a question box."
			: "A Peer does not put questions to the Human. Send the question to your own Lead with peer_ask_lead (KIND: question | dependency | blocker); the Lead answers it or escalates to the Supervisor.";
	}

	// Skill admission, both doors.
	//
	// `Skill` stays in CLAUDE_NEUTRAL_TOOLS — the tool itself is harmless and the
	// user's own skills go through it — so the gate is per call, on the package
	// name, using the same table the Pi adapter reads.
	//
	// The second door is the one that makes the first mean anything. pi has no
	// `skill` tool at all: its agent loads a skill by READING the SKILL.md, which
	// is why the Pi adapter gates the read path. Claude has both, so a Peer
	// refused `Skill(paseo-team-lead)` could otherwise just
	// `Read ~/.claude/skills/paseo-team-lead/SKILL.md` and get the same bytes —
	// a rule denied on one runtime and reachable on the other, which is the exact
	// asymmetry the shared core exists to prevent.
	if (toolName === CLAUDE_SKILL_TOOL) {
		const reason = skillBlockReason(role, claudeSkillName(input.toolInput), brief);
		if (reason) return reason;
	}
	if (classified.kind === "read") {
		const skill = packSkillFromPath(claudeReadPath(input.toolInput));
		const reason = skill && skillBlockReason(role, skill, brief);
		if (reason) return reason;
	}

	if (classified.kind === "team") {
		const named = teamToolName(toolName);
		const coarse = teamToolBlockReason(role, named, brief);
		if (coarse) return coarse;
		// The per-action gate needs the arguments, which the coarse name-only
		// check never sees. Without this a Claude Supervisor could claim and
		// release scopes that a Pi Supervisor is refused — an authority
		// asymmetry, which is the one thing the shared core exists to prevent.
		return teamLeaseToolBlockReason(
			role,
			(input.toolInput as Record<string, unknown> | undefined)?.action,
			named,
		);
	}

	// Same scope-lease rule the Pi extension applies. The ledger cannot be read
	// from a synchronous guard, so the hook fetches it and hands it in; an
	// absent `leases` when one is actually needed is treated as unreadable,
	// which is fail-closed rather than a silent allow.
	if (
		role === "lead" &&
		classified.kind === "paseo-mcp" &&
		// Both calls can deliver the brief that arms a writer.
		matchesPaseoToolName(classified.target ?? "", ["create_agent", "send_agent_prompt"]) &&
		writerScopeFromCreateAgent(input.toolInput)
	) {
		const leaseReason = leaseBlockReason({
			role,
			args: input.toolInput,
			leases: input.leases ?? null,
			selfAgentId: input.selfAgentId ?? null,
			cluster: input.cluster,
		});
		if (leaseReason) return leaseReason;
	}

	if (classified.kind === "paseo-mcp") {
		const target = classified.target ?? "";
		if (role === "peer") {
			return "Peer cannot orchestrate agents or manage workspaces. Report a DEPENDENCY_REQUEST to the Lead instead.";
		}
		if (!matchesPaseoToolName(target, mcpAllowedTargets(role))) {
			return role === "supervisor"
				? `Supervisor may only call monitoring tools through MCP (${SUPERVISOR_ALLOWED_MCP_TARGETS.join(", ")}) plus a gated lead-recovery create_agent. "${target}" is blocked — send an observation to the Lead instead.`
				: `"${target}" is not in the ${role} MCP allowlist (discovery, workspace, monitoring, orchestration, permissions).`;
		}
		if (matchesPaseoToolName(target, ["create_agent"]) && (role === "lead" || role === "supervisor")) {
			// Same cluster check the Pi adapter runs through mcpBlockReason, in the
			// same order (before the supervisor-specific argument gate below): a
			// call blocked on one runtime must be blocked on the other, or a
			// Claude-hosted seat is the quiet way around it.
			const clusterBlock = clusterLabelBlockReason({
				role,
				args: input.toolInput,
				cluster: input.cluster,
			});
			if (clusterBlock) return clusterBlock;
		}
		if (role === "supervisor" && matchesPaseoToolName(target, ["create_agent"])) {
			// Captured rather than returned: the mode gate below runs for a
			// Supervisor's lead-recovery create_agent too, exactly as it does on
			// the Pi adapter, and an early return here would skip it.
			const argBlock = supervisorCreateAgentArgsBlockReason(input.toolInput, {
				topology: input.topology ?? "single",
				selfDomain: input.selfDomain ?? null,
			});
			if (argBlock) return argBlock;
		}
		if (role === "lead" && matchesPaseoToolName(target, ["create_agent"])) {
			// A Lead seating its own governance seat (PR-H), gated in the same
			// order as the Pi adapter runs it. Returns null for every create_agent
			// whose provider is not a supervisor one, so the lease gate above and
			// the ordinary Peer path are untouched.
			const supervisorSeatBlock = leadCreateSupervisorArgsBlockReason(input.toolInput, {
				topology: input.topology ?? "single",
				selfDomain: input.selfDomain ?? null,
			});
			if (supervisorSeatBlock) return supervisorSeatBlock;
		}
		if (matchesPaseoToolName(target, ["create_agent"]) && (role === "lead" || role === "supervisor")) {
			// Same mode gate the Pi adapter runs through mcpBlockReason, in the
			// same position (last of the create_agent gates). A seat created
			// without settings.modeId comes up on "default" whichever runtime
			// created it, so a Claude-hosted Lead must not be the quiet way to a
			// seat that parks every tool call it makes.
			const modeBlock = createAgentModeArgsBlockReason(input.toolInput);
			if (modeBlock) return modeBlock;
		}
		if (role === "lead" && matchesPaseoToolName(target, ["create_workspace"])) {
			return leadCreateWorkspaceArgsBlockReason(input.toolInput);
		}
		// Same ownership wall the Pi adapter puts in front of send_agent_prompt:
		// a Lead that can prompt another Lead's Peer bypasses that Lead's brief,
		// its authority accounting and its scope lease.
		if (matchesPaseoToolName(target, ["send_agent_prompt"])) {
			return sendAgentPromptBlockReason({
				role,
				selfAgentId: input.selfAgentId ?? null,
				targetId: sendAgentPromptTargetId(input.toolInput),
				target: input.promptTarget ?? null,
				topology: input.topology ?? "single",
				cluster: input.cluster,
			});
		}
		return null;
	}

	if (classified.kind === "browser-mcp") {
		if (role === "lead") return null;
		if (role !== "peer") {
			return "Supervisor has no browser authority. Send an observation to the Lead instead.";
		}
		return authority.browserMcp
			? null
			: "This Peer's brief sets BROWSER_MCP_AUTHORITY: denied, so the browser is withheld for this turn. Report a DEPENDENCY_REQUEST to the Lead if the task needs it.";
	}

	if (classified.kind === "other-mcp") {
		return allowedExtra.has(toolName)
			? null
			: `MCP tool "${toolName}" is outside the ${role} role surface (in scope: the paseo and paseo-team servers, plus the browser — Paseo Browser Control and Claude in Chrome).`;
	}

	if (classified.kind === "subagent") {
		return "Claude subagents are denied for every team role: work spawned outside Paseo carries no role prompt, no brief authority and no place in the team graph. Ask the Lead to create a Paseo agent instead.";
	}

	// Write/edit is decided BEFORE the generic allowlist so the agent gets the
	// actionable reason ("send an observation", "report AUTHORITY_MISMATCH")
	// rather than a bare "blocked by the role policy".
	if (classified.kind === "write" || classified.kind === "edit") {
		if (role === "supervisor") {
			return "Supervisor cannot modify product code. Send an observation to the Lead instead.";
		}
		if (role === "peer") {
			if (peerMode !== "write") {
				return "This Peer session is read-only (MODE: read-only). Propose the change in your report instead of editing files.";
			}
			if (!authority.edit) {
				return "EDIT_AUTHORITY is denied for this task even though MODE is write. Report AUTHORITY_MISMATCH to the Lead.";
			}
		}
	}

	const base = new Set([...claudeBaseTools(role), ...allowedExtra]);
	if (!base.has(toolName)) {
		return `Tool "${toolName}" is blocked by the ${role} role policy.`;
	}

	if (classified.kind === "write" || classified.kind === "edit") return null;

	if (classified.kind === "bash" && role === "peer") {
		const command = bashCommand(input.toolInput);
		if (callsPaseoCli(command)) {
			return "Peer cannot drive the Paseo CLI from bash (would bypass the tool policy). Report a DEPENDENCY_REQUEST to the Lead instead.";
		}
		// There is deliberately no browser-CLI guard here any more. It existed for
		// the agent-browser npm package, which the pack no longer installs;
		// neither browser that replaced it has a CLI to shell out to (Paseo's is
		// an MCP surface over the daemon's broker, Claude's runs through the
		// Chrome extension), so the typed check above is the whole surface.
		const supportScriptReason = supportScriptBlockReason(role, command);
		if (supportScriptReason) return supportScriptReason;
		return gitAuthorityBlockReason(
			command,
			peerGitAuthority(brief),
			brief?.fields.get("TASK_ID"),
		);
	}

	return null;
}

/**
 * Diagnostic view of the effective surface for a turn — the Claude equivalent
 * of Pi's `/team-role`.
 */
export function describeClaudePolicy(
	role: TeamRole,
	brief: ParsedTaskBrief | null,
): string {
	const authority = peerAuthority(brief);
	return [
		`role=${role}`,
		`peerMode=${resolvePeerMode(brief)}`,
		brief
			? `brief=V${brief.version}${brief.malformed.length ? ` malformed=[${brief.malformed.join("; ")}]` : ""}`
			: "brief=none",
		`edit=${authority.edit}`,
		`browserMcp=${authority.browserMcp}`,
		`commit=${authority.commit}`,
		`pushTaskBranch=${authority.pushTaskBranch}`,
		`paseoMcp=[${mcpAllowedTargets(role).join(", ") || "none"}]`,
		`disallowed=[${claudeDisallowedTools(role).join(", ")}]`,
	].join(" ");
}

/** Paseo orchestration tool names as Claude sees them. */
export const CLAUDE_PASEO_TOOL_NAMES: string[] = ALL_PASEO_TOOLS.map(
	(tool) => `mcp__${PASEO_MCP_SERVER}__${tool}`,
);
