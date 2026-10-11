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
	for (const modelId of ["gpt-5.6-terra", "half-agree", "two-owners", "review", "no-limit", "deepseek-v4.1-flash", "stitched", "one-carries", "lone-reseller", "inverted"]) {
		const result = await lookupModelLimits({ endpointId: "minnyat", modelId, fetchImpl: offline(), cacheDir });
		for (const field of ["contextWindow", "maxTokens"]) {
			const value = result[field];
			assert.ok(value === undefined || (Number.isInteger(value) && value > 0), `${modelId}.${field} = ${value}`);
		}
		if (result.contextWindow !== undefined && result.maxTokens !== undefined) {
			assert.ok(result.maxTokens <= result.contextWindow, `${modelId}: maxTokens fits its window`);
		}
		assert.ok(["override", "models.dev", "unknown"].includes(result.source));
	}
}

rmSync(sandbox, { recursive: true, force: true });
console.log("models-dev tests passed");
