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
	applySwitch,
	listSwitches,
	cleanListItems,
	clone,
	deepMerge,
	deletePath,
	dependentOptionProblems,
	dependentOptions,
	displayPath,
	fieldPath,
	fillKeptEmpty,
	getPath,
	isShown,
	listLengthProblems,
	moveAt,
	numberRangeProblems,
	optionModelOff,
	optionalEntryProblems,
	parseLines,
	pruneEmpty,
	removeAt,
	setPath,
} from "./config-form.js";
import {
	ROLE_HINT,
	agentKindLabel,
	compactTokens,
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

// --- language ----------------------------------------------------------------

const LANG_KEY = "paseo-team-lang";
const STRINGS = {
	vi: {
		skipToContent: "Đến nội dung chính", brandCaption: "Không gian điều phối", navAria: "Điều hướng chính",
		navHome: "Trang chủ", navGraph: "Nhóm agent", navPermits: "Chờ duyệt", navRoles: "Vai trò", navConfig: "Cấu hình",
		advancedTitle: "Chế độ nâng cao hiện thêm phần chỉnh cấu hình và mô tả vai trò", advanced: "Chế độ nâng cao",
		homeTitle: "Tổng quan", homeSub: "Nắm tình hình nhóm. Tập trung vào việc cần bạn quyết định.", workspaceLabel: "Paseo / Không gian làm việc",
		statRunning: "Đang làm việc", statRunningTitle: "Agent đang thực sự chạy ngay lúc này. Bấm để xem.", statRunningCaption: "Agent đang thực hiện công việc",
		statErrors: "Gặp lỗi", statErrorsTitle: "Agent dừng giữa chừng, cần xem lại. Bấm để xem.", statErrorsCaption: "Cần kiểm tra và xử lý",
		statTotal: "Tổng số agent", statTotalTitle: "Gồm cả agent đang rảnh. Bấm để xem.", statTotalCaption: "Xem toàn bộ nhóm agent",
		guideTitle: "Điều phối, không cần theo sát từng bước.", guideSub: "Xem ai đang làm gì trong nhóm và phản hồi khi agent cần quyền thực hiện hành động.",
		guideGraph: "Xem nhóm agent", guidePermits: "Kiểm tra yêu cầu chờ duyệt", setupTitle: "Tình trạng cài đặt", checking: "Đang kiểm tra…",
		preflightTitle: "Kiểm tra kỹ thuật (preflight)", preflightRun: "Chạy kiểm tra", preflightMeta: "Mất khoảng 30 giây vì phải hỏi từng nhà cung cấp mô hình.", preflightIdle: "Chưa chạy lần nào.",
		graphTitle: "Nhóm agent", graphSub: "Theo dõi phân công, tiến độ và mối liên hệ trong nhóm.", viewTypeAria: "Kiểu hiển thị",
		viewDiagram: "Sơ đồ", viewList: "Danh sách", refresh: "Cập nhật", graphShowArchived: "Hiện cả agent đã lưu trữ", project: "Dự án", all: "tất cả", domain: "Phạm vi quản (domain)",
		agentDetailAria: "Chi tiết agent", graphAria: "Sơ đồ ai giao việc cho ai", close: "Đóng",
		permitsTitle: "Yêu cầu chờ duyệt", permitsSub: "Bạn quyết định hành động nào được tiếp tục. Kiểm tra nội dung trước khi cấp quyền.",
		permitsMeta: "Mỗi thẻ là một agent đang dừng lại chờ bạn trả lời.", loading: "Đang tải…",
		permitsFootnote: "Đây là quyền cho một hành động cụ thể, ngay lúc này. Quyền chung của từng vai trò nằm ở tab “Vai trò”.",
		rolesTitle: "Vai trò & trách nhiệm", rolesSub: "Định nghĩa cách mỗi agent làm việc và phối hợp với nhóm.", roleSelectAria: "Chọn vai trò",
		roleSupervisor: "Giám sát", roleLead: "Trưởng nhóm", rolePeer: "Thành viên", reload: "Tải lại", save: "Lưu", roleEditorAria: "Mô tả vai trò", envCardTitle: "Quyền chung của vai trò (chỉ xem)",
		configTitle: "Cấu hình không gian làm việc", configSub: "Quản lý mô hình, công cụ và cách công việc được phân phối.",
		configWarn: "Phần này sửa trực tiếp file cấu hình. Mỗi lần lưu đều tạo bản sao lưu kèm thời gian, nhưng nếu không chắc thì đừng sửa.",
		sectionSelectAria: "Chọn nhóm cấu hình", secPiSettings: "Pi — cấu hình chính", secMcp: "Pi — công cụ MCP", secProviders: "Paseo — nhà cung cấp",
		secRouting: "Định tuyến mô hình", secCluster: "Nhiều máy (cluster)", secPiModels: "Kho model Pi", secSeats: "Ghế tuỳ biến", secJobs: "Công việc",
		editModeAria: "Kiểu chỉnh", rawJson: "JSON thô", seatsApplyTitle: "Sinh provider Paseo từ danh sách ghế đã lưu", seatsApply: "Áp dụng ghế",
		catalogAria: "Model đang dùng", configEditorAria: "Nội dung cấu hình",
		modelId: "Model ID", displayName: "Tên hiển thị", contextWindow: "Cửa sổ ngữ cảnh", maxTokens: "Token đầu ra tối đa",
		reasoning: "Suy luận", inputModalities: "Đầu vào", discovery: "Nguồn model",
		modalHint: "Các lựa chọn “Tự động” bỏ ghi đè và quay về mặc định.", removeOverride: "Xoá cấu hình này", cancel: "Hủy", apply: "Áp dụng",
		defaultPrefix: "mặc định: ", on: "Bật", off: "Tắt", choiceAuto: "Tự động — bỏ ghi đè", choiceExisting: "Giá trị cũ: {v}",
		saveButton: "Lưu", saveDirty: "Lưu thay đổi",
		catalogHeading: "Model đang dùng",
		catalogHint: "models.json → bản đã lưu. Ghi đè → Lưu → Đồng bộ. Giới hạn: override > models.dev > chưa biết. Có tên trong danh sách không đồng nghĩa model đang hoạt động.",
		catalogMissing: "Chưa có kho model. Cấu hình điểm cuối, lưu rồi chọn Cập nhật danh sách model.",
		catalogInvalid: "Không đọc được kho model. Kiểm tra models.json rồi bấm Tải lại; đây không phải danh sách rỗng.",
		catalogEmptyHint: "Kho hiện chưa có model nào. Chọn Cập nhật danh sách model để nhận model từ các điểm cuối đã lưu.",
		catalogCount: "{n} model · {p} provider", catalogProvider: "{provider} · {n} model",
		configure: "Cấu hình", goPiSettings: "Model mặc định, thinking & công cụ Pi",
		catalogNeedProvider: "Thêm và lưu điểm cuối tương ứng trước khi cấu hình model.",
		modalNewTitle: "Thêm cấu hình model", modalEditTitle: "Chỉnh model",
		modalSubExisting: "{provider} / {id} — đang ghi đè", modalSubNew: "{provider} — model mới",
		modalApplied: "Đã áp dụng cấu hình cho {id}.", modalRemoved: "Đã bỏ ghi đè cho {id}.", modalIdTaken: "Model ID này đã có cấu hình.",
		errIdEmpty: "Model ID không được trống", errIdWhitespace: "{id}: Model ID không được chứa khoảng trắng",
		errNumber: "{id}: {field} cần số nguyên dương an toàn", errExceed: "{id}: Output không được vượt context window",
		errBoolean: "{id}: {field} cần true/false", errInput: "{id}: input chỉ nhận text, image (text bắt buộc)",
		errName: "{id}: name cần chuỗi đã cắt khoảng trắng thừa", errHighlighted: "Sửa ô đánh dấu lỗi", notSavedPrefix: "Chưa lưu: ",
		confirmSyncDirty: "Có thay đổi chưa lưu. Thao tác này chỉ đọc cấu hình trên đĩa, không áp dụng phần đang sửa. Tiếp tục?",
		confirmDiscard: "Bạn đã sửa mục này nhưng chưa lưu. Bỏ các thay đổi đó?",
		metaInvalid: "{path} — file này đang HỎNG, không đọc được JSON ({message}). Sửa trong ô dưới rồi Lưu; bản hỏng được sao lưu.",
		metaNew: "{path} (chưa tồn tại — lưu sẽ tạo mới)",
		syncDone: "Đã cập nhật xong", syncPartial: "Có điểm cuối không cập nhật được", warningsLabel: "Cảnh báo", warnCount: " — {n} cảnh báo",
		refreshDone: "Paseo đã đọc lại danh sách model.", cannotRun: "Không chạy được", limitsLegend: "context window · max output · nguồn", busyFallback: "Đang chạy…",
		ovEmpty: "Chưa có model nào được cấu hình. Bấm “Thêm cấu hình model” hoặc chọn một model trong danh sách ở trên.",
		ovAdd: "+ Thêm cấu hình model", ovEdit: "Sửa", ovRemove: "Xoá",
		ovBadgeManual: "thủ công", ovBadgeReasoning: "reasoning", ovBadgeNoReasoning: "không reasoning", ovBadgeCtx: "ctx", ovBadgeOut: "out",
		seatsDirty: "Còn thay đổi chưa lưu. Bấm Lưu trước rồi mới Áp dụng.", jsonInvalid: "JSON chưa hợp lệ, chưa chuyển về form được: {message}",
		currentHeading: "Đang dùng (models.json)", currentNone: "Chưa có dữ liệu của model này trong models.json — chạy “Cập nhật danh sách model” để lấy.",
		yes: "Có", no: "Không", unknownVal: "không rõ", chipImage: "ảnh",
		pickModel: "Chọn model có sẵn", pickManual: "— Nhập ID thủ công —",
		quickLockCluster: "File cluster {path} có một host local nên cổng đọc file đó, không đọc file này. Công tắc ở đây sẽ sửa nhầm file không ai đọc. Dùng: pteam routing disable <CLASS> (hoặc sửa ở mục Nhiều máy).",
		quickLockInvalid: "File cluster {path} đang lỗi nên cổng từ chối mọi lần dựng agent cho tới khi sửa xong. Công tắc tạm khoá.",
		quickGoJobs: "Bật/tắt công cụ & công việc →", quickGoRouting: "Tắt model hết tiền (Định tuyến mô hình) →",
		quickTitle: "Công tắc nhanh", quickRouting: "Tắt một lớp việc = cổng từ chối mọi lần dựng agent theo lớp đó, không tự đổi sang model khác. Có hiệu lực ở lần dựng agent kế tiếp, không cần chạy lại Paseo; agent đang chạy giữ nguyên model.",
		quickJobs: "Tắt công việc/bước = Lead không thấy nó trong pteam jobs list; bước bị tắt bị bỏ qua chứ không được thay bằng bước khác. Có hiệu lực ngay, không cần chạy lại Paseo.",
		quickGroupModels: "Model (hết tiền hoặc lỗi → tắt ở đây)", quickModelsHint: "Tắt một model = mọi lớp việc và mọi bước trong công việc dùng model đó bị từ chối/bỏ qua ngay, không tự đổi sang model khác. “pi/Minnyat/*” tắt cả endpoint, “pi/*” tắt cả công cụ pi. Agent đang chạy trên model đó vẫn chạy tiếp và sẽ lỗi — hãy dựng agent thay thế.", quickGroupRoutes: "Lớp việc → model", quickGroupJobs: "Công việc & bước", quickGroupTools: "Công cụ CLI",
		quickOn: "Đã bật {what}. Có hiệu lực ngay, không cần chạy lại Paseo.", quickOff: "Đã tắt {what}. Có hiệu lực ngay, không cần chạy lại Paseo.",
		quickDiscard: "Bạn đang sửa dở mục này. Công tắc ghi file như đang có trên đĩa và bỏ các chỉnh sửa chưa lưu. Tiếp tục?",
		quickNoFile: "Chưa có file để bật/tắt. Lưu cấu hình trước.", switchLabel: "Bật/tắt {what}",
		modalConfigTitle: "Cấu hình model", modalSubDefault: "{provider} / {id} — chưa ghi đè, đang dùng giá trị hiện tại",
		choiceAutoCurrent: "Tự động · {v}", supported: "Có", notSupported: "Không", textOnly: "Văn bản", textImage: "Văn bản + ảnh",
		includeManual: "Thêm thủ công", includeListed: "Chỉ khi endpoint liệt kê", noChange: "Chưa có thay đổi nào để áp dụng.",
		formMode: "Form", moreOptions: "Tuỳ chọn nâng cao ({n})", moreOptionsSet: "Tuỳ chọn nâng cao ({n}, {set} đã đặt)",
		wholeNumber: "Nhập số nguyên hợp lệ", optionalSuffix: "(tuỳ chọn)", removeEntry: "Xoá mục “{key}”", removeLine: "Bỏ dòng này",
		optionColumn: "Lựa chọn", optionMain: "chính", addOption: "+ Thêm tool/model", removeOption: "Bỏ lựa chọn #{n}",
		configureOptional: "+ Cấu hình {key} (tuỳ chọn)", optionIncomplete: "Có lựa chọn chưa đủ", routeUnset: "Chưa cấu hình", routeOff: "Đang tắt", optionsMore: "+{n} lựa chọn", optionsOnOf: "{on}/{total} đang bật", otherGroup: "Khác",
		keyLabelFallback: "Khóa", keyTaken: "Đã có mục tên “{key}” rồi.",
		saved: "Đã lưu. Bản cũ được sao lưu kèm thời gian.", jsonBad: "Nội dung chưa đúng định dạng JSON: {message}",
		presetFilled: "Đã điền sẵn: {label}. Xem lại rồi bấm Lưu.",
		seatsNotApplied: "Không áp dụng được: {errors}", seatsNothing: "Không có gì thay đổi.",
		seatsCreated: "tạo {list}", seatsUpdated: "cập nhật {list}", seatsRemoved: "gỡ {list}", seatsSkipped: "bỏ qua (đã có sẵn, không phải do công cụ tạo): {list}",
		needValidForm: "Chuyển về Form hợp lệ trước khi cấu hình model.", metaMissingTail: " (chưa tồn tại — lưu sẽ tạo mới)",
		ctxTitle: "Cửa sổ ngữ cảnh: {n} token", outTitle: "Token đầu ra tối đa: {n} token",
	},
	en: {
		skipToContent: "Skip to main content", brandCaption: "Orchestration workspace", navAria: "Main navigation",
		navHome: "Home", navGraph: "Agent team", navPermits: "Pending approvals", navRoles: "Roles", navConfig: "Settings",
		advancedTitle: "Advanced mode reveals configuration editors and role prompts", advanced: "Advanced mode",
		homeTitle: "Overview", homeSub: "Stay on top of the team. Focus on what needs your decision.", workspaceLabel: "Paseo / Workspace",
		statRunning: "Working", statRunningTitle: "Agents actually running right now. Click to view.", statRunningCaption: "Agents doing work",
		statErrors: "Failed", statErrorsTitle: "Agents stopped mid-task; worth a look. Click to view.", statErrorsCaption: "Needs attention",
		statTotal: "Total agents", statTotalTitle: "Includes idle agents. Click to view.", statTotalCaption: "View the whole team",
		guideTitle: "Orchestrate; no step-by-step babysitting.", guideSub: "See who is doing what and respond when an agent needs permission to act.",
		guideGraph: "View the agent team", guidePermits: "Review pending approvals", setupTitle: "Setup status", checking: "Checking…",
		preflightTitle: "Technical check (preflight)", preflightRun: "Run check", preflightMeta: "Takes about 30 seconds: every model provider is probed.", preflightIdle: "Not run yet.",
		graphTitle: "Agent team", graphSub: "Track assignments, progress and relationships across the team.", viewTypeAria: "View type",
		viewDiagram: "Diagram", viewList: "List", refresh: "Refresh", graphShowArchived: "Show archived agents", project: "Project", all: "all", domain: "Domain",
		agentDetailAria: "Agent details", graphAria: "Diagram of who assigns work to whom", close: "Close",
		permitsTitle: "Pending approvals", permitsSub: "You decide which actions may proceed. Review before granting.",
		permitsMeta: "Each card is an agent waiting for your answer.", loading: "Loading…",
		permitsFootnote: "This grants one specific action, right now. Role-wide permissions live in the Roles tab.",
		rolesTitle: "Roles & responsibilities", rolesSub: "Define how each agent works and collaborates.", roleSelectAria: "Choose a role",
		roleSupervisor: "Supervisor", roleLead: "Lead", rolePeer: "Peer", reload: "Reload", save: "Save", roleEditorAria: "Role prompt", envCardTitle: "Role permissions (read-only)",
		configTitle: "Workspace settings", configSub: "Manage models, tools and how work is distributed.",
		configWarn: "This edits config files directly. Every save creates a timestamped backup, but if unsure, don't edit.",
		sectionSelectAria: "Choose a section", secPiSettings: "Pi — main settings", secMcp: "Pi — MCP tools", secProviders: "Paseo — providers",
		secRouting: "Model routing", secCluster: "Multi-machine (cluster)", secPiModels: "Pi model catalog", secSeats: "Custom seats", secJobs: "Jobs",
		editModeAria: "Edit mode", rawJson: "Raw JSON", seatsApplyTitle: "Generate Paseo providers from saved seats", seatsApply: "Apply seats",
		catalogAria: "Active models", configEditorAria: "Config content",
		modelId: "Model ID", displayName: "Display name", contextWindow: "Context window", maxTokens: "Max output tokens",
		reasoning: "Reasoning", inputModalities: "Input modalities", discovery: "Discovery",
		modalHint: "“Auto” clears the override and restores defaults.", removeOverride: "Remove this override", cancel: "Cancel", apply: "Apply",
		defaultPrefix: "default: ", on: "On", off: "Off", choiceAuto: "Auto — clear override", choiceExisting: "Existing value: {v}",
		saveButton: "Save", saveDirty: "Save changes",
		catalogHeading: "Active models",
		catalogHint: "models.json → saved snapshot. Override → Save → Sync. Limits: override > models.dev > unknown. Being listed does not mean a model is currently working.",
		catalogMissing: "No model catalog yet. Configure a provider, save, then run “Sync model list”.",
		catalogInvalid: "Cannot read the model catalog. Check models.json and reload; this is not an empty list.",
		catalogEmptyHint: "The catalog has no models yet. Run “Sync model list” to pull models from saved providers.",
		catalogCount: "Models: {n} · Providers: {p}", catalogProvider: "{provider} · {n} model(s)",
		configure: "Configure", goPiSettings: "Default model, thinking & Pi tools",
		catalogNeedProvider: "Add and save the matching provider before configuring a model.",
		modalNewTitle: "Add model override", modalEditTitle: "Edit model",
		modalSubExisting: "{provider} / {id} — override active", modalSubNew: "{provider} — new model",
		modalApplied: "Applied configuration for {id}.", modalRemoved: "Cleared override for {id}.", modalIdTaken: "This model ID already has an override.",
		errIdEmpty: "Model ID must not be empty", errIdWhitespace: "{id}: Model ID must not contain whitespace",
		errNumber: "{id}: {field} requires a safe positive integer", errExceed: "{id}: output must not exceed the context window",
		errBoolean: "{id}: {field} must be true/false", errInput: "{id}: input allows text and optionally image",
		errName: "{id}: name must be a trimmed non-empty string", errHighlighted: "Fix the highlighted fields", notSavedPrefix: "Not saved: ",
		confirmSyncDirty: "You have unsaved changes. This action only reads the saved file and will not apply your edits. Continue?",
		confirmDiscard: "You edited this section without saving. Discard those changes?",
		metaInvalid: "{path} — this file is BROKEN (invalid JSON: {message}). Fix it below and Save; the broken copy is backed up.",
		metaNew: "{path} (does not exist yet — saving creates it)",
		syncDone: "Sync finished", syncPartial: "Some providers failed to update", warningsLabel: "Warnings", warnCount: " — {n} warnings",
		refreshDone: "Paseo reloaded the model list.", cannotRun: "Could not run", limitsLegend: "context window · max output · source", busyFallback: "Running…",
		ovEmpty: "No model overrides yet. Use “Add model override” or pick a model from the list above.",
		ovAdd: "+ Add model override", ovEdit: "Edit", ovRemove: "Remove",
		ovBadgeManual: "manual", ovBadgeReasoning: "reasoning", ovBadgeNoReasoning: "no reasoning", ovBadgeCtx: "ctx", ovBadgeOut: "out",
		seatsDirty: "You have unsaved changes. Save first, then Apply.", jsonInvalid: "Invalid JSON; cannot switch to form: {message}",
		currentHeading: "Current (models.json)", currentNone: "No data for this model in models.json yet — run “Sync model list” to fetch it.",
		yes: "Yes", no: "No", unknownVal: "unknown", chipImage: "image",
		pickModel: "Pick an existing model", pickManual: "— Type an ID manually —",
		quickLockCluster: "The cluster file {path} has a local host, so the gate reads THAT file, not this one. A switch here would edit a file nobody reads. Use: pteam routing disable <CLASS> (or edit the Multi-machine section).",
		quickLockInvalid: "The cluster file {path} is invalid, so the gate refuses every seating until it is fixed. Switches are locked meanwhile.",
		quickGoJobs: "Switch tools & jobs →", quickGoRouting: "Switch off a model that ran out of credit (Model routing) →",
		quickTitle: "Quick switches", quickRouting: "Switching a class off makes the gate refuse every seating of that class — nothing is rerouted to another model. Live from the next create_agent, no Paseo restart; running agents keep their model.",
		quickJobs: "A switched-off job or step is hidden from pteam jobs list for the Lead; a skipped step is never replaced by another. Live at once, no Paseo restart.",
		quickGroupModels: "Models (out of credit or failing → switch off here)", quickModelsHint: "Switching a model off refuses/skips every class and job step that uses it at once; nothing is moved to another model. “pi/Minnyat/*” switches off a whole endpoint, “pi/*” a whole tool. Agents already running on that model keep running and will fail — seat a replacement.", quickGroupRoutes: "Class → model", quickGroupJobs: "Jobs & steps", quickGroupTools: "CLI tools",
		quickOn: "{what} switched on. Live now — no Paseo restart needed.", quickOff: "{what} switched off. Live now — no Paseo restart needed.",
		quickDiscard: "You have unsaved edits in this section. A switch writes the file as it is on disk and drops them. Continue?",
		quickNoFile: "No file to switch yet. Save the configuration first.", switchLabel: "Toggle {what}",
		modalConfigTitle: "Configure model", modalSubDefault: "{provider} / {id} — no override yet, using current values",
		choiceAutoCurrent: "Auto · {v}", supported: "Supported", notSupported: "Not supported", textOnly: "Text", textImage: "Text + image",
		includeManual: "Include manually", includeListed: "Listed only", noChange: "No changes to apply yet.",
		formMode: "Form", moreOptions: "Advanced options ({n})", moreOptionsSet: "Advanced options ({n}, {set} set)",
		wholeNumber: "Enter a valid whole number", optionalSuffix: "(optional)", removeEntry: "Remove “{key}”", removeLine: "Remove this line",
		optionColumn: "Option", optionMain: "main", addOption: "+ Add tool/model", removeOption: "Remove option #{n}",
		configureOptional: "+ Configure {key} (optional)", optionIncomplete: "An option is incomplete", routeUnset: "Not configured", routeOff: "Off", optionsMore: "+{n} more", optionsOnOf: "{on}/{total} on", otherGroup: "Other",
		keyLabelFallback: "Key", keyTaken: "An entry named “{key}” already exists.",
		saved: "Saved. The previous file was backed up with a timestamp.", jsonBad: "Content is not valid JSON: {message}",
		presetFilled: "Filled in: {label}. Review, then press Save.",
		seatsNotApplied: "Could not apply: {errors}", seatsNothing: "Nothing changed.",
		seatsCreated: "created {list}", seatsUpdated: "updated {list}", seatsRemoved: "removed {list}", seatsSkipped: "skipped (already exist, not created by this tool): {list}",
		needValidForm: "Switch back to a valid Form before configuring models.", metaMissingTail: " (does not exist yet — saving creates it)",
		ctxTitle: "Context window: {n} tokens", outTitle: "Max output tokens: {n} tokens",
	},
};
let lang = localStorage.getItem(LANG_KEY) === "en" ? "en" : "vi";
let lastCatalog = null;

function t(key, params = {}) {
	const table = STRINGS[lang] ?? STRINGS.vi;
	const text = table[key] ?? STRINGS.vi[key] ?? key;
	return String(text).replace(/\{(\w+)\}/g, (_, name) => params[name] ?? "");
}

function applyStaticI18n() {
	if (document.documentElement) document.documentElement.lang = lang;
	for (const node of document.querySelectorAll("[data-i18n]")) node.textContent = t(node.dataset.i18n);
	for (const node of document.querySelectorAll("[data-i18n-title]")) node.title = t(node.dataset.i18nTitle);
	for (const node of document.querySelectorAll("[data-i18n-aria]")) node.setAttribute("aria-label", t(node.dataset.i18nAria));
}

function syncLangButtons() {
	$("lang-vi").classList.toggle("active", lang === "vi");
	$("lang-vi").setAttribute("aria-pressed", String(lang === "vi"));
	$("lang-en").classList.toggle("active", lang === "en");
	$("lang-en").setAttribute("aria-pressed", String(lang === "en"));
}

function setLang(next) {
	if (next === lang) return;
	lang = next;
	localStorage.setItem(LANG_KEY, lang);
	syncLangButtons();
	applyStaticI18n();
	syncTopbarOffset();
	// Re-render the surfaces that already hold data so they follow the switch.
	paintModelCatalog(lastCatalog);
	applyConfigMode(configState.mode);
	paintDirty();
	paintConfigMeta();
	paintQuickSwitches();
}

$("lang-vi").addEventListener("click", () => setLang("vi"));
$("lang-en").addEventListener("click", () => setLang("en"));

// --- tabs ------------------------------------------------------------------

const loaders = {};
let activeTab = "home";

/** Publish the top bar's height so the config toolbar can stick right under it, however the nav wraps. */
function syncTopbarOffset() {
	const bar = document.querySelector(".topbar");
	const style = document.documentElement?.style;
	if (bar && style?.setProperty) style.setProperty("--topbar-h", `${bar.offsetHeight ?? 0}px`);
}
window.addEventListener("resize", syncTopbarOffset);

function selectTab(name) {
	activeTab = name;
	syncTopbarOffset();
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
	/** The file's document exactly as read (null when absent or broken): what the quick switches show. */
	loaded: null,
	/** Why the routing switches must not be used right now (the gate reads another file), or null. */
	quickLock: null,
	/** Last-read file facts for the meta line, re-rendered on language switch. */
	metaInfo: null,
	mode: "form",
	// Repaint callbacks for fields whose options follow a sibling field.
	// Rebuilt from scratch on every render — a stale closure would write into
	// a detached node and leak the previous section's form.
	dependents: [],
	// Rows with a `showIf`, each with the segments of the object it lives in.
	// Kept here rather than in a data attribute: a path is an array whose map
	// keys may contain dots, and a string attribute would have to be split again.
	conditional: [],
	// What the person has opened or closed (class cards, "advanced options"),
	// keyed by where it sits in the document. A re-render reads it back, so a
	// panel stays the way they left it instead of snapping shut. Dropped when
	// another section loads.
	ui: { open: new Map() },
	// The section the form on screen belongs to: a render of the SAME section
	// keeps the scroll position, a render of another one starts at the top.
	renderedSection: null,
	pendingView: null,
};

function defaultValueLabel(field) {
	if (field.default === undefined) return "";
	const shown = field.type === "bool" ? t(field.default ? "on" : "off") : String(field.default);
	return t("defaultPrefix") + shown;
}

/** The label/hint a field shows in the active language; schemas may carry En alternates. */
function fieldLabel(field) {
	return lang === "en" && field.labelEn ? field.labelEn : field.label;
}

function fieldHint(field) {
	return lang === "en" && field.hintEn ? field.hintEn : field.hint;
}

/** A schema node's \`label\` / \`intro\` / \`hint\` in the active language (Vietnamese when no En alternate exists). */
function schemaText(node, key) {
	return (lang === "en" && node?.[`${key}En`]) || node?.[key] || "";
}

/**
 * Wrap a repaint so it only runs when the value it depends on actually
 * changed. refreshDependents fires on every keystroke anywhere in the form, and
 * rebuilding a <datalist> under an input the user is typing into closes the
 * browser's suggestion popup — the list would flicker away exactly while it was
 * being used.
 */
function whenDependencyChanges(spec, prefix, paint, node = null) {
	let last = null;
	let primed = false;
	const run = () => {
		const key = String(getPath(configState.doc, fieldPath(prefix, spec.path)) ?? "");
		if (primed && key === last) return;
		primed = true;
		last = key;
		paint();
	};
	// The node it paints into: a control that was rebuilt in place (an option row
	// removed, a card added) leaves its old repaint behind, and refreshDependents
	// drops it once that node is no longer on the page.
	run.node = node;
	return run;
}

function textInput(field, path) {
	const input = el("input", { type: "text", class: "cfg-input" });
	input.placeholder = field.default !== undefined ? String(field.default) : "";
	input.value = String(getPath(configState.doc, path) ?? "");
	if (field.trim) input.addEventListener("blur", () => {
		input.value = input.value.trim();
		if (input.value) setPath(configState.doc, path, input.value);
		else deletePath(configState.doc, path);
		paintDirty();
	});
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
		label.textContent = box.checked ? t("on") : t("off");
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
	if (field.optionsBy) configState.dependents.push(whenDependencyChanges(field.optionsBy, prefix, paint, select));
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
	if (field.optionsBy) configState.dependents.push(whenDependencyChanges(field.optionsBy, prefix, paint, wrap));
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
			el("button", { type: "button", class: "cfg-icon", text: "×", title: t("removeLine"), "aria-label": t("removeLine"), onclick: () => { row.remove(); rebuild(); } }),
		]);
		wrap.insertBefore(row, wrap.querySelector(".cfg-add"));
	};
	for (const [key, value] of Object.entries(getPath(configState.doc, path) ?? {})) addRow(key, String(value ?? ""));
	wrap.appendChild(el("button", { type: "button", class: "cfg-add", text: "+ Thêm biến", onclick: () => addRow() }));
	return wrap;
}

