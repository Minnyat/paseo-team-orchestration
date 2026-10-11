/**
 * humanize.js — turns the CLI's machine vocabulary into sentences a person who
 * has never opened a terminal can act on.
 *
 * Kept free of DOM access on purpose: this is the layer that decides what a
 * non-technical operator is told, so it must be testable without a browser
 * (see test/humanize.test.mjs). app.js imports it; nothing here imports app.js.
 *
 * The rule this file follows everywhere: never show a code without also saying
 * what to do about it. "DAEMON_NOT_RUNNING" tells the reader nothing; "Paseo
 * chưa chạy — mở terminal và gõ `paseo start`" tells them everything.
 */

export const ROLE_LABEL = Object.freeze({
	supervisor: "Giám sát",
	lead: "Trưởng nhóm",
	peer: "Thành viên",
});

export const ROLE_HINT = Object.freeze({
	supervisor: "Theo dõi chất lượng công việc, không tự viết code.",
	lead: "Nhận việc, chia việc và giao cho thành viên.",
	peer: "Người trực tiếp làm một việc cụ thể.",
});

export function roleLabel(role) {
	return ROLE_LABEL[role] ?? "Chưa rõ vai trò";
}

/**
 * What an agent IS, for a node. A role the pack knows keeps its name; anything
 * else is an honest generic. "Chưa rõ vai trò" read like a fault, and it was shown
 * for every sub-agent that Paseo runs outside the pack's role providers (a plain
 * `codex` or `claude` agent a Lead started) — which is a normal thing to have.
 */
export function agentKindLabel(node) {
	if (ROLE_LABEL[node?.role]) return ROLE_LABEL[node.role];
	return node?.parentId ? "Agent phụ" : "Agent độc lập";
}

const RUNTIME_LABEL = Object.freeze({
	claude: "Claude",
	pi: "Pi",
	codex: "Codex",
	opencode: "OpenCode",
	gemini: "Gemini",
	copilot: "Copilot",
});

/**
 * Which coding agent runs the node, whatever it is. A known runtime gets its
 * proper spelling; an unknown one is shown under its own provider name rather
 * than hidden, because a badge that only exists for two runtimes makes every
 * other sub-agent look like it has no runtime at all.
 */
export function runtimeLabel(node) {
	const raw = node?.runtime ?? node?.family ?? null;
	if (typeof raw !== "string" || raw.trim() === "") return "";
	const key = raw.trim().toLowerCase();
	return RUNTIME_LABEL[key] ?? key.charAt(0).toUpperCase() + key.slice(1);
}

/**
 * The project a node belongs to, as a name. A cluster id is often a path
 * ("d:/code/shop") or a workspace id, and the last segment is what a person calls
 * it.
 */
export function projectLabel(cluster) {
	if (typeof cluster !== "string" || cluster.trim() === "") return "";
	const trimmed = cluster.trim().replace(/[\\/]+$/, "");
	return trimmed.split(/[\\/]/).pop() || trimmed;
}

const STATUS_LABEL = Object.freeze({
	running: "Đang làm việc",
	idle: "Đang rảnh",
	error: "Gặp lỗi",
	closed: "Đã đóng",
	archived: "Đã lưu trữ",
	stopped: "Đã dừng",
	initializing: "Đang khởi động",
});

export function statusLabel(status) {
	return STATUS_LABEL[String(status ?? "").toLowerCase()] ?? String(status ?? "không rõ");
}

/**
 * Tools are grouped by what they can do to the machine, not by their name.
 * "bash" means nothing to a non-technical reader; "chạy lệnh trên máy" does.
 */
const TOOL_MEANING = [
	{ match: /^(write|edit|create|apply_patch|multi_edit)/i, risk: "high", what: "sửa hoặc tạo file trong dự án" },
	{ match: /^(bash|shell|exec|run|terminal|process)/i, risk: "high", what: "chạy lệnh trên máy này" },
	{ match: /(delete|remove|rm|archive|cancel|stop)/i, risk: "high", what: "xoá hoặc dừng thứ gì đó" },
	{ match: /(push|commit|merge|git)/i, risk: "high", what: "thay đổi lịch sử mã nguồn (git)" },
	{ match: /^(fetch|web|http|curl|browser|navigate)/i, risk: "medium", what: "truy cập mạng ra ngoài" },
	{ match: /^(mcp|send|create_agent|update_agent)/i, risk: "medium", what: "điều khiển agent khác" },
	{ match: /^(read|cat|list|ls|glob|grep|search|inspect|get)/i, risk: "low", what: "đọc thông tin, không sửa gì" },
];

