/**
 * paseo-team-policy.ts — Pi adapter for the Paseo team role pack.
 *
 * Reads PASEO_PI_ROLE (supervisor | lead | peer) from the environment and:
 *   - injects the role prompt (prompts/<role>.md) into the system prompt;
 *   - applies a per-role tool allowlist via setActiveTools();
 *   - blocks policy-violating tool calls as a backstop via tool_call.
 *
 * Every RULE lives in ./paseo-team-core/policy-core.ts, which knows nothing about Pi; this
 * file only binds those rules to Pi's extension API and re-exports the core so
 * existing importers (tests, tooling) keep one entry point. The Claude Code
 * adapter binds the SAME core through settings hooks — see
 * ./paseo-team-core/claude-policy.ts and scripts/claude-hook.mjs.
 *
 * When PASEO_PI_ROLE is unset the extension stays passive: no prompt
 * injection, no tool restriction. Safe to install globally.
 *
 * Fail-closed invariants (Phase 3):
 *   - Peer write authority is derived from the *current prompt's* strict
 *     V3 task brief (PASEO_TEAM_TASK_V3_BEGIN/END marker block) on every
 *     before_agent_start. Legacy V1/V2 briefs are parseable for diagnostics
 *     but NEVER grant write mode or git authority (their whole-prompt scan
 *     was an injection surface). A turn without a valid V3 brief is
 *     read-only — write mode never leaks across turns.
 *   - Peer git authority (commit/push) comes from V3 authority fields and
 *     is denied by default; force-push and merge are always denied, and
 *     granted push authority is branch-scoped to agent/<TASK_ID>.
 *   - Supervisor and Lead MCP proxy calls are checked against a fail-closed
 *     target allowlist. Anything that cannot be classified (missing or
 *     non-string tool target, unknown input shape) is blocked.
 *
 * Prompts are resolved from $PASEO_TEAM_PROMPTS_DIR or, by default, from a
 * `prompts/` directory next to this file (the installer copies them there).
 * Extra per-profile tools can be added via $PASEO_TEAM_EXTRA_TOOLS="a,b".
 * Lead gets write/edit tools only when $PASEO_TEAM_LEAD_WRITE=1 (documented
 * opt-in; orchestration work does not need them).
 */

import {
	isToolCallEventType,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
	ALL_PASEO_TOOLS,
	browserMcpAllowed,
	callsPaseoCli,
	denyReason,
	detectRole,
	extraTools,
	gitAuthorityBlockReason,
	isBrowserMcpTarget,
	loadRolePrompt,
	mcpBlockReason,
	mcpScriptBlockReason,
	parseTaskBrief,
	peerGitAuthority,
	peerMcpBlockReason,
	policyWithAuthority,
	packSkillFromPath,
	resolvePeerMode,
	skillBlockReason,
	teamToolBlockReason,
	PEER_COMMUNICATION_TOOL,
	TEAM_WATCHDOG_TOOL,
	TEAM_LEASE_TOOL,
	TEAM_FORK_TOOL,
	LEAD_CONSULT_TOOL,
	LEAD_CONSULT_KINDS,
	leadAskSupervisorToolDescription,
	leadConsultAttribution,
	leadConsultToolBlockReason,
	leadConsultTurnNotice,
	leadConsultVerdict,
	parseLeadConsultBlock,
	FORK_REASONS,
	teamForkToolBlockReason,
	teamForkToolDescription,
	teamLeaseToolBlockReason,
	teamLeaseToolDescription,
	agentOwnership,
	classifyMcpInput,
	leaseBlockReason,
	matchesPaseoToolName,
	parsePeerBlock,
	parseSupervisorBlock,
	peerMessageTurnNotice,
	resolveLeases,
	selfCluster,
	sendAgentPromptTargetId,
	supervisorAttribution,
	supervisorSeats,
	supervisorTurnNotice,
	supervisorTurnVerdict,
	teamTopology,
	type GovernanceContext,
	type SupervisorSeat,
	supportScriptBlockReason,
	writerScopeFromCreateAgent,
	type ParsedTaskBrief,
	type PeerMode,
	type Policy,
	type TeamRole,
} from "./paseo-team-core/policy-core.ts";

