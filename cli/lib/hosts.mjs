// hosts.mjs — one view and one set of verbs for the machines a cluster runs on.
//
// Three sources describe a host today, and before this module an operator had
// to reconcile them by hand, in a shell, per machine:
//
//   1. the pack's cluster file (cluster-routing.local.json): routes,
//      capabilities, limits, endpointEnv — what the gate and the Lead read;
//   2. Paseo's own host registry on the controller daemon (`paseo host ...`,
//      Paseo >= 0.14): the connection itself (secret included — kept by the
//      daemon, never by this pack), live status, and the server id that the
//      fleet MCP tools (create_agent { serverId }) address;
//   3. the live daemons: reachable or not, agents running there.
//
// `hosts list` joins them and names every disagreement; `add` / `remove` /
// `sync` change 1 and 2 together so they cannot drift; `check` runs the pack's
// own preflight for one host. Every Paseo call goes through an injected
// `paseo(args) -> Promise<json>` so the logic is testable without a daemon.
//
// Mapping rule (one, everywhere): a registry entry belongs to cluster host H
// when its metadata "team.host-id" is H, or — for an entry added by hand —
// its label is H. `add` always writes both.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	HOST_CAPABILITIES,
	SERVER_ID_RE,
	validateClusterConfig,
} from "../../scripts/model-routing.mjs";

export const HOST_ID_META = "team.host-id";
export const HOST_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const DEFAULT_REMOTE_CAPABILITIES = Object.freeze(["git-read", "focused-test"]);

export class HostsError extends Error {
	constructor(code, message, details = {}) {
		super(message);
		this.name = "HostsError";
		this.code = code;
		this.details = details;
	}
}

/** Env var name a new host's endpoint is read from by remote-paseo.mjs. */
export function defaultEndpointEnv(hostId) {
	return `PASEO_HOST_${hostId.toUpperCase().replace(/-/g, "_")}`;
}

/** The registry entry that belongs to `hostId`, or null. */
export function registryEntryFor(registry, hostId) {
	return (
		registry.find((entry) => entry?.metadata?.[HOST_ID_META] === hostId) ??
		registry.find((entry) => entry?.label === hostId) ??
		null
	);
}

/** Server id of THIS daemon: `paseo status`, else ~/.paseo/server-id. */
export async function localServerId(paseo, paseoHome) {
	try {
		const status = await paseo(["status"]);
		if (typeof status?.serverId === "string" && SERVER_ID_RE.test(status.serverId)) return status.serverId;
	} catch {}
	try {
		const fromFile = readFileSync(join(paseoHome, "server-id"), "utf8").trim();
		if (SERVER_ID_RE.test(fromFile)) return fromFile;
	} catch {}
	return null;
}

function readCluster(path) {
	if (!existsSync(path)) return null;
	const doc = JSON.parse(readFileSync(path, "utf8"));
	validateClusterConfig(doc);
	return doc;
}

/**
 * Join cluster file + registry + (optional) live probes into one row per host.
 * Pure: every input is passed in.
 */
