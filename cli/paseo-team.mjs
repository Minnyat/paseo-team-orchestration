#!/usr/bin/env node
/**
 * paseo-team.mjs — the CLI that owns every paseo-team-orchestration config path.
 *
 * Everything paseo-team-orchestration configures is read/written here and only here; the
 * WebUI extension is a *client* that spawns this binary with a subcommand and
 * renders the JSON it returns. It never touches the filesystem itself.
 *
 * The preview CLI contract:
 *
 *   paseo-team status                  -> machine-readable snapshot of paths + presence
 *   paseo-team preflight    [--strict|--json|--skip-models|--runtime pi|claude|both|--host-id <id>|--cluster <p>|--routes <p>]
 *   paseo-team claude-setup [--install|--apply|--verify|--uninstall|--print-providers] [--json] [--force]
 *   paseo-team config read  <section>  -> full JSON of that section (stdout)
 *   paseo-team config write <section>  -> full JSON of that section from stdin, atomic+backup
 *   paseo-team prompts read <role>     -> markdown body (JSON-wrapped)
 *   paseo-team prompts write <role>    -> markdown body from stdin, atomic+backup
 *   paseo-team skills list             -> [{ name, path, pack }]
 *   paseo-team skills read <name>      -> SKILL.md body (JSON-wrapped)
 *   paseo-team skills write <name>     -> SKILL.md body from stdin
 *   paseo-team cost [--all|--cluster <id>]        -> per-agent + summed cost for one cluster
 *   paseo-team activity <ref> [--tail|--max-chars] -> one agent's activity, capped PER ENTRY
 *   paseo-team env list                -> documented env knobs + process values + target file
 *   paseo-team install                            -> delegate to the bundled installer
 *
 * Every command emits a single JSON object (or JSON for read bodies). Non-JSON
 * errors go to stderr and the process exits non-zero.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, appendFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as cw from "./lib/config-walker.mjs";
import { schemaForSection, withModelInventory, ROUTING_SECTIONS } from "./lib/config-schema.mjs";
import {
	applySeatsToPaseoConfig,
	listSeats,
	materializeSeats,
	seatLedgerPath,
	seatsPath,
	resolveSeatGrants,
	seatProviderName,
	validateSeats,
	baseRole,
	SEAT_CAPABILITIES,
} from "../scripts/seat-profiles.mjs";
import { runPaseoJson, runPaseoText, mapWithConcurrency, refreshProviderSnapshot, PaseoError } from "./lib/paseo-bridge.mjs";
import { describeProtocolState, protocolState } from "./lib/workspace-protocol.mjs";
import {
	ROLE_PROVIDERS,
	RUNTIME_FAMILIES,
	PROVIDER_OK_STATUSES,
	buildProviderInventory,
	normalizeModelEntry,
	providerFamily,
} from "../scripts/model-routing.mjs";
import { configProblems, normalizeConfig, resolveApiKey, syncModels } from "../scripts/pi-models-sync.mjs";
import * as graphCache from "./lib/graph-cache.mjs";
import { collectGraph, inferRole, inferSeat, normalizePermits } from "./lib/graph.mjs";
import { readAgentStates, isAgentId } from "./lib/agent-state.mjs";
import { agentCluster, normalizeCluster } from "../extensions/paseo-team-core/policy-core.js";
import * as su from "./lib/self-update.mjs";
import * as un from "./lib/uninstall.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function fail(msg, code = 1) {
	process.stderr.write(`[paseo-team] ${msg}\n`);
	process.exit(code);
}

/**
 * Exit code for "you typed something this CLI does not accept".
 *
 * 2 is usage, 1 is an operation that ran and failed — the distinction a script
 * keys on to tell a typo from a daemon that is down. The top-level dispatcher
 * and `seats` already used 2 while every other subcommand dispatcher used 1,
 * so one question had two answers depending on which noun you got wrong.
 */
const USAGE = 2;
const usageFail = (msg) => fail(msg, USAGE);

function json(obj) {
	process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
}