/**
 * Re-export the whole core so `paseo-team-policy.ts` stays the single import
 * surface for tests and tooling that predate the core split.
 */
export * from "./paseo-team-core/policy-core.ts";

function supportScriptPath(name: string): string {
	const configured = process.env.PASEO_TEAM_SCRIPTS_DIR?.trim();
	const candidates = configured
		? [join(configured, name)]
		: [
				join(dirname(fileURLToPath(import.meta.url)), "paseo-team-scripts", name),
				join(dirname(fileURLToPath(import.meta.url)), "../scripts", name),
			];
		const found = candidates.find((candidate) => existsSync(candidate));
	if (!found) throw new Error(`Paseo team support script is missing: ${name}`);
	return found;
}

function runSupportScript(name: string, args: string[], signal?: AbortSignal, timeoutMs = 30_000): Promise<{ stdout: string; stderr: string; code: number; killed: boolean }> {
	return new Promise((resolve, reject) => {
		execFile(
			process.execPath,
			[supportScriptPath(name), ...args],
			{ encoding: "utf8", timeout: timeoutMs, windowsHide: true, env: process.env, signal },
			(error, stdout, stderr) => {
				if (error && !stdout && !stderr) reject(error);
				else resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), code: error ? 1 : 0, killed: Boolean(error?.killed) });
			},
		);
	});
}

/**
 * The scope-lease gate for a Lead's create_agent.
 *
 * It lives OUTSIDE mcpBlockReason on purpose: that function is pure and both
 * runtimes depend on it staying that way, while this needs to read the ledger
 * room — a ~3s round trip. create_agent is rare enough to afford it, and the
 * alternative is a rule that only the Leads who feel like claiming obey.
 *
 * Everything about the decision is still pure: the ledger is fetched here and
 * arbitrated by policy-core, so the Pi and Claude adapters cannot disagree
 * about who holds a scope.
 */
async function leadWriterLeaseReason(input: unknown): Promise<string | null> {
	const classified = classifyMcpInput(input);
	if (classified.kind !== "target") return null;
	// Both calls can deliver the brief that arms a writer.
	if (!matchesPaseoToolName(classified.target ?? "", ["create_agent", "send_agent_prompt"])) {
		return null;
	}

	const args = extractCreateAgentArgs(input);
	// Nothing to gate unless this call staffs a writer; the core decides that
	// from the same V3 brief the Peer will be held to.
	if (!writerScopeFromCreateAgent(args)) return null;

	let entries: unknown = null;
	try {
		const result = await runSupportScript("team-lease.mjs", ["ledger", "{}"]);
		const parsed = JSON.parse(result.stdout || "{}");
		entries = parsed?.ok ? parsed.entries : null;
	} catch {
		// Leave entries null — the guard is fail-closed by design, and the reason
		// it returns says so in words the Lead can act on.
		entries = null;
	}

	return leaseBlockReason({
		role: "lead",
		args,
		leases: entries ? resolveLeases(entries, { now: Date.now() }) : null,
		selfAgentId: process.env.PASEO_AGENT_ID?.trim() || null,
		// A scope is repo-relative, so the board has to be read against THIS
		// project's leases, not against every project on the host.
		cluster: selfCluster(),
	});
}

/**
 * The governance facts a tool call is judged against (PR-D).
 *
 * Resolved HERE rather than inside the core so the decision itself stays pure
 * and testable, and resolved the same way in the Claude adapter so a Lead on
 * one runtime cannot reach further than a Lead on the other. Every lookup is a
 * local read of Paseo's own agent state (§1.4) — no daemon round trip, so it
 * is affordable on the tool-call path.
 */
