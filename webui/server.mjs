/**
 * server.mjs — the WebUI transport. It owns no truth.
 *
 * The whole contract of this file: an HTTP request is mapped onto a fixed
 * `paseo-team` argv template, the CLI is spawned, and its stdout is returned
 * verbatim. This file must never read a config file, never call `paseo`, and
 * never merge, patch or synthesize a response. If you find yourself wanting to
 * "just" compute something here, it belongs in the CLI — that is what makes
 * the UI reproducible from a terminal.
 *
 * Two things it *is* allowed to do, because neither invents data:
 *   - cache a CLI response verbatim for a few seconds (see CACHEABLE), and
 *   - collapse concurrent identical requests into one spawn (single-flight).
 * Both exist because one paseo round trip costs ~3s; without them, three open
 * browser tabs would triple the load on the daemon for identical answers.
 *
 * Security posture — this UI can approve permission requests and rewrite
 * config, so it is treated as privileged even on localhost:
 *   - binds 127.0.0.1 only;
 *   - /api/* requires a per-run bearer token, handed to the SPA through the
 *     URL fragment (a fragment is never sent to a server and never lands in an
 *     access log);
 *   - Origin/Host are checked, which is what stops a DNS-rebinding page in
 *     another tab from driving this API;
 *   - no CORS headers are ever emitted.
 */

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join, dirname, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const PUBLIC_DIR = join(HERE, "public");
const CLI = join(ROOT, "cli", "paseo-team.mjs");

export const DEFAULT_PORT = 4321;
export const MAX_BODY_BYTES = 4 * 1024 * 1024;

// --- request -> argv -------------------------------------------------------

export const CONFIG_SECTIONS = ["providers", "routing", "cluster", "mcp", "paseo", "pi-settings", "seats", "pi-models"];
const ROLES = ["supervisor", "lead", "peer"];
const AGENT_REF = /^[0-9a-fA-F][0-9a-fA-F-]{5,63}$/;
const TOKEN_LIKE = /^[A-Za-z0-9._:-]{1,128}$/;
const CONFIG_REV = /^(?:absent|[0-9a-f]{64})$/;
const SKILL_NAME = /^[A-Za-z0-9._-]{1,64}$/;

class RouteError extends Error {
	constructor(status, code, message) {
		super(message);
		this.status = status;
		this.code = code;
	}
}

function pick(value, allowed, label) {
	if (!allowed.includes(value)) {
		throw new RouteError(400, "PARAM_INVALID", `${label} must be one of: ${allowed.join(", ")}`);
	}
	return value;
}

function match(value, pattern, label) {
	if (typeof value !== "string" || !pattern.test(value)) {
		throw new RouteError(400, "PARAM_INVALID", `${label} is missing or malformed`);
	}
	return value;
}

/**
 * The complete set of things the browser can ask for. A request that does not
 * match a key here is a 404 — there is no dynamic argv assembly, and no path
 * from user input to a command name.
 *
 * Cached GETs carry a `tag`; each POST lists the tags its write can reach
 * (`invalidates`), and a successful POST drops only those cache entries.
 */
