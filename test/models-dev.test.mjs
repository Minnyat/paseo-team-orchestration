import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CACHE_FILE_NAME,
	DEFAULT_TTL_MS,
	MODELS_DEV_URL,
	loadModelsDev,
	lookupModelLimits,
	matchModelsDev,
	resolveModelLimits,
	slimCatalog,
} from "../scripts/models-dev.mjs";

// Shaped like https://models.dev/api.json, cut down to the cases the scout
// found against a real proxy's model list (/tmp/scout-T1.md §5). Never fetched:
// every test below runs offline.
const API = {
	openai: {
		id: "openai",
		models: {
			"gpt-5.6-terra": {
				id: "gpt-5.6-terra",
				reasoning: true,
				limit: { context: 1_050_000, input: 922_000, output: 128_000 },
				canonical_model_id: "openai/gpt-5.6-terra",
			},
			"gpt-6-astra": { id: "gpt-6-astra", limit: { context: 1_050_000, output: 128_000 }, canonical_model_id: "openai/gpt-6-astra" },
		},
	},
	xpersona: {
		id: "xpersona",
		models: {
			"gpt-5.6-terra": { id: "gpt-5.6-terra", limit: { context: 372_000, output: 128_000 }, canonical_model_id: "openai/gpt-5.6-terra" },
		},
	},
	abacus: {
		id: "abacus",
		models: {
			"gpt-5.6-terra": { id: "gpt-5.6-terra", limit: { context: 1_000_000, output: 128_000 }, canonical_model_id: "openai/gpt-5.6-terra" },
		},
	},
	llmgateway: {
		id: "llmgateway",
		models: {
			// No canonical id and a bogus output: must not outvote the owner.
			"gpt-6-astra": { id: "gpt-6-astra", limit: { context: 1_050_000, output: 1_050_000 } },
		},
	},
	poolside: {
		id: "poolside",
		models: {
			// The owner keys it WITH its vendor prefix.
			"poolside/laguna-s-2.1": {
				id: "poolside/laguna-s-2.1",
				limit: { context: 1_048_576, output: 32_768 },
				canonical_model_id: "poolside/laguna-s-2.1",
			},
		},
	},
	openrouter: {
		id: "openrouter",
		models: {
			"poolside/laguna-s-2.1": { id: "poolside/laguna-s-2.1", limit: { context: 1_048_576, output: 131_072 } },
		},
	},
	vercel: {
		id: "vercel",
		models: {
			"poolside/laguna-s-2.1": {
				id: "poolside/laguna-s-2.1",
				limit: { context: 1_000_000, output: 131_072 },
				canonical_model_id: "poolside/laguna-s-2.1",
			},
		},
	},
	// deepseek-v4.1-flash: canonical owner "deepseek" is not in the catalog,
	// and the resellers disagree.
	engy: {
		id: "engy",
		models: {
			"deepseek-v4.1-flash": { id: "deepseek-v4.1-flash", limit: { context: 327_680, output: 65_536 }, canonical_model_id: "deepseek/deepseek-v4.1-flash" },
			"same-everywhere": { id: "same-everywhere", limit: { context: 64_000, output: 8_000 } },
			"half-agree": { id: "half-agree", limit: { context: 200_000, output: 8_000 } },
			"two-owners": { id: "two-owners", limit: { context: 100_000, output: 4_000 }, canonical_model_id: "a/two-owners" },
			// Only context here, only output at azure: must not be stitched.
			stitched: { id: "stitched", limit: { context: 64_000 } },
			// Both fields here, only context at azure: output is not unanimous.
			"one-carries": { id: "one-carries", limit: { context: 64_000, output: 8_000 } },
			// Listed only here, and engy is its canonical owner.
			"lone-owner": { id: "lone-owner", limit: { context: 32_000, output: 4_000 }, canonical_model_id: "engy/lone-owner" },
			// The owner's own record claims more output than window.
			inverted: { id: "inverted", limit: { context: 8_000, output: 16_000 }, canonical_model_id: "engy/inverted" },
		},
	},
	azure: {
		id: "azure",
		models: {
			"deepseek-v4.1-flash": { id: "deepseek-v4.1-flash", limit: { context: 1_000_000, output: 128_000 }, canonical_model_id: "deepseek/deepseek-v4.1-flash" },
			"same-everywhere": { id: "same-everywhere", limit: { context: 64_000, output: 8_000 } },
			"half-agree": { id: "half-agree", limit: { context: 200_000, output: 16_000 } },
			"two-owners": { id: "two-owners", limit: { context: 200_000, output: 4_000 }, canonical_model_id: "b/two-owners" },
			"no-limit": { id: "no-limit" },
			stitched: { id: "stitched", limit: { output: 8_000 } },
			"one-carries": { id: "one-carries", limit: { context: 64_000 } },
			// Listed by one reseller only, no canonical id.
			"lone-reseller": { id: "lone-reseller", limit: { context: 128_000, output: 16_000 } },
			inverted: { id: "inverted", limit: { context: 8_000, output: 16_000 }, canonical_model_id: "engy/inverted" },
		},
	},
	"no-models": { id: "no-models" },

	// Round-two review: canonical labels that name ANOTHER id. Shaped on the
	// real records (models.dev 2026-10-11); each owner record is a different
	// model, so following the label silently read wrong limits.
	nano: {
		models: {
			"x-ai/grok-4.20": { id: "x-ai/grok-4.20", limit: { context: 2_000_000, output: 131_072 } },
			"gemini-img": { id: "gemini-img", limit: { context: 65_536, output: 32_768 }, canonical_model_id: "google/gemini-img" },
		},
	},
	kilo: { models: { "x-ai/grok-4.20": { id: "x-ai/grok-4.20", limit: { context: 2_000_000, output: 1_800_000 } } } },
	ofox: {
		models: {
			"x-ai/grok-4.20": { id: "x-ai/grok-4.20", limit: { context: 2_000_000, output: 128_000 }, canonical_model_id: "xai/grok-4.20-0309-reasoning" },
			"gemini-img": { id: "gemini-img", limit: { context: 65_536, output: 32_768 }, canonical_model_id: "google/gemini-img" },
		},
	},
	xai: { models: { "grok-4.20-0309-reasoning": { id: "grok-4.20-0309-reasoning", limit: { context: 1_000_000, output: 30_000 } } } },
	deepinfra: {
		models: {
			"Qwen/Qwen3-Next-80B-A3B-Instruct": {
				id: "Qwen/Qwen3-Next-80B-A3B-Instruct",
				limit: { context: 262_144, output: 32_768 },
				canonical_model_id: "alibaba/qwen3-next-80b-a3b-instruct",
			},
		},
	},
	huggingface: { models: { "Qwen/Qwen3-Next-80B-A3B-Instruct": { id: "Qwen/Qwen3-Next-80B-A3B-Instruct", limit: { context: 262_144, output: 66_536 } } } },
	"io-net": { models: { "Qwen/Qwen3-Next-80B-A3B-Instruct": { id: "Qwen/Qwen3-Next-80B-A3B-Instruct", limit: { context: 262_144, output: 4_096 } } } },
	alibaba: { models: { "qwen3-next-80b-a3b-instruct": { id: "qwen3-next-80b-a3b-instruct", limit: { context: 131_072, output: 32_768 } } } },
	"umans-ai": { models: { "umans-kimi-k3": { id: "umans-kimi-k3", limit: { context: 1_048_576, output: 131_072 }, canonical_model_id: "moonshotai/kimi-k3" } } },
	"umans-ai-coding-plan": { models: { "umans-kimi-k3": { id: "umans-kimi-k3", limit: { context: 1_048_576, output: 131_072 }, canonical_model_id: "moonshotai/kimi-k3" } } },
	moonshotai: { models: { "kimi-k3": { id: "kimi-k3", limit: { context: 2_097_152, output: 1_048_576 } } } },
	// The owner's own record disagrees with every reseller: the owner wins.
	google: { models: { "gemini-img": { id: "gemini-img", limit: { context: 131_072, output: 32_768 }, canonical_model_id: "google/gemini-img" } } },
};
const API_TEXT = JSON.stringify(API);

