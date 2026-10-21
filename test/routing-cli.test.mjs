// routing-cli.test.mjs — `pteam routing show|check|set|unset`.
//
// Driven through the real CLI binary, against a throwaway config dir
// (PST_TEAM_CONFIG_DIR) and an injected inventory (fake-paseo-routing.mjs), so
// no case can read or write the developer's real ~/.paseo-pi-team or talk to a
// real daemon. What is pinned here is the contract that makes `set` safe to
// hand to a Lead or a Human: it validates STRICTLY against the live inventory,
// writes NOTHING when the route does not resolve, and always leaves a
// `<file>.bak-<epoch>` of what it replaced.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "cli", "paseo-team.mjs");
const FAKE = join(HERE, "fixtures", "fake-paseo-routing.mjs");
const sandbox = mkdtempSync(join(tmpdir(), "pteam-routing-cli-"));
after(() => rmSync(sandbox, { recursive: true, force: true }));

const BASE_ROUTES = {
	MONITOR_ECONOMY: { paseoProvider: "pi-supervisor", model: "Mx/cheap", thinking: "low" },
	FAST_READ: { paseoProvider: "pi-peer", model: "Mx/cheap", thinking: "low" },
	CODING_MEDIUM: { paseoProvider: "pi-peer", model: "Mx/mid", thinking: "medium" },
	REASONING_HIGH: { paseoProvider: "claude-peer", model: "claude-opus-5", thinking: "high" },
	REVIEW_HIGH: { paseoProvider: "claude-peer", model: "claude-opus-5", thinking: "xhigh" },
};

const INVENTORY = {
	providers: ["pi-supervisor", "pi-lead", "pi-peer", "claude-supervisor", "claude-lead", "claude-peer"].map((provider) => ({
		provider,
		enabled: "Enabled",
		status: "available",
	})),
	models: {
		"pi-peer": [
			{ id: "Mx/cheap", thinkingOptionIds: ["off", "low"] },
			{ id: "Mx/mid", thinkingOptionIds: ["low", "medium"] },
		],
		"pi-supervisor": [{ id: "Mx/cheap", thinkingOptionIds: ["low"] }],
		"pi-lead": [{ id: "Mx/big", thinkingOptionIds: ["medium", "high"] }],
		"claude-peer": [{ id: "claude-opus-5", thinkingOptionIds: ["high", "xhigh"] }],
		"claude-supervisor": [{ id: "claude-opus-5", thinkingOptionIds: ["high", "max"] }],
		"claude-lead": [{ id: "claude-opus-5", thinkingOptionIds: ["high"] }],
	},
};

let count = 0;
/** A fresh config dir + inventory file; returns the paths and a runner bound to them. */
function host({ routing, cluster, inventory = INVENTORY } = {}) {
	const dir = join(sandbox, `host-${(count += 1)}`);
	mkdirSync(dir, { recursive: true });
	const routingPath = join(dir, "model-routing.local.json");
	const clusterPath = join(dir, "cluster-routing.local.json");
	if (routing) writeFileSync(routingPath, `${JSON.stringify(routing, null, 2)}\n`);
	if (cluster) writeFileSync(clusterPath, `${JSON.stringify(cluster, null, 2)}\n`);
	const inventoryPath = join(dir, "inventory.json");
	if (inventory) writeFileSync(inventoryPath, JSON.stringify(inventory));
	const run = (args, extraEnv = {}) => {
		const env = { ...process.env };
		for (const key of Object.keys(env)) if (key.startsWith("PASEO_") || key.startsWith("PST_")) delete env[key];
		const result = spawnSync(process.execPath, [CLI, "routing", ...args], {
			encoding: "utf8",
			env: {
				...env,
				PST_TEAM_CONFIG_DIR: dir,
				PASEO_TEAM_PASEO_EXEC: `node "${FAKE}"`,
				FAKE_ROUTING_INVENTORY: inventoryPath,
				PI_HOME: join(dir, "pi"),
				PASEO_HOME: join(dir, "paseo"),
				...extraEnv,
			},
		});
		let json = null;
		try {
			json = JSON.parse(result.stdout);
		} catch {
			/* text output */
		}
		return { ...result, json };
	};
	const backups = () => readdirSync(dir).filter((name) => /\.bak-\d+$/.test(name));
	const read = (path) => JSON.parse(readFileSync(path, "utf8"));
	return { dir, routingPath, clusterPath, run, backups, read };
}