export const ROUTES = {
	"GET /api/status": { build: () => ({ args: ["status"] }), cacheMs: 2_000, tag: "status" },
	// Preflight probes providers and models: ~25-30s on the reference machine,
	// and slower still when a graph poll is competing for the same daemon. It
	// gets its own timeout and a long TTL because its answer barely moves.
	"GET /api/preflight": { build: () => ({ args: ["preflight", "--json"] }), cacheMs: 60_000, timeoutMs: 180_000, tag: "preflight" },
	"GET /api/env": { build: () => ({ args: ["env", "list"] }), cacheMs: 10_000, tag: "env" },

	"GET /api/agents": {
		build: (q) => ({ args: q.all === "1" ? ["agents", "--all"] : ["agents"] }),
		cacheMs: 4_000,
		tag: "agents",
	},
	"GET /api/agent": {
		build: (q) => ({ args: ["agent", "inspect", match(q.id, AGENT_REF, "id")] }),
		cacheMs: 4_000,
		tag: "agents",
	},
	"POST /api/agent/send": {
		build: (q, body) => ({
			args: ["agent", "send", match(body?.agentId, AGENT_REF, "agentId")],
			stdin: String(body?.prompt ?? ""),
		}),
		invalidates: ["agents", "graph", "status", "watchdog"],
	},

	"GET /api/graph": {
		build: (q) => ({
			args: [
				"graph",
				...(q.all === "1" ? ["--all"] : []),
				...(q.maxInspect ? ["--max-inspect", match(q.maxInspect, /^\d{1,3}$/, "maxInspect")] : []),
			],
		}),
		// Slightly under the UI's poll interval so a poll usually gets a fresh
		// snapshot rather than the same one twice.
		cacheMs: 4_000,
		tag: "graph",
	},

	// Seats: reading is a plain config section (above); applying is the write
	// that turns the seat document into Paseo providers. It gets its own route
	// rather than riding on POST /api/config because the two are different acts
	// — saving a seat changes a file the user owns, applying it rewrites the
	// daemon's provider set.
	"GET /api/seats": { build: () => ({ args: ["seats", "list"] }), cacheMs: 5_000, tag: "seats" },
	"POST /api/seats/apply": {
		build: (q, body) => ({
			args: ["seats", "apply", ...(body?.dryRun === true ? ["--dry-run"] : [])],
		}),
		invalidates: ["seats", "config", "status", "preflight", "env"],
	},

	"GET /api/permits": { build: () => ({ args: ["permits", "list"] }), cacheMs: 3_000, tag: "permits" },
	"POST /api/permits/decide": {
		build: (q, body) => ({
			args: [
				"permits",
				pick(body?.action, ["allow", "deny"], "action"),
				match(body?.agentId, AGENT_REF, "agentId"),
				match(body?.requestId, TOKEN_LIKE, "requestId"),
			],
		}),
		invalidates: ["permits", "graph", "agents", "status"],
	},

	// A routing/cluster read now also asks the daemon which models each role
	// provider offers, so the answer costs a `paseo` round trip instead of a
	// file read. A short TTL keeps re-opening the tab cheap; the POST below
	// already invalidates the "config" tag, so a save is never served stale.
	"GET /api/config": {
		build: (q) => ({ args: ["config", "read", pick(q.section, CONFIG_SECTIONS, "section")] }),
		cacheMs: 5_000,
		tag: "config",
	},
	"POST /api/config": {
		build: (q, body, raw) => ({
			args: [
				"config",
				"write",
				pick(q.section, CONFIG_SECTIONS, "section"),
				// Optional: the fingerprint `config read` returned. Present, the CLI
				// refuses to overwrite a file that changed since it was read.
				...(q.rev === undefined ? [] : ["--rev", match(q.rev, CONFIG_REV, "rev")]),
			],
			stdin: raw,
		}),
		invalidates: ["config", "env", "status", "preflight", "seats"],
	},
	"GET /api/prompts": {
		build: (q) => ({ args: ["prompts", "read", pick(q.role, ROLES, "role")] }),
	},
	"POST /api/prompts": {
		build: (q, body) => ({
			args: ["prompts", "write", pick(q.role, ROLES, "role")],
			stdin: String(body?.content ?? ""),
		}),
		invalidates: ["prompts", "agents"],
	},
	"GET /api/skills": { build: () => ({ args: ["skills", "list"] }), cacheMs: 5_000, tag: "skills" },
	"GET /api/skill": {
		build: (q) => ({ args: ["skills", "read", match(q.name, SKILL_NAME, "name")] }),
	},
	"POST /api/skill": {
		build: (q, body) => ({
			args: ["skills", "write", match(body?.name, SKILL_NAME, "name")],
			stdin: String(body?.content ?? ""),
		}),
		invalidates: ["skills"],
	},

	"GET /api/watchdog": { build: () => ({ args: ["watchdog"] }), cacheMs: 10_000, tag: "watchdog" },

	// Rebuilding pi's catalog means one real completion per model the endpoint
	// lists, so it is minutes rather than seconds on a slow upstream — hence a
	// timeout of its own. It rewrites models.json and the daemon's snapshot, so
	// every cached answer that quotes a model has to go.
	"POST /api/models/sync": {
		build: (q, body) => ({
			args: [
				"models",
				"sync",
				...(typeof body?.only === "string" && body.only ? ["--only", body.only] : []),
				...(body?.dryRun === true ? ["--dry-run"] : []),
			],
		}),
		timeoutMs: 600_000,
		invalidates: ["config", "preflight", "status", "models"],
	},
	"POST /api/models/refresh": {
		build: () => ({ args: ["models", "refresh"] }),
		timeoutMs: 60_000,
		invalidates: ["config", "preflight", "models"],
	},
};

