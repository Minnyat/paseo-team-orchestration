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
 * case included, as a model key under every models.dev provider. Those records
 * are the hit set, and only they are ever read. The same id is typically
 * listed by 10-40 providers with different limits, so it is narrowed by, in
 * order:
 *
 *   1. endpoint: the hit whose provider is the pi provider name itself.
 *   2. owner: the one hit whose provider is the owner named by the hits'
 *      `canonical_model_id` labels (`owner/rest`). This is how
 *      `gpt-5.6-terra` resolves to openai's 1050000/128000 instead of a
 *      reseller's 372000. A label is only used to say who the owner is; the
 *      owner's record must itself be in the hit set, so a label pointing at
 *      some other model (`x-ai/grok-4.20` -> `xai/grok-4.20-0309-reasoning`)
 *      never reads that model's limits. When the owner's value for a field
 *      differs from EVERY other hit's, it is still used, with a warning that
 *      names the model, the field, and both numbers.
 *   3. agreed: per field, every hit carries it with one value, and there are
 *      at least three hits. One or two resellers agreeing is not enough to
 *      vouch for a model nobody else lists.
 *
 * Whichever rule matched, a maxTokens larger than the contextWindow it sits
 * beside cannot be right (no model outputs more than its window), so that
 * maxTokens becomes unknown; the contextWindow stands.
 *
 * Mixing an override with models.dev: the override is the user's stated
 * intent and always stands. When it no longer fits the models.dev value next
 * to it — an overridden maxTokens above models.dev's contextWindow, or an
 * overridden contextWindow below models.dev's maxTokens — the models.dev
 * value becomes unknown and a warning says which model and why.
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

/** A time a Date can hold; 1e20 is a number but not a moment. */
function isTimestamp(value) {
	return isPositiveInteger(value) && !Number.isNaN(new Date(value).getTime());
}

/** The only keys a per-model override may hold. */
export const OVERRIDE_KEYS = Object.freeze(["contextWindow", "maxTokens"]);

/**
 * What is wrong with one per-model override, as `models.<id>...` messages.
 * Shared by pi-models-sync's configProblems (which stops the run) and
 * resolveModelLimits (which skips the bad value and reports it).
 */
