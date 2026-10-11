import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	baseUrlProblem,
	buildModelEntry,
	configProblems,
	describeFailure,
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
	assert.equal(buildModelEntry("m", false, {}).thinkingLevelMap, undefined, "a non-reasoning model carries no level map");
	assert.deepEqual(buildModelEntry("m", true, {}).thinkingLevelMap, { ...THINKING_LEVEL_MAP });
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

	const modern = normalizeConfig({ version: 1, providers: { a: { baseUrl: "http://a/v1" }, b: { baseUrl: "http://b/v1" } } });
	assert.equal(modern.legacy, false);
	assert.deepEqual(modern.entries.map((e) => e.name).sort(), ["a", "b"]);

	assert.deepEqual(normalizeConfig(null).entries, [], "a missing document is empty, not a crash");
	assert.deepEqual(normalizeConfig({ providers: { "": { baseUrl: "x" }, ok: null } }).entries, [], "junk entries are dropped");

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

	const dry = only(await syncModels({ entries, keys, modelsPath, dryRun: true }));
	assert.equal(dry.ok, true);
	assert.equal(dry.listed, 3);
	assert.equal(dry.written, 2, "the dead model is not written");
	assert.deepEqual(
		dry.models,
		[{ id: "plain", reasoning: false }, { id: "thinker", reasoning: true }].sort((a, b) => a.id.localeCompare(b.id)),
		"reasoning comes from what each model actually answered",
	);
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
			await syncModels({ entries, keys, modelsPath: freshPath });
		} finally {
			process.umask(realUmask);
		}
		assert.equal((statSync(freshPath).mode & 0o777).toString(8), "600", "a new models.json is owner-only");
	}

	// A real write preserves other providers and leaves a backup behind.
	writeFileSync(modelsPath, JSON.stringify({ providers: { untouched: { models: [] } } }));
	const writtenReport = await syncModels({ entries, keys, modelsPath });
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
		const noProbe = only(await syncModels({ entries, keys, modelsPath, probe: false }));
		assert.equal(noProbe.ok, true);
		assert.equal(noProbe.written, 3, "without probing, whatever the endpoint lists is written");
		const byId = Object.fromEntries(noProbe.models.map((m) => [m.id, m.reasoning]));
		assert.equal(byId.thinker, true, "a model proved to think keeps its flag when it is not re-probed");
		assert.equal(byId.plain, false, "a model proved not to think keeps that too");
		assert.equal(byId.dead, false, "a model never probed is written as non-reasoning, never invented");
		const reProbed = only(await syncModels({ entries, keys, modelsPath }));
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
		const report = await syncModels({ entries: both, keys: bothKeys, modelsPath });
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

function existsOrNull(path) {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

rmSync(sandbox, { recursive: true, force: true });
console.log("pi-models-sync tests passed");