function readStdin() {
	try {
		return readFileSync(0, "utf8");
	} catch (e) {
		fail(`failed to read stdin: ${e.message}`);
	}
	return "";
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

function cmdStatus() {
	const paseoCfg = cw.readJsonOrNull(cw.paseoConfigPath());
	const providers = paseoCfg?.agents?.providers ?? {};
	json({
		repoRoot: ROOT,
		version: su.currentVersion(),
		pi: { home: cw.piHome(), agentDir: cw.agentDir() },
		paths: {
			paseoConfig: cw.paseoConfigPath(),
			mcpConfig: cw.mcpConfigPath(),
			promptsDir: cw.promptsDir(),
			skillsDir: cw.skillsDir(),
			policyExtension: cw.policyExtensionPath(),
			routing: join(cw.teamConfigDir(), "model-routing.local.json"),
			cluster: join(cw.teamConfigDir(), "cluster-routing.local.json"),
		},
		presence: {
			paseoConfig: cw.readJsonOrNull(cw.paseoConfigPath()) !== null,
			mcpConfig: cw.readJsonOrNull(cw.mcpConfigPath()) !== null,
			policyExtension: existsSync(cw.policyExtensionPath()),
			routing: existsSync(join(cw.teamConfigDir(), "model-routing.local.json")),
			cluster: existsSync(join(cw.teamConfigDir(), "cluster-routing.local.json")),
			prompts: Object.fromEntries(
				cw.ROLE_PROMPTS.map((r) => [r, existsSync(cw.rolePromptPath(r))])
			),
		},
		// The pack owns exactly ROLE_PROVIDERS. Filtering by `extends === "pi"`
		// hid every claude-* role profile even when the daemon had it registered,
		// which made a mixed-runtime install look like a pi-only one.
		roleProfiles: ROLE_PROVIDERS.filter((name) => providers[name] !== undefined),
		docs: "docs/webui-architecture.md",
	});
}

// ---------------------------------------------------------------------------
// preflight (delegate to the bundled script)
// ---------------------------------------------------------------------------

function cmdPreflight(argv) {
	// Strip a no-op --json (script accepts it) and pass the rest through.
	const res = spawnSync(process.execPath, [join(ROOT, "scripts", "preflight.mjs"), ...argv], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (res.error) fail(`preflight failed to start: ${res.error.message}`);
	if (res.stderr) process.stderr.write(res.stderr);
	if (res.stdout) process.stdout.write(res.stdout);
	process.exit(res.status ?? 1);
}

// ---------------------------------------------------------------------------
// live model inventory (feeds the routing/cluster forms and `pteam models`)
// ---------------------------------------------------------------------------

/**
 * The Paseo CLI reports some daemon failures as a *successful* JSON body
 * `{ "error": { code, message } }` rather than a non-zero exit, so
 * runPaseoJson resolves instead of rejecting. Every inventory read goes
 * through here: an error envelope that reached a caller as data would be
 * counted as "zero models available", which is a silent wrong answer.
 */
function paseoErrorEnvelope(payload) {
	if (Array.isArray(payload) || payload === null || typeof payload !== "object") {
		return null;
	}
	const error = payload.error;
	if (error === undefined || error === null) return null;
	if (typeof error === "string") return { code: "CLI_ERROR", message: error };
	return {
		code: typeof error.code === "string" ? error.code : "CLI_ERROR",
		message: String(error.message ?? "paseo reported an error"),
	};
}

/** Model ids of one role provider, or a structured fault. Never throws. */
async function listProviderModels(roleProvider, timeoutMs) {
	try {
		const payload = await runPaseoJson(["provider", "models", roleProvider], { timeoutMs });
		const envelope = paseoErrorEnvelope(payload);
		if (envelope) return { ok: false, provider: roleProvider, ...envelope };
		const models = (Array.isArray(payload) ? payload : [])
			.map(normalizeModelEntry)
			.filter(Boolean);
		return { ok: true, provider: roleProvider, models };
	} catch (error) {
		return {
			ok: false,
			provider: roleProvider,
			code: error instanceof PaseoError ? error.code : "PASEO_FAILED",
			message: String(error?.message ?? error),
		};
	}
}

/**
 * Discover which models each role provider can actually be routed to.
 *
 * Cost discipline (see paseo-bridge.mjs): one `paseo` invocation costs ~3s of
 * process startup, so this issues at most 1 + RUNTIME_FAMILIES.length calls —
 * `provider ls` once, then `provider models` once per family, using the first
 * REGISTERED, ENABLED and HEALTHY role provider of that family as the
 * representative. The three role profiles of a family extend the same base
 * runtime, so their model lists agree; where they might not, the per-provider
 * truth is still enforced later by preflight's resolveRoute, which fails
 * closed. These lists are a typing aid, never an authority.
 *
 * Never throws and never blocks a form: a daemon that is down yields an empty
 * map plus a `degraded` entry, and the model field stays the free-text box it
 * has always been.
 */
async function discoverModels(options = {}) {
	const timeoutMs = options.timeoutMs ?? 8000;
	const degraded = [];
	let listed;
	try {
		listed = await runPaseoJson(["provider", "ls"], { timeoutMs });
	} catch (error) {
		return {
			byProvider: {},
			degraded: [{
				step: "provider ls",
				code: error instanceof PaseoError ? error.code : "PASEO_FAILED",
				message: String(error?.message ?? error),
			}],
		};
	}
	const envelope = paseoErrorEnvelope(listed);
	if (envelope) return { byProvider: {}, degraded: [{ step: "provider ls", ...envelope }] };

	// Same health predicate as the route resolver: enabled AND, when a status is
	// reported, a healthy one. Suggesting models from a provider that preflight
	// will reject is worse than suggesting nothing.
	const healthy = new Set(
		buildProviderInventory(Array.isArray(listed) ? listed : [])
			.filter((p) => p.enabled && (p.status === undefined || PROVIDER_OK_STATUSES.has(p.status)))
			.map((p) => p.id),
	);

	const byProvider = {};
	for (const family of RUNTIME_FAMILIES) {
		const members = ROLE_PROVIDERS.filter((name) => providerFamily(name) === family);
		const representative = members.find((name) => healthy.has(name));
		if (representative === undefined) {
			degraded.push({
				step: `family ${family}`,
				code: "NO_HEALTHY_ROLE_PROVIDER",
				message: `no enabled role provider for family "${family}" (looked for ${members.join(", ")}) — run 'pteam preflight' or 'pteam claude-setup --install'`,
			});
			continue;
		}
		const result = await listProviderModels(representative, timeoutMs);
		if (!result.ok) {
			degraded.push({ step: `provider models ${representative}`, code: result.code, message: result.message });
			continue;
		}
		const ids = [...new Set(result.models.map((m) => m.id))].sort();
		for (const member of members) byProvider[member] = ids;
	}
	return { byProvider, degraded };
}

/**
 * `models refresh` — tell the daemon to re-read its provider catalog.
 *
 * Editing ~/.pi/agent/models.json changes nothing the daemon can see until it
 * is told: it caches the catalog for its whole process lifetime. Without this
 * the only cure is a daemon restart, which drops every live agent connection
 * for what is a read-only change.
 */
async function cmdModelsRefresh(argv) {
	rejectUnknownFlags(argv, ["--provider", "--host"]);
	const provider = flagValue(argv, "--provider");
	const host = flagValue(argv, "--host");
	if (provider !== undefined && !ROLE_PROVIDERS.includes(provider)) {
		fail(`models refresh: --provider must be one of ${ROLE_PROVIDERS.join(", ")} (got '${provider}')`);
	}
	const targets = provider === undefined ? [] : [provider];
	const result = await refreshProviderSnapshot(targets, { timeoutMs: 20000, ...(host ? { host } : {}) });
	if (!result.ok) {
		json({
			ok: false,
			command: "models refresh",
			code: result.code,
			message: result.message,
			// The catalog is still whatever the daemon read at startup, so say
			// what actually fixes it rather than leaving the user guessing.
			hint: "restart the daemon to pick up catalog changes (systemd: systemctl --user restart paseo)",
		});
		process.exit(3);
	}
	json({
		ok: true,
		command: "models refresh",
		providers: targets.length > 0 ? targets : "all",
	});
}

/**
 * `models sync` — rebuild pi's model catalogs from their endpoints, then tell
 * the daemon about it.
 *
 * Two halves on purpose. scripts/pi-models-sync.mjs knows about endpoints and
 * models.json and nothing about Paseo, so it still works on a host with no
 * daemon; this function adds the one Paseo-specific step, because a catalog the
 * daemon has not re-read is a catalog nobody can route to.
 *
 * A refresh that fails does NOT fail the sync: the file on disk is correct
 * either way, and pi itself re-reads it on every start. It is reported, with
 * the restart that would finish the job.
 */
async function cmdModelsSync(argv) {
	rejectUnknownFlags(argv, ["--config", "--only", "--no-probe", "--all", "--no-refresh", "--dry-run"]);
	const configPath = flagValue(argv, "--config") ?? resolveSection("pi-models");
	const doc = cw.readJsonOrNull(configPath);
	if (!doc) {
		json({
			ok: false,
			command: "models sync",
			code: "CONFIG_MISSING",
			path: configPath,
			message: `no endpoint configured at ${configPath}`,
			hint: "copy config/pi-models.example.json there, or add one in the WebUI under Cấu hình → Kho model Pi",
		});
		process.exit(2);
	}

	const { entries: all, legacy } = normalizeConfig(doc);
	const only = flagValue(argv, "--only");
	const entries = only === undefined ? all : all.filter((entry) => entry.name === only);
	if (only !== undefined && entries.length === 0) {
		fail(`models sync: --only '${only}' is not configured (have: ${all.map((e) => e.name).join(", ") || "none"})`);
	}
	const problems = configProblems(entries);
	if (problems.length > 0) {
		json({ ok: false, command: "models sync", code: "CONFIG_INVALID", path: configPath, problems });
		process.exit(2);
	}

	// Resolve every key BEFORE any request: a half-synced run would rewrite one
	// provider's catalog and leave the operator guessing about the rest.
	const keys = new Map();
	const keySources = {};
	const missing = [];
	for (const entry of entries) {
		const { key, source, tried } = resolveApiKey(entry);
		if (!key) {
			missing.push({ provider: entry.name, tried });
			continue;
		}
		keys.set(entry.name, key);
		keySources[entry.name] = source;
	}
	if (missing.length > 0) {
		json({
			ok: false,
			command: "models sync",
			code: "API_KEY_MISSING",
			missing,
			hint: "put each key in the keyFile that provider names; systemd hands the daemon the same file",
		});
		process.exit(2);
	}

	const dryRun = argv.includes("--dry-run");
	const report = await syncModels({
		entries,
		keys,
		modelsPath: cw.piModelsPath(),
		probe: argv.includes("--no-probe") ? false : undefined,
		keepAll: argv.includes("--all"),
		dryRun,
	});
	if (report.code) {
		json({ ok: false, command: "models sync", ...report });
		process.exit(2);
	}

	// The daemon caches the catalog for its whole lifetime, so a write nobody
	// told it about changes nothing it can route to.
	let refresh = { skipped: true, reason: dryRun ? "--dry-run" : "--no-refresh" };
	const wroteSomething = !dryRun && report.providers.some((p) => p.ok);
	if (wroteSomething && !argv.includes("--no-refresh")) {
		const refreshed = await refreshProviderSnapshot([], { timeoutMs: 20000 });
		refresh = refreshed.ok
			? { ok: true }
			: {
					ok: false,
					code: refreshed.code,
					message: refreshed.message,
					hint: "the catalog on disk is correct; restart the daemon to make it visible (systemctl --user restart paseo)",
				};
	}
	json({ ok: report.ok, command: "models sync", legacyConfigShape: legacy, keySources, ...report, refresh });
	// A provider that failed must not read as success in a script.
	if (!report.ok) process.exit(3);
}

async function cmdModels(argv) {
	if (argv[0] === "refresh") return cmdModelsRefresh(argv.slice(1));
	if (argv[0] === "sync") return cmdModelsSync(argv.slice(1));
	rejectUnknownFlags(argv, ["--provider"]);
	const provider = flagValue(argv, "--provider");
	if (provider !== undefined) {
		if (!ROLE_PROVIDERS.includes(provider)) {
			fail(`models: --provider must be one of ${ROLE_PROVIDERS.join(", ")} (got '${provider}')`);
		}
		// One named provider is the authoritative read: full entries, including
		// the thinking options a route must match.
		const result = await listProviderModels(provider, 20000);
		if (!result.ok) {
			json({ ok: false, code: result.code, command: "models", provider, message: result.message });
			process.exit(3);
		}
		json({ ok: true, provider, family: providerFamily(provider), count: result.models.length, models: result.models });
		return;
	}
	const { byProvider, degraded } = await discoverModels({ timeoutMs: 20000 });
	// `ok` reports whether this answer is COMPLETE, not whether the command ran.
	// A fan-out keeps exit 0 and a renderable body on purpose — same reason
	// `graph` does — but claiming ok:true after reaching nothing made "the
	// daemon is unreachable" indistinguishable from "there are no models", and
	// disagreed with `models --provider X`, which fails loudly on the same
	// daemon. Partial results stay ok:true with `degraded` listing the gaps.
	json({
		ok: Object.keys(byProvider).length > 0 || degraded.length === 0,
		providers: byProvider,
		count: Object.fromEntries(Object.entries(byProvider).map(([k, v]) => [k, v.length])),
		degraded,
	});
}

// ---------------------------------------------------------------------------
// config read/write
// ---------------------------------------------------------------------------

const CONFIG_SECTIONS = {
	providers: () => cw.paseoConfigPath(),
	routing: () => join(cw.teamConfigDir(), "model-routing.local.json"),
	cluster: () => join(cw.teamConfigDir(), "cluster-routing.local.json"),
	mcp: () => cw.mcpConfigPath(),
	paseo: () => cw.paseoConfigPath(),
	"pi-settings": () => cw.piSettingsPath(),
	seats: () => seatsPath(cw.teamConfigDir()),
	"pi-models": () => join(cw.teamConfigDir(), "pi-models.local.json"),
};

function resolveSection(section) {
	if (typeof section !== "string" || !(section in CONFIG_SECTIONS)) {
		fail(`unknown config section '${section}' (expected: ${Object.keys(CONFIG_SECTIONS).join(", ")})`);
	}
	return CONFIG_SECTIONS[section]();
}

async function cmdConfigRead(section, rest = []) {
	rejectUnknownFlags(rest, ["--no-discovery"]);
	const path = resolveSection(section);
	const data = cw.readJsonOrNull(path);
	// The form schema rides along with the data: the WebUI renders fields the
	// CLI described and nothing else, so a form is reproducible from a terminal.
	let schema = schemaForSection(section);
	// Routing forms get the live model inventory folded into that same schema,
	// so the browser still renders only what the CLI described. --no-discovery
	// skips the daemon round trip for scripted reads and for a machine whose
	// daemon is known to be down (the read otherwise costs one `provider ls`).
	let inventory = null;
	if (schema && ROUTING_SECTIONS.includes(section) && !flag(rest, "--no-discovery")) {
		inventory = await discoverModels();
		schema = withModelInventory(schema, inventory.byProvider);
	}
	const extras = {
		...(schema ? { schema } : {}),
		...(inventory ? { inventory: { providers: Object.keys(inventory.byProvider), degraded: inventory.degraded } } : {}),
	};
	if (data === null) {
		json({ exists: false, path, data: {}, ...extras });
		return;
	}
	json({ exists: true, path, data, ...extras });
}

function cmdConfigWrite(section) {
	const path = resolveSection(section);
	const content = readStdin();
	try {
		cw.atomicWriteJson(path, content);
	} catch (e) {
		fail(`invalid JSON or write failed for ${path}: ${e.message}`);
	}
	json({ ok: true, wrote: true, path });
}

// ---------------------------------------------------------------------------
// prompts read/write
// ---------------------------------------------------------------------------

/**
 * `cw.rolePromptPath` throws on an unknown role, and the top-level handler
 * prints `error.stack` — so a plain typo answered with a JavaScript stack
 * trace while every other bad-name path here printed one clean line. The
 * message the walker raises is already the right one; only its framing and
 * exit code were wrong.
 */
function rolePromptPathOrUsage(role) {
	try {
		return cw.rolePromptPath(role);
	} catch (error) {
		return usageFail(String(error?.message ?? error));
	}
}

function cmdPromptsRead(role) {
	const path = rolePromptPathOrUsage(role);
	if (!existsSync(path)) {
		fail(`prompt not installed for role '${role}' at ${path} — run 'paseo-team install'`);
	}
	json({ role, path, content: cw.readText(path) });
}

function cmdPromptsWrite(role) {
	const path = rolePromptPathOrUsage(role);
	const content = readStdin();
	cw.atomicWrite(path, content);
	json({ ok: true, wrote: true, role, path });
}

// ---------------------------------------------------------------------------
// skills list/read/write
// ---------------------------------------------------------------------------

function listSkills() {
	if (!existsSync(cw.skillsDir())) return [];
	return readdirSync(cw.skillsDir(), { withFileTypes: true })
		.filter((d) => d.isDirectory())
		.map((d) => d.name);
}

function cmdSkillsList() {
	json({
		skills: listSkills().map((name) => ({
			name,
			path: join(cw.skillsDir(), name),
			pack: cw.PACK_SKILLS.includes(name),
		})),
	});
}

function cmdSkillsRead(name) {
	const n = cw.safeName(name);
	const p = cw.skillPromptPath(n);
	if (!existsSync(p)) fail(`skill '${name}' has no SKILL.md at ${p}`);
	json({ name, path: p, content: cw.readText(p) });
}

function cmdSkillsWrite(name) {
	const n = cw.safeName(name);
	const p = cw.skillPromptPath(n);
	const content = readStdin();
	cw.atomicWrite(p, content);
	json({ ok: true, wrote: true, name, path: p });
}

// ---------------------------------------------------------------------------
// env list (read-only view of documented knobs)
// ---------------------------------------------------------------------------

const DOC_ENV = [
	{ key: "PASEO_PI_ROLE", scope: "per-provider", where: "Paseo config agents.providers.<name>.env", purpose: "role selection (supervisor|lead|peer)" },
	{ key: "PASEO_TEAM_LEAD_WRITE", scope: "host", where: "machine env", purpose: "grant Lead write/edit tools ('1' to enable)" },
	{ key: "PASEO_TEAM_EXTRA_TOOLS", scope: "host", where: "machine env", purpose: "comma-separated extra tools per profile" },
	{ key: "PST_TEAM_CONFIG_DIR", scope: "host", where: "machine env", purpose: "override the pack's config directory (routing files, seat ledger, permit log, Claude session state). Default ~/.paseo-pi-team; PASEO_TEAM_HOME is honoured as a legacy alias and loses to this one" },
	{ key: "PASEO_TEAM_HOME", scope: "host", where: "machine env", purpose: "legacy alias for PST_TEAM_CONFIG_DIR — still read, and only used when PST_TEAM_CONFIG_DIR is unset" },
	{ key: "PASEO_TEAM_PROMPTS_DIR", scope: "host", where: "machine env", purpose: "override prompts directory" },
	{ key: "PASEO_TEAM_SCRIPTS_DIR", scope: "host", where: "machine env", purpose: "override support-scripts directory" },
	{ key: "PASEO_TEAM_TOPOLOGY", scope: "per-agent", where: "paseo run --env / provider env", purpose: "single (default) | multi — 'multi' turns on the several-Supervisor governance rules: DOMAIN on supervisor blocks, recovery_for inside the supervisor's own domain, and the send_agent_prompt ownership wall. Any unrecognized value resolves to 'multi' (the side that only denies)" },
	{ key: "PASEO_TEAM_DOMAIN", scope: "per-agent", where: "paseo run --env / provider env", purpose: "jurisdiction of this seat; also set it as the team.domain label so `ls --label` can find it. Required on every Lead and Supervisor under PASEO_TEAM_TOPOLOGY=multi" },
	{ key: "PASEO_HOME", scope: "host", where: "machine env", purpose: "Paseo's own home; the CLI reads agent state from $PASEO_HOME/agents (defaults to ~/.paseo)" },
	{ key: "PASEO_TEAM_NODE_EXEC", scope: "install-time", where: "env of the `pteam install` / `claude-setup --install` run", purpose: "absolute node to write into the Claude hook + MCP registrations. Default: the most durable version-alias of the running interpreter that still satisfies engines (>=22.18), else the running one. Set this when you know your layout better than that heuristic — e.g. a version manager whose aliases move. `claude-setup --verify` re-checks whichever path was written" },
];

function cmdEnvList() {
	json({
		env: DOC_ENV.map((e) => ({ ...e, current: process.env[e.key] ?? null })),
	});
}

// ---------------------------------------------------------------------------
// install (delegate)
// ---------------------------------------------------------------------------

function cmdInstall(argv) {
	const isWin = process.platform === "win32";
	if (isWin) {
		const res = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(ROOT, "scripts", "install.ps1"), ...argv], { stdio: "inherit" });
		process.exit(res.status ?? 0);
	} else {
		const res = spawnSync("bash", [join(ROOT, "scripts", "install.sh"), ...argv], { stdio: "inherit" });
		process.exit(res.status ?? 0);
	}
}

