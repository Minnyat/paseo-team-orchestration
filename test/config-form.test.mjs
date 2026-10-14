import assert from "node:assert/strict";
import {
	applySwitch,
	listSwitches,
	cleanListItems,
	clone,
	deepMerge,
	deletePath,
	displayPath,
	fieldPath,
	fillKeptEmpty,
	getPath,
	dependentOptionProblems,
	dependentOptions,
	isShown,
	itemPaths,
	listLengthProblems,
	moveAt,
	numberRangeProblems,
	optionModelOff,
	optionalEntryProblems,
	parseLines,
	pruneEmpty,
	removeAt,
	setPath,
} from "../webui/public/config-form.js";

// --- path get/set/delete ----------------------------------------------------
// A path is an array of segments. Schema field paths ("retry.provider.timeoutMs")
// are split once, by fieldPath; data keys are never split.

{
	const doc = {};
	setPath(doc, ["retry", "provider", "timeoutMs"], 600000);
	assert.deepEqual(doc, { retry: { provider: { timeoutMs: 600000 } } }, "setPath creates missing parents");

	assert.equal(getPath(doc, ["retry", "provider", "timeoutMs"]), 600000);
	assert.equal(getPath(doc, ["retry", "provider", "maxRetries"]), undefined);
	assert.equal(getPath(undefined, ["a", "b"]), undefined, "a missing root reads as undefined");

	deletePath(doc, ["retry", "provider", "timeoutMs"]);
	assert.deepEqual(doc, {}, "deleting the only leaf prunes the empty parents it leaves behind");

	const keep = { retry: { enabled: true, provider: { timeoutMs: 1 } } };
	deletePath(keep, ["retry", "provider", "timeoutMs"]);
	assert.deepEqual(keep, { retry: { enabled: true } }, "a surviving sibling keeps the branch");

	const alien = { packages: ["npm:x"] };
	deletePath(alien, ["retry", "enabled"]);
	assert.deepEqual(alien, { packages: ["npm:x"] }, "deleting an absent path changes nothing");

	assert.deepEqual(fieldPath([], "retry.provider.timeoutMs"), ["retry", "provider", "timeoutMs"], "a schema path is split at the form layer");
	assert.deepEqual(fieldPath(["hosts", "mac.local"], "limits.writers"), ["hosts", "mac.local", "limits", "writers"], "the item's key stays whole");
	for (const old of ["retry.enabled", "", undefined]) {
		assert.throws(() => getPath({}, old), TypeError, "a string path is the old model: refused, not guessed at");
		assert.throws(() => setPath({}, old, 1), TypeError);
		assert.throws(() => deletePath({}, old), TypeError);
	}
}

// --- a map key is one segment, whatever it contains ---------------------------
// The reviewer's case: hosts "mac" and "mac.local" side by side. Joined into
// "hosts.mac.local.x" and split back, every read and write of mac.local landed
// on mac.local's would-be child of mac instead.
{
	const doc = { hosts: { mac: { required: true }, "mac.local": { required: false } } };
	assert.equal(getPath(doc, ["hosts", "mac.local", "required"]), false, "mac.local reads its own value");
	setPath(doc, ["hosts", "mac.local", "required"], true);
	assert.deepEqual(doc.hosts.mac, { required: true }, "writing mac.local leaves mac alone");
	assert.equal(doc.hosts["mac.local"].required, true);
	deletePath(doc, ["hosts", "mac.local", "required"]);
	assert.deepEqual(doc, { hosts: { mac: { required: true } } }, "deleting mac.local's only field removes mac.local, not mac");

	const models = {};
	for (const id of ["gpt-5.5", "poolside/laguna-s-2.1", "a..b", ".", "__proto__", "constructor"]) {
		setPath(models, ["models", id, "contextWindow"], 1000);
		assert.equal(getPath(models, ["models", id, "contextWindow"]), 1000, `"${id}" round-trips`);
	}
	assert.deepEqual(
		Object.keys(models.models),
		["gpt-5.5", "poolside/laguna-s-2.1", "a..b", ".", "__proto__", "constructor"],
		"every key is an own entry, none split, none swallowed by the prototype",
	);
	assert.equal(Object.getPrototypeOf(models.models), Object.prototype, "a key spelled __proto__ does not replace the prototype");
	assert.deepEqual(JSON.parse(JSON.stringify(models)).models.__proto__, { contextWindow: 1000 }, "and it is saved like any other key");

	assert.equal(displayPath(["hosts", "mac.local", "routes", "FAST_READ"]), 'hosts."mac.local".routes.FAST_READ');
	assert.equal(displayPath(["jobs", "review", "executors", 0, "model"]), "jobs.review.executors[0].model");
}