/**
 * What to do after a control rebuilt only its own part of the form.
 *
 * Adding a card, removing a row or renaming a key used to rebuild the WHOLE
 * form, so the list the person was working in jumped (and a section they had
 * opened shut again). A structural edit now redraws just the control it
 * belongs to; this brings everything that follows the document — showIf rows,
 * dependent dropdowns, card summaries, the Save button — up to date.
 */
function afterStructuralEdit() {
	refreshDependents();
	paintDirty();
}

/**
 * Open the class cards a refusal names. Cards start collapsed, so a Save that is
 * refused for "CODING_MEDIUM #1" would otherwise leave the empty field it is
 * talking about out of sight.
 */
function openCardsNamedIn(text) {
	const message = String(text ?? "");
	for (const node of $("config-form").querySelectorAll(".cfg-class[data-key]")) {
		if (!message.includes(node.dataset.key)) continue;
		node.open = true;
		if (node.dataset.ui) configState.ui.open.set(node.dataset.ui, true);
	}
	const first = [...$("config-form").querySelectorAll(".cfg-class[data-key]")].find((node) => node.open && message.includes(node.dataset.key));
	first?.scrollIntoView?.({ block: "nearest" });
}

/** Move the person to what they just added: scroll it into view (only if it is not) and focus its first control. */
function revealNew(node) {
	if (!node) return;
	node.scrollIntoView?.({ block: "nearest" });
	node.querySelector?.("select, input, textarea")?.focus?.();
}

