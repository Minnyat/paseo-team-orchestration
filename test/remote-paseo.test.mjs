// remote-paseo.test.mjs — regression tests for scripts/remote-paseo.mjs.
// Run: node test/remote-paseo.test.mjs   (node >= 22)

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CLAUDE_DEFAULT_MODE,
	REMOTE_ERROR_CODES,
	RemoteError,
	buildArgv,
	parseAgentRef,
	parseArgs,
	parseDurationMs,
	readPrompt,
	resolveCmdEntry,
	resolveHost,
	splitAgentRef,
	validateFlags,
	validateRunProvider,
	runCli,
	validateThinking,
	waitForRuntimeIdentity,
	extractRuntimeIdentity,
} from "../scripts/remote-paseo.mjs";
import { loadClusterConfig } from "../scripts/model-routing.mjs";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ROOT = join(import.meta.dirname, "..");
const WRAPPER = join(ROOT, "scripts", "remote-paseo.mjs");
const FAKE = join(ROOT, "test", "fixtures", "fake-paseo.mjs");

const ENDPOINT = "https://app.paseo.sh/#offer=testtoken123";

// npm-generated Windows shims use `%~dp0`, not only the legacy `%dp0%` form.
{
	const shimDir = mkdtempSync(join(tmpdir(), "paseo-cmd-shim-"));
	const entry = join(shimDir, "node_modules", "@getpaseo", "cli", "dist", "index.js");
	mkdirSync(join(shimDir, "node_modules", "@getpaseo", "cli", "dist"), { recursive: true });
	writeFileSync(entry, "// fixture\n");
	const shim = join(shimDir, "paseo.cmd");
	writeFileSync(shim, `@IF EXIST "%~dp0\\node_modules\\@getpaseo\\cli\\dist\\index.js" (\n  "%~dp0\\node_modules\\@getpaseo\\cli\\dist\\index.js" %*\n)\n`);
	assert.equal(resolveCmdEntry(shim), process.platform === "win32" ? entry.replaceAll("/", "\\") : entry);
}

const CLUSTER = {
	version: 1,
	hosts: {
		"win-primary": {
			connection: { type: "local" },
			required: true,
			capabilities: ["git-read", "git-write", "focused-test"],
			limits: { writers: 1, readers: 2 },
			routes: {
				MONITOR_ECONOMY: {
					paseoProvider: "pi-supervisor",
					model: "testprov/model-a",
					thinking: "low",
				},
				FAST_READ: {
					paseoProvider: "pi-peer",
					model: "testprov/model-a",
					thinking: "low",
				},
				CODING_MEDIUM: {
					paseoProvider: "pi-peer",
					model: "testprov/model-b",
					thinking: "medium",
				},
				REASONING_HIGH: {
					paseoProvider: "pi-peer",
					model: "vendor/scoped/deep",
					thinking: "high",
				},
				REVIEW_HIGH: {
					paseoProvider: "pi-peer",
					model: "testprov/model-c",
					thinking: "high",
				},
			},
		},
		"mac-review": {
			connection: { type: "remote", endpointEnv: "PASEO_TEST_ENDPOINT" },
			required: true,
			capabilities: ["git-read", "independent-review"],
			limits: { writers: 0, readers: 2 },
			routes: {
				MONITOR_ECONOMY: {
					paseoProvider: "pi-supervisor",
					model: "testprov/model-a",
					thinking: "low",
				},
				FAST_READ: {
					paseoProvider: "pi-peer",
					model: "testprov/model-a",
					thinking: "low",
				},
				CODING_MEDIUM: {
					paseoProvider: "pi-peer",
					model: "testprov/model-b",
					thinking: "medium",
				},
				REASONING_HIGH: {
					paseoProvider: "pi-peer",
					model: "vendor/scoped/deep",
					thinking: "high",
				},
				REVIEW_HIGH: {
					paseoProvider: "pi-peer",
					model: "testprov/model-c",
					thinking: "high",
				},
			},
		},
	},
};

const SAVED_ENV = { ...process.env };

function makeHome() {
	const home = mkdtempSync(join(tmpdir(), "paseo-remote-test-"));
	writeFileSync(
		join(home, "cluster-routing.local.json"),
		JSON.stringify(CLUSTER, null, 2),
	);
	return home;
}

/** Run the wrapper as a child process with an isolated PASEO_TEAM_HOME. */
function runWrapper(
	args,
	{ home, endpoint = ENDPOINT, omitEndpoint = false, extraEnv = {} } = {},
) {
	const h = home ?? makeHome();
	const env = {
		...SAVED_ENV,
		PASEO_TEAM_HOME: h,
		PASEO_TEAM_PASEO_EXEC: `node "${FAKE}"`,
		...extraEnv,
	};
	// Do not let a developer/CI-level endpoint leak into the missing-endpoint
	// test; omission must mean absent even when the parent environment exports it.
	if (omitEndpoint) delete env.PASEO_TEST_ENDPOINT;
	else if (!Object.hasOwn(extraEnv, "PASEO_TEST_ENDPOINT")) env.PASEO_TEST_ENDPOINT = endpoint;
	const res = spawnSync(process.execPath, [WRAPPER, ...args], {
		encoding: "utf8",
		env,
		timeout: 60000,
	});
	let json = null;
	try {
		json = JSON.parse(res.stdout);
	} catch {
		/* leave null */
	}
	return { code: res.status, stdout: res.stdout, stderr: res.stderr, json };
}

function expectRemoteError(code, fn) {
	try {
		fn();
	} catch (error) {
		assert.ok(
			error instanceof RemoteError,
			`expected RemoteError, got ${error}`,
		);
		assert.equal(
			error.code,
			code,
			`expected code ${code}, got "${error.code}" (${error.message})`,
		);
		return error;
	}
	assert.fail(`expected RemoteError(${code}) but nothing was thrown`);
}

