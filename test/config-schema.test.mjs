// config-schema.test.mjs — the routing form must describe the SAME vocabulary
// the resolver enforces.
//
// Why this file exists: the routing vocabulary once had three independent
// definitions — scripts/model-routing.mjs, extensions/paseo-team-core/policy-core.ts
// and a hand-typed copy inside cli/lib/config-schema.mjs. model-routing.test.mjs
// locked the first two together; nothing watched the third, so it silently
// stayed pi-only after the Claude runtime family landed and the WebUI could not
// select any claude-* role provider. These assertions close that gap.
//
// Run: node test/config-schema.test.mjs   (node >= 22)

import assert from "node:assert/strict";
import {
	CONFIG_SCHEMAS,
	ROUTING_SECTIONS,
	schemaForSection,
	withModelInventory,
	withPiModelCatalog,
} from "../cli/lib/config-schema.mjs";
import {
	MODEL_CLASSES,
	OPTIONAL_MODEL_CLASSES,
	ROLE_PROVIDERS,
	RUNTIME_DESCRIPTORS,
	RUNTIME_FAMILIES,
	TEAM_ROLES,
	THINKING_LEVELS_BY_FAMILY,
	providerFamily,
} from "../scripts/model-routing.mjs";
import {
	SEAT_CAPABILITY_IDS,
	capabilitiesForBase,
} from "../scripts/seat-profiles.mjs";

/** The route card of a section, wherever it is nested. */
function routeItemFields(schema) {
	const found = [];
	const walk = (field) => {
		if (field.type === "map" && Array.isArray(field.fixedKeys) && field.fixedKeys.includes("REVIEW_HIGH")) {
			found.push(field);
		}
		for (const child of field.item?.fields ?? []) walk(child);
	};
	for (const group of schema.groups ?? []) for (const field of group.fields ?? []) walk(field);
	return found;
}

function fieldByPath(fields, path) {
	const field = fields.find((f) => f.path === path);
	assert.ok(field, `route card has no "${path}" field`);
	return field;
}

// --- both routing sections describe every role provider ----------------------

assert.deepEqual(
	[...ROUTING_SECTIONS].sort(),
	["cluster", "routing"],
	"ROUTING_SECTIONS names the sections whose forms carry a model inventory",
);

for (const section of ROUTING_SECTIONS) {
	const schema = schemaForSection(section);
	const cards = routeItemFields(schema);
	assert.ok(cards.length > 0, `${section}: no route map found in the schema`);
	for (const card of cards) {
		assert.deepEqual(
			card.fixedKeys,
			[...MODEL_CLASSES],
			`${section}: route keys must be exactly the MODEL_CLASSES the resolver requires`,
		);
		assert.deepEqual(
			card.optionalKeys,
			[...OPTIONAL_MODEL_CLASSES],
			`${section}: the optional classes are offered, never as required keys`,
		);
		const fields = card.item?.fields ?? [];

		// The drift that started all this: a pi-only provider list.
		assert.deepEqual(
			fieldByPath(fields, "paseoProvider").enum,
			[...ROLE_PROVIDERS],
			`${section}: the provider dropdown must offer every role provider, not just pi-*`,
		);

		// The provider control is the ROLE-first composite, not a flat dropdown:
		// role axis (fixed at three), runtime axis (grows with the descriptors),
		// and the two must compose to EXACTLY the flat vocabulary the resolver
		// enforces — no missing pair, no pair that is not a real role provider.
		const roleProvider = fieldByPath(fields, "paseoProvider");
		assert.equal(roleProvider.type, "role-provider", `${section}: provider is the role-first composite`);
		assert.deepEqual(roleProvider.roles, [...TEAM_ROLES], `${section}: role axis is the three team roles`);
		assert.deepEqual(
			roleProvider.runtimes.map((r) => r.id),
			[...RUNTIME_FAMILIES],
			`${section}: runtime axis is every runtime family, in order`,
		);
		for (const rt of roleProvider.runtimes) {
			assert.equal(rt.label, RUNTIME_DESCRIPTORS[rt.id].label, `${section}: runtime ${rt.id} carries its descriptor label`);
		}
		const composed = roleProvider.runtimes
			.flatMap((rt) => roleProvider.roles.map((role) => `${rt.id}-${role}`))
			.sort();
		assert.deepEqual(
			composed,
			[...ROLE_PROVIDERS].sort(),
			`${section}: role × runtime must compose to exactly ROLE_PROVIDERS`,
		);

		// Thinking levels are per family, so the form cannot offer one flat list.
		const thinking = fieldByPath(fields, "thinking");
		assert.equal(thinking.optionsBy?.path, "paseoProvider", `${section}: thinking must follow the provider`);
		for (const provider of ROLE_PROVIDERS) {
			assert.deepEqual(
				thinking.optionsBy.map[provider],
				[...THINKING_LEVELS_BY_FAMILY[providerFamily(provider)]],
				`${section}: ${provider} must offer exactly its family's thinking levels`,
			);
		}
		assert.ok(
			!thinking.optionsBy.map["claude-peer"].includes("minimal"),
			`${section}: "minimal" is pi-only and must never be offered for a Claude route`,
		);
		assert.ok(
			thinking.optionsBy.map["claude-peer"].includes("ultracode"),
			`${section}: "ultracode" is a real Claude level and must be reachable`,
		);
		assert.ok(
			!thinking.optionsBy.map["pi-peer"].includes("ultracode"),
			`${section}: "ultracode" does not exist on pi`,
		);

		// The static fallback list must not hide a level a family really has.
		for (const levels of Object.values(THINKING_LEVELS_BY_FAMILY)) {
			for (const level of levels) {
				assert.ok(thinking.enum.includes(level), `${section}: fallback enum is missing "${level}"`);
			}
		}

		// The model is picked from the chosen provider's own list, not typed.
		const model = fieldByPath(fields, "model");
		assert.equal(model.type, "enum", `${section}: the model field is a picker`);
		assert.equal(model.optionsBy?.path, "paseoProvider", `${section}: the list follows the provider`);
		assert.equal(
			model.optionsBy.source,
			"models",
			`${section}: the model list comes from the daemon, so it must be marked runtime-sourced`,
		);
		assert.deepEqual(model.optionsBy.map, {}, `${section}: the list starts empty and is filled per read`);
		assert.equal(
			thinking.optionsBy.source,
			undefined,
			`${section}: thinking levels are a static per-family table the daemon must not overwrite`,
		);
	}
}