// --- lists: arrays of objects ------------------------------------------------------
{
	const doc = {};
	setPath(doc, ["jobs", "a", "executors", 0, "kind"], "class");
	assert.deepEqual(doc, { jobs: { a: { executors: [{ kind: "class" }] } } }, "a numeric segment creates a list, not an object");

	doc.jobs.a.executors.push({ kind: "cli", tool: "pi" }, { kind: "route" });
	moveAt(doc, ["jobs", "a", "executors"], 2, -1);
	assert.deepEqual(doc.jobs.a.executors.map((e) => e.kind), ["class", "route", "cli"], "move up swaps with the neighbour");
	moveAt(doc, ["jobs", "a", "executors"], 0, -1);
	moveAt(doc, ["jobs", "a", "executors"], 2, 1);
	assert.deepEqual(doc.jobs.a.executors.map((e) => e.kind), ["class", "route", "cli"], "moving past either end is a no-op");
	removeAt(doc, ["jobs", "a", "executors"], 1);
	assert.deepEqual(doc.jobs.a.executors.map((e) => e.kind), ["class", "cli"], "remove takes out exactly one element");

	deletePath(doc, ["jobs", "a", "executors", 0, "kind"]);
	assert.deepEqual(doc.jobs.a.executors, [{}, { kind: "cli", tool: "pi" }], "emptying an element leaves it in place: no hole, no renumbering");

	assert.deepEqual(itemPaths({ type: "list", item: {} }, doc, ["jobs", "a", "executors"]), [
		["jobs", "a", "executors", 0],
		["jobs", "a", "executors", 1],
	]);
	assert.deepEqual(itemPaths({ type: "map", item: {} }, { hosts: { "mac.local": {} } }, ["hosts"]), [["hosts", "mac.local"]]);
	assert.deepEqual(itemPaths({ type: "list", item: {} }, { x: { a: 1 } }, ["x"]), [], "a list field holding an object holds no items");
}

// --- preset merge ------------------------------------------------------------

{
	const doc = { retry: { enabled: true, provider: { timeoutMs: 0 } } };
	deepMerge(doc, { retry: { maxRetries: 6, provider: { timeoutMs: 600000 } } });
	assert.deepEqual(doc, { retry: { enabled: true, maxRetries: 6, provider: { timeoutMs: 600000 } } });
}

// --- prune: emptiness is structural, never a value ---------------------------

{
	assert.equal(pruneEmpty({}), undefined);
	assert.equal(pruneEmpty({ a: [], b: {} }), undefined);
	assert.deepEqual(
		pruneEmpty({ a: {}, b: [], c: 0, d: false, e: "", f: { g: { h: 1 } } }),
		{ c: 0, d: false, e: "", f: { g: { h: 1 } } },
		"0, false and empty-string are values, not emptiness",
	);
}

// --- range validation reaches into map items ---------------------------------

{
	const schema = {
		groups: [
			{
				fields: [
					{ path: "retry.maxRetries", type: "number", label: "Số lần thử lại", min: 0, max: 20 },
					{
						path: "hosts",
						type: "map",
						item: { fields: [{ path: "limits.writers", type: "number", label: "Số agent ghi", min: 0, max: 16 }] },
					},
				],
			},
		],
	};
	assert.deepEqual(numberRangeProblems(schema, { retry: { maxRetries: 6 } }), []);
	assert.equal(numberRangeProblems(schema, { retry: { maxRetries: 99 } }).length, 1);
	assert.equal(
		numberRangeProblems(schema, { hosts: { "win-primary": { limits: { writers: 44 } } } }).length,
		1,
		"number fields inside map cards are checked too",
	);
	const dotted = numberRangeProblems(schema, { hosts: { mac: { limits: { writers: 1 } }, "mac.local": { limits: { writers: 44 } } } });
	assert.equal(dotted.length, 1, "a dotted key's own value is the one checked (not a phantom mac.local under mac)");
	assert.equal(dotted[0], 'hosts."mac.local": Số agent ghi phải là số từ 0 đến 16', "the message says which item, like every other check");
	assert.match(numberRangeProblems(schema, { retry: { maxRetries: 99 } })[0], /^retry\.maxRetries: Số lần thử lại phải là số/, "a top-level field names its path");
	assert.deepEqual(
		numberRangeProblems(schema, { hosts: { mac: { limits: { writers: 44 } }, "mac.local": { limits: { writers: 1 } } } }).length,
		1,
	);
}