const routingOnly = () => host({ routing: { version: 1, hostId: "minnyat", routes: BASE_ROUTES } });
const clusterHost = () =>
	host({
		cluster: {
			version: 1,
			hosts: {
				ctl: { connection: { type: "local" }, required: true, capabilities: ["git-read"], routes: BASE_ROUTES },
				mac: {
					connection: { type: "remote", endpointEnv: "PASEO_MAC" },
					required: false,
					capabilities: ["git-read"],
					routes: BASE_ROUTES,
				},
			},
		},
	});

// --- show ----------------------------------------------------------------------

test("show: the effective route per class, optional classes marked unset, text and --json", () => {
	const h = routingOnly();
	const json = h.run(["show", "--json"]);
	assert.equal(json.status, 0, json.stderr);
	assert.equal(json.json.ok, true);
	assert.equal(json.json.source, "routing");
	assert.equal(json.json.path, h.routingPath);
	assert.equal(json.json.enforcement, "on");
	const byClass = Object.fromEntries(json.json.classes.map((entry) => [entry.class, entry]));
	assert.equal(byClass.CODING_MEDIUM.createAgentProvider, "pi-peer/Mx/mid");
	assert.equal(byClass.SUPERVISOR_GOVERNANCE.configured, false);
	assert.equal(byClass.SUPERVISOR_GOVERNANCE.required, false);
	assert.equal(byClass.LEAD_RECOVERY.configured, false);
	assert.ok(json.json.warnings.some((w) => /SUPERVISOR_GOVERNANCE is not configured/.test(w)));

	const text = h.run(["show"]);
	assert.equal(text.status, 0);
	assert.match(text.stdout, /SUPERVISOR_GOVERNANCE\s+— not configured \(optional\)/);
	assert.match(text.stdout, /CODING_MEDIUM\s+pi-peer\/Mx\/mid\s+thinking=medium/);

	const off = h.run(["show", "--json"], { PASEO_TEAM_ROUTE_ENFORCE: "off" });
	assert.equal(off.json.enforcement, "off");
	assert.ok(off.json.warnings.some((w) => /PASEO_TEAM_ROUTE_ENFORCE=off/.test(w)), "the opt-out is flagged");
});

test("show: a cluster host reports its LOCAL host; a missing file is a failure, not an empty table", () => {
	const c = clusterHost();
	const shown = c.run(["show", "--json"]);
	assert.equal(shown.json.source, "cluster");
	assert.equal(shown.json.hostId, "ctl");

	const empty = host({});
	const missing = empty.run(["show", "--json"]);
	assert.equal(missing.status, 1);
	assert.equal(missing.json.ok, false);
	assert.equal(missing.json.code, "ROUTE_FILE_MISSING");
});

// --- check ---------------------------------------------------------------------

test("check: resolves every configured class strictly against the live inventory", () => {
	const h = routingOnly();
	const ok = h.run(["check", "--json"]);
	assert.equal(ok.status, 0, ok.stdout);
	const byId = Object.fromEntries(ok.json.checks.map((check) => [check.id, check]));
	assert.equal(byId["route:CODING_MEDIUM"].status, "pass");
	assert.equal(byId["route:LEAD_RECOVERY"].status, "warn", "an absent optional class warns");
	assert.equal(byId["route-gate"].status, "pass");

	const noDaemon = host({ routing: { version: 1, hostId: "h", routes: BASE_ROUTES }, inventory: null });
	const down = noDaemon.run(["check", "--json"]);
	assert.equal(down.status, 1, "an unreadable inventory is not a pass");
	assert.match(down.json.checks.find((c) => c.id === "route:FAST_READ").detail, /unverifiable is not a pass/);

	const drift = host({
		routing: { version: 1, hostId: "h", routes: { ...BASE_ROUTES, CODING_MEDIUM: { paseoProvider: "pi-peer", model: "Mx/mid", thinking: "high" } } },
	});
	const bad = drift.run(["check"]);
	assert.equal(bad.status, 1);
	assert.match(bad.stdout, /✗ route:CODING_MEDIUM: .*thinking "high" is not offered/);
	assert.match(bad.stdout, /routing: FAILED/);
});

