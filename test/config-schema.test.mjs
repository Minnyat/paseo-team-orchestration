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
	MODEL_INVENTORY_SECTIONS,
	ROUTE_CLASS_GROUPS,
	ROUTE_CLASS_INFO,
	ROUTING_SECTIONS,
	schemaForSection,
	withModelInventory,
	withPiModelCatalog,
} from "../cli/lib/config-schema.mjs";
import {
	ALL_MODEL_CLASSES,
	MODEL_CLASSES,
	OPTIONAL_MODEL_CLASSES,
	ROLE_PROVIDERS,
	RUNTIME_DESCRIPTORS,
	RUNTIME_FAMILIES,
	TEAM_ROLES,
	THINKING_LEVELS_BY_FAMILY,
	providerFamily,
} from "../scripts/model-routing.mjs";
import { OVERRIDE_KEYS } from "../scripts/models-dev.mjs";
import {
	SEAT_CAPABILITY_IDS,
	capabilitiesForBase,
} from "../scripts/seat-profiles.mjs";
import {
	BUILTIN_CLI_TOOLS,
	EXECUTOR_KEYS,
	EXECUTOR_KINDS,
	JOB_DISPOSITIONS,
	JOB_RUN_MODES,
	validateJobsConfig,
} from "../scripts/jobs.mjs";

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

// --- pi-models: context limits are per model, never per endpoint ------------
// The sync ignores endpoint-level contextWindow/maxTokens (with a warning), so
// a box for them on the endpoint card would take a value and do nothing with
// it. Limits are overridden per model id under `models`, with no default and
// no seed: an absent limit means "look it up on models.dev".
{
	const providers = CONFIG_SCHEMAS["pi-models"].groups
		.flatMap((group) => group.fields)
		.find((field) => field.path === "providers");
	for (const path of ["contextWindow", "maxTokens"]) {
		assert.ok(!(path in providers.item.seed), `a new endpoint card must not seed ${path}`);
		assert.equal(
			providers.item.fields.find((f) => f.path === path),
			undefined,
			`the endpoint card no longer offers ${path}: the sync ignores it there`,
		);
	}
	assert.ok(!("models" in providers.item.seed), "a new endpoint card starts with no overrides");
	const models = providers.item.fields.find((f) => f.path === "models");
	assert.ok(models, "the endpoint card offers per-model overrides");
	assert.equal(models.type, "model-overrides", "a dedicated table+modal control, still keyed by model id");
	assert.equal(models.labelEn, "Model overrides", "the control's label is bilingual");
	assert.equal(models.fixedKeys, undefined, "any model id may be a key");
	assert.match(models.hint, /models\.dev/, "says where a model without an override gets its limits");
	assert.match(models.hintEn, /models\.dev/, "in English too");
	// Exactly the keys the sync accepts: anything else would be refused at sync time.
	assert.deepEqual(models.item.fields.map((f) => f.path), [...OVERRIDE_KEYS]);
	for (const field of models.item.fields.filter(f => ["contextWindow", "maxTokens"].includes(f.path))) {
		assert.equal(field.type, "number");
		assert.equal(field.default, undefined, `${field.path} has no default: blank means unknown`);
		assert.match(field.hint, /models\.dev/, `${field.path} says where a blank value comes from`);
	}
}

