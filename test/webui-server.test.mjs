import assert from "node:assert/strict";
import { connect } from "node:net";
import {
	ROUTES,
	bearerToken,
	runCli,
	createCache,
	isCacheable,
	handleApi,
	isAllowedHost,
	startServer,
} from "../webui/server.mjs";

// --- the route table is the whole attack surface ---------------------------
// There is no dynamic argv assembly: a path that is not a key here cannot
// reach the CLI at all.
{
	const echo = (args, stdin) => Promise.resolve({ exitCode: 0, stdout: "{}", stderr: "", args, stdin });

	await assert.rejects(
		handleApi({ method: "GET", pathname: "/api/nope", query: {}, exec: echo }),
		(error) => error.status === 404 && error.code === "NO_ROUTE",
	);
	// Same path, wrong verb: a GET-only route must not be reachable by POST.
	await assert.rejects(
		handleApi({ method: "POST", pathname: "/api/status", query: {}, exec: echo }),
		(error) => error.status === 404,
	);

	const status = await handleApi({ method: "GET", pathname: "/api/status", query: {}, exec: echo });
	assert.deepEqual(status.args, ["status"]);

	const graph = await handleApi({ method: "GET", pathname: "/api/graph", query: { all: "1", maxInspect: "8" }, exec: echo });
	assert.deepEqual(graph.args, ["graph", "--all", "--max-inspect", "8"]);

	const agents = await handleApi({ method: "GET", pathname: "/api/agents", query: {}, exec: echo });
	assert.deepEqual(agents.args, ["agents"], "a missing flag is absent, never the string 'undefined'");
}

// --- parameters are checked before they become argv ------------------------
{
	const echo = () => Promise.resolve({ exitCode: 0, stdout: "{}", stderr: "" });
	const rejects = (pathname, query, method = "GET", rawBody = "") =>
		assert.rejects(
			handleApi({ method, pathname, query, rawBody, exec: echo }),
			(error) => error.status === 400 && error.code === "PARAM_INVALID",
		);

	await rejects("/api/config", { section: "../../etc/passwd" });
	await rejects("/api/config", { section: "unknown" });
	await rejects("/api/prompts", { role: "root" });
	await rejects("/api/agent", { id: "not an id" });
	await rejects("/api/skill", { name: "../secret" });
	await rejects("/api/graph", { maxInspect: "99999" });
	await rejects("/api/permits/decide", {}, "POST", JSON.stringify({ action: "approve-all", agentId: "aaaaaaaa", requestId: "r" }));
	await rejects("/api/permits/decide", {}, "POST", JSON.stringify({ action: "allow", agentId: "; rm -rf /", requestId: "r" }));

	// The happy path still builds the exact delegate command.
	const decided = await handleApi({
		method: "POST",
		pathname: "/api/permits/decide",
		query: {},
		rawBody: JSON.stringify({ action: "deny", agentId: "aaaa1111-2222-3333-4444-555555555555", requestId: "req-9" }),
		exec: echo,
	});
	assert.deepEqual(decided.args, ["permits", "deny", "aaaa1111-2222-3333-4444-555555555555", "req-9"]);
}

// --- config write forwards the raw document, not a re-serialized copy ------
{
	const raw = '{\n  "agents": { "providers": {} }\n}';
	const seen = await handleApi({
		method: "POST",
		pathname: "/api/config",
		query: { section: "providers" },
		rawBody: raw,
		exec: (args, stdin) => Promise.resolve({ exitCode: 0, stdout: "{}", stderr: "", stdin }),
	});
	assert.deepEqual(seen.args, ["config", "write", "providers"]);
	assert.equal(seen.stdin, raw, "the CLI receives the document byte-for-byte");
}

// --- pi-settings is a first-class section: same argv shape as the others ---
{
	const echo = () => Promise.resolve({ exitCode: 0, stdout: "{}", stderr: "" });
	const read = await handleApi({ method: "GET", pathname: "/api/config", query: { section: "pi-settings" }, exec: echo });
	assert.deepEqual(read.args, ["config", "read", "pi-settings"]);

	const raw = '{"retry":{"maxRetries":6}}';
	const written = await handleApi({
		method: "POST",
		pathname: "/api/config",
		query: { section: "pi-settings" },
		rawBody: raw,
		exec: (args, stdin) => Promise.resolve({ exitCode: 0, stdout: "{}", stderr: "", stdin }),
	});
	assert.deepEqual(written.args, ["config", "write", "pi-settings"]);
	assert.equal(written.stdin, raw);
}