test("check: one inventory read per DISTINCT provider, not one per option", () => {
	// Seven enabled options across three providers (CODING_MEDIUM carries two
	// alternates). The old behavior paid two paseo spawns PER OPTION and ran
	// them one after another — ~38s on the reference host; the contract pinned
	// here is one `provider ls` plus one `provider models` per distinct
	// provider, with the answers, the check rows and their order unchanged.
	const routing = {
		version: 1,
		hostId: "dedup",
		routes: {
			...BASE_ROUTES,
			CODING_MEDIUM: {
				...BASE_ROUTES.CODING_MEDIUM,
				alternates: [
					{ paseoProvider: "pi-peer", model: "Mx/cheap", thinking: "low" },
					{ paseoProvider: "claude-peer", model: "claude-opus-5", thinking: "high" },
				],
			},
		},
	};
	const h = host({ routing });
	const logPath = join(h.dir, "paseo-calls.log");
	const result = h.run(["check", "--json"], { FAKE_PASEO_LOG: logPath });
	assert.equal(result.status, 0, result.stderr);
	const calls = readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line).argv);
	const ls = calls.filter((argv) => argv[0] === "provider" && argv[1] === "ls");
	assert.equal(ls.length, 1, `provider ls is asked once, not once per option (${calls.map((a) => a.join(" ")).join(" | ")})`);
	for (const provider of ["pi-supervisor", "pi-peer", "claude-peer"]) {
		const asks = calls.filter((argv) => argv[0] === "provider" && argv[1] === "models" && argv[2] === provider);
		assert.equal(asks.length, 1, `${provider} is asked once, however many options sit on it`);
	}
	const byId = Object.fromEntries(result.json.checks.map((check) => [check.id, check]));
	for (const id of ["route:MONITOR_ECONOMY", "route:FAST_READ", "route:CODING_MEDIUM", "route:CODING_MEDIUM#1", "route:CODING_MEDIUM#2", "route:REASONING_HIGH", "route:REVIEW_HIGH"]) {
		assert.equal(byId[id].status, "pass", `${id} still resolves — dedup must not change the verdict`);
	}
	// A switched-off option must not buy its provider a daemon round-trip:
	// the cache is paid for by options that are actually checked. Disable the
	// only class on pi-supervisor; nothing else sits on that provider.
	const offRouting = {
		version: 1,
		hostId: "dedup-off",
		routes: {
			...BASE_ROUTES,
			MONITOR_ECONOMY: { ...BASE_ROUTES.MONITOR_ECONOMY, enabled: false },
		},
	};
	const off = host({ routing: offRouting });
	const offLog = join(off.dir, "paseo-calls.log");
	const offResult = off.run(["check", "--json"], { FAKE_PASEO_LOG: offLog });
	assert.equal(offResult.status, 0, offResult.stderr);
	const offCalls = readFileSync(offLog, "utf8").trim().split("\n").map((line) => JSON.parse(line).argv);
	assert.ok(
		!offCalls.some((argv) => argv[0] === "provider" && argv[1] === "models" && argv[2] === "pi-supervisor"),
		"a disabled class never reaches the daemon for its inventory",
	);
	const offById = Object.fromEntries(offResult.json.checks.map((check) => [check.id, check]));
	assert.equal(offById["route:MONITOR_ECONOMY"].status, "warn");
});

// --- set -----------------------------------------------------------------------

test("set: a routable value is written atomically, with a .bak-<epoch> of the previous file", () => {
	const h = routingOnly();
	const before = readFileSync(h.routingPath, "utf8");
	const set = h.run(["set", "SUPERVISOR_GOVERNANCE", "--provider", "claude-supervisor", "--model", "claude-opus-5", "--thinking", "max", "--json"]);
	assert.equal(set.status, 0, set.stderr);
	assert.equal(set.json.wrote, true);
	assert.equal(set.json.createAgentProvider, "claude-supervisor/claude-opus-5");
	assert.deepEqual(h.read(h.routingPath).routes.SUPERVISOR_GOVERNANCE, {
		paseoProvider: "claude-supervisor",
		model: "claude-opus-5",
		thinking: "max",
	});
	const backups = h.backups();
	assert.equal(backups.length, 1);
	assert.match(backups[0], /^model-routing\.local\.json\.bak-\d{13}$/);
	assert.equal(readFileSync(join(h.dir, backups[0]), "utf8"), before, "the backup is the previous file, byte for byte");
	assert.equal(set.json.backup, join(h.dir, backups[0]));
	assert.ok(!readdirSync(h.dir).some((name) => name.includes(".tmp-")), "no temp file is left behind");

	// Changing a required class works the same way.
	const change = h.run(["set", "CODING_MEDIUM", "--provider", "pi-peer", "--model", "Mx/mid", "--thinking", "low"]);
	assert.equal(change.status, 0, change.stderr);
	assert.equal(h.read(h.routingPath).routes.CODING_MEDIUM.thinking, "low");
});

