#!/usr/bin/env node
// remote-paseo.mjs — remote-host executor for the paseo-pi-team role pack.
//
// The MCP server injected into a pi agent ALWAYS points at that agent's LOCAL
// daemon (verified against Paseo 0.2.5 source: daemon.mcp.injectIntoAgents
// builds the mcp config with the parent daemon's own URL). So a Lead that
// needs to create/observe agents on ANOTHER daemon cannot use the mcp proxy —
// it must drive the Paseo CLI with `--host <endpoint>`. This wrapper is that
// bridge. The Lead calls the wrapper, never hand-builds shell commands.
//
// Why a wrapper instead of raw bash:
//   - the endpoint VALUE lives in an env var; only the NAME appears anywhere;
//   - provider/model/thinking are validated BEFORE a single CLI call;
//   - argv is passed without a shell on Windows (node.exe spawns the real CLI
//     entry), so arbitrary prose prompts survive quoting;
//   - every result is a stable JSON envelope tagged with the hostId, so the
//     Lead can never confuse a remote answer with a local one.
//
// Usage:
//   node scripts/remote-paseo.mjs <command> [options] [--cluster <path>] [--dry-run]
//
//   health           --host-id <id>                     reachability (paseo ls)
//   providers        --host-id <id>                     paseo provider ls
//   models           --host-id <id> --provider <role>   paseo provider models
//   workspaces       --host-id <id>                     paseo workspace ls
//   workspace-create --host-id <id> --path <p> [--isolation local|worktree]
//                    [--disposition <d>] [--title <t>] [--project <id>]
//                    (disposition independent-reviewer forces worktree isolation)
//   agents           --host-id <id> [--all]             paseo ls -g
//   run              --host-id <id> --provider <role-provider>/<model-ref>
//                    --thinking <level> [--mode <m>] (claude-* defaults to "auto") [--workspace <wks>] [--title <t>]
//                    [--label <key>=<value> ...] [--prompt <text> | --brief <file>]
//                    [--wait-timeout <dur>]
//                    A "team.cluster" label is required on every remotely-created
//                    agent (§PR-G) — every cluster-scoped rule (SUPERVISOR_DECISION,
//                    the scope-lease board) reads it from the
//                    agent's own state. main() fills it in automatically from this
//                    seat's own cluster (selfCluster()) when --label does not
//                    already set one; buildArgv() refuses the run if it is still
//                    missing when the paseo CLI would be invoked.
//   status           --agent-ref <host-id>/<agent-id>   paseo inspect
//   cancel           --agent-ref <host-id>/<agent-id>   paseo stop
//   archive          --agent-ref <host-id>/<agent-id>   paseo archive
//   send             --agent-ref <host-id>/<agent-id>
//                    [--prompt <text> | --prompt-file <file>] [--wait]
//
// Env:
//   PASEO_TEAM_HOME         config dir (default ~/.paseo-pi-team) — same as
//                           model-routing.mjs / preflight.mjs
//   PASEO_TEAM_PASEO_EXEC   test/debug hook: full command line of a
//                           paseo-compatible executable (e.g. "node ./fake.mjs")
//
// Output: one JSON envelope on stdout, e.g.
//   { ok: true, command: "models", hostId: "mac-review", endpointEnv: "PASEO_MAC_REVIEW",
//     endpointSet: true, data: [...] }
//   { ok: false, code: "ENDPOINT_ENV_MISSING", message: "...", hostId: "mac-review",
//     endpointEnv: "PASEO_MAC_REVIEW" }
//
// Exit codes: 0 ok · 1 usage/config/env error · 2 paseo CLI runtime error.
// The endpoint VALUE is never printed, logged or embedded in errors.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	PASEO_CONVENTIONAL_ENTRIES,
	importPolicyCore,
	isEntrypoint,
	resolveCmdEntry as resolveCmdEntryFromShim,
	resolvePaseoExec as resolvePaseoExecShared,
} from "./lib-common.mjs";
import { classifyRemoteFailure } from "./reliability.mjs";
import {
	ROLE_PROVIDERS,
	THINKING_LEVELS_BY_FAMILY,
	RoutingError,
	cmdPercentExpansionRisk,
	composeProviderModel,
	loadClusterConfig,
	providerFamily,
	splitProviderModel,
	validateModelForFamily,
	validateRemoteEndpoint,
} from "./model-routing.mjs";

// ---------------------------------------------------------------------------
// Structured error
// ---------------------------------------------------------------------------

export const REMOTE_ERROR_CODES = Object.freeze([
	"USAGE",
	"STARTUP_IDENTITY_UNAVAILABLE",
	"AGENT_REF_UNAVAILABLE",
	"MODEL_RESOLUTION_MISMATCH",
	"CLUSTER_CONFIG_INVALID",
	"HOST_NOT_FOUND",
	"LOCAL_HOST_UNSUPPORTED",
	"ENDPOINT_ENV_MISSING",
	"ENDPOINT_UNSAFE",
	"CLI_ERROR",
	"PROMPT_TOO_LONG",
	"REVIEW_ISOLATION_INVALID",
	"REVIEW_WORKTREE_UNAVAILABLE",
]);

export class RemoteError extends Error {
	/**
	 * @param {string} code one of REMOTE_ERROR_CODES
	 * @param {string} message human-readable explanation (never secrets)
	 * @param {Record<string, unknown>} [details]
	 */
	constructor(code, message, details = {}) {
		super(`${code}: ${message}`);
		this.name = "RemoteError";
		this.code = code;
		this.details = details;
	}
}

const usageError = (message) => new RemoteError("USAGE", message);

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

const BOOLEAN_FLAGS = new Set([
	"--all",
	"--background",
	"--dry-run",
	"--global",
	"--json",
	"--wait",
	"--no-wait",
]);

export const DEFAULT_STARTUP_IDENTITY_TIMEOUT_MS = 10000;
export const MAX_STARTUP_IDENTITY_TIMEOUT_MS = 120000;
export const STARTUP_IDENTITY_POLL_INTERVAL_MS = 250;
export const MAX_STARTUP_IDENTITY_ATTEMPTS = 512;

