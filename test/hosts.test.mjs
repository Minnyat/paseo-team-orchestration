// hosts.test.mjs — cli/lib/hosts.mjs: joining cluster file + Paseo registry,
// and the add / sync / remove / adopt plans, with a scripted `paseo`.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
	HOST_ID_META,
	HostsError,
	defaultEndpointEnv,
	describeHosts,
	planAddHost,
	planAdopt,
	planRemove,
	planSync,
	registryEntryFor,
} from "../cli/lib/hosts.mjs";

const ROUTES = {
	MONITOR_ECONOMY: { paseoProvider: "pi-supervisor", model: "Mx/cheap", thinking: "low" },
	FAST_READ: { paseoProvider: "pi-peer", model: "Mx/cheap", thinking: "low" },
	CODING_MEDIUM: { paseoProvider: "pi-peer", model: "Mx/mid", thinking: "medium" },
	REASONING_HIGH: { paseoProvider: "claude-peer", model: "claude-opus-5", thinking: "high" },
	REVIEW_HIGH: { paseoProvider: "claude-peer", model: "claude-opus-5", thinking: "xhigh" },
};
const cluster = () => ({
	version: 1,
	hosts: {
		ctl: { connection: { type: "local", serverId: "srv_CTL00001" }, required: true, capabilities: ["git-read", "git-write", "focused-test"], limits: { writers: 1, readers: 3 }, routes: ROUTES },
		mac: { connection: { type: "remote", endpointEnv: "PASEO_MAC" }, required: false, capabilities: ["git-read", "independent-review"], limits: { writers: 0, readers: 2 }, routes: ROUTES },
	},
});
const REG = [
	{ registrationId: "hst_mac", serverId: "srv_MAC00001", label: "mac", metadata: { [HOST_ID_META]: "mac" }, enabled: true, status: "online", targetDescription: "tcp://10.0.0.2:6767" },
	{ registrationId: "hst_stray", serverId: "srv_STRAY001", label: "build-box", metadata: {}, enabled: true, status: "online" },
];

test("registry entries map by team.host-id first, then label", () => {
	assert.equal(registryEntryFor(REG, "mac").registrationId, "hst_mac");
	assert.equal(registryEntryFor(REG, "build-box").registrationId, "hst_stray");
	assert.equal(registryEntryFor(REG, "nope"), null);
	assert.equal(defaultEndpointEnv("lab-d"), "PASEO_HOST_LAB_D");
});

test("describeHosts names every disagreement, and the unmanaged registry entries", () => {
	const { hosts, unmanaged } = describeHosts({ cluster: cluster(), registry: REG, localServer: "srv_CTL00001", env: {} });
	const mac = hosts.find((h) => h.hostId === "mac");
	assert.deepEqual(mac.problems.map((p) => p.code).sort(), ["ENDPOINT_ENV_UNSET", "NO_SERVER_ID"]);
	assert.equal(mac.status, "online");
	assert.equal(mac.roles.reviewer, true);
	assert.equal(mac.roles.writer, false);
	const ctl = hosts.find((h) => h.hostId === "ctl");
	assert.deepEqual(ctl.problems, []);
	assert.equal(ctl.roles.writer, true);
	assert.deepEqual(unmanaged.map((u) => u.registrationId), ["hst_stray"]);
	assert.match(unmanaged[0].fix, /pteam hosts adopt build-box --registration hst_stray/);

	const c = cluster();
	c.hosts.mac.connection.serverId = "srv_OLD00001";
	const offline = REG.map((r) => (r.registrationId === "hst_mac" ? { ...r, status: "failed", error: "ECONNREFUSED" } : r));
	const again = describeHosts({ cluster: c, registry: offline, localServer: "srv_CTL00001", env: { PASEO_MAC: "x" } }).hosts.find((h) => h.hostId === "mac");
	assert.deepEqual(again.problems.map((p) => p.code).sort(), ["OFFLINE", "SERVER_ID_MISMATCH"]);
	const missing = describeHosts({ cluster: cluster(), registry: [], env: { PASEO_MAC: "x" } }).hosts.find((h) => h.hostId === "mac");
	assert.ok(missing.problems.some((p) => p.code === "NOT_IN_REGISTRY"));
});

