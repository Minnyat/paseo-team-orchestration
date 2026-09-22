// model-routing.test.mjs — unit tests for the stateless routing resolver.
// Run: node test/model-routing.test.mjs   (node >= 22)

import assert from "node:assert/strict";
import {
	ERROR_CODES,
	MODEL_CLASSES,
	ROLE_PROVIDERS,
	RUNTIME_DESCRIPTORS,
	RUNTIME_FAMILIES,
	THINKING_LEVELS,
	THINKING_LEVELS_BY_FAMILY,
	RoutingError,
	runtimeDescriptor,
	buildProviderInventory,
	cmdPercentExpansionRisk,
	composeProviderModel,
	loadClusterConfig,
	loadRoutingConfig,
	missingHostCapabilities,
	modelsCacheKey,
	normalizeModelEntry,
	providerFamily,
	resolveClusterRoute,
	resolveRoute,
	splitProviderModel,
	validateClusterConfig,
	validateRemoteEndpoint,
	validateRoutingConfig,
	verifyObserved,
} from "../scripts/model-routing.mjs";

function expectRoutingError(code, fn) {
	try {
		fn();
	} catch (error) {
		assert.ok(
			error instanceof RoutingError,
			`expected RoutingError, got ${error}`,
		);
		assert.equal(
			error.code,
			code,
			`expected code ${code}, got "${error.code}" (${error.message})`,
		);
		return error;
	}
	assert.fail(`expected RoutingError(${code}) but nothing was thrown`);
}

// --- fixtures ----------------------------------------------------------------

const validConfigData = {
	version: 1,
	hostId: "host-a",
	routes: {
		MONITOR_ECONOMY: {
			paseoProvider: "pi-supervisor",
			model: "testprov/fast-small",
			thinking: "low",
		},
		FAST_READ: {
			paseoProvider: "pi-peer",
			model: "testprov/fast-small",
			thinking: "low",
		},
		CODING_MEDIUM: {
			paseoProvider: "pi-peer",
			model: "testprov/coder-mid",
			thinking: "medium",
		},
		REASONING_HIGH: {
			paseoProvider: "pi-peer",
			model: "vendor/scoped/deep-reasoner",
			thinking: "high",
		},
		REVIEW_HIGH: {
			paseoProvider: "pi-peer",
			model: "testprov/reviewer-pro",
			thinking: "high",
		},
	},
};

const inventory = {
	providers: [
		{ id: "pi-supervisor", enabled: true },
		{ id: "pi-lead", enabled: true },
		{ id: "pi-peer", enabled: true },
	],
	models: [
		{
			id: "testprov/fast-small",
			thinkingOptions: [{ id: "off" }, { id: "low" }, { id: "medium" }],
		},
		{
			id: "testprov/coder-mid",
			thinkingOptionIds: ["off", "minimal", "low", "medium", "high"],
		},
		{
			id: "vendor/scoped/deep-reasoner",
			thinkingOptions: [{ id: "low" }, { id: "high" }],
		},
		{
			id: "testprov/reviewer-pro",
			thinkingOptions: [{ id: "low" }, { id: "high" }],
		},
		{ id: "testprov/non-reasoning" }, // no thinkingOptions at all
	],
};

const config = validateRoutingConfig(validConfigData);

// --- validateRoutingConfig ----------------------------------------------------

assert.equal(config.hostId, "host-a");
assert.equal(config.routes.REASONING_HIGH.model, "vendor/scoped/deep-reasoner");

expectRoutingError("CONFIG_INVALID", () => validateRoutingConfig(null));
expectRoutingError("CONFIG_INVALID", () => validateRoutingConfig([]));
expectRoutingError("CONFIG_INVALID", () => validateRoutingConfig({}));
expectRoutingError("CONFIG_INVALID", () =>
	validateRoutingConfig({ ...validConfigData, version: 2 }),
);
expectRoutingError("CONFIG_INVALID", () =>
	validateRoutingConfig({ ...validConfigData, hostId: "" }),
);
{
	const missing = structuredClone(validConfigData);
	delete missing.routes.REVIEW_HIGH;
	expectRoutingError("CONFIG_INVALID", () => validateRoutingConfig(missing));
}
{
	const unknown = structuredClone(validConfigData);
	unknown.routes.SUPER_MODEL = {
		paseoProvider: "pi-peer",
		model: "a/b",
		thinking: "low",
	};
	expectRoutingError("CONFIG_INVALID", () => validateRoutingConfig(unknown));
}
{
	const badProvider = structuredClone(validConfigData);
	badProvider.routes.FAST_READ.paseoProvider = "pi-peer-fast";
	expectRoutingError("CONFIG_INVALID", () =>
		validateRoutingConfig(badProvider),
	);
}
{
	const bareModel = structuredClone(validConfigData);
	bareModel.routes.FAST_READ.model = "gpt-5.4";
	expectRoutingError("CONFIG_INVALID", () => validateRoutingConfig(bareModel));
}
{
	const badThinking = structuredClone(validConfigData);
	badThinking.routes.FAST_READ.thinking = "turbo";
	expectRoutingError("CONFIG_INVALID", () =>
		validateRoutingConfig(badThinking),
	);
}
expectRoutingError("CONFIG_INVALID", () =>
	loadRoutingConfig("/nonexistent/path.json"),
);

