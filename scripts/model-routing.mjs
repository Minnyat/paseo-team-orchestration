// model-routing.mjs — stateless logical-model-class resolver for the
// paseo-team-orchestration role pack.
//
// What this module is ALLOWED to do:
//   - read + validate a host-local routing config;
//   - compose the exact `<role-provider>/<model-id>` create_agent string;
//   - validate a route against a real provider/model inventory;
//   - compare requested values against observed runtime info;
//   - return structured, fail-closed errors.
//
// What it must NEVER do: store agent lifecycle, manage sessions, keep a task
// database, hold API keys, or fall back to another model/host on its own.
// Paseo remains the only control plane; git SHA remains the artifact anchor.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isEntrypoint, teamConfigDir } from "./lib-common.mjs";

export const MODEL_CLASSES = Object.freeze([
	"MONITOR_ECONOMY",
	"FAST_READ",
	"CODING_MEDIUM",
	"REASONING_HIGH",
	"REVIEW_HIGH",
]);

/**
 * Thinking levels are per RUNTIME FAMILY, not global: `minimal` exists only on
 * pi and `ultracode` only on Claude, so a single union would silently accept a
 * level the target runtime clamps away. Verify against the real inventory with
 * `paseo provider models <role-provider> --json`.
 */
export const THINKING_LEVELS_BY_FAMILY = Object.freeze({
	pi: Object.freeze(["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
	claude: Object.freeze([
		"off",
		"low",
		"medium",
		"high",
		"xhigh",
		"max",
		"ultracode",
	]),
});

/** Kept for compatibility: the pi levels, which predate the Claude family. */
export const THINKING_LEVELS = THINKING_LEVELS_BY_FAMILY.pi;

/**
 * The one level that means "no extended thinking". It is in EVERY family's
 * list, and it is the level a model without extended thinking runs at whether
 * or not anybody asked for it — which is why a model that publishes no options
 * can still be routed at exactly this level and no other.
 */
export const NO_THINKING_LEVEL = "off";

export const RUNTIME_FAMILIES = Object.freeze(["pi", "claude"]);
export const TEAM_ROLES = Object.freeze(["supervisor", "lead", "peer"]);

/**
 * The durable Paseo role profiles — one per (family, role). Model-per-role
 * profiles are not created; the model is chosen per route instead.
 *
 * MUST stay in sync with ROLE_PROVIDERS in extensions/paseo-team-core/policy-core.ts
 * (test/model-routing.test.mjs asserts the two agree).
 */
export const ROLE_PROVIDERS = Object.freeze(
	RUNTIME_FAMILIES.flatMap((family) =>
		TEAM_ROLES.map((role) => `${family}-${role}`),
	),
);

/** "claude-peer" → "claude"; null when the name is not a role provider. */
export function providerFamily(paseoProvider) {
	const name = String(paseoProvider ?? "").trim();
	const family = RUNTIME_FAMILIES.find((candidate) =>
		TEAM_ROLES.some((role) => name === `${candidate}-${role}`),
	);
	return family ?? null;
}

/**
 * Model reference shape per family.
 *
 * pi model ids carry their own provider segment ("<pi-provider>/<model-id>",
 * and the model id may itself contain slashes — Paseo splits at the FIRST
 * slash only). Claude model ids are a single segment ("claude-opus-5"), so a
 * slash there means the author pasted a pi-shaped value by mistake.
 */
export function validateModelForFamily(family, model, fail, context = {}) {
	const trimmed = String(model).trim();
	if (family === "claude") {
		if (trimmed.includes("/")) {
			throw fail(
				`model "${trimmed}" must be a bare Claude model id (no "/"), e.g. claude-opus-5`,
				{ ...context, model: trimmed },
			);
		}
		if (/\s/.test(trimmed)) {
			throw fail(`model "${trimmed}" must not contain whitespace`, {
				...context,
				model: trimmed,
			});
		}
		return trimmed;
	}
	if (!trimmed.includes("/")) {
		throw fail(`model "${trimmed}" must be in <pi-provider>/<model-id> form`, {
			...context,
			model: trimmed,
		});
	}
	// Split the model value DIRECTLY (not prefixed by paseoProvider):
	// splitProviderModel rejects an empty provider segment ("/model-id") and an
	// empty model segment ("provider/") at the position where the config author
	// made the mistake, not later at route composition.
	splitProviderModel(trimmed);
	return trimmed;
}

export const ERROR_CODES = Object.freeze([
	"CONFIG_INVALID",
	"ROLE_PROVIDER_UNAVAILABLE",
	"MODEL_UNAVAILABLE",
	"THINKING_OPTION_UNAVAILABLE",
	"MODEL_RESOLUTION_MISMATCH",
	"HOST_ROUTE_UNAVAILABLE",
]);

/** Structured failure. Always fail-closed; never a fallback signal. */
export class RoutingError extends Error {
	/**
	 * @param {string} code one of ERROR_CODES
	 * @param {string} message human-readable explanation
	 * @param {Record<string, unknown>} [details] machine-readable context
	 */
	constructor(code, message, details = {}) {
		super(`${code}: ${message}`);
		this.name = "RoutingError";
		this.code = code;
		this.details = details;
	}
}

export function defaultRoutingDir() {
	// Delegated so the CLI and the router cannot disagree about where routing
	// lives — they used to, see teamConfigDir in lib-common.
	return teamConfigDir();
}

export function defaultRoutingConfigPath() {
	return join(defaultRoutingDir(), "model-routing.local.json");
}

export function defaultClusterRoutingPath() {
	return join(defaultRoutingDir(), "cluster-routing.local.json");
}

// Required capabilities per task kind — used by cluster validation and by
// preflight's strict checks. Drafted once here so hosts cannot silently
// accept tasks they cannot perform.
export const HOST_CAPABILITIES = Object.freeze({
	writer: ["git-write", "focused-test"],
	reviewer: ["git-read", "independent-review"],
});

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

/**
 * Validate a parsed model-routing config object.
 * @returns {{hostId: string, routes: Record<string, {paseoProvider: string, model: string, thinking: string}>}}
 * @throws {RoutingError} CONFIG_INVALID
 */
export function validateRoutingConfig(data) {
	const fail = (message, details = {}) =>
		new RoutingError("CONFIG_INVALID", message, details);
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		throw fail("routing config must be a JSON object");
	}
	if (data.version !== 1) {
		throw fail("routing config version must be 1", { version: data.version });
	}
	if (typeof data.hostId !== "string" || data.hostId.trim() === "") {
		throw fail("routing config requires a non-empty hostId");
	}
	const routes = data.routes;
	if (typeof routes !== "object" || routes === null || Array.isArray(routes)) {
		throw fail("routing config requires a routes object");
	}
	for (const modelClass of MODEL_CLASSES) {
		if (!(modelClass in routes)) {
			throw fail(`routes is missing required class ${modelClass}`, {
				modelClass,
			});
		}
	}
	const validated = {};
	for (const [modelClass, route] of Object.entries(routes)) {
		if (!MODEL_CLASSES.includes(modelClass)) {
			throw fail(`unknown MODEL_CLASS "${modelClass}"`, { modelClass });
		}
		if (typeof route !== "object" || route === null) {
			throw fail(`route for ${modelClass} must be an object`);
		}
		const { paseoProvider, model, thinking } = route;
		if (!ROLE_PROVIDERS.includes(paseoProvider)) {
			throw fail(
				`route ${modelClass}: paseoProvider "${paseoProvider}" is not one of the durable role profiles (${ROLE_PROVIDERS.join(", ")})`,
				{ modelClass, paseoProvider },
			);
		}
		if (typeof model !== "string" || model.trim() === "") {
			throw fail(`route ${modelClass}: model must be a non-empty string`);
		}
		const family = providerFamily(paseoProvider);
		const trimmedModel = validateModelForFamily(
			family,
			model,
			(message, details) => fail(`route ${modelClass}: ${message}`, details),
			{ modelClass },
		);
		const levels = THINKING_LEVELS_BY_FAMILY[family];
		if (!levels.includes(thinking)) {
			throw fail(
				`route ${modelClass}: thinking "${thinking}" is not a ${family} thinking level (${levels.join(", ")})`,
				{ modelClass, thinking, family },
			);
		}
		validated[modelClass] = {
			paseoProvider,
			model: trimmedModel,
			thinking,
		};
	}
	return { hostId: data.hostId.trim(), routes: validated };
}

/**
 * Load + validate a host-local routing config from disk.
 * @throws {RoutingError} CONFIG_INVALID on missing/invalid file
 */
export function loadRoutingConfig(path = defaultRoutingConfigPath()) {
	let raw;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		throw new RoutingError(
			"CONFIG_INVALID",
			`cannot read routing config at ${path}`,
			{
				path,
				cause: String(error?.message ?? error),
			},
		);
	}
	let data;
	try {
		data = JSON.parse(raw);
	} catch (error) {
		throw new RoutingError(
			"CONFIG_INVALID",
			`routing config at ${path} is not valid JSON`,
			{
				path,
				cause: String(error?.message ?? error),
			},
		);
	}
	return validateRoutingConfig(data);
}

