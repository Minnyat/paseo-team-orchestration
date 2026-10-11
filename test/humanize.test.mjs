import assert from "node:assert/strict";
import {
	agentKindLabel,
	degradedSentence,
	formatTokens,
	humanizeError,
	limitCell,
	limitsOriginSentence,
	missingSetup,
	modelLimitsLabel,
	overallHealth,
	permitDetail,
	permitSentence,
	projectLabel,
	relativeTime,
	roleLabel,
	runtimeLabel,
	statusLabel,
	PI_DEFAULT_LIMITS,
	syncWarningText,
	toolMeaning,
} from "../webui/public/humanize.js";

// This module is the entire non-technical vocabulary of the WebUI, so it is
// kept DOM-free and tested here rather than eyeballed in a browser.

// --- labels ---------------------------------------------------------------
assert.equal(roleLabel("lead"), "Trưởng nhóm");
assert.equal(roleLabel("peer"), "Thành viên");
assert.equal(roleLabel(undefined), "Chưa rõ vai trò", "an unknown role is never silently blank");
assert.equal(statusLabel("running"), "Đang làm việc");
assert.equal(statusLabel("ERROR"), "Gặp lỗi", "status casing from the daemon does not matter");
assert.equal(statusLabel("something-new"), "something-new", "an unmapped status is shown as-is, not swallowed");

// --- tool risk ------------------------------------------------------------
assert.equal(toolMeaning("write").risk, "high");
assert.equal(toolMeaning("bash").risk, "high");
assert.equal(toolMeaning("archive_agent").risk, "high");
assert.equal(toolMeaning("read").risk, "low");
assert.equal(toolMeaning("list_agents").risk, "low");
// The important one: anything unclassified must NOT be presented as safe.
assert.equal(toolMeaning("frobnicate_9000").risk, "unknown");
assert.equal(toolMeaning("").risk, "unknown");
assert.equal(toolMeaning(undefined).risk, "unknown");
assert.match(toolMeaning("bash").what, /chạy lệnh/);

assert.match(permitSentence({ tool: "write" }, "Fix login bug"), /Fix login bug.*sửa hoặc tạo file/s);
assert.match(permitSentence({ tool: "write" }, ""), /^Một agent/);

// --- errors carry an action, never just a code ---------------------------
{
	const daemon = humanizeError({ code: "CLI_FAILED", stderr: "paseo daemon unreachable" });
	assert.match(daemon.title, /Chưa kết nối/);
	assert.match(daemon.advice, /paseo start/);

	const timeout = humanizeError({ stderr: "paseo-team timed out" });
	assert.match(timeout.advice, /paseo restart/);

	const auth = humanizeError({ code: "UNAUTHORIZED", message: "missing or invalid bearer token" });
	assert.match(auth.title, /hết hạn/);

	const install = humanizeError({ stderr: "prompt not installed for role 'lead'" });
	assert.match(install.advice, /install/);

	// Unknown failures still get a next step instead of a dead end.
	const unknown = humanizeError({ code: "WAT", message: "something odd" });
	assert.equal(unknown.title, "Có lỗi xảy ra");
	assert.match(unknown.advice, /Chi tiết kỹ thuật/);
	assert.match(unknown.technical, /something odd/);

	// The raw text is preserved for whoever does read codes.
	assert.match(humanizeError({ command: "paseo-team graph", stderr: "boom" }).technical, /paseo-team graph.*boom/);
}

// --- relative time --------------------------------------------------------
const now = Date.parse("2026-08-21T12:00:00.000Z");
assert.equal(relativeTime("2026-08-21T11:59:58.000Z", now), "vừa xong");
assert.equal(relativeTime("2026-08-21T11:59:30.000Z", now), "30 giây trước");
assert.equal(relativeTime("2026-08-21T11:45:00.000Z", now), "15 phút trước");
assert.equal(relativeTime("2026-08-21T09:00:00.000Z", now), "3 giờ trước");
assert.equal(relativeTime("2026-08-19T12:00:00.000Z", now), "2 ngày trước");
assert.equal(relativeTime("not a date", now), "không rõ");
assert.equal(relativeTime(undefined, now), "không rõ");

// --- setup gaps -----------------------------------------------------------
{
	const complete = { presence: { policyExtension: true, paseoConfig: true, prompts: { supervisor: true, lead: true, peer: true } } };
	assert.deepEqual(missingSetup(complete), []);

	const partial = { presence: { policyExtension: false, paseoConfig: true, prompts: { supervisor: true, lead: false, peer: false } } };
	const missing = missingSetup(partial);
	assert.equal(missing.length, 2);
	assert.match(missing[1], /Trưởng nhóm.*Thành viên/, "missing prompts are named by role, not by filename");
}