const sandbox = mkdtempSync(join(tmpdir(), "pst-models-dev-"));
let dirCount = 0;
const freshDir = () => join(sandbox, `cache-${dirCount++}`);

function fakeFetch(respond) {
	const calls = [];
	const impl = async (url, init) => {
		calls.push(url);
		return respond(url, init);
	};
	impl.calls = calls;
	return impl;
}
const serving = (text = API_TEXT, status = 200) => fakeFetch(async () => new Response(text, { status }));
const offline = () =>
	fakeFetch(async () => {
		throw new TypeError("fetch failed");
	});

const catalog = slimCatalog(API);
const match = (modelId, endpointId = "minnyat") => matchModelsDev(catalog, { endpointId, modelId });

// --- the slimmed catalog keeps limits and identity, nothing else -----------
{
	assert.deepEqual(catalog.openai["gpt-5.6-terra"], { context: 1_050_000, output: 128_000, canonical: "openai/gpt-5.6-terra" });
	assert.equal("reasoning" in catalog.openai["gpt-5.6-terra"], false, "reasoning never crosses over: the probe owns it");
	assert.deepEqual(catalog.azure["no-limit"], {});
	for (const junk of [null, [], "x", {}, { a: { models: {} } }]) {
		assert.throws(() => slimCatalog(junk), /models\.dev/, `${JSON.stringify(junk)} is not a catalog`);
	}
}