export function describeHosts({ cluster, registry = [], localServer = null, env = process.env, live = {} }) {
	const rows = [];
	const claimed = new Set();
	for (const [hostId, host] of Object.entries(cluster?.hosts ?? {})) {
		const local = host.connection.type === "local";
		const entry = local ? null : registryEntryFor(registry, hostId);
		if (entry) claimed.add(entry.registrationId);
		const problems = [];
		const serverId = host.connection.serverId ?? null;
		const actualServerId = local ? localServer : (entry?.serverId ?? null);
		if (!local && !entry) problems.push({ code: "NOT_IN_REGISTRY", fix: `pteam hosts add ${hostId} --connection <conn>  (the daemon keeps the connection; Lead MCP seating needs it)` });
		if (entry && entry.enabled === false) problems.push({ code: "REGISTRY_DISABLED", fix: `paseo host enable ${entry.registrationId}` });
		if (entry && entry.status && entry.status !== "online") problems.push({ code: "OFFLINE", detail: entry.error ?? entry.status });
		if (!serverId) problems.push({ code: "NO_SERVER_ID", fix: "pteam hosts sync  (until then a Lead's create_agent { serverId } to this host is refused)" });
		else if (actualServerId && actualServerId !== serverId) {
			problems.push({ code: "SERVER_ID_MISMATCH", detail: `file ${serverId}, daemon ${actualServerId}`, fix: "pteam hosts sync" });
		}
		const endpointEnv = host.connection.endpointEnv ?? null;
		const endpointSet = endpointEnv ? Boolean(String(env[endpointEnv] ?? "").trim()) : null;
		if (endpointEnv && !endpointSet) problems.push({ code: "ENDPOINT_ENV_UNSET", detail: `${endpointEnv} is not set in this shell — remote-paseo.mjs / preflight cannot reach the host (MCP seating via the registry still can)` });
		const routes = Object.entries(host.routes ?? {}).map(([modelClass, route]) => ({
			modelClass,
			paseoProvider: route.paseoProvider,
			model: route.model,
			thinking: route.thinking,
			enabled: route.enabled !== false,
			alternates: (route.alternates ?? []).length,
		}));
		rows.push({
			hostId,
			type: host.connection.type,
			required: host.required,
			capabilities: host.capabilities,
			limits: host.limits,
			roles: {
				writer: HOST_CAPABILITIES.writer.every((c) => host.capabilities.includes(c)),
				reviewer: HOST_CAPABILITIES.reviewer.every((c) => host.capabilities.includes(c)),
			},
			serverId,
			endpointEnv,
			endpointSet,
			registry: entry
				? {
						registrationId: entry.registrationId,
						label: entry.label ?? null,
						status: entry.status ?? null,
						enabled: entry.enabled !== false,
						lastOnlineAt: entry.lastOnlineAt ?? null,
						error: entry.error ?? null,
						target: entry.targetDescription ?? null,
					}
				: null,
			status: local ? (live[hostId]?.status ?? "local") : (entry?.status ?? (live[hostId]?.status ?? "unknown")),
			agents: live[hostId]?.agents ?? null,
			routes,
			problems,
		});
	}
	// Registry entries no cluster host claims: reachable by MCP, but no route
	// exists for them, so the gate refuses every seat there.
	const unmanaged = registry
		.filter((entry) => !claimed.has(entry.registrationId))
		.map((entry) => ({
			registrationId: entry.registrationId,
			serverId: entry.serverId ?? null,
			label: entry.label ?? null,
			status: entry.status ?? null,
			target: entry.targetDescription ?? null,
			fix: `pteam hosts adopt ${entry.label && HOST_ID_RE.test(entry.label) ? entry.label : "<host-id>"} --registration ${entry.registrationId}`,
		}));
	return { hosts: rows, unmanaged };
}

