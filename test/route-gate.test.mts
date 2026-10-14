// route-gate.test.mts — the create_agent route gate, on both runtimes.
//
// Every case runs through BOTH adapters' decision points: the Pi one
// (mcpBlockReason with the `{ tool, args }` proxy shape) and the Claude one
// (claudeToolBlockReason with args as the tool input). A rule that holds on one
// runtime only is a rule the other runtime is the quiet way around.
//
// Route tables are never hand-built: they are written to temp dirs and read back
// through scripts/model-routing.mjs (gateRouteTable), the loader the adapters
// use, so the file-selection rules are exercised along with the comparison.
// Two host shapes are covered, as they exist in the field: a host with only
// model-routing.local.json (no optional classes), and a controller whose
// cluster-routing.local.json holds one local and one remote host.
//
// Every call passes an explicit `env`, so an inherited PASEO_TEAM_ROUTE_ENFORCE
// (a developer running the suite from inside a Paseo seat) cannot flip a case.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, after } from "node:test";
import { fileURLToPath } from "node:url";

import {
	createAgentRouteBlockReason,
	forkRouteDecision,
	mcpBlockReason,
	routeTargetFor,
	updateAgentRouteBlockReason,
	type RouteTarget,
	routeEnforcement,
	routeEnforcementNotice,
	routingAvailabilityNotice,
	type RouteTable,
	type TeamRole,
} from "../extensions/paseo-team-core/policy-core.ts";
import { claudeToolBlockReason } from "../extensions/paseo-team-core/claude-policy.ts";
// @ts-ignore — plain .mjs module, no declarations
import { gateRouteTable } from "../scripts/model-routing.mjs";
// @ts-ignore — plain .mjs module, no declarations
import { gateTable } from "../scripts/gate-table.mjs";
// @ts-ignore — plain .mjs module, no declarations
import { handleEvent } from "../scripts/claude-hook.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = mkdtempSync(join(tmpdir(), "pteam-route-gate-"));
after(() => rmSync(sandbox, { recursive: true, force: true }));

const ENFORCED: Record<string, string | undefined> = {};

// --- fixtures ----------------------------------------------------------------

const BASE_ROUTES = {
	MONITOR_ECONOMY: { paseoProvider: "pi-supervisor", model: "Mx/cheap", thinking: "low" },
	FAST_READ: { paseoProvider: "pi-peer", model: "Mx/cheap", thinking: "low" },
	CODING_MEDIUM: { paseoProvider: "pi-peer", model: "Mx/mid", thinking: "medium" },
	REASONING_HIGH: { paseoProvider: "claude-peer", model: "claude-opus-5", thinking: "high" },
	REVIEW_HIGH: { paseoProvider: "claude-peer", model: "claude-opus-5", thinking: "xhigh" },
};
const OPTIONAL_ROUTES = {
	SUPERVISOR_GOVERNANCE: { paseoProvider: "claude-supervisor", model: "claude-opus-5", thinking: "max" },
	LEAD_RECOVERY: { paseoProvider: "pi-lead", model: "Mx/big", thinking: "high" },
};

let dirCount = 0;
/** A config dir holding exactly the given files; returns its gate table. */
function hostTable(files: { routing?: unknown; cluster?: unknown; raw?: Record<string, string> }): RouteTable {
	const dir = join(sandbox, `host-${(dirCount += 1)}`);
	mkdirSync(dir, { recursive: true });
	if (files.routing !== undefined) {
		writeFileSync(join(dir, "model-routing.local.json"), JSON.stringify(files.routing));
	}
	if (files.cluster !== undefined) {
		writeFileSync(join(dir, "cluster-routing.local.json"), JSON.stringify(files.cluster));
	}
	for (const [name, text] of Object.entries(files.raw ?? {})) writeFileSync(join(dir, name), text);
	return gateRouteTable({ env: { PST_TEAM_CONFIG_DIR: dir } }) as RouteTable;
}

/** This host today: model-routing.local.json only, no optional classes. */
const ROUTING_ONLY = { version: 1, hostId: "minnyat", routes: BASE_ROUTES };
/** A controller: one local host (all seven classes) + one remote host. */
const CLUSTER = {
	version: 1,
	hosts: {
		ctl: {
			connection: { type: "local" },
			required: true,
			capabilities: ["git-read", "git-write", "focused-test"],
			routes: { ...BASE_ROUTES, ...OPTIONAL_ROUTES },
		},
		mac: {
			connection: { type: "remote", endpointEnv: "PASEO_MAC" },
			required: false,
			capabilities: ["git-read", "independent-review"],
			routes: {
				...BASE_ROUTES,
				FAST_READ: { paseoProvider: "pi-peer", model: "Remote/only-on-mac", thinking: "low" },
			},
		},
	},
};

const routingOnly = hostTable({ routing: ROUTING_ONLY });
const clusterHost = hostTable({ cluster: CLUSTER });

// --- decision helpers: the SAME case through both adapters --------------------

type Runtime = "pi" | "claude";
const RUNTIMES: Runtime[] = ["pi", "claude"];

function decide(
	runtime: Runtime,
	role: TeamRole,
	args: unknown,
	routeTable: RouteTable | null | undefined,
	env: Record<string, string | undefined> = ENFORCED,
): string | null {
	if (runtime === "pi") {
		return mcpBlockReason(role, { tool: "create_agent", args }, { routeTable, env });
	}
	return claudeToolBlockReason({
		role,
		toolName: "mcp__paseo__create_agent",
		toolInput: args,
		brief: null,
		routeTable,
		env,
	});
}

/** A Lead seating a Peer (claude-* seats need a mode; pi seats must not have one). */
function peerArgs(provider: string, thinking: string | undefined, modelClass?: string) {
	const claude = provider.trim().toLowerCase().startsWith("claude-");
	return {
		title: "route-gate fixture",
		initialPrompt: "brief",
		provider,
		settings: {
			...(thinking === undefined ? {} : { thinkingOptionId: thinking }),
			...(claude ? { modeId: "auto" } : {}),
		},
		labels: modelClass === undefined ? {} : { "team.model-class": modelClass },
	};
}

/** A Lead seating its Supervisor (PR-H shape + the class). */
function supervisorArgs(provider = "claude-supervisor/claude-opus-5", thinking = "max", modelClass = "SUPERVISOR_GOVERNANCE") {
	return {
		title: "route-gate fixture",
		initialPrompt: "brief",
		provider,
		settings: { thinkingOptionId: thinking, modeId: "auto" },
		labels: { purpose: "governance", "team.model-class": modelClass },
	};
}

/** A Supervisor's lead recovery (recovery shape + the class). */
function recoveryArgs(provider = "pi-lead/Mx/big", thinking = "high", modelClass = "LEAD_RECOVERY") {
	return {
		title: "route-gate fixture",
		initialPrompt: "brief",
		provider,
		settings: { thinkingOptionId: thinking },
		labels: { purpose: "recovery", recovery_for: "proj", "team.model-class": modelClass },
	};
}

const blocked = (reason: string | null, pattern: RegExp, message: string) => {
	assert.ok(reason, `${message}: expected a refusal, got an allow`);
	assert.match(reason, pattern, message);
};

// --- flow 1: Lead → Peer -------------------------------------------------------

test("Lead→Peer: every base class matching its route passes, on both host shapes and runtimes", () => {
	for (const runtime of RUNTIMES) {
		for (const table of [routingOnly, clusterHost]) {
			for (const [modelClass, route] of Object.entries(BASE_ROUTES)) {
				if (route.paseoProvider.endsWith("-supervisor")) continue; // see the MONITOR_ECONOMY case
				assert.equal(
					decide(runtime, "lead", peerArgs(`${route.paseoProvider}/${route.model}`, route.thinking, modelClass), table),
					null,
					`${runtime}: ${modelClass} on its own route must pass`,
				);
			}
		}
	}
});