/** "pi-peer" → { runtime: "pi", role: "peer" }; anything else → empty halves. */
function splitProvider(value) {
	const match = /^(.+)-(supervisor|lead|peer)$/.exec(String(value ?? ""));
	return match ? { runtime: match[1], role: match[2] } : { runtime: "", role: "" };
}

/**
 * One line that says what a class is set to, for its collapsed card: the first
 * option in full, how many others there are, and whether it is switched off.
 */
function routeSummary(route) {
	const options = [route, ...(Array.isArray(route?.alternates) ? route.alternates : [])].filter((o) => o && typeof o === "object");
	const first = options[0] ?? {};
	const { runtime, role } = splitProvider(first.paseoProvider);
	const configured = Boolean(first.paseoProvider && first.model);
	// An option counts as on only when the gate would accept it: its own switch is
	// on AND its model is not in disabledModels (the quick panel says "model OFF").
	const on = options.filter((option) => option.enabled !== false && !optionModelOff(configState.doc, option)).length;
	const tail = [runtime, first.model, first.thinking].filter(Boolean).join(" · ");
	// A collapsed card must not hide a half-filled option: Save would refuse it with
	// the field out of sight.
	const incomplete = options.slice(1).some((option) => !option.paseoProvider || !option.model);
	return { role, configured, incomplete, text: tail, extra: options.length - 1, on, total: options.length };
}

