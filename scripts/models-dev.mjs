/**
 * models-dev.mjs — context window and max output per model, from models.dev.
 *
 * pi has no way to ask an OpenAI-compatible endpoint how big a model's context
 * is, so `models sync` used to write one number per endpoint (200000/32000)
 * into every model. models.dev publishes the real limits; this reads them.
 *
 * Only `limit.context` and `limit.output` are taken — the same two fields pi's
 * own generated catalogs map to contextWindow/maxTokens. Nothing else crosses
 * over, and above all not `reasoning`: models.dev marks gpt-5.6-terra as a
 * reasoning model while the probe through a real proxy says it is not, and the
 * probe is the only source pi-models-sync trusts for that flag.
 *
 * Precedence, per field: a value the user wrote for that model, then a
 * models.dev value matched by the rules below, then nothing. "Nothing" stays
 * absent in models.json — it means unknown, and pi applies its own default.
 * There is no number of our own to fall back to.
 *
 * Matching. The id an endpoint lists (`gpt-5.6-terra`, `poolside/laguna-s-2.1`,
 * `cx/gpt-6-astra`, `deepseek-v4.1-flash-free`, `review`) is looked up EXACTLY,
 * case included, against every models.dev provider. The same id is typically
 * listed by 10-40 providers with different limits, so a hit set is narrowed by,
 * in order:
 *
 *   1. endpoint: the pi provider name is itself a models.dev provider that
 *      lists the id — that provider's own record.
 *   2. canonical: every hit that names a `canonical_model_id` names the same
 *      one, and that model's owner (the id's first segment) lists it — the
 *      owner's record. This is how `gpt-5.6-terra` resolves to openai's
 *      1050000/128000 instead of a reseller's 372000.
 *   3. unanimous: per field, EVERY hit carries the field and all give the
 *      same value. A field only some hits carry is unknown, so the two limits
 *      can never be stitched together from different records. This needs at
 *      least two hits: an id only one provider lists, and that provider is
 *      neither the endpoint (1) nor the canonical owner (2), is one reseller's
 *      word and stays unknown.
 *
 * Whichever rule matched, a maxTokens larger than the contextWindow it sits
 * beside cannot be right (no model outputs more than its window), so that
 * maxTokens becomes unknown; the contextWindow stands.
 *
 * Anything else is unknown. In particular there is no majority vote, no
 * minimum, no case folding, and no stripping of proxy prefixes (`cx/`) or
 * suffixes (`-free`): each of those picks a number for a model nobody has
 * identified. A per-model override is the way to state one.
 *
 * The catalog is 5+ MB, so it is cached on disk (slimmed to the fields above)
 * for a day, and a stale cache is used when the network is down.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { teamConfigDir } from "./lib-common.mjs";

export const MODELS_DEV_URL = "https://models.dev/api.json";
export const CACHE_FILE_NAME = "models-dev.json";
export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_FETCH_TIMEOUT_MS = 20_000;
// Bump when the slimmed shape changes: an older cache is then ignored rather
// than misread.
const CACHE_VERSION = 1;

export function isPositiveInteger(value) {
	return Number.isInteger(value) && value > 0;
}

export function defaultCacheDir(env = process.env) {
	return join(teamConfigDir(env), "cache");
}

/**
 * Reduce api.json to what limits need: `{provider: {modelKey: {context?,
 * output?, canonical?}}}`. Throws on anything that does not look like the
 * catalog, so a captive-portal page or an error body never replaces a good
 * cache.
 */
export function slimCatalog(raw) {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("models.dev: not a provider map");
	const out = {};
	let count = 0;
	for (const [providerId, provider] of Object.entries(raw)) {
		const models = provider?.models;
		if (!models || typeof models !== "object") continue;
		const slim = {};
		for (const [key, model] of Object.entries(models)) {
			if (!model || typeof model !== "object") continue;
			const entry = {};
			if (isPositiveInteger(model.limit?.context)) entry.context = model.limit.context;
			if (isPositiveInteger(model.limit?.output)) entry.output = model.limit.output;
			if (typeof model.canonical_model_id === "string" && model.canonical_model_id.includes("/")) {
				entry.canonical = model.canonical_model_id;
			}
			if (typeof model.id === "string" && model.id !== key) entry.id = model.id;
			slim[key] = entry;
			count += 1;
		}
		out[providerId] = slim;
	}
	if (count === 0) throw new Error("models.dev: no model in the catalog");
	return out;
}