// ---------------------------------------------------------------------------
// Cluster routing contract (controller-local)
// ---------------------------------------------------------------------------
//
// ~/.paseo-pi-team/cluster-routing.local.json is the SINGLE controller-local
// route file: one object describing every host in the cluster, each with its
// own connection info, capabilities, concurrency limits and per-class routes.
// It never holds endpoint VALUES (env-var names only) and is never committed.

/**
 * Validate a cluster routing config object.
 * @returns {{version: 1, hosts: Record<string, {connection: {type: string, endpointEnv?: string},
 *            required: boolean, capabilities: string[], limits: {writers: number, readers: number},
 *            routes: Record<string, {paseoProvider: string, model: string, thinking: string}>}>}}
 * @throws {RoutingError} CONFIG_INVALID
 */
export function validateClusterConfig(data) {
	const fail = (message, details = {}) =>
		new RoutingError("CONFIG_INVALID", message, details);
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		throw fail("cluster routing config must be a JSON object");
	}
	if (data.version !== 1) {
		throw fail("cluster routing config version must be 1", {
			version: data.version,
		});
	}
	if (
		typeof data.hosts !== "object" ||
		data.hosts === null ||
		Array.isArray(data.hosts)
	) {
		// An array is `typeof "object"` too — without this guard a hosts ARRAY
		// silently iterated as phantom hosts "0", "1", ... instead of failing.
		throw fail("cluster routing config requires a hosts object");
	}
	if (Object.keys(data.hosts).length === 0) {
		throw fail("cluster routing config hosts must not be empty");
	}
	const hosts = {};
	for (const [hostId, raw] of Object.entries(data.hosts)) {
		const failHost = (message, details = {}) =>
			fail(`host "${hostId}": ${message}`, { hostId, ...details });
		if (typeof hostId !== "string" || hostId.trim() === "") {
			throw fail("host id must be a non-empty string");
		}
		if (typeof raw !== "object" || raw === null) {
			throw failHost("host entry must be an object");
		}
		// connection
		const connection = raw.connection;
		if (typeof connection !== "object" || connection === null) {
			throw failHost("connection must be an object");
		}
		if (connection.type !== "local" && connection.type !== "remote") {
			throw failHost(
				`connection.type "${connection.type}" must be "local" or "remote"`,
			);
		}
		const validatedConnection = { type: connection.type };
		if (connection.type === "remote") {
			if (
				typeof connection.endpointEnv !== "string" ||
				connection.endpointEnv.trim() === ""
			) {
				throw failHost(
					"remote connection requires a non-empty endpointEnv (env-var NAME only — never a value)",
				);
			}
			validatedConnection.endpointEnv = connection.endpointEnv.trim();
		}
		// required
		if (typeof raw.required !== "boolean") {
			throw failHost(
				`required must be an explicit boolean (got ${JSON.stringify(raw.required)}) — a mistyped value silently downgrades a required host to optional`,
				{ required: raw.required },
			);
		}
		const required = raw.required;
		// capabilities
		if (!Array.isArray(raw.capabilities)) {
			throw failHost("capabilities must be an array of strings");
		}
		const capabilities = raw.capabilities.map((c) => {
			if (typeof c !== "string" || c.trim() === "") {
				throw failHost("capabilities entries must be non-empty strings");
			}
			return c.trim();
		});
		// limits
		if (
			raw.limits !== undefined &&
			(typeof raw.limits !== "object" ||
				raw.limits === null ||
				Array.isArray(raw.limits))
		) {
			throw failHost("limits must be an object when present", {
				limits: raw.limits,
			});
		}
		const limits = raw.limits ?? {};
		const writers = limits.writers ?? 0;
		const readers = limits.readers ?? 0;
		for (const [key, value] of [
			["writers", writers],
			["readers", readers],
		]) {
			if (!Number.isInteger(value) || value < 0) {
				throw failHost(`limits.${key} must be a non-negative integer`);
			}
		}
		// routes: reuse the single-host validator for correctness parity.
		const validated = validateRoutingConfig({
			version: 1,
			hostId,
			routes: raw.routes ?? {},
		});
		hosts[hostId] = {
			connection: validatedConnection,
			required,
			capabilities,
			limits: { writers, readers },
			routes: validated.routes,
		};
	}
	return { version: 1, hosts };
}