/**
 * The options of one class as a table: one line per tool/model, the class's own
 * route first and every alternate under it. Adding or removing a line redraws
 * only these lines, so the page below does not move more than one line's height
 * and the button the person just pressed stays where it was.
 */
function routeOptionsTable(cardPath, itemFields) {
	const fieldNamed = (name) => itemFields.find((field) => field.path === name);
	const columns = ["paseoProvider", "model", "thinking", "enabled"].map(fieldNamed).filter(Boolean);
	const alternates = fieldNamed("alternates");
	const alternatesPath = [...cardPath, "alternates"];
	const box = el("div", { class: "route-options" });
	const head = el("div", { class: "route-row route-head" }, [
		el("span", { class: "route-n", text: t("optionColumn") }),
		...columns.map((column) => el("span", { class: `route-cell route-col-${column.path}`, text: fieldLabel(column), title: fieldHint(column) ?? "" })),
		el("span", { class: "route-x" }),
	]);
	const rows = el("div", { class: "route-rows" });

	const optionRow = (prefix, number) => {
		const row = el("div", { class: "route-row" });
		row.dataset.option = String(number);
		row.appendChild(el("span", { class: "route-n", text: number === 0 ? t("optionMain") : `#${number}` }));
		for (const column of columns) {
			row.appendChild(
				el("div", { class: `route-cell route-col-${column.path}`, title: fieldLabel(column) }, [fieldControl(column, fieldPath(prefix, column.path), prefix, { compact: true })]),
			);
		}
		row.appendChild(
			number === 0
				? el("span", { class: "route-x" })
				: el("button", {
						type: "button",
						class: "cfg-icon route-remove",
						text: "×",
						title: t("removeOption", { n: number }),
						"aria-label": t("removeOption", { n: number }),
						onclick: () => {
							removeAt(configState.doc, alternatesPath, number - 1);
							if ((getPath(configState.doc, alternatesPath) ?? []).length === 0) deletePath(configState.doc, alternatesPath);
							paint();
							afterStructuralEdit();
						},
					}),
		);
		return row;
	};

	const paint = () => {
		clear(rows);
		const more = getPath(configState.doc, alternatesPath);
		rows.appendChild(optionRow(cardPath, 0));
		if (Array.isArray(more)) more.forEach((_, index) => rows.appendChild(optionRow([...alternatesPath, index], index + 1)));
	};
	paint();

	box.appendChild(head);
	box.appendChild(rows);
	if (alternates) {
		box.appendChild(
			el("div", { class: "route-foot" }, [
				el("button", {
					type: "button",
					class: "cfg-add route-add",
					text: schemaText(alternates, "addLabel") || t("addOption"),
					onclick: () => {
						const list = getPath(configState.doc, alternatesPath);
						const seed = clone(alternates.item?.seed ?? {});
						// Every option of a class shares its role, so start from the main
						// option's provider (the role is already right; the runtime and the
						// model are what the person is here to change).
						const provider = getPath(configState.doc, [...cardPath, "paseoProvider"]);
						if (provider) seed.paseoProvider = provider;
						if (Array.isArray(list)) list.push(seed);
						else setPath(configState.doc, alternatesPath, [seed]);
						paint();
						afterStructuralEdit();
						revealNew(rows.lastChild);
					},
				}),
				alternates.hint ? el("p", { class: "cfg-hint", text: fieldHint(alternates) }) : null,
			]),
		);
	}
	return box;
}

