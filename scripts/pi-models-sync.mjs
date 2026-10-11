#!/usr/bin/env node
/**
 * pi-models-sync.mjs — rebuild pi's model catalog from an OpenAI-compatible
 * endpoint, keeping only the models that actually answer.
 *
 * Layer 1 of model routing (see docs/model-routing.md) is pi's own inventory:
 * `~/.pi/agent/models.json`. pi has NO model discovery — every model must be
 * listed by hand — so this writes that file. It is deliberately the only thing
 * in the pack that touches it.
 *
 * Two rules earned the hard way, both about not trusting a listing:
 *
 *   1. A proxy happily lists models whose upstream is gone (530 tunnel down,
 *      403 unentitled workspace, 404 no credentials). Listing proves nothing;
 *      only a completion that comes back does. Hence the probe.
 *   2. `reasoning` must come from the probe too, never from the model's NAME.
 *      A name heuristic marked glm-5.2 and poolside/laguna-s-2.1 as
 *      non-reasoning; both return reasoning_content. Paseo reads that flag
 *      verbatim, reports thinkingOptions: "none", and then refuses every route
 *      above `thinking: off` — a wrong flag here silently costs you the model.
 *
 * Knows nothing about Paseo: refreshing the daemon's cached catalog is the
 * caller's job (`pteam models sync` does it, see cmdModelsSync). That keeps
 * this runnable on a host with no daemon at all.
 *
 * Several endpoints may be configured at once; they are written into one
 * models.json in a single pass, so a run leaves one backup and one file, and a
 * provider whose endpoint is down keeps the entry it already had.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { PRIVATE_FILE_MODE } from "./lib-common.mjs";

// --- config ----------------------------------------------------------------

/**
 * Thinking levels pi accepts, mapped onto what a generic reasoning endpoint
 * understands. No entry may be null: pi treats a null as "unsupported" and
 * clamps the level away silently, which preflight then cannot verify.
 */
export const THINKING_LEVEL_MAP = Object.freeze({
	minimal: "low",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "high",
	max: "high",
});

export const DEFAULT_CONFIG = Object.freeze({
	api: "openai-completions",
	keyEnv: "CODING_API_KEY",
	keyFile: "",
	probe: true,
	concurrency: 5,
	contextWindow: 200_000,
	maxTokens: 32_000,
});

/**
 * Accept either shape and hand one shape onward.
 *
 * The section started as a single endpoint (`{provider, baseUrl, ...}` at the
 * top level) and grew a `providers` map. Files written under the old shape are
 * still on disk and still correct, so they are read as a one-entry map rather
 * than rejected — and nothing downstream has to know which shape it came from.
 *
 * @returns {{entries: Array<{name: string} & typeof DEFAULT_CONFIG>, legacy: boolean}}
 */
export function normalizeConfig(doc) {
	const source = doc && typeof doc === "object" ? doc : {};
	const legacy = typeof source.provider === "string" && source.provider.trim() !== "" && !source.providers;
	const raw = legacy
		? { [source.provider]: source }
		: (source.providers && typeof source.providers === "object" ? source.providers : {});
	const entries = Object.entries(raw)
		.filter(([name, value]) => typeof name === "string" && name.trim() !== "" && value && typeof value === "object")
		.map(([name, value]) => ({ ...DEFAULT_CONFIG, ...value, name: name.trim() }));
	return { entries, legacy };
}

/** A host whose traffic never leaves the machine. */
function isLoopback(hostname) {
	const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
	return host === "localhost" || host === "::1" || /^127\./.test(host);
}

/**
 * Why a baseUrl cannot be used, or null.
 *
 * Every request carries `Authorization: Bearer <key>`, so a plain-http endpoint
 * puts the key on the wire in clear. https is required — except on loopback,
 * where the traffic never leaves the machine and a local proxy over http is a
 * normal way to run one of these.
 */
export function baseUrlProblem(baseUrl) {
	if (typeof baseUrl !== "string" || baseUrl.trim() === "") return "baseUrl is required";
	let url;
	try {
		url = new URL(baseUrl);
	} catch {
		return `baseUrl is not a URL: ${baseUrl}`;
	}
	if (url.protocol === "https:") return null;
	if (url.protocol === "http:" && isLoopback(url.hostname)) return null;
	return `baseUrl must be https (the API key is sent to it); got ${url.protocol}//${url.hostname}`;
}