/**
 * Load + validate the controller-local cluster routing config from disk.
 * @throws {RoutingError} CONFIG_INVALID on missing/invalid file
 */
export function loadClusterConfig(path = defaultClusterRoutingPath()) {
	let raw;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		throw new RoutingError(
			"CONFIG_INVALID",
			`cannot read cluster routing config at ${path}`,
			{ path, cause: String(error?.message ?? error) },
		);
	}
	let data;
	try {
		data = JSON.parse(raw);
	} catch (error) {
		throw new RoutingError(
			"CONFIG_INVALID",
			`cluster routing config at ${path} is not valid JSON`,
			{ path, cause: String(error?.message ?? error) },
		);
	}
	return validateClusterConfig(data);
}

/**
 * Capability contract check for ONE task kind on ONE host. Returns the list
 * of missing capabilities (empty array = host can take the task kind).
 */
export function missingHostCapabilities(host, taskKind) {
	const required = HOST_CAPABILITIES[taskKind];
	if (!required) {
		throw new RoutingError(
			"CONFIG_INVALID",
			`unknown task kind "${taskKind}"`,
			{
				taskKind,
			},
		);
	}
	return required.filter((cap) => !host.capabilities.includes(cap));
}

/**
 * Resolve a route for (hostId, MODEL_CLASS) from a validated cluster config
 * against THAT host's inventory. The caller is responsible for fetching the
 * remote daemon's list_providers/list_models before calling this.
 *
 * @param {object} cluster validated cluster config
 * @param {string} hostId
 * @param {string} modelClass
 * @param {object} inventory host inventory {providers, models}
 * @param {{strict?: boolean, taskKind?: "writer"|"reviewer"}} [options]
 * @throws {RoutingError} HOST_ROUTE_UNAVAILABLE | CONFIG_INVALID | delegate errors
 */
