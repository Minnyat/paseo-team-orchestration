/**
 * routing.mjs — `pteam routing show|check|set|unset`.
 *
 * The route file is what the create_agent gate compares every Lead/Supervisor
 * seating against, so editing it has to be as strict as the gate itself:
 *
 *   - every read goes through scripts/model-routing.mjs (loadLocalRouteTable,
 *     validateRoutingConfig/validateClusterConfig, resolveRoute) — this file
 *     parses no route on its own;
 *   - `set` validates the new route with resolveRoute in STRICT mode against
 *     the live inventory, exactly like `preflight --strict`, and writes nothing
 *     when it does not resolve;
 *   - every write copies the previous file to `<file>.bak-<epoch>` and renames
 *     a temp file over the original (config-walker's atomicWrite), the same
 *     convention as `pteam config write`.
 *
 * Without --host-id, set/unset edit the file AND host the gate reads (the
 * single local host of cluster-routing.local.json, else
 * model-routing.local.json) — editing a file the gate ignores would look like
 * a fix and change nothing. --host-id targets that host in the cluster file.
 *
 * Nothing here prints a secret: route files hold none (remote endpoints are
 * env-var NAMES, and those are never read).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as cw from "./config-walker.mjs";
import { runPaseoJson, PaseoError } from "./paseo-bridge.mjs";
import { teamConfigDir } from "../../scripts/lib-common.mjs";
import {
	ALL_MODEL_CLASSES,
	CLASS_REQUIRED_ROLE,
	MODEL_CLASSES,
	OPTIONAL_MODEL_CLASSES,
	ROLE_PROVIDERS,
	ROUTE_ENFORCE_ENV,
	RoutingError,
	THINKING_LEVELS_BY_FAMILY,
	composeProviderModel,
	disabledModelProblem,
	isModelDisabled,
	loadLocalRouteTable,
	routeOptions,
	providerFamily,
	resolveRoute,
	validateClusterConfig,
	validateRoutingConfig,
} from "../../scripts/model-routing.mjs";

/** A refusal the command reports and exits 1 on (2 is kept for usage). */
export class RoutingCommandError extends Error {
	constructor(code, message, details = {}) {
		// A RoutingError's message already starts with its code; say it once.
		super(message.startsWith(`${code}: `) ? message.slice(code.length + 2) : message);
		this.name = "RoutingCommandError";
		this.code = code;
		this.details = details;
	}
}

/** The two route files, under the same config-dir resolution the gate uses. */
function paths(env) {
	const dir = teamConfigDir(env);
	return {
		routing: join(dir, "model-routing.local.json"),
		cluster: join(dir, "cluster-routing.local.json"),
	};
}

export function enforcementState(env = process.env) {
	return env[ROUTE_ENFORCE_ENV] === "off" ? "off" : "on";
}

function enforcementWarning(env) {
	return enforcementState(env) === "off"
		? `${ROUTE_ENFORCE_ENV}=off in this environment — create_agent is NOT checked against these routes. An emergency opt-out, never a default; unset it.`
		: null;
}

function describeRoutes(routes, disabledModels = []) {
	return ALL_MODEL_CLASSES.map((modelClass) => {
		const route = routes?.[modelClass];
		const required = MODEL_CLASSES.includes(modelClass);
		if (!route) return { class: modelClass, required, configured: false };
		// Every option of the class (0 = the primary). The class-level fields below
		// describe the primary, as they always did; `usable` says whether the class
		// can be seated at all — when ANY option is on and its model is not off.
		const options = routeOptions(route).map((option) => ({
			index: option.index,
			enabled: option.enabled,
			modelDisabled: isModelDisabled(disabledModels, option.paseoProvider, option.model),
			paseoProvider: option.paseoProvider,
			model: option.model,
			thinking: option.thinking,
			createAgentProvider: composeProviderModel(option.paseoProvider, option.model),
		}));
		return {
			class: modelClass,
			required,
			configured: true,
			enabled: options.some((option) => option.enabled),
			modelDisabled: options.every((option) => option.modelDisabled || !option.enabled) && options.some((option) => option.modelDisabled),
			usable: options.some((option) => option.enabled && !option.modelDisabled),
			paseoProvider: route.paseoProvider,
			model: route.model,
			thinking: route.thinking,
			createAgentProvider: composeProviderModel(route.paseoProvider, route.model),
			options,
		};
	});
}

