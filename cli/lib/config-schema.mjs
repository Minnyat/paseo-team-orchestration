/**
 * config-schema.mjs — form metadata for every config section the WebUI edits.
 *
 * The UI renders forms from these tables and from nothing else: a field the
 * CLI did not describe cannot appear on screen, so what the browser shows is
 * always reproducible from a terminal. Labels and hints are Vietnamese
 * because the WebUI's audience is; keys, paths and enums stay verbatim.
 *
 * Field shapes (paths are dot-separated; map item paths are relative to the
 * item object):
 *   scalar: { path, type: bool|number|string|enum, label, hint?, default?,
 *             min?, max?, enum? }
 *   lines:  { path, type: "lines" }            one string per textarea line
 *   kv:     { path, type: "kv" }               object of string -> string
 *   map:    { path, type: "map", keyLabel?, addLabel?, fixedKeys?, item? }
 *           Presentation extras for a map of fixed keys: `keyGroups`
 *           [{ id, label, labelEn, keys }] prints the cards under sub-headings
 *           (a key in no group goes under "Khác"; a card never moves between
 *           groups), `keyInfo` { KEY: { label, labelEn } } is one line on what a
 *           key is for, and `item.layout: "route"` draws each card as a
 *           collapsible line plus a table of its options. None of it is stored.
 *   list:   { path, type: "list", label, addLabel?, minItems?,
 *             item: { seed: {...}, fields: [...] } }
 *           an ARRAY of objects, one card per element, in order (the order
 *           matters: a job's `run: "sequential"` follows it). `item.fields`
 *           paths are relative to the element, like a map item's, and their
 *           `showIf` / `optionsBy` name sibling fields of the same element. A
 *           list may sit inside a map item (jobs.<id>.executors). The renderer
 *           adds elements from `item.seed`, removes and reorders them, keeps at
 *           least `minItems`, and drops the value of a field hidden by its
 *           `showIf` when saving.
 *
 * A map key is always one opaque string, dots included ("gpt-5.5",
 * "poolside/laguna-s-2.1"): the renderer never splits it back into a path.
 *
 * `seed` is the skeleton a missing file starts from; `presets` are one-click
 * patches the UI offers as buttons. An empty scalar control means "key
 * absent — the default applies", which is why defaults double as placeholders.
 */

// Routing vocabulary has exactly ONE definition: scripts/model-routing.mjs.
// It used to be re-typed here, and that copy silently stayed pi-only when the
// Claude runtime family landed — so the routing form could not select any
// claude-* role provider even though the daemon had them registered. Import,
// never re-type; test/config-schema.test.mjs locks the two together.
import { join } from "node:path";
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
} from "../../scripts/model-routing.mjs";
// Seat vocabulary has exactly ONE definition too: scripts/seat-profiles.mjs.
// The capability catalog IS the allowlist, so the form must render what that
// module describes rather than a second list that can quietly disagree with
// what `seats apply` will actually grant.
import {
	SEAT_CAPABILITIES,
	SEAT_CAPABILITY_IDS,
	SEATS_SEED,
	capabilitiesByBase,
} from "../../scripts/seat-profiles.mjs";
import { teamConfigDir } from "../../scripts/lib-common.mjs";
// The sync's own reading of the file and its own override rule, so a save
// refuses exactly the overrides the next sync would stop on.
import { normalizeConfig } from "../../scripts/pi-models-sync.mjs";
import { overrideProblems } from "../../scripts/models-dev.mjs";
// Jobs vocabulary lives with its validator, for the same reason.
import {
	BUILTIN_CLI_TOOLS,
	DEFAULT_RUN_MODE,
	EXECUTOR_KINDS,
	JOB_DISPOSITIONS,
	JOB_RUN_MODES,
} from "../../scripts/jobs.mjs";

/**
 * Seeded from the resolved config directory, not from a `~/...` literal. The
 * literal was the pack's old directory name spelled out, so a host that set
 * `PST_TEAM_CONFIG_DIR` — or a new host that never had the old directory —
 * was offered a key file in a directory nothing else reads, and the daemon
 * came up without a key. It is only a seed; the field stays editable.
 */
const PROVIDER_KEY_FILE_SEED = join(teamConfigDir(), "pi-provider.env");

/**
 * Fallback list for `thinking`: the union of every family's levels. A renderer
 * that cannot resolve `optionsBy` still shows a usable set, and enumControl
 * measures a hand-written value against this instead of flagging a valid
 * claude-only level as "outside the list".
 */
const ALL_THINKING_LEVELS = [
	...new Set(Object.values(THINKING_LEVELS_BY_FAMILY).flat()),
];

/**
 * "pi: <pi-provider>/<model-id>, claude: id trần" — built from the descriptors
 * rather than spelled out, so teaching the pack a new runtime updates every
 * hint that mentions model shapes without editing this file.
 */
const MODEL_SHAPE_SENTENCE = RUNTIME_FAMILIES.map(
	(f) => `${RUNTIME_DESCRIPTORS[f].label}: ${RUNTIME_DESCRIPTORS[f].model.hint}`,
).join(", ");

/** Runtime options for the role-provider control: id + human label. */
const RUNTIME_OPTIONS = RUNTIME_FAMILIES.map((f) => ({
	id: f,
	label: RUNTIME_DESCRIPTORS[f].label,
}));

/** Thinking levels keyed by role provider — the `optionsBy` map for `thinking`. */
function thinkingByProvider() {
	return Object.fromEntries(
		ROLE_PROVIDERS.map((name) => [
			name,
			[...THINKING_LEVELS_BY_FAMILY[providerFamily(name)]],
		]),
	);
}

/**
 * The two optional classes, said once for both routing forms. Absent is valid
 * (every route file written before them lacks them); what absence costs is that
 * the create_agent gate refuses the flow that needs one.
 */
const OPTIONAL_ROUTES_HINT =
	"Hai lớp tuỳ chọn: SUPERVISOR_GOVERNANCE (vai trò supervisor — Lead dựng Supervisor) và LEAD_RECOVERY (vai trò lead — Supervisor khôi phục Lead). Để trống thì hợp lệ, nhưng luồng tương ứng bị chặn cho tới khi cấu hình; không bao giờ mượn route của lớp khác.";

