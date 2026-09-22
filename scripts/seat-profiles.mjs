/**
 * seat-profiles.mjs — seat vocabulary: named variants of the three base roles.
 *
 * A "seat" is not a fourth role. It is one of the six durable role providers
 * plus a name and a set of CURATED capabilities, materialized into an ordinary
 * Paseo provider entry:
 *
 *   { id: "researcher", base: "claude-peer", capabilities: ["web-research"] }
 *     -> provider "claude-peer-researcher"
 *        env  { PASEO_PI_ROLE: "peer", PASEO_TEAM_EXTRA_TOOLS: "WebFetch,WebSearch" }
 *        disallowedTools = claudeDisallowedTools("peer") evaluated under that env
 *
 * The role policy never reads a provider NAME to decide authority — it reads
 * PASEO_PI_ROLE from the environment. That is the whole reason seats are safe
 * to generate: a seat can only ever be one of the three roles the rule core
 * already knows, carrying grants from a catalog that lives in code.
 *
 * Why a catalog and not free-form tool names: this file is the allowlist. The
 * WebUI renders the capabilities described here and nothing else, so a seat
 * built in a browser can never reach a tool nobody reviewed — the same promise
 * `config-schema.mjs` makes for config fields. Adding a capability is a code
 * change with a test, deliberately.
 *
 * Vocabulary is imported, never re-typed: ROLE_PROVIDERS/TEAM_ROLES come from
 * model-routing.mjs, which is their single definition.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { teamConfigDir } from "./lib-common.mjs";
import {
	ROLE_PROVIDERS,
	RUNTIME_FAMILIES,
	TEAM_ROLES,
	providerFamily,
} from "./model-routing.mjs";

/**
 * Seat ids become the tail of a provider name, so the character set is the one
 * `parseRoleProvider` can split back out: lowercase, no slash, no dot, and it
 * may not start with a digit or dash.
 */
export const SEAT_ID_RE = /^[a-z][a-z0-9-]{1,23}$/;

/** Same shape as a provider name's head segment, for the reverse direction. */
export const SEAT_PROVIDER_RE = new RegExp(
	`^(${RUNTIME_FAMILIES.join("|")})-(${TEAM_ROLES.join("|")})-([a-z][a-z0-9-]{1,23})$`,
);

/**
 * Every capability a seat may be granted.
 *
 * `tools` are added to PASEO_TEAM_EXTRA_TOOLS, which both runtimes read
 * (`extraTools()` in policy-core.ts). `env` is for grants already expressed as
 * an environment knob rather than a tool name (`lead-write`). Both halves reach
 * the static layer the same way: `materializeSeat` recomputes disallowedTools
 * under the finished env instead of guessing which knob implies which tool.
 *
 * `roles` is the guard that keeps a grant meaningful: browser authority for a
 * Supervisor is not "extra reach", it is a contradiction of the role, so the
 * catalog refuses it rather than the UI hiding it.
 */
export const SEAT_CAPABILITIES = Object.freeze([
	Object.freeze({
		id: "web-research",
		label: "Nghiên cứu web (WebFetch + WebSearch)",
		hint:
			"Đọc tài liệu ngoài internet. Nội dung do người khác viết sẽ chảy vào agent này, nên chỉ cấp cho ghế bạn định dùng ở MODE: read-only; nếu ghế còn quyền sửa file thì đây là đường vào của prompt injection.",
		roles: Object.freeze(["lead", "peer"]),
		tools: Object.freeze(["WebFetch", "WebSearch"]),
		env: Object.freeze({}),
		families: Object.freeze(["claude"]),
	}),
	Object.freeze({
		id: "lead-write",
		label: "Lead được sửa file (Write/Edit)",
		hint:
			"Bật PASEO_TEAM_LEAD_WRITE cho riêng ghế này. Mặc định Lead chỉ đọc và điều phối; cấp quyền sửa làm mờ ranh giới giữa người giao việc và người làm việc.",
		roles: Object.freeze(["lead"]),
		tools: Object.freeze([]),
		env: Object.freeze({ PASEO_TEAM_LEAD_WRITE: "1" }),
		families: Object.freeze(["pi", "claude"]),
	}),
]);

/** Capability ids only, in catalog order. */
export const SEAT_CAPABILITY_IDS = Object.freeze(
	SEAT_CAPABILITIES.map((c) => c.id),
);

export function seatCapability(id) {
	return SEAT_CAPABILITIES.find((c) => c.id === id) ?? null;
}

/** "claude-peer" → "peer"; null when the name is not a durable role provider. */
export function baseRole(base) {
	const name = String(base ?? "").trim();
	if (!ROLE_PROVIDERS.includes(name)) return null;
	return name.slice(name.indexOf("-") + 1);
}

