// lib-common.mjs — helpers shared by the role-pack support scripts.
//
// INSTALL CONTRACT: the installer copies support scripts FLAT into
// ~/.pi/agent/extensions/paseo-team-scripts/, so every consumer imports this
// as "./lib-common.mjs" and this file must be listed in TEAM_SUPPORT_FILES in
// BOTH scripts/install.sh and scripts/install.ps1. A missing entry here breaks
// every installed script at import time, which is why
// test/installer-contract.test.mjs asserts the installed set can run.
//
// Nothing in here may import another support script: it sits at the bottom of
// the dependency graph on purpose.

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { delimiter, dirname, join, sep } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * True when `moduleUrl` is the process entrypoint.
 *
 * Callers pass their OWN import.meta.url — a default of import.meta.url here
 * would resolve to this file and every check would answer false.
 *
 * Compares canonical filesystem paths, not URL text: macOS temp dirs are
 * reachable through both /var and /private/var, and installed scripts are
 * often symlinked.
 */
export function isEntrypoint(moduleUrl, entry = process.argv[1]) {
	if (!entry) return false;
	try {
		return realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl));
	} catch {
		return false;
	}
}

/**
 * Split a command line into argv, honouring single and double quotes.
 *
 * Returns `{ parts, unterminated }` rather than throwing: each caller maps a
 * malformed override onto its own error contract (OcrReviewError vs
 * RemoteError), and an exception type from a shared module would have to be
 * translated at every call site anyway.
 */
export function splitCommandLine(commandLine) {
	// Reject non-strings loudly. Coercing would turn `undefined` into the argv
	// element "undefined" and spawn a nonsense binary with a confusing ENOENT.
	if (typeof commandLine !== "string") {
		throw new TypeError("splitCommandLine expects a string");
	}
	const parts = [];
	let current = "";
	let quote = "";
	for (const ch of commandLine) {
		if ((ch === '"' || ch === "'") && (!quote || quote === ch)) {
			quote = quote ? "" : ch;
			continue;
		}
		if (/\s/.test(ch) && !quote) {
			if (current) parts.push(current);
			current = "";
		} else {
			current += ch;
		}
	}
	if (current) parts.push(current);
	return { parts, unterminated: quote !== "" };
}

/** PATH entries, plus the npm global bin on Windows.
 *
 * `%APPDATA%\npm` holds npm-installed CLI shims and is frequently absent from
 * a child process's PATH (services, IDE terminals, spawned daemons), so a
 * globally installed `paseo`/`ocr` would look missing without it. */
export function searchPathDirs(env = process.env) {
	const dirs = (env.PATH ?? "").split(delimiter).filter(Boolean);
	if (process.platform === "win32" && env.APPDATA) {
		dirs.push(join(env.APPDATA, "npm"));
	}
	return dirs;
}

/**
 * First existing file among `names`, scanned directory-major: every candidate
 * name is tried in the first PATH entry before moving to the second. That
 * makes PATH order — not the order of `names` — decide which install wins,
 * matching how the OS resolves a command.
 */
export function findOnPath(names, env = process.env) {
	const candidates = Array.isArray(names) ? names : [names];
	for (const dir of searchPathDirs(env)) {
		for (const name of candidates) {
			const candidate = join(dir, name);
			if (existsSync(candidate)) return candidate;
		}
	}
	return undefined;
}

/**
 * Resolve the real `node <entry.js>` invocation behind an npm-generated
 * Windows `.cmd`/`.bat` shim. Shims cannot be spawned with argv (EINVAL), so
 * the entry script has to be extracted and run through node directly.
 *
 * npm shims end with: "%_prog%" "%dp0%\node_modules\@scope\pkg\dist\index.js" %*
 *
 * @param {string} shimPath path to the .cmd/.bat shim
 * @param {string[][]} conventionalCandidates path segments, relative to the
 *   shim directory, to try when the shim cannot be parsed
 */
export function resolveCmdEntry(shimPath, conventionalCandidates = []) {
	let text;
	try {
		text = readFileSync(shimPath, "utf8");
	} catch {
		text = undefined;
	}
	if (text !== undefined) {
		const match = text.match(/"([^"]*(?:%~dp0|%dp0%)[^"]*\.js)"/i);
		if (match?.[1]) {
			const entry = match[1]
				.replace(/%~dp0|%dp0%/gi, dirname(shimPath))
				.replace(/[\\/]/g, sep);
			if (existsSync(entry)) return entry;
		}
	}
	for (const segments of conventionalCandidates) {
		const conventional = join(dirname(shimPath), ...segments);
		if (existsSync(conventional)) return conventional;
	}
	return undefined;
}