// ---------------------------------------------------------------------------
// claude-setup — the Claude Code half of the role pack
//
// Pi gets its policy from an extension; Claude gets it from user-level hooks
// plus an MCP server. This subcommand is the single place that installs,
// verifies or removes that half, and prints the matching provider block.
// ---------------------------------------------------------------------------

function cmdClaudeSetup(argv) {
	const known = ["--install", "--apply", "--verify", "--uninstall", "--print-providers"];
	const passthrough = ["--json", "--force"];
	// No valued flags any more: --attach-cdp-port went with the agent-browser
	// integration. Kept as an empty list because the loop below distinguishes
	// flag-with-value from bare flag, and collapsing that is how the next valued
	// flag silently leaks its value into the unknown-flag check.
	const valued = [];
	// Fail closed on anything unrecognised: silently degrading a mistyped
	// --instal into a read-only --verify would report success for work that
	// never happened, and the rest of this CLI rejects unknown flags outright.
	const valuedArgs = [];
	const bareFlags = [];
	for (let i = 0; i < argv.length; i++) {
		if (!valued.includes(argv[i])) {
			bareFlags.push(argv[i]);
			continue;
		}
		if (argv[i + 1] === undefined) fail(`claude-setup: ${argv[i]} needs a value`);
		valuedArgs.push(argv[i], argv[++i]);
	}
	const unknown = bareFlags.filter(
		(arg) => !known.includes(arg) && !passthrough.includes(arg),
	);
	if (unknown.length > 0) {
		fail(
			`claude-setup: unknown flag '${unknown[0]}' (allowed: ${[...known, ...passthrough, ...valued].join(", ")})`,
		);
	}
	const modes = bareFlags.filter((arg) => known.includes(arg));
	if (modes.length > 1) fail(`claude-setup: pick one of ${known.join(", ")}`);
	const mode = modes[0] ?? "--verify";
	// --force overwrites a provider the operator owns, so it must never be a
	// no-op flag someone leaves on a command that cannot use it.
	if (bareFlags.includes("--force") && mode !== "--apply") {
		fail("claude-setup: --force is only valid with --apply");
	}
	if (valuedArgs.length > 0 && mode !== "--install") {
		fail(`claude-setup: ${valuedArgs[0]} is only valid with --install`);
	}
	const rest = [...bareFlags.filter((arg) => passthrough.includes(arg)), ...valuedArgs];
	const res = spawnSync(
		process.execPath,
		[join(ROOT, "scripts", "claude-setup.mjs"), mode, ...rest],
		{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
	);
	if (res.error) fail(`claude-setup failed to start: ${res.error.message}`);
	if (res.stderr) process.stderr.write(res.stderr);
	if (res.stdout) process.stdout.write(res.stdout);
	process.exit(res.status ?? 1);
}

// ---------------------------------------------------------------------------
// Live plane: agents, permits, graph
//
// Everything below talks to the Paseo daemon through cli/lib/paseo-bridge.mjs
// and nowhere else. Each paseo invocation costs ~3s of process startup, so
// commands here are batch-shaped by design: one command, one snapshot.
// ---------------------------------------------------------------------------

/** Agent ids and short-id prefixes only — never a free-form string in argv. */
const AGENT_REF = /^[0-9a-fA-F][0-9a-fA-F-]{5,63}$/;
/** A single opaque token (a permit request id); keeps free-form text out of argv. */
const TOKEN_REF = /^[A-Za-z0-9._:-]{1,128}$/;

function safeRef(ref, kind = "agent") {
	if (typeof ref !== "string" || !AGENT_REF.test(ref)) {
		fail(`invalid ${kind} reference '${ref}' (expected a Paseo id or short-id prefix)`);
	}
	return ref;
}

function flag(argv, name) {
	return argv.includes(name);
}

function flagValue(argv, name) {
	const index = argv.indexOf(name);
	if (index < 0) return undefined;
	const value = argv[index + 1];
	if (value === undefined || value.startsWith("--")) fail(`${name} requires a value`);
	return value;
}

/** Fail closed on typos: an unknown flag must never be silently ignored. */
function rejectUnknownFlags(argv, allowed) {
	for (const part of argv) {
		if (part.startsWith("--") && !allowed.includes(part)) {
			fail(`unknown flag '${part}' (allowed: ${allowed.join(", ")})`);
		}
	}
}

async function live(args, label) {
	try {
		return await runPaseoJson(args);
	} catch (error) {
		const code = error instanceof PaseoError ? error.code : "PASEO_FAILED";
		process.stdout.write(JSON.stringify({ ok: false, code, command: label, message: String(error?.message ?? error) }, null, 2) + "\n");
		process.exit(3);
	}
}

async function cmdAgents(argv) {
	rejectUnknownFlags(argv, ["--all", "--domain"]);
	const domainFilter = flagValue(argv, "--domain");
	const listed = await live(flag(argv, "--all") ? ["ls", "-g", "-a"] : ["ls", "-g"], "agents");
	const rows = Array.isArray(listed) ? listed : [];
	// `paseo ls` carries neither labels nor the parent link; Paseo's own state
	// files carry both, and reading them costs no daemon round trip.
	const ids = rows.map((agent) => agent?.id).filter(isAgentId);
	const { states, degraded } = readAgentStates(ids);
	const agents = rows.map((agent) => {
		const state = states[agent?.id] ?? null;
		return {
			...agent,
			role: inferRole(agent?.provider),
			seat: inferSeat(agent?.provider),
			domain: state?.domain ?? null,
			parentId: state?.parentAgentId ?? null,
			resolvedModel: state?.model ?? null,
			modelDrift: state?.modelDrift ?? false,
			sessionId: state?.sessionId ?? null,
		};
	});
	const filtered = domainFilter === undefined ? agents : agents.filter((a) => a.domain === domainFilter);
	json({
		ok: true,
		count: filtered.length,
		domain: domainFilter ?? null,
		agents: filtered,
		degraded: degraded.filter((fault) => fault.reason !== "AGENT_STATE_MISSING"),
	});
}

async function cmdAgentInspect(ref) {
	const detail = await live(["inspect", safeRef(ref)], "agent inspect");
	json({ ok: true, role: inferRole(detail?.Provider ?? detail?.provider), agent: detail });
}

/**
 * Send a prompt read from stdin. The body goes through a temp file rather than
 * argv: on Windows the whole command line is one bounded string, and
 * remote-paseo.mjs already learned that lesson the hard way (PROMPT_TOO_LONG).
 */
async function cmdAgentSend(ref) {
	const agent = safeRef(ref);
	const body = readStdin().trim();
	if (!body) fail("agent send: empty prompt on stdin");
	cw.ensureDir(cw.teamConfigDir());
	const tmp = join(cw.teamConfigDir(), `send-${process.pid}-${Date.now()}.txt`);
	writeFileSync(tmp, body, "utf8");
	// Cleanup on 'exit' rather than in a finally: `live()` reports a failed
	// delegate by calling process.exit, which skips finally blocks entirely and
	// would leave a prompt file behind on every failure.
	process.on("exit", () => {
		try { unlinkSync(tmp); } catch { /* already gone, or the send still holds it — not worth failing over */ }
	});
	const sent = await live(["send", agent, "--prompt-file", tmp, "--no-wait"], "agent send");
	json({ ok: true, agentId: agent, bytes: Buffer.byteLength(body, "utf8"), response: sent });
}

// --- permissions -----------------------------------------------------------

export function permitAuditPath() {
	return join(cw.teamConfigDir(), "permit-audit.jsonl");
}

/**
 * Approving a tool call is an authority act, so it leaves a record before the
 * daemon is asked — a decision that was made must be visible even if the
 * delegate call then fails.
 */
function auditPermit(entry) {
	cw.ensureDir(cw.teamConfigDir());
	appendFileSync(permitAuditPath(), JSON.stringify(entry) + "\n", "utf8");
}

async function cmdPermitsList() {
	const listed = await live(["permit", "ls"], "permits list");
	const { permits, unclassified } = normalizePermits(listed);
	json({
		ok: true,
		count: permits.length + unclassified.length,
		permits: permits.map(({ ok, ...rest }) => rest),
		// Surfaced, not swallowed: a row we cannot name is still a request
		// somebody is blocked on, but it must not get a one-click approve.
		unclassified,
	});
}

async function cmdPermitDecision(action, argv) {
	const [agentRef, requestId] = argv;
	const agent = safeRef(agentRef);
	if (typeof requestId !== "string" || !TOKEN_REF.test(requestId)) {
		fail(`permits ${action}: missing or invalid request id`);
	}
	const decidedAt = new Date().toISOString();
	auditPermit({ decidedAt, action, agentId: agent, requestId, actor: process.env.USERNAME ?? process.env.USER ?? null });
	const result = await live(["permit", action, agent, requestId], `permits ${action}`);
	json({ ok: true, action, agentId: agent, requestId, decidedAt, response: result });
}

// --- cost ------------------------------------------------------------------

/**
 * The usage numbers Paseo records for one agent, under whatever casing the
 * daemon used. Reported under Paseo's own name (`LastUsage`) rather than
 * renamed to `totalCostUsd`: the two are not obviously the same thing, and a
 * cost report that quietly relabels its source is the kind of number people
 * later build a budget on.
 */
function normalizeUsage(detail) {
	const raw = detail?.LastUsage ?? detail?.lastUsage ?? detail?.usage ?? null;
	if (!raw || typeof raw !== "object") return null;
	const num = (...keys) => {
		for (const key of keys) {
			const value = raw[key];
			if (typeof value === "number" && Number.isFinite(value)) return value;
		}
		return null;
	};
	return {
		costUsd: num("CostUsd", "costUsd", "cost_usd", "totalCostUsd"),
		inputTokens: num("InputTokens", "inputTokens"),
		outputTokens: num("OutputTokens", "outputTokens"),
		cachedTokens: num("CachedTokens", "cachedTokens"),
	};
}

/**
 * Cost for a whole cluster in ONE command.
 *
 * `paseo ls` carries no cost column and `paseo inspect` carries it one agent at
 * a time, so a fifteen-Peer project had no way to answer "what has this cost"
 * except fifteen sequential calls and mental arithmetic. The cluster is the
 * right unit because it is already the pack's authority boundary: the same
 * grouping that decides which Supervisor may bind which Lead decides whose
 * spend this is.
 *
 * Cost discipline (paseo-bridge.mjs): one `paseo` invocation is ~3s of process
 * startup, so the inspects run with bounded concurrency and an agent that fails
 * to answer is reported as unavailable rather than silently counted as zero — a
 * total that quietly omits a seat is worse than one that names the gap.
 */
async function cmdCost(argv) {
	rejectUnknownFlags(argv, ["--all", "--cluster", "--concurrency", "--json"]);
	const concurrencyRaw = flagValue(argv, "--concurrency");
	// Validated to the range the message names rather than clamped: this repo
	// already treats a silently-ignored flag value as the same defect class as a
	// silently-ignored flag.
	if (
		concurrencyRaw !== undefined &&
		(!/^\d{1,2}$/.test(concurrencyRaw) || Number(concurrencyRaw) < 1 || Number(concurrencyRaw) > 16)
	) {
		fail("--concurrency must be a number between 1 and 16");
	}
	const concurrency = concurrencyRaw === undefined ? 6 : Number(concurrencyRaw);
	const clusterRaw = flagValue(argv, "--cluster");
	const clusterFilter = clusterRaw === undefined ? null : normalizeCluster(clusterRaw);
	if (clusterRaw !== undefined && clusterFilter === null) {
		fail(`--cluster '${clusterRaw}' is not a usable cluster id`);
	}

	const listed = await live(flag(argv, "--all") ? ["ls", "-g", "-a"] : ["ls", "-g"], "cost");
	// The Paseo CLI reports some daemon failures as a successful JSON body, so an
	// unchecked envelope here would render as "0 agents, $0.00, ok: true" — the
	// most dangerous possible answer to "what has this cost".
	const listEnvelope = paseoErrorEnvelope(listed);
	if (listEnvelope) {
		json({ ok: false, command: "cost", ...listEnvelope });
		process.exit(3);
	}
	const rows = Array.isArray(listed) ? listed : [];
	const ids = rows.map((agent) => agent?.id).filter(isAgentId);
	const { states } = readAgentStates(ids);

	const candidates = rows
		// An id `paseo ls` returned in a shape we cannot validate never becomes an
		// argv element: safeRef would exit the process mid-snapshot, turning one
		// odd row into a cost report nobody gets.
		.filter((agent) => isAgentId(agent?.id))
		.map((agent) => {
			const state = states[agent.id] ?? null;
			return { agent, cluster: state ? agentCluster(state) : null };
		})
		// A null cluster is "unknown", not "mine": including it would inflate one
		// project's bill with another's seats. It stays visible via `--all`
		// without a filter, where the caller has asked for everything.
		.filter(({ cluster }) => clusterFilter === null || cluster === clusterFilter);

	const results = await mapWithConcurrency(candidates, concurrency, async ({ agent, cluster }) => {
		const detail = await runPaseoJson(["inspect", safeRef(agent.id)]);
		// Same trap as the inventory reads above: `paseo inspect` can answer a
		// daemon failure with exit 0 and an `{ error }` body. Left unchecked it has
		// no usage field, so it would be filed as "Paseo reports no usage for this
		// agent" — a transport failure silently reclassified as a benign state,
		// and a total quietly missing a seat.
		const envelope = paseoErrorEnvelope(detail);
		if (envelope) {
			const failure = new PaseoError(envelope.code, envelope.message);
			return { agent, cluster, usage: null, failure };
		}
		return { agent, cluster, usage: normalizeUsage(detail), failure: null };
	});

	const agents = [];
	const unavailable = [];
	const totals = { costUsd: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
	let costedCount = 0;
	for (const [index, result] of results.entries()) {
		const { agent, cluster } = candidates[index];
		if (!result.ok) {
			unavailable.push({
				id: agent?.id ?? null,
				shortId: agent?.shortId ?? null,
				cluster,
				code: result.error instanceof PaseoError ? result.error.code : "PASEO_FAILED",
				message: String(result.error?.message ?? result.error),
			});
			continue;
		}
		const { usage, failure } = result.value;
		if (failure) {
			unavailable.push({
				id: agent.id,
				shortId: agent?.shortId ?? null,
				cluster,
				code: failure.code,
				message: failure.message,
			});
			continue;
		}
		if (usage === null) {
			// An agent Paseo has recorded no usage for (never started, archived
			// before its first turn) is not a failure and not a zero — say so.
			unavailable.push({
				id: agent?.id ?? null,
				shortId: agent?.shortId ?? null,
				cluster,
				code: "USAGE_UNREPORTED",
				message: "Paseo reports no usage for this agent",
			});
			continue;
		}
		costedCount += 1;
		for (const key of Object.keys(totals)) {
			if (typeof usage[key] === "number") totals[key] += usage[key];
		}
		agents.push({
			id: agent?.id ?? null,
			shortId: agent?.shortId ?? null,
			name: agent?.name ?? null,
			role: inferRole(agent?.provider),
			provider: agent?.provider ?? null,
			status: agent?.status ?? null,
			cluster,
			...usage,
		});
	}
	agents.sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0));
	json({
		ok: true,
		cluster: clusterFilter,
		scope: flag(argv, "--all") ? "all" : "active",
		agentCount: candidates.length,
		costedCount,
		totals: { ...totals, costUsd: Number(totals.costUsd.toFixed(6)) },
		agents,
		unavailable,
		source: "paseo inspect -> LastUsage (per agent); summed here, not by the daemon",
	});
}

