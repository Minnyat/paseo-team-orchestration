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

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isEntrypoint, teamConfigDir } from "./lib-common.mjs";

/**
 * The REQUIRED classes: every route file must carry all five. Kept under its
 * old name because every loop that walks "the classes a host must route"
 * (preflight, the routing form, the resolver CLI) means exactly these.
 */
export const MODEL_CLASSES = Object.freeze([
	"MONITOR_ECONOMY",
	"FAST_READ",
	"CODING_MEDIUM",
	"REASONING_HIGH",
	"REVIEW_HIGH",
]);

/**
 * Classes a route file MAY carry. They exist so the two create_agent flows that
 * do not seat a Peer — a Lead seating its Supervisor, a Supervisor recovering a
 * Lead — have a route to be checked against. Optional so every route file
 * written before them still validates; preflight warns while they are absent,
 * and the create_agent gate refuses the flow that needs one (it never borrows
 * another class's route — that silent substitution is what this pack exists to
 * prevent).
 */
export const OPTIONAL_MODEL_CLASSES = Object.freeze([
	"SUPERVISOR_GOVERNANCE",
	"LEAD_RECOVERY",
]);

export const ALL_MODEL_CLASSES = Object.freeze([
	...MODEL_CLASSES,
	...OPTIONAL_MODEL_CLASSES,
]);

/**
 * The role an optional class must route to. A SUPERVISOR_GOVERNANCE route that
 * named a peer provider could never satisfy the gate, so it is refused where the
 * author made the mistake — at validation — instead of at the first seating.
 */
export const CLASS_REQUIRED_ROLE = Object.freeze({
	SUPERVISOR_GOVERNANCE: "supervisor",
	LEAD_RECOVERY: "lead",
});

/**
 * Label a Lead or Supervisor puts on every create_agent to declare which class
 * it routed from. Mirrored in policy-core.ts (MODEL_CLASS_LABEL), locked by
 * test/model-routing.test.mjs.
 */
export const MODEL_CLASS_LABEL = "team.model-class";

/** The one explicit opt-out of the create_agent route gate. */
export const ROUTE_ENFORCE_ENV = "PASEO_TEAM_ROUTE_ENFORCE";

/**
 * RUNTIME DESCRIPTORS — the single source of every per-runtime fact this
 * module and its consumers key off. The pack runs the SAME three roles on more
 * than one coding agent; what differs between agents is captured here ONCE, so
 * teaching the pack a new coding agent is adding one entry, not hunting down a
 * dozen `family === "claude"` branches scattered across the tree.
 *
 * Insertion order IS the pack's canonical family order (RUNTIME_FAMILIES, and
 * through it ROLE_PROVIDERS) — test/model-routing.test.mjs pins it, so a new
 * entry goes at the END unless a reorder is intended.
 *
 * `policy-core.ts` keeps its OWN descriptor for the authority facts it owns
 * (permission modes), deliberately not importing this file because it loads
 * inside pi's runtime; the cross-check test locks the families and the
 * model-shape facts the two share.
 */