function governanceContext(input: unknown, role: TeamRole): GovernanceContext {
	const topology = teamTopology();
	const context: GovernanceContext = {
		topology,
		selfAgentId: process.env.PASEO_AGENT_ID?.trim() || null,
		selfDomain: process.env.PASEO_TEAM_DOMAIN?.trim() || null,
		cluster: selfCluster(),
	};
	// The target lookup is driven by the TOOL, not by the topology.
	//
	// It used to return early here for a Lead under `single`, on the reasoning
	// that the ownership guard was off for that seat anyway. Two of the rules it
	// feeds are not ownership rules and are live on every topology — "a
	// Supervisor does not task a Peer", and "no seat reaches into another
	// cluster" — so the early return silently disarmed the cluster guard for a
	// Lead in the DEFAULT pack: the core was asked to judge a target it was
	// never given, and `sendAgentPromptBlockReason` cannot refuse a target it
	// cannot see. The cost is one local state-file read on `send_agent_prompt`
	// calls only; every other tool still returns without touching the disk.
	const classified = classifyMcpInput(input);
	const isPrompt =
		classified.kind === "target" &&
		matchesPaseoToolName(classified.target ?? "", ["send_agent_prompt"]);
	if (!isPrompt) return context;
	context.promptTarget = agentOwnership(sendAgentPromptTargetId(input));
	return context;
}

/**
 * A Lead's turn may open with a supervisor observation or decision. The Lead
 * cannot tell by reading it whether that Supervisor governs this seat, nor
 * whether the seat it names is a Supervisor at all, so the verdict is computed
 * and pushed into the turn's system prompt. It is context, not a block: nothing
 * here denies a tool, it tells the Lead which authority the message does and
 * does not carry — and, on the accepting path, that acting on it needs no Human
 * round-trip.
 *
 * Computed on EVERY topology. It used to return early under `single`, which is
 * the default pack: the one-Supervisor cluster got no verdict, no attribution
 * and no directive, so a delegated decision reached the Lead as bare prose.
 */
function supervisorNotice(prompt: string): string | null {
	const block = parseSupervisorBlock(prompt);
	if (!block) return null;
	const topology = teamTopology();
	const cluster = selfCluster();
	let seats: SupervisorSeat[] = [];
	// Only the overlap rule needs the full seat list, and only under `multi`.
	// Reading every agent state on a `single` cluster would be a per-turn cost
	// for an answer nothing consults.
	if (topology === "multi") {
		try {
			// Scoped: a Supervisor in another project is not a claimant on this
			// Lead, and counting it turned a shared label like `backend` into a
			// fail-closed JURISDICTION_OVERLAP on a one-Supervisor cluster.
			seats = supervisorSeats(process.env, { cluster });
		} catch {
			seats = [];
		}
	}
	const attribution = supervisorAttribution(
		block.fields.get("FROM_AGENT_ID") ?? null,
	);
	const verdict = supervisorTurnVerdict({
		block,
		leadDomain: process.env.PASEO_TEAM_DOMAIN?.trim() || null,
		supervisors: seats,
		attribution,
		topology,
		leadCluster: cluster,
	});
	return supervisorTurnNotice({ block, verdict, attribution });
}

/**
 * The Supervisor's half of the same idea (PR-H).
 *
 * `supervisorNotice` above tells a Lead what a supervisor message obliges it to
 * do. This tells a Supervisor what a LEAD_CONSULT obliges it to do — and the
 * obligation is the load-bearing part. A Supervisor that reads a consult as
 * ordinary prose answers it with a recommendation, or with nothing, and either
 * way the Lead is left holding a question it must then take to the Human. Which
 * is the exact behaviour the consult channel exists to remove.
 */
function leadConsultNotice(prompt: string): string | null {
	const block = parseLeadConsultBlock(prompt);
	if (!block) return null;
	const attribution = leadConsultAttribution(
		block.fields.get("FROM_AGENT_ID") ?? null,
	);
	const verdict = leadConsultVerdict({
		block,
		attribution,
		supervisorDomain: process.env.PASEO_TEAM_DOMAIN?.trim() || null,
		supervisorCluster: selfCluster(),
		topology: teamTopology(),
	});
	return leadConsultTurnNotice({ block, verdict, attribution });
}