// --- misc ---------------------------------------------------------------------

{
	assert.deepEqual(parseLines("a\n b\r\n\r\n  c \n"), ["a", "b", "c"]);
	assert.deepEqual(parseLines(""), []);
	assert.deepEqual(parseLines(null), []);

	assert.deepEqual(clone({ a: { b: 1 } }), { a: { b: 1 } });
	assert.notEqual(clone({ a: { b: 1 } }).a, { a: { b: 1 } }.a);
	assert.equal(clone(undefined), undefined);
}

// --- dependentOptions (what a dependent control may offer) ------------------

{
	const spec = { path: "paseoProvider", map: { "pi-peer": ["minimal", "low"], "claude-peer": ["low", "ultracode"] } };
	const doc = { routes: { A: { paseoProvider: "claude-peer" }, B: { paseoProvider: "pi-peer" }, C: {} } };

	assert.deepEqual(dependentOptions(spec, doc, ["routes", "A"]), ["low", "ultracode"], "options follow the sibling's value");
	assert.deepEqual(dependentOptions(spec, doc, ["routes", "B"]), ["minimal", "low"], "a sibling in another item resolves independently");
	assert.deepEqual(
		dependentOptions(spec, doc, ["routes", "C"]),
		[],
		"no provider chosen yet: offer nothing rather than another family's levels",
	);
	assert.deepEqual(
		dependentOptions(spec, { routes: { A: { paseoProvider: "pi-lead" } } }, ["routes", "A"]),
		[],
		"a sibling value the map has never heard of offers nothing, it does not fall back",
	);
	assert.deepEqual(dependentOptions(null, doc, ["routes", "A"]), null, "a field with no dependency declares none");
	assert.deepEqual(
		dependentOptions(spec, { routes: { "gpt-5.5": { paseoProvider: "claude-peer" } } }, ["routes", "gpt-5.5"]),
		["low", "ultracode"],
		"a dotted item key resolves its own sibling",
	);
	assert.deepEqual(
		dependentOptions({ path: "top", map: { x: ["a"] } }, { top: "x" }),
		["a"],
		"a top-level field resolves against the document root",
	);
}

// --- dependentOptionProblems (family-specific thinking levels) ---------------

{
	const schema = {
		groups: [
			{
				fields: [
					{
						path: "routes",
						type: "map",
						item: {
							fields: [
								{ path: "paseoProvider", type: "enum", enum: ["pi-peer", "claude-peer"] },
								{
									path: "model",
									type: "enum",
									label: "Mô hình",
									optionsBy: { path: "paseoProvider", source: "models", map: { "pi-peer": ["p/a"] } },
								},
								{
									path: "thinking",
									type: "enum",
									label: "Mức suy nghĩ",
									optionsBy: {
										path: "paseoProvider",
										map: { "pi-peer": ["low", "minimal"], "claude-peer": ["low", "ultracode"] },
									},
								},
							],
						},
					},
				],
			},
		],
	};

	const ok = { routes: { A: { paseoProvider: "claude-peer", model: "claude-opus-5", thinking: "ultracode" } } };
	assert.deepEqual(dependentOptionProblems(schema, ok), [], "a level its family really has passes");

	const stranded = { routes: { A: { paseoProvider: "claude-peer", model: "claude-opus-5", thinking: "minimal" } } };
	const problems = dependentOptionProblems(schema, stranded);
	assert.equal(problems.length, 1, "a pi-only level on a Claude route is reported");
	assert.match(problems[0], /routes\.A/, "the message names the route that is wrong");
	assert.match(problems[0], /minimal/);
	assert.match(problems[0], /claude-peer/);

	assert.deepEqual(
		dependentOptionProblems(schema, { routes: { A: { paseoProvider: "pi-peer", model: "brand-new-id" } } }),
		[],
		"a model outside the daemon's list is legitimate (new id, or a daemon that was down) and must not block a save",
	);

	assert.deepEqual(
		dependentOptionProblems(schema, { routes: { A: { thinking: "minimal" } } }),
		[],
		"no provider chosen yet: nothing to validate against, so nothing to report",
	);

	assert.deepEqual(dependentOptionProblems(undefined, {}), [], "a section without a schema reports nothing");
}

