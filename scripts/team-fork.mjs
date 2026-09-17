#!/usr/bin/env node
/**
 * team-fork.mjs — hand a session over without retelling it.
 *
 * A fork copies an agent's transcript into a new session file and imports it as
 * a new Paseo agent. Measured on 2026-08-27/28 (docs/multi-supervisor-topology.md
 * §1.1-§1.3), and every step here exists because of one of those measurements:
 *
 *   §1.2  A fork is a FILE COPY. The forked file keeps every entry verbatim,
 *         including the original `id`/`parentId` chain, and differs only in a
 *         new header: new session uuid, new timestamp, and `parentSession`
 *         pointing at the source file. So no `pi` process is spawned and no LLM
 *         turn is spent — a large session forks in milliseconds.
 *   §1.1  `paseo import <session-id>` turns that file into a real agent, with
 *         its history intact and `ParentAgentId: null` (already a root).
 *   §1.3  The imported agent's MODEL cannot be set from the CLI. Only MCP
 *         `update_agent { settings: { model, thinkingOptionId } }` moves it,
 *         which is why this script stops after `import` and hands the Lead the
 *         exact call to make, then verifies the result in a second step.
 *
 * The verification reads `runtimeInfo`, never `persistence.metadata.model`: the
 * latter is a creation-time snapshot Paseo does not rewrite, so it reports a
 * model the agent is not running.
 *
 * `paseo import` is ABSENT from Paseo's published CLI docs (§1.13). Treat the
 * shape as unverified upstream and keep test/paseo-contract.test.mjs honest
 * about it.
 */

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { importPolicyCore, isEntrypoint, resolvePaseoExec } from "./lib-common.mjs";

// Runtime resolution, for the reason spelled out in lib-common's policyCorePath:
// checkout and installed layouts differ by one directory level, and a static
// specifier can only be right in one of them.
const {
	agentCluster,
	defaultSeatMode,
	forkModeBlockReason,
	forkModelBlockReason,
	forkRequestBlockReason,
	forkSeedPrompt,
	parseRoleProvider,
	seatModeBlockReason,
} = await importPolicyCore();
const { paseoAgentsRoot, readAgentStates } = await importPolicyCore("agent-directory.ts");

/** Roles allowed to fork anything. Forking is a Lead act. */
export const FORK_ROLES = Object.freeze(["lead", "supervisor"]);

function bad(code, message) {
	return Object.assign(new Error(message), { code });
}

/**
 * UUIDv7 — time-ordered, which is what pi writes and what makes a session file
 * name sort by age. Random bits from crypto, not Math.random: a collision here
 * would silently merge two agents' histories.
 */
