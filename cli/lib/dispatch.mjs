// dispatch.mjs — WHERE a task should run, and what is running where.
//
// planDispatch() is the Lead skill's routing cycle (filter hard constraints →
// reachable → route valid on THAT host's inventory → concurrency → choose +
// record evidence) done once, deterministically, from the same files and the
// same validator (`resolveRoute`) the gate and preflight use. It is read-only:
// it seats nothing, it prints the exact create_agent arguments for the host it
// picked (local: plain MCP; remote: MCP with serverId + that host's workspace;
// or the remote-paseo.mjs command) and a ROUTING_DECISION with the evidence
// filled in. Nothing here falls back: a host that fails a step is listed with
// the step and the reason, and if none qualifies the answer says so.
//
// collectFlow() is the observability half: per host, the seats of every model
// class and job (Paseo's own `ls --label` filters), so one view shows how a
// task was split and where each part stands.

import {
	ALL_MODEL_CLASSES,
	HOST_CAPABILITIES,
	RoutingError,
	buildProviderInventory,
	isModelDisabled,
	providerFamily,
	resolveRoute,
	routeOptions,
	runtimeDescriptor,
} from "../../scripts/model-routing.mjs";

export const TASK_KINDS = Object.freeze(["writer", "reviewer", "reader"]);
/** Default kind per class — what a class is FOR, overridable with --kind. */
export const DEFAULT_KIND = Object.freeze({
	CODING_MEDIUM: "writer",
	REASONING_HIGH: "writer",
	REVIEW_HIGH: "reviewer",
	FAST_READ: "reader",
	MONITOR_ECONOMY: "reader",
	SUPERVISOR_GOVERNANCE: "reader",
	LEAD_RECOVERY: "reader",
});

export class DispatchError extends Error {
	constructor(code, message, details = {}) {
		super(message);
		this.name = "DispatchError";
		this.code = code;
		this.details = details;
	}
}

/** Hosts as the planner sees them: the cluster file, or this host alone. */
export function hostsForPlanning({ cluster, routeTable }) {
	if (cluster?.hosts) return cluster.hosts;
	if (routeTable?.ok) {
		return {
			[routeTable.hostId]: {
				connection: { type: "local" },
				required: true,
				// A single-host setup declares no capabilities or limits: it is the
				// only place anything can run, so nothing is filtered on them.
				capabilities: [...new Set([...HOST_CAPABILITIES.writer, ...HOST_CAPABILITIES.reviewer])],
				limits: null,
				routes: routeTable.routes,
				disabledModels: routeTable.disabledModels ?? [],
			},
		};
	}
	return {};
}

function capacityFor(kind, limits) {
	if (!limits) return Infinity;
	return kind === "writer" ? limits.writers : limits.readers;
}

/**
 * Plan one seat. `probe(hostId, host)` returns what could be learned live:
 *   { reachable: bool, error?, providers?: [], models?: { [provider]: [] } | null,
 *     running?: number, workspaces?: [] | null, observable: bool }
 * It is injected so the planner is pure and testable.
 */