// --- withModelInventory ----------------------------------------------------

{
	const inventory = { "pi-peer": ["Minnyat/deepseek-v4-pro"], "claude-peer": ["claude-opus-5"] };

	for (const section of ROUTING_SECTIONS) {
		const filled = withModelInventory(schemaForSection(section), inventory);
		const cards = routeItemFields(filled);
		assert.ok(cards.length > 0, `${section}: filled schema lost its route map`);
		for (const card of cards) {
			assert.deepEqual(
				fieldByPath(card.item.fields, "model").optionsBy.map,
				inventory,
				`${section}: every route card gets the inventory, including the ones nested under a host`,
			);
			// The other optionsBy on the same card is static and must be untouched.
			assert.deepEqual(
				fieldByPath(card.item.fields, "thinking").optionsBy.map["claude-peer"],
				[...THINKING_LEVELS_BY_FAMILY.claude],
				`${section}: filling the model list must not clobber the thinking table`,
			);
		}
		// The module hands out its own tables; filling them in place would leak
		// one command's daemon snapshot into the next call in the same process.
		assert.deepEqual(
			fieldByPath(routeItemFields(schemaForSection(section))[0].item.fields, "model").optionsBy.map,
			{},
			`${section}: withModelInventory must not mutate the shared schema`,
		);
	}

	// A missing/failed inventory degrades to "no suggestions", never to a throw.
	for (const empty of [undefined, null, {}]) {
		const filled = withModelInventory(CONFIG_SCHEMAS.routing, empty);
		assert.deepEqual(fieldByPath(routeItemFields(filled)[0].item.fields, "model").optionsBy.map, {});
	}
}

// --- pi's own settings keep pi's levels --------------------------------------

{
	const field = CONFIG_SCHEMAS["pi-settings"].groups
		.flatMap((group) => group.fields)
		.find((f) => f.path === "defaultThinkingLevel");
	assert.ok(field, "pi-settings has no defaultThinkingLevel field");
	assert.deepEqual(
		field.enum,
		[...THINKING_LEVELS_BY_FAMILY.pi],
		"~/.pi/agent/settings.json is pi's own file: a Claude-only level there means nothing",
	);
}

