// claude-team-mcp.mjs — stdio MCP server exposing the pack's team tools
// to Claude Code, which has no extension API to register tools directly.
//
// Pi gets `peer_ask_lead`, `lead_ask_supervisor` and `team_watchdog` from the policy
// extension (registerTeamTools). Claude gets the SAME tools from this server, with
// the same role gate and the same underlying support scripts, so a Peer talks
// to its Lead identically on both runtimes. Claude sees them as
// `mcp__paseo-team__peer_ask_lead` / `__lead_ask_supervisor` / `__team_watchdog`.
//
// Zero dependencies on purpose (the pack ships no runtime deps): this speaks
// the MCP stdio framing — one JSON-RPC message per line — directly.
//
// Register with:
//   claude mcp add --scope user paseo-team -- node <this file>
// or through `pteam claude-setup`, which does it for you.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isEntrypoint } from "./lib-common.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

export const SERVER_NAME = "paseo-team";
export const SERVER_VERSION = "1.0.0";
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";

export const TEAM_TOOLS = [
	{
		name: "peer_ask_lead",
		description:
			"Send a question, blocker, dependency request, progress update, or finished report to this Peer's parent Lead only.",
		roles: ["peer"],
		script: "team-communication.mjs",
		timeoutMs: 30_000,
		buildArgs: (params) => ["ask-lead", JSON.stringify(params ?? {})],
		inputSchema: {
			type: "object",
			properties: {
				kind: {
					type: "string",
					enum: ["question", "blocked", "dependency", "progress", "report"],
				},
				message: { type: "string", minLength: 1, maxLength: 12000 },
				taskId: { type: "string" },
				correlationId: { type: "string" },
			},
			required: ["kind", "message"],
			additionalProperties: false,
		},
	},
	{
		name: "lead_ask_supervisor",
		// Mirrors policy-core's leadAskSupervisorToolDescription(). This file is
		// plain .mjs and cannot import the TypeScript core, so the text is
		// duplicated and claude-team-mcp.test.mjs asserts the two never drift.
		description:
			"Ask this cluster's Supervisor to DECIDE a matter, instead of asking the Human. " +
			"Delivers a LEAD_CONSULT_V1 prompt that wakes the Supervisor, which answers with either a binding SUPERVISOR_DECISION or an escalation naming which delegation criterion failed. " +
			"Use it whenever you would otherwise stop and ask the Human: a choice between approaches you have evidence for, a retry after a transient failure, a scope or ordering call, an ambiguous protocol reading. " +
			"Requires the four things the Supervisor is obliged to check — question, options, evidence, scope and reversibility — so a decision can come back in one round trip. " +
			"Go to the Human directly only for what is genuinely irreversible (merge, push, deploy, delete data, external comms), or when this tool reports NO_SUPERVISOR_SEAT.",
		roles: ["lead"],
		script: "team-communication.mjs",
		timeoutMs: 30_000,
		buildArgs: (params) => ["ask-supervisor", JSON.stringify(params ?? {})],
		inputSchema: {
			type: "object",
			properties: {
				kind: { type: "string", enum: ["decision", "question", "risk"] },
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
		},
	},
	{
		name: "team_watchdog",
		description:
			"Inspect running Paseo agents and report suspected stale agents. Observation only; never cancels or replaces agents.",
		roles: ["lead", "supervisor"],
		script: "watchdog.mjs",
		timeoutMs: 130_000,
		buildArgs: (params) => [JSON.stringify(params ?? {})],
		inputSchema: {
			type: "object",
			properties: {
				staleAfterMs: { type: "integer", minimum: 1000, maximum: 86400000 },
				maxAgents: { type: "integer", minimum: 1, maximum: 200 },
				concurrency: { type: "integer", minimum: 1, maximum: 16 },
				globalDeadlineMs: { type: "integer", minimum: 1000, maximum: 120000 },
				commandTimeoutMs: { type: "integer", minimum: 250, maximum: 30000 },
			},
			additionalProperties: false,
		},
	},
	{
		name: "team_lease",
		// Mirrors policy-core's teamLeaseToolDescription(); the parity test pins them.
		description:
			"Take, extend, release or inspect a scope lease — the record of which Lead may put a WRITER on which files. `claim` before creating an engineer; `release` when the work is done; `renew` for long work; `status` to see the board. Scopes are repo-relative paths and nest: holding `src` also holds `src/auth`. A claim can lose — read `granted` in the result, not merely `ok`. Creating a write-mode Peer without a covering lease is refused.",
		// Supervisor is included so it can read the board; the per-action gate in
		// policy-core refuses it claim/renew/release.
		roles: ["lead", "supervisor"],
		script: "team-lease.mjs",
		timeoutMs: 30_000,
		buildArgs: (params) => {
			const { action, ...rest } = params ?? {};
			return [typeof action === "string" ? action : "status", JSON.stringify(rest)];
		},
		inputSchema: {
			type: "object",
			properties: {
				action: { type: "string", enum: ["claim", "renew", "release", "status"] },
				scope: { type: "string", maxLength: 256 },
				ttlMs: { type: "integer", minimum: 1, maximum: 43200000 },
				taskId: { type: "string", maxLength: 128 },
			},
			required: ["action"],
			additionalProperties: false,
		},
	},
	{
		name: "team_fork",
		// Mirrors policy-core's teamForkToolDescription(); the parity test pins them.
		description:
			"Hand a session over WITHOUT retelling it: copy an agent's transcript into a new session file and import it as a new agent. `fork` validates, copies and imports, then returns the update_agent call that routes the model (the CLI cannot set it) plus a seed prompt that revokes the inherited identity; `verify` confirms the fork runs the requested model and DELETES it if not; `seed` returns the seed prompt alone. Choose a fork only when the reasoning history itself must travel (split-load, change-host, change-model, takeover). A role that must be independent (reviewer, challenger, supervisor) is refused — a fork inherits the framing it exists to question. Running out of context is NOT a fork reason: auto-compaction fires on the copy too, so use /compact instead. A fork inherits no lease and no Peers; claim your own scope before staffing a writer.",
		roles: ["lead", "supervisor"],
		script: "team-fork.mjs",
		// A fork is a file copy plus one `paseo import`; the import is the slow
		// half and shares the ~3s-per-command cost of every other Paseo call.
		timeoutMs: 60_000,
		buildArgs: (params) => {
			const { action, ...rest } = params ?? {};
			return [typeof action === "string" ? action : "seed", JSON.stringify(rest)];
		},
		inputSchema: {
			type: "object",
			properties: {
				action: { type: "string", enum: ["fork", "verify", "seed"] },
				agentId: { type: "string", maxLength: 64 },
				// Mirrors FORK_REASONS in policy-core; the parity test pins them.
				reason: { type: "string", enum: ["split-load", "change-host", "change-model", "takeover"] },
				disposition: { type: "string", maxLength: 64 },
				scope: { type: "string", maxLength: 256 },
				rationale: { type: "string", maxLength: 2000 },
				provider: { type: "string", maxLength: 256 },
				model: { type: "string", maxLength: 128 },
				thinkingOptionId: { type: "string", maxLength: 64 },
				// Optional: a claude-* fork is moved onto "auto" after import
				// (paseo import carries no mode, and an imported seat otherwise
				// comes up on "default"). Pass this only to narrow it on purpose,
				// e.g. "plan" for a fork that should propose before acting.
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
		},
	},
];

/** Same two-candidate resolution the Pi extension uses for support scripts. */
export function supportScriptPath(name, env = process.env) {
	const configured = env.PASEO_TEAM_SCRIPTS_DIR?.trim();
	const candidates = configured ? [join(configured, name)] : [join(HERE, name)];
	const found = candidates.find((candidate) => existsSync(candidate));
	if (!found) {
		throw new Error(`Paseo team support script is missing: ${name}`);
	}
	return found;
}

export function runSupportScript(name, args, timeoutMs = 30_000, env = process.env) {
	return new Promise((resolve) => {
		execFile(
			process.execPath,
			[supportScriptPath(name, env), ...args],
			{ encoding: "utf8", timeout: timeoutMs, windowsHide: true, env },
			(error, stdout, stderr) => {
				resolve({
					stdout: String(stdout ?? ""),
					stderr: String(stderr ?? ""),
					code: error ? 1 : 0,
				});
			},
		);
	});
}

function toolListPayload() {
	return {
		tools: TEAM_TOOLS.map(({ name, description, inputSchema }) => ({
			name,
			description,
			inputSchema,
		})),
	};
}

function textResult(text, isError = false) {
	return { content: [{ type: "text", text }], isError };
}

/**
 * Role gate, mirroring the Pi extension exactly. The PreToolUse hook already
 * denies these calls for the wrong role; this is the same rule enforced at the
 * other end, so the tools stay safe even if the hook is not installed.
 */
export async function callTeamTool(name, params, env = process.env) {
	const tool = TEAM_TOOLS.find((candidate) => candidate.name === name);
	if (!tool) return textResult(`Unknown tool: ${name}`, true);
	const role = env.PASEO_PI_ROLE?.trim().toLowerCase() ?? "";
	if (!tool.roles.includes(role)) {
		return textResult(
			`${name} is available only to ${tool.roles.join(" or ")} agents (PASEO_PI_ROLE=${role || "unset"}).`,
			true,
		);
	}
	const result = await runSupportScript(
		tool.script,
		tool.buildArgs(params),
		tool.timeoutMs,
		env,
	);
	return textResult(result.stdout || result.stderr, result.code !== 0);
}

/**
 * Handle one JSON-RPC request. Returns the response object, or null for
 * notifications (which must never be answered).
 */
export async function handleMessage(message, env = process.env) {
	if (typeof message !== "object" || message === null) return null;
	const { id, method, params } = message;
	const isNotification = id === undefined || id === null;
	const reply = (result) => (isNotification ? null : { jsonrpc: "2.0", id, result });
	const fail = (code, msg) =>
		isNotification ? null : { jsonrpc: "2.0", id, error: { code, message: msg } };

	switch (method) {
		case "initialize": {
			const requested = params?.protocolVersion;
			return reply({
				protocolVersion:
					typeof requested === "string" ? requested : DEFAULT_PROTOCOL_VERSION,
				capabilities: { tools: { listChanged: false } },
				serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
			});
		}
		case "notifications/initialized":
		case "notifications/cancelled":
			return null;
		case "ping":
			return reply({});
		case "tools/list":
			return reply(toolListPayload());
		case "tools/call": {
			const name = params?.name;
			if (typeof name !== "string") {
				return fail(-32602, "tools/call requires a string name");
			}
			try {
				return reply(await callTeamTool(name, params?.arguments, env));
			} catch (error) {
				return reply(textResult(`${name} failed: ${error?.message ?? error}`, true));
			}
		}
		default:
			return fail(-32601, `Method not found: ${method}`);
	}
}

export async function main(env = process.env) {
	const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
	for await (const line of rl) {
		const text = line.trim();
		if (!text) continue;
		let message;
		try {
			message = JSON.parse(text);
		} catch {
			process.stdout.write(
				`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })}\n`,
			);
			continue;
		}
		const response = await handleMessage(message, env);
		if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
	}
}

if (isEntrypoint(import.meta.url, process.argv[1])) {
	await main();
}