// --- activity ---------------------------------------------------------------

/** An entry in `paseo logs` output starts a line with its own `[Speaker]` tag. */
const ACTIVITY_ENTRY_RE = /^\[[A-Za-z][A-Za-z ]{0,30}\]/;

/**
 * Split a transcript into entries and cap each one INDEPENDENTLY.
 *
 * A per-entry cap is the whole point. `limit`/`--tail` bounds how many entries
 * come back but not how big one is, and a single entry can be a Peer's whole
 * PEER_MESSAGE_V1 report — thousands of lines whose full text is, by the pack's
 * own output contract, already sitting in a file the report names. Asking for
 * four activities and being handed half a megabyte is not a large answer to a
 * small question; it is the same document twice.
 */
export function clipActivity(text, { maxChars, tail }) {
	const lines = String(text ?? "").split(/\r?\n/);
	const entries = [];
	for (const line of lines) {
		if (entries.length === 0 || ACTIVITY_ENTRY_RE.test(line)) {
			entries.push({ kind: ACTIVITY_ENTRY_RE.exec(line)?.[0].slice(1, -1) ?? null, lines: [line] });
		} else {
			entries[entries.length - 1].lines.push(line);
		}
	}
	const picked = tail > 0 ? entries.slice(-tail) : entries;
	return picked.map((entry, index) => {
		const body = entry.lines.join("\n").replace(/\s+$/, "");
		const truncated = body.length > maxChars;
		return {
			index,
			kind: entry.kind,
			chars: body.length,
			truncated,
			text: truncated
				? `${body.slice(0, maxChars)}\n[... ${body.length - maxChars} more characters withheld by --max-chars. The full text is in the artifact this entry names, or read it with: paseo logs <agent> --tail 1]`
				: body,
		};
	});
}

