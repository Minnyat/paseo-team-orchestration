#!/usr/bin/env node
// fake-paseo.mjs — fake paseo CLI for remote-paseo.mjs tests.
//
// Echoes argv as JSON (with the --host VALUE redacted so tests can assert the
// endpoint never leaks into wrapper output). Recognizes a few commands to
// return CLI-shaped results, and "--fail" to exercise the CLI_ERROR path.

const argv = process.argv.slice(2);

// The endpoint value is redacted in the echo ON PURPOSE: in production the
// real paseo never echoes argv back, so the wrapper's stdout must be free of
// the secret. The fake mimics that so the leak assertion is meaningful.
const shown = [...argv];
{
	const hostIdx = shown.indexOf("--host");
	if (hostIdx >= 0 && hostIdx + 1 < shown.length) {
		shown[hostIdx + 1] = "<host-redacted>";
	}
}

// Paseo >= 0.14 answers a failed --json command with {"error":{...}} on
// STDERR. FAKE_PASEO_JSON_ERROR=<CODE> reproduces that, echoing the endpoint
// (normalized, with its password) the way DAEMON_UNREACHABLE really does.
if (process.env.FAKE_PASEO_JSON_ERROR) {
	const hostIdx = argv.indexOf("--host");
	const endpoint = hostIdx >= 0 ? argv[hostIdx + 1] : "?";
	console.error(JSON.stringify({
		error: {
			code: process.env.FAKE_PASEO_JSON_ERROR,
			message: `fake failure at ${endpoint} (also as tcp://x:1?password=hunter2&ssl=true)`,
			details: "fake details",
		},
	}, null, 2));
	process.exit(1);
}

if (argv.includes("--fail")) {
	// Simulate a paseo CLI that leaks the endpoint into its own stderr — the
	// wrapper must redact it from the error it surfaces.
	const hostIdx = argv.indexOf("--host");
	const leaked =
		hostIdx >= 0 && hostIdx + 1 < argv.length ? argv[hostIdx + 1] : "?";
	console.error(`boom: ${leaked}`);
	process.exit(1);
}

if (
	argv[0] === "workspace" &&
	argv[1] === "create" &&
	process.env.FAKE_PASEO_WORKSPACE_CREATE_FAIL === "1"
) {
	console.error("fatal: could not create worktree: disk full");
	process.exit(1);
}

// `workspace ls --json`: the rows come from the test, so "a workspace is already
// open on this path" and "none is" are both expressible. FAKE_PASEO_WORKSPACE_LS_FAIL
// makes the listing itself fail, which the wrapper must NOT read as "none".
if (argv[0] === "workspace" && argv[1] === "ls") {
	if (process.env.FAKE_PASEO_WORKSPACE_LS_FAIL === "1") {
		console.error("fatal: daemon unavailable");
		process.exit(1);
	}
	if (process.env.FAKE_PASEO_WORKSPACES !== undefined) {
		console.log(process.env.FAKE_PASEO_WORKSPACES);
		process.exit(0);
	}
}

if (argv[0] === "run") {
	if (process.env.FAKE_PASEO_NO_AGENT_ID === "1") {
		console.log(JSON.stringify({ status: "running" }));
		process.exit(0);
	}
	const labels = argv.flatMap((value, i) => (argv[i - 1] === "--label" ? [value] : []));
	console.log(
		JSON.stringify({
			agentId: "9f8e7d6c-0000-0000-0000-000000000000",
			status: "running",
			provider: "pi-peer",
			cwd: "/fake/worktree",
			title: argv.includes("--title")
				? argv[argv.indexOf("--title") + 1]
				: null,
			labels,
		}),
	);
	process.exit(0);
}

if (argv[0] === "inspect") {
	const noRuntime = process.env.FAKE_PASEO_NO_RUNTIME === "1";
	const runtime = {
		model: process.env.FAKE_PASEO_RUNTIME_MODEL ?? "testprov/model-a",
		thinkingOptionId: process.env.FAKE_PASEO_RUNTIME_THINKING ?? "low",
	};
	console.log(
		JSON.stringify({
			Id: argv[1],
			Name: "fake-agent",
			Provider: "pi",
			...(noRuntime
				? {}
				: process.env.FAKE_PASEO_NEST_RUNTIME === "1"
					? { snapshot: { runtimeInfo: runtime } }
					: { Model: runtime.model, Thinking: runtime.thinkingOptionId }),
			Status: "idle",
		}),
	);
	process.exit(0);
}

if (argv[0] === "archive") {
	if (process.env.FAKE_PASEO_ARCHIVE_FAIL === "1") {
		console.error("archive failed");
		process.exit(1);
	}
	if (process.env.FAKE_PASEO_ARCHIVE_MARKER) {
		await import("node:fs/promises").then(({ writeFile }) =>
			writeFile(process.env.FAKE_PASEO_ARCHIVE_MARKER, argv[1], "utf8"),
		);
	}
	console.log(JSON.stringify({ archived: argv[1] }));
	process.exit(0);
}

if (process.env.FAKE_PASEO_LEAK_ENDPOINT === "1") {
	const hostIdx = argv.indexOf("--host");
	const endpoint = hostIdx >= 0 ? argv[hostIdx + 1] : "";
	console.log(JSON.stringify({ endpoint, argv: shown }));
} else {
	console.log(JSON.stringify({ argv: shown }));
}
