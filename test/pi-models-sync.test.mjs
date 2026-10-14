import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	baseUrlProblem,
	buildModelEntry,
	configProblems,
	describeFailure,
	LEGACY_LIMIT_KEYS,
	legacyLimitWarning,
	mergeCatalog,
	normalizeConfig,
	readEnvFileValue,
	readsAsThinking,
	resolveApiKey,
	syncModels,
	THINKING_LEVEL_MAP,
} from "../scripts/pi-models-sync.mjs";

const sandbox = mkdtempSync(join(tmpdir(), "pst-models-"));
const DEFAULTS_FOR_SECOND = { api: "openai-completions", keyEnv: "K", concurrency: 2, probe: true };

// models.dev is never reached from a test: every sync gets a fake, and a cache
// directory inside the sandbox so the real team directory is never written.
const offlineDev = () => ({
	cacheDir: join(sandbox, "models-dev-none"),
	fetchImpl: async () => {
		throw new TypeError("fetch failed");
	},
});
const quiet = () => {};
const MODELS_DEV_API = {
	openai: {
		models: {
			"gpt-5.6-terra": {
				id: "gpt-5.6-terra",
				reasoning: true,
				limit: { context: 1_050_000, input: 922_000, output: 128_000 },
				canonical_model_id: "openai/gpt-5.6-terra",
			},
		},
	},
	xpersona: {
		models: {
			"gpt-5.6-terra": { id: "gpt-5.6-terra", limit: { context: 372_000, output: 128_000 }, canonical_model_id: "openai/gpt-5.6-terra" },
		},
	},
};

// --- the reasoning verdict is the whole point of probing -------------------
// A name heuristic got glm-5.2 and poolside/laguna-s-2.1 wrong; Paseo reads the
// flag verbatim and then refuses every route above `thinking: off`.
{
	assert.equal(readsAsThinking({ choices: [{ message: { reasoning_content: "let me think" } }] }), true, "visible reasoning counts");
	assert.equal(
		readsAsThinking({ choices: [{ message: { content: "4" } }], usage: { completion_tokens_details: { reasoning_tokens: 61 } } }),
		true,
		"reasoning tokens count even with no reasoning_content",
	);
	// The subtle one: asked something trivial, a thinking model answers off the
	// top. The SHAPE is still there, and that is what says it can think.
	assert.equal(
		readsAsThinking({ choices: [{ message: { content: "hi", reasoning_content: null } }] }),
		true,
		"reasoning_content: null is a capable model with nothing to think about",
	);
	assert.equal(readsAsThinking({ choices: [{ message: { content: "hi" } }] }), false, "no reasoning keys at all is a no");
	assert.equal(readsAsThinking({}), false, "a malformed body is a no, not a crash");

	// Every level must map somewhere: pi treats a null as unsupported and
	// clamps it away silently, which preflight cannot then verify.
	for (const [level, mapped] of Object.entries(THINKING_LEVEL_MAP)) {
		assert.ok(typeof mapped === "string" && mapped !== "", `thinking level ${level} maps to something`);
	}
	const custom = buildModelEntry("m", true, {}, { name: "My model", reasoning: false, input: ["text"], include: true });
	assert.equal(custom.name, "My model");
	assert.equal(custom.reasoning, false);
	assert.equal(custom.thinkingLevelMap, undefined);
	assert.deepEqual(custom.input, ["text"]);
	assert.equal(custom.include, undefined);
	assert.deepEqual(configProblems([{ name: "p", baseUrl: "https://example.com", models: { m: { name: "Model", reasoning: false, input: ["text"], include: true } } }]), []);
	assert.ok(configProblems([{ name: "p", baseUrl: "https://example.com", models: { m: { reasoning: "false", input: ["audio"] } } }]).length);
	assert.equal(buildModelEntry("m", false, {}).thinkingLevelMap, undefined, "a non-reasoning model carries no level map");
	assert.deepEqual(buildModelEntry("m", true, {}).thinkingLevelMap, { ...THINKING_LEVEL_MAP });

	// Limits are written only when known. Absent means unknown; the old code
	// wrote 200000 into every model instead.
	const unknown = buildModelEntry("m", false);
	assert.equal("contextWindow" in unknown, false, "no limit known: no contextWindow key, not 200000");
	assert.equal("maxTokens" in unknown, false);
	const known = buildModelEntry("m", false, { contextWindow: 1_050_000, maxTokens: 128_000, source: "models.dev" });
	assert.equal(known.contextWindow, 1_050_000);
	assert.equal(known.maxTokens, 128_000);
	assert.equal("source" in known, false, "bookkeeping does not leak into models.json");
	for (const bad of [0, -5, 1.5, "200000", null]) {
		assert.equal("contextWindow" in buildModelEntry("m", false, { contextWindow: bad }), false, `${String(bad)} is never written`);
	}
	// An endpoint entry passed by an old caller carries no limits any more.
	assert.equal("contextWindow" in buildModelEntry("m", false, { name: "p", baseUrl: "https://x" }), false);

	// compat is passed through verbatim so a gateway that is not what its URL
	// says can be fixed per model in the sync config and the fix SURVIVES every
	// sync. Earned the hard way: pi marks a reasoning model behind a generic
	// OpenAI proxy as supportsDeveloperRole=true and sends the system prompt as
	// role "developer"; a vLLM-style backend answers 422 "unknown variant
	// `developer`" and the model is unusable until compat says otherwise.
	const withCompat = buildModelEntry("m", true, {}, { compat: { supportsDeveloperRole: false } });
	assert.deepEqual(withCompat.compat, { supportsDeveloperRole: false });
	assert.equal(withCompat.thinkingLevelMap !== undefined, true, "a compat-carrying reasoning model keeps its level map");
	assert.equal("compat" in buildModelEntry("m", true, {}), false, "no compat override: no compat key");
	assert.equal("compat" in buildModelEntry("m", true, {}, { compat: {} }), false, "an empty compat override writes nothing");
	assert.deepEqual(
		configProblems([{ name: "p", baseUrl: "https://example.com", models: { m: { compat: { supportsDeveloperRole: false, thinkingFormat: "deepseek" } } } }]),
		[],
	);
	assert.ok(configProblems([{ name: "p", baseUrl: "https://example.com", models: { m: { compat: "no" } } }]).length, "compat must be an object");
	assert.ok(configProblems([{ name: "p", baseUrl: "https://example.com", models: { m: { compat: null } } }]).length, "compat must not be null");
	assert.ok(configProblems([{ name: "p", baseUrl: "https://example.com", models: { m: { compat: [false] } } }]).length, "compat must not be an array");
	assert.ok(
		configProblems([{ name: "p", baseUrl: "https://example.com", models: { m: { compat: { supportsDeveloperRole: 42 } } } }]).length,
		"compat values must be boolean, string, or object",
	);
}