export async function planDispatch({
	cluster,
	routeTable,
	modelClass,
	kind,
	avoidHost = null,
	allowSameHost = false,
	project = null,
	teamCluster = null,
	strict = false,
	probe,
}) {
	if (!ALL_MODEL_CLASSES.includes(modelClass)) {
		throw new DispatchError("USAGE", `--class must be one of ${ALL_MODEL_CLASSES.join(", ")} (got "${modelClass}")`);
	}
	const taskKind = kind ?? DEFAULT_KIND[modelClass] ?? "reader";
	if (!TASK_KINDS.includes(taskKind)) throw new DispatchError("USAGE", `--kind must be one of ${TASK_KINDS.join(", ")}`);
	const hosts = hostsForPlanning({ cluster, routeTable });
	if (Object.keys(hosts).length === 0) {
		throw new DispatchError("NO_HOSTS", "no route file: neither cluster-routing.local.json nor model-routing.local.json loads (pteam routing check)");
	}

	const candidates = await Promise.all(
		Object.entries(hosts).map(async ([hostId, host]) => {
			const steps = [];
			const add = (step, ok, detail) => steps.push({ step, ok, detail });
			const out = { hostId, type: host.connection.type, serverId: host.connection.serverId ?? null, steps, eligible: false };

			// 1. hard constraints
			const needed = taskKind === "reader" ? [] : HOST_CAPABILITIES[taskKind];
			const missing = needed.filter((c) => !host.capabilities.includes(c));
			add("capability", missing.length === 0, missing.length ? `missing ${missing.join(", ")} for a ${taskKind}` : `${taskKind}: ${needed.join(", ") || "no requirement"}`);
			if (missing.length) return out;
			if (avoidHost && hostId === avoidHost && !allowSameHost) {
				add("independence", false, `this is the writer's host (${avoidHost}); an independent ${taskKind} runs elsewhere (--allow-same-host to override)`);
				return out;
			}
			const capacity = capacityFor(taskKind, host.limits);
			if (capacity === 0) {
				add("capacity", false, `limits.${taskKind === "writer" ? "writers" : "readers"} is 0 on this host`);
				return out;
			}

			// 2. a usable option of the class on THIS host's routes
			const options = routeOptions(host.routes?.[modelClass]).filter(
				(o) => o.enabled && !isModelDisabled(host.disabledModels ?? [], o.paseoProvider, o.model),
			);
			if (options.length === 0) {
				add("route", false, host.routes?.[modelClass] ? `${modelClass} is switched off or on a switched-off model here` : `no ${modelClass} route on this host`);
				return out;
			}
			add("route", true, options.map((o) => `${o.paseoProvider}/${o.model}@${o.thinking}`).join(" | "));

			// 3. reachable
			const live = await probe(hostId, host);
			if (!live.reachable) {
				add("reachable", false, live.error ?? "daemon not reachable");
				return out;
			}
			add("reachable", true, live.observable ? "daemon answered" : "registry says online (no endpoint env here: inventory not checked from the CLI)");

			// 4. route valid against THAT daemon's inventory — the gate's validator
			let chosen = null;
			if (live.observable) {
				for (const option of options) {
					try {
						const resolved = resolveRoute(
							{ hostId, routes: host.routes },
							modelClass,
							{ providers: buildProviderInventory(live.providers ?? []), models: live.models?.[option.paseoProvider] ?? [] },
							{ strict, option: option.index },
						);
						chosen = { ...option, resolved };
						break;
					} catch (error) {
						if (!(error instanceof RoutingError)) throw error;
						add(`inventory#${option.index}`, false, `${error.code}: ${error.message.replace(/^[A-Z_]+: /, "")}`);
					}
				}
				if (!chosen) return out;
				add("inventory", true, `${chosen.resolved.createAgentProvider} thinking=${chosen.thinking} (${chosen.resolved.thinkingValidated})`);
			} else {
				if (strict) {
					add("inventory", false, "unverifiable from here (strict): set this host's endpoint env, or run the check where it is set");
					return out;
				}
				chosen = { ...options[0], resolved: null };
				add("inventory", true, "UNVERIFIED — the gate still checks the route; the daemon refuses an unknown model");
			}

			// 5. concurrency
			const busy = live.running ?? null;
			const free = capacity === Infinity ? Infinity : busy === null ? capacity : capacity - busy;
			add("capacity", free > 0, `${busy ?? "?"} running / limit ${capacity === Infinity ? "none" : capacity}`);
			if (!(free > 0)) return out;

			out.eligible = true;
			out.option = chosen;
			out.free = free;
			out.busy = busy;
			out.workspaces = live.workspaces ?? null;
			return out;
		}),
	);

	const eligible = candidates.filter((c) => c.eligible);
	// Most free capacity first; a writer prefers this host (its files are here),
	// a reviewer prefers another (independence), then host id for a stable answer.
	const pref = (c) => (taskKind === "writer" ? (c.type === "local" ? 0 : 1) : c.type === "local" ? 1 : 0);
	eligible.sort((a, b) => (b.free === a.free ? 0 : b.free > a.free ? 1 : -1) || pref(a) - pref(b) || a.hostId.localeCompare(b.hostId));
	const pick = eligible[0] ?? null;
	return {
		modelClass,
		kind: taskKind,
		chosen: pick ? seatFor(pick, { modelClass, project, teamCluster }) : null,
		ranking: eligible.map((c) => ({ hostId: c.hostId, free: c.free === Infinity ? "unlimited" : c.free, busy: c.busy })),
		candidates: candidates.map(({ option: _o, workspaces: _w, ...rest }) => rest),
		blocked: pick ? null : `BLOCKED: HOST_ROUTE_UNAVAILABLE — no host passes every step for ${modelClass} as a ${taskKind}; see candidates[].steps`,
	};
}