test("Lead→Peer: model, thinking, provider role and class mismatches are refused with the expected values", () => {
	for (const runtime of RUNTIMES) {
		blocked(
			decide(runtime, "lead", peerArgs("pi-peer/Mx/big", "medium", "CODING_MEDIUM"), routingOnly),
			/ROUTE_MODEL_MISMATCH.*"Mx\/mid".*Expected provider "pi-peer\/Mx\/mid" with settings\.thinkingOptionId "medium"/,
			`${runtime}: a different model`,
		);
		blocked(
			decide(runtime, "lead", peerArgs("pi-peer/Mx/mid", "high", "CODING_MEDIUM"), routingOnly),
			/ROUTE_THINKING_MISMATCH.*thinking "medium".*"high"/,
			`${runtime}: a different thinking level`,
		);
		blocked(
			decide(runtime, "lead", peerArgs("pi-peer/Mx/mid", undefined, "CODING_MEDIUM"), routingOnly),
			// Refused either way. The params gate runs first and names the missing
			// settings.thinkingOptionId; the route gate's own wording is the backstop.
			/ROUTE_THINKING_MISMATCH.*<missing>|"settings\.thinkingOptionId" is required/,
			`${runtime}: a dropped thinking level (the daemon would pick one)`,
		);
		blocked(
			decide(runtime, "lead", peerArgs("claude-peer/Mx/mid", "medium", "CODING_MEDIUM"), routingOnly),
			/ROUTE_PROVIDER_MISMATCH.*"pi-peer".*claude\/peer/,
			`${runtime}: a different runtime family`,
		);
		blocked(
			decide(runtime, "lead", peerArgs("pi-lead/Mx/mid", "medium", "CODING_MEDIUM"), routingOnly),
			/ROUTE_CLASS_WRONG_FLOW.*a Lead seating a lead routes from LEAD_RECOVERY/,
			`${runtime}: a different role (a Lead seat routes from LEAD_RECOVERY only)`,
		);
		blocked(
			decide(runtime, "lead", peerArgs("pi-peer/Mx/cheap", "low", "CODING_MEDIUM"), routingOnly),
			/ROUTE_MODEL_MISMATCH/,
			`${runtime}: FAST_READ's route declared as CODING_MEDIUM is a class mismatch`,
		);
		blocked(
			decide(runtime, "lead", peerArgs("pi-peer/Mx/mid", "medium", "SUPERVISOR_GOVERNANCE"), clusterHost),
			/ROUTE_CLASS_WRONG_FLOW.*a Lead seating a peer routes from MONITOR_ECONOMY/,
			`${runtime}: a governance class on a Peer`,
		);
	}
});

test("Lead→Peer: a class routed to a *-supervisor provider cannot seat a Peer (MONITOR_ECONOMY)", () => {
	for (const runtime of RUNTIMES) {
		for (const provider of ["pi-peer/Mx/cheap", "pi-supervisor/Mx/cheap"]) {
			const reason = decide(runtime, "lead", peerArgs(provider, "low", "MONITOR_ECONOMY"), routingOnly);
			if (provider.startsWith("pi-peer")) {
				blocked(
					reason,
					/ROUTE_PROVIDER_MISMATCH.*"pi-supervisor".*A class routed to a \*-supervisor provider cannot be used to seat a peer/,
					`${runtime}: MONITOR_ECONOMY → pi-supervisor cannot seat a Peer`,
				);
			} else {
				// Copying the route's own provider makes it a SUPERVISOR seating,
				// which has its own class — the loophole does not open.
				blocked(reason, /./, `${runtime}: seating a supervisor from MONITOR_ECONOMY`);
			}
		}
	}
});

test("Lead→Peer: a seat variant counts as its base family+role", () => {
	for (const runtime of RUNTIMES) {
		assert.equal(
			decide(runtime, "lead", peerArgs("claude-peer-audit/claude-opus-5", "xhigh", "REVIEW_HIGH"), routingOnly),
			null,
			`${runtime}: claude-peer-audit is claude/peer`,
		);
	}
});

// --- flow 2: Lead → Supervisor --------------------------------------------------

test("Lead→Supervisor: matches SUPERVISOR_GOVERNANCE on the cluster host; refused on each difference", () => {
	for (const runtime of RUNTIMES) {
		assert.equal(decide(runtime, "lead", supervisorArgs(), clusterHost), null, `${runtime}: matching seat passes`);
		blocked(
			decide(runtime, "lead", supervisorArgs("claude-supervisor/claude-sonnet-5"), clusterHost),
			/ROUTE_MODEL_MISMATCH.*Expected provider "claude-supervisor\/claude-opus-5" with settings\.thinkingOptionId "max"/,
			`${runtime}: supervisor on another model`,
		);
		blocked(
			decide(runtime, "lead", supervisorArgs(undefined, "high"), clusterHost),
			/ROUTE_THINKING_MISMATCH/,
			`${runtime}: supervisor at another thinking level`,
		);
		blocked(
			decide(runtime, "lead", { ...supervisorArgs("pi-supervisor/Mx/big"), settings: { thinkingOptionId: "max" } }, clusterHost),
			/ROUTE_PROVIDER_MISMATCH/,
			`${runtime}: supervisor on another family`,
		);
		blocked(
			decide(runtime, "lead", supervisorArgs(undefined, undefined, "REASONING_HIGH"), clusterHost),
			/ROUTE_CLASS_WRONG_FLOW.*a Lead seating a supervisor routes from SUPERVISOR_GOVERNANCE/,
			`${runtime}: supervisor from a Peer class`,
		);
	}
});

test("Lead→Supervisor on a model-routing-only host: refused until SUPERVISOR_GOVERNANCE is configured, naming the command", () => {
	for (const runtime of RUNTIMES) {
		blocked(
			decide(runtime, "lead", supervisorArgs(), routingOnly),
			/ROUTE_CLASS_UNCONFIGURED — SUPERVISOR_GOVERNANCE has no route on host "minnyat".*optional class.*pteam routing set SUPERVISOR_GOVERNANCE --provider claude-supervisor --model <model-id> --thinking <level>.*does not fall back/,
			`${runtime}: optional class absent`,
		);
	}
});

// --- flow 3: Supervisor → Lead recovery ----------------------------------------

test("Supervisor→Lead recovery: matches LEAD_RECOVERY; refused on each difference and when unconfigured", () => {
	for (const runtime of RUNTIMES) {
		assert.equal(decide(runtime, "supervisor", recoveryArgs(), clusterHost), null, `${runtime}: matching recovery passes`);
		blocked(
			decide(runtime, "supervisor", recoveryArgs("pi-lead/Mx/mid"), clusterHost),
			/ROUTE_MODEL_MISMATCH.*Expected provider "pi-lead\/Mx\/big" with settings\.thinkingOptionId "high"/,
			`${runtime}: recovery on another model`,
		);
		blocked(
			decide(runtime, "supervisor", recoveryArgs(undefined, "low"), clusterHost),
			/ROUTE_THINKING_MISMATCH/,
			`${runtime}: recovery at another thinking level`,
		);
		blocked(
			decide(runtime, "supervisor", {
				...recoveryArgs("claude-lead/claude-opus-5", "high"),
				settings: { thinkingOptionId: "high", modeId: "auto" },
			}, clusterHost),
			/ROUTE_PROVIDER_MISMATCH/,
			`${runtime}: recovery on another family`,
		);
		blocked(
			decide(runtime, "supervisor", recoveryArgs(undefined, undefined, "REASONING_HIGH"), clusterHost),
			/ROUTE_CLASS_WRONG_FLOW.*Lead recovery routes from LEAD_RECOVERY/,
			`${runtime}: recovery from a Peer class`,
		);
		blocked(
			decide(runtime, "supervisor", recoveryArgs(), routingOnly),
			/ROUTE_CLASS_UNCONFIGURED — LEAD_RECOVERY.*pteam routing set LEAD_RECOVERY --provider pi-lead/,
			`${runtime}: LEAD_RECOVERY absent on a model-routing-only host`,
		);
	}
});

// --- class label ---------------------------------------------------------------

test("a missing or unknown class is refused on every flow", () => {
	for (const runtime of RUNTIMES) {
		blocked(
			decide(runtime, "lead", peerArgs("pi-peer/Mx/mid", "medium"), routingOnly),
			/ROUTE_CLASS_MISSING.*team\.model-class.*MONITOR_ECONOMY, FAST_READ/,
			`${runtime}: Lead→Peer without a class`,
		);
		blocked(
			decide(runtime, "lead", { ...supervisorArgs(), labels: { purpose: "governance" } }, clusterHost),
			/ROUTE_CLASS_MISSING.*SUPERVISOR_GOVERNANCE/,
			`${runtime}: Lead→Supervisor without a class`,
		);
		blocked(
			decide(runtime, "supervisor", { ...recoveryArgs(), labels: { purpose: "recovery", recovery_for: "proj" } }, clusterHost),
			/ROUTE_CLASS_MISSING.*LEAD_RECOVERY/,
			`${runtime}: recovery without a class`,
		);
		for (const bogus of ["coding_medium", " CODING_MEDIUM", "CODING-MEDIUM", "GOVERNANCE"]) {
			blocked(
				decide(runtime, "lead", peerArgs("pi-peer/Mx/mid", "medium", bogus), routingOnly),
				/ROUTE_CLASS_UNKNOWN/,
				`${runtime}: class "${bogus}"`,
			);
		}
	}
});

// --- mutation: casing / padding cannot bypass the gate ---------------------------