// --- the key is read from the file systemd hands the daemon -----------------
{
	assert.equal(readEnvFileValue("CODING_API_KEY=sk-plain\n", "CODING_API_KEY"), "sk-plain");
	assert.equal(readEnvFileValue('export CODING_API_KEY="sk-quoted"\n', "CODING_API_KEY"), "sk-quoted");
	assert.equal(readEnvFileValue("OTHER=1\nCODING_API_KEY='sk-single'\n", "CODING_API_KEY"), "sk-single");
	assert.equal(readEnvFileValue("CODING_API_KEY=\n", "CODING_API_KEY"), null, "an empty assignment is not a key");
	assert.equal(readEnvFileValue("# CODING_API_KEY=sk-commented\n", "CODING_API_KEY"), null, "a comment is not a key");

	const keyFile = join(sandbox, "provider.env");
	writeFileSync(keyFile, "CODING_API_KEY=sk-from-file\n");
	assert.equal(resolveApiKey({ keyEnv: "CODING_API_KEY", keyFile }, {}).key, "sk-from-file");
	assert.equal(
		resolveApiKey({ keyEnv: "CODING_API_KEY", keyFile }, { CODING_API_KEY: "sk-from-env" }).key,
		"sk-from-env",
		"the environment wins over the file",
	);
	const missing = resolveApiKey({ keyEnv: "CODING_API_KEY", keyFile: join(sandbox, "nope.env") }, {});
	assert.equal(missing.key, null);
	assert.ok(missing.tried.length === 2, "a failure names both places it looked");
}