// --- splitProviderModel / composeProviderModel --------------------------------

assert.deepEqual(splitProviderModel("pi-peer/testprov/coder-mid"), {
	provider: "pi-peer",
	model: "testprov/coder-mid",
});
// Multi-slash model IDs: split at FIRST slash only (mirrors Paseo source).
assert.deepEqual(splitProviderModel("pi-peer/vendor/scoped/deep-reasoner"), {
	provider: "pi-peer",
	model: "vendor/scoped/deep-reasoner",
});
assert.deepEqual(splitProviderModel("pi-peer/a/b/c/d"), {
	provider: "pi-peer",
	model: "a/b/c/d",
});
expectRoutingError("CONFIG_INVALID", () => splitProviderModel("pi-peer"));
expectRoutingError("CONFIG_INVALID", () => splitProviderModel("/model"));
expectRoutingError("CONFIG_INVALID", () => splitProviderModel("provider/"));

assert.equal(
	composeProviderModel("pi-peer", "vendor/scoped/deep-reasoner"),
	"pi-peer/vendor/scoped/deep-reasoner",
);
assert.equal(
	composeProviderModel("pi-supervisor", "testprov/fast-small"),
	"pi-supervisor/testprov/fast-small",
);
expectRoutingError("CONFIG_INVALID", () =>
	composeProviderModel("pi-peer-x", "a/b"),
);
expectRoutingError("CONFIG_INVALID", () =>
	composeProviderModel("pi-peer", "noprovider"),
);
expectRoutingError("CONFIG_INVALID", () =>
	composeProviderModel("pi-peer", "testprov/"),
);
expectRoutingError("CONFIG_INVALID", () =>
	composeProviderModel("pi-peer", "/m"),
);
expectRoutingError("CONFIG_INVALID", () => composeProviderModel("pi-peer", ""));

// Roundtrip: split(compose(x)) must recover x exactly (verifies Paseo-side parsing).
// The model reference shape is family-specific — pi ids carry a provider
// segment, Claude ids are bare — so each family is roundtripped with its own.
for (const roleProvider of ROLE_PROVIDERS) {
	const model = providerFamily(roleProvider) === "claude" ? "claude-opus-5" : "a/b/c";
	const composed = composeProviderModel(roleProvider, model);
	const split = splitProviderModel(composed);
	assert.equal(split.provider, roleProvider);
	assert.equal(split.model, model);
}

// A pi-shaped model on a Claude route (and vice versa) is a config error, not
// something to normalise away: the daemon would create the agent on a model id
// that does not exist.
expectRoutingError("CONFIG_INVALID", () =>
	composeProviderModel("claude-peer", "openrouter/vendor/model"),
);
expectRoutingError("CONFIG_INVALID", () =>
	composeProviderModel("pi-peer", "claude-opus-5"),
);
assert.equal(
	composeProviderModel("claude-lead", "claude-opus-5"),
	"claude-lead/claude-opus-5",
);
assert.equal(providerFamily("claude-supervisor"), "claude");
assert.equal(providerFamily("pi-peer"), "pi");
assert.equal(providerFamily("codex-peer"), null);