/**
 * The third cross-role channel, on the Lead's side.
 *
 * `supervisorNotice` and `leadConsultNotice` above each tell their receiver
 * what an incoming block obliges it to do. A PEER_MESSAGE_V1 had no such
 * function, so a Peer's report arrived as prose in the middle of a Lead's turn
 * and competed with the Human for attention on equal terms.
 */
function peerNotice(prompt: string): string | null {
	return peerMessageTurnNotice({ block: parsePeerBlock(prompt) });
}

function extractCreateAgentArgs(input: unknown): unknown {
	if (!input || typeof input !== "object") return null;
	const args = (input as Record<string, unknown>).args;
	if (typeof args === "string") {
		try {
			return JSON.parse(args);
		} catch {
			return null;
		}
	}
	return args ?? null;
}

function registerTeamTools(pi: ExtensionAPI, r: TeamRole): void {
	if (typeof pi.registerTool !== "function") return;
	pi.registerTool({
		name: PEER_COMMUNICATION_TOOL,
		label: "peer_ask_lead",
		description: "Send a question, blocker, dependency request, or progress update to this Peer’s parent Lead only.",
		parameters: {
			type: "object",
			properties: {
				kind: { type: "string", enum: ["question", "blocked", "dependency", "progress", "report"] },
				message: { type: "string", minLength: 1, maxLength: 12000 },
				taskId: { type: "string" },
				correlationId: { type: "string" },
			},
			required: ["kind", "message"],
			additionalProperties: false,
		} as any,
		async execute(_id, params, signal, _onUpdate, _ctx) {
			if (r !== "peer") return { content: [{ type: "text", text: "peer_ask_lead is available only to Peer agents." }], details: undefined, isError: true };
			const result = await runSupportScript("team-communication.mjs", ["ask-lead", JSON.stringify(params)], signal);
			return { content: [{ type: "text", text: result.stdout || result.stderr }], details: undefined, isError: result.code !== 0 };
		},
	});
	pi.registerTool({
		name: LEAD_CONSULT_TOOL,
		label: "lead_ask_supervisor",
		description: leadAskSupervisorToolDescription(),
		parameters: {
			type: "object",
			properties: {
				kind: { type: "string", enum: [...LEAD_CONSULT_KINDS] },
				question: { type: "string", minLength: 1, maxLength: 6000 },
				options: { type: "string", minLength: 1, maxLength: 6000 },
				evidence: { type: "string", minLength: 1, maxLength: 6000 },
				recommendation: { type: "string", maxLength: 6000 },
				scope: { type: "string", minLength: 1, maxLength: 512 },
				reversibility: { type: "string", enum: ["reversible", "irreversible"] },
				taskId: { type: "string", maxLength: 128 },
				projectId: { type: "string", maxLength: 128 },
				correlationId: { type: "string", maxLength: 128 },
				supervisorAgentId: { type: "string", maxLength: 64 },
			},
			required: ["kind", "question", "options", "evidence", "scope", "reversibility"],
			additionalProperties: false,
		} as any,
		async execute(_id, params, signal, _onUpdate, _ctx) {
			const blocked = leadConsultToolBlockReason(r, LEAD_CONSULT_TOOL);
			if (blocked) return { content: [{ type: "text", text: blocked }], details: undefined, isError: true };
			const result = await runSupportScript("team-communication.mjs", ["ask-supervisor", JSON.stringify(params ?? {})], signal);
			return { content: [{ type: "text", text: result.stdout || result.stderr }], details: undefined, isError: result.code !== 0 };
		},
	});
	pi.registerTool({
		name: TEAM_WATCHDOG_TOOL,
		label: "team_watchdog",
		description: "Inspect running Paseo agents and report suspected stale agents. Observation only; never cancels or replaces agents.",
		parameters: { type: "object", properties: { staleAfterMs: { type: "integer", minimum: 1000, maximum: 86400000 }, maxAgents: { type: "integer", minimum: 1, maximum: 200 }, concurrency: { type: "integer", minimum: 1, maximum: 16 }, globalDeadlineMs: { type: "integer", minimum: 1000, maximum: 120000 }, commandTimeoutMs: { type: "integer", minimum: 250, maximum: 30000 } }, additionalProperties: false } as any,
		async execute(_id, params, signal, _onUpdate, _ctx) {
			if (r !== "lead" && r !== "supervisor") return { content: [{ type: "text", text: "team_watchdog is available only to Lead or Supervisor agents." }], details: undefined, isError: true };
			const result = await runSupportScript("watchdog.mjs", [JSON.stringify(params ?? {})], signal, 130_000);
			return { content: [{ type: "text", text: result.stdout || result.stderr }], details: undefined, isError: result.code !== 0 };
		},
	});
	pi.registerTool({
		name: TEAM_LEASE_TOOL,
		label: "team_lease",
		description: teamLeaseToolDescription(),
		parameters: {
			type: "object",
			properties: {
				action: { type: "string", enum: ["claim", "renew", "release", "status"] },
				scope: { type: "string", maxLength: 256 },
				ttlMs: { type: "integer", minimum: 1, maximum: 43_200_000 },
				taskId: { type: "string", maxLength: 128 },
			},
			required: ["action"],
			additionalProperties: false,
		} as any,
		async execute(_id, params, signal, _onUpdate, _ctx) {
			const { action, ...rest } = (params ?? {}) as Record<string, unknown>;
			const blocked = teamLeaseToolBlockReason(r, action);
			if (blocked) return { content: [{ type: "text", text: blocked }], details: undefined, isError: true };
			const command = typeof action === "string" ? action : "status";
			const result = await runSupportScript("team-lease.mjs", [command, JSON.stringify(rest)], signal);
			return { content: [{ type: "text", text: result.stdout || result.stderr }], details: undefined, isError: result.code !== 0 };
		},
	});
	pi.registerTool({
		name: TEAM_FORK_TOOL,
		label: "team_fork",
		description: teamForkToolDescription(),
		parameters: {
			type: "object",
			properties: {
				action: { type: "string", enum: ["fork", "verify", "seed"] },
				agentId: { type: "string", maxLength: 64 },
				reason: { type: "string", enum: [...FORK_REASONS] },
				disposition: { type: "string", maxLength: 64 },
				scope: { type: "string", maxLength: 256 },
				rationale: { type: "string", maxLength: 2000 },
				provider: { type: "string", maxLength: 256 },
				model: { type: "string", maxLength: 128 },
				thinkingOptionId: { type: "string", maxLength: 64 },
				// See the same field in claude-team-mcp.mjs: a claude-* fork is
				// moved onto "auto" after import; this only narrows it on purpose.
				modeId: { type: "string", maxLength: 32 },
				cwd: { type: "string", maxLength: 512 },
				owns: { type: "string", maxLength: 512 },
				doesNotOwn: { type: "string", maxLength: 512 },
				forkAgentId: { type: "string", maxLength: 64 },
				labels: { type: "object", additionalProperties: { type: "string" } },
				keep: { type: "boolean" },
			},
			required: ["action"],
			additionalProperties: false,
		} as any,
		async execute(_id, params, signal, _onUpdate, _ctx) {
			const blocked = teamForkToolBlockReason(r, TEAM_FORK_TOOL);
			if (blocked) return { content: [{ type: "text", text: blocked }], details: undefined, isError: true };
			const { action, ...rest } = (params ?? {}) as Record<string, unknown>;
			const command = typeof action === "string" ? action : "seed";
			const result = await runSupportScript("team-fork.mjs", [command, JSON.stringify(rest)], signal, 60_000);
			return { content: [{ type: "text", text: result.stdout || result.stderr }], details: undefined, isError: result.code !== 0 };
		},
	});
}