test("set: an unroutable value is REFUSED and nothing is written", () => {
	const h = routingOnly();
	const before = readFileSync(h.routingPath, "utf8");
	const cases = [
		[["LEAD_RECOVERY", "--provider", "pi-lead", "--model", "Mx/big", "--thinking", "xhigh"], /THINKING_OPTION_UNAVAILABLE/],
		[["LEAD_RECOVERY", "--provider", "pi-lead", "--model", "Mx/nope", "--thinking", "high"], /MODEL_UNAVAILABLE/],
		[["LEAD_RECOVERY", "--provider", "pi-peer", "--model", "Mx/mid", "--thinking", "medium"], /LEAD_RECOVERY seats a lead/],
		[["SUPERVISOR_GOVERNANCE", "--provider", "claude-lead", "--model", "claude-opus-5", "--thinking", "high"], /seats a supervisor/],
		[["FAST_READ", "--provider", "pi-peer", "--model", "Mx/cheap", "--thinking", "ultracode"], /THINKING_INVALID/],
		[["FAST_READ", "--provider", "Pi-Peer", "--model", "Mx/cheap", "--thinking", "low"], /PROVIDER_INVALID/],
		[["FAST_READ", "--provider", "pi-peer", "--model", " Mx/cheap", "--thinking", "low"], /MODEL_INVALID/],
		[["GOVERNANCE", "--provider", "pi-supervisor", "--model", "Mx/cheap", "--thinking", "low"], /CLASS_UNKNOWN/],
	];
	for (const [args, pattern] of cases) {
		const result = h.run(["set", ...args]);
		assert.equal(result.status, 1, `${args.join(" ")} must be refused`);
		assert.match(result.stderr, pattern, args.join(" "));
	}
	const unavailable = host({ routing: { version: 1, hostId: "h", routes: BASE_ROUTES }, inventory: null });
	const down = unavailable.run(["set", "FAST_READ", "--provider", "pi-peer", "--model", "Mx/cheap", "--thinking", "low", "--json"]);
	assert.equal(down.status, 1);
	assert.equal(down.json.code, "INVENTORY_UNAVAILABLE");
	assert.deepEqual(unavailable.backups(), []);

	assert.equal(readFileSync(h.routingPath, "utf8"), before, "the route file is untouched");
	assert.deepEqual(h.backups(), [], "a refused set leaves no backup either");
});

test("set: cluster file — default is the gate's local host, --host-id a local host works, a remote host is refused", () => {
	const c = clusterHost();
	const local = c.run(["set", "LEAD_RECOVERY", "--provider", "pi-lead", "--model", "Mx/big", "--thinking", "high", "--json"]);
	assert.equal(local.status, 0, local.stderr);
	assert.equal(local.json.hostId, "ctl");
	assert.equal(local.json.path, c.clusterPath);
	assert.equal(c.read(c.clusterPath).hosts.ctl.routes.LEAD_RECOVERY.model, "Mx/big");
	assert.equal(c.read(c.clusterPath).hosts.mac.routes.LEAD_RECOVERY, undefined, "the remote host is untouched");

	const explicit = c.run(["set", "FAST_READ", "--provider", "pi-peer", "--model", "Mx/mid", "--thinking", "low", "--host-id", "ctl"]);
	assert.equal(explicit.status, 0, explicit.stderr);
	assert.equal(c.read(c.clusterPath).hosts.ctl.routes.FAST_READ.model, "Mx/mid");

	const before = readFileSync(c.clusterPath, "utf8");
	const remote = c.run(["set", "FAST_READ", "--provider", "pi-peer", "--model", "Mx/mid", "--thinking", "low", "--host-id", "mac", "--json"]);
	assert.equal(remote.status, 1);
	assert.equal(remote.json.code, "REMOTE_HOST_UNVERIFIABLE");
	assert.match(remote.json.message, /LOCAL one. Nothing written/);
	const unknown = c.run(["set", "FAST_READ", "--provider", "pi-peer", "--model", "Mx/mid", "--thinking", "low", "--host-id", "nope"]);
	assert.equal(unknown.status, 1);
	assert.match(unknown.stderr, /HOST_UNKNOWN/);
	assert.equal(readFileSync(c.clusterPath, "utf8"), before);
	assert.equal(c.backups().length, 2, "one backup per successful write");
});