export const RUNTIME_DESCRIPTORS = Object.freeze({
	pi: Object.freeze({
		family: "pi",
		/** Human label for the UI's family badge and dropdowns. */
		label: "Pi",
		/** The CLI whose presence means this runtime is installed on a host. */
		cli: "pi",
		/**
		 * Thinking levels for this family. `minimal` exists only on pi and
		 * `ultracode` only on Claude, so a single union would silently accept a
		 * level the target runtime clamps away. Verify against the real inventory
		 * with `paseo provider models <role-provider> --json`.
		 */
		thinkingLevels: Object.freeze([
			"off",
			"minimal",
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
		]),
		/**
		 * Whether a seat of this family has permission modes at all. pi declares
		 * none (AvailableModes: []), so a --mode passed to it is an error; only a
		 * moded family gets a default mode at create time. Mirrored — and locked
		 * by test/model-routing.test.mjs — against policy-core's descriptor, which
		 * owns the mode VALUES themselves.
		 */
		hasPermissionModes: false,
		model: Object.freeze({
			/**
			 * pi model ids carry their own provider segment
			 * ("<pi-provider>/<model-id>", and the model id may itself contain
			 * slashes — Paseo splits at the FIRST slash only), so the rule is "must
			 * carry a provider segment", never "exactly two segments".
			 */
			carriesProvider: true,
			/** Prefix shown in "how to write it" hints and error messages. */
			hintPrefix: "<pi-provider>/",
			/** Shorthand for the whole reference shape, for hints. */
			hint: "<pi-provider>/<model-id>",
			/**
			 * Minimum segment count of a full route string
			 * "<family>-<role>/<pi-provider>/<model-id>". Rejecting a bare
			 * "pi-supervisor" that lets the daemon pick a default model is an
			 * authority check in policy-core; the count lives here so both agree.
			 */
			minRouteSegments: 3,
		}),
	}),
	claude: Object.freeze({
		family: "claude",
		label: "Claude",
		cli: "claude",
		thinkingLevels: Object.freeze([
			"off",
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
			"ultracode",
		]),
		hasPermissionModes: true,
		model: Object.freeze({
			/** Claude model ids are a single segment ("claude-opus-5"); a slash
			 * there means the author pasted a pi-shaped value by mistake. */
			carriesProvider: false,
			hintPrefix: "",
			hint: "id trần (claude-opus-5)",
			/** Route string is "<family>-<role>/<model-id>": two segments. */
			minRouteSegments: 2,
		}),
	}),
});

export const RUNTIME_FAMILIES = Object.freeze(
	Object.keys(RUNTIME_DESCRIPTORS),
);
export const TEAM_ROLES = Object.freeze(["supervisor", "lead", "peer"]);

/**
 * The descriptor for a family, or null when the name is not a known runtime.
 * Every consumer that used to branch on `family === "..."` asks this instead,
 * so a new runtime reaches all of them the moment its descriptor exists.
 */
export function runtimeDescriptor(family) {
	return RUNTIME_DESCRIPTORS[String(family ?? "")] ?? null;
}

/**
 * Thinking levels are per RUNTIME FAMILY, derived from the descriptors so the
 * table cannot drift from them. Kept as an exported map because it is the
 * `optionsBy` source the routing form paints from.
 */
export const THINKING_LEVELS_BY_FAMILY = Object.freeze(
	Object.fromEntries(
		Object.entries(RUNTIME_DESCRIPTORS).map(([family, d]) => [
			family,
			d.thinkingLevels,
		]),
	),
);

/** Kept for compatibility: the pi levels, which predate the Claude family. */
export const THINKING_LEVELS = THINKING_LEVELS_BY_FAMILY.pi;

/**
 * The one level that means "no extended thinking". It is in EVERY family's
 * list, and it is the level a model without extended thinking runs at whether
 * or not anybody asked for it — which is why a model that publishes no options
 * can still be routed at exactly this level and no other.
 */
export const NO_THINKING_LEVEL = "off";

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

/** "claude-peer" → "peer"; null when the name is not a role provider. */
export function providerRole(paseoProvider) {
	const family = providerFamily(paseoProvider);
	if (!family) return null;
	return String(paseoProvider).trim().slice(family.length + 1);
}

/**
 * Model reference shape per family, resolved through the descriptor's
 * `model.carriesProvider` rather than a hard-coded family name — the whole
 * point of the table is that this function does not grow a branch per runtime.
 *
 * A provider-carrying family (pi) requires "<provider>/<model-id>"; a
 * bare-id family (claude) rejects a slash as a pi-shaped value pasted by
 * mistake. An unknown family is a fail-closed error, never a silent pass.
 */
