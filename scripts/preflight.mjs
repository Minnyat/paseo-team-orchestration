#!/usr/bin/env node
// preflight.mjs — host readiness check for the paseo-team-orchestration role pack.
//
// Usage:
//   node scripts/preflight.mjs [--json] [--strict] [--host-id <id>] [--cluster <path>]
//                              [--routes <path>] [--skip-models]
//
// Checks (per host): node, git, paseo CLI + daemon, pi CLI, pi-mcp-adapter,
// role-pack extension + prompts, Paseo role providers, model inventory,
// routing-config validity, per-model thinking support, cluster routing
// contract, endpoint env presence, the browser surface both runtimes share,
// repository state.
//
// Never prints secret values: only env-var NAMES are checked/reported.
// Exit code 1 when any check fails. In --strict mode, warnings that affect
// the ability to route the current task (missing routing config, unreadable
// model inventory, silently-clamped thinking levels, missing required remote
// endpoint env) are escalated to failures — unverifiable is NOT a pass.

import { execFileSync, execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
// Only for the ONE path that is a historical constant rather than a resolved
// location: the pre-unification default of the pack's config directory.
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	claudeUserConfigPath,
	readJsonOrNull,
	verify as verifyClaudeSetup,
} from "./claude-setup.mjs";
import { orchestrationPreferencesNotice } from "./lib-common.mjs";
// Lives in cli/lib because that is where the pack's path knowledge lives
// (config-walker.mjs). preflight.mjs is never copied into the installed support
// directory, so this relative path always resolves to the package it shipped in
// — which is the whole point: one side of the comparison must BE this release.
import { installDrift, summarizeDrift } from "../cli/lib/install-drift.mjs";
// The SAME path resolution the installers use. Not `homedir()`: install.sh and
// install.ps1 both honour PI_HOME and PI_CODING_AGENT_DIR, and preflight used
// to hardcode ~/.pi/agent — so on a host with either override set it reported
// `extension`, `policy-core` and `role-prompts` as missing on a correctly
// installed pack, while `install-drift` (which already resolved through the
// walker) reported the same host as fine. Two halves of one command
// disagreeing, and the failing half naming a path the installer never wrote to.
import * as cw from "../cli/lib/config-walker.mjs";
import { describeProtocolState, protocolState } from "../cli/lib/workspace-protocol.mjs";
import {
	RoutingError,
	buildProviderInventory,
	defaultClusterRoutingPath,
	defaultRoutingDir,
	loadClusterConfig,
	loadRoutingConfig,
	missingHostCapabilities,
	modelsCacheKey,
	resolveClusterRoute,
	resolveRoute,
	validateRemoteEndpoint,
	cmdPercentExpansionRisk,
	MODEL_CLASSES,
	PROVIDER_OK_STATUSES,
	providerFamily,
} from "./model-routing.mjs";

const PINNED = Object.freeze({
	paseo: "0.2.5",
	pi: "0.83.0",
	adapter: "2.19.0",
	nodeMajor: 22,
});

const wantJson = process.argv.includes("--json");
const skipModels = process.argv.includes("--skip-models");
const wantStrict = process.argv.includes("--strict");
/**
 * Which runtime families this host is expected to serve. A mixed fleet runs
 * both; a Claude-only host must not fail on missing pi bits, and vice versa.
 * Explicit --runtime wins; otherwise the installed CLIs decide, so an
 * unconfigured host still reports the truth instead of a false failure.
 */