export const RISK_LABEL = Object.freeze({
	high: "Ảnh hưởng lớn",
	medium: "Cần cân nhắc",
	low: "Ít rủi ro",
	unknown: "Chưa rõ mức ảnh hưởng",
});

/**
 * An unrecognized tool is "unknown", never "low": guessing low on something we
 * cannot classify is exactly how a dangerous approval slips through.
 */
export function toolMeaning(tool) {
	const name = typeof tool === "string" ? tool.trim() : "";
	if (!name) return { risk: "unknown", what: "một hành động chưa xác định được", tool: null };
	const hit = TOOL_MEANING.find((entry) => entry.match.test(name));
	return hit ? { risk: hit.risk, what: hit.what, tool: name } : { risk: "unknown", what: `dùng công cụ “${name}”`, tool: name };
}

/**
 * One sentence describing what is being asked, addressed to the person who has
 * to answer it.
 */
export function permitSentence(permit, agentName) {
	const who = agentName?.trim() ? `“${agentName.trim()}”` : "Một agent";
	const { what } = toolMeaning(permit?.tool);
	return `${who} đang xin phép để ${what}.`;
}

const DETAIL_LABEL = Object.freeze({
	command: "Lệnh",
	cmd: "Lệnh",
	file_path: "File",
	filePath: "File",
	path: "Đường dẫn",
	url: "Địa chỉ",
	pattern: "Tìm",
	query: "Tìm",
	description: "Nội dung",
	title: "Nội dung",
	summary: "Nội dung",
});

/**
 * The thing the agent actually wants to do — the command line, the file, the
 * address — pulled out of whatever the daemon attached to the request.
 *
 * "đang xin phép để chạy lệnh trên máy này" is not something a person can decide
 * on: whether `ls` or `rm -rf` follows is the whole question. The raw record used
 * to be reachable only in advanced mode, which put the one fact an approval turns
 * on behind a toggle most readers never open.
 *
 * Tolerant on purpose (Paseo does not document the shape): the first string found
 * under the usual keys wins, and nothing found returns null so the card says so
 * rather than inventing a summary.
 */
export function permitDetail(permit, max = 400) {
	const raw = permit?.raw;
	if (!raw || typeof raw !== "object") return null;
	const clip = (text) => (text.length > max ? `${text.slice(0, max)}…` : text);
	for (const scope of [raw.input, raw.rawInput, raw.arguments, raw.args, raw]) {
		if (typeof scope === "string" && scope.trim() !== "") return { label: "Nội dung", text: clip(scope.trim()) };
		if (!scope || typeof scope !== "object") continue;
		for (const key of Object.keys(DETAIL_LABEL)) {
			const value = scope[key];
			if (typeof value === "string" && value.trim() !== "") {
				return { label: DETAIL_LABEL[key], text: clip(value.trim()) };
			}
		}
	}
	return null;
}