test("planAddHost registers, waits for the server id, and writes a valid routable host", async () => {
	const calls = [];
	let polls = 0;
	const paseo = async (args) => {
		calls.push(args);
		if (args[1] === "add") return { registrationId: "hst_new", serverId: null, status: "connecting" };
		if (args[1] === "ls") return [{ registrationId: "hst_new", serverId: (polls += 1) >= 2 ? "srv_NEW00001" : null, status: polls >= 2 ? "online" : "connecting" }];
		throw new Error(`unexpected ${args.join(" ")}`);
	};
	const plan = await planAddHost({
		cluster: cluster(),
		hostId: "lab-d",
		connection: "tcp://10.0.0.9:6767?password=pw",
		registry: REG,
		paseo,
		localRoutes: ROUTES,
		options: { capabilities: ["git-read", "independent-review"], readers: 3 },
	});
	assert.deepEqual(calls[0], ["host", "add", "tcp://10.0.0.9:6767?password=pw", "--label", "lab-d", "--meta", `${HOST_ID_META}=lab-d`]);
	assert.equal(plan.host.connection.serverId, "srv_NEW00001");
	assert.equal(plan.host.connection.endpointEnv, "PASEO_HOST_LAB_D");
	assert.deepEqual(plan.host.limits, { writers: 0, readers: 3 });
	assert.deepEqual(plan.host.routes, ROUTES);
	assert.ok(!JSON.stringify(plan.next).includes("password"), "the connection secret never reaches the cluster file");
	assert.equal(plan.online, true);

	await assert.rejects(planAddHost({ cluster: cluster(), hostId: "mac", connection: "x", registry: REG, paseo, localRoutes: ROUTES }), (e) => e instanceof HostsError && e.code === "HOST_EXISTS");
	await assert.rejects(planAddHost({ cluster: cluster(), hostId: "Bad_Id", connection: "x", registry: REG, paseo, localRoutes: ROUTES }), /must match/);
	await assert.rejects(planAddHost({ cluster: cluster(), hostId: "x1", connection: "x", registry: [], paseo, localRoutes: null }), (e) => e.code === "NO_ROUTE_TEMPLATE");
	const dry = await planAddHost({ cluster: cluster(), hostId: "x2", connection: "c", registry: [], paseo: async () => assert.fail("dry-run must not call paseo"), localRoutes: ROUTES, dryRun: true });
	assert.equal(dry.host.connection.serverId, undefined);
});

test("planSync fills server ids from the registry and this daemon; planRemove never removes the local host", () => {
	const { next, changes } = planSync({ cluster: cluster(), registry: REG, localServer: "srv_CTL00001" });
	assert.deepEqual(changes, [{ hostId: "mac", from: null, to: "srv_MAC00001" }]);
	assert.equal(next.hosts.mac.connection.serverId, "srv_MAC00001");
	assert.deepEqual(planSync({ cluster: next, registry: REG, localServer: "srv_CTL00001" }).changes, [], "idempotent");

	const removed = planRemove({ cluster: cluster(), registry: REG, hostId: "mac" });
	assert.equal(removed.registrationId, "hst_mac");
	assert.equal(removed.next.hosts.mac, undefined);
	assert.equal(planRemove({ cluster: cluster(), registry: REG, hostId: "mac", keepRegistry: true }).registrationId, null);
	assert.throws(() => planRemove({ cluster: cluster(), registry: REG, hostId: "ctl" }), (e) => e.code === "LOCAL_HOST");
	assert.throws(() => planRemove({ cluster: cluster(), registry: REG, hostId: "ghost" }), (e) => e.code === "HOST_NOT_FOUND");
});

test("planAdopt turns a hand-added registry entry into a cluster host and tags it", () => {
	const plan = planAdopt({ cluster: cluster(), registry: REG, hostId: "build-box", registrationId: "hst_stray", localRoutes: ROUTES });
	assert.equal(plan.next.hosts["build-box"].connection.serverId, "srv_STRAY001");
	assert.equal(plan.metaUpdate, "hst_stray");
	assert.throws(() => planAdopt({ cluster: cluster(), registry: REG, hostId: "y", registrationId: "hst_none", localRoutes: ROUTES }), (e) => e.code === "REGISTRATION_NOT_FOUND");
});