test("set: refuses to invent a route file, and to rewrite one that does not load", () => {
	const empty = host({});
	const missing = empty.run(["set", "FAST_READ", "--provider", "pi-peer", "--model", "Mx/cheap", "--thinking", "low"]);
	assert.equal(missing.status, 1);
	assert.match(missing.stderr, /ROUTE_FILE_MISSING.*does not invent the five required classes/);
	assert.equal(existsSync(empty.routingPath), false);

	const broken = host({});
	writeFileSync(broken.routingPath, "{ not json");
	const refused = broken.run(["set", "FAST_READ", "--provider", "pi-peer", "--model", "Mx/cheap", "--thinking", "low"]);
	assert.equal(refused.status, 1);
	assert.match(refused.stderr, /CONFIG_INVALID/);
	assert.equal(readFileSync(broken.routingPath, "utf8"), "{ not json");
});

test("set: an edit made while the route is being validated is not silently overwritten", async () => {
	const { routingSet } = await import("../cli/lib/routing.mjs");
	const h = routingOnly();
	const env = { PST_TEAM_CONFIG_DIR: h.dir };
	const inventoryOk = async () => ({ ok: true, inventory: { providers: INVENTORY.providers, models: INVENTORY.models["pi-lead"] } });
	// The concurrent edit lands DURING the inventory await — the window a cold
	// daemon keeps open for seconds.
	const concurrent = JSON.stringify({ version: 1, hostId: "minnyat", routes: { ...BASE_ROUTES, FAST_READ: { ...BASE_ROUTES.FAST_READ, thinking: "off" } } });
	await assert.rejects(
		routingSet(
			{ modelClass: "LEAD_RECOVERY", provider: "pi-lead", model: "Mx/big", thinking: "high" },
			{
				env,
				inventoryFor: async () => {
					writeFileSync(h.routingPath, concurrent);
					return inventoryOk();
				},
			},
		),
		(error) => {
			assert.equal(error.code, "CONCURRENT_EDIT");
			assert.match(error.message, /changed while this command was validating/);
			return true;
		},
	);
	assert.equal(readFileSync(h.routingPath, "utf8"), concurrent, "the concurrent edit survives");
	assert.deepEqual(h.backups(), [], "nothing was written, so nothing was backed up");

	// Without interference the same call writes.
	const ok = await routingSet(
		{ modelClass: "LEAD_RECOVERY", provider: "pi-lead", model: "Mx/big", thinking: "high" },
		{ env, inventoryFor: inventoryOk },
	);
	assert.equal(ok.wrote, true);
	assert.equal(h.read(h.routingPath).routes.FAST_READ.thinking, "off", "it wrote on top of the file as it now is");
});

// --- unset ---------------------------------------------------------------------

test("unset: removes an optional class with a backup; a required class is refused; an absent one is a no-op", () => {
	const h = routingOnly();
	assert.equal(h.run(["set", "LEAD_RECOVERY", "--provider", "pi-lead", "--model", "Mx/big", "--thinking", "high"]).status, 0);
	const unset = h.run(["unset", "LEAD_RECOVERY", "--json"]);
	assert.equal(unset.status, 0, unset.stderr);
	assert.equal(unset.json.wrote, true);
	assert.equal(h.read(h.routingPath).routes.LEAD_RECOVERY, undefined);
	assert.equal(h.backups().length, 2);

	const again = h.run(["unset", "LEAD_RECOVERY", "--json"]);
	assert.equal(again.status, 0);
	assert.equal(again.json.wrote, false);
	assert.equal(h.backups().length, 2, "a no-op writes nothing");

	const required = h.run(["unset", "REVIEW_HIGH"]);
	assert.equal(required.status, 1);
	assert.match(required.stderr, /CLASS_REQUIRED/);
	assert.ok(h.read(h.routingPath).routes.REVIEW_HIGH);
});

// --- dispatch + help --------------------------------------------------------------

test("dispatch: usage errors exit 2, help lists every subcommand", () => {
	const h = routingOnly();
	for (const args of [[], ["frobnicate"], ["set"], ["set", "FAST_READ", "--provider", "pi-peer"], ["unset"]]) {
		const result = h.run(args);
		assert.equal(result.status, 2, `routing ${args.join(" ")} is a usage error`);
	}
	assert.equal(h.run(["show", "--bogus"]).status, 1, "an unknown flag is refused, never ignored");
	const help = h.run(["--help"]);
	assert.equal(help.status, 0);
	for (const sub of ["show", "check", "set <CLASS>", "unset <CLASS>"]) {
		assert.match(help.stdout, new RegExp(`pteam routing ${sub}`), `help names routing ${sub}`);
	}
});

// --- enable / disable: the quick switch ----------------------------------------------