export function overrideProblems(modelId, override) {
	if (override === undefined) return [];
	if (!override || typeof override !== "object" || Array.isArray(override)) return [`models.${modelId} must be an object`];
	const problems = [];
	// Only the two limits: anything else (`context`, `reasoning`, a misspelling)
	// would be read by nobody and look like it worked.
	for (const key of Object.keys(override)) {
		if (!OVERRIDE_KEYS.includes(key)) {
			problems.push(`models.${modelId}.${key} is not an override (allowed: ${OVERRIDE_KEYS.join(", ")})`);
		}
	}
	for (const field of OVERRIDE_KEYS) {
		if (override[field] !== undefined && !isPositiveInteger(override[field])) {
			problems.push(`models.${modelId}.${field} must be a positive integer`);
		}
	}
	if (isPositiveInteger(override.contextWindow) && isPositiveInteger(override.maxTokens) && override.maxTokens > override.contextWindow) {
		problems.push(`models.${modelId}.maxTokens (${override.maxTokens}) exceeds its contextWindow (${override.contextWindow})`);
	}
	return problems;
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
		if (doc?.version !== CACHE_VERSION || !isTimestamp(doc.fetchedAt)) return null;
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

/** model key → every record under that key, across providers. Built once per catalog. */
function indexOf(catalog) {
	let index = indexes.get(catalog);
	if (index) return index;
	index = new Map();
	for (const [provider, models] of Object.entries(catalog)) {
		for (const [key, record] of Object.entries(models ?? {})) {
			if (!index.has(key)) index.set(key, []);
			index.get(key).push({ provider, key, ...record });
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

// Rule 3 needs this many hits: one or two resellers agreeing vouch for nothing.
export const MIN_AGREEING_HITS = 3;

/** The value every hit gives for `field`, or undefined if any hit lacks it or differs. */
function agreed(hits, field) {
	if (hits.length < MIN_AGREEING_HITS) return undefined;
	if (!hits.every((hit) => isPositiveInteger(hit[field]))) return undefined;
	const values = new Set(hits.map((hit) => hit[field]));
	return values.size === 1 ? [...values][0] : undefined;
}

const FIELDS = [["contextWindow", "context"], ["maxTokens", "output"]];

/**
 * Apply the matching rules in the header to one id. Pure.
 *
 * @returns {{rule?: "endpoint"|"owner"|"agreed", record?: string, candidates: number,
 *   contextWindow?: number, maxTokens?: number, reason?: string, dropped?: string,
 *   warnings: Array<{field: string, text: string}>}}
 */
export function matchModelsDev(catalog, { endpointId, modelId }) {
	if (!catalog) return { candidates: 0, reason: "models.dev catalog unavailable", warnings: [] };
	const hits = indexOf(catalog).get(modelId) ?? [];
	if (hits.length === 0) return { candidates: 0, reason: `models.dev lists no model with id "${modelId}"`, warnings: [] };

	const own = hits.find((hit) => hit.provider === endpointId);
	if (own) return { ...recordFrom(own, "endpoint", hits.length), warnings: [] };

	const owners = new Set(hits.map((hit) => hit.canonical?.split("/")[0]).filter(Boolean));
	const ownerHits = hits.filter((hit) => owners.has(hit.provider));
	if (ownerHits.length === 1) {
		const [owner] = ownerHits;
		const result = recordFrom(owner, "owner", hits.length);
		const others = hits.filter((hit) => hit !== owner);
		result.warnings = [];
		for (const [field, key] of FIELDS) {
			const value = result[field];
			const theirs = others.map((hit) => hit[key]).filter(isPositiveInteger);
			// Every other hit carries the field and none agrees with the owner.
			if (value !== undefined && theirs.length > 0 && theirs.length === others.length && !theirs.includes(value)) {
				const distinct = [...new Set(theirs)].sort((a, b) => a - b).join("/");
				result.warnings.push({
					field,
					text: `${modelId}: ${field} ${value} from owner ${owner.provider} differs from every other models.dev provider (${distinct}); using the owner's`,
				});
			}
		}
		return result;
	}

	const contextWindow = agreed(hits, "context");
	const maxTokens = agreed(hits, "output");
	if (contextWindow === undefined && maxTokens === undefined) {
		const why = hits.length < MIN_AGREEING_HITS
			? `only ${hits.length} models.dev ${hits.length === 1 ? "entry lists" : "entries list"} "${modelId}", none of them this endpoint or the owner`
			: `${hits.length} models.dev entries for "${modelId}" disagree and none is the owner`;
		return { candidates: hits.length, reason: why, warnings: [] };
	}
	return { ...saneLimits({ rule: "agreed", candidates: hits.length, contextWindow, maxTokens }), warnings: [] };
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
 * `warnings` (an override and a models.dev value that did not fit together)
 * and `problems` (an override that was invalid and skipped) are always arrays.
 */
export function resolveModelLimits(catalog, { endpointId, modelId, overrides }) {
	// Own keys only: "constructor" or "toString" is not an override.
	const own = overrides && typeof overrides === "object" && Object.hasOwn(overrides, modelId) ? overrides[modelId] : undefined;
	const override = own && typeof own === "object" && !Array.isArray(own) ? { ...own } : {};
	// Two overrides that cannot both be true (maxTokens above the window):
	// the window stands and the maxTokens override is skipped, like any other
	// invalid value — reported in `problems`, and refused before any write by
	// pi-models-sync's configProblems. maxTokens <= contextWindow holds at the
	// seam exactly as in models.json.
	if (isPositiveInteger(override.contextWindow) && isPositiveInteger(override.maxTokens) && override.maxTokens > override.contextWindow) {
		delete override.maxTokens;
	}
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
	// An override and a models.dev value that no longer fit together: the
	// override stands, the models.dev value becomes unknown, and it is said.
	const conflicts = [];
	if (isPositiveInteger(result.contextWindow) && isPositiveInteger(result.maxTokens) && result.maxTokens > result.contextWindow) {
		if (result.fields.contextWindow === "models.dev" && result.fields.maxTokens === "override") {
			conflicts.push(
				`${modelId}: overridden maxTokens ${result.maxTokens} exceeds models.dev contextWindow ${result.contextWindow}; contextWindow left unknown`,
			);
			delete result.contextWindow;
			result.fields.contextWindow = "unknown";
		} else if (result.fields.contextWindow === "override" && result.fields.maxTokens === "models.dev") {
			conflicts.push(
				`${modelId}: models.dev maxTokens ${result.maxTokens} exceeds overridden contextWindow ${result.contextWindow}; maxTokens left unknown`,
			);
			delete result.maxTokens;
			result.fields.maxTokens = "unknown";
		}
	}
	// The match's own notes (an owner overruling every reseller) count only
	// for fields that were actually written from it.
	const notes = (match?.warnings ?? []).filter((note) => result.fields[note.field] === "models.dev").map((note) => note.text);
	result.warnings = [...notes, ...conflicts];
	// A bad override is skipped, never silently: the caller can show why.
	result.problems = overrideProblems(modelId, own);
	const origins = Object.values(result.fields);
	result.source = origins.includes("override") ? "override" : origins.includes("models.dev") ? "models.dev" : "unknown";
	if (match) result.match = match;
	return result;
}

/**
 * One line about where the catalog came from, when the user should know:
 * models.dev unreachable with no copy, or an old copy in use. Null otherwise.
 */
export function catalogNotice(loaded, now = Date.now()) {
	if (loaded?.origin === "unavailable") {
		return `models.dev unreachable and no cached copy (${loaded.error}); contextWindow/maxTokens stay unknown except per-model overrides, and pi uses its own defaults until ${MODELS_DEV_URL} can be reached`;
	}
	if (loaded?.origin === "stale-cache") {
		const hours = Math.floor(Math.max(0, now - loaded.fetchedAt) / 3_600_000);
		const age = hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
		return `models.dev unreachable (${loaded.error}); using the cached copy from ${new Date(loaded.fetchedAt).toISOString()} (${age} old)`;
	}
	return null;
}

/**
 * The seam other code builds against: `{ contextWindow, maxTokens, source }`,
 * each limit a positive integer or undefined (unknown), and maxTokens never
 * above contextWindow when both are present. Also: `origin` (where the
 * catalog came from, as in loadModelsDev, or "not-needed" when both limits
 * are overridden), `fields`, `match?`, and `warnings[]`/`problems[]` — the
 * catalog notice (stale or unavailable) is the first warning, as in sync.
 *
 * Loads the catalog per call; a caller resolving many models should call
 * loadModelsDev once and resolveModelLimits per model, as pi-models-sync does.
 */
export async function lookupModelLimits({ endpointId, modelId, overrides, fetchImpl, cacheDir } = {}) {
	const own = overrides && typeof overrides === "object" && Object.hasOwn(overrides, modelId) ? overrides[modelId] : undefined;
	// Fully and validly overridden: no reason to touch the network.
	const covered =
		isPositiveInteger(own?.contextWindow) && isPositiveInteger(own?.maxTokens) && own.maxTokens <= own.contextWindow;
	const loaded = covered
		? { catalog: null, origin: "not-needed" }
		: await loadModelsDev({ ...(fetchImpl ? { fetchImpl } : {}), ...(cacheDir ? { cacheDir } : {}) });
	const result = resolveModelLimits(loaded.catalog, { endpointId, modelId, overrides });
	result.origin = loaded.origin;
	const notice = catalogNotice(loaded);
	if (notice) result.warnings.unshift(notice);
	return result;
}