function toCamelCase(flag) {
	const parts = flag.replace(/^--/, "").split("-");
	let out = parts[0];
	for (let i = 1; i < parts.length; i++) {
		const part = parts[i];
		if (part) out += part[0].toUpperCase() + part.slice(1);
	}
	return out;
}

/**
 * Parse `--flag value` args into a camelCase options object; bare values land
 * in `_`. A flag whose value is missing (or that is followed by another flag)
 * is recorded as boolean `true` — validateFlags() then rejects it when the
 * flag requires a value, so a typo can never silently drop an option.
 *
 * `--label` is the one flag that REPEATS (`--label a=b --label c=d`) and is
 * always accumulated into an array under `out.label`, even when passed once,
 * so buildArgv never has to distinguish "one label" from "one of several".
 */
export function parseArgs(argv) {
	const out = { _: [] };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "-h" || arg === "--help") {
			out.help = true;
			continue;
		}
		if (arg === "--label") {
			const next = argv[i + 1];
			const hasValue = next !== undefined && !next.startsWith("--");
			out.label = Array.isArray(out.label) ? out.label : [];
			out.label.push(hasValue ? next : true);
			if (hasValue) i++;
			continue;
		}
		if (arg.startsWith("--")) {
			const key = toCamelCase(arg);
			const next = argv[i + 1];
			if (
				BOOLEAN_FLAGS.has(arg) ||
				next === undefined ||
				next.startsWith("--")
			) {
				out[key] = true;
			} else {
				out[key] = next;
				i++;
			}
			continue;
		}
		if (arg.startsWith("-")) {
			throw usageError(`unknown flag "${arg}"`);
		}
		out._.push(arg);
	}
	return out;
}

/**
 * Permission mode a `claude-*` route gets when the caller passes no --mode.
 *
 * Paseo refuses to inherit a mode across providers, so one has to be supplied
 * on every claude-* create; this is the value the pack supplies. See the note
 * in buildArgv's `run` case for why it is "auto" rather than "default".
 *
 * Deliberately a literal rather than an import: policy-core is loaded lazily
 * here (one `await importPolicyCore()` deep inside main, so `--help` and the
 * argument checks stay synchronous), and a module-level await would make every
 * importer pay for it. `remote-paseo.test.mjs` pins it against policy-core's
 * `CLAUDE_DEFAULT_SEAT_MODE`, so the two cannot drift apart in silence.
 */
export const CLAUDE_DEFAULT_MODE = "auto";

// Per-command flag allowlist (camelCase keys — the parse output). Anything
// outside the set is a typo — rejected fail-closed so a misspelled option
// cannot silently change which workspace/provider/agent a remote command
// targets.
const COMMAND_FLAG_KEYS = {
	health: ["hostId"],
	providers: ["hostId"],
	models: ["hostId", "provider"],
	workspaces: ["hostId"],
	"workspace-create": ["hostId", "path", "isolation", "disposition", "title", "project"],
	agents: ["hostId", "all"],
	run: [
		"hostId",
		"provider",
		"thinking",
		"mode",
		"workspace",
		"title",
		"prompt",
		"brief",
		"waitTimeout",
		"startupTimeout",
		"background",
		"label",
	],
	status: ["agentRef"],
	cancel: ["agentRef"],
	archive: ["agentRef"],
	send: ["agentRef", "prompt", "promptFile", "wait", "noWait"],
};

// The V3 brief disposition vocabulary (see templates/TASK_BRIEF_V3.md).
export const WORKSPACE_DISPOSITIONS = Object.freeze([
	"repository-scout",
	"documentation-researcher",
	"solution-architect",
	"engineer",
	"independent-reviewer",
]);

const GLOBAL_FLAG_KEYS = new Set(["cluster", "dryRun", "json", "help"]);
const BOOLEAN_KEYS = new Set([...BOOLEAN_FLAGS].map(toCamelCase));

/**
 * Fail-closed flag validation against the command's allowlist: unknown flags
 * and value-flags missing their value are rejected.
 */
export function validateFlags(command, out) {
	const allowed = new Set([
		...(COMMAND_FLAG_KEYS[command] ?? []),
		...GLOBAL_FLAG_KEYS,
	]);
	for (const key of Object.keys(out)) {
		if (key === "_") continue;
		if (!allowed.has(key)) {
			throw usageError(`flag "--${key}" is not valid for command "${command}"`);
		}
		if (out[key] === true && !BOOLEAN_KEYS.has(key)) {
			throw usageError(`flag "--${key}" requires a value`);
		}
	}
}

// ---------------------------------------------------------------------------
// Host resolution from the cluster contract (single source of truth)
// ---------------------------------------------------------------------------

/**
 * Resolve a remote host entry from the controller-local cluster config.
 * The endpoint VALUE is only ever returned internally; every thrown error
 * mentions the env-var NAME, never the value.
 */
export function resolveHost(cluster, hostId, options = {}) {
	const platform = options.platform ?? process.platform;
	const host = cluster?.hosts?.[hostId];
	if (!host) {
		throw new RemoteError(
			"HOST_NOT_FOUND",
			`cluster routing config has no host "${hostId}" (known: ${Object.keys(cluster?.hosts ?? {}).join(", ") || "none"})`,
			{ hostId },
		);
	}
	if (host.connection.type !== "remote") {
		throw new RemoteError(
			"LOCAL_HOST_UNSUPPORTED",
			`host "${hostId}" is connection.type=local — the MCP server injected into this agent already talks to that daemon. Use MCP operations (list_providers/create_agent/...) for local; the remote wrapper only drives REMOTE daemons.`,
			{ hostId },
		);
	}
	const envName = host.connection.endpointEnv;
	const value = envName ? process.env[envName] : undefined;
	if (!envName || typeof value !== "string" || value.trim() === "") {
		throw new RemoteError(
			"ENDPOINT_ENV_MISSING",
			`endpoint env ${envName ?? "<missing endpointEnv>"} is not set for host "${hostId}". Set it persistently (e.g. setx / [Environment]::SetEnvironmentVariable), restart the controller process, and re-check — a session-local export is invisible to an already-running controller.`,
			{ hostId, endpointEnv: envName },
		);
	}
	if (!validateRemoteEndpoint(value)) {
		throw new RemoteError(
			"ENDPOINT_UNSAFE",
			`endpoint env ${envName} has an unexpected shape (expected a paseo pairing-offer URL or tcp:// target) — refusing to use it.`,
			{ hostId, endpointEnv: envName },
		);
	}
	if (platform === "win32" && cmdPercentExpansionRisk(value)) {
		throw new RemoteError(
			"ENDPOINT_UNSAFE",
			`endpoint env ${envName} contains 2+ "%" characters — unsafe with cmd.exe %VAR% expansion on Windows controllers. Use a pairing offer URL or run the controller on a non-cmd host.`,
			{ hostId, endpointEnv: envName },
		);
	}
	return { hostId, host, endpointEnv: envName, endpoint: value };
}