function withEndpoint(value) {
	const prev = process.env.PASEO_TEST_ENDPOINT;
	// Assigning undefined to process.env stores the STRING "undefined" — to
	// simulate a missing var the key must be deleted.
	if (value === undefined) delete process.env.PASEO_TEST_ENDPOINT;
	else process.env.PASEO_TEST_ENDPOINT = value;
	return () => {
		if (prev === undefined) delete process.env.PASEO_TEST_ENDPOINT;
		else process.env.PASEO_TEST_ENDPOINT = prev;
	};
}

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

{
	const t = "parseArgs: flags and camelCase";
	const out = parseArgs([
		"models",
		"--host-id",
		"mac-review",
		"--provider",
		"pi-peer",
		"--json",
	]);
	assert.equal(out._[0], "models", t);
	assert.equal(out.hostId, "mac-review", t);
	assert.equal(out.provider, "pi-peer", t);
	assert.equal(out.json, true, t);
}

{
	const t = "parseArgs: boolean flags";
	const out = parseArgs([
		"run",
		"--host-id",
		"h",
		"--provider",
		"p",
		"--thinking",
		"low",
		"--prompt",
		"x",
		"--dry-run",
		"--no-wait",
	]);
	assert.equal(out.dryRun, true, t);
	assert.equal(out.noWait, true, t);
}

{
	const out = parseArgs(["models", "--worksapce", "x"]);
	expectRemoteError("USAGE", () => validateFlags("models", out));
}

{
	const out = parseArgs(["models", "--host-id"]);
	expectRemoteError("USAGE", () => validateFlags("models", out));
}

{
	const out = parseArgs(["models", "--host-id", "mac-review"]);
	validateFlags("models", out);
}

{
	const out = parseArgs([
		"run",
		"--host-id",
		"h",
		"--provider",
		"p",
		"--thinking",
		"low",
		"--prompt",
		"x",
		"--json",
	]);
	validateFlags("run", out);
}

// ---------------------------------------------------------------------------
// resolveHost
// ---------------------------------------------------------------------------

{
	expectRemoteError("HOST_NOT_FOUND", () =>
		resolveHost(loadClusterConfigFromFixture(), "nope"),
	);
}

{
	expectRemoteError("LOCAL_HOST_UNSUPPORTED", () =>
		resolveHost(loadClusterConfigFromFixture(), "win-primary"),
	);
}

{
	const restore = withEndpoint(undefined);
	try {
		expectRemoteError("ENDPOINT_ENV_MISSING", () =>
			resolveHost(loadClusterConfigFromFixture(), "mac-review"),
		);
	} finally {
		restore();
	}
}

{
	const restore = withEndpoint("not an endpoint value with spaces");
	try {
		expectRemoteError("ENDPOINT_UNSAFE", () =>
			resolveHost(loadClusterConfigFromFixture(), "mac-review"),
		);
	} finally {
		restore();
	}
}

{
	const t = "resolveHost: % expansion risk only on win32";
	const restore = withEndpoint("tcp://host:6767?ssl=true&password=abc%def%");
	try {
		// linux/mac: the value is structurally valid → no error
		const host = resolveHost(loadClusterConfigFromFixture(), "mac-review", {
			platform: "darwin",
		});
		assert.equal(
			host.endpoint,
			"tcp://host:6767?ssl=true&password=abc%def%",
			t,
		);
		// win32: refused
		expectRemoteError("ENDPOINT_UNSAFE", () =>
			resolveHost(loadClusterConfigFromFixture(), "mac-review", {
				platform: "win32",
			}),
		);
	} finally {
		restore();
	}
}

{
	const t = "resolveHost: valid remote host returns endpoint internally";
	const restore = withEndpoint(ENDPOINT);
	try {
		const host = resolveHost(loadClusterConfigFromFixture(), "mac-review");
		assert.equal(host.hostId, "mac-review", t);
		assert.equal(host.endpointEnv, "PASEO_TEST_ENDPOINT", t);
		assert.equal(host.endpoint, ENDPOINT, t);
	} finally {
		restore();
	}
}

function loadClusterConfigFromFixture() {
	const home = makeHome();
	return loadClusterConfig(join(home, "cluster-routing.local.json"));
}

// ---------------------------------------------------------------------------
// splitAgentRef / parseAgentRef
// ---------------------------------------------------------------------------

{
	const t = "splitAgentRef: splits at first slash";
	assert.deepEqual(
		splitAgentRef("mac-review/abc-123"),
		{ hostId: "mac-review", agentId: "abc-123" },
		t,
	);
	assert.deepEqual(splitAgentRef("h/a/b"), { hostId: "h", agentId: "a/b" }, t);
}

{
	expectRemoteError("USAGE", () => splitAgentRef(""));
	expectRemoteError("USAGE", () => splitAgentRef("no-slash"));
	expectRemoteError("USAGE", () => splitAgentRef("/agent"));
	expectRemoteError("USAGE", () => splitAgentRef("host/"));
}

{
	const restore = withEndpoint(ENDPOINT);
	try {
		expectRemoteError("LOCAL_HOST_UNSUPPORTED", () =>
			parseAgentRef("win-primary/abc", loadClusterConfigFromFixture()),
		);
	} finally {
		restore();
	}
}

// ---------------------------------------------------------------------------
// validateRunProvider / validateThinking / readPrompt
// ---------------------------------------------------------------------------

{
	const t = "validateRunProvider: canonical form";
	const out = validateRunProvider("pi-peer/openrouter/vendor/model-name");
	assert.equal(out.provider, "pi-peer/openrouter/vendor/model-name", t);
	assert.equal(out.roleProvider, "pi-peer", t);
	assert.equal(out.model, "openrouter/vendor/model-name", t);
}