// --- merging must not disturb other providers ------------------------------
{
	const existing = { providers: { other: { baseUrl: "x", models: [{ id: "keep" }] } } };
	const merged = mergeCatalog(existing, { name: "mine", baseUrl: "b", api: "openai-completions", keyEnv: "K" }, []);
	assert.deepEqual(merged.providers.other, existing.providers.other, "a provider this pack does not own is left alone");
	assert.equal(merged.providers.mine.apiKey, "$K", "the file stores the variable NAME, never the secret");
}

// --- both config shapes reach the rest of the code as one shape ------------
{
	// The section shipped as a single endpoint before it grew a map. Files
	// written under that shape are still on disk and still correct.
	const legacy = normalizeConfig({ version: 1, provider: "solo", baseUrl: "http://a/v1", probe: false });
	assert.equal(legacy.legacy, true);
	assert.deepEqual(legacy.entries.map((e) => e.name), ["solo"]);
	assert.equal(legacy.entries[0].probe, false, "the old shape's own settings survive the translation");
	assert.equal(legacy.entries[0].api, "openai-completions", "and unset fields fall back to the defaults");
	for (const key of LEGACY_LIMIT_KEYS) {
		assert.equal(key in legacy.entries[0], false, `no default ${key} is invented for an endpoint`);
	}

	const modern = normalizeConfig({ version: 1, providers: { a: { baseUrl: "http://a/v1" }, b: { baseUrl: "http://b/v1" } } });
	assert.equal(modern.legacy, false);
	assert.deepEqual(modern.entries.map((e) => e.name).sort(), ["a", "b"]);

	assert.deepEqual(normalizeConfig(null).entries, [], "a missing document is empty, not a crash");
	assert.deepEqual(normalizeConfig({ providers: { "": { baseUrl: "x" }, ok: null } }).entries, [], "junk entries are dropped");

	// The WebUI edits compat as a kv control (string values); pi wants
	// booleans. Exactly "true"/"false" coerce, anything else passes through
	// (thinkingFormat: "deepseek"), and a "false" left as a string would flip
	// the flag the wrong way round at pi's end — it merges with ??, not with
	// Boolean().
	const [coerced] = normalizeConfig({ providers: { p: { baseUrl: "https://a/v1", models: { m: { compat: { supportsDeveloperRole: "false", supportsStore: "true", thinkingFormat: "deepseek" } } } } } }).entries;
	assert.deepEqual(coerced.models.m.compat, { supportsDeveloperRole: false, supportsStore: true, thinkingFormat: "deepseek" });
	assert.equal("models" in normalizeConfig({ providers: { p: { baseUrl: "https://a/v1" } } }).entries[0], false, "no models key: nothing invented");

	assert.deepEqual(configProblems([]), ["no provider configured"]);
	assert.match(configProblems([{ name: "x" }])[0], /baseUrl is required/);

	// Every request carries the API key in an Authorization header, so a plain
	// http endpoint puts it on the wire in clear.
	assert.equal(baseUrlProblem("https://a.example/v1"), null);
	assert.match(baseUrlProblem("http://a.example/v1"), /must be https/);
	assert.match(baseUrlProblem("not-a-url"), /not a URL/);
	// Loopback stays allowed: the traffic never leaves the machine, and a local
	// proxy over http is a normal way to run one of these (the tests below are
	// exactly that).
	for (const local of ["http://127.0.0.1:9/v1", "http://localhost:9/v1", "http://[::1]:9/v1"]) {
		assert.equal(baseUrlProblem(local), null, `${local} is loopback`);
	}
	assert.match(configProblems([{ name: "x", baseUrl: "http://evil.example/v1" }]).join(" "), /must be https/);
	// Paseo splits "<pi-provider>/<model-id>" at the FIRST slash, so a slash in
	// the provider name silently re-points every route built from it.
	assert.match(configProblems([{ name: "a/b", baseUrl: "https://x" }]).join(" "), /must not contain/);
	assert.deepEqual(configProblems([{ name: "ok", baseUrl: "https://x" }]), []);

	// Per-model overrides: a typo must stop the run, not quietly read as unknown.
	const withModels = (models) => configProblems([{ name: "p", baseUrl: "https://x", models }]).join(" ");
	assert.equal(withModels({ review: { contextWindow: 128_000, maxTokens: 16_000 }, other: {} }), "");
	assert.match(withModels({ " bad id ": {} }), /model ID/);
	assert.match(withModels({ review: { contextWindow: Number.MAX_SAFE_INTEGER + 1 } }), /positive integer/);
	assert.match(withModels({ review: { name: "  Model  " } }), /name/);
	assert.match(withModels({ review: { contextWindow: "128k" } }), /models\.review\.contextWindow must be a positive integer/);
	assert.match(withModels({ review: { maxTokens: 0 } }), /models\.review\.maxTokens must be a positive integer/);
	assert.match(withModels({ review: 128_000 }), /models\.review must be an object/);
	assert.match(withModels([]), /models must be an object/);
	// Only the two limits are overrides; anything else names the bad key.
	const stray = withModels({ review: { contextWindow: 128_000, context: 64_000, reasoning: true } });
	assert.match(stray, /models\.review\.context is not an override/);
	assert.doesNotMatch(stray, /models\.review\.reasoning is not an override/);
	assert.doesNotMatch(stray, /contextWindow is not/);
	assert.match(withModels({ review: { contextWindow: 8_000, maxTokens: 16_000 } }), /models\.review\.maxTokens \(16000\) exceeds its contextWindow \(8000\)/);

	// Endpoint-level limits from an older file: ignored, and said so in ONE line.
	assert.equal(legacyLimitWarning([{ name: "a" }]), null, "nothing to say about a clean file");
	const line = legacyLimitWarning([
		{ name: "minnyat", contextWindow: 200_000, maxTokens: 32_000 },
		{ name: "other", maxTokens: 8_000 },
	]);
	assert.equal(line.includes("\n"), false, "one line");
	assert.match(line, /minnyat\.contextWindow=200000/);
	assert.match(line, /minnyat\.maxTokens=32000/);
	assert.match(line, /other\.maxTokens=8000/);
	assert.match(line, /providers\.<name>\.models\.<model-id>/, "and it says where the number goes now");
}