test("disable / enable flip one route's switch, keep its model, back up, and show it in `show` and `check`", () => {
	const h = routingOnly();
	const off = h.run(["disable", "CODING_MEDIUM", "--json"]);
	assert.equal(off.status, 0, off.stderr);
	assert.equal(off.json.enabled, false);
	assert.equal(off.json.wrote, true);
	assert.equal(h.backups().length, 1, "a backup of what it replaced");
	assert.deepEqual(h.read(h.routingPath).routes.CODING_MEDIUM, { ...BASE_ROUTES.CODING_MEDIUM, enabled: false }, "model and thinking are kept");

	const show = h.run(["show", "--json"]);
	const entry = show.json.classes.find((c) => c.class === "CODING_MEDIUM");
	assert.equal(entry.enabled, false);
	assert.ok(show.json.warnings.some((w) => /CODING_MEDIUM is switched off.*pteam routing enable/.test(w)));
	assert.match(h.run(["show"]).stdout, /CODING_MEDIUM\s+pi-peer\/Mx\/mid\s+thinking=medium \[OFF\]/);

	const check = h.run(["check", "--json"]);
	const row = check.json.checks.find((c) => c.id === "route:CODING_MEDIUM");
	assert.equal(row.status, "warn", "a deliberate switch-off is a warning, never a failure");
	assert.equal(check.json.ok, true);

	const again = h.run(["disable", "CODING_MEDIUM", "--json"]);
	assert.equal(again.json.wrote, false, "already off: nothing written");
	assert.equal(h.backups().length, 1);

	// `set` changes what the class routes to without silently switching it back on.
	const set = h.run(["set", "CODING_MEDIUM", "--provider", "pi-peer", "--model", "Mx/cheap", "--thinking", "low", "--json"]);
	assert.equal(set.status, 0, set.stderr);
	assert.deepEqual(h.read(h.routingPath).routes.CODING_MEDIUM, { paseoProvider: "pi-peer", model: "Mx/cheap", thinking: "low", enabled: false });

	const on = h.run(["enable", "CODING_MEDIUM", "--json"]);
	assert.equal(on.status, 0, on.stderr);
	assert.equal("enabled" in h.read(h.routingPath).routes.CODING_MEDIUM, false, "on is the absence of the key");
});

test("enable/disable refuse an unknown class and a class with no route, writing nothing", () => {
	const h = routingOnly();
	const unknown = h.run(["disable", "NOPE", "--json"]);
	assert.equal(unknown.status, 1);
	assert.equal(unknown.json.code, "CLASS_UNKNOWN");
	const none = h.run(["disable", "LEAD_RECOVERY", "--json"]);
	assert.equal(none.status, 1);
	assert.equal(none.json.code, "CLASS_UNCONFIGURED");
	assert.equal(h.backups().length, 0);
});

test("disable works on a cluster host's route file too (--host-id)", () => {
	const h = clusterHost();
	const result = h.run(["disable", "FAST_READ", "--host-id", "ctl", "--json"]);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(h.read(h.clusterPath).hosts.ctl.routes.FAST_READ.enabled, false);
	assert.equal(h.read(h.clusterPath).hosts.mac.routes.FAST_READ.enabled, undefined, "only the named host");
});

// --- disable-model / enable-model: "this model is out of credit" ----------------------

test("disable-model / enable-model edit one list in the file the gate reads, validated, backed up", () => {
	const h = routingOnly();
	const off = h.run(["disable-model", "pi/Mx/mid", "--json"]);
	assert.equal(off.status, 0, off.stderr);
	assert.deepEqual(off.json.disabledModels, ["pi/Mx/mid"]);
	assert.equal(h.backups().length, 1);
	assert.deepEqual(h.read(h.routingPath).disabledModels, ["pi/Mx/mid"]);
	assert.deepEqual(h.read(h.routingPath).routes, BASE_ROUTES, "no route is touched");

	const again = h.run(["disable-model", "pi/Mx/mid", "--json"]);
	assert.equal(again.json.wrote, false);
	assert.equal(h.backups().length, 1);

	const show = h.run(["show", "--json"]);
	assert.deepEqual(show.json.disabledModels, ["pi/Mx/mid"]);
	const byClass = Object.fromEntries(show.json.classes.map((c) => [c.class, c]));
	assert.equal(byClass.CODING_MEDIUM.modelDisabled, true, "the class on that model is flagged");
	assert.equal(byClass.CODING_MEDIUM.enabled, true, "its own switch is a separate fact");
	assert.equal(byClass.FAST_READ.modelDisabled, false);
	assert.ok(show.json.warnings.some((w) => /CODING_MEDIUM routes to a model that is switched off/.test(w)));
	assert.match(h.run(["show"]).stdout, /CODING_MEDIUM .*\[MODEL OFF\]/);
	assert.match(h.run(["show"]).stdout, /models switched off: pi\/Mx\/mid/);
	const check = h.run(["check", "--json"]);
	assert.equal(check.json.checks.find((c) => c.id === "route:CODING_MEDIUM").status, "warn", "a deliberate switch-off is a warning");

	h.run(["disable-model", "claude/claude-opus-5"]);
	const wild = h.run(["disable-model", "pi/Mx/*", "--json"]);
	assert.deepEqual(wild.json.disabledModels, ["pi/Mx/mid", "claude/claude-opus-5", "pi/Mx/*"]);

	const on = h.run(["enable-model", "pi/Mx/mid", "--json"]);
	assert.deepEqual(on.json.disabledModels, ["claude/claude-opus-5", "pi/Mx/*"]);
	h.run(["enable-model", "claude/claude-opus-5"]);
	h.run(["enable-model", "pi/Mx/*"]);
	assert.equal("disabledModels" in h.read(h.routingPath), false, "an empty list is dropped");
});