/** Live agent counts per host (local via plain ls; remote via its endpoint env when set). */
export async function probeLive({ cluster, paseo, env = process.env }) {
	const out = {};
	await Promise.all(
		Object.entries(cluster?.hosts ?? {}).map(async ([hostId, host]) => {
			const args = ["ls"];
			if (host.connection.type === "remote") {
				const endpoint = String(env[host.connection.endpointEnv] ?? "").trim();
				if (!endpoint) return;
				args.push("--host", endpoint);
			}
			try {
				const agents = await paseo(args);
				const list = Array.isArray(agents) ? agents : [];
				const count = (status) => list.filter((a) => a.status === status).length;
				out[hostId] = { status: "reachable", agents: { total: list.length, running: count("running"), idle: count("idle") } };
			} catch (error) {
				out[hostId] = { status: "unreachable", error: String(error?.message ?? error).slice(0, 200) };
			}
		}),
	);
	return out;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Add a remote host in ONE step: register it with the controller daemon
 * (the connection + secret stay in Paseo's store), wait for its server id, and
 * write the cluster entry (routes copied from a host already in the file, so
 * the new one is routable at once and edited afterwards).
 */
export async function planAddHost({
	cluster,
	hostId,
	connection,
	registry,
	paseo,
	localRoutes,
	options = {},
	dryRun = false,
	waitMs = 15000,
}) {
	if (!HOST_ID_RE.test(hostId)) throw new HostsError("USAGE", `host id "${hostId}" must match ${HOST_ID_RE} (lowercase letters, digits, '-')`);
	if (cluster?.hosts?.[hostId]) throw new HostsError("HOST_EXISTS", `host "${hostId}" is already in the cluster file — edit it, or remove it first`);
	if (!connection || typeof connection !== "string") throw new HostsError("USAGE", "--connection <host:port | tcp://... | pairing URL> is required");
	const copyFrom = options.copyRoutesFrom;
	const template = copyFrom ? cluster?.hosts?.[copyFrom]?.routes : localRoutes;
	if (!template) {
		throw new HostsError(
			"NO_ROUTE_TEMPLATE",
			copyFrom ? `--copy-routes-from ${copyFrom}: no such host` : "no local routes to copy (model-routing.local.json or a local host in the cluster file) — pass --copy-routes-from <host-id>",
		);
	}
	let entry = registryEntryFor(registry, hostId);
	const steps = [];
	if (!entry) {
		steps.push({ action: "paseo host add", label: hostId, meta: `${HOST_ID_META}=${hostId}` });
		if (!dryRun) entry = await paseo(["host", "add", connection, "--label", hostId, "--meta", `${HOST_ID_META}=${hostId}`]);
	} else steps.push({ action: "reuse registry entry", registrationId: entry.registrationId });

	let serverId = entry?.serverId ?? null;
	if (!dryRun && entry && !serverId) {
		const until = Date.now() + waitMs;
		while (!serverId && Date.now() < until) {
			await sleep(500);
			const listed = await paseo(["host", "ls"]);
			const fresh = (Array.isArray(listed) ? listed : []).find((x) => x.registrationId === entry.registrationId);
			serverId = fresh?.serverId ?? null;
			entry = fresh ?? entry;
			if (fresh?.status === "failed") break;
		}
	}
	const host = {
		connection: {
			type: "remote",
			endpointEnv: options.endpointEnv ?? defaultEndpointEnv(hostId),
			...(serverId ? { serverId } : {}),
		},
		required: options.required === true,
		capabilities: options.capabilities?.length ? options.capabilities : [...DEFAULT_REMOTE_CAPABILITIES],
		limits: { writers: options.writers ?? 0, readers: options.readers ?? 2 },
		routes: structuredClone(template),
	};
	const next = { version: 1, ...(cluster ?? {}), hosts: { ...(cluster?.hosts ?? {}), [hostId]: host } };
	validateClusterConfig(next);
	steps.push({ action: "cluster file", hostId, serverId: serverId ?? "(pending: run pteam hosts sync once it is online)" });
	return { next, host, steps, registry: entry ?? null, online: entry?.status === "online" };
}

/** Fill / correct connection.serverId for every host from the registry and this daemon. */
export function planSync({ cluster, registry, localServer }) {
	const next = structuredClone(cluster);
	const changes = [];
	for (const [hostId, host] of Object.entries(next.hosts)) {
		const local = host.connection.type === "local";
		const actual = local ? localServer : (registryEntryFor(registry, hostId)?.serverId ?? null);
		if (!actual || host.connection.serverId === actual) continue;
		changes.push({ hostId, from: host.connection.serverId ?? null, to: actual });
		host.connection.serverId = actual;
	}
	validateClusterConfig(next);
	return { next, changes };
}

/** Remove a host from the cluster file (never the local one) and, unless kept, from the registry. */
export function planRemove({ cluster, registry, hostId, keepRegistry = false }) {
	const host = cluster?.hosts?.[hostId];
	if (!host) throw new HostsError("HOST_NOT_FOUND", `no host "${hostId}" in the cluster file`);
	if (host.connection.type === "local") throw new HostsError("LOCAL_HOST", `"${hostId}" is this controller's own daemon — it cannot be removed from its own cluster`);
	const next = structuredClone(cluster);
	delete next.hosts[hostId];
	validateClusterConfig(next);
	const entry = keepRegistry ? null : registryEntryFor(registry, hostId);
	return { next, registrationId: entry?.registrationId ?? null };
}

/** Adopt a registry entry added by hand (no team.host-id) as cluster host `hostId`. */
export function planAdopt({ cluster, registry, hostId, registrationId, localRoutes, copyRoutesFrom }) {
	const entry = registry.find((x) => x.registrationId === registrationId);
	if (!entry) throw new HostsError("REGISTRATION_NOT_FOUND", `no registry entry ${registrationId} (paseo host ls)`);
	if (cluster?.hosts?.[hostId]) throw new HostsError("HOST_EXISTS", `host "${hostId}" is already in the cluster file`);
	const template = copyRoutesFrom ? cluster?.hosts?.[copyRoutesFrom]?.routes : localRoutes;
	if (!template) throw new HostsError("NO_ROUTE_TEMPLATE", "no routes to copy — pass --copy-routes-from <host-id>");
	const next = {
		version: 1,
		...(cluster ?? {}),
		hosts: {
			...(cluster?.hosts ?? {}),
			[hostId]: {
				connection: { type: "remote", endpointEnv: defaultEndpointEnv(hostId), ...(entry.serverId ? { serverId: entry.serverId } : {}) },
				required: false,
				capabilities: [...DEFAULT_REMOTE_CAPABILITIES],
				limits: { writers: 0, readers: 2 },
				routes: structuredClone(template),
			},
		},
	};
	validateClusterConfig(next);
	return { next, metaUpdate: entry.metadata?.[HOST_ID_META] === hostId ? null : entry.registrationId };
}

export { readCluster };