{
	expectRemoteError("USAGE", () => validateRunProvider("pi-executive/x/y"));
}

{
	expectRemoteError("USAGE", () => validateRunProvider("pi-peer"));
	expectRemoteError("USAGE", () => validateRunProvider("pi-peer/testprov"));
	expectRemoteError("USAGE", () => validateRunProvider("pi-peer//model"));
}

{
	validateThinking("high");
	expectRemoteError("USAGE", () => validateThinking("turbo"));
	expectRemoteError("USAGE", () => validateThinking(undefined));
}

{
	const t = "readPrompt: --prompt vs --brief";
	assert.equal(readPrompt({ prompt: "do the thing" }), "do the thing", t);
	assert.equal(readPrompt({ prompt: "  padded  " }), "padded", t);
	expectRemoteError("USAGE", () => readPrompt({}));
	expectRemoteError("USAGE", () => readPrompt({ prompt: "a", brief: "b" }));
}

// ---------------------------------------------------------------------------
// buildArgv — exact paseo CLI argv per command (endpoint embedded)
// ---------------------------------------------------------------------------

const EP = "https://app.paseo.sh/#offer=tok";

{
	const t = "buildArgv: health";
	assert.deepEqual(
		buildArgv("health", {}, EP),
		["ls", "--host", EP, "--json"],
		t,
	);
}

{
	const t = "buildArgv: providers";
	assert.deepEqual(
		buildArgv("providers", {}, EP),
		["provider", "ls", "--host", EP, "--json"],
		t,
	);
}

{
	const t = "buildArgv: models";
	assert.deepEqual(
		buildArgv("models", { provider: "pi-peer" }, EP),
		["provider", "models", "pi-peer", "--host", EP, "--json"],
		t,
	);
	expectRemoteError("USAGE", () => buildArgv("models", {}, EP));
}

{
	const t = "buildArgv: workspaces";
	assert.deepEqual(
		buildArgv("workspaces", {}, EP),
		["workspace", "ls", "--host", EP, "--json"],
		t,
	);
}

{
	const t = "buildArgv: workspace-create";
	assert.deepEqual(
		buildArgv(
			"workspace-create",
			{
				path: "/Users/admin/repo",
				isolation: "local",
				title: "remote-repository",
			},
			EP,
		),
		[
			"workspace",
			"create",
			"--host",
			EP,
			"--path",
			"/Users/admin/repo",
			"--isolation",
			"local",
			"--title",
			"remote-repository",
			"--json",
		],
		t,
	);
}

{
	const t = "buildArgv: workspace-create validates --isolation values";
	expectRemoteError("USAGE", () =>
		buildArgv(
			"workspace-create",
			{ path: "/Users/admin/repo", isolation: "worktee" },
			EP,
		),
	);
	assert.ok(
		buildArgv(
			"workspace-create",
			{ path: "/Users/admin/repo", isolation: "worktree" },
			EP,
		).includes("worktree"),
		t,
	);
}

{
	const t = "buildArgv: independent-reviewer disposition forces worktree isolation";
	// Unspecified isolation defaults to worktree for a reviewer workspace.
	const argv = buildArgv(
		"workspace-create",
		{
			path: "/Users/admin/repo",
			disposition: "independent-reviewer",
			title: "review-workspace",
		},
		EP,
	);
	const isolationIndex = argv.indexOf("--isolation");
	assert.ok(isolationIndex !== -1 && argv[isolationIndex + 1] === "worktree", t);
	// Explicit worktree is accepted unchanged.
	assert.ok(
		buildArgv(
			"workspace-create",
			{
				path: "/Users/admin/repo",
				disposition: "independent-reviewer",
				isolation: "worktree",
			},
			EP,
		).includes("worktree"),
		t,
	);
	// Local isolation for a reviewer is a hard error, never a silent fallback.
	expectRemoteError("REVIEW_ISOLATION_INVALID", () =>
		buildArgv(
			"workspace-create",
			{
				path: "/Users/admin/repo",
				disposition: "independent-reviewer",
				isolation: "local",
			},
			EP,
		),
	);
	// Non-reviewer dispositions do not force isolation.
	assert.ok(
		!buildArgv(
			"workspace-create",
			{ path: "/Users/admin/repo", disposition: "engineer" },
			EP,
		).includes("--isolation"),
		t,
	);
	// A misspelled disposition fails closed instead of silently skipping the
	// reviewer worktree enforcement.
	expectRemoteError("USAGE", () =>
		buildArgv(
			"workspace-create",
			{ path: "/Users/admin/repo", disposition: "independent-reviwer" },
			EP,
		),
	);
}

{
	const t = "buildArgv: agents";
	assert.deepEqual(
		buildArgv("agents", {}, EP),
		["ls", "--host", EP, "-g", "--json"],
		t,
	);
	assert.deepEqual(
		buildArgv("agents", { all: true }, EP),
		["ls", "-a", "--host", EP, "-g", "--json"],
		t,
	);
}

{
	const t = "buildArgv: run defaults to background, prompt last";
	const argv = buildArgv(
		"run",
		{
			provider: "pi-peer/testprov/model-b",
			thinking: "medium",
			workspace: "wks-1",
			title: "t",
			label: ["team.cluster=d:/code/shop"],
			prompt: "fix it now",
		},
		EP,
	);
	assert.deepEqual(
		argv,
		[
			"run",
			"--host",
			EP,
			"--provider",
			"pi-peer/testprov/model-b",
			"--thinking",
			"medium",
			"--workspace",
			"wks-1",
			"--title",
			"t",
			"--label",
			"team.cluster=d:/code/shop",
			"-d",
			"--json",
			"fix it now",
		],
		t,
	);
}