// --- the home headline ranks by urgency -----------------------------------
{
	const status = { presence: { policyExtension: true, paseoConfig: true, prompts: { supervisor: true, lead: true, peer: true } } };
	const graph = { ok: true, nodes: [{ status: "running" }, { status: "idle" }] };

	assert.equal(overallHealth({}).level, "bad", "no status at all is a problem, not a green light");

	// A blocked agent outranks everything else — it is the only thing that
	// stops work until a human answers.
	const waiting = overallHealth({ status, graph, permits: { count: 2 } });
	assert.equal(waiting.level, "attention");
	assert.match(waiting.headline, /2 việc đang chờ bạn duyệt/);

	const one = overallHealth({ status, graph, permits: { count: 1 } });
	assert.match(one.headline, /1 việc/, "singular is not '1 việc(s)'");

	const brokenList = overallHealth({ status, graph: { ok: false }, permits: { count: 0 } });
	assert.equal(brokenList.level, "bad");

	const notInstalled = overallHealth({
		status: { presence: { policyExtension: false, paseoConfig: true, prompts: {} } },
		graph,
		permits: { count: 0 },
	});
	assert.equal(notInstalled.level, "attention");
	assert.match(notInstalled.detail, /install/);

	const errored = overallHealth({ status, graph: { ok: true, nodes: [{ status: "error" }] }, permits: { count: 0 } });
	assert.match(errored.headline, /1 agent đang gặp lỗi/);

	const fine = overallHealth({ status, graph, permits: { count: 0 } });
	assert.equal(fine.level, "good");
	assert.match(fine.headline, /1 agent đang làm việc/);
}

// --- degraded data is stated, never hidden --------------------------------
assert.equal(degradedSentence([], 0), "", "a clean snapshot says nothing");
assert.match(degradedSentence([{ reason: "PARENT_NOT_LISTED" }], 0), /ngoài danh sách/);
assert.match(degradedSentence([{ reason: "TIMEOUT" }, { reason: "INSPECT_FAILED" }], 0), /2 mục không lấy được/);
assert.match(degradedSentence([{ reason: "PERMIT_SHAPE_UNRECOGNIZED" }], 0), /không đọc được nội dung/);
assert.match(degradedSentence([], 5), /còn 5 agent chưa xếp xong/);

// A model endpoint being down is not Paseo being down. The generic rule
// matches "unreachable"/"connect" too, so the specific codes have to win —
// otherwise the page tells someone to start Paseo when Paseo is running fine
// and it is their upstream that is broken.
{
	assert.equal(humanizeError({ code: "ENDPOINT_UNREACHABLE", message: "fetch failed" }).title, "Không gọi được tới điểm cuối");
	assert.equal(humanizeError({ code: "ENDPOINT_LIST_FAILED", message: "GET .../models -> 403" }).title, "Không gọi được tới điểm cuối");
	assert.match(humanizeError({ code: "ALL_MODELS_DEAD", message: "no model answered" }).advice, /được giữ nguyên/);
	assert.equal(humanizeError({ code: "API_KEY_MISSING" }).title, "Chưa tìm thấy khoá API");
	// ...while a genuine daemon fault still reads as one.
	assert.equal(humanizeError({ code: "DAEMON_UNREACHABLE", message: "ECONNREFUSED" }).title, "Chưa kết nối được với Paseo");
}

// --- sub-agents of any runtime ---------------------------------------------
// A Lead can start a plain `codex` or `gemini` agent through Paseo's own
// providers. The board used to give such a node no runtime badge and the label
// "Chưa rõ vai trò", which read as a fault on a perfectly normal setup.
{
	assert.equal(runtimeLabel({ runtime: "claude" }), "Claude");
	assert.equal(runtimeLabel({ runtime: "pi" }), "Pi");
	assert.equal(runtimeLabel({ runtime: "codex" }), "Codex");
	assert.equal(runtimeLabel({ runtime: "somenewagent" }), "Somenewagent", "an unknown runtime is named, not hidden");
	assert.equal(runtimeLabel({ family: "pi" }), "Pi", "an older payload with only `family` still gets its badge");
	assert.equal(runtimeLabel({}), "");
	assert.equal(runtimeLabel(null), "");

	assert.equal(agentKindLabel({ role: "lead" }), "Trưởng nhóm");
	assert.equal(agentKindLabel({ role: null, parentId: "p" }), "Agent phụ", "outside the role pack, but started by someone");
	assert.equal(agentKindLabel({ role: null, parentId: null }), "Agent độc lập");
	assert.doesNotMatch(agentKindLabel({ role: null }), /Chưa rõ/, "not a fault");
}

// --- project names -----------------------------------------------------------
assert.equal(projectLabel("d:/code/shop"), "shop");
assert.equal(projectLabel("D:\\Code\\Shop\\"), "Shop", "a Windows path, with a trailing separator");
assert.equal(projectLabel("ws_shop"), "ws_shop", "a workspace id is already a name");
assert.equal(projectLabel(""), "");
assert.equal(projectLabel(null), "");

