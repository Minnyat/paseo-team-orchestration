/**
 * fleet.js — the "Máy" (hosts) and "Luồng việc" (task flow) tabs.
 *
 * Same contract as app.js: every value on screen comes from a `paseo-team`
 * answer (hosts list / dispatch plan / flow / runtimes), nothing is computed
 * that the CLI did not send, and everything is inserted with textContent.
 * The two tabs exist so that managing machines and following how a task was
 * split never needs a terminal:
 *
 *   Máy        every host: cluster file + Paseo registry + live state, the
 *              problems with their fix, and the verbs (add, sync, check,
 *              remove, adopt) — a connection string goes to the CLI on stdin.
 *   Luồng việc where a task SHOULD run (dispatch plan: each host's steps,
 *              the exact create_agent to copy) and what IS running where,
 *              per job and per model class, refreshed while the tab is open.
 *
 * app.js passes its helpers in; this module owns no token and no fetch.
 */

const CAPABILITIES = ["git-read", "git-write", "focused-test", "independent-review", "integration-test", "docker"];
const CLASSES = ["CODING_MEDIUM", "REASONING_HIGH", "REVIEW_HIGH", "FAST_READ", "MONITOR_ECONOMY", "SUPERVISOR_GOVERNANCE", "LEAD_RECOVERY"];
const KIND_LABEL = { writer: "Viết code (writer)", reviewer: "Review độc lập", reader: "Chỉ đọc" };
const PROBLEM_LABEL = {
	NOT_IN_REGISTRY: "Chưa đăng ký với daemon (Lead không seat qua MCP được)",
	NO_SERVER_ID: "Chưa có serverId — gate sẽ từ chối create_agent { serverId }",
	SERVER_ID_MISMATCH: "serverId trong file khác với daemon",
	OFFLINE: "Daemon không online",
	REGISTRY_DISABLED: "Bị tắt trong registry",
	ENDPOINT_ENV_UNSET: "Thiếu biến môi trường endpoint (chỉ ảnh hưởng remote-paseo/preflight)",
};
const STATUS_TONE = { online: "ok", local: "ok", reachable: "ok", connecting: "warn", failed: "no", offline: "no", unreachable: "no", unknown: "warn" };