{
	// Paseo refuses to inherit a permission mode across providers, so a claude-*
	// create must carry one. The pack supplies "auto": what bounds the new seat
	// is its role policy and its V3 brief, both enforced before Paseo's
	// permission queue sees the call, and "default" parks every one of that
	// seat's tool calls in the queue — the seat looks hung and its Lead spends
	// the turn triaging instead of leading.
	const t = "buildArgv: a claude-* route with no --mode defaults to auto";
	const argv = buildArgv(
		"run",
		{
			provider: "claude-peer/claude-opus-5",
			thinking: "medium",
			workspace: "wks-1",
			label: ["team.cluster=d:/code/shop"],
			prompt: "go",
		},
		EP,
	);
	assert.ok(argv.includes("--mode"), t);
	assert.equal(argv[argv.indexOf("--mode") + 1], CLAUDE_DEFAULT_MODE, t);
	assert.equal(CLAUDE_DEFAULT_MODE, "auto", t);
	// One rule, one value: this module keeps its own literal so `--help` and the
	// argument checks stay synchronous (policy-core is loaded lazily deep inside
	// main), and this is what stops the two copies drifting apart. Every other
	// creation path in the pack — the create_agent gate, team-fork's post-import
	// move — reads the core's constant directly.
	const { CLAUDE_DEFAULT_SEAT_MODE } = await import(
		"../extensions/paseo-team-core/policy-core.ts"
	);
	assert.equal(CLAUDE_DEFAULT_MODE, CLAUDE_DEFAULT_SEAT_MODE, t);
}

{
	const t = "buildArgv: an explicit --mode still wins over the default";
	const argv = buildArgv(
		"run",
		{
			provider: "claude-peer/claude-opus-5",
			thinking: "medium",
			workspace: "wks-1",
			mode: "plan",
			label: ["team.cluster=d:/code/shop"],
			prompt: "go",
		},
		EP,
	);
	assert.equal(argv[argv.indexOf("--mode") + 1], "plan", t);
}

{
	// pi declares no modes at all, so nothing is required and nothing is added.
	const t = "buildArgv: a pi route gets no --mode";
	const argv = buildArgv(
		"run",
		{
			provider: "pi-peer/testprov/model-b",
			thinking: "medium",
			workspace: "wks-1",
			label: ["team.cluster=d:/code/shop"],
			prompt: "go",
		},
		EP,
	);
	assert.ok(!argv.includes("--mode"), t);
}

{
	const t = "buildArgv: run passes through every --label, in order, alongside the required one";
	const argv = buildArgv(
		"run",
		{
			provider: "pi-peer/testprov/model-b",
			thinking: "medium",
			workspace: "wks-1",
			label: ["team.domain=backend", "team.cluster=d:/code/shop"],
			prompt: "x",
		},
		EP,
	);
	const labelFlags = argv.flatMap((value, i) => (argv[i - 1] === "--label" ? [value] : []));
	assert.deepEqual(labelFlags, ["team.domain=backend", "team.cluster=d:/code/shop"], t);
}

{
	const t = "buildArgv: run without a team.cluster label is refused";
	const error = expectRemoteError("USAGE", () =>
		buildArgv(
			"run",
			{
				provider: "pi-peer/testprov/model-b",
				thinking: "medium",
				workspace: "wks-1",
				prompt: "x",
			},
			EP,
		),
	);
	assert.match(error.message, /team\.cluster/, t);
	assert.match(error.message, /--label/, t);
}

{
	const t = "buildArgv: run refuses a repeated --label key fail-closed, never silently overwrites";
	const error = expectRemoteError("USAGE", () =>
		buildArgv(
			"run",
			{
				provider: "pi-peer/testprov/model-b",
				thinking: "medium",
				workspace: "wks-1",
				label: ["team.cluster=d:/code/shop", "team.cluster=d:/code/blog"],
				prompt: "x",
			},
			EP,
		),
	);
	assert.match(error.message, /more than once/, t);
}

{
	const t = "buildArgv: run --wait-timeout replaces -d";
	const argv = buildArgv(
		"run",
		{
			provider: "pi-peer/testprov/model-b",
			thinking: "medium",
			workspace: "wks-1",
			label: ["team.cluster=d:/code/shop"],
			prompt: "x",
			waitTimeout: "2m",
		},
		EP,
	);
	assert.ok(argv.includes("--wait-timeout") && argv.includes("2m"), t);
	assert.ok(!argv.includes("-d"), t);
}

{
	expectRemoteError("USAGE", () =>
		buildArgv(
			"run",
			{ provider: "pi-peer/testprov/model-b", thinking: "medium", prompt: "x" },
			EP,
		),
	);
}

{
	expectRemoteError("USAGE", () =>
		buildArgv("workspace-create", { isolation: "local" }, EP),
	);
}

{
	expectRemoteError("USAGE", () =>
		buildArgv(
			"run",
			{
				provider: "pi-peer/testprov/model-b",
				thinking: "medium",
				workspace: "wks-1",
				label: ["team.cluster=d:/code/shop"],
				prompt: "x",
				waitTimeout: "2m",
				background: true,
			},
			EP,
		),
	);
}

{
	const t = "buildArgv: status";
	assert.deepEqual(
		buildArgv("status", { agentRef: "mac-review/abc-123" }, EP),
		["inspect", "abc-123", "--host", EP, "--json"],
		t,
	);
}

{
	const t = "buildArgv: cancel → paseo stop";
	assert.deepEqual(
		buildArgv("cancel", { agentRef: "mac-review/abc-123" }, EP),
		["stop", "abc-123", "--host", EP, "--json"],
		t,
	);
}

{
	const t = "buildArgv: archive → paseo archive";
	assert.deepEqual(
		buildArgv("archive", { agentRef: "mac-review/abc-123" }, EP),
		["archive", "abc-123", "--host", EP, "--json"],
		t,
	);
}