/** The capability ids a given base provider may take — the UI's option list. */
export function capabilitiesForBase(base) {
	const role = baseRole(base);
	const family = providerFamily(base);
	if (role === null || family === null) return [];
	return SEAT_CAPABILITIES.filter(
		(c) => c.roles.includes(role) && c.families.includes(family),
	).map((c) => c.id);
}

/** Options map for a `optionsBy` field keyed on the seat's `base`. */
export function capabilitiesByBase() {
	return Object.fromEntries(
		ROLE_PROVIDERS.map((name) => [name, capabilitiesForBase(name)]),
	);
}

/** "claude-peer" + "researcher" → "claude-peer-researcher". */
export function seatProviderName(base, id) {
	return `${base}-${id}`;
}

export const SEATS_FILENAME = "seat-profiles.local.json";
export const SEAT_LEDGER_FILENAME = "seat-providers.json";

/**
 * Both files live in the pack's config directory, which the CLI resolves with
 * `config-walker.teamConfigDir()` — the same override (`PST_TEAM_CONFIG_DIR`)
 * every other pack config honours. The directory is a PARAMETER rather than
 * something this module resolves itself: a second resolution of "where does
 * pack config live" is a second thing that can point at the user's real home
 * while the rest of a test run is sandboxed.
 *
 * The no-argument default delegates to that same resolver rather than naming a
 * directory by literal, so the env overrides and the legacy-directory fallback
 * reach this file too. `home` stays a parameter so a sandboxed run still steers
 * it without touching the real home.
 */
export function defaultTeamDir(home = homedir()) {
	return teamConfigDir(process.env, home);
}

export function seatsPath(dir = defaultTeamDir()) {
	return join(dir, SEATS_FILENAME);
}

/**
 * The ledger of provider names this tool generated.
 *
 * `seats apply` removes a provider only when the ledger says it created it.
 * Deriving ownership from the name pattern instead would let a hand-written
 * provider that happens to match get deleted by a tool that never made it —
 * the one failure mode worth spending a file to avoid.
 */
export function seatLedgerPath(dir = defaultTeamDir()) {
	return join(dir, SEAT_LEDGER_FILENAME);
}

export const SEATS_SEED = Object.freeze({ version: 1, seats: {} });

/**
 * Read a seat document into a normalized list. Accepts the map form the WebUI
 * writes (`{ seats: { researcher: {...} } }`); the id is the map key.
 */
export function listSeats(data) {
	const seats = data?.seats;
	if (seats === null || typeof seats !== "object" || Array.isArray(seats)) {
		return [];
	}
	return Object.entries(seats).map(([id, value]) => ({
		id,
		base: typeof value?.base === "string" ? value.base.trim() : "",
		label: typeof value?.label === "string" ? value.label.trim() : "",
		capabilities: Array.isArray(value?.capabilities)
			? value.capabilities.filter((c) => typeof c === "string")
			: [],
	}));
}

/**
 * Every problem with a seat document, as sentences a user can act on.
 *
 * Fail-closed on purpose: `seats apply` refuses the whole document when this
 * is non-empty rather than writing the seats it happened to understand. A
 * half-applied seat set is a config nobody can reason about.
 */
export function validateSeats(data) {
	const errors = [];
	if (data !== null && data !== undefined && typeof data !== "object") {
		return ["Tệp seat phải là một object JSON."];
	}
	// A `seats` of the wrong shape used to read as "no seats" with no error at
	// all: `list` printed nothing, `apply` created nothing, and the file looked
	// accepted. A confident empty answer is the failure this module exists to
	// avoid, so a `seats` that is present and not a plain object is refused by
	// name. Absent or null stays legitimately empty — a file may declare no
	// seats.
	const block = data?.seats;
	if (block !== null && block !== undefined && (typeof block !== "object" || Array.isArray(block))) {
		return [
			`"seats" phải là một object khoá theo tên ghế, ví dụ {"seats":{"researcher":{"base":"claude-peer"}}} — đang là ${Array.isArray(block) ? "mảng" : `kiểu ${typeof block}`}.`,
		];
	}
	const seats = listSeats(data);
	const seen = new Set();
	for (const seat of seats) {
		const where = `seat "${seat.id}"`;
		if (!SEAT_ID_RE.test(seat.id)) {
			errors.push(
				`${where}: tên ghế phải là chữ thường, 2–24 ký tự, bắt đầu bằng chữ cái, chỉ gồm a-z 0-9 và dấu gạch ngang.`,
			);
		}
		if (TEAM_ROLES.includes(seat.id)) {
			errors.push(
				`${where}: trùng tên vai trò gốc (${TEAM_ROLES.join(", ")}) — provider sinh ra sẽ không phân biệt được với ghế gốc.`,
			);
		}
		if (seen.has(seat.id)) errors.push(`${where}: bị khai báo hai lần.`);
		seen.add(seat.id);

		if (!ROLE_PROVIDERS.includes(seat.base)) {
			errors.push(
				`${where}: "base" phải là một trong sáu vai trò gốc (${ROLE_PROVIDERS.join(", ")}), đang là "${seat.base || "<trống>"}".`,
			);
			continue; // capability checks below need a known base
		}
		const allowed = capabilitiesForBase(seat.base);
		for (const id of seat.capabilities) {
			if (seatCapability(id) === null) {
				errors.push(
					`${where}: năng lực "${id}" không có trong danh mục (${SEAT_CAPABILITY_IDS.join(", ")}).`,
				);
			} else if (!allowed.includes(id)) {
				errors.push(
					`${where}: năng lực "${id}" không cấp được cho base "${seat.base}".`,
				);
			}
		}
	}
	return errors;
}