// --- matching: exact id, then endpoint / canonical owner / unanimous --------
{
	const terra = match("gpt-5.6-terra");
	assert.equal(terra.rule, "canonical");
	assert.equal(terra.record, "openai/gpt-5.6-terra");
	assert.equal(terra.candidates, 3);
	assert.equal(terra.contextWindow, 1_050_000, "limit.context, not limit.input: pi's own catalogs do the same");
	assert.equal(terra.maxTokens, 128_000);

	// Hits without a canonical id do not break the agreement of those with one.
	const astra = match("gpt-6-astra");
	assert.equal(astra.record, "openai/gpt-6-astra");
	assert.equal(astra.maxTokens, 128_000);

	const laguna = match("poolside/laguna-s-2.1");
	assert.equal(laguna.rule, "canonical");
	assert.equal(laguna.record, "poolside/poolside/laguna-s-2.1", "an owner that keys the id with its prefix is still found");
	assert.equal(laguna.maxTokens, 32_768);

	// A pi provider that IS a models.dev provider reads its own record.
	const viaRouter = match("poolside/laguna-s-2.1", "openrouter");
	assert.equal(viaRouter.rule, "endpoint");
	assert.equal(viaRouter.maxTokens, 131_072);

	const same = match("same-everywhere");
	assert.equal(same.rule, "unanimous");
	assert.equal(same.contextWindow, 64_000);
	assert.equal(same.maxTokens, 8_000);

	// Unanimity is per field: the agreed one is known, the other is not.
	const half = match("half-agree");
	assert.equal(half.contextWindow, 200_000);
	assert.equal(half.maxTokens, undefined);

	const twoOwners = match("two-owners");
	assert.equal(twoOwners.rule, "unanimous", "two different canonical ids pick no owner");
	assert.equal(twoOwners.contextWindow, undefined, "and their disagreeing context stays unknown");
	assert.equal(twoOwners.maxTokens, 4_000);

	// The cases that must stay unknown rather than be guessed.
	const deepseek = match("deepseek-v4.1-flash");
	assert.equal(deepseek.contextWindow, undefined, "owner absent and resellers disagree: unknown, not min, not majority");
	assert.equal(deepseek.maxTokens, undefined);
	assert.match(deepseek.reason, /disagree/);
	for (const id of ["cx/gpt-6-astra", "deepseek-v4.1-flash-free", "review", "GPT-5.6-Terra", "gpt-5.6"]) {
		const unknown = match(id);
		assert.equal(unknown.candidates, 0, `${id}: no prefix/suffix stripping, no case folding, no prefix match`);
		assert.equal(unknown.contextWindow, undefined);
		assert.equal(unknown.maxTokens, undefined);
	}
	assert.equal(match("no-limit").contextWindow, undefined, "a record with no limit gives none");

	// Unanimous means every hit carries the field, with one value.
	const stitched = match("stitched");
	assert.equal(stitched.contextWindow, undefined, "context from one record and output from another is never stitched");
	assert.equal(stitched.maxTokens, undefined);
	const oneCarries = match("one-carries");
	assert.equal(oneCarries.contextWindow, 64_000, "every hit carries the same context");
	assert.equal(oneCarries.maxTokens, undefined, "a field only one hit carries is unknown");

	// One provider only: its record counts only when it is provably the owner.
	const lone = match("lone-reseller");
	assert.equal(lone.candidates, 1);
	assert.equal(lone.contextWindow, undefined, "one reseller's word, not the owner's: unknown");
	assert.equal(lone.maxTokens, undefined);
	assert.match(lone.reason, /only azure lists/);
	const loneOwner = match("lone-owner");
	assert.equal(loneOwner.rule, "canonical", "the single record IS its canonical owner: kept");
	assert.equal(loneOwner.contextWindow, 32_000);
	const loneEndpoint = match("lone-reseller", "azure");
	assert.equal(loneEndpoint.rule, "endpoint", "and so is the endpoint's own record");
	assert.equal(loneEndpoint.maxTokens, 16_000);

	// A canonical label naming ANOTHER id is not followed (round-two review).
	const grok = match("x-ai/grok-4.20");
	assert.equal(grok.rule, "unanimous", "ofox's label points at a different xai model");
	assert.equal(grok.contextWindow, 2_000_000, "every record agrees on 2M; xai's 1M belongs to another model");
	assert.equal(grok.maxTokens, undefined, "and the outputs disagree");
	const qwen = match("Qwen/Qwen3-Next-80B-A3B-Instruct");
	assert.equal(qwen.contextWindow, 262_144, "not alibaba's 131072 for a differently named id");
	assert.equal(qwen.maxTokens, undefined);
	const kimi = match("umans-kimi-k3");
	assert.equal(kimi.rule, "unanimous", "a plan alias labelled with its base model is not the base model");
	assert.equal(kimi.contextWindow, 1_048_576);
	assert.equal(kimi.maxTokens, 131_072, "not moonshotai's 1048576");
	// A label that does name this id still makes the owner's record win.
	const gemini = match("gemini-img");
	assert.equal(gemini.rule, "canonical");
	assert.equal(gemini.record, "google/gemini-img");
	assert.equal(gemini.contextWindow, 131_072, "the owner's own record beats the resellers' 65536");

	// No model outputs more than its window.
	const inverted = match("inverted");
	assert.equal(inverted.contextWindow, 8_000);
	assert.equal(inverted.maxTokens, undefined, "maxTokens > contextWindow is unknown");
	assert.match(inverted.dropped, /16000 > contextWindow 8000/);
	assert.match(matchModelsDev(null, { modelId: "gpt-5.6-terra" }).reason, /unavailable/);
}