// --- the seats form describes the SAME catalog the generator enforces --------
// Same failure this file was written for, one section later: a hand-typed
// capability list in the form would offer grants `pteam seats apply` refuses,
// or hide ones it allows. The schema must be built FROM seat-profiles.mjs.
{
	const schema = schemaForSection("seats");
	assert.ok(schema, "the seats section has a form schema");
	const seatsField = schema.groups
		.flatMap((group) => group.fields ?? [])
		.find((field) => field.path === "seats");
	assert.equal(seatsField?.type, "map");

	const base = seatsField.item.fields.find((f) => f.path === "base");
	assert.deepEqual([...base.enum].sort(), [...ROLE_PROVIDERS].sort(), "every durable role provider is offerable as a base");

	const caps = seatsField.item.fields.find((f) => f.path === "capabilities");
	assert.equal(caps.type, "flags");
	assert.deepEqual(caps.enum, [...SEAT_CAPABILITY_IDS]);
	assert.deepEqual(
		caps.options.map((option) => option.id),
		[...SEAT_CAPABILITY_IDS],
		"every catalog entry is described for the renderer",
	);
	for (const option of caps.options) {
		assert.ok(option.label, `${option.id} has no label to render`);
	}
	// The per-base option lists come from the catalog's own role/family rules,
	// so a capability the generator would reject is never even offered.
	assert.equal(caps.optionsBy.path, "base");
	for (const provider of ROLE_PROVIDERS) {
		assert.deepEqual(caps.optionsBy.map[provider], capabilitiesForBase(provider), `optionsBy disagrees for ${provider}`);
	}
}


console.log("[paseo-team] config-schema tests passed");

// --- pi-settings: what a person sets vs. tuning knobs -----------------------
// Twenty-one fields in five open cards buried the four that matter. The tuning
// knobs fold into a disclosure that opens by itself when one of them is set.
{
	const fields = CONFIG_SCHEMAS["pi-settings"].groups.flatMap((group) => group.fields);
	const advanced = new Set(fields.filter((field) => field.advanced).map((field) => field.path));
	for (const path of [
		"retry.baseDelayMs", "retry.provider.timeoutMs", "retry.provider.maxRetries", "retry.provider.maxRetryDelayMs",
		"transport", "httpIdleTimeoutMs", "websocketConnectTimeoutMs", "steeringMode", "followUpMode",
		"compaction.reserveTokens", "compaction.keepRecentTokens",
	]) {
		assert.ok(advanced.has(path), `${path} is a tuning knob`);
	}
	for (const path of [
		"retry.enabled", "retry.maxRetries", "defaultProvider", "defaultModel", "defaultThinkingLevel",
		"hideThinkingBlock", "compaction.enabled", "theme", "defaultProjectTrust", "quietStartup",
	]) {
		assert.ok(!advanced.has(path), `${path} stays on the surface`);
	}
	assert.ok(fields.length - advanced.size >= 8, "the surface is still the settings people actually change");
}

// --- pi-settings: model fields fed from pi's own models.json ----------------
{
	const base = CONFIG_SCHEMAS["pi-settings"];
	const catalog = { Minnyat: ["gpt-5.4", "gpt-5.6-sol"], ollama: ["llama3.1:8b"] };
	const before = JSON.stringify(base);
	const fed = withPiModelCatalog(base, catalog);
	const field = (schema, path) => schema.groups.flatMap((group) => group.fields).find((f) => f.path === path);

	assert.equal(field(fed, "defaultProvider").type, "enum");
	assert.deepEqual(field(fed, "defaultProvider").enum, ["Minnyat", "ollama"]);
	assert.equal(field(fed, "defaultModel").type, "enum");
	assert.deepEqual(field(fed, "defaultModel").optionsBy, { path: "defaultProvider", source: "pi-models", map: catalog });
	assert.equal(JSON.stringify(base), before, "the module's own table is never mutated");

	// With nothing to offer the fields stay what they were: text boxes.
	assert.equal(withPiModelCatalog(base, {}), base);
	assert.equal(withPiModelCatalog(base, undefined), base);
	assert.equal(field(withPiModelCatalog(base, {}), "defaultModel").type, "string");

	// Everything else in the schema is untouched.
	assert.deepEqual(
		fed.groups.flatMap((g) => g.fields).filter((f) => !["defaultProvider", "defaultModel"].includes(f.path)),
		base.groups.flatMap((g) => g.fields).filter((f) => !["defaultProvider", "defaultModel"].includes(f.path)),
	);
}

// --- pi-models: context limits are optional, never a stamped default ---------
// An absent contextWindow/maxTokens means "unknown — look it up per model".
// A seed or a `default:` here would put one number on every model behind the
// endpoint (the old 200000/32000), which is exactly what the sync must not do.
{
	const providers = CONFIG_SCHEMAS["pi-models"].groups
		.flatMap((group) => group.fields)
		.find((field) => field.path === "providers");
	for (const path of ["contextWindow", "maxTokens"]) {
		assert.ok(!(path in providers.item.seed), `a new endpoint card must not seed ${path}`);
		const field = providers.item.fields.find((f) => f.path === path);
		assert.ok(field, `the ${path} field still exists`);
		assert.equal(field.type, "number");
		assert.equal(field.default, undefined, `${path} has no default: blank means unknown`);
		assert.match(field.hint, /models\.dev/, `${path} says where a blank value comes from`);
	}
}
