// runtime-families.test.mts — a Peer-only runtime (opencode) end to end:
// descriptor → generated provider → route gate on both adapters → CLI apply.
//
// The invariant under test is the one that makes adding a coding agent safe:
// a runtime enters the pack only with enforcement, and only a runtime the core
// polices per turn ("full") may carry Supervisor or Lead authority.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
	ROLE_PROVIDERS as CORE_ROLE_PROVIDERS,
	mcpBlockReason,
	parseRoleProvider,
	type RouteTable,
} from "../extensions/paseo-team-core/policy-core.ts";
import { claudeToolBlockReason } from "../extensions/paseo-team-core/claude-policy.ts";
// @ts-ignore — plain .mjs module
import { PASEO_EXTENDABLE_BASES, RUNTIME_DESCRIPTORS, RUNTIME_FAMILIES, gateRouteTable } from "../scripts/model-routing.mjs";
// @ts-ignore — plain .mjs module
import {
	STATIC_PEER_BASH_DENY,
	generatedFamilies,
	hasStaticPolicyBuilder,
	materializeRuntimeProviders,
	runtimeProviderEntry,
	// @ts-ignore — plain .mjs module
} from "../scripts/runtime-providers.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = mkdtempSync(join(tmpdir(), "pteam-runtimes-"));
after(() => rmSync(sandbox, { recursive: true, force: true }));

/**
 * OpenCode's rule evaluation: the ruleset is flattened in config order and the
 * LAST matching rule wins (measured on opencode 1.19.5 with
 * `opencode debug agent build`: our denies land after the "*" allow).
 */