function mapControl(field, path) {
	const wrap = el("div", { class: "cfg-map" });
	const fixed = field.fixedKeys ?? null;
	// Keys the schema names but a document may leave out (the routing forms'
	// SUPERVISOR_GOVERNANCE / LEAD_RECOVERY). Never renamed, only configured or
	// removed — a half-filled one is caught by optionalEntryProblems at save.
	const optional = field.optionalKeys ?? [];
	const existing = () => getPath(configState.doc, path) ?? {};
	// Redraw this map only; the rest of the form stays exactly where it is.
	const repaint = () => {
		paint();
		afterStructuralEdit();
	};
	const addOptional = (key) =>
		el("button", {
			type: "button",
			class: "cfg-add",
			text: t("configureOptional", { key }),
			onclick: () => {
				setPath(configState.doc, [...path, key], clone(field.item?.seed ?? {}));
				configState.ui.open.set(`card:${displayPath([...path, key])}`, true);
				repaint();
				revealNew(wrap.querySelector(`.cfg-card[data-key="${CSS.escape(key)}"]`));
			},
		});

	// One class as a collapsible card: a line that says what it is set to, and
	// the table of its options inside. Collapsed by default, so seven classes fit
	// on a screen and an added option cannot push the rest out of view.
	const routeCard = (key, isOptional) => {
		const cardPath = [...path, key];
		const uiKey = `card:${displayPath(cardPath)}`;
		const info = field.keyInfo?.[key];
		const card = el("details", { class: "cfg-card cfg-class" });
		card.dataset.key = key;
		card.dataset.ui = uiKey;
		card.open = configState.ui.open.get(uiKey) ?? false;
		card.addEventListener("toggle", () => configState.ui.open.set(uiKey, card.open));

		const chips = el("span", { class: "cfg-class-chips" });
		const head = el("summary", { class: "cfg-card-head cfg-class-head" }, [
			el("span", { class: "cfg-card-title", text: key }),
			info ? el("span", { class: "cfg-class-info", text: schemaText(info, "label") }) : null,
			chips,
		]);
		if (isOptional) {
			head.appendChild(
				el("button", {
					type: "button",
					class: "cfg-icon",
					text: "×",
					title: "Bỏ cấu hình lớp này (luồng dùng nó sẽ bị chặn cho tới khi cấu hình lại)",
					"aria-label": "Bỏ cấu hình lớp này",
					onclick: (event) => {
						event.preventDefault(); // a button inside <summary> must not also toggle the card
						deletePath(configState.doc, cardPath);
						repaint();
					},
				}),
			);
		}
		const paintSummary = () => {
			const summary = routeSummary(getPath(configState.doc, cardPath));
			clear(chips);
			if (!summary.configured) chips.appendChild(el("span", { class: "chip warn", text: t("routeUnset") }));
			else chips.appendChild(el("span", { class: "cfg-class-now", text: summary.text }));
			if (summary.configured && summary.incomplete) chips.appendChild(el("span", { class: "chip warn", text: t("optionIncomplete") }));
			if (summary.role) chips.appendChild(el("span", { class: `chip role-${summary.role}`, text: lang === "en" ? summary.role : roleLabel(summary.role) }));
			if (summary.extra > 0) chips.appendChild(el("span", { class: "chip", text: t("optionsMore", { n: summary.extra }) }));
			if (summary.on === 0 && summary.total > 0) chips.appendChild(el("span", { class: "chip off", text: t("routeOff") }));
			else if (summary.on < summary.total) chips.appendChild(el("span", { class: "chip off", text: t("optionsOnOf", { on: summary.on, total: summary.total }) }));
			card.classList.toggle("off", summary.on === 0 && summary.total > 0);
		};
		paintSummary();
		const track = () => paintSummary();
		track.node = card;
		configState.dependents.push(track);

		card.appendChild(head);
		card.appendChild(el("div", { class: "cfg-card-body" }, [routeOptionsTable(cardPath, field.item?.fields ?? [])]));
		return card;
	};

	const cardForKey = (key, isFixed, compact = false, isOptional = false) => {
		if (field.item?.layout === "route") return routeCard(key, isOptional);
		const card = el("div", { class: "cfg-card" });
		card.dataset.key = key;
		const head = el("div", { class: "cfg-card-head" });
		if (isOptional) {
			head.appendChild(el("span", { class: "cfg-card-title", text: `${key} ${t("optionalSuffix")}` }));
			head.appendChild(
				el("button", {
					type: "button",
					class: "cfg-icon",
					text: "×",
					title: "Bỏ cấu hình lớp này (luồng dùng nó sẽ bị chặn cho tới khi cấu hình lại)",
					"aria-label": "Bỏ cấu hình lớp này",
					onclick: () => {
						deletePath(configState.doc, [...path, key]);
						repaint();
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
			const keyInput = el("input", { type: "text", class: "cfg-input cfg-card-key", placeholder: field.keyLabel ?? t("keyLabelFallback") });
			keyInput.value = key;
			keyInput.addEventListener("change", () => {
				const next = keyInput.value.trim();
				if (!next || next === key) {
					keyInput.value = key;
					return;
				}
				if (Object.hasOwn(existing(), next)) {
					toast(t("keyTaken", { key: next }), true);
					keyInput.value = key;
					return;
				}
				setPath(configState.doc, [...path, next], existing()[key]);
				deletePath(configState.doc, [...path, key]);
				repaint();
			});
			head.appendChild(keyInput);
			head.appendChild(
				el("button", {
					type: "button",
					class: "cfg-icon",
					text: "×",
					title: t("removeEntry", { key }),
					"aria-label": t("removeEntry", { key }),
					onclick: () => {
						deletePath(configState.doc, [...path, key]);
						repaint();
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

	const paint = () => {
		clear(wrap);
		const present = Object.keys(existing());
		if (fixed && field.keyGroups) {
			// Grouped by the role of the seat each class builds. A class stays in its
			// group whatever its route says, so editing a card never moves it.
			const placed = new Set();
			for (const group of field.keyGroups) {
				const members = group.keys.filter((key) => fixed.includes(key) || optional.includes(key) || present.includes(key));
				if (members.length === 0) continue;
				const section = el("section", { class: "cfg-keygroup" }, [el("h4", { class: "cfg-keygroup-title", text: schemaText(group, "label") })]);
				const cards = el("div", { class: "cfg-keygroup-cards" });
				for (const key of members) {
					placed.add(key);
					if (present.includes(key) || fixed.includes(key)) cards.appendChild(cardForKey(key, fixed.includes(key), false, optional.includes(key)));
					else cards.appendChild(addOptional(key));
				}
				section.appendChild(cards);
				wrap.appendChild(section);
			}
			const rest = present.filter((key) => !placed.has(key));
			if (rest.length > 0) {
				const cards = el("div", { class: "cfg-keygroup-cards" }, rest.map((key) => cardForKey(key, false, true, false)));
				wrap.appendChild(el("section", { class: "cfg-keygroup" }, [el("h4", { class: "cfg-keygroup-title", text: t("otherGroup") }), cards]));
			}
			return;
		}
		const keys = fixed ? [...fixed, ...present.filter((key) => !fixed.includes(key))] : present;
		keys.forEach((key, index) => wrap.appendChild(cardForKey(key, fixed?.includes(key) === true, index > 0, optional.includes(key))));
		for (const key of optional.filter((name) => !Object.hasOwn(existing(), name))) wrap.appendChild(addOptional(key));
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
						repaint();
						// A key with quotes or spaces would break a naive selector.
						const fresh = wrap.querySelector(`.cfg-card[data-key="${CSS.escape(key)}"] .cfg-card-key`);
						fresh?.scrollIntoView?.({ block: "nearest" });
						fresh?.focus();
						fresh?.select();
					},
				}),
			);
		}
	};
	paint();
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
 * Every structural change redraws this list only (each card's fields are bound
 * to their element's index, so the cards are rebuilt) — never the whole form.
 */
function listControl(field, path, _prefix, { compact: parentCompact = false } = {}) {
	const wrap = el("div", { class: "cfg-list" });
	const min = Number.isInteger(field.minItems) ? field.minItems : 0;
	const structural = (change, focusIndex = null) => () => {
		change();
		paint();
		afterStructuralEdit();
		if (focusIndex !== null) revealNew(wrap.querySelectorAll(".cfg-list-item")[focusIndex()]);
	};
	const tool = (className, text, title, disabled, change) => {
		const button = el("button", { type: "button", class: `cfg-icon ${className}`, text, title, onclick: structural(change) });
		button.disabled = disabled;
		return button;
	};
	const paint = () => {
		clear(wrap);
		const current = getPath(configState.doc, path);
		const count = Array.isArray(current) ? current.length : 0;
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
			appendFields(body, field.item?.fields, [...path, index], { compact: parentCompact || index > 0 });
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
				onclick: structural(
					() => {
						const list = getPath(configState.doc, path);
						const seed = clone(field.item?.seed ?? {});
						if (Array.isArray(list)) list.push(seed);
						else setPath(configState.doc, path, [seed]);
					},
					() => (getPath(configState.doc, path) ?? []).length - 1,
				),
			}),
		);
	};
	paint();
	return wrap;
}

function choiceControl(field, path) {
	const select = el("select", { class: "cfg-input", "aria-label": fieldLabel(field) });
	const current = getPath(configState.doc, path);
	const choices = [{ label: t("choiceAuto"), value: undefined }, ...field.choices.map((choice) => ({ label: lang === "en" && choice.labelEn ? choice.labelEn : choice.label, value: choice.value }))];
	let index = choices.findIndex(choice => JSON.stringify(choice.value) === JSON.stringify(current));
	if (index < 0) {
		choices.push({ label: t("choiceExisting", { v: JSON.stringify(current) }), value: current });
		index = choices.length - 1;
	}
	choices.forEach((choice, i) => select.appendChild(el("option", { value: String(i), text: choice.label })));
	select.value = String(index);
	select.addEventListener("change", () => {
		const choice = choices[Number(select.value)];
		if (!choice) return;
		if (choice.value === undefined) deletePath(configState.doc, path);
		else setPath(configState.doc, path, clone(choice.value));
	});
	return select;
}

function fieldControl(field, path, prefix, options = {}) {
	if (field.choices) return choiceControl(field, path);
	if (field.type === "model-overrides") return modelOverridesControl(field, path);
	if (field.type === "bool") return boolControl(field, path);
	if (field.type === "number") return numberControl(field, path);
	if (field.type === "enum") return enumControl(field, path, prefix);
	if (field.type === "role-provider") return roleProviderControl(field, path);
	if (field.type === "lines") return linesControl(field, path);
	if (field.type === "kv") return kvControl(field, path);
	if (field.type === "flags") return flagsControl(field, path, prefix);
	if (field.type === "map") return mapControl(field, path);
	if (field.type === "list") return listControl(field, path, prefix, options);
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
function appendFields(container, fields, prefix, { compact = false, scope = "" } = {}) {
	const plain = [];
	const advanced = [];
	for (const field of fields ?? []) (field.advanced ? advanced : plain).push(field);
	for (const field of plain) container.appendChild(fieldRow(field, prefix, { compact }));
	if (advanced.length === 0) return;
	// Open when something in it is already set: a collapsed section hiding a
	// non-default value is a setting nobody can see is in force.
	const set = advanced.filter((field) => getPath(configState.doc, fieldPath(prefix, field.path)) !== undefined).length;
	const more = el("details", { class: "cfg-more" });
	// Where the person left it wins over the default, in both directions.
	const uiKey = `more:${scope}:${displayPath(prefix)}`;
	more.dataset.ui = uiKey;
	more.open = configState.ui.open.get(uiKey) ?? set > 0;
	more.addEventListener("toggle", () => configState.ui.open.set(uiKey, more.open));
	more.appendChild(
		el("summary", { text: set > 0 ? t("moreOptionsSet", { n: advanced.length, set }) : t("moreOptions", { n: advanced.length }) }),
	);
	for (const field of advanced) more.appendChild(fieldRow(field, prefix, { compact }));
	container.appendChild(more);
}

function fieldRow(field, prefix, { compact = false } = {}) {
	const path = fieldPath(prefix, field.path);
	const wide = ["map", "list", "flags", "role-provider", "model-overrides"].includes(field.type);
	const row = el("div", { class: `cfg-field${wide ? " cfg-field-wide" : ""}` });
	// Label, its default and its hint all live in the FIRST column. They used
	// to be three stacked rows, which made a six-field card taller than the
	// screen and hid the control the row is actually about.
	row.appendChild(
		el("div", { class: "cfg-label" }, [
			// `compact` is every card after the first in a list of look-alike cards
			// (the five routes, each host): the same three paragraphs of hint repeated
			// five times buried the values. The text stays one hover away.
			el("label", { text: fieldLabel(field), title: compact && field.hint ? fieldHint(field) : null }),
			field.default !== undefined ? el("span", { class: "cfg-default", text: defaultValueLabel(field) }) : null,
			field.hint && field.type !== "map" && field.type !== "model-overrides" && !compact ? el("p", { class: "cfg-hint", text: fieldHint(field) }) : null,
		]),
	);
	const control = fieldControl(field, path, prefix, { compact });
	row.appendChild(control);
	if (configState.section === "pi-models" && field.type === "number") {
		const error = el("p", { class: "cfg-field-error", role: "status" });
		const validate = () => {
			const value = getPath(configState.doc, path);
			const invalid = control.validity?.badInput || (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || (field.max !== undefined && value > field.max)));
			control.setAttribute("aria-invalid", String(Boolean(invalid)));
			error.textContent = invalid ? t("wholeNumber") : "";
		};
		control.addEventListener("input", validate);
		row.appendChild(error);
		validate();
	}
	if ((field.type === "map" || field.type === "list" || field.type === "model-overrides") && field.hint && !compact) {
		row.appendChild(el("p", { class: "cfg-hint", text: fieldHint(field) }));
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
	// Rows and repaints of controls that were rebuilt in place are gone from the page.
	configState.conditional = configState.conditional.filter(({ row }) => row.isConnected !== false);
	configState.dependents = configState.dependents.filter((paint) => paint.node?.isConnected !== false);
	for (const { row, field, base } of configState.conditional) {
		row.classList.toggle("hidden", !isShown(field, configState.doc, base));
	}
	for (const paint of configState.dependents) paint();
}

/**
 * Remember where the person is in the form: the first card on screen and how far
 * below the toolbar it sits. A render rebuilds every node, so scroll position
 * alone is not enough — anything that changes the height ABOVE the form (the
 * quick-switch panel gaining a row after a save) would shift what they are
 * looking at. Anchoring to a card keeps that card where it was.
 */
function captureView() {
	if (typeof window === "undefined" || !Number.isFinite(window.scrollY)) return null;
	const view = { section: configState.section, y: window.scrollY, anchor: null };
	try {
		const floor = $("config-bar")?.getBoundingClientRect?.().bottom ?? 0;
		for (const node of $("config-form").querySelectorAll("[data-ui]")) {
			const box = node.getBoundingClientRect?.();
			if (box && box.bottom > floor + 4) {
				view.anchor = { key: node.dataset.ui, top: box.top };
				break;
			}
		}
	} catch {
		// A DOM without layout: the plain scroll position is all there is.
	}
	return view;
}

function restoreView(view) {
	if (!view || view.section !== configState.section || typeof window.scrollTo !== "function") return;
	try {
		if (view.anchor) {
			const node = [...$("config-form").querySelectorAll("[data-ui]")].find((candidate) => candidate.dataset.ui === view.anchor.key);
			const box = node?.getBoundingClientRect?.();
			if (box) {
				window.scrollBy(0, box.top - view.anchor.top);
				return;
			}
		}
		window.scrollTo(0, view.y);
	} catch {
		// Nothing to restore against.
	}
}

function renderConfigForm() {
	const schema = configState.schema;
	// Same section as the last render: keep the person where they were. A section
	// they just switched to starts at the top.
	const view = configState.pendingView ?? (configState.renderedSection === configState.section ? captureView() : null);
	configState.pendingView = null;
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
	$("config-intro").textContent = schemaText(schema, "intro");
	if (!schema) return;

	for (const preset of schema.presets ?? []) {
		$("config-presets").appendChild(
			el("div", { class: "preset-item" }, [
				el("button", {
					type: "button",
					class: "preset",
					text: schemaText(preset, "label"),
					onclick: () => {
						deepMerge(configState.doc, clone(preset.patch));
						renderConfigForm();
						toast(t("presetFilled", { label: schemaText(preset, "label") }));
					},
				}),
				preset.hint ? el("span", { class: "cfg-hint preset-hint", text: schemaText(preset, "hint") }) : null,
			]),
		);
	}

	renderConfigActions(schema);

	for (const group of schema.groups ?? []) {
		const fieldset = el("fieldset", { class: "cfg-group" });
		fieldset.dataset.ui = `group:${group.id}`;
		fieldset.appendChild(el("legend", { text: schemaText(group, "label") }));
		if (group.hint) fieldset.appendChild(el("p", { class: "cfg-hint", text: schemaText(group, "hint") }));
		appendFields(fieldset, group.fields, [], { scope: group.id });
		form.appendChild(fieldset);
	}
	refreshDependents();
	// Presets and add/remove-card buttons rebuild the form without firing an
	// input event, so the Save button's "unsaved" state is refreshed here too.
	paintDirty();
	configState.renderedSection = configState.section;
	restoreView(view);
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
// --- model overrides: compact table + modal editor --------------------------

/** Validate one override the way the save path and the CLI do, in the active language. */
function modelOverrideProblems(id, model, takenIds = []) {
	const problems = [];
	const shown = id || t("modelId");
	if (!id) problems.push(t("errIdEmpty"));
	else {
		if (/[\s\u0000-\u001f\u007f]/u.test(id)) problems.push(t("errIdWhitespace", { id }));
		if (takenIds.includes(id)) problems.push(t("modalIdTaken"));
	}
	if (model === null || typeof model !== "object" || Array.isArray(model)) return problems;
	for (const key of ["contextWindow", "maxTokens"]) {
		if (model[key] !== undefined && (!Number.isSafeInteger(model[key]) || model[key] < 1)) problems.push(t("errNumber", { id: shown, field: key }));
	}
	if (Number.isSafeInteger(model?.maxTokens) && Number.isSafeInteger(model?.contextWindow) && model.maxTokens > model.contextWindow) problems.push(t("errExceed", { id: shown }));
	for (const key of ["reasoning", "include"]) if (model[key] !== undefined && typeof model[key] !== "boolean") problems.push(t("errBoolean", { id: shown, field: key }));
	if (model.input !== undefined && (!Array.isArray(model.input) || !model.input.includes("text") || model.input.some((v) => !["text", "image"].includes(v)) || new Set(model.input).size !== model.input.length)) problems.push(t("errInput", { id: shown }));
	if (model.name !== undefined && (typeof model.name !== "string" || !model.name.trim() || model.name !== model.name.trim())) problems.push(t("errName", { id: shown }));
	return problems;
}

/** A short summary of what an override sets, as badge chips for the table row. */
function overrideBadges(model) {
	if (!model || typeof model !== "object") return [];
	const badges = [];
	if (model.name) badges.push(model.name);
	if (Number.isSafeInteger(model.contextWindow)) badges.push(`${t("ovBadgeCtx")} ${compactTokens(model.contextWindow)}`);
	if (Number.isSafeInteger(model.maxTokens)) badges.push(`${t("ovBadgeOut")} ${compactTokens(model.maxTokens)}`);
	if (model.reasoning === true) badges.push(t("ovBadgeReasoning"));
	if (model.reasoning === false) badges.push(t("ovBadgeNoReasoning"));
	if (Array.isArray(model.input)) badges.push(model.input.join("+"));
	if (model.include === true) badges.push(t("ovBadgeManual"));
	return badges;
}

function modelOverridesControl(field, path) {
	const provider = path.length >= 3 ? path[path.length - 2] : "";
	const wrap = el("div", { class: "model-ov" });
	const render = () => {
		clear(wrap);
		const models = getPath(configState.doc, path);
		const entries = Object.entries(models && typeof models === "object" ? models : {}).sort(([a], [b]) => a.localeCompare(b));
		if (entries.length === 0) wrap.appendChild(el("p", { class: "hint", text: t("ovEmpty") }));
		for (const [id, model] of entries) {
			wrap.appendChild(
				el("div", { class: "model-ov-row" }, [
					el("code", { class: "model-ov-id", text: id }),
					el("div", { class: "model-ov-badges" }, overrideBadges(model).map((badge) => el("span", { class: "chip", text: badge }))),
					el("div", { class: "model-ov-actions" }, [
						el("button", { type: "button", text: t("ovEdit"), onclick: () => openModelModal({ modelsPath: path, provider, id, isNew: false, lockId: true, current: lastCatalog?.detail?.[provider]?.[id] ?? null }) }),
						el("button", { type: "button", class: "danger", text: t("ovRemove"), onclick: () => {
							deletePath(configState.doc, [...path, id]);
							renderConfigForm();
							paintDirty();
							toast(t("modalRemoved", { id }));
						} }),
					]),
				]),
			);
		}
		wrap.appendChild(
			el("button", { type: "button", class: "model-ov-add", text: t("ovAdd"), onclick: () => openModelModal({ modelsPath: path, provider, id: "", isNew: true, lockId: false }) }),
		);
	};
	render();
	// The modal writes into the working document and rebuilds the whole form;
	// this control is rebuilt with it, so no stale-list problem exists.
	return wrap;
}

// --- model modal ---------------------------------------------------------------

const MODAL_SELECTS = [
	{ id: "mm-reasoning", key: "reasoning", options: [{ value: "", auto: true }, { value: "true" }, { value: "false" }] },
	{ id: "mm-input", key: "input", options: [{ value: "", auto: true }, { value: "text" }, { value: "text+image" }] },
	{ id: "mm-include", key: "include", options: [{ value: "", auto: true }, { value: "true" }, { value: "false" }] },
];
const modalState = { modelsPath: null, provider: "", originalId: "", isNew: false, lockId: true, initial: "" };

function groupedNumber(value) {
	return value.toLocaleString(lang === "en" ? "en-US" : "vi-VN");
}

/**
 * An empty field means "inherit", so say what it inherits: the current value
 * becomes the placeholder, and each select's Auto entry names the current choice.
 * Without it a blank box and a bare "Auto — clear override" read as "no value".
 */
function paintModalInherited(current) {
	const known = current && typeof current === "object" ? current : {};
	$("mm-name").placeholder = typeof known.name === "string" ? known.name : "";
	$("mm-context").placeholder = Number.isSafeInteger(known.contextWindow) ? String(known.contextWindow) : "";
	$("mm-max").placeholder = Number.isSafeInteger(known.maxTokens) ? String(known.maxTokens) : "";
	const shown = {
		reasoning: typeof known.reasoning === "boolean" ? t(known.reasoning ? "supported" : "notSupported") : null,
		input: Array.isArray(known.input) ? t(known.input.includes("image") ? "textImage" : "textOnly") : null,
		include: null,
	};
	for (const { id: selectId, key } of MODAL_SELECTS) {
		const auto = [...($(selectId).children ?? [])].find((option) => option.value === "");
		if (auto) auto.textContent = shown[key] ? t("choiceAutoCurrent", { v: shown[key] }) : t("choiceAuto");
	}
}

/** Read-only "what Pi is actually using" block, from the catalog snapshot. */
function paintModalCurrent(current) {
	paintModalInherited(current);
	const host = clear($("mm-current"));
	if (!current || Object.keys(current).length === 0) {
		host.appendChild(el("p", { class: "modal-hint", text: t("currentNone") }));
		return;
	}
	const rows = [
		[t("displayName"), typeof current.name === "string" ? current.name : t("unknownVal")],
		[t("contextWindow"), Number.isSafeInteger(current.contextWindow) ? groupedNumber(current.contextWindow) : t("unknownVal")],
		[t("maxTokens"), Number.isSafeInteger(current.maxTokens) ? groupedNumber(current.maxTokens) : t("unknownVal")],
		[t("reasoning"), typeof current.reasoning === "boolean" ? t(current.reasoning ? "yes" : "no") : t("unknownVal")],
		[t("inputModalities"), Array.isArray(current.input) ? current.input.join(" + ") : t("unknownVal")],
	];
	host.appendChild(el("h3", { text: t("currentHeading") }));
	for (const [label, value] of rows) {
		host.appendChild(el("div", { class: "modal-current-row" }, [el("span", { text: label }), el("b", { text: value })]));
	}
}

function modalChoiceLabel(key, raw) {
	if (raw === "") return t("choiceAuto");
	if (key === "reasoning") return t(raw === "true" ? "supported" : "notSupported");
	if (key === "include") return t(raw === "true" ? "includeManual" : "includeListed");
	return t(raw === "text" ? "textOnly" : "textImage");
}

function modalSelectValue(model, key) {
	const value = model?.[key];
	if (key === "input") return Array.isArray(value) ? value.join("+") : "";
	if (value === undefined) return "";
	return String(value);
}

/** Fill and show the model override dialog. Reads the working document, never the file. */
function openModelModal({ modelsPath, provider, id, isNew, lockId = !isNew, current = null }) {
	const override = isNew ? {} : (getPath(configState.doc, [...modelsPath, id]) ?? {});
	modalState.modelsPath = modelsPath;
	modalState.provider = provider;
	modalState.originalId = id;
	modalState.isNew = isNew;
	modalState.lockId = lockId;
	// A picker over the live catalog: most "add" flows pick a model that already
	// exists upstream, and picking one is where its current data appears.
	const known = lastCatalog?.status === "ready" ? (lastCatalog.byProvider?.[provider] ?? []) : [];
	const pickWrap = $("mm-pick-wrap");
	// A locked ID (opened from a listed model) has nothing left to pick.
	pickWrap.classList.toggle("hidden", known.length === 0 || !isNew || lockId);
	if (!pickWrap.classList.contains("hidden")) {
		const pick = clear($("mm-pick"));
		pick.appendChild(el("option", { value: "", text: t("pickManual") }));
		for (const knownId of known) pick.appendChild(el("option", { value: knownId, text: knownId }));
		pick.value = "";
	}
	// Opened from a listed model that has no override yet: it is being configured,
	// not added from nothing, and it is already running on its current values.
	const fromCatalog = isNew && lockId && Boolean(id);
	$("model-modal-title").textContent = t(fromCatalog ? "modalConfigTitle" : isNew ? "modalNewTitle" : "modalEditTitle");
	$("model-modal-sub").textContent = t(fromCatalog ? "modalSubDefault" : isNew ? "modalSubNew" : "modalSubExisting", { provider, id });
	$("mm-id").value = id;
	$("mm-id").disabled = lockId;
	$("mm-name").value = typeof override.name === "string" ? override.name : "";
	$("mm-context").value = Number.isSafeInteger(override.contextWindow) ? String(override.contextWindow) : "";
	$("mm-max").value = Number.isSafeInteger(override.maxTokens) ? String(override.maxTokens) : "";
	for (const { id: selectId, key, options } of MODAL_SELECTS) {
		const select = $(selectId);
		clear(select);
		const chosen = modalSelectValue(override, key);
		let matched = false;
		for (const option of options) {
			const raw = option.auto ? "" : option.value;
			select.appendChild(el("option", { value: raw, text: modalChoiceLabel(key, raw) }));
			if (raw === chosen) matched = true;
		}
		if (!matched) select.appendChild(el("option", { value: chosen, text: t("choiceExisting", { v: chosen }) }));
		select.value = chosen;
	}
	paintModalCurrent(current);
	modalState.initial = modalSignature();
	$("mm-remove").classList.toggle("hidden", isNew);
	$("mm-remove").textContent = t("removeOverride");
	$("mm-cancel").textContent = t("cancel");
	$("mm-apply").textContent = t("apply");
	paintModelModalState();
	const dialog = $("model-modal");
	if (!dialog.open && typeof dialog.showModal === "function") dialog.showModal();
	(isNew && !lockId ? $("mm-id") : $("mm-name")).focus();
}

/** Re-read the dialog's fields, validate them, and reflect the verdict in the UI. */
/** What the dialog would apply, as one comparable string. */
function modalSignature() {
	return JSON.stringify([readModelModalId(), readModelModalOverride()]);
}

function paintModelModalState() {
	const error = $("mm-error");
	const problems = modelOverrideProblems(readModelModalId(), readModelModalOverride(), takenIdsForModal());
	error.textContent = problems.join(" · ");
	// Applying what is already there changes nothing; saying so beats a button that looks live and does nothing.
	const unchanged = modalSignature() === modalState.initial;
	$("mm-apply").disabled = problems.length > 0 || unchanged;
	$("mm-apply").title = problems.length === 0 && unchanged ? t("noChange") : "";
}

function readModelModalId() {
	return $("mm-id").value.trim();
}

function readModelModalOverride() {
	const override = {};
	const name = $("mm-name").value.trim();
	if (name) override.name = name;
	for (const inputId of ["mm-context", "mm-max"]) {
		const raw = $(inputId).value.trim();
		if (raw !== "") override[inputId === "mm-context" ? "contextWindow" : "maxTokens"] = Number(raw);
	}
	for (const { key } of MODAL_SELECTS) {
		const raw = $(`mm-${key}`).value;
		if (raw === "") continue;
		if (key === "input") override.input = raw.split("+");
		else override[key] = raw === "true";
	}
	return override;
}

function takenIdsForModal() {
	const models = getPath(configState.doc, modalState.modelsPath ?? []);
	const ids = Object.keys(models && typeof models === "object" ? models : {});
	if (!modalState.isNew && readModelModalId() === modalState.originalId) return ids.filter((id) => id !== modalState.originalId);
	return ids;
}

function applyModelModal() {
	if ($("mm-apply").disabled) return;
	const id = readModelModalId();
	const override = readModelModalOverride();
	const path = [...(modalState.modelsPath ?? []), id];
	if (!modalState.isNew && id !== modalState.originalId) deletePath(configState.doc, [...(modalState.modelsPath ?? []), modalState.originalId]);
	if (Object.keys(override).length > 0) setPath(configState.doc, path, override);
	else deletePath(configState.doc, path); // every field Auto/blank: clearing the override is the honest result
	closeModelModal();
	renderConfigForm();
	paintDirty();
	toast(Object.keys(override).length > 0 ? t("modalApplied", { id }) : t("modalRemoved", { id }));
}

function removeModelModal() {
	if (modalState.isNew) return;
	deletePath(configState.doc, [...(modalState.modelsPath ?? []), modalState.originalId]);
	closeModelModal();
	renderConfigForm();
	paintDirty();
	toast(t("modalRemoved", { id: modalState.originalId }));
}

function closeModelModal() {
	$("model-modal").close?.();
}

$("mm-cancel").addEventListener("click", closeModelModal);
$("model-modal-close").addEventListener("click", closeModelModal);
$("mm-apply").addEventListener("click", applyModelModal);
$("mm-remove").addEventListener("click", removeModelModal);
for (const inputId of ["mm-id", "mm-name", "mm-context", "mm-max"]) {
	$(inputId).addEventListener("input", paintModelModalState);
}
// While typing a new model ID, follow the catalog: match → show that model's
// current data; no match → the "no data yet" note.
function syncModalCurrentFromId() {
	if (modalState.lockId) return;
	const id = readModelModalId();
	const detail = modalState.provider ? lastCatalog?.detail?.[modalState.provider]?.[id] : null;
	paintModalCurrent(detail && Object.keys(detail).length > 0 ? detail : null);
}
$("mm-id").addEventListener("input", syncModalCurrentFromId);
$("mm-pick").addEventListener("change", () => {
	const picked = $("mm-pick").value;
	if (!picked) return;
	$("mm-id").value = picked;
	// Direct calls, not a synthetic input event: re-dispatching inside a
	// handler is awkward in minimal DOMs and needless in real ones.
	syncModalCurrentFromId();
	paintModelModalState();
});
for (const { id } of MODAL_SELECTS) {
	$(id).addEventListener("change", paintModelModalState);
}

function paintConfigMeta() {
	const info = configState.metaInfo;
	if (!info) return;
	if (info.invalid) {
		$("config-meta").textContent = t("metaInvalid", { path: info.path, message: info.message });
	} else {
		const tail = info.exists ? "" : t("metaMissingTail");
		$("config-meta").textContent = info.path + tail;
	}
	$("config-meta").classList.toggle("no", Boolean(info.invalid));
}

function paintModelCatalog(catalog) {
	lastCatalog = catalog;
	const host = clear($("config-catalog"));
	host.classList.toggle("hidden", configState.section !== "pi-models");
	if (configState.section !== "pi-models") return;
	host.appendChild(el("h2", { text: t("catalogHeading") }));
	host.appendChild(el("p", { class: "hint", text: t("catalogHint") }));
	host.appendChild(el("button", { type: "button", text: t("goPiSettings"), onclick: () => {
		if (!confirmDiscardConfig()) return;
		$("config-section").value = "pi-settings";
		loadConfig({ fresh: true });
	} }));
	if (catalog?.status !== "ready") {
		const text = catalog?.status === "missing" ? t("catalogMissing") : t("catalogInvalid");
		host.appendChild(el("p", { class: "notice warn", text }));
		return;
	}
	const entries = Object.entries(catalog.byProvider ?? {}).sort(([a], [b]) => a.localeCompare(b));
	const count = entries.reduce((n, [, models]) => n + models.length, 0);
	host.appendChild(el("p", { class: "meta", text: t("catalogCount", { n: count, p: entries.length }) }));
	if (!count) host.appendChild(el("p", { class: "hint", text: t("catalogEmptyHint") }));
	for (const [provider, models] of entries) {
		host.appendChild(el("details", { class: "catalog-provider", open: "" }, [
			el("summary", { text: t("catalogProvider", { provider, n: models.length }) }),
			el("ul", { class: "catalog-models" }, models.map(id => {
				const meta = catalog.detail?.[provider]?.[id];
				const chips = [];
				if (Number.isSafeInteger(meta?.contextWindow)) chips.push({ text: `${t("ovBadgeCtx")} ${compactTokens(meta.contextWindow)}`, title: t("ctxTitle", { n: meta.contextWindow.toLocaleString(lang === "en" ? "en-US" : "vi-VN") }) });
				if (Number.isSafeInteger(meta?.maxTokens)) chips.push({ text: `${t("ovBadgeOut")} ${compactTokens(meta.maxTokens)}`, title: t("outTitle", { n: meta.maxTokens.toLocaleString(lang === "en" ? "en-US" : "vi-VN") }) });
				if (meta?.reasoning === true) chips.push({ text: t("ovBadgeReasoning") });
				if (Array.isArray(meta?.input) && meta.input.includes("image")) chips.push({ text: t("chipImage") });
				return el("li", {}, [
					el("div", { class: "catalog-model-main" }, [
						el("code", { text: id }),
						chips.length > 0 ? el("div", { class: "model-ov-badges" }, chips.map((chip) => el("span", { class: "chip", text: chip.text, title: chip.title ?? null }))) : null,
					]),
					el("button", { type: "button", text: t("configure"), "aria-label": `${t("configure")} ${provider}/${id}`, onclick: () => {
						if (configState.invalidRaw !== null || configState.mode !== "form") {
							toast(t("needValidForm"), true); return;
						}
						const providerEntry = configState.doc.providers?.[provider];
						if (!providerEntry || typeof providerEntry !== "object") {
							toast(t("catalogNeedProvider"), true); return;
						}
						openModelModal({ modelsPath: ["providers", provider, "models"], provider, id, isNew: !Object.hasOwn(providerEntry.models ?? {}, id), lockId: true, current: catalog.detail?.[provider]?.[id] ?? null });
					} }),
				]);
			})),
		]));
	}
}

async function refreshModelCatalog() {
	try {
		const { data } = await api("/api/config?section=pi-models&fresh=1");
		if (configState.section === "pi-models") paintModelCatalog(data.catalog);
	} catch {
		if (configState.section === "pi-models") paintModelCatalog(null);
	}
}

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
			text: lang === "en" && action.labelEn ? action.labelEn : action.label,
			onclick: async () => {
				if ((action.id === "models-sync" || action.id === "models-refresh") && configDirty() && !confirm(t("confirmSyncDirty"))) return;
				for (const other of buttons) other.disabled = true;
				const idle = button.textContent;
				button.textContent = (lang === "en" ? action.busyEn : action.busy) ?? t("busyFallback");
				host.classList.add("running");
				clear(output).classList.remove("hidden", "bad", "good");
				output.appendChild(el("p", { class: "cfg-hint", text: (lang === "en" ? action.busyEn : action.busy) ?? t("busyFallback") }));
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
					if (action.id === "models-sync" || action.id === "models-refresh") await refreshModelCatalog();
					host.classList.remove("running");
					for (const other of buttons) other.disabled = false;
				}
			},
		});
		buttons.push(button);
		row.appendChild(el("div", { class: "cfg-action" }, [button, action.hint ? el("span", { class: "cfg-hint", text: lang === "en" && action.hintEn ? action.hintEn : action.hint }) : null]));
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
					(failed ? t("syncPartial") : t("syncDone")) +
					(warnings.length > 0 ? t("warnCount", { n: warnings.length }) : ""),
			}),
		);
		// Warnings first and loud: each one is a model whose limit is wrong or
		// unknown, or a models.dev that could not be reached — the very things a
		// person pressing this button needs to act on, which stderr alone hid.
		if (warnings.length > 0) {
			box.appendChild(
				el("div", { class: "cfg-actions-warn", role: "alert" }, [
					el("strong", { text: t("warningsLabel") }),
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
						? el("ul", { class: "cfg-model-limits", title: t("limitsLegend") }, [
								el("li", { class: "cfg-model-limits-legend", text: t("limitsLegend") }),
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
			text: failed ? (data?.hint ?? data?.message ?? t("cannotRun")) : t("refreshDone"),
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
		toast(t("jsonInvalid", { message: cause.message }), true);
		return;
	}
	applyConfigMode("form");
}

// Only the newest request may paint: a slow reply for a section the person already
// left must not overwrite the one on screen (and the document Save would write).
let configLoadSeq = 0;

async function loadConfig({ fresh = false } = {}) {
	const section = $("config-section").value;
	const seq = ++configLoadSeq;
	try {
		// A save changes the file (so the CLI-side cache is already dropped), but an
		// explicit reload may follow a change made by something else — Pi itself —
		// which the 5s read cache cannot know about.
		const { data } = await api(`/api/config?section=${encodeURIComponent(section)}${fresh ? "&fresh=1" : ""}`);
		if (seq !== configLoadSeq) return;
		if (section !== configState.section) configState.ui = { open: new Map() };
		else if (configState.mode === "form") configState.pendingView = captureView();
		configState.section = section;
		paintModelCatalog(data.catalog);
		configState.schema = data.schema ?? null;
		configState.rev = typeof data.rev === "string" ? data.rev : null;
		configState.invalidRaw = data.invalid ? String(data.raw ?? "") : null;
		configState.doc = data.exists ? clone(data.data) : clone(configState.schema?.seed ?? {});
		// What is on disk right now, so "Áp dụng ghế" can tell edited from saved.
		configState.saved = pruneEmpty(clone(configState.doc)) ?? {};
		$("seats-apply").classList.toggle("hidden", section !== "seats");
		configState.metaInfo = data.invalid ? { invalid: true, path: data.path, message: data.invalid.message } : { invalid: false, path: data.path, exists: data.exists };
		paintConfigMeta();
		// A jobs file that does not exist yet still has tools to switch (pi, claude, …):
		// the first switch creates it, so the panel is not hidden on a fresh machine.
		configState.loaded = data.invalid ? null : data.exists ? clone(data.data) : section === "jobs" ? { version: 1 } : null;
		configState.quickLock = null;
		paintQuickSwitches();
		checkQuickShadow(section, seq);
		$("config-meta").classList.toggle("no", Boolean(data.invalid));
		$("config-editor").value = data.invalid ? configState.invalidRaw : JSON.stringify(configState.doc, null, 2);
		// A section without a schema keeps the old raw-JSON editor, and so does a
		// file that does not parse: the form cannot show what could not be read.
		applyConfigMode(configState.schema && !data.invalid ? "form" : "raw");
		paintDirty();
	} catch (error) {
		if (seq === configLoadSeq) toastError(error);
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
	$("config-save").textContent = dirty ? t("saveDirty") : t("saveButton");
}

// --- quick switches (routing, jobs) -----------------------------------------------

let quickBusy = false;

function switchSubject(item) {
	if (item.kind === "route") return item.cls;
	if (item.kind === "option") return `${item.cls} ${item.label}`;
	if (item.kind === "model") return item.key;
	if (item.kind === "job") return item.id;
	if (item.kind === "executor") return `${item.id} #${item.index + 1} (${item.label})`;
	return item.name;
}

/**
 * Flip ONE switch on the file as it is on disk and write it straight back, with
 * the rev it was read at (so a file that changed since is refused, not
 * overwritten). It goes through the same validator, backup and write path as
 * Save, which is why it needs nothing of its own on the server — and why it does
 * not wait behind Save. The gate / `pteam jobs` read the file on every use, so
 * it is live at once.
 */
async function flipSwitch(item, on, input) {
	if (quickBusy) return;
	if (configDirty() && !confirm(t("quickDiscard"))) {
		input.checked = !on;
		return;
	}
	quickBusy = true;
	for (const box of $("config-quick").querySelectorAll("input")) box.disabled = true;
	const section = configState.section;
	try {
		// The document and rev THIS panel was painted from, not a fresh read: if the
		// file changed since (a hand edit, another tab), the write is refused as a
		// conflict instead of flipping whatever now sits at the same position.
		if (!configState.loaded || !configState.rev) throw new Error(t("quickNoFile"));
		const doc = clone(configState.loaded);
		applySwitch(section, doc, item, on);
		await api(`/api/config?section=${encodeURIComponent(section)}&rev=${encodeURIComponent(configState.rev)}`, { method: "POST", raw: `${JSON.stringify(doc, null, 2)}\n` });
		toast(t(on ? "quickOn" : "quickOff", { what: switchSubject(item) }));
	} catch (error) {
		input.checked = !on;
		toastError(error);
	} finally {
		quickBusy = false;
		if (configState.section === section) await loadConfig({ fresh: true });
	}
}

/**
 * The gate reads cluster-routing.local.json instead of model-routing.local.json
 * whenever the cluster file has a local host (and refuses everything while it is
 * invalid). A routing switch would then edit a file nobody reads and still say
 * "live" — so the panel looks, and locks itself when that is the case.
 */
async function checkQuickShadow(section, seq) {
	if (section !== "routing") return;
	try {
		const { data } = await api("/api/config?section=cluster");
		if (seq !== configLoadSeq || configState.section !== section) return;
		if (!data.exists) return;
		const locals = data.invalid ? [] : Object.values(data.data?.hosts ?? {}).filter((host) => host?.connection?.type === "local");
		if (!data.invalid && locals.length === 0) return;
		configState.quickLock = { kind: data.invalid ? "invalid" : "cluster", path: data.path };
		paintQuickSwitches();
	} catch {
		// Unreadable: leave the switches as they are; the write itself is validated.
	}
}

function paintQuickSwitches() {
	const host = clear($("config-quick"));
	const section = configState.section;
	const groups = section === "routing" || section === "jobs" ? listSwitches(section, configState.loaded) : [];
	host.classList.toggle("hidden", groups.length === 0);
	if (groups.length === 0) return;
	host.appendChild(el("h2", { text: t("quickTitle") }));
	host.appendChild(el("p", { class: "hint", text: t(section === "routing" ? "quickRouting" : "quickJobs") }));
	// The two halves of "turn things off" live on two pages; each says where the other is.
	host.appendChild(el("button", { type: "button", class: "quick-go", text: t(section === "routing" ? "quickGoJobs" : "quickGoRouting"), onclick: () => {
		if (!confirmDiscardConfig()) return;
		$("config-section").value = section === "routing" ? "jobs" : "routing";
		loadConfig({ fresh: true });
	} }));
	const lock = section === "routing" ? configState.quickLock : null;
	if (lock) host.appendChild(el("p", { class: "notice warn quick-lock", role: "status", text: t(lock.kind === "invalid" ? "quickLockInvalid" : "quickLockCluster", { path: lock.path }) }));
	const row = (item) => {
		const input = el("input", { type: "checkbox", role: "switch", "aria-label": t("switchLabel", { what: switchSubject(item) }) });
		input.checked = item.on;
		input.disabled = Boolean(lock) || item.locked === true;
		input.addEventListener("change", () => flipSwitch(item, input.checked, input));
		return el("div", { class: `quick-item${item.on ? "" : " off"}` }, [
			el("label", { class: "quick-switch" }, [input, el("span", { class: "quick-track", "aria-hidden": "true" })]),
			el("span", { class: `quick-name${item.kind === "job" ? " plain" : ""}`, text: item.label }),
			item.detail ? el("span", { class: "quick-detail", text: item.detail }) : null,
		]);
	};
	// The class switches follow the form's grouping (Peer / Supervisor / Lead), so
	// the panel and the cards below it read the same way.
	const routeGroups = section === "routing"
		? ((configState.schema?.groups ?? []).flatMap((g) => g.fields ?? []).find((f) => f.type === "map" && f.keyGroups)?.keyGroups ?? [])
		: [];
	for (const group of groups) {
		const parts = group.id === "routes" && routeGroups.length > 0
			? [
					...routeGroups.map((g) => ({ title: schemaText(g, "label"), items: group.items.filter((item) => g.keys.includes(item.cls)) })),
					{ title: t("otherGroup"), items: group.items.filter((item) => !routeGroups.some((g) => g.keys.includes(item.cls))) },
				].filter((part) => part.items.length > 0)
			: [{ title: null, items: group.items }];
		host.appendChild(el("h3", { text: t(group.id === "routes" ? "quickGroupRoutes" : group.id === "models" ? "quickGroupModels" : group.id === "jobs" ? "quickGroupJobs" : "quickGroupTools") }));
		if (group.id === "models") host.appendChild(el("p", { class: "hint", text: t("quickModelsHint") }));
		for (const part of parts) {
			if (part.title) host.appendChild(el("h4", { class: "quick-role", text: part.title }));
			host.appendChild(quickList(part.items, row));
		}
	}
}

/** The switches of one group as a grid; a job or class and its steps/options form one card. */
function quickList(items, row) {
	const list = el("ul", { class: "quick-list" });
	let block = null;
	for (const item of items) {
		if (item.kind === "job" || item.kind === "route") {
			// A job and its steps are one card: the steps belong to the job, so they
			// sit under it instead of floating in the grid next to other jobs.
			block = el("li", { class: "quick-job" }, [row(item), el("ul", { class: "quick-steps" })]);
			list.appendChild(block);
		} else if ((item.kind === "executor" || item.kind === "option") && block) {
			block.querySelector(".quick-steps").appendChild(el("li", {}, [row(item)]));
		} else {
			list.appendChild(el("li", {}, [row(item)]));
		}
	}
	return list;
}

/** Ask before discarding edits; true means "go ahead". */
function confirmDiscardConfig() {
	if (!configDirty()) return true;
	return confirm(t("confirmDiscard"));
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
		toast(t("seatsDirty"), true);
		return;
	}
	try {
		const { data } = await api("/api/seats/apply", { method: "POST", body: {} });
		if (data.ok === false) {
			toast(t("seatsNotApplied", { errors: (data.errors ?? []).join(" | ") }), true);
			return;
		}
		const parts = [
			data.created?.length ? t("seatsCreated", { list: data.created.join(", ") }) : null,
			data.updated?.length ? t("seatsUpdated", { list: data.updated.join(", ") }) : null,
			data.removed?.length ? t("seatsRemoved", { list: data.removed.join(", ") }) : null,
			data.skipped?.length ? t("seatsSkipped", { list: data.skipped.join(", ") }) : null,
		].filter(Boolean);
		toast(parts.length > 0 ? `${parts.join("; ")}. ${data.note}` : `${t("seatsNothing")} ${data.note}`);
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
		const modelProblems = [];
		if (section === "pi-models") {
			const providers = doc.providers ?? (doc.provider ? { [doc.provider]: doc } : {});
			for (const [, entry] of Object.entries(providers)) {
				for (const [id, model] of Object.entries(entry?.models ?? {})) {
					// Same rules as the modal; raw-JSON edits get them here too.
					modelProblems.push(...modelOverrideProblems(id, model));
				}
			}
			if ($("config-form").querySelector('[aria-invalid="true"]')) modelProblems.push(t("errHighlighted"));
		}
		const problems = [
			...modelProblems,
			...numberRangeProblems(configState.schema, doc),
			...dependentOptionProblems(configState.schema, doc),
			...optionalEntryProblems(configState.schema, doc),
			...listLengthProblems(configState.schema, doc),
		];
		if (problems.length > 0) {
			toast((section === "pi-models" ? t("notSavedPrefix") : "") + problems.join(" · "), true);
			openCardsNamedIn(problems.join(" "));
			return;
		}
		text = JSON.stringify(fillKeptEmpty(configState.schema, pruneEmpty(doc) ?? {}), null, 2);
	}
	try {
		JSON.parse(text); // fail here, before anything touches the file
	} catch (cause) {
		toast(t("jsonBad", { message: cause.message }), true);
		return;
	}
	try {
		// `rev` is the fingerprint of the file this form was built from: if anything
		// (Pi itself rewrites its own settings.json) changed it since, the CLI
		// refuses instead of silently writing a stale copy over those changes.
		const rev = configState.section === section && configState.rev ? `&rev=${encodeURIComponent(configState.rev)}` : "";
		await api(`/api/config?section=${encodeURIComponent(section)}${rev}`, { method: "POST", raw: text });
		toast(t("saved"));
		await loadConfig({ fresh: true });
	} catch (error) {
		toastError(error);
		openCardsNamedIn([error?.message, error?.human?.technical, error?.human?.advice].filter(Boolean).join(" "));
	}
});

loaders.config = async () => {
	if (configState.section !== $("config-section").value) await loadConfig();
};

// --- boot ------------------------------------------------------------------

applyMode();
syncLangButtons();
applyStaticI18n();
// No up-front complaint about a missing token: `paseo-team web --no-token` runs
// without one, and warning there was a false alarm on every page load. A server
// that DOES need one answers 401, which api() turns into the same advice.
for (const tile of document.querySelectorAll("[data-goto]")) {
	tile.addEventListener("click", () => selectTab(tile.dataset.goto));
}
selectTab("home");
