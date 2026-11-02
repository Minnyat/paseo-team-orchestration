// server-route-gate.test.mts — Paseo 0.14 MCP create_agent takes `serverId`
// and seats on THAT connected host. The route gate must hold such a call to
// that host's routes (cluster connection.serverId), and refuse a serverId it
// cannot map instead of comparing against the local routes. Both adapters.

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { mcpBlockReason, type RouteTable } from "../extensions/paseo-team-core/policy-core.ts";
import { claudeToolBlockReason } from "../extensions/paseo-team-core/claude-policy.ts";
// @ts-ignore — plain .mjs module
import { gateRouteTable, loadClusterConfig } from "../scripts/model-routing.mjs";
// @ts-ignore — plain .mjs module
import { gateTable } from "../scripts/gate-table.mjs";

const sandbox = mkdtempSync(join(tmpdir(), "pteam-server-gate-"));
after(() => rmSync(sandbox, { recursive: true, force: true }));

const BASE = {
	MONITOR_ECONOMY: { paseoProvider: "pi-supervisor", model: "Mx/cheap", thinking: "low" },
	FAST_READ: { paseoProvider: "pi-peer", model: "Mx/cheap", thinking: "low" },
	CODING_MEDIUM: { paseoProvider: "pi-peer", model: "Mx/mid", thinking: "medium" },
	REASONING_HIGH: { paseoProvider: "claude-peer", model: "claude-opus-5", thinking: "high" },
	REVIEW_HIGH: { paseoProvider: "claude-peer", model: "claude-opus-5", thinking: "xhigh" },
};
const cluster = (macServerId: string | undefined = "srv_MACmac01") => ({
	version: 1,
	hosts: {
		ctl: {
			connection: { type: "local", serverId: "srv_CTLctl01" },
			required: true,
			capabilities: ["git-read", "git-write"],
			routes: BASE,
		},
		mac: {
			connection: { type: "remote", endpointEnv: "PASEO_MAC", ...(macServerId ? { serverId: macServerId } : {}) },
			required: false,
			capabilities: ["git-read", "independent-review"],
			routes: { ...BASE, FAST_READ: { paseoProvider: "pi-peer", model: "Remote/only-on-mac", thinking: "low" } },
			disabledModels: ["claude/claude-opus-5"],
		},
	},
});

let n = 0;
function tableFrom(files: { cluster?: unknown; routing?: unknown }, loader = gateRouteTable): RouteTable {
	const dir = join(sandbox, `d${(n += 1)}`);
	mkdirSync(dir, { recursive: true });
	if (files.cluster) writeFileSync(join(dir, "cluster-routing.local.json"), JSON.stringify(files.cluster));
	if (files.routing) writeFileSync(join(dir, "model-routing.local.json"), JSON.stringify(files.routing));
	return loader({ env: { PST_TEAM_CONFIG_DIR: dir } }) as RouteTable;
}

const seat = (provider: string, thinking: string, cls: string, serverId?: string, workspaceId: string | null = "wks_remote") => ({
	title: "t",
	initialPrompt: "brief",
	provider,
	...(serverId === undefined ? {} : { serverId }),
	// A remote seat names the workspace already open on THAT host.
	...(serverId !== undefined && serverId !== "srv_CTLctl01" && workspaceId !== null ? { workspaceId } : {}),
	settings: { thinkingOptionId: thinking, ...(provider.startsWith("claude-") ? { modeId: "auto" } : {}) },
	labels: { "team.model-class": cls },
});
function decide(runtime: "pi" | "claude", args: unknown, routeTable: RouteTable): string | null {
	if (runtime === "pi") return mcpBlockReason("lead", { tool: "create_agent", args }, { routeTable, env: {} });
	return claudeToolBlockReason({ role: "lead", toolName: "mcp__paseo__create_agent", toolInput: args, brief: null, routeTable, env: {} });
}

test("cluster validation: serverId shape and one daemon per host", () => {
	const dir = join(sandbox, "v");
	mkdirSync(dir, { recursive: true });
	const write = (doc: unknown) => {
		writeFileSync(join(dir, "c.json"), JSON.stringify(doc));
		return () => loadClusterConfig(join(dir, "c.json"));
	};
	assert.doesNotThrow(write(cluster()));
	const bad = cluster();
	(bad.hosts.mac.connection as Record<string, unknown>).serverId = "not-a-server";
	assert.throws(write(bad), /srv_/);
	assert.throws(write(cluster("srv_CTLctl01")), /one daemon is one host/);
});