// The role-provider list is duplicated in the policy core (which must not
// depend on the routing script). Assert the two never drift.
{
	const core = await import("../extensions/paseo-team-core/policy-core.ts");
	assert.deepEqual([...ROLE_PROVIDERS].sort(), [...core.ROLE_PROVIDERS].sort());

	// The two runtime-descriptor tables are deliberate siblings, not one import
	// (policy-core loads inside pi's runtime). They MUST agree on the families
	// and on every fact they both carry, or a new coding agent that only lands
	// in one table becomes a silent split-brain: routing would compose a seat
	// the authority gates measure by different rules.
	assert.deepEqual(
		[...RUNTIME_FAMILIES],
		[...core.RUNTIME_FAMILIES],
		"the two descriptor tables must list the same families in the same order",
	);
	for (const family of RUNTIME_FAMILIES) {
		const routing = runtimeDescriptor(family);
		const authority = core.runtimeDescriptor(family);
		assert.ok(routing && authority, `both tables must describe ${family}`);
		assert.equal(
			routing.model.minRouteSegments,
			authority.minRouteSegments,
			`${family}: route-segment minimum disagrees across the boundary`,
		);
		assert.equal(
			routing.model.hintPrefix,
			authority.modelHintPrefix,
			`${family}: model hint prefix disagrees across the boundary`,
		);
		assert.equal(
			routing.hasPermissionModes,
			authority.hasPermissionModes,
			`${family}: permission-mode capability disagrees across the boundary`,
		);
	}
	// pi carries its own provider segment (3), Claude is a bare id (2): the fact
	// every route-length gate keys off, pinned to concrete values so a typo in
	// either table is caught, not just a mutual drift.
	assert.equal(core.runtimeDescriptor("pi").minRouteSegments, 3);
	assert.equal(core.runtimeDescriptor("claude").minRouteSegments, 2);
	assert.equal(core.familyHasPermissionModes("claude"), true);
	assert.equal(core.familyHasPermissionModes("pi"), false);
	assert.equal(core.familyHasPermissionModes("codex"), false, "unknown family has no modes");
}

// --- resolveRoute --------------------------------------------------------------

{
	const route = resolveRoute(config, "CODING_MEDIUM", inventory);
	assert.equal(route.paseoProvider, "pi-peer");
	assert.equal(route.model, "testprov/coder-mid");
	assert.equal(route.thinking, "medium");
	assert.equal(route.createAgentProvider, "pi-peer/testprov/coder-mid");
	assert.equal(route.thinkingValidated, "exact");
}
{
	// Multi-slash model survives resolution end to end.
	const route = resolveRoute(config, "REASONING_HIGH", inventory);
	assert.equal(
		route.createAgentProvider,
		"pi-peer/vendor/scoped/deep-reasoner",
	);
}
{
	// Supervisor route goes through pi-supervisor profile.
	const route = resolveRoute(config, "MONITOR_ECONOMY", inventory);
	assert.equal(route.paseoProvider, "pi-supervisor");
	assert.equal(route.createAgentProvider, "pi-supervisor/testprov/fast-small");
}

// Missing model → MODEL_UNAVAILABLE (NO silent fallback to anything else).
{
	const missingConfig = structuredClone(validConfigData);
	missingConfig.routes.FAST_READ.model = "testprov/gone";
	expectRoutingError("MODEL_UNAVAILABLE", () =>
		resolveRoute(validateRoutingConfig(missingConfig), "FAST_READ", inventory),
	);
}

// Disabled/missing role provider → ROLE_PROVIDER_UNAVAILABLE.
expectRoutingError("ROLE_PROVIDER_UNAVAILABLE", () =>
	resolveRoute(config, "MONITOR_ECONOMY", {
		...inventory,
		providers: [
			{ id: "pi-peer", enabled: true },
			{ id: "pi-supervisor", enabled: false },
		],
	}),
);
expectRoutingError("ROLE_PROVIDER_UNAVAILABLE", () =>
	resolveRoute(config, "MONITOR_ECONOMY", { ...inventory, providers: [] }),
);

// Unsupported thinking → THINKING_OPTION_UNAVAILABLE.
{
	const badThinking = structuredClone(validConfigData);
	badThinking.routes.REVIEW_HIGH.thinking = "xhigh";
	expectRoutingError("THINKING_OPTION_UNAVAILABLE", () =>
		resolveRoute(validateRoutingConfig(badThinking), "REVIEW_HIGH", inventory),
	);
}

// Unknown class / missing class route → HOST_ROUTE_UNAVAILABLE.
expectRoutingError("HOST_ROUTE_UNAVAILABLE", () =>
	resolveRoute(config, "WHATEVER", inventory),
);
{
	const partial = {
		hostId: "h",
		routes: { FAST_READ: validConfigData.routes.FAST_READ },
	};
	expectRoutingError("HOST_ROUTE_UNAVAILABLE", () =>
		resolveRoute(partial, "REASONING_HIGH", inventory),
	);
}

// CLI --json shapes work too (provider/status/enabled strings, thinkingOptionIds).
{
	const cliInventory = {
		providers: [
			{ provider: "pi-peer", status: "available", enabled: "Enabled" },
		],
		models: [
			{ id: "testprov/coder-mid", thinkingOptionIds: ["medium", "high"] },
		],
	};
	// Fast-read needs pi-peer + testprov/fast-small (absent here) → MODEL_UNAVAILABLE.
	expectRoutingError("MODEL_UNAVAILABLE", () =>
		resolveRoute(config, "FAST_READ", cliInventory),
	);
	const codecInventory = {
		...cliInventory,
		models: [
			{ id: "testprov/coder-mid", thinkingOptionIds: ["medium", "high"] },
		],
	};
	const route = resolveRoute(config, "CODING_MEDIUM", codecInventory);
	assert.equal(route.createAgentProvider, "pi-peer/testprov/coder-mid");
}