/** `routing show` — the table the gate reads, per class, unset optional ones marked. */
export function routingShow({ env = process.env } = {}) {
	const table = loadLocalRouteTable({ env });
	const warnings = [enforcementWarning(env)].filter(Boolean);
	if (!table.ok) {
		return {
			ok: false,
			enforcement: enforcementState(env),
			code: table.code,
			message: table.message,
			paths: table.paths,
			warnings,
		};
	}
	if (table.shadowed) {
		warnings.push(`${table.shadowed} exists but is NOT read: the cluster file's local host "${table.hostId}" is the source`);
	}
	const classes = describeRoutes(table.routes, table.disabledModels);
	for (const entry of classes) {
		if (!entry.required && !entry.configured) {
			warnings.push(`${entry.class} is not configured — the gate refuses the flow that needs it (pteam routing set ${entry.class} ...)`);
		}
		if (entry.configured && !entry.usable) {
			if (entry.modelDisabled) {
				warnings.push(`${entry.class} routes to a model that is switched off — the gate refuses every seating of this class (the Human switches the model on: pteam routing enable-model <family>/<model>)`);
			} else {
				warnings.push(`${entry.class} is switched off — the gate refuses every seating of this class, it is never rerouted (the Human switches it on: pteam routing enable ${entry.class})`);
			}
		}
	}
	return {
		ok: true,
		enforcement: enforcementState(env),
		source: table.source,
		path: table.path,
		hostId: table.hostId,
		classes,
		disabledModels: table.disabledModels ?? [],
		warnings,
	};
}

/**
 * The live inventory for one role provider on the LOCAL daemon: the same two
 * reads preflight makes (`provider ls`, `provider models <rp>`). An `{ error }`
 * body or a non-array answer is a failure, never "zero models".
 */
export async function liveInventory(paseoProvider, { timeoutMs = 20_000 } = {}) {
	const read = async (args) => {
		try {
			const payload = await runPaseoJson(args, { timeoutMs });
			if (!Array.isArray(payload)) {
				const message =
					payload && typeof payload === "object" && payload.error
						? String(payload.error.message ?? payload.error)
						: "paseo returned no list";
				return { ok: false, message: `paseo ${args.join(" ")}: ${message}` };
			}
			return { ok: true, value: payload };
		} catch (error) {
			const code = error instanceof PaseoError ? error.code : "PASEO_FAILED";
			return { ok: false, message: `paseo ${args.join(" ")} failed (${code}): ${String(error?.message ?? error)}` };
		}
	};
	const providers = await read(["provider", "ls"]);
	if (!providers.ok) return providers;
	const models = await read(["provider", "models", paseoProvider]);
	if (!models.ok) return models;
	return { ok: true, inventory: { providers: providers.value, models: models.value } };
}

/**
 * The file (and cluster host) a set/unset edits.
 * @returns {{kind: "routing"|"cluster", path: string, hostId: string, raw: object}}
 */
function editTarget(env, hostIdArg) {
	const p = paths(env);
	if (hostIdArg !== undefined) {
		if (!existsSync(p.cluster)) {
			throw new RoutingCommandError(
				"CLUSTER_FILE_MISSING",
				`--host-id targets a host in ${p.cluster}, which does not exist (copy config/cluster-routing.example.json)`,
			);
		}
		const text = readText(p.cluster);
		const raw = parseJson(p.cluster, text);
		if (!raw?.hosts || typeof raw.hosts !== "object" || !(hostIdArg in raw.hosts)) {
			throw new RoutingCommandError(
				"HOST_UNKNOWN",
				`host "${hostIdArg}" is not in ${p.cluster} (hosts: ${Object.keys(raw?.hosts ?? {}).join(", ") || "none"})`,
			);
		}
		return { kind: "cluster", path: p.cluster, hostId: hostIdArg, raw, text };
	}
	const table = loadLocalRouteTable({ env });
	if (!table.ok) {
		throw new RoutingCommandError(
			table.code,
			table.code === "ROUTE_FILE_MISSING"
				? `${table.message}. \`routing set\` edits an existing route file; it does not invent the five required classes.`
				: `${table.message}. Fix the file first (pteam config read routing / cluster); \`routing set\` will not rewrite a file that does not load.`,
			{ paths: table.paths },
		);
	}
	const text = readText(table.path);
	return {
		kind: table.source,
		path: table.path,
		hostId: table.hostId,
		raw: parseJson(table.path, text),
		text,
	};
}