assert.match(describeFailure(530, "cloudflare tunnel down"), /tunnel/);
assert.match(describeFailure(403, JSON.stringify({ error: { message: "not enabled" } })), /not enabled/);

// --- full sync against a real HTTP endpoint --------------------------------
{
	const calls = [];
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => { body += chunk; });
		req.on("end", () => {
			if (req.url === "/models") {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ data: [{ id: "thinker" }, { id: "plain" }, { id: "dead" }] }));
				return;
			}
			const payload = JSON.parse(body);
			calls.push({ model: payload.model, reasoning_effort: payload.reasoning_effort ?? null });
			if (payload.model === "dead") {
				res.writeHead(503, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: { message: "model unavailable" } }));
				return;
			}
			// `plain` rejects the reasoning parameter and only answers without
			// it — the retry path, and the only honest way to report false.
			if (payload.model === "plain" && payload.reasoning_effort) {
				res.writeHead(400, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: { message: "reasoning_effort unsupported" } }));
				return;
			}
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({
				choices: [{ message: payload.model === "thinker" ? { content: "4", reasoning_content: "2 plus 2" } : { content: "4" } }],
			}));
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const baseUrl = `http://127.0.0.1:${server.address().port}`;
	const entry = { name: "testprov", baseUrl, api: "openai-completions", keyEnv: "K", concurrency: 2 };
	const entries = [entry];
	const keys = new Map([["testprov", "sk"]]);
	const modelsPath = join(sandbox, "models.json");
	const only = (report) => report.providers[0];
	const manual = await syncModels({ entries: [{ ...entry, models: { custom: { include: true, name: "Manual", reasoning: false, input: ["text"] } } }], keys, modelsPath: join(sandbox, "manual.json"), modelsDev: offlineDev(), warn: quiet });
	const added = JSON.parse(readFileSync(join(sandbox, "manual.json"), "utf8")).providers.testprov.models.find(model => model.id === "custom");
	assert.equal(added.name, "Manual");
	assert.deepEqual(added.input, ["text"]);
	assert.ok(manual.providers[0].probed.some(model => model.id === "custom" && model.live));
	calls.length = 0;

	const dry = only(await syncModels({ entries, keys, modelsPath, dryRun: true, modelsDev: offlineDev(), warn: quiet }));
	assert.equal(dry.ok, true);
	assert.equal(dry.listed, 3);
	assert.equal(dry.written, 2, "the dead model is not written");
	assert.deepEqual(
		dry.models.map(({ id, reasoning }) => ({ id, reasoning })),
		[{ id: "plain", reasoning: false }, { id: "thinker", reasoning: true }].sort((a, b) => a.id.localeCompare(b.id)),
		"reasoning comes from what each model actually answered",
	);
	assert.equal(dry.models.every((m) => m.limitSource === "unknown"), true, "models.dev offline, no cache: every limit unknown");
	assert.equal(existsOrNull(modelsPath), null, "--dry-run writes nothing");
	assert.ok(
		calls.some((c) => c.model === "plain" && c.reasoning_effort === null),
		"a model that rejects reasoning_effort is retried without it rather than written off as dead",
	);

	// A catalog this run CREATES starts private (it can carry provider
	// credentials); POSIX modes only. An existing one keeps its owner's mode, which
	// the real write below exercises.
	if (process.platform !== "win32") {
		const freshPath = join(sandbox, "fresh-dir", "models.json");
		const realUmask = process.umask(0o022);
		try {
			await syncModels({ entries, keys, modelsPath: freshPath, modelsDev: offlineDev(), warn: quiet });
		} finally {
			process.umask(realUmask);
		}
		assert.equal((statSync(freshPath).mode & 0o777).toString(8), "600", "a new models.json is owner-only");
	}

	// A real write preserves other providers and leaves a backup behind.
	writeFileSync(modelsPath, JSON.stringify({ providers: { untouched: { models: [] } } }));
	const writtenReport = await syncModels({ entries, keys, modelsPath, modelsDev: offlineDev(), warn: quiet });
	assert.equal(writtenReport.ok, true);
	assert.ok(writtenReport.backup, "the previous catalog is backed up before it is replaced");
	const onDisk = JSON.parse(readFileSync(modelsPath, "utf8"));
	assert.ok(onDisk.providers.untouched, "another provider survives the write");
	assert.equal(onDisk.providers.testprov.models.length, 2);
	assert.equal(onDisk.providers.testprov.apiKey, "$K");
	assert.deepEqual(
		onDisk.providers.testprov.models.find((m) => m.id === "thinker").thinkingLevelMap,
		{ ...THINKING_LEVEL_MAP },
	);

	// --no-probe must not silently strip thinking off a working catalog: a
	// model this run did not probe keeps the verdict an earlier run proved.
	{
		const noProbe = only(await syncModels({ entries, keys, modelsPath, probe: false, modelsDev: offlineDev(), warn: quiet }));
		assert.equal(noProbe.ok, true);
		assert.equal(noProbe.written, 3, "without probing, whatever the endpoint lists is written");
		const byId = Object.fromEntries(noProbe.models.map((m) => [m.id, m.reasoning]));
		assert.equal(byId.thinker, true, "a model proved to think keeps its flag when it is not re-probed");
		assert.equal(byId.plain, false, "a model proved not to think keeps that too");
		assert.equal(byId.dead, false, "a model never probed is written as non-reasoning, never invented");
		const reProbed = only(await syncModels({ entries, keys, modelsPath, modelsDev: offlineDev(), warn: quiet }));
		assert.equal(
			reProbed.models.find((m) => m.id === "thinker").reasoning,
			true,
			"a real probe still decides when there is one",
		);
	}

	// Everything dead must NOT empty the catalog: a flaky network would
	// otherwise delete a working setup.
	const before = readFileSync(modelsPath, "utf8");
	const allDeadReport = await syncModels({
		entries,
		keys,
		modelsPath,
		modelsDev: offlineDev(),
		warn: quiet,
		fetchImpl: async (url) =>
			url.endsWith("/models")
				? new Response(JSON.stringify({ data: [{ id: "dead" }] }), { status: 200 })
				: new Response(JSON.stringify({ error: { message: "model unavailable" } }), { status: 503 }),
	});
	assert.equal(allDeadReport.ok, false);
	assert.equal(only(allDeadReport).code, "ALL_MODELS_DEAD");
	assert.equal(readFileSync(modelsPath, "utf8"), before, "a total failure leaves the previous catalog exactly as it was");

	// A listing that never answers must fail on OUR deadline. Node's fetch
	// would otherwise wait 300s for headers, holding the whole run.
	{
		const stalled = await syncModels({
			entries,
			keys,
			modelsPath,
			modelsDev: offlineDev(),
			warn: quiet,
			listTimeoutMs: 50,
			fetchImpl: (url, init) =>
				new Promise((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => {
						const error = new Error("timed out");
						error.name = "TimeoutError";
						reject(error);
					});
				}),
		});
		assert.equal(stalled.ok, false);
		assert.equal(only(stalled).code, "ENDPOINT_UNREACHABLE");
		assert.match(only(stalled).message, /50 ms/, "the deadline is named, not swallowed");
	}

	// --- several endpoints, one of them down -----------------------------
	// The whole point of a provider map: a dead endpoint must not take the
	// working ones down with it, and must not delete what it wrote last time.
	{
		const both = [entry, { ...DEFAULTS_FOR_SECOND, name: "offline", baseUrl: "http://127.0.0.1:1/v1" }];
		const bothKeys = new Map([["testprov", "sk"], ["offline", "sk"]]);
		const report = await syncModels({ entries: both, keys: bothKeys, modelsPath, modelsDev: offlineDev(), warn: quiet });
		assert.equal(report.ok, false, "one failed provider makes the whole run not-ok");
		const byProvider = Object.fromEntries(report.providers.map((p) => [p.provider, p]));
		assert.equal(byProvider.testprov.ok, true, "the healthy endpoint is still written");
		assert.equal(byProvider.offline.ok, false);
		assert.equal(byProvider.offline.code, "ENDPOINT_UNREACHABLE");
		const disk = JSON.parse(readFileSync(modelsPath, "utf8"));
		assert.equal(disk.providers.testprov.models.length, 2);
		assert.equal(disk.providers.offline, undefined, "a provider that never synced is not invented as an empty entry");
		assert.ok(disk.providers.untouched, "and an unrelated provider is still there");
	}

	server.close();
}