/** Problems that must stop a run before it touches the network. */
export function configProblems(entries) {
	const problems = [];
	if (entries.length === 0) problems.push("no provider configured");
	for (const entry of entries) {
		const bad = baseUrlProblem(entry.baseUrl);
		if (bad) problems.push(`provider "${entry.name}": ${bad}`);
		// A slash would split the pi model reference in the wrong place:
		// Paseo splits "<pi-provider>/<model-id>" at the FIRST slash only.
		if (entry.name.includes("/")) problems.push(`provider "${entry.name}": name must not contain "/"`);
	}
	return problems;
}

function expandHome(value) {
	if (typeof value !== "string" || value === "") return value;
	return value.startsWith("~/") || value === "~" ? join(homedir(), value.slice(1)) : value;
}

/**
 * Read KEY=VALUE out of an env file. The Paseo daemon gets the same file
 * through systemd's EnvironmentFile=, which an interactive shell never reads —
 * so reading it here is what makes the command work without asking anyone to
 * export a secret into every process they run.
 */
export function readEnvFileValue(text, name) {
	for (const line of String(text).split(/\r?\n/)) {
		const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
		if (!match || match[1] !== name) continue;
		let value = match[2].trim();
		// One matching pair of quotes; systemd and sh both accept either.
		if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
			value = value.slice(1, -1);
		}
		if (value !== "") return value;
	}
	return null;
}

export function resolveApiKey(entry, env = process.env) {
	const name = entry.keyEnv || DEFAULT_CONFIG.keyEnv;
	const fromEnv = env[name];
	if (fromEnv) return { key: fromEnv, source: `env ${name}` };
	const file = expandHome(entry.keyFile);
	if (file && existsSync(file)) {
		const key = readEnvFileValue(readFileSync(file, "utf8"), name);
		if (key) return { key, source: file };
	}
	return { key: null, source: null, tried: [`env ${name}`, file || "(no keyFile configured)"] };
}

// --- probing ---------------------------------------------------------------

/**
 * Did this answer carry reasoning?
 *
 * Three signals, weakest last. The last one matters: asked something trivial a
 * thinking model answers straight off and reports zero reasoning tokens, so
 * behaviour alone under-reports. A response that carries the reasoning SHAPE
 * (`reasoning_content: null` included) is from a model that can think and had
 * nothing to think about; a response missing those keys entirely is not.
 */
export function readsAsThinking(body) {
	const message = body?.choices?.[0]?.message ?? {};
	const details = body?.usage?.completion_tokens_details ?? {};
	if (typeof message.reasoning_content === "string" && message.reasoning_content.trim() !== "") return true;
	if (Number(details.reasoning_tokens ?? 0) > 0) return true;
	return "reasoning_content" in message || "reasoning_tokens" in details;
}

/** Why a model is dead, short enough for one line of a report. */
export function describeFailure(status, text) {
	if (status === 530 || /tunnel/i.test(text)) return "530 upstream tunnel down";
	if (/unavailable/i.test(text)) return "model unavailable";
	try {
		const body = JSON.parse(text);
		const message = body.message ?? body.error?.message ?? "";
		return `${status} ${message}`.trim().slice(0, 70);
	} catch {
		return `HTTP ${status}`.slice(0, 70);
	}
}

// A question with exactly one deduction in it. "hi" is answered off the top,
// which is what made a thinking model look like a plain one.
const PROBE_PROMPT = "What is 2+2? Reply with the number only.";

async function ask(fetchImpl, baseUrl, auth, id, withReasoning, signal) {
	const response = await fetchImpl(`${baseUrl}/chat/completions`, {
		method: "POST",
		headers: { ...auth, "Content-Type": "application/json" },
		body: JSON.stringify({
			model: id,
			messages: [{ role: "user", content: withReasoning ? PROBE_PROMPT : "hi" }],
			// A thinking model spends the budget reasoning before it writes one
			// visible token; 4 would come back empty and read as dead.
			max_tokens: withReasoning ? 48 : 4,
			stream: false,
			...(withReasoning ? { reasoning_effort: "medium" } : {}),
		}),
		signal,
	});
	return { response, text: await response.text() };
}