export function resolveClusterRoute(
	cluster,
	hostId,
	modelClass,
	inventory,
	options = {},
) {
	const host = cluster.hosts[hostId];
	if (!host) {
		throw new RoutingError(
			"HOST_ROUTE_UNAVAILABLE",
			`cluster routing config has no host "${hostId}"`,
			{ hostId },
		);
	}
	if (options.taskKind) {
		const missing = missingHostCapabilities(host, options.taskKind);
		if (missing.length > 0) {
			throw new RoutingError(
				"HOST_ROUTE_UNAVAILABLE",
				`host "${hostId}" lacks capabilities for ${options.taskKind}: ${missing.join(", ")}`,
				{ hostId, taskKind: options.taskKind, missing },
			);
		}
	}
	const resolved = resolveRoute(
		{ hostId, routes: host.routes },
		modelClass,
		inventory,
		{ strict: options.strict === true },
	);
	return {
		hostId,
		connection: host.connection,
		...resolved,
	};
}

// ---------------------------------------------------------------------------
// Composition — mirrors Paseo resolveRequiredProviderModel (split FIRST "/")
// ---------------------------------------------------------------------------

/**
 * Split a `<provider>/<model>` value at the FIRST slash, exactly like Paseo
 * (server/agent/mcp-shared.js resolveRequiredProviderModel). Model IDs may
 * contain further slashes (e.g. openrouter/vendor/model-name).
 */
export function splitProviderModel(value) {
	const input = String(value).trim();
	const slashIndex = input.indexOf("/");
	if (slashIndex <= 0 || slashIndex === input.length - 1) {
		throw new RoutingError(
			"CONFIG_INVALID",
			`"${value}" must be <provider>/<model>`,
			{ value },
		);
	}
	return {
		provider: input.slice(0, slashIndex).trim(),
		model: input.slice(slashIndex + 1).trim(),
	};
}

/**
 * Compose the exact value for create_agent.provider.
 * "pi-peer" + "openrouter/vendor/model-name" → "pi-peer/openrouter/vendor/model-name"
 * @throws {RoutingError} CONFIG_INVALID if paseoProvider/model are malformed
 */
export function composeProviderModel(paseoProvider, model) {
	if (!ROLE_PROVIDERS.includes(paseoProvider)) {
		throw new RoutingError(
			"CONFIG_INVALID",
			`paseoProvider "${paseoProvider}" is not a durable role profile`,
			{ paseoProvider },
		);
	}
	const trimmed = String(model).trim();
	// Model segments must be non-empty on BOTH sides of every slash chain;
	// splitProviderModel rejects "<pi-provider>/" and "/<model-id>" forms.
	// Claude ids carry no provider segment, so they are checked by shape instead.
	validateModelForFamily(
		providerFamily(paseoProvider),
		trimmed,
		(message, details) => new RoutingError("CONFIG_INVALID", message, details),
	);
	if (trimmed.endsWith("/")) {
		throw new RoutingError(
			"CONFIG_INVALID",
			`model "${model}" has an empty trailing segment`,
			{ model },
		);
	}
	return `${paseoProvider}/${trimmed}`;
}