// --- config write: the fingerprint of the file the form was built from ----
{
	const rev = "a".repeat(64);
	const seen = await handleApi({
		method: "POST",
		pathname: "/api/config",
		query: { section: "pi-settings", rev },
		rawBody: "{}",
		exec: (args, stdin) => Promise.resolve({ exitCode: 0, stdout: "{}", stderr: "", stdin }),
	});
	assert.deepEqual(seen.args, ["config", "write", "pi-settings", "--rev", rev], "the CLI is asked to check it");

	const absent = await handleApi({
		method: "POST", pathname: "/api/config", query: { section: "pi-settings", rev: "absent" }, rawBody: "{}",
		exec: () => Promise.resolve({ exitCode: 0, stdout: "{}", stderr: "" }),
	});
	assert.deepEqual(absent.args.slice(-2), ["--rev", "absent"], "'no file yet' is a fingerprint too");

	// The value becomes an argv element, so it is allowlisted like every other one.
	for (const bad of ["", "--force", "../../x", "A".repeat(64), "a".repeat(63), "absent;rm"]) {
		await assert.rejects(
			handleApi({ method: "POST", pathname: "/api/config", query: { section: "pi-settings", rev: bad }, rawBody: "{}", exec: () => Promise.resolve({ exitCode: 0, stdout: "{}" }) }),
			/rev is missing or malformed/,
			`rev ${JSON.stringify(bad)} is refused before it reaches the CLI`,
		);
	}
}

// --- host / origin checks --------------------------------------------------
assert.equal(isAllowedHost({ headers: { host: "127.0.0.1:4321" } }, 4321), true);
assert.equal(isAllowedHost({ headers: { host: "localhost:4321" } }, 4321), true);
// DNS rebinding: the name resolves to 127.0.0.1 but the Host header does not.
assert.equal(isAllowedHost({ headers: { host: "evil.example.com:4321" } }, 4321), false);
assert.equal(isAllowedHost({ headers: { host: "127.0.0.1:9999" } }, 4321), false);
assert.equal(isAllowedHost({ headers: { host: "127.0.0.1:4321", origin: "http://evil.example.com" } }, 4321), false);
assert.equal(isAllowedHost({ headers: {} }, 4321), false);

assert.equal(bearerToken({ headers: { authorization: "Bearer abc.def" } }), "abc.def");
assert.equal(bearerToken({ headers: { authorization: "Basic abc" } }), null);
assert.equal(bearerToken({ headers: {} }), null);

// --- cache: coalesce, expire, never memoize a failure ----------------------
{
	const cache = createCache();
	let calls = 0;
	const slow = () => new Promise((resolve) => setTimeout(() => { calls += 1; resolve({ exitCode: 0, stdout: "{}" }); }, 20));

	// Three tabs polling the same thing must cost one spawn, not three.
	const [a, b, c] = await Promise.all([
		cache.run("graph", 1000, slow),
		cache.run("graph", 1000, slow),
		cache.run("graph", 1000, slow),
	]);
	assert.equal(calls, 1, "concurrent identical requests are single-flighted");
	assert.ok(b.coalesced || c.coalesced);
	assert.equal(a.exitCode, 0);

	const hit = await cache.run("graph", 1000, slow);
	assert.equal(calls, 1);
	assert.equal(hit.cached, true);

	const expired = await cache.run("graph", 0, slow);
	assert.equal(calls, 2, "ttl 0 always re-runs");
	assert.ok(!expired.cached);

	// A failure must not stick: the daemon coming back has to be visible on
	// the very next poll.
	let failures = 0;
	const failing = () => { failures += 1; return Promise.resolve({ exitCode: 2, stdout: "", stderr: "boom" }); };
	await cache.run("bad", 10_000, failing);
	await cache.run("bad", 10_000, failing);
	assert.equal(failures, 2, "failed answers are never cached");

	// Scoped invalidation: a POST drops only the reads its write can reach,
	// so prompting an agent must not throw away a 60s preflight answer.
	const fresh = () => Promise.resolve({ exitCode: 0, stdout: "{}" });
	await cache.run("agents", 60_000, fresh, "agents");
	await cache.run("preflight --json", 60_000, fresh, "preflight");
	cache.invalidate(["agents"]);
	assert.ok(!(await cache.run("agents", 60_000, fresh, "agents")).cached, "the invalidated tag re-runs");
	assert.equal((await cache.run("preflight --json", 60_000, fresh, "preflight")).cached, true, "an untouched tag survives");
}

