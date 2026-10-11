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

// Shaped like https://models.dev/api.json, cut down to the cases the scout and
// three review rounds found on the real catalog (snapshot 2026-10-11). Never
// fetched: every test below runs offline.
const rec = (context, output, canonical) => ({
	...(context || output ? { limit: { ...(context ? { context } : {}), ...(output ? { output } : {}) } } : {}),
	...(canonical ? { canonical_model_id: canonical } : {}),
});
const API = {
	openai: {
		id: "openai",
		models: {
			"gpt-5.6-terra": { id: "gpt-5.6-terra", reasoning: true, limit: { context: 1_050_000, input: 922_000, output: 128_000 }, canonical_model_id: "openai/gpt-5.6-terra" },
			"gpt-6-astra": rec(1_050_000, 128_000, "openai/gpt-6-astra"),
		},
	},
	xpersona: { models: { "gpt-5.6-terra": rec(372_000, 128_000, "openai/gpt-5.6-terra") } },
	abacus: { models: { "gpt-5.6-terra": rec(1_000_000, 128_000, "openai/gpt-5.6-terra"), "gemini-3-pro-image-preview": rec(65_536, 32_768, "google/gemini-3-pro-image-preview") } },
	// No canonical id and a bogus output: must not outvote the owner.
	llmgateway: { models: { "gpt-6-astra": rec(1_050_000, 1_050_000) } },

	// poolside keys its own model WITH the vendor prefix; resellers agree with
	// each other on output and not with the owner.
	poolside: { models: { "poolside/laguna-s-2.1": rec(1_048_576, 32_768, "poolside/laguna-s-2.1") } },
	openrouter: {
		models: {
			"poolside/laguna-s-2.1": rec(1_048_576, 131_072),
			"x-ai/grok-4.20": rec(2_000_000, 1_800_000),
			"google/gemini-3-pro-image-preview": rec(65_536, 32_768, "google/gemini-3-pro-image-preview"),
			"nvidia/nemotron-3.5-content-safety": rec(131_072, 117_964, "nvidia/nemotron-3.5-content-safety"),
		},
	},
	vercel: { models: { "poolside/laguna-s-2.1": rec(1_000_000, 131_072, "poolside/laguna-s-2.1") } },
	kilo: {
		models: {
			"poolside/laguna-s-2.1": rec(1_048_576, 131_072),
			"x-ai/grok-4.20": rec(2_000_000, 1_800_000),
			"google/gemini-3-pro-image-preview": rec(65_536, 32_768, "google/gemini-3-pro-image-preview"),
			"nvidia/nemotron-3.5-content-safety": rec(131_072, 117_964, "nvidia/nemotron-3.5-content-safety"),
		},
	},

	// Three generic resellers for the "agreed" rule.
	engy: {
		models: {
			"deepseek-v4.1-flash": rec(327_680, 65_536, "deepseek/deepseek-v4.1-flash"),
			"same-everywhere": rec(64_000, 8_000),
			"half-agree": rec(200_000, 8_000),
			"only-two": rec(64_000, 8_000),
			stitched: rec(64_000, undefined),
			"one-carries": rec(64_000, 8_000),
			"lone-owner": rec(32_000, 4_000, "engy/lone-owner"),
			// The owner's own record claims more output than window.
			inverted: rec(8_000, 16_000, "engy/inverted"),
			contested: rec(100_000, 4_000, "engy/contested"),
		},
	},
	azure: {
		models: {
			"gpt-5.6-terra": rec(1_050_000, 128_000, "openai/gpt-5.6-terra"),
			"deepseek-v4.1-flash": rec(1_000_000, 128_000, "deepseek/deepseek-v4.1-flash"),
			"same-everywhere": rec(64_000, 8_000),
			"half-agree": rec(200_000, 16_000),
			"only-two": rec(64_000, 8_000),
			stitched: rec(undefined, 8_000),
			"one-carries": rec(64_000, undefined),
			"no-limit": {},
			// Listed by one reseller only, no canonical id.
			"lone-reseller": rec(128_000, 16_000),
			inverted: rec(8_000, 16_000, "engy/inverted"),
			contested: rec(200_000, 4_000, "azure/contested"),
		},
	},
	cortecs: {
		models: {
			"deepseek-v4.1-flash": rec(1_000_000, 384_000, "deepseek/deepseek-v4.1-flash"),
			"same-everywhere": rec(64_000, 8_000),
			"half-agree": rec(200_000, 8_000),
			stitched: rec(64_000, 8_000),
			"one-carries": rec(64_000, undefined),
			contested: rec(100_000, 4_000),
		},
	},

	// Labels that name ANOTHER model: the labelled owner exists in the catalog
	// but not under this id, so it is never read.
	nano: {
		models: {
			"x-ai/grok-4.20": rec(2_000_000, 131_072),
			"gemini-3-pro-image-preview": rec(65_536, 32_768, "google/gemini-3-pro-image-preview"),
			"nvidia/nemotron-3.5-content-safety": rec(131_072, 32_768, "nvidia/nemotron-3.5-content-safety"),
		},
	},
	ofox: { models: { "x-ai/grok-4.20": rec(2_000_000, 128_000, "xai/grok-4.20-0309-reasoning") } },
	xai: { models: { "grok-4.20-0309-reasoning": rec(1_000_000, 30_000) } },
	deepinfra: { models: { "Qwen/Qwen3-Next-80B-A3B-Instruct": rec(262_144, 32_768, "alibaba/qwen3-next-80b-a3b-instruct") } },
	huggingface: { models: { "Qwen/Qwen3-Next-80B-A3B-Instruct": rec(262_144, 66_536) } },
	"io-net": { models: { "Qwen/Qwen3-Next-80B-A3B-Instruct": rec(262_144, 4_096) } },
	alibaba: { models: { "qwen3-next-80b-a3b-instruct": rec(131_072, 32_768) } },
	"umans-ai": { models: { "umans-kimi-k3": rec(1_048_576, 131_072, "moonshotai/kimi-k3") } },
	"umans-ai-coding-plan": { models: { "umans-kimi-k3": rec(1_048_576, 131_072, "moonshotai/kimi-k3") } },
	moonshotai: { models: { "kimi-k3": rec(2_097_152, 1_048_576) } },

	// google/nvidia key their own model differently from the resellers'
	// prefixed ids, so each owner is in the hit set of one spelling only.
	google: { models: { "gemini-3-pro-image-preview": rec(131_072, 32_768, "google/gemini-3-pro-image-preview") } },
	fastrouter: { models: { "google/gemini-3-pro-image-preview": rec(65_536, 32_768, "google/gemini-3-pro-image-preview") } },
	edenai: { models: { "google/gemini-3-pro-image-preview": rec(65_536, 32_768, "google/gemini-3-pro-image-preview") } },
	"302ai": { models: { "gemini-3-pro-image-preview": rec(32_768, 64_000) } },
	nvidia: { models: { "nvidia/nemotron-3.5-content-safety": rec(128_000, 8_192, "nvidia/nemotron-3.5-content-safety") } },
	vultr: { models: { "nemotron-3.5-content-safety": rec(131_072, 8_192, "nvidia/nemotron-3.5-content-safety") } },
	requesty: { models: { "nemotron-3.5-content-safety": rec(131_072, 8_192, "nvidia/nemotron-3.5-content-safety") } },
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

// --- matching: exact id, then endpoint / owner in the hit set / agreed -----
{
	// 2. owner: openai is in the hit set and its label names it.
	const terra = match("gpt-5.6-terra");
	assert.equal(terra.rule, "owner");
	assert.equal(terra.record, "openai/gpt-5.6-terra");
	assert.equal(terra.candidates, 4);
	assert.equal(terra.contextWindow, 1_050_000, "limit.context, not limit.input: pi's own catalogs do the same");
	assert.equal(terra.maxTokens, 128_000);
	assert.deepEqual(terra.warnings, [], "azure agrees with the owner, so nothing to say");

	// Hits without a canonical id do not stop the owner being found.
	const astra = match("gpt-6-astra");
	assert.equal(astra.record, "openai/gpt-6-astra");
	assert.equal(astra.maxTokens, 128_000);

	// The owner disagreeing with EVERY other hit on a field: still the owner's
	// value, with a warning naming model, field and both numbers.
	const laguna = match("poolside/laguna-s-2.1");
	assert.equal(laguna.rule, "owner");
	assert.equal(laguna.record, "poolside/poolside/laguna-s-2.1");
	assert.equal(laguna.contextWindow, 1_048_576);
	assert.equal(laguna.maxTokens, 32_768);
	assert.deepEqual(laguna.warnings.map((w) => w.field), ["maxTokens"], "context: some resellers agree with the owner, so no warning");
	assert.equal(
		laguna.warnings[0].text,
		"poolside/laguna-s-2.1: maxTokens 32768 from owner poolside differs from every other models.dev provider (131072); using the owner's",
	);

	// 1. endpoint: a pi provider that IS a models.dev provider reads its own record.
	const viaRouter = match("poolside/laguna-s-2.1", "openrouter");
	assert.equal(viaRouter.rule, "endpoint");
	assert.equal(viaRouter.maxTokens, 131_072);
	assert.deepEqual(viaRouter.warnings, []);

	// 3. agreed: every hit carries the field with one value, three hits or more.
	const same = match("same-everywhere");
	assert.equal(same.rule, "agreed");
	assert.equal(same.contextWindow, 64_000);
	assert.equal(same.maxTokens, 8_000);
	const half = match("half-agree");
	assert.equal(half.contextWindow, 200_000, "per field: the agreed one is known");
	assert.equal(half.maxTokens, undefined, "the other is not");
	const two = match("only-two");
	assert.equal(two.candidates, 2);
	assert.equal(two.contextWindow, undefined, "two resellers agreeing vouch for nothing");
	assert.equal(two.maxTokens, undefined);
	assert.match(two.reason, /only 2 models\.dev entries list/);
	const stitched = match("stitched");
	assert.equal(stitched.contextWindow, undefined, "a field one hit lacks is unknown: never stitched across records");
	assert.equal(stitched.maxTokens, undefined);
	const oneCarries = match("one-carries");
	assert.equal(oneCarries.contextWindow, 64_000);
	assert.equal(oneCarries.maxTokens, undefined, "a field only one hit carries is unknown");
	// Two hits each the owner their own label names: no single owner.
	const contested = match("contested");
	assert.equal(contested.rule, "agreed");
	assert.equal(contested.contextWindow, undefined);
	assert.equal(contested.maxTokens, 4_000);

	// One provider only: kept when it is the endpoint or the owner, else unknown.
	const lone = match("lone-reseller");
	assert.equal(lone.candidates, 1);
	assert.equal(lone.contextWindow, undefined);
	assert.equal(lone.maxTokens, undefined);
	assert.match(lone.reason, /only 1 models\.dev entry lists/);
	const loneOwner = match("lone-owner");
	assert.equal(loneOwner.rule, "owner");
	assert.equal(loneOwner.contextWindow, 32_000);
	assert.deepEqual(loneOwner.warnings, [], "nobody else to disagree with");
	assert.equal(match("lone-reseller", "azure").maxTokens, 16_000, "the endpoint's own record");

	// Labels naming ANOTHER model never read that model (rounds two and three).
	const grok = match("x-ai/grok-4.20");
	assert.equal(grok.rule, "agreed", "xai is labelled but not in the hit set");
	assert.equal(grok.contextWindow, 2_000_000, "all four agree on 2M; xai's 1M belongs to another model");
	assert.equal(grok.maxTokens, undefined, "and the outputs disagree");
	const qwen = match("Qwen/Qwen3-Next-80B-A3B-Instruct");
	assert.equal(qwen.contextWindow, 262_144, "not alibaba's 131072 for a differently named id");
	assert.equal(qwen.maxTokens, undefined);
	const kimi = match("umans-kimi-k3");
	assert.equal(kimi.contextWindow, undefined, "two plan records, owner not in the set: not enough to vouch");
	assert.equal(kimi.maxTokens, undefined, "and certainly not moonshotai's 1048576");

	// gemini-3-pro-image-preview, both spellings. Under "google/..." google is
	// NOT in the hit set (it keys the bare id): the four resellers agree.
	const geminiPrefixed = match("google/gemini-3-pro-image-preview");
	assert.equal(geminiPrefixed.rule, "agreed");
	assert.equal(geminiPrefixed.contextWindow, 65_536, "not google's 131072 read from outside the hit set");
	assert.equal(geminiPrefixed.maxTokens, 32_768);
	// Under the bare id google IS in the hit set: the owner, and since every
	// other hit says less, a warning.
	const geminiBare = match("gemini-3-pro-image-preview");
	assert.equal(geminiBare.rule, "owner");
	assert.equal(geminiBare.contextWindow, 131_072);
	assert.equal(geminiBare.maxTokens, 32_768);
	assert.deepEqual(geminiBare.warnings.map((w) => w.text), [
		"gemini-3-pro-image-preview: contextWindow 131072 from owner google differs from every other models.dev provider (32768/65536); using the owner's",
	]);

	// nemotron-3.5-content-safety: nvidia keys it prefixed.
	const nemotron = match("nvidia/nemotron-3.5-content-safety");
	assert.equal(nemotron.rule, "owner");
	assert.equal(nemotron.contextWindow, 128_000);
	assert.equal(nemotron.maxTokens, 8_192);
	assert.deepEqual(nemotron.warnings.map((w) => w.field), ["contextWindow", "maxTokens"], "both fields differ from every reseller");
	const nemotronBare = match("nemotron-3.5-content-safety");
	assert.equal(nemotronBare.contextWindow, undefined, "two resellers, owner not in this hit set");
	assert.equal(nemotronBare.maxTokens, undefined);

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

	// No model outputs more than its window.
	const inverted = match("inverted");
	assert.equal(inverted.rule, "owner");
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
	// Two overrides that cannot both be true: the window stands, the maxTokens
	// override is skipped and reported (sync refuses it before writing), and
	// the seam never hands out maxTokens > contextWindow.
	const clash = resolve("gpt-5.6-terra", { "gpt-5.6-terra": { contextWindow: 8_000, maxTokens: 16_000 } });
	assert.equal(clash.contextWindow, 8_000);
	assert.equal(clash.maxTokens, undefined, "neither the bad override nor models.dev's 128000 fits an 8000 window");
	assert.deepEqual(clash.fields, { contextWindow: "override", maxTokens: "unknown" });
	assert.match(clash.problems.join(" "), /maxTokens \(16000\) exceeds its contextWindow \(8000\)/);
	assert.match(clash.warnings.join(" "), /models\.dev maxTokens 128000 exceeds overridden contextWindow 8000/);
	const clashNoDev = resolve("review", { review: { contextWindow: 1_000, maxTokens: 5_000 } });
	assert.deepEqual([clashNoDev.contextWindow, clashNoDev.maxTokens], [1_000, undefined], "the reviewer's {1000, 5000}");

	// Only the overrides object's own keys: "constructor" is not an override.
	for (const id of ["constructor", "toString", "__proto__"]) {
		const inherited = resolve(id, {});
		assert.deepEqual(inherited.problems, [], `${id}: no phantom problem`);
		assert.equal(inherited.source, "unknown");
	}

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

	// The seam reports where its numbers came from, like the sync report does.
	const fresh = await lookupModelLimits({ endpointId: "minnyat", modelId: "gpt-5.6-terra", fetchImpl: offline(), cacheDir });
	assert.equal(fresh.origin, "cache");
	assert.deepEqual(fresh.warnings, []);
	const noCopy = await lookupModelLimits({ endpointId: "minnyat", modelId: "gpt-5.6-terra", fetchImpl: offline(), cacheDir: freshDir() });
	assert.equal(noCopy.origin, "unavailable");
	assert.match(noCopy.warnings[0], /^models\.dev unreachable and no cached copy \(fetch failed\)/);
	const staleDir = freshDir();
	await loadModelsDev({ fetchImpl: serving(), cacheDir: staleDir, now: Date.now() - 3 * DEFAULT_TTL_MS });
	const stale = await lookupModelLimits({ endpointId: "minnyat", modelId: "gpt-5.6-terra", fetchImpl: offline(), cacheDir: staleDir });
	assert.equal(stale.origin, "stale-cache");
	assert.equal(stale.contextWindow, 1_050_000, "the old copy still answers");
	assert.match(stale.warnings[0], /^models\.dev unreachable \(fetch failed\); using the cached copy from \S+ \(3d old\)$/);
	const notNeeded = await lookupModelLimits({
		endpointId: "minnyat",
		modelId: "review",
		overrides: { review: { contextWindow: 1_000, maxTokens: 500 } },
		fetchImpl: offline(),
		cacheDir: freshDir(),
	});
	assert.equal(notNeeded.origin, "not-needed");
	// An impossible pair is not "fully overridden": it goes to the catalog,
	// and the seam still never returns maxTokens > contextWindow.
	const impossible = await lookupModelLimits({
		endpointId: "minnyat",
		modelId: "gpt-5.6-terra",
		overrides: { "gpt-5.6-terra": { contextWindow: 1_000, maxTokens: 5_000 } },
		fetchImpl: offline(),
		cacheDir,
	});
	assert.deepEqual([impossible.contextWindow, impossible.maxTokens, impossible.origin], [1_000, undefined, "cache"]);
	assert.equal(impossible.problems.length, 1);

	// Every answer obeys the contract: a positive integer or absent.
	for (const modelId of [
		"gpt-5.6-terra", "half-agree", "contested", "review", "no-limit", "deepseek-v4.1-flash", "stitched", "one-carries",
		"lone-reseller", "inverted", "x-ai/grok-4.20", "Qwen/Qwen3-Next-80B-A3B-Instruct", "umans-kimi-k3",
		"gemini-3-pro-image-preview", "google/gemini-3-pro-image-preview", "nvidia/nemotron-3.5-content-safety", "poolside/laguna-s-2.1",
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