function opencodeDecision(config: any, permission: string, subject: string): string | undefined {
	const value = config.permission?.[permission];
	const rules: [string, string][] = typeof value === "string" ? [["*", value]] : Object.entries(value ?? {});
	const match = (pattern: string) =>
		new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`).test(subject);
	return rules.filter(([pattern]) => match(pattern)).pop()?.[1];
}

test("every non-full family is Peer-only, extends a provider Paseo accepts, and has a policy builder", () => {
	for (const family of RUNTIME_FAMILIES) {
		const d = RUNTIME_DESCRIPTORS[family];
		assert.ok(PASEO_EXTENDABLE_BASES.includes(d.paseoBase), `${family}: ${d.paseoBase}`);
		if (d.enforcement === "full") continue;
		assert.deepEqual([...d.roles], ["peer"], `${family}: Peer-only`);
		assert.equal(d.enforcement, "static", `${family}: the only non-full tier`);
		assert.ok(hasStaticPolicyBuilder(family), `${family}: a static family must bring its permission builder`);
	}
	assert.deepEqual(generatedFamilies(), ["opencode"]);
});

test("the policy core knows the same role providers, and no Peer-only family parses as Lead/Supervisor", () => {
	assert.ok(CORE_ROLE_PROVIDERS.includes("opencode-peer"));
	assert.deepEqual(parseRoleProvider("opencode-peer"), { family: "opencode", role: "peer", seat: null });
	assert.equal(parseRoleProvider("opencode-lead"), null);
	assert.equal(parseRoleProvider("opencode-supervisor/anthropic/x"), null);
});

test("opencode-peer: extends opencode, carries the role, and OpenCode's own config denies what a static policy must", () => {
	const entry = runtimeProviderEntry("opencode", "peer", { promptsDir: "/p" });
	assert.equal(entry.extends, "opencode");
	assert.equal(entry.env.PASEO_PI_ROLE, "peer");
	const config = JSON.parse(entry.env.OPENCODE_CONFIG_CONTENT);
	assert.deepEqual(config.instructions, [join("/p", "peer.md")], "role prompt loaded by OpenCode itself");
	for (const command of [
		"git push -u origin HEAD:refs/heads/agent/T-1",
		"git push --force origin main",
		"git commit -m x",
		"git -C /w commit -m x",
		"git merge main",
		"git reset --hard HEAD~1",
		"paseo run --provider pi-peer x",
		"pteam permits allow 1",
	]) {
		assert.equal(opencodeDecision(config, "bash", command), "deny", command);
	}
	for (const command of ["npm test", "git status", "git diff HEAD~1", "node scripts/x.mjs"]) {
		assert.equal(opencodeDecision(config, "bash", command), "allow", command);
	}
	assert.equal(opencodeDecision(config, "webfetch", "https://example.com"), "deny");
	assert.equal(opencodeDecision(config, "question", "*"), "deny", "Peer never asks the Human");
	assert.equal(opencodeDecision(config, "edit", "src/a.ts"), "allow");
	assert.ok(STATIC_PEER_BASH_DENY.length > 0);
});

test("the generator refuses what is not a Peer-only role provider", () => {
	assert.throws(() => runtimeProviderEntry("opencode", "lead"), /carries only peer/);
	assert.throws(() => runtimeProviderEntry("pi", "peer"), /own installer/);
	assert.throws(() => runtimeProviderEntry("antigravity", "peer"), /unknown runtime family/);
	assert.throws(() => materializeRuntimeProviders({ families: ["nope"] }), /unknown runtime family/);
	assert.deepEqual(Object.keys(materializeRuntimeProviders()), ["opencode-peer"]);
});

// --- the route gate, through BOTH adapters -----------------------------------

const ROUTES = {
	MONITOR_ECONOMY: { paseoProvider: "pi-supervisor", model: "Mx/cheap", thinking: "low" },
	FAST_READ: { paseoProvider: "opencode-peer", model: "opencode/beam-free", thinking: "low" },
	CODING_MEDIUM: {
		paseoProvider: "pi-peer",
		model: "Mx/mid",
		thinking: "medium",
		alternates: [{ paseoProvider: "opencode-peer", model: "github-copilot/claude-opus-5.5", thinking: "high" }],
	},
	REASONING_HIGH: { paseoProvider: "claude-peer", model: "claude-opus-5", thinking: "high" },
	REVIEW_HIGH: { paseoProvider: "claude-peer", model: "claude-opus-5", thinking: "xhigh" },
};

function table(): RouteTable {
	const dir = join(sandbox, "routes");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "model-routing.local.json"), JSON.stringify({ version: 1, hostId: "h", routes: ROUTES }));
	return gateRouteTable({ env: { PST_TEAM_CONFIG_DIR: dir } }) as RouteTable;
}

function decide(runtime: "pi" | "claude", args: unknown, routeTable: RouteTable): string | null {
	if (runtime === "pi") return mcpBlockReason("lead", { tool: "create_agent", args }, { routeTable, env: {} });
	return claudeToolBlockReason({ role: "lead", toolName: "mcp__paseo__create_agent", toolInput: args, brief: null, routeTable, env: {} });
}

const seat = (provider: string, thinking: string, cls: string) => ({
	title: "t",
	initialPrompt: "brief",
	provider,
	settings: { thinkingOptionId: thinking },
	labels: { "team.model-class": cls },
});

test("a Lead seats opencode-peer from its route (primary or alternate) on both runtimes", () => {
	const routeTable = table();
	for (const runtime of ["pi", "claude"] as const) {
		assert.equal(decide(runtime, seat("opencode-peer/opencode/beam-free", "low", "FAST_READ"), routeTable), null, `${runtime}: primary`);
		assert.equal(
			decide(runtime, seat("opencode-peer/github-copilot/claude-opus-5.5", "high", "CODING_MEDIUM"), routeTable),
			null,
			`${runtime}: alternate`,
		);
		assert.match(
			String(decide(runtime, seat("opencode-peer/opencode/other", "low", "FAST_READ"), routeTable)),
			/ROUTE_MODEL_MISMATCH/,
			`${runtime}: off-route model`,
		);
		assert.match(
			String(decide(runtime, seat("opencode-lead/opencode/beam-free", "low", "FAST_READ"), routeTable)),
			/ROUTE_PROVIDER_UNKNOWN/,
			`${runtime}: a Peer-only runtime cannot be seated as Lead`,
		);
	}
});

test("a route file cannot name a role a Peer-only runtime does not carry", () => {
	const dir = join(sandbox, "bad-routes");
	mkdirSync(dir, { recursive: true });
	const routes = { ...ROUTES, MONITOR_ECONOMY: { paseoProvider: "opencode-supervisor", model: "opencode/beam-free", thinking: "low" } };
	writeFileSync(join(dir, "model-routing.local.json"), JSON.stringify({ version: 1, hostId: "h", routes }));
	const r = spawnSync(process.execPath, [join(ROOT, "scripts/model-routing.mjs"), "validate", "--json"], {
		encoding: "utf8",
		env: { ...process.env, PST_TEAM_CONFIG_DIR: dir, PASEO_TEAM_HOME: dir },
	});
	assert.notEqual(r.status, 0, r.stdout);
	assert.match(r.stdout + r.stderr, /opencode-supervisor/);
});

// --- pteam runtimes apply ------------------------------------------------------

test("pteam runtimes apply: writes opencode-peer, is idempotent, never overwrites a hand-written provider", () => {
	const home = join(sandbox, "home");
	mkdirSync(join(home, ".paseo"), { recursive: true });
	const configPath = join(home, ".paseo", "config.json");
	writeFileSync(configPath, JSON.stringify({ version: 1, agents: { providers: { "pi-peer": { extends: "pi", label: "mine" } } } }));
	const env = { ...process.env, HOME: home, USERPROFILE: home, PST_TEAM_CONFIG_DIR: join(home, ".paseo-team-orchestration") };
	delete (env as Record<string, unknown>).PASEO_TEAM_HOME;
	const run = (...args: string[]) => {
		const r = spawnSync(process.execPath, [join(ROOT, "cli/paseo-team.mjs"), "runtimes", ...args], { encoding: "utf8", env });
		assert.equal(r.status, 0, r.stderr);
		return JSON.parse(r.stdout);
	};

	const dry = run("apply", "--dry-run");
	assert.deepEqual(dry.created, ["opencode-peer"]);
	assert.equal(JSON.parse(readFileSync(configPath, "utf8")).agents.providers["opencode-peer"], undefined, "dry-run writes nothing");

	const first = run("apply");
	assert.deepEqual(first.created, ["opencode-peer"]);
	const written = JSON.parse(readFileSync(configPath, "utf8")).agents.providers;
	assert.equal(written["opencode-peer"].extends, "opencode");
	assert.equal(written["pi-peer"].label, "mine", "other providers untouched");

	const again = run("apply");
	assert.deepEqual([again.created, again.updated, again.skipped], [[], [], []], "idempotent");

	// A hand-written provider of the same name, unknown to the ledger, is kept.
	writeFileSync(configPath, JSON.stringify({ version: 1, agents: { providers: { "opencode-peer": { extends: "opencode", label: "hand" } } } }));
	rmSync(join(home, ".paseo-team-orchestration", "runtime-providers.json"));
	const collide = run("apply");
	assert.deepEqual(collide.skipped, ["opencode-peer"]);
	assert.equal(JSON.parse(readFileSync(configPath, "utf8")).agents.providers["opencode-peer"].label, "hand");

	const list = run("list");
	const oc = list.runtimes.find((r: { family: string }) => r.family === "opencode");
	assert.equal(oc.enforcement, "static");
	assert.deepEqual(oc.providers, ["opencode-peer"]);
	assert.deepEqual(oc.configured, ["opencode-peer"]);
});

test("a brief granting commit/push is refused for a static-policy seat, on both runtimes", () => {
	const routeTable = table();
	const example = readFileSync(join(ROOT, "examples/engineer-task.md"), "utf8");
	const start = example.indexOf("\nPASEO_TEAM_TASK_V3_BEGIN") + 1;
	// MODE: read-only keeps the writer-lease gate (Claude adapter) out of the
	// way, so only the rule under test can refuse.
	const brief = example
		.slice(start, example.indexOf("```", start))
		.replace("MODE: write", "MODE: read-only")
		.replace("EDIT_AUTHORITY: allowed", "EDIT_AUTHORITY: denied");
	assert.match(brief, /COMMIT_AUTHORITY: allowed/);
	const withBrief = (text: string) => ({ ...seat("opencode-peer/opencode/beam-free", "low", "FAST_READ"), initialPrompt: text });
	for (const runtime of ["pi", "claude"] as const) {
		assert.match(String(decide(runtime, withBrief(brief), routeTable)), /RUNTIME_AUTHORITY_UNSUPPORTED.*COMMIT_AUTHORITY/, runtime);
		const denied = brief.replace("COMMIT_AUTHORITY: allowed", "COMMIT_AUTHORITY: denied");
		assert.equal(decide(runtime, withBrief(denied), routeTable), null, `${runtime}: same brief without commit is seatable`);
		// A full-enforcement Peer may carry the very same brief.
		const pi = { ...seat("pi-peer/Mx/mid", "medium", "CODING_MEDIUM"), initialPrompt: brief };
		assert.equal(decide(runtime, pi, routeTable), null, `${runtime}: pi Peer keeps brief-scoped commit`);
	}
});