// --- end to end over a real socket ----------------------------------------
{
	const calls = [];
	const handle = await startServer({
		port: 0,
		quiet: true,
		token: "test-token",
		runCli: (args) => {
			calls.push(args.join(" "));
			return Promise.resolve({ exitCode: 0, stdout: JSON.stringify({ ok: true, args }), stderr: "" });
		},
	});
	const base = `http://127.0.0.1:${handle.port}`;
	try {
		const anonymous = await fetch(`${base}/api/status`);
		assert.equal(anonymous.status, 401, "no token, no API");
		assert.equal(calls.length, 0, "an unauthorized request never reaches the CLI");

		const wrong = await fetch(`${base}/api/status`, { headers: { authorization: "Bearer nope" } });
		assert.equal(wrong.status, 401);

		const ok = await fetch(`${base}/api/status`, { headers: { authorization: "Bearer test-token" } });
		assert.equal(ok.status, 200);
		const payload = await ok.json();
		assert.equal(payload.ok, true);
		// Every answer names the command that produced it — that is what makes
		// "the CLI is the source of truth" checkable rather than aspirational.
		assert.equal(payload.command, "paseo-team status");
		assert.deepEqual(payload.data.args, ["status"]);

		const unknown = await fetch(`${base}/api/does-not-exist`, { headers: { authorization: "Bearer test-token" } });
		assert.equal(unknown.status, 404);

		// Static assets are public (they carry no data), but must not escape
		// the public directory.
		const page = await fetch(`${base}/`);
		assert.equal(page.status, 200);
		assert.match(await page.text(), /paseo-team/);
		const escape = await fetch(`${base}/..%2Fserver.mjs`);
		assert.ok(escape.status === 403 || escape.status === 404, `traversal blocked (got ${escape.status})`);
	} finally {
		await handle.close();
	}
}

// --- a POST invalidates only the reads its write can reach -----------------
{
	const calls = [];
	const handle = await startServer({
		port: 0,
		quiet: true,
		token: "t",
		runCli: (args) => {
			calls.push(args.join(" "));
			return Promise.resolve({ exitCode: 0, stdout: JSON.stringify({ args }), stderr: "" });
		},
	});
	const auth = { authorization: "Bearer t" };
	const base = `http://127.0.0.1:${handle.port}`;
	try {
		const agentsFirst = await (await fetch(`${base}/api/agents`, { headers: auth })).json();
		const preflightFirst = await (await fetch(`${base}/api/preflight`, { headers: auth })).json();
		assert.equal(agentsFirst.cached, false);
		assert.equal(preflightFirst.cached, false);

		const posted = await fetch(`${base}/api/agent/send`, {
			method: "POST",
			headers: { ...auth, "content-type": "application/json" },
			body: JSON.stringify({ agentId: "aaaaaaaa-1111-4111-8111-111111111111", prompt: "hello" }),
		});
		assert.equal(posted.status, 200);

		const agentsAgain = await (await fetch(`${base}/api/agents`, { headers: auth })).json();
		assert.equal(agentsAgain.cached, false, "agent answers were invalidated by the post");

		const preflightAgain = await (await fetch(`${base}/api/preflight`, { headers: auth })).json();
		assert.equal(preflightAgain.cached, true, "a prompt must not throw away the 60s preflight answer");
		assert.equal(calls.filter((call) => call.startsWith("preflight")).length, 1, "preflight ran exactly once");
	} finally {
		await handle.close();
	}
}

// --- an explicit refresh is not served from a read cache ------------------
// Pi (or an editor) can change a config file behind the page's back; "Tải lại"
// that answered from a read cached 5s earlier showed the file as it WAS.
{
	let reads = 0;
	const handle = await startServer({
		port: 0,
		quiet: true,
		token: "t",
		runCli: (args) => {
			if (args[0] === "config" && args[1] === "read") reads += 1;
			return Promise.resolve({ exitCode: 0, stdout: JSON.stringify({ n: reads }), stderr: "" });
		},
	});
	const auth = { authorization: "Bearer t" };
	const base = `http://127.0.0.1:${handle.port}`;
	try {
		const first = await (await fetch(`${base}/api/config?section=pi-settings`, { headers: auth })).json();
		const second = await (await fetch(`${base}/api/config?section=pi-settings`, { headers: auth })).json();
		assert.equal(second.cached, true, "a plain read is still cached");
		assert.equal(reads, 1);

		const fresh = await (await fetch(`${base}/api/config?section=pi-settings&fresh=1`, { headers: auth })).json();
		assert.notEqual(fresh.cached, true, "a fresh read goes to the CLI");
		assert.equal(reads, 2);
		assert.equal(fresh.data.n, 2, "and returns what the CLI said just now");

		const after = await (await fetch(`${base}/api/config?section=pi-settings`, { headers: auth })).json();
		assert.equal(after.data.n, 2, "the cached copy was replaced, so the next plain read is not the stale one");
		assert.equal(first.data.n, 1);

		// The unprompted favicon request is answered, not a 404 in the console.
		const icon = await fetch(`${base}/favicon.ico`);
		assert.equal(icon.status, 204);
	} finally {
		await handle.close();
	}
}