{
	const t = "buildArgv: send defaults to --no-wait";
	assert.deepEqual(
		buildArgv(
			"send",
			{ agentRef: "mac-review/abc-123", prompt: "follow up" },
			EP,
		),
		[
			"send",
			"abc-123",
			"--host",
			EP,
			"--prompt",
			"follow up",
			"--no-wait",
			"--json",
		],
		t,
	);
}

{
	const t = "buildArgv: send --wait omits --no-wait; --prompt-file wins";
	const home = makeHome();
	const promptFile = join(home, "msg.txt");
	writeFileSync(promptFile, "follow up text", "utf8");
	assert.deepEqual(
		buildArgv(
			"send",
			{ agentRef: "mac-review/abc-123", promptFile, wait: true },
			EP,
		),
		["send", "abc-123", "--host", EP, "--prompt-file", promptFile, "--json"],
		t,
	);
}

assert.deepEqual(
	extractRuntimeIdentity({ snapshot: { runtimeInfo: { model: "m", thinkingOptionId: "t" } } }),
	{ model: "m", thinking: "t" },
);
assert.deepEqual(
	extractRuntimeIdentity({ data: { snapshot: { runtimeInfo: { model: "m2", thinkingOptionId: "t2" } } } }),
	{ model: "m2", thinking: "t2" },
);
assert.deepEqual(
	extractRuntimeIdentity({ Model: "  ", Thinking: 42 }),
	{ model: null, thinking: null },
);
assert.deepEqual(
	extractRuntimeIdentity({ data: { Model: "m3", Thinking: "t3" } }),
	{ model: "m3", thinking: "t3" },
);

// ---------------------------------------------------------------------------
// Startup identity polling
// ---------------------------------------------------------------------------

{
	const responses = [
		{ ok: true, stdout: JSON.stringify({ Status: "running" }) },
		{ ok: true, stdout: JSON.stringify({ runtimeInfo: { model: "testprov/model-b", thinkingOptionId: "medium" } }) },
	];
	const result = waitForRuntimeIdentity({
		requested: { model: "testprov/model-b", thinking: "medium" },
		status: () => responses.shift(),
		timeoutMs: 100,
		intervalMs: 0,
		now: (() => { let t = 0; return () => t++; })(),
		sleep: () => {},
	});
	assert.equal(result.state, "ready");
	assert.equal(result.attempts, 2);
}

{
	const result = waitForRuntimeIdentity({
		requested: { model: "testprov/model-b", thinking: "medium" },
		status: () => ({ ok: true, stdout: JSON.stringify({ Status: "running" }) }),
		timeoutMs: 0,
		intervalMs: 0,
		now: () => 1,
		sleep: () => {},
	});
	assert.equal(result.state, "unavailable");
}

{
	let calls = 0;
	const result = waitForRuntimeIdentity({
		requested: { model: "testprov/model-b", thinking: "medium" },
		status: () => {
			calls++;
			return { ok: true, stdout: JSON.stringify({ Status: "running" }) };
		},
		timeoutMs: 100,
		intervalMs: Number.POSITIVE_INFINITY,
		now: (() => { let t = 0; return () => t++; })(),
		sleep: () => {},
		maxAttempts: 3,
	});
	assert.equal(result.state, "unavailable");
	assert.equal(calls, 3, "polling has an explicit attempt bound");
}

{
	const result = waitForRuntimeIdentity({
		requested: { model: "testprov/model-b", thinking: "medium" },
		status: () => ({ ok: true, stdout: JSON.stringify({ runtimeInfo: { model: "testprov/model-a", thinkingOptionId: "medium" } }) }),
		timeoutMs: 100,
	});
	assert.equal(result.state, "mismatch");
}

// ---------------------------------------------------------------------------
// End-to-end: wrapper subprocess against the fake CLI
// ---------------------------------------------------------------------------

{
	const t = "e2e: models envelope carries hostId and remote data";
	const r = runWrapper([
		"models",
		"--host-id",
		"mac-review",
		"--provider",
		"pi-peer",
	]);
	assert.equal(r.code, 0, `${t} (stderr: ${r.stderr})`);
	assert.equal(r.json.ok, true, t);
	assert.equal(r.json.hostId, "mac-review", t);
	assert.equal(r.json.endpointEnv, "PASEO_TEST_ENDPOINT", t);
	assert.equal(r.json.endpointSet, true, t);
	assert.deepEqual(
		r.json.data,
		{
			argv: [
				"provider",
				"models",
				"pi-peer",
				"--host",
				"<host-redacted>",
				"--json",
			],
		},
		t,
	);
}

{
	const t = "e2e: endpoint value never appears in wrapper output";
	const r = runWrapper([
		"models",
		"--host-id",
		"mac-review",
		"--provider",
		"pi-peer",
	]);
	assert.ok(!r.stdout.includes(ENDPOINT), `${t}: stdout leaked endpoint`);
	assert.ok(!r.stderr.includes(ENDPOINT), `${t}: stderr leaked endpoint`);
}

{
	const t = "e2e: run returns agentRef composite";
	const r = runWrapper([
		"run",
		"--host-id",
		"mac-review",
		"--provider",
		"pi-peer/testprov/model-b",
		"--thinking",
		"medium",
		"--workspace",
		"wks-1",
		"--title",
		"remote-job",
		"--prompt",
		"implement the feature",
	], {
		extraEnv: {
			FAKE_PASEO_RUNTIME_MODEL: "testprov/model-b",
			FAKE_PASEO_RUNTIME_THINKING: "medium",
			FAKE_PASEO_NEST_RUNTIME: "1",
		},
	});
	assert.equal(r.code, 0, `${t} (stderr: ${r.stderr})`);
	assert.equal(r.json.ok, true, t);
	assert.equal(
		r.json.agentRef,
		"mac-review/9f8e7d6c-0000-0000-0000-000000000000",
		t,
	);
	const data = r.json.data;
	assert.equal(data.agentId, "9f8e7d6c-0000-0000-0000-000000000000", t);
	assert.equal(data.status, "running", t);
	assert.equal(r.json.startupIdentity.state, "ready", t);
}