/** The exact seating arguments for the picked host, and the decision record. */
export function seatFor(candidate, { modelClass, project, teamCluster }) {
	const { option, hostId, type, serverId } = candidate;
	const family = providerFamily(option.paseoProvider);
	const provider = `${option.paseoProvider}/${option.model}`;
	const settings = { thinkingOptionId: option.thinking, ...(runtimeDescriptor(family)?.hasPermissionModes ? { modeId: "auto" } : {}) };
	const labels = { "team.model-class": modelClass, "team.cluster": teamCluster ?? "<your own cluster>" };
	const workspaces = candidate.workspaces ?? [];
	const matching = project ? workspaces.filter((w) => w.project === project || w.name === project || String(w.cwd ?? "").replace(/\/+$/, "").endsWith(`/${project}`)) : workspaces;
	const workspaceId = matching.length === 1 ? matching[0].workspaceId : null;
	// Several workspaces open on one path is the duplication a Lead's MCP
	// create_workspace leaves behind (measured: it never reuses). Name it; do
	// not pick one silently — the job's seats must share ONE.
	const paths = new Set(matching.map((w) => String(w.cwd ?? "").replace(/\/+$/, "")));
	const workspaceNote =
		matching.length > 1
			? paths.size < matching.length
				? `WORKSPACE_DUPLICATES: ${matching.length} workspaces are open on ${[...paths].join(", ")} on ${hostId} — use the one the job already uses (or ask the Human to archive the extras)`
				: `${matching.length} workspaces match; pass --project <name> to narrow`
			: matching.length === 0 && type !== "local"
				? `no workspace for ${project ?? "this project"} is open on ${hostId} — the Human opens one (or: remote-paseo.mjs workspace-create, which reuses)`
				: null;

	let mechanism;
	let createAgent = null;
	let remoteCli = null;
	if (type === "local") {
		mechanism = "mcp";
		createAgent = { title: "<short title>", provider, initialPrompt: "<brief>", settings, labels };
	} else if (serverId) {
		mechanism = "mcp-serverId";
		createAgent = {
			title: "<short title>",
			provider,
			initialPrompt: "<brief>",
			serverId,
			workspaceId: workspaceId ?? `<workspace for this project ON ${hostId}: list_workspaces { serverId: "${serverId}" }>`,
			settings,
			labels,
		};
	} else mechanism = "remote-cli";
	if (type !== "local") {
		remoteCli = `node <PASEO_TEAM_SCRIPTS_DIR>/remote-paseo.mjs run --host-id ${hostId} --provider ${provider} --thinking ${option.thinking} --workspace ${workspaceId ?? "<wks>"} --title <t> --brief <brief-file>`;
	}
	const evidence = option.resolved
		? `inventory of ${hostId}: ${provider} thinking=${option.thinking} (${option.resolved.thinkingValidated})`
		: `route of ${hostId} (inventory not checked from the CLI)`;
	return {
		hostId,
		mechanism,
		provider,
		thinking: option.thinking,
		option: option.index,
		createAgent,
		remoteCli,
		workspaceCandidates: matching.map((w) => ({ workspaceId: w.workspaceId, cwd: w.cwd ?? null, project: w.project ?? null })),
		workspaceNote,
		routingDecision: [
			"ROUTING_DECISION",
			"TASK_ID: <task id>",
			"DISPOSITION: <engineer | independent-reviewer | ...>",
			`MODEL_CLASS: ${modelClass}`,
			`HOST_ID: ${hostId}`,
			`CLUSTER: ${teamCluster ?? "<team.cluster>"}`,
			`MECHANISM: ${mechanism === "remote-cli" ? "remote-cli" : "mcp"}${mechanism === "mcp-serverId" ? ` (serverId ${serverId})` : ""}`,
			`PASEO_PROVIDER: ${option.paseoProvider}`,
			`REQUESTED_MODEL: ${option.model}`,
			`REQUESTED_THINKING: ${option.thinking}`,
			"OBSERVED_PROVIDER: <get_agent_status / remote-paseo status>",
			"OBSERVED_MODEL: <...>",
			"OBSERVED_THINKING: <...>",
			`WORKSPACE_REF: ${hostId}/${type === "local" ? "<your workspace>" : (workspaceId ?? "<wks>")}`,
			`AGENT_REF: ${hostId}/<agent-id>`,
			`ROUTING_EVIDENCE: pteam dispatch plan — ${evidence}; ${candidate.busy ?? "?"} running on ${hostId}`,
		].join("\n"),
	};
}