function readText(path) {
	try {
		return readFileSync(path, "utf8");
	} catch (error) {
		throw new RoutingCommandError("CONFIG_INVALID", `${path} is not readable: ${String(error?.message ?? error)}`);
	}
}

function parseJson(path, text) {
	try {
		return JSON.parse(text);
	} catch (error) {
		throw new RoutingCommandError("CONFIG_INVALID", `${path} is not readable JSON: ${String(error?.message ?? error)}`);
	}
}

function routesOf(target) {
	if (target.kind === "cluster") {
		const host = target.raw.hosts[target.hostId];
		host.routes = host.routes && typeof host.routes === "object" ? host.routes : {};
		return host.routes;
	}
	target.raw.routes = target.raw.routes && typeof target.raw.routes === "object" ? target.raw.routes : {};
	return target.raw.routes;
}

/** Validate the whole candidate document with the resolver's own validator. */
function validateCandidate(target) {
	try {
		if (target.kind === "cluster") validateClusterConfig(target.raw);
		else validateRoutingConfig(target.raw);
	} catch (error) {
		throw new RoutingCommandError(
			error instanceof RoutingError ? error.code : "CONFIG_INVALID",
			`${String(error?.message ?? error)} — nothing written`,
		);
	}
}

/**
 * Write the edited document — but only over the exact bytes it was read from.
 * `set` awaits the live inventory between reading and writing (seconds, on a
 * cold daemon); an edit made meanwhile — another `routing set`, the WebUI, a
 * hand edit — would otherwise be overwritten with no trace. Compared on the
 * CONTENT, not mtime+size: a same-size edit within one mtime tick is exactly
 * the case a stat comparison misses.
 */
function writeTarget(target) {
	let current;
	try {
		current = readFileSync(target.path, "utf8");
	} catch (error) {
		throw new RoutingCommandError("CONCURRENT_EDIT", `${target.path} could not be re-read before writing (${String(error?.message ?? error)}) — nothing written`);
	}
	if (current !== target.text) {
		throw new RoutingCommandError(
			"CONCURRENT_EDIT",
			`${target.path} changed while this command was validating the route — nothing written, so that edit is not lost. Re-run the command against the file as it is now.`,
		);
	}
	const backup = cw.atomicWrite(target.path, `${JSON.stringify(target.raw, null, 2)}\n`);
	return backup;
}

export function requireClass(modelClass) {
	if (!ALL_MODEL_CLASSES.includes(modelClass)) {
		throw new RoutingCommandError(
			"CLASS_UNKNOWN",
			`unknown class "${modelClass ?? ""}" (expected one of: ${ALL_MODEL_CLASSES.join(", ")})`,
		);
	}
}