test("a differently-cased or padded provider never bypasses the gate", () => {
	for (const runtime of RUNTIMES) {
		for (const provider of [
			"Pi-Peer/Mx/mid",
			"PI-PEER/Mx/mid",
			" pi-peer/Mx/mid",
			"pi-peer /Mx/mid",
			"\tpi-peer/Mx/mid",
			// The same spellings carrying a WRONG model: if any of them skipped the
			// gate (parse failed → "not a create_agent we route"), this is the
			// string that would slip an unrouted model through.
			"Pi-Peer/Mx/big",
			" pi-peer/Any/model",
		]) {
			blocked(
				decide(runtime, "lead", peerArgs(provider, "medium", "CODING_MEDIUM"), routingOnly),
				// A padded provider with a space inside ("pi-peer /Mx/mid") is not even the
				// "<role-provider>/<model-id>" shape, so the params gate (it runs first)
				// refuses it; every other spelling reaches the route gate's own check.
				/ROUTE_PROVIDER_NONCANONICAL.*must be written exactly "pi-peer"|"provider" must be "<role-provider>\/<model-id>"/,
				`${runtime}: provider ${JSON.stringify(provider)}`,
			);
		}
		// A padded MODEL is a different model id, not a spelling of the right one.
		blocked(
			decide(runtime, "lead", peerArgs("pi-peer/Mx/mid ", "medium", "CODING_MEDIUM"), routingOnly),
			/ROUTE_MODEL_MISMATCH/,
			`${runtime}: padded model`,
		);
		blocked(
			decide(runtime, "lead", peerArgs("pi-peer/Mx/mid", "Medium", "CODING_MEDIUM"), routingOnly),
			/ROUTE_THINKING_MISMATCH/,
			`${runtime}: cased thinking level (Paseo would run it at "medium" silently)`,
		);
		blocked(
			decide(runtime, "lead", peerArgs("codex-peer/x/y", "medium", "CODING_MEDIUM"), routingOnly),
			/ROUTE_PROVIDER_UNKNOWN/,
			`${runtime}: an unparseable provider is refused, not skipped`,
		);
	}
	// Pure function, directly: casing that parses still reaches the check.
	blocked(
		createAgentRouteBlockReason({
			role: "supervisor",
			args: recoveryArgs("PI-LEAD/Mx/big"),
			routeTable: clusterHost,
			env: ENFORCED,
		}),
		/ROUTE_PROVIDER_NONCANONICAL/,
		"recovery with a cased provider",
	);
});

// --- which file the gate reads ---------------------------------------------------

test("cluster host: the LOCAL host's routes are used, never the remote host's", () => {
	assert.equal(clusterHost.ok && clusterHost.hostId, "ctl");
	for (const runtime of RUNTIMES) {
		blocked(
			decide(runtime, "lead", peerArgs("pi-peer/Remote/only-on-mac", "low", "FAST_READ"), clusterHost),
			/ROUTE_MODEL_MISMATCH.*host "ctl"/,
			`${runtime}: the remote host's FAST_READ route does not authorise a local seat`,
		);
	}
});

test("file selection: shadowed legacy file, zero or two local hosts, invalid cluster never falls back", () => {
	const both = hostTable({ routing: { ...ROUTING_ONLY, hostId: "legacy" }, cluster: CLUSTER });
	assert.ok(both.ok);
	assert.equal(both.hostId, "ctl", "a cluster file with a local host wins");
	assert.match(String(both.shadowed), /model-routing\.local\.json$/);

	const remoteOnly = hostTable({
		routing: ROUTING_ONLY,
		cluster: { version: 1, hosts: { mac: CLUSTER.hosts.mac } },
	});
	assert.ok(remoteOnly.ok && remoteOnly.source === "routing" && remoteOnly.hostId === "minnyat");

	const twoLocals = hostTable({
		cluster: { version: 1, hosts: { a: CLUSTER.hosts.ctl, b: CLUSTER.hosts.ctl } },
	});
	assert.ok(!twoLocals.ok && twoLocals.code === "LOCAL_HOST_AMBIGUOUS");

	const invalidCluster = hostTable({ routing: ROUTING_ONLY, raw: { "cluster-routing.local.json": "{ not json" } });
	assert.ok(!invalidCluster.ok && invalidCluster.code === "CONFIG_INVALID");
	assert.match(invalidCluster.message, /does not fall back/);
});

// --- fail-closed ------------------------------------------------------------------

test("an unreadable, invalid or missing route file refuses every Lead/Supervisor create_agent", () => {
	const missing = hostTable({});
	const garbage = hostTable({ raw: { "model-routing.local.json": "{ nope" } });
	const invalid = hostTable({ routing: { version: 1, hostId: "h", routes: { FAST_READ: BASE_ROUTES.FAST_READ } } });
	// A directory where the file should be: it exists, and readFileSync fails
	// (EISDIR) — the "present but unreadable" case, distinct from absent.
	const unreadableDir = join(sandbox, "unreadable");
	mkdirSync(join(unreadableDir, "model-routing.local.json"), { recursive: true });
	const unreadableAgain = gateRouteTable({ env: { PST_TEAM_CONFIG_DIR: unreadableDir } }) as RouteTable;
	assert.equal(missing.ok, false);
	assert.equal(!missing.ok && missing.code, "ROUTE_FILE_MISSING");
	assert.equal(!garbage.ok && garbage.code, "CONFIG_INVALID");
	assert.equal(!invalid.ok && invalid.code, "CONFIG_INVALID");
	assert.equal(!unreadableAgain.ok && unreadableAgain.code, "CONFIG_INVALID");
	for (const runtime of RUNTIMES) {
		for (const [name, table] of [
			["missing", missing],
			["garbage", garbage],
			["invalid", invalid],
			["unreadable", unreadableAgain],
		] as const) {
			blocked(
				decide(runtime, "lead", peerArgs("pi-peer/Mx/mid", "medium", "CODING_MEDIUM"), table),
				/ROUTE_TABLE_UNAVAILABLE \((ROUTE_FILE_MISSING|CONFIG_INVALID)\).*model-routing\.local\.json/,
				`${runtime}: ${name} route file`,
			);
			blocked(decide(runtime, "supervisor", recoveryArgs(), table), /ROUTE_TABLE_UNAVAILABLE/, `${runtime}: ${name} (recovery)`);
		}
		// The adapter could not load a table at all: refused, not waved through.
		for (const table of [undefined, null]) {
			blocked(
				decide(runtime, "lead", peerArgs("pi-peer/Mx/mid", "medium", "CODING_MEDIUM"), table),
				/ROUTE_UNVERIFIABLE/,
				`${runtime}: route table ${table}`,
			);
		}
	}
});

// --- opt-out ------------------------------------------------------------------------

test("PASEO_TEAM_ROUTE_ENFORCE=off (exactly) disables the gate, loudly; anything else keeps it on", () => {
	const off = { PASEO_TEAM_ROUTE_ENFORCE: "off" };
	assert.equal(routeEnforcement(off), "off");
	assert.equal(routeEnforcement({}), "on");
	for (const runtime of RUNTIMES) {
		assert.equal(
			decide(runtime, "lead", peerArgs("pi-peer/any/model", "high"), undefined, off),
			null,
			`${runtime}: off skips the route gate`,
		);
		// The shape gates stay on: the opt-out is for the route, nothing else.
		blocked(
			decide(runtime, "lead", { provider: "claude-peer/claude-opus-5", settings: { thinkingOptionId: "high" } }, undefined, off),
			/settings\.modeId/,
			`${runtime}: the mode gate still runs with the route gate off`,
		);
		for (const value of ["OFF", "Off", " off", "0", "false", "no", "disabled", ""]) {
			blocked(
				decide(runtime, "lead", peerArgs("pi-peer/any/model", "high"), undefined, { PASEO_TEAM_ROUTE_ENFORCE: value }),
				/ROUTE_CLASS_MISSING/,
				`${runtime}: ${JSON.stringify(value)} is not the opt-out`,
			);
		}
	}
	const notice = routeEnforcementNotice("lead", off);
	assert.match(String(notice), /Route Enforcement: OFF[\s\S]*PASEO_TEAM_ROUTE_ENFORCE=off[\s\S]*never as a default/);
	assert.ok(routeEnforcementNotice("supervisor", off));
	assert.equal(routeEnforcementNotice("peer", off), null, "a Peer creates no agents");
	assert.equal(routeEnforcementNotice("lead", {}), null);
});

test("roles that create no agents are never route-gated", () => {
	assert.equal(
		createAgentRouteBlockReason({ role: "peer", args: {}, routeTable: null, env: ENFORCED }),
		null,
		"Peers are refused create_agent by the role policy, not by this gate",
	);
});

// --- the adapters' loaders ----------------------------------------------------------

test("Pi adapter's gate-routes subprocess answers exactly what the Claude hook loads in-process", () => {
	for (const files of [{ routing: ROUTING_ONLY }, { cluster: CLUSTER }, {}]) {
		const dir = join(sandbox, `subprocess-${(dirCount += 1)}`);
		mkdirSync(dir, { recursive: true });
		if ("routing" in files) writeFileSync(join(dir, "model-routing.local.json"), JSON.stringify(files.routing));
		if ("cluster" in files) writeFileSync(join(dir, "cluster-routing.local.json"), JSON.stringify(files.cluster));
		const env = { ...process.env, PST_TEAM_CONFIG_DIR: dir };
		const stdout = execFileSync(process.execPath, [join(ROOT, "scripts", "model-routing.mjs"), "gate-routes", "--json"], {
			env,
			encoding: "utf8",
		});
		assert.deepEqual(JSON.parse(stdout), gateRouteTable({ env: { PST_TEAM_CONFIG_DIR: dir } }));
	}
});