// ---------------------------------------------------------------------------
// Route resolution against a real inventory
// ---------------------------------------------------------------------------

/**
 * Normalize one model entry from either inventory shape. Exported so the
 * `paseo-team` CLI (which feeds the routing form its model suggestions) reads
 * an inventory through the SAME parser as the route resolver — a second,
 * hand-rolled reader is how the form and preflight would drift apart again.
 */
export function normalizeModelEntry(entry) {
	if (typeof entry !== "object" || entry === null) return null;
	const id = entry.id ?? entry.model;
	if (typeof id !== "string" || id.trim() === "") return null;
	// Accept both shapes: Paseo MCP list_models (thinkingOptions: [{id}...])
	// and Paseo CLI --json (thinkingOptionIds: ["off",...]).
	let thinkingOptionIds = null;
	if (Array.isArray(entry.thinkingOptionIds)) {
		thinkingOptionIds = entry.thinkingOptionIds.filter(
			(v) => typeof v === "string",
		);
	} else if (Array.isArray(entry.thinkingOptions)) {
		thinkingOptionIds = entry.thinkingOptions
			.map((option) => (typeof option === "string" ? option : option?.id))
			.filter((v) => typeof v === "string");
	}
	// Tri-state, and the three states are genuinely different questions:
	//
	//   true  — the daemon says this model has extended thinking;
	//   false — the daemon says it does NOT (an explicit `thinkingSupported:
	//           false`, or an option list that is present and EMPTY, which is
	//           the same statement written as data);
	//   null  — the daemon said nothing, so we do not know.
	//
	// Collapsing false into null is what made the cheapest available model
	// unroutable: a Haiku-class seat that genuinely has no extended thinking
	// was read as "unverifiable" and refused, even for `thinking: off`, which
	// such a model satisfies by construction. Only `null` is unverifiable.
	let thinkingSupported = null;
	if (typeof entry.thinkingSupported === "boolean") {
		thinkingSupported = entry.thinkingSupported;
	} else if (thinkingOptionIds !== null) {
		thinkingSupported = thinkingOptionIds.length > 0;
	}
	return { id: id.trim(), thinkingOptionIds, thinkingSupported };
}

/** Provider status strings we accept as "available". Anything else present
 * in the inventory (e.g. "unavailable", "error", "unauthenticated") means
 * the provider is up but NOT usable — strict validation must not pass it.
 * Exported so preflight.mjs applies the SAME health predicate as the route
 * resolver (one source of truth for provider health). */
export const PROVIDER_OK_STATUSES = new Set([
	"available",
	"ok",
	"enabled",
	"active",
]);

function normalizeProviderEntry(entry) {
	if (typeof entry !== "object" || entry === null) return null;
	const id = entry.id ?? entry.provider;
	if (typeof id !== "string" || id.trim() === "") return null;
	// MCP list_providers: { id, enabled: boolean, status? }
	// CLI provider ls --json: { provider, status: "available", enabled: "Enabled" }
	const enabled =
		// Fail-closed: a missing or mistyped `enabled` field means the provider
		// is UNVERIFIABLE, and unverifiable is not usable.
		entry.enabled === true ||
		(typeof entry.enabled === "string" &&
			entry.enabled.toLowerCase() === "enabled");
	const status =
		typeof entry.status === "string" ? entry.status.toLowerCase() : null;
	return { id: id.trim(), enabled, status };
}

/**
 * Build a resolver inventory-provider array from raw `paseo provider ls
 * --json` entries (or MCP list_providers entries). Status MUST round-trip
 * into the resolver — preflight once rebuilt this mapping inline and dropped
 * the field, which let a provider reporting "error" still pass a strict
 * preflight. Centralize the mapping so every caller (single-host routes,
 * cluster-local routes, live remote preflight) carries status through.
 *
 * @param {unknown} entries raw provider-ls entries
 * @returns {{id: string, enabled: boolean, status?: string}[]}
 */
export function buildProviderInventory(entries) {
	if (!Array.isArray(entries)) return [];
	return entries
		.map(normalizeProviderEntry)
		.filter(Boolean)
		.map((p) => ({
			id: p.id,
			enabled: p.enabled,
			...(p.status !== null ? { status: p.status } : {}),
		}));
}