/**
 * Resolve `[bin, ...prefixArgs]` for an npm-installed CLI on Windows.
 * Returns undefined when nothing was found, so the caller can fall back to the
 * bare command name and let spawn surface the real ENOENT/EINVAL.
 *
 * @param {object} spec
 * @param {string} spec.exe native executable name, e.g. "paseo.exe"
 * @param {string[]} spec.shims shim names, e.g. ["paseo.cmd", "paseo.bat"]
 * @param {string[][]} [spec.conventionalCandidates] see resolveCmdEntry
 */
export function resolveWindowsCliExec({ exe, shims, conventionalCandidates = [] }) {
	const native = findOnPath([exe]);
	if (native) return [native];
	const shim = findOnPath(shims);
	if (!shim) return undefined;
	const entry = resolveCmdEntry(shim, conventionalCandidates);
	return entry ? [process.execPath, entry] : undefined;
}

// Layouts to try when a paseo shim cannot be parsed, relative to the shim
// directory. Two are needed because @getpaseo/cli has shipped its entry under
// dist/ and under bin/ depending on version.
export const PASEO_CONVENTIONAL_ENTRIES = [
	["node_modules", "@getpaseo", "cli", "dist", "index.js"],
	["node_modules", "@getpaseo", "cli", "bin", "paseo"],
];

/**
 * Locate Paseo's client SDK module, the one the `paseo` CLI itself imports.
 *
 * Why this exists: a handful of daemon operations have never been exposed as
 * `paseo` subcommands — refreshing the provider snapshot is the one this pack
 * needs. Spawning the CLI cannot reach them, so for those the pack imports the
 * same module the CLI does and speaks the protocol directly.
 *
 * The path is derived from wherever `paseo` actually lives (`<root>/bin/paseo`
 * -> `<root>/dist/utils/client.js`) rather than hard-coded: npm -g, mise, nvm
 * and Homebrew each put it somewhere different, and a checkout puts it under
 * node_modules. PASEO_TEAM_PASEO_CLIENT overrides everything, which is also
 * how the tests substitute a fake daemon.
 *
 * @param {(reason: string, tried: string[]) => never} [onMissing]
 * @returns {string} a file:// URL ready for dynamic import
 */
export function resolvePaseoClientModule(onMissing) {
	const override = process.env.PASEO_TEAM_PASEO_CLIENT?.trim();
	if (override) {
		return override.startsWith("file:") ? override : pathToFileURL(override).href;
	}
	const tried = [];
	const bin = findOnPath(["paseo", "paseo.exe", "paseo.cmd", "paseo.bat"]);
	if (bin) {
		// realpath first: ~/.local/bin/paseo is usually a symlink into the
		// package, and the relative layout only holds at the real location.
		let real;
		try {
			real = realpathSync(bin);
		} catch {
			real = bin;
		}
		// On Windows the thing on PATH is an npm .cmd shim that lives nowhere
		// near the package — walking up from it lands outside @getpaseo/cli
		// entirely. resolveCmdEntry reads the shim for the JS entry it runs,
		// and both known layouts (<root>/dist/index.js, <root>/bin/paseo) sit
		// two levels below the package root, same as the POSIX bin.
		const entry = /\.(?:cmd|bat)$/i.test(real)
			? (resolveCmdEntry(real, PASEO_CONVENTIONAL_ENTRIES) ?? real)
			: real;
		const candidate = join(dirname(dirname(entry)), "dist", "utils", "client.js");
		tried.push(candidate);
		if (existsSync(candidate)) return pathToFileURL(candidate).href;
	}
	for (const segments of PASEO_CLIENT_CONVENTIONAL_ENTRIES) {
		const candidate = join(process.cwd(), ...segments);
		tried.push(candidate);
		if (existsSync(candidate)) return pathToFileURL(candidate).href;
	}
	const reason = bin
		? "found the paseo CLI but not its client SDK next to it"
		: "could not find the paseo CLI on PATH";
	if (onMissing) onMissing(reason, tried);
	throw new Error(`${reason} (tried: ${tried.join(", ") || "nothing"})`);
}

// Checkout layout, for a repo that has @getpaseo/cli as a dependency.
export const PASEO_CLIENT_CONVENTIONAL_ENTRIES = [
	["node_modules", "@getpaseo", "cli", "dist", "utils", "client.js"],
];