test("disable-model refuses a bad key and writes nothing; works per host in a cluster file", () => {
	const h = routingOnly();
	for (const bad of ["Mx/gpt", "pi", "pi/a*b", "gpt/x"]) {
		const r = h.run(["disable-model", bad, "--json"]);
		assert.equal(r.status, 1, bad);
		assert.equal(r.json.code, "MODEL_KEY_INVALID", bad);
	}
	assert.equal(h.run(["disable-model"]).status, 2, "a missing key is a usage error");
	assert.equal(h.backups().length, 0);

	const c = clusterHost();
	const r = c.run(["disable-model", "pi/Mx/*", "--host-id", "ctl", "--json"]);
	assert.equal(r.status, 0, r.stderr);
	assert.deepEqual(c.read(c.clusterPath).hosts.ctl.disabledModels, ["pi/Mx/*"]);
	assert.equal(c.read(c.clusterPath).hosts.mac.disabledModels, undefined, "only the named host");
	// without --host-id it edits the host the gate reads (the local one)
	const d = c.run(["disable-model", "claude/claude-opus-5", "--json"]);
	assert.equal(d.status, 0, d.stderr);
	assert.deepEqual(c.read(c.clusterPath).hosts.ctl.disabledModels, ["pi/Mx/*", "claude/claude-opus-5"]);
});

// --- a class with several options: add-option / remove-option / --option ---------------