// --- CLI invocation --------------------------------------------------------

/**
 * Spawn the CLI. `shell: false` is the whole point: argv elements travel as
 * argv, so no quoting rule anywhere can turn a config value into a command.
 */
export function runCli(args, stdin = null, options = {}) {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [CLI, ...args], {
			cwd: ROOT,
			env: process.env,
			shell: false,
			windowsHide: true,
			stdio: ["pipe", "pipe", "pipe"],
		});
		const outChunks = [];
		const errChunks = [];
		let settled = false;
		const timer = setTimeout(() => {
			if (!settled) {
				child.kill();
				settled = true;
				resolve({ exitCode: null, stdout: "", stderr: "paseo-team timed out", timedOut: true });
			}
		}, options.timeoutMs ?? 60_000);
		child.stdout.on("data", (chunk) => { outChunks.push(chunk); });
		child.stderr.on("data", (chunk) => { errChunks.push(chunk); });
		child.on("error", (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ exitCode: null, stdout: "", stderr: String(error?.message ?? error) });
		});
		child.on("close", (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({
				exitCode: code,
				stdout: Buffer.concat(outChunks).toString("utf8"),
				stderr: Buffer.concat(errChunks).toString("utf8"),
			});
		});
		// The child may exit without reading stdin (it rejected its arguments
		// first). A body bigger than the pipe buffer then fails with EPIPE, and an
		// 'error' event nobody listens for is an uncaught exception that ends the
		// whole server. The exit code already says what happened.
		child.stdin.on("error", () => {});
		if (stdin !== null) child.stdin.end(stdin, "utf8");
		else child.stdin.end();
	});
}

// --- cache + single flight -------------------------------------------------

/**
 * Is this answer worth remembering?
 *
 * A zero exit is not the same question as a successful answer, and `graph` is
 * where they came apart. `collectGraph` deliberately reports a fault AS DATA —
 * `{ ok: false, degraded: [...] }` with exit 0 — so the WebUI can still render
 * a page that explains itself; making it exit non-zero instead would send this
 * server down the CLI_FAILED path below, which returns 502 and never parses the
 * body, so the explaining page would be the thing lost.
 *
 * The cost was here: the exit code alone said "successful", and a graph taken
 * while the daemon was down got cached for its whole window — exactly the
 * "keep showing a stale error after the daemon came back" this cache says it
 * avoids. So the body gets a say too. Parsed once, on the miss path only, and
 * an unparseable body is simply not cached: it is going to 502 anyway.
 */
export function isCacheable(value) {
	if (value?.exitCode !== 0) return false;
	if (typeof value.stdout !== "string" || value.stdout.trim() === "") return true;
	try {
		return JSON.parse(value.stdout)?.ok !== false;
	} catch {
		return false;
	}
}

export function createCache() {
	const entries = new Map();
	const inflight = new Map();
	return {
		async run(key, ttlMs, producer, tag = null) {
			const now = Date.now();
			const hit = entries.get(key);
			if (hit && ttlMs > 0 && now - hit.at < ttlMs) return { ...hit.value, cached: true, ageMs: now - hit.at };
			if (hit) entries.delete(key); // an expired entry leaves instead of lingering
			const pending = inflight.get(key);
			if (pending) return { ...(await pending), coalesced: true };
			const promise = producer().finally(() => inflight.delete(key));
			inflight.set(key, promise);
			const value = await promise;
			// Only successful answers are cached: caching a failure would keep
			// showing a stale error after the daemon came back.
			if (isCacheable(value)) entries.set(key, { at: Date.now(), value, tag });
			return value;
		},
		// A POST drops only the reads its write can reach (ROUTES `invalidates`),
		// so one write no longer throws away a 60s preflight answer.
		invalidate(tags) {
			for (const [key, entry] of entries) {
				if (entry.tag !== null && tags.includes(entry.tag)) entries.delete(key);
			}
		},
		clear() { entries.clear(); },
		size() { return entries.size; },
	};
}