export function validateModelForFamily(family, model, fail, context = {}) {
	const trimmed = String(model).trim();
	const descriptor = runtimeDescriptor(family);
	if (!descriptor) {
		throw fail(`unknown runtime family "${family}"`, { ...context, family });
	}
	if (!descriptor.model.carriesProvider) {
		if (trimmed.includes("/")) {
			throw fail(
				`model "${trimmed}" must be a bare ${descriptor.label} model id (no "/"), e.g. claude-opus-5`,
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
		throw fail(
			`model "${trimmed}" must be in ${descriptor.model.hint} form`,
			{ ...context, model: trimmed },
		);
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
	"ROUTE_DISABLED",
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

// ---------------------------------------------------------------------------
// Model switch — "this model of this tool is off" (out of credit, outage)
// ---------------------------------------------------------------------------
//
// One list per route file (per host in a cluster file): `disabledModels`. An
// entry is "<family>/<model>" — the runtime family (pi, claude, ...) and the
// model id exactly as a route spells it ("pi/Minnyat/gpt-5.5",
// "claude/claude-opus-5") — or ends in "/*" to switch off everything under a
// prefix ("pi/Minnyat/*" = the whole endpoint). The role is deliberately not part
// of the key: a model that is out of credit is out of credit for the Lead and
// the Peer alike. A route (or job executor) on such a model is refused/skipped,
// never moved to another model.

/** The key a route's model is switched with. */
export function modelSwitchKey(paseoProvider, model) {
	return `${providerFamily(paseoProvider)}/${model}`;
}

/** Why `entry` is not a valid disabledModels entry, or null. */
export function disabledModelProblem(entry) {
	if (typeof entry !== "string" || entry !== entry.trim() || entry === "") {
		return "must be a non-empty string with no surrounding whitespace";
	}
	const slash = entry.indexOf("/");
	const family = slash < 0 ? entry : entry.slice(0, slash);
	const rest = slash < 0 ? "" : entry.slice(slash + 1);
	if (!RUNTIME_FAMILIES.includes(family)) {
		return `must start with a runtime family (${RUNTIME_FAMILIES.join(", ")}) and a slash, e.g. "pi/<provider>/<model>"`;
	}
	if (rest === "") return `needs a model (or "*" / "<prefix>/*") after "${family}/"`;
	if (/\s/u.test(rest)) return "must not contain whitespace";
	// "pi/*" switches off a whole tool (every pi model); "pi/Minnyat/*" one endpoint.
	if (rest !== "*" && rest.includes("*") && !(rest.endsWith("/*") && !rest.slice(0, -2).includes("*"))) {
		return 'may use "*" only as a trailing "/*" (e.g. "pi/Minnyat/*")';
	}
	return null;
}

/** Is `paseoProvider`'s `model` covered by an entry of `disabledModels`? */
export function isModelDisabled(disabledModels, paseoProvider, model) {
	if (!Array.isArray(disabledModels) || disabledModels.length === 0) return false;
	const key = modelSwitchKey(paseoProvider, model);
	return disabledModels.some((entry) =>
		entry.endsWith("/*") ? key.startsWith(entry.slice(0, -1)) : key === entry,
	);
}

/** Validate `disabledModels` (absent is fine). Returns a fresh de-duplicated array, or undefined. */
function validateDisabledModels(value, fail) {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) throw fail("disabledModels must be an array of strings", {});
	for (const entry of value) {
		const problem = disabledModelProblem(entry);
		if (problem) throw fail(`disabledModels entry ${JSON.stringify(entry)} ${problem}`, { entry });
	}
	return [...new Set(value)];
}

/**
 * The options of a class route, primary first: `[{index, paseoProvider, model,
 * thinking, enabled}]`. A class is usable when ANY option is usable; which one a
 * seat uses is the Lead's explicit choice, checked by the gate — nothing here (or
 * anywhere) picks one on its behalf.
 */
export function routeOptions(route) {
	if (route === null || typeof route !== "object") return [];
	const toOption = (option, index) => ({
		index,
		paseoProvider: option.paseoProvider,
		model: option.model,
		thinking: option.thinking,
		enabled: option.enabled !== false,
	});
	return [toOption(route, 0), ...(Array.isArray(route.alternates) ? route.alternates : []).map((option, i) => toOption(option, i + 1))];
}

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
		if (!ALL_MODEL_CLASSES.includes(modelClass)) {
			throw fail(`unknown MODEL_CLASS "${modelClass}"`, { modelClass });
		}
		if (typeof route !== "object" || route === null) {
			throw fail(`route for ${modelClass} must be an object`);
		}
		// One option = a tool (runtime family + role) running a model at a thinking
		// level. The route's own fields are option 0 (the primary); `alternates` are
		// further options of the SAME class. Every option is validated exactly the
		// same way, and all of them seat the same role.
		const validateOption = (option, where) => {
			if (typeof option !== "object" || option === null || Array.isArray(option)) {
				throw fail(`${where} must be an object`, { modelClass });
			}
			const { paseoProvider, model, thinking } = option;
			if (!ROLE_PROVIDERS.includes(paseoProvider)) {
				throw fail(
					`${where}: paseoProvider "${paseoProvider}" is not one of the durable role profiles (${ROLE_PROVIDERS.join(", ")})`,
					{ modelClass, paseoProvider },
				);
			}
			const requiredRole = CLASS_REQUIRED_ROLE[modelClass];
			if (requiredRole && providerRole(paseoProvider) !== requiredRole) {
				throw fail(
					`${where}: paseoProvider "${paseoProvider}" must be a ${requiredRole} role provider (${ROLE_PROVIDERS.filter((name) => providerRole(name) === requiredRole).join(" or ")}) — this class seats a ${requiredRole}, nothing else`,
					{ modelClass, paseoProvider, requiredRole },
				);
			}
			if (typeof model !== "string" || model.trim() === "") {
				throw fail(`${where}: model must be a non-empty string`);
			}
			const family = providerFamily(paseoProvider);
			const trimmedModel = validateModelForFamily(
				family,
				model,
				(message, details) => fail(`${where}: ${message}`, details),
				{ modelClass },
			);
			const levels = THINKING_LEVELS_BY_FAMILY[family];
			if (!levels.includes(thinking)) {
				throw fail(
					`${where}: thinking "${thinking}" is not a ${family} thinking level (${levels.join(", ")})`,
					{ modelClass, thinking, family },
				);
			}
			// `enabled` is the quick off switch: a disabled option keeps its model and
			// thinking (so turning it back on restores exactly what was there) but is
			// never offered. Only `false` is carried; absent means on.
			if (option.enabled !== undefined && typeof option.enabled !== "boolean") {
				throw fail(`${where}: enabled must be true or false`, { modelClass });
			}
			return {
				paseoProvider,
				model: trimmedModel,
				thinking,
				...(option.enabled === false ? { enabled: false } : {}),
			};
		};
		const primary = validateOption(route, `route ${modelClass}`);
		let alternates;
		if (route.alternates !== undefined) {
			if (!Array.isArray(route.alternates)) {
				throw fail(`route ${modelClass}: alternates must be an array of options`, { modelClass });
			}
			alternates = route.alternates.map((option, index) => validateOption(option, `route ${modelClass} alternates[${index}]`));
			// One class seats one ROLE: a Peer class never offers a Supervisor option (the
			// gate would let a Lead seat a governance seat from it). The tool (family) may differ.
			alternates.forEach((option, index) => {
				if (providerRole(option.paseoProvider) !== providerRole(primary.paseoProvider)) {
					throw fail(
						`route ${modelClass} alternates[${index}]: paseoProvider "${option.paseoProvider}" is a ${providerRole(option.paseoProvider)} provider, but this class seats a ${providerRole(primary.paseoProvider)} (its primary is "${primary.paseoProvider}") — every option of a class seats the same role`,
						{ modelClass },
					);
				}
			});
			const seen = new Set([`${primary.paseoProvider}|${primary.model}|${primary.thinking}`]);
			alternates.forEach((option, index) => {
				const key = `${option.paseoProvider}|${option.model}|${option.thinking}`;
				if (seen.has(key)) {
					throw fail(`route ${modelClass} alternates[${index}] repeats an option already listed (${option.paseoProvider}/${option.model} at ${option.thinking})`, { modelClass });
				}
				seen.add(key);
			});
		}
		validated[modelClass] = { ...primary, ...(alternates && alternates.length > 0 ? { alternates } : {}) };
	}
	const disabledModels = validateDisabledModels(data.disabledModels, fail);
	return {
		hostId: data.hostId.trim(),
		routes: validated,
		...(disabledModels && disabledModels.length > 0 ? { disabledModels } : {}),
	};
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
// cluster-routing.local.json, in the pack's config directory, is the SINGLE
// controller-local
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
			disabledModels: raw.disabledModels,
		});
		hosts[hostId] = {
			connection: validatedConnection,
			required,
			capabilities,
			limits: { writers, readers },
			routes: validated.routes,
			...(validated.disabledModels ? { disabledModels: validated.disabledModels } : {}),
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
		{ strict: options.strict === true, ...(options.option === undefined ? {} : { option: options.option }) },
	);
	return {
		hostId,
		connection: host.connection,
		...resolved,
	};
}