export async function probeModel({ fetchImpl, baseUrl, auth, id, timeoutMs = 45_000 }) {
	try {
		const signal = AbortSignal.timeout(timeoutMs);
		let { response, text } = await ask(fetchImpl, baseUrl, auth, id, true, signal);
		let refusedReasoning = false;
		if (!response.ok) {
			// Only a model that rejects `reasoning_effort` needs a second call.
			const retry = await ask(fetchImpl, baseUrl, auth, id, false, signal);
			if (retry.response.ok) {
				refusedReasoning = true;
				response = retry.response;
				text = retry.text;
			}
		}
		if (!response.ok) return { id, live: false, why: describeFailure(response.status, text) };
		const body = JSON.parse(text);
		const reasoning = !refusedReasoning && readsAsThinking(body);
		const content = body?.choices?.[0]?.message?.content;
		// Answering entirely inside reasoning_content is still an answer.
		if (typeof content !== "string" && !reasoning) return { id, live: false, why: "response carried no content" };
		return { id, live: true, reasoning };
	} catch (error) {
		const why = error?.name === "TimeoutError" ? "timeout" : String(error?.message ?? error);
		return { id, live: false, why: why.slice(0, 70) };
	}
}

async function pool(items, limit, fn) {
	const list = Array.from(items);
	const width = Math.max(1, Math.min(16, Math.floor(limit) || 1));
	const out = [];
	let cursor = 0;
	async function worker() {
		while (cursor < list.length) out.push(await fn(list[cursor++]));
	}
	await Promise.all(Array.from({ length: Math.min(width, list.length) }, () => worker()));
	return out;
}

// --- catalog ---------------------------------------------------------------

export function buildModelEntry(id, reasoning, entry = {}) {
	return {
		id,
		name: id,
		contextWindow: entry.contextWindow ?? DEFAULT_CONFIG.contextWindow,
		maxTokens: entry.maxTokens ?? DEFAULT_CONFIG.maxTokens,
		reasoning,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		...(reasoning ? { thinkingLevelMap: { ...THINKING_LEVEL_MAP } } : {}),
	};
}

/**
 * Replace one provider's entry in models.json, leaving every other provider
 * exactly as it was: this file is user-owned and may describe runtimes this
 * pack knows nothing about.
 */
export function mergeCatalog(existing, entry, models) {
	const next = existing && typeof existing === "object" ? { ...existing } : {};
	next.providers = { ...(next.providers ?? {}) };
	next.providers[entry.name] = {
		baseUrl: String(entry.baseUrl).replace(/\/+$/, ""),
		api: entry.api ?? DEFAULT_CONFIG.api,
		apiKey: `$${entry.keyEnv || DEFAULT_CONFIG.keyEnv}`,
		models,
	};
	return next;
}

/**
 * Probe ONE endpoint and decide what its catalog entry should contain.
 * Touches no file: the caller writes once for every provider together, so a
 * run over three endpoints leaves one backup rather than three.
 */