/**
 * How the class cards are laid out, said once for the routing form and every
 * cluster host. Presentation only: the stored keys, validators and gate never
 * read it. Grouped by the role of the seat each class builds, then by what the
 * class is for, so a card never moves when its role dropdown changes.
 * MONITOR_ECONOMY sits with the Supervisor: its route must name a *-supervisor
 * provider (docs/model-routing.md), it is just the cheap observation tier.
 */
export const ROUTE_CLASS_GROUPS = Object.freeze([
	{
		id: "peer",
		label: "Peer — Lead dựng để làm việc",
		labelEn: "Peer — seated by the Lead to do the work",
		keys: ["FAST_READ", "CODING_MEDIUM", "REASONING_HIGH", "REVIEW_HIGH"],
	},
	{
		id: "supervisor",
		label: "Supervisor — giám sát và quản trị",
		labelEn: "Supervisor — watching and governing",
		keys: ["MONITOR_ECONOMY", "SUPERVISOR_GOVERNANCE"],
	},
	{
		id: "lead",
		label: "Lead — khôi phục",
		labelEn: "Lead — recovery",
		keys: ["LEAD_RECOVERY"],
	},
]);

/** One line on what each class is for (skills/paseo-team-lead/SKILL.md, "Model classes"). */
export const ROUTE_CLASS_INFO = Object.freeze({
	FAST_READ: { label: "Đọc, khảo sát, kiểm tra cơ học", labelEn: "Scout, research, mechanical checks" },
	CODING_MEDIUM: { label: "Viết code, sửa lỗi, viết test", labelEn: "Implementation, bugfix, tests" },
	REASONING_HIGH: { label: "Kiến trúc, an toàn, di trú", labelEn: "Architecture, safety, migrations" },
	REVIEW_HIGH: { label: "Reviewer độc lập, nghiệm thu", labelEn: "Independent review, acceptance" },
	MONITOR_ECONOMY: { label: "Quan sát thường ngày (rẻ)", labelEn: "Everyday observation (cheap)" },
	SUPERVISOR_GOVERNANCE: { label: "Ghế Supervisor quyết định", labelEn: "Deciding Supervisor seat" },
	LEAD_RECOVERY: { label: "Dựng lại Lead", labelEn: "Seating a Lead again" },
});

/** Shared shape of one route card inside routing and every cluster host. */
function routeFields({ nested = false } = {}) {
	const fields = [
		{
			path: "paseoProvider",
			// One stored key ("claude-peer"), two dropdowns: VAI TRÒ first, then
			// RUNTIME. Roles are the fixed axis (always three); runtimes are the
			// growing one, so the growth lands in the second control instead of
			// multiplying the length of one flat list. Both halves write this same
			// path, so model/thinking below still key off paseoProvider unchanged
			// and the on-disk format is untouched.
			type: "role-provider",
			roles: [...TEAM_ROLES],
			runtimes: RUNTIME_OPTIONS,
			// Kept so any renderer that does not know the composite type still has
			// the full flat vocabulary to fall back to.
			enum: [...ROLE_PROVIDERS],
			label: "Vai trò & runtime",
			labelEn: "Role & runtime",
			hint: "Chọn VAI TRÒ trước (supervisor/lead/peer), rồi RUNTIME chạy nó. Ô mô hình và mức suy nghĩ bên dưới đổi theo lựa chọn này.",
		},
		{
			path: "model",
			type: "enum",
			label: "Mô hình",
			labelEn: "Model",
			hint: `Danh sách model của chính provider đã chọn, đọc từ daemon. Daemon không trả về được thì ô này lùi về nhập tay — ${MODEL_SHAPE_SENTENCE}.`,
			// `source: "models"` marks this map as filled at read time from the live
			// inventory (withModelInventory). An empty map therefore means "the
			// daemon could not tell us", never "no model is valid" — which is why
			// the control falls back to a text box instead of an empty dropdown,
			// and why the pre-save check leaves a runtime-sourced list alone.
			optionsBy: { path: "paseoProvider", source: "models", map: {} },
		},
		{
			path: "thinking",
			type: "enum",
			enum: ALL_THINKING_LEVELS,
			label: "Mức suy nghĩ",
			labelEn: "Thinking level",
			hint: "Danh sách đổi theo family: minimal chỉ có ở pi, ultracode chỉ có ở claude. Mức mô hình không hỗ trợ sẽ bị ép xuống âm thầm — chạy preflight để chắc.",
			optionsBy: { path: "paseoProvider", map: thinkingByProvider() },
		},
		{
			path: "enabled",
			type: "bool",
			default: true,
			label: "Đang bật",
			labelEn: "Enabled",
			hint: "Tắt = lựa chọn này không còn được đưa ra (không có gì thay thế tự động). Lớp việc chỉ bị từ chối khi không còn lựa chọn nào đang bật. Model và mức suy nghĩ vẫn được giữ để bật lại. Có hiệu lực ngay, không cần chạy lại Paseo.",
		},
		{
			path: "alternates",
			type: "list",
			label: "Tool/model khác của lớp này",
			labelEn: "Other tools/models for this class",
			addLabel: "+ Thêm tool/model",
			hint: "Một lớp việc có thể có nhiều cách dựng: tool khác (pi hoặc claude), hoặc cùng tool với model khác. Lead chọn MỘT trong số các lựa chọn đang bật; cổng chỉ kiểm lựa chọn đó có hợp lệ không. Không có gì tự chọn thay Lead.",
			hintEn: "A class can be seated several ways: another tool (pi or claude), or the same tool on another model. The Lead picks ONE of the options that are on; the gate only checks that pick. Nothing is chosen for the Lead.",
			// An alternate is a route without alternates of its own (one level, no tree).
			item: { seed: { thinking: "medium" }, get fields() { return routeFields({ nested: true }); } },
		},
	];
	return nested ? fields.filter((field) => field.path !== "alternates") : fields;
}

/** The on/off switch every executor carries, whatever its kind. */
const executorEnabledField = {
	path: "enabled",
	type: "bool",
	default: true,
	label: "Đang bật",
	hint: "Tắt = bỏ qua bước này (không thay bằng bước khác). Cấu hình vẫn được giữ để bật lại.",
};