{
	// §PR-G follow-up: run with no --label at all still auto-fills team.cluster
	// from this seat's own selfCluster() (here, the child process's own cwd —
	// there is no PASEO_AGENT_ID/state file in this harness).
	const t = "e2e: run auto-fills team.cluster when no --label sets one";
	const r = runWrapper([
		"run", "--host-id", "mac-review", "--provider", "pi-peer/testprov/model-b",
		"--thinking", "medium", "--workspace", "wks-1", "--prompt", "auto-fill",
	], {
		extraEnv: {
			FAKE_PASEO_RUNTIME_MODEL: "testprov/model-b",
			FAKE_PASEO_RUNTIME_THINKING: "medium",
			FAKE_PASEO_NEST_RUNTIME: "1",
		},
	});
	assert.equal(r.code, 0, `${t} (stderr: ${r.stderr})`);
	assert.equal(
		r.json.data.labels.filter((l) => l.startsWith("team.cluster=")).length,
		1,
		t,
	);
}

{
	// An explicit --label team.cluster=... must survive untouched — auto-fill
	// only fires when the caller did not already declare one.
	const t = "e2e: an explicit --label team.cluster is not overridden by auto-fill";
	const r = runWrapper([
		"run", "--host-id", "mac-review", "--provider", "pi-peer/testprov/model-b",
		"--thinking", "medium", "--workspace", "wks-1",
		"--label", "team.cluster=explicit-value",
		"--label", "team.domain=backend",
		"--prompt", "explicit-label",
	], {
		extraEnv: {
			FAKE_PASEO_RUNTIME_MODEL: "testprov/model-b",
			FAKE_PASEO_RUNTIME_THINKING: "medium",
			FAKE_PASEO_NEST_RUNTIME: "1",
		},
	});
	assert.equal(r.code, 0, `${t} (stderr: ${r.stderr})`);
	assert.deepEqual(
		r.json.data.labels,
		["team.cluster=explicit-value", "team.domain=backend"],
		t,
	);
}

{
	const t = "e2e: missing agent id is explicit and does not archive";
	const r = runWrapper([
		"run", "--host-id", "mac-review", "--provider", "pi-peer/testprov/model-b",
		"--thinking", "medium", "--workspace", "wks-1", "--prompt", "missing-id",
	], { extraEnv: { FAKE_PASEO_NO_AGENT_ID: "1" } });
	assert.equal(r.code, 2, `${t} (stderr: ${r.stderr})`);
	assert.equal(r.json.code, "AGENT_REF_UNAVAILABLE", t);
	assert.equal(r.json.archive, undefined, t);
}

{
	const t = "e2e: startup identity unavailable does not archive";
	const home = makeHome();
	const archiveMarker = join(home, "archive-called");
	const r = runWrapper([
		"run", "--host-id", "mac-review", "--provider", "pi-peer/testprov/model-b",
		"--thinking", "medium", "--workspace", "wks-1", "--prompt", "wait",
		"--startup-timeout", "1ms",
	], {
		home,
		extraEnv: { FAKE_PASEO_NO_RUNTIME: "1", FAKE_PASEO_ARCHIVE_MARKER: archiveMarker },
	});
	assert.equal(r.code, 2, `${t} (stderr: ${r.stderr})`);
	assert.equal(r.json.code, "STARTUP_IDENTITY_UNAVAILABLE", t);
	assert.equal(r.json.startupIdentity.state, "unavailable", t);
	assert.equal(r.json.archive, undefined, t);
	assert.equal(existsSync(archiveMarker), false, `${t}: archive side effect`);
}

{
	const t = "e2e: confirmed identity mismatch archives exactly once";
	const home = makeHome();
	const archiveMarker = join(home, "archive-called");
	const r = runWrapper([
		"run", "--host-id", "mac-review", "--provider", "pi-peer/testprov/model-b",
		"--thinking", "medium", "--workspace", "wks-1", "--prompt", "mismatch",
	], {
		home,
		extraEnv: {
			FAKE_PASEO_RUNTIME_MODEL: "testprov/model-a",
			FAKE_PASEO_RUNTIME_THINKING: "medium",
			FAKE_PASEO_ARCHIVE_MARKER: archiveMarker,
		},
	});
	assert.equal(r.code, 2, `${t} (stderr: ${r.stderr})`);
	assert.equal(r.json.code, "MODEL_RESOLUTION_MISMATCH", t);
	assert.equal(r.json.archive.ok, true, t);
	assert.equal(readFileSync(archiveMarker, "utf8"), "9f8e7d6c-0000-0000-0000-000000000000", t);
}

{
	const t = "e2e: mismatch archive failure remains explicit";
	const r = runWrapper([
		"run", "--host-id", "mac-review", "--provider", "pi-peer/testprov/model-b",
		"--thinking", "medium", "--workspace", "wks-1", "--prompt", "mismatch",
	], {
		extraEnv: {
			FAKE_PASEO_RUNTIME_MODEL: "testprov/model-a",
			FAKE_PASEO_RUNTIME_THINKING: "medium",
			FAKE_PASEO_ARCHIVE_FAIL: "1",
		},
	});
	assert.equal(r.code, 2, `${t} (stderr: ${r.stderr})`);
	assert.equal(r.json.code, "MODEL_RESOLUTION_MISMATCH", t);
	assert.equal(r.json.archive.ok, false, t);
}