test("Claude hook end to end: the route gate runs in pre-tool-use, and the opt-out is announced every turn", async () => {
	const dir = join(sandbox, "hook-home");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "model-routing.local.json"), JSON.stringify(ROUTING_ONLY));
	// A pinned cluster, so the (earlier) cluster-label gate is satisfied the same
	// way wherever the suite runs from.
	const leadEnv = { PASEO_TEAM_HOME: dir, PASEO_PI_ROLE: "lead", PASEO_TEAM_CLUSTER: "route-gate" };
	const withCluster = (args: ReturnType<typeof peerArgs> | ReturnType<typeof supervisorArgs>) => ({
		...args,
		labels: { ...args.labels, "team.cluster": "route-gate" },
	});
	const call = (toolInput: ReturnType<typeof peerArgs> | ReturnType<typeof supervisorArgs>, env: Record<string, string> = leadEnv) =>
		handleEvent(
			"pre-tool-use",
			{ session_id: "route-gate", tool_name: "mcp__paseo__create_agent", tool_input: withCluster(toolInput) },
			env,
		);

	assert.equal(await call(peerArgs("pi-peer/Mx/mid", "medium", "CODING_MEDIUM")), null, "matching route is allowed");
	const refused = await call(peerArgs("pi-peer/Mx/big", "medium", "CODING_MEDIUM"));
	assert.equal(refused?.hookSpecificOutput?.permissionDecision, "deny");
	assert.match(String(refused?.hookSpecificOutput?.permissionDecisionReason), /ROUTE_MODEL_MISMATCH/);
	const seatSupervisor = await call(supervisorArgs());
	assert.match(String(seatSupervisor?.hookSpecificOutput?.permissionDecisionReason), /ROUTE_CLASS_UNCONFIGURED.*SUPERVISOR_GOVERNANCE/);

	const offEnv = { ...leadEnv, PASEO_TEAM_ROUTE_ENFORCE: "off" };
	assert.equal(await call(peerArgs("pi-peer/any/model", "high"), offEnv), null);
	const turn = await handleEvent("user-prompt-submit", { session_id: "route-gate", prompt: "next" }, offEnv);
	assert.match(String(turn?.hookSpecificOutput?.additionalContext), /Route Enforcement: OFF/);
	const quiet = await handleEvent("user-prompt-submit", { session_id: "route-gate", prompt: "next" }, leadEnv);
	assert.doesNotMatch(String(quiet?.hookSpecificOutput?.additionalContext ?? ""), /Route Enforcement: OFF/);
});

// --- update_agent: the second door to a seat's model --------------------------

const AGENT_PEER = "11111111-aaaa-4aaa-8aaa-111111111111";
const AGENT_UNLABELLED = "22222222-bbbb-4bbb-8bbb-222222222222";
const AGENT_LEAD = "33333333-cccc-4ccc-8ccc-333333333333";
const AGENT_MISSING = "44444444-dddd-4ddd-8ddd-444444444444";
const AGENT_WATCHER = "55555555-eeee-4eee-8eee-555555555555";

/** A PASEO_HOME with agent state files, read back through routeTargetFor. */
const paseoHome = join(sandbox, "paseo-home");
{
	const dir = join(paseoHome, "agents", "D--repo");
	mkdirSync(dir, { recursive: true });
	const write = (id: string, provider: string, labels: Record<string, string>) =>
		writeFileSync(join(dir, `${id}.json`), JSON.stringify({ id, provider, labels, runtimeInfo: {} }));
	write(AGENT_PEER, "pi-peer/Mx/mid", { "team.model-class": "CODING_MEDIUM" });
	write(AGENT_UNLABELLED, "pi-peer/Mx/mid", {});
	write(AGENT_LEAD, "pi-lead/Mx/big", { "team.model-class": "LEAD_RECOVERY" });
		write(AGENT_WATCHER, "pi-supervisor/Mx/cheap", { "team.model-class": "MONITOR_ECONOMY", "team.watch": "liveness,cost" });
	}
const PASEO_ENV = { PASEO_HOME: paseoHome };
const target = (id: string) => routeTargetFor(id, PASEO_ENV);

function decideUpdate(
	runtime: Runtime,
	role: TeamRole,
	args: unknown,
	updateTarget: RouteTarget | null | undefined,
	routeTable: RouteTable | null | undefined,
	env: Record<string, string | undefined> = ENFORCED,
): string | null {
	if (runtime === "pi") {
		return mcpBlockReason(role, { tool: "update_agent", args }, { updateTarget, routeTable, env });
	}
	return claudeToolBlockReason({
		role,
		toolName: "mcp__paseo__update_agent",
		toolInput: args,
		brief: null,
		updateTarget,
		routeTable,
		env,
	});
}

test("update_agent: routeTargetFor reads the class off Paseo's own agent state", () => {
	assert.deepEqual(target(AGENT_PEER), {
		agentId: AGENT_PEER,
		provider: "pi-peer/Mx/mid",
		modelClass: "CODING_MEDIUM",
		job: null,
		watch: null,
	});
	// A watch seat's label travels with the target: it is what lets an observer stay
	// on the economy route it was seated on, while a seat that decides cannot.
	assert.equal(target(AGENT_WATCHER)?.watch, "liveness,cost");
	assert.equal(target(AGENT_UNLABELLED)?.modelClass, null);
	assert.equal(target(AGENT_MISSING), null, "an agent with no state is null, never a classless target");
	assert.equal(target("not-an-id"), null);
});

test("update_agent: an observer seated on MONITOR_ECONOMY stays on it; read as a seat that decides, it never had it", () => {
	const watcher = target(AGENT_WATCHER);
	assert.ok(watcher);
	const move = { agentId: AGENT_WATCHER, settings: { model: "Mx/cheap", thinkingOptionId: "low" } };
	for (const runtime of RUNTIMES) {
		assert.equal(decideUpdate(runtime, "lead", move, watcher, clusterHost), null, `${runtime}: an observer on the economy route`);
		blocked(
			decideUpdate(runtime, "lead", move, { ...watcher, watch: null }, clusterHost),
			/ROUTE_CLASS_WRONG_FLOW.*routes from SUPERVISOR_GOVERNANCE/,
			`${runtime}: a seat that decides never had the economy route`,
		);
	}
});

test("update_agent: model/thinking on the target's own route pass; anything else is refused naming the route", () => {
	for (const runtime of RUNTIMES) {
		const peer = target(AGENT_PEER);
		const upd = (settings: Record<string, unknown>) => ({ agentId: AGENT_PEER, settings });
		assert.equal(decideUpdate(runtime, "lead", upd({ model: "Mx/mid" }), peer, routingOnly), null, `${runtime}: route model`);
		assert.equal(decideUpdate(runtime, "lead", upd({ model: "Mx/mid", thinkingOptionId: "medium" }), peer, routingOnly), null);
		assert.equal(decideUpdate(runtime, "lead", upd({ thinkingOptionId: "medium" }), peer, clusterHost), null);
		blocked(
			decideUpdate(runtime, "lead", upd({ model: "Mx/big" }), peer, routingOnly),
			/ROUTE_MODEL_MISMATCH.*CODING_MEDIUM seat.*"Mx\/mid".*Expected settings \{ model: "Mx\/mid", thinkingOptionId: "medium" \}/,
			`${runtime}: another model`,
		);
		blocked(
			decideUpdate(runtime, "lead", upd({ thinkingOptionId: "high" }), peer, routingOnly),
			/ROUTE_THINKING_MISMATCH.*"medium"/,
			`${runtime}: another thinking level`,
		);
		blocked(
			decideUpdate(runtime, "lead", upd({ model: null }), peer, routingOnly),
			/ROUTE_MODEL_MISMATCH.*null \(clears it to the daemon default\)/,
			`${runtime}: clearing the model is moving it`,
		);
		blocked(
			decideUpdate(runtime, "lead", upd({ thinkingOptionId: null }), peer, routingOnly),
			/ROUTE_THINKING_MISMATCH.*null/,
			`${runtime}: clearing thinking`,
		);
		// Lead recovery seat on a model-routing-only host: its class is optional
		// and absent there, so it cannot be re-routed at all.
		blocked(
			decideUpdate(runtime, "lead", { agentId: AGENT_LEAD, settings: { model: "Mx/big" } }, target(AGENT_LEAD), routingOnly),
			/ROUTE_CLASS_UNCONFIGURED.*LEAD_RECOVERY/,
			`${runtime}: class not configured`,
		);
		assert.equal(
			decideUpdate(runtime, "lead", { agentId: AGENT_LEAD, settings: { model: "Mx/big" } }, target(AGENT_LEAD), clusterHost),
			null,
			`${runtime}: configured on the cluster host`,
		);
	}
});