/**
 * Resolve `[bin, ...prefixArgs]` for the paseo CLI.
 *
 * Windows `.cmd` shims cannot be spawned with argv (EINVAL), so the shim's
 * real node entry is extracted and node is spawned directly — argv fidelity
 * without cmd.exe quoting. PASEO_TEAM_PASEO_EXEC overrides everything.
 *
 * @param {(reason: string) => never} [onInvalidOverride] maps a bad override
 *   onto the caller's error type (RemoteError, etc). Falls back to a plain
 *   Error, so a bad override can never be silently ignored.
 */
export function resolvePaseoExec(onInvalidOverride) {
	const raw = process.env.PASEO_TEAM_PASEO_EXEC;
	const override = raw?.trim();
	// Set-but-blank is checked BEFORE the truthiness test, because it cannot be
	// caught after it. "   ".trim() is "", "" is falsy, so the whole override
	// branch was skipped and resolution fell through to a bare "paseo" — the
	// one outcome the doc comment above promises cannot happen. On a host with
	// a healthy daemon that fallback SUCCEEDS, so the operator who mistyped the
	// override sees a normal answer from a binary they did not choose, and the
	// "is set but empty" message below was unreachable for the value most
	// likely to produce it.
	if (raw !== undefined && override === "") {
		const invalid = "is set but empty";
		if (onInvalidOverride) onInvalidOverride(invalid);
		throw new Error(`PASEO_TEAM_PASEO_EXEC ${invalid}`);
	}
	if (override) {
		const { parts, unterminated } = splitCommandLine(override);
		const invalid = unterminated
			? "has an unterminated quote"
			: parts.length === 0
				? "is set but empty"
				: null;
		if (invalid) {
			if (onInvalidOverride) onInvalidOverride(invalid);
			throw new Error(`PASEO_TEAM_PASEO_EXEC ${invalid}`);
		}
		return parts;
	}
	if (process.platform !== "win32") return ["paseo"];
	// Bare "paseo" as the fallback: let spawn surface the real ENOENT/EINVAL
	// rather than guessing at a layout nothing confirmed.
	return (
		resolveWindowsCliExec({
			exe: "paseo.exe",
			shims: ["paseo.cmd", "paseo.bat"],
			conventionalCandidates: PASEO_CONVENTIONAL_ENTRIES,
		}) ?? ["paseo"]
	);
}

/** Extract "1.8.10" from OCR's `ocr version` output. Null when absent. */
export function parseOcrVersion(output) {
	const match = String(output).match(/open-code-review v(\d+\.\d+\.\d+)/i);
	return match?.[1] ?? null;
}

/** Numeric semver compare over major.minor.patch; returns -1 | 0 | 1. */
export function compareOcrVersions(a, b) {
	const pa = String(a).split(".").map(Number);
	const pb = String(b).split(".").map(Number);
	for (let i = 0; i < 3; i++) {
		const delta = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (delta !== 0) return delta < 0 ? -1 : 1;
	}
	return 0;
}

// ---------------------------------------------------------------------------
// Locating the shared policy core from a support script.
//
// The two layouts differ by one directory level, and the difference is not
// cosmetic — a static `../extensions/paseo-team-core/...` import resolves
// correctly in a checkout and resolves to nothing in an installed tree:
//
//   checkout   scripts/team-lease.mjs            -> ../extensions/paseo-team-core/
//   installed  <ext>/paseo-team-scripts/team-...  -> <ext>/paseo-team-core/
//
// A script that gets this wrong does not fail visibly: it throws at IMPORT
// time, the extension's guard sees a failed support script, and the guard's
// own fail-closed branch reports something else entirely (a Lead that cannot
// staff any writer, blamed on an unreadable lease ledger). So the resolution
// lives here, next to every consumer, and installer-contract.test.mjs runs the
// installed copies to prove it.
// ---------------------------------------------------------------------------

/**
 * Paseo's own per-task-kind routing file. The pack never reads it — see the
 * decision in docs/multi-supervisor-topology.md §4.4 — but its presence is
 * worth surfacing, because the two files look interchangeable and are not:
 * editing the wrong one produces no error, just an agent quietly running on a
 * model nobody chose.
 */
export const PASEO_ORCHESTRATION_PREFS = "orchestration-preferences.json";

/** `$PASEO_HOME`, else the documented default. */
export function paseoHomeDir(env = process.env) {
	return env.PASEO_HOME?.trim() || join(homedir(), ".paseo");
}