// ---------------------------------------------------------------------------
// Per-turn peer state — recomputed from the *current* prompt on every
// before_agent_start. Never sticky across turns.
// ---------------------------------------------------------------------------

let currentBrief: ParsedTaskBrief | null = null;

function currentPeerMode(): PeerMode {
	return resolvePeerMode(currentBrief);
}


function currentPolicy(r: TeamRole): Policy {
	return policyWithAuthority(r, currentPeerMode(), currentBrief);
}

function applyPolicy(pi: ExtensionAPI, r: TeamRole): Policy {
	const registered = new Set(pi.getAllTools().map((t) => t.name));
	const policy = currentPolicy(r);
	const browserTools =
		r === "peer" && browserMcpAllowed(currentBrief)
			? [...registered].filter(isBrowserMcpTarget)
			: [];
	const allowed = [
		...new Set([...policy.allow, ...browserTools, ...extraTools()]),
	].filter((name) => registered.has(name));
	pi.setActiveTools(allowed);
	return policy;
}

function describePolicy(p: Policy): string {
	return `allow=[${p.allow.join(", ")}] deny=[${p.deny.join(", ")}]`;
}

// ---------------------------------------------------------------------------
// Debug commands
// ---------------------------------------------------------------------------

function registerDebugCommands(pi: ExtensionAPI, r: TeamRole | undefined) {
	pi.registerCommand("team-role", {
		description: "Show the active Paseo team role and its tool policy",
		handler: async (_args, ctx) => {
			if (!r) {
				ctx.ui.notify(
					"PASEO_PI_ROLE is unset — extension is passive (no restrictions).",
					"warning",
				);
				return;
			}
			const briefInfo = currentBrief
				? `brief=V${currentBrief.version} mode=${currentBrief.mode ?? "invalid"}${
						currentBrief.malformed.length
							? ` malformed=[${currentBrief.malformed.join("; ")}]`
							: ""
					}`
				: "brief=none";
			const p = currentPolicy(r);
			ctx.ui.notify(
				`role=${r} peerMode=${currentPeerMode()} ${briefInfo}\n${describePolicy(p)}`,
				"info",
			);
		},
	});

	pi.registerCommand("team-tools", {
		description: "List all registered tools with source and active state",
		handler: async (_args, ctx) => {
			const all = pi.getAllTools();
			const active = new Set(pi.getActiveTools());
			const rows = all.map((t) => {
				const state = active.has(t.name) ? "active  " : "inactive";
				const source = t.sourceInfo?.source ?? "unknown";
				return `${state} ${t.name.padEnd(32)} source=${source}`;
			});
			const text = [
				`role: ${r ?? "none"}`,
				`peerMode: ${currentPeerMode()}`,
				`tools: ${all.length} registered, ${active.size} active`,
				...rows,
			].join("\n");
			console.log(`[paseo-team] /team-tools\n${text}`);
			const dumpPath = join(homedir(), ".pi", "team-tools.txt");
			writeFileSync(dumpPath, `${text}\n`, "utf8");
			ctx.ui.notify(`team-tools: ${all.length} tools -> ${dumpPath}`, "info");
		},
	});
}