test("update_agent: fail-closed — unreadable target, no class on the target, unloadable table", () => {
	for (const runtime of RUNTIMES) {
		const upd = (id: string) => ({ agentId: id, settings: { model: "Mx/mid" } });
		for (const unreadable of [undefined, null, target(AGENT_MISSING)]) {
			blocked(
				decideUpdate(runtime, "lead", upd(AGENT_MISSING), unreadable, routingOnly),
				/ROUTE_TARGET_UNREADABLE.*44444444/,
				`${runtime}: unreadable target (${String(unreadable)})`,
			);
		}
		blocked(
			decideUpdate(runtime, "lead", upd(AGENT_UNLABELLED), target(AGENT_UNLABELLED), routingOnly),
			/ROUTE_CLASS_MISSING.*created before the route gate or outside it/,
			`${runtime}: no class on the target`,
		);
		for (const table of [undefined, null, { ok: false, code: "CONFIG_INVALID", message: "broken" } as RouteTable]) {
			blocked(
				decideUpdate(runtime, "lead", upd(AGENT_PEER), target(AGENT_PEER), table),
				/ROUTE_UNVERIFIABLE|ROUTE_TABLE_UNAVAILABLE/,
				`${runtime}: route table ${JSON.stringify(table)}`,
			);
		}
	}
});

test("update_agent: the class label is fixed — it cannot be rewritten to borrow another class's route", () => {
	for (const runtime of RUNTIMES) {
		blocked(
			decideUpdate(runtime, "lead", { agentId: AGENT_PEER, labels: { "team.model-class": "REASONING_HIGH" } }, target(AGENT_PEER), routingOnly),
			/ROUTE_CLASS_IMMUTABLE.*"CODING_MEDIUM"/,
			`${runtime}: relabel alone`,
		);
		blocked(
			decideUpdate(
				runtime,
				"lead",
				{ agentId: AGENT_PEER, labels: { "team.model-class": "REASONING_HIGH" }, settings: { model: "claude-opus-5" } },
				target(AGENT_PEER),
				routingOnly,
			),
			/ROUTE_CLASS_IMMUTABLE/,
			`${runtime}: relabel + move in one call`,
		);
		blocked(
			decideUpdate(runtime, "lead", { agentId: AGENT_UNLABELLED, labels: { "team.model-class": "CODING_MEDIUM" } }, target(AGENT_UNLABELLED), routingOnly),
			/ROUTE_CLASS_IMMUTABLE.*unset/,
			`${runtime}: stamping a class onto an unlabelled seat`,
		);
		assert.equal(
			decideUpdate(runtime, "lead", { agentId: AGENT_PEER, labels: { "team.model-class": "CODING_MEDIUM", note: "x" } }, target(AGENT_PEER), routingOnly),
			null,
			`${runtime}: repeating the same class is not a change`,
		);
	}
});

test("update_agent that changes neither model nor thinking works unchanged — no state read, no route table", () => {
	for (const runtime of RUNTIMES) {
		for (const args of [
			{ agentId: AGENT_MISSING, name: "renamed" },
			{ agentId: AGENT_MISSING, labels: { note: "anything", "team.domain": "x" } },
			{ agentId: AGENT_MISSING, settings: { modeId: "plan" } },
			{ agentId: AGENT_MISSING, settings: { features: { fast_mode: true } } },
			{ agentId: AGENT_MISSING, name: "n", labels: { a: "b" }, settings: { modeId: "auto" } },
		]) {
			// undefined target AND undefined table: if the gate looked at either,
			// it would refuse — so a pass proves it never needed them.
			assert.equal(decideUpdate(runtime, "lead", args, undefined, undefined), null, `${runtime}: ${JSON.stringify(args)}`);
		}
	}
});

test("update_agent: the opt-out disables the update gate the same way, and only for the route", () => {
	const off = { PASEO_TEAM_ROUTE_ENFORCE: "off" };
	for (const runtime of RUNTIMES) {
		assert.equal(
			decideUpdate(runtime, "lead", { agentId: AGENT_PEER, settings: { model: "any/model" } }, undefined, undefined, off),
			null,
		);
		blocked(
			decideUpdate(runtime, "lead", { agentId: AGENT_PEER, settings: { model: "any/model" } }, target(AGENT_PEER), routingOnly, { PASEO_TEAM_ROUTE_ENFORCE: "OFF" }),
			/ROUTE_MODEL_MISMATCH/,
			`${runtime}: "OFF" is not the opt-out`,
		);
	}
	assert.equal(
		updateAgentRouteBlockReason({ role: "peer", args: { agentId: AGENT_PEER, settings: { model: "x" } }, env: ENFORCED }),
		null,
		"a Peer never reaches update_agent at all; the role policy refuses it",
	);
	assert.match(String(routeEnforcementNotice("lead", off)), /update_agent and team_fork are NOT checked/);
});

test("create_agent: a legacy top-level thinking cannot override the routed one", () => {
	for (const runtime of RUNTIMES) {
		blocked(
			decide(runtime, "lead", { ...peerArgs("pi-peer/Mx/mid", "medium", "CODING_MEDIUM"), thinking: "max" }, routingOnly),
			// The placement/params gate (it runs first) refuses any parameter Paseo does
			// not read, and says where it belongs; the route gate's own top-level
			// "thinking" check is the backstop if that gate is ever loosened.
			/unknown parameter "thinking" \(belongs in settings\.thinkingOptionId\)|ROUTE_THINKING_MISMATCH.*top-level "thinking"/,
			`${runtime}: legacy thinking`,
		);
	}
});

// --- the Pi adapter itself: tool_call → gate-routes subprocess → core ----------

type Handler = (event: unknown) => Promise<{ block?: boolean; reason?: string } | undefined>;

async function piLead(env: Record<string, string>, tag: string) {
	const handlers: Record<string, Handler[]> = {};
	const saved: Record<string, string | undefined> = {};
	const keys = [
		"PASEO_PI_ROLE",
		"PASEO_TEAM_ROUTE_ENFORCE",
		"PST_TEAM_CONFIG_DIR",
		"PASEO_TEAM_HOME",
		"PASEO_TEAM_SCRIPTS_DIR",
		"PASEO_TEAM_CLUSTER",
		"PASEO_HOME",
		...Object.keys(env),
	];
	for (const key of keys) saved[key] = process.env[key];
	for (const key of keys) delete process.env[key];
	Object.assign(process.env, { PASEO_PI_ROLE: "lead", PASEO_TEAM_CLUSTER: "route-gate", ...env });
	const mod: { default: (pi: unknown) => void } = await import(`../extensions/paseo-team-policy.ts?routegate=${tag}`);
	mod.default({
		on: (name: string, fn: Handler) => (handlers[name] ??= []).push(fn),
		getAllTools: () => [{ name: "mcp" }],
		setActiveTools: () => {},
		getActiveTools: () => [],
		registerCommand: () => {},
		registerTool: () => {},
	});
	const toolCall = handlers.tool_call?.[0];
	assert.ok(toolCall, "the Pi extension registers tool_call");
	const restore = () => {
		for (const key of keys) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}
	};
	const mcp = (tool: string, args: unknown) => toolCall({ toolName: "mcp", input: { tool, args } });
	return { mcp, restore };
}

const withCluster = (args: { labels: Record<string, string> }) => ({ ...args, labels: { ...args.labels, "team.cluster": "route-gate" } });

test("Pi adapter tool_call, enforcement ON: accept, mismatch, and a failing gate-routes subprocess refuses", async () => {
	const configDir = join(sandbox, "pi-adapter-config");
	mkdirSync(configDir, { recursive: true });
	writeFileSync(join(configDir, "model-routing.local.json"), JSON.stringify(ROUTING_ONLY));
	const scripts = join(ROOT, "scripts");

	const good = await piLead({ PST_TEAM_CONFIG_DIR: configDir, PASEO_TEAM_SCRIPTS_DIR: scripts, PASEO_HOME: paseoHome }, "good");
	try {
		assert.equal(
			await good.mcp("create_agent", withCluster(peerArgs("pi-peer/Mx/mid", "medium", "CODING_MEDIUM"))),
			undefined,
			"a create_agent on its route passes through the real subprocess",
		);
		const mismatch = await good.mcp("create_agent", withCluster(peerArgs("pi-peer/Mx/big", "medium", "CODING_MEDIUM")));
		assert.equal(mismatch?.block, true);
		assert.match(String(mismatch?.reason), /ROUTE_MODEL_MISMATCH.*Expected provider "pi-peer\/Mx\/mid"/);
		// update_agent through the same handler: target resolved from PASEO_HOME.
		assert.equal(await good.mcp("update_agent", { agentId: AGENT_PEER, settings: { model: "Mx/mid" } }), undefined);
		const moved = await good.mcp("update_agent", { agentId: AGENT_PEER, settings: { model: "Mx/big" } });
		assert.match(String(moved?.reason), /ROUTE_MODEL_MISMATCH/);
		assert.equal(await good.mcp("update_agent", { agentId: AGENT_PEER, name: "renamed" }), undefined);
	} finally {
		good.restore();
	}

	// The support script cannot be found (an empty scripts dir): the adapter gets
	// no table at all and the core must refuse, not wave the call through.
	const emptyScripts = join(sandbox, "no-scripts");
	mkdirSync(emptyScripts, { recursive: true });
	const broken = await piLead({ PST_TEAM_CONFIG_DIR: configDir, PASEO_TEAM_SCRIPTS_DIR: emptyScripts, PASEO_HOME: paseoHome }, "broken");
	try {
		const refused = await broken.mcp("create_agent", withCluster(peerArgs("pi-peer/Mx/mid", "medium", "CODING_MEDIUM")));
		assert.equal(refused?.block, true);
		assert.match(String(refused?.reason), /ROUTE_UNVERIFIABLE/);
		const refusedUpdate = await broken.mcp("update_agent", { agentId: AGENT_PEER, settings: { model: "Mx/mid" } });
		assert.match(String(refusedUpdate?.reason), /ROUTE_UNVERIFIABLE/);
	} finally {
		broken.restore();
	}

	// A subprocess that runs but answers garbage is the same refusal.
	const garbageScripts = join(sandbox, "garbage-scripts");
	mkdirSync(garbageScripts, { recursive: true });
	writeFileSync(join(garbageScripts, "model-routing.mjs"), 'console.log("not json");\n');
	const garbage = await piLead({ PST_TEAM_CONFIG_DIR: configDir, PASEO_TEAM_SCRIPTS_DIR: garbageScripts, PASEO_HOME: paseoHome }, "garbage");
	try {
		const refused = await garbage.mcp("create_agent", withCluster(peerArgs("pi-peer/Mx/mid", "medium", "CODING_MEDIUM")));
		assert.match(String(refused?.reason), /ROUTE_UNVERIFIABLE/);
	} finally {
		garbage.restore();
	}
});

