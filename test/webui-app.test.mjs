// webui-app.test.mjs — webui/public/app.js exercised as a browser would run it.
//
// Why this file exists: app.js had no behavioural test, and two bugs walked
// straight through every other check.
//   - `roleLabel` was dropped from the humanize.js import while
//     roleProviderControl still called it. The routing and cluster forms threw
//     a ReferenceError on their first route card and rendered no card at all;
//     webui-dom.test.mjs only matches $("id") lookups, so nothing noticed.
//   - enumControl compared against `select.value` after assigning a value the
//     list does not carry. A browser reads that back as "", which matched the
//     default option, so a claude model left behind by a runtime switch showed
//     as "— mặc định —" while the document kept it — and Save wrote a routing
//     file the route gate refuses for EVERY seat.
//
// So the real module is loaded into a small DOM written for this file (the
// repo has no DOM dependency), fed the real routing/cluster schema through the
// real WebUI server, and driven the way a person would: open the form, switch a
// runtime, press Lưu. The fake <select> follows the browser rule the second bug
// hinged on: a value no option carries reads back as "".
//
// Run: node test/webui-app.test.mjs   (node >= 22)

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { schemaForSection, withModelInventory } from "../cli/lib/config-schema.mjs";
import { validateClusterConfig, validateRoutingConfig } from "../scripts/model-routing.mjs";
import { handleApi, startServer } from "../webui/server.mjs";
import { fillKeptEmpty, pruneEmpty } from "../webui/public/config-form.js";
import { humanizeError } from "../webui/public/humanize.js";

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "webui", "public");