// Model without any thinking list → unverifiable but allowed in non-strict;
// STRICT mode refuses it (unverifiable is not a pass).
{
	const unverifiable = structuredClone(validConfigData);
	unverifiable.routes.FAST_READ.model = "testprov/non-reasoning";
	const route = resolveRoute(
		validateRoutingConfig(unverifiable),
		"FAST_READ",
		inventory,
	);
	assert.equal(route.thinkingValidated, "unverifiable");
	expectRoutingError("THINKING_OPTION_UNAVAILABLE", () =>
		resolveRoute(validateRoutingConfig(unverifiable), "FAST_READ", inventory, {
			strict: true,
		}),
	);
}

// --- "we do not know" vs "we know it has none" --------------------------------
// The daemon can say three different things about extended thinking, and the
// resolver used to hear only two of them. A model that genuinely has no
// extended thinking (Haiku-class) was read as UNVERIFIABLE and refused from
// every strict route, which took the cheapest seat on the host out of service
// for work that never needed thinking in the first place.
{
	// Shape 1: the daemon says nothing at all, and the route asks for "off".
	// Nothing to verify, so nothing can be unverifiable — strict included.
	const off = structuredClone(validConfigData);
	off.routes.FAST_READ.model = "testprov/non-reasoning";
	off.routes.FAST_READ.thinking = "off";
	assert.equal(
		resolveRoute(validateRoutingConfig(off), "FAST_READ", inventory, {
			strict: true,
		}).thinkingValidated,
		"off",
	);

	// Shape 2: the daemon states it outright. `thinkingSupported: false` is a
	// FACT about the model, so "off" is fully verified, not tolerated.
	const declared = {
		...inventory,
		models: [
			...inventory.models,
			{ id: "testprov/haiku-like", thinkingSupported: false },
			// Shape 3: the same statement written as data — an option list that
			// is present and empty. Before this fix it failed with "offered: ".
			{ id: "testprov/empty-options", thinkingOptions: [] },
		],
	};
	for (const model of ["testprov/haiku-like", "testprov/empty-options"]) {
		const cfg = structuredClone(validConfigData);
		cfg.routes.FAST_READ.model = model;
		cfg.routes.FAST_READ.thinking = "off";
		assert.equal(
			resolveRoute(validateRoutingConfig(cfg), "FAST_READ", declared, {
				strict: true,
			}).thinkingValidated,
			"unsupported",
			`${model} at thinking:off must resolve as a known-unsupported pass`,
		);

		// Fail-closed is unchanged where it was ever load-bearing: asking such a
		// model for a real thinking level is still refused, in BOTH modes, and
		// the message names the level that would work.
		const raised = structuredClone(validConfigData);
		raised.routes.FAST_READ.model = model;
		raised.routes.FAST_READ.thinking = "medium";
		for (const strict of [false, true]) {
			expectRoutingError("THINKING_OPTION_UNAVAILABLE", () =>
				resolveRoute(validateRoutingConfig(raised), "FAST_READ", declared, {
					strict,
				}),
			);
		}
	}

	// The opposite direction stays UNVERIFIABLE: a model that claims thinking
	// but publishes no levels tells us nothing about WHICH level, so a strict
	// route to a specific level is still refused.
	const claims = {
		...inventory,
		models: [
			...inventory.models,
			{ id: "testprov/claims-thinking", thinkingSupported: true },
		],
	};
	const claimsCfg = structuredClone(validConfigData);
	claimsCfg.routes.FAST_READ.model = "testprov/claims-thinking";
	assert.equal(
		resolveRoute(validateRoutingConfig(claimsCfg), "FAST_READ", claims)
			.thinkingValidated,
		"unverifiable",
	);
	expectRoutingError("THINKING_OPTION_UNAVAILABLE", () =>
		resolveRoute(validateRoutingConfig(claimsCfg), "FAST_READ", claims, {
			strict: true,
		}),
	);
}

// normalizeModelEntry carries the tri-state through, because the CLI's routing
// form reads the inventory through this same parser.
{
	assert.equal(
		normalizeModelEntry({ id: "m" }).thinkingSupported,
		null,
		"silence is not a claim either way",
	);
	assert.equal(
		normalizeModelEntry({ id: "m", thinkingSupported: false }).thinkingSupported,
		false,
	);
	assert.equal(
		normalizeModelEntry({ id: "m", thinkingOptions: [] }).thinkingSupported,
		false,
		"a present-but-empty option list IS the no-thinking statement",
	);
	assert.equal(
		normalizeModelEntry({ id: "m", thinkingOptionIds: ["off", "low"] })
			.thinkingSupported,
		true,
	);
	// An explicit field wins over the list, so a daemon that publishes both a
	// stale list and a correct flag is read the way it means.
	assert.equal(
		normalizeModelEntry({
			id: "m",
			thinkingSupported: false,
			thinkingOptions: [{ id: "low" }],
		}).thinkingSupported,
		false,
	);
}