// --- HTTP plumbing ---------------------------------------------------------

function safeEqual(a, b) {
	const left = Buffer.from(String(a));
	const right = Buffer.from(String(b));
	if (left.length !== right.length) return false;
	return timingSafeEqual(left, right);
}

export function bearerToken(req) {
	const header = req.headers?.authorization ?? "";
	const match = /^Bearer\s+(.+)$/i.exec(String(header).trim());
	return match ? match[1] : null;
}

/**
 * A browser will not let a cross-origin page set an Authorization header, so
 * the token already blocks CSRF. The Host check closes the other door: a
 * rebound DNS name resolving to 127.0.0.1 arrives with a Host that is not
 * localhost, and is refused before any argv is built.
 */
export function isAllowedHost(req, port) {
	const host = String(req.headers?.host ?? "");
	const allowed = new Set([
		`127.0.0.1:${port}`,
		`localhost:${port}`,
		`[::1]:${port}`,
	]);
	if (!allowed.has(host)) return false;
	const origin = req.headers?.origin;
	if (origin === undefined) return true;
	return [`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`].includes(String(origin));
}

function readBody(req) {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks = [];
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				reject(new RouteError(413, "BODY_TOO_LARGE", `request body exceeds ${MAX_BODY_BYTES} bytes`));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

const MIME = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml",
	".json": "application/json; charset=utf-8",
};

// Static files change only when pteam is updated or a developer edits them,
// so bodies live in memory and are re-read only when mtime moves. A strong
// content-hash ETag turns every reload into a 304 instead of a re-download.
const staticCache = new Map();

async function serveStatic(pathname, res, headers = {}) {
	const requested = pathname === "/" ? "/index.html" : pathname;
	// normalize() then a prefix check: the classic ../ escape has to fail
	// before readFile ever sees the path.
	const resolved = join(PUBLIC_DIR, normalize(requested).replace(/^([/\\])+/, ""));
	if (!resolved.startsWith(PUBLIC_DIR + sep)) {
		res.writeHead(403, { "content-type": "text/plain" });
		res.end("forbidden");
		return;
	}
	try {
		const mtimeMs = (await stat(resolved)).mtimeMs;
		let entry = staticCache.get(resolved);
		if (!entry || entry.mtimeMs !== mtimeMs) {
			const body = await readFile(resolved);
			const etag = `"${createHash("sha256").update(body).digest("hex").slice(0, 16)}"`;
			entry = { mtimeMs, body, etag };
			staticCache.set(resolved, entry);
		}
		if (headers["if-none-match"] === entry.etag) {
			res.writeHead(304, { "cache-control": "no-cache", etag: entry.etag });
			res.end();
			return;
		}
		const ext = resolved.slice(resolved.lastIndexOf("."));
		res.writeHead(200, {
			"content-type": MIME[ext] ?? "application/octet-stream",
			"cache-control": "no-cache",
			etag: entry.etag,
			// The SPA is entirely self-contained; nothing it renders should be
			// able to pull in a remote script.
			"content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'",
			"x-content-type-options": "nosniff",
		});
		res.end(entry.body);
	} catch {
		res.writeHead(404, { "content-type": "text/plain" });
		res.end("not found");
	}
}

function sendJson(res, status, payload) {
	const body = JSON.stringify(payload);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		"x-content-type-options": "nosniff",
	});
	res.end(body);
}

/**
 * Handle one /api request. Exported and dependency-injected so the contract
 * (auth, route allowlist, argv shape) is testable without a socket.
 */