export async function syncProvider(options) {
	const {
		entry,
		apiKey,
		fetchImpl = fetch,
		probe = entry.probe !== false,
		keepAll = false,
		previousReasoning = new Map(),
		// Node's fetch waits up to 300s for headers and again between body
		// chunks. Every probe below is already bounded; the listing was not, so
		// one unresponsive endpoint could hold the whole run — and the WebUI
		// button — for five minutes before anything was reported.
		listTimeoutMs = 20_000,
	} = options;
	const baseUrl = String(entry.baseUrl).replace(/\/+$/, "");
	const auth = { Authorization: `Bearer ${apiKey}` };

	let listed;
	let listedText;
	try {
		// One signal for both: a body that never finishes arriving is the same
		// failure as headers that never arrive.
		const signal = AbortSignal.timeout(listTimeoutMs);
		listed = await fetchImpl(`${baseUrl}/models`, { headers: auth, signal });
		listedText = await listed.text();
	} catch (error) {
		const message = error?.name === "TimeoutError" ? `khong tra loi trong ${listTimeoutMs} ms` : String(error?.message ?? error);
		return { ok: false, provider: entry.name, baseUrl, code: "ENDPOINT_UNREACHABLE", message };
	}
	if (!listed.ok) {
		return {
			ok: false,
			provider: entry.name,
			baseUrl,
			code: "ENDPOINT_LIST_FAILED",
			message: `GET ${baseUrl}/models -> ${describeFailure(listed.status, listedText)}`,
		};
	}
	let ids;
	try {
		const parsed = JSON.parse(listedText);
		ids = (Array.isArray(parsed) ? parsed : parsed.data ?? [])
			.map((item) => (typeof item === "string" ? item : item?.id))
			.filter((id) => typeof id === "string" && id !== "")
			.sort();
	} catch (error) {
		return { ok: false, provider: entry.name, baseUrl, code: "ENDPOINT_LIST_UNREADABLE", message: String(error?.message ?? error) };
	}
	if (ids.length === 0) {
		return { ok: false, provider: entry.name, baseUrl, code: "ENDPOINT_LIST_EMPTY", message: `${baseUrl}/models returned no model` };
	}

	let probed = [];
	let live = ids;
	if (probe) {
		probed = (await pool(ids, entry.concurrency ?? DEFAULT_CONFIG.concurrency, (id) =>
			probeModel({ fetchImpl, baseUrl, auth, id }),
		)).sort((a, b) => a.id.localeCompare(b.id));
		live = probed.filter((r) => r.live).map((r) => r.id);
		if (live.length === 0) {
			// Never leave a provider with an empty catalog: a flaky network
			// would otherwise delete a working setup.
			return {
				ok: false,
				provider: entry.name,
				baseUrl,
				code: "ALL_MODELS_DEAD",
				message: "no model answered; this provider is left exactly as it was",
				listed: ids.length,
				probed,
			};
		}
		if (keepAll) live = ids;
	}

	// This run's evidence wins; a model it did not probe keeps whatever an
	// earlier run proved; anything never seen before is written as
	// non-reasoning, which costs thinking levels but never invents a capability.
	const proven = new Map(probed.filter((r) => r.live).map((r) => [r.id, r.reasoning === true]));
	const models = live.map((id) =>
		buildModelEntry(id, proven.has(id) ? proven.get(id) : previousReasoning.get(id) === true, entry),
	);
	return {
		ok: true,
		provider: entry.name,
		baseUrl,
		listed: ids.length,
		written: models.length,
		probed,
		models,
	};
}

/**
 * Rebuild every configured provider's catalog and write models.json once.
 *
 * A provider that fails does not stop the others and does not lose its
 * existing entry: a dead endpoint leaves yesterday's models in place rather
 * than deleting them, and the failure is reported instead of swallowed.
 */
export async function syncModels(options) {
	const { entries, keys, modelsPath, fetchImpl = fetch, probe, keepAll = false, dryRun = false, listTimeoutMs } = options;

	let existing = {};
	if (existsSync(modelsPath)) {
		try {
			existing = JSON.parse(readFileSync(modelsPath, "utf8"));
		} catch (error) {
			return { ok: false, code: "CATALOG_UNREADABLE", message: `${modelsPath}: ${String(error?.message ?? error)}` };
		}
	}

	const results = [];
	for (const entry of entries) {
		const previousReasoning = new Map(
			(existing?.providers?.[entry.name]?.models ?? [])
				.filter((m) => m && typeof m.id === "string")
				.map((m) => [m.id, m.reasoning === true]),
		);
		results.push(
			await syncProvider({
				entry,
				apiKey: keys.get(entry.name),
				fetchImpl,
				probe: probe === undefined ? entry.probe !== false : probe,
				keepAll,
				previousReasoning,
				...(listTimeoutMs === undefined ? {} : { listTimeoutMs }),
			}),
		);
	}

	const succeeded = results.filter((r) => r.ok);
	const report = {
		ok: succeeded.length === results.length,
		path: modelsPath,
		dryRun,
		providers: results.map(({ models, ...rest }) => ({
			...rest,
			...(models ? { models: models.map((m) => ({ id: m.id, reasoning: m.reasoning })) } : {}),
		})),
	};
	if (dryRun || succeeded.length === 0) return report;

	let next = existing;
	for (const result of succeeded) {
		next = mergeCatalog(next, entries.find((e) => e.name === result.provider), result.models);
	}
	if (existsSync(modelsPath)) {
		const backup = `${modelsPath}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
		copyFileSync(modelsPath, backup);
		report.backup = backup;
	}
	mkdirSync(dirname(modelsPath), { recursive: true });
	// The catalog can carry provider credentials. An existing file is rewritten
	// in place and keeps the mode its owner chose; a new one starts private.
	writeFileSync(modelsPath, `${JSON.stringify(next, null, 2)}\n`, { mode: PRIVATE_FILE_MODE });
	return report;
}