// --- precedence: override, then models.dev, then unknown -------------------
{
	const resolve = (modelId, overrides) => resolveModelLimits(catalog, { endpointId: "minnyat", modelId, overrides });

	const fromDev = resolve("gpt-5.6-terra");
	assert.deepEqual(
		{ contextWindow: fromDev.contextWindow, maxTokens: fromDev.maxTokens, source: fromDev.source },
		{ contextWindow: 1_050_000, maxTokens: 128_000, source: "models.dev" },
	);
	assert.equal("reasoning" in fromDev, false);

	const full = resolve("gpt-5.6-terra", { "gpt-5.6-terra": { contextWindow: 400_000, maxTokens: 64_000 } });
	assert.equal(full.contextWindow, 400_000, "the user's number beats models.dev");
	assert.equal(full.maxTokens, 64_000);
	assert.equal(full.source, "override");
	assert.equal(full.match, undefined, "a fully overridden model is not even matched");

	const partial = resolve("gpt-5.6-terra", { "gpt-5.6-terra": { contextWindow: 400_000 } });
	assert.equal(partial.contextWindow, 400_000);
	assert.equal(partial.maxTokens, 128_000, "the field the user did not set still comes from models.dev");
	assert.deepEqual(partial.fields, { contextWindow: "override", maxTokens: "models.dev" });
	assert.equal(partial.source, "override");

	const alias = resolve("review", { review: { maxTokens: 16_000 } });
	assert.equal(alias.contextWindow, undefined, "an alias models.dev does not know stays unknown where not overridden");
	assert.equal(alias.maxTokens, 16_000);

	const unknown = resolve("review");
	assert.deepEqual(
		{ contextWindow: unknown.contextWindow, maxTokens: unknown.maxTokens, source: unknown.source },
		{ contextWindow: undefined, maxTokens: undefined, source: "unknown" },
		"never a made-up 200000",
	);

	for (const bad of [0, -1, 1.5, "400000", null, Number.NaN]) {
		const ignored = resolve("gpt-5.6-terra", { "gpt-5.6-terra": { contextWindow: bad } });
		assert.equal(ignored.contextWindow, 1_050_000, `${String(bad)} is not an override`);
		assert.equal(ignored.source, "models.dev");
	}
	assert.equal(resolve("gpt-5.6-terra", { other: { contextWindow: 5 } }).contextWindow, 1_050_000, "another model's override does not apply");

	// An overridden window smaller than models.dev's output: that output cannot fit.
	const narrowed = resolve("gpt-5.6-terra", { "gpt-5.6-terra": { contextWindow: 100_000 } });
	assert.equal(narrowed.contextWindow, 100_000);
	assert.equal(narrowed.maxTokens, undefined);
	assert.equal(narrowed.fields.maxTokens, "unknown");
	assert.equal(narrowed.warnings.length, 1);
	assert.match(narrowed.warnings[0], /^gpt-5\.6-terra: models\.dev maxTokens 128000 exceeds overridden contextWindow 100000; maxTokens left unknown$/);

	// An overridden maxTokens above models.dev's window: the override is the
	// user's intent and stands; the window it contradicts becomes unknown.
	const widened = resolve("same-everywhere", { "same-everywhere": { maxTokens: 200_000 } });
	assert.equal(widened.maxTokens, 200_000, "the override is kept");
	assert.equal(widened.contextWindow, undefined, "models.dev's 64000 cannot hold it: unknown, not 64000");
	assert.deepEqual(widened.fields, { contextWindow: "unknown", maxTokens: "override" });
	assert.equal(widened.source, "override");
	assert.equal(widened.warnings.length, 1);
	assert.match(widened.warnings[0], /^same-everywhere: overridden maxTokens 200000 exceeds models\.dev contextWindow 64000; contextWindow left unknown$/);

	// Both fields overridden: both written as given, models.dev not consulted.
	const both = resolve("gpt-5.6-terra", { "gpt-5.6-terra": { contextWindow: 300_000, maxTokens: 200_000 } });
	assert.deepEqual([both.contextWindow, both.maxTokens, both.source], [300_000, 200_000, "override"]);
	assert.deepEqual(both.warnings, []);
	assert.deepEqual(both.problems, []);
	assert.equal(both.match, undefined);
	// Two overrides that contradict each other are the user's to fix: kept,
	// and reported (the sync path refuses them before writing).
	const clash = resolve("gpt-5.6-terra", { "gpt-5.6-terra": { contextWindow: 8_000, maxTokens: 16_000 } });
	assert.deepEqual([clash.contextWindow, clash.maxTokens], [8_000, 16_000]);
	assert.match(clash.problems.join(" "), /maxTokens \(16000\) exceeds its contextWindow \(8000\)/);

	// A bad override is skipped as before, but no longer silently.
	const skipped = resolve("gpt-5.6-terra", { "gpt-5.6-terra": { contextWindow: -1, context: 5 } });
	assert.equal(skipped.contextWindow, 1_050_000, "the bad value is not used");
	assert.match(skipped.problems.join(" "), /models\.gpt-5\.6-terra\.contextWindow must be a positive integer/);
	assert.match(skipped.problems.join(" "), /models\.gpt-5\.6-terra\.context is not an override/);
	assert.deepEqual(resolve("review", { review: "big" }).problems, ["models.review must be an object"]);
	assert.deepEqual(fromDev.problems, [], "no override, no problem");
	assert.deepEqual(fromDev.warnings, []);
}