/**
 * The pack's own config directory — routing files, the seat ledger, the permit
 * audit log, the Claude session state.
 *
 * It lives here, at the bottom of the import graph, because it is the one
 * directory BOTH halves of the pack need to agree on and neither half can
 * import the other's resolver: `cli/lib/config-walker.mjs` is not shipped to
 * the installed support directory, and the support scripts are not importable
 * from the CLI's own layer. lib-common is.
 *
 * Two variable names, in a fixed order, because the pack shipped both and only
 * one of them was ever documented. Before this existed, config-walker read
 * `PST_TEAM_CONFIG_DIR` while model-routing.mjs and claude-hook.mjs read
 * `PASEO_TEAM_HOME` — so an operator who set one got `pteam status` reporting
 * the routing file as present at the configured path while `pteam preflight`
 * reported it MISSING and named a different one. Same command family, same
 * environment, two answers, and the honest-looking half was wrong.
 *
 * `PST_TEAM_CONFIG_DIR` wins because it is the name `config-walker`'s header
 * and `seat-profiles.mjs` document; `PASEO_TEAM_HOME` is still honoured so a
 * host configured the old way keeps working — everywhere, now, rather than in
 * half the commands.
 *
 * The unconfigured default is two names for the same reason. The pack used to
 * be called paseo-pi-team, and a host installed under that name holds the only
 * copy of its routing files, seat ledger, permit log and provider env — moving
 * it would stop a daemon that loads that env, so an existing legacy directory
 * keeps winning forever. A host that has none gets the current name instead,
 * so the directory a NEW machine creates is not already wrong on the day it is
 * created. When both exist the legacy one still wins: whichever holds the
 * state is the one the rest of the pack has been reading.
 *
 * `home` is a parameter, not a call to `homedir()` inside the branch, because
 * the branch is the part worth testing and `homedir()` cannot be steered by
 * `$HOME` on Windows, where this suite also runs.
 */
export const TEAM_CONFIG_DIR_NAME = ".paseo-team-orchestration";
export const LEGACY_TEAM_CONFIG_DIR_NAME = ".paseo-pi-team";

export function teamConfigDir(env = process.env, home = homedir()) {
	const configured = env.PST_TEAM_CONFIG_DIR?.trim() || env.PASEO_TEAM_HOME?.trim();
	if (configured) return configured;
	const legacy = join(home, LEGACY_TEAM_CONFIG_DIR_NAME);
	return existsSync(legacy) ? legacy : join(home, TEAM_CONFIG_DIR_NAME);
}

/**
 * Warn only when Paseo's routing file actually exists: absent is the common
 * case and says nothing, so reporting it would be noise. Returns null when
 * there is nothing to say.
 */
export function orchestrationPreferencesNotice(env = process.env, exists = existsSync) {
	const path = join(paseoHomeDir(env), PASEO_ORCHESTRATION_PREFS);
	if (!exists(path)) return null;
	return {
		path,
		message: `${path} exists but the pack does NOT read it — pack agents route only from cluster-routing.local.json (docs/multi-supervisor-topology.md §4.4). Edit the cluster file, not this one.`,
	};
}

const POLICY_CORE_DIR = "paseo-team-core";

/**
 * The same module, under two extensions. `.ts` is the source pi loads directly
 * from `~/.pi/agent/extensions/`; `.js` is what `npm run build` emits beside it
 * and is the ONLY one that loads out of an installed package, because Node
 * refuses to strip types under `node_modules`
 * (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING). Preferring `.js` therefore
 * costs nothing where both exist and is the difference between a working and a
 * crashing `pteam` where only one does.
 */
export function policyCoreVariants(name) {
	const base = name.replace(/\.(ts|js)$/, "");
	return [`${base}.js`, `${base}.ts`];
}

/** Absolute path to a policy-core module, in either layout and either extension. */
export function policyCorePath(name, env = process.env, here = dirname(fileURLToPath(import.meta.url))) {
	const configured = env.PASEO_TEAM_POLICY_DIR?.trim();
	const dirs = configured
		? [configured]
		: [join(here, "..", POLICY_CORE_DIR), join(here, "..", "extensions", POLICY_CORE_DIR)];
	const candidates = [];
	// Directory is the outer loop: a complete install wins over a stray
	// leftover `.js` in a directory that no longer holds the rest of the core.
	for (const dir of dirs) {
		for (const variant of policyCoreVariants(name)) candidates.push(join(dir, variant));
	}
	const found = candidates.find((candidate) => existsSync(candidate));
	if (!found) {
		throw new Error(
			`Paseo team policy module is missing: ${name} (looked in ${candidates.join(", ")})`,
		);
	}
	return found;
}

/** Import a policy-core module by name, from whichever layout is installed. */
export function importPolicyCore(name = "policy-core.ts", env = process.env) {
	return import(pathToFileURL(policyCorePath(name, env)).href);
}