/** The --provider/--model/--thinking of `set` and `add-option`, checked the same way. */
function checkOptionArgs(modelClass, provider, model, thinking) {
	if (!ROLE_PROVIDERS.includes(provider)) {
		throw new RoutingCommandError(
			"PROVIDER_INVALID",
			`--provider "${provider ?? ""}" must be a role provider (${ROLE_PROVIDERS.join(", ")})`,
		);
	}
	const requiredRole = CLASS_REQUIRED_ROLE[modelClass];
	if (requiredRole && !provider.endsWith(`-${requiredRole}`)) {
		throw new RoutingCommandError(
			"PROVIDER_INVALID",
			`${modelClass} seats a ${requiredRole}: --provider must be ${ROLE_PROVIDERS.filter((name) => name.endsWith(`-${requiredRole}`)).join(" or ")} (got "${provider}")`,
		);
	}
	if (typeof model !== "string" || model === "" || model !== model.trim()) {
		throw new RoutingCommandError("MODEL_INVALID", "--model must be a non-empty model id with no surrounding whitespace");
	}
	const levels = THINKING_LEVELS_BY_FAMILY[providerFamily(provider)] ?? [];
	if (!levels.includes(thinking)) {
		throw new RoutingCommandError(
			"THINKING_INVALID",
			`--thinking "${thinking ?? ""}" is not a ${providerFamily(provider)} thinking level (${levels.join(", ")})`,
		);
	}
}

/** A cluster host must be this machine's: its inventory is the local daemon's. */
function assertLocalHost(target) {
	if (target.kind === "cluster") {
		const type = target.raw.hosts[target.hostId]?.connection?.type;
		if (type !== "local") {
			throw new RoutingCommandError(
				"REMOTE_HOST_UNVERIFIABLE",
				`host "${target.hostId}" is connection.type "${type}" — its inventory lives on another daemon, and this command validates only against the LOCAL one. Nothing written. Run the command on that host, or edit ${target.path} and verify with \`pteam preflight --strict --host-id ${target.hostId}\`.`,
			);
		}
	}
}

/**
 * `routing set` — validate strictly against the live inventory, then write.
 *
 * `inventoryFor` is injectable for tests; production reads the local daemon.
 */
export async function routingSet(
	{ modelClass, provider, model, thinking, hostId },
	{ env = process.env, inventoryFor = liveInventory } = {},
) {
	requireClass(modelClass);
	checkOptionArgs(modelClass, provider, model, thinking);

	const target = editTarget(env, hostId);
	assertLocalHost(target);
	const previous = routesOf(target)[modelClass] ?? null;
	// Changing WHAT a class routes to must not silently switch it back on.
	// ...and must not drop the class's other options.
	const route = {
		paseoProvider: provider,
		model,
		thinking,
		...(previous?.enabled === false ? { enabled: false } : {}),
		...(Array.isArray(previous?.alternates) && previous.alternates.length > 0 ? { alternates: previous.alternates } : {}),
	};
	routesOf(target)[modelClass] = route;
	validateCandidate(target);

	const live = await inventoryFor(provider, { env });
	if (!live.ok) {
		throw new RoutingCommandError(
			"INVENTORY_UNAVAILABLE",
			`${live.message} — the route cannot be verified, and an unverified route is not written`,
		);
	}
	let resolved;
	try {
		// The route is verified as a route; whether its class is switched on is a separate fact.
		const { enabled: _enabled, alternates: _alternates, ...verifiable } = route;
		resolved = resolveRoute({ hostId: target.hostId, routes: { [modelClass]: verifiable } }, modelClass, live.inventory, {
			strict: true,
		});
	} catch (error) {
		throw new RoutingCommandError(
			error instanceof RoutingError ? error.code : "ROUTE_UNROUTABLE",
			`${String(error?.message ?? error)} — nothing written`,
		);
	}
	const backup = writeTarget(target);
	return {
		ok: true,
		wrote: true,
		path: target.path,
		backup,
		hostId: target.hostId,
		class: modelClass,
		previous,
		route,
		createAgentProvider: resolved.createAgentProvider,
		thinkingValidated: resolved.thinkingValidated,
	};
}

/**
 * `routing enable|disable <CLASS>` — the quick switch. Flips `enabled` on one
 * route and nothing else: model and thinking stay, so enabling restores exactly
 * what was there. No live inventory is needed to switch OFF, and none is
 * demanded to switch ON either — preflight / `routing check` verify it. The
 * gate reads the file on every create_agent, so the change is live at once.
 */