test("add-option gives a class another tool/model, verified live; set keeps it; show lists every option", () => {
	const h = routingOnly();
	// claude-peer has claude-opus-5 (high/xhigh) in the fake inventory
	const added = h.run(["add-option", "CODING_MEDIUM", "--provider", "claude-peer", "--model", "claude-opus-5", "--thinking", "high", "--json"]);
	assert.equal(added.status, 0, added.stderr);
	assert.equal(added.json.option, 1);
	assert.equal(added.json.createAgentProvider, "claude-peer/claude-opus-5");
	assert.equal(h.backups().length, 1);
	assert.deepEqual(h.read(h.routingPath).routes.CODING_MEDIUM.alternates, [{ paseoProvider: "claude-peer", model: "claude-opus-5", thinking: "high" }]);

	const show = h.run(["show", "--json"]);
	const entry = show.json.classes.find((c) => c.class === "CODING_MEDIUM");
	assert.deepEqual(entry.options.map((o) => `${o.index}:${o.createAgentProvider}`), ["0:pi-peer/Mx/mid", "1:claude-peer/claude-opus-5"]);
	assert.equal(entry.usable, true);
	assert.match(h.run(["show"]).stdout, /CODING_MEDIUM\s+pi-peer\/Mx\/mid\s+thinking=medium\n\s+#1 claude-peer\/claude-opus-5\s+thinking=high/);

	// `set` changes the primary and must not drop the other options
	const set = h.run(["set", "CODING_MEDIUM", "--provider", "pi-peer", "--model", "Mx/cheap", "--thinking", "low", "--json"]);
	assert.equal(set.status, 0, set.stderr);
	const after = h.read(h.routingPath).routes.CODING_MEDIUM;
	assert.equal(after.model, "Mx/cheap");
	assert.equal(after.alternates.length, 1, "set kept the alternates");

	const check = h.run(["check", "--json"]);
	assert.equal(check.json.checks.find((c) => c.id === "route:CODING_MEDIUM#1").status, "pass", "every option is checked, as route:CLASS#N");
});

test("add-option refuses an unverifiable, duplicate or wrong-role option and writes nothing", () => {
	const h = routingOnly();
	const missingModel = h.run(["add-option", "CODING_MEDIUM", "--provider", "claude-peer", "--model", "no-such", "--thinking", "high", "--json"]);
	assert.equal(missingModel.status, 1);
	assert.ok(missingModel.json.code);
	const dup = h.run(["add-option", "CODING_MEDIUM", "--provider", "pi-peer", "--model", "Mx/mid", "--thinking", "medium", "--json"]);
	assert.equal(dup.status, 1, "an exact repeat of the primary");
	const wrongRole = h.run(["add-option", "FAST_READ", "--provider", "pi-supervisor", "--model", "Mx/cheap", "--thinking", "low", "--json"]);
	assert.equal(wrongRole.status, 1, "a Supervisor option in a Peer class");
	assert.equal(h.run(["add-option", "NOPE", "--provider", "pi-peer", "--model", "x", "--thinking", "low", "--json"]).json.code, "CLASS_UNKNOWN");
	assert.equal(h.run(["add-option", "CODING_MEDIUM", "--provider", "pi-peer"]).status, 2, "all three flags are required");
	assert.equal(h.backups().length, 0);
	assert.deepEqual(h.read(h.routingPath).routes.CODING_MEDIUM, BASE_ROUTES.CODING_MEDIUM);
});

test("enable/disable --option switches one option; without it the whole class; remove-option drops an alternate", () => {
	const h = host({
		routing: {
			version: 1,
			hostId: "minnyat",
			routes: { ...BASE_ROUTES, CODING_MEDIUM: { ...BASE_ROUTES.CODING_MEDIUM, alternates: [{ paseoProvider: "claude-peer", model: "claude-opus-5", thinking: "high" }] } },
		},
	});
	const off = h.run(["disable", "CODING_MEDIUM", "--option", "0", "--json"]);
	assert.equal(off.status, 0, off.stderr);
	let route = h.read(h.routingPath).routes.CODING_MEDIUM;
	assert.equal(route.enabled, false);
	assert.equal(route.alternates[0].enabled, undefined, "only the primary");
	let show = h.run(["show", "--json"]).json;
	let entry = show.classes.find((c) => c.class === "CODING_MEDIUM");
	assert.equal(entry.usable, true, "the class is still usable through its other option");
	assert.deepEqual(entry.options.map((o) => o.enabled), [false, true]);
	assert.ok(!show.warnings.some((w) => /CODING_MEDIUM is switched off/.test(w)), "no class-level warning while an option is on");
	assert.match(h.run(["show"]).stdout, /CODING_MEDIUM\s+pi-peer\/Mx\/mid\s+thinking=medium \[OFF\]/);

	// the whole class: every option off, then a class-level warning
	h.run(["disable", "CODING_MEDIUM"]);
	route = h.read(h.routingPath).routes.CODING_MEDIUM;
	assert.equal(route.enabled, false);
	assert.equal(route.alternates[0].enabled, false);
	show = h.run(["show", "--json"]).json;
	assert.equal(show.classes.find((c) => c.class === "CODING_MEDIUM").usable, false);
	assert.ok(show.warnings.some((w) => /CODING_MEDIUM is switched off/.test(w)));
	const bad = h.run(["disable", "CODING_MEDIUM", "--option", "7", "--json"]);
	assert.equal(bad.status, 1);
	assert.equal(bad.json.code, "OPTION_UNKNOWN");
	assert.equal(h.run(["disable", "CODING_MEDIUM", "--option", "x"]).status, 2);

	h.run(["enable", "CODING_MEDIUM"]);
	route = h.read(h.routingPath).routes.CODING_MEDIUM;
	assert.equal("enabled" in route, false);
	assert.equal("enabled" in route.alternates[0], false);

	const removed = h.run(["remove-option", "CODING_MEDIUM", "1", "--json"]);
	assert.equal(removed.status, 0, removed.stderr);
	assert.equal("alternates" in h.read(h.routingPath).routes.CODING_MEDIUM, false, "an empty list is dropped");
	assert.equal(h.run(["remove-option", "CODING_MEDIUM", "1", "--json"]).json.code, "OPTION_UNKNOWN");
	assert.equal(h.run(["remove-option", "CODING_MEDIUM", "0", "--json"]).json.code, "OPTION_UNKNOWN", "the primary is changed with set, not removed");
});