/**
 * Split `<host-id>/<agent-id>` at the FIRST slash (agent ids are UUIDs — they
 * never contain slashes). Pure string split; no cluster validation here so
 * buildArgv can stay cluster-free. Validation against the cluster happens in
 * parseAgentRef (the main() path).
 */
export function splitAgentRef(ref) {
	if (typeof ref !== "string" || ref.trim() === "") {
		throw usageError("--agent-ref <host-id>/<agent-id> is required");
	}
	const slash = ref.indexOf("/");
	if (slash <= 0 || slash === ref.length - 1) {
		throw usageError(`--agent-ref must be <host-id>/<agent-id> (got "${ref}")`);
	}
	const hostId = ref.slice(0, slash).trim();
	const agentId = ref.slice(slash + 1).trim();
	if (!hostId || !agentId) {
		throw usageError("--agent-ref has an empty host-id or agent-id segment");
	}
	return { hostId, agentId };
}

/**
 * Parse `<host-id>/<agent-id>` (composite AGENT_REF) and resolve the host.
 * The host prefix must resolve to a REMOTE host in the cluster config — a
 * ref pointing at the local host is rejected (use MCP for local agents).
 */
export function parseAgentRef(ref, cluster, options = {}) {
	const { hostId, agentId } = splitAgentRef(ref);
	const host = resolveHost(cluster, hostId, options);
	return { hostId, agentId, ...host };
}

// ---------------------------------------------------------------------------
// Run-option validation (provider / thinking / prompt)
// ---------------------------------------------------------------------------

/**
 * Validate the FULL create_agent provider string. Paseo splits at the FIRST
 * slash only, so the model part is whatever follows the role provider — but
 * its SHAPE is per family and is not interchangeable:
 *
 *   pi-peer/<pi-provider>/<model-id>   pi ids carry their own provider segment,
 *                                      and may contain further slashes
 *   claude-peer/<model-id>             Claude ids are one bare segment
 *
 * A pi-shaped model on a Claude route is a config error, not something to
 * normalise, so the family decides the check. Returns the canonical form.
 */
export function validateRunProvider(provider) {
	if (typeof provider !== "string" || provider.trim() === "") {
		throw usageError(
			"--provider <role-provider>/<model-ref> is required (pi: <pi-provider>/<model-id>, claude: bare model id)",
		);
	}
	let roleProvider, model;
	try {
		({ provider: roleProvider, model } = splitProviderModel(provider));
	} catch (error) {
		if (error instanceof RoutingError) {
			throw usageError(
				`--provider must be <role-provider>/<model-ref> (got "${provider}")`,
			);
		}
		throw error;
	}
	if (!ROLE_PROVIDERS.includes(roleProvider)) {
		throw usageError(
			`role provider "${roleProvider}" is not a durable role profile (${ROLE_PROVIDERS.join(", ")})`,
		);
	}
	// The family is known only once the role provider is, so the model check
	// comes second — never the pi shape applied to every family.
	const family = providerFamily(roleProvider);
	try {
		validateModelForFamily(family, model, (message) => new RoutingError("CONFIG_INVALID", message));
	} catch (error) {
		if (error instanceof RoutingError) {
			throw usageError(`--provider "${provider}": ${error.message.replace(/^CONFIG_INVALID: /, "")}`);
		}
		throw error;
	}
	return {
		roleProvider,
		family,
		model,
		provider: composeProviderModel(roleProvider, model),
	};
}

/**
 * Thinking levels belong to the runtime family: `minimal` exists only on pi and
 * `ultracode` only on Claude. Validating against a union would accept a level
 * the target runtime silently clamps away, which is the exact failure mode this
 * wrapper exists to prevent. `family` defaults to pi, which predates Claude.
 */
export function validateThinking(thinking, family = "pi") {
	const levels = THINKING_LEVELS_BY_FAMILY[family] ?? THINKING_LEVELS_BY_FAMILY.pi;
	if (typeof thinking !== "string" || !levels.includes(thinking)) {
		throw usageError(
			`--thinking must be one of ${levels.join(" | ")} for the ${family} family (got "${thinking}")`,
		);
	}
	return thinking;
}

/**
 * Same string as `TEAM_CLUSTER_LABEL` in policy-core.ts, kept as a LOCAL
 * literal rather than an import: `run` needs it to validate an already-parsed
 * argv, which is pure and must stay usable from `--help`/read commands with no
 * policy-core dependency at all (installer-contract.test.mjs proves those
 * still work when the core is not even shipped alongside this file). `main()`
 * asserts the two spellings match wherever it DOES load the core, below, so a
 * drift is a loud CI failure rather than a silent divergence between the two
 * checks a Lead's create_agent goes through.
 */
export const TEAM_CLUSTER_LABEL = "team.cluster";

/**
 * Parse repeated `--label key=value` flags (as accumulated by parseArgs) into
 * `{ key, value }` pairs. Fail-closed: a flag with no value, a value missing
 * "=", or a key repeated across two `--label` flags is a config error that
 * must not silently drop or overwrite a label on the agent about to be
 * created on a REMOTE host — there is no create_agent argument guard out
 * there to catch it afterwards.
 */