// ---------------------------------------------------------------------------
// Extension entry
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	const activeRole = detectRole();
	if (!activeRole) {
		console.log("[paseo-team] PASEO_PI_ROLE unset — extension passive");
		registerDebugCommands(pi, undefined);
		return;
	}
	const r: TeamRole = activeRole;
	registerTeamTools(pi, r);

	console.log(
		`[paseo-team] role=${r} peerMode=${currentPeerMode()} policy=${describePolicy(currentPolicy(r))}`,
	);

	pi.on("session_start", () => {
		currentBrief = null;
		applyPolicy(pi, r);
	});

	pi.on("before_agent_start", async (event) => {
		if (r === "peer") {
			// Recompute authority from THIS prompt — never inherit from an
			// earlier turn. Missing/malformed brief → read-only.
			currentBrief = parseTaskBrief(event.prompt);
			if (currentBrief?.malformed.length) {
				console.warn(
					`[paseo-team] malformed task brief → read-only: ${currentBrief.malformed.join("; ")}`,
				);
			}
		}
		applyPolicy(pi, r);
		const rolePrompt = loadRolePrompt(r);
		const notice =
			r === "lead"
				? (supervisorNotice(event.prompt) ?? peerNotice(event.prompt))
				: r === "supervisor"
					? leadConsultNotice(event.prompt)
					: null;
		if (!rolePrompt && !notice) return;
		const sections = [
			event.systemPrompt,
			rolePrompt ? `## Paseo Team Role\n${rolePrompt}` : "",
			notice ?? "",
		].filter(Boolean);
		return { systemPrompt: sections.join("\n\n") };
	});

	pi.on("tool_call", async (event) => {
		const peerMode = currentPeerMode();
		const policy = currentPolicy(r);
		if (
			r === "peer" &&
			isBrowserMcpTarget(event.toolName) &&
			!browserMcpAllowed(currentBrief)
		) {
			return {
				block: true,
				reason:
					"This Peer's brief sets BROWSER_MCP_AUTHORITY: denied, so the browser is withheld for this turn.",
			};
		}
		const teamBlockReason = teamToolBlockReason(r, event.toolName, currentBrief);
		if (teamBlockReason) return { block: true, reason: teamBlockReason };
		// Skill admission, pi dialect. pi has no `skill` tool: its own docs say
		// the agent loads a skill by READING the full SKILL.md after seeing it
		// listed in the system prompt, so the read IS the load and the path is
		// the only handle. Same table as the Claude `Skill` gate.
		if (isToolCallEventType("read", event)) {
			const skill = packSkillFromPath(event.input.path);
			const skillReason = skill && skillBlockReason(r, skill, currentBrief);
			if (skillReason) return { block: true, reason: skillReason };
		}
		if (policy.deny.includes(event.toolName)) {
			if (
				r === "peer" &&
				peerMode === "write" &&
				(event.toolName === "write" || event.toolName === "edit")
			) {
				return {
					block: true,
					reason:
						"EDIT_AUTHORITY is denied for this task even though MODE is write. Report AUTHORITY_MISMATCH to the Lead.",
				};
			}
			return {
				block: true,
				reason: denyReason(r, peerMode, event.toolName),
			};
		}
		if (isToolCallEventType("mcp", event)) {
			if (r === "peer") {
				const blockReason = peerMcpBlockReason(event.input, currentBrief);
				if (blockReason) return { block: true, reason: blockReason };
			}
			if (r === "supervisor" || r === "lead") {
				const blockReason = mcpBlockReason(
					r,
					event.input,
					governanceContext(event.input, r),
				);
				if (blockReason) {
					return { block: true, reason: blockReason };
				}
			}
			if (r === "lead") {
				const leaseReason = await leadWriterLeaseReason(event.input);
				if (leaseReason) {
					return { block: true, reason: leaseReason };
				}
			}
		}
		if (
			(r === "lead" || r === "supervisor") &&
			isToolCallEventType("mcp_script", event)
		) {
			const code = typeof event.input.code === "string" ? event.input.code : "";
			const blockReason = mcpScriptBlockReason(r, code);
			if (blockReason) {
				return { block: true, reason: blockReason };
			}
		}
		if (r === "peer" && isToolCallEventType("bash", event)) {
			const command = event.input.command ?? "";
			if (callsPaseoCli(command)) {
				return {
					block: true,
					reason:
						"Peer cannot drive the Paseo CLI from bash (would bypass the tool policy). Report a DEPENDENCY_REQUEST to the Lead instead.",
				};
			}
			// No browser-CLI guard: it existed for the agent-browser npm package,
			// which the pack no longer installs. Paseo Browser Control is an MCP
			// surface over the daemon's broker and has no CLI to shell out to.
			const supportScriptReason = supportScriptBlockReason(r, command);
			if (supportScriptReason) {
				return { block: true, reason: supportScriptReason };
			}
			const gitBlockReason = gitAuthorityBlockReason(
				command,
				peerGitAuthority(currentBrief),
				currentBrief?.fields.get("TASK_ID"),
			);
			if (gitBlockReason) {
				return { block: true, reason: gitBlockReason };
			}
		}
	});

	registerDebugCommands(pi, r);
}