/**
 * One executor card of a job. Every field shows for exactly one `kind`; the
 * route ones are the routing form's own route card, so a route executor offers
 * the same providers, live model list and family-specific thinking levels.
 */
function executorFields() {
	const forKind = (kind, field) => ({ ...field, showIf: { path: "kind", equals: kind } });
	return [
		{
			path: "kind",
			type: "enum",
			enum: [...EXECUTOR_KINDS],
			label: "Loại",
			hint: "class: dùng route hiện tại của một lớp việc. route: chỉ định thẳng provider + mô hình. cli: một công cụ dòng lệnh.",
		},
		forKind("class", {
			path: "modelClass",
			type: "enum",
			enum: [...ALL_MODEL_CLASSES],
			label: "Lớp việc",
			hint: "Mô hình thực tế là route của lớp này trong Định tuyến mô hình, đọc lúc dùng.",
		}),
		...routeFields({ nested: true })
			.filter((field) => field.path !== "enabled")
			.map((field) =>
				forKind(
					"route",
					field.path === "thinking" ? { ...field, hint: `Không bắt buộc. ${field.hint}` } : field,
				),
			),
		forKind("cli", {
			path: "tool",
			type: "string",
			label: "Công cụ",
			hint: `Có sẵn: ${Object.keys(BUILTIN_CLI_TOOLS).join(", ")}; hoặc tên một công cụ khai báo ở mục "Công cụ CLI".`,
		}),
		forKind("cli", {
			path: "args",
			type: "lines",
			label: "Tham số thêm",
			hint: "Mỗi dòng một tham số, nối sau tham số của công cụ.",
		}),
		executorEnabledField,
	];
}