{
	const t = "e2e: cancel/archive resolve host from agent-ref";
	for (const cmd of ["cancel", "archive"]) {
		const r = runWrapper([
			cmd,
			"--agent-ref",
			"mac-review/9f8e7d6c-0000-0000-0000-000000000000",
		]);
		assert.equal(r.code, 0, `${t}:${cmd} (stderr: ${r.stderr})`);
		assert.equal(r.json.ok, true, `${t}:${cmd}`);
		assert.equal(r.json.hostId, "mac-review", `${t}:${cmd}`);
	}
}

{
	const t = "e2e: status via agent-ref resolves host from ref";
	const r = runWrapper([
		"status",
		"--agent-ref",
		"mac-review/9f8e7d6c-0000-0000-0000-000000000000",
	]);
	assert.equal(r.code, 0, `${t} (stderr: ${r.stderr})`);
	assert.equal(r.json.ok, true, t);
	assert.equal(r.json.hostId, "mac-review", t);
	assert.equal(r.json.data.Model, "testprov/model-a", t);
}

{
	const t = "e2e: missing endpoint env → exit 1, code ENDPOINT_ENV_MISSING";
	const r = runWrapper(["health", "--host-id", "mac-review"], {
		omitEndpoint: true,
	});
	assert.equal(r.code, 1, t);
	assert.equal(r.json.ok, false, t);
	assert.equal(r.json.code, "ENDPOINT_ENV_MISSING", t);
	assert.ok(r.json.message.includes("PASEO_TEST_ENDPOINT"), t);
}

{
	const t = "e2e: local host via wrapper → exit 1, LOCAL_HOST_UNSUPPORTED";
	const r = runWrapper(["health", "--host-id", "win-primary"]);
	assert.equal(r.code, 1, t);
	assert.equal(r.json.code, "LOCAL_HOST_UNSUPPORTED", t);
	assert.ok(r.json.message.toLowerCase().includes("mcp"), t);
}

{
	const t = "e2e: unknown host → exit 1, HOST_NOT_FOUND";
	const r = runWrapper(["health", "--host-id", "ghost"]);
	assert.equal(r.code, 1, t);
	assert.equal(r.json.code, "HOST_NOT_FOUND", t);
}

{
	const t =
		"e2e: CLI failure → exit 2, CLI_ERROR, endpoint redacted in error output";
	// Drive the fake into its failure path: a brief file whose content is
	// "--fail" lands as the paseo run positional argv, and the fake prints
	// the endpoint value into ITS OWN stderr (simulating a leaky CLI). The
	// wrapper must surface CLI_ERROR with the endpoint redacted.
	const home = makeHome();
	const brief = join(home, "fail-brief.txt");
	writeFileSync(brief, "--fail\n", "utf8");
	const r = runWrapper(
		[
			"run",
			"--host-id",
			"mac-review",
			"--provider",
			"pi-peer/testprov/model-b",
			"--thinking",
			"medium",
			"--workspace",
			"wks-1",
			"--brief",
			brief,
		],
		{ home },
	);
	assert.equal(r.code, 2, `${t} (got ${r.code}: ${r.stdout})`);
	assert.equal(r.json.ok, false, t);
	assert.equal(r.json.code, "CLI_ERROR", t);
	assert.ok(!r.stdout.includes(ENDPOINT), `${t}: endpoint leaked in error`);
	assert.ok(r.stdout.includes("<endpoint-value-redacted>"), t);
}

{
	const t =
		"e2e: reviewer worktree creation failure → REVIEW_WORKTREE_UNAVAILABLE, not CLI_ERROR";
	const r = runWrapper(
		[
			"workspace-create",
			"--host-id",
			"mac-review",
			"--path",
			"/Users/admin/repo",
			"--disposition",
			"independent-reviewer",
		],
		{ extraEnv: { FAKE_PASEO_WORKSPACE_CREATE_FAIL: "1" } },
	);
	assert.equal(r.code, 2, `${t} (got ${r.code}: ${r.stdout})`);
	assert.equal(r.json.ok, false, t);
	assert.equal(r.json.code, "REVIEW_WORKTREE_UNAVAILABLE", t);
	assert.match(r.json.message, /REVIEW_WORKTREE_UNAVAILABLE/, t);
	assert.match(r.json.message, /never fall back/i, t);
}

{
	const t =
		"e2e: non-reviewer workspace-create failure stays CLI_ERROR";
	const r = runWrapper(
		[
			"workspace-create",
			"--host-id",
			"mac-review",
			"--path",
			"/Users/admin/repo",
		],
		{ extraEnv: { FAKE_PASEO_WORKSPACE_CREATE_FAIL: "1" } },
	);
	assert.equal(r.code, 2, `${t} (got ${r.code}: ${r.stdout})`);
	assert.equal(r.json.code, "CLI_ERROR", t);
}

{
	const t = "successful CLI output is redacted at the wrapper boundary";
	const home = makeHome();
	const previous = process.env.FAKE_PASEO_LEAK_ENDPOINT;
	process.env.FAKE_PASEO_LEAK_ENDPOINT = "1";
	try {
		const r = runWrapper(["providers", "--host-id", "mac-review"], { home, extraEnv: { FAKE_PASEO_LEAK_ENDPOINT: "1" } });
		assert.equal(r.code, 0, t);
		assert.ok(!r.stdout.includes(ENDPOINT), t);
		assert.ok(r.stdout.includes("<endpoint-value-redacted>"), t);
	} finally {
		if (previous === undefined) delete process.env.FAKE_PASEO_LEAK_ENDPOINT;
		else process.env.FAKE_PASEO_LEAK_ENDPOINT = previous;
	}
}

{
	const t = "e2e: dry-run redacts endpoint and never executes";
	const r = runWrapper(["providers", "--host-id", "mac-review", "--dry-run"]);
	assert.equal(r.code, 0, t);
	assert.equal(r.json.dryRun, true, t);
	assert.equal(r.json.ok, true, t);
	assert.ok(!r.stdout.includes(ENDPOINT), t);
	assert.deepEqual(
		r.json.argv,
		["provider", "ls", "--host", "<redacted:PASEO_TEST_ENDPOINT>", "--json"],
		t,
	);
}