// --- every helper app.js calls from its sibling modules is imported ----------
// Cheap and file-wide: the same mistake on a path the drive-through below never
// reaches (a different tab, a rarely used control) is still caught here.
{
	const app = readFileSync(join(PUBLIC_DIR, "app.js"), "utf8");
	const importBlock = (module) => {
		const found = new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*"\\./${module.replace(".", "\\.")}"`).exec(app);
		assert.ok(found, `app.js imports from ./${module}`);
		return new Set(found[1].split(",").map((name) => name.trim()).filter(Boolean));
	};
	for (const module of ["humanize.js", "config-form.js"]) {
		const imported = importBlock(module);
		const source = readFileSync(join(PUBLIC_DIR, module), "utf8");
		const exported = [...source.matchAll(/^export\s+(?:async\s+)?(?:function|const|let)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
		for (const name of exported) {
			const used = new RegExp(`(?<![\\w$.])${name.replace("$", "\\$")}(?![\\w$])`).test(
				app.replace(/import\s*\{[^}]*\}\s*from\s*"[^"]*";/g, ""),
			);
			const local = new RegExp(`(?:function|const|let|var)\\s+${name}\\b`).test(app);
			if (used && !local) assert.ok(imported.has(name), `app.js uses ${name} from ./${module} without importing it`);
		}
	}
}

// --- the server refuses a routing/cluster document the resolver would refuse --
const ROUTING_DOC = {
	version: 1,
	hostId: "box-1",
	routes: {
		MONITOR_ECONOMY: { paseoProvider: "claude-supervisor", model: "claude-sonnet-5-5", thinking: "low" },
		FAST_READ: { paseoProvider: "pi-peer", model: "box/flash", thinking: "low" },
		CODING_MEDIUM: { paseoProvider: "pi-peer", model: "box/terra", thinking: "medium" },
		REASONING_HIGH: { paseoProvider: "claude-peer", model: "claude-opus-5-5", thinking: "high" },
		REVIEW_HIGH: { paseoProvider: "claude-peer", model: "claude-opus-5-5", thinking: "high" },
		SUPERVISOR_GOVERNANCE: { paseoProvider: "claude-supervisor", model: "claude-opus-5-5", thinking: "high" },
	},
};
validateRoutingConfig(ROUTING_DOC); // the fixture itself is a file the gate accepts

{
	const seen = [];
	const exec = (args, stdin) => {
		seen.push({ args, stdin });
		return Promise.resolve({ exitCode: 0, stdout: "{}", stderr: "" });
	};
	const post = (section, doc) =>
		handleApi({
			method: "POST",
			pathname: "/api/config",
			query: { section },
			rawBody: typeof doc === "string" ? doc : JSON.stringify(doc),
			exec,
		});
	const refused = (section, doc, pattern) =>
		assert.rejects(post(section, doc), (error) => {
			assert.equal(error.status, 400);
			assert.equal(error.code, "CONFIG_INVALID");
			assert.match(error.message, pattern);
			return true;
		});

	// The exact file the old form saved after switching MONITOR_ECONOMY to pi.
	const leftover = structuredClone(ROUTING_DOC);
	leftover.routes.MONITOR_ECONOMY.paseoProvider = "pi-supervisor";
	await refused("routing", leftover, /MONITOR_ECONOMY.*<pi-provider>\/<model-id>/);
	// A governance class seated by the wrong role is refused too.
	const wrongRole = structuredClone(ROUTING_DOC);
	wrongRole.routes.SUPERVISOR_GOVERNANCE.paseoProvider = "claude-peer";
	await refused("routing", wrongRole, /SUPERVISOR_GOVERNANCE.*supervisor role provider/);
	await refused("routing", { version: 1, hostId: "box-1", routes: {} }, /missing required class/);
	await refused("routing", "{not json", /not valid JSON/);
	await refused("cluster", { version: 1, hosts: { a: { connection: { type: "remote" }, required: true } } }, /endpointEnv/);
	assert.equal(seen.length, 0, "a refused document never reaches `config write`");

	// A valid document goes through byte for byte, rev included.
	const raw = JSON.stringify(ROUTING_DOC, null, 2);
	const ok = await handleApi({ method: "POST", pathname: "/api/config", query: { section: "routing", rev: "absent" }, rawBody: raw, exec });
	assert.deepEqual(ok.args, ["config", "write", "routing", "--rev", "absent"]);
	assert.equal(ok.stdin, raw);
	// Sections the route gate does not read keep their old, unvalidated path.
	const other = await post("pi-settings", {});
	assert.deepEqual(other.args, ["config", "write", "pi-settings"]);
}

// --- and the refusal is explained with the validator's own sentence -----------
{
	const message = 'host "a": remote connection requires a non-empty endpointEnv (env-var NAME only — never a value)';
	const info = humanizeError({ ok: false, code: "CONFIG_INVALID", message });
	assert.equal(info.title, "Chưa lưu: cấu hình không hợp lệ", "not 'Paseo is down' just because the text says connection");
	assert.ok(info.advice.includes(message), "the advice carries which host/route and what is wrong");
	assert.match(info.advice, /giữ nguyên/, "and says the file was not touched");
	// The validator's own message arrives as "CONFIG_INVALID: route …"; the code
	// is already in the title, so it is not repeated mid-sentence.
	const prefixed = humanizeError({ ok: false, code: "CONFIG_INVALID", message: `CONFIG_INVALID: ${message}` });
	assert.ok(prefixed.advice.endsWith(`— ${message}`), `prefix stripped: ${prefixed.advice}`);
	assert.doesNotMatch(prefixed.advice, /CONFIG_INVALID/);
}

// --- the save prune keeps the empty lists a validator requires ---------------
{
	const schema = schemaForSection("cluster");
	const doc = {
		version: 1,
		hosts: { a: { connection: { type: "local" }, required: true, capabilities: [], routes: {} } },
	};
	const saved = fillKeptEmpty(schema, pruneEmpty(doc));
	assert.deepEqual(saved.hosts.a.capabilities, [], "a keepEmpty list comes back after the prune");
	assert.equal(saved.hosts.a.routes, undefined, "a list/object without keepEmpty stays pruned");
	assert.deepEqual(Object.keys(fillKeptEmpty(schema, { version: 1, hosts: {} }).hosts), [], "no host is invented");

	// A host id is any non-empty string, dots included. Built into a dotted
	// path and split again, "mac.local" turned into a phantom host "mac" with a
	// "local" child, and a cluster file that saved as-is was refused.
	const dotted = {
		version: 1,
		hosts: {
			"mac.local": { connection: { type: "local" }, required: true, capabilities: [], routes: structuredClone(ROUTING_DOC.routes) },
		},
	};
	const savedDotted = fillKeptEmpty(schema, pruneEmpty(structuredClone(dotted)));
	assert.deepEqual(Object.keys(savedDotted.hosts), ["mac.local"], "the dotted host id is kept whole, no phantom host");
	assert.deepEqual(savedDotted.hosts["mac.local"].capabilities, []);
	validateClusterConfig(savedDotted);

	// Every other section's save is unchanged: nothing in them is keepEmpty.
	for (const section of ["routing", "pi-models", "pi-settings", "mcp", "providers", "seats"]) {
		const before = { version: 1 };
		assert.deepEqual(fillKeptEmpty(schemaForSection(section), structuredClone(before)), before, `${section}: untouched`);
	}
}

// --- a DOM just big enough for app.js -----------------------------------------

class Event {
	constructor(type, { bubbles = false } = {}) {
		this.type = type;
		this.bubbles = bubbles;
		this.target = null;
		this.currentTarget = null;
		this.defaultPrevented = false;
		this.stopped = false;
	}
	preventDefault() {
		this.defaultPrevented = true;
	}
	stopPropagation() {
		this.stopped = true;
	}
}

class Node {
	constructor() {
		this.childNodes = [];
		this.parentNode = null;
		this.listeners = new Map();
	}
	get firstChild() {
		return this.childNodes[0] ?? null;
	}
	get children() {
		return this.childNodes.filter((child) => child instanceof Element);
	}
	appendChild(child) {
		return this.insertBefore(child, null);
	}
	insertBefore(child, ref) {
		if (child.parentNode) child.parentNode.removeChild(child);
		const at = ref ? this.childNodes.indexOf(ref) : -1;
		if (at < 0) this.childNodes.push(child);
		else this.childNodes.splice(at, 0, child);
		child.parentNode = this;
		return child;
	}
	removeChild(child) {
		const at = this.childNodes.indexOf(child);
		if (at >= 0) this.childNodes.splice(at, 1);
		child.parentNode = null;
		this.childRemoved?.(child);
		return child;
	}
	remove() {
		this.parentNode?.removeChild(this);
	}
	get textContent() {
		return this.childNodes.map((child) => child.textContent).join("");
	}
	set textContent(value) {
		for (const child of [...this.childNodes]) this.removeChild(child);
		if (value !== "" && value !== null && value !== undefined) this.appendChild(new Text(String(value)));
	}
	addEventListener(type, listener) {
		if (!this.listeners.has(type)) this.listeners.set(type, []);
		this.listeners.get(type).push(listener);
	}
	removeEventListener(type, listener) {
		const list = this.listeners.get(type) ?? [];
		const at = list.indexOf(listener);
		if (at >= 0) list.splice(at, 1);
	}
	dispatchEvent(event) {
		event.target = this;
		for (let node = this; node; node = event.bubbles ? node.parentNode : null) {
			event.currentTarget = node;
			for (const listener of [...(node.listeners.get(event.type) ?? [])]) listener.call(node, event);
			if (event.stopped) break;
		}
		return !event.defaultPrevented;
	}
}

class Text extends Node {
	constructor(data) {
		super();
		this.data = data;
	}
	get textContent() {
		return this.data;
	}
	set textContent(value) {
		this.data = String(value);
	}
}

const kebab = (camel) => camel.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

class Element extends Node {
	constructor(tag) {
		super();
		this.tagName = tag.toUpperCase();
		this.attributes = new Map();
		this.disabled = false;
		this.checked = false;
		this.hidden = false;
		this.open = false;
		const self = this;
		this.classList = {
			contains: (name) => self.classes().includes(name),
			add: (...names) => self.setClasses([...new Set([...self.classes(), ...names])]),
			remove: (...names) => self.setClasses(self.classes().filter((c) => !names.includes(c))),
			toggle: (name, force) => {
				const on = force === undefined ? !self.classList.contains(name) : Boolean(force);
				if (on) self.classList.add(name);
				else self.classList.remove(name);
				return on;
			},
		};
		this.dataset = new Proxy(
			{},
			{
				get: (_, key) => (typeof key === "string" ? self.getAttribute(`data-${kebab(key)}`) ?? undefined : undefined),
				set: (_, key, value) => {
					self.setAttribute(`data-${kebab(key)}`, value);
					return true;
				},
			},
		);
	}
	classes() {
		return (this.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
	}
	setClasses(list) {
		this.setAttribute("class", list.join(" "));
	}
	get className() {
		return this.getAttribute("class") ?? "";
	}
	set className(value) {
		this.setAttribute("class", value);
	}
	get id() {
		return this.getAttribute("id") ?? "";
	}
	set id(value) {
		this.setAttribute("id", value);
	}
	setAttribute(name, value) {
		this.attributes.set(name, String(value));
	}
	getAttribute(name) {
		return this.attributes.has(name) ? this.attributes.get(name) : null;
	}
	hasAttribute(name) {
		return this.attributes.has(name);
	}
	removeAttribute(name) {
		this.attributes.delete(name);
	}
	get value() {
		if (this.tagName === "OPTION") return this.getAttribute("value") ?? this.textContent;
		return this._value ?? this.getAttribute("value") ?? "";
	}
	set value(next) {
		this._value = String(next);
	}
	get placeholder() {
		return this.getAttribute("placeholder") ?? "";
	}
	set placeholder(value) {
		this.setAttribute("placeholder", value);
	}
	get type() {
		return this.getAttribute("type") ?? "";
	}
	set type(value) {
		this.setAttribute("type", value);
	}
	get title() {
		return this.getAttribute("title") ?? "";
	}
	set title(value) {
		this.setAttribute("title", value);
	}
	focus() {}
	blur() {}
	select() {}
	click() {
		if (!this.disabled) this.dispatchEvent(new Event("click", { bubbles: true }));
	}
	descendants() {
		const out = [];
		const walk = (node) => {
			for (const child of node.children) {
				out.push(child);
				walk(child);
			}
		};
		walk(this);
		return out;
	}
	querySelectorAll(selector) {
		return this.descendants().filter((node) => matches(node, selector, this));
	}
	querySelector(selector) {
		return this.querySelectorAll(selector)[0] ?? null;
	}
	closest(selector) {
		for (let node = this; node instanceof Element; node = node.parentNode) if (matches(node, selector, null)) return node;
		return null;
	}
}

/**
 * <select> as a browser keeps it: the selection is an option, not a string.
 * Assigning a value that no option carries selects nothing, and `value` then
 * reads "" — the rule enumControl's out-of-list branch tripped over.
 */
class SelectElement extends Element {
	constructor() {
		super("select");
		this.selected = null;
		this.selectionSet = false;
	}
	get options() {
		return this.descendants().filter((node) => node.tagName === "OPTION");
	}
	get selectedIndex() {
		const options = this.options;
		if (this.selected && options.includes(this.selected)) return options.indexOf(this.selected);
		return this.selectionSet || options.length === 0 ? -1 : 0;
	}
	get value() {
		const index = this.selectedIndex;
		return index < 0 ? "" : this.options[index].value;
	}
	set value(next) {
		this.selectionSet = true;
		this.selected = this.options.find((option) => option.value === String(next)) ?? null;
	}
	childRemoved(child) {
		if (child === this.selected || child.descendants?.().includes(this.selected)) {
			this.selected = null;
			this.selectionSet = false;
		}
	}
}

/** Compound selectors (tag, #id, .class, [attr], [attr="v"]) joined by spaces. */
function matches(node, selector, scope) {
	const parts = selector.trim().match(/(?:[^\s"[\]]+|\[[^\]]*\])+/g) ?? [];
	const compound = (el, part) => {
		const tokens = part.match(/^[a-zA-Z][\w-]*|#[\w-]+|\.[\w-]+|\[[^\]]+\]/g) ?? [];
		return tokens.every((token) => {
			if (token.startsWith("#")) return el.id === token.slice(1);
			if (token.startsWith(".")) return el.classList.contains(token.slice(1));
			if (token.startsWith("[")) {
				const [, name, value] = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(token) ?? [];
				return value === undefined ? el.hasAttribute(name) : el.getAttribute(name) === value;
			}
			return el.tagName === token.toUpperCase();
		});
	};
	if (!compound(node, parts.at(-1))) return false;
	let cursor = node.parentNode;
	for (let i = parts.length - 2; i >= 0; i--) {
		while (cursor instanceof Element && cursor !== scope && !compound(cursor, parts[i])) cursor = cursor.parentNode;
		if (!(cursor instanceof Element) || cursor === scope) return false;
		cursor = cursor.parentNode;
	}
	return true;
}

const body = new Element("body");
const document = {
	body,
	hidden: false,
	createElement: (tag) => (tag.toLowerCase() === "select" ? new SelectElement() : new Element(tag)),
	createElementNS: (_, tag) => new Element(tag),
	createTextNode: (text) => new Text(text),
	querySelectorAll: (selector) => body.querySelectorAll(selector),
	querySelector: (selector) => body.querySelector(selector),
	// index.html is not parsed: an id app.js reaches for is created on first use.
	// webui-dom.test.mjs already checks every $("id") exists in the real page.
	getElementById(id) {
		const found = body.descendants().find((node) => node.id === id);
		if (found) return found;
		const made = new Element("div");
		made.id = id;
		body.appendChild(made);
		return made;
	},
	addEventListener() {},
};

function storage(initial = {}) {
	const map = new Map(Object.entries(initial));
	return {
		getItem: (key) => (map.has(key) ? map.get(key) : null),
		setItem: (key, value) => map.set(key, String(value)),
		removeItem: (key) => map.delete(key),
	};
}

// --- the CLI behind the real server: config read/write on an in-memory file ---

const INVENTORY = {
	"pi-supervisor": ["box/flash", "box/terra"],
	"pi-lead": ["box/flash", "box/terra"],
	"pi-peer": ["box/flash", "box/terra"],
	"claude-supervisor": ["claude-sonnet-5-5", "claude-opus-5-5"],
	"claude-lead": ["claude-sonnet-5-5", "claude-opus-5-5"],
	"claude-peer": ["claude-sonnet-5-5", "claude-opus-5-5"],
};
// Two sections stand in for schemas this branch does not have yet. "mcp" serves
// a per-model limits map keyed by model ids (`gpt-5.5`, `poolside/laguna-s-2.1`),
// "paseo" a jobs-shaped map whose items hold a `list` of executors (contract
// S7). The section names only pick a file slot in this fake CLI; neither has a
// server-side validator, so what reaches `config write` is exactly what the
// form sent.
const ROUTE_FIELD = (name) =>
	schemaForSection("routing")
		.groups.flatMap((group) => group.fields)
		.find((field) => field.path === "routes")
		.item.fields.find((field) => field.path === name);
const LIMITS_SCHEMA = {
	label: "Giới hạn theo model (thử)",
	seed: { version: 1, providers: {} },
	groups: [
		{
			id: "providers",
			label: "Điểm cuối",
			fields: [
				{
					path: "providers",
					type: "map",
					keyLabel: "Tên provider",
					item: {
						fields: [
							{
								path: "models",
								type: "map",
								keyLabel: "Model id",
								addLabel: "Thêm model",
								item: {
									fields: [
										{ path: "contextWindow", type: "number", min: 1024, label: "Context window" },
										{ path: "maxTokens", type: "number", min: 256, label: "Max output tokens" },
									],
								},
							},
						],
					},
				},
			],
		},
	],
};
const LIMITS_DOC = {
	version: 1,
	providers: {
		minnyat: {
			baseUrl: "https://example.invalid/v1",
			models: {
				"gpt-5": { contextWindow: 400000 },
				"gpt-5.5": { contextWindow: 1050000, maxTokens: 128000 },
				"poolside/laguna-s-2.1": { maxTokens: 8000 },
			},
		},
	},
};
const JOBS_SCHEMA = {
	label: "Jobs (thử)",
	seed: { version: 1, jobs: {} },
	groups: [
		{
			id: "jobs",
			label: "Jobs",
			fields: [
				{
					path: "jobs",
					type: "map",
					keyLabel: "Tên job",
					addLabel: "Thêm job",
					item: {
						seed: { executors: [{ kind: "class" }] },
						fields: [
							{ path: "run", type: "enum", enum: ["parallel", "sequential"], label: "Cách chạy" },
							{
								path: "executors",
								type: "list",
								label: "Executors",
								addLabel: "Thêm executor",
								minItems: 1,
								item: {
									seed: { kind: "class" },
									fields: [
										{ path: "kind", type: "enum", enum: ["class", "route", "cli"], label: "Loại" },
										{
											path: "modelClass",
											type: "enum",
											enum: ["FAST_READ", "REVIEW_HIGH"],
											label: "Lớp việc",
											showIf: { path: "kind", equals: "class" },
										},
										{ ...ROUTE_FIELD("paseoProvider"), showIf: { path: "kind", equals: "route" } },
										{
											...ROUTE_FIELD("model"),
											optionsBy: { path: "paseoProvider", source: "models", map: INVENTORY },
											showIf: { path: "kind", equals: "route" },
										},
										{ path: "tool", type: "string", label: "Công cụ", showIf: { path: "kind", equals: "cli" } },
										{ path: "args", type: "lines", label: "Tham số", showIf: { path: "kind", equals: "cli" } },
									],
								},
							},
						],
					},
				},
			],
		},
	],
};
const JOBS_DOC = {
	version: 1,
	jobs: {
		"re.view": {
			run: "sequential",
			executors: [
				{ kind: "class", modelClass: "FAST_READ" },
				{ kind: "cli", tool: "claude", args: ["-p"] },
			],
		},
	},
};
const SCHEMA_OVERRIDE = { mcp: LIMITS_SCHEMA, paseo: JOBS_SCHEMA };

const files = {
	routing: JSON.stringify(ROUTING_DOC, null, 2),
	cluster: null,
	mcp: JSON.stringify(LIMITS_DOC, null, 2),
	paseo: JSON.stringify(JOBS_DOC, null, 2),
	"pi-models": JSON.stringify({ version: 1, providers: { minnyat: { baseUrl: "https://example.invalid/v1" } } }, null, 2),
};
// What the next `models sync` answers, in order; a report with ok:false exits
// non-zero, as the real CLI does.
const syncReplies = [];
const writes = [];
const rev = (text) => (text === null ? "absent" : createHash("sha256").update(text).digest("hex"));

async function fakeCli(args, stdin) {
	const [command, verb, section] = args;
	if (command === "config" && verb === "read" && section in files) {
		const text = files[section];
		const payload = {
			exists: text !== null,
			path: `/tmp/fake/${section}.local.json`,
			rev: rev(text),
			data: text === null ? null : JSON.parse(text),
			schema: SCHEMA_OVERRIDE[section] ?? withModelInventory(schemaForSection(section), INVENTORY),
		};
		return { exitCode: 0, stdout: JSON.stringify(payload), stderr: "" };
	}
	if (command === "config" && verb === "write" && section in files) {
		writes.push({ section, doc: JSON.parse(stdin) });
		files[section] = stdin;
		return { exitCode: 0, stdout: JSON.stringify({ ok: true, path: `/tmp/fake/${section}.local.json` }), stderr: "" };
	}
	if (command === "models" && verb === "sync" && syncReplies.length > 0) {
		const report = syncReplies.shift();
		return { exitCode: report.ok === false ? 1 : 0, stdout: JSON.stringify(report), stderr: "" };
	}
	return { exitCode: 1, stdout: "", stderr: `unexpected command in test: ${args.join(" ")}` };
}

const server = await startServer({ port: 0, requireToken: false, quiet: true, runCli: fakeCli });
const realFetch = globalThis.fetch;
const realSetTimeout = globalThis.setTimeout;
const realSetInterval = globalThis.setInterval;

Object.assign(globalThis, {
	document,
	window: { addEventListener() {} },
	location: { hash: "", pathname: "/", search: "" },
	history: { replaceState() {} },
	sessionStorage: storage(),
	localStorage: storage({ "paseo-team-advanced": "1" }),
	CSS: { escape: (value) => String(value) },
	confirm: () => true,
	// Only the config and model-sync endpoints are wired to the server. The home tab's polls
	// stay pending forever, which is harmless and keeps their render paths (not
	// under test here) from running on half-shaped data.
	fetch: (path, init) =>
		/^\/api\/(config|models)/.test(String(path)) ? realFetch(`http://127.0.0.1:${server.port}${path}`, init) : new Promise(() => {}),
	// The page's polls and the toast's auto-hide must not keep the test alive.
	setInterval: () => 0,
	setTimeout: (fn, ms, ...rest) => realSetTimeout(fn, ms, ...rest).unref(),
});