export const CONFIG_SCHEMAS = {
	"pi-settings": {
		label: "Pi — cấu hình chính",
		intro:
			"Hành vi của Pi (trình agent đọc cấu hình này). Ô nào để trống thì dùng giá trị mặc định hiển thị dưới nhãn. Thay đổi có hiệu lực từ phiên agent mới.",
		presets: [
			{
				id: "unstable-provider",
				label: "Chống provider lỗi tạm thời",
				hint: "Thử lại tối đa 6 lần, chờ lâu dần giữa các lần (3s → 6s → 12s → 24s → 48s → 96s) và cắt yêu cầu bị treo sau 10 phút.",
				patch: {
					retry: {
						enabled: true,
						maxRetries: 6,
						baseDelayMs: 3000,
						provider: { timeoutMs: 600000, maxRetries: 0, maxRetryDelayMs: 60000 },
					},
				},
			},
		],
		groups: [
			{
				id: "retry",
				label: "Thử lại khi provider lỗi",
				hint: "Chỉ áp dụng cho lỗi tạm thời (quá tải, giới hạn tốc độ, lỗi 5xx, mất kết nối). Lỗi xác thực hoặc sai yêu cầu không bao giờ được thử lại.",
				fields: [
					{
						path: "retry.enabled",
						type: "bool",
						default: true,
						label: "Tự thử lại khi lỗi tạm thời",
					},
					{
						path: "retry.maxRetries",
						type: "number",
						default: 3,
						min: 0,
						max: 20,
						label: "Số lần thử lại tối đa",
					},
					{
						path: "retry.baseDelayMs",
						advanced: true,
						type: "number",
						default: 2000,
						min: 0,
						max: 600000,
						label: "Thời gian chờ ban đầu (ms)",
						hint: "Nhân đôi sau mỗi lần thử: để 3000 thì chờ 3s, 6s, 12s…",
					},
					{
						path: "retry.provider.timeoutMs",
						advanced: true,
						type: "number",
						default: 0,
						min: 0,
						max: 3600000,
						label: "Thời gian chờ mỗi yêu cầu (ms)",
						hint: "0 = để thư viện tự quyết. Đặt 600000 (10 phút) để cắt yêu cầu bị treo rồi thử lại.",
					},
					{
						path: "retry.provider.maxRetries",
						advanced: true,
						type: "number",
						default: 0,
						min: 0,
						max: 10,
						label: "Số lần thử lại của tầng thư viện",
						hint: "Khuyến cáo giữ 0: đặt lớn hơn có thể che lỗi vượt hạn mức và treo agent rất lâu.",
					},
					{
						path: "retry.provider.maxRetryDelayMs",
						advanced: true,
						type: "number",
						default: 60000,
						min: 0,
						max: 600000,
						label: "Chờ dài nhất theo yêu cầu của máy chủ (ms)",
						hint: "Nếu máy chủ yêu cầu chờ lâu hơn mức này thì lỗi được trả về ngay thay vì đợi im lặng.",
					},
				],
			},
			{
				id: "model",
				label: "Mô hình & mức suy nghĩ",
				fields: [
					{
						path: "defaultProvider",
						type: "string",
						label: "Nhà cung cấp mặc định",
						hint: "Tên provider như trong ~/.pi/agent/models.json (ví dụ Minnyat).",
					},
					{ path: "defaultModel", type: "string", label: "Mô hình mặc định" },
					{
						path: "defaultThinkingLevel",
						type: "enum",
						// pi's OWN settings file: the pi levels, not the union — a
						// claude-only level here is meaningless to the Pi agent.
						enum: [...THINKING_LEVELS_BY_FAMILY.pi],
						label: "Mức suy nghĩ mặc định",
					},
					{
						path: "hideThinkingBlock",
						type: "bool",
						default: false,
						label: "Ẩn khối suy nghĩ trong kết quả",
					},
				],
			},
			{
				id: "tools",
				label: "Công cụ & phạm vi model",
				fields: [
					{ path: "defaultTools", type: "lines", label: "Công cụ khởi động", hint: "Mỗi dòng một tên: read, bash, edit, write; +codemode để thêm, -bash để bỏ. Đây không phải sandbox hay cơ chế duyệt quyền." },
					{ path: "enabledModels", type: "lines", label: "Model được chọn / luân phiên", hint: "Mỗi dòng một mẫu provider/model. Để trống = không giới hạn." },
					{ path: "defaultProjectTrust", type: "enum", enum: ["ask", "always", "never"], label: "Tin cậy cấu hình dự án", hint: "ask = hỏi; always = tự nạp cấu hình/extension dự án; never = không nạp. Không giới hạn quyền công cụ trên hệ điều hành." },
				],
			},
			{
				id: "network",
				label: "Mạng & gửi tin",
				fields: [
					{
						path: "transport",
						advanced: true,
						type: "enum",
						enum: ["auto", "sse", "websocket", "websocket-cached"],
						default: "auto",
						label: "Kiểu truyền với provider",
					},
					{
						path: "httpIdleTimeoutMs",
						advanced: true,
						type: "number",
						default: 300000,
						min: 0,
						max: 3600000,
						label: "Thời gian im lặng tối đa qua HTTP (ms)",
					},
					{
						path: "websocketConnectTimeoutMs",
						advanced: true,
						type: "number",
						default: 15000,
						min: 0,
						max: 600000,
						label: "Thời gian kết nối WebSocket (ms)",
					},
					{
						path: "steeringMode",
						advanced: true,
						type: "enum",
						enum: ["one-at-a-time", "all"],
						default: "one-at-a-time",
						label: "Gửi tin chen ngang",
						hint: "one-at-a-time: lần lượt từng tin; all: dồn hết vào lượt kế tiếp.",
					},
					{
						path: "followUpMode",
						advanced: true,
						type: "enum",
						enum: ["one-at-a-time", "all"],
						default: "one-at-a-time",
						label: "Gửi tin nối tiếp",
					},
				],
			},
			{
				id: "compaction",
				label: "Nén ngữ cảnh",
				hint: "Khi hội thoại sắp đầy, Pi tóm tắt phần cũ để chạy tiếp thay vì dừng giữa việc.",
				fields: [
					{
						path: "compaction.enabled",
						type: "bool",
						default: true,
						label: "Tự nén khi hội thoại dài",
					},
					{
						path: "compaction.reserveTokens",
						advanced: true,
						type: "number",
						default: 16384,
						min: 0,
						max: 200000,
						label: "Token dành cho câu trả lời",
					},
					{
						path: "compaction.keepRecentTokens",
						advanced: true,
						type: "number",
						default: 20000,
						min: 0,
						max: 200000,
						label: "Token gần đây được giữ nguyên (không tóm tắt)",
					},
				],
			},
			{
				id: "ui",
				label: "Giao diện",
				fields: [
					{ path: "theme", type: "string", default: "dark", label: "Giao diện (theme)" },
					{
						path: "defaultProjectTrust",
						type: "enum",
						enum: ["ask", "always", "never"],
						default: "ask",
						label: "Tin thư mục dự án mặc định",
						hint: "ask: hỏi khi chạy tương tác. Chạy tự động (kể cả agent) dùng luôn giá trị này.",
					},
					{ path: "quietStartup", type: "bool", default: false, label: "Ẩn lời chào khi khởi động" },
				],
			},
		],
	},

	paseo: {
		label: "Paseo — daemon & nhà cung cấp",
		intro:
			"Cấu hình của daemon Paseo và các hob provider (supervisor / lead / peer). Sửa xong nên khởi động lại daemon để chắc chắn áp dụng.",
		seed: { version: 1 },
		groups: [
			{
				id: "daemon",
				label: "Daemon",
				fields: [
					{
						path: "daemon.mcp.enabled",
						type: "bool",
						default: true,
						label: "Bật máy chủ MCP của daemon",
					},
					{
						path: "daemon.mcp.injectIntoAgents",
						type: "bool",
						default: true,
						label: "Cấp công cụ MCP cho agent",
					},
				],
			},
			{
				id: "providers",
				label: "Nhà cung cấp (hob provider)",
				fields: [
					{
						path: "agents.providers",
						type: "map",
						keyLabel: "Tên provider",
						addLabel: "Thêm provider",
						item: {
							fields: [
								{ path: "label", type: "string", label: "Tên hiển thị" },
								{
									path: "extends",
									type: "string",
									default: "pi",
									label: "Kế thừa",
									hint: "Thường là pi — hob chạy trên trình agent Pi.",
								},
								{
									path: "env",
									type: "kv",
									label: "Biến môi trường",
									hint: "Ví dụ PASEO_PI_ROLE = supervisor.",
								},
							],
						},
					},
				],
			},
		],
	},

	mcp: {
		label: "Pi — công cụ MCP",
		intro: "Các công cụ MCP mà Pi được phép dùng. Thêm một mục tương đương thêm một máy chủ MCP vào ~/.pi/agent/mcp.json.",
		seed: { mcpServers: {} },
		groups: [
			{
				id: "servers",
				label: "Máy chủ MCP",
				fields: [
					{
						path: "mcpServers",
						type: "map",
						keyLabel: "Tên công cụ",
						addLabel: "Thêm công cụ",
						item: {
							seed: { lifecycle: "lazy" },
							fields: [
								{ path: "command", type: "string", label: "Lệnh chạy" },
								{
									path: "args",
									type: "lines",
									label: "Tham số lệnh",
									hint: "Mỗi dòng một tham số, theo đúng thứ tự.",
								},
								{ path: "env", type: "kv", label: "Biến môi trường" },
								{
									path: "lifecycle",
									type: "string",
									default: "lazy",
									label: "Kiểu khởi động",
									hint: "lazy: chỉ khởi động khi agent dùng tới. Đang dùng phổ biến nhất là lazy.",
								},
							],
						},
					},
				],
			},
		],
	},

	routing: {
		label: "Định tuyến mô hình",
		intro:
			"Chọn mô hình cho từng lớp việc trên máy này. Ô mô hình tự gợi ý theo danh sách daemon đang có; xem đầy đủ bằng: pteam models --provider <role-provider>.",
		seed: { version: 1, routes: {} },
		groups: [
			{
				id: "host",
				label: "Máy này",
				fields: [{ path: "hostId", type: "string", label: "Mã máy (hostId)" }],
			},
			{
				id: "routes",
				label: "Lớp việc → mô hình",
				hint: `Năm lớp việc bắt buộc; điền đủ để agent không phải đoán khi nhận việc. ${OPTIONAL_ROUTES_HINT}`,
				fields: [
					{
						path: "routes",
						type: "map",
						keyLabel: "Lớp việc",
						fixedKeys: [...MODEL_CLASSES],
						optionalKeys: [...OPTIONAL_MODEL_CLASSES],
						keyGroups: ROUTE_CLASS_GROUPS,
						keyInfo: ROUTE_CLASS_INFO,
						item: { layout: "route", fields: routeFields() },
					},
				],
			},
			{
				id: "disabledModels",
				label: "Model đang tắt",
				hint: "Model hết tiền hoặc đang lỗi. Mỗi dòng một khoá \"<họ>/<model>\", ví dụ pi/Minnyat/gpt-5.5 hoặc claude/claude-opus-5; kết thúc bằng /* để tắt cả nhóm (pi/Minnyat/* = cả endpoint, pi/* = cả công cụ pi). Lớp việc và bước công việc dùng model này bị từ chối/bỏ qua ngay, không đổi sang model khác. Bật/tắt nhanh ở bảng công tắc phía trên.",
				fields: [{ path: "disabledModels", type: "lines", label: "Model tắt" }],
			},
		],
	},

	"pi-models": {
		label: "Kho model Pi",
		labelEn: "Pi model catalog",
		// Buttons the form offers above the fields. The whole reason this
		// section exists is that keeping pi's catalog current used to mean a
		// terminal; a form you can fill in but not act on would only move half
		// the job into the browser.
		actions: [
			{
				id: "models-sync",
				api: "/api/models/sync",
				label: "Cập nhật danh sách model",
				labelEn: "Sync model list",
				hint: "Gọi thử từng model của mọi điểm cuối, rồi chỉ giữ lại những model còn trả lời. Mất vài phút.",
				hintEn: "Probes every model of every provider and keeps only the ones that answer. Takes minutes.",
				busy: "Đang gọi thử từng model…",
				busyEn: "Probing each model…",
				primary: true,
			},
			{
				id: "models-refresh",
				api: "/api/models/refresh",
				label: "Nạp lại cho Paseo",
				labelEn: "Reload for Paseo",
				hint: "Dùng khi bạn tự sửa file model: Paseo giữ danh sách cũ tới khi được bảo đọc lại.",
				hintEn: "Use after editing the model file yourself: Paseo keeps the old list until told to re-read.",
				busy: "Đang nạp lại…",
				busyEn: "Reloading…",
			},
		],
		intro: "Mỗi thẻ là một nơi Pi lấy model về. Khoá API không lưu ở đây — chỉ lưu tên biến và đường dẫn file chứa khoá.",
		introEn: "Each card is a source Pi pulls models from. API keys are never stored here — only env var names and key-file paths.",
		seed: { version: 1, providers: {} },
		groups: [
			{
				id: "providers",
				label: "Điểm cuối",
				labelEn: "Providers",
				fields: [
					{
						path: "providers",
						type: "map",
						keyLabel: "Tên provider",
						addLabel: "+ Thêm điểm cuối",
						hint: "Tên này đi vào model của Pi: <tên>/<model-id>. Không dùng dấu /.",
						item: {
							seed: {
								api: "openai-completions",
								keyEnv: "CODING_API_KEY",
								keyFile: PROVIDER_KEY_FILE_SEED,
								probe: true,
								concurrency: 5,
							},
							fields: [
								{ path: "baseUrl", type: "string", trim: true, label: "Địa chỉ endpoint", labelEn: "Base URL", hint: "Ví dụ: https://ten-mien/v1", hintEn: "e.g. https://host/v1" },
								{
									path: "keyEnv",
									type: "string",
									trim: true,
									default: "CODING_API_KEY",
									label: "Biến môi trường chứa khoá",
									labelEn: "Env var for API key",
									hint: "Ghi tên biến, không ghi khoá.",
									hintEn: "The variable name, never the key itself.",
								},
								{
									path: "keyFile",
									type: "string",
									trim: true,
									label: "File chứa khoá",
									labelEn: "Key file",
									hint: "Dùng khi biến môi trường trống.",
									hintEn: "Used when the env var is empty.",
								},
								{
									path: "probe",
									type: "bool",
									default: true,
									label: "Gọi thử trước khi ghi",
									hint: "Tắt thì model đã hỏng vẫn được ghi vào.",
								},
								{ path: "api", type: "enum", enum: ["openai-completions"], default: "openai-completions", label: "Giao thức" , advanced: true },
								{ path: "concurrency", type: "number", default: 5, min: 1, max: 16, label: "Số model gọi thử cùng lúc" , advanced: true },
								// Per model, never per endpoint: one number stamped on every model
								// behind an endpoint is what the sync stopped doing. No default on
								// purpose either — an absent limit means "look it up on models.dev".
								// Keys are model ids and stay whole even with dots ("gpt-5.5").
								{
									path: "models",
									type: "model-overrides",
									keyLabel: "Model id",
									addLabel: "+ Thêm cấu hình model",
									label: "Cấu hình model",
									labelEn: "Model overrides",
									hint: "Bền vững qua các lần đồng bộ. Giới hạn để trống được tra từ models.dev. Lưu rồi Cập nhật danh sách model để áp dụng; xoá cấu hình không xoá model ở endpoint.",
									hintEn: "Survives every sync. Blank limits resolve from models.dev. Save then Sync to apply; removing an override never removes the model at the endpoint.",
									item: {
										fields: [
											{
												path: "contextWindow",
												type: "number",
												min: 1,
												label: "Cửa sổ ngữ cảnh",
												labelEn: "Context window",
												hint: "Để trống = tự tra từ models.dev.",
												hintEn: "Leave blank to resolve from models.dev.",
											},
											{
												path: "maxTokens",
												type: "number",
												min: 1,
												label: "Token đầu ra tối đa",
												labelEn: "Max output tokens",
												hint: "Để trống = tự tra từ models.dev. Không được lớn hơn context window.",
												hintEn: "Leave blank to resolve from models.dev. Must not exceed the context window.",
											},
											{ path: "name", type: "string", trim: true, label: "Tên hiển thị", labelEn: "Display name", hint: "Để trống dùng model ID.", hintEn: "Leave blank to use the model ID." },
											{ path: "reasoning", type: "bool", choices: [{ label: "Có", labelEn: "Supported", value: true }, { label: "Không", labelEn: "Not supported", value: false }], label: "Suy luận", labelEn: "Reasoning", hint: "Auto = theo kết quả gọi thử; chỉ ghi đè khi đã xác nhận.", hintEn: "Auto follows probe results; override only verified capabilities." },
											{ path: "input", type: "lines", choices: [{ label: "Văn bản", labelEn: "Text", value: ["text"] }, { label: "Văn bản + ảnh", labelEn: "Text + image", value: ["text", "image"] }], label: "Đầu vào", labelEn: "Input modalities", hint: "Auto hiện dùng text + image, chưa được xác minh.", hintEn: "Auto currently assumes text + image; unverified." },
											{ path: "compat", type: "kv", label: "Cờ compat của Pi", labelEn: "Pi compat flags", hint: "Ghi đè lên những gì Pi tự dò từ URL, vd supportsDeveloperRole = false cho model suy luận sau proxy từ chối role 'developer' (lỗi 422). Giá trị true/false.", hintEn: "Overrides what Pi auto-detects from the URL, e.g. supportsDeveloperRole = false for a reasoning model behind a proxy that rejects the 'developer' role (a 422). true/false values." },
											{ path: "include", type: "bool", choices: [{ label: "Thêm thủ công", labelEn: "Include manually", value: true }, { label: "Chỉ khi endpoint liệt kê", labelEn: "Listed only", value: false }], label: "Nguồn model", labelEn: "Discovery", hint: "ID thủ công vẫn qua probe.", hintEn: "Manual IDs still go through probes." },
										],
									},
								},
							],
						},
					},
				],
			},
		],
	},

	cluster: {
		label: "Nhiều máy (cluster)",
		intro:
			"Mỗi máy một thẻ: kết nối, khả năng, giới hạn song song và định tuyến mô hình. Giá trị endpoint chỉ chứa TÊN biến môi trường — không ghi giá trị thật vào file này.",
		seed: { version: 1, hosts: {} },
		groups: [
			{
				id: "hosts",
				label: "Máy trong cụm",
				fields: [
					{
						path: "hosts",
						type: "map",
						keyLabel: "Tên máy",
						addLabel: "Thêm máy",
						item: {
							seed: { connection: { type: "local" }, required: true, capabilities: [], limits: { writers: 0, readers: 2 }, routes: {} },
							fields: [
								{
									path: "connection.type",
									type: "enum",
									enum: ["local", "remote"],
									default: "local",
									label: "Kiểu kết nối",
								},
								{
									path: "connection.endpointEnv",
									type: "string",
									label: "Biến môi trường chứa endpoint",
									hint: "Chỉ tên biến (ví dụ PASEO_MAC_REVIEW); giá trị nằm trong môi trường của máy điều khiển.",
									showIf: { path: "connection.type", equals: "remote" },
								},
								{
									path: "required",
									type: "bool",
									default: true,
									label: "Máy bắt buộc",
									hint: "Nếu bắt buộc mà máy vắng mặt thì cụm không chạy.",
								},
								{
									path: "capabilities",
									type: "lines",
									// validateClusterConfig requires the array even when empty;
									// the form's save prune would otherwise drop it.
									keepEmpty: true,
									label: "Khả năng",
									hint: "Mỗi dòng một khả năng: git-read, git-write, focused-test, docker, integration-test, independent-review…",
								},
								{
									path: "limits.writers",
									type: "number",
									default: 0,
									min: 0,
									max: 16,
									label: "Số agent được ghi file cùng lúc",
								},
								{
									path: "limits.readers",
									type: "number",
									default: 2,
									min: 0,
									max: 32,
									label: "Số agent chỉ đọc cùng lúc",
								},
								{
									path: "routes",
									type: "map",
									keyLabel: "Lớp việc",
									fixedKeys: [...MODEL_CLASSES],
									optionalKeys: [...OPTIONAL_MODEL_CLASSES],
									keyGroups: ROUTE_CLASS_GROUPS,
									keyInfo: ROUTE_CLASS_INFO,
									hint: OPTIONAL_ROUTES_HINT,
									item: { layout: "route", fields: routeFields() },
								},
							],
						},
					},
				],
			},
		],
	},

	jobs: {
		label: "Công việc",
		intro:
			"Mỗi công việc là một bộ gợi ý cho Lead: làm việc này thì dùng những mô hình hoặc công cụ nào. Mọi executor đang bật trong một công việc đều được dùng — \"lần lượt\" là theo thứ tự, không phải \"hỏng cái này thì thử cái kia\"; bước đang tắt bị bỏ qua chứ không được thay bằng bước khác. Công việc không tự dựng agent; Lead đọc bằng: pteam jobs list. Công tắc bật/tắt có hiệu lực ngay, không cần chạy lại Paseo.",
		seed: { version: 1, jobs: {} },
		// One click, no typing: each preset adds a ready job. They use CLASS executors,
		// so the model of each step is whatever route that class has on this host — to
		// pin a specific model, change an executor's kind to "route" afterwards.
		presets: [
			{
				id: "two-reviewers",
				label: "Mẫu: hai reviewer độc lập (hai model khác nhau)",
				labelEn: "Preset: two independent reviewers (two different models)",
				hint: "Chạy song song REVIEW_HIGH và REASONING_HIGH trên cùng một SHA. Tắt model nào hết tiền ở bảng công tắc, bước đó tự bị bỏ qua.",
				hintEn: "Runs REVIEW_HIGH and REASONING_HIGH side by side on one SHA. Switch off a model that ran out of credit and its step is skipped.",
				patch: {
					jobs: {
						"two-reviewers": {
							label: "Hai reviewer độc lập",
							disposition: "independent-reviewer",
							run: "parallel",
							executors: [
								{ kind: "class", modelClass: "REVIEW_HIGH" },
								{ kind: "class", modelClass: "REASONING_HIGH" },
							],
						},
					},
				},
			},
			{
				id: "many-models",
				label: "Mẫu: cùng một việc, nhiều model",
				labelEn: "Preset: one task, several models",
				hint: "FAST_READ, CODING_MEDIUM và REASONING_HIGH chạy song song — cùng công cụ nhưng model khác nhau nếu route của chúng khác nhau.",
				hintEn: "FAST_READ, CODING_MEDIUM and REASONING_HIGH side by side — the same tool on different models when their routes differ.",
				patch: {
					jobs: {
						"many-models": {
							label: "Một việc, nhiều model",
							run: "parallel",
							executors: [
								{ kind: "class", modelClass: "FAST_READ" },
								{ kind: "class", modelClass: "CODING_MEDIUM" },
								{ kind: "class", modelClass: "REASONING_HIGH" },
							],
						},
					},
				},
			},
			{
				id: "scout-then-build",
				label: "Mẫu: khảo sát rồi làm (lần lượt)",
				labelEn: "Preset: scout, then build (in order)",
				hint: "FAST_READ khảo sát trước, CODING_MEDIUM làm sau. Lần lượt theo thứ tự; bước bị tắt bị bỏ qua, không thay bằng bước khác.",
				hintEn: "FAST_READ scouts first, CODING_MEDIUM builds after. In order; a switched-off step is skipped, never replaced.",
				patch: {
					jobs: {
						"scout-then-build": {
							label: "Khảo sát rồi làm",
							disposition: "engineer",
							run: "sequential",
							executors: [
								{ kind: "class", modelClass: "FAST_READ" },
								{ kind: "class", modelClass: "CODING_MEDIUM" },
							],
						},
					},
				},
			},
		],
		groups: [
			{
				id: "jobs",
				label: "Danh sách công việc",
				hint: "Mã công việc chỉ gồm chữ, số, \"_\" và \"-\" (không dấu chấm).",
				fields: [
					{
						path: "jobs",
						type: "map",
						keyLabel: "Mã công việc",
						addLabel: "+ Thêm công việc",
						item: {
							seed: { run: DEFAULT_RUN_MODE, executors: [{ kind: "class" }] },
							fields: [
								{ path: "label", type: "string", label: "Tên hiển thị" },
								{ path: "description", type: "string", label: "Mô tả" },
								{
									path: "disposition",
									type: "enum",
									enum: [...JOB_DISPOSITIONS],
									label: "Loại việc trong brief (DISPOSITION)",
									hint: "Không bắt buộc. Gợi ý DISPOSITION cho brief giao việc này.",
								},
								{
									path: "run",
									type: "enum",
									enum: [...JOB_RUN_MODES],
									default: DEFAULT_RUN_MODE,
									label: "Cách chạy",
									hint: "parallel: các executor chạy cùng lúc. sequential: lần lượt theo thứ tự trong danh sách.",
								},
								{
									path: "enabled",
									type: "bool",
									default: true,
									label: "Đang bật",
									hint: "Tắt = Lead không thấy công việc này trong pteam jobs list. Có hiệu lực ngay.",
								},
								{
									path: "executors",
									type: "list",
									label: "Executor",
									addLabel: "+ Thêm executor",
									minItems: 1,
									hint: "Ít nhất một. Mỗi executor là một lớp việc, một route cụ thể, hoặc một công cụ CLI.",
									item: { seed: { kind: "class" }, fields: executorFields() },
								},
							],
						},
					},
				],
			},
			{
				id: "disabledTools",
				label: "Công cụ đang tắt",
				hint: "Mỗi dòng một tên công cụ (pi, claude hoặc công cụ khai báo bên dưới). Executor dùng công cụ này bị bỏ qua. Bật/tắt nhanh ở bảng công tắc phía trên.",
				fields: [{ path: "disabledTools", type: "lines", label: "Công cụ tắt" }],
			},
			{
				id: "cliTools",
				label: "Công cụ CLI",
				hint: `Thêm công cụ ngoài hai cái có sẵn (${Object.keys(BUILTIN_CLI_TOOLS).join(", ")}). Tên chỉ gồm chữ, số, "_" và "-".`,
				fields: [
					{
						path: "cliTools",
						type: "map",
						keyLabel: "Tên công cụ",
						addLabel: "+ Thêm công cụ",
						item: {
							fields: [
								{ path: "command", type: "string", label: "Lệnh chạy" },
								{
									path: "args",
									type: "lines",
									label: "Tham số lệnh",
									hint: "Mỗi dòng một tham số, theo đúng thứ tự.",
								},
							],
						},
					},
				],
			},
		],
	},

	seats: {
		label: "Ghế tuỳ biến (biến thể vai trò)",
		intro:
			"Một ghế là một biến thể có tên của MỘT trong ba vai trò gốc, không phải vai trò thứ tư. Luật vẫn đọc vai trò gốc; ghế chỉ thêm năng lực trong danh mục đã kiểm duyệt. Lưu xong bấm \"Áp dụng ghế\" để sinh provider, rồi chạy 'paseo daemon restart'.",
		seed: { ...SEATS_SEED },
		groups: [
			{
				id: "seats",
				label: "Danh sách ghế",
				hint:
					"Tên ghế trở thành đuôi của provider: base \"claude-peer\" + ghế \"researcher\" → provider \"claude-peer-researcher\". Chữ thường, 2–24 ký tự, chỉ a-z 0-9 và dấu gạch ngang.",
				fields: [
					{
						path: "seats",
						type: "map",
						keyLabel: "Tên ghế",
						addLabel: "+ Thêm ghế",
						item: {
							fields: [
								{
									path: "base",
									type: "enum",
									enum: [...ROLE_PROVIDERS],
									label: "Vai trò gốc",
									hint: "Quyết định PASEO_PI_ROLE của ghế, tức toàn bộ luật áp lên nó.",
								},
								{
									path: "label",
									type: "string",
									label: "Nhãn hiển thị",
									hint: "Tên Paseo hiển thị trong 'provider ls'. Bỏ trống thì sinh tự động.",
								},
								{
									path: "capabilities",
									type: "flags",
									enum: [...SEAT_CAPABILITY_IDS],
									// Options follow the sibling `base`: a capability the
									// catalog refuses for that role must not even be offered,
									// because `seats apply` would reject the document anyway.
									optionsBy: { path: "base", map: capabilitiesByBase() },
									options: SEAT_CAPABILITIES.map((c) => ({
										id: c.id,
										label: c.label,
										hint: c.hint,
										tools: [...c.tools],
										env: { ...c.env },
									})),
									label: "Năng lực được cấp",
									hint: "Chỉ những năng lực có trong danh mục của code. Muốn thêm loại mới phải sửa scripts/seat-profiles.mjs kèm test.",
								},
							],
						},
					},
				],
			},
		],
	},
};