export function parseRunLabels(raw) {
	const list = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
	const seen = new Set();
	return list.map((entry) => {
		if (typeof entry !== "string" || entry.trim() === "") {
			throw usageError(
				`--label requires a value in the form <key>=<value> (got ${JSON.stringify(entry)})`,
			);
		}
		const eq = entry.indexOf("=");
		if (eq <= 0) {
			throw usageError(`--label must be <key>=<value> (got "${entry}")`);
		}
		const key = entry.slice(0, eq).trim();
		const value = entry.slice(eq + 1);
		if (seen.has(key)) {
			throw usageError(`--label "${key}" was passed more than once`);
		}
		seen.add(key);
		return { key, value };
	});
}

/** Max prompt length for a single argv element (Windows CreateProcess limit). */
export const MAX_PROMPT_LENGTH = 20000;

/**
 * Parse a paseo duration string ("30s", "2m", "1h", "500ms", "90") to ms.
 * Returns null when unparseable.
 */
export function parseDurationMs(value) {
	const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/.exec(String(value).trim());
	if (!match) return null;
	const mult = { ms: 1, s: 1000, m: 60000, h: 3600000 }[match[2] ?? "s"];
	return Number(match[1]) * mult;
}

function sleepSync(ms) {
	if (ms <= 0) return;
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function parseCliJson(result) {
	if (!result?.ok) return null;
	try {
		return JSON.parse(result.stdout);
	} catch {
		return null;
	}
}

function unwrapStatusPayload(data) {
	if (Array.isArray(data)) return data[0] ?? null;
	return data?.data ?? data;
}

function identityValue(value) {
	return typeof value === "string" && value.trim() !== "" ? value : null;
}

export function extractRuntimeIdentity(data) {
	const runtime =
		data?.snapshot?.runtimeInfo ??
		data?.snapshot?.RuntimeInfo ??
		data?.runtimeInfo ??
		data?.RuntimeInfo ??
		data?.data?.snapshot?.runtimeInfo ??
		data?.data?.runtimeInfo ??
		data?.data ??
		data;
	return {
		model: identityValue(runtime?.model ?? runtime?.Model),
		thinking: identityValue(
			runtime?.thinkingOptionId ??
			runtime?.ThinkingOptionId ??
			runtime?.thinking ??
			runtime?.Thinking,
		),
	};
}

/**
 * Poll a newly-created background agent until its runtime identity is ready.
 * Missing identity is a startup condition, not a mismatch. Only an explicit
 * model/thinking value that differs from the request is a confirmed mismatch.
 */
export function waitForRuntimeIdentity({
	status,
	requested,
	timeoutMs = DEFAULT_STARTUP_IDENTITY_TIMEOUT_MS,
	intervalMs = STARTUP_IDENTITY_POLL_INTERVAL_MS,
	now = () => performance.now(),
	sleep = sleepSync,
	maxAttempts = MAX_STARTUP_IDENTITY_ATTEMPTS,
}) {
	const boundedTimeoutMs = Math.min(
		MAX_STARTUP_IDENTITY_TIMEOUT_MS,
		Number.isFinite(timeoutMs) ? Math.max(0, timeoutMs) : 0,
	);
	const boundedIntervalMs = Number.isFinite(intervalMs) ? Math.max(0, intervalMs) : 0;
	const boundedMaxAttempts = Number.isFinite(maxAttempts)
		? Math.max(1, Math.floor(maxAttempts))
		: MAX_STARTUP_IDENTITY_ATTEMPTS;
	const deadline = now() + boundedTimeoutMs;
	let attempts = 0;
	let last = null;
	while (attempts < boundedMaxAttempts) {
		const remainingMs = Math.max(0, deadline - now());
		if (attempts > 0 && remainingMs <= 0) break;
		attempts++;
		const result = status({ attempt: attempts, remainingMs });
		last = result;
		const data = unwrapStatusPayload(parseCliJson(result));
		const observed = extractRuntimeIdentity(data);
		if (observed.model !== null && observed.thinking !== null) {
			if (observed.model !== requested.model || observed.thinking !== requested.thinking) {
				return { state: "mismatch", attempts, observed, result };
			}
			return { state: "ready", attempts, observed, result };
		}
		const remainingAfterStatus = Math.max(0, deadline - now());
		if (remainingAfterStatus <= 0) break;
		sleep(Math.min(boundedIntervalMs, remainingAfterStatus));
	}
	return { state: "unavailable", attempts, result: last };
}

export function readPrompt(opts) {
	const hasPrompt = typeof opts.prompt === "string" && opts.prompt.length > 0;
	const hasBrief = typeof opts.brief === "string" && opts.brief.length > 0;
	if (hasPrompt && hasBrief) {
		throw usageError("pass either --prompt or --brief, not both");
	}
	let prompt = "";
	if (hasBrief) {
		if (!existsSync(opts.brief)) {
			throw usageError(`--brief file not found: ${opts.brief}`);
		}
		prompt = readFileSync(opts.brief, "utf8");
	} else if (hasPrompt) {
		prompt = opts.prompt;
	}
	prompt = prompt.trim();
	if (!prompt) {
		throw usageError(
			"a non-empty prompt is required (--prompt <text> or --brief <file>)",
		);
	}
	if (prompt.length > MAX_PROMPT_LENGTH) {
		throw new RemoteError(
			"PROMPT_TOO_LONG",
			`prompt is ${prompt.length} chars (max ${MAX_PROMPT_LENGTH}) — the value travels as one Windows command-line argument; split the task or use a shorter brief`,
			{ promptLength: prompt.length, max: MAX_PROMPT_LENGTH },
		);
	}
	return prompt;
}

// ---------------------------------------------------------------------------
// Paseo CLI argv construction
// ---------------------------------------------------------------------------

/**
 * Build the exact paseo CLI argv for a remote command. `endpoint` is the
 * secret endpoint VALUE — it must never leave this function except inside the
 * argv handed to the subprocess (and the `--dry-run` display, redacted).
 */
export function buildArgv(command, opts, endpoint) {
	const ep = ["--host", endpoint];
	switch (command) {
		case "health":
			return ["ls", ...ep, "--json"];
		case "providers":
			return ["provider", "ls", ...ep, "--json"];
		case "models": {
			if (typeof opts.provider !== "string" || opts.provider.trim() === "") {
				throw usageError("models requires --provider <role-provider>");
			}
			return ["provider", "models", opts.provider.trim(), ...ep, "--json"];
		}
		case "workspaces":
			return ["workspace", "ls", ...ep, "--json"];
		case "workspace-create": {
			if (typeof opts.path !== "string" || opts.path.trim() === "") {
				throw usageError(
					"workspace-create requires --path <path-on-remote-host> (a remote workspace from the controller's cwd makes no sense)",
				);
			}
			const argv = ["workspace", "create", ...ep];
			argv.push("--path", opts.path.trim());
			const isolation =
				typeof opts.isolation === "string" && opts.isolation.trim() !== ""
					? opts.isolation.trim()
					: "";
			if (isolation && isolation !== "local" && isolation !== "worktree") {
				throw usageError(
					`--isolation must be "local" or "worktree" (got "${isolation}")`,
				);
			}
			const disposition =
				typeof opts.disposition === "string" ? opts.disposition.trim() : "";
			// Fail closed on typos: a misspelled reviewer disposition must never
			// silently skip the worktree enforcement below.
			if (disposition && !WORKSPACE_DISPOSITIONS.includes(disposition)) {
				throw usageError(
					`--disposition must be one of ${WORKSPACE_DISPOSITIONS.join(", ")} (got "${disposition}")`,
				);
			}
			let effectiveIsolation = isolation;
			// Reviewer isolation is an invariant, not a preference: an
			// independent-reviewer workspace is ALWAYS a git worktree. If the
			// worktree cannot be created on the target host, the caller reports
			// BLOCKED: REVIEW_WORKTREE_UNAVAILABLE — it never falls back to a
			// local/standalone workspace that ocr-review.mjs would reject anyway.
			if (disposition === "independent-reviewer") {
				if (isolation && isolation !== "worktree") {
					throw new RemoteError(
						"REVIEW_ISOLATION_INVALID",
						`an independent-reviewer workspace requires --isolation worktree (got "${isolation}"); if a worktree cannot be created, report BLOCKED: REVIEW_WORKTREE_UNAVAILABLE instead of falling back`,
						{ disposition, isolation },
					);
				}
				effectiveIsolation = "worktree";
			}
			if (effectiveIsolation) {
				argv.push("--isolation", effectiveIsolation);
			}
			if (typeof opts.title === "string" && opts.title.trim() !== "") {
				argv.push("--title", opts.title.trim());
			}
			if (typeof opts.project === "string" && opts.project.trim() !== "") {
				argv.push("--project", opts.project.trim());
			}
			argv.push("--json");
			return argv;
		}
		case "agents": {
			const argv = ["ls", ...ep, "-g", "--json"];
			if (opts.all) argv.splice(1, 0, "-a");
			return argv;
		}
		case "run": {
			const { provider, family } = validateRunProvider(opts.provider);
			validateThinking(opts.thinking, family);
			// Permission modes belong to the provider and are NOT inherited from
			// the caller: whenever the target provider declares modes and its id
			// differs from the caller's (in this pack it always does — lead and
			// peer are different profiles), Paseo refuses the create outright.
			// pi declares no modes, so only the Claude family needs one.
			//
			// The default is CLAUDE_DEFAULT_MODE ("auto"), not "default". On
			// "default" every one of the new seat's tool calls parks in the
			// pending-permission queue, so the seat does nothing until someone
			// triages it one call at a time — the seat looks hung, and the Lead
			// spends its turn clicking instead of leading. What bounds a seat
			// here is the role policy, which is enforced before any of this; the
			// permission queue only decides how often a human is interrupted
			// while the seat does already-bounded work. Pass --mode explicitly to
			// narrow it (plan, default, acceptEdits).
			const mode =
				typeof opts.mode === "string" && opts.mode.trim() !== ""
					? opts.mode.trim()
					: family === "claude"
						? CLAUDE_DEFAULT_MODE
						: null;
			if (typeof opts.workspace !== "string" || opts.workspace.trim() === "") {
				throw usageError(
					"run requires --workspace <id> — the remote workspace id from `workspaces`/`workspace-create` (a remote agent without a workspace would run in the controller's cwd)",
				);
			}
			// §PR-G follow-up: no code path ever stamped team.cluster at creation
			// time, so a remotely-created seat fell back to workspaceId/cwd for its
			// cluster — wrong the moment two projects share a host. main() fills
			// this in automatically from this seat's own cluster (selfCluster())
			// before calling buildArgv; this check is the fail-closed backstop for
			// a caller that bypasses main() (a direct buildArgv call, or a future
			// auto-fill that could not resolve one), symmetric with the --mode
			// refusal above.
			const labels = parseRunLabels(opts.label);
			if (!labels.some((entry) => entry.key === TEAM_CLUSTER_LABEL)) {
				throw usageError(
					`run requires a "${TEAM_CLUSTER_LABEL}" label — pass --label ${TEAM_CLUSTER_LABEL}=<value> (this seat's own cluster). Every cluster-scoped rule (SUPERVISOR_DECISION, the scope-lease board) reads it from the created agent's state; without it the new seat is orphaned from its own Lead's cluster the moment workspaceId/cwd diverge (e.g. a reviewer worktree).`,
				);
			}
			const prompt = readPrompt(opts);
			const argv = [
				"run",
				...ep,
				"--provider",
				provider,
				"--thinking",
				opts.thinking,
			];
			if (mode) argv.push("--mode", mode);
			if (typeof opts.workspace === "string" && opts.workspace.trim() !== "") {
				argv.push("--workspace", opts.workspace.trim());
			}
			if (typeof opts.title === "string" && opts.title.trim() !== "") {
				argv.push("--title", opts.title.trim());
			}
			for (const { key, value } of labels) {
				argv.push("--label", `${key}=${value}`);
			}
			const waitTimeout =
				typeof opts.waitTimeout === "string" && opts.waitTimeout.trim() !== "";
			if (opts.background && waitTimeout) {
				throw usageError(
					"pass either --background (default) or --wait-timeout <dur>, not both",
				);
			}
			argv.push(waitTimeout ? "--wait-timeout" : "-d");
			if (waitTimeout) argv.push(opts.waitTimeout.trim());
			argv.push("--json");
			argv.push(prompt);
			return argv;
		}
		case "status": {
			const { agentId } = splitAgentRef(opts.agentRef);
			return ["inspect", agentId, ...ep, "--json"];
		}
		case "cancel": {
			const { agentId } = splitAgentRef(opts.agentRef);
			return ["stop", agentId, ...ep, "--json"];
		}
		case "archive": {
			const { agentId } = splitAgentRef(opts.agentRef);
			return ["archive", agentId, ...ep, "--json"];
		}
		case "send": {
			const { agentId } = splitAgentRef(opts.agentRef);
			const argv = ["send", agentId, ...ep];
			const hasPrompt =
				typeof opts.prompt === "string" && opts.prompt.length > 0;
			const hasPromptFile =
				typeof opts.promptFile === "string" && opts.promptFile.length > 0;
			if (hasPrompt && hasPromptFile) {
				throw usageError("pass either --prompt or --prompt-file, not both");
			}
			if (hasPromptFile) {
				if (!existsSync(opts.promptFile)) {
					throw usageError(`--prompt-file not found: ${opts.promptFile}`);
				}
				argv.push("--prompt-file", opts.promptFile);
			} else if (hasPrompt) {
				if (opts.prompt.length > MAX_PROMPT_LENGTH) {
					throw new RemoteError(
						"PROMPT_TOO_LONG",
						`prompt is ${opts.prompt.length} chars (max ${MAX_PROMPT_LENGTH}) — use --prompt-file <file> for long messages`,
						{ promptLength: opts.prompt.length, max: MAX_PROMPT_LENGTH },
					);
				}
				argv.push("--prompt", opts.prompt);
			} else {
				throw usageError(
					"send requires --prompt <text> or --prompt-file <file>",
				);
			}
			if (opts.wait !== true) argv.push("--no-wait");
			argv.push("--json");
			return argv;
		}
		default:
			throw usageError(`unknown command "${command}"`);
	}
}

// ---------------------------------------------------------------------------
// CLI executable resolution (no shell on Windows)
// ---------------------------------------------------------------------------

/** Parse the npm .cmd shim for the real `node ... entry.js` invocation.
 * Kept at this name because the remote-paseo tests pin the contract here. */
export function resolveCmdEntry(shimPath) {
	return resolveCmdEntryFromShim(shimPath, PASEO_CONVENTIONAL_ENTRIES);
}

/** Shared resolution, with a bad PASEO_TEAM_PASEO_EXEC mapped onto this
 * module's USAGE error contract instead of a bare Error. */
export function resolvePaseoExec() {
	return resolvePaseoExecShared((reason) => {
		throw new RemoteError("USAGE", `PASEO_TEAM_PASEO_EXEC ${reason}`);
	});
}

/**
 * Run the paseo CLI with a fully-specified argv. No shell on any platform;
 * the secret endpoint value travels inside argv only.
 */
export function runCli(argv, { timeoutMs = 120000, secret = "", maxAttempts = 3 } = {}) {
	const [bin, ...prefix] = resolvePaseoExec();
	const redact = (text) =>
		secret
			? String(text).split(secret).join("<endpoint-value-redacted>")
			: String(text);
	for (let attempt = 0; attempt < Math.max(1, maxAttempts); attempt++) {
	try {
		const stdout = execFileSync(bin, [...prefix, ...argv], {
			encoding: "utf8",
			timeout: timeoutMs,
			maxBuffer: 16 * 1024 * 1024,
			stdio: ["ignore", "pipe", "pipe"],
			env: process.env,
			windowsHide: true,
		});
		return { ok: true, stdout: redact(stdout), status: 0, attempts: attempt + 1 };
	} catch (error) {
		const failure = {
			ok: false,
			status: typeof error?.status === "number" ? error.status : 1,
			stdout: error?.stdout ? redact(error.stdout) : "",
			stderr: error?.stderr ? redact(error.stderr) : "",
			error: redact(error?.message ? String(error.message).split("\n")[0] : String(error)),
		};
		const retryable = classifyRemoteFailure(failure) === "retryable";
		if (!retryable || attempt + 1 >= Math.max(1, maxAttempts)) {
			return { ...failure, attempts: attempt + 1 };
		}
		const delayMs = Math.min(2000, 250 * 2 ** attempt);
		if (delayMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
	}
	}
	return { ok: false, status: 1, stdout: "", error: "retry exhausted", attempts: maxAttempts };
}

// ---------------------------------------------------------------------------
// Output envelope
// ---------------------------------------------------------------------------

class EmitExit extends Error {}

function emit(payload, exitCode) {
	// stdout may contain a large JSON response. Setting exitCode lets Node drain
	// the stream instead of terminating synchronously via process.exit().
	process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
	process.exitCode = exitCode;
	throw new EmitExit();
}

const COMMANDS = new Set([
	"health",
	"providers",
	"models",
	"workspaces",
	"workspace-create",
	"agents",
	"run",
	"status",
	"cancel",
	"archive",
	"send",
]);

const HELP = `remote-paseo.mjs — drive a REMOTE Paseo daemon from the controller (Lead).

The MCP server injected into this agent only talks to the LOCAL daemon. For a
remote host (connection.type: "remote" in cluster-routing.local.json) use this
wrapper; it resolves the endpoint env var, validates everything, and never
prints the endpoint value.

Commands:
  health           --host-id <id>
  providers        --host-id <id>
  models           --host-id <id> --provider <role-provider>
  workspaces       --host-id <id>
  workspace-create --host-id <id> --path <path> [--isolation local|worktree]
                   [--disposition <d>] [--title <t>] [--project <id>]
                   --disposition independent-reviewer forces --isolation worktree
                   (reviewer isolation is an invariant; local is rejected)
  agents           --host-id <id> [--all]
  run              --host-id <id> --provider <role-provider>/<pi-provider>/<model-id>
                   --thinking <level> --workspace <wks-id> [--title <t>]
                   [--label <key>=<value> ...] [--prompt <text> | --brief <file>]
                   [--wait-timeout <dur>] [--startup-timeout <dur>] [--mode <m>]
                   a team.cluster label is required; filled in automatically
                   from this seat's own cluster when --label does not set one
                   claude-* routes need a permission mode (Paseo never inherits
                   one across providers); omitting --mode sends "auto"
  status           --agent-ref <host-id>/<agent-id>
  cancel           --agent-ref <host-id>/<agent-id>
  archive          --agent-ref <host-id>/<agent-id>
  send             --agent-ref <host-id>/<agent-id>
                   [--prompt <text> | --prompt-file <file>] [--wait]

Common:
  --cluster <path>   cluster routing config (default ~/.paseo-pi-team/cluster-routing.local.json)
  --dry-run          print the paseo argv (endpoint redacted) without executing
  --help             this help

Output: one JSON envelope on stdout (ok, command, hostId, endpointEnv,
endpointSet, data). Exit: 0 ok · 1 usage/config/env · 2 CLI runtime error.`;

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

/** Compare canonical filesystem paths so macOS /var aliases work. */
export function isMainModule(entry = process.argv[1], moduleUrl = import.meta.url) {
	return isEntrypoint(moduleUrl, entry);
}

function basePayload(command, hostInfo) {
	const payload = { ok: true, command };
	if (hostInfo) {
		payload.hostId = hostInfo.hostId;
		payload.endpointEnv = hostInfo.endpointEnv;
		payload.endpointSet = true;
	}
	return payload;
}

async function main() {
	let parsed;
	try {
		parsed = parseArgs(process.argv.slice(2));
	} catch (error) {
		emit(
			{
				ok: false,
				code: "USAGE",
				message: error.message,
				details: error.details,
			},
			1,
		);
	}
	if (parsed.help) {
		console.log(HELP);
		process.exitCode = 0;
		return;
	}
	const command = parsed._[0];
	if (!command || !COMMANDS.has(command)) {
		emit(
			{
				ok: false,
				code: "USAGE",
				message: `expected one of: ${[...COMMANDS].join(", ")} (got "${command ?? "<none>"}")`,
			},
			1,
		);
	}
	try {
		validateFlags(command, parsed);
	} catch (error) {
		emit(
			{
				ok: false,
				code: error.code ?? "USAGE",
				message: error.message,
				...(error.details ?? {}),
			},
			1,
		);
	}

	// A run's team.cluster label is filled in HERE, not inside buildArgv: the
	// value comes from this seat's own selfCluster() (policy-core), and
	// buildArgv stays a pure function testable with plain literal opts, no
	// policy-core dependency, so --help and every other command keep working in
	// a layout where the core is not even shipped alongside this file (see
	// installer-contract.test.mjs's flat-copy case). Loaded lazily and only for
	// `run`, for the same reason.
	if (command === "run") {
		const existingLabels = Array.isArray(parsed.label)
			? parsed.label
			: parsed.label !== undefined
				? [parsed.label]
				: [];
		const hasOwnClusterLabel = existingLabels.some((entry) => {
			if (typeof entry !== "string") return false;
			const eq = entry.indexOf("=");
			return eq > 0 && entry.slice(0, eq).trim() === TEAM_CLUSTER_LABEL;
		});
		if (!hasOwnClusterLabel) {
			// Import failure is soft: the core may not be shipped alongside this
			// file in every layout, and a run that cannot auto-fill still gets
			// buildArgv's own requirement below — one clear refusal naming
			// --label, not a module-resolution error that says nothing about the
			// fix.
			let core = null;
			try {
				core = await importPolicyCore();
			} catch {
				core = null;
			}
			if (core) {
				if (core.TEAM_CLUSTER_LABEL !== TEAM_CLUSTER_LABEL) {
					// NOT caught below on purpose: two spellings of the same label
					// silently splitting one axis into two is worse than a crashed
					// run, and this is a packaging bug, not a user mistake.
					throw new Error(
						`remote-paseo.mjs's TEAM_CLUSTER_LABEL ("${TEAM_CLUSTER_LABEL}") has drifted from policy-core's ("${core.TEAM_CLUSTER_LABEL}")`,
					);
				}
				let own = null;
				try {
					own = core.selfCluster();
				} catch {
					own = null;
				}
				if (own) parsed.label = [...existingLabels, `${TEAM_CLUSTER_LABEL}=${own}`];
			}
		}
	}

	let cluster;
	try {
		cluster = loadClusterConfig(parsed.cluster);
	} catch (error) {
		const details = error instanceof RoutingError ? error.details : {};
		emit(
			{
				ok: false,
				code: "CLUSTER_CONFIG_INVALID",
				message: error instanceof RoutingError ? error.message : String(error),
				details,
				clusterPath: parsed.cluster,
			},
			1,
		);
	}

	let hostInfo = null;
	try {
		if (
			command === "status" ||
			command === "cancel" ||
			command === "archive" ||
			command === "send"
		) {
			// Agent-ref commands resolve the host from the ref prefix.
			const { hostId, agentId, endpoint, endpointEnv } = parseAgentRef(
				parsed.agentRef,
				cluster,
			);
			parsed.agentId = agentId;
			hostInfo = { hostId, endpointEnv, endpoint };
		} else {
			hostInfo = resolveHost(cluster, parsed.hostId);
		}
	} catch (error) {
		emit(
			{
				ok: false,
				code: error.code ?? "ERROR",
				message: error.message,
				...(error.details ?? {}),
			},
			1,
		);
	}

	let argv;
	try {
		argv = buildArgv(command, parsed, hostInfo.endpoint);
	} catch (error) {
		emit(
			{
				ok: false,
				code: error.code ?? "USAGE",
				message: error.message,
				...(error.details ?? {}),
			},
			1,
		);
	}

	if (parsed.dryRun) {
		const redactedArgv = argv.map((a) =>
			a === hostInfo.endpoint ? `<redacted:${hostInfo.endpointEnv}>` : a,
		);
		emit(
			{ ...basePayload(command, hostInfo), dryRun: true, argv: redactedArgv },
			0,
		);
	}

	// run --wait-timeout can legitimately exceed the default 120s subprocess
	// timeout: scale the child timeout to the requested duration (+60s buffer).
	// An invalid duration is a wrapper usage error; it must never disable the
	// subprocess timeout by becoming `0`.
	let timeoutMs = 120000;
	if (command === "run" && typeof parsed.waitTimeout === "string") {
		const parsedWait = parseDurationMs(parsed.waitTimeout);
		if (parsedWait === null || !Number.isFinite(parsedWait) || parsedWait <= 0) {
			emit({ ok: false, code: "USAGE", message: `--wait-timeout must be a positive duration (got "${parsed.waitTimeout}")` }, 1);
		}
		timeoutMs = parsedWait + 60000;
	}
	let startupTimeoutMs = DEFAULT_STARTUP_IDENTITY_TIMEOUT_MS;
	if (command === "run" && typeof parsed.startupTimeout === "string") {
		const parsedStartup = parseDurationMs(parsed.startupTimeout);
		if (
			parsedStartup === null ||
			!Number.isFinite(parsedStartup) ||
			parsedStartup <= 0 ||
			parsedStartup > MAX_STARTUP_IDENTITY_TIMEOUT_MS
		) {
			emit({ ok: false, code: "USAGE", message: `--startup-timeout must be a positive duration no greater than ${MAX_STARTUP_IDENTITY_TIMEOUT_MS}ms (got "${parsed.startupTimeout}")` }, 1);
		}
		startupTimeoutMs = parsedStartup;
	}

	const retryableReadCommand = new Set([
		"health",
		"providers",
		"models",
		"workspaces",
		"agents",
		"status",
	]).has(command);
	const result = runCli(argv, {
		secret: hostInfo.endpoint,
		timeoutMs,
		maxAttempts: retryableReadCommand ? 3 : 1,
	});
	const payload = basePayload(command, hostInfo);
	if (!result.ok) {
		payload.ok = false;
		// A failed reviewer worktree creation is the specific blocker the Lead
		// skill keys recovery on — surface it as REVIEW_WORKTREE_UNAVAILABLE, not
		// a generic CLI_ERROR. There is no fallback to a local workspace.
		const reviewerWorkspaceCreate =
			command === "workspace-create" &&
			typeof parsed.disposition === "string" &&
			parsed.disposition.trim() === "independent-reviewer";
		payload.code = reviewerWorkspaceCreate
			? "REVIEW_WORKTREE_UNAVAILABLE"
			: "CLI_ERROR";
		payload.message = reviewerWorkspaceCreate
			? `reviewer worktree workspace could not be created on host "${hostInfo.hostId}" — report BLOCKED: REVIEW_WORKTREE_UNAVAILABLE; never fall back to a local/standalone workspace (${result.error || `paseo exit ${result.status}`})`
			: result.error ||
				`paseo ${command} failed with exit ${result.status} (stderr redacted)`;
		if (result.stdout) payload.data = result.stdout;
		emit(payload, 2);
	}

	if (command === "run") {
		let parsedOut;
		try {
			parsedOut = JSON.parse(result.stdout);
		} catch {
			parsedOut = { raw: result.stdout };
		}
		payload.data = parsedOut;
		if (!parsedOut || typeof parsedOut.agentId !== "string" || parsedOut.agentId.trim() === "") {
			payload.ok = false;
			payload.code = "AGENT_REF_UNAVAILABLE";
			payload.message = "remote run did not return an agent id; agent was not archived because its lifecycle identity is unavailable";
			emit(payload, 2);
		}
		if (parsedOut && typeof parsedOut.agentId === "string") {
			payload.agentRef = `${hostInfo.hostId}/${parsedOut.agentId}`;
			const statusRef = `${hostInfo.hostId}/${parsedOut.agentId}`;
			const requested = validateRunProvider(parsed.provider);
			const identity = waitForRuntimeIdentity({
				requested: {
					model: requested.model,
					thinking: parsed.thinking,
				},
				status: ({ remainingMs }) => runCli(buildArgv("status", { agentRef: statusRef }, hostInfo.endpoint), {
					secret: hostInfo.endpoint,
					timeoutMs: Math.max(1, Math.floor(Math.min(120000, remainingMs || 1))),
					maxAttempts: 1,
				}),
				timeoutMs: startupTimeoutMs,
			});
			payload.startupIdentity = {
				state: identity.state,
				attempts: identity.attempts,
				...(identity.observed ? { observed: identity.observed } : {}),
				...(identity.state === "unavailable" && identity.result
					? { lastStatus: identity.result }
					: {}),
			};
			if (identity.state === "unavailable") {
				payload.ok = false;
				payload.code = "STARTUP_IDENTITY_UNAVAILABLE";
				payload.message = "runtime identity was not available within the startup timeout; agent was not archived";
				emit(payload, 2);
			}
			if (identity.state === "mismatch") {
				const archive = runCli(buildArgv("archive", { agentRef: statusRef }, hostInfo.endpoint), {
					secret: hostInfo.endpoint,
					timeoutMs: 120000,
					maxAttempts: 1,
				});
				payload.ok = false;
				payload.code = "MODEL_RESOLUTION_MISMATCH";
				payload.message = archive.ok
					? "observed runtime identity differs from the requested route; confirmed mismatching agent was archived"
					: "observed runtime identity differs from the requested route; archive attempt failed and the agent may still be active";
				payload.archive = {
					ok: archive.ok,
					attempts: archive.attempts,
					...(archive.status !== undefined ? { status: archive.status } : {}),
					...(archive.error ? { error: archive.error } : {}),
				};
				emit(payload, 2);
			}
		}
	} else {
		try {
			payload.data = JSON.parse(result.stdout);
		} catch {
			payload.data = { raw: result.stdout };
		}
	}
	emit(payload, 0);
}

if (isMainModule()) {
	// main() is async (the run command's cluster-label auto-fill loads
	// policy-core lazily), so a synchronous try/catch around a bare call would
	// no longer see errors thrown after the first await — including emit()'s
	// own EmitExit, once a run reaches that point. Every throw, before or after
	// an await, now surfaces as a rejection of the promise main() returns.
	main().catch((error) => {
		if (!(error instanceof EmitExit)) throw error;
	});
}
