/**
 * paseo-bridge.mjs — the only place the `paseo-team` CLI talks to the Paseo CLI.
 *
 * Layering: WebUI -> paseo-team (this file) -> paseo. The WebUI never spawns
 * `paseo` itself, so every daemon call is funnelled through one argv builder
 * with one timeout policy and one error vocabulary.
 *
 * Almost everything here spawns the `paseo` CLI. One thing cannot:
 * refreshProviderSnapshot speaks the daemon protocol through Paseo's own
 * client SDK, because that operation has no CLI subcommand (see the function's
 * own note). It lives here anyway so the rule that survives is the useful one
 * — this file is the only place the pack talks to Paseo, by any transport.
 *
 * Measured on the reference machine (Windows, paseo 0.3.0): a *single* paseo
 * invocation costs ~3.0-3.5s wall, and `paseo --version` alone costs ~2.7s.
 * The cost is process/bundle startup, not the daemon query — spawning the
 * dist entry directly instead of the .cmd shim does not help. Two consequences
 * shape everything above this file:
 *   1. Never issue one call per widget. Batch a whole snapshot per command.
 *   2. Cache anything immutable (see graph-cache.mjs) instead of re-asking.
 */

import { execFile } from "node:child_process";
import { resolvePaseoClientModule, resolvePaseoExec } from "../../scripts/lib-common.mjs";

/** Generous because a cold paseo start alone eats ~3s of it. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 20_000;

export class PaseoError extends Error {
	constructor(code, message, details = undefined) {
		super(message);
		this.name = "PaseoError";
		this.code = code;
		if (details !== undefined) this.details = details;
	}
}

/**
 * Resolve `[bin, ...prefixArgs]`, mapping a malformed
 * PASEO_TEAM_PASEO_EXEC onto PASEO_EXEC_INVALID rather than a generic spawn
 * failure — a bad override is a configuration fault and must never be retried.
 */
export function paseoExec() {
	return resolvePaseoExec((reason) => {
		throw new PaseoError("PASEO_EXEC_INVALID", `PASEO_TEAM_PASEO_EXEC ${reason}`);
	});
}

/**
 * Every argv element must already be a string. Coercing would turn an
 * undefined option into the literal argv element "undefined" and send a
 * nonsense command to the daemon, which is exactly the class of bug a WebUI
 * forwarding user input is most likely to introduce.
 */
export function assertArgv(args) {
	if (!Array.isArray(args) || args.length === 0) {
		throw new PaseoError("ARGV_INVALID", "paseo argv must be a non-empty array");
	}
	for (const [index, part] of args.entries()) {
		if (typeof part !== "string" || part.length === 0) {
			throw new PaseoError(
				"ARGV_INVALID",
				`paseo argv[${index}] must be a non-empty string (got ${typeof part})`,
				{ index },
			);
		}
	}
	return args;
}

/**
 * Run `paseo <args> --json` and parse stdout.
 *
 * `--json` is appended here, once, so no caller can forget it and get a table
 * back. Errors carry a code so reliability.mjs#classifyRemoteFailure can tell
 * a transport hiccup from a configuration fault.
 */
export function runPaseoJson(args, options = {}) {
	// Validation and exec resolution happen inside the executor on purpose: a
	// function that returns a promise must never *also* throw synchronously,
	// or half the call sites need a try/catch the other half do not.
	return new Promise((resolve, reject) => {
		assertArgv(args);
		const timeoutMs = Math.max(250, options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS);
		const [bin, ...prefix] = paseoExec();
		const argv = [...prefix, ...args, "--json"];
		execFile(
			bin,
			argv,
			{
				encoding: "utf8",
				timeout: timeoutMs,
				signal: options.signal,
				stdio: ["ignore", "pipe", "pipe"],
				maxBuffer: 32 * 1024 * 1024,
				env: process.env,
				windowsHide: true,
			},
			(error, stdout, stderr) => {
				if (error) {
					const text = `${String(stderr ?? "").trim()} ${String(error.message ?? "")}`.trim();
					const code = error.killed || error.signal ? "TIMEOUT" : (error.code ?? "CLI_ERROR");
					reject(new PaseoError(typeof code === "number" ? "CLI_ERROR" : code, text || "paseo failed", { args }));
					return;
				}
				try {
					resolve(JSON.parse(stdout));
				} catch (parseError) {
					reject(
						new PaseoError(
							"INVALID_JSON",
							`paseo returned invalid JSON for '${args.join(" ")}': ${String(parseError?.message ?? parseError)}`,
							{ head: String(stdout).slice(0, 200) },
						),
					);
				}
			},
		);
	});
}

/**
 * Run `paseo <args>` and return raw stdout.
 *
 * The `--json` sibling above is the default and should stay that way; this
 * exists for the handful of paseo subcommands that have no JSON form at all
 * (`logs` is one — it accepts `--json` and prints a transcript regardless).
 * Callers get text and must parse it themselves, so keep that list short.
 *
 * `maxChars` bounds what is RETURNED to the caller (keeping the tail, which is
 * the useful end of a transcript), not what the child process produces —
 * `maxBuffer` is the only real cap on that, and it is deliberately generous.
 * `totalChars` always reports the true size, so a caller can say how much it
 * chose not to look at.
 */