try {
	await import(pathToFileURL(join(PUBLIC_DIR, "app.js")).href);

	const $ = (id) => document.getElementById(id);
	const toastText = () => ($("toast").classList.contains("hidden") ? "" : $("toast").textContent);
	const errorToast = () => ($("toast").classList.contains("err") && !$("toast").classList.contains("hidden") ? $("toast").textContent : "");
	const tick = () => new Promise((resolve) => setImmediate(resolve));
	async function until(predicate, what) {
		for (let i = 0; i < 2000; i++) {
			if (predicate()) return;
			await new Promise((resolve) => realSetTimeout(resolve, 5));
		}
		assert.fail(`timed out waiting for: ${what} (toast: "${toastText()}")`);
	}
	const change = (node, value) => {
		node.value = value;
		node.dispatchEvent(new Event("change", { bubbles: true }));
	};
	const resetToast = () => {
		$("toast").textContent = "";
		$("toast").classList.remove("err");
		$("toast").classList.add("hidden");
	};
	const card = (key, within = $("config-form")) => within.querySelector(`.cfg-card[data-key="${key}"]`);
	const routeCards = (within = $("config-form")) =>
		within.querySelectorAll(".cfg-card").filter((node) => node.querySelector(".cfg-roleprovider"));
	const runtimeSelect = (routeCard) => routeCard.querySelectorAll(".cfg-roleprovider select")[1];
	const modelSelect = (routeCard) => routeCard.querySelector(".cfg-swap select");
	async function openSection(section, meta = `${section}.local.json`) {
		resetToast();
		$("config-meta").textContent = "";
		change($("config-section"), section);
		await until(() => $("config-meta").textContent.includes(meta), `${section} form loaded`);
		await tick();
	}
	// Fill a route card through its controls, in the order a person would.
	function fillRoute(routeCard, { role, runtime, model, thinking }) {
		const [roleSel, runtimeSel] = routeCard.querySelectorAll(".cfg-roleprovider select");
		change(roleSel, role);
		change(runtimeSel, runtime);
		change(modelSelect(routeCard), model);
		const thinkingSel = routeCard.querySelectorAll("select").at(-1);
		change(thinkingSel, thinking);
	}
	const CLAUDE_PEER = { role: "peer", runtime: "claude", model: "claude-opus-5-5", thinking: "high" };
	async function save() {
		const before = writes.length;
		resetToast();
		// A successful save re-reads the file and rebuilds the form. Until that
		// rebuild lands, an edit made to the old form is thrown away by it, so
		// the nodes on screen now are marked and a save waits for them to go.
		for (const node of $("config-form").children) node.dataset.stale = "1";
		$("config-save").click();
		await until(() => toastText() !== "", "a save result toast");
		if (writes.length === before) return null;
		await until(() => !$("config-form").querySelector("[data-stale]"), "the form rebuilt from the saved file");
		await tick();
		return writes.at(-1);
	}

	// --- routing: every route card renders ---------------------------------
	await openSection("routing");
	assert.equal(errorToast(), "", "opening the routing form raises no error");
	assert.equal(routeCards().length, 6, "five required classes + the configured SUPERVISOR_GOVERNANCE");
	for (const key of Object.keys(ROUTING_DOC.routes)) {
		const route = card(key);
		assert.ok(route, `${key} has a card`);
		const [roleSel, runtimeSel] = route.querySelectorAll(".cfg-roleprovider select");
		const [runtime, role] = ROUTING_DOC.routes[key].paseoProvider.split("-");
		assert.equal(roleSel.value, role, `${key}: role shown`);
		assert.equal(runtimeSel.value, runtime, `${key}: runtime shown`);
		assert.equal(modelSelect(route).value, ROUTING_DOC.routes[key].model, `${key}: model shown`);
	}
	assert.ok(
		roleSelText(card("MONITOR_ECONOMY")).every((text) => text.trim() !== ""),
		"role options carry a readable label",
	);

	// An untouched, valid file saves as it is.
	const unchanged = await save();
	assert.ok(unchanged, `an unchanged valid file reaches config write (toast: "${toastText()}")`);
	assert.deepEqual(unchanged.doc, ROUTING_DOC);
	assert.equal(routeCards().length, 6, "the rebuilt form still has every card");

	// --- switching a runtime keeps the stray model VISIBLE ------------------
	change(runtimeSelect(card("MONITOR_ECONOMY")), "pi");
	await tick();
	const model = modelSelect(card("MONITOR_ECONOMY"));
	assert.equal(model.value, "claude-sonnet-5-5", "the model the document still holds is the one selected");
	const selected = model.options[model.selectedIndex];
	assert.match(selected.textContent, /claude-sonnet-5-5 \(ngoài danh sách\)/, "and it is flagged out-of-list, not shown as the default");
	assert.ok(model.options.some((option) => option.value === "box/flash"), "the pi list is offered");

	// --- and saving it is refused before the file is touched ----------------
	const refusedWrite = await save();
	assert.equal(refusedWrite, null, "the invalid routing document never reached config write");
	assert.match(errorToast(), /Chưa lưu/, "the toast says nothing was saved");
	assert.match(errorToast(), /MONITOR_ECONOMY/, "and names the route to fix");
	assert.match(errorToast(), /<pi-provider>\/<model-id>/, "and what form the model must take");
	assert.match(errorToast(), /Lưu lại — route MONITOR_ECONOMY/, "the reason follows the advice without the bare error code");
	assert.deepEqual(JSON.parse(files.routing), ROUTING_DOC, "the file on disk is still the valid one");

	// Picking a model from the pi list makes it savable.
	change(modelSelect(card("MONITOR_ECONOMY")), "box/flash");
	const fixed = await save();
	assert.ok(fixed, `a valid switch is saved (toast: "${toastText()}")`);
	assert.deepEqual(fixed.doc.routes.MONITOR_ECONOMY, { paseoProvider: "pi-supervisor", model: "box/flash", thinking: "low" });
	validateRoutingConfig(fixed.doc);

	// --- routing from nothing: a form filled from the seed is savable --------
	// A refusal on THIS path would leave a new machine with no way to write its
	// first routing file from the browser.
	files.routing = null;
	await openSection("routing", "chưa tồn tại");
	assert.equal(errorToast(), "", "an absent routing file opens without error");
	const hostRow = $("config-form").querySelectorAll(".cfg-field").find((row) => row.textContent.includes("hostId"));
	const hostInput = hostRow.querySelector("input");
	hostInput.value = "box-2";
	hostInput.dispatchEvent(new Event("input", { bubbles: true }));
	for (const key of ["MONITOR_ECONOMY", "FAST_READ", "CODING_MEDIUM", "REASONING_HIGH", "REVIEW_HIGH"]) {
		fillRoute(card(key), CLAUDE_PEER);
	}
	const first = await save();
	assert.ok(first, `a routing file filled in from scratch is saved (toast: "${toastText()}")`);
	assert.equal(first.doc.hostId, "box-2");
	validateRoutingConfig(first.doc);

	// --- cluster: a new host gets its route cards ----------------------------
	await openSection("cluster");
	assert.equal(errorToast(), "", "opening the cluster form raises no error");
	const addHost = $("config-form").querySelectorAll("button").find((button) => button.textContent === "Thêm máy");
	assert.ok(addHost, "the cluster form offers Thêm máy");
	addHost.click();
	await tick();
	assert.equal(errorToast(), "", "adding a host raises no error");
	const host = card("moi");
	assert.ok(host, "the new host card is there");
	assert.equal(routeCards(host).length, 5, "the new host shows the five required route cards");

	// Filled in and saved: the host's empty capability list must survive the
	// save prune, or validateClusterConfig refuses every host without one.
	for (const routeCard of routeCards(host)) fillRoute(routeCard, CLAUDE_PEER);
	const cluster = await save();
	assert.ok(cluster, `a new cluster host is saved (toast: "${toastText()}")`);
	assert.deepEqual(cluster.doc.hosts.moi.capabilities, [], "capabilities is written even when empty");
	validateClusterConfig(cluster.doc);

	// --- cluster: hosts "mac" and "mac.local" side by side (S6) ---------------
	// The reviewer's reproduction: editing mac.local's card said "Đã lưu" but
	// wrote hosts.mac.local — a child of host mac. Every action on the dotted
	// card is driven here, and host mac must come out byte-identical each time.
	const HOST = (writers) => ({
		connection: { type: "local" },
		required: true,
		capabilities: [],
		limits: { writers, readers: 2 },
		routes: structuredClone(ROUTING_DOC.routes),
	});
	const TWO_HOSTS = { version: 1, hosts: { mac: HOST(1), "mac.local": HOST(3) } };
	validateClusterConfig(TWO_HOSTS);
	files.cluster = JSON.stringify(TWO_HOSTS, null, 2);
	await openSection("cluster");
	assert.equal(errorToast(), "");
	const rowByLabel = (within, text) =>
		within.querySelectorAll(".cfg-field").find((row) => row.querySelector(".cfg-label label")?.textContent === text);
	const writersInput = (key) => rowByLabel(card(key), "Số agent được ghi file cùng lúc").querySelector("input");
	const type = (input, value) => {
		input.value = value;
		input.dispatchEvent(new Event("input", { bubbles: true }));
	};
	assert.equal(writersInput("mac").value, "1");
	assert.equal(writersInput("mac.local").value, "3", "mac.local's card shows its own value, not an empty default");

	const clusterUntouched = await save();
	assert.ok(clusterUntouched, `an unedited cluster saves (toast: "${toastText()}")`);
	assert.deepEqual(clusterUntouched.doc, TWO_HOSTS, "opening the form and pressing Lưu changes nothing");

	type(writersInput("mac.local"), "5");
	const editedHost = await save();
	assert.ok(editedHost, `editing mac.local saves (toast: "${toastText()}")`);
	assert.deepEqual(Object.keys(editedHost.doc.hosts), ["mac", "mac.local"], "no host invented, none lost");
	assert.equal(editedHost.doc.hosts["mac.local"].limits.writers, 5, "the edit lands on mac.local");
	assert.deepEqual(editedHost.doc.hosts.mac, TWO_HOSTS.hosts.mac, "and host mac is untouched");

	change(card("mac.local").querySelector(".cfg-card-key"), "mac.lan");
	await tick();
	assert.ok(card("mac.lan"), "the renamed card is there");
	assert.equal(card("mac.local"), null, "and the old one is gone, not duplicated");
	const renamedHost = await save();
	assert.ok(renamedHost, `a renamed dotted host saves (toast: "${toastText()}")`);
	assert.deepEqual(Object.keys(renamedHost.doc.hosts), ["mac", "mac.lan"]);
	assert.equal(renamedHost.doc.hosts["mac.lan"].limits.writers, 5, "the renamed host keeps its settings");
	assert.deepEqual(renamedHost.doc.hosts.mac, TWO_HOSTS.hosts.mac);

	card("mac.lan").querySelector(".cfg-card-head .cfg-icon").click();
	await tick();
	assert.equal(card("mac.lan"), null, "the × on a dotted card removes that card");
	const removedHost = await save();
	assert.ok(removedHost, `removing a dotted host saves (toast: "${toastText()}")`);
	assert.deepEqual(removedHost.doc.hosts, { mac: TWO_HOSTS.hosts.mac }, "only mac is left, as it was");

	$("config-form").querySelectorAll("button").find((button) => button.textContent === "Thêm máy").click();
	await tick();
	change(card("moi").querySelector(".cfg-card-key"), "studio.local");
	await tick();
	for (const routeCard of routeCards(card("studio.local"))) fillRoute(routeCard, CLAUDE_PEER);
	type(writersInput("studio.local"), "2");
	const addedHost = await save();
	assert.ok(addedHost, `a new host named with a dot saves (toast: "${toastText()}")`);
	assert.deepEqual(Object.keys(addedHost.doc.hosts), ["mac", "studio.local"]);
	assert.equal(addedHost.doc.hosts["studio.local"].limits.writers, 2);
	assert.deepEqual(addedHost.doc.hosts["studio.local"].capabilities, [], "keepEmpty still reaches a dotted host");
	assert.deepEqual(addedHost.doc.hosts.mac, TWO_HOSTS.hosts.mac);
	validateClusterConfig(addedHost.doc);

	// --- model ids with dots as map keys ---------------------------------------
	// `gpt-5` next to `gpt-5.5`: the dotted path for gpt-5.5 split into
	// models["gpt-5"]["5"], so the card showed nothing, edits went under gpt-5,
	// and the range check looked at the wrong number.
	await openSection("mcp");
	assert.equal(errorToast(), "");
	const limitInput = (id, label) => rowByLabel(card(id), label).querySelector("input");
	assert.equal(limitInput("gpt-5.5", "Context window").value, "1050000", "gpt-5.5 shows its own limit");
	assert.equal(limitInput("gpt-5", "Context window").value, "400000");
	assert.equal(limitInput("poolside/laguna-s-2.1", "Max output tokens").value, "8000", "a slash-and-dot id too");

	const limitsUntouched = await save();
	assert.ok(limitsUntouched, `an unedited limits map saves (toast: "${toastText()}")`);
	assert.deepEqual(limitsUntouched.doc, LIMITS_DOC, "opening the form and pressing Lưu changes nothing");

	type(limitInput("gpt-5.5", "Context window"), "10");
	assert.equal(await save(), null, "an out-of-range value under a dotted key is refused before the write");
	assert.match(errorToast(), /Context window phải là số từ 1024/);
	type(limitInput("gpt-5.5", "Context window"), "2000000");
	const limitsEdited = await save();
	assert.ok(limitsEdited, `a valid edit saves (toast: "${toastText()}")`);
	assert.deepEqual(limitsEdited.doc.providers.minnyat.models["gpt-5.5"], { contextWindow: 2000000, maxTokens: 128000 });
	assert.deepEqual(limitsEdited.doc.providers.minnyat.models["gpt-5"], { contextWindow: 400000 }, "gpt-5 untouched");

	card("poolside/laguna-s-2.1").querySelector(".cfg-card-head .cfg-icon").click();
	await tick();
	const limitsRemoved = await save();
	assert.ok(limitsRemoved);
	assert.deepEqual(Object.keys(limitsRemoved.doc.providers.minnyat.models), ["gpt-5", "gpt-5.5"], "the × removed exactly that model");

	// --- `list` fields: a job's executors (S7) ---------------------------------
	await openSection("paseo");
	assert.equal(errorToast(), "", "a list inside a map item renders without error");
	const items = () => card("re.view").querySelectorAll(".cfg-list-item");
	const shown = (item, label) => !rowByLabel(item, label).classList.contains("hidden");
	const tool = (item, name) => item.querySelector(`.cfg-list-${name}`);
	assert.equal(items().length, 2);
	assert.deepEqual(
		items().map((item) => [shown(item, "Lớp việc"), shown(item, "Công cụ"), shown(item, "Vai trò & runtime")]),
		[
			[true, false, false],
			[false, true, false],
		],
		"each element shows the fields of its own kind",
	);
	assert.equal(tool(items()[0], "up").disabled, true, "the first cannot move up");
	assert.equal(tool(items()[1], "down").disabled, true, "the last cannot move down");
	assert.equal(tool(items()[0], "remove").disabled, false, "above minItems an element can go");

	const jobsUntouched = await save();
	assert.ok(jobsUntouched, `an unedited jobs document saves (toast: "${toastText()}")`);
	assert.deepEqual(jobsUntouched.doc, JOBS_DOC, "opening the form and pressing Lưu changes nothing");

	tool(items()[1], "up").click();
	await tick();
	assert.deepEqual(
		items().map((item) => rowByLabel(item, "Loại").querySelector("select").value),
		["cli", "class"],
		"move up reorders the cards",
	);
	// The class executor becomes a route: its modelClass is hidden now, and must not be saved.
	change(rowByLabel(items()[1], "Loại").querySelector("select"), "route");
	await tick();
	assert.equal(shown(items()[1], "Lớp việc"), false, "switching kind hides the old kind's field");
	assert.equal(shown(items()[1], "Vai trò & runtime"), true, "and shows the new kind's");
	const [roleSel, runtimeSel] = items()[1].querySelectorAll(".cfg-roleprovider select");
	change(roleSel, "peer");
	change(runtimeSel, "claude");
	await tick();
	change(items()[1].querySelector(".cfg-swap select"), "claude-opus-5-5");
	const jobsEdited = await save();
	assert.ok(jobsEdited, `the edited executors save (toast: "${toastText()}")`);
	assert.deepEqual(
		jobsEdited.doc.jobs["re.view"].executors,
		[
			{ kind: "cli", tool: "claude", args: ["-p"] },
			{ kind: "route", paseoProvider: "claude-peer", model: "claude-opus-5-5" },
		],
		"order kept, the hidden modelClass left out",
	);

	tool(items()[0], "remove").click();
	await tick();
	assert.equal(items().length, 1);
	assert.equal(tool(items()[0], "remove").disabled, true, "at minItems the last element cannot be removed");
	card("re.view").querySelector(".cfg-list-add").click();
	await tick();
	assert.equal(items().length, 2, "Thêm executor adds one");
	assert.equal(rowByLabel(items()[1], "Loại").querySelector("select").value, "class", "from the item seed");
	change(rowByLabel(items()[1], "Lớp việc").querySelector("select"), "REVIEW_HIGH");

	$("config-form").querySelectorAll("button").find((button) => button.textContent === "Thêm job").click();
	await tick();
	change(card("moi").querySelector(".cfg-card-key"), "nightly.v2");
	await tick();
	assert.equal(card("nightly.v2").querySelectorAll(".cfg-list-item").length, 1, "a new job starts from the map seed's executor");
	change(rowByLabel(card("nightly.v2"), "Lớp việc").querySelector("select"), "FAST_READ");
	const jobsAdded = await save();
	assert.ok(jobsAdded, `jobs save (toast: "${toastText()}")`);
	assert.deepEqual(jobsAdded.doc.jobs, {
		"re.view": {
			run: "sequential",
			executors: [
				{ kind: "route", paseoProvider: "claude-peer", model: "claude-opus-5-5" },
				{ kind: "class", modelClass: "REVIEW_HIGH" },
			],
		},
		"nightly.v2": { executors: [{ kind: "class", modelClass: "FAST_READ" }] },
	});

	// --- the model sync result says where each limit came from ----------------
	await openSection("pi-models");
	const syncButton = () => $("config-actions").querySelectorAll("button").find((button) => button.textContent === "Cập nhật danh sách model");
	const output = () => $("config-actions").querySelector(".cfg-actions-out");
	async function runSync(report) {
		syncReplies.push(report);
		clear(output());
		syncButton().click();
		await until(() => output().querySelector(".cfg-actions-head") && !syncButton().disabled, "the sync result");
		return output();
	}
	const clear = (node) => {
		for (const child of [...node.childNodes]) node.removeChild(child);
	};
	const fetchedAt = new Date(Date.now() - 3 * 3_600_000).toISOString();
	const okOut = await runSync({
		ok: true,
		command: "models sync",
		path: "/tmp/fake/models.json",
		dryRun: false,
		limits: { origin: "stale-cache", fetchedAt, error: "fetch failed" },
		warnings: [
			`pi-models: models.dev unreachable (fetch failed); using the cached copy from ${fetchedAt} (3h old)`,
			"pi-models: minnyat/gpt-5.5: override maxTokens 2000000 is above models.dev's contextWindow 1050000; contextWindow is now unknown",
		],
		providers: [
			{
				ok: true,
				provider: "minnyat",
				baseUrl: "https://example.invalid/v1",
				listed: 3,
				written: 3,
				models: [
					{ id: "gpt-5.6-terra", reasoning: false, contextWindow: 1050000, maxTokens: 128000, limitSource: "models.dev" },
					{ id: "gpt-5.5", reasoning: true, maxTokens: 64000, limitSource: "override" },
					{ id: "review", reasoning: false, limitSource: "unknown" },
				],
			},
		],
	});
	assert.equal(okOut.classList.contains("good"), true);
	assert.match(okOut.querySelector(".cfg-actions-head").textContent, /Đã cập nhật xong — 2 cảnh báo/);
	const warnBox = okOut.querySelector(".cfg-actions-warn");
	assert.ok(warnBox, "warnings are shown, set apart");
	assert.deepEqual(
		warnBox.querySelectorAll("li").map((li) => li.textContent),
		[
			`models.dev unreachable (fetch failed); using the cached copy from ${fetchedAt} (3h old)`,
			"minnyat/gpt-5.5: override maxTokens 2000000 is above models.dev's contextWindow 1050000; contextWindow is now unknown",
		],
	);
	const originLine = okOut.querySelector(".cfg-actions-origin");
	assert.ok(originLine.classList.contains("warn"), "an old cached copy is a warning");
	assert.match(originLine.textContent, /bản lưu CŨ, tải 3 giờ trước/);
	const limitRow = (id) => okOut.querySelector(`.cfg-model-limit[data-model="${id}"]`)?.textContent;
	assert.equal(limitRow("gpt-5.6-terra"), "gpt-5.6-terra1.050.000 · 128.000 · models.dev");
	assert.equal(limitRow("gpt-5.5"), "gpt-5.5chưa biết (Pi dùng 128.000) · 64.000 · ghi đè", "half known: only the unknown half falls back");
	assert.equal(limitRow("review"), "reviewchưa biết (Pi dùng 128.000/16.384)");

	// A partial failure exits non-zero; the report still arrives and is shown.
	const badOut = await runSync({
		ok: false,
		command: "models sync",
		path: "/tmp/fake/models.json",
		dryRun: false,
		limits: { origin: "unavailable", error: "getaddrinfo ENOTFOUND models.dev" },
		warnings: [],
		providers: [
			{ ok: false, provider: "dead", baseUrl: "https://dead.invalid/v1", code: "LIST_FAILED", message: "HTTP 503" },
			{ ok: true, provider: "minnyat", baseUrl: "https://example.invalid/v1", written: 1, models: [{ id: "review", limitSource: "unknown" }] },
		],
	});
	assert.equal(badOut.classList.contains("bad"), true);
	assert.equal(badOut.querySelector(".cfg-actions-warn"), null, "no warnings, no warning box");
	assert.ok(badOut.querySelector(".cfg-actions-origin").classList.contains("bad"));
	assert.match(badOut.querySelector(".cfg-actions-origin").textContent, /ENOTFOUND models\.dev.*mặc định của Pi \(128\.000\/16\.384\)/);
	assert.equal(badOut.querySelector('.cfg-model-limit[data-model="review"]').textContent, "reviewchưa biết (Pi dùng 128.000/16.384)");
	assert.match(badOut.querySelector(".cfg-actions-list li.no").textContent, /^dead — /, "the failed endpoint is still named");
} finally {
	Object.assign(globalThis, { fetch: realFetch, setTimeout: realSetTimeout, setInterval: realSetInterval });
	await server.close();
}

function roleSelText(routeCard) {
	return routeCard
		.querySelectorAll(".cfg-roleprovider select")[0]
		.options.filter((option) => option.value !== "")
		.map((option) => option.textContent);
}

console.log("webui app tests passed");
