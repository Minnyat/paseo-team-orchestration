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
import {
	MODEL_INVENTORY_SECTIONS,
	schemaForSection,
	validatePiModelsConfig,
	withModelInventory,
	withPiModelCatalog,
} from "../cli/lib/config-schema.mjs";
import { validateJobsConfig } from "../scripts/jobs.mjs";
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
// Every form below is the REAL schema, folded exactly as `pteam config read`
// folds it (cmdConfigRead): the live model inventory for MODEL_INVENTORY_SECTIONS,
// pi's model catalog for pi-settings. A schema that drifts from the form or
// from the server's validator therefore turns this file red.
const PI_CATALOG = { minnyat: ["gpt-5.5", "gpt-5"] };
function schemaAsCliSendsIt(section) {
	let schema = schemaForSection(section);
	if (schema && MODEL_INVENTORY_SECTIONS.includes(section)) schema = withModelInventory(schema, INVENTORY);
	if (schema && section === "pi-settings") schema = withPiModelCatalog(schema, PI_CATALOG);
	return schema;
}

// The shipped example, as a user would copy it to jobs.local.json.
const JOBS_EXAMPLE_TEXT = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "config", "jobs.example.json"), "utf8");
validateJobsConfig(JSON.parse(JOBS_EXAMPLE_TEXT));
// Per-model overrides keyed by real-looking model ids: a dotted id next to its
// dot-free prefix, and one with a slash.
const PI_MODELS_DOC = {
	version: 1,
	providers: {
		minnyat: {
			baseUrl: "https://example.invalid/v1",
			api: "openai-completions",
			keyEnv: "CODING_API_KEY",
			probe: true,
			models: {
				"gpt-5": { contextWindow: 400000 },
				"gpt-5.5": { contextWindow: 1050000, maxTokens: 128000 },
				"poolside/laguna-s-2.1": { maxTokens: 8000 },
			},
		},
	},
};
validatePiModelsConfig(structuredClone(PI_MODELS_DOC));
// The rest of the sections, each a file the form must hand back byte for byte
// when nothing was edited — including keys no schema field describes.
const UNTOUCHED = {
	mcp: {
		mcpServers: {
			"files.local": { command: "npx", args: ["-y", "@example/files"], env: { ROOT_DIR: "/srv" }, lifecycle: "eager" },
		},
		futureKey: { keep: true },
	},
	paseo: {
		version: 1,
		daemon: { listen: "127.0.0.1:6767", mcp: { enabled: true, injectIntoAgents: false } },
		agents: { providers: { "pi-peer.alt": { label: "Alt", extends: "pi", env: { PASEO_PI_ROLE: "peer" } } } },
	},
	providers: { agents: { providers: { "hob.local": { extends: "pi", env: { PASEO_PI_ROLE: "supervisor" } } } } },
	"pi-settings": {
		lastChangelogVersion: "0.83.0",
		retry: { enabled: true, maxRetries: 6, provider: { timeoutMs: 600000 } },
		defaultProvider: "minnyat",
		defaultModel: "gpt-5.5",
		defaultThinkingLevel: "high",
		compaction: { enabled: true, reserveTokens: 16384 },
		packages: ["npm:pi-extra"],
		theme: "dark",
	},
	seats: {
		version: 1,
		seats: {
			researcher: { base: "claude-peer", label: "Researcher", capabilities: ["web-research"] },
			"lead-w": { base: "claude-lead", capabilities: ["web-research", "lead-write"] },
		},
	},
};