export function runPaseoText(args, options = {}) {
	return new Promise((resolve, reject) => {
		assertArgv(args);
		const timeoutMs = Math.max(250, options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS);
		const maxChars = Math.max(1024, options.maxChars ?? 4 * 1024 * 1024);
		const [bin, ...prefix] = paseoExec();
		execFile(
			bin,
			[...prefix, ...args],
			{
				encoding: "utf8",
				timeout: timeoutMs,
				signal: options.signal,
				stdio: ["ignore", "pipe", "pipe"],
				maxBuffer: 32 * 1024 * 1024,
				env: process.env,
				windowsHide: true,
			},
			(error, stdout, stderr) => {
				if (error) {
					const text = `${String(stderr ?? "").trim()} ${String(error.message ?? "")}`.trim();
					const code = error.killed || error.signal ? "TIMEOUT" : (error.code ?? "CLI_ERROR");
					reject(new PaseoError(typeof code === "number" ? "CLI_ERROR" : code, text || "paseo failed", { args }));
					return;
				}
				const text = String(stdout ?? "");
				resolve({
					text: text.length > maxChars ? text.slice(text.length - maxChars) : text,
					totalChars: text.length,
					clipped: text.length > maxChars,
				});
			},
		);
	});
}

/**
 * Bounded-concurrency map that never rejects: a failing item resolves to
 * `{ ok: false, error }`. A snapshot must degrade per item, not collapse
 * because one cold agent timed out.
 */
export async function mapWithConcurrency(items, limit, fn) {
	const list = Array.from(items);
	const width = Math.max(1, Math.min(16, Math.floor(limit) || 1));
	const results = new Array(list.length);
	let cursor = 0;
	async function worker() {
		while (cursor < list.length) {
			const index = cursor++;
			try {
				results[index] = { ok: true, value: await fn(list[index], index) };
			} catch (error) {
				results[index] = { ok: false, error };
			}
		}
	}
	await Promise.all(Array.from({ length: Math.min(width, list.length) }, () => worker()));
	return results;
}

/**
 * Make a RUNNING daemon re-read its provider catalog.
 *
 * Paseo caches each provider's model list for the lifetime of the daemon
 * process. Edit ~/.pi/agent/models.json and `paseo provider models pi-peer`
 * keeps answering with the old list; `paseo reload` does not help either — it
 * reloads daemon config, not the provider snapshot. Restarting the daemon does,
 * at the cost of dropping every live agent connection for a catalog change.
 *
 * The daemon already accepts `refresh_providers_snapshot_request` (permission
 * daemon.read) and the client SDK wraps it as refreshProvidersSnapshot(); only
 * the `paseo` CLI never exposed it. So this is the one call that goes through
 * the SDK rather than argv.
 *
 * Fails closed and never throws: a daemon that is down, an SDK that cannot be
 * located, or a daemon too old to know the message all return a structured
 * fault, because the honest answer then is "the catalog is still stale, restart
 * the daemon" — not a silent success.
 *
 * @param {string[]} [providers] role providers to refresh; empty means all
 * @param {{timeoutMs?: number, host?: string}} [options]
 * @returns {Promise<{ok: true, providers: string[]} | {ok: false, code: string, message: string}>}
 */
export async function refreshProviderSnapshot(providers = [], options = {}) {
	const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
	let connectToDaemon;
	let moduleUrl;
	try {
		moduleUrl = resolvePaseoClientModule((reason, tried) => {
			throw new PaseoError("PASEO_CLIENT_MISSING", `${reason} (tried: ${tried.join(", ") || "nothing"})`);
		});
		({ connectToDaemon } = await import(moduleUrl));
		if (typeof connectToDaemon !== "function") {
			return {
				ok: false,
				code: "PASEO_CLIENT_INCOMPATIBLE",
				message: "paseo client SDK does not export connectToDaemon",
			};
		}
	} catch (error) {
		return {
			ok: false,
			code: error instanceof PaseoError ? error.code : "PASEO_CLIENT_MISSING",
			message: String(error?.message ?? error),
		};
	}

	let client;
	try {
		// Paseo 0.10 made connectToDaemon's `target` mandatory: without one the
		// call dies on `options.target.kind` before any socket opens, so every
		// refresh reports DAEMON_UNREACHABLE against a daemon that is up. The
		// SDK that needs the field ships selectDaemonTarget in daemon-target.js
		// next to client.js — resolve it from the same directory and pass the
		// target through; an older SDK without that file keeps the targetless
		// call it was built for.
		let target;
		try {
			const { selectDaemonTarget } = await import(new URL("./daemon-target.js", moduleUrl).href);
			if (typeof selectDaemonTarget === "function") {
				target = selectDaemonTarget(options.host ? { host: options.host } : {}, process.env);
			}
		} catch {
			// No daemon-target module: a pre-0.10 SDK, which takes no target.
		}
		client = await connectToDaemon({
			timeout: timeoutMs,
			// One source of truth: with a target-bearing SDK the host has already
			// been folded into the target, so sending it twice would let the two
			// disagree about which daemon to reach.
			...(target ? { target } : options.host ? { host: options.host } : {}),
		});
	} catch (error) {
		return {
			ok: false,
			code: "DAEMON_UNREACHABLE",
			message: `cannot reach the Paseo daemon: ${String(error?.message ?? error)}`,
		};
	}

	try {
		if (typeof client?.refreshProvidersSnapshot !== "function") {
			return {
				ok: false,
				code: "REFRESH_UNSUPPORTED",
				message: "this Paseo version has no refreshProvidersSnapshot — restart the daemon to pick up catalog changes",
			};
		}
		await client.refreshProvidersSnapshot(providers.length > 0 ? { providers } : {});
		return { ok: true, providers };
	} catch (error) {
		return {
			ok: false,
			code: "REFRESH_FAILED",
			message: String(error?.message ?? error),
		};
	} finally {
		// The SDK has renamed its teardown across versions; closing the socket
		// matters more than which name does it.
		for (const method of ["close", "disconnect", "dispose", "destroy"]) {
			if (typeof client?.[method] === "function") {
				try { await client[method](); } catch { /* teardown is best-effort */ }
				break;
			}
		}
	}
}