test("Claude hook end to end: update_agent is gated off the target's own class", async () => {
	const dir = join(sandbox, "hook-update-home");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "model-routing.local.json"), JSON.stringify(ROUTING_ONLY));
	const env = { PASEO_TEAM_HOME: dir, PASEO_PI_ROLE: "lead", PASEO_TEAM_CLUSTER: "route-gate", PASEO_HOME: paseoHome };
	const call = (toolInput: unknown) =>
		handleEvent("pre-tool-use", { session_id: "route-gate-update", tool_name: "mcp__paseo__update_agent", tool_input: toolInput }, env);
	assert.equal(await call({ agentId: AGENT_PEER, settings: { model: "Mx/mid" } }), null);
	const refused = await call({ agentId: AGENT_PEER, settings: { model: "Mx/big" } });
	assert.match(String(refused?.hookSpecificOutput?.permissionDecisionReason), /ROUTE_MODEL_MISMATCH/);
	const unreadable = await call({ agentId: AGENT_MISSING, settings: { model: "Mx/mid" } });
	assert.match(String(unreadable?.hookSpecificOutput?.permissionDecisionReason), /ROUTE_TARGET_UNREADABLE/);
	assert.equal(await call({ agentId: AGENT_MISSING, name: "renamed" }), null, "a rename needs no state at all");
});

// --- quick switch: a disabled route refuses its class, live, never rerouted ---------

test("a switched-off class is refused on create_agent and update_agent, on both runtimes — and the switch is live", () => {
	const dir = join(sandbox, `host-${(dirCount += 1)}`);
	mkdirSync(dir, { recursive: true });
	const file = join(dir, "model-routing.local.json");
	const write = (off: boolean) =>
		writeFileSync(
			file,
			JSON.stringify({
				version: 1,
				hostId: "minnyat",
				routes: { ...BASE_ROUTES, CODING_MEDIUM: { ...BASE_ROUTES.CODING_MEDIUM, ...(off ? { enabled: false } : {}) } },
			}),
		);
	// The gate loader is called afresh for every decision, exactly as both adapters
	// do (Pi: a gate-routes subprocess per create_agent; Claude: a new hook process
	// per tool call) — so editing the file is the whole "reload".
	const table = () => gateRouteTable({ env: { PST_TEAM_CONFIG_DIR: dir } }) as RouteTable;
	const route = BASE_ROUTES.CODING_MEDIUM;
	const create = (runtime: Runtime) => decide(runtime, "lead", peerArgs(`${route.paseoProvider}/${route.model}`, route.thinking, "CODING_MEDIUM"), table());

	write(false);
	for (const runtime of RUNTIMES) assert.equal(create(runtime), null, `${runtime}: on`);

	write(true);
	const peer = target(AGENT_PEER);
	for (const runtime of RUNTIMES) {
		blocked(create(runtime), /ROUTE_CLASS_DISABLED — CODING_MEDIUM is switched off.*not rerouted.*pteam routing enable CODING_MEDIUM\) is the Human's call, not yours — do not run it/, `${runtime}: create_agent`);
		blocked(
			decideUpdate(runtime, "lead", { agentId: AGENT_PEER, settings: { model: "Mx/mid" } }, peer, table()),
			/ROUTE_CLASS_DISABLED.*CODING_MEDIUM/,
			`${runtime}: update_agent`,
		);
		// The other classes are untouched: no fallback, no collateral.
		const other = BASE_ROUTES.FAST_READ;
		assert.equal(decide(runtime, "lead", peerArgs(`${other.paseoProvider}/${other.model}`, other.thinking, "FAST_READ"), table()), null, `${runtime}: FAST_READ still routes`);
	}

	write(false);
	for (const runtime of RUNTIMES) assert.equal(create(runtime), null, `${runtime}: back on, no restart`);
});

// --- model switch + job seatings ------------------------------------------------------

/** A host dir you can rewrite between calls, like an operator editing files while seats run. */
function liveHost() {
	const dir = join(sandbox, `host-${(dirCount += 1)}`);
	mkdirSync(dir, { recursive: true });
	return {
		dir,
		routing(extra: Record<string, unknown> = {}) {
			writeFileSync(join(dir, "model-routing.local.json"), JSON.stringify({ version: 1, hostId: "minnyat", routes: BASE_ROUTES, ...extra }));
		},
		jobs(doc: unknown) {
			writeFileSync(join(dir, "jobs.local.json"), JSON.stringify(doc));
		},
		table: () => gateTable({ env: { PST_TEAM_CONFIG_DIR: dir } }) as RouteTable,
	};
}

const JOB_DOC = {
	version: 1,
	jobs: {
		// two models of the same tool (pi) plus a claude one: the user's "same tool, several models"
		review: {
			run: "parallel",
			executors: [
				{ kind: "class", modelClass: "REVIEW_HIGH" },
				{ kind: "route", paseoProvider: "pi-peer", model: "Other/model-b", thinking: "high" },
				{ kind: "route", paseoProvider: "pi-peer", model: "Other/model-c", thinking: "low" },
				{ kind: "route", paseoProvider: "pi-peer", model: "Other/no-thinking" },
			],
		},
		paused: { enabled: false, executors: [{ kind: "class", modelClass: "FAST_READ" }] },
	},
};
const seatFor = (provider: string, thinking: string, labels: Record<string, string>) => ({
	title: "job seat",
	initialPrompt: "brief",
	provider,
	settings: { thinkingOptionId: thinking, ...(provider.startsWith("claude-") ? { modeId: "auto" } : {}) },
	labels,
});

test("the gap this closes: without a job label a route executor's model is refused (ROUTE_MODEL_MISMATCH)", () => {
	const host = liveHost();
	host.routing();
	host.jobs(JOB_DOC);
	for (const runtime of RUNTIMES) {
		blocked(
			decide(runtime, "lead", seatFor("pi-peer/Other/model-b", "high", { "team.model-class": "CODING_MEDIUM" }), host.table()),
			/ROUTE_MODEL_MISMATCH/,
			`${runtime}: a job executor's model is not a class route`,
		);
	}
});

test("job seatings: any active executor of the job passes, anything else is refused with what IS usable", () => {
	const host = liveHost();
	host.routing();
	host.jobs(JOB_DOC);
	const labels = { "team.model-class": "CODING_MEDIUM", "team.job": "review" };
	for (const runtime of RUNTIMES) {
		assert.equal(decide(runtime, "lead", seatFor("pi-peer/Other/model-b", "high", labels), host.table()), null, `${runtime}: route executor b`);
		assert.equal(decide(runtime, "lead", seatFor("pi-peer/Other/model-c", "low", labels), host.table()), null, `${runtime}: same tool, another model`);
		assert.equal(
			decide(runtime, "lead", seatFor("claude-peer/claude-opus-5", "xhigh", { "team.model-class": "REVIEW_HIGH", "team.job": "review" }), host.table()),
			null,
			`${runtime}: the class executor resolves to its route`,
		);
		blocked(decide(runtime, "lead", seatFor("pi-peer/Other/model-b", "low", labels), host.table()), /ROUTE_JOB_EXECUTOR_MISMATCH.*Usable now:.*Other\/model-b @high.*Other\/model-c @low/, `${runtime}: wrong thinking`);
		blocked(decide(runtime, "lead", seatFor("pi-peer/Other/nope", "high", labels), host.table()), /ROUTE_JOB_EXECUTOR_MISMATCH/, `${runtime}: a model the job does not list`);
		blocked(decide(runtime, "lead", seatFor("pi-peer/Other/no-thinking", "high", labels), host.table()), /ROUTE_JOB_EXECUTOR_MISMATCH/, `${runtime}: an executor without a thinking level is not seatable`);
		blocked(decide(runtime, "lead", seatFor("pi-peer/Other/model-b", "high", { ...labels, "team.job": "ghost" }), host.table()), /ROUTE_JOB_UNKNOWN.*known: paused, review/, `${runtime}: unknown job`);
		blocked(decide(runtime, "lead", seatFor("pi-peer/Other/model-b", "high", { ...labels, "team.job": "paused" }), host.table()), /ROUTE_JOB_INACTIVE.*switched off/, `${runtime}: a switched-off job`);
		// the class label still decides the flow: a Peer seat cannot borrow a governance class
		blocked(decide(runtime, "lead", seatFor("pi-peer/Other/model-b", "high", { "team.model-class": "SUPERVISOR_GOVERNANCE", "team.job": "review" }), host.table()), /ROUTE_CLASS_WRONG_FLOW/, `${runtime}: flow check kept`);
	}
});