const ERROR_ADVICE = [
	// First: the message names a file path and the words "write"/"modified", and
	// nothing below should get the chance to explain it as something else.
	{
		match: /CONFIG_CHANGED/,
		title: "File cấu hình đã bị sửa ở nơi khác",
		advice: "Có chương trình khác (thường là chính Pi) vừa ghi vào file này, nên lần lưu này bị chặn để không đè mất thay đổi đó. Bấm “Tải lại”, làm lại chỉnh sửa của bạn rồi Lưu.",
	},
	// The model-endpoint codes come FIRST: their text contains words like
	// "unreachable" and "connect" that the Paseo rule below would swallow,
	// and telling someone to start Paseo when their model endpoint is down
	// sends them to fix the wrong machine.
	{
		match: /ENDPOINT_UNREACHABLE|ENDPOINT_LIST_FAILED/,
		title: "Không gọi được tới điểm cuối",
		advice: "Kiểm tra địa chỉ endpoint và khoá API của điểm cuối này. Các điểm cuối khác vẫn được cập nhật bình thường.",
	},
	{
		match: /ENDPOINT_LIST_EMPTY|ENDPOINT_LIST_UNREADABLE/,
		title: "Điểm cuối không trả về model nào",
		advice: "Địa chỉ có thể thiếu /v1 ở cuối, hoặc khoá API không có quyền xem danh sách model.",
	},
	{
		match: /ALL_MODELS_DEAD/,
		title: "Không model nào còn trả lời",
		advice: "Danh sách cũ được giữ nguyên, không bị xoá. Thử lại sau, hoặc kiểm tra khoá API.",
	},
	{
		match: /API_KEY_MISSING/,
		title: "Chưa tìm thấy khoá API",
		advice: "Tạo file chứa khoá mà điểm cuối này trỏ tới, với nội dung dạng TÊN_BIẾN=khoá.",
	},
	{
		match: /daemon|econnrefused|not running|unreachable|connect/i,
		title: "Chưa kết nối được với Paseo",
		advice: "Paseo có thể chưa chạy. Mở cửa sổ dòng lệnh và gõ: paseo start",
	},
	{
		match: /timed out|timeout|etimedout/i,
		title: "Máy phản hồi quá chậm",
		advice: "Thử lại sau vài giây. Nếu lặp lại, khởi động lại Paseo: paseo restart",
	},
	{
		match: /unauthorized|token/i,
		title: "Phiên làm việc đã hết hạn",
		advice: "Mở lại đường dẫn có #token=… mà lệnh 'paseo-team web' vừa in ra trong cửa sổ dòng lệnh.",
	},
	{
		match: /prompt not installed|run 'paseo-team install'|no SKILL\.md/i,
		title: "Bộ vai trò chưa được cài",
		advice: "Chạy lệnh cài đặt một lần: npm run paseo-team -- install",
	},
	{
		match: /invalid JSON|not json/i,
		title: "Nội dung nhập vào chưa đúng định dạng",
		advice: "Kiểm tra lại phần vừa sửa — thiếu dấu phẩy hoặc dấu ngoặc là lỗi hay gặp nhất.",
	},
	{
		match: /is missing or malformed|must be one of/i,
		title: "Thông tin gửi lên chưa hợp lệ",
		advice: "Tải lại trang rồi thử lại. Nếu vẫn vậy, đây là lỗi của ứng dụng chứ không phải của bạn.",
	},
];

/**
 * @param {object} payload the server's error envelope
 * @returns {{title: string, advice: string, technical: string}}
 */
export function humanizeError(payload) {
	const technical = [payload?.command, payload?.stderr, payload?.message, payload?.code]
		.filter((part) => typeof part === "string" && part.trim() !== "")
		.join(" · ")
		.slice(0, 600);
	// The server refused a routing/cluster write before it reached the file. The
	// validator's sentence IS the advice (which route, which field, what form),
	// and matched against the table below its words — "connection", "must be one
	// of" — would be explained as a Paseo outage or an app bug.
	if (payload?.code === "CONFIG_INVALID") {
		return {
			title: "Chưa lưu: cấu hình không hợp lệ",
			advice: `File vẫn giữ nguyên. Sửa chỗ này rồi Lưu lại — ${payload.message ?? "xem chi tiết kỹ thuật"}`,
			technical,
		};
	}
	const hit = ERROR_ADVICE.find((entry) => entry.match.test(technical));
	if (hit) return { title: hit.title, advice: hit.advice, technical };
	return {
		title: "Có lỗi xảy ra",
		advice: "Bấm “Chi tiết kỹ thuật” để xem nguyên văn, hoặc gửi phần đó cho người phụ trách.",
		technical: technical || "không có thông tin chi tiết",
	};
}

/** "12 giây trước", "3 phút trước" — a wall-clock time nobody has to subtract. */
export function relativeTime(iso, now = Date.now()) {
	const then = typeof iso === "number" ? iso : Date.parse(iso ?? "");
	if (!Number.isFinite(then)) return "không rõ";
	const seconds = Math.max(0, Math.round((now - then) / 1000));
	if (seconds < 5) return "vừa xong";
	if (seconds < 60) return `${seconds} giây trước`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes} phút trước`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours} giờ trước`;
	return `${Math.round(hours / 24)} ngày trước`;
}