/**
 * Bounded read of one agent's activity.
 *
 * Exists because the monitoring tool a Lead reaches for first
 * (`get_agent_activity`) has no per-entry bound, and a Lead that blows its
 * context reading a report it already has on disk has paid twice for one
 * document.
 */
async function cmdActivity(argv) {
	const [ref, ...rest] = argv;
	if (!ref || ref.startsWith("--")) fail("activity: missing agent reference");
	rejectUnknownFlags(rest, ["--tail", "--max-chars", "--filter"]);
	const tailRaw = flagValue(rest, "--tail");
	// 0 is rejected rather than treated as "all": this command exists to BOUND a
	// read, and a spelling of it that silently removes the bound is a trap.
	if (tailRaw !== undefined && (!/^\d{1,4}$/.test(tailRaw) || Number(tailRaw) < 1)) {
		fail("--tail must be a number of entries, 1 or more");
	}
	const maxCharsRaw = flagValue(rest, "--max-chars");
	if (maxCharsRaw !== undefined && !/^\d{1,7}$/.test(maxCharsRaw)) fail("--max-chars must be a number");
	const filter = flagValue(rest, "--filter");
	const FILTERS = ["tools", "text", "errors", "permissions"];
	if (filter !== undefined && !FILTERS.includes(filter)) {
		fail(`--filter must be one of: ${FILTERS.join(", ")}`);
	}
	const tail = tailRaw === undefined ? 20 : Number(tailRaw);
	const maxChars = Math.max(200, maxCharsRaw === undefined ? 2000 : Number(maxCharsRaw));

	const agent = safeRef(ref);
	const args = ["logs", agent];
	// Ask paseo for a few more entries than we return: --tail counts entries and
	// our own splitter may merge or split differently, so a short read is worse
	// than a slightly long one.
	if (tail > 0) args.push("--tail", String(Math.min(9999, tail + 5)));
	if (filter !== undefined) args.push("--filter", filter);

	let raw;
	try {
		raw = await runPaseoText(args);
	} catch (error) {
		const code = error instanceof PaseoError ? error.code : "PASEO_FAILED";
		json({ ok: false, code, command: "activity", agentId: agent, message: String(error?.message ?? error) });
		process.exit(3);
		return;
	}
	const entries = clipActivity(raw.text, { maxChars, tail });
	const returnedChars = entries.reduce((sum, entry) => sum + entry.text.length, 0);
	json({
		ok: true,
		agentId: agent,
		tail,
		maxChars,
		filter: filter ?? null,
		entryCount: entries.length,
		sourceChars: raw.totalChars,
		returnedChars,
		withheldChars: Math.max(0, raw.totalChars - returnedChars),
		entries,
	});
}