test("model switch: a model switched off refuses its class and drops out of its jobs — live, with the alternatives named", () => {
	const host = liveHost();
	host.routing();
	host.jobs(JOB_DOC);
	const labels = { "team.model-class": "CODING_MEDIUM", "team.job": "review" };
	const mid = BASE_ROUTES.CODING_MEDIUM;
	const classSeat = () => peerArgs(`${mid.paseoProvider}/${mid.model}`, mid.thinking, "CODING_MEDIUM");
	for (const runtime of RUNTIMES) {
		host.routing();
		assert.equal(decide(runtime, "lead", classSeat(), host.table()), null, `${runtime}: on`);
		assert.equal(decide(runtime, "lead", seatFor("pi-peer/Other/model-b", "high", labels), host.table()), null);

		// the whole pi endpoint "Mx" is out of credit: both class routes on it go, the job's other pi models stay
		host.routing({ disabledModels: ["pi/Mx/*"] });
		blocked(decide(runtime, "lead", classSeat(), host.table()), /ROUTE_MODEL_DISABLED.*pi\/Mx\/mid.*not moved to another model.*pteam routing enable-model pi\/Mx\/mid\) is the Human's call, not yours — do not run it; seat from what is usable\.\s+No other class is usable now for a pi\/peer seat/, `${runtime}: class on a disabled model`);
		assert.equal(decide(runtime, "lead", seatFor("pi-peer/Other/model-b", "high", labels), host.table()), null, `${runtime}: the job's other models are unaffected`);

		// switching a job executor's own model off skips it — and only it
		host.routing({ disabledModels: ["pi/Other/model-b"] });
		blocked(decide(runtime, "lead", seatFor("pi-peer/Other/model-b", "high", labels), host.table()), /ROUTE_JOB_EXECUTOR_MISMATCH.*Other\/model-c @low/, `${runtime}: that executor is skipped`);
		assert.equal(decide(runtime, "lead", seatFor("pi-peer/Other/model-c", "low", labels), host.table()), null, `${runtime}: its sibling still seats`);

		host.routing();
		assert.equal(decide(runtime, "lead", seatFor("pi-peer/Other/model-b", "high", labels), host.table()), null, `${runtime}: back on, no restart`);
	}
});

test("job seatings fail closed: an unreadable jobs file refuses only job-labelled seatings", () => {
	const host = liveHost();
	host.routing();
	writeFileSync(join(host.dir, "jobs.local.json"), "{ not json");
	const labels = { "team.model-class": "CODING_MEDIUM", "team.job": "review" };
	const mid = BASE_ROUTES.CODING_MEDIUM;
	for (const runtime of RUNTIMES) {
		blocked(decide(runtime, "lead", seatFor("pi-peer/Other/model-b", "high", labels), host.table()), /ROUTE_JOB_UNAVAILABLE.*jobs file could not be read/, `${runtime}`);
		assert.equal(decide(runtime, "lead", peerArgs(`${mid.paseoProvider}/${mid.model}`, mid.thinking, "CODING_MEDIUM"), host.table()), null, `${runtime}: class seatings unaffected`);
	}
	// a table from a reader that predates jobs
	const old = hostTable({ routing: ROUTING_ONLY });
	for (const runtime of RUNTIMES) blocked(decide(runtime, "lead", seatFor("pi-peer/Other/model-b", "high", labels), old), /ROUTE_JOB_UNAVAILABLE.*no job data/, `${runtime}: old table`);
});

test("update_agent on a job seat: its job label is fixed and its model cannot be moved", () => {
	const host = liveHost();
	host.routing();
	host.jobs(JOB_DOC);
	const jobSeat: RouteTarget = { agentId: AGENT_PEER, provider: "pi-peer/Other/model-b", modelClass: "CODING_MEDIUM", job: "review", watch: null };
	for (const runtime of RUNTIMES) {
		blocked(decideUpdate(runtime, "lead", { agentId: AGENT_PEER, settings: { model: "Other/model-c" } }, jobSeat, host.table()), /ROUTE_JOB_SEAT_FIXED.*job "review"/, `${runtime}: model move`);
		blocked(decideUpdate(runtime, "lead", { agentId: AGENT_PEER, labels: { "team.job": "other" } }, jobSeat, host.table()), /ROUTE_JOB_IMMUTABLE/, `${runtime}: job label`);
		assert.equal(decideUpdate(runtime, "lead", { agentId: AGENT_PEER, labels: { "team.job": "review" } }, jobSeat, host.table()), null, `${runtime}: restating it is a no-op`);
	}
});