const files = {
	routing: JSON.stringify(ROUTING_DOC, null, 2),
	cluster: null,
	jobs: JOBS_EXAMPLE_TEXT,
	"pi-models": JSON.stringify(PI_MODELS_DOC, null, 2),
	...Object.fromEntries(Object.entries(UNTOUCHED).map(([section, doc]) => [section, JSON.stringify(doc, null, 2)])),
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
			schema: schemaAsCliSendsIt(section),
		};
		return { exitCode: 0, stdout: JSON.stringify(payload), stderr: "" };
	}
	if (command === "config" && verb === "write" && section in files) {
		// The exact text too: "unchanged" includes the order of the keys.
		writes.push({ section, doc: JSON.parse(stdin), text: stdin });
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
	assert.equal(unchanged.text, JSON.stringify(ROUTING_DOC, null, 2), "byte for byte, key order included");
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
	// Hidden (the host is local) but meaningful: it is what switching to remote
	// uses. Unlike a list element's hidden field, it must survive a save.
	TWO_HOSTS.hosts.mac.connection.endpointEnv = "MAC_URL";
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
	// Same content, not the same bytes: the save prune drops `capabilities: []`
	// and fillKeptEmpty puts it back as each host's LAST key. Base 45b4f83 did
	// the same; it is reported, not locked in here.
	assert.deepEqual(clusterUntouched.doc, TWO_HOSTS, "opening the form and pressing Lưu changes nothing");
	// showIf inside a dotted host: mac.local's endpoint field follows mac.local's
	// own connection type, not a phantom "mac" → "local".
	const endpointRow = (key) => rowByLabel(card(key), "Biến môi trường chứa endpoint");
	assert.equal(endpointRow("mac.local").classList.contains("hidden"), true, "local host: endpoint field hidden");
	change(rowByLabel(card("mac.local"), "Kiểu kết nối").querySelector("select"), "remote");
	await tick();
	assert.equal(endpointRow("mac.local").classList.contains("hidden"), false, "switched to remote: shown");
	assert.equal(endpointRow("mac").classList.contains("hidden"), true, "and mac's own field is unaffected");
	change(rowByLabel(card("mac.local"), "Kiểu kết nối").querySelector("select"), "local");
	await tick();

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

	// --- "Kho model Pi": the real per-model override map ----------------------
	// providers.<endpoint>.models.<model-id>, the schema the sync reads. `gpt-5`
	// next to `gpt-5.5` is the case a dotted path got wrong (gpt-5.5 split into
	// models["gpt-5"]["5"]); the server runs validatePiModelsConfig on each save.
	await openSection("pi-models");
	assert.equal(errorToast(), "", "the pi-models form opens");
	const limit = (id, label) => rowByLabel(card(id), label).querySelector("input");
	assert.equal(limit("gpt-5.5", "Context window").value, "1050000", "gpt-5.5 shows its own value");
	assert.equal(limit("gpt-5.5", "Max output tokens").value, "128000");
	assert.equal(limit("gpt-5", "Context window").value, "400000", "gpt-5 shows its own value");
	assert.equal(limit("gpt-5", "Max output tokens").value, "", "and leaves the unset one empty");
	assert.equal(limit("poolside/laguna-s-2.1", "Max output tokens").value, "8000", "an id with a slash and dots");
	assert.equal(limit("poolside/laguna-s-2.1", "Context window").value, "");

	const piModelsText = files["pi-models"];
	const piUntouched = await save();
	assert.ok(piUntouched, `an unedited pi-models file saves (toast: "${toastText()}")`);
	assert.equal(piUntouched.text, piModelsText, "opening the form and pressing Lưu changes nothing, byte for byte");

	// What the server refuses, it refuses naming endpoint and model, and the file stays.
	type(limit("gpt-5.5", "Context window"), "1.5");
	assert.equal(await save(), null, "1.5 is not a token count");
	assert.match(errorToast(), /Chưa lưu/);
	assert.match(errorToast(), /provider "minnyat": models\.gpt-5\.5\.contextWindow must be a positive integer/);
	type(limit("gpt-5.5", "Context window"), "100000");
	assert.equal(await save(), null, "a maxTokens above its own contextWindow is refused");
	assert.match(errorToast(), /provider "minnyat": models\.gpt-5\.5\.maxTokens \(128000\) exceeds its contextWindow \(100000\)/);
	assert.equal(files["pi-models"], piModelsText, "neither refusal touched the file");

	type(limit("gpt-5.5", "Context window"), "2000000");
	const piEdited = await save();
	assert.ok(piEdited, `a valid override saves (toast: "${toastText()}")`);
	assert.deepEqual(piEdited.doc.providers.minnyat.models, {
		"gpt-5": { contextWindow: 400000 },
		"gpt-5.5": { contextWindow: 2000000, maxTokens: 128000 },
		"poolside/laguna-s-2.1": { maxTokens: 8000 },
	}, "the edit lands on gpt-5.5 only");

	change(card("gpt-5").querySelector(".cfg-card-key"), "cx/gpt-6.astra");
	await tick();
	card("poolside/laguna-s-2.1").querySelector(".cfg-card-head .cfg-icon").click();
	await tick();
	card("minnyat").querySelectorAll("button").find((button) => button.textContent === "+ Ghi đè giới hạn cho một model").click();
	await tick();
	change(card("moi").querySelector(".cfg-card-key"), "tiny.m-1");
	await tick();
	type(limit("tiny.m-1", "Context window"), "1000");
	const piReshaped = await save();
	assert.ok(piReshaped, `rename, remove and add save together (toast: "${toastText()}")`);
	assert.deepEqual(piReshaped.doc.providers.minnyat.models, {
		"gpt-5.5": { contextWindow: 2000000, maxTokens: 128000 },
		"cx/gpt-6.astra": { contextWindow: 400000 },
		"tiny.m-1": { contextWindow: 1000 },
	}, "renamed to a key with a slash and a dot, removed exactly one, added one with a small but valid window");

	// A name Object.prototype also carries is still a free key: `next in {}` is
	// true for "constructor", and the rename used to be refused as a duplicate.
	change(card("cx/gpt-6.astra").querySelector(".cfg-card-key"), "constructor");
	await tick();
	assert.equal(errorToast(), "", "renaming to constructor is not refused as a duplicate");
	change(card("tiny.m-1").querySelector(".cfg-card-key"), "toString");
	await tick();
	assert.equal(errorToast(), "", "nor to toString");
	const protoNames = await save();
	assert.ok(protoNames, `keys named like prototype members save (toast: "${toastText()}")`);
	assert.deepEqual(protoNames.doc.providers.minnyat.models, {
		"gpt-5.5": { contextWindow: 2000000, maxTokens: 128000 },
		constructor: { contextWindow: 400000 },
		toString: { contextWindow: 1000 },
	});

	// An endpoint card with no baseUrl yet is a draft: it saves, the sync complains later.
	$("config-form").querySelectorAll("button").find((button) => button.textContent === "+ Thêm điểm cuối").click();
	await tick();
	const draft = await save();
	assert.ok(draft, `an endpoint without baseUrl still saves (toast: "${toastText()}")`);
	assert.equal(draft.doc.providers.moi.baseUrl, undefined);
	assert.equal(draft.doc.providers.moi.keyEnv, "CODING_API_KEY", "from the endpoint seed");

	// A file from before per-model overrides: endpoint-level limits are no longer
	// a form field, but they are the owner's keys and stay in the file.
	const LEGACY = { version: 1, providers: { old: { baseUrl: "https://old.invalid/v1", keyEnv: "CODING_API_KEY", contextWindow: 200000, maxTokens: 32000 } } };
	files["pi-models"] = JSON.stringify(LEGACY, null, 2);
	await openSection("pi-models");
	assert.equal(errorToast(), "", "a legacy pi-models file opens");
	const legacyUntouched = await save();
	assert.ok(legacyUntouched, `a legacy file saves (toast: "${toastText()}")`);
	assert.equal(legacyUntouched.text, JSON.stringify(LEGACY, null, 2), "unedited: byte for byte");
	type(rowByLabel(card("old"), "Biến môi trường chứa khoá").querySelector("input"), "OLD_KEY");
	const legacyEdited = await save();
	assert.ok(legacyEdited);
	assert.deepEqual(legacyEdited.doc.providers.old, { ...LEGACY.providers.old, keyEnv: "OLD_KEY" }, "an edit elsewhere keeps the endpoint-level limits");

	// --- jobs: the real section, from config/jobs.example.json ----------------
	await openSection("jobs");
	assert.equal(errorToast(), "", "the jobs form opens");
	const jobItems = (jobId) => card(jobId).querySelectorAll(".cfg-list-item");
	const shown = (within, label) => !rowByLabel(within, label).classList.contains("hidden");
	const listTool = (item, name) => item.querySelector(`.cfg-list-${name}`);
	const kindSelect = (item) => rowByLabel(item, "Loại").querySelector("select");
	const KIND_OF = {
		"Lớp việc": "class",
		"Vai trò & runtime": "route",
		"Mô hình": "route",
		"Mức suy nghĩ": "route",
		"Công cụ": "cli",
		"Tham số thêm": "cli",
	};
	const assertKindFields = (item, where) => {
		const kind = kindSelect(item).value;
		for (const [label, owner] of Object.entries(KIND_OF)) {
			assert.equal(shown(item, label), owner === kind, `${where} (${kind}): "${label}" ${owner === kind ? "shown" : "hidden"}`);
		}
	};
	const example = JSON.parse(JOBS_EXAMPLE_TEXT);
	for (const [jobId, job] of Object.entries(example.jobs)) {
		assert.ok(card(jobId), `job ${jobId} has a card`);
		assert.equal(jobItems(jobId).length, job.executors.length, `${jobId}: one card per executor`);
		jobItems(jobId).forEach((item, index) => {
			assert.equal(kindSelect(item).value, job.executors[index].kind, `${jobId} [${index}]: kind shown`);
			assertKindFields(item, `${jobId} [${index}]`);
		});
	}
	assert.ok(card("codex"), "the declared CLI tool has a card");

	const jobsUntouched = await save();
	assert.ok(jobsUntouched, `the example saves unedited (toast: "${toastText()}")`);
	assert.equal(jobsUntouched.text, JSON.stringify(example, null, 2), "byte for byte, $comment and key order included");
	const jobsText = files.jobs;

	// A new job starts from the seed: one class executor, no class chosen yet —
	// which the validator refuses, naming the executor.
	$("config-form").querySelectorAll("button").find((button) => button.textContent === "+ Thêm công việc").click();
	await tick();
	assert.equal(jobItems("moi").length, 1, "the job seed carries one executor");
	assert.equal(kindSelect(jobItems("moi")[0]).value, "class");
	assert.equal(listTool(jobItems("moi")[0], "remove").disabled, true, "at minItems it cannot be removed");
	assert.equal(await save(), null, "a seed executor without a class is refused");
	assert.match(errorToast(), /job "moi" executor \[0\]: modelClass/);
	assert.equal(files.jobs, jobsText, "and the file is untouched");

	change(rowByLabel(jobItems("moi")[0], "Lớp việc").querySelector("select"), "FAST_READ");
	// a route executor, its lists following the provider chosen
	card("moi").querySelector(".cfg-list-add").click();
	await tick();
	assert.equal(kindSelect(jobItems("moi")[1]).value, "class", "a new executor starts from the executor seed");
	change(kindSelect(jobItems("moi")[1]), "route");
	await tick();
	assertKindFields(jobItems("moi")[1], "new route executor");
	const [execRole, execRuntime] = jobItems("moi")[1].querySelectorAll(".cfg-roleprovider select");
	change(execRole, "peer");
	change(execRuntime, "pi");
	await tick();
	const execModel = jobItems("moi")[1].querySelector(".cfg-swap select");
	assert.deepEqual(execModel.options.map((option) => option.value), ["", ...INVENTORY["pi-peer"]], "models come from the pi-peer inventory");
	change(execModel, "box/terra");
	const execThinking = rowByLabel(jobItems("moi")[1], "Mức suy nghĩ").querySelector("select");
	const thinkingValues = execThinking.options.map((option) => option.value);
	assert.ok(thinkingValues.includes("minimal") && !thinkingValues.includes("ultracode"), "thinking levels are pi's");
	change(execThinking, "high");
	// a class executor turned into a cli one: its modelClass must not be saved
	card("moi").querySelector(".cfg-list-add").click();
	await tick();
	change(rowByLabel(jobItems("moi")[2], "Lớp việc").querySelector("select"), "REVIEW_HIGH");
	change(kindSelect(jobItems("moi")[2]), "cli");
	await tick();
	assertKindFields(jobItems("moi")[2], "switched to cli");
	type(rowByLabel(jobItems("moi")[2], "Công cụ").querySelector("input"), "claude");
	type(rowByLabel(jobItems("moi")[2], "Tham số thêm").querySelector("textarea"), "-p\n--verbose");
	const jobAdded = await save();
	assert.ok(jobAdded, `the new job saves and the server accepts it (toast: "${toastText()}")`);
	assert.deepEqual(jobAdded.doc.jobs.moi, {
		run: "parallel",
		executors: [
			{ kind: "class", modelClass: "FAST_READ" },
			{ kind: "route", paseoProvider: "pi-peer", model: "box/terra", thinking: "high" },
			{ kind: "cli", tool: "claude", args: ["-p", "--verbose"] },
		],
	}, "the cli executor carries no leftover modelClass");
	for (const jobId of Object.keys(example.jobs)) assert.deepEqual(jobAdded.doc.jobs[jobId], example.jobs[jobId], `${jobId} untouched`);
	validateJobsConfig(jobAdded.doc);

	listTool(jobItems("moi")[2], "up").click();
	await tick();
	listTool(jobItems("moi")[0], "down").click();
	await tick();
	const jobReordered = await save();
	assert.ok(jobReordered);
	assert.deepEqual(jobReordered.doc.jobs.moi.executors.map((e) => e.kind), ["cli", "class", "route"], "up then down, saved in that order");

	listTool(jobItems("moi")[0], "remove").click();
	await tick();
	listTool(jobItems("moi")[0], "remove").click();
	await tick();
	assert.equal(jobItems("moi").length, 1);
	assert.equal(listTool(jobItems("moi")[0], "remove").disabled, true, "the last executor cannot go");
	change(card("moi").querySelector(".cfg-card-key"), "nightly");
	await tick();
	const jobRenamed = await save();
	assert.ok(jobRenamed);
	assert.deepEqual(Object.keys(jobRenamed.doc.jobs), [...Object.keys(example.jobs), "nightly"]);
	assert.deepEqual(jobRenamed.doc.jobs.nightly.executors, [{ kind: "route", paseoProvider: "pi-peer", model: "box/terra", thinking: "high" }]);
	card("nightly").querySelector(".cfg-card-head .cfg-icon").click();
	await tick();
	const jobRemoved = await save();
	assert.ok(jobRemoved);
	assert.equal(jobRemoved.text, JSON.stringify(example, null, 2), "removing the job brings back the example exactly");

	// Names the validator refuses are refused through the form too, file untouched.
	const refusedName = async (rename, pattern) => {
		await openSection("jobs");
		const before = files.jobs;
		rename();
		await tick();
		assert.equal(await save(), null, `${pattern} is refused`);
		assert.match(errorToast(), /Chưa lưu/);
		assert.match(errorToast(), pattern);
		assert.equal(files.jobs, before, "the file is untouched");
	};
	await refusedName(() => change(card("code-review").querySelector(".cfg-card-key"), "night.ly"), /job "night\.ly": id must match .*no dots/);
	await refusedName(() => change(card("code-review").querySelector(".cfg-card-key"), "__proto__"), /job "__proto__": id "__proto__" is reserved/);
	await refusedName(() => change(card("code-review").querySelector(".cfg-card-key"), "constructor"), /job "constructor": id "constructor" is reserved/);
	await refusedName(() => {
		$("config-form").querySelectorAll("button").find((button) => button.textContent === "+ Thêm công cụ").click();
		change(card("moi").querySelector(".cfg-card-key"), "pi");
		type(rowByLabel(card("pi"), "Lệnh chạy").querySelector("input"), "pi");
	}, /cliTools "pi": "pi" is a built-in tool and cannot be redefined/);

	// A job with no executor (hand-edited) is refused by the form itself, place named.
	files.jobs = JSON.stringify({ version: 1, jobs: { empty: { executors: [] } } }, null, 2);
	await openSection("jobs");
	assert.match(card("empty").querySelector(".cfg-list-short").textContent, /Cần ít nhất 1 mục/, "the card says it is short");
	const writesBeforeEmpty = writes.length;
	assert.equal(await save(), null);
	assert.match(errorToast(), /jobs\.empty\.executors: Executor cần ít nhất 1 mục/);
	assert.equal(writes.length, writesBeforeEmpty, "nothing reached config write");

	// --- every other section: open, Lưu, the same bytes go back ---------------
	// routing and cluster (with mac.local) are covered above with the same check.
	for (const [section, doc] of Object.entries(UNTOUCHED)) {
		files[section] = JSON.stringify(doc, null, 2);
		await openSection(section);
		assert.equal(errorToast(), "", `${section} opens`);
		const saved = await save();
		assert.ok(saved, `${section} saves unedited (toast: "${toastText()}")`);
		assert.equal(saved.text, JSON.stringify(doc, null, 2), `${section}: byte for byte`);
	}

	// --- a kv row keyed __proto__ (the real providers section's env editor) ---
	// `next[key] = value` with key "__proto__" sets the object's prototype
	// instead of adding a key, so the variable silently vanished on save.
	await openSection("providers");
	assert.equal(errorToast(), "");
	const envField = rowByLabel(card("hob.local"), "Biến môi trường");
	envField.querySelector(".cfg-add").click();
	const newRow = envField.querySelectorAll(".cfg-kv-row").at(-1);
	type(newRow.querySelector(".cfg-kv-key"), "__proto__");
	type(newRow.querySelector(".cfg-kv-value"), "polluted");
	const kvSaved = await save();
	assert.ok(kvSaved, `a kv row named __proto__ saves (toast: "${toastText()}")`);
	const env = kvSaved.doc.agents.providers["hob.local"].env;
	assert.deepEqual(Object.keys(env), ["PASEO_PI_ROLE", "__proto__"], "the __proto__ row is an own key of the saved env");
	assert.equal(Object.getOwnPropertyDescriptor(env, "__proto__").value, "polluted");
	assert.equal({}.polluted, undefined, "and Object.prototype is untouched");
	assert.equal(Object.getPrototypeOf({}), Object.prototype);

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
					null,
					"not-a-model",
				],
			},
		],
	});
	assert.equal(okOut.classList.contains("good"), true, "a malformed model entry does not turn the report into an error line");
	assert.equal(okOut.querySelectorAll(".cfg-model-limit").length, 3, "it is skipped; the three real models are listed");
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
	assert.equal(limitRow("gpt-5.5"), "gpt-5.5chưa biết (Pi tự dùng mặc định của nó) · 64.000 · ghi đè", "half known: only the unknown half says so");
	assert.equal(limitRow("review"), "reviewchưa biết (Pi tự dùng mặc định của nó) · chưa biết (Pi tự dùng mặc định của nó) · chưa biết");
	assert.doesNotMatch(okOut.textContent, /128\.000\/16\.384|16\.384/, "no pi default is quoted as a number");

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
	assert.match(badOut.querySelector(".cfg-actions-origin").textContent, /ENOTFOUND models\.dev.*mặc định của Pi\.$/);
	assert.equal(badOut.querySelector('.cfg-model-limit[data-model="review"]').textContent, "reviewchưa biết (Pi tự dùng mặc định của nó) · chưa biết (Pi tự dùng mặc định của nó) · chưa biết");
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