export function routingToggle({ modelClass, enabled, hostId, option }, { env = process.env } = {}) {
	requireClass(modelClass);
	const target = editTarget(env, hostId);
	const routes = routesOf(target);
	const route = routes[modelClass];
	if (!route || typeof route !== "object") {
		throw new RoutingCommandError(
			"CLASS_UNCONFIGURED",
			`${modelClass} has no route in ${target.path} — there is nothing to switch (pteam routing set ${modelClass} ...)`,
		);
	}
	// Without --option the whole class is switched (every option); with it, ONE option
	// (0 = the primary, 1.. = the alternates in file order).
	const nodes = [route, ...(Array.isArray(route.alternates) ? route.alternates : [])];
	if (option !== undefined && (!Number.isInteger(option) || option < 0 || option >= nodes.length)) {
		throw new RoutingCommandError("OPTION_UNKNOWN", `${modelClass} has options 0..${nodes.length - 1}; --option ${option} is not one of them`);
	}
	const picked = option === undefined ? nodes : [nodes[option]];
	const was = picked.every((node) => node.enabled !== false) ? true : picked.every((node) => node.enabled === false) ? false : null;
	if (was === enabled) {
		return { ok: true, wrote: false, path: target.path, hostId: target.hostId, class: modelClass, ...(option === undefined ? {} : { option }), enabled, note: `already ${enabled ? "on" : "off"}; nothing to do` };
	}
	for (const node of picked) {
		if (enabled) delete node.enabled;
		else node.enabled = false;
	}
	validateCandidate(target);
	const backup = writeTarget(target);
	return { ok: true, wrote: true, path: target.path, backup, hostId: target.hostId, class: modelClass, ...(option === undefined ? {} : { option }), enabled, previous: was };
}

/**
 * `routing add-option <CLASS> --provider … --model … --thinking …` — give a class
 * one more way to be seated (another tool, or the same tool on another model).
 * Verified as strictly as `set` (the live inventory of the local daemon) and
 * written the same way (backup, atomic, refuses a concurrent edit). The class
 * stays one class: the Lead seats ONE of its usable options, and the gate checks
 * the one it names — adding an option changes what may be chosen, never what is
 * chosen.
 */
export async function routingAddOption(
	{ modelClass, provider, model, thinking, hostId },
	{ env = process.env, inventoryFor = liveInventory } = {},
) {
	requireClass(modelClass);
	checkOptionArgs(modelClass, provider, model, thinking);
	const target = editTarget(env, hostId);
	assertLocalHost(target);
	const route = routesOf(target)[modelClass];
	if (!route || typeof route !== "object") {
		throw new RoutingCommandError("CLASS_UNCONFIGURED", `${modelClass} has no route in ${target.path} — set the primary first (pteam routing set ${modelClass} ...)`);
	}
	const added = { paseoProvider: provider, model, thinking };
	route.alternates = [...(Array.isArray(route.alternates) ? route.alternates : []), added];
	validateCandidate(target); // role, model shape, thinking level, duplicates
	const live = await inventoryFor(provider, { env });
	if (!live.ok) {
		throw new RoutingCommandError("INVENTORY_UNAVAILABLE", `${live.message} — the option cannot be verified, and an unverified option is not written`);
	}
	let resolved;
	try {
		resolved = resolveRoute({ hostId: target.hostId, routes: { [modelClass]: added } }, modelClass, live.inventory, { strict: true });
	} catch (error) {
		throw new RoutingCommandError(error instanceof RoutingError ? error.code : "ROUTE_UNROUTABLE", `${String(error?.message ?? error)} — nothing written`);
	}
	const backup = writeTarget(target);
	return { ok: true, wrote: true, path: target.path, backup, hostId: target.hostId, class: modelClass, option: route.alternates.length, added, createAgentProvider: resolved.createAgentProvider, thinkingValidated: resolved.thinkingValidated };
}