/**
 * What runs where, grouped by model class and job. `paseoFor(hostId, host)`
 * returns a runner `(args) => Promise<json>` aimed at that host, or null when
 * the host cannot be observed from here.
 */
export async function collectFlow({ cluster, routeTable, jobs = [], paseoFor }) {
	const hosts = hostsForPlanning({ cluster, routeTable });
	const result = { hosts: [], classes: {}, jobs: {} };
	const classes = ALL_MODEL_CLASSES;
	await Promise.all(
		Object.entries(hosts).map(async ([hostId, host]) => {
			const run = paseoFor(hostId, host);
			const row = { hostId, type: host.connection.type, observable: Boolean(run), agents: [], limits: host.limits ?? null };
			result.hosts.push(row);
			if (!run) return;
			try {
				const all = await run(["ls", "-g"]);
				const byId = new Map((Array.isArray(all) ? all : []).map((a) => [a.id, { ...a, hostId, modelClass: null, job: null }]));
				const tag = async (label, value, key) => {
					const tagged = await run(["ls", "-g", "--label", `${label}=${value}`]);
					for (const a of Array.isArray(tagged) ? tagged : []) {
						const entry = byId.get(a.id) ?? { ...a, hostId, modelClass: null, job: null };
						entry[key] = value;
						byId.set(a.id, entry);
					}
				};
				await Promise.all([
					...classes.map((c) => tag("team.model-class", c, "modelClass")),
					...jobs.map((j) => tag("team.job", j.id, "job")),
				]);
				row.agents = [...byId.values()].map((a) => ({
					id: a.id,
					name: a.name,
					status: a.status,
					provider: a.provider,
					modelClass: a.modelClass,
					job: a.job,
				}));
				row.running = row.agents.filter((a) => a.status === "running").length;
			} catch (error) {
				row.error = String(error?.message ?? error).slice(0, 200);
			}
		}),
	);
	result.hosts.sort((a, b) => a.hostId.localeCompare(b.hostId));
	for (const row of result.hosts) {
		for (const a of row.agents) {
			if (a.modelClass) {
				const c = (result.classes[a.modelClass] ??= { running: 0, idle: 0, other: 0, byHost: {} });
				c[a.status === "running" ? "running" : a.status === "idle" ? "idle" : "other"] += 1;
				c.byHost[row.hostId] = (c.byHost[row.hostId] ?? 0) + 1;
			}
			if (a.job) (result.jobs[a.job] ??= []).push({ hostId: row.hostId, ...a });
		}
	}
	for (const job of jobs) {
		result.jobs[job.id] = {
			label: job.label ?? null,
			run: job.run ?? null,
			active: job.active !== false,
			executors: (job.executors ?? []).map((e) => ({ index: e.index, kind: e.kind, modelClass: e.modelClass ?? null, tool: e.tool ?? null, seats: e.seats ?? [] })),
			seated: Array.isArray(result.jobs[job.id]) ? result.jobs[job.id] : [],
		};
	}
	return result;
}