/**
 * Resolve one MODEL_CLASS against the routing config and real host inventory.
 *
 * @param {object} config validated routing config
 * @param {string} modelClass one of MODEL_CLASSES
 * @param {object} inventory { providers: [...], models: [...] } as returned by
 *   list_providers / list_models (Paseo MCP or CLI --json shapes)
 * @param {{strict?: boolean}} [options] strict mode treats thinking
 *   "unverifiable" as a failure (no warn-as-pass) and requires provider
 *   status to be explicitly healthy when a status field is present.
 * @returns {{paseoProvider: string, model: string, thinking: string,
 *            createAgentProvider: string,
 *            thinkingValidated: "exact"|"off"|"unsupported"|"unverifiable"}}
 * @throws {RoutingError} ROLE_PROVIDER_UNAVAILABLE | MODEL_UNAVAILABLE |
 *   THINKING_OPTION_UNAVAILABLE | HOST_ROUTE_UNAVAILABLE
 */
export function resolveRoute(config, modelClass, inventory, options = {}) {
	const strict = options.strict === true;
	if (!MODEL_CLASSES.includes(modelClass)) {
		throw new RoutingError(
			"HOST_ROUTE_UNAVAILABLE",
			`unknown MODEL_CLASS "${modelClass}"`,
			{ modelClass },
		);
	}
	const route = config.routes[modelClass];
	if (!route) {
		throw new RoutingError(
			"HOST_ROUTE_UNAVAILABLE",
			`routing config for host ${config.hostId} has no route for ${modelClass}`,
			{ hostId: config.hostId, modelClass },
		);
	}

	const providers = (inventory?.providers ?? [])
		.map(normalizeProviderEntry)
		.filter(Boolean);
	const provider = providers.find((p) => p.id === route.paseoProvider);
	if (!provider || !provider.enabled) {
		throw new RoutingError(
			"ROLE_PROVIDER_UNAVAILABLE",
			`role provider "${route.paseoProvider}" is ${provider ? "disabled" : "not registered"} on this daemon`,
			{ paseoProvider: route.paseoProvider, modelClass },
		);
	}
	if (provider.status !== null && !PROVIDER_OK_STATUSES.has(provider.status)) {
		throw new RoutingError(
			"ROLE_PROVIDER_UNAVAILABLE",
			`role provider "${route.paseoProvider}" reports status "${provider.status}" (expected one of: ${[...PROVIDER_OK_STATUSES].join(", ")})`,
			{
				paseoProvider: route.paseoProvider,
				modelClass,
				status: provider.status,
			},
		);
	}

	const models = (inventory?.models ?? [])
		.map(normalizeModelEntry)
		.filter(Boolean);
	const modelEntry = models.find((m) => m.id === route.model);
	if (!modelEntry) {
		throw new RoutingError(
			"MODEL_UNAVAILABLE",
			`model "${route.model}" is not in the inventory of provider "${route.paseoProvider}" (${models.length} models listed)`,
			{ paseoProvider: route.paseoProvider, model: route.model, modelClass },
		);
	}

	let thinkingValidated = "exact";
	if (modelEntry.thinkingSupported === false) {
		// KNOWN not to support extended thinking. That is a fact, not a gap, so
		// it must not be spelled "unverifiable": the only level such a model can
		// run is NO_THINKING_LEVEL, and asking for it is fully verified.
		if (route.thinking !== NO_THINKING_LEVEL) {
			throw new RoutingError(
				"THINKING_OPTION_UNAVAILABLE",
				`model "${route.model}" reports that it does not support extended thinking — route it with thinking "${NO_THINKING_LEVEL}" (requested "${route.thinking}")`,
				{ model: route.model, thinking: route.thinking, modelClass },
			);
		}
		thinkingValidated = "unsupported";
	} else if (modelEntry.thinkingOptionIds === null) {
		if (route.thinking === NO_THINKING_LEVEL) {
			// Nothing published, but nothing to publish either: "off" is the
			// absence of extended thinking, so an empty inventory satisfies it in
			// every case an inventory could have. Strict mode included — there is
			// no fact here that could later turn out to be false.
			thinkingValidated = "off";
		} else if (strict) {
			throw new RoutingError(
				"THINKING_OPTION_UNAVAILABLE",
				`model "${route.model}" exposes no thinking option list — thinking "${route.thinking}" is UNVERIFIABLE (strict mode: unverifiable is not a pass)`,
				{ model: route.model, thinking: route.thinking, modelClass },
			);
		} else {
			// Non-reasoning models may carry no option list; only the default is safe.
			thinkingValidated = "unverifiable";
		}
	} else if (!modelEntry.thinkingOptionIds.includes(route.thinking)) {
		throw new RoutingError(
			"THINKING_OPTION_UNAVAILABLE",
			`thinking "${route.thinking}" is not offered by model "${route.model}" (offered: ${modelEntry.thinkingOptionIds.join(", ")})`,
			{
				model: route.model,
				thinking: route.thinking,
				offered: modelEntry.thinkingOptionIds,
			},
		);
	}

	return {
		paseoProvider: route.paseoProvider,
		model: route.model,
		thinking: route.thinking,
		createAgentProvider: composeProviderModel(route.paseoProvider, route.model),
		thinkingValidated,
	};
}