// --- limits per model, from models.dev and overrides -----------------------
// The bug this replaces: one endpoint-level 200000/32000 copied into every
// model. Here the endpoint lists a model models.dev knows (with a reseller
// disagreeing), a proxy alias it does not, and one the user overrides; the
// file still carries the old endpoint-level keys.
{
	const listed = ["gpt-5.6-terra", "review", "cx/gpt-6-astra"];
	const endpointFetch = async (url) =>
		url.endsWith("/models")
			? new Response(JSON.stringify({ data: listed.map((id) => ({ id })) }), { status: 200 })
			// The probe through this proxy says no reasoning, whatever models.dev claims.
			: new Response(JSON.stringify({ choices: [{ message: { content: "4" } }] }), { status: 200 });
	const devCalls = [];
	const modelsDev = {
		cacheDir: join(sandbox, "models-dev-cache"),
		fetchImpl: async (url) => {
			devCalls.push(url);
			return new Response(JSON.stringify(MODELS_DEV_API), { status: 200 });
		},
	};
	const [entry] = normalizeConfig({
		version: 1,
		providers: {
			proxy: {
				baseUrl: "https://proxy.invalid/v1",
				keyEnv: "K",
				contextWindow: 200_000,
				maxTokens: 32_000,
				models: { "cx/gpt-6-astra": { contextWindow: 400_000 } },
			},
		},
	}).entries;
	const modelsPath = join(sandbox, "limits-models.json");
	const warned = [];
	const report = await syncModels({
		entries: [entry],
		keys: new Map([["proxy", "sk"]]),
		modelsPath,
		fetchImpl: endpointFetch,
		modelsDev,
		warn: (line) => warned.push(line),
	});
	assert.equal(report.ok, true);
	assert.equal(devCalls.length, 1, "models.dev is fetched once per run, not once per model");
	assert.equal(report.limits.origin, "network");

	const legacyLines = warned.filter((line) => /endpoint-level/.test(line));
	assert.equal(legacyLines.length, 1, "exactly one warning line for the ignored endpoint-level keys");
	assert.match(legacyLines[0], /proxy\.contextWindow=200000/);
	assert.match(legacyLines[0], /proxy\.maxTokens=32000/);
	assert.deepEqual(report.warnings, warned, "every line printed reaches the JSON report too");
	// The fixture's only other gpt-5.6-terra record (xpersona, 372000) disagrees
	// with the owner: the owner's number is used, and that is said.
	assert.deepEqual(warned.filter((line) => !/endpoint-level/.test(line)), [
		"pi-models: proxy/gpt-5.6-terra: contextWindow 1050000 from owner openai differs from every other models.dev provider (372000); using the owner's",
	]);

	const byId = Object.fromEntries(JSON.parse(readFileSync(modelsPath, "utf8")).providers.proxy.models.map((m) => [m.id, m]));
	assert.equal(byId["gpt-5.6-terra"].contextWindow, 1_050_000, "the owner openai on models.dev, not the endpoint's 200000");
	assert.equal(byId["gpt-5.6-terra"].maxTokens, 128_000);
	assert.equal(byId["gpt-5.6-terra"].reasoning, false, "reasoning comes from the probe, never from models.dev");
	assert.equal(byId["gpt-5.6-terra"].thinkingLevelMap, undefined);
	assert.equal("contextWindow" in byId.review, false, "an alias models.dev does not know is unknown: absent");
	assert.equal("maxTokens" in byId.review, false);
	assert.equal(byId["cx/gpt-6-astra"].contextWindow, 400_000, "a per-model override is written");
	assert.equal("maxTokens" in byId["cx/gpt-6-astra"], false, "and a field it does not set is not guessed");
	for (const model of Object.values(byId)) {
		for (const field of ["contextWindow", "maxTokens"]) {
			const value = model[field];
			assert.ok(value === undefined || (Number.isInteger(value) && value > 0), `${model.id}.${field}`);
			assert.notEqual(value, 200_000);
		}
	}
	const reported = Object.fromEntries(report.providers[0].models.map((m) => [m.id, m.limitSource]));
	assert.deepEqual(reported, { "cx/gpt-6-astra": "override", "gpt-5.6-terra": "models.dev", review: "unknown" });

	// Next run offline: the cache from the first run still supplies the limits.
	const offlineRun = await syncModels({
		entries: [entry],
		keys: new Map([["proxy", "sk"]]),
		modelsPath,
		fetchImpl: endpointFetch,
		modelsDev: { cacheDir: modelsDev.cacheDir, now: Date.now() + 3 * 24 * 60 * 60 * 1000, fetchImpl: offlineDev().fetchImpl },
		warn: quiet,
	});
	assert.equal(offlineRun.limits.origin, "stale-cache");
	assert.match(offlineRun.limits.error, /fetch failed/);
	const staleLines = offlineRun.warnings.filter((line) => /cached copy/.test(line));
	assert.equal(staleLines.length, 1, "a stale cache is said, once");
	assert.match(staleLines[0], /models\.dev unreachable \(fetch failed\); using the cached copy from \d{4}-\d\d-\d\dT[^ ]+ \(3d old\)/);
	assert.equal(offlineRun.providers[0].models.find((m) => m.id === "gpt-5.6-terra").contextWindow, 1_050_000);

	// A file without the old keys says nothing.
	const clean = { ...entry };
	delete clean.contextWindow;
	delete clean.maxTokens;
	const silent = [];
	const cleanRun = await syncModels({
		entries: [clean],
		keys: new Map([["proxy", "sk"]]),
		modelsPath,
		fetchImpl: endpointFetch,
		modelsDev,
		dryRun: true,
		warn: (line) => silent.push(line),
	});
	assert.deepEqual(silent.filter((line) => /endpoint-level/.test(line)), []);
	assert.deepEqual(cleanRun.warnings, silent);

	// An override for an id the endpoint does not list is a typo until proven
	// otherwise: one line per such id, and the run goes on.
	{
		const lines = [];
		const typo = await syncModels({
			entries: [{ ...clean, models: { "gpt-5.6-tera": { contextWindow: 400_000 }, "cx/gpt-6-astra": { contextWindow: 400_000 }, ghost: { maxTokens: 1_000 } } }],
			keys: new Map([["proxy", "sk"]]),
			modelsPath: join(sandbox, "typo-models.json"),
			fetchImpl: endpointFetch,
			modelsDev,
			dryRun: true,
			warn: (line) => lines.push(line),
		});
		assert.equal(typo.ok, true);
		const unlisted = lines.filter((line) => /matches no model/.test(line));
		assert.deepEqual(unlisted, [
			"pi-models: proxy: override models.ghost matches no model the endpoint lists; it is not applied (check the id)",
			"pi-models: proxy: override models.gpt-5.6-tera matches no model the endpoint lists; it is not applied (check the id)",
		]);
		assert.equal(typo.providers[0].models.find((m) => m.id === "gpt-5.6-terra").contextWindow, 1_050_000, "the typo changes nothing");
		assert.equal("unlistedOverrides" in typo.providers[0], false, "internal bookkeeping stays out of the report");
	}

	// models.dev unreachable and never cached: the run still succeeds, overrides
	// still apply, and the report says why every other limit is missing.
	{
		const lines = [];
		const unreachable = await syncModels({
			entries: [clean],
			keys: new Map([["proxy", "sk"]]),
			modelsPath: join(sandbox, "unreachable-models.json"),
			fetchImpl: endpointFetch,
			modelsDev: offlineDev(),
			dryRun: true,
			warn: (line) => lines.push(line),
		});
		assert.equal(unreachable.ok, true, "missing limits do not fail the sync");
		assert.equal(unreachable.limits.origin, "unavailable");
		assert.equal(lines.length, 1);
		assert.match(lines[0], /models\.dev unreachable and no cached copy \(fetch failed\)/);
		assert.deepEqual(unreachable.warnings, lines, "the same line is in the report for the UI");
		const sources = Object.fromEntries(unreachable.providers[0].models.map((m) => [m.id, m.limitSource]));
		assert.deepEqual(sources, { "cx/gpt-6-astra": "override", "gpt-5.6-terra": "unknown", review: "unknown" });
	}

	// A cache whose fetchedAt is not a real moment is ignored, not a crash.
	{
		const bogusDir = join(sandbox, "models-dev-bogus");
		mkdirSync(bogusDir, { recursive: true });
		writeFileSync(join(bogusDir, "models-dev.json"), JSON.stringify({ version: 1, fetchedAt: 1e20, providers: { openai: {} } }));
		const bogus = await syncModels({
			entries: [clean],
			keys: new Map([["proxy", "sk"]]),
			modelsPath: join(sandbox, "bogus-models.json"),
			fetchImpl: endpointFetch,
			modelsDev: { cacheDir: bogusDir, fetchImpl: offlineDev().fetchImpl },
			dryRun: true,
			warn: quiet,
		});
		assert.equal(bogus.ok, true);
		assert.equal(bogus.limits.origin, "unavailable");
	}

	// An overridden maxTokens above models.dev's window: kept, the window
	// becomes unknown, and one line names the model and the reason.
	{
		const lines = [];
		const widened = await syncModels({
			entries: [{ ...clean, models: { "gpt-5.6-terra": { maxTokens: 2_000_000 } } }],
			keys: new Map([["proxy", "sk"]]),
			modelsPath: join(sandbox, "widened-models.json"),
			fetchImpl: endpointFetch,
			modelsDev,
			dryRun: true,
			warn: (line) => lines.push(line),
		});
		const terra = widened.providers[0].models.find((m) => m.id === "gpt-5.6-terra");
		assert.equal(terra.maxTokens, 2_000_000);
		assert.equal(terra.contextWindow, undefined);
		assert.equal(terra.limitSource, "override");
		assert.equal(lines.length, 1);
		assert.match(lines[0], /^pi-models: proxy\/gpt-5\.6-terra: overridden maxTokens 2000000 exceeds models\.dev contextWindow 1050000; contextWindow left unknown$/);
		assert.deepEqual(widened.warnings, lines);
	}

	// --dry-run writes nothing at all, the models.dev cache included.
	const dryCache = join(sandbox, "models-dev-dry");
	const dryRun = await syncModels({
		entries: [clean],
		keys: new Map([["proxy", "sk"]]),
		modelsPath: join(sandbox, "dry-models.json"),
		fetchImpl: endpointFetch,
		modelsDev: { ...modelsDev, cacheDir: dryCache },
		dryRun: true,
		warn: quiet,
	});
	assert.equal(dryRun.limits.origin, "network");
	assert.equal(dryRun.providers[0].models.find((m) => m.id === "gpt-5.6-terra").contextWindow, 1_050_000, "the dry run still reports the limits");
	assert.equal(existsOrNull(join(dryCache, "models-dev.json")), null, "but caches nothing");
	assert.equal(existsOrNull(join(sandbox, "dry-models.json")), null);
}

function existsOrNull(path) {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

rmSync(sandbox, { recursive: true, force: true });
console.log("pi-models-sync tests passed");