function readCache(path) {
	try {
		const doc = JSON.parse(readFileSync(path, "utf8"));
		if (doc?.version !== CACHE_VERSION || !Number.isFinite(doc.fetchedAt)) return null;
		if (!doc.providers || typeof doc.providers !== "object") return null;
		return doc;
	} catch {
		return null;
	}
}

/**
 * The catalog, from the cache when it is fresh, from the network otherwise,
 * from a stale cache when the network fails.
 *
 * @returns {Promise<{catalog: object|null, origin: "cache"|"network"|"stale-cache"|"unavailable",
 *   fetchedAt?: number, error?: string}>}
 */
export async function loadModelsDev(options = {}) {
	const {
		fetchImpl = fetch,
		cacheDir = defaultCacheDir(),
		ttlMs = DEFAULT_TTL_MS,
		timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
		now = Date.now(),
		url = MODELS_DEV_URL,
		// false: use what was fetched, write nothing (a dry run writes nothing).
		persist = true,
	} = options;
	const path = join(cacheDir, CACHE_FILE_NAME);
	const cached = readCache(path);
	// A fetchedAt in the future (clock moved back, copied cache) is not fresh.
	const age = cached ? now - cached.fetchedAt : -1;
	if (cached && age >= 0 && age < ttlMs) {
		return { catalog: cached.providers, origin: "cache", fetchedAt: cached.fetchedAt };
	}

	let catalog;
	try {
		// One signal for headers and body: a body that stalls is the same
		// failure as headers that never arrive.
		const signal = AbortSignal.timeout(timeoutMs);
		const response = await fetchImpl(url, { signal, headers: { accept: "application/json" } });
		const text = await response.text();
		if (!response.ok) throw new Error(`GET ${url} -> HTTP ${response.status}`);
		catalog = slimCatalog(JSON.parse(text));
	} catch (error) {
		const message = error?.name === "TimeoutError" ? `models.dev did not answer in ${timeoutMs} ms` : String(error?.message ?? error);
		if (cached) return { catalog: cached.providers, origin: "stale-cache", fetchedAt: cached.fetchedAt, error: message };
		return { catalog: null, origin: "unavailable", error: message };
	}

	const result = { catalog, origin: "network", fetchedAt: now };
	if (!persist) return result;
	// Temp file + rename: a reader never sees half a catalog.
	const temp = `${path}.${process.pid}.tmp`;
	try {
		mkdirSync(cacheDir, { recursive: true });
		writeFileSync(temp, JSON.stringify({ version: CACHE_VERSION, source: url, fetchedAt: now, providers: catalog }));
		renameSync(temp, path);
	} catch (error) {
		// The data is good; only next run's offline fallback is lost. Do not
		// leave a 700 KB orphan behind for every failed write.
		rmSync(temp, { force: true });
		result.cacheError = String(error?.message ?? error);
	}
	return result;
}

const indexes = new WeakMap();

/** id → every record listing it, across providers. Built once per catalog. */
function indexOf(catalog) {
	let index = indexes.get(catalog);
	if (index) return index;
	index = new Map();
	for (const [provider, models] of Object.entries(catalog)) {
		for (const [key, record] of Object.entries(models ?? {})) {
			for (const id of new Set([key, record?.id ?? key])) {
				if (!index.has(id)) index.set(id, []);
				index.get(id).push({ provider, key, ...record });
			}
		}
	}
	indexes.set(catalog, index);
	return index;
}

/** No model outputs more than its whole window: such a maxTokens is unknown. */
function saneLimits(result) {
	if (isPositiveInteger(result.contextWindow) && isPositiveInteger(result.maxTokens) && result.maxTokens > result.contextWindow) {
		return { ...result, maxTokens: undefined, dropped: `maxTokens ${result.maxTokens} > contextWindow ${result.contextWindow}` };
	}
	return result;
}

function recordFrom(record, rule, candidates) {
	return saneLimits({
		rule,
		record: `${record.provider}/${record.key}`,
		candidates,
		contextWindow: isPositiveInteger(record.context) ? record.context : undefined,
		maxTokens: isPositiveInteger(record.output) ? record.output : undefined,
	});
}

/** The value every hit gives for `field`, or undefined if any hit lacks it or differs. */
function unanimous(hits, field) {
	if (!hits.every((hit) => isPositiveInteger(hit[field]))) return undefined;
	const values = new Set(hits.map((hit) => hit[field]));
	return values.size === 1 ? [...values][0] : undefined;
}

/**
 * Apply the matching rules in the header to one id. Pure.
 *
 * @returns {{rule?: string, record?: string, candidates: number,
 *   contextWindow?: number, maxTokens?: number, reason?: string}}
 */