// --- dependentOptionProblems on a MULTI-value field (seat capabilities) -----
// A `flags` field holds an array. Testing the array itself against the allowed
// list never matches, so before per-element checking every seat reported its
// whole capability list as invalid and the form refused to save a correct one.
{
	const schema = {
		groups: [
			{
				fields: [
					{
						path: "seats",
						type: "map",
						item: {
							fields: [
								{ path: "base", type: "enum", enum: ["claude-peer", "claude-supervisor"] },
								{
									path: "capabilities",
									type: "flags",
									label: "Năng lực",
									enum: ["web-research", "lead-write"],
									optionsBy: { path: "base", map: { "claude-peer": ["web-research"], "claude-supervisor": [] } },
								},
							],
						},
					},
				],
			},
		],
	};

	assert.deepEqual(
		dependentOptionProblems(schema, { seats: { r: { base: "claude-peer", capabilities: ["web-research"] } } }),
		[],
		"a capability the base really allows passes",
	);

	const problems = dependentOptionProblems(schema, {
		seats: { r: { base: "claude-peer", capabilities: ["web-research", "lead-write"] } },
	});
	assert.equal(problems.length, 1);
	assert.match(problems[0], /seats\.r/);
	assert.match(problems[0], /lead-write/);
	assert.match(problems[0], /"lead-write"/, "only the offending entry is quoted as the bad value");
	assert.match(problems[0], /chỉ nhận: web-research/, "the allowed list is still shown");

	assert.deepEqual(
		dependentOptionProblems(schema, { seats: { r: { base: "claude-supervisor", capabilities: ["web-research"] } } }),
		[],
		"an empty allowed list means the form has nothing to check against (the CLI still refuses on apply)",
	);

	assert.deepEqual(
		dependentOptionProblems(schema, { seats: { r: { base: "claude-peer", capabilities: [] } } }),
		[],
		"granting nothing is a valid seat",
	);
}

// --- optional map keys (routing's SUPERVISOR_GOVERNANCE / LEAD_RECOVERY) --------

{
	const schema = {
		groups: [
			{
				fields: [
					{
						path: "routes",
						type: "map",
						fixedKeys: ["FAST_READ"],
						optionalKeys: ["LEAD_RECOVERY"],
						item: {
							fields: [
								{ path: "paseoProvider", label: "Vai trò & runtime" },
								{ path: "model", label: "Mô hình" },
								{ path: "thinking", label: "Mức suy nghĩ" },
							],
						},
					},
				],
			},
		],
	};
	const full = { paseoProvider: "pi-lead", model: "p/m", thinking: "high" };
	assert.deepEqual(optionalEntryProblems(schema, { routes: {} }), [], "absent is valid");
	assert.deepEqual(optionalEntryProblems(schema, { routes: { LEAD_RECOVERY: {} } }), [], "an untouched card is pruned on save, not an error");
	assert.deepEqual(optionalEntryProblems(schema, { routes: { LEAD_RECOVERY: full } }), [], "complete is valid");
	const half = optionalEntryProblems(schema, { routes: { LEAD_RECOVERY: { paseoProvider: "pi-lead", thinking: "" } } });
	assert.equal(half.length, 1, "a half-filled optional route would write a file the gate cannot load");
	assert.match(half[0], /LEAD_RECOVERY.*Mô hình, Mức suy nghĩ/);
	assert.deepEqual(
		optionalEntryProblems(schema, { routes: { FAST_READ: { paseoProvider: "pi-peer" } } }),
		[],
		"required keys are not this check's business",
	);
}