// --- cache: fresh, reused, stale when offline, absent when never fetched ----
{
	const cacheDir = freshDir();
	const t0 = 1_800_000_000_000;
	const net = serving();
	const first = await loadModelsDev({ fetchImpl: net, cacheDir, now: t0 });
	assert.equal(first.origin, "network");
	assert.deepEqual(net.calls, [MODELS_DEV_URL]);
	const onDisk = JSON.parse(readFileSync(join(cacheDir, CACHE_FILE_NAME), "utf8"));
	assert.equal(onDisk.fetchedAt, t0);
	assert.deepEqual(onDisk.providers, catalog, "the cache holds the slimmed catalog");

	const reused = await loadModelsDev({ fetchImpl: offline(), cacheDir, now: t0 + DEFAULT_TTL_MS - 1 });
	assert.equal(reused.origin, "cache", "inside the TTL the network is not touched");

	const net2 = serving();
	const refreshed = await loadModelsDev({ fetchImpl: net2, cacheDir, now: t0 + DEFAULT_TTL_MS });
	assert.equal(refreshed.origin, "network", "past the TTL it refetches");
	assert.equal(net2.calls.length, 1);

	const stale = await loadModelsDev({ fetchImpl: offline(), cacheDir, now: t0 + 10 * DEFAULT_TTL_MS });
	assert.equal(stale.origin, "stale-cache", "offline past the TTL: the old copy beats nothing");
	assert.match(stale.error, /fetch failed/);
	assert.equal(stale.catalog.openai["gpt-5.6-terra"].context, 1_050_000);

	// A bad answer must not replace a good cache.
	const before = readFileSync(join(cacheDir, CACHE_FILE_NAME), "utf8");
	for (const bad of [serving("<html>captive portal</html>"), serving(API_TEXT, 503), serving("{}")]) {
		const kept = await loadModelsDev({ fetchImpl: bad, cacheDir, now: t0 + 10 * DEFAULT_TTL_MS });
		assert.equal(kept.origin, "stale-cache");
	}
	assert.equal(readFileSync(join(cacheDir, CACHE_FILE_NAME), "utf8"), before, "the cache file is untouched by a failed refresh");

	// A cache from another format version is not misread.
	const oldFormat = freshDir();
	await loadModelsDev({ fetchImpl: serving(), cacheDir: oldFormat, now: t0 });
	const doc = JSON.parse(readFileSync(join(oldFormat, CACHE_FILE_NAME), "utf8"));
	writeFileSync(join(oldFormat, CACHE_FILE_NAME), JSON.stringify({ ...doc, version: 0 }));
	assert.equal((await loadModelsDev({ fetchImpl: offline(), cacheDir: oldFormat, now: t0 })).origin, "unavailable");

	// A cache stamped in the future (clock moved back) is not fresh.
	const future = freshDir();
	await loadModelsDev({ fetchImpl: serving(), cacheDir: future, now: t0 });
	const netAgain = serving();
	const behind = await loadModelsDev({ fetchImpl: netAgain, cacheDir: future, now: t0 - 60_000 });
	assert.equal(behind.origin, "network", "a fetchedAt after now is refetched, not trusted");
	assert.equal(netAgain.calls.length, 1);

	// A cache write that fails leaves no temp file behind.
	const blocked = freshDir();
	mkdirSync(join(blocked, CACHE_FILE_NAME, "occupied"), { recursive: true });
	const unwritable = await loadModelsDev({ fetchImpl: serving(), cacheDir: blocked, now: t0 });
	assert.equal(unwritable.origin, "network", "the fetched data is still used");
	assert.ok(unwritable.cacheError, "the failed write is reported");
	assert.deepEqual(readdirSync(blocked), [CACHE_FILE_NAME], "and the temp file is cleaned up");

	// A fetchedAt that is a number but not a moment is a broken cache.
	const bogus = freshDir();
	mkdirSync(bogus, { recursive: true });
	writeFileSync(join(bogus, CACHE_FILE_NAME), JSON.stringify({ ...doc, version: onDisk.version, fetchedAt: 1e20 }));
	const ignoredBogus = await loadModelsDev({ fetchImpl: offline(), cacheDir: bogus, now: t0 });
	assert.equal(ignoredBogus.origin, "unavailable", "fetchedAt 1e20 is not trusted, and does not crash");

	const never = await loadModelsDev({ fetchImpl: offline(), cacheDir: freshDir(), now: t0 });
	assert.equal(never.origin, "unavailable");
	assert.equal(never.catalog, null);

	// A models.dev that never answers fails on our deadline. AbortSignal.timeout
	// does not hold the event loop open, so the test does.
	const keepAlive = setInterval(() => {}, 1_000);
	const stalled = await loadModelsDev({
		cacheDir: freshDir(),
		timeoutMs: 30,
		fetchImpl: (_url, init) =>
			new Promise((_resolve, reject) => {
				init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "TimeoutError" })));
			}),
	});
	assert.equal(stalled.origin, "unavailable");
	assert.match(stalled.error, /30 ms/);
	clearInterval(keepAlive);
}