test("gate table exposes every mapped host's own routes (with its model switches)", () => {
	const t = tableFrom({ cluster: cluster() });
	assert.ok(t.ok);
	if (!t.ok) return;
	assert.deepEqual(Object.keys(t.serverHosts ?? {}).sort(), ["srv_CTLctl01", "srv_MACmac01"]);
	assert.equal(t.serverHosts?.srv_MACmac01.hostId, "mac");
	assert.equal(t.serverHosts?.srv_MACmac01.routes.FAST_READ?.model, "Remote/only-on-mac");
	assert.equal((t.serverHosts?.srv_MACmac01.routes.REVIEW_HIGH as { modelDisabled?: boolean }).modelDisabled, true);
	assert.equal(t.routes.FAST_READ?.model, "Mx/cheap", "the local table is unchanged");
	const withJobs = tableFrom({ cluster: cluster() }, gateTable);
	assert.ok(withJobs.ok && withJobs.serverHosts?.srv_MACmac01, "gate-table keeps serverHosts");
});

for (const runtime of ["pi", "claude"] as const) {
	test(`${runtime}: a serverId seat is held to THAT host's routes`, () => {
		const t = tableFrom({ cluster: cluster() });
		// The remote-only model is fine on mac, refused locally.
		assert.equal(decide(runtime, seat("pi-peer/Remote/only-on-mac", "low", "FAST_READ", "srv_MACmac01"), t), null);
		assert.match(String(decide(runtime, seat("pi-peer/Remote/only-on-mac", "low", "FAST_READ"), t)), /ROUTE_MODEL_MISMATCH/);
		// The gap this closes: the LOCAL route's model, sent to mac, used to pass.
		assert.match(String(decide(runtime, seat("pi-peer/Mx/cheap", "low", "FAST_READ", "srv_MACmac01"), t)), /ROUTE_MODEL_MISMATCH.*mac|mac.*ROUTE_MODEL_MISMATCH|ROUTE_MODEL_MISMATCH/);
		// mac switched claude-opus-5 off; the controller did not.
		assert.match(String(decide(runtime, seat("claude-peer/claude-opus-5", "xhigh", "REVIEW_HIGH", "srv_MACmac01"), t)), /ROUTE_MODEL_DISABLED/);
		assert.equal(decide(runtime, seat("claude-peer/claude-opus-5", "xhigh", "REVIEW_HIGH"), t), null);
		// The controller's own server id is the local table.
		assert.equal(decide(runtime, seat("pi-peer/Mx/cheap", "low", "FAST_READ", "srv_CTLctl01"), t), null);
	});

	test(`${runtime}: a remote seat needs that host's workspaceId; a local serverId keeps the one-workspace rule`, () => {
		const t = tableFrom({ cluster: cluster() });
		assert.match(
			String(decide(runtime, seat("pi-peer/Remote/only-on-mac", "low", "FAST_READ", "srv_MACmac01", null), t)),
			/needs "workspaceId".*ON THAT HOST/,
		);
		// Local serverId + a foreign workspaceId: still refused (own workspace unprovable/different).
		const local = { ...seat("pi-peer/Mx/cheap", "low", "FAST_READ", "srv_CTLctl01"), workspaceId: "wks_other" };
		assert.match(String(decide(runtime, local, t)), /workspaceId/);
	});

	test(`${runtime}: an unmapped serverId is refused, never checked against local routes`, () => {
		const t = tableFrom({ cluster: cluster(undefined) });
		const r = decide(runtime, seat("pi-peer/Mx/cheap", "low", "FAST_READ", "srv_UNKNOWN1"), t);
		assert.match(String(r), /ROUTE_HOST_UNKNOWN/);
		assert.match(String(r), /pteam hosts sync/);
		const single = tableFrom({ routing: { version: 1, hostId: "solo", routes: BASE } });
		assert.match(String(decide(runtime, seat("pi-peer/Mx/cheap", "low", "FAST_READ", "srv_ANY0001"), single)), /ROUTE_HOST_UNKNOWN/);
		assert.match(String(decide(runtime, seat("pi-peer/Mx/cheap", "low", "FAST_READ", ""), t)), /ROUTE_HOST_UNKNOWN/);
	});
}