/** `routing remove-option <CLASS> <N>` — drop alternate N (1..); the primary is changed with `set`, never removed. */
export function routingRemoveOption({ modelClass, option, hostId }, { env = process.env } = {}) {
	requireClass(modelClass);
	const target = editTarget(env, hostId);
	const route = routesOf(target)[modelClass];
	const alternates = Array.isArray(route?.alternates) ? route.alternates : [];
	if (!Number.isInteger(option) || option < 1 || option > alternates.length) {
		throw new RoutingCommandError("OPTION_UNKNOWN", `${modelClass} has ${alternates.length} alternate option(s), numbered 1..${alternates.length || 0}; "${option}" is not one of them (the primary, 0, is changed with \`routing set\`)`);
	}
	const [removed] = alternates.splice(option - 1, 1);
	if (alternates.length === 0) delete route.alternates;
	validateCandidate(target);
	const backup = writeTarget(target);
	return { ok: true, wrote: true, path: target.path, backup, hostId: target.hostId, class: modelClass, removed, option };
}

/**
 * `routing disable-model|enable-model <family/model>` — the "this model is out
 * of credit" switch. One entry in `disabledModels` of the file the gate reads
 * (the host's own list in a cluster file): every class route and every job
 * executor on that model is refused/skipped at once, on the next seating. A key
 * ending in "/*" switches off a whole prefix ("pi/Minnyat/*" = the endpoint).
 * Nothing is rerouted: a class on that model is simply unavailable until you
 * switch the model back on or point the class somewhere else.
 */
export function routingModelSwitch({ key, enabled, hostId }, { env = process.env } = {}) {
	const problem = disabledModelProblem(key);
	if (problem) throw new RoutingCommandError("MODEL_KEY_INVALID", `"${key ?? ""}" ${problem}`);
	const target = editTarget(env, hostId);
	const holder = target.kind === "cluster" ? target.raw.hosts[target.hostId] : target.raw;
	const list = Array.isArray(holder.disabledModels) ? holder.disabledModels : [];
	const was = list.includes(key);
	if (was === !enabled) {
		return { ok: true, wrote: false, path: target.path, hostId: target.hostId, model: key, enabled, note: `already ${enabled ? "on" : "off"}; nothing to do` };
	}
	const next = enabled ? list.filter((entry) => entry !== key) : [...list, key];
	if (next.length > 0) holder.disabledModels = next;
	else delete holder.disabledModels;
	validateCandidate(target);
	const backup = writeTarget(target);
	return { ok: true, wrote: true, path: target.path, backup, hostId: target.hostId, model: key, enabled, disabledModels: next };
}

/** `routing unset` — optional classes only; the five required ones are the contract. */
export function routingUnset({ modelClass, hostId }, { env = process.env } = {}) {
	requireClass(modelClass);
	if (!OPTIONAL_MODEL_CLASSES.includes(modelClass)) {
		throw new RoutingCommandError(
			"CLASS_REQUIRED",
			`${modelClass} is a required class and cannot be unset (only ${OPTIONAL_MODEL_CLASSES.join(", ")} can); use \`routing set\` to change it`,
		);
	}
	const target = editTarget(env, hostId);
	const routes = routesOf(target);
	if (!(modelClass in routes)) {
		return { ok: true, wrote: false, path: target.path, hostId: target.hostId, class: modelClass, note: "not configured; nothing to do" };
	}
	const previous = routes[modelClass];
	delete routes[modelClass];
	validateCandidate(target);
	const backup = writeTarget(target);
	return { ok: true, wrote: true, path: target.path, backup, hostId: target.hostId, class: modelClass, previous };
}

/**
 * `routing check` — the routing half of preflight and nothing else: both files'
 * schemas, the table the gate reads, and every configured class of the local
 * host resolved STRICTLY against the live daemon. Remote cluster hosts get the
 * schema check only (their inventory is on another daemon — `pteam preflight
 * --host-id <id>` does the live remote check).
 */
