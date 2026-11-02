// dispatch.test.mjs — cli/lib/dispatch.mjs: the routing cycle as one call,
// against scripted probes (no daemon).
import assert from "node:assert/strict";
import { test } from "node:test";

import { collectFlow, planDispatch } from "../cli/lib/dispatch.mjs";

const ROUTES = {
	MONITOR_ECONOMY: { paseoProvider: "pi-supervisor", model: "Mx/cheap", thinking: "low" },
	FAST_READ: { paseoProvider: "pi-peer", model: "Mx/cheap", thinking: "low" },
	CODING_MEDIUM: { paseoProvider: "pi-peer", model: "Mx/mid", thinking: "medium" },
	REASONING_HIGH: { paseoProvider: "claude-peer", model: "claude-opus-5", thinking: "high" },
	REVIEW_HIGH: { paseoProvider: "claude-peer", model: "claude-opus-5", thinking: "high" },
};
const cluster = () => ({
	version: 1,
	hosts: {
		ctl: { connection: { type: "local", serverId: "srv_CTL00001" }, required: true, capabilities: ["git-read", "git-write", "focused-test"], limits: { writers: 1, readers: 3 }, routes: ROUTES },
		mac: { connection: { type: "remote", endpointEnv: "PASEO_MAC", serverId: "srv_MAC00001" }, required: false, capabilities: ["git-read", "independent-review"], limits: { writers: 0, readers: 2 }, routes: ROUTES },
		win: { connection: { type: "remote", endpointEnv: "PASEO_WIN", serverId: "srv_WIN00001" }, required: false, capabilities: ["git-read", "independent-review"], limits: { writers: 0, readers: 2 }, routes: ROUTES },
	},
});
const PROVIDERS = [
	{ provider: "pi-peer", enabled: "Enabled", status: "available" },
	{ provider: "pi-supervisor", enabled: "Enabled", status: "available" },
	{ provider: "claude-peer", enabled: "Enabled", status: "available" },
];
const MODELS = {
	"pi-peer": [{ id: "Mx/mid", thinkingOptionIds: ["low", "medium", "high"] }, { id: "Mx/cheap", thinkingOptionIds: ["low"] }],
	"claude-peer": [{ id: "claude-opus-5", thinkingOptionIds: ["low", "high", "max"] }],
};
const ok = (extra = {}) => ({ reachable: true, observable: true, providers: PROVIDERS, models: MODELS, running: 0, workspaces: [{ workspaceId: "wks_demo", cwd: "/r/projects/demo", project: "demo" }], ...extra });
const probeWith = (byHost) => async (hostId) => byHost[hostId] ?? ok();

test("a writer goes where git-write is: the local host, by plain MCP, no placement", async () => {
	const plan = await planDispatch({ cluster: cluster(), modelClass: "CODING_MEDIUM", probe: probeWith({}) });
	assert.equal(plan.kind, "writer");
	assert.equal(plan.chosen.hostId, "ctl");
	assert.equal(plan.chosen.mechanism, "mcp");
	assert.equal(plan.chosen.createAgent.provider, "pi-peer/Mx/mid");
	assert.equal(plan.chosen.createAgent.workspaceId, undefined);
	assert.equal(plan.chosen.createAgent.settings.modeId, undefined, "pi seats carry no mode");
	assert.equal(plan.candidates.find((c) => c.hostId === "mac").steps[0].ok, false, "mac lacks git-write");
	assert.match(plan.chosen.routingDecision, /HOST_ID: ctl[\s\S]*MECHANISM: mcp/);
});

test("an independent reviewer avoids the writer's host, prefers the freer remote, and gets serverId + that host's workspace", async () => {
	const plan = await planDispatch({
		cluster: cluster(),
		modelClass: "REVIEW_HIGH",
		avoidHost: "ctl",
		project: "demo",
		teamCluster: "shop",
		probe: probeWith({ win: ok({ running: 1 }) }),
	});
	assert.equal(plan.chosen.hostId, "mac", "mac has 2 free, win 1");
	assert.equal(plan.chosen.mechanism, "mcp-serverId");
	assert.equal(plan.chosen.createAgent.serverId, "srv_MAC00001");
	assert.equal(plan.chosen.createAgent.workspaceId, "wks_demo");
	assert.equal(plan.chosen.createAgent.settings.modeId, "auto", "claude seats need a mode");
	assert.equal(plan.chosen.createAgent.labels["team.cluster"], "shop");
	assert.deepEqual(plan.ranking.map((r) => r.hostId), ["mac", "win"]);
});

test("every failing step is named, nothing falls back", async () => {
	const plan = await planDispatch({
		cluster: cluster(),
		modelClass: "REVIEW_HIGH",
		avoidHost: "ctl",
		probe: probeWith({
			mac: { reachable: false, observable: true, error: "DAEMON_UNREACHABLE: ECONNREFUSED" },
			win: ok({ models: { "claude-peer": [{ id: "claude-sonnet-5", thinkingOptionIds: ["high"] }] } }),
		}),
	});
	assert.equal(plan.chosen, null);
	assert.match(plan.blocked, /HOST_ROUTE_UNAVAILABLE/);
	const mac = plan.candidates.find((c) => c.hostId === "mac");
	assert.deepEqual(mac.steps.at(-1), { step: "reachable", ok: false, detail: "DAEMON_UNREACHABLE: ECONNREFUSED" });
	const win = plan.candidates.find((c) => c.hostId === "win");
	assert.match(win.steps.find((s) => s.step.startsWith("inventory#")).detail, /MODEL_UNAVAILABLE/);
	assert.equal(plan.candidates.find((c) => c.hostId === "ctl").steps.at(-1).step, "capability");
});