export function uuidv7(now = Date.now(), random = randomBytes) {
	const bytes = Buffer.alloc(16);
	bytes.writeUIntBE(now, 0, 6);
	random(10).copy(bytes, 6);
	bytes[6] = (bytes[6] & 0x0f) | 0x70; // version 7
	bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10
	const hex = bytes.toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** pi names a session file `<timestamp with : and . replaced>_<uuid>.jsonl`. */
export function sessionFileName(sessionId, now = Date.now()) {
	return `${new Date(now).toISOString().replace(/[:.]/g, "-")}_${sessionId}.jsonl`;
}

/**
 * Copy a session file into a new one the daemon will accept as its own.
 *
 * Only the FIRST line changes; every entry after it is copied byte for byte,
 * ids and all. That is what the measurement showed a real `pi --fork` produces,
 * and reproducing it exactly is the whole reason this is a file operation
 * rather than a replay.
 *
 * Written to a temp file and renamed, so a half-written session file can never
 * be picked up: an import of a truncated transcript would look like an agent
 * that forgot the middle of its own history.
 */
export function materializeFork(sourceFile, options = {}) {
	if (typeof sourceFile !== "string" || sourceFile.trim() === "") {
		throw bad("FORK_SESSION_FILE_MISSING", "the source agent has no session file on this host (persistence.nativeHandle is empty) — a fork can only be materialized where the transcript lives");
	}
	if (!existsSync(sourceFile)) {
		throw bad("FORK_SESSION_FILE_MISSING", `session file not found: ${sourceFile}`);
	}
	const now = options.now ?? Date.now();
	const sessionId = options.sessionId ?? uuidv7(now);
	const text = readFileSync(sourceFile, "utf8");
	const lines = text.split(/\r?\n/);
	const headerLine = lines.find((line) => line.trim() !== "");
	if (!headerLine) throw bad("FORK_SESSION_EMPTY", `session file is empty: ${sourceFile}`);
	let header;
	try {
		header = JSON.parse(headerLine);
	} catch (error) {
		throw bad("FORK_SESSION_UNREADABLE", `session header is not JSON: ${String(error?.message ?? error)}`);
	}
	if (header?.type !== "session") {
		throw bad("FORK_SESSION_UNREADABLE", `session file does not start with a session header (got type ${JSON.stringify(header?.type ?? null)})`);
	}
	const rest = lines.slice(lines.indexOf(headerLine) + 1);
	const forkHeader = {
		...header,
		id: sessionId,
		timestamp: new Date(now).toISOString(),
		// An ABSOLUTE path, which is what a real fork records.
		parentSession: sourceFile,
	};
	const target = options.targetFile ?? join(dirname(sourceFile), sessionFileName(sessionId, now));
	const temp = `${target}.tmp-${process.pid}`;
	writeFileSync(temp, [JSON.stringify(forkHeader), ...rest].join("\n"), "utf8");
	renameSync(temp, target);
	return { sessionId, file: target, parentSession: sourceFile, entries: rest.filter((line) => line.trim() !== "").length };
}

export function runPaseo(args, timeoutMs = 30_000) {
	const [bin, ...prefix] = resolvePaseoExec((reason) => {
		throw bad("PASEO_EXEC_INVALID", `PASEO_TEAM_PASEO_EXEC ${reason}`);
	});
	try {
		return JSON.parse(
			execFileSync(bin, [...prefix, ...args, "--json"], {
				encoding: "utf8",
				timeout: timeoutMs,
				stdio: ["ignore", "pipe", "pipe"],
				env: process.env,
				windowsHide: true,
			}),
		);
	} catch (error) {
		const text = `${error?.stderr ?? ""}\n${error?.stdout ?? ""}\n${error?.message ?? error}`.trim();
		throw bad("CLI_ERROR", text.split("\n").map((line) => line.trim()).find((line) => /[A-Za-z0-9]/.test(line)) ?? "paseo failed");
	}
}

function readState(agentId, options = {}) {
	const { states, degraded } = readAgentStates([agentId], {
		root: options.agentsRoot ?? paseoAgentsRoot(options.env ?? process.env),
	});
	const state = states[agentId];
	if (!state) {
		throw bad(
			"FORK_SOURCE_UNKNOWN",
			`Paseo has no readable state for agent ${agentId} on this host (${degraded.map((entry) => entry.reason).join(", ") || "no detail"}). A fork copies a transcript, so it can only run where that transcript lives.`,
		);
	}
	return state;
}

function requireRole(options) {
	const role = (options.role ?? process.env.PASEO_PI_ROLE ?? "").trim().toLowerCase();
	if (!FORK_ROLES.includes(role)) {
		throw bad("ROLE_NOT_ALLOWED", `ROLE_NOT_ALLOWED: forking is a ${FORK_ROLES.join("/")} act (a Peer has no agent to fork)`);
	}
	return role;
}

/**
 * Fork an agent: validate, copy the transcript, import it.
 *
 * Deliberately stops one step short of "done". The model cannot be set from
 * here (§1.3), so the result carries the exact `update_agent` call the Lead
 * must make through MCP, and `verify` is a separate command that either
 * confirms the route or deletes the fork. Returning "created" before the route
 * is known would hand the Lead an agent whose model nobody chose.
 */
export async function forkAgent(input = {}, options = {}) {
	requireRole(options);
	const blocked = forkRequestBlockReason(input);
	if (blocked) throw bad("FORK_BLOCKED", blocked);

	const agentId = typeof input.agentId === "string" ? input.agentId.trim() : "";
	if (!agentId) throw bad("FORK_SOURCE_MISSING", "agentId (the agent to fork) is required");
	const run = options.runPaseo ?? runPaseo;

	// Argument checks first: they are free, and a request that can never
	// succeed should not cost a state read — nor leave the caller reading a
	// "no such agent" message when the real problem is the provider it typed.
	const provider = typeof input.provider === "string" ? input.provider.trim() : "";
	const parsed = parseRoleProvider(provider);
	if (!parsed) {
		throw bad(
			"FORK_PROVIDER_INVALID",
			`provider must be one of the pack's role providers — "pi-lead", "claude-supervisor", ... (got "${provider || "<missing>"}"). A fork that lands on a provider without a role prompt is an agent outside the team.`,
		);
	}
	// Measured 2026-08-28: `paseo import --provider` takes a BARE provider id and
	// rejects the `<provider>/<model>` form that `create_agent` accepts —
	//   "Unknown provider 'pi-supervisor/Minnyat/gpt-5.6-luna'"
	// which is the same fact §1.3 records from the other side: import cannot
	// carry a route, so the model is set afterwards through update_agent. A full
	// reference is accepted here and reduced, so a Lead that reaches for the
	// create_agent spelling gets a fork rather than a confusing CLI error.
	const importProvider = `${parsed.family}-${parsed.role}`;
	// The measured anti-pattern: a fork of a Lead created as a reviewer. The
	// disposition gate above catches the intent; this catches the shape.
	if (parsed.role === "peer" && input.disposition === "lead") {
		throw bad("FORK_PROVIDER_INVALID", "the provider role and the declared disposition disagree");
	}
	// Which mode the fork must end up on. Checked here, before a single byte is
	// copied, for the same reason the provider is: a request that can never
	// produce a usable seat should not leave a session file behind.
	const requestedMode =
		typeof input.modeId === "string" && input.modeId.trim() !== "" ? input.modeId.trim() : null;
	const modeBlocked = seatModeBlockReason(requestedMode, { family: parsed.family, what: "fork" });
	if (modeBlocked) throw bad("FORK_MODE_INVALID", modeBlocked);
	const mode = requestedMode ?? defaultSeatMode(parsed.family);

	const state = readState(agentId, options);

	const materialized = options.materialize
		? options.materialize(state.sessionFile, { now: options.now })
		: materializeFork(state.sessionFile, { now: options.now });

	const labels = { ...(input.labels && typeof input.labels === "object" ? input.labels : {}) };
	labels["team.fork-of"] = agentId;
	labels["team.fork-reason"] = String(input.reason);
	// A fork is a continuation of the SOURCE seat's identity (§2 rule 5:
	// "fork inherits belief, not authority" — but cluster membership is
	// belief, not authority). Derived from the source's own state, the same
	// way `team.fork-of`/`team.fork-reason` are: not left to whatever the
	// caller happened to pass. Omitted when the source's cluster cannot be
	// derived, matching LEASE_V1's own "absent field, not a lying one" rule —
	// an empty CLUSTER label would be worse than none.
	const sourceCluster = agentCluster(state);
	if (sourceCluster) labels["team.cluster"] = sourceCluster;
	const cwd = typeof input.cwd === "string" && input.cwd.trim() !== "" ? input.cwd : state.cwd;
	if (!cwd) {
		// Measured 2026-08-28: without --cwd the CLI notices the session belongs
		// to another project and PROMPTS ("Fork this session into current
		// directory? [y/N]"), which under --json aborts with the unhelpful
		// "Pi RPC process exited with code 0". Refusing here is a readable
		// failure instead of a mysterious one.
		throw bad(
			"FORK_CWD_UNKNOWN",
			`neither the request nor agent ${agentId}'s state names a working directory, and \`paseo import\` prompts (and then aborts) without --cwd. Pass cwd explicitly.`,
		);
	}
	const args = ["import", materialized.sessionId, "--provider", importProvider, "--cwd", cwd];
	for (const [key, value] of Object.entries(labels)) {
		args.push("--label", `${key}=${value}`);
	}

	let imported;
	try {
		imported = await run(args);
	} catch (error) {
		// Nothing is left behind: an orphan session file would be imported by a
		// later retry with a different provider and no one would know why.
		try {
			rmSync(materialized.file, { force: true });
		} catch {
			/* the report below already names the file */
		}
		throw error;
	}
	// Measured 2026-08-28: `paseo import --json` answers
	//   { agentId, status, provider, cwd, title }
	// — `agentId`, NOT the `id` that `paseo ls` uses. Reading only `id` yields
	// null while the import actually SUCCEEDED, which leaves a live agent behind
	// and reports a failure. All three spellings are accepted so an upstream
	// rename does not silently orphan an agent.
	const forkAgentId = imported?.agentId ?? imported?.id ?? imported?.Id ?? null;
	if (!forkAgentId) {
		throw bad(
			"FORK_IMPORT_UNCONFIRMED",
			`paseo import returned no agent id (${JSON.stringify(imported)}). The agent may exist: check \`paseo ls -g\` for one labelled team.fork-of=${agentId} and delete it before retrying.`,
		);
	}

	// Measured 2026-09-07: `paseo import` has no `--mode` at all (its whole
	// option set is --provider, --cwd, --label, --json, --host), and Paseo does
	// NOT apply the provider's defaultMode at create time — an imported Claude
	// seat comes up on "default" and parks every tool call it makes in the
	// pending-permission queue. So the mode is a SECOND call, and a fork that
	// cannot be moved onto it is deleted rather than handed over: a seat whose
	// permission mode nobody chose is exactly what `verify` exists to refuse,
	// and leaving it alive would hand the Lead a fork that looks hung.
	if (mode) {
		try {
			await run(["agent", "mode", forkAgentId, mode]);
		} catch (error) {
			let removed = false;
			try {
				await run(["delete", forkAgentId]);
				removed = true;
			} catch {
				/* the message below names the agent to remove by hand */
			}
			throw bad(
				"FORK_MODE_UNSET",
				`the fork was imported but could not be moved onto mode "${mode}" (${String(error?.message ?? error)}). ${removed ? "It has been deleted; fork again." : `DELETE IT BY HAND — \`paseo delete ${forkAgentId}\` — then fork again.`} An imported seat stays on "default", where every tool call waits for a human.${requestedMode === null ?` If "${mode}" is unavailable for this backend or model (Bedrock/Vertex, or a model without it), fork again with an explicit modeId the seat supports.` : ""}`,
			);
		}
	}

	return {
		ok: true,
		agentId: forkAgentId,
		forkOf: agentId,
		// What `verify` will hold the fork to, alongside the model and thinking
		// level the caller must still route through MCP.
		mode,
		sessionId: materialized.sessionId,
		sessionFile: materialized.file,
		parentSession: materialized.parentSession,
		entries: materialized.entries,
		provider: importProvider,
		requestedProvider: provider,
		reason: String(input.reason),
		disposition: String(input.disposition),
		seedPrompt: forkSeedPrompt({
			sourceAgentId: agentId,
			forkAgentId,
			reason: String(input.reason),
			disposition: String(input.disposition),
			owns: typeof input.owns === "string" ? input.owns : null,
			doesNotOwn: typeof input.doesNotOwn === "string" ? input.doesNotOwn : null,
		}),
		// §1.3: the CLI cannot set the model. Say so, with the call to make.
		nextAction: {
			tool: "update_agent",
			args: {
				agentId: forkAgentId,
				settings: {
					...(input.model ? { model: input.model } : {}),
					...(input.thinkingOptionId ? { thinkingOptionId: input.thinkingOptionId } : {}),
				},
			},
			why: `The imported agent's model can only be set through MCP update_agent; the CLI has no --model. Run it, then \`team-fork.mjs verify\` before using the fork.${mode ? ` The permission mode is already done: the fork was moved onto "${mode}" with \`paseo agent mode\`, which import cannot carry.` : ""}`,
		},
		then: "verify",
	};
}

/**
 * Confirm the fork runs the route it was created for, or remove it.
 *
 * Deleting rather than reporting: an agent on an unknown model produces
 * evidence nobody can weigh, and it is cheaper to fork again (a file copy) than
 * to discover three rounds later that the route was never applied.
 *
 * The permission mode is checked on the same terms as the model, because it
 * fails the same way: `paseo import` cannot carry one, so it is applied by a
 * separate call that can silently not have happened (an older fork, a hand-run
 * import, a daemon that refused the mode for that model). A fork left on
 * "default" answers nothing and waits for a human on every tool call, so it is
 * removed rather than reported as usable.
 */
export async function verifyFork(input = {}, options = {}) {
	requireRole(options);
	const agentId = typeof input.agentId === "string" ? input.agentId.trim() : "";
	if (!agentId) throw bad("FORK_TARGET_MISSING", "agentId (the imported fork) is required");
	const state = readState(agentId, options);
	const family = parseRoleProvider(state.provider ?? "")?.family ?? null;
	const requestedMode =
		typeof input.modeId === "string" && input.modeId.trim() !== "" ? input.modeId.trim() : null;
	const reason =
		forkModelBlockReason({
			expectedModel: typeof input.model === "string" ? input.model : null,
			actualModel: state.model,
			expectedThinking: typeof input.thinkingOptionId === "string" ? input.thinkingOptionId : null,
			actualThinking: state.thinking,
		}) ??
		forkModeBlockReason({
			// Only what the caller actually asked for is held to exactly; without
			// a request the check is "not parked, not unguarded", so a fork
			// deliberately created on "plan" survives a verify that says nothing
			// about modes.
			expectedMode: requestedMode,
			actualMode: state.mode,
			family,
		});
	if (!reason) {
		return {
			ok: true,
			agentId,
			model: state.model,
			modelSource: state.modelSource,
			thinking: state.thinking,
			mode: state.mode,
			modeSource: state.modeSource,
			sessionId: state.sessionId,
		};
	}
	const run = options.runPaseo ?? runPaseo;
	let removed = false;
	let removeError = null;
	if (input.keep !== true) {
		try {
			await run(["delete", agentId]);
			removed = true;
		} catch (error) {
			removeError = String(error?.message ?? error);
		}
	}
	return {
		ok: false,
		code: reason.includes("FORK_MODE_UNROUTABLE")
			? "FORK_MODE_UNROUTABLE"
			: "FORK_MODEL_UNROUTABLE",
		message: reason,
		agentId,
		model: state.model,
		thinking: state.thinking,
		mode: state.mode,
		removed,
		...(removeError ? { removeError } : {}),
	};
}

/** The seed prompt on its own, for a Lead composing the handover by hand. */
export function forkSeed(input = {}) {
	const agentId = typeof input.agentId === "string" ? input.agentId.trim() : "";
	if (!agentId) throw bad("FORK_SOURCE_MISSING", "agentId (the source agent) is required");
	return {
		ok: true,
		seedPrompt: forkSeedPrompt({
			sourceAgentId: agentId,
			forkAgentId: typeof input.forkAgentId === "string" ? input.forkAgentId : null,
			reason: typeof input.reason === "string" ? input.reason : "takeover",
			disposition: typeof input.disposition === "string" ? input.disposition : "lead",
			owns: typeof input.owns === "string" ? input.owns : null,
			doesNotOwn: typeof input.doesNotOwn === "string" ? input.doesNotOwn : null,
		}),
	};
}

async function main() {
	const command = process.argv[2];
	let input = {};
	if (process.argv[3] !== undefined) {
		try {
			input = JSON.parse(process.argv[3]);
		} catch (error) {
			throw bad("INPUT_INVALID", `invalid JSON input: ${String(error?.message ?? error)}`);
		}
	}
	const handlers = { fork: forkAgent, verify: verifyFork, seed: async (i) => forkSeed(i) };
	const handler = handlers[command];
	if (!handler) throw bad("USAGE", `usage: team-fork.mjs ${Object.keys(handlers).join("|")} '<json>'`);
	console.log(JSON.stringify(await handler(input), null, 2));
}

export function isMainModule(entry = process.argv[1], moduleUrl = import.meta.url) {
	return isEntrypoint(moduleUrl, entry);
}

if (isMainModule()) {
	main().catch((error) => {
		console.error(JSON.stringify({ ok: false, code: error.code ?? "FORK_FAILED", message: error.message }));
		process.exit(2);
	});
}