// Provider present+enabled but reporting a bad status → unavailable.
expectRoutingError("ROLE_PROVIDER_UNAVAILABLE", () =>
	resolveRoute(config, "MONITOR_ECONOMY", {
		...inventory,
		providers: [{ id: "pi-supervisor", enabled: true, status: "error" }],
	}),
);
// Healthy statuses still pass.
{
	const okInventory = {
		...inventory,
		providers: [{ id: "pi-supervisor", enabled: true, status: "available" }],
	};
	const route = resolveRoute(config, "MONITOR_ECONOMY", okInventory);
	assert.equal(route.paseoProvider, "pi-supervisor");
}

// Route model with an empty trailing segment is rejected at config validation.
{
	const trailing = structuredClone(validConfigData);
	trailing.routes.FAST_READ.model = "testprov/";
	expectRoutingError("CONFIG_INVALID", () => validateRoutingConfig(trailing));
}
// Route model with an empty LEADING segment ("/model-id") is rejected at
// config validation too — previously it slipped into prefix-split logic and
// only failed later at route composition (cluster-config PASS, route FAIL).
{
	const leading = structuredClone(validConfigData);
	leading.routes.FAST_READ.model = "/fast-small";
	expectRoutingError("CONFIG_INVALID", () => validateRoutingConfig(leading));
}

// --- buildProviderInventory (preflight inventory mapping) --------------------

{
	// Raw `paseo provider ls --json` shapes must map into a resolver inventory
	// WITHOUT dropping status — preflight once rebuilt this mapping inline and
	// dropped the field, letting an enabled-but-erroring provider pass.
	const raw = [
		{ provider: "pi-lead", status: "available", enabled: "Enabled" },
		{ provider: "pi-peer", status: "error", enabled: true },
		{ id: "pi-supervisor", enabled: true }, // MCP shape: no status field
		null,
		{ enabled: true }, // no id → dropped
	];
	const inv = buildProviderInventory(raw);
	assert.deepEqual(inv, [
		{ id: "pi-lead", enabled: true, status: "available" },
		{ id: "pi-peer", enabled: true, status: "error" },
		{ id: "pi-supervisor", enabled: true },
	]);
	assert.deepEqual(buildProviderInventory(undefined), []);
	assert.deepEqual(buildProviderInventory("nope"), []);

	// The false-pass regression, end to end: enabled + status "error" must be
	// REJECTED by the resolver, not silently passed.
	expectRoutingError("ROLE_PROVIDER_UNAVAILABLE", () =>
		resolveRoute(config, "CODING_MEDIUM", {
			...inventory,
			providers: buildProviderInventory([
				{ provider: "pi-peer", status: "error", enabled: true },
			]),
		}),
	);
	// And in STRICT mode a model without a thinking option list fails even
	// when the provider is healthy (unverifiable is not a pass).
	const unverifiable = structuredClone(validConfigData);
	unverifiable.routes.FAST_READ.model = "testprov/non-reasoning";
	expectRoutingError("THINKING_OPTION_UNAVAILABLE", () =>
		resolveRoute(
			validateRoutingConfig(unverifiable),
			"FAST_READ",
			{
				...inventory,
				providers: buildProviderInventory([
					{ provider: "pi-peer", status: "available", enabled: "Enabled" },
				]),
			},
			{ strict: true },
		),
	);
}

// Provider with missing/mistyped `enabled` is UNVERIFIABLE → not usable
// (fail-closed; a lone `{ id: "pi-peer" }` must not be routed to).
for (const bad of [undefined, null, {}, "maybe", "disabled"]) {
	expectRoutingError("ROLE_PROVIDER_UNAVAILABLE", () =>
		resolveRoute(config, "CODING_MEDIUM", {
			...inventory,
			providers: [{ id: "pi-peer", enabled: bad }],
		}),
	);
}

// --- verifyObserved -----------------------------------------------------------

const requested = resolveRoute(config, "CODING_MEDIUM", inventory);

{
	const result = verifyObserved(requested, {
		provider: "pi-peer",
		model: "testprov/coder-mid",
		thinkingOptionId: "medium",
	});
	assert.equal(result.ok, true);
}