// --- graph -----------------------------------------------------------------

async function cmdGraph(argv) {
	rejectUnknownFlags(argv, ["--all", "--max-inspect", "--refresh"]);
	if (flag(argv, "--refresh")) graphCache.clearParentCache();
	const maxInspect = flagValue(argv, "--max-inspect");
	if (maxInspect !== undefined && !/^\d{1,3}$/.test(maxInspect)) {
		fail("--max-inspect must be a number (max 3 digits)");
	}
	json(
		await collectGraph({
			all: flag(argv, "--all"),
			maxInspect: maxInspect === undefined ? undefined : Number(maxInspect),
		}),
	);
}

async function cmdWatchdog(argv) {
	rejectUnknownFlags(argv, ["--stale-after"]);
	const staleAfter = flagValue(argv, "--stale-after");
	if (staleAfter !== undefined && !/^\d{1,9}$/.test(staleAfter)) fail("--stale-after must be milliseconds");
	const { collectWatchdogSnapshot } = await import("../scripts/watchdog.mjs");
	json(await collectWatchdogSnapshot(staleAfter === undefined ? {} : { staleAfterMs: Number(staleAfter) }));
}

// --- uninstall --------------------------------------------------------------

function cmdUninstall(argv) {
	rejectUnknownFlags(argv, ["--purge"]);
	const report = un.uninstall({ purge: flag(argv, "--purge") });
	const mode = su.detectInstallMode();
	json({
		...report,
		mode,
		binary: mode === "global"
			? "this CLI was installed globally by npm — run `npm rm -g paseo-team-orchestration` to remove the `pteam`/`paseo-team` binary itself; an install made before the repo was renamed is registered under the old name, so `npm rm -g paseo-pi-team` is the one that works there"
			: "this CLI runs from a git checkout — remove the checkout to delete the binary",
	});
}

// --- update ----------------------------------------------------------------

/**
 * Upgrading the BINARY is only half of an upgrade.
 *
 * The policy core, the role prompts and the Lead skill are COPIED into
 * ~/.pi/agent/ at install time — that copy is what a running agent actually
 * loads, and `npm i -g` does not touch it. So a user who runs `pteam update`
 * and stops there gets a new CLI enforcing the previous release's rules, with
 * both halves reporting the new version number and nothing disagreeing out
 * loud. Say it here, where the person who just upgraded is looking.
 */
const UPDATE_NEXT_STEPS = Object.freeze([
	"re-run `pteam install` — the policy core, role prompts and Lead skill are copies under ~/.pi/agent and are NOT refreshed by the package upgrade",
	"then `pteam preflight` to confirm the installed copies match this version",
]);

async function cmdUpdate(argv) {
	rejectUnknownFlags(argv, ["--check"]);
	const info = await su.checkForUpdate();
	if (flag(argv, "--check")) {
		json(info);
		return;
	}
	if (info.degraded.length > 0) {
		fail(`could not check for updates (${info.degraded[0].reason}): ${info.degraded[0].error ?? "no detail"}`);
	}
	if (!info.updateAvailable) {
		json({ ...info, action: "none", message: `already up to date (${info.current})` });
		return;
	}
	// Never `git pull` inside a checkout the user owns, and never npm-install
	// over one — the two install modes need opposite update paths.
	const mode = su.detectInstallMode();
	if (mode === "checkout") {
		json({
			...info,
			action: "manual",
			mode,
			message: "running from a git checkout — pull the latest yourself (`git pull`), then restart the CLI",
			nextSteps: UPDATE_NEXT_STEPS,
		});
		return;
	}
	process.stderr.write(`[paseo-team] installing ${info.latest} (npm install -g github:${info.slug}#${info.latest})…\n`);
	const res = su.runNpmUpdate(info.slug, info.latest);
	if (res.error || res.status !== 0) {
		fail(`npm update failed (exit ${res.status ?? "?"}${res.error ? `: ${res.error.message}` : ""})`);
	}
	json({
		...info,
		action: "updated",
		mode,
		message: `updated ${info.current} -> ${info.latest}`,
		nextSteps: UPDATE_NEXT_STEPS,
	});
	// stderr, not the JSON body: a human running `pteam update` by hand is the
	// one who has to act on it, and the WebUI reads stdout.
	process.stderr.write(`[paseo-team] ${UPDATE_NEXT_STEPS[0]}\n`);
}