test("capacity: a host at its reader limit is skipped; limits.writers 0 never takes a writer", async () => {
	const full = await planDispatch({ cluster: cluster(), modelClass: "FAST_READ", avoidHost: "ctl", probe: probeWith({ mac: ok({ running: 2 }), win: ok({ running: 2 }) }) });
	assert.equal(full.chosen, null);
	assert.match(full.candidates.find((c) => c.hostId === "mac").steps.at(-1).detail, /2 running \/ limit 2/);
	const c = cluster();
	c.hosts.mac.capabilities.push("git-write", "focused-test");
	const writer = await planDispatch({ cluster: c, modelClass: "CODING_MEDIUM", probe: probeWith({ ctl: ok({ running: 1 }) }) });
	assert.equal(writer.chosen, null, "ctl is at 1/1 writers and mac allows 0");
	assert.match(writer.candidates.find((x) => x.hostId === "mac").steps.at(-1).detail, /writers is 0/);
});

test("a host known only from the registry is seatable UNVERIFIED, never under --strict; switched-off options are skipped", async () => {
	const registryOnly = { reachable: true, observable: false, running: null };
	const plan = await planDispatch({ cluster: cluster(), modelClass: "REVIEW_HIGH", avoidHost: "ctl", probe: probeWith({ mac: registryOnly, win: registryOnly }) });
	assert.equal(plan.chosen.hostId, "mac");
	assert.match(plan.chosen.routingDecision, /inventory not checked/);
	const strict = await planDispatch({ cluster: cluster(), modelClass: "REVIEW_HIGH", avoidHost: "ctl", strict: true, probe: probeWith({ mac: registryOnly, win: registryOnly }) });
	assert.equal(strict.chosen, null);

	const c = cluster();
	c.hosts.mac.routes = { ...ROUTES, REVIEW_HIGH: { ...ROUTES.REVIEW_HIGH, enabled: false, alternates: [{ paseoProvider: "pi-peer", model: "Mx/mid", thinking: "high" }] } };
	c.hosts.win.disabledModels = ["claude/claude-opus-5"];
	const alt = await planDispatch({ cluster: c, modelClass: "REVIEW_HIGH", avoidHost: "ctl", probe: probeWith({}) });
	assert.equal(alt.chosen.hostId, "mac");
	assert.equal(alt.chosen.option, 1, "the enabled alternate");
	assert.match(alt.candidates.find((x) => x.hostId === "win").steps.at(-1).detail, /switched off/);
});

test("duplicate workspaces on one path are named, not picked", async () => {
	const dup = ok({ workspaces: [{ workspaceId: "wks_1", cwd: "/r/demo", project: "demo" }, { workspaceId: "wks_2", cwd: "/r/demo/", project: "demo" }] });
	const plan = await planDispatch({ cluster: cluster(), modelClass: "REVIEW_HIGH", avoidHost: "ctl", project: "demo", probe: probeWith({ mac: dup, win: { reachable: false, observable: true } }) });
	assert.match(plan.chosen.createAgent.workspaceId, /list_workspaces/);
	assert.match(plan.chosen.workspaceNote, /WORKSPACE_DUPLICATES/);
});

test("collectFlow groups seats by class and job across hosts, and marks unobservable hosts", async () => {
	const agents = { ctl: [{ id: "a1", name: "eng", status: "running", provider: "pi-peer/Mx/mid" }], mac: [{ id: "b1", name: "rev", status: "idle", provider: "claude-peer/claude-opus-5" }] };
	const labelled = { "ctl team.model-class=CODING_MEDIUM": ["a1"], "mac team.model-class=REVIEW_HIGH": ["b1"], "ctl team.job=code-review": ["a1"], "mac team.job=code-review": ["b1"] };
	const paseoFor = (hostId) =>
		hostId === "win"
			? null
			: async (args) => {
					const label = args[args.indexOf("--label") + 1];
					if (!args.includes("--label")) return agents[hostId];
					return (labelled[`${hostId} ${label}`] ?? []).map((id) => agents[hostId].find((a) => a.id === id));
				};
	const flow = await collectFlow({ cluster: cluster(), jobs: [{ id: "code-review", label: "Review", run: "parallel", executors: [] }], paseoFor });
	assert.deepEqual(flow.hosts.map((h) => [h.hostId, h.observable]), [["ctl", true], ["mac", true], ["win", false]]);
	assert.deepEqual(flow.classes.CODING_MEDIUM.byHost, { ctl: 1 });
	assert.equal(flow.classes.REVIEW_HIGH.idle, 1);
	assert.deepEqual(flow.jobs["code-review"].seated.map((s) => `${s.hostId}/${s.id}`).sort(), ["ctl/a1", "mac/b1"]);
});