// ---------------------------------------------------------------------------
// The LOCAL daemon's route table — what the create_agent gate compares against
// ---------------------------------------------------------------------------
//
// A create_agent made through MCP always lands on the local daemon (MCP is
// local-only, see skills/paseo-team-lead/SKILL.md "The hard rule"), so the gate
// needs exactly one host's routes: this one. Two files can hold them, and the
// choice is made here, once, so the Claude hook (in-process) and the Pi adapter
// (through `gate-routes --json`) cannot pick differently.

/**
 * Where the local route table comes from — the file, and inside a cluster file
 * the host — without reading any route. Shared by the gate loader and by
 * `pteam routing set`, which must write the file the gate will read.
 *
 * - cluster-routing.local.json present → it is the single source of truth. Its
 *   one `connection.type: "local"` host is this daemon. None means the cluster
 *   file describes remote hosts only, and the single-host file holds the local
 *   routes; more than one is ambiguous and refused. An INVALID cluster file is
 *   an error, never a reason to read the other file instead.
 * - otherwise model-routing.local.json.
 *
 * @returns {{ok: true, source: "cluster"|"routing", path: string, hostId: string,
 *   routes: object, config: object, shadowed: string|null}
 *   | {ok: false, code: string, message: string, paths: string[]}}
 */