// --- web -------------------------------------------------------------------

async function cmdWeb(argv) {
	rejectUnknownFlags(argv, ["--port", "--open", "--no-token"]);
	const port = flagValue(argv, "--port");
	if (port !== undefined && !/^\d{1,5}$/.test(port)) fail("--port must be a number");
	const { startServer } = await import("../webui/server.mjs");
	try {
		await startServer({
			port: port === undefined ? undefined : Number(port),
			// No --port means the default is ours to move: fall forward to the
			// next free port instead of dying on a stale instance. A pinned
			// --port is the user's decision — fail with actionable text.
			autoPort: port === undefined,
			open: flag(argv, "--open"),
			// --no-token is for a throwaway demo on a machine you already trust.
			// It is opt-in and loud, because this UI approves permission requests.
			requireToken: !flag(argv, "--no-token"),
		});
	} catch (error) {
		fail(String(error?.message ?? error), 1);
	}
}

// ---------------------------------------------------------------------------
// Help + dispatch
// ---------------------------------------------------------------------------
// seats — custom named variants of the three base roles
// ---------------------------------------------------------------------------

/**
 * The static deny list for a seat, computed by the real policy under the seat's
 * own environment.
 *
 * `claudeDisallowedTools` reads PASEO_TEAM_EXTRA_TOOLS and
 * PASEO_TEAM_LEAD_WRITE from `process.env` at call time, so the env is applied
 * around the call and restored after. Mutating the process environment is not
 * free of smell, but the alternative — teaching the seat generator which env
 * knob implies which tool — is a second copy of the policy, and this repo has
 * already paid for that mistake once (see the routing vocabulary note in
 * cli/lib/config-schema.mjs). Pi providers carry no disallowedTools at all
 * (pi denies by allowlist instead), so they resolve to an empty list.
 */
async function seatDisallowedResolver() {
	let policy = null;
	try {
		const setup = await import("../scripts/claude-setup.mjs");
		policy = await setup.loadClaudePolicy();
	} catch {
		// A checkout without the Claude half still edits seats; it just cannot
		// compute a deny list it cannot read. Reported as `degraded` rather than
		// silently producing a seat whose capability does nothing.
		return null;
	}
	const KNOBS = ["PASEO_TEAM_EXTRA_TOOLS", "PASEO_TEAM_LEAD_WRITE"];
	return (base, env) => {
		if (providerFamily(base) !== "claude") return [];
		const role = baseRole(base);
		if (role === null) return [];
		const saved = Object.fromEntries(KNOBS.map((k) => [k, process.env[k]]));
		for (const knob of KNOBS) {
			if (env[knob] === undefined) delete process.env[knob];
			else process.env[knob] = env[knob];
		}
		try {
			return policy.claudeDisallowedTools(role);
		} finally {
			for (const knob of KNOBS) {
				if (saved[knob] === undefined) delete process.env[knob];
				else process.env[knob] = saved[knob];
			}
		}
	};
}

function readSeatsDoc() {
	const path = seatsPath(cw.teamConfigDir());
	return { path, data: cw.readJsonOrNull(path) ?? { version: 1, seats: {} } };
}

function readSeatLedger() {
	const ledger = cw.readJsonOrNull(seatLedgerPath(cw.teamConfigDir()));
	return Array.isArray(ledger?.providers) ? ledger.providers.filter((n) => typeof n === "string") : [];
}

async function cmdSeatsList(rest = []) {
	rejectUnknownFlags(rest, []);
	const { path, data } = readSeatsDoc();
	const errors = validateSeats(data);
	const resolver = await seatDisallowedResolver();
	const generated = errors.length === 0 ? materializeSeats(data, resolver ?? (() => [])) : {};
	json({
		ok: errors.length === 0,
		path,
		catalog: SEAT_CAPABILITIES.map((c) => ({ id: c.id, label: c.label, roles: [...c.roles], families: [...c.families], tools: [...c.tools], env: { ...c.env } })),
		seats: listSeats(data).map((seat) => ({
			...seat,
			provider: seatProviderName(seat.base, seat.id),
			grants: resolveSeatGrants(seat),
		})),
		providers: generated,
		ledger: readSeatLedger(),
		errors,
		...(resolver === null ? { degraded: ["claude-policy-unreadable: disallowedTools not subtracted"] } : {}),
	});
}

/**
 * Materialize seats into ~/.paseo/config.json.
 *
 * Refuses the whole document when validation fails: applying the seats that
 * happened to parse would leave a provider set nobody described. The ledger is
 * written only after the config write succeeds, so a crash between the two
 * leaves a provider this tool will adopt on the next run rather than a ledger
 * entry pointing at a provider that was never created.
 */
async function cmdSeatsApply(rest = []) {
	rejectUnknownFlags(rest, ["--dry-run"]);
	const dryRun = flag(rest, "--dry-run");
	const { path: docPath, data } = readSeatsDoc();
	const errors = validateSeats(data);
	if (errors.length > 0) {
		json({ ok: false, code: "SEATS_INVALID", path: docPath, errors });
		process.exitCode = 1;
		return;
	}
	const resolver = await seatDisallowedResolver();
	const generated = materializeSeats(data, resolver ?? (() => []));
	const configPath = cw.paseoConfigPath();
	const current = cw.readJsonOrNull(configPath);
	const result = applySeatsToPaseoConfig(current, generated, readSeatLedger());

	if (!dryRun) {
		cw.atomicWriteJson(configPath, JSON.stringify(result.config));
		cw.atomicWriteJson(
			seatLedgerPath(cw.teamConfigDir()),
			JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), providers: result.ledger }),
		);
	}
	json({
		ok: true,
		dryRun,
		seatsPath: docPath,
		configPath,
		created: result.created,
		updated: result.updated,
		removed: result.removed,
		// A name that already existed and this tool did not create is never
		// overwritten; saying so is the difference between "nothing happened"
		// and "something was silently skipped".
		skipped: result.skipped,
		providers: generated,
		...(resolver === null ? { degraded: ["claude-policy-unreadable: disallowedTools not subtracted"] } : {}),
		note: dryRun
			? "Chưa ghi gì. Bỏ --dry-run để áp dụng."
			: "Đã ghi provider. Chạy 'paseo daemon restart' để daemon nạp lại.",
	});
}

function dispatchSeats(argv) {
	const [sub, ...rest] = argv;
	if (sub === "list") return cmdSeatsList(rest);
	if (sub === "apply") return cmdSeatsApply(rest);
	fail(`seats: unknown subcommand '${sub ?? "<missing>"}' (expected: list, apply)`, 2);
}

// ---------------------------------------------------------------------------