// Observed model mismatch → MODEL_RESOLUTION_MISMATCH (no silent fallback).
expectRoutingError("MODEL_RESOLUTION_MISMATCH", () =>
	verifyObserved(requested, {
		model: "testprov/other-model",
		thinkingOptionId: "medium",
	}),
);

// Observed thinking mismatch (e.g. pi clamped an unsupported level).
const clamped = verifyObserved;
{
	const error = expectRoutingError("MODEL_RESOLUTION_MISMATCH", () =>
		clamped(requested, {
			model: "testprov/coder-mid",
			thinkingOptionId: "low",
		}),
	);
	assert.match(error.message, /clamped|thinking/);
	assert.equal(error.details.observed.thinking, "low");
	assert.equal(error.details.requested.thinking, "medium");
}

// Provider mismatch is caught when the provider field is present.
expectRoutingError("MODEL_RESOLUTION_MISMATCH", () =>
	verifyObserved(requested, {
		provider: "pi",
		model: "testprov/coder-mid",
		thinkingOptionId: "medium",
	}),
);

// Missing runtimeInfo / missing fields → fail-closed, NOT a pass.
expectRoutingError("MODEL_RESOLUTION_MISMATCH", () =>
	verifyObserved(requested, null),
);
expectRoutingError("MODEL_RESOLUTION_MISMATCH", () =>
	verifyObserved(requested, {}),
);
expectRoutingError("MODEL_RESOLUTION_MISMATCH", () =>
	verifyObserved(requested, { model: "testprov/coder-mid" }),
);

// Multi-slash observed model verifies verbatim.
{
	const high = resolveRoute(config, "REASONING_HIGH", inventory);
	const result = verifyObserved(high, {
		model: "vendor/scoped/deep-reasoner",
		thinkingOptionId: "high",
	});
	assert.equal(result.ok, true);
}

// --- constants sanity -----------------------------------------------------------

assert.deepEqual(MODEL_CLASSES, [
	"MONITOR_ECONOMY",
	"FAST_READ",
	"CODING_MEDIUM",
	"REASONING_HIGH",
	"REVIEW_HIGH",
]);
assert.deepEqual(ROLE_PROVIDERS, [
	"pi-supervisor",
	"pi-lead",
	"pi-peer",
	"claude-supervisor",
	"claude-lead",
	"claude-peer",
]);
assert.ok(THINKING_LEVELS.includes("max") && THINKING_LEVELS.includes("off"));
// Family-specific thinking vocabularies: neither is a superset of the other,
// so a shared list would accept a level the target runtime silently clamps.
assert.ok(THINKING_LEVELS_BY_FAMILY.pi.includes("minimal"));
assert.ok(!THINKING_LEVELS_BY_FAMILY.claude.includes("minimal"));
assert.ok(THINKING_LEVELS_BY_FAMILY.claude.includes("ultracode"));
assert.ok(!THINKING_LEVELS_BY_FAMILY.pi.includes("ultracode"));
{
	const claudeRoute = structuredClone(validConfigData);
	claudeRoute.routes.REVIEW_HIGH = {
		paseoProvider: "claude-peer",
		model: "claude-opus-5",
		thinking: "ultracode",
	};
	const mixed = validateRoutingConfig(claudeRoute);
	assert.equal(mixed.routes.REVIEW_HIGH.paseoProvider, "claude-peer");
	// ...and the pi vocabulary is rejected on a Claude route.
	claudeRoute.routes.REVIEW_HIGH.thinking = "minimal";
	expectRoutingError("CONFIG_INVALID", () => validateRoutingConfig(claudeRoute));
}
assert.ok(ERROR_CODES.includes("MODEL_UNAVAILABLE"));
// The example config file must itself validate.
{
	const { readFileSync } = await import("node:fs");
	const { resolve, dirname } = await import("node:path");
	const { fileURLToPath } = await import("node:url");
	const examplePath = resolve(
		dirname(fileURLToPath(import.meta.url)),
		"../config/model-routing.example.json",
	);
	let example;
	try {
		example = JSON.parse(readFileSync(examplePath, "utf8"));
	} catch (error) {
		assert.fail(`example config is not valid JSON: ${error?.message ?? error}`);
	}
	delete example.$comment;
	const validated = validateRoutingConfig(example);
	assert.equal(validated.hostId, "replace-me-host-id");
}

// --- cluster routing contract ----------------------------------------------------

const clusterData = {
	version: 1,
	hosts: {
		"win-primary": {
			connection: { type: "local" },
			required: true,
			capabilities: [
				"git-read",
				"git-write",
				"focused-test",
				"integration-test",
			],
			limits: { writers: 1, readers: 3 },
			routes: validConfigData.routes,
		},
		"mac-review": {
			connection: { type: "remote", endpointEnv: "PASEO_MAC_REVIEW" },
			required: true,
			capabilities: ["git-read", "focused-test", "independent-review"],
			limits: { writers: 0, readers: 2 },
			routes: validConfigData.routes,
		},
	},
};