export function mountFleet({ api: rawApi, el, clear, toast, toastError: rawToastError, $ }) {
	const state = { hosts: null, flowTimer: null, lastAdd: null };
	// The server wraps the CLI's JSON in `data`, on success AND on a non-zero
	// exit; the CLI's own sentence (`data.message`) is what the reader needs.
	const api = async (path, options) => (await rawApi(path, options)).data;
	const cliMessage = (error) => error?.payload?.data?.message ?? error?.payload?.data?.blocked ?? null;
	const toastError = (error) => {
		const message = cliMessage(error);
		if (message) toast(`${error?.payload?.data?.code ?? "Lỗi"}: ${message}`, true);
		else rawToastError(error);
	};

	const chip = (text, tone = "") => el("span", { class: `chip ${tone}`.trim(), text });
	const pre = (text) => el("pre", { class: "cmd", text });
	const copyButton = (text, label = "Sao chép") =>
		el("button", {
			type: "button",
			text: label,
			onclick: async () => {
				try {
					await navigator.clipboard.writeText(text);
					toast("Đã sao chép");
				} catch {
					toast("Trình duyệt không cho sao chép — chọn và copy tay", true);
				}
			},
		});
	const field = (label, input, hint) =>
		el("label", { class: "cfg-field" }, [el("span", { class: "cfg-label", text: label }), input, hint ? el("span", { class: "cfg-hint", text: hint }) : null]);
	const busy = async (button, work) => {
		button.disabled = true;
		try {
			return await work();
		} catch (error) {
			toastError(error);
			return null;
		} finally {
			button.disabled = false;
		}
	};

	// ---------------------------------------------------------------- hosts
	async function loadHosts({ fresh = false } = {}) {
		const root = clear($("fleet-hosts"));
		root.appendChild(el("p", { class: "hint", text: "Đang hỏi daemon từng máy…" }));
		let data;
		try {
			void fresh;
			data = await api("/api/hosts");
		} catch (error) {
			clear(root).appendChild(el("div", { class: "error-block" }, [el("strong", { text: "Không đọc được danh sách máy" }), el("p", { text: cliMessage(error) ?? String(error?.message ?? error) })]));
			return;
		}
		state.hosts = data;
		clear(root);
		if (!data.clusterExists) {
			root.appendChild(el("div", { class: "notice" }, [
				el("strong", { text: "Chưa có cụm nhiều máy." }),
				el("p", { text: "Thêm máy đầu tiên ở form bên dưới — file cụm sẽ được tạo từ route của máy này." }),
			]));
		}
		if (data.registryProblem) root.appendChild(el("p", { class: "cfg-warn", text: `Không đọc được registry của daemon: ${data.registryProblem}` }));
		const grid = el("div", { class: "grid fleet-grid" });
		for (const host of data.hosts ?? []) grid.appendChild(hostCard(host));
		root.appendChild(grid);
		if ((data.unmanaged ?? []).length > 0) {
			root.appendChild(el("h3", { text: "Đã kết nối nhưng chưa thuộc cụm" }));
			for (const u of data.unmanaged) root.appendChild(unmanagedRow(u));
		}
		paintAddForm(data);
	}

	function hostCard(host) {
		const tone = STATUS_TONE[host.status] ?? "warn";
		const head = el("div", { class: "fleet-head" }, [
			el("strong", { text: host.hostId }),
			chip(host.type === "local" ? "máy này" : "remote"),
			chip(host.status ?? "?", tone),
			host.required ? chip("bắt buộc") : null,
		]);
		const facts = el("div", { class: "facts" }, [
			el("div", {}, [el("span", { class: "k", text: "Làm được: " }), host.roles?.writer ? chip("viết code", "ok") : null, host.roles?.reviewer ? chip("review", "ok") : null, ...(host.capabilities ?? []).map((c) => chip(c))]),
			el("div", {}, [el("span", { class: "k", text: "Giới hạn: " }), el("span", { text: `${host.limits?.writers ?? "?"} writer · ${host.limits?.readers ?? "?"} reader` })]),
			host.agents ? el("div", {}, [el("span", { class: "k", text: "Agent: " }), el("span", { text: `${host.agents.running} đang chạy · ${host.agents.idle} rảnh · ${host.agents.total} tổng` })]) : null,
			el("div", { class: "tech" }, [el("span", { class: "k", text: "serverId: " }), el("code", { text: host.serverId ?? "—" })]),
			host.registry?.target ? el("div", { class: "tech" }, [el("span", { class: "k", text: "Kết nối: " }), el("code", { text: host.registry.target })]) : null,
		]);
		const routes = el("details", {}, [
			el("summary", { text: `Route (${host.routes?.length ?? 0} lớp)` }),
			el("table", {}, (host.routes ?? []).map((r) =>
				el("tr", {}, [el("th", { text: r.modelClass }), el("td", { text: `${r.paseoProvider}/${r.model} @ ${r.thinking}${r.alternates ? ` (+${r.alternates})` : ""}${r.enabled ? "" : " — TẮT"}` })]),
			)),
		]);
		const problems = (host.problems ?? []).map((p) =>
			el("div", { class: "cfg-warn" }, [el("span", { text: `⚠ ${PROBLEM_LABEL[p.code] ?? p.code}${p.detail ? ` — ${p.detail}` : ""}` }), p.fix ? el("code", { class: "tech", text: ` ${p.fix}` }) : null]),
		);
		const out = el("div", { class: "fleet-out" });
		const checkBtn = el("button", { type: "button", text: "Kiểm tra" });
		checkBtn.addEventListener("click", () => busy(checkBtn, async () => {
			clear(out).appendChild(el("p", { class: "hint", text: "Đang chạy preflight cho máy này (có thể mất một phút)…" }));
			const r = await api(`/api/hosts/check?id=${encodeURIComponent(host.hostId)}`);
			clear(out).appendChild(el("div", {}, [
				chip(`kết luận: ${r.verdict}`, r.verdict === "pass" ? "ok" : r.verdict === "warn" ? "warn" : "no"),
				...r.checks.map((c) => el("div", { class: "check" }, [chip(c.status ?? c.level, (c.status ?? c.level) === "pass" ? "ok" : (c.status ?? c.level) === "warn" ? "warn" : "no"), el("span", { class: "tech", text: ` ${c.id ?? c.name}: ${c.detail ?? ""}` })])),
			]));
		}));
		const actions = el("div", { class: "toolbar" }, [checkBtn]);
		if (host.type !== "local") {
			const conn = el("input", { class: "cfg-input", type: "password", placeholder: "kết nối mới (tcp://…?password=…)", autocomplete: "off" });
			const setBtn = el("button", { type: "button", text: "Đổi kết nối" });
			setBtn.addEventListener("click", () => busy(setBtn, async () => {
				await api("/api/hosts/set-connection", { method: "POST", body: { hostId: host.hostId, connection: conn.value } });
				conn.value = "";
				toast("Đã cập nhật kết nối (daemon giữ nó, không ghi vào file)");
				await loadHosts({ fresh: true });
			}));
			const rmBtn = el("button", { type: "button", class: "danger", text: "Gỡ khỏi cụm" });
			rmBtn.addEventListener("click", () => busy(rmBtn, async () => {
				if (!window.confirm(`Gỡ ${host.hostId} khỏi file cụm và registry của daemon? Agent đang chạy trên máy đó không bị dừng.`)) return;
				await api("/api/hosts/remove", { method: "POST", body: { hostId: host.hostId } });
				toast(`Đã gỡ ${host.hostId}`);
				await loadHosts({ fresh: true });
			}));
			actions.append(conn, setBtn, rmBtn);
		}
		return el("div", { class: `card fleet-card tone-${tone}` }, [head, facts, ...problems, routes, actions, out]);
	}

	function unmanagedRow(u) {
		const id = el("input", { class: "cfg-input", value: u.label && /^[a-z0-9][a-z0-9-]{0,39}$/.test(u.label) ? u.label : "", placeholder: "host-id" });
		const btn = el("button", { type: "button", text: "Đưa vào cụm" });
		btn.addEventListener("click", () => busy(btn, async () => {
			await api("/api/hosts/adopt", { method: "POST", body: { hostId: id.value, registrationId: u.registrationId } });
			toast(`Đã thêm ${id.value} vào cụm`);
			await loadHosts({ fresh: true });
		}));
		return el("div", { class: "card" }, [el("span", { text: `${u.label ?? "(không nhãn)"} · ${u.status ?? "?"} · ${u.target ?? ""} ` }), id, btn]);
	}

	function paintAddForm(data) {
		const root = clear($("fleet-add"));
		const id = el("input", { class: "cfg-input", placeholder: "vd: mac-review", autocomplete: "off" });
		const conn = el("input", { class: "cfg-input", type: "password", placeholder: "tcp://10.0.0.5:6767?password=…  hoặc pairing URL", autocomplete: "off" });
		const caps = CAPABILITIES.map((c) => {
			const box = el("input", { type: "checkbox", value: c });
			if (c === "git-read" || c === "focused-test") box.checked = true;
			return { c, box };
		});
		const writers = el("input", { class: "cfg-input", type: "number", min: "0", value: "0" });
		const readers = el("input", { class: "cfg-input", type: "number", min: "0", value: "2" });
		const required = el("input", { type: "checkbox" });
		const copyFrom = el("select", { class: "cfg-input" }, [el("option", { value: "", text: "route của máy này" }), ...(data.hosts ?? []).map((h) => el("option", { value: h.hostId, text: h.hostId }))]);
		const out = el("div", { class: "fleet-out" });
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
		const show = (r, dryRun) =>
			clear(out).appendChild(el("div", {}, [
				el("p", { text: dryRun ? "Xem trước — chưa ghi gì:" : `Đã thêm ${r.hostId}${r.online ? " (online)" : " — chưa online, bấm Đồng bộ khi máy lên"}.` }),
				pre(JSON.stringify(r.host, null, 2)),
				el("p", { class: "hint", text: "Bước tiếp:" }),
				...(r.next ?? []).map((line) => pre(line)),
			]));
		// The list re-renders this form after a real add; keep what it said.
		if (state.lastAdd) show(state.lastAdd.r, state.lastAdd.dryRun);
		const run = (dryRun, btn) => busy(btn, async () => {
			const r = await api("/api/hosts/add", { method: "POST", body: body(dryRun) });
			state.lastAdd = { r, dryRun };
			show(r, dryRun);
			if (!dryRun) {
				conn.value = "";
				await loadHosts({ fresh: true });
			}
		});
		const preview = el("button", { type: "button", text: "Xem trước" });
		preview.addEventListener("click", () => run(true, preview));
		const add = el("button", { type: "button", class: "primary", text: "Thêm máy" });
		add.addEventListener("click", () => run(false, add));
		root.append(
			el("h3", { text: "Thêm máy" }),
			el("p", { class: "hint", text: "Kết nối (kể cả mật khẩu) được giao cho daemon Paseo giữ — không ghi vào file cụm, không nằm trong lệnh được hiển thị." }),
			el("div", { class: "modal-grid" }, [
				field("Tên máy (host-id)", id),
				field("Kết nối", conn, "host:port, tcp://host:port?password=…, hoặc pairing URL"),
				field("Writer tối đa", writers),
				field("Reader tối đa", readers),
				field("Sao chép route từ", copyFrom, "Sửa lại sau ở Cấu hình → Cụm nhiều máy"),
				field("Bắt buộc (strict preflight fail nếu mất)", required),
			]),
			el("div", { class: "cfg-flags" }, caps.map(({ c, box }) => el("label", { class: "cfg-flag" }, [box, el("span", { text: ` ${c}` })]))),
			el("div", { class: "toolbar" }, [preview, add]),
			out,
		);
	}

	// ------------------------------------------------------------ dispatch
	function paintPlanner() {
		const root = clear($("flow-planner"));
		const cls = el("select", { class: "cfg-input" }, CLASSES.map((c) => el("option", { value: c, text: c })));
		const kind = el("select", { class: "cfg-input" }, [el("option", { value: "", text: "theo lớp (mặc định)" }), ...Object.entries(KIND_LABEL).map(([k, v]) => el("option", { value: k, text: v }))]);
		const avoid = el("select", { class: "cfg-input" }, [el("option", { value: "", text: "—" }), ...(state.hosts?.hosts ?? []).map((h) => el("option", { value: h.hostId, text: h.hostId }))]);
		const project = el("input", { class: "cfg-input", placeholder: "tên project (vd: demo)" });
		const out = el("div", { class: "fleet-out" });
		const go = el("button", { type: "button", class: "primary", text: "Chọn máy" });
		go.addEventListener("click", () => busy(go, async () => {
			const q = new URLSearchParams({ class: cls.value });
			if (kind.value) q.set("kind", kind.value);
			if (avoid.value) q.set("avoidHost", avoid.value);
			if (project.value.trim()) q.set("project", project.value.trim());
			let plan;
			try {
				plan = await api(`/api/dispatch/plan?${q}`);
			} catch (error) {
				plan = error?.payload?.data;
				if (!plan?.candidates) throw error;
			}
			clear(out).appendChild(renderPlan(plan));
		}));
		root.append(
			el("h3", { text: "Task này nên chạy ở đâu?" }),
			el("p", { class: "hint", text: "Lọc theo năng lực máy → còn sống → route hợp lệ trên chính inventory của máy đó → còn chỗ. Không tự đổi máy: máy nào trượt bước nào sẽ được ghi rõ." }),
			el("div", { class: "modal-grid" }, [field("Lớp mô hình", cls), field("Loại việc", kind), field("Tránh máy (máy của writer)", avoid), field("Project", project)]),
			el("div", { class: "toolbar" }, [go]),
			out,
		);
	}

	function renderPlan(plan) {
		const box = el("div");
		if (plan.chosen) {
			const c = plan.chosen;
			box.append(
				el("div", { class: "notice" }, [
					el("strong", { text: `→ ${c.hostId}` }),
					chip(c.mechanism === "mcp" ? "MCP (máy này)" : c.mechanism === "mcp-serverId" ? "MCP + serverId" : "remote-paseo"),
					el("span", { text: ` ${c.provider} @ ${c.thinking}` }),
				]),
			);
			// Element.append(null) writes the text "null": add only what exists.
			if (c.workspaceNote) box.append(el("p", { class: "cfg-warn", text: c.workspaceNote }));
			if (c.createAgent) {
				const text = JSON.stringify(c.createAgent, null, 2);
				box.append(el("div", { class: "toolbar" }, [el("strong", { text: "create_agent" }), copyButton(text)]), pre(text));
			}
			if (c.remoteCli) box.append(el("div", { class: "toolbar" }, [el("strong", { text: "hoặc qua CLI" }), copyButton(c.remoteCli)]), pre(c.remoteCli));
			box.append(el("details", {}, [el("summary", { text: "ROUTING_DECISION (điền sẵn)" }), copyButton(c.routingDecision), pre(c.routingDecision)]));
		} else box.append(el("p", { class: "cfg-warn", text: plan.blocked ?? "Không máy nào đạt." }));
		const table = el("table", { class: "fleet-steps" });
		for (const cand of plan.candidates ?? []) {
			table.appendChild(el("tr", {}, [
				el("th", { text: cand.hostId }),
				el("td", {}, cand.steps.map((s) => chip(`${s.ok ? "✓" : "✗"} ${s.step}`, s.ok ? "ok" : "no"))),
				el("td", { class: "tech", text: cand.steps.find((s) => !s.ok)?.detail ?? (cand.eligible ? "đạt" : "") }),
			]));
		}
		box.append(el("h4", { text: "Từng máy" }), table);
		return box;
	}

	// ---------------------------------------------------------------- flow
	async function loadFlow() {
		const root = $("flow-live");
		let flow;
		try {
			flow = await api("/api/flow");
		} catch (error) {
			clear(root).appendChild(el("p", { class: "cfg-warn", text: `Không đọc được luồng: ${error?.message ?? error}` }));
			return;
		}
		clear(root);
		root.appendChild(el("p", { class: "hint", text: `Cập nhật ${new Date(flow.generatedAt).toLocaleTimeString()} · tự làm mới 5 giây/lần khi tab đang mở` }));

		const jobs = Object.entries(flow.jobs ?? {}).filter(([, j]) => !Array.isArray(j));
		if (jobs.length > 0) {
			root.appendChild(el("h3", { text: "Theo công việc (job)" }));
			for (const [id, job] of jobs) {
				root.appendChild(el("div", { class: "card" }, [
					el("div", { class: "fleet-head" }, [el("strong", { text: job.label ?? id }), chip(job.run === "sequential" ? "tuần tự" : "song song"), job.active ? null : chip("tắt", "warn")]),
					el("div", { class: "facts" }, job.executors.map((e) => el("div", {}, [
						chip(`#${e.index + 1}`),
						el("span", { text: ` ${e.kind === "class" ? e.modelClass : e.kind === "cli" ? `CLI ${e.tool}` : (e.seats?.[0] ? `${e.seats[0].paseoProvider}/${e.seats[0].model}` : "route")}` }),
					]))),
					job.seated.length
						? el("div", {}, job.seated.map((s) => el("div", {}, [chip(s.status, s.status === "running" ? "warn" : s.status === "idle" ? "ok" : ""), el("span", { text: ` ${s.hostId} · ${s.name} · ${s.provider}` })])))
						: el("p", { class: "hint", text: "Chưa có agent nào mang nhãn team.job này." }),
				]));
			}
		}

		root.appendChild(el("h3", { text: "Theo máy" }));
		const lanes = el("div", { class: "grid fleet-grid" });
		for (const host of flow.hosts ?? []) {
			const active = (host.agents ?? []).filter((a) => a.status === "running" || a.status === "idle");
			const running = active.filter((a) => a.status === "running");
			const idle = active.filter((a) => a.status === "idle");
			const agentRow = (a) => el("div", { class: "fleet-agent" }, [chip(a.status, a.status === "running" ? "warn" : "ok"), el("span", { text: a.name }), a.modelClass ? chip(a.modelClass) : null, a.job ? chip(`job ${a.job}`) : null, el("span", { class: "tech", text: a.provider })]);
			lanes.appendChild(el("div", { class: "card" }, [
				el("div", { class: "fleet-head" }, [el("strong", { text: host.hostId }), chip(host.type === "local" ? "máy này" : "remote"), host.observable ? chip(`${host.running ?? 0} đang chạy`, host.running ? "warn" : "ok") : chip("không quan sát được (thiếu endpoint env)", "warn")]),
				host.error ? el("p", { class: "cfg-warn", text: host.error }) : null,
				...running.map(agentRow),
				idle.length
					? el("details", {}, [el("summary", { text: `${idle.length} agent đang rảnh` }), ...idle.slice(0, 60).map(agentRow), idle.length > 60 ? el("p", { class: "hint", text: `… và ${idle.length - 60} nữa` }) : null])
					: null,
				active.length === 0 && host.observable ? el("p", { class: "hint", text: "Không có agent đang chạy/rảnh." }) : null,
			]));
		}
		root.appendChild(lanes);

		const classes = Object.entries(flow.classes ?? {});
		if (classes.length > 0) {
			const hostIds = (flow.hosts ?? []).map((h) => h.hostId);
			root.appendChild(el("h3", { text: "Theo lớp mô hình × máy" }));
			root.appendChild(el("table", { class: "fleet-matrix" }, [
				el("tr", {}, [el("th", { text: "" }), ...hostIds.map((h) => el("th", { text: h })), el("th", { text: "đang chạy" })]),
				...classes.map(([cls, c]) => el("tr", {}, [el("th", { text: cls }), ...hostIds.map((h) => el("td", { text: String(c.byHost[h] ?? "") })), el("td", { text: String(c.running) })])),
			]));
		}
	}

	// ------------------------------------------------------------ runtimes
	async function loadRuntimes() {
		const root = clear($("flow-runtimes"));
		let data;
		try {
			data = await api("/api/runtimes");
		} catch (error) {
			root.appendChild(el("p", { class: "cfg-warn", text: String(error?.message ?? error) }));
			return;
		}
		root.appendChild(el("h3", { text: "Công cụ (runtime) dùng được" }));
		const table = el("table");
		table.appendChild(el("tr", {}, ["Runtime", "CLI", "Policy", "Vai", "Provider đã đăng ký", ""].map((h) => el("th", { text: h }))));
		for (const r of data.runtimes ?? []) {
			const missing = r.providers.filter((p) => !r.configured.includes(p));
			const action = r.enforcement !== "full" && missing.length > 0 ? el("button", { type: "button", text: "Đăng ký provider" }) : null;
			action?.addEventListener("click", () => busy(action, async () => {
				const res = await api("/api/runtimes/apply", { method: "POST", body: { family: r.family } });
				toast(`Đã ghi ${res.created.join(", ") || "không có gì mới"} — chạy 'paseo daemon restart' để daemon nạp lại`);
				await loadRuntimes();
			}));
			table.appendChild(el("tr", {}, [
				el("td", { text: r.label }),
				el("td", {}, [chip(r.cliVersion ? `${r.cli} ✓` : `${r.cli} chưa cài`, r.cliVersion ? "ok" : "warn")]),
				el("td", {}, [chip(r.enforcement === "full" ? "đầy đủ (theo từng turn)" : "tĩnh (permission của runtime)", r.enforcement === "full" ? "ok" : "warn")]),
				el("td", { text: r.roles.join(", ") }),
				el("td", { class: "tech", text: r.configured.join(", ") || "—" }),
				el("td", {}, [action]),
			]));
		}
		root.appendChild(table);
		root.appendChild(el("p", { class: "hint", text: "Gán một runtime cho task: Cấu hình → Định tuyến mô hình (lớp hoặc 'Tool/model khác của lớp này'), hoặc Cấu hình → Công việc (executor kind route/cli)." }));
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
		sync: async (button) =>
			busy(button, async () => {
				const r = await api("/api/hosts/sync", { method: "POST", body: {} });
				toast(r.changes.length ? `Đã đồng bộ ${r.changes.length} serverId` : "Không có gì cần đồng bộ");
				await loadHosts({ fresh: true });
			}),
		refresh: () => loadHosts({ fresh: true }),
		stopFlow,
	};
}