export function loadLocalRouteTable(options = {}) {
	const env = options.env ?? process.env;
	const dir = teamConfigDir(env);
	const routingPath = options.routingPath ?? join(dir, "model-routing.local.json");
	const clusterPath = options.clusterPath ?? join(dir, "cluster-routing.local.json");
	const failed = (code, message, paths) => ({ ok: false, code, message, paths });
	const routingExists = existsSync(routingPath);
	if (existsSync(clusterPath)) {
		let cluster;
		try {
			cluster = loadClusterConfig(clusterPath);
		} catch (error) {
			return failed(
				"CONFIG_INVALID",
				`${withPath(clusterPath, error)} — fix it (pteam routing check) before seating anything; the gate does not fall back to ${routingPath}`,
				[clusterPath],
			);
		}
		const locals = Object.entries(cluster.hosts).filter(
			([, host]) => host.connection.type === "local",
		);
		if (locals.length > 1) {
			return failed(
				"LOCAL_HOST_AMBIGUOUS",
				`${clusterPath} declares ${locals.length} hosts with connection.type "local" (${locals.map(([id]) => id).join(", ")}); exactly one of them can be this daemon — mark the others "remote"`,
				[clusterPath],
			);
		}
		if (locals.length === 1) {
			const [hostId, host] = locals[0];
			return {
				ok: true,
				source: "cluster",
				path: clusterPath,
				hostId,
				routes: host.routes,
				disabledModels: host.disabledModels ?? [],
				config: cluster,
				shadowed: routingExists ? routingPath : null,
			};
		}
		// Zero local hosts: the controller's local routes live in the single-host
		// file, if anywhere.
	}
	if (!routingExists) {
		return failed(
			"ROUTE_FILE_MISSING",
			`no local route file: neither ${routingPath} nor a "local" host in ${clusterPath} — copy config/model-routing.example.json there and fill it in (pteam routing check verifies it)`,
			[routingPath, clusterPath],
		);
	}
	try {
		const config = loadRoutingConfig(routingPath);
		return {
			ok: true,
			source: "routing",
			path: routingPath,
			hostId: config.hostId,
			routes: config.routes,
			disabledModels: config.disabledModels ?? [],
			config,
			shadowed: null,
		};
	} catch (error) {
		return failed(
			"CONFIG_INVALID",
			`${withPath(routingPath, error)} — fix it (pteam routing check) before seating anything`,
			[routingPath],
		);
	}
}