const cluster = validateClusterConfig(clusterData);
assert.equal(Object.keys(cluster.hosts).length, 2);
assert.equal(
	cluster.hosts["mac-review"].connection.endpointEnv,
	"PASEO_MAC_REVIEW",
);
assert.equal(cluster.hosts["mac-review"].limits.writers, 0);

expectRoutingError("CONFIG_INVALID", () => validateClusterConfig(null));
expectRoutingError("CONFIG_INVALID", () =>
	validateClusterConfig({ version: 2, hosts: {} }),
);
expectRoutingError("CONFIG_INVALID", () =>
	validateClusterConfig({ version: 1, hosts: {} }),
);
{
	const badRemote = structuredClone(clusterData);
	delete badRemote.hosts["mac-review"].connection.endpointEnv;
	expectRoutingError("CONFIG_INVALID", () => validateClusterConfig(badRemote));
}
{
	const badType = structuredClone(clusterData);
	badType.hosts["win-primary"].connection.type = "telepathy";
	expectRoutingError("CONFIG_INVALID", () => validateClusterConfig(badType));
}
{
	const badLimits = structuredClone(clusterData);
	badLimits.hosts["win-primary"].limits.writers = -1;
	expectRoutingError("CONFIG_INVALID", () => validateClusterConfig(badLimits));
}
{
	// `hosts` must be a plain object — a non-empty ARRAY is also
	// `typeof "object"` and previously slipped past the gate, iterating as
	// phantom hosts "0", "1", ... instead of failing at the schema.
	const arrayHosts = {
		version: 1,
		hosts: [
			{
				connection: { type: "local" },
				required: true,
				capabilities: [],
				routes: {},
			},
		],
	};
	expectRoutingError("CONFIG_INVALID", () => validateClusterConfig(arrayHosts));
	const emptyArrayHosts = { version: 1, hosts: [] };
	expectRoutingError("CONFIG_INVALID", () =>
		validateClusterConfig(emptyArrayHosts),
	);
}
{
	// `required` must be an explicit boolean — a string "true" previously
	// silently downgraded a required host to optional.
	const badRequired = structuredClone(clusterData);
	badRequired.hosts["mac-review"].required = "true";
	expectRoutingError("CONFIG_INVALID", () =>
		validateClusterConfig(badRequired),
	);
	const missingRequired = structuredClone(clusterData);
	delete missingRequired.hosts["mac-review"].required;
	expectRoutingError("CONFIG_INVALID", () =>
		validateClusterConfig(missingRequired),
	);
}
{
	// `limits` must be a real object when present — never silently defaulted.
	const badLimitsType = structuredClone(clusterData);
	badLimitsType.hosts["win-primary"].limits = "plenty";
	expectRoutingError("CONFIG_INVALID", () =>
		validateClusterConfig(badLimitsType),
	);
	const nullLimits = structuredClone(clusterData);
	nullLimits.hosts["win-primary"].limits = null;
	expectRoutingError("CONFIG_INVALID", () => validateClusterConfig(nullLimits));
	const arrayLimits = structuredClone(clusterData);
	arrayLimits.hosts["win-primary"].limits = [];
	expectRoutingError("CONFIG_INVALID", () =>
		validateClusterConfig(arrayLimits),
	);
}
{
	// Host routes are validated with the same strictness as single-host configs.
	const badRoute = structuredClone(clusterData);
	badRoute.hosts["mac-review"].routes.FAST_READ.model = "bare-model";
	expectRoutingError("CONFIG_INVALID", () => validateClusterConfig(badRoute));
}
expectRoutingError("CONFIG_INVALID", () =>
	loadClusterConfig("/nonexistent/x.json"),
);