// --- `list` fields (S7): walked by every check, tidied before save ------------------
{
	// The shape T-4A's jobs schema takes: a list inside a map item, whose
	// fields show/hide on a sibling `kind` and narrow on `paseoProvider`.
	const executors = {
		path: "executors",
		type: "list",
		label: "Executors",
		minItems: 1,
		item: {
			seed: { kind: "class" },
			fields: [
				{ path: "kind", type: "enum", enum: ["class", "route", "cli"] },
				{ path: "modelClass", type: "enum", enum: ["FAST_READ"], showIf: { path: "kind", equals: "class" } },
				{ path: "paseoProvider", type: "role-provider", showIf: { path: "kind", equals: "route" } },
				{
					path: "thinking",
					type: "enum",
					label: "Mức suy nghĩ",
					showIf: { path: "kind", equals: "route" },
					optionsBy: { path: "paseoProvider", map: { "pi-peer": ["minimal"], "claude-peer": ["ultracode"] } },
				},
				{ path: "budget.tokens", type: "number", label: "Ngân sách", min: 1, max: 10, showIf: { path: "kind", equals: "route" } },
				{ path: "tool", type: "string", showIf: { path: "kind", equals: "cli" } },
				{ path: "args", type: "lines", showIf: { path: "kind", equals: "cli" } },
				{ path: "tags", type: "lines", keepEmpty: true },
			],
		},
	};
	const schema = { groups: [{ fields: [{ path: "jobs", type: "map", item: { fields: [{ path: "label", type: "string" }, executors] } }] }] };

	const field = executors.item.fields[1];
	const doc = { jobs: { "re.view": { executors: [{ kind: "class" }, { kind: "cli" }] } } };
	assert.equal(isShown(field, doc, ["jobs", "re.view", "executors", 0]), true, "showIf reads the sibling in the same element");
	assert.equal(isShown(field, doc, ["jobs", "re.view", "executors", 1]), false, "and each element on its own");
	assert.equal(isShown({ path: "x" }, doc, []), true, "a field without showIf is always shown");

	const bad = {
		jobs: {
			"re.view": {
				executors: [
					{ kind: "route", paseoProvider: "claude-peer", thinking: "minimal", budget: { tokens: 99 } },
					{ kind: "class", modelClass: "FAST_READ" },
				],
			},
			empty: { executors: [] },
			absent: { label: "x" },
		},
	};
	const range = numberRangeProblems(schema, bad);
	assert.equal(range.length, 1, "a number inside a list element is range-checked");
	const options = dependentOptionProblems(schema, bad);
	assert.equal(options.length, 1, "an optionsBy field inside a list element is checked against its own sibling");
	assert.match(options[0], /^jobs\."re\.view"\.executors\[0\]: /, "and the message says which element, dotted job id quoted");
	const short = listLengthProblems(schema, bad);
	assert.equal(short.length, 2, "minItems: an empty list and a missing one are both short");
	assert.match(short[0], /jobs\.empty\.executors: Executors cần ít nhất 1 mục \(đang có 0\)/);
	assert.match(short[1], /jobs\.absent\.executors/);
	assert.deepEqual(listLengthProblems(schema, { jobs: { "re.view": bad.jobs["re.view"] } }), [], "a list at its floor passes");

	// Switching an element's kind leaves the old kind's fields behind in the
	// working document; the save must not carry them.
	const switched = {
		keep: { a: {} },
		jobs: {
			"re.view": {
				executors: [
					{ kind: "cli", tool: "pi", args: [], modelClass: "FAST_READ", paseoProvider: "pi-peer", budget: { tokens: 3 } },
					{ kind: "class", modelClass: "FAST_READ", unknownKey: "kept", nested: {} },
					{},
				],
			},
		},
		host: { connection: { type: "local", endpointEnv: "X" } },
	};
	cleanListItems(schema, switched);
	assert.deepEqual(
		switched.jobs["re.view"].executors,
		[{ kind: "cli", tool: "pi" }, { kind: "class", modelClass: "FAST_READ", unknownKey: "kept" }, {}],
		"hidden fields dropped, empty insides pruned, unknown keys kept, no element removed or renumbered",
	);
	assert.deepEqual(switched.keep, { a: {} }, "outside list elements nothing is touched");
	assert.deepEqual(switched.host.connection.endpointEnv, "X");

	// keepEmpty reaches into list elements, and only elements that exist.
	const filled = fillKeptEmpty(schema, { jobs: { a: { executors: [{ kind: "class" }, "not-an-object"] } } });
	assert.deepEqual(filled.jobs.a.executors, [{ kind: "class", tags: [] }, "not-an-object"]);

	// The whole save pipeline keeps a key spelled __proto__ (S2's job-name
	// pattern allows it): as a job id, and as a key inside a list element.
	const proto = JSON.parse('{"jobs":{"__proto__":{"executors":[{"kind":"cli","tool":"pi","__proto__":"x"}]}}}');
	const savedProto = fillKeptEmpty(schema, pruneEmpty(cleanListItems(schema, clone(proto))));
	assert.deepEqual(Object.keys(savedProto.jobs), ["__proto__"], "a job named __proto__ survives the save");
	assert.equal(Object.getPrototypeOf(savedProto.jobs), Object.prototype);
	assert.deepEqual(
		JSON.parse(JSON.stringify(savedProto)),
		JSON.parse('{"jobs":{"__proto__":{"executors":[{"kind":"cli","tool":"pi","__proto__":"x","tags":[]}]}}}'),
	);

	// A field hidden by showIf in a MAP item (not a list element) is kept: a
	// local host's endpointEnv is not rubbish, it is what "remote" will use.
	const hostSchema = {
		groups: [
			{
				fields: [
					{
						path: "hosts",
						type: "map",
						item: {
							fields: [
								{ path: "connection.type", type: "enum" },
								{ path: "connection.endpointEnv", type: "string", showIf: { path: "connection.type", equals: "remote" } },
							],
						},
					},
				],
			},
		],
	};
	const localHost = { hosts: { "mac.local": { connection: { type: "local", endpointEnv: "MAC_URL" } } } };
	assert.deepEqual(cleanListItems(hostSchema, clone(localHost)), localHost, "map items keep their hidden fields");

	// optionalKeys in a map that lives inside a list element.
	const nested = {
		groups: [
			{
				fields: [
					{
						path: "steps",
						type: "list",
						item: {
							fields: [
								{
									path: "routes",
									type: "map",
									optionalKeys: ["LEAD_RECOVERY"],
									item: { fields: [{ path: "model", label: "Mô hình" }] },
								},
							],
						},
					},
				],
			},
		],
	};
	assert.equal(optionalEntryProblems(nested, { steps: [{ routes: { LEAD_RECOVERY: { other: 1 } } }] }).length, 1);
}