const runtimeOpt = (() => {
	const i = process.argv.indexOf("--runtime");
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1].toLowerCase() : null;
})();
const opt = (name, fallback) => {
	const i = process.argv.indexOf(name);
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const routesPath = opt(
	"--routes",
	join(defaultRoutingDir(), "model-routing.local.json"),
);
// Not configurable: this path exists only to warn that a leftover legacy
// registry is no longer read. The cluster file is the only host source.
const legacyHostsPath = join(defaultRoutingDir(), "hosts.local.json");
const clusterPath = opt("--cluster", defaultClusterRoutingPath());
const hostIdArg = opt("--host-id", undefined);

const results = [];
function report(id, status, detail = "") {
	results.push({ id, status, detail });
	if (!wantJson) {
		const mark = status === "pass" ? "✓" : status === "warn" ? "⚠" : "✗";
		console.log(`${mark} ${id}${detail ? ` — ${detail}` : ""}`);
	}
}
const pass = (id, detail) => report(id, "pass", detail);
const warn = (id, detail) => report(id, "warn", detail);
const fail = (id, detail) => report(id, "fail", detail);
const clusterExplicit = process.argv.includes("--cluster");

/** In strict mode, route-affecting warnings are failures. */
const strictCheck = wantStrict ? fail : warn;

// On Windows, npm-installed CLIs (paseo, pi) are .cmd shims which execFile
// cannot spawn directly; route those through the shell via execSync. All
// arguments passed to tryExec are static literals (never user input), so
// joining them into a command string is safe.
const NEEDS_SHELL = process.platform === "win32";

function tryExec(cmd, argv, timeoutMs = 30000) {
	try {
		const stdout = NEEDS_SHELL
			? execSync([cmd, ...argv.map(String)].join(" "), {
					timeout: timeoutMs,
					encoding: "utf8",
					stdio: ["ignore", "pipe", "pipe"],
					env: process.env,
				})
			: execFileSync(cmd, argv, {
					timeout: timeoutMs,
					encoding: "utf8",
					stdio: ["ignore", "pipe", "pipe"],
					env: process.env,
				});
		return { ok: true, stdout };
	} catch (error) {
		return {
			ok: false,
			stdout: error?.stdout ? String(error.stdout) : "",
			error: String(error?.message ?? error),
		};
	}
}

function summarizeMessages() {
	if (results.some((r) => r.status === "fail")) return 1;
	return 0;
}

// --- node / git / CLIs --------------------------------------------------------

{
	const ocr = tryExec("ocr", ["version"]);
	if (!ocr.ok) {
		warn("ocr-cli", "ocr CLI unavailable — independent-reviewer OCR workflow is blocked (install @alibaba-group/open-code-review)");
	} else {
		const versionLine = ocr.stdout.trim().split(/\r?\n/)[0] || "";
		const parsed = versionLine.match(/open-code-review v(\d+)\.(\d+)\.(\d+)/i);
		// Compatibility is capability-based; the version only gates a warning
		// when it is below the verified 1.8.10 baseline or unparseable.
		const meetsBaseline =
			parsed &&
			(Number(parsed[1]) > 1 ||
				(Number(parsed[1]) === 1 &&
					(Number(parsed[2]) > 8 ||
						(Number(parsed[2]) === 8 && Number(parsed[3]) >= 10))));
		if (meetsBaseline) pass("ocr-cli", versionLine);
		else warn("ocr-cli", `${versionLine || "installed"} — below the verified open-code-review v1.8.10 baseline; reviewer wrapper capability probes will fail closed`);
		for (const command of ["preview", "rule"]) {
			const help = tryExec("ocr", ["delegate", command, "--help"]);
			if (help.ok && help.stdout.includes("--repo") && help.stdout.includes("--from")) pass(`ocr-capability:${command}`, "delegate capability available");
			else warn(`ocr-capability:${command}`, "delegate capability probe failed — reviewer wrapper will fail closed");
		}
	}
}
{
	const major = Number(process.versions.node.split(".")[0]);
	if (major >= PINNED.nodeMajor) pass("node", process.versions.node);
	else
		fail(
			"node",
			`node ${process.versions.node} < required ${PINNED.nodeMajor}`,
		);
}
{
	const git = tryExec("git", ["--version"]);
	if (git.ok) pass("git", git.stdout.trim());
	else fail("git", "git CLI not found");
}
{
	const v = tryExec("paseo", ["--version"]);
	if (!v.ok) fail("paseo-cli", "paseo CLI not found");
	else {
		const version = v.stdout.trim();
		if (version === PINNED.paseo) pass("paseo-cli", version);
		else
			warn(
				"paseo-cli",
				`detected ${version}, role pack was verified against ${PINNED.paseo}`,
			);
	}
}
const piCli = tryExec("pi", ["--version"]);
const claudeCli = tryExec("claude", ["--version"]);
const runtimes = (() => {
	if (runtimeOpt === "pi" || runtimeOpt === "claude") return [runtimeOpt];
	if (runtimeOpt === "both") return ["pi", "claude"];
	if (runtimeOpt) {
		fail("runtime", `unknown --runtime "${runtimeOpt}" (pi|claude|both)`);
		return ["pi"];
	}
	const detected = [
		...(piCli.ok ? ["pi"] : []),
		...(claudeCli.ok ? ["claude"] : []),
	];
	// Nothing detected: keep the historical behaviour and report the pi gaps.
	return detected.length > 0 ? detected : ["pi"];
})();
const wantPi = runtimes.includes("pi");
const wantClaude = runtimes.includes("claude");
pass("runtime", runtimes.join(" + "));

if (wantPi) {
	if (!piCli.ok) fail("pi-cli", "pi CLI not found");
	else {
		const version = piCli.stdout.trim();
		if (version === PINNED.pi) pass("pi-cli", version);
		else
			warn(
				"pi-cli",
				`detected ${version}, role pack was verified against ${PINNED.pi}`,
			);
	}
}
if (wantClaude) {
	if (!claudeCli.ok) fail("claude-cli", "claude CLI not found");
	else pass("claude-cli", claudeCli.stdout.trim());
}

// --- daemon -------------------------------------------------------------------

let daemonUp = false;
{
	const status = tryExec("paseo", ["status", "--json"]);
	if (status.ok) {
		try {
			const parsed = JSON.parse(status.stdout);
			if (parsed.localDaemon) {
				daemonUp = true;
				pass("paseo-daemon", `${parsed.localDaemon} (${parsed.listen ?? "?"})`);
			} else {
				warn("paseo-daemon", "status returned but localDaemon field missing");
			}
		} catch {
			fail("paseo-daemon", "paseo status --json did not return JSON");
		}
	} else {
		fail("paseo-daemon", `daemon unreachable: ${status.error.slice(0, 160)}`);
	}
}

// --- Paseo's bundled MCP server accepts a newer protocol header ----------------
//
// Paseo injects its orchestration MCP into every agent over HTTP, and its
// pinned @modelcontextprotocol/sdk 400s a client that sends a protocol revision
// newer than the SDK knows — which Claude Code does. Unpatched, every
// `create_agent` / `send_agent_prompt` / `list_agents` from a Claude seat fails
// mid-turn with nothing in the seat's own transcript explaining it; the only
// trace is a line in ~/.paseo/daemon.log. That is precisely the kind of silence
// preflight exists to break, and it comes back on every Paseo upgrade.
{
	try {
		const { resolveSdkDir, runPatch } = await import("./patch-paseo-mcp.mjs");
		const sdkDir = resolveSdkDir();
		const result = runPatch({ sdkDir, mode: "verify" });
		if (result.patched) pass("paseo-mcp-protocol", sdkDir);
		else
			fail(
				"paseo-mcp-protocol",
				"Paseo's bundled MCP SDK rejects Claude Code's protocol header — Claude seats lose the whole Paseo tool surface → run: node scripts/patch-paseo-mcp.mjs --apply (re-run after every `npm i -g @getpaseo/cli`)",
			);
	} catch (err) {
		// No global Paseo install, an unreadable one, or an SDK layout this patch
		// does not recognise. None of those is a reason to fail a preflight that
		// may be running on a controller with no local daemon at all.
		warn("paseo-mcp-protocol", `not checked: ${String(err.message).slice(0, 160)}`);
	}
}

// --- pi-mcp-adapter -----------------------------------------------------------

if (wantPi) {
	const list = tryExec("pi", ["list"]);
	const hasAdapter = list.ok && list.stdout.includes("pi-mcp-adapter");
	if (!hasAdapter) {
		fail(
			"mcp-adapter",
			"pi-mcp-adapter not installed → Paseo cannot inject MCP tools into pi agents (install: pi install npm:pi-mcp-adapter@" +
				PINNED.adapter +
				")",
		);
	} else {
		const pkgPath = join(
			cw.agentDir(),
			"npm",
			"node_modules",
			"pi-mcp-adapter",
			"package.json",
		);
		let version = "unknown";
		try {
			version = JSON.parse(readFileSync(pkgPath, "utf8")).version ?? "unknown";
		} catch {
			/* keep unknown */
		}
		if (version === PINNED.adapter) pass("mcp-adapter", version);
		else if (version === "unknown")
			warn("mcp-adapter", "installed but version unreadable");
		else warn("mcp-adapter", `detected ${version}, pinned ${PINNED.adapter}`);
	}
}

// --- browser surface ----------------------------------------------------------
//
// The pack used to install `agent-browser` and probe it here: CLI, Chrome
// runtime, bundled skill, an MCP entry per runtime, and a CDP attach target.
// All of it is gone. Both runtimes now use a browser they already have —
// Paseo Browser Control, which the daemon registers on its own MCP server and
// injects into EVERY seat (gated on `daemon.browserTools.enabled` plus a
// broker, never on the provider), and Claude in Chrome on Claude seats.
//
// So the browser check that remains is `paseo-mcp-protocol` above: Browser
// Control rides the same /mcp/agents server as create_agent, and when that
// server refuses Claude's protocol header the browser goes with it.
{
	// readJsonOrNull returns null for "absent" and undefined for "present but
	// unreadable"; neither is evidence that the browser is off, and the default
	// when the key is missing is enabled.
	const daemonConfig = readJsonOrNull(cw.paseoConfigPath());
	const browserToolsOff =
		Boolean(daemonConfig) && daemonConfig?.daemon?.browserTools?.enabled === false;
	if (browserToolsOff)
		fail(
			"paseo-browser-tools",
			`daemon.browserTools.enabled is false in ${cw.paseoConfigPath()} — no seat has a browser on either runtime. Set it to true (\`pteam config write paseo\`) or accept that BROWSER_MCP_AUTHORITY grants nothing.`,
		);
	else pass("paseo-browser-tools", "daemon.browserTools enabled (default)");
}

// --- role-pack installation ---------------------------------------------------

if (wantPi) {
	const extPath = cw.policyExtensionPath();
	if (existsSync(extPath)) pass("extension", extPath);
	else fail("extension", `${extPath} missing → run scripts/install.{sh,ps1}`);
}
{
	// Both runtimes read the SAME policy core and the SAME role prompts, so
	// these are checked regardless of family.
	const coreDir = join(cw.extensionsDir(), "paseo-team-core");
	// Either extension satisfies the check: `.ts` is what pi loads, `.js` is the
	// built sibling, and an install carrying only one of them is still complete.
	const coreModule = (name) =>
		[join(coreDir, `${name}.js`), join(coreDir, `${name}.ts`)].find((p) => existsSync(p)) ?? null;
	const missingModules = ["policy-core", "claude-policy"].filter(
		(name) => coreModule(name) === null,
	);
	if (missingModules.length > 0) {
		fail(
			"policy-core",
			`missing ${missingModules.join(", ")} in ${coreDir} → run scripts/install.{sh,ps1}`,
		);
	} else {
		// Presence is not enough. Pi's extension loader SWALLOWS an import
		// failure and starts with no policy at all, so a core that is present
		// but unparseable — or an adapter left pointing at an old filename —
		// looks identical to a healthy install until a Peer runs unrestricted.
		// Importing it here is the only check that actually proves it loads.
		try {
			const core = await import(pathToFileURL(coreModule("policy-core")).href);
			const claudeDialect = await import(
				pathToFileURL(coreModule("claude-policy")).href
			);
			if (
				typeof core.parseTaskBrief !== "function" ||
				typeof claudeDialect.claudeToolBlockReason !== "function"
			) {
				fail("policy-core", `${coreDir} loaded but does not export the policy API`);
			} else {
				pass("policy-core", coreDir);
			}
		} catch (error) {
			fail(
				"policy-core",
				`${coreDir} failed to load (pi would start with NO policy): ${String(error?.message ?? error).slice(0, 200)}`,
			);
		}
	}
}
if (wantClaude) {
	// In-process rather than a subprocess: the verifier is a sibling module and
	// spawning it would re-enter the same quoting path that breaks on Windows
	// paths containing spaces ("C:\Program Files\nodejs\node.exe").
	try {
		const state = await verifyClaudeSetup();
		if (state.ok) pass("claude-hooks", state.settingsPath);
		else
			fail(
				"claude-hooks",
				`missing ${state.missing.join(", ")} → run: node scripts/claude-setup.mjs --install`,
			);
	} catch (error) {
		fail("claude-hooks", `claude setup unreadable: ${String(error?.message ?? error).slice(0, 160)}`);
	}
}
{
	const promptsDir = cw.promptsDir();
	const missing = cw.ROLE_PROMPTS.filter((r) => !existsSync(cw.rolePromptPath(r)));
	if (missing.length === 0) pass("role-prompts", promptsDir);
	else fail("role-prompts", `missing prompts: ${missing.join(", ")}`);
}

// --- installed copies vs THIS release ----------------------------------------
//
// Every check above asks whether an artifact is present and usable. None of
// them asks whether it is the CURRENT one, and a policy core from three
// releases ago is present, loads, and exports the same API. `pteam update`
// already tells the user to run this command "to confirm the installed copies
// match this version"; this is the check that makes that true.
//
// A warning, not a failure, except in --strict: drift means the rules a running
// agent enforces are not the rules this CLI reports, which is exactly the
// unverifiable state --strict exists to reject.
{
	try {
		const state = installDrift();
		if (state.ok) {
			pass("install-drift", "installed copies match this release");
		} else if (!state.installed) {
			// Never installed for this user. The extension/prompt/policy-core
			// checks above already say so; repeating it as a file listing helps
			// nobody, so name the remedy once. Keyed on the pi adapter's absence
			// rather than on "every verdict is missing", or a complete install
			// short one new file would be reported as no install at all — and the
			// filename that would fix it suppressed.
			warn(
				"install-drift",
				"the pack is not installed for this user → run scripts/install.{sh,ps1} (or `pteam install`)",
			);
		} else {
			// A prompt or skill can differ because the operator ran
			// `pteam prompts write` / `pteam skills write`, both of which
			// deliberately edit the installed copy. It is still drift — the rules
			// a running agent enforces are not this release's — so --strict still
			// rejects it, which is the point of a mode that gates routing. What
			// changes is the remedy: `pteam install` OVERWRITES that edit, and a
			// check that tells someone to destroy their own customization without
			// saying so is worse than one that says nothing.
			const onlyCustomizable = state.drift.every(
				(d) => (d.kind === "prompt" || d.kind === "skill") && d.verdict === "changed",
			);
			const parts = [...summarizeDrift(state.drift), ...state.unchecked];
			strictCheck(
				"install-drift",
				`${state.drift.length} file(s) differ from this release: ${parts.join(" | ")} — ${
					onlyCustomizable
						? "re-run `pteam install` to match the release, which OVERWRITES a local `pteam prompts write` / `pteam skills write` edit"
						: "re-run `pteam install`"
				}`,
			);
		}
	} catch (error) {
		strictCheck(
			"install-drift",
			`could not compare installed copies: ${String(error?.message ?? error).slice(0, 160)}`,
		);
	}
}

// --- role providers + model inventory -----------------------------------------

const modelsCache = new Map();
function listModels(roleProvider) {
	if (modelsCache.has(roleProvider)) return modelsCache.get(roleProvider);
	const res = tryExec(
		"paseo",
		["provider", "models", roleProvider, "--json"],
		120000,
	);
	if (!res.ok) {
		modelsCache.set(roleProvider, null);
		return null;
	}
	try {
		const models = JSON.parse(res.stdout);
		modelsCache.set(roleProvider, models);
		return models;
	} catch {
		modelsCache.set(roleProvider, null);
		return null;
	}
}

const providersById = new Map();
if (daemonUp) {
	const ls = tryExec("paseo", ["provider", "ls", "--json"]);
	if (ls.ok) {
		try {
			const providers = JSON.parse(ls.stdout);
			for (const p of Array.isArray(providers) ? providers : []) {
				providersById.set(p.provider ?? p.id, p);
			}
		} catch {
			fail("role-providers", "paseo provider ls --json did not return JSON");
		}
		const expectedRoleProviders = runtimes.flatMap((family) =>
			["supervisor", "lead", "peer"].map((role) => `${family}-${role}`),
		);
		for (const role of expectedRoleProviders) {
			const entry = providersById.get(role);
			if (!entry)
				// The remediation is family-specific: this loop covers pi-* too, and
				// `claude-setup --apply` only ever writes the claude-* block. Sending
				// a pi-only operator there is sending them to a command that cannot
				// create the provider they are missing.
				fail(
					`role-provider:${role}`,
					role.startsWith("claude-")
						? "not registered in ~/.paseo/config.json -> run: node scripts/claude-setup.mjs --apply"
						: "not registered in ~/.paseo/config.json -> copy it from config/paseo.providers.example.json (claude-setup --apply writes only the claude-* providers)",
				);
			else if (
				String(entry.enabled).toLowerCase() !== "enabled" &&
				entry.enabled !== true
			) {
				fail(`role-provider:${role}`, "registered but disabled");
			} else {
				// A provider can be enabled AND unhealthy — printing the status
				// next to a ✓ is a false pass. Reject the same statuses the
				// route resolver rejects.
				const status =
					typeof entry.status === "string" ? entry.status.toLowerCase() : null;
				if (status !== null && !PROVIDER_OK_STATUSES.has(status)) {
					fail(
						`role-provider:${role}`,
						`status "${entry.status}" is unhealthy (expected: ${[...PROVIDER_OK_STATUSES].join("/")})`,
					);
				} else if (skipModels) {
					pass(`role-provider:${role}`, String(entry.status ?? "ok"));
				} else {
					// "available" is a claim about the PROVIDER, not about anything
					// routable behind it. A registered, enabled, healthy provider whose
					// model inventory comes back EMPTY passes every check above and
					// cannot serve a single create_agent — the same shape of trap as a
					// permission that looks granted while the daemon never registered
					// the tool. Observed live on `pi-peer`.
					const models = listModels(role);
					// An `{ error }` body that paseo returns with exit 0 parses fine and
					// is NOT an empty inventory. Telling an operator to go check their
					// credentials when the daemon simply failed to answer sends them to
					// fix something that is not broken.
					if (models === null || !Array.isArray(models)) {
						warn(
							`role-provider:${role}`,
							`status "${entry.status ?? "ok"}" but its model inventory could not be read — routability is unverified`,
						);
					} else if (models.length === 0) {
						strictCheck(
							`role-provider:${role}`,
							`reports status "${entry.status ?? "ok"}" but list_models is EMPTY — nothing can be routed through it. "available" describes the provider, not its inventory: check the credentials/base URL behind ${role} in ~/.paseo/config.json.`,
						);
					} else {
						pass(
							`role-provider:${role}`,
							`${entry.status ?? "ok"}, ${models.length} model(s)`,
						);
					}
				}
			}
		}
	} else {
		fail("role-providers", "could not list providers");
	}
}

// --- routing config + routes ---------------------------------------------------

const routesExplicit = process.argv.includes("--routes");
let routing = null;
if (!existsSync(routesPath)) {
	if (routesExplicit) {
		fail("routing-config", `${routesPath} (explicit --routes) does not exist`);
	} else {
		strictCheck(
			"routing-config",
			`${routesPath} missing (copy config/model-routing.example.json and edit). Routing checks skipped.`,
		);
	}
} else {
	try {
		routing = loadRoutingConfig(routesPath);
		pass("routing-config", `hostId=${routing.hostId}`);
	} catch (error) {
		if (error instanceof RoutingError) fail("routing-config", error.message);
		else fail("routing-config", String(error));
	}
}

// Per-model thinkingLevelMap from ~/.pi/agent/models.json (level null = unsupported).
function piModelLevelUnreachable(piProvider, modelId, level) {
	const modelsJsonPath = join(cw.agentDir(), "models.json");
	if (!existsSync(modelsJsonPath)) return false;
	try {
		const data = JSON.parse(readFileSync(modelsJsonPath, "utf8"));
		const provider = data?.providers?.[piProvider];
		if (!provider) return false;
		const model = (provider.models ?? []).find((m) => m?.id === modelId);
		const map = model?.thinkingLevelMap;
		if (map && level in map && map[level] === null) return true;
	} catch {
		/* unreadable → do not block */
	}
	return false;
}

if (routing && daemonUp && !skipModels) {
	for (const modelClass of MODEL_CLASSES) {
		const route = routing.routes[modelClass];
		const models = listModels(route.paseoProvider);
		if (models === null) {
			strictCheck(
				`route:${modelClass}`,
				`could not list models for ${route.paseoProvider} (daemon busy?)${wantStrict ? " — strict: unverifiable is not a pass" : ""}`,
			);
			continue;
		}
		// buildProviderInventory keeps `status` intact and the resolver runs
		// in strict mode when --strict was passed — an enabled-but-erroring
		// provider or an unverifiable thinking list must NOT be a pass.
		const inventory = {
			providers: buildProviderInventory([...providersById.values()]),
			models,
		};
		try {
			const resolved = resolveRoute(routing, modelClass, inventory, {
				strict: wantStrict,
			});
			// Per-model thinkingLevelMap guard (Paseo's list does not reflect it).
			// pi ONLY: the map lives in ~/.pi/agent/models.json, and a Claude model
			// id is a single segment — splitting one at indexOf("/") === -1 yielded
			// a truncated provider name ("claude-opus-") and looked it up anyway.
			const clamped =
				providerFamily(route.paseoProvider) === "pi" &&
				piModelLevelUnreachable(
					resolved.model.slice(0, resolved.model.indexOf("/")),
					resolved.model.slice(resolved.model.indexOf("/") + 1),
					route.thinking,
				);
			if (clamped) {
				strictCheck(
					`route:${modelClass}`,
					`model ${route.model} has thinkingLevelMap.${route.thinking}=null in ${join(cw.agentDir(), "models.json")} — pi will CLAMP the level silently; pick a supported level or another model`,
				);
			} else {
				pass(
					`route:${modelClass}`,
					`${resolved.createAgentProvider} + thinking=${route.thinking}`,
				);
			}
		} catch (error) {
			if (error instanceof RoutingError)
				fail(`route:${modelClass}`, error.message);
			else fail(`route:${modelClass}`, String(error));
		}
	}
} else if (routing && skipModels) {
	warn("routes", "model inventory checks skipped (--skip-models)");
}

// --- legacy hosts.local.json migration notice ------------------------------------
// The N-host registry was replaced by the single controller-local cluster file.
// Removing the reader silently would leave a stale hosts.local.json looking
// authoritative while nothing read it, so say so once, loudly, instead.

if (existsSync(legacyHostsPath)) {
	warn(
		"hosts-config:legacy-file",
		`${legacyHostsPath} is a REMOVED legacy format and is ignored — move its entries into ${clusterPath} (see docs/multi-host.md) and delete the file`,
	);
}
if (process.argv.includes("--hosts")) {
	warn(
		// A distinct id: both conditions can hold at once, and two checks
		// sharing one id breaks every consumer that keys the report by id —
		// including this file's own uniqueness test.
		"hosts-config:removed-flag",
		"--hosts was removed with the legacy host registry; pass --cluster <path> instead",
	);
}

// --- live remote preflight helpers ---------------------------------------------

/** Structural endpoint validation lives in model-routing.mjs so it can be
 * unit-tested: parse-based per scheme (offer URL / tcp:// with query params /
 * host:port), never a raw character whitelist. */
const isSafeEndpointValue = validateRemoteEndpoint;

/** Chars that can never appear in ANY argv element we quote for cmd.exe
 * (static literals are short ascii; endpoint values already passed the
 * stricter isSafeEndpointValue check). */
const UNSAFE_ARGV_RE = /[\s"'`<>|()[\]{}\\]/;

/** Quote one argv element for cmd.exe when NEEDS_SHELL joins the command. */
function cmdQuote(value) {
	if (UNSAFE_ARGV_RE.test(value)) {
		throw new Error(`refusing to pass unsafe argv value to shell`);
	}
	return `"${value}"`;
}
/**
 * Run a paseo CLI command against a remote endpoint.
 *
 * On Windows (.cmd shims) every argv element is quoted through cmdQuote.
 *
 * The redaction is the load-bearing part, and it belongs HERE rather than at
 * each call site. An endpoint is a pairing offer — a secret — and it travels
 * inside argv, which is the safe channel. But a failing `execFileSync` puts the
 * whole command line into `error.message` ("Command failed: paseo ls --host
 * <secret> --json"), and preflight reported that verbatim when a remote daemon
 * was unreachable. So the file that opens with "Never prints secret values"
 * printed one on the single most likely failure of the remote lane, straight
 * into output that gets pasted into issues and chat logs.
 *
 * scripts/remote-paseo.mjs already redacts exactly this, which is the point:
 * the rule was known and implemented once, and the second place running the
 * same command with the same secret did not inherit it. Doing it inside the
 * helper makes every consumer safe by construction instead of by remembering.
 */
function remoteExec(argv, timeoutMs = 60000) {
	const hostAt = argv.indexOf("--host");
	const secret = hostAt >= 0 ? argv[hostAt + 1] : undefined;
	const redact = (text) =>
		secret && typeof text === "string"
			? text.split(secret).join("<endpoint-value-redacted>")
			: text;
	const result = NEEDS_SHELL
		? tryExecRaw([argv[0], ...argv.slice(1).map(cmdQuote)].join(" "), timeoutMs)
		: tryExec(argv[0], argv.slice(1), timeoutMs);
	return {
		...result,
		stdout: redact(result.stdout),
		...(result.error === undefined ? {} : { error: redact(result.error) }),
	};
}

function tryExecRaw(commandString, timeoutMs) {
	try {
		const stdout = execSync(commandString, {
			timeout: timeoutMs,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			env: process.env,
		});
		return { ok: true, stdout };
	} catch (error) {
		return {
			ok: false,
			stdout: error?.stdout ? String(error.stdout) : "",
			error: String(error?.message ?? error),
		};
	}
}

const remoteModelsCache = new Map();
/**
 * Model inventory is per-DAEMON. The cache key must therefore carry the
 * host identity, never the role-provider name alone — two remote hosts
 * serving the same "pi-peer" provider do NOT share an inventory, and a
 * mixed cache would let a preflight pass on a model that only exists on
 * the other host.
 */
function listModelsRemote(hostId, endpointValue, roleProvider) {
	const key = modelsCacheKey(hostId, roleProvider);
	if (remoteModelsCache.has(key)) {
		return remoteModelsCache.get(key);
	}
	const res = remoteExec(
		[
			"paseo",
			"provider",
			"models",
			roleProvider,
			"--host",
			endpointValue,
			"--json",
		],
		120000,
	);
	let models = null;
	if (res.ok) {
		try {
			const parsed = JSON.parse(res.stdout);
			models = Array.isArray(parsed) ? parsed : (parsed?.models ?? null);
		} catch {
			models = null;
		}
	}
	remoteModelsCache.set(key, models);
	return models;
}

function runRemotePreflight(hostId, host, endpointValue) {
	// 1. daemon reachable?
	const reach = remoteExec(["paseo", "ls", "--host", endpointValue, "--json"]);
	if (!reach.ok) {
		fail(
			`cluster-remote:${hostId}`,
			`remote daemon unreachable via ${host.connection.endpointEnv}: ${String(reach.error).slice(0, 120)}`,
		);
		return;
	}
	pass(`cluster-remote:${hostId}`, "remote daemon reachable (offer accepted)");

	// 2. role providers present + enabled + healthy on the remote daemon.
	const ls = remoteExec([
		"paseo",
		"provider",
		"ls",
		"--host",
		endpointValue,
		"--json",
	]);
	const remoteProviders = new Map();
	if (ls.ok) {
		try {
			for (const p of JSON.parse(ls.stdout)) {
				remoteProviders.set(p.provider ?? p.id, p);
			}
		} catch {
			fail(
				`cluster-remote:${hostId}:providers`,
				"provider ls --json unparseable",
			);
			return;
		}
	} else {
		fail(
			`cluster-remote:${hostId}:providers`,
			"could not list remote providers",
		);
		return;
	}
	const neededProviders = new Set(
		Object.values(host.routes).map((r) => r.paseoProvider),
	);
	for (const roleProvider of neededProviders) {
		const entry = remoteProviders.get(roleProvider);
		const status = String(entry?.status ?? "").toLowerCase();
		const enabled =
			entry?.enabled === true ||
			String(entry?.enabled ?? "").toLowerCase() === "enabled";
		if (!entry) {
			fail(
				`cluster-remote:${hostId}:provider:${roleProvider}`,
				"role provider NOT registered on remote daemon",
			);
		} else if (!enabled || !PROVIDER_OK_STATUSES.has(status)) {
			fail(
				`cluster-remote:${hostId}:provider:${roleProvider}`,
				`status="${entry.status}" enabled=${entry.enabled} (need enabled + healthy status: ${[...PROVIDER_OK_STATUSES].join("/")})`,
			);
		} else {
			pass(
				`cluster-remote:${hostId}:provider:${roleProvider}`,
				"enabled + healthy",
			);
		}
	}

	// 3. Route resolution against the REMOTE inventory.
	const inventoryProviders = buildProviderInventory([
		...remoteProviders.values(),
	]);
	for (const modelClass of MODEL_CLASSES) {
		const route = host.routes[modelClass];
		const models = listModelsRemote(hostId, endpointValue, route.paseoProvider);
		if (models === null) {
			strictCheck(
				`cluster-remote:${hostId}:route:${modelClass}`,
				`could not list models for ${route.paseoProvider} on remote`,
			);
			continue;
		}
		try {
			const resolved = resolveClusterRoute(
				cluster,
				hostId,
				modelClass,
				{ providers: inventoryProviders, models },
				{ strict: wantStrict },
			);
			pass(
				`cluster-remote:${hostId}:route:${modelClass}`,
				resolved.createAgentProvider,
			);
		} catch (error) {
			fail(
				`cluster-remote:${hostId}:route:${modelClass}`,
				error instanceof RoutingError ? error.message : String(error),
			);
		}
	}
}

// The repo-clean writer gate must use the host that was actually selected
// for verification (possibly inferred), not only an explicit --host-id.
let clusterVerifyHostId;

// --- cluster routing contract (controller-local) ------------------------------

// In strict mode the cluster contract file is REQUIRED (missing → exit 1).
// Otherwise absence only warns so single-host dev setups keep working.
let cluster = null;
if (existsSync(clusterPath)) {
	try {
		cluster = loadClusterConfig(clusterPath);
		pass(
			"cluster-config",
			`${Object.keys(cluster.hosts).length} host(s): ${Object.keys(cluster.hosts).join(", ")}`,
		);
	} catch (error) {
		fail(
			"cluster-config",
			error instanceof RoutingError ? error.message : String(error),
		);
	}
} else if (clusterExplicit || wantStrict) {
	fail("cluster-config", `${clusterPath} missing (required in strict mode)`);
} else {
	warn(
		"cluster-config",
		`${clusterPath} missing (copy config/cluster-routing.example.json; required for cross-host routing)`,
	);
}

// Two files describe routing and only one of them is ours (§4.4). Paseo's is
// left strictly alone; the check exists so an operator who edits it notices
// that the pack did not read a single line of it.
{
	const notice = orchestrationPreferencesNotice();
	if (notice) warn("routing-source-of-truth", notice.message);
	else
		pass(
			"routing-source-of-truth",
			"cluster-routing.local.json is the only routing source the pack reads",
		);
}

if (cluster) {
	for (const [hostId, host] of Object.entries(cluster.hosts)) {
		// Required remote hosts must have their endpoint env present; the VALUE
		// is never read or printed — only name-based presence is checked.
		if (host.connection.type === "remote" && host.required) {
			const envName = host.connection.endpointEnv;
			if (envName && process.env[envName]) {
				pass(
					`cluster-host:${hostId}`,
					`endpoint env ${envName} present (value not printed)`,
				);
			} else {
				strictCheck(
					`cluster-host:${hostId}`,
					`required remote host but endpoint env ${envName ?? "<missing endpointEnv>"} NOT set`,
				);
			}
		}
		// Capability contract: a host that claims review roles must not also be
		// a writer; writer hosts must carry the writer capabilities.
		if (host.limits.writers > 0) {
			const missing = missingHostCapabilities(host, "writer");
			if (missing.length > 0) {
				fail(
					`cluster-host:${hostId}`,
					`declares writers=${host.limits.writers} but lacks writer capabilities: ${missing.join(", ")}`,
				);
			}
		}
	}

	// Resolve the route for the host this preflight was asked to verify.
	// Verify targets a single host: --host-id, or the only host when the
	// cluster has exactly one. Nothing is ever verified silently — every
	// skip produces an explicit result line.
	const verifyHostId =
		hostIdArg ??
		(Object.keys(cluster.hosts).length === 1
			? Object.keys(cluster.hosts)[0]
			: undefined);
	if (!hostIdArg && verifyHostId === undefined && wantStrict) {
		fail(
			"cluster-host-select",
			"multiple hosts in cluster config; strict preflight requires --host-id <id>",
		);
	} else if (!hostIdArg && verifyHostId === undefined) {
		warn(
			"cluster-host-select",
			`multiple hosts in cluster config (${Object.keys(cluster.hosts).join(", ")}); no per-host route verification performed — pass --host-id <id>`,
		);
	}
	clusterVerifyHostId = verifyHostId;
	if (verifyHostId !== undefined) {
		const host = cluster.hosts[verifyHostId];
		if (!host) {
			fail(
				`cluster-host:${verifyHostId}`,
				`--host-id "${verifyHostId}" not present in cluster routing config`,
			);
		} else if (host.connection.type === "local" && skipModels) {
			warn(
				`cluster-route:${verifyHostId}`,
				"local route verification skipped (--skip-models)",
			);
		} else if (host.connection.type === "local" && daemonUp && !skipModels) {
			// Local host: full route resolution against the live daemon, strict.
			for (const modelClass of MODEL_CLASSES) {
				const route = host.routes[modelClass];
				const models = listModels(route.paseoProvider);
				if (models === null) {
					strictCheck(
						`cluster-route:${verifyHostId}:${modelClass}`,
						`could not list models for ${route.paseoProvider}`,
					);
					continue;
				}
				const inventory = {
					providers: buildProviderInventory([...providersById.values()]),
					models,
				};
				try {
					const resolved = resolveClusterRoute(
						cluster,
						verifyHostId,
						modelClass,
						inventory,
						{ strict: wantStrict },
					);
					pass(
						`cluster-route:${verifyHostId}:${modelClass}`,
						resolved.createAgentProvider,
					);
				} catch (error) {
					fail(
						`cluster-route:${verifyHostId}:${modelClass}`,
						error instanceof RoutingError ? error.message : String(error),
					);
				}
			}
		} else if (host.connection.type === "remote") {
			// Remote host: if the endpoint env is set AND the value passes a
			// strict shape check, perform a LIVE remote preflight via the Paseo
			// CLI (the offer URL / tcp endpoint is accepted as --host). The
			// endpoint value is never logged.
			const envName = host.connection.endpointEnv;
			const envValue = envName ? process.env[envName] : undefined;
			if (!envValue) {
				strictCheck(
					`cluster-remote:${verifyHostId}`,
					`endpoint env ${envName ?? "<missing>"} NOT set — live remote preflight skipped`,
				);
			} else if (!isSafeEndpointValue(envValue)) {
				fail(
					`cluster-remote:${verifyHostId}`,
					`endpoint env ${envName} has an unexpected shape (expected paseo offer URL or tcp:// target) — refusing to use it`,
				);
			} else if (NEEDS_SHELL && cmdPercentExpansionRisk(envValue)) {
				// cmd.exe expands %VAR% before paseo sees the argv — the endpoint
				// would be silently corrupted or leak into expansions. Fail loudly
				// rather than trying to out-quote cmd's parser.
				fail(
					`cluster-remote:${verifyHostId}`,
					`endpoint env ${envName} contains 2+ '%' characters — unsafe with cmd.exe %VAR% expansion on Windows controllers (use a pairing offer URL or a non-cmd controller)`,
				);
			} else if (skipModels) {
				warn(
					`cluster-remote:${verifyHostId}`,
					"endpoint set but --skip-models active — remote inventory checks skipped",
				);
			} else {
				runRemotePreflight(verifyHostId, host, envValue);
			}
		} else if (!daemonUp) {
			strictCheck(
				`cluster-host:${verifyHostId}`,
				"local daemon down — cluster route resolution skipped",
			);
		}
	}
}

// --- repository state (if run inside a repo) ------------------------------------

// --- the pack's config directory, after the two-variable unification ---------
//
// The pack used to resolve this directory twice under two different variable
// names, and unifying it necessarily MOVES one side: a host that set
// PST_TEAM_CONFIG_DIR for the CLI while leaving routing and Claude session
// state in the default ~/.paseo-pi-team now has every reader following the
// override. No precedence order avoids that — the whole point is that the two
// halves stop disagreeing — so the migration is reported instead of guessed
// at, the same way the removed hosts.local.json format is.
//
// Reported only when there is something to move: the resolved directory is not
// the default AND the default still holds pack files the resolved one does not.
{
	const resolved = cw.teamConfigDir();
	const legacyDefault = join(homedir(), ".paseo-pi-team");
	const PACK_FILES = [
		"model-routing.local.json",
		"cluster-routing.local.json",
		"seat-providers.json",
		"claude-provider-ledger.json",
		"claude-sessions",
	];
	if (resolved !== legacyDefault && existsSync(legacyDefault)) {
		const stranded = PACK_FILES.filter(
			(name) =>
				existsSync(join(legacyDefault, name)) && !existsSync(join(resolved, name)),
		);
		if (stranded.length > 0) {
			warn(
				"team-config-dir",
				`${resolved} is the pack's config directory (PST_TEAM_CONFIG_DIR / PASEO_TEAM_HOME), but ${legacyDefault} still holds ${stranded.join(", ")} and the resolved directory does not. Earlier releases read routing and Claude session state from the default even when the override was set; move those files across. Session state is fail-closed, so a Peer whose brief is left behind goes read-only rather than unrestricted.`,
			);
		} else pass("team-config-dir", resolved);
	} else pass("team-config-dir", resolved);
}

// --- the repository tactics layer --------------------------------------------
//
// Only meaningful inside a repository, so it rides along with the repo checks
// below rather than running on a bare host. `invalid` is the case worth the
// code: a Lead reading a protocol with an unresolved merge conflict in it does
// not get "no protocol", it gets both sides of the conflict as rules — and
// until now nothing in the pack ever opened the file to notice.
{
	const inRepo = tryExec("git", ["rev-parse", "--is-inside-work-tree"]);
	const top = tryExec("git", ["rev-parse", "--show-toplevel"]);
	if (inRepo.ok && inRepo.stdout.trim() === "true" && top.ok) {
		const state = protocolState(top.stdout.trim());
		const detail = describeProtocolState(state);
		if (state.state === "valid" && !state.legacy) pass("workspace-protocol", detail);
		// Present but unusable is the one that must not read as "absent": the
		// file is there, the Lead will open it, and what it finds is wrong.
		else if (state.state === "invalid" || state.state === "unreadable") {
			fail("workspace-protocol", detail);
		} else warn("workspace-protocol", detail);
	}
}

{
	const repo = tryExec("git", ["rev-parse", "--is-inside-work-tree"]);
	if (repo.ok && repo.stdout.trim() === "true") {
		const status = tryExec("git", ["status", "--porcelain"]);
		if (status.ok && status.stdout.trim() === "") {
			pass("repo-clean", "working tree clean");
		} else if (status.ok) {
			const dirtyWriter =
				clusterVerifyHostId !== undefined &&
				cluster !== null &&
				cluster.hosts[clusterVerifyHostId] &&
				cluster.hosts[clusterVerifyHostId].limits.writers > 0;
			if (dirtyWriter) {
				strictCheck(
					"repo-clean",
					`writer host "${clusterVerifyHostId}" has uncommitted changes — writer workspaces must start clean`,
				);
			} else if (status.ok) {
				warn(
					"repo-clean",
					"uncommitted changes present (user-owned changes must never be overwritten by agents)",
				);
			}
		}
	}
}

if (wantJson) {
	console.log(
		JSON.stringify(
			{ checks: results, ok: !results.some((r) => r.status === "fail") },
			null,
			2,
		),
	);
}
process.exit(summarizeMessages());