// --- jobs: the form is the validator's vocabulary, field for field -----------
{
	const schema = schemaForSection("jobs");
	assert.ok(schema, "the jobs section has a form schema");
	assert.equal(schema.label, "Công việc");
	validateJobsConfig(structuredClone(schema.seed));

	const fields = schema.groups.flatMap((group) => group.fields);
	const jobs = fields.find((field) => field.path === "jobs");
	assert.equal(jobs?.type, "map", "jobs are keyed by job id");
	const cliTools = fields.find((field) => field.path === "cliTools");
	assert.equal(cliTools?.type, "map", "extra CLI tools are keyed by name");
	assert.deepEqual(cliTools.item.fields.map((f) => f.path), ["command", "args"]);

	const jobField = (path) => {
		const field = jobs.item.fields.find((f) => f.path === path);
		assert.ok(field, `the job card has a "${path}" field`);
		return field;
	};
	assert.deepEqual(jobField("disposition").enum, [...JOB_DISPOSITIONS]);
	assert.deepEqual(jobField("run").enum, [...JOB_RUN_MODES]);
	assert.equal(jobField("run").default, "parallel");

	// `list`: an ordered array of element cards (S7).
	const executors = jobField("executors");
	assert.equal(executors.type, "list");
	assert.equal(executors.minItems, 1, "a job needs at least one executor");
	assert.equal(typeof executors.label, "string");
	assert.ok(Array.isArray(executors.item?.fields));
	assert.deepEqual(executors.item.seed, { kind: "class" });

	// A new job card starts WITH one executor — the executors list's own element
	// seed — so it never opens empty and is only refused at save.
	assert.ok(Array.isArray(jobs.item.seed.executors) && jobs.item.seed.executors.length >= executors.minItems);
	assert.deepEqual(jobs.item.seed.executors, [executors.item.seed], "the job seed's executor is the list's element seed");
	assert.notEqual(jobs.item.seed.executors[0], executors.item.seed, "a copy, not a shared object a renderer could mutate");
	// A freshly added job, as the form seeds it, is one pick away from valid.
	const seeded = { version: 1, jobs: { j: structuredClone(jobs.item.seed) } };
	seeded.jobs.j.executors[0].modelClass = "FAST_READ";
	validateJobsConfig(seeded);

	// The routing form's class card offers more tools/models for the class (alternates).
	const routeItem = CONFIG_SCHEMAS.routing.groups.find((g) => g.id === "routes").fields[0].item;
	const alt = routeItem.fields.find((f) => f.path === "alternates");
	assert.equal(alt.type, "list");
	assert.deepEqual(alt.item.fields.map((f) => f.path), ["paseoProvider", "model", "thinking", "enabled"], "an alternate is a route without alternates of its own");
	assert.ok(alt.labelEn && alt.hintEn);
	assert.equal(JSON.parse(JSON.stringify(CONFIG_SCHEMAS.routing)).groups.find((g) => g.id === "routes").fields[0].item.fields.find((f) => f.path === "alternates").item.fields.length, 4, "it survives the JSON the CLI sends to the form");
	// Class cards are grouped by role then function: every class sits in exactly
	// one group (a class in none would vanish from the form), and the optional
	// classes sit with the role they seat.
	const grouped = ROUTE_CLASS_GROUPS.flatMap((group) => group.keys);
	assert.deepEqual([...grouped].sort(), [...ALL_MODEL_CLASSES].sort(), "every class is in exactly one group");
	assert.equal(new Set(grouped).size, grouped.length);
	assert.ok(ROUTE_CLASS_GROUPS.find((g) => g.id === "supervisor").keys.includes("SUPERVISOR_GOVERNANCE"));
	assert.ok(ROUTE_CLASS_GROUPS.find((g) => g.id === "lead").keys.includes("LEAD_RECOVERY"));
	for (const cls of ALL_MODEL_CLASSES) assert.ok(ROUTE_CLASS_INFO[cls]?.label && ROUTE_CLASS_INFO[cls]?.labelEn, `${cls} says what it is for, in both languages`);
	for (const group of ROUTE_CLASS_GROUPS) assert.ok(group.label && group.labelEn);
	const routesField = CONFIG_SCHEMAS.routing.groups.find((g) => g.id === "routes").fields[0];
	assert.equal(routesField.item.layout, "route", "the routing form lays each class out as an options table");
	assert.deepEqual(routesField.keyGroups, ROUTE_CLASS_GROUPS);
	const clusterRoutes = CONFIG_SCHEMAS.cluster.groups[0].fields.find((f) => f.type === "map").item.fields.find((f) => f.path === "routes");
	assert.deepEqual(clusterRoutes.keyGroups, ROUTE_CLASS_GROUPS, "every cluster host groups its classes the same way");
	for (const column of ["paseoProvider", "model", "thinking", "enabled"]) {
		assert.ok(routeItem.fields.find((f) => f.path === column)?.labelEn, `${column} has an English column label`);
	}
	// job route executors do not get it (a job names its executors itself)
	assert.ok(!executors.item.fields.some((f) => f.path === "alternates"));

	// One-click presets: each merged onto the seed is a file the validator accepts.
	const presets = CONFIG_SCHEMAS.jobs.presets;
	assert.ok(presets.length >= 3, "the jobs form offers starter jobs");
	for (const preset of presets) {
		assert.ok(preset.labelEn && preset.hintEn, `${preset.id} has an English alternate`);
		const doc = structuredClone(CONFIG_SCHEMAS.jobs.seed);
		for (const [id, job] of Object.entries(preset.patch.jobs)) doc.jobs[id] = structuredClone(job);
		validateJobsConfig(doc);
		assert.ok(Object.values(doc.jobs).every((job) => job.executors.length >= 2), `${preset.id}: several models/tools in one job`);
	}

	const byPath = Object.fromEntries(executors.item.fields.map((f) => [f.path, f]));
	assert.deepEqual(byPath.kind.enum, [...EXECUTOR_KINDS]);
	assert.equal(byPath.kind.showIf, undefined, "the kind picker is always visible");
	// Every key a kind takes has a field shown for exactly that kind, and no
	// field exists for a key no kind takes.
	for (const kind of EXECUTOR_KINDS) {
		const shown = executors.item.fields.filter((f) => f.showIf?.equals === kind).map((f) => f.path);
		assert.deepEqual(
			shown.sort(),
			// `enabled` is the quick switch every kind takes: one field, always shown.
			EXECUTOR_KEYS[kind].filter((key) => key !== "kind" && key !== "enabled").sort(),
			`kind "${kind}" shows exactly the fields it takes`,
		);
		assert.ok(EXECUTOR_KEYS[kind].includes("enabled"), `kind "${kind}" takes the switch`);
	}
	assert.equal(byPath.enabled.type, "bool");
	assert.equal(byPath.enabled.default, true);
	assert.equal(byPath.enabled.showIf, undefined, "the switch is visible whatever the kind");
	for (const field of executors.item.fields) {
		if (field.showIf) assert.equal(field.showIf.path, "kind", `${field.path} toggles on its sibling kind`);
	}
	assert.equal(new Set(executors.item.fields.map((f) => f.path)).size, executors.item.fields.length, "one field per key");
	assert.deepEqual(byPath.modelClass.enum, [...ALL_MODEL_CLASSES]);
	// A route executor is the routing form's own route card.
	assert.equal(byPath.paseoProvider.type, "role-provider");
	assert.deepEqual(byPath.paseoProvider.enum, [...ROLE_PROVIDERS]);
	assert.equal(byPath.model.optionsBy?.source, "models");
	assert.equal(byPath.thinking.optionsBy?.path, "paseoProvider");
	for (const provider of ROLE_PROVIDERS) {
		assert.deepEqual(byPath.thinking.optionsBy.map[provider], [...THINKING_LEVELS_BY_FAMILY[providerFamily(provider)]]);
	}
	for (const tool of Object.keys(BUILTIN_CLI_TOOLS)) assert.match(byPath.tool.hint, new RegExp(tool));
	assert.equal(byPath.args.type, "lines");

	// The live model list reaches the route executors two levels down.
	assert.ok(MODEL_INVENTORY_SECTIONS.includes("jobs"), "config read jobs folds in the model inventory");
	for (const section of ROUTING_SECTIONS) assert.ok(MODEL_INVENTORY_SECTIONS.includes(section));
	const inventory = { "pi-peer": ["Minnyat/gpt-5.5"] };
	const filled = withModelInventory(schema, inventory);
	const filledModel = filled.groups
		.flatMap((g) => g.fields)
		.find((f) => f.path === "jobs")
		.item.fields.find((f) => f.path === "executors")
		.item.fields.find((f) => f.path === "model");
	assert.deepEqual(filledModel.optionsBy.map, inventory);
	assert.deepEqual(byPath.model.optionsBy.map, {}, "the shared schema is not mutated");
}