{
	const t = "e2e: invalid provider shape → exit 1 USAGE";
	const r = runWrapper([
		"run",
		"--host-id",
		"mac-review",
		"--provider",
		"pi-peer",
		"--thinking",
		"low",
		"--prompt",
		"x",
	]);
	assert.equal(r.code, 1, t);
	assert.equal(r.json.code, "USAGE", t);
}

{
	const t = "invalid wait timeout is rejected before the CLI and never becomes unbounded";
	const home = makeHome();
	const r = runWrapper([
		"run", "--host-id", "mac-review", "--provider", "pi-peer/testprov/model-b",
		"--thinking", "medium", "--workspace", "wks-1", "--prompt", "x",
		"--wait-timeout", "not-a-duration",
	], { home });
	assert.equal(r.code, 1, t);
	assert.equal(r.json.code, "USAGE", t);
}

{
	const t = "parseDurationMs: paseo duration strings";
	assert.equal(parseDurationMs("500ms"), 500, t);
	assert.equal(parseDurationMs("30s"), 30000, t);
	assert.equal(parseDurationMs("2m"), 120000, t);
	assert.equal(parseDurationMs("1h"), 3600000, t);
	assert.equal(parseDurationMs("90"), 90000, t);
	assert.equal(parseDurationMs("nonsense"), null, t);
}

{
	const t = "e2e: help exits 0";
	const r = runWrapper(["--help"]);
	assert.equal(r.code, 0, t);
	assert.ok(r.stdout.includes("remote-paseo.mjs"), t);
}

{
	const t = "REMOTE_ERROR_CODES exports the documented set";
	for (const code of [
		"USAGE",
		"CLUSTER_CONFIG_INVALID",
		"HOST_NOT_FOUND",
		"LOCAL_HOST_UNSUPPORTED",
		"ENDPOINT_ENV_MISSING",
		"ENDPOINT_UNSAFE",
		"CLI_ERROR",
		"PROMPT_TOO_LONG",
		"STARTUP_IDENTITY_UNAVAILABLE",
		"AGENT_REF_UNAVAILABLE",
		"MODEL_RESOLUTION_MISMATCH",
	]) {
		assert.ok(REMOTE_ERROR_CODES.includes(code), `${t}: missing ${code}`);
	}
}

// ---------------------------------------------------------------------------
// Mixed fleet: a claude-* route is not a pi route
// ---------------------------------------------------------------------------

{
	const t = "validateRunProvider: a Claude route carries a BARE model id";
	const out = validateRunProvider("claude-peer/claude-opus-5");
	assert.equal(out.roleProvider, "claude-peer", t);
	assert.equal(out.model, "claude-opus-5", t);
	assert.equal(out.provider, "claude-peer/claude-opus-5", t);
}

{
	// A pi-shaped model on a Claude route is a config error, not something to
	// normalise (docs/claude-runtime.md, "Two families, one control plane").
	expectRemoteError("USAGE", () =>
		validateRunProvider("claude-peer/anthropic/claude-opus-5"),
	);
	expectRemoteError("USAGE", () => validateRunProvider("claude-peer"));
	expectRemoteError("USAGE", () => validateRunProvider("claude-peer/"));
}

{
	const t = "validateThinking: levels are per family, never a union";
	validateThinking("ultracode", "claude");
	validateThinking("minimal", "pi");
	assert.equal(validateThinking("high"), "high", t);
	// `minimal` exists only on pi and `ultracode` only on Claude — a union would
	// silently accept a level the target runtime clamps away.
	expectRemoteError("USAGE", () => validateThinking("ultracode", "pi"));
	expectRemoteError("USAGE", () => validateThinking("minimal", "claude"));
}

{
	const t = "buildArgv: a Claude run forwards --mode";
	const argv = buildArgv(
		"run",
		{
			provider: "claude-peer/claude-opus-5",
			thinking: "ultracode",
			mode: "default",
			workspace: "wks-1",
			title: "t",
			label: ["team.cluster=d:/code/shop"],
			prompt: "x",
		},
		EP,
	);
	assert.deepEqual(
		argv,
		[
			"run",
			"--host",
			EP,
			"--provider",
			"claude-peer/claude-opus-5",
			"--thinking",
			"ultracode",
			"--mode",
			"default",
			"--workspace",
			"wks-1",
			"--title",
			"t",
			"--label",
			"team.cluster=d:/code/shop",
			"-d",
			"--json",
			"x",
		],
		t,
	);
}

{
	// Paseo refuses to inherit a permission mode across providers, so a Claude
	// agent created without one dies at the daemon with a confusing message.
	// Catch it here, where the reason can be stated.
	expectRemoteError("USAGE", () =>
		buildArgv(
			"run",
			{
				provider: "claude-peer/claude-opus-5",
				thinking: "ultracode",
				workspace: "wks-1",
				prompt: "x",
			},
			EP,
		),
	);
}

{
	const t = "buildArgv: a pi run needs no mode and is unchanged";
	const argv = buildArgv(
		"run",
		{
			provider: "pi-peer/testprov/model-b",
			thinking: "medium",
			workspace: "wks-1",
			label: ["team.cluster=d:/code/shop"],
			prompt: "x",
		},
		EP,
	);
	assert.ok(!argv.includes("--mode"), t);
}

{
	const out = parseArgs(["run", "--host-id", "h", "--mode", "default"]);
	assert.equal(out.mode, "default");
	validateFlags("run", { ...out, provider: "p", thinking: "low", prompt: "x" });
}

// ---------------------------------------------------------------------------

console.log("remote-paseo.test.mjs: all tests passed");