export async function routingCheck({ env = process.env, inventoryFor = liveInventory } = {}) {
	const p = paths(env);
	const checks = [];
	const add = (id, status, detail) => checks.push({ id, status, detail });
	for (const [id, path, validate] of [
		["routing-config", p.routing, (data) => validateRoutingConfig(data)],
		["cluster-config", p.cluster, (data) => validateClusterConfig(data)],
	]) {
		if (!existsSync(path)) {
			add(id, "skip", `${path} absent`);
			continue;
		}
		try {
			validate(JSON.parse(readFileSync(path, "utf8")));
			add(id, "pass", path);
		} catch (error) {
			add(id, "fail", `${path}: ${String(error?.message ?? error)}`);
		}
	}
	const table = loadLocalRouteTable({ env });
	if (!table.ok) {
		add("route-gate", "fail", `${table.code}: ${table.message}`);
	} else {
		add("route-gate", "pass", `create_agent is checked against ${table.path} (host "${table.hostId}")`);
		for (const modelClass of ALL_MODEL_CLASSES) {
			const route = table.routes[modelClass];
			if (!route) {
				add(`route:${modelClass}`, "warn", "optional class not configured — the flow that needs it is refused until it is");
				continue;
			}
			// Every option is checked; the id of option N > 0 is `route:CLASS#N`.
			for (const option of routeOptions(route)) {
				const id = option.index === 0 ? `route:${modelClass}` : `route:${modelClass}#${option.index}`;
				if (!option.enabled) {
					add(id, "warn", `switched off — ${option.index === 0 && !route.alternates ? "the gate refuses every seating of this class" : "this option is not offered"} (pteam routing enable ${modelClass}${option.index === 0 && !route.alternates ? "" : ` --option ${option.index}`})`);
					continue;
				}
				if (isModelDisabled(table.disabledModels, option.paseoProvider, option.model)) {
					add(id, "warn", `its model is switched off (disabledModels) — this option is not offered (pteam routing enable-model <family>/<model>)`);
					continue;
				}
				const live = await inventoryFor(option.paseoProvider, { env });
				if (!live.ok) {
					add(id, "fail", `${live.message} — unverifiable is not a pass`);
					continue;
				}
				try {
					const resolved = resolveRoute(table, modelClass, live.inventory, { strict: true, option: option.index });
					add(id, "pass", `${resolved.createAgentProvider} + thinking=${option.thinking}`);
				} catch (error) {
					add(id, "fail", String(error?.message ?? error));
				}
			}
		}
	}
	const warning = enforcementWarning(env);
	add("route-enforcement", warning ? "warn" : "pass", warning ?? "on");
	return { ok: !checks.some((check) => check.status === "fail"), checks };
}

/** Human rendering for `routing show` (the JSON form is the same object). */
export function formatShow(result) {
	const lines = [];
	if (!result.ok) {
		lines.push(`route table: UNAVAILABLE (${result.code}) — ${result.message}`);
	} else {
		lines.push(`route table: ${result.path}  (host "${result.hostId}", source ${result.source})`);
		lines.push(`enforcement: ${result.enforcement}`);
		const tags = (option) => `${option.enabled ? "" : " [OFF]"}${option.modelDisabled ? " [MODEL OFF]" : ""}`;
		for (const entry of result.classes) {
			const optional = entry.required ? "" : " (optional)";
			if (!entry.configured) {
				lines.push(`  ${entry.class.padEnd(22)} — not configured${optional}`);
				continue;
			}
			const [first, ...more] = entry.options;
			lines.push(`  ${entry.class.padEnd(22)} ${first.createAgentProvider}  thinking=${first.thinking}${optional}${tags(first)}`);
			// Several options: the Lead seats ONE of the usable ones; none is chosen for it.
			for (const option of more) lines.push(`  ${"".padEnd(22)} #${option.index} ${option.createAgentProvider}  thinking=${option.thinking}${tags(option)}`);
		}
	}
	if (result.ok && (result.disabledModels ?? []).length > 0) lines.push(`models switched off: ${result.disabledModels.join(", ")}`);
	for (const warning of result.warnings ?? []) lines.push(`WARN ${warning}`);
	return `${lines.join("\n")}\n`;
}

export function formatCheck(result) {
	const mark = { pass: "✓", warn: "!", fail: "✗", skip: "-" };
	return `${result.checks.map((check) => `${mark[check.status] ?? "?"} ${check.id}: ${check.detail}`).join("\n")}\n${result.ok ? "routing: OK" : "routing: FAILED"}\n`;
}
