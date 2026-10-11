/**
 * app.js — the WebUI client.
 *
 * It renders whatever `paseo-team` returned and nothing else: no field is
 * computed here that the CLI did not send, so what you see on screen can
 * always be reproduced by running the same command in a terminal.
 *
 * Two audiences share this page. The default ("Chế độ đơn giản") is written for
 * someone who will never open a terminal: their job is to watch the team and
 * answer permission requests, so every code, id and file path is either
 * translated or hidden behind a disclosure. Advanced mode adds the editors that
 * only make sense if you know what a JSON config is.
 *
 * Everything is inserted with textContent, never innerHTML: agent names and
 * message bodies are model-authored text, and this page holds a token that can
 * approve permission requests.
 */

import {
	cleanListItems,
	clone,
	deepMerge,
	deletePath,
	dependentOptionProblems,
	dependentOptions,
	fieldPath,
	fillKeptEmpty,
	getPath,
	isShown,
	listLengthProblems,
	moveAt,
	numberRangeProblems,
	optionalEntryProblems,
	parseLines,
	pruneEmpty,
	removeAt,
	setPath,
} from "./config-form.js";
import {
	ROLE_HINT,
	agentKindLabel,
	degradedSentence,
	humanizeError,
	limitsOriginSentence,
	missingSetup,
	modelLimitsLabel,
	overallHealth,
	permitDetail,
	permitSentence,
	projectLabel,
	relativeTime,
	RISK_LABEL,
	roleLabel,
	runtimeLabel,
	statusLabel,
	syncWarningText,
	toolMeaning,
} from "./humanize.js";

// --- token -----------------------------------------------------------------

const TOKEN_KEY = "paseo-team-token";

