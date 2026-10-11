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
import { validateRoutingConfig } from "../scripts/model-routing.mjs";
import { handleApi, startServer } from "../webui/server.mjs";
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
const files = { routing: JSON.stringify(ROUTING_DOC, null, 2), cluster: null };
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
			schema: withModelInventory(schemaForSection(section), INVENTORY),
		};
		return { exitCode: 0, stdout: JSON.stringify(payload), stderr: "" };
	}
	if (command === "config" && verb === "write" && section in files) {
		writes.push({ section, doc: JSON.parse(stdin) });
		files[section] = stdin;
		return { exitCode: 0, stdout: JSON.stringify({ ok: true, path: `/tmp/fake/${section}.local.json` }), stderr: "" };
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
	// Only the config endpoints are wired to the server. The home tab's polls
	// stay pending forever, which is harmless and keeps their render paths (not
	// under test here) from running on half-shaped data.
	fetch: (path, init) =>
		String(path).startsWith("/api/config") ? realFetch(`http://127.0.0.1:${server.port}${path}`, init) : new Promise(() => {}),
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
	async function openSection(section) {
		resetToast();
		change($("config-section"), section);
		await until(() => $("config-meta").textContent.includes(`${section}.local.json`), `${section} form loaded`);
		await tick();
	}
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
	assert.deepEqual(JSON.parse(files.routing), ROUTING_DOC, "the file on disk is still the valid one");

	// Picking a model from the pi list makes it savable.
	change(modelSelect(card("MONITOR_ECONOMY")), "box/flash");
	const fixed = await save();
	assert.ok(fixed, `a valid switch is saved (toast: "${toastText()}")`);
	assert.deepEqual(fixed.doc.routes.MONITOR_ECONOMY, { paseoProvider: "pi-supervisor", model: "box/flash", thinking: "low" });
	validateRoutingConfig(fixed.doc);

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