// --- the seam: lookupModelLimits({endpointId, modelId, overrides, fetchImpl, cacheDir}) ---
{
	const cacheDir = freshDir();
	const net = serving();
	const seam = (result) => ({ contextWindow: result.contextWindow, maxTokens: result.maxTokens, source: result.source });

	assert.deepEqual(
		seam(await lookupModelLimits({ endpointId: "minnyat", modelId: "gpt-5.6-terra", fetchImpl: net, cacheDir })),
		{ contextWindow: 1_050_000, maxTokens: 128_000, source: "models.dev" },
	);
	assert.ok(existsSync(join(cacheDir, CACHE_FILE_NAME)), "the cache lands where the caller said");

	const untouched = offline();
	assert.deepEqual(
		seam(await lookupModelLimits({
			endpointId: "minnyat",
			modelId: "review",
			overrides: { review: { contextWindow: 128_000, maxTokens: 16_000 } },
			fetchImpl: untouched,
			cacheDir: freshDir(),
		})),
		{ contextWindow: 128_000, maxTokens: 16_000, source: "override" },
	);
	assert.equal(untouched.calls.length, 0, "a fully overridden model never touches the network");

	assert.deepEqual(
		seam(await lookupModelLimits({ endpointId: "minnyat", modelId: "gpt-5.6-terra", fetchImpl: offline(), cacheDir: freshDir() })),
		{ contextWindow: undefined, maxTokens: undefined, source: "unknown" },
		"offline with no cache: unknown, not a default",
	);

	// Every answer obeys the contract: a positive integer or absent.
	for (const modelId of [
		"gpt-5.6-terra", "half-agree", "two-owners", "review", "no-limit", "deepseek-v4.1-flash", "stitched", "one-carries",
		"lone-reseller", "inverted", "x-ai/grok-4.20", "Qwen/Qwen3-Next-80B-A3B-Instruct", "umans-kimi-k3", "gemini-img",
	]) {
		const result = await lookupModelLimits({ endpointId: "minnyat", modelId, fetchImpl: offline(), cacheDir });
		for (const field of ["contextWindow", "maxTokens"]) {
			const value = result[field];
			assert.ok(value === undefined || (Number.isInteger(value) && value > 0), `${modelId}.${field} = ${value}`);
		}
		if (result.contextWindow !== undefined && result.maxTokens !== undefined) {
			assert.ok(result.maxTokens <= result.contextWindow, `${modelId}: maxTokens fits its window`);
		}
		assert.ok(["override", "models.dev", "unknown"].includes(result.source));
		assert.ok(Array.isArray(result.warnings) && Array.isArray(result.problems), "warnings and problems are always arrays");
	}
}

rmSync(sandbox, { recursive: true, force: true });
console.log("models-dev tests passed");