function bootToken() {
	const fromHash = /(?:^|[#&])token=([^&]+)/.exec(location.hash || "");
	if (fromHash) {
		sessionStorage.setItem(TOKEN_KEY, decodeURIComponent(fromHash[1]));
		// Drop it from the address bar so a screenshot or a shared URL does not
		// hand over the ability to approve tool calls.
		history.replaceState(null, "", location.pathname + location.search);
	}
	return sessionStorage.getItem(TOKEN_KEY) ?? "";
}

let token = bootToken();

// --- tiny DOM helpers ------------------------------------------------------

const $ = (id) => document.getElementById(id);

function el(tag, props = {}, children = []) {
	const node = document.createElement(tag);
	for (const [key, value] of Object.entries(props)) {
		if (key === "class") node.className = value;
		else if (key === "text") node.textContent = value;
		else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
		else if (value !== null && value !== undefined) node.setAttribute(key, value);
	}
	for (const child of [].concat(children)) {
		if (child) node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
	}
	return node;
}

function svgEl(tag, props = {}, children = []) {
	const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
	for (const [key, value] of Object.entries(props)) {
		if (key === "text") node.textContent = value;
		else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
		else if (value !== null && value !== undefined) node.setAttribute(key, value);
	}
	for (const child of [].concat(children)) node.appendChild(child);
	return node;
}

function clear(node) {
	while (node.firstChild) node.removeChild(node.firstChild);
	return node;
}

/** An error the reader can act on, with the raw text one click away. */
function errorBlock(error) {
	const info = error?.human ?? humanizeError({ message: error?.message });
	return el("div", { class: "error-block" }, [
		el("strong", { text: info.title }),
		el("p", { text: info.advice }),
		el("details", {}, [el("summary", { text: "Chi tiết kỹ thuật" }), el("pre", { text: info.technical })]),
	]);
}

let toastTimer = null;
function toast(message, isError = false) {
	const node = $("toast");
	node.textContent = message;
	node.classList.toggle("err", isError);
	node.classList.remove("hidden");
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => node.classList.add("hidden"), isError ? 10_000 : 3500);
}

function toastError(error) {
	const info = error?.human ?? humanizeError({ message: error?.message });
	toast(`${info.title}. ${info.advice}`, true);
}

// --- API -------------------------------------------------------------------

let inFlight = 0;
/** The CLI command behind the last answer — shown only in advanced mode. */
let lastCommand = "";

function paintConnection(state, extra = "") {
	const node = $("conn");
	node.className = `conn ${state}`;
	node.textContent =
		state === "busy" ? "đang cập nhật…" : state === "err" ? "mất kết nối" : `đã cập nhật ${extra}`.trim();
}

async function api(path, { method = "GET", body = null, raw = null } = {}) {
	inFlight += 1;
	paintConnection("busy");
	const headers = { authorization: `Bearer ${token}` };
	if (body !== null || raw !== null) headers["content-type"] = "application/json";
	let response;
	try {
		response = await fetch(path, {
			method,
			headers,
			body: raw !== null ? raw : body !== null ? JSON.stringify(body) : undefined,
		});
	} catch (cause) {
		inFlight -= 1;
		paintConnection("err");
		const error = new Error(cause.message);
		error.human = {
			title: "Không liên lạc được với máy chủ trên máy bạn",
			advice: "Cửa sổ dòng lệnh chạy 'paseo-team web' có thể đã bị đóng. Mở lại rồi tải lại trang.",
			technical: String(cause.message),
		};
		throw error;
	}
	inFlight -= 1;
	const payload = await response
		.json()
		.catch(() => ({ ok: false, code: "BAD_RESPONSE", message: "máy chủ trả về nội dung không đọc được" }));
	if (payload.command) lastCommand = payload.command;
	if (!response.ok || payload.ok === false) {
		paintConnection("err");
		if (response.status === 401) {
			// The stored token outlived the server that issued it. Drop it, or
			// every later action fails with the same opaque 401.
			sessionStorage.removeItem(TOKEN_KEY);
			token = "";
		}
		const error = new Error(payload.message ?? payload.code ?? `HTTP ${response.status}`);
		error.human = humanizeError(payload);
		error.payload = payload;
		throw error;
	}
	if (inFlight === 0) paintConnection("ok", "vừa xong");
	return payload;
}

// --- simple / advanced mode ------------------------------------------------

const ADVANCED_KEY = "paseo-team-advanced";
let advanced = localStorage.getItem(ADVANCED_KEY) === "1";

function applyMode() {
	document.body.classList.toggle("advanced", advanced);
	$("advanced-toggle").checked = advanced;
	// Leaving a hidden tab selected would show an empty page.
	if (!advanced && (activeTab === "config" || activeTab === "roles")) selectTab("home");
}

$("advanced-toggle").addEventListener("change", (event) => {
	advanced = event.target.checked;
	localStorage.setItem(ADVANCED_KEY, advanced ? "1" : "0");
	applyMode();
});

// --- tabs ------------------------------------------------------------------

const loaders = {};
let activeTab = "home";

function selectTab(name) {
	activeTab = name;
	for (const button of document.querySelectorAll("#tabs button")) {
		button.classList.toggle("active", button.dataset.tab === name);
	}
	for (const section of document.querySelectorAll(".tab")) {
		section.classList.toggle("active", section.id === `tab-${name}`);
	}
	loaders[name]?.();
}

$("tabs").addEventListener("click", (event) => {
	const tab = event.target?.closest?.("button")?.dataset?.tab;
	if (tab) selectTab(tab);
});

// --- shared state ----------------------------------------------------------

let lastGraph = null;
let lastStatus = null;
let lastPermits = null;

function setBadge(count) {
	const badge = $("permit-badge");
	badge.textContent = String(count);
	badge.classList.toggle("hidden", !count);
}

function kvTable(pairs) {
	const table = el("table");
	for (const [key, value] of pairs) {
		table.appendChild(
			el("tr", {}, [
				el("th", { text: key }),
				el("td", { class: "v", text: value === true ? "có" : value === false ? "không" : String(value ?? "—") }),
			]),
		);
	}
	return table;
}

// --- home ------------------------------------------------------------------

const HEALTH_ICON = { good: "✓", attention: "!", bad: "×" };

function paintHealth() {
	const health = overallHealth({ status: lastStatus, graph: lastGraph, permits: lastPermits });
	$("health").className = `health ${health.level}`;
	$("health-icon").textContent = HEALTH_ICON[health.level] ?? "…";
	$("health-headline").textContent = health.headline;
	$("health-detail").textContent = health.detail;

	const actions = clear($("health-actions"));
	if ((lastPermits?.count ?? 0) > 0) {
		actions.appendChild(
			el("button", { class: "primary big", text: "Xem việc chờ duyệt", onclick: () => selectTab("permissions") }),
		);
	} else if (lastGraph?.nodes?.some((node) => node.status === "error")) {
		actions.appendChild(el("button", { class: "big", text: "Xem agent gặp lỗi", onclick: () => selectTab("graph") }));
	}

	const nodes = lastGraph?.nodes ?? [];
	$("stat-running").textContent = nodes.filter((node) => node.status === "running").length;
	$("stat-errors").textContent = nodes.filter((node) => node.status === "error").length;
	$("stat-total").textContent = nodes.length;
}

function paintSetup() {
	const body = clear($("setup-body"));
	// The banner above already says "Cài đặt chưa hoàn tất" and what to run when
	// that is the most urgent thing; repeating it in a card below is the same
	// message twice. The card earns its place when it adds something: the other
	// problems the banner had no room for, or the file paths in advanced mode.
	const missingNow = lastStatus ? missingSetup(lastStatus) : [];
	const bannerSaysIt = overallHealth({ status: lastStatus, graph: lastGraph, permits: lastPermits }).headline === "Cài đặt chưa hoàn tất";
	$("setup-card").classList.toggle("hidden", !advanced && (missingNow.length === 0 || bannerSaysIt));
	if (!lastStatus) {
		body.appendChild(el("p", { class: "hint", text: "Chưa đọc được." }));
		return;
	}
	const missing = missingSetup(lastStatus);
	if (missing.length === 0) {
		body.appendChild(el("p", { class: "ok", text: "✓ Đã cài đủ: bộ quy tắc phân quyền, mô tả vai trò và cấu hình Paseo." }));
	} else {
		body.appendChild(el("p", { class: "no", text: `Còn thiếu: ${missing.join(", ")}.` }));
		body.appendChild(
			el("p", { class: "hint", text: "Mở cửa sổ dòng lệnh trong thư mục dự án và chạy: npm run paseo-team -- install" }),
		);
	}
	if (advanced) {
		body.appendChild(
			el("details", {}, [el("summary", { text: "Đường dẫn file" }), kvTable(Object.entries(lastStatus.paths ?? {}))]),
		);
	}
}

loaders.home = async () => {
	paintHealth();
	paintSetup();
	await Promise.allSettled([refreshStatus(), refreshGraph({ silent: true }), refreshPermits({ silent: true })]);
	paintHealth();
	paintSetup();
};

async function refreshStatus() {
	try {
		lastStatus = (await api("/api/status")).data;
	} catch (error) {
		lastStatus = null;
		if (activeTab === "home") toastError(error);
	}
}

$("preflight-run").addEventListener("click", async () => {
	const body = clear($("preflight-body"));
	body.appendChild(el("p", { class: "hint", text: "Đang kiểm tra… việc này mất khoảng 30 giây." }));
	try {
		const { data } = await api("/api/preflight");
		const checks = Array.isArray(data?.checks) ? data.checks : [];
		clear(body);
		if (checks.length === 0) {
			body.appendChild(el("pre", { text: JSON.stringify(data, null, 2).slice(0, 4000) }));
			return;
		}
		const failed = checks.filter((check) => check.status !== "pass");
		body.appendChild(
			el("p", {
				class: failed.length === 0 ? "ok" : "no",
				text:
					failed.length === 0
						? `✓ ${checks.length} mục đều đạt.`
						: `${failed.length}/${checks.length} mục chưa đạt.`,
			}),
		);
		const table = el("table");
		for (const check of failed.length > 0 ? failed : checks) {
			table.appendChild(
				el("tr", {}, [
					el("th", { text: check.id ?? "mục" }),
					el("td", { class: check.status === "pass" ? "ok" : "no", text: check.status ?? "?" }),
					el("td", { text: check.detail ?? "" }),
				]),
			);
		}
		body.appendChild(table);
	} catch (error) {
		clear(body).appendChild(errorBlock(error));
	}
});

// --- permissions -----------------------------------------------------------

function nodeFor(agentId) {
	return lastGraph?.nodes?.find((node) => node.id === agentId) ?? null;
}

function agentNameFor(agentId) {
	return nodeFor(agentId)?.name ?? "";
}

async function decide(action, permit, card) {
	const meaning = toolMeaning(permit.tool);
	if (action === "allow" && meaning.risk !== "low") {
		// A high-impact approval gets one deliberate extra step. A non-technical
		// reader cannot judge a tool name, so the confirm restates the effect.
		if (!confirm(`Cho phép agent ${meaning.what}?\n\nHành động này thực hiện ngay trên máy của bạn.`)) return;
	}
	for (const button of card.querySelectorAll("button")) button.disabled = true;
	try {
		await api("/api/permits/decide", {
			method: "POST",
			body: { action, agentId: permit.agentId, requestId: permit.requestId },
		});
		toast(action === "allow" ? "Đã cho phép. Agent sẽ chạy tiếp." : "Đã từ chối.");
		await refreshPermits();
		renderPermits();
	} catch (error) {
		toastError(error);
		for (const button of card.querySelectorAll("button")) button.disabled = false;
	}
}

function permitCard(permit) {
	const meaning = toolMeaning(permit.tool);
	const node = nodeFor(permit.agentId);
	const card = el("div", { class: `permit risk-${meaning.risk}` });
	card.appendChild(el("div", { class: "risk-tag", text: RISK_LABEL[meaning.risk] }));
	card.appendChild(el("p", { class: "permit-headline", text: permitSentence(permit, agentNameFor(permit.agentId)) }));

	const facts = el("dl", { class: "facts" });
	const addFact = (term, value) => {
		if (!value) return;
		facts.appendChild(el("dt", { text: term }));
		facts.appendChild(el("dd", { text: String(value) }));
	};
	addFact("Agent", agentNameFor(permit.agentId) || "không rõ tên");
	if (node) addFact("Dự án", projectLabel(node.project ?? "") || null);
	if (node) addFact("Thư mục", node.cwd);
	if (advanced) {
		if (node) addFact("Loại agent", agentKindLabel(node));
		addFact("Công cụ", permit.tool ?? "không rõ");
		addFact("Mã yêu cầu", permit.requestId);
	}
	card.appendChild(facts);
	// What it actually wants to do. "chạy lệnh trên máy này" cannot be approved or
	// refused on its own — the command line is the decision.
	const detail = permitDetail(permit);
	card.appendChild(
		detail
			? el("div", { class: "permit-detail" }, [el("span", { class: "permit-detail-label", text: detail.label }), el("pre", { text: detail.text })])
			: el("p", { class: "hint", text: "Agent không nói rõ cụ thể muốn làm gì. Nếu chưa chắc, hãy từ chối." }),
	);

	const allow = el("button", { class: "primary big", text: "Cho phép" });
	const deny = el("button", { class: "danger big", text: "Từ chối" });
	allow.addEventListener("click", () => decide("allow", permit, card));
	deny.addEventListener("click", () => decide("deny", permit, card));
	card.appendChild(el("div", { class: "permit-actions" }, [allow, deny]));

	if (advanced) {
		card.appendChild(
			el("details", {}, [el("summary", { text: "Dữ liệu gốc" }), el("pre", { text: JSON.stringify(permit.raw, null, 2) })]),
		);
	}
	return card;
}

let permitsRenderedSig = "";

function renderPermits() {
	// The 20s poll calls this even when nothing changed; a rebuild would
	// collapse an open disclosure mid-read, so an identical payload is a no-op.
	const sig = `${advanced}|${lastPermits ? JSON.stringify(lastPermits) : "loading"}`;
	if (sig === permitsRenderedSig) return;
	permitsRenderedSig = sig;
	const body = clear($("permits-body"));
	if (!lastPermits) {
		body.appendChild(el("p", { class: "hint", text: "Đang tải…" }));
		return;
	}
	const permits = lastPermits.permits ?? [];
	const unclassified = lastPermits.unclassified ?? [];
	if (permits.length === 0 && unclassified.length === 0) {
		body.appendChild(
			el("div", { class: "empty" }, [
				el("div", { class: "empty-icon", text: "✓" }),
				el("p", { text: "Không có việc nào chờ bạn duyệt." }),
				el("p", {
					class: "hint",
					text: "Khi một agent cần bạn đồng ý, nó sẽ hiện ở đây và con số trên tab sẽ nhảy lên.",
				}),
			]),
		);
		return;
	}
	for (const permit of permits) body.appendChild(permitCard(permit));
	for (const raw of unclassified) {
		body.appendChild(
			el("div", { class: "permit unclassified" }, [
				el("strong", { text: "Có yêu cầu xin phép nhưng không đọc được nội dung" }),
				el("p", {
					text: "Không xác định được agent nào và xin phép điều gì, nên không cho duyệt từ đây — để tránh đồng ý nhầm.",
				}),
				el("p", { class: "hint", text: "Nhờ người phụ trách xử lý bằng lệnh: paseo permit ls" }),
				el("details", {}, [el("summary", { text: "Dữ liệu gốc" }), el("pre", { text: JSON.stringify(raw, null, 2) })]),
			]),
		);
	}
}

async function refreshPermits({ silent = false, fresh = false } = {}) {
	try {
		lastPermits = (await api(`/api/permits${fresh ? "?fresh=1" : ""}`)).data;
		setBadge(lastPermits.count ?? 0);
	} catch (error) {
		if (!silent) toastError(error);
	}
}

loaders.permissions = async () => {
	renderPermits();
	await refreshPermits();
	renderPermits();
};

$("permits-refresh").addEventListener("click", async () => {
	await refreshPermits({ fresh: true });
	renderPermits();
});

// --- team view: diagram + list --------------------------------------------
//
// One board for the whole host, grouped by PROJECT. Several Leads (each with its
// own Peers) share one machine in normal use, and a single flat tree made them
// read as one team: the projects only differed by a pill that was easy to miss.
// A project is the node's cluster — policy-core's own answer to "which workspace
// does this seat live in" — falling back to its working directory.

const NODE_W = 250;
const NODE_H = 56;
const COL_GAP = 80;
const ROW_GAP = 14;
const BAND_HEAD = 34;
const BAND_GAP = 22;

let viewMode = "diagram";

const VIEW_HINT = {
	diagram:
		"Mỗi hộp là một agent. Đường nối đi từ người giao việc (bên trái) sang người nhận việc (bên phải). Bấm vào hộp để xem chi tiết hoặc nhắn tin.",
	list: "Mỗi dự án là một nhóm; agent do ai giao việc thì thụt vào dưới người đó. Dòng màu đỏ là agent đang gặp lỗi.",
};

function setView(mode) {
	viewMode = mode;
	$("view-diagram").classList.toggle("active", mode === "diagram");
	$("view-list").classList.toggle("active", mode === "list");
	$("diagram-wrap").classList.toggle("hidden", mode !== "diagram");
	$("list-wrap").classList.toggle("hidden", mode === "diagram");
	$("graph-hint").textContent = VIEW_HINT[mode];
	if (lastGraph) renderTeam(lastGraph);
}

$("view-diagram").addEventListener("click", () => setView("diagram"));
$("view-list").addEventListener("click", () => setView("list"));
$("graph-hint").textContent = VIEW_HINT.diagram;

function roleClass(role) {
	return ["supervisor", "lead", "peer"].includes(role) ? role : "unknown";
}

function truncate(text, max) {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Stamp every node with the project it belongs to.
 *
 * Its own cluster when the CLI could derive one; otherwise its parent's — a
 * sub-agent started through a plain Paseo provider has no state file of its own to
 * read a cluster from, and grouping it by its cwd instead would split it away from
 * the Lead that started it into a second "project" of the same name; otherwise its
 * working directory. Resolved over the WHOLE board before any filter runs, so a
 * filter cannot change which project a node is in.
 */
function annotateProjects(graph) {
	const nodes = graph?.nodes ?? [];
	const byId = new Map(nodes.map((node) => [node.id, node]));
	const memo = new Map();
	const resolve = (node, hops = 0) => {
		if (memo.has(node.id)) return memo.get(node.id);
		let key = node.cluster ?? null;
		const parent = node.parentId ? byId.get(node.parentId) : null;
		if (key === null && parent && hops < 16) key = resolve(parent, hops + 1);
		key = key ?? node.cwd ?? "";
		memo.set(node.id, key);
		return key;
	};
	return { ...graph, nodes: nodes.map((node) => ({ ...node, project: resolve(node) })) };
}

function projectKey(node) {
	return node.project ?? "";
}

function projectName(key) {
	return projectLabel(key) || "Không rõ dự án";
}

/**
 * Nodes grouped by project. A project holding something that needs a person (an
 * approval waiting, an error) comes first; otherwise by name, so the order does
 * not shuffle on every poll.
 */
function groupByProject(nodes) {
	const groups = new Map();
	for (const node of nodes) {
		const key = projectKey(node);
		if (!groups.has(key)) groups.set(key, []);
		groups.get(key).push(node);
	}
	const needsPerson = (list) => list.some((node) => node.pendingPermissions > 0 || node.status === "error");
	return [...groups.entries()]
		.map(([key, list]) => ({ key, name: projectName(key), nodes: list }))
		.sort((a, b) => Number(needsPerson(b.nodes)) - Number(needsPerson(a.nodes)) || a.name.localeCompare(b.name));
}

/**
 * The order a person reads a team in: each root followed by everything it handed
 * out, indented by how many hands away it is. A parent that is not in this group
 * makes its child a root HERE (it is shown, not dropped), and a parent cycle
 * cannot loop: every node is visited once.
 */
function treeOrder(nodes) {
	const ids = new Set(nodes.map((node) => node.id));
	const children = new Map();
	const roots = [];
	for (const node of nodes) {
		if (node.parentId && node.parentId !== node.id && ids.has(node.parentId)) {
			if (!children.has(node.parentId)) children.set(node.parentId, []);
			children.get(node.parentId).push(node);
		} else {
			roots.push(node);
		}
	}
	const order = [];
	const seen = new Set();
	const visit = (node, depth) => {
		if (seen.has(node.id)) return;
		seen.add(node.id);
		order.push({ node, depth });
		for (const child of children.get(node.id) ?? []) visit(child, depth + 1);
	};
	for (const root of roots) visit(root, 0);
	for (const node of nodes) visit(node, 0); // only a cycle leaves anyone unvisited
	return { order, children };
}

/**
 * Tree layout, left to right: leaves take consecutive rows and a parent sits
 * halfway between its first and last child, so edges fan out instead of crossing.
 */
function layoutGroup(nodes) {
	const { order, children } = treeOrder(nodes);
	const rowOf = new Map();
	const visiting = new Set();
	let nextRow = 0;
	const place = (node) => {
		if (rowOf.has(node.id)) return rowOf.get(node.id);
		visiting.add(node.id);
		const kids = (children.get(node.id) ?? []).filter((kid) => !visiting.has(kid.id));
		let row;
		if (kids.length === 0) {
			row = nextRow;
			nextRow += 1;
		} else {
			const rows = kids.map(place);
			row = (Math.min(...rows) + Math.max(...rows)) / 2;
		}
		visiting.delete(node.id);
		rowOf.set(node.id, row);
		return row;
	};
	for (const { node } of order) place(node);
	let maxDepth = 0;
	const positions = new Map();
	for (const { node, depth } of order) {
		maxDepth = Math.max(maxDepth, depth);
		positions.set(node.id, { node, depth, row: rowOf.get(node.id) ?? 0 });
	}
	return { positions, rows: Math.max(1, nextRow), maxDepth };
}

function renderDiagram(graph) {
	const svg = clear($("graph"));
	const groups = groupByProject(graph.nodes ?? []);
	const showHeads = groups.length > 1;
	const placed = new Map();
	const heads = [];
	let y = 16;
	let width = 0;

	for (const group of groups) {
		if (showHeads) {
			heads.push({ y: y + 14, text: `${group.name} · ${group.nodes.length} agent` });
			y += BAND_HEAD;
		}
		const { positions, rows, maxDepth } = layoutGroup(group.nodes);
		for (const [id, at] of positions) {
			placed.set(id, {
				x: 24 + at.depth * (NODE_W + COL_GAP),
				y: y + at.row * (NODE_H + ROW_GAP),
				node: at.node,
			});
		}
		width = Math.max(width, 48 + (maxDepth + 1) * NODE_W + maxDepth * COL_GAP);
		y += rows * (NODE_H + ROW_GAP) + BAND_GAP;
	}

	const height = Math.max(200, y);
	svg.setAttribute("viewBox", `0 0 ${Math.max(width, 320)} ${height}`);
	svg.setAttribute("height", `${Math.min(height, 4000)}`);
	// Left-align instead of the default centring: a two-column tree in a wide
	// viewport would otherwise float in the middle with the roots off-centre.
	svg.setAttribute("preserveAspectRatio", "xMinYMin meet");

	for (const head of heads) {
		svg.appendChild(svgEl("text", { class: "band-title", x: 24, y: head.y, text: head.text }));
		svg.appendChild(svgEl("line", { class: "band-rule", x1: 24, y1: head.y + 8, x2: Math.max(width, 320) - 24, y2: head.y + 8 }));
	}

	for (const edge of graph.edges ?? []) {
		const from = placed.get(edge.from);
		const to = placed.get(edge.to);
		if (!from || !to) continue;
		const x1 = from.x + NODE_W;
		const y1 = from.y + NODE_H / 2;
		const x2 = to.x;
		const y2 = to.y + NODE_H / 2;
		const mid = (x1 + x2) / 2;
		svg.appendChild(
			svgEl("path", { class: `edge ${edge.type}`, d: `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}` }),
		);
	}

	for (const { x, y: top, node } of placed.values()) {
		const group = svgEl("g", { class: "node-box", transform: `translate(${x} ${top})`, onclick: () => openDrawer(node) });
		group.appendChild(
			svgEl("rect", {
				class: "node-rect",
				width: NODE_W,
				height: NODE_H,
				rx: 10,
				fill: "#1b2120",
				stroke: `var(--${roleClass(node.role)})`,
				"stroke-width": node.status === "running" ? 2.5 : 1.2,
				"stroke-dasharray": node.status === "error" ? "4 3" : null,
			}),
		);
		const name = node.name || "(không tên)";
		const kind = `${agentKindLabel(node)}${node.seat ? ` · ${node.seat}` : ""} · ${statusLabel(node.status)}`;
		// A hover tooltip carries the untruncated text; the box shows a slice.
		group.appendChild(svgEl("title", { text: `${name} — ${kind}${runtimeLabel(node) ? `, chạy bằng ${runtimeLabel(node)}` : ""}` }));
		group.appendChild(svgEl("circle", { class: `status-dot ${node.status}`, cx: 15, cy: 19, r: 4.5 }));
		group.appendChild(svgEl("text", { class: "node-label", x: 28, y: 23, text: truncate(name, 27) }));
		group.appendChild(svgEl("text", { class: "node-sub", x: 12, y: 42, text: truncate(kind, 32) }));
		const runtime = runtimeLabel(node);
		if (runtime) {
			group.appendChild(svgEl("text", { class: "node-runtime", x: NODE_W - 12, y: 42, "text-anchor": "end", text: runtime }));
		}
		if (node.pendingPermissions > 0) {
			group.appendChild(svgEl("circle", { class: "badge-permit", cx: NODE_W - 16, cy: 16, r: 10 }));
			group.appendChild(
				svgEl("text", { class: "badge-text", x: NODE_W - 19.5, y: 20, text: String(node.pendingPermissions) }),
			);
		}
		svg.appendChild(group);
	}
}

function renderList(graph) {
	const wrap = clear($("agent-list"));
	const nodes = graph.nodes ?? [];
	if (nodes.length === 0) {
		wrap.appendChild(el("div", { class: "empty" }, [el("p", { text: "Chưa có agent nào." })]));
		return;
	}
	const byId = new Map(nodes.map((node) => [node.id, node]));
	const groups = groupByProject(nodes);
	const showHeads = groups.length > 1;
	const table = el("table", { class: "list" }, [
		el("tr", {}, [
			el("th", { text: "Agent" }),
			el("th", { text: "Loại" }),
			el("th", { text: "Trạng thái" }),
			el("th", { class: "col-parent", text: "Người giao việc" }),
			el("th", { text: "" }),
		]),
	]);
	for (const group of groups) {
		if (showHeads) {
			table.appendChild(
				el("tr", { class: "group-row" }, [el("td", { colspan: "5", text: `${group.name} · ${group.nodes.length} agent` })]),
			);
		}
		for (const { node, depth } of treeOrder(group.nodes).order) {
			const parent = node.parentId ? byId.get(node.parentId) : null;
			table.appendChild(
				el("tr", { class: node.status === "error" ? "row-error" : "" }, [
					el("td", { class: `indent-${Math.min(depth, 5)}` }, [
						el("span", { class: `dot-role ${roleClass(node.role)}` }),
						el("span", { text: node.name || "(không tên)" }),
						node.pendingPermissions > 0 ? el("span", { class: "pill", text: `${node.pendingPermissions} chờ duyệt` }) : null,
					]),
					el("td", {}, [
						el("span", { text: agentKindLabel(node) }),
						runtimeLabel(node) ? el("span", { class: "tag", text: runtimeLabel(node) }) : null,
						node.seat ? el("span", { class: "tag", text: node.seat }) : null,
						advanced && node.domain ? el("span", { class: "tag", text: node.domain }) : null,
						advanced && node.role === "supervisor"
							? el("span", { class: "tag", text: watchLabel(node.watch, node.watchUnreadable) })
							: null,
					]),
					el("td", { class: node.status === "error" ? "no" : "", text: statusLabel(node.status) }),
					el("td", { class: "col-parent", text: parent ? parent.name || "(không tên)" : node.orphan ? "ngoài danh sách này" : "—" }),
					el("td", {}, [el("button", { text: "Chi tiết", onclick: () => openDrawer(node) })]),
				]),
			);
		}
	}
	wrap.appendChild(table);
}

let teamRenderedSig = "";

/** Human label for a seat's jurisdiction. */
function domainLabel(domain) {
	return domain ? domain : "chưa đặt phạm vi";
}

/**
 * What a Supervisor seat watches (`team.watch`). No label is the seat the pack
 * has always had — it watches everything and decides — and says so, instead of
 * showing a blank that reads as "unknown".
 */
function watchLabel(watch, unreadable = []) {
if (!watch) return "giám sát: tất cả";
// A label with a part this pack cannot read makes a seat that decides nothing,
// whatever the rest says — so it must not look like a plausible watch.
const flaw = unreadable.length > 0 ? ` ⚠ không đọc được: ${unreadable.join(", ")} — ghế này không quyết định gì` : "";
return `giám sát: ${watch}${flaw}`;
}

/**
 * Keep a filter <select> in step with what is actually on the board without
 * throwing away the operator's current choice: a filter that resets itself on
 * every 5s poll is worse than no filter.
 */
function syncSelect(select, values, allLabel) {
	const wanted = ["", ...values.map((entry) => entry.value)].join("|");
	if (select.dataset.options !== wanted) {
		const previous = select.value;
		select.dataset.options = wanted;
		clear(select);
		select.appendChild(el("option", { value: "", text: allLabel }));
		for (const entry of values) select.appendChild(el("option", { value: entry.value, text: entry.text }));
		select.value = values.some((entry) => entry.value === previous) ? previous : "";
	}
	return select.value;
}

function syncDomainFilter(graph) {
	const select = $("graph-domain");
	const domains = [...new Set((graph.nodes ?? []).map((node) => node.domain).filter(Boolean))].sort();
	return syncSelect(
		select,
		domains.map((domain) => ({ value: domain, text: domain })),
		"tất cả phạm vi",
	);
}

/**
 * The project filter only exists when there is more than one project to choose
 * between: a dropdown with a single entry is a control that does nothing.
 */
function syncProjectFilter(graph) {
	const projects = groupByProject(graph.nodes ?? []);
	$("graph-project-wrap").classList.toggle("hidden", projects.length < 2);
	const entries = projects.map((project) => ({ value: project.key, text: project.name })).sort((a, b) => a.text.localeCompare(b.text));
	return syncSelect($("graph-project"), entries, "tất cả dự án");
}

/**
 * Restrict the board to one project and/or one jurisdiction.
 *
 * Edges are kept only when BOTH ends survive: half an edge pointing into
 * nothing would read as a message to an agent that does not exist.
 */
function filterBoard(graph, { domain, project }) {
	if (!domain && !project) return graph;
	const nodes = (graph.nodes ?? []).filter(
		(node) => (!domain || node.domain === domain) && (!project || projectKey(node) === project),
	);
	const kept = new Set(nodes.map((node) => node.id));
	return {
		...graph,
		nodes,
		edges: (graph.edges ?? []).filter((edge) => kept.has(edge.from) && kept.has(edge.to)),
	};
}

/**
 * Two Supervisors over one domain is not a cosmetic labelling problem: a Lead
 * under both refuses BOTH decisions and escalates, so governance stops for
 * everyone underneath. Advanced mode only — it is about team.domain labels, which
 * the simple view never mentions — and the "no label" half is further limited to
 * the case where it can matter: the graph cannot read the agents' own
 * PASEO_TEAM_TOPOLOGY, and on the default single-Supervisor setup an unlabelled
 * seat is normal, so reporting it there is noise a reader cannot act on.
 */
function renderJurisdiction(graph) {
	const box = $("graph-jurisdiction");
	const jurisdiction = graph.jurisdiction ?? {};
	const conflicts = jurisdiction.conflicts ?? [];
	const unlabeled = jurisdiction.unlabeled ?? [];
	const supervisors = jurisdiction.supervisors ?? [];
	const lines = [];
	for (const conflict of conflicts) lines.push(`Chồng lấn phạm vi: ${conflict.detail}`);
	if (unlabeled.length > 0 && supervisors.length > 1) {
		lines.push(
			`${unlabeled.length} ghế Trưởng nhóm/Giám sát chưa có nhãn team.domain. Nếu bạn chạy nhiều Giám sát (PASEO_TEAM_TOPOLOGY=multi) thì họ không quản được ai và cũng không ai quản được họ.`,
		);
	}
	// Quiet failure, so it gets its own sentence: nothing refuses anything, every
	// consult just has nobody to land on and goes to the Human.
	if (jurisdiction.undecided) {
		lines.push(
			"Chỉ có ghế quan sát (team.watch), chưa ghế Giám sát nào giữ `decisions`: mọi câu hỏi của Trưởng nhóm sẽ dồn về bạn. Hãy dựng ghế quyết định trước.",
		);
	}
	box.textContent = lines.join(" ");
	box.classList.toggle("hidden", lines.length === 0);
	box.classList.toggle("alert", conflicts.length > 0);
}

/**
 * A Supervisor and a Lead PROVABLY in different clusters (`graph.clusterMismatches`,
 * computed by the CLI from policy-core's own `agentCluster`/`clustersSeparate` —
 * this box only renders what it is given, it does not recompute the mismatch).
 *
 * Every SUPERVISOR_DECISION between such a pair is already refused with
 * CLUSTER_MISMATCH by policy; policy cannot fix a seat it did not create, so
 * this is the one place an operator sees the mismatch before it shows up as a
 * silently-refused decision.
 */
function renderClusterMismatches(graph) {
	const box = $("graph-cluster-mismatch");
	const mismatches = graph.clusterMismatches ?? [];
	box.textContent = mismatches.map((mismatch) => mismatch.detail).join(" ");
	box.classList.toggle("hidden", mismatches.length === 0);
	box.classList.toggle("alert", mismatches.length > 0);
}

function renderTeam(fullGraph) {
	const graph = filterBoard(fullGraph, {
		domain: syncDomainFilter(fullGraph),
		project: syncProjectFilter(fullGraph),
	});
	renderJurisdiction(fullGraph);
	renderClusterMismatches(fullGraph);
	return renderTeamGraph(graph, fullGraph);
}

function renderTeamGraph(graph, fullGraph) {
	// Same payload, same picture: skip the diagram/list rebuild so the 5s poll
	// does not wipe hover state while idle. collectedAt / pendingParents /
	// inspectSpent move on every snapshot but only feed the meta line, the
	// degraded notice and diagnostics, which repaint below regardless.
	const { collectedAt, pendingParents, inspectSpent, ...stable } = graph;
	const sig = `${viewMode}|${advanced}|${JSON.stringify(stable)}`;
	if (sig !== teamRenderedSig) {
		teamRenderedSig = sig;
		if (viewMode === "diagram") renderDiagram(graph);
		else renderList(graph);
	}

	const counts = fullGraph.counts ?? {};
	const shown = (graph.nodes ?? []).length;
	const total = counts.agents ?? shown;
	const scope = shown === total ? `${total} agent` : `${shown}/${total} agent`;
	const messages = (graph.edges ?? []).filter((edge) => edge.type === "message").length;
	$("graph-meta").textContent =
		`${scope}${messages ? ` · ${messages} nhắn tin` : ""} · cập nhật ${relativeTime(graph.collectedAt)}`;

	const notice = $("graph-degraded");
	const sentence = degradedSentence(graph.degraded ?? [], graph.pendingParents ?? 0);
	notice.textContent = sentence;
	notice.classList.toggle("hidden", sentence === "");
}

function openDrawer(node) {
	const drawer = $("node-drawer");
	const body = clear($("drawer-body"));
	drawer.classList.remove("hidden");
	body.appendChild(el("h3", { text: node.name || "(không tên)" }));
	const runtime = runtimeLabel(node);
	body.appendChild(
		el("p", {
			class: "drawer-sub",
			text: `${agentKindLabel(node)}${node.seat ? ` · ${node.seat}` : ""}${runtime ? ` · chạy bằng ${runtime}` : ""} · ${statusLabel(node.status)}`,
		}),
	);
	if (ROLE_HINT[node.role]) body.appendChild(el("p", { class: "hint", text: ROLE_HINT[node.role] }));

	const facts = [];
	const project = projectLabel(node.project ?? "");
	if (project) facts.push(["Dự án", project]);
	facts.push(["Thư mục làm việc", node.cwd], ["Chờ bạn duyệt", node.pendingPermissions || "không có"]);
	if (node.forkOf) {
		const source = lastGraph?.nodes?.find((other) => other.id === node.forkOf);
		facts.push(["Bàn giao từ", source ? source.name || node.forkOf : node.forkOf]);
	}
	if (node.orphan) facts.push(["Người giao việc", "không có trong danh sách này (có thể đã lưu trữ)"]);
	if (advanced) {
		if (node.role === "supervisor" || node.role === "lead") {
			facts.push(["Phạm vi quản (team.domain)", domainLabel(node.domain)]);
			facts.push(["Cluster (team.cluster)", node.cluster ?? "chưa xác định được"]);
		}
		if (node.role === "supervisor") {
			facts.push(["Loại giám sát (team.watch)", watchLabel(node.watch, node.watchUnreadable).replace("giám sát: ", "")]);
		}
		facts.push(["Mã agent", node.id], ["Nhà cung cấp", node.provider], ["Mức suy nghĩ", node.thinking]);
	}
	body.appendChild(kvTable(facts));

	body.appendChild(el("h4", { text: "Nhắn cho agent này" }));
	const input = el("textarea", { class: "drawer-input", placeholder: "Ví dụ: dừng lại và báo cáo tiến độ hiện tại" });
	const send = el("button", {
		class: "primary big",
		text: "Gửi",
		onclick: async () => {
			if (!input.value.trim()) {
				toast("Chưa nhập nội dung.", true);
				return;
			}
			send.disabled = true;
			try {
				await api("/api/agent/send", { method: "POST", body: { agentId: node.id, prompt: input.value } });
				toast("Đã gửi. Agent sẽ đọc khi rảnh.");
				input.value = "";
			} catch (error) {
				toastError(error);
			} finally {
				send.disabled = false;
			}
		},
	});
	body.appendChild(input);
	body.appendChild(send);
	if (advanced && lastCommand) body.appendChild(el("p", { class: "cmd", text: lastCommand }));
}

$("drawer-close").addEventListener("click", () => $("node-drawer").classList.add("hidden"));

async function refreshGraph({ silent = false, fresh = false } = {}) {
	try {
		const params = new URLSearchParams();
		if ($("graph-all").checked) params.set("all", "1");
		if (fresh) params.set("fresh", "1");
		const query = params.toString();
		lastGraph = annotateProjects((await api(`/api/graph${query ? `?${query}` : ""}`)).data);
		if (activeTab === "graph") renderTeam(lastGraph);
	} catch (error) {
		if (!silent) toastError(error);
	}
}

loaders.graph = async () => {
	if (lastGraph) renderTeam(lastGraph);
	await refreshGraph();
};

$("graph-refresh").addEventListener("click", () => refreshGraph({ fresh: true }));
$("graph-all").addEventListener("change", () => refreshGraph());
// Both filters are local view changes: no request, just a redraw.
for (const id of ["graph-domain", "graph-project"]) {
	$(id).addEventListener("change", () => {
		teamRenderedSig = "";
		if (lastGraph) renderTeam(lastGraph);
	});
}

// A paseo round trip costs ~3s, so 5s is the floor that still leaves the daemon
// idle between polls. The server caches, so extra tabs cost nothing.
setInterval(() => {
	if (activeTab === "graph" && !document.hidden) refreshGraph({ silent: true });
}, 5000);

// The pending-approval count is the one thing worth knowing from any tab: an
// agent sitting on a permission request is stopped until somebody answers.
setInterval(async () => {
	if (document.hidden) return;
	await refreshPermits({ silent: true });
	if (activeTab === "permissions") renderPermits();
	if (activeTab === "home") paintHealth();
}, 20_000);

// --- roles -----------------------------------------------------------------

/** The role currently loaded into the editor, and its text as it is on disk. */
const promptState = { role: null, saved: "" };

function promptDirty() {
	return promptState.role !== null && !$("prompt-editor").disabled && $("prompt-editor").value !== promptState.saved;
}

function paintPromptDirty() {
	$("prompt-save").classList.toggle("dirty", promptDirty());
}

async function loadPrompt() {
	const role = $("role-select").value;
	$("role-hint").textContent = ROLE_HINT[role] ?? "";
	try {
		const { data } = await api(`/api/prompts?role=${encodeURIComponent(role)}`);
		promptState.role = role;
		promptState.saved = data.content ?? "";
		$("prompt-editor").disabled = false;
		$("prompt-save").disabled = false;
		$("prompt-editor").value = promptState.saved;
		$("prompt-meta").classList.remove("no");
		$("prompt-meta").textContent = data.path ?? "";
	} catch (error) {
		// An editor that stays empty and enabled invites exactly the wrong move: Lưu
		// would write an empty file over the role's instructions. Say what is wrong
		// where the editor is, and lock it until there is something to edit.
		const info = error?.human ?? humanizeError({ message: error?.message });
		promptState.role = null;
		promptState.saved = "";
		$("prompt-editor").value = "";
		$("prompt-editor").disabled = true;
		$("prompt-save").disabled = true;
		$("prompt-meta").classList.add("no");
		$("prompt-meta").textContent = `${info.title}. ${info.advice}`;
	}
	paintPromptDirty();
}

function confirmDiscardPrompt() {
	return !promptDirty() || confirm("Bạn đã sửa mô tả vai trò này nhưng chưa lưu. Bỏ các thay đổi đó?");
}

$("prompt-load").addEventListener("click", () => {
	if (confirmDiscardPrompt()) loadPrompt();
});
$("role-select").addEventListener("change", () => {
	if (confirmDiscardPrompt()) {
		loadPrompt();
		return;
	}
	$("role-select").value = promptState.role ?? $("role-select").value;
});
$("prompt-editor").addEventListener("input", paintPromptDirty);
$("prompt-save").addEventListener("click", async () => {
	const role = $("role-select").value;
	if ($("prompt-editor").value.trim() === "") {
		toast("Mô tả vai trò đang trống. Không lưu, để khỏi xoá hết chỉ dẫn của vai trò này.", true);
		return;
	}
	try {
		await api(`/api/prompts?role=${encodeURIComponent(role)}`, { method: "POST", body: { content: $("prompt-editor").value } });
		promptState.saved = $("prompt-editor").value;
		paintPromptDirty();
		toast("Đã lưu. Bản cũ được sao lưu tự động.");
	} catch (error) {
		toastError(error);
	}
});

loaders.roles = async () => {
	if (promptState.role === null) await loadPrompt();
	if (!$("env-table").hasChildNodes()) await loadEnvTable();
};

async function loadEnvTable() {
	try {
		const { data } = await api("/api/env");
		const table = el("table", {}, [
			el("tr", {}, [el("th", { text: "Thiết lập" }), el("th", { text: "Hiện tại" }), el("th", { text: "Tác dụng" })]),
		]);
		for (const entry of data.env ?? []) {
			table.appendChild(
				el("tr", {}, [
					el("td", { class: "v", text: entry.key }),
					el("td", { class: entry.current ? "ok" : "k", text: entry.current ?? "chưa đặt" }),
					el("td", { text: entry.purpose }),
				]),
			);
		}
		clear($("env-table")).appendChild(table);
	} catch (error) {
		clear($("env-table")).appendChild(errorBlock(error));
	}
}

// --- config ----------------------------------------------------------------
//
// The tab is a schema-driven form editor: the CLI describes every field
// (label, hint, default, type) in `config read <section>`, and this engine
// renders controls for exactly those fields. An empty control means "key
// absent — the default applies"; saving always starts from the file's own
// JSON, so a key the schema does not know about survives every edit.

const configState = {
	section: null,
	schema: null,
	doc: {},
	/** The document as it is on disk, for "unsaved edits?" checks. */
	saved: {},
	/** Fingerprint of the file as it was read; a save sends it back so a file that changed since is not overwritten. */
	rev: null,
	/** The text of a file that exists but does not parse, until it is repaired. */
	invalidRaw: null,
	mode: "form",
	// Repaint callbacks for fields whose options follow a sibling field.
	// Rebuilt from scratch on every render — a stale closure would write into
	// a detached node and leak the previous section's form.
	dependents: [],
	// Rows with a `showIf`, each with the segments of the object it lives in.
	// Kept here rather than in a data attribute: a path is an array whose map
	// keys may contain dots, and a string attribute would have to be split again.
	conditional: [],
};

function defaultValueLabel(field) {
	if (field.default === undefined) return "";
	const shown = field.type === "bool" ? (field.default ? "có" : "không") : String(field.default);
	return `mặc định: ${shown}`;
}

/**
 * Wrap a repaint so it only runs when the value it depends on actually
 * changed. refreshDependents fires on every keystroke anywhere in the form, and
 * rebuilding a <datalist> under an input the user is typing into closes the
 * browser's suggestion popup — the list would flicker away exactly while it was
 * being used.
 */
function whenDependencyChanges(spec, prefix, paint) {
	let last = null;
	let primed = false;
	return () => {
		const key = String(getPath(configState.doc, fieldPath(prefix, spec.path)) ?? "");
		if (primed && key === last) return;
		primed = true;
		last = key;
		paint();
	};
}

function textInput(field, path) {
	const input = el("input", { type: "text", class: "cfg-input" });
	input.placeholder = field.default !== undefined ? String(field.default) : "";
	input.value = String(getPath(configState.doc, path) ?? "");
	input.addEventListener("input", () => {
		if (input.value === "") deletePath(configState.doc, path);
		else setPath(configState.doc, path, input.value);
	});
	return input;
}

function stringControl(field, path) {
	return textInput(field, path);
}

function boolControl(field, path) {
	const box = el("input", { type: "checkbox" });
	const label = el("span");
	const paint = () => {
		label.textContent = box.checked ? "Bật" : "Tắt";
	};
	box.checked = getPath(configState.doc, path) === undefined ? Boolean(field.default) : Boolean(getPath(configState.doc, path));
	box.addEventListener("change", () => {
		setPath(configState.doc, path, box.checked);
		paint();
	});
	paint();
	return el("label", { class: "cfg-bool" }, [box, label]);
}

function numberControl(field, path) {
	const input = el("input", { type: "number", class: "cfg-input", step: "1" });
	if (field.min !== undefined) input.min = String(field.min);
	if (field.max !== undefined) input.max = String(field.max);
	input.placeholder = field.default !== undefined ? String(field.default) : "";
	const current = getPath(configState.doc, path);
	if (current !== undefined && current !== null) input.value = String(current);
	input.addEventListener("input", () => {
		if (input.value.trim() === "") deletePath(configState.doc, path);
		else setPath(configState.doc, path, Number(input.value));
	});
	return input;
}

/**
 * A dropdown whose options may follow a sibling field.
 *
 * Two lists can feed it. `enum` is the static one the schema always carries.
 * `optionsBy` narrows that to what the sibling allows — a claude-* route must
 * not be offered pi's `minimal`, and its model list is the chosen provider's
 * own catalogue.
 *
 * When a RUNTIME-sourced list (`optionsBy.source`) comes back empty, the
 * daemon could not tell us what exists — which is not the same as "nothing
 * exists". Gating the field behind an empty dropdown would make the form a
 * dead end on a machine whose daemon is down, so the control swaps itself for
 * a text box until the list arrives. Both halves live in one wrapper and write
 * to the same path, so the swap is a visibility toggle, not a re-render.
 */
function enumControl(field, path, prefix) {
	const select = el("select", { class: "cfg-input" });
	const runtimeSourced = Boolean(field.optionsBy?.source);
	const fallback = runtimeSourced ? textInput(field, path) : null;

	const paintSelect = (values) => {
		clear(select);
		select.appendChild(
			el("option", { value: "", text: field.default !== undefined ? `— mặc định (${field.default}) —` : "— mặc định —" }),
		);
		for (const value of values) select.appendChild(el("option", { value, text: value }));
		const current = getPath(configState.doc, path);
		select.value = current === undefined ? "" : String(current);
		// Compare against the stored value, not `select.value`: assigning a value
		// no option carries makes the browser fall back to "", which matches the
		// default option and would hide the stray value behind "— mặc định —".
		if (current !== undefined && ![...select.options].some((option) => option.value === String(current))) {
			// A value outside the list (hand-written, from a newer version, or left
			// over after switching family) stays visible instead of silently
			// snapping back to the default — losing it would rewrite the config.
			select.appendChild(el("option", { value: String(current), text: `${String(current)} (ngoài danh sách)` }));
			select.value = String(current);
		}
	};

	const paint = () => {
		const dependent = field.optionsBy ? dependentOptions(field.optionsBy, configState.doc, prefix) : null;
		const values = dependent !== null && dependent.length > 0 ? dependent : (field.enum ?? []);
		if (fallback) {
			const usable = values.length > 0;
			select.classList.toggle("hidden", !usable);
			fallback.classList.toggle("hidden", usable);
			if (!usable) {
				fallback.value = String(getPath(configState.doc, path) ?? "");
				return;
			}
		}
		paintSelect(values);
	};

	paint();
	select.addEventListener("change", () => {
		if (select.value === "") deletePath(configState.doc, path);
		else setPath(configState.doc, path, select.value);
	});
	if (field.optionsBy) configState.dependents.push(whenDependencyChanges(field.optionsBy, prefix, paint));
	return fallback ? el("div", { class: "cfg-swap" }, [select, fallback]) : select;
}

/**
 * The route provider control: ROLE first, then RUNTIME, writing the single
 * stored key both halves compose ("peer" + "claude" -> "claude-peer").
 *
 * Why two dropdowns instead of the flat list this replaced: the roles are a
 * closed set of three, the runtimes are the axis that grows as the pack learns
 * new coding agents. A flat "<runtime>-<role>" enum multiplied the two into one
 * list that got longer every time a runtime was added; splitting them keeps the
 * choice a human makes — the role — short and fixed, and puts the growth in a
 * second control. The stored path is unchanged (still `paseoProvider`), so the
 * model and thinking fields keep keying off it and nothing on disk moves.
 *
 * A stored value that does not split into a known role+runtime (a hand-edited
 * or newer-version string) is left in the document untouched and shown as a
 * note, rather than silently deleted by a control that could not represent it.
 */
function roleProviderControl(field, path) {
	const roles = field.roles ?? [];
	const runtimes = field.runtimes ?? [];
	const roleSel = el("select", { class: "cfg-input" });
	const runtimeSel = el("select", { class: "cfg-input" });
	roleSel.appendChild(el("option", { value: "", text: "— vai trò —" }));
	for (const role of roles) roleSel.appendChild(el("option", { value: role, text: roleLabel(role) }));
	runtimeSel.appendChild(el("option", { value: "", text: "— runtime —" }));
	for (const rt of runtimes) runtimeSel.appendChild(el("option", { value: rt.id, text: rt.label }));

	const note = el("p", { class: "cfg-hint cfg-roleprovider-note hidden" });

	const parse = (value) => {
		for (const rt of runtimes) {
			for (const role of roles) {
				if (value === `${rt.id}-${role}`) return { runtime: rt.id, role };
			}
		}
		return { runtime: "", role: "" };
	};

	const paintNote = () => {
		const current = String(getPath(configState.doc, path) ?? "");
		const { runtime, role } = parse(current);
		const stranded = current !== "" && (runtime === "" || role === "");
		note.classList.toggle("hidden", !stranded);
		if (stranded) note.textContent = `Giá trị đang lưu "${current}" không khớp vai trò/runtime nào — giữ nguyên, chọn lại để thay.`;
	};

	const paint = () => {
		const { runtime, role } = parse(String(getPath(configState.doc, path) ?? ""));
		roleSel.value = role;
		runtimeSel.value = runtime;
		paintNote();
	};

	const commit = () => {
		const role = roleSel.value;
		const runtime = runtimeSel.value;
		if (role && runtime) setPath(configState.doc, path, `${runtime}-${role}`);
		else deletePath(configState.doc, path);
		// The delegated form listener repaints model/thinking off the new
		// paseoProvider; this only has to keep its own note current. It must NOT
		// re-read the dropdowns from the document: half a choice (a role with no
		// runtime yet) stores nothing, and repainting from that wiped the half
		// just picked — a fresh route card could never be filled in.
		paintNote();
	};

	roleSel.addEventListener("change", commit);
	runtimeSel.addEventListener("change", commit);
	paint();

	return el("div", { class: "cfg-roleprovider" }, [
		el("div", { class: "cfg-roleprovider-pair" }, [
			el("span", { class: "cfg-sub", text: "Vai trò" }),
			roleSel,
			el("span", { class: "cfg-sub", text: "Runtime" }),
			runtimeSel,
		]),
		note,
	]);
}

/**
 * A checkbox set writing an array of ids.
 *
 * The offered list is the intersection of the schema's `enum` and whatever
 * `optionsBy` allows for the sibling it depends on — a capability the catalog
 * refuses for the chosen base role is not merely disabled, it is absent, since
 * `seats apply` would reject the document anyway.
 *
 * A value already in the document that the current list does not offer stays
 * visible and CHECKED, flagged as out-of-list. Silently dropping it would make
 * switching a seat's base quietly rewrite its grants on the next save.
 */
function flagsControl(field, path, prefix) {
	const wrap = el("div", { class: "cfg-flags" });
	const describe = new Map((field.options ?? []).map((option) => [option.id, option]));

	const current = () => {
		const value = getPath(configState.doc, path);
		return Array.isArray(value) ? value.filter((v) => typeof v === "string") : [];
	};

	const write = (next) => {
		if (next.length === 0) deletePath(configState.doc, path);
		else setPath(configState.doc, path, next);
	};

	const paint = () => {
		clear(wrap);
		const dependent = field.optionsBy ? dependentOptions(field.optionsBy, configState.doc, prefix) : null;
		const allowed = dependent !== null ? dependent : (field.enum ?? []);
		const chosen = current();
		const extra = chosen.filter((id) => !allowed.includes(id));
		if (allowed.length === 0 && extra.length === 0) {
			wrap.appendChild(el("p", { class: "cfg-hint", text: "Vai trò gốc này chưa có năng lực nào cấp thêm được." }));
			return;
		}
		for (const id of [...allowed, ...extra]) {
			const option = describe.get(id) ?? { id, label: id };
			const box = el("input", { type: "checkbox" });
			box.checked = chosen.includes(id);
			box.addEventListener("change", () => {
				const next = current().filter((value) => value !== id);
				if (box.checked) next.push(id);
				write(next);
			});
			const tools = Array.isArray(option.tools) && option.tools.length > 0 ? option.tools.join(", ") : null;
			const envKeys = Object.keys(option.env ?? {});
			const grants = [tools, envKeys.length > 0 ? envKeys.join(", ") : null].filter(Boolean).join(" · ");
			wrap.appendChild(
				el("label", { class: "cfg-flag" }, [
					box,
					el("span", { class: "cfg-flag-body" }, [
						el("span", { class: "cfg-flag-label", text: extra.includes(id) ? `${option.label} (ngoài danh sách)` : option.label }),
						grants ? el("code", { class: "cfg-flag-grant", text: grants }) : null,
						option.hint ? el("span", { class: "cfg-hint", text: option.hint }) : null,
					]),
				]),
			);
		}
	};

	paint();
	if (field.optionsBy) configState.dependents.push(whenDependencyChanges(field.optionsBy, prefix, paint));
	return wrap;
}

function linesControl(field, path) {
	const area = el("textarea", { class: "cfg-lines", rows: "3", spellcheck: "false" });
	const current = getPath(configState.doc, path);
	if (Array.isArray(current)) area.value = current.join("\n");
	area.addEventListener("input", () => {
		const lines = parseLines(area.value);
		if (lines.length === 0) deletePath(configState.doc, path);
		else setPath(configState.doc, path, lines);
	});
	return area;
}

function kvControl(field, path) {
	const wrap = el("div", { class: "cfg-kv" });
	const rebuild = () => {
		const entries = [];
		for (const row of wrap.querySelectorAll(".cfg-kv-row")) {
			const key = row.querySelector(".cfg-kv-key").value.trim();
			if (key) entries.push([key, row.querySelector(".cfg-kv-value").value]);
		}
		const next = Object.fromEntries(entries);
		if (Object.keys(next).length === 0) deletePath(configState.doc, path);
		else setPath(configState.doc, path, next);
	};
	const addRow = (key = "", value = "") => {
		const keyInput = el("input", { type: "text", class: "cfg-input cfg-kv-key", placeholder: "TÊN_BIẾN" });
		const valueInput = el("input", { type: "text", class: "cfg-input cfg-kv-value", placeholder: "giá trị" });
		keyInput.value = key;
		valueInput.value = value;
		keyInput.addEventListener("input", rebuild);
		valueInput.addEventListener("input", rebuild);
		const row = el("div", { class: "cfg-kv-row" }, [
			keyInput,
			valueInput,
			el("button", { type: "button", class: "cfg-icon", text: "×", title: "Bỏ dòng này", onclick: () => { row.remove(); rebuild(); } }),
		]);
		wrap.insertBefore(row, wrap.querySelector(".cfg-add"));
	};
	for (const [key, value] of Object.entries(getPath(configState.doc, path) ?? {})) addRow(key, String(value ?? ""));
	wrap.appendChild(el("button", { type: "button", class: "cfg-add", text: "+ Thêm biến", onclick: () => addRow() }));
	return wrap;
}

function mapControl(field, path) {
	const wrap = el("div", { class: "cfg-map" });
	const fixed = field.fixedKeys ?? null;
	// Keys the schema names but a document may leave out (the routing forms'
	// SUPERVISOR_GOVERNANCE / LEAD_RECOVERY). Never renamed, only configured or
	// removed — a half-filled one is caught by optionalEntryProblems at save.
	const optional = field.optionalKeys ?? [];
	const existing = () => getPath(configState.doc, path) ?? {};

	const cardForKey = (key, isFixed, compact = false, isOptional = false) => {
		const card = el("div", { class: "cfg-card" });
		card.dataset.key = key;
		const head = el("div", { class: "cfg-card-head" });
		if (isOptional) {
			head.appendChild(el("span", { class: "cfg-card-title", text: `${key} (tuỳ chọn)` }));
			head.appendChild(
				el("button", {
					type: "button",
					class: "cfg-icon",
					text: "×",
					title: "Bỏ cấu hình lớp này (luồng dùng nó sẽ bị chặn cho tới khi cấu hình lại)",
					onclick: () => {
						deletePath(configState.doc, [...path, key]);
						renderConfigForm();
					},
				}),
			);
		} else if (isFixed) {
			head.appendChild(el("span", { class: "cfg-card-title", text: key }));
		} else {
			// A bare text box at the top of a card says nothing about what goes
			// in it, and the placeholder that would have is hidden the moment
			// the box has a value.
			if (field.keyLabel) head.appendChild(el("span", { class: "cfg-card-keylabel", text: field.keyLabel }));
			const keyInput = el("input", { type: "text", class: "cfg-input cfg-card-key", placeholder: field.keyLabel ?? "Khóa" });
			keyInput.value = key;
			keyInput.addEventListener("change", () => {
				const next = keyInput.value.trim();
				if (!next || next === key) {
					keyInput.value = key;
					return;
				}
				if (Object.hasOwn(existing(), next)) {
					toast(`Đã có mục tên "${next}" rồi.`, true);
					keyInput.value = key;
					return;
				}
				setPath(configState.doc, [...path, next], existing()[key]);
				deletePath(configState.doc, [...path, key]);
				renderConfigForm();
			});
			head.appendChild(keyInput);
			head.appendChild(
				el("button", {
					type: "button",
					class: "cfg-icon",
					text: "×",
					title: "Xóa mục này",
					onclick: () => {
						deletePath(configState.doc, [...path, key]);
						renderConfigForm();
					},
				}),
			);
		}
		card.appendChild(head);
		const body = el("div", { class: "cfg-card-body" });
		appendFields(body, field.item?.fields, [...path, key], { compact });
		card.appendChild(body);
		return card;
	};

	const keys = fixed
		? [...fixed, ...Object.keys(existing()).filter((key) => !fixed.includes(key))]
		: Object.keys(existing());
	keys.forEach((key, index) =>
		wrap.appendChild(cardForKey(key, fixed?.includes(key) === true, index > 0, optional.includes(key))),
	);
	for (const key of optional.filter((name) => !Object.hasOwn(existing(), name))) {
		wrap.appendChild(
			el("button", {
				type: "button",
				class: "cfg-add",
				text: `+ Cấu hình ${key} (tuỳ chọn)`,
				onclick: () => {
					setPath(configState.doc, [...path, key], clone(field.item?.seed ?? {}));
					renderConfigForm();
				},
			}),
		);
	}
	if (!fixed) {
		wrap.appendChild(
			el("button", {
				type: "button",
				class: "cfg-add",
				text: field.addLabel ?? "+ Thêm mục",
				onclick: () => {
					let key = "moi";
					let index = 1;
					while (Object.hasOwn(existing(), key)) key = `moi-${(index += 1)}`;
					setPath(configState.doc, [...path, key], clone(field.item?.seed ?? {}));
					renderConfigForm();
					// A key with quotes or spaces would break a naive selector.
					const fresh = wrap.querySelector(`.cfg-card[data-key="${CSS.escape(key)}"] .cfg-card-key`);
					fresh?.focus();
					fresh?.select();
				},
			}),
		);
	}
	return wrap;
}

/**
 * An ordered list of objects (`type: "list"`): one card per element, each with
 * the item's fields, plus add / remove / move up / move down.
 *
 * Order is data here — a job's executors run in this order when `run` is
 * "sequential" — so moving is a first-class action, not a drag nicety.
 * `minItems` is enforced twice: the remove button is disabled at the floor, and
 * the save refuses a list below it (a fresh map item may start with none).
 * Every structural change re-renders the form, since each card's fields are
 * bound to their element's index.
 */
function listControl(field, path) {
	const wrap = el("div", { class: "cfg-list" });
	const current = getPath(configState.doc, path);
	const count = Array.isArray(current) ? current.length : 0;
	const min = Number.isInteger(field.minItems) ? field.minItems : 0;
	const structural = (change) => () => {
		change();
		renderConfigForm();
	};
	const tool = (className, text, title, disabled, change) => {
		const button = el("button", { type: "button", class: `cfg-icon ${className}`, text, title, onclick: structural(change) });
		button.disabled = disabled;
		return button;
	};
	for (let index = 0; index < count; index++) {
		const card = el("div", { class: "cfg-card cfg-list-item" });
		card.dataset.index = String(index);
		card.appendChild(
			el("div", { class: "cfg-card-head" }, [
				el("span", { class: "cfg-card-title", text: `#${index + 1}` }),
				el("span", { class: "cfg-list-tools" }, [
					tool("cfg-list-up", "↑", "Đưa lên trước", index === 0, () => moveAt(configState.doc, path, index, -1)),
					tool("cfg-list-down", "↓", "Đưa xuống sau", index === count - 1, () => moveAt(configState.doc, path, index, 1)),
					tool("cfg-list-remove", "×", count <= min ? `Cần ít nhất ${min} mục` : "Xóa mục này", count <= min, () =>
						removeAt(configState.doc, path, index),
					),
				]),
			]),
		);
		const body = el("div", { class: "cfg-card-body" });
		appendFields(body, field.item?.fields, [...path, index], { compact: index > 0 });
		card.appendChild(body);
		wrap.appendChild(card);
	}
	if (count < min) {
		wrap.appendChild(el("p", { class: "cfg-hint cfg-list-short", text: `Cần ít nhất ${min} mục.` }));
	}
	wrap.appendChild(
		el("button", {
			type: "button",
			class: "cfg-add cfg-list-add",
			text: field.addLabel ?? "+ Thêm mục",
			onclick: structural(() => {
				const list = getPath(configState.doc, path);
				const seed = clone(field.item?.seed ?? {});
				if (Array.isArray(list)) list.push(seed);
				else setPath(configState.doc, path, [seed]);
			}),
		}),
	);
	return wrap;
}

function fieldControl(field, path, prefix) {
	if (field.type === "bool") return boolControl(field, path);
	if (field.type === "number") return numberControl(field, path);
	if (field.type === "enum") return enumControl(field, path, prefix);
	if (field.type === "role-provider") return roleProviderControl(field, path);
	if (field.type === "lines") return linesControl(field, path);
	if (field.type === "kv") return kvControl(field, path);
	if (field.type === "flags") return flagsControl(field, path, prefix);
	if (field.type === "map") return mapControl(field, path);
	if (field.type === "list") return listControl(field, path);
	return stringControl(field, path, prefix);
}

/**
 * Lay fields out, folding the ones marked `advanced` into a disclosure.
 *
 * Most of these forms have two or three fields somebody actually sets and a
 * tail of tuning knobs nobody touches. Showing all of them at once makes the
 * card twice as tall and buries the two that matter, so the tail is collapsed —
 * still one click away, and still saved whether it is open or shut.
 */
function appendFields(container, fields, prefix, { compact = false } = {}) {
	const plain = [];
	const advanced = [];
	for (const field of fields ?? []) (field.advanced ? advanced : plain).push(field);
	for (const field of plain) container.appendChild(fieldRow(field, prefix, { compact }));
	if (advanced.length === 0) return;
	// Open when something in it is already set: a collapsed section hiding a
	// non-default value is a setting nobody can see is in force.
	const set = advanced.filter((field) => getPath(configState.doc, fieldPath(prefix, field.path)) !== undefined).length;
	const more = el("details", { class: "cfg-more" });
	more.open = set > 0;
	more.appendChild(
		el("summary", { text: `Tuỳ chọn nâng cao (${advanced.length}${set > 0 ? `, ${set} đã đặt` : ""})` }),
	);
	for (const field of advanced) more.appendChild(fieldRow(field, prefix, { compact }));
	container.appendChild(more);
}

function fieldRow(field, prefix, { compact = false } = {}) {
	const path = fieldPath(prefix, field.path);
	const wide = ["map", "list", "flags", "role-provider"].includes(field.type);
	const row = el("div", { class: `cfg-field${wide ? " cfg-field-wide" : ""}` });
	// Label, its default and its hint all live in the FIRST column. They used
	// to be three stacked rows, which made a six-field card taller than the
	// screen and hid the control the row is actually about.
	row.appendChild(
		el("div", { class: "cfg-label" }, [
			// `compact` is every card after the first in a list of look-alike cards
			// (the five routes, each host): the same three paragraphs of hint repeated
			// five times buried the values. The text stays one hover away.
			el("label", { text: field.label, title: compact && field.hint ? field.hint : null }),
			field.default !== undefined ? el("span", { class: "cfg-default", text: defaultValueLabel(field) }) : null,
			field.hint && field.type !== "map" && !compact ? el("p", { class: "cfg-hint", text: field.hint }) : null,
		]),
	);
	row.appendChild(fieldControl(field, path, prefix));
	if ((field.type === "map" || field.type === "list") && field.hint && !compact) {
		row.appendChild(el("p", { class: "cfg-hint", text: field.hint }));
	}
	if (field.showIf) configState.conditional.push({ row, field, base: prefix });
	return row;
}

/**
 * Re-evaluate everything that depends on another field's current value:
 * `showIf` visibility, and the option lists of `optionsBy` fields.
 *
 * This used to run exactly once, at the end of the first render, so a row was
 * frozen at whatever the document said when the form was built — switching a
 * host to `remote` never revealed its endpoint field. It now runs after every
 * edit, via one delegated listener (below) instead of a call in each control.
 */
function refreshDependents() {
	for (const { row, field, base } of configState.conditional) {
		row.classList.toggle("hidden", !isShown(field, configState.doc, base));
	}
	for (const paint of configState.dependents) paint();
}

function renderConfigForm() {
	const schema = configState.schema;
	const form = clear($("config-form"));
	configState.dependents = [];
	configState.conditional = [];
	clear($("config-presets"));
	if (!form.dataset.dependentsBound) {
		// One delegated listener instead of a refresh call inside every control:
		// it fires in the bubble phase, after the control has already written the
		// edit into configState.doc, so the repaint always sees the new value.
		form.dataset.dependentsBound = "1";
		form.addEventListener("input", refreshDependents);
		form.addEventListener("change", refreshDependents);
	}
	$("config-intro").textContent = schema?.intro ?? "";
	if (!schema) return;

	for (const preset of schema.presets ?? []) {
		$("config-presets").appendChild(
			el("div", { class: "preset-item" }, [
				el("button", {
					type: "button",
					class: "preset",
					text: preset.label,
					onclick: () => {
						deepMerge(configState.doc, clone(preset.patch));
						renderConfigForm();
						toast(`Đã điền sẵn: ${preset.label}. Xem lại rồi bấm Lưu.`);
					},
				}),
				preset.hint ? el("span", { class: "cfg-hint preset-hint", text: preset.hint }) : null,
			]),
		);
	}

	renderConfigActions(schema);

	for (const group of schema.groups ?? []) {
		const fieldset = el("fieldset", { class: "cfg-group" });
		fieldset.appendChild(el("legend", { text: group.label }));
		if (group.hint) fieldset.appendChild(el("p", { class: "cfg-hint", text: group.hint }));
		appendFields(fieldset, group.fields, []);
		form.appendChild(fieldset);
	}
	refreshDependents();
	// Presets and add/remove-card buttons rebuild the form without firing an
	// input event, so the Save button's "unsaved" state is refreshed here too.
	paintDirty();
}

/**
 * Buttons a section declares for itself, plus the last result underneath.
 *
 * These run a `pteam` command rather than editing the document, so they are
 * kept visibly apart from the fields: the form's Lưu writes a file, an action
 * goes and does something to the machine. One runs at a time, and the running
 * one says what it is doing — a model sweep can take minutes, and a button that
 * looks idle for three minutes reads as broken.
 */
function renderConfigActions(schema) {
	const host = clear($("config-actions"));
	const actions = schema?.actions ?? [];
	host.classList.toggle("hidden", actions.length === 0);
	if (actions.length === 0) return;

	const row = el("div", { class: "cfg-actions-row" });
	const output = el("div", { class: "cfg-actions-out hidden" });
	const buttons = [];

	for (const action of actions) {
		const button = el("button", {
			type: "button",
			class: action.primary ? "primary" : "",
			text: action.label,
			onclick: async () => {
				for (const other of buttons) other.disabled = true;
				const idle = button.textContent;
				button.textContent = action.busy ?? "Đang chạy…";
				host.classList.add("running");
				clear(output).classList.remove("hidden", "bad", "good");
				output.appendChild(el("p", { class: "cfg-hint", text: action.busy ?? "Đang chạy…" }));
				try {
					const { data } = await api(action.api, { method: "POST", body: {} });
					paintActionResult(output, action, data);
				} catch (error) {
					// A partial failure still answers with a full report, and the
					// server now carries it through a non-zero exit. Show which
					// part failed rather than one flat "command failed".
					const report = error?.payload?.data;
					if (report && typeof report === "object") {
						paintActionResult(output, action, report);
						// api() paints "mất kết nối" for any non-ok answer, but a
						// report that came back in full is the server working,
						// not failing. The panel below already says which part
						// went wrong.
						paintConnection("ok", "vừa xong");
					} else {
						output.classList.add("bad");
						clear(output).appendChild(el("p", { class: "cfg-actions-head", text: errorLine(error?.payload ?? { message: error?.message }) }));
					}
				} finally {
					button.textContent = idle;
					host.classList.remove("running");
					for (const other of buttons) other.disabled = false;
				}
			},
		});
		buttons.push(button);
		row.appendChild(el("div", { class: "cfg-action" }, [button, action.hint ? el("span", { class: "cfg-hint", text: action.hint }) : null]));
	}
	host.appendChild(row);
	host.appendChild(output);
}

/** humanizeError returns a {title, advice} pair; a list row needs one line. */
function errorLine(payload) {
	const info = humanizeError(payload);
	return info.title === "Có lỗi xảy ra" ? (payload?.message ?? info.technical) : `${info.title}. ${info.advice}`;
}

/**
 * Say what the run actually did, in the terms the person pressing the button
 * cares about: which endpoint, how many models still answer, and — when it did
 * not work — what to do next. A bare "ok" would hide a provider that failed
 * while its neighbour succeeded.
 */
function paintActionResult(output, action, data) {
	const box = clear(output);
	const failed = data?.ok === false;
	output.classList.toggle("bad", failed);
	output.classList.toggle("good", !failed);

	if (Array.isArray(data?.providers)) {
		const warnings = (Array.isArray(data.warnings) ? data.warnings : []).map(syncWarningText).filter(Boolean);
		box.appendChild(
			el("p", {
				class: "cfg-actions-head",
				text:
					(failed ? "Có điểm cuối không cập nhật được" : "Đã cập nhật xong") +
					(warnings.length > 0 ? ` — ${warnings.length} cảnh báo` : ""),
			}),
		);
		// Warnings first and loud: each one is a model whose limit is wrong or
		// unknown, or a models.dev that could not be reached — the very things a
		// person pressing this button needs to act on, which stderr alone hid.
		if (warnings.length > 0) {
			box.appendChild(
				el("div", { class: "cfg-actions-warn", role: "alert" }, [
					el("strong", { text: "Cảnh báo" }),
					el("ul", {}, warnings.map((line) => el("li", { text: line }))),
				]),
			);
		}
		const origin = limitsOriginSentence(data.limits);
		if (origin) box.appendChild(el("p", { class: `cfg-actions-origin ${origin.level}`, text: origin.text }));
		const list = el("ul", { class: "cfg-actions-list" });
		for (const entry of data.providers) {
			const dead = (entry.probed ?? []).filter((x) => !x.live).length;
			// One malformed entry must not take the whole report down with it.
			const models = Array.isArray(entry.models) ? entry.models.filter((m) => m && typeof m === "object") : [];
			list.appendChild(
				el("li", { class: entry.ok ? "ok" : "no" }, [
					el("b", { text: entry.provider }),
					el("span", {
						text: entry.ok
							? ` — giữ lại ${entry.written} model` + (dead > 0 ? `, bỏ ${dead} model không trả lời` : "")
							: ` — ${errorLine({ code: entry.code, message: entry.message })}`,
					}),
					models.length > 0
						? el("ul", { class: "cfg-model-limits", title: "context window · max output · nguồn" }, [
								el("li", { class: "cfg-model-limits-legend", text: "context window · max output · nguồn" }),
								...models.map((model) =>
									el("li", { class: `cfg-model-limit ${model.limitSource === "unknown" ? "unknown" : ""}`.trim(), "data-model": model.id }, [
										el("code", { text: model.id }),
										el("span", { text: modelLimitsLabel(model) }),
									]),
								),
							])
						: null,
				]),
			);
		}
		box.appendChild(list);
		if (data.refresh && data.refresh.ok === false) {
			box.appendChild(el("p", { class: "cfg-hint", text: data.refresh.hint ?? data.refresh.message }));
		}
		return;
	}

	box.appendChild(
		el("p", {
			class: "cfg-actions-head",
			text: failed ? (data?.hint ?? data?.message ?? "Không chạy được") : "Paseo đã đọc lại danh sách model.",
		}),
	);
}

/** Flip visibility only. `loadConfig` uses this directly: the freshly loaded
 *  document is the truth, so it must not round-trip through the textarea. */
function applyConfigMode(mode) {
	configState.mode = mode;
	$("config-mode-form").classList.toggle("active", mode === "form");
	$("config-mode-raw").classList.toggle("active", mode === "raw");
	for (const id of ["config-form", "config-presets", "config-intro"]) {
		$(id).classList.toggle("hidden", mode !== "form");
	}
	$("config-raw").classList.toggle("hidden", mode !== "raw");
	if (mode === "form") renderConfigForm();
}

function setConfigMode(mode) {
	if (mode === "raw") {
		// Serialize the working document so form edits carry into the textarea.
		$("config-editor").value = JSON.stringify(configState.doc, null, 2);
		applyConfigMode("raw");
		return;
	}
	try {
		configState.doc = JSON.parse($("config-editor").value);
	} catch (cause) {
		toast(`JSON chưa hợp lệ, chưa chuyển về form được: ${cause.message}`, true);
		return;
	}
	applyConfigMode("form");
}

async function loadConfig({ fresh = false } = {}) {
	const section = $("config-section").value;
	try {
		// A save changes the file (so the CLI-side cache is already dropped), but an
		// explicit reload may follow a change made by something else — Pi itself —
		// which the 5s read cache cannot know about.
		const { data } = await api(`/api/config?section=${encodeURIComponent(section)}${fresh ? "&fresh=1" : ""}`);
		configState.section = section;
		configState.schema = data.schema ?? null;
		configState.rev = typeof data.rev === "string" ? data.rev : null;
		configState.invalidRaw = data.invalid ? String(data.raw ?? "") : null;
		configState.doc = data.exists ? clone(data.data) : clone(configState.schema?.seed ?? {});
		// What is on disk right now, so "Áp dụng ghế" can tell edited from saved.
		configState.saved = pruneEmpty(clone(configState.doc)) ?? {};
		$("seats-apply").classList.toggle("hidden", section !== "seats");
		$("config-meta").textContent = data.invalid
			? `${data.path} — file này đang HỎNG, không đọc được JSON (${data.invalid.message}). Sửa trong ô dưới rồi Lưu; bản hỏng được sao lưu.`
			: `${data.path}${data.exists ? "" : " (chưa tồn tại — lưu sẽ tạo mới)"}`;
		$("config-meta").classList.toggle("no", Boolean(data.invalid));
		$("config-editor").value = data.invalid ? configState.invalidRaw : JSON.stringify(configState.doc, null, 2);
		// A section without a schema keeps the old raw-JSON editor, and so does a
		// file that does not parse: the form cannot show what could not be read.
		applyConfigMode(configState.schema && !data.invalid ? "form" : "raw");
		paintDirty();
	} catch (error) {
		toastError(error);
	}
}

/**
 * Has the person changed anything since the file was read?
 *
 * Leaving a section (or pressing Tải lại) used to throw the edits away without a
 * word — one mis-click on the dropdown and a form's worth of changes was gone.
 */
function configDirty() {
	if (configState.section === null) return false;
	if (configState.invalidRaw !== null) return $("config-editor").value !== configState.invalidRaw;
	let working;
	if (configState.mode === "raw") {
		try {
			working = pruneEmpty(JSON.parse($("config-editor").value)) ?? {};
		} catch {
			return true; // text that is not even JSON has certainly been edited
		}
	} else {
		working = pruneEmpty(clone(configState.doc)) ?? {};
	}
	return JSON.stringify(working) !== JSON.stringify(configState.saved ?? {});
}

function paintDirty() {
	const dirty = configDirty();
	$("config-save").classList.toggle("dirty", dirty);
	$("config-save").textContent = dirty ? "Lưu thay đổi" : "Lưu";
}

/** Ask before discarding edits; true means "go ahead". */
function confirmDiscardConfig() {
	if (!configDirty()) return true;
	return confirm("Bạn đã sửa mục này nhưng chưa lưu. Bỏ các thay đổi đó?");
}

$("config-load").addEventListener("click", () => {
	if (confirmDiscardConfig()) loadConfig({ fresh: true });
});
$("config-section").addEventListener("change", () => {
	if (confirmDiscardConfig()) {
		loadConfig({ fresh: true });
		return;
	}
	$("config-section").value = configState.section ?? $("config-section").value;
});
// Edits fire input/change inside these two; the Save button follows them.
for (const id of ["config-form", "config-editor"]) {
	$(id).addEventListener("input", paintDirty);
	$(id).addEventListener("change", paintDirty);
}
window.addEventListener("beforeunload", (event) => {
	if ((activeTab === "config" && configDirty()) || (activeTab === "roles" && promptDirty())) {
		event.preventDefault();
		event.returnValue = "";
	}
});

/**
 * Apply the SAVED seat document, never the form's working copy.
 *
 * The CLI reads the file, so applying while the form holds unsaved edits would
 * generate providers from a document the user is still writing. Refusing with
 * a message beats generating something they did not ask for.
 */
$("seats-apply").addEventListener("click", async () => {
	if (JSON.stringify(pruneEmpty(clone(configState.doc)) ?? {}) !== JSON.stringify(configState.saved ?? {})) {
		toast("Còn thay đổi chưa lưu. Bấm Lưu trước rồi mới Áp dụng.", true);
		return;
	}
	try {
		const { data } = await api("/api/seats/apply", { method: "POST", body: {} });
		if (data.ok === false) {
			toast(`Không áp dụng được: ${(data.errors ?? []).join(" | ")}`, true);
			return;
		}
		const parts = [
			data.created?.length ? `tạo ${data.created.join(", ")}` : null,
			data.updated?.length ? `cập nhật ${data.updated.join(", ")}` : null,
			data.removed?.length ? `gỡ ${data.removed.join(", ")}` : null,
			data.skipped?.length ? `bỏ qua (đã có sẵn, không phải do công cụ tạo): ${data.skipped.join(", ")}` : null,
		].filter(Boolean);
		toast(parts.length > 0 ? `${parts.join("; ")}. ${data.note}` : `Không có gì thay đổi. ${data.note}`);
	} catch (error) {
		toastError(error);
	}
});
$("config-mode-form").addEventListener("click", () => setConfigMode("form"));
$("config-mode-raw").addEventListener("click", () => setConfigMode("raw"));
$("config-save").addEventListener("click", async () => {
	const section = configState.section ?? $("config-section").value;
	let text;
	if (configState.mode === "raw") {
		text = $("config-editor").value;
	} else {
		// Checked and written from a copy with each list element tidied first: a
		// field its `showIf` hides is not part of what is saved, so it must not
		// be what blocks the save either. The working document keeps it, so
		// switching an executor's kind back and forth loses nothing until Lưu.
		const doc = cleanListItems(configState.schema, clone(configState.doc) ?? {});
		const problems = [
			...numberRangeProblems(configState.schema, doc),
			...dependentOptionProblems(configState.schema, doc),
			...optionalEntryProblems(configState.schema, doc),
			...listLengthProblems(configState.schema, doc),
		];
		if (problems.length > 0) {
			toast(problems.join(" · "), true);
			return;
		}
		text = JSON.stringify(fillKeptEmpty(configState.schema, pruneEmpty(doc) ?? {}), null, 2);
	}
	try {
		JSON.parse(text); // fail here, before anything touches the file
	} catch (cause) {
		toast(`Nội dung chưa đúng định dạng JSON: ${cause.message}`, true);
		return;
	}
	try {
		// `rev` is the fingerprint of the file this form was built from: if anything
		// (Pi itself rewrites its own settings.json) changed it since, the CLI
		// refuses instead of silently writing a stale copy over those changes.
		const rev = configState.section === section && configState.rev ? `&rev=${encodeURIComponent(configState.rev)}` : "";
		await api(`/api/config?section=${encodeURIComponent(section)}${rev}`, { method: "POST", raw: text });
		toast("Đã lưu. Bản cũ được sao lưu kèm thời gian.");
		await loadConfig({ fresh: true });
	} catch (error) {
		toastError(error);
	}
});

loaders.config = async () => {
	if (configState.section !== $("config-section").value) await loadConfig();
};

// --- boot ------------------------------------------------------------------

applyMode();
// No up-front complaint about a missing token: `paseo-team web --no-token` runs
// without one, and warning there was a false alarm on every page load. A server
// that DOES need one answers 401, which api() turns into the same advice.
for (const tile of document.querySelectorAll("[data-goto]")) {
	tile.addEventListener("click", () => selectTab(tile.dataset.goto));
}
selectTab("home");