// --- what an approval is actually about --------------------------------------
// "chạy lệnh trên máy này" is not something a person can answer: the command is
// the decision. It used to be reachable only in advanced mode.
{
	assert.deepEqual(permitDetail({ raw: { input: { command: "npm install left-pad" } } }), { label: "Lệnh", text: "npm install left-pad" });
	assert.deepEqual(permitDetail({ raw: { input: { file_path: "/repo/a.ts", content: "x" } } }), { label: "File", text: "/repo/a.ts" });
	assert.deepEqual(permitDetail({ raw: { rawInput: { url: "https://example.com" } } }), { label: "Địa chỉ", text: "https://example.com" });
	assert.deepEqual(permitDetail({ raw: { command: "ls" } }), { label: "Lệnh", text: "ls" }, "a flat record works too");
	assert.deepEqual(permitDetail({ raw: { input: "plain text" } }), { label: "Nội dung", text: "plain text" });
	assert.equal(permitDetail({ raw: { tool: "bash" } }), null, "nothing to show is null, never an invented summary");
	assert.equal(permitDetail({}), null);
	assert.equal(permitDetail(null), null);
	const long = permitDetail({ raw: { input: { command: "x".repeat(900) } } }, 100);
	assert.equal(long.text.length, 101, "clipped, with an ellipsis");
	assert.ok(long.text.endsWith("…"));
}
assert.equal(statusLabel("initializing"), "Đang khởi động");

// --- a refused config write is explained, not shown as a generic fault --------
{
	const changed = humanizeError({
		stderr: "[paseo-team] CONFIG_CHANGED: /home/u/.pi/agent/settings.json was modified after it was read, so this write would overwrite those changes.",
		code: "CLI_FAILED",
	});
	assert.equal(changed.title, "File cấu hình đã bị sửa ở nơi khác");
	assert.match(changed.advice, /Tải lại/, "and it says what to do next");
	assert.match(changed.advice, /Pi/, "naming the usual culprit");
}

// --- model limits in the sync report ------------------------------------------
{
	assert.equal(formatTokens(1050000), "1.050.000");
	assert.equal(formatTokens(999), "999");
	assert.equal(formatTokens(128000), "128.000");
	assert.deepEqual({ ...PI_DEFAULT_LIMITS }, { contextWindow: 128000, maxTokens: 16384 }, "pi 0.83.0 provider-composer.js:69-70");
	assert.equal(limitCell(200000, "contextWindow"), "200.000");
	assert.equal(limitCell(undefined, "maxTokens"), "chưa biết (Pi dùng 16.384)", "unknown says what pi will use instead");
	assert.equal(limitCell(0, "contextWindow"), "chưa biết (Pi dùng 128.000)", "a non-positive number is not a limit");

	assert.equal(modelLimitsLabel({ contextWindow: 1050000, maxTokens: 128000, limitSource: "models.dev" }), "1.050.000 · 128.000 · models.dev");
	assert.equal(modelLimitsLabel({ contextWindow: 400000, limitSource: "override" }), "400.000 · chưa biết (Pi dùng 16.384) · ghi đè");
	assert.equal(modelLimitsLabel({ limitSource: "unknown" }), "chưa biết (Pi dùng 128.000/16.384)");

	const now = Date.parse("2026-10-11T12:00:00Z");
	assert.equal(limitsOriginSentence(undefined), null, "an older CLI without the field shows nothing, not a guess");
	const fresh = limitsOriginSentence({ origin: "network", fetchedAt: "2026-10-11T12:00:00Z" }, now);
	assert.equal(fresh.level, "ok");
	assert.match(fresh.text, /vừa tải mới/);
	const cached = limitsOriginSentence({ origin: "cache", fetchedAt: "2026-10-11T07:00:00Z" }, now);
	assert.equal(cached.level, "ok");
	assert.match(cached.text, /lưu sẵn trên máy, tải 5 giờ trước/);
	const stale = limitsOriginSentence({ origin: "stale-cache", fetchedAt: "2026-10-08T12:00:00Z", error: "ETIMEDOUT" }, now);
	assert.equal(stale.level, "warn");
	assert.match(stale.text, /\(ETIMEDOUT\).*CŨ, tải 3 ngày trước/);
	const none = limitsOriginSentence({ origin: "unavailable", error: "offline" }, now);
	assert.equal(none.level, "bad");
	assert.match(none.text, /\(offline\).*mặc định của Pi \(128\.000\/16\.384\)/);
	const unwritable = limitsOriginSentence({ origin: "network", fetchedAt: "2026-10-11T12:00:00Z", cacheError: "EACCES" }, now);
	assert.equal(unwritable.level, "warn", "a cache that could not be written is worth knowing");
	assert.match(unwritable.text, /EACCES/);

	assert.equal(syncWarningText("pi-models: models.dev unreachable"), "models.dev unreachable");
	assert.equal(syncWarningText("other: kept"), "other: kept");
}

console.log("humanize tests passed");