/**
 * Return a copy of `schema` with every runtime-sourced option map
 * (`optionsBy.source === "models"`) filled from a live model inventory
 * (`{ "<role-provider>": ["<model-id>", ...] }`).
 *
 * Only `source`-marked maps are touched: the thinking levels are an
 * `optionsBy` too, but theirs is a static per-family table that the daemon has
 * no say in and must survive untouched.
 *
 * Walks nested map items, so the cluster section — whose route cards sit two
 * levels down, one set per host — gets the same lists as the single-host
 * routing section.
 *
 * The input schema is never mutated: `schemaForSection` hands out the module's
 * own tables, and filling them in place would leak one command's daemon
 * snapshot into the next call within the same process.
 */
export function withModelInventory(schema, modelsByProvider = {}) {
	if (schema === null || typeof schema !== "object") return schema;
	const byProvider =
		modelsByProvider !== null && typeof modelsByProvider === "object"
			? modelsByProvider
			: {};
	const fillField = (field) => {
		const next = { ...field };
		if (next.optionsBy?.source === "models") {
			next.optionsBy = { ...next.optionsBy, map: byProvider };
		}
		if (next.item && Array.isArray(next.item.fields)) {
			next.item = { ...next.item, fields: next.item.fields.map(fillField) };
		}
		return next;
	};
	return {
		...schema,
		groups: (schema.groups ?? []).map((group) => ({
			...group,
			fields: (group.fields ?? []).map(fillField),
		})),
	};
}