/** Tools and env a seat's capabilities add, deduplicated and ordered. */
export function resolveSeatGrants(seat) {
	const tools = [];
	const env = {};
	for (const id of seat.capabilities ?? []) {
		const capability = seatCapability(id);
		if (capability === null) continue;
		for (const tool of capability.tools) {
			if (!tools.includes(tool)) tools.push(tool);
		}
		Object.assign(env, capability.env);
	}
	return { tools, env };
}

/** The environment a seat's provider carries: its role plus its grants. */
export function seatEnv(seat) {
	const { tools, env } = resolveSeatGrants(seat);
	return {
		PASEO_PI_ROLE: baseRole(seat.base),
		...(tools.length > 0 ? { PASEO_TEAM_EXTRA_TOOLS: tools.join(",") } : {}),
		...env,
	};
}

/**
 * One Paseo provider entry for one seat.
 *
 * `disallowedFor(base, env)` must compute the static deny list *under the
 * seat's own environment*, not subtract a tool list from the base one. The
 * difference is not cosmetic: `lead-write` grants through
 * PASEO_TEAM_LEAD_WRITE, so a subtraction that only knows about `tools` leaves
 * Write/Edit in disallowedTools and ships a seat whose capability silently does
 * nothing. Asking the policy — the same function the installer asks — is also
 * the only way this file avoids re-typing which env knob implies which tool.
 */
export function materializeSeat(seat, disallowedFor = () => []) {
	const env = seatEnv(seat);
	// `extends` is the base provider's runtime family, verbatim — not a
	// pi/claude coin flip. The old ternary coerced any unknown base to "claude",
	// which would have silently mis-typed a seat once a third runtime existed;
	// listSeats has already validated base ∈ ROLE_PROVIDERS, so the family is
	// always a real one here.
	const family = providerFamily(seat.base);
	const entry = {
		extends: family,
		label: seat.label || `${seat.base} — ${seat.id}`,
		env,
	};
	const disallowed = disallowedFor(seat.base, env) ?? [];
	if (disallowed.length > 0) entry.disallowedTools = [...disallowed];
	return entry;
}

/** The whole generated provider set, keyed by provider name. */
export function materializeSeats(data, disallowedFor = () => []) {
	const out = {};
	for (const seat of listSeats(data)) {
		out[seatProviderName(seat.base, seat.id)] = materializeSeat(seat, disallowedFor);
	}
	return out;
}

/**
 * Merge generated providers into a Paseo config, and drop the ones this tool
 * created that the seat document no longer defines.
 *
 * Never touches a provider outside `ledger`: an entry a human wrote by hand
 * survives even when its name collides with a seat that was just deleted.
 * Returns the next config plus what changed, so a --dry-run can print it.
 */
export function applySeatsToPaseoConfig(config, generated, ledger = []) {
	const next = config === null || typeof config !== "object" ? {} : { ...config };
	const agents = { ...(next.agents ?? {}) };
	const providers = { ...(agents.providers ?? {}) };

	const owned = new Set(ledger);
	const created = [];
	const updated = [];
	const removed = [];
	const skipped = [];

	for (const [name, entry] of Object.entries(generated)) {
		const existing = providers[name];
		if (existing !== undefined && !owned.has(name)) {
			// A name we did not create already exists. Overwriting it would make
			// the seat editor a way to silently rewrite a hand-tuned provider.
			skipped.push(name);
			continue;
		}
		if (existing === undefined) created.push(name);
		else if (JSON.stringify(existing) !== JSON.stringify(entry)) updated.push(name);
		providers[name] = entry;
	}

	for (const name of owned) {
		if (name in generated) continue;
		if (name in providers) {
			delete providers[name];
			removed.push(name);
		}
	}

	agents.providers = providers;
	next.agents = agents;
	return {
		config: next,
		created,
		updated,
		removed,
		skipped,
		ledger: Object.keys(generated).filter((name) => !skipped.includes(name)),
	};
}