function helpText() {
	return `pteam ${su.currentVersion()} — role pack CLI (Paseo + Pi)   (alias: paseo-team)

usage:
  pteam status
  pteam preflight [--strict] [--json] [--skip-models] [--runtime pi|claude|both] [--host-id <id>] [--cluster <path>] [--routes <path>]
  pteam claude-setup [--install|--apply|--verify|--uninstall|--print-providers] [--json] [--force]
                                           (--apply writes the claude-* providers; it does NOT reload)
  pteam config read  <section> [--no-discovery]
  pteam config write <section>             (JSON body on stdin)
  pteam prompts read <role>                (supervisor|lead|peer)
  pteam prompts write <role>               (markdown body on stdin)
  pteam skills list
  pteam skills read <name>
  pteam skills write <name>                (markdown body on stdin)
  pteam protocol status [--path <repo>]    (grade a repo's WORKSPACE_PROTOCOL.md)
  pteam env list
  pteam seats list                         (custom seats + the providers they generate)
  pteam seats apply [--dry-run]            (write those providers into ~/.paseo/config.json)
  pteam install
  pteam uninstall [--purge]                (remove what install wrote; --purge also deletes ~/.paseo-pi-team)
  pteam update [--check]                    (compare with the latest GitHub release tag)

live plane (talks to the Paseo daemon):
  pteam agents [--all]
  pteam agent inspect <ref>
  pteam agent send <ref>                   (prompt on stdin)
  pteam permits list
  pteam permits allow <agent> <reqId>
  pteam permits deny  <agent> <reqId>
  pteam models [--provider <role-provider>]
  pteam models refresh [--provider <role-provider>] [--host <host>]
                                           (daemon re-reads its model catalog; no restart)
  pteam models sync [--only <pi-provider>] [--dry-run] [--no-probe] [--all] [--no-refresh]
                                           (probe the pi endpoint, rewrite models.json, then refresh)
  pteam cost [--all] [--cluster <id>] [--concurrency <n>]
  pteam activity <ref> [--tail <n>] [--max-chars <n>] [--filter tools|text|errors|permissions]
  pteam graph [--all] [--max-inspect <n>] [--refresh]
  pteam watchdog [--stale-after <ms>]
  pteam web [--port <n>] [--open] [--no-token]

sections: ${Object.keys(CONFIG_SECTIONS).join(", ")}
roles:    ${cw.ROLE_PROMPTS.join(", ")}
documentation: docs/webui-architecture.md
`;
}

function help() {
	process.stdout.write(helpText());
}

/**
 * Usage for ONE subcommand, filtered out of the same text `help()` prints.
 *
 * Filtered rather than stored separately on purpose: a second copy of the usage
 * lines is a copy that drifts, and a help text that lies is worse than one that
 * is terse. A continuation line (claude-setup wraps onto a second line) is
 * indented and carries no `pteam`, so it rides along with the entry above it.
 *
 * Falls back to the full help when nothing matches, because a reader who asked
 * a question must never get silence.
 */
function subcommandHelp(cmd) {
	const prefix = `  pteam ${cmd}`;
	const lines = helpText().split("\n");
	const picked = [];
	let inEntry = false;
	for (const line of lines) {
		if (line === prefix || line.startsWith(`${prefix} `)) {
			picked.push(line);
			inEntry = true;
			continue;
		}
		if (inEntry && line.startsWith("    ") && !line.startsWith("  pteam ")) {
			picked.push(line);
			continue;
		}
		inEntry = false;
	}
	if (picked.length === 0) return help();
	process.stdout.write(`${picked.join("\n")}\n`);
}

async function main() {
	const [cmd, ...argv] = process.argv.slice(2);
	// `--help` used to be a TOP-LEVEL case only, so the flag fell through into
	// the subcommand's own case and the command RAN: `pteam install --help`
	// installed, and `pteam uninstall --help` removed the installed pack. The
	// person typing --help is the one who does not yet know what the command
	// does — answering with the command itself is the worst available reply,
	// and for a destructive one it costs them their install. Intercepted before
	// dispatch so it can never reach a handler, read stdin, or touch a daemon.
	if (cmd && !cmd.startsWith("-") && argv.some((arg) => arg === "--help" || arg === "-h")) {
		return subcommandHelp(cmd);
	}
	switch (cmd) {
		case "status": return cmdStatus();
		case "preflight": return cmdPreflight(argv);
		case "config": return dispatchTwo("config", argv, { read: cmdConfigRead, write: cmdConfigWrite });
		case "prompts": return dispatchTwo("prompts", argv, { read: cmdPromptsRead, write: cmdPromptsWrite });
		case "skills": return dispatchSkills(argv);
		case "protocol": return dispatchProtocol(argv);
		case "env": return dispatchEnv(argv[0]);
		case "install": return cmdInstall(argv);
		case "claude-setup": return cmdClaudeSetup(argv);
		case "agents": return cmdAgents(argv);
		case "agent": return dispatchAgent(argv);
		case "permits": return dispatchPermits(argv);
		case "models": return cmdModels(argv);
		case "seats": return dispatchSeats(argv);
		case "cost": return cmdCost(argv);
		case "activity": return cmdActivity(argv);
		case "graph": return cmdGraph(argv);
		case "watchdog": return cmdWatchdog(argv);
		case "web": return cmdWeb(argv);
		case "update": return cmdUpdate(argv);
		case "uninstall": return cmdUninstall(argv);
		case "--version":
		case "-v":
			process.stdout.write(`pteam ${su.currentVersion()}\n`);
			return;
		case "--help":
		case "-h":
		case "help":
		case undefined:
			return help();
		default:
			fail(`unknown command '${cmd}'. Run 'pteam --help'.`, 2);
	}
}

function dispatchAgent(argv) {
	const [sub, ref] = argv;
	switch (sub) {
		case "inspect": if (!ref) usageFail("agent inspect: missing agent reference"); return cmdAgentInspect(ref);
		case "send": if (!ref) usageFail("agent send: missing agent reference"); return cmdAgentSend(ref);
		// `${sub}` alone printed the string "undefined" when the subcommand was
		// simply absent, which reads as a JavaScript leak rather than a message.
		default: usageFail(`agent: ${sub ? `unknown subcommand '${sub}'` : "missing subcommand"} (expected inspect|send)`);
	}
}

function dispatchPermits(argv) {
	const [sub, ...rest] = argv;
	switch (sub) {
		case "list": return cmdPermitsList();
		case "allow":
		case "deny": return cmdPermitDecision(sub, rest);
		default: usageFail(`permits: ${sub ? `unknown subcommand '${sub}'` : "missing subcommand"} (expected list|allow|deny)`);
	}
}

function dispatchTwo(parent, argv, handlers) {
	const [sub, arg] = argv;
	if (!sub) usageFail(`${parent}: missing subcommand (${Object.keys(handlers).join("|")})`);
	const fn = handlers[sub];
	if (!fn) usageFail(`${parent}: unknown subcommand '${sub}' (expected ${Object.keys(handlers).join("|")})`);
	if (!arg) usageFail(`${parent} ${sub}: missing argument`);
	// Trailing flags reach the handler; each one declares what it accepts and
	// rejects the rest, so a typo can never be silently dropped here.
	return fn(arg, argv.slice(2));
}

// ---------------------------------------------------------------------------
// workspace protocol
//
// The repository tactics layer the Lead is told to read before orchestrating.
// Reported, never enforced here: `missing` and `invalid` are facts a Human acts
// on, and turning either into a delegation blocker is a fleet-operator decision
// rather than something a release switches on underneath them.
// ---------------------------------------------------------------------------

function cmdProtocolStatus(argv) {
	const i = argv.indexOf("--path");
	const repoRoot = i >= 0 && argv[i + 1] ? argv[i + 1] : process.cwd();
	const state = protocolState(repoRoot);
	json({ repoRoot, ...state, summary: describeProtocolState(state) });
}

function dispatchProtocol(argv) {
	const sub = argv[0];
	switch (sub) {
		case "status": return cmdProtocolStatus(argv.slice(1));
		default: usageFail(`protocol: ${sub ? `unknown subcommand '${sub}'` : "missing subcommand"} (expected status)`);
	}
}

function dispatchSkills(argv) {
	const [sub, name] = argv;
	switch (sub) {
		case "list": return cmdSkillsList();
		case "read": if (!name) usageFail("skills read: missing skill name"); return cmdSkillsRead(name);
		case "write": if (!name) usageFail("skills write: missing skill name"); return cmdSkillsWrite(name);
		default: usageFail(`skills: ${sub ? `unknown subcommand '${sub}'` : "missing subcommand"} (expected list|read|write)`);
	}
}

function dispatchEnv(sub) {
	if (sub && sub !== "list") usageFail(`env: unknown subcommand '${sub}' (expected list)`);
	return cmdEnvList();
}

// An unhandled rejection must not exit 0 with an empty stdout: the WebUI
// treats a zero exit as "the CLI answered", and a silent success is the one
// failure mode a JSON-over-argv contract cannot recover from.
main().catch((error) => {
	fail(String(error?.stack ?? error?.message ?? error), 1);
});