test("the routing-now notice is the same words for both runtimes, names off models, and changes when a file does", () => {
	const host = liveHost();
	host.routing();
	host.jobs(JOB_DOC);
	const before = routingAvailabilityNotice("lead", host.table());
	assert.ok(before);
	assert.match(before.text, /## Routing now/);
	assert.match(before.text, /FAST_READ=pi-peer\/Mx\/cheap@low/);
	assert.match(before.text, /review: .*pi-peer\/Other\/model-b@high/);
	assert.match(before.text, /paused: OFF \(job switched off/);
	assert.match(before.text, /pteam jobs resolve <id>/);
	host.routing({ disabledModels: ["pi/Mx/*"] });
	const after = routingAvailabilityNotice("lead", host.table());
	assert.ok(after);
	assert.notEqual(after.fingerprint, before.fingerprint, "a change is detectable");
	assert.match(after.text, /FAST_READ=OFF \(model switched off\)/);
	assert.match(after.text, /Models switched off: pi\/Mx\/\*/);
	assert.equal(routingAvailabilityNotice("peer", host.table()), null, "a Peer seats nothing");
	// a Supervisor has no terminal: it is never told to run pteam
	const supervisorNotice = routingAvailabilityNotice("supervisor", host.table());
	assert.ok(supervisorNotice);
	assert.doesNotMatch(supervisorNotice.text, /pteam (jobs resolve|routing show)/);
	assert.match(supervisorNotice.text, /You have no terminal.*LEAD_RECOVERY.*escalate to the Human/);
	assert.match(routingAvailabilityNotice("lead", null)?.text ?? "", /UNLOADABLE/);
});

test("Claude hook: 'Routing now' is injected at session start, again only when a file changed, and a job seating passes the live gate", async () => {
	const host = liveHost();
	host.routing();
	host.jobs(JOB_DOC);
	const env = { PASEO_TEAM_HOME: host.dir, PASEO_PI_ROLE: "lead", PASEO_TEAM_CLUSTER: "route-gate" };
	const session = `routing-now-${dirCount}`;
	const context = (out: any) => String(out?.hookSpecificOutput?.additionalContext ?? "");

	const start = await handleEvent("session-start", { session_id: session }, env);
	assert.match(context(start), /## Routing now[\s\S]*review: .*Other\/model-b@high/, "a new Lead session starts with the current table");

	const quiet = await handleEvent("user-prompt-submit", { session_id: session, prompt: "next" }, env);
	assert.doesNotMatch(context(quiet), /Routing now/, "unchanged: not repeated every turn");

	host.routing({ disabledModels: ["pi/Other/model-b"] });
	const changed = await handleEvent("user-prompt-submit", { session_id: session, prompt: "next" }, env);
	assert.match(context(changed), /CHANGED since your last turn — ## Routing now/, "a model switched off while the session runs shows up on the next turn");
	assert.match(context(changed), /Models switched off: pi\/Other\/model-b/);
	const again = await handleEvent("user-prompt-submit", { session_id: session, prompt: "next" }, env);
	assert.doesNotMatch(context(again), /Routing now/);

	const seat = (model: string, thinking: string) => ({
		session_id: session,
		tool_name: "mcp__paseo__create_agent",
		tool_input: { ...seatFor(`pi-peer/${model}`, thinking, { "team.model-class": "CODING_MEDIUM", "team.job": "review", "team.cluster": "route-gate" }) },
	});
	const refused = await handleEvent("pre-tool-use", seat("Other/model-b", "high"), env);
	assert.match(String(refused?.hookSpecificOutput?.permissionDecisionReason), /ROUTE_JOB_EXECUTOR_MISMATCH.*Other\/model-c @low/);
	assert.equal(await handleEvent("pre-tool-use", seat("Other/model-c", "low"), env), null, "the sibling model seats, no restart");
});

// --- a class with several tools/models: the Lead picks ONE, nothing is chosen for it ---

const OPTIONED_ROUTES = {
	...BASE_ROUTES,
	// pi (primary) + claude + a second pi model, all peers; each can be seated, one per agent
	CODING_MEDIUM: {
		paseoProvider: "pi-peer",
		model: "Mx/mid",
		thinking: "medium",
		alternates: [
			{ paseoProvider: "claude-peer", model: "claude-sonnet-5-5", thinking: "high" },
			{ paseoProvider: "pi-peer", model: "Mx/other", thinking: "low" },
		],
	},
};

test("a class with several options: every usable option can be seated; anything else is refused with the list", () => {
	const host = liveHost();
	host.routing({ routes: OPTIONED_ROUTES });
	for (const runtime of RUNTIMES) {
		assert.equal(decide(runtime, "lead", peerArgs("pi-peer/Mx/mid", "medium", "CODING_MEDIUM"), host.table()), null, `${runtime}: primary`);
		assert.equal(decide(runtime, "lead", peerArgs("claude-peer/claude-sonnet-5-5", "high", "CODING_MEDIUM"), host.table()), null, `${runtime}: another tool`);
		assert.equal(decide(runtime, "lead", peerArgs("pi-peer/Mx/other", "low", "CODING_MEDIUM"), host.table()), null, `${runtime}: same tool, another model`);
		blocked(decide(runtime, "lead", peerArgs("pi-peer/Mx/other", "medium", "CODING_MEDIUM"), host.table()), /ROUTE_THINKING_MISMATCH.*offers "Mx\/other" .* at thinking "low".*Expected one of: provider "pi-peer\/Mx\/mid".*"pi-peer\/Mx\/other"/, `${runtime}: right model, wrong thinking`);
		blocked(decide(runtime, "lead", peerArgs("pi-peer/Mx/nope", "medium", "CODING_MEDIUM"), host.table()), /ROUTE_MODEL_MISMATCH.*offers no model "Mx\/nope".*Expected one of:/, `${runtime}: a model the class does not list`);
		// a class with ONE option keeps its exact old wording
		blocked(decide(runtime, "lead", peerArgs("pi-peer/Mx/big", "low", "FAST_READ"), host.table()), /ROUTE_MODEL_MISMATCH — FAST_READ routes .* to model "Mx\/cheap", but provider "pi-peer\/Mx\/big" asks for "Mx\/big"\. Expected provider "pi-peer\/Mx\/cheap" with settings\.thinkingOptionId "low"\./, `${runtime}: single-option wording`);
	}
});

test("switching an option off removes it — and the Lead is NOT moved to another one", () => {
	const host = liveHost();
	const routes = structuredClone(OPTIONED_ROUTES) as typeof OPTIONED_ROUTES & Record<string, any>;
	routes.CODING_MEDIUM.enabled = false; // the primary (pi/Mx/mid) is off
	host.routing({ routes });
	for (const runtime of RUNTIMES) {
		blocked(decide(runtime, "lead", peerArgs("pi-peer/Mx/mid", "medium", "CODING_MEDIUM"), host.table()), /ROUTE_MODEL_MISMATCH.*Expected provider "pi-peer\/Mx\/other" with settings\.thinkingOptionId "low"\./, `${runtime}: the primary is gone (and the Lead is told what is left, not moved)`);
		assert.equal(decide(runtime, "lead", peerArgs("claude-peer/claude-sonnet-5-5", "high", "CODING_MEDIUM"), host.table()), null, `${runtime}: the others still seat`);
	}
	// a model switched off (out of credit) drops only the options on it
	host.routing({ routes: OPTIONED_ROUTES, disabledModels: ["pi/Mx/mid"] });
	for (const runtime of RUNTIMES) {
		blocked(decide(runtime, "lead", peerArgs("pi-peer/Mx/mid", "medium", "CODING_MEDIUM"), host.table()), /ROUTE_MODEL_MISMATCH/, `${runtime}`);
		assert.equal(decide(runtime, "lead", peerArgs("pi-peer/Mx/other", "low", "CODING_MEDIUM"), host.table()), null, `${runtime}: the other pi model`);
	}
	// every option off: now the class itself is refused, naming why
	host.routing({ routes: OPTIONED_ROUTES, disabledModels: ["pi/*", "claude/*"] });
	for (const runtime of RUNTIMES) {
		blocked(decide(runtime, "lead", peerArgs("pi-peer/Mx/mid", "medium", "CODING_MEDIUM"), host.table()), /ROUTE_MODEL_DISABLED.*not moved to another model.*Human's call/, `${runtime}`);
	}
	const allOff = structuredClone(OPTIONED_ROUTES) as any;
	allOff.CODING_MEDIUM.enabled = false;
	for (const alt of allOff.CODING_MEDIUM.alternates) alt.enabled = false;
	host.routing({ routes: allOff });
	for (const runtime of RUNTIMES) blocked(decide(runtime, "lead", peerArgs("pi-peer/Mx/mid", "medium", "CODING_MEDIUM"), host.table()), /ROUTE_CLASS_DISABLED/, `${runtime}`);
});

test("options of another tool serve only seats of that tool; update_agent and team_fork follow the same list", () => {
	const host = liveHost();
	host.routing({ routes: OPTIONED_ROUTES });
	const piSeat: RouteTarget = { agentId: AGENT_PEER, provider: "pi-peer/Mx/mid", modelClass: "CODING_MEDIUM", watch: null };
	for (const runtime of RUNTIMES) {
		// a pi seat may move to the other pi option, not to a claude model
		assert.equal(decideUpdate(runtime, "lead", { agentId: AGENT_PEER, settings: { model: "Mx/other", thinkingOptionId: "low" } }, piSeat, host.table()), null, `${runtime}: to the other pi option`);
		blocked(decideUpdate(runtime, "lead", { agentId: AGENT_PEER, settings: { model: "claude-sonnet-5-5" } }, piSeat, host.table()), /ROUTE_MODEL_MISMATCH.*Expected one of: settings \{ model: "Mx\/mid".*"Mx\/other"/, `${runtime}: a claude model on a pi seat`);
		blocked(decideUpdate(runtime, "lead", { agentId: AGENT_PEER, settings: { thinkingOptionId: "high" } }, piSeat, host.table()), /ROUTE_THINKING_MISMATCH/, `${runtime}: thinking of an option the seat's model does not have`);
		assert.equal(decideUpdate(runtime, "lead", { agentId: AGENT_PEER, settings: { thinkingOptionId: "medium" } }, piSeat, host.table()), null, `${runtime}: its own model's thinking`);
	}
	// a claude peer seating for a pi/claude class sees only claude options in a mismatch list
	for (const runtime of RUNTIMES) {
		blocked(decide(runtime, "lead", peerArgs("claude-peer/claude-opus-5", "high", "CODING_MEDIUM"), host.table()), /ROUTE_MODEL_MISMATCH.*Expected provider "claude-peer\/claude-sonnet-5-5" with settings\.thinkingOptionId "high"\./, `${runtime}: one claude option => the single wording`);
	}
	const fork = (model?: string, thinking?: string) =>
		forkRouteDecision({ role: "lead", provider: "pi-peer", modelClass: "CODING_MEDIUM", model, thinking, routeTable: host.table(), env: ENFORCED } as any);
	const ambiguous = fork();
	assert.equal(ambiguous.ok, false);
	assert.match((ambiguous as any).reason, /ROUTE_OPTION_AMBIGUOUS.*2 usable options.*nothing is chosen for you/, "no model named, two usable pi options: refuse, do not take the first");
	assert.deepEqual(fork("Mx/other"), { ok: true, enforced: true, model: "Mx/other", thinking: "low" });
	assert.equal(fork("Mx/other", "high").ok, false);
	assert.equal(fork("Mx/nope").ok, false);
	// a class with one option behaves exactly as before: omitted means "take the route's"
	const single = forkRouteDecision({ role: "lead", provider: "pi-peer", modelClass: "FAST_READ", routeTable: host.table(), env: ENFORCED } as any);
	assert.deepEqual(single, { ok: true, enforced: true, model: "Mx/cheap", thinking: "low" });
});

test("'Routing now' lists every option of a class as 'pick one'", () => {
	const host = liveHost();
	host.routing({ routes: OPTIONED_ROUTES, disabledModels: ["pi/Mx/other"] });
	const notice = routingAvailabilityNotice("lead", host.table());
	assert.ok(notice);
	assert.match(notice.text, /CODING_MEDIUM=\[pick one: pi-peer\/Mx\/mid@medium \| claude-peer\/claude-sonnet-5-5@high \| pi-peer\/Mx\/other: OFF \(model switched off\)\]/);
	assert.match(notice.text, /FAST_READ=pi-peer\/Mx\/cheap@low/, "a one-option class reads as before");
});