/**
 * Return a copy of the pi-settings schema whose `defaultProvider` / `defaultModel`
 * offer what Pi actually has: the providers and model ids in pi's own models.json
 * (`{ "<provider>": ["<model-id>", ...] }`).
 *
 * Both fields were free text, and a typo there is not an error anywhere — Pi just
 * starts on a model that is not what its owner meant, or none. A dropdown fed by
 * the same file Pi reads makes the valid choices the visible ones.
 *
 * Only ever an OFFER: `defaultModel` keeps `optionsBy.source`, so the form still
 * degrades to a text box when no provider is chosen or models.json lists no models
 * for it, and a value outside the list stays (flagged) and is never refused on save —
 * Pi also knows built-in providers that models.json never mentions. With no catalog
 * at all both fields stay the plain text boxes they were.
 */
export function withPiModelCatalog(schema, catalog = {}) {
	if (schema === null || typeof schema !== "object") return schema;
	const providers = Object.keys(catalog ?? {}).sort();
	if (providers.length === 0) return schema;
	const fill = (field) => {
		if (field.path === "defaultProvider") {
			return { ...field, type: "enum", enum: providers, hint: `${field.hint ?? ""} Lấy từ models.json; Pi còn có cả provider có sẵn không nằm trong file đó.`.trim() };
		}
		if (field.path === "defaultModel") {
			return {
				...field,
				type: "enum",
				enum: [],
				hint: "Model của provider đã chọn ở ô trên, lấy từ models.json. Chưa chọn provider thì nhập tay.",
				optionsBy: { path: "defaultProvider", source: "pi-models", map: catalog },
			};
		}
		return field;
	};
	return {
		...schema,
		groups: (schema.groups ?? []).map((group) => ({ ...group, fields: (group.fields ?? []).map(fill) })),
	};
}