// --- static assets: ETag revalidation instead of a re-download -------------
{
	const handle = await startServer({ port: 0, quiet: true, token: "t" });
	try {
		const base = `http://127.0.0.1:${handle.port}`;
		const first = await fetch(`${base}/app.js`);
		assert.equal(first.status, 200);
		assert.equal(first.headers.get("cache-control"), "no-cache", "revalidate every time, never serve blind");
		const etag = first.headers.get("etag");
		assert.ok(etag, "a strong content-hash etag accompanies every static asset");
		const revalidate = await fetch(`${base}/app.js`, { headers: { "if-none-match": etag } });
		assert.equal(revalidate.status, 304, "an unchanged asset costs a 304, not a re-download");
		assert.equal(await revalidate.text(), "");
	} finally {
		await handle.close();
	}
}

// --- a malformed request target answers 400, it does not kill the server ----
// `new URL("//", base)` throws. That parse used to sit outside the handler's
// try, so one request (no token, no Host match needed) crashed the process.
// fetch() normalises the target, so this goes over a raw socket.
{
	const rawHttp = (port, target, headers = {}) =>
		new Promise((resolve, reject) => {
			const socket = connect(port, "127.0.0.1");
			let data = "";
			socket.setEncoding("utf8");
			socket.on("data", (chunk) => {
				data += chunk;
			});
			socket.on("end", () => resolve(data));
			socket.on("error", reject);
			socket.on("connect", () => {
				const head = Object.entries({ host: `127.0.0.1:${port}`, connection: "close", ...headers })
					.map(([key, value]) => `${key}: ${value}`)
					.join("\r\n");
				socket.write(`GET ${target} HTTP/1.1\r\n${head}\r\n\r\n`);
			});
		});

	const handle = await startServer({ port: 0, quiet: true, token: "t" });
	try {
		for (const target of ["//", "///", "//@/x", "//%"]) {
			const answer = await rawHttp(handle.port, target);
			assert.match(answer, /^HTTP\/1\.1 400 /, `${target} is a client error, not a dropped connection`);
			assert.match(answer, /BAD_REQUEST_TARGET/);
			const alive = await fetch(`http://127.0.0.1:${handle.port}/favicon.ico`);
			assert.equal(alive.status, 204, `the server must still be up after ${target}`);
		}
		// The Host check still runs first: a rebound name gets 403, whatever the target.
		const rebound = await rawHttp(handle.port, "//", { host: `evil.example:${handle.port}` });
		assert.match(rebound, /^HTTP\/1\.1 403 /);
	} finally {
		await handle.close();
	}
}

// --- nothing a request does can end the process ------------------------------
// The handler answers its own errors; the wrapper around it is the last line of
// defence for the ones it cannot (here the error response itself fails to
// serialise, because `code` is a BigInt).
{
	const handle = await startServer({
		port: 0,
		quiet: true,
		token: "t",
		runCli: () => {
			const error = new Error("boom");
			error.code = 10n;
			throw error;
		},
	});
	try {
		const base = `http://127.0.0.1:${handle.port}`;
		const failed = await fetch(`${base}/api/status`, { headers: { authorization: "Bearer t" } });
		assert.equal(failed.status, 500);
		assert.equal((await failed.json()).code, "SERVER_ERROR");
		assert.equal((await fetch(`${base}/favicon.ico`)).status, 204, "the server survives an error it cannot even report");
	} finally {
		await handle.close();
	}
}

// A child that exits without reading its stdin leaves the server writing into a
// closed pipe. For a body larger than the pipe buffer that is an EPIPE 'error'
// event on child.stdin; unhandled, it killed the server (and the test process).
{
	const result = await runCli(["--version"], "x".repeat(4_000_000));
	assert.equal(result.exitCode, 0);
	assert.match(result.stdout, /^pteam /);
}

// --- a failing CLI is surfaced, not swallowed ------------------------------
{
	const handle = await startServer({
		port: 0,
		quiet: true,
		token: "t",
		runCli: () => Promise.resolve({ exitCode: 3, stdout: "", stderr: "paseo daemon unreachable" }),
	});
	try {
		const response = await fetch(`http://127.0.0.1:${handle.port}/api/status`, { headers: { authorization: "Bearer t" } });
		assert.equal(response.status, 502);
		const payload = await response.json();
		assert.equal(payload.ok, false);
		assert.equal(payload.code, "CLI_FAILED");
		assert.match(payload.stderr, /daemon unreachable/);
	} finally {
		await handle.close();
	}
}