export async function handleApi({ method, pathname, query, rawBody, exec }) {
	const key = `${method} ${pathname}`;
	const route = ROUTES[key];
	if (!route) throw new RouteError(404, "NO_ROUTE", `no route for ${key}`);
	let body = null;
	if (method === "POST" && rawBody) {
		try {
			body = JSON.parse(rawBody);
		} catch {
			// config write posts a raw JSON document; every other POST posts an
			// envelope. An unparseable envelope is only an error for the latter.
			body = null;
		}
	}
	const { args, stdin = null } = route.build(query, body, rawBody ?? "");
	return { route, args, stdin, result: await exec(args, stdin, route) };
}

export async function startServer(options = {}) {
	let port = Number.isInteger(options.port) ? options.port : DEFAULT_PORT;
	const requireToken = options.requireToken !== false;
	const token = requireToken ? (options.token ?? randomBytes(24).toString("base64url")) : null;
	const cache = options.cache ?? createCache();
	const exec = options.runCli ?? runCli;
	// Resolved after listen(): port 0 asks the OS to choose, and the Host
	// check must compare against the port actually bound, not the request.
	let boundPort = port;

	const handleRequest = async (req, res) => {
		try {
			if (!isAllowedHost(req, boundPort)) {
				sendJson(res, 403, { ok: false, code: "HOST_NOT_ALLOWED", message: "this server only answers to localhost" });
				return;
			}
			// A target such as "//" is not a URL against this base and URL() throws
			// on it. Parsed outside this try it escaped as an unhandled rejection
			// that took the whole process down, before any Host or token check, so
			// a single request from any local process or web page could kill the UI.
			let url;
			try {
				url = new URL(req.url ?? "/", `http://127.0.0.1:${boundPort}`);
			} catch {
				throw new RouteError(400, "BAD_REQUEST_TARGET", "malformed request target");
			}
			const query = Object.fromEntries(url.searchParams.entries());
			if (url.pathname === "/favicon.ico") {
				// Browsers ask for it unprompted; a 404 here showed up as a console
				// error on every page load and looked like something being broken.
				res.writeHead(204, { "cache-control": "max-age=86400" });
				res.end();
				return;
			}
			if (!url.pathname.startsWith("/api/")) {
				await serveStatic(url.pathname, res, req.headers);
				return;
			}
			if (requireToken && !safeEqual(bearerToken(req) ?? "", token)) {
				sendJson(res, 401, { ok: false, code: "UNAUTHORIZED", message: "missing or invalid bearer token" });
				return;
			}
			const rawBody = req.method === "POST" ? await readBody(req) : "";
			const { args, route, result } = await handleApi({
				method: req.method ?? "GET",
				pathname: url.pathname,
				query,
				rawBody,
				exec: (argv, stdin, route) => {
					// `?fresh=1` is a person pressing a refresh button: a read cached up to
					// 10s ago is not what they asked for, and it also drops the cached copy
					// so the next plain read is not stale either.
					const fresh = req.method === "GET" && query.fresh === "1";
					if (fresh && route.tag) cache.invalidate([route.tag]);
					// Fresh with a tag: the entry was just dropped, so this read goes to the
					// CLI and then REPLACES it. Fresh without one cannot be dropped, so it is
					// simply not cached.
					const ttl = req.method === "GET" && (!fresh || route.tag) ? (route.cacheMs ?? 0) : 0;
					const key = `${argv.join("\u0000")}`;
					const options = route.timeoutMs ? { timeoutMs: route.timeoutMs } : {};
					return ttl > 0
						? cache.run(key, ttl, () => exec(argv, stdin, options), route.tag ?? null)
						: exec(argv, stdin, options);
				},
			});
			if (req.method === "POST") cache.invalidate(route?.invalidates ?? []); // a write drops only the reads it can affect
			if (result.exitCode !== 0) {
				// A non-zero exit is not always a crash: several commands answer
				// with a full JSON report AND exit non-zero because part of the
				// work failed. Flattening that into a stdout string threw away
				// the only copy of which part — so the body is carried through
				// verbatim when it parses, and the page can say what happened.
				let data = null;
				try {
					data = JSON.parse(result.stdout ?? "");
				} catch {
					/* genuinely not a JSON answer; stdout below is all there is */
				}
				sendJson(res, 502, {
					ok: false,
					code: "CLI_FAILED",
					command: ["paseo-team", ...args].join(" "),
					exitCode: result.exitCode,
					stderr: result.stderr?.slice(0, 4000) ?? "",
					stdout: result.stdout?.slice(0, 4000) ?? "",
					...(data !== null && typeof data === "object" ? { data } : {}),
				});
				return;
			}
			let parsed;
			try {
				parsed = JSON.parse(result.stdout);
			} catch {
				sendJson(res, 502, {
					ok: false,
					code: "CLI_OUTPUT_NOT_JSON",
					command: ["paseo-team", ...args].join(" "),
					stdout: result.stdout.slice(0, 4000),
				});
				return;
			}
			// `command` travels with every answer so the UI can show exactly
			// which CLI call produced what is on screen.
			sendJson(res, 200, {
				ok: true,
				command: ["paseo-team", ...args].join(" "),
				cached: Boolean(result.cached),
				ageMs: result.ageMs ?? 0,
				data: parsed,
			});
		} catch (error) {
			const status = error instanceof RouteError ? error.status : 500;
			sendJson(res, status, {
				ok: false,
				code: error?.code ?? "SERVER_ERROR",
				message: String(error?.message ?? error),
			});
		}
	};
	const server = createServer((req, res) => {
		// Last line of defence: the handler answers its own errors, but anything
		// that still escapes it (a throw while writing the error response, say)
		// must end this one request, never the process.
		handleRequest(req, res).catch(() => {
			if (res.headersSent) {
				res.destroy();
				return;
			}
			try {
				sendJson(res, 500, { ok: false, code: "SERVER_ERROR", message: "internal error" });
			} catch {
				res.destroy();
			}
		});
	});

	// A busy port must degrade to a notice, not a stack trace. Without an
	// explicit --port we fall forward like a dev server (4321 -> 4322 -> …);
	// an explicit port is the user's decision, so it fails with actionable
	// text instead of silently moving.
	const autoPort = options.autoPort === true;
	const maxAttempts = autoPort ? 9 : 1;
	let listenError = null;
	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		const candidate = port + attempt;
		try {
			await new Promise((resolve, reject) => {
				server.once("error", reject);
				server.listen(candidate, "127.0.0.1", resolve);
			});
			listenError = null;
			port = candidate;
			break;
		} catch (error) {
			listenError = error;
			if (error?.code !== "EADDRINUSE" || attempt === maxAttempts - 1) break;
			if (!options.quiet) {
				process.stdout.write(`paseo-team web: port ${candidate} is busy, trying ${candidate + 1}…\n`);
			}
		}
	}
	if (listenError !== null) {
		const busy = listenError.code === "EADDRINUSE";
		const message = busy
			? `port ${port} is already in use — a WebUI may already be running there (open http://127.0.0.1:${port}/ in your browser), or pass --port <other-port>`
			: `could not listen on 127.0.0.1:${port}: ${listenError.message}`;
		const failure = new Error(message);
		failure.code = busy ? "WEB_PORT_BUSY" : "WEB_LISTEN_FAILED";
		throw failure;
	}
	boundPort = server.address()?.port ?? port;

	const base = `http://127.0.0.1:${boundPort}/`;
	const url = token ? `${base}#token=${token}` : base;
	if (!options.quiet) {
		process.stdout.write(`paseo-team web: ${url}\n`);
		if (!token) {
			process.stdout.write("paseo-team web: WARNING — running with --no-token; anything on this machine can approve permissions through this port\n");
		}
	}
	if (options.open) {
		const opener = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
		// A missing opener (no xdg-open on a headless host) is an 'error' event; with
		// no listener it would end the process. The URL is printed above anyway.
		spawn(opener[0], opener[1], { detached: true, stdio: "ignore", windowsHide: true }).on("error", () => {}).unref();
	}
	return { server, port: boundPort, token, url, close: () => new Promise((resolve) => server.close(resolve)) };
}
