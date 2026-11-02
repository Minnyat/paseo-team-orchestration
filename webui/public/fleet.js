/**
 * fleet.js — the "Máy" (hosts) and "Luồng việc" (task flow) pages.
 *
 * Same contract as app.js: every value on screen comes from a `paseo-team`
 * answer (hosts list / dispatch plan / flow / runtimes), nothing is computed
 * that the CLI did not send beyond counting and sorting it, and everything is
 * inserted with textContent. A connection string goes to the CLI on stdin.
 *
 *   Máy        summary bar, one card per machine (status, capabilities, load
 *              against its limits, problems with a copyable fix, check /
 *              change connection / remove), the add-machine dialog.
 *   Luồng việc the planner (each host's steps as a pipeline, the winner with
 *              the exact create_agent to copy), the live board (one lane per
 *              machine, running seats first), jobs, class × machine heatmap,
 *              and the runtimes that can be seated.
 *
 * app.js passes its helpers in; this module owns no token and no fetch.
 */

const CAPABILITIES = [
	["git-read", "Đọc repo"],
	["git-write", "Commit/push"],
	["focused-test", "Chạy test"],
	["independent-review", "Review độc lập"],
	["integration-test", "Test tích hợp"],
	["docker", "Docker"],
];
const CLASSES = ["CODING_MEDIUM", "REASONING_HIGH", "REVIEW_HIGH", "FAST_READ", "MONITOR_ECONOMY", "SUPERVISOR_GOVERNANCE", "LEAD_RECOVERY"];
const KINDS = [["", "Theo lớp"], ["writer", "Viết code"], ["reviewer", "Review độc lập"], ["reader", "Chỉ đọc"]];
const STEPS = ["capability", "independence", "route", "reachable", "inventory", "capacity"];
const STEP_LABEL = { capability: "Năng lực", independence: "Độc lập", route: "Route", reachable: "Kết nối", inventory: "Model", capacity: "Còn chỗ" };
const PROBLEM_LABEL = {
	NOT_IN_REGISTRY: "Chưa đăng ký với daemon — Lead chưa seat qua MCP được",
	NO_SERVER_ID: "Thiếu serverId — create_agent { serverId } sẽ bị từ chối",
	SERVER_ID_MISMATCH: "serverId trong file khác với daemon",
	OFFLINE: "Daemon không online",
	REGISTRY_DISABLED: "Đang bị tắt trong registry",
	ENDPOINT_ENV_UNSET: "Thiếu biến môi trường endpoint (chỉ ảnh hưởng remote-paseo / preflight)",
};
const TONE = { online: "ok", local: "ok", reachable: "ok", connecting: "warn", failed: "no", offline: "no", unreachable: "no", unknown: "warn" };
const STATUS_TEXT = { online: "Online", local: "Máy này", reachable: "Online", connecting: "Đang kết nối", failed: "Lỗi", offline: "Offline", unreachable: "Không với tới", unknown: "Chưa rõ" };