// --- every route is a real CLI subcommand ---------------------------------
{
	const known = new Set(["status", "preflight", "config", "prompts", "skills", "env", "install", "agents", "agent", "permits", "graph", "watchdog", "web", "seats", "models"]);
	for (const [key, route] of Object.entries(ROUTES)) {
		const { args } = route.build(
			{ section: "providers", role: "lead", id: "aaaa1111-2222-3333-4444-555555555555", name: "paseo-team-lead", room: "team" },
			{ agentId: "aaaa1111-2222-3333-4444-555555555555", action: "allow", requestId: "r", name: "paseo-team-lead", room: "team" },
			"{}",
		);
		assert.ok(known.has(args[0]), `${key} maps to a real subcommand (got '${args[0]}')`);
	}
}

// --- busy port: fall forward by default, fail friendly when pinned ----------
{
	const blocker = await startServer({ port: 0, quiet: true, token: "t" });
	try {
		const handle = await startServer({ port: blocker.port, quiet: true, token: "t", autoPort: true });
		assert.ok(
			handle.port > blocker.port && handle.port <= blocker.port + 8,
			`autoPort must fall forward past the busy port (blocked ${blocker.port}, got ${handle.port})`,
		);
		await handle.close();
	} finally {
		await blocker.close();
	}

	// a pinned port is the user's decision: reject with actionable text,
	// never a raw EADDRINUSE stack
	const pinnedBlocker = await startServer({ port: 0, quiet: true, token: "t" });
	await assert.rejects(
		() => startServer({ port: pinnedBlocker.port, quiet: true, token: "t" }),
		(err) => err.code === "WEB_PORT_BUSY" && /already in use/.test(err.message) && /--port/.test(err.message),
	);
	await pinnedBlocker.close();
}

// --- a zero exit is not the same question as a successful answer -------------
//
// This cache says it stores only successful answers, "because caching a
// failure would keep showing a stale error after the daemon came back". It
// decided that on the exit code alone, and `graph` is where the two came
// apart: collectGraph deliberately reports a fault AS DATA — ok:false with a
// degraded list, exit 0 — so this server can still render a page that explains
// itself. Making it exit non-zero instead would take the CLI_FAILED path, which
// returns 502 and never parses the body, so the explaining page is exactly what
// would be lost. The body therefore gets a say in what is worth remembering.
{
	const ok = (body) => ({ exitCode: 0, stdout: JSON.stringify(body), stderr: "" });

	assert.equal(isCacheable(ok({ ok: true, agents: [] })), true);
	assert.equal(isCacheable(ok({ ok: false, degraded: [{ reason: "LIST_FAILED" }] })), false);
	// A body with no `ok` at all is not claiming failure — `status`, `config
	// read` and the prompt/skill bodies have none.
	assert.equal(isCacheable(ok({ paths: {} })), true);
	assert.equal(isCacheable({ exitCode: 0, stdout: "", stderr: "" }), true);
	// Non-zero still loses, whatever the body says.
	assert.equal(isCacheable({ exitCode: 3, stdout: JSON.stringify({ ok: true }) }), false);
	assert.equal(isCacheable({ exitCode: null, stdout: "" }), false);
	// An unparseable body is heading for a 502 anyway; remembering it would
	// serve that 502 from cache for the whole window.
	assert.equal(isCacheable({ exitCode: 0, stdout: "<html>login</html>" }), false);

	// And the cache honours it: a degraded graph is answered, then re-fetched.
	const cache = createCache();
	let calls = 0;
	const failing = async () => {
		calls += 1;
		return ok({ ok: false, degraded: [{ reason: "LIST_FAILED" }] });
	};
	assert.equal((await cache.run("graph", 60_000, failing, "graph")).exitCode, 0);
	await cache.run("graph", 60_000, failing, "graph");
	assert.equal(calls, 2, "a body reporting its own failure must not be served from cache");

	// A healthy one still caches, or this would have cost the cache its job.
	let good = 0;
	const healthy = async () => {
		good += 1;
		return ok({ ok: true, nodes: [] });
	};
	await cache.run("graph-ok", 60_000, healthy, "graph");
	const second = await cache.run("graph-ok", 60_000, healthy, "graph");
	assert.equal(good, 1, "a successful answer is still remembered");
	assert.equal(second.cached, true);
}

console.log("webui-server tests passed");