// ---------------------------------------------------------------------------
// Shared remote-endpoint helpers (used by preflight.mjs live remote checks)
// ---------------------------------------------------------------------------

/**
 * Parse-based validation for a Paseo remote endpoint value. Character
 * whitelists were too blunt (they rejected the documented
 * `tcp://host:6767?ssl=true&password=...` form because of the `&`), so we
 * validate structurally per supported scheme:
 *   - pairing offer URL:  https://app.paseo.sh/#offer=<token>
 *   - tcp URI:            tcp://host:port[?query...]   (query params allowed)
 *   - any https:// URL with a hostname
 *   - bare host:port      (e.g. "192.168.1.20:6767")
 * Whitespace, quotes and shell metacharacters are always refused — the value
 * travels inside a quoted argv on Windows and must never break out of it.
 */
export function validateRemoteEndpoint(value) {
	if (typeof value !== "string" || value.length === 0 || value.length > 4096) {
		return false;
	}
	if (/[\s"'`;<>|\\$`{}()[\]]/.test(value)) return false;
	if (value.startsWith("https://app.paseo.sh/#offer=")) {
		return /^https:\/\/app\.paseo\.sh\/#offer=[A-Za-z0-9._~+/-]+$/.test(value);
	}
	if (value.startsWith("tcp://")) {
		let url;
		try {
			url = new URL(value);
		} catch {
			return false;
		}
		return Boolean(url.hostname) && Boolean(url.port);
	}
	if (value.startsWith("https://")) {
		try {
			return Boolean(new URL(value).hostname);
		} catch {
			return false;
		}
	}
	return /^[A-Za-z0-9.-]+:\d+$/.test(value);
}

/**
 * Cache key for a per-daemon model inventory lookup. `scope` is the host
 * identity (host id or endpoint) — caching by role-provider name ALONE
 * silently mixes inventories between distinct daemons that happen to run
 * the same role provider (e.g. two remote hosts both serving "pi-peer").
 */
export function modelsCacheKey(scope, provider) {
	return `${scope}\0${provider}`;
}

/**
 * cmd.exe %VAR% expansion risk: a value with TWO OR MORE `%` characters can
 * be expanded/re-written by cmd.exe BEFORE paseo receives it, even when the
 * value is passed as one quoted argv element (% expansion happens at parse
 * time). A single literal `%` (e.g. one percent-encoded character in a
 * password) is safe because expansion requires a closing `%`.
 * On Windows, preflight refuses such endpoints outright rather than trying
 * to escape them — switch the endpoint to a pairing offer or run the
 * controller on a non-cmd host.
 */
export function cmdPercentExpansionRisk(value) {
	return (String(value).match(/%/g) ?? []).length >= 2;
}

// ---------------------------------------------------------------------------
// Observed-value verification (fail-closed)
// ---------------------------------------------------------------------------

/**
 * Verify an agent's observed runtime info against what was requested.
 * Source: get_agent_status → snapshot.runtimeInfo {model, thinkingOptionId}.
 *
 * @param {{paseoProvider: string, model: string, thinking: string}} requested
 * @param {{provider?: string, model?: string|null, thinkingOptionId?: string|null}|null|undefined} runtimeInfo
 * @returns {{ok: true, requested: object, observed: object}}
 * @throws {RoutingError} MODEL_RESOLUTION_MISMATCH — also when runtimeInfo is
 *   missing/unverifiable (fail-closed: unverifiable is NOT a pass). The remote
 *   startup orchestrator must distinguish this final verifier from its bounded
 *   pre-identity startup-unavailable state before taking lifecycle action.
 */
export function verifyObserved(requested, runtimeInfo) {
	const mismatch = (message, observed) =>
		new RoutingError("MODEL_RESOLUTION_MISMATCH", message, {
			requested: {
				paseoProvider: requested.paseoProvider,
				model: requested.model,
				thinking: requested.thinking,
			},
			observed,
		});

	if (runtimeInfo === null || runtimeInfo === undefined) {
		throw mismatch(
			"runtimeInfo is unavailable — observed model cannot be verified (unverifiable is not a pass)",
			null,
		);
	}
	const observed = {
		provider: runtimeInfo.provider ?? null,
		model: runtimeInfo.model ?? null,
		thinking: runtimeInfo.thinkingOptionId ?? null,
	};
	if (observed.model === null) {
		throw mismatch(
			"runtimeInfo.model is missing — cannot verify observed model",
			observed,
		);
	}
	if (observed.thinking === null) {
		throw mismatch(
			"runtimeInfo.thinkingOptionId is missing — cannot verify observed thinking level",
			observed,
		);
	}
	if (observed.model !== requested.model) {
		throw mismatch(
			`observed model "${observed.model}" != requested "${requested.model}"`,
			observed,
		);
	}
	if (observed.thinking !== requested.thinking) {
		throw mismatch(
			`observed thinking "${observed.thinking}" != requested "${requested.thinking}" (an unsupported level may have been clamped by pi — check the model's thinkingLevelMap)`,
			observed,
		);
	}
	if (
		observed.provider !== null &&
		observed.provider !== requested.paseoProvider
	) {
		throw mismatch(
			`observed provider "${observed.provider}" != requested role profile "${requested.paseoProvider}"`,
			observed,
		);
	}
	return { ok: true, requested, observed };
}

// ---------------------------------------------------------------------------
// Minimal CLI — so a Lead (or human) can resolve/validate without reading
// JSON by hand. Usage:
//   node scripts/model-routing.mjs validate [--routes <path>]
//   node scripts/model-routing.mjs resolve --class <MODEL_CLASS> [--routes <path>] [--json]
// Exit code 0 ok, 1 config error, 2 route unavailable (structured stdout).
// ---------------------------------------------------------------------------

/** Compare canonical filesystem paths so macOS /var aliases work. */
export function isMainModule(entry = process.argv[1], moduleUrl = import.meta.url) {
	return isEntrypoint(moduleUrl, entry);
}

if (isMainModule()) {
	const argv = process.argv.slice(2);
	const command = argv[0];
	const optArg = (name) => {
		const i = argv.indexOf(name);
		return i >= 0 && argv[i + 1] ? argv[i + 1] : undefined;
	};
	const asJson = argv.includes("--json");
	const emit = (payload, code) => {
		console.log(JSON.stringify(payload, null, 2));
		process.exit(code);
	};
	const failOut = (error, code) => {
		const payload =
			error instanceof RoutingError
				? {
						ok: false,
						code: error.code,
						message: error.message,
						details: error.details,
					}
				: {
						ok: false,
						code: "ERROR",
						message: String(error?.message ?? error),
					};
		if (asJson) emit(payload, code);
		console.error(payload.message);
		process.exit(code);
	};
	try {
		const config = loadRoutingConfig(optArg("--routes"));
		if (command === "validate") {
			emit(
				{
					ok: true,
					hostId: config.hostId,
					classes: Object.keys(config.routes),
				},
				0,
			);
		} else if (command === "resolve") {
			const modelClass = optArg("--class");
			if (!modelClass)
				failOut(new Error("resolve requires --class <MODEL_CLASS>"), 2);
			// Inventory must come from the caller (list_models). Without it we can
			// only emit the configured request; correctness verification stays
			// with the Lead's list_models comparison + verifyObserved.
			const route = config.routes[modelClass];
			if (!route) {
				failOut(
					new RoutingError(
						"HOST_ROUTE_UNAVAILABLE",
						`no route for ${modelClass} on host ${config.hostId}`,
					),
					2,
				);
			}
			emit(
				{
					ok: true,
					hostId: config.hostId,
					modelClass,
					paseoProvider: route.paseoProvider,
					model: route.model,
					thinking: route.thinking,
					createAgentProvider: composeProviderModel(
						route.paseoProvider,
						route.model,
					),
					note: "Verify against list_models + get_agent_status runtimeInfo before/during create_agent.",
				},
				0,
			);
		} else {
			console.error(
				"usage: model-routing.mjs validate|resolve --class <MODEL_CLASS> [--routes <path>] [--json]",
			);
			process.exit(64);
		}
	} catch (error) {
		failOut(
			error,
			error instanceof RoutingError && error.code !== "CONFIG_INVALID" ? 2 : 1,
		);
	}
}