// --- quick switches ----------------------------------------------------------

{
	const routing = { version: 1, hostId: "h", routes: { FAST_READ: { paseoProvider: "pi-peer", model: "a/b", thinking: "low", enabled: false }, REVIEW_HIGH: { paseoProvider: "claude-peer", model: "m", thinking: "high" } } };
	const [group] = listSwitches("routing", routing);
	assert.deepEqual(group.items.map((i) => [i.cls, i.on]), [["FAST_READ", false], ["REVIEW_HIGH", true]]);
	applySwitch("routing", routing, group.items[0], true);
	assert.equal("enabled" in routing.routes.FAST_READ, false, "on is the absence of the key");
	applySwitch("routing", routing, group.items[1], false);
	assert.equal(routing.routes.REVIEW_HIGH.enabled, false);
	assert.equal(routing.routes.REVIEW_HIGH.model, "m", "the route itself is untouched");

	const jobs = {
		version: 1,
		cliTools: { codex: { command: "codex" } },
		disabledTools: ["codex"],
		jobs: { j: { run: "sequential", executors: [{ kind: "class", modelClass: "FAST_READ" }, { kind: "cli", tool: "codex", enabled: false }] } },
	};
	const groups = listSwitches("jobs", jobs);
	assert.deepEqual(groups.map((g) => g.id), ["jobs", "tools"]);
	assert.deepEqual(groups[0].items.map((i) => [i.kind, i.on]), [["job", true], ["executor", true], ["executor", false]]);
	assert.deepEqual(groups[1].items.map((i) => [i.name, i.on]), [["pi", true], ["claude", true], ["codex", false]]);
	applySwitch("jobs", jobs, groups[0].items[2], true);
	assert.equal("enabled" in jobs.jobs.j.executors[1], false);
	applySwitch("jobs", jobs, groups[0].items[0], false);
	assert.equal(jobs.jobs.j.enabled, false);
	applySwitch("jobs", jobs, groups[1].items[2], true);
	assert.equal("disabledTools" in jobs, false, "an empty disabledTools list is dropped");
	applySwitch("jobs", jobs, groups[1].items[0], false);
	assert.deepEqual(jobs.disabledTools, ["pi"]);
	assert.throws(() => applySwitch("jobs", jobs, { kind: "job", id: "__proto__" }, false), /no job/);
	// models: one switch per model the routes use, family taken from the role provider
	const withModels = { version: 1, hostId: "h", routes: { FAST_READ: { paseoProvider: "pi-peer", model: "Mx/a", thinking: "low" }, REVIEW_HIGH: { paseoProvider: "claude-peer", model: "claude-opus-5", thinking: "high" } }, disabledModels: ["pi/Mx/*"] };
	const modelGroup = listSwitches("routing", withModels).find((g) => g.id === "models");
	assert.deepEqual(modelGroup.items.map((i) => [i.key, i.on, i.locked]), [["claude/claude-opus-5", true, false], ["pi/Mx/*", false, false], ["pi/Mx/a", false, true]], "a model covered by a pattern is off and locked to its pattern");
	applySwitch("routing", withModels, modelGroup.items[0], false);
	assert.deepEqual(withModels.disabledModels, ["pi/Mx/*", "claude/claude-opus-5"]);
	applySwitch("routing", withModels, modelGroup.items[1], true);
	applySwitch("routing", withModels, modelGroup.items[0], true);
	assert.equal("disabledModels" in withModels, false, "an empty list is dropped");
	// a class with several options: a class switch (all) plus one switch per option
	const multi = { version: 1, hostId: "h", routes: { CODING_MEDIUM: { paseoProvider: "pi-peer", model: "Mx/a", thinking: "low", alternates: [{ paseoProvider: "claude-peer", model: "claude-opus-5", thinking: "high", enabled: false }] }, FAST_READ: { paseoProvider: "pi-peer", model: "Mx/b", thinking: "low" } } };
	const routeItems = listSwitches("routing", multi).find((g) => g.id === "routes").items;
	assert.deepEqual(routeItems.map((i) => [i.kind, i.cls, i.index ?? "-", i.on]), [["route", "CODING_MEDIUM", "-", true], ["option", "CODING_MEDIUM", 0, true], ["option", "CODING_MEDIUM", 1, false], ["route", "FAST_READ", "-", true]], "options are listed only for a class that has several");
	assert.equal(routeItems[0].detail, "2 options");
	applySwitch("routing", multi, routeItems[2], true);
	assert.equal("enabled" in multi.routes.CODING_MEDIUM.alternates[0], false, "one option back on");
	applySwitch("routing", multi, routeItems[1], false);
	assert.equal(multi.routes.CODING_MEDIUM.enabled, false);
	assert.equal(multi.routes.CODING_MEDIUM.alternates[0].enabled, undefined, "only that option");
	applySwitch("routing", multi, routeItems[0], false);
	assert.equal(multi.routes.CODING_MEDIUM.alternates[0].enabled, false, "the class switch flips every option");
	applySwitch("routing", multi, routeItems[0], true);
	assert.equal("enabled" in multi.routes.CODING_MEDIUM, false);
	assert.ok(listSwitches("routing", multi).find((g) => g.id === "models").items.some((i) => i.key === "claude/claude-opus-5"), "an alternate's model gets its own model switch");
	assert.deepEqual(listSwitches("pi-settings", {}), []);
}

console.log("config-form tests passed");

// optionModelOff: the form says "off" exactly when the gate would refuse the model.
{
	const doc = { disabledModels: ["pi/Minnyat/gpt-5.5", "claude/*"] };
	assert.equal(optionModelOff(doc, { paseoProvider: "pi-peer", model: "Minnyat/gpt-5.5" }), true, "an exact key");
	assert.equal(optionModelOff(doc, { paseoProvider: "pi-peer", model: "Minnyat/cheap" }), false, "another model of the same tool");
	assert.equal(optionModelOff(doc, { paseoProvider: "claude-peer", model: "claude-opus-5" }), true, "a /* pattern covers the whole tool");
	assert.equal(optionModelOff({}, { paseoProvider: "pi-peer", model: "x" }), false, "no list, nothing off");
}