/**
 * Save-time check for the pi-models section — the per-model overrides ONLY
 * (`providers.<name>.models.<model-id>`): each must be an object of positive
 * integers under the keys the sync reads, with maxTokens ≤ contextWindow. A
 * bad override makes `pteam models sync` stop the whole run, and the form is
 * where it gets typed, so it is refused at save naming endpoint and model.
 *
 * Everything else the sync checks (a missing or plain-http baseUrl, a "/" in
 * an endpoint name, no endpoint at all) still saves and fails at sync, as it
 * always did: an endpoint card half filled in is a draft, and refusing it would
 * change a save flow this check was not added to change. The endpoint-level
 * contextWindow/maxTokens an older version wrote stay a sync warning too.
 *
 * Same messages as the sync (overrideProblems), prefixed with the endpoint.
 *
 * @throws {Error} "CONFIG_INVALID: pi-models: <problem>; <problem>…"
 */
export function validatePiModelsConfig(doc) {
	const problems = [];
	for (const entry of normalizeConfig(doc).entries) {
		if (entry.models === undefined) continue;
		if (!entry.models || typeof entry.models !== "object" || Array.isArray(entry.models)) {
			problems.push(`provider "${entry.name}": models must be an object of per-model overrides`);
			continue;
		}
		for (const [id, override] of Object.entries(entry.models)) {
			for (const problem of overrideProblems(id, override)) problems.push(`provider "${entry.name}": ${problem}`);
		}
	}
	if (problems.length > 0) throw new Error(`CONFIG_INVALID: pi-models: ${problems.join("; ")}`);
	return doc;
}

/** Sections whose forms are route tables (a route card per MODEL_CLASS). */
export const ROUTING_SECTIONS = ["routing", "cluster"];

/**
 * Sections whose forms carry a live model inventory: the route tables, plus
 * jobs, whose route executors pick from the same per-provider model lists.
 */
export const MODEL_INVENTORY_SECTIONS = [...ROUTING_SECTIONS, "jobs"];

/** Sections sharing one file share one schema: `providers` and `paseo`. */
export function schemaForSection(section) {
	if (section === "providers" || section === "paseo") return CONFIG_SCHEMAS.paseo;
	return CONFIG_SCHEMAS[section] ?? null;
}