export function mountFleet({ api: rawApi, el, clear, toast, toastError: rawToastError, $ }) {
	const state = { hosts: null, flowTimer: null, plan: null, planTab: "mcp" };
	// The server wraps the CLI's JSON in `data`, on success AND on a non-zero
	// exit; the CLI's own sentence (`data.message`) is what the reader needs.
	const api = async (path, options) => (await rawApi(path, options)).data;
	const cliMessage = (error) => error?.payload?.data?.message ?? error?.payload?.data?.blocked ?? null;
	const toastError = (error) => {
		const message = cliMessage(error);
		if (message) toast(`${error?.payload?.data?.code ?? "Lỗi"}: ${message}`, true);
		else rawToastError(error);
	};

	// --- small building blocks ---------------------------------------------
	const svg = (paths, cls = "i") => {
		const node = document.createElementNS("http://www.w3.org/2000/svg", "svg");
		node.setAttribute("viewBox", "0 0 24 24");
		node.setAttribute("class", cls);
		node.setAttribute("aria-hidden", "true");
		for (const d of paths) {
			const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
			p.setAttribute("d", d);
			node.appendChild(p);
		}
		return node;
	};
	const ICON = {
		plus: ["M12 5v14", "M5 12h14"],
		copy: ["M9 9h10v10H9z", "M5 15V5h10"],
		check: ["M5 12.5 10 17 19 7"],
		x: ["M6 6l12 12", "M18 6 6 18"],
		dots: ["M5 12h.01", "M12 12h.01", "M19 12h.01"],
		play: ["M8 5v14l11-7z"],
	};
	const chip = (text, tone = "") => el("span", { class: `chip ${tone}`.trim(), text });
	const dot = (tone, pulse = false) => el("span", { class: `dot ${tone}${pulse ? " pulse" : ""}`, "aria-hidden": "true" });
	const button = (label, { icon, cls = "", title, onclick } = {}) => {
		const b = el("button", { type: "button", class: cls, title: title ?? null, "aria-label": !label && title ? title : null });
		if (icon) b.appendChild(svg(ICON[icon]));
		if (label) b.appendChild(el("span", { text: label }));
		if (onclick) b.addEventListener("click", onclick);
		return b;
	};
	const pre = (text) => el("pre", { class: "code-block", text });
	const copy = async (text) => {
		try {
			await navigator.clipboard.writeText(text);
			toast("Đã sao chép");
		} catch {
			toast("Trình duyệt không cho sao chép — chọn và copy tay", true);
		}
	};
	const busy = async (b, work) => {
		b.disabled = true;
		b.classList.add("loading");
		try {
			return await work();
		} catch (error) {
			toastError(error);
			return null;
		} finally {
			b.disabled = false;
			b.classList.remove("loading");
		}
	};
	const skeleton = (lines = 3) =>
		el("div", { class: "skeleton-group", "aria-busy": "true" }, Array.from({ length: lines }, (_, i) => el("div", { class: `skeleton ${i === 0 ? "w-40" : i % 2 ? "w-90" : "w-70"}` })));
	const meter = (label, used, limit, valueText = null) => {
		const pct = !limit ? (used ? 100 : 0) : Math.min(100, Math.round(((used ?? 0) / limit) * 100));
		const tone = limit === 0 ? "off" : pct >= 100 ? "no" : pct >= 60 ? "warn" : "ok";
		return el("div", { class: `meter ${tone}` }, [
			el("div", { class: "meter-head" }, [el("span", { text: label }), el("b", { text: valueText ?? (limit === 0 ? "không nhận" : `${used ?? "?"} / ${limit ?? "∞"}`) })]),
			el("div", { class: "meter-track" }, [el("div", { class: "meter-fill", style: `width:${limit === 0 ? 0 : pct}%` })]),
		]);
	};

	// =========================================================== HOSTS PAGE
	async function loadHosts() {
		const root = $("fleet-hosts");
		if (!root.dataset.loaded) clear(root).appendChild(el("div", { class: "host-grid" }, [1, 2, 3].map(() => el("div", { class: "card host-card" }, [skeleton(5)]))));
		let data;
		try {
			data = await api("/api/hosts");
		} catch (error) {
			clear(root).appendChild(el("div", { class: "error-block" }, [el("strong", { text: "Không đọc được danh sách máy" }), el("p", { text: cliMessage(error) ?? String(error?.message ?? error) })]));
			return;
		}
		root.dataset.loaded = "1";
		state.hosts = data;
		paintSummary(data);
		clear(root);
		if (!data.clusterExists) {
			root.appendChild(el("div", { class: "empty" }, [
				el("div", { class: "empty-icon", text: "+" }),
				el("strong", { text: "Chưa có cụm nhiều máy" }),
				el("p", { text: "Thêm máy đầu tiên — file cụm sẽ được tạo từ route của máy này." }),
				button("Thêm máy", { icon: "plus", cls: "primary", onclick: openAddDialog }),
			]));
		}
		if (data.registryProblem) root.appendChild(el("div", { class: "callout warn" }, [el("span", { text: `Không đọc được registry của daemon: ${data.registryProblem}` })]));
		const grid = el("div", { class: "host-grid" });
		for (const host of data.hosts ?? []) grid.appendChild(hostCard(host));
		root.appendChild(grid);
		if ((data.unmanaged ?? []).length > 0) {
			root.appendChild(el("h3", { class: "section-title", text: "Đã kết nối nhưng chưa thuộc cụm" }));
			root.appendChild(el("div", { class: "stack" }, data.unmanaged.map(unmanagedRow)));
		}
	}

	function paintSummary(data) {
		const hosts = data.hosts ?? [];
		const online = hosts.filter((h) => (TONE[h.status] ?? "warn") === "ok").length;
		const attention = hosts.filter((h) => h.problems.length > 0).length;
		const running = hosts.reduce((n, h) => n + (h.agents?.running ?? 0), 0);
		const bar = clear($("fleet-summary"));
		const stat = (value, label, tone = "") => el("div", { class: `sum-stat ${tone}`.trim() }, [el("b", { text: String(value) }), el("span", { text: label })]);
		bar.append(
			stat(hosts.length, "máy trong cụm"),
			stat(online, "online", online === hosts.length ? "ok" : "warn"),
			stat(attention, "cần chú ý", attention ? "warn" : "ok"),
			stat(running, "agent đang chạy"),
		);
		const badge = $("hosts-badge");
		badge.textContent = String(attention);
		badge.classList.toggle("hidden", !attention);
		$("stat-hosts").textContent = hosts.length ? `${online}/${hosts.length}` : "–";
	}

	function hostCard(host) {
		const tone = TONE[host.status] ?? "warn";
		const card = el("article", { class: `card host-card tone-${host.problems.length && tone === "ok" ? "attn" : tone}` });
		const menu = el("details", { class: "menu" }, [el("summary", { "aria-label": "Thao tác khác", title: "Thao tác khác" }, [svg(ICON.dots)])]);
		const menuBody = el("div", { class: "menu-body" });
		menu.appendChild(menuBody);
		if (host.type !== "local") {
			menuBody.append(
				button("Đổi kết nối…", { onclick: () => { menu.open = false; openConnectionDialog(host); } }),
				button("Gỡ khỏi cụm", {
					cls: "danger-text",
					onclick: () => {
						menu.open = false;
						confirmDialog(`Gỡ ${host.hostId}?`, "Máy bị gỡ khỏi file cụm và registry của daemon. Agent đang chạy trên máy đó không bị dừng.", "Gỡ máy", async () => {
							await api("/api/hosts/remove", { method: "POST", body: { hostId: host.hostId } });
							toast(`Đã gỡ ${host.hostId}`);
							await loadHosts();
						});
					},
				}),
			);
		}
		menuBody.append(button("Sao chép serverId", { onclick: () => { menu.open = false; copy(host.serverId ?? ""); } }));

		const head = el("header", { class: "host-head" }, [
			dot(tone, tone === "ok"),
			el("div", { class: "host-title" }, [
				el("h3", { text: host.hostId }),
				el("span", { class: "host-sub", text: host.registry?.target ?? (host.type === "local" ? "Daemon trên máy này" : "Chưa có trong registry") }),
			]),
			menu,
		]);
		const badges = el("div", { class: "host-badges" }, [
			chip(STATUS_TEXT[host.status] ?? host.status ?? "?", tone),
			host.type === "local" ? chip("controller", "info") : null,
			host.required ? chip("bắt buộc") : null,
		]);
		const roles = el("div", { class: "host-roles" }, [
			el("span", { class: `role-pill ${host.roles?.writer ? "on" : ""}`, text: `${host.roles?.writer ? "✓" : "✗"} Viết code` }),
			el("span", { class: `role-pill ${host.roles?.reviewer ? "on" : ""}`, text: `${host.roles?.reviewer ? "✓" : "✗"} Review` }),
			...(host.capabilities ?? []).map((c) => el("span", { class: "cap", text: c })),
		]);
		const running = host.agents?.running ?? null;
		const meters = el("div", { class: "meters" }, [
			// The CLI has no per-kind count: show the writer LIMIT, not a guessed usage.
			meter("Writer", 0, host.limits?.writers, host.limits?.writers === 0 ? "không nhận" : `tối đa ${host.limits?.writers ?? "∞"}`),
			meter("Đang chạy / reader", running, host.limits?.readers),
		]);
		const agentsLine = host.agents
			? el("p", { class: "host-agents" }, [el("b", { text: String(host.agents.running) }), el("span", { text: " đang chạy · " }), el("b", { text: String(host.agents.idle) }), el("span", { text: ` rảnh · ${host.agents.total} tổng` })])
			: host.type === "local" ? null : el("p", { class: "host-agents muted", text: "Không quan sát agent từ đây (thiếu endpoint env)" });
		const problems = host.problems.length
			? el("ul", { class: "problems" }, host.problems.map((p) =>
					el("li", { class: "callout warn" }, [
						el("div", {}, [el("strong", { text: PROBLEM_LABEL[p.code] ?? p.code }), p.detail ? el("span", { class: "muted", text: ` — ${p.detail}` }) : null]),
						p.fix ? el("div", { class: "fix" }, [el("code", { text: p.fix }), button("", { icon: "copy", cls: "icon-btn", title: "Sao chép lệnh sửa", onclick: () => copy(p.fix) })]) : null,
					]),
				))
			: null;
		const routes = el("details", { class: "routes" }, [
			el("summary", { text: `Route của máy · ${host.routes?.length ?? 0} lớp` }),
			el("div", { class: "route-list" }, (host.routes ?? []).map((r) =>
				el("div", { class: `route-item ${r.enabled ? "" : "off"}` }, [el("span", { class: "route-class", text: r.modelClass }), el("code", { text: `${r.paseoProvider}/${r.model}` }), chip(r.thinking), r.alternates ? chip(`+${r.alternates}`) : null]),
			)),
		]);
		const out = el("div", { class: "check-out" });
		const checkBtn = button("Kiểm tra", { icon: "check" });
		checkBtn.addEventListener("click", () => busy(checkBtn, async () => {
			clear(out).appendChild(skeleton(4));
			try {
				const r = await api(`/api/hosts/check?id=${encodeURIComponent(host.hostId)}`);
				clear(out).appendChild(checkPanel(r));
			} catch (error) {
				clear(out);
				throw error;
			}
		}));
		card.appendChild(el("div", { class: "host-body" }, [head, badges, roles, meters, agentsLine, problems, routes, el("footer", { class: "host-foot" }, [checkBtn]), out]));
		return card;
	}

	function checkPanel(r) {
		const level = (c) => c.status ?? c.level;
		const counts = { pass: 0, warn: 0, fail: 0 };
		for (const c of r.checks) counts[level(c)] = (counts[level(c)] ?? 0) + 1;
		const order = { fail: 0, warn: 1, pass: 2 };
		return el("div", { class: `check-panel ${r.verdict}` }, [
			el("div", { class: "check-sum" }, [
				el("strong", { text: r.verdict === "pass" ? "Mọi kiểm tra đạt" : r.verdict === "warn" ? "Đạt, có lưu ý" : "Có kiểm tra thất bại" }),
				chip(`${counts.pass} đạt`, "ok"),
				counts.warn ? chip(`${counts.warn} lưu ý`, "warn") : null,
				counts.fail ? chip(`${counts.fail} lỗi`, "no") : null,
			]),
			el("ul", { class: "check-list" }, [...r.checks].sort((a, b) => order[level(a)] - order[level(b)]).map((c) =>
				el("li", { class: level(c) }, [
					el("span", { class: "check-mark", text: level(c) === "pass" ? "✓" : level(c) === "warn" ? "!" : "✗" }),
					el("div", {}, [el("code", { text: String(c.id ?? c.name).replace(/^cluster-(remote|route|host):/, "") }), el("p", { text: c.detail ?? "" })]),
				]),
			)),
		]);
	}

	function unmanagedRow(u) {
		const id = el("input", { class: "cfg-input", value: u.label && /^[a-z0-9][a-z0-9-]{0,39}$/.test(u.label) ? u.label : "", placeholder: "host-id", "aria-label": "Tên máy trong cụm" });
		const b = button("Đưa vào cụm", { icon: "plus" });
		b.addEventListener("click", () => busy(b, async () => {
			await api("/api/hosts/adopt", { method: "POST", body: { hostId: id.value, registrationId: u.registrationId } });
			toast(`Đã thêm ${id.value} vào cụm`);
			await loadHosts();
		}));
		return el("div", { class: "card row-card" }, [dot(TONE[u.status] ?? "warn"), el("div", { class: "grow" }, [el("strong", { text: u.label ?? "(không nhãn)" }), el("span", { class: "muted", text: ` ${u.target ?? ""}` })]), id, b]);
	}

	// --- dialogs ---------------------------------------------------------------
	function dialog(title, sub, body, foot) {
		const d = el("dialog", { class: "modal" });
		const close = () => {
			d.close();
			d.remove();
		};
		d.appendChild(el("div", { class: "modal-panel" }, [
			el("div", { class: "modal-head" }, [el("div", {}, [el("h2", { text: title }), sub ? el("p", { class: "modal-sub", text: sub }) : null]), button("", { icon: "x", cls: "close", title: "Đóng", onclick: close })]),
			el("div", { class: "modal-body" }, body),
			el("div", { class: "modal-foot" }, foot(close)),
		]));
		d.addEventListener("cancel", (e) => {
			e.preventDefault();
			close();
		});
		document.body.appendChild(d);
		d.showModal();
		return { d, close };
	}

	function confirmDialog(title, text, action, work) {
		dialog(title, null, [el("p", { text })], (close) => {
			const go = button(action, { cls: "danger" });
			go.addEventListener("click", () => busy(go, async () => {
				await work();
				close();
			}));
			return [el("span", { class: "spacer" }), button("Huỷ", { onclick: close }), go];
		});
	}

	function openConnectionDialog(host) {
		const conn = el("input", { type: "password", class: "cfg-input", placeholder: "tcp://host:port?password=…", autocomplete: "off" });
		dialog(`Đổi kết nối · ${host.hostId}`, "Daemon giữ kết nối mới; nó không được ghi vào file cụm.", [el("label", { class: "modal-field" }, [el("span", { text: "Kết nối" }), conn])], (close) => {
			const save = button("Lưu", { cls: "primary" });
			save.addEventListener("click", () => busy(save, async () => {
				await api("/api/hosts/set-connection", { method: "POST", body: { hostId: host.hostId, connection: conn.value } });
				toast("Đã cập nhật kết nối");
				close();
				await loadHosts();
			}));
			return [el("span", { class: "spacer" }), button("Huỷ", { onclick: close }), save];
		});
		conn.focus();
	}

	function openAddDialog() {
		const id = el("input", { class: "cfg-input", placeholder: "vd: mac-review", autocomplete: "off", name: "host-id" });
		const conn = el("input", { class: "cfg-input", type: "password", placeholder: "tcp://10.0.0.5:6767?password=…", autocomplete: "off", name: "connection" });
		const caps = CAPABILITIES.map(([c, label]) => {
			const box = el("input", { type: "checkbox", value: c });
			if (c === "git-read" || c === "focused-test") box.checked = true;
			return { c, box, node: el("label", { class: "cap-toggle" }, [box, el("span", {}, [el("b", { text: label }), el("code", { text: c })])]) };
		});
		const writers = el("input", { class: "cfg-input", type: "number", min: "0", value: "0" });
		const readers = el("input", { class: "cfg-input", type: "number", min: "0", value: "2" });
		const required = el("input", { type: "checkbox" });
		const copyFrom = el("select", { class: "cfg-input" }, [el("option", { value: "", text: "Route của máy này" }), ...(state.hosts?.hosts ?? []).map((h) => el("option", { value: h.hostId, text: h.hostId }))]);
		const out = el("div", { class: "dialog-out" });
		const presets = el("div", { class: "segmented presets-row" });
		for (const [label, set, w, r] of [
			["Máy review", ["git-read", "focused-test", "independent-review"], 0, 2],
			["Máy viết code", ["git-read", "git-write", "focused-test"], 1, 2],
			["Máy chạy test", ["git-read", "focused-test", "integration-test", "docker"], 0, 3],
		]) {
			const b = button(label, {
				onclick: () => {
					for (const x of caps) x.box.checked = set.includes(x.c);
					writers.value = String(w);
					readers.value = String(r);
					for (const other of presets.children) other.classList.toggle("active", other === b);
				},
			});
			presets.appendChild(b);
		}
		const body = (dryRun) => ({
			hostId: id.value.trim(),
			connection: conn.value,
			capabilities: caps.filter((x) => x.box.checked).map((x) => x.c),
			writers: Number(writers.value),
			readers: Number(readers.value),
			required: required.checked,
			...(copyFrom.value ? { copyRoutesFrom: copyFrom.value } : {}),
			dryRun,
		});
		dialog("Thêm máy", "Kết nối (kể cả mật khẩu) do daemon Paseo giữ — không ghi vào file cụm, không nằm trong lệnh được hiển thị.", [
			el("div", { class: "modal-grid" }, [
				el("label", { class: "modal-field" }, [el("span", { text: "Tên máy (host-id)" }), id]),
				el("label", { class: "modal-field" }, [el("span", { text: "Kết nối" }), conn]),
			]),
			el("div", { class: "modal-field" }, [el("span", { text: "Máy này dùng để" }), presets]),
			el("div", { class: "cap-grid" }, caps.map((x) => x.node)),
			el("div", { class: "modal-grid three" }, [
				el("label", { class: "modal-field" }, [el("span", { text: "Writer tối đa" }), writers]),
				el("label", { class: "modal-field" }, [el("span", { text: "Reader tối đa" }), readers]),
				el("label", { class: "modal-field" }, [el("span", { text: "Sao chép route từ" }), copyFrom]),
			]),
			el("label", { class: "cfg-bool" }, [required, el("span", { text: "Bắt buộc — strict preflight thất bại nếu máy mất" })]),
			out,
		], (close) => {
			const preview = button("Xem trước");
			const add = button("Thêm máy", { cls: "primary", icon: "plus" });
			const run = (dryRun, b) => busy(b, async () => {
				const r = await api("/api/hosts/add", { method: "POST", body: body(dryRun) });
				if (dryRun) {
					clear(out).append(el("p", { class: "muted", text: "Xem trước — chưa ghi gì:" }), pre(JSON.stringify(r.host, null, 2)));
					return;
				}
				close();
				toast(`Đã thêm ${r.hostId}${r.online ? " — online" : " — chưa online, bấm Đồng bộ khi máy lên"}`);
				await loadHosts();
			});
			preview.addEventListener("click", () => run(true, preview));
			add.addEventListener("click", () => run(false, add));
			return [button("Huỷ", { onclick: close }), el("span", { class: "spacer" }), preview, add];
		});
		id.focus();
	}

	// ============================================================ FLOW PAGE
	function paintPlanner() {
		const root = clear($("flow-planner"));
		const cls = el("select", { class: "cfg-input", "aria-label": "Lớp mô hình" }, CLASSES.map((c) => el("option", { value: c, text: c })));
		const kind = el("div", { class: "segmented", role: "group", "aria-label": "Loại việc" });
		let kindValue = "";
		for (const [value, label] of KINDS) {
			const b = button(label, {
				onclick: () => {
					kindValue = value;
					for (const x of kind.children) x.classList.toggle("active", x === b);
				},
			});
			if (value === "") b.classList.add("active");
			kind.appendChild(b);
		}
		const avoid = el("select", { class: "cfg-input", "aria-label": "Tránh máy" }, [el("option", { value: "", text: "Không tránh máy nào" }), ...(state.hosts?.hosts ?? []).map((h) => el("option", { value: h.hostId, text: `Tránh ${h.hostId}` }))]);
		const project = el("input", { class: "cfg-input", placeholder: "Project (vd: demo)", "aria-label": "Project" });
		const out = el("div", { class: "planner-out" });
		const go = button("Chọn máy", { cls: "primary", icon: "play" });
		go.addEventListener("click", () => busy(go, async () => {
			const q = new URLSearchParams({ class: cls.value });
			if (kindValue) q.set("kind", kindValue);
			if (avoid.value) q.set("avoidHost", avoid.value);
			if (project.value.trim()) q.set("project", project.value.trim());
			clear(out).appendChild(skeleton(4));
			let plan;
			try {
				plan = await api(`/api/dispatch/plan?${q}`);
			} catch (error) {
				plan = error?.payload?.data;
				if (!plan?.candidates) {
					clear(out);
					throw error;
				}
			}
			state.plan = plan;
			clear(out).appendChild(renderPlan(plan));
		}));
		root.append(
			el("div", { class: "card-head" }, [el("div", {}, [el("h2", { text: "Task này nên chạy ở đâu?" }), el("p", { class: "muted", text: "Năng lực → độc lập → route → kết nối → model có trên máy đó → còn chỗ. Máy trượt bước nào sẽ được nói rõ; không tự đổi máy." })])]),
			el("div", { class: "planner-form" }, [cls, kind, avoid, project, go]),
			out,
		);
	}

	function renderPlan(plan) {
		const box = el("div", { class: "plan" });
		if (plan.chosen) {
			const c = plan.chosen;
			const mech = c.mechanism === "mcp" ? "MCP · máy này" : c.mechanism === "mcp-serverId" ? "MCP + serverId" : "remote-paseo";
			box.appendChild(el("div", { class: "verdict ok" }, [
				el("div", { class: "verdict-host" }, [el("span", { class: "muted", text: "Chọn máy" }), el("b", { text: c.hostId })]),
				el("div", { class: "verdict-meta" }, [chip(mech, "info"), el("code", { text: `${c.provider} @ ${c.thinking}` }), c.option ? chip(`lựa chọn #${c.option}`) : null]),
			]));
			if (c.workspaceNote) box.appendChild(el("div", { class: "callout warn" }, [el("span", { text: c.workspaceNote })]));
			const panes = [
				c.createAgent ? ["mcp", "create_agent", JSON.stringify(c.createAgent, null, 2)] : null,
				c.remoteCli ? ["cli", "Qua CLI", c.remoteCli] : null,
				["decision", "ROUTING_DECISION", c.routingDecision],
			].filter(Boolean);
			if (!panes.some(([key]) => key === state.planTab)) state.planTab = panes[0][0];
			const tabs = el("div", { class: "code-tabs", role: "tablist" });
			const view = el("div", { class: "code-view" });
			const show = (key) => {
				state.planTab = key;
				for (const t of tabs.children) t.classList.toggle("active", t.dataset.key === key);
				const [, , text] = panes.find(([k]) => k === key);
				clear(view).append(button("Sao chép", { icon: "copy", cls: "copy-btn", onclick: () => copy(text) }), pre(text));
			};
			for (const [key, label] of panes) {
				const t = button(label, { onclick: () => show(key) });
				t.dataset.key = key;
				tabs.appendChild(t);
			}
			box.append(tabs, view);
			show(state.planTab);
		} else {
			box.appendChild(el("div", { class: "verdict no" }, [el("div", { class: "verdict-host" }, [el("span", { class: "muted", text: "Không máy nào đạt" }), el("b", { text: "—" })]), el("p", { text: plan.blocked ?? "" })]));
		}
		const table = el("div", { class: "pipeline", role: "table", "aria-label": "Từng máy qua từng bước" });
		table.appendChild(el("div", { class: "pipe-row head", role: "row" }, [el("span", { text: "Máy" }), ...STEPS.map((s) => el("span", { class: "pipe-step-h", text: STEP_LABEL[s] })), el("span", { text: "Kết luận" })]));
		const ranking = new Map((plan.ranking ?? []).map((r, i) => [r.hostId, i]));
		const sorted = [...(plan.candidates ?? [])].sort((a, b) => (ranking.get(a.hostId) ?? 99) - (ranking.get(b.hostId) ?? 99));
		for (const cand of sorted) {
			const byStep = new Map();
			for (const s of cand.steps) {
				const key = s.step.startsWith("inventory") ? "inventory" : s.step;
				if (!byStep.has(key) || !s.ok) byStep.set(key, s);
			}
			const fail = cand.steps.find((s) => !s.ok);
			const chosen = plan.chosen?.hostId === cand.hostId;
			const free = plan.ranking?.find((r) => r.hostId === cand.hostId)?.free;
			table.appendChild(el("div", { class: `pipe-row ${chosen ? "chosen" : ""} ${cand.eligible ? "eligible" : "out"}`, role: "row" }, [
				el("b", { text: cand.hostId }),
				...STEPS.map((step) => {
					const s = byStep.get(step);
					const cls = !s ? "skip" : s.ok ? "pass" : "fail";
					return el("span", { class: `pipe-step ${cls}`, title: s?.detail ?? (step === "independence" ? "không áp dụng" : "chưa tới bước này") }, [el("i", { text: !s ? "" : s.ok ? "✓" : "✗" })]);
				}),
				el("span", { class: "pipe-why", text: chosen ? "Được chọn" : cand.eligible ? `Đạt · còn ${free ?? "?"} chỗ` : fail?.detail ?? "" }),
			]));
		}
		box.append(el("h3", { class: "section-title", text: "Từng máy" }), table);
		return box;
	}

	async function loadFlow() {
		const root = $("flow-live");
		if (!root.dataset.loaded) clear(root).appendChild(el("div", { class: "lanes" }, [1, 2, 3].map(() => el("div", { class: "lane" }, [skeleton(6)]))));
		let flow;
		try {
			flow = await api("/api/flow");
		} catch (error) {
			clear(root).appendChild(el("div", { class: "callout no" }, [el("span", { text: `Không đọc được luồng: ${cliMessage(error) ?? error?.message ?? error}` })]));
			return;
		}
		root.dataset.loaded = "1";
		clear(root);
		const totalRunning = (flow.hosts ?? []).reduce((n, h) => n + (h.running ?? 0), 0);
		root.appendChild(el("div", { class: "live-head" }, [
			el("h2", {}, [dot("ok", true), el("span", { text: "Đang diễn ra" })]),
			el("span", { class: "muted", text: `${totalRunning} agent đang chạy · cập nhật ${new Date(flow.generatedAt).toLocaleTimeString()} · tự làm mới 5 giây/lần` }),
		]));

		const jobs = Object.entries(flow.jobs ?? {}).filter(([, j]) => !Array.isArray(j));
		if (jobs.length > 0) {
			root.append(el("h3", { class: "section-title", text: "Theo công việc" }), el("div", { class: "job-grid" }, jobs.map(([id, job]) =>
				el("article", { class: "card job-card" }, [
					el("header", { class: "job-head" }, [el("h3", { text: job.label ?? id }), chip(job.run === "sequential" ? "tuần tự" : "song song", "info"), job.active ? null : chip("tắt", "warn")]),
					el("ol", { class: `chain ${job.run === "sequential" ? "seq" : "par"}` }, job.executors.map((e) =>
						el("li", {}, [el("span", { class: "chain-n", text: String(e.index + 1) }), el("span", { text: e.kind === "class" ? e.modelClass : e.kind === "cli" ? `CLI · ${e.tool}` : (e.seats?.[0] ? `${e.seats[0].paseoProvider}/${e.seats[0].model}` : "route") })]),
					)),
					job.seated.length
						? el("div", { class: "job-seated" }, job.seated.map((s) => agentCard({ ...s, hostLabel: s.hostId })))
						: el("p", { class: "muted small", text: "Chưa có agent mang nhãn team.job này." }),
				]),
			)));
		}

		const lanes = el("div", { class: "lanes" });
		for (const host of flow.hosts ?? []) {
			const agents = host.agents ?? [];
			const running = agents.filter((a) => a.status === "running");
			const idle = agents.filter((a) => a.status === "idle");
			const lane = el("section", { class: `lane ${host.observable ? "" : "blind"}` }, [
				el("header", { class: "lane-head" }, [
					dot(host.error ? "no" : host.observable ? "ok" : "warn"),
					el("b", { text: host.hostId }),
					el("span", { class: "muted small", text: host.type === "local" ? "máy này" : "remote" }),
					el("span", { class: `lane-count ${running.length ? "busy" : ""}`, title: "Đang chạy", text: String(running.length) }),
				]),
				host.limits && host.observable ? meter("Đang chạy / reader", running.length, host.limits.readers) : null,
			]);
			if (!host.observable) lane.appendChild(el("p", { class: "lane-empty", text: "Không quan sát được từ đây — đặt biến endpoint của máy này để xem agent." }));
			if (host.error) lane.appendChild(el("div", { class: "callout no" }, [el("span", { text: host.error })]));
			for (const a of running) lane.appendChild(agentCard(a));
			if (host.observable && running.length === 0 && !host.error) lane.appendChild(el("p", { class: "lane-empty", text: "Không có agent đang chạy" }));
			if (idle.length) {
				lane.appendChild(el("details", { class: "idle" }, [
					el("summary", { text: `${idle.length} agent rảnh` }),
					...idle.slice(0, 60).map(agentCard),
					idle.length > 60 ? el("p", { class: "muted small", text: `… và ${idle.length - 60} nữa` }) : null,
				]));
			}
			lanes.appendChild(lane);
		}
		root.append(el("h3", { class: "section-title", text: "Theo máy" }), lanes);

		const classes = Object.entries(flow.classes ?? {});
		if (classes.length > 0) {
			const hostIds = (flow.hosts ?? []).map((h) => h.hostId);
			const max = Math.max(1, ...classes.flatMap(([, c]) => Object.values(c.byHost)));
			const grid = el("div", { class: "heat", style: `grid-template-columns: minmax(150px, 1.4fr) repeat(${hostIds.length}, minmax(56px, 1fr)) 84px` });
			grid.append(el("span", {}), ...hostIds.map((h) => el("span", { class: "heat-h", text: h })), el("span", { class: "heat-h", text: "đang chạy" }));
			for (const [cls, c] of classes) {
				grid.appendChild(el("span", { class: "heat-row", text: cls }));
				for (const h of hostIds) {
					const n = c.byHost[h] ?? 0;
					grid.appendChild(el("span", { class: `heat-cell ${n ? "" : "zero"}`, style: `--a:${n ? (0.18 + 0.7 * (n / max)).toFixed(2) : 0}`, title: `${cls} trên ${h}: ${n}`, text: n ? String(n) : "·" }));
				}
				grid.appendChild(el("span", { class: `heat-run ${c.running ? "busy" : ""}`, text: String(c.running) }));
			}
			root.append(el("h3", { class: "section-title", text: "Lớp mô hình × máy" }), el("div", { class: "card heat-card" }, [grid]));
		}
	}

	function agentCard(a) {
		const running = a.status === "running";
		return el("div", { class: `agent-card ${a.status}` }, [
			el("div", { class: "agent-top" }, [dot(running ? "warn" : a.status === "idle" ? "ok" : "off", running), el("b", { text: a.name ?? a.id }), a.hostLabel ? el("span", { class: "muted small", text: `@${a.hostLabel}` }) : null]),
			a.modelClass || a.job ? el("div", { class: "agent-tags" }, [a.modelClass ? chip(a.modelClass) : null, a.job ? chip(`job ${a.job}`, "info") : null]) : null,
			el("code", { class: "agent-provider", text: a.provider ?? "" }),
		]);
	}

	async function loadRuntimes() {
		const root = clear($("flow-runtimes"));
		root.appendChild(skeleton(3));
		let data;
		try {
			data = await api("/api/runtimes");
		} catch (error) {
			clear(root).appendChild(el("div", { class: "callout no" }, [el("span", { text: cliMessage(error) ?? String(error?.message ?? error) })]));
			return;
		}
		clear(root).append(el("div", { class: "card-head" }, [el("div", {}, [el("h2", { text: "Công cụ (runtime) dùng được" }), el("p", { class: "muted", text: "Gán runtime cho task ở Cấu hình → Định tuyến mô hình (lớp, hoặc “Tool/model khác của lớp này”) hoặc Cấu hình → Công việc." })])]));
		const grid = el("div", { class: "runtime-grid" });
		for (const r of data.runtimes ?? []) {
			const missing = r.providers.filter((p) => !r.configured.includes(p));
			const action = r.enforcement !== "full" && missing.length > 0 ? button("Đăng ký provider", { icon: "plus" }) : null;
			action?.addEventListener("click", () => busy(action, async () => {
				const res = await api("/api/runtimes/apply", { method: "POST", body: { family: r.family } });
				toast(`Đã ghi ${res.created.join(", ") || "không có gì mới"} — chạy 'paseo daemon restart' để daemon nạp lại`);
				await loadRuntimes();
			}));
			grid.appendChild(el("div", { class: "runtime" }, [
				el("div", { class: "runtime-head" }, [el("b", { text: r.label }), chip(r.cliVersion ? "đã cài" : "chưa cài", r.cliVersion ? "ok" : "warn")]),
				el("p", { class: "small muted", text: r.enforcement === "full" ? "Policy đầy đủ, kiểm từng lượt — mang được mọi vai." : "Policy tĩnh từ permission của chính runtime — chỉ làm Peer." }),
				el("div", { class: "agent-tags" }, r.roles.map((role) => chip(role))),
				el("code", { class: "small muted", text: r.configured.join(", ") || "chưa có provider" }),
				action,
			]));
		}
		root.appendChild(grid);
	}

	function stopFlow() {
		if (state.flowTimer) clearInterval(state.flowTimer);
		state.flowTimer = null;
	}

	return {
		async hosts() {
			stopFlow();
			await loadHosts();
		},
		async flow() {
			stopFlow();
			if (!state.hosts) {
				try {
					state.hosts = await api("/api/hosts?live=0");
				} catch {}
			}
			paintPlanner();
			await Promise.all([loadFlow(), loadRuntimes()]);
			state.flowTimer = setInterval(() => {
				if (document.visibilityState === "visible" && $("tab-flow")?.classList.contains("active")) loadFlow();
				else stopFlow();
			}, 5000);
		},
		/** Home tile + nav badge, without the live probe. */
		async summary() {
			try {
				const data = await api("/api/hosts?live=0");
				if (!state.hosts) state.hosts = data;
				paintSummary(data);
			} catch {}
		},
		sync: async (b) =>
			busy(b, async () => {
				const r = await api("/api/hosts/sync", { method: "POST", body: {} });
				toast(r.changes.length ? `Đã đồng bộ ${r.changes.length} serverId` : "Không có gì cần đồng bộ");
				await loadHosts();
			}),
		refresh: () => loadHosts(),
		add: () => openAddDialog(),
		stopFlow,
	};
}