/** A load error that always names the file — a schema error alone does not. */
function withPath(path, error) {
	const message = String(error?.message ?? error);
	return message.includes(path) ? message : `${path}: ${message}`;
}

/**
 * The JSON the gate is handed: the table minus the parsed config object, so
 * the Pi adapter's subprocess and the Claude hook's in-process call produce
 * byte-identical inputs for policy-core.
 */
export function gateRouteTable(options = {}) {
	const table = loadLocalRouteTable(options);
	if (!table.ok) return table;
	const { config: _config, ...rest } = table;
	// A route on a switched-off model carries `modelDisabled` — the gate refuses it
	// with its own code. `enabled` is NOT touched: that is the class's own switch
	// (`routing enable|disable`), and the two must stay separately visible.
	const mark = (option) =>
		isModelDisabled(rest.disabledModels, option.paseoProvider, option.model) ? { ...option, modelDisabled: true } : option;
	const routes = Object.fromEntries(
		Object.entries(rest.routes).map(([modelClass, route]) => [
			modelClass,
			{ ...mark(route), ...(route.alternates ? { alternates: route.alternates.map(mark) } : {}) },
		]),
	);
	return { ...rest, routes };
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
	if (!ALL_MODEL_CLASSES.includes(modelClass)) {
		throw new RoutingError(
			"HOST_ROUTE_UNAVAILABLE",
			`unknown MODEL_CLASS "${modelClass}"`,
			{ modelClass },
		);
	}
	const classRoute = config.routes[modelClass];
	if (!classRoute) {
		throw new RoutingError(
			"HOST_ROUTE_UNAVAILABLE",
			`routing config for host ${config.hostId} has no route for ${modelClass}`,
			{ hostId: config.hostId, modelClass },
		);
	}
	// `options.option` picks one option of the class (0 = the primary, the default).
	const optionIndex = Number.isInteger(options.option) ? options.option : 0;
	const route = routeOptions(classRoute)[optionIndex];
	if (!route) {
		throw new RoutingError(
			"HOST_ROUTE_UNAVAILABLE",
			`the route for ${modelClass} on host ${config.hostId} has no option ${optionIndex}`,
			{ hostId: config.hostId, modelClass, option: optionIndex },
		);
	}

	if (route.enabled === false) {
		throw new RoutingError(
			"ROUTE_DISABLED",
			`${optionIndex === 0 ? `the route for ${modelClass}` : `option ${optionIndex} of ${modelClass}`} on host ${config.hostId} is switched off (enabled: false) — switch it on again with: pteam routing enable ${modelClass}${optionIndex === 0 ? "" : ` --option ${optionIndex}`}`,
			{ hostId: config.hostId, modelClass, option: optionIndex },
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
//   node scripts/model-routing.mjs gate-routes   (the local route table, JSON; used by the Pi adapter)
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
	if (command === "gate-routes") {
		// The Pi adapter's half of the create_agent route gate: the same table
		// the Claude hook loads in-process. Always exit 0 with JSON — a load
		// failure is DATA the gate refuses on, not a crash to be retried.
		// Job-less on purpose: the gate subprocess is scripts/gate-table.mjs (this
		// file cannot import jobs.mjs, which imports it). Kept for `pteam` and tests.
		const table = gateRouteTable();
		emit(table, 0);
	}
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
