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
	MODEL_CLASSES,
	ROLE_PROVIDERS,
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

/** Thinking levels keyed by role provider — the `optionsBy` map for `thinking`. */
function thinkingByProvider() {
	return Object.fromEntries(
		ROLE_PROVIDERS.map((name) => [
			name,
			[...THINKING_LEVELS_BY_FAMILY[providerFamily(name)]],
		]),
	);
}

/** Shared shape of one route card inside routing and every cluster host. */
function routeFields() {
	return [
		{
			path: "paseoProvider",
			type: "enum",
			enum: [...ROLE_PROVIDERS],
			label: "Provider Paseo",
			hint: "Family + vai trò. pi-* chạy trên Pi, claude-* chạy trên Claude Code. Ô mô hình và mức suy nghĩ bên dưới đổi theo ô này.",
		},
		{
			path: "model",
			type: "enum",
			label: "Mô hình",
			hint: "Danh sách model của chính provider đã chọn, đọc từ daemon. Daemon không trả về được thì ô này lùi về nhập tay — pi: <pi-provider>/<model-id>, claude: id trần.",
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
			hint: "Danh sách đổi theo family: minimal chỉ có ở pi, ultracode chỉ có ở claude. Mức mô hình không hỗ trợ sẽ bị ép xuống âm thầm — chạy preflight để chắc.",
			optionsBy: { path: "paseoProvider", map: thinkingByProvider() },
		},
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
						type: "number",
						default: 2000,
						min: 0,
						max: 600000,
						label: "Thời gian chờ ban đầu (ms)",
						hint: "Nhân đôi sau mỗi lần thử: để 3000 thì chờ 3s, 6s, 12s…",
					},
					{
						path: "retry.provider.timeoutMs",
						type: "number",
						default: 0,
						min: 0,
						max: 3600000,
						label: "Thời gian chờ mỗi yêu cầu (ms)",
						hint: "0 = để thư viện tự quyết. Đặt 600000 (10 phút) để cắt yêu cầu bị treo rồi thử lại.",
					},
					{
						path: "retry.provider.maxRetries",
						type: "number",
						default: 0,
						min: 0,
						max: 10,
						label: "Số lần thử lại của tầng thư viện",
						hint: "Khuyến cáo giữ 0: đặt lớn hơn có thể che lỗi vượt hạn mức và treo agent rất lâu.",
					},
					{
						path: "retry.provider.maxRetryDelayMs",
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
				id: "network",
				label: "Mạng & gửi tin",
				fields: [
					{
						path: "transport",
						type: "enum",
						enum: ["auto", "sse", "websocket", "websocket-cached"],
						default: "auto",
						label: "Kiểu truyền với provider",
					},
					{
						path: "httpIdleTimeoutMs",
						type: "number",
						default: 300000,
						min: 0,
						max: 3600000,
						label: "Thời gian im lặng tối đa qua HTTP (ms)",
					},
					{
						path: "websocketConnectTimeoutMs",
						type: "number",
						default: 15000,
						min: 0,
						max: 600000,
						label: "Thời gian kết nối WebSocket (ms)",
					},
					{
						path: "steeringMode",
						type: "enum",
						enum: ["one-at-a-time", "all"],
						default: "one-at-a-time",
						label: "Gửi tin chen ngang",
						hint: "one-at-a-time: lần lượt từng tin; all: dồn hết vào lượt kế tiếp.",
					},
					{
						path: "followUpMode",
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
						type: "number",
						default: 16384,
						min: 0,
						max: 200000,
						label: "Token dành cho câu trả lời",
					},
					{
						path: "compaction.keepRecentTokens",
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
				hint: "Năm lớp việc cố định; điền đủ để agent không phải đoán khi nhận việc.",
				fields: [
					{
						path: "routes",
						type: "map",
						keyLabel: "Lớp việc",
						fixedKeys: [...MODEL_CLASSES],
						item: { fields: routeFields() },
					},
				],
			},
		],
	},

	"pi-models": {
		label: "Kho model Pi",
		// Buttons the form offers above the fields. The whole reason this
		// section exists is that keeping pi's catalog current used to mean a
		// terminal; a form you can fill in but not act on would only move half
		// the job into the browser.
		actions: [
			{
				id: "models-sync",
				api: "/api/models/sync",
				label: "Cập nhật danh sách model",
				hint: "Gọi thử từng model của mọi điểm cuối, rồi chỉ giữ lại những model còn trả lời. Mất vài phút.",
				busy: "Đang gọi thử từng model…",
				primary: true,
			},
			{
				id: "models-refresh",
				api: "/api/models/refresh",
				label: "Nạp lại cho Paseo",
				hint: "Dùng khi bạn tự sửa file model: Paseo giữ danh sách cũ tới khi được bảo đọc lại.",
				busy: "Đang nạp lại…",
			},
		],
		intro: "Mỗi thẻ là một nơi Pi lấy model về. Khoá API không lưu ở đây — chỉ lưu tên biến và đường dẫn file chứa khoá.",
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
						addLabel: "+ Thêm điểm cuối",
						hint: "Tên này đi vào model của Pi: <tên>/<model-id>. Không dùng dấu /.",
						item: {
							seed: {
								api: "openai-completions",
								keyEnv: "CODING_API_KEY",
								keyFile: PROVIDER_KEY_FILE_SEED,
								probe: true,
								concurrency: 5,
								contextWindow: 200000,
								maxTokens: 32000,
							},
							fields: [
								{ path: "baseUrl", type: "string", label: "Địa chỉ endpoint", hint: "Ví dụ: https://ten-mien/v1" },
								{
									path: "keyEnv",
									type: "string",
									default: "CODING_API_KEY",
									label: "Biến môi trường chứa khoá",
									hint: "Ghi tên biến, không ghi khoá.",
								},
								{
									path: "keyFile",
									type: "string",
									label: "File chứa khoá",
									hint: "Dùng khi biến môi trường trống.",
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
								{ path: "contextWindow", type: "number", default: 200000, min: 1024, label: "Context window" , advanced: true },
								{ path: "maxTokens", type: "number", default: 32000, min: 256, label: "Max output tokens" , advanced: true },
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
									item: { fields: routeFields() },
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

/** Sections whose forms carry a live model inventory. */
export const ROUTING_SECTIONS = ["routing", "cluster"];

/** Sections sharing one file share one schema: `providers` and `paseo`. */
export function schemaForSection(section) {
	if (section === "providers" || section === "paseo") return CONFIG_SCHEMAS.paseo;
	return CONFIG_SCHEMAS[section] ?? null;
}