/**
 * The one-line verdict on the top of the home screen. Order matters: a blocked
 * agent is more urgent than a missing config file, and both outrank "fine".
 */
export function overallHealth({ status, graph, permits } = {}) {
	if (!status) {
		return { level: "bad", headline: "Chưa đọc được tình trạng hệ thống", detail: "Kiểm tra xem Paseo đã chạy chưa." };
	}
	const pending = permits?.count ?? 0;
	if (pending > 0) {
		return {
			level: "attention",
			headline: pending === 1 ? "Có 1 việc đang chờ bạn duyệt" : `Có ${pending} việc đang chờ bạn duyệt`,
			detail: "Agent đang dừng lại chờ bạn đồng ý — xử lý sớm để công việc chạy tiếp.",
		};
	}
	if (graph && graph.ok === false) {
		return { level: "bad", headline: "Không lấy được danh sách agent", detail: "Paseo có thể chưa chạy hoặc đang bận." };
	}
	const missing = missingSetup(status);
	if (missing.length > 0) {
		return {
			level: "attention",
			headline: "Cài đặt chưa hoàn tất",
			detail: `Còn thiếu: ${missing.join(", ")}. Chạy: npm run paseo-team -- install`,
		};
	}
	const errored = graph?.nodes?.filter((node) => node.status === "error").length ?? 0;
	if (errored > 0) {
		return {
			level: "attention",
			headline: errored === 1 ? "1 agent đang gặp lỗi" : `${errored} agent đang gặp lỗi`,
			detail: "Mở tab “Nhóm agent” để xem agent nào và đang mắc ở đâu.",
		};
	}
	const running = graph?.nodes?.filter((node) => node.status === "running").length ?? 0;
	return {
		level: "good",
		headline: running > 0 ? `Mọi thứ ổn — ${running} agent đang làm việc` : "Mọi thứ ổn — không có agent nào đang chạy",
		detail: "Không có việc gì cần bạn xử lý ngay.",
	};
}

/** Which pieces of the role pack are not installed yet, in plain words. */
export function missingSetup(status) {
	const missing = [];
	if (status?.presence?.policyExtension === false) missing.push("bộ quy tắc phân quyền");
	const prompts = status?.presence?.prompts ?? {};
	const missingPrompts = Object.entries(prompts)
		.filter(([, present]) => present === false)
		.map(([role]) => roleLabel(role));
	if (missingPrompts.length > 0) missing.push(`mô tả vai trò (${missingPrompts.join(", ")})`);
	if (status?.presence?.paseoConfig === false) missing.push("cấu hình Paseo");
	return missing;
}

/**
 * Collection faults, said out loud. `degraded[]` exists so the UI never shows a
 * confident-looking picture built from partial data — that promise is only kept
 * if the wording is understandable.
 */
export function degradedSentence(degraded = [], pendingParents = 0) {
	const parts = [];
	const byReason = new Map();
	for (const fault of degraded) {
		byReason.set(fault.reason, (byReason.get(fault.reason) ?? 0) + 1);
	}
	if (byReason.has("PARENT_NOT_LISTED")) {
		parts.push(`${byReason.get("PARENT_NOT_LISTED")} agent có người giao việc nằm ngoài danh sách này (thường là đã lưu trữ)`);
	}
	const unreachable = [...byReason.entries()]
		.filter(([reason]) => reason !== "PARENT_NOT_LISTED" && reason !== "PERMIT_SHAPE_UNRECOGNIZED")
		.reduce((sum, [, count]) => sum + count, 0);
	if (unreachable > 0) parts.push(`${unreachable} mục không lấy được thông tin`);
	if (byReason.has("PERMIT_SHAPE_UNRECOGNIZED")) parts.push("có yêu cầu xin phép không đọc được nội dung");
	if (pendingParents > 0) parts.push(`đang dựng sơ đồ, còn ${pendingParents} agent chưa xếp xong`);
	return parts.length === 0 ? "" : `Lưu ý: ${parts.join("; ")}.`;
}