export function matchModelsDev(catalog, { endpointId, modelId }) {
	if (!catalog) return { candidates: 0, reason: "models.dev catalog unavailable" };
	const hits = indexOf(catalog).get(modelId) ?? [];
	if (hits.length === 0) return { candidates: 0, reason: `models.dev lists no model with id "${modelId}"` };

	const own = hits.find((hit) => hit.provider === endpointId);
	if (own) return recordFrom(own, "endpoint", hits.length);

	const canonical = new Set(hits.map((hit) => hit.canonical).filter(Boolean));
	if (canonical.size === 1) {
		const id = [...canonical][0];
		const owner = id.slice(0, id.indexOf("/"));
		const rest = id.slice(owner.length + 1);
		// The owner may key it bare (openai: "gpt-5.6-terra") or prefixed
		// (poolside: "poolside/laguna-s-2.1").
		const ownerModels = catalog[owner] ?? {};
		const key = rest in ownerModels ? rest : id in ownerModels ? id : null;
		if (key !== null) return recordFrom({ provider: owner, key, ...ownerModels[key] }, "canonical", hits.length);
	}

	if (hits.length === 1) {
		const [only] = hits;
		return { candidates: 1, reason: `only ${only.provider} lists "${modelId}" and it is neither this endpoint nor the canonical owner` };
	}
	const contextWindow = unanimous(hits, "context");
	const maxTokens = unanimous(hits, "output");
	if (contextWindow === undefined && maxTokens === undefined) {
		return { candidates: hits.length, reason: `${hits.length} models.dev entries for "${modelId}" disagree and none is the canonical owner` };
	}
	return saneLimits({ rule: "unanimous", candidates: hits.length, contextWindow, maxTokens });
}

/**
 * Resolve both limits for one model: override, then models.dev, then unknown.
 *
 * `overrides` is the endpoint's per-model map — `providers.<name>.models` in
 * pi-models.local.json: `{ "<model-id>": { contextWindow?, maxTokens? } }`.
 * A value that is not a positive integer is not an override.
 *
 * `source` is "override" when any field came from an override, "models.dev"
 * when any came from a match, "unknown" otherwise; `fields` says it per field.
 */
export function resolveModelLimits(catalog, { endpointId, modelId, overrides }) {
	const own = overrides && typeof overrides === "object" ? overrides[modelId] : undefined;
	const override = own && typeof own === "object" ? own : {};
	const need = ["contextWindow", "maxTokens"].filter((field) => !isPositiveInteger(override[field]));
	const match = need.length === 0 ? null : matchModelsDev(catalog, { endpointId, modelId });

	const result = { fields: {} };
	for (const field of ["contextWindow", "maxTokens"]) {
		if (isPositiveInteger(override[field])) {
			result[field] = override[field];
			result.fields[field] = "override";
		} else if (isPositiveInteger(match?.[field])) {
			result[field] = match[field];
			result.fields[field] = "models.dev";
		} else {
			result.fields[field] = "unknown";
		}
	}
	// An overridden window smaller than models.dev's output: that output
	// cannot fit, so it is unknown. (Two overrides that disagree are stopped
	// earlier, by pi-models-sync's configProblems.)
	if (result.fields.maxTokens === "models.dev" && isPositiveInteger(result.contextWindow) && result.maxTokens > result.contextWindow) {
		delete result.maxTokens;
		result.fields.maxTokens = "unknown";
	}
	const origins = Object.values(result.fields);
	result.source = origins.includes("override") ? "override" : origins.includes("models.dev") ? "models.dev" : "unknown";
	if (match) result.match = match;
	return result;
}

/**
 * The seam other code builds against: `{ contextWindow, maxTokens, source }`,
 * each limit a positive integer or undefined (unknown).
 *
 * Loads the catalog per call; a caller resolving many models should call
 * loadModelsDev once and resolveModelLimits per model, as pi-models-sync does.
 */
export async function lookupModelLimits({ endpointId, modelId, overrides, fetchImpl, cacheDir } = {}) {
	const own = overrides?.[modelId];
	// Fully overridden: no reason to touch the network.
	const covered = isPositiveInteger(own?.contextWindow) && isPositiveInteger(own?.maxTokens);
	const loaded = covered
		? { catalog: null }
		: await loadModelsDev({ ...(fetchImpl ? { fetchImpl } : {}), ...(cacheDir ? { cacheDir } : {}) });
	return resolveModelLimits(loaded.catalog, { endpointId, modelId, overrides });
}