// resolveClusterRoute: exact host + class resolution against host inventory.
{
	const route = resolveClusterRoute(
		cluster,
		"mac-review",
		"REVIEW_HIGH",
		inventory,
		{
			taskKind: "reviewer",
		},
	);
	assert.equal(route.hostId, "mac-review");
	assert.equal(route.createAgentProvider, "pi-peer/testprov/reviewer-pro");
	assert.equal(route.connection.type, "remote");
}
// Writer task on a host without git-write → refused.
expectRoutingError("HOST_ROUTE_UNAVAILABLE", () =>
	resolveClusterRoute(cluster, "mac-review", "CODING_MEDIUM", inventory, {
		taskKind: "writer",
	}),
);
// Unknown host → refused, never silently re-homed.
expectRoutingError("HOST_ROUTE_UNAVAILABLE", () =>
	resolveClusterRoute(cluster, "ghost-host", "FAST_READ", inventory),
);
// Strict resolution propagates through the cluster resolver.
{
	const strictCluster = validateClusterConfig(structuredClone(clusterData));
	strictCluster.hosts["win-primary"].routes.FAST_READ.model =
		"testprov/non-reasoning";
	const inv = {
		providers: inventory.providers,
		models: [...inventory.models],
	};
	expectRoutingError("THINKING_OPTION_UNAVAILABLE", () =>
		resolveClusterRoute(strictCluster, "win-primary", "FAST_READ", inv, {
			strict: true,
		}),
	);
}
// missingHostCapabilities: reviewer only needs git-read + independent-review.
assert.deepEqual(
	missingHostCapabilities(cluster.hosts["mac-review"], "reviewer"),
	[],
);
assert.deepEqual(
	missingHostCapabilities(cluster.hosts["mac-review"], "writer"),
	["git-write"],
);
expectRoutingError("CONFIG_INVALID", () =>
	missingHostCapabilities(cluster.hosts["mac-review"], "pilot"),
);

// The example cluster config file must itself validate.
{
	const { readFileSync } = await import("node:fs");
	const { resolve } = await import("node:path");
	const examplePath = resolve(
		new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
		"../../config/cluster-routing.example.json",
	);
	const example = JSON.parse(readFileSync(examplePath, "utf8"));
	delete example.$comment;
	const validated = validateClusterConfig(example);
	assert.ok(validated.hosts["win-primary"] && validated.hosts["mac-review"]);
}
// --- validateRemoteEndpoint (parse-based, multi-form) ----------------------------

// Documented forms must be accepted.
assert.equal(validateRemoteEndpoint("192.168.1.20:6767"), true, "host:port");
assert.equal(
	validateRemoteEndpoint("mac-mini.local:6767"),
	true,
	"hostname:port",
);
assert.equal(
	validateRemoteEndpoint(
		"tcp://192.168.1.20:6767?ssl=true&password=abc123%40x",
	),
	true,
	"tcp URI with query params (incl. &) — the documented pairing form",
);
assert.equal(
	validateRemoteEndpoint("https://app.paseo.sh/#offer=abc_DEF-123.456~789+"),
	true,
	"pairing offer URL",
);
assert.equal(validateRemoteEndpoint("https://relay.example.com/ws"), true);

// Rejected shapes.
for (const [value, why] of [
	["", "empty"],
	["tcp://only-host", "tcp URI without port"],
	["tcp://:6767", "tcp URI without host"],
	["https://", "https without host"],
	["https://app.paseo.sh/#offer=", "empty offer token"],
	["tcp://a b:6767", "whitespace"],
	['tcp://a:6767?"quoted"', "quote characters"],
	["tcp://a:6767;rm -rf /", "semicolon"],
	["tcp://a:6767$(id)", "command substitution"],
	["tcp://a:6767`id`", "backtick"],
	["not-an-endpoint", "bare word"],
	[123, "non-string"],
	[null, "null"],
]) {
	assert.equal(validateRemoteEndpoint(value), false, `rejected: ${why}`);
}
// Overlong values rejected.
assert.equal(validateRemoteEndpoint(`tcp://a:6767?${"x".repeat(5000)}`), false);

// --- modelsCacheKey (per-host isolation) -----------------------------------------

assert.notEqual(
	modelsCacheKey("mac-review", "pi-peer"),
	modelsCacheKey("linux-runner", "pi-peer"),
	"same role provider on two remote hosts must NOT share a cache entry",
);
assert.notEqual(
	modelsCacheKey("mac-review", "pi-peer"),
	modelsCacheKey("mac-review", "pi-lead"),
	"different providers on the same host stay distinct",
);
assert.equal(
	modelsCacheKey("mac-review", "pi-peer"),
	modelsCacheKey("mac-review", "pi-peer"),
	"deterministic for identical scope+provider",
);

// --- cmdPercentExpansionRisk (cmd.exe %VAR% guard) ------------------------------

assert.equal(cmdPercentExpansionRisk("tcp://a:6767?password=abc"), false);
assert.equal(
	cmdPercentExpansionRisk("tcp://a:6767?password=abc%40x"),
	false,
	"a single literal % cannot expand (needs a closing %)",
);
assert.equal(
	cmdPercentExpansionRisk("tcp://a:6767?password=a%40%20z"),
	true,
	"two % expand as %VAR% under cmd.exe even when percent-encoded",
);
assert.equal(cmdPercentExpansionRisk("192.168.1.20:6767"), false);
assert.equal(cmdPercentExpansionRisk("https://app.paseo.sh/#offer=xyz"), false);

console.log("[paseo-team] model-routing tests passed");
