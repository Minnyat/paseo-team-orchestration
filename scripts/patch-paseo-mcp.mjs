#!/usr/bin/env node
// patch-paseo-mcp.mjs — let Paseo's bundled MCP server accept a client that
// speaks a NEWER protocol revision than the SDK it was built against.
//
// The bug, from ~/.paseo/daemon.log:
//
//   Bad Request: Unsupported protocol version: 2026-07-28
//   (supported versions: 2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05, 2024-10-07)
//
// Paseo injects its orchestration MCP into every agent over HTTP — the agent
// record carries `mcpServers.paseo = { type: "http", url:
// "http://127.0.0.1:<port>/mcp/agents?callerAgentId=..." }` — so this is not a
// cosmetic log line: it is a 400 on `create_agent`, `send_agent_prompt`,
// `list_agents`, `respond_to_permission` and Browser Control, i.e. on the whole
// Lead surface, for every Claude-hosted seat.
//
// Whose fault: the MCP spec says a client sends the NEGOTIATED version in the
// `MCP-Protocol-Version` header, and Claude Code sends its own latest instead.
// The initialize handshake itself succeeds (it carries no such header); the
// very next request 400s. Paseo cannot fix a client it does not ship, and the
// bundled @modelcontextprotocol/sdk is a transitive pin we do not control
// either — so the durable fix is to make the SERVER liberal in what it accepts.
//
// What this changes: exactly one condition, in the two files that carry it.
// A header version stays rejected unless it is a well-formed YYYY-MM-DD dated
// revision NEWER than everything the SDK knows — "the client is ahead of us",
// which is the only case that is safe to wave through. Garbage, and genuinely
// unknown older strings, still 400.
//
// What this does NOT change: SUPPORTED_PROTOCOL_VERSIONS, so the initialize
// handshake still negotiates the SDK's real latest. The server never claims a
// protocol it does not implement; it only stops arguing about a header.
//
// Idempotent, reversible, and re-appliable: `npm i -g @getpaseo/cli` replaces
// node_modules and silently reverts this, so re-run it after every Paseo
// update. `--verify` answers without writing (exit 1 when unpatched), which is
// what preflight's `paseo-mcp-protocol` check calls.
//
// Usage:
//   node scripts/patch-paseo-mcp.mjs [--apply|--verify|--revert] [--json]
//                                    [--sdk-dir <dir>]

import { existsSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { isEntrypoint } from "./lib-common.mjs";

/**
 * Marker that makes the patch self-identifying, so re-running is a no-op.
 *
 * The string is frozen at the pack's former name on purpose. It is not a label
 * we print — it is compared against bytes already written into every Paseo MCP
 * dist file this pack has ever patched (see `source.includes(PATCH_MARKER)`
 * below). Renaming it would make each of those files read as unpatched, so the
 * next run would patch an already-patched file and `revert` would find nothing
 * to undo. A rename here needs a migration that recognizes both strings.
 */
export const PATCH_MARKER = "paseo-pi-team:accept-newer-protocol";

/** The two dist builds that carry the header check. */
export const PATCH_TARGETS = [
	"dist/esm/server/webStandardStreamableHttp.js",
	"dist/cjs/server/webStandardStreamableHttp.js",
];

/**
 * The condition the SDK ships, anchored on its full text so that a reworded
 * upstream check FAILS LOUDLY instead of being patched blind.
 *
 * The one thing that legitimately varies is how the constant is referenced:
 * the ESM build names it bare, the CJS build namespaces it through tsc's
 * import alias (`types_js_1.SUPPORTED_PROTOCOL_VERSIONS`), and that alias is a
 * generated name nobody should hardcode. So the qualifier is CAPTURED and
 * replayed rather than matched literally — a literal match is what let this
 * script patch the ESM build and then fail on the CJS one, which is worse than
 * either patching both or refusing both.
 */
const CONDITION_RE =
	/if \(protocolVersion !== null && !((?:[A-Za-z_$][\w$]*\.)?)SUPPORTED_PROTOCOL_VERSIONS\.includes\(protocolVersion\)\) \{/g;

/**
 * The same shape once patched, for revert. PATCH_MARKER is interpolated raw:
 * it is a fixed literal with no regex metacharacter in it (`-` is only special
 * inside a character class). A test pins that, so a marker later edited to
 * contain one cannot slip through unnoticed.
 */
const PATCHED_RE = new RegExp(
	String.raw`if \(protocolVersion !== null && !((?:[A-Za-z_$][\w$]*\.)?)SUPPORTED_PROTOCOL_VERSIONS\.includes\(protocolVersion\) && !\(/\* ` +
		PATCH_MARKER +
		String.raw` \*/ /\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$/\.test\(protocolVersion\) && protocolVersion > (?:[A-Za-z_$][\w$]*\.)?SUPPORTED_PROTOCOL_VERSIONS\[0\]\)\) \{`,
	"g",
);

const originalCondition = (qualifier) =>
	`if (protocolVersion !== null && !${qualifier}SUPPORTED_PROTOCOL_VERSIONS.includes(protocolVersion)) {`;

/**
 * `> SUPPORTED_PROTOCOL_VERSIONS[0]` is a string compare, which is exactly
 * right for zero-padded YYYY-MM-DD: element 0 is LATEST_PROTOCOL_VERSION in
 * every published build of this SDK.
 */
const patchedCondition = (qualifier) =>
	`if (protocolVersion !== null && !${qualifier}SUPPORTED_PROTOCOL_VERSIONS.includes(protocolVersion)` +
	` && !(/* ${PATCH_MARKER} */ /^\\d{4}-\\d{2}-\\d{2}$/.test(protocolVersion)` +
	` && protocolVersion > ${qualifier}SUPPORTED_PROTOCOL_VERSIONS[0])) {`;

export class PatchError extends Error {
	constructor(code, message) {
		super(`${code}: ${message}`);
		this.name = "PatchError";
		this.code = code;
	}
}

/**
 * Exactly one match, or refuse: zero means the check moved or was reworded,
 * and more than one means this file has a shape the patch was never designed
 * for and guessing which occurrence to rewrite is not a decision a script gets
 * to make.
 */
function soleMatch(source, re, what) {
	const matches = [...source.matchAll(re)];
	if (matches.length === 1) return matches[0];
	throw new PatchError(
		"PATTERN_NOT_FOUND",
		matches.length === 0
			? `${what} does not look the way this patch expects — refusing to guess. Report it rather than editing by hand: the check may have moved, or upstream may have fixed it, in which case this script is no longer needed`
			: `${what} matched ${matches.length} times in one file; this patch rewrites exactly one occurrence and will not choose between them`,
	);
}

/**
 * Rewrite one file's source. Pure, so the transform is testable without a
 * Paseo install on disk.
 *
 * @returns {{ source: string, state: "patched" | "already" }}
 */
export function patchSource(source) {
	if (source.includes(PATCH_MARKER)) return { source, state: "already" };
	const [, qualifier] = soleMatch(
		source,
		CONDITION_RE,
		"the SDK's protocol-version check",
	);
	return {
		source: source.replace(
			originalCondition(qualifier),
			patchedCondition(qualifier),
		),
		state: "patched",
	};
}

/** Undo patchSource. Returns the source unchanged when it was never patched. */
export function revertSource(source) {
	if (!source.includes(PATCH_MARKER)) return { source, state: "already" };
	const [, qualifier] = soleMatch(
		source,
		PATCHED_RE,
		"this patch's own marker, but the text around it,",
	);
	return {
		source: source.replace(
			patchedCondition(qualifier),
			originalCondition(qualifier),
		),
		state: "reverted",
	};
}

/**
 * Locate the MCP SDK inside the globally installed Paseo CLI.
 *
 * `npm root -g` rather than a hardcoded path: the global prefix differs per
 * platform and per nvm/volta install, and getting it wrong would silently
 * patch nothing.
 */
export function resolveSdkDir(explicit = null, env = process.env) {
	if (explicit) return explicit;
	const fromEnv = env.PASEO_TEAM_MCP_SDK_DIR;
	if (fromEnv) return fromEnv;
	let root;
	try {
		// execSync, not execFileSync: npm is npm.cmd on Windows and Node refuses
		// to spawn a .cmd without a shell (EINVAL). The command is a fixed
		// literal with nothing interpolated into it, so the shell adds no
		// injection surface — and passing ARGS through a shell, which is what
		// DEP0190 warns about, is exactly what this form avoids.
		root = execSync("npm root -g", { encoding: "utf8" }).trim();
	} catch (err) {
		throw new PatchError(
			"NPM_ROOT_UNAVAILABLE",
			`could not run \`npm root -g\` to find the Paseo install (${err.message}). Pass --sdk-dir <dir> explicitly`,
		);
	}
	return join(
		root,
		"@getpaseo",
		"cli",
		"node_modules",
		"@modelcontextprotocol",
		"sdk",
	);
}

/**
 * Apply, verify or revert across every target file.
 *
 * A backup is written beside each file on the first real write only — a second
 * run must not overwrite the pristine copy with an already-patched one.
 */
export function runPatch({ sdkDir, mode = "apply" } = {}) {
	if (!existsSync(sdkDir)) {
		throw new PatchError(
			"SDK_NOT_FOUND",
			`no MCP SDK at ${sdkDir} — is @getpaseo/cli installed globally? Pass --sdk-dir <dir> if it lives elsewhere`,
		);
	}
	// TWO PHASES, and the split is the point. The ESM and CJS builds of this SDK
	// spell the same check differently, so transforming-and-writing in one pass
	// let a first file be rewritten and a second one throw — leaving the daemon
	// with one build patched and one not, which is a worse state than either
	// end and a silent one. Every transform is computed first; nothing is
	// written unless all of them succeeded.
	const planned = [];
	for (const relative of PATCH_TARGETS) {
		const path = join(sdkDir, relative);
		if (!existsSync(path)) {
			throw new PatchError(
				"TARGET_MISSING",
				`expected ${relative} inside ${sdkDir}, but it is not there`,
			);
		}
		const before = readFileSync(path, "utf8");
		if (mode === "verify") {
			planned.push({
				file: relative,
				state: before.includes(PATCH_MARKER) ? "already" : "unpatched",
			});
			continue;
		}
		const { source, state } =
			mode === "revert" ? revertSource(before) : patchSource(before);
		planned.push({ file: relative, state, path, before, source });
	}
	if (mode !== "verify") {
		for (const entry of planned) {
			if (entry.source === entry.before) continue;
			const backup = `${entry.path}.paseo-team-backup`;
			// Only on the first real write: a second apply must not overwrite the
			// pristine copy with an already-patched one.
			if (mode === "apply" && !existsSync(backup)) {
				copyFileSync(entry.path, backup);
			}
			writeFileSync(entry.path, entry.source);
		}
	}
	const files = planned.map(({ file, state }) => ({ file, state }));
	const patched = files.every((entry) => entry.state !== "unpatched");
	return { ok: mode !== "verify" || patched, sdkDir, mode, files, patched };
}

function parse(argv) {
	const out = { mode: "apply", json: false, sdkDir: null };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--apply") out.mode = "apply";
		else if (arg === "--verify") out.mode = "verify";
		else if (arg === "--revert") out.mode = "revert";
		else if (arg === "--json") out.json = true;
		else if (arg === "--sdk-dir") out.sdkDir = argv[++i] ?? null;
		else if (arg === "-h" || arg === "--help") out.help = true;
		else throw new PatchError("USAGE", `unknown flag "${arg}"`);
	}
	return out;
}

async function main(argv) {
	let opts;
	try {
		opts = parse(argv);
	} catch (err) {
		console.error(err.message);
		return 1;
	}
	if (opts.help) {
		console.log(
			"usage: node scripts/patch-paseo-mcp.mjs [--apply|--verify|--revert] [--json] [--sdk-dir <dir>]",
		);
		return 0;
	}
	try {
		const result = runPatch({
			sdkDir: resolveSdkDir(opts.sdkDir),
			mode: opts.mode,
		});
		if (opts.json) {
			console.log(JSON.stringify(result, null, 2));
		} else {
			for (const entry of result.files) {
				console.log(`${entry.state.padEnd(9)} ${entry.file}`);
			}
			if (opts.mode === "apply") {
				console.log(
					"\nRestart the Paseo daemon for this to take effect, and re-run after every `npm i -g @getpaseo/cli`.",
				);
			}
		}
		return result.ok ? 0 : 1;
	} catch (err) {
		if (opts.json) {
			console.log(
				JSON.stringify(
					{ ok: false, code: err.code ?? "UNKNOWN", message: err.message },
					null,
					2,
				),
			);
		} else {
			console.error(err.message);
		}
		return 1;
	}
}

if (isEntrypoint(import.meta.url)) {
	main(process.argv.slice(2)).then((code) => {
		process.exitCode = code;
	});
}
