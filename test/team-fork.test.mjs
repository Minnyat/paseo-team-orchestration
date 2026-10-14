// team-fork.test.mjs — PR-E: session fork / handoff.
//
// The expensive half (paseo import, update_agent) is stubbed; what is exercised
// for real is the part that touches DATA: the transcript copy, the header
// rewrite, and the route verification that decides whether the fork survives.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
	FORK_SEED_HEADER,
	forkModelBlockReason,
	forkRequestBlockReason,
	forkSeedPrompt,
} from "../extensions/paseo-team-core/policy-core.ts";
import {
	forkAgent,
	materializeFork,
	sessionFileName,
	uuidv7,
	verifyFork,
} from "../scripts/team-fork.mjs";

// The route gate is off for this file: it pins the fork MECHANICS (copy,
// import, mode, verify), and with the gate on every fork would read the route
// table from the default config dir. The fork's route check is pinned with
// enforcement ON — and an injected route table — in test/route-gate.test.mts.
process.env.PASEO_TEAM_ROUTE_ENFORCE = "off";

const SOURCE = "aaaaaaaa-1111-4111-8111-111111111111";
const FORKED = "bbbbbbbb-2222-4222-8222-222222222222";

// ---------------------------------------------------------------------------
// Which forks are allowed at all
// ---------------------------------------------------------------------------

test("a fork must declare a reason from the known set", () => {
	assert.equal(forkRequestBlockReason({ reason: "takeover", disposition: "lead", scope: "src" }), null);
	assert.match(String(forkRequestBlockReason({ disposition: "lead" })), /FORK_REASON_INVALID/);
	assert.match(
		String(forkRequestBlockReason({ reason: "because", disposition: "lead" })),
		/FORK_REASON_INVALID/,
	);
});

test("forking a role whose value is independence is refused", () => {
	for (const disposition of ["reviewer", "independent reviewer", "challenger", "supervisor", "auditor"]) {
		assert.match(
			String(forkRequestBlockReason({ reason: "split-load", disposition, scope: "src" })),
			/FORK_ROLE_MUST_BE_INDEPENDENT/,
			disposition,
		);
	}
	assert.equal(forkRequestBlockReason({ reason: "split-load", disposition: "engineer", scope: "src" }), null);
});

test('"I am running out of context" is not a fork reason', () => {
	// Whether it arrives as the reason or buried in the rationale.
	assert.match(
		String(forkRequestBlockReason({ reason: "context-full", disposition: "lead" })),
		/FORK_FOR_CONTEXT|FORK_REASON_INVALID/,
	);
	const withRationale = forkRequestBlockReason({
		reason: "split-load",
		disposition: "lead",
		scope: "src",
		rationale: "my context window is nearly exhausted",
	});
	assert.match(String(withRationale), /FORK_FOR_CONTEXT/);
	assert.match(String(withRationale), /compact/);
});

test("a fork that will write must name the scope it takes", () => {
	assert.match(
		String(forkRequestBlockReason({ reason: "split-load", disposition: "engineer" })),
		/FORK_WITHOUT_LEASE_PLAN/,
	);
	assert.match(
		String(forkRequestBlockReason({ reason: "takeover", disposition: "lead" })),
		/FORK_WITHOUT_LEASE_PLAN/,
	);
	// Changing host or model moves the same seat; it adds no second writer.
	assert.equal(forkRequestBlockReason({ reason: "change-host", disposition: "lead" }), null);
	assert.equal(forkRequestBlockReason({ reason: "change-model", disposition: "lead" }), null);
});

test("the seed prompt revokes the inherited identity in so many words", () => {
	const seed = forkSeedPrompt({
		sourceAgentId: SOURCE,
		forkAgentId: FORKED,
		reason: "takeover",
		disposition: "lead",
		owns: "src/auth",
		doesNotOwn: "everything else",
	});
	assert.ok(seed.startsWith(FORK_SEED_HEADER));
	assert.ok(seed.includes(`FORK_OF: ${SOURCE}`));
	assert.ok(seed.includes(`You are NOT ${SOURCE}`));
	assert.match(seed, /inherit no scope lease/i);
	assert.match(seed, /inherit no Peers/i);
	assert.ok(seed.includes("OWNS: src/auth"));
	// The defaults have to be the SAFE reading, not an empty line: a seed that
	// says nothing about ownership leaves the fork believing it owns what the
	// transcript says it owns.
	const bare = forkSeedPrompt({ sourceAgentId: SOURCE, reason: "takeover", disposition: "lead" });
	assert.match(bare, /OWNS: nothing yet/);
	assert.ok(bare.includes(`DOES_NOT_OWN: every scope, lease and Peer still held by ${SOURCE}`));
});

// ---------------------------------------------------------------------------
// The copy itself
// ---------------------------------------------------------------------------

const HEADER = {
	type: "session",
	version: 3,
	id: "01a0081c-6715-7d66-84e6-efd29ffcf7fd",
	timestamp: "2026-08-16T01:07:54.261Z",
	cwd: "D:\\repo",
};
const ENTRIES = [
	{ type: "model_change", id: "10401e15", parentId: null, timestamp: "2026-08-16T01:08:00.372Z" },
	{ type: "message", id: "20401e15", parentId: "10401e15", text: "codeword FALCON-9920" },
];

async function withSession(run) {
	const dir = mkdtempSync(join(tmpdir(), "pteam-fork-"));
	const file = join(dir, sessionFileName(HEADER.id, Date.parse(HEADER.timestamp)));
	writeFileSync(file, [JSON.stringify(HEADER), ...ENTRIES.map((e) => JSON.stringify(e))].join("\n"), "utf8");
	try {
		return await run({ dir, file });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test("uuidv7 is time-ordered and well-formed", () => {
	const early = uuidv7(1_000_000_000_000);
	const late = uuidv7(2_000_000_000_000);
	assert.match(early, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
	assert.ok(early < late, "a later fork sorts after an earlier one");
	assert.notEqual(uuidv7(1_000_000_000_000), uuidv7(1_000_000_000_000));
});

test("the fork copies every entry verbatim and rewrites only the header", async () => {
	await withSession(({ file }) => {
		const now = Date.parse("2026-08-28T10:00:00.000Z");
		const result = materializeFork(file, { now });
		const lines = readFileSync(result.file, "utf8").split("\n");
		const header = JSON.parse(lines[0]);

		assert.equal(header.type, "session");
		assert.equal(header.id, result.sessionId);
		assert.notEqual(header.id, HEADER.id);
		assert.equal(header.timestamp, new Date(now).toISOString());
		// An absolute path back to the source: that is what a real fork records,
		// and what makes the lineage readable afterwards.
		assert.equal(header.parentSession, file);
		assert.equal(header.cwd, HEADER.cwd, "everything else in the header survives");

		// The entries keep their own ids: a fork is not a replay, and rewriting
		// the id/parentId chain would break the very continuity it exists for.
		assert.deepEqual(
			lines.slice(1).filter(Boolean).map((line) => JSON.parse(line)),
			ENTRIES,
		);
		assert.equal(result.entries, ENTRIES.length);

		// The source is untouched.
		assert.equal(JSON.parse(readFileSync(file, "utf8").split("\n")[0]).id, HEADER.id);
		// And the fork lands beside it, named the way pi names sessions.
		assert.equal(dirname(result.file), dirname(file));
		assert.ok(result.file.endsWith(`_${result.sessionId}.jsonl`));
		// No temp file is left behind.
		assert.equal(readdirSync(dirname(file)).filter((name) => name.includes(".tmp-")).length, 0);
	});
});

test("an unusable source file is a named failure, not a half-made fork", async () => {
	assert.throws(() => materializeFork(""), /FORK_SESSION_FILE_MISSING|nativeHandle/);
	assert.throws(() => materializeFork("/no/such/file.jsonl"), /not found/);
	await withSession(({ dir }) => {
		const empty = join(dir, "empty.jsonl");
		writeFileSync(empty, "", "utf8");
		assert.throws(() => materializeFork(empty), /FORK_SESSION_EMPTY|empty/);
		const junk = join(dir, "junk.jsonl");
		writeFileSync(junk, "not json\n", "utf8");
		assert.throws(() => materializeFork(junk), /not JSON/);
		const wrong = join(dir, "wrong.jsonl");
		writeFileSync(wrong, `${JSON.stringify({ type: "message" })}\n`, "utf8");
		assert.throws(() => materializeFork(wrong), /session header/);
	});
});

// ---------------------------------------------------------------------------
// fork = validate + copy + import, and NOT "done"
// ---------------------------------------------------------------------------

function withState(run) {
	return withSession(async ({ dir, file }) => {
		const home = mkdtempSync(join(tmpdir(), "pteam-fork-home-"));
		const agentsDir = join(home, "agents", "D--repo");
		mkdirSync(agentsDir, { recursive: true });
		const write = (id, extra) =>
			writeFileSync(
				join(agentsDir, `${id}.json`),
				JSON.stringify({
					id,
					provider: "pi-lead/anthropic/model",
					cwd: "D:\\repo",
					labels: {},
					persistence: { nativeHandle: file },
					runtimeInfo: { sessionId: HEADER.id },
					...extra,
				}),
				"utf8",
			);
		write(SOURCE);
		try {
			return await run({ dir, file, home, agentsRoot: join(home, "agents"), write });
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
}

test("fork imports the copy and stops before the model is set", async () => {
	await withState(async ({ agentsRoot, file }) => {
		const calls = [];
		const result = await forkAgent(
			{
				agentId: SOURCE,
				reason: "takeover",
				disposition: "lead",
				scope: "src/auth",
				provider: "pi-lead/anthropic/claude-opus-5",
				model: "claude-opus-5",
				thinkingOptionId: "high",
				labels: { "team.domain": "backend" },
			},
			{
				role: "lead",
				agentsRoot,
				runPaseo: async (args) => {
					calls.push(args);
					return { id: FORKED };
				},
			},
		);

		assert.equal(result.agentId, FORKED);
		assert.equal(result.forkOf, SOURCE);
		assert.equal(result.parentSession, file);
		const [args] = calls;
		assert.equal(args[0], "import");
		assert.equal(args[1], result.sessionId, "the NEW session id is imported, not the source's");
		// The BARE provider id: `paseo import` rejects the `<provider>/<model>`
		// form `create_agent` takes ("Unknown provider ..."), which is the same
		// fact from the other side as "import cannot carry a route".
		assert.deepEqual(args.slice(2, 4), ["--provider", "pi-lead"]);
		assert.equal(result.requestedProvider, "pi-lead/anthropic/claude-opus-5");
		assert.ok(args.includes("--cwd"), "the source cwd travels with the fork");
		assert.ok(args.includes(`team.fork-of=${SOURCE}`), "the lineage is a label, so `paseo ls` shows it");
		assert.ok(args.includes("team.domain=backend"));
		// §PR-G follow-up: no code path stamped team.cluster at creation before
		// this, and a fork is a creation path too. Derived from the SOURCE's own
		// state (cwd "D:\\repo" → "d:/repo"), the same way team.fork-of is.
		assert.ok(args.includes("team.cluster=d:/repo"), "the source's cluster travels with the fork too");

		// §1.3: the CLI cannot route the model, so the caller is handed the exact
		// MCP call and told to verify afterwards.
		assert.equal(result.nextAction.tool, "update_agent");
		assert.deepEqual(result.nextAction.args.settings, { model: "claude-opus-5", thinkingOptionId: "high" });
		assert.equal(result.then, "verify");
		assert.ok(result.seedPrompt.includes(`You are NOT ${SOURCE}`));
	});
});

test("the fork's cluster is the SOURCE's own, not whatever the caller passed", async () => {
	// Like team.fork-of/team.fork-reason, this is a derived fact about the fork
	// operation, not a caller-settable label — a fork claiming a different
	// cluster than its source would be the escalation clusterLabelBlockReason
	// exists to catch on the create_agent path, reached here through import.
	await withState(async ({ agentsRoot }) => {
		const calls = [];
		await forkAgent(
			{
				agentId: SOURCE,
				reason: "change-host",
				disposition: "lead",
				provider: "pi-lead/anthropic/claude-opus-5",
				labels: { "team.cluster": "some-other-cluster" },
			},
			{
				role: "lead",
				agentsRoot,
				runPaseo: async (args) => {
					calls.push(args);
					return { id: FORKED };
				},
			},
		);
		const [args] = calls;
		assert.ok(args.includes("team.cluster=d:/repo"));
		assert.ok(!args.includes("team.cluster=some-other-cluster"));
	});
});

test("an underivable source cluster omits the label rather than lying about it", async () => {
	await withState(async ({ agentsRoot, write }) => {
		// No cwd, no workspaceId, no team.cluster label on the SOURCE's own state:
		// agentCluster(state) has nothing to derive from. --cwd still travels on
		// the request itself (forkAgent requires it independently — FORK_CWD_UNKNOWN
		// otherwise), which is a different value from the state's own cwd on
		// purpose: proof that the label comes from the source's STATE, not from
		// whatever cwd the request happens to carry.
		write(SOURCE, { cwd: undefined });
		const calls = [];
		await forkAgent(
			{
				agentId: SOURCE,
				reason: "change-host",
				disposition: "lead",
				provider: "pi-lead/anthropic/claude-opus-5",
				cwd: "D:\\elsewhere",
			},
			{
				role: "lead",
				agentsRoot,
				runPaseo: async (args) => {
					calls.push(args);
					return { id: FORKED };
				},
			},
		);
		const [args] = calls;
		assert.ok(!args.some((a) => typeof a === "string" && a.startsWith("team.cluster=")));

		// A caller-supplied label survives when the source cannot override it.
		calls.length = 0;
		await forkAgent(
			{
				agentId: SOURCE,
				reason: "change-host",
				disposition: "lead",
				provider: "pi-lead/anthropic/claude-opus-5",
				cwd: "D:\\elsewhere",
				labels: { "team.cluster": "caller-supplied" },
			},
			{ role: "lead", agentsRoot, runPaseo: async (args) => { calls.push(args); return { id: FORKED }; } },
		);
		assert.ok(calls[0].includes("team.cluster=caller-supplied"));
	});
});

test("a fork stays in its source's workspace: a cwd that names another directory is refused", async () => {
	await withState(async ({ agentsRoot, dir }) => {
		const before = readdirSync(dir).length;
		let imported = false;
		await assert.rejects(
			forkAgent(
				{
					agentId: SOURCE,
					reason: "change-host",
					disposition: "lead",
					provider: "pi-lead/anthropic/claude-opus-5",
					cwd: "D:\\elsewhere",
				},
				{ role: "lead", agentsRoot, runPaseo: async () => { imported = true; return { id: FORKED }; } },
			),
			/FORK_CWD_MISMATCH/,
		);
		assert.equal(imported, false, "nothing was imported");
		assert.equal(readdirSync(dir).length, before, "and no session file was written");

		// The same directory, spelled differently, is the same directory.
		await forkAgent(
			{
				agentId: SOURCE,
				reason: "change-host",
				disposition: "lead",
				provider: "pi-lead/anthropic/claude-opus-5",
				cwd: "d:/repo/",
			},
			{ role: "lead", agentsRoot, runPaseo: async () => ({ id: FORKED }) },
		);
	});
});

test("a blocked fork never touches the disk", async () => {
	await withState(async ({ agentsRoot, dir }) => {
		const before = readdirSync(dir).length;
		await assert.rejects(
			forkAgent(
				{ agentId: SOURCE, reason: "split-load", disposition: "reviewer", scope: "src", provider: "pi-peer/a/b" },
				{ role: "lead", agentsRoot, runPaseo: async () => ({ id: FORKED }) },
			),
			/FORK_ROLE_MUST_BE_INDEPENDENT/,
		);
		assert.equal(readdirSync(dir).length, before, "no session file was written");
	});
});

test("a failed import cleans up the session file it made", async () => {
	await withState(async ({ agentsRoot, dir }) => {
		const before = readdirSync(dir).length;
		await assert.rejects(
			forkAgent(
				{ agentId: SOURCE, reason: "change-model", disposition: "lead", provider: "pi-lead/a/b" },
				{
					role: "lead",
					agentsRoot,
					runPaseo: async () => {
						throw Object.assign(new Error("daemon unreachable"), { code: "CLI_ERROR" });
					},
				},
			),
			/daemon unreachable/,
		);
		assert.equal(
			readdirSync(dir).length,
			before,
			"an orphan transcript would be imported by the next retry under a different provider",
		);
	});
});

test("a Peer cannot fork, and a provider outside the pack is refused", async () => {
	await withState(async ({ agentsRoot }) => {
		await assert.rejects(
			forkAgent({ agentId: SOURCE, reason: "change-model", disposition: "lead", provider: "pi-lead/a/b" }, {
				role: "peer",
				agentsRoot,
			}),
			/ROLE_NOT_ALLOWED/,
		);
		await assert.rejects(
			forkAgent({ agentId: SOURCE, reason: "change-model", disposition: "lead", provider: "codex/gpt-5" }, {
				role: "lead",
				agentsRoot,
			}),
			(error) => error.code === "FORK_PROVIDER_INVALID" && /role providers/.test(error.message),
		);
	});
});

// ---------------------------------------------------------------------------
// Verification: the route, or nothing
// ---------------------------------------------------------------------------

test("the route check reads runtimeInfo and refuses a stale creation snapshot", () => {
	assert.equal(forkModelBlockReason({ expectedModel: "m", actualModel: "m" }), null);
	assert.match(String(forkModelBlockReason({ expectedModel: "m", actualModel: "other" })), /FORK_MODEL_UNROUTABLE/);
	assert.match(String(forkModelBlockReason({ expectedModel: "m", actualModel: null })), /FORK_MODEL_UNROUTABLE/);
	assert.equal(forkModelBlockReason({ actualModel: "anything" }), null, "nothing expected, nothing to check");
	// Measured on a real import: runtimeInfo answers the pi-qualified form
	// ("Minnyat/claude-opus-5") while a Lead routes with the bare model id.
	// Failing that comparison DELETES a correctly routed fork, so the tolerance
	// is a correctness rule, not a convenience.
	assert.equal(forkModelBlockReason({ expectedModel: "claude-opus-5", actualModel: "Minnyat/claude-opus-5" }), null);
	assert.equal(forkModelBlockReason({ expectedModel: "Minnyat/claude-opus-5", actualModel: "claude-opus-5" }), null);
	// Two providers serving the same model id is exactly the distinction a
	// cross-provider route exists to make, so qualified-vs-qualified must match.
	assert.match(
		String(forkModelBlockReason({ expectedModel: "A/claude-opus-5", actualModel: "B/claude-opus-5" })),
		/FORK_MODEL_UNROUTABLE/,
	);
	assert.match(
		String(forkModelBlockReason({ expectedModel: "gpt-5.6-luna", actualModel: "Minnyat/claude-opus-5" })),
		/FORK_MODEL_UNROUTABLE/,
	);
	assert.match(
		String(forkModelBlockReason({ expectedThinking: "high", actualThinking: "minimal" })),
		/thinking level/,
	);
});

test("verify accepts a fork on the requested route", async () => {
	await withState(async ({ agentsRoot, write }) => {
		write(FORKED, { runtimeInfo: { sessionId: "s", model: "claude-opus-5", thinkingOptionId: "high" } });
		const result = await verifyFork(
			{ agentId: FORKED, model: "claude-opus-5", thinkingOptionId: "high" },
			{ role: "lead", agentsRoot, runPaseo: async () => ({}) },
		);
		assert.equal(result.ok, true);
		assert.equal(result.model, "claude-opus-5");
		assert.equal(result.modelSource, "runtime");
	});
});

test("a fork on the wrong model is deleted, not reported and kept", async () => {
	await withState(async ({ agentsRoot, write }) => {
		write(FORKED, {
			// The stale creation-time snapshot says the RIGHT thing; runtimeInfo
			// says what the agent actually runs. Trusting persistence.metadata
			// here is exactly the bug §1.3 records.
			persistence: { metadata: { model: "claude-opus-5" } },
			runtimeInfo: { sessionId: "s", model: "haiku-4-5", thinkingOptionId: "high" },
		});
		const calls = [];
		const result = await verifyFork(
			{ agentId: FORKED, model: "claude-opus-5" },
			{
				role: "lead",
				agentsRoot,
				runPaseo: async (args) => {
					calls.push(args);
					return {};
				},
			},
		);
		assert.equal(result.ok, false);
		assert.equal(result.code, "FORK_MODEL_UNROUTABLE");
		assert.equal(result.model, "haiku-4-5");
		assert.equal(result.removed, true);
		assert.deepEqual(calls, [["delete", FORKED]]);
	});
});

test("a delete that fails is reported rather than swallowed", async () => {
	await withState(async ({ agentsRoot, write }) => {
		write(FORKED, { runtimeInfo: { sessionId: "s", model: "haiku-4-5" } });
		const result = await verifyFork(
			{ agentId: FORKED, model: "claude-opus-5" },
			{
				role: "lead",
				agentsRoot,
				runPaseo: async () => {
					throw new Error("agent is busy");
				},
			},
		);
		assert.equal(result.removed, false);
		assert.match(result.removeError, /busy/);
	});
});

// ---------------------------------------------------------------------------
// The mode the fork comes up in
//
// Measured 2026-09-07: `paseo import` has no --mode at all, and Paseo applies
// no provider defaultMode at create time (claude/agent.js builds the seat with
// `isPermissionMode(config.modeId) ? config.modeId : "default"`). So an
// imported Claude seat is on "default" — every tool call parked in the
// permission queue — until something moves it. That something is here.
// ---------------------------------------------------------------------------

test("a claude fork is moved onto auto right after the import", async () => {
	await withState(async ({ agentsRoot }) => {
		const calls = [];
		const result = await forkAgent(
			{
				agentId: SOURCE,
				reason: "change-host",
				disposition: "lead",
				provider: "claude-lead/claude-opus-5",
			},
			{
				role: "lead",
				agentsRoot,
				runPaseo: async (args) => {
					calls.push(args);
					return { agentId: FORKED };
				},
			},
		);
		assert.equal(result.mode, "auto");
		assert.equal(calls.length, 2, "import, then the mode it could not carry");
		assert.equal(calls[0][0], "import");
		assert.deepEqual(calls[1], ["agent", "mode", FORKED, "auto"]);
	});
});

test("a deliberate narrowing travels; pi gets no mode at all", async () => {
	await withState(async ({ agentsRoot }) => {
		const calls = [];
		const planned = await forkAgent(
			{
				agentId: SOURCE,
				reason: "split-load",
				disposition: "planner",
				scope: "docs/plan",
				provider: "claude-peer/claude-opus-5",
				modeId: "plan",
			},
			{ role: "lead", agentsRoot, runPaseo: async (args) => (calls.push(args), { agentId: FORKED }) },
		);
		assert.equal(planned.mode, "plan");
		assert.deepEqual(calls[1], ["agent", "mode", FORKED, "plan"]);

		// pi declares no modes (AvailableModes: []), so there is nothing to set
		// and sending one would be an error rather than a safety measure.
		const piCalls = [];
		const pi = await forkAgent(
			{
				agentId: SOURCE,
				reason: "change-host",
				disposition: "lead",
				provider: "pi-lead/Minnyat/gpt-5.6-sol",
			},
			{ role: "lead", agentsRoot, runPaseo: async (args) => (piCalls.push(args), { agentId: FORKED }) },
		);
		assert.equal(pi.mode, null);
		assert.equal(piCalls.length, 1, "import only");

		// And a mode asked for on a pi route is refused before anything is copied.
		await assert.rejects(
			forkAgent(
				{
					agentId: SOURCE,
					reason: "change-host",
					disposition: "lead",
					provider: "pi-lead/Minnyat/gpt-5.6-sol",
					modeId: "auto",
				},
				{ role: "lead", agentsRoot, runPaseo: async () => ({ agentId: FORKED }) },
			),
			(error) => error.code === "FORK_MODE_INVALID",
		);
		// bypassPermissions is never a seat mode, however deliberate the caller.
		await assert.rejects(
			forkAgent(
				{
					agentId: SOURCE,
					reason: "change-host",
					disposition: "lead",
					provider: "claude-lead/claude-opus-5",
					modeId: "bypassPermissions",
				},
				{ role: "lead", agentsRoot, runPaseo: async () => ({ agentId: FORKED }) },
			),
			(error) => error.code === "FORK_MODE_INVALID",
		);
	});
});

test("a fork that cannot be moved off default is deleted, not handed over", async () => {
	await withState(async ({ agentsRoot }) => {
		const calls = [];
		await assert.rejects(
			forkAgent(
				{
					agentId: SOURCE,
					reason: "change-host",
					disposition: "lead",
					provider: "claude-lead/claude-opus-5",
				},
				{
					role: "lead",
					agentsRoot,
					runPaseo: async (args) => {
						calls.push(args);
						if (args[0] === "agent") throw new Error("auto mode unavailable for this model");
						return { agentId: FORKED };
					},
				},
			),
			(error) =>
				error.code === "FORK_MODE_UNSET" &&
				/deleted/.test(error.message) &&
				// The default mode was never chosen by the caller, so the way out
				// when auto does not exist for this model is named.
				/explicit modeId/.test(error.message),
		);
		assert.deepEqual(calls[2], ["delete", FORKED], "the half-made fork does not survive");
	});
});

test("verify refuses a claude fork still sitting on default", async () => {
	await withState(async ({ agentsRoot, write }) => {
		write(FORKED, {
			provider: "claude-lead/claude-opus-5",
			// The creation-time snapshot is not a mode source either: this one
			// says "auto" while the agent actually runs "default".
			persistence: { metadata: { modeId: "auto" } },
			runtimeInfo: { sessionId: "s", model: "claude-opus-5", modeId: "default" },
		});
		const calls = [];
		const result = await verifyFork(
			{ agentId: FORKED, model: "claude-opus-5" },
			{ role: "lead", agentsRoot, runPaseo: async (args) => (calls.push(args), {}) },
		);
		assert.equal(result.ok, false);
		assert.equal(result.code, "FORK_MODE_UNROUTABLE");
		assert.equal(result.mode, "default");
		assert.equal(result.removed, true);
		assert.deepEqual(calls, [["delete", FORKED]]);
	});
});

test("verify refuses bypassPermissions even when the caller asked for it", async () => {
	await withState(async ({ agentsRoot, write }) => {
		write(FORKED, {
			provider: "claude-lead/claude-opus-5",
			runtimeInfo: { sessionId: "s", model: "claude-opus-5", modeId: "bypassPermissions" },
		});
		const calls = [];
		const result = await verifyFork(
			{ agentId: FORKED, model: "claude-opus-5", modeId: "bypassPermissions" },
			{ role: "lead", agentsRoot, runPaseo: async (args) => (calls.push(args), {}) },
		);
		assert.equal(result.ok, false);
		assert.equal(result.code, "FORK_MODE_UNROUTABLE");
		assert.equal(result.removed, true);
		assert.deepEqual(calls, [["delete", FORKED]]);
	});
});

test("verify accepts a claude fork on auto", async () => {
	await withState(async ({ agentsRoot, write }) => {
		write(FORKED, {
			provider: "claude-lead/claude-opus-5",
			runtimeInfo: { sessionId: "s", model: "claude-opus-5", modeId: "auto" },
		});
		const result = await verifyFork(
			{ agentId: FORKED, model: "claude-opus-5" },
			{ role: "lead", agentsRoot, runPaseo: async () => ({}) },
		);
		assert.equal(result.ok, true);
		assert.equal(result.mode, "auto");
		assert.equal(result.modeSource, "runtime");
	});
});

// ---------------------------------------------------------------------------
// The route gate, ENFORCED. The file-wide opt-out above is overridden per call
// with `env: {}`, and the route table is injected, so nothing here reads a real
// config directory.
// ---------------------------------------------------------------------------

const ENFORCED = {};
const ROUTE_TABLE = {
	ok: true,
	source: "routing",
	path: "/cfg/model-routing.local.json",
	hostId: "h",
	routes: {
		FAST_READ: { paseoProvider: "pi-peer", model: "Mx/cheap", thinking: "low" },
		LEAD_RECOVERY: { paseoProvider: "pi-lead", model: "anthropic/claude-opus-5", thinking: "high" },
	},
};
const leadFork = (extra = {}) => ({
	agentId: SOURCE,
	reason: "takeover",
	disposition: "lead",
	scope: "src/auth",
	provider: "pi-lead",
	...extra,
});
const routedOptions = (agentsRoot, calls, extra = {}) => ({
	role: "lead",
	agentsRoot,
	env: ENFORCED,
	routeTable: ROUTE_TABLE,
	runPaseo: async (args) => {
		calls.push(args);
		return { id: FORKED };
	},
	...extra,
});

test("route gate: a fork declares a class, lands on its route, and carries the class label", async () => {
	await withState(async ({ agentsRoot }) => {
		const calls = [];
		const result = await forkAgent(leadFork({ modelClass: "LEAD_RECOVERY" }), routedOptions(agentsRoot, calls));
		assert.deepEqual(
			result.nextAction.args.settings,
			{ model: "anthropic/claude-opus-5", thinkingOptionId: "high" },
			"the update_agent the Lead is handed carries the ROUTE's values",
		);
		const importArgs = calls[0];
		assert.ok(importArgs.includes("team.model-class=LEAD_RECOVERY"), "the class is stamped on the import");
		// Passing the route's own values explicitly is the same fork.
		const explicit = await forkAgent(
			leadFork({ modelClass: "LEAD_RECOVERY", model: "anthropic/claude-opus-5", thinkingOptionId: "high" }),
			routedOptions(agentsRoot, []),
		);
		assert.equal(explicit.ok, true);
	});
});

test("route gate: a fork without a class, on another model, from another flow, or with no table is refused before anything is imported", async () => {
	await withState(async ({ agentsRoot }) => {
		const cases = [
			[leadFork(), /FORK_ROUTE_BLOCKED|ROUTE_CLASS_MISSING/, /ROUTE_CLASS_MISSING.*LEAD_RECOVERY/],
			[leadFork({ modelClass: "LEAD_RECOVERY", model: "anthropic/haiku" }), null, /ROUTE_MODEL_MISMATCH.*"anthropic\/claude-opus-5"/],
			[leadFork({ modelClass: "LEAD_RECOVERY", thinkingOptionId: "low" }), null, /ROUTE_THINKING_MISMATCH.*"high"/],
			[leadFork({ modelClass: "FAST_READ" }), null, /ROUTE_CLASS_WRONG_FLOW.*LEAD_RECOVERY/],
			[leadFork({ modelClass: "LEAD_RECOVERY", labels: { "team.model-class": "FAST_READ" } }), null, /disagree/],
		];
		for (const [input, , pattern] of cases) {
			const calls = [];
			await assert.rejects(forkAgent(input, routedOptions(agentsRoot, calls)), (error) => {
				assert.equal(error.code, "FORK_ROUTE_BLOCKED");
				assert.match(error.message, pattern);
				return true;
			});
			assert.deepEqual(calls, [], "no import for a refused fork");
		}
		const calls = [];
		await assert.rejects(
			forkAgent(
				leadFork({ modelClass: "LEAD_RECOVERY" }),
				routedOptions(agentsRoot, calls, { routeTable: { ok: false, code: "ROUTE_FILE_MISSING", message: "no local route file" } }),
			),
			/ROUTE_TABLE_UNAVAILABLE/,
		);
		await assert.rejects(
			forkAgent(leadFork({ modelClass: "LEAD_RECOVERY" }), routedOptions(agentsRoot, calls, { routeTable: null })),
			/ROUTE_UNVERIFIABLE/,
		);
		assert.deepEqual(calls, []);
	});
});

test("route gate: verify compares against the route of the fork's own class, not the caller's values", async () => {
	await withState(async ({ agentsRoot, write }) => {
		const onRoute = { sessionId: "s", model: "anthropic/claude-opus-5", thinkingOptionId: "high" };
		write(FORKED, { provider: "pi-lead", labels: { "team.model-class": "LEAD_RECOVERY" }, runtimeInfo: onRoute });
		const ok = await verifyFork({ agentId: FORKED }, routedOptions(agentsRoot, []));
		assert.equal(ok.ok, true, ok.message);

		// Off-route fork: refused and deleted even though the caller "expects" it.
		write(FORKED, {
			provider: "pi-lead",
			labels: { "team.model-class": "LEAD_RECOVERY" },
			runtimeInfo: { ...onRoute, model: "anthropic/haiku" },
		});
		const deletes = [];
		const drift = await verifyFork(
			{ agentId: FORKED },
			routedOptions(agentsRoot, deletes),
		);
		assert.equal(drift.ok, false);
		assert.equal(drift.code, "FORK_MODEL_UNROUTABLE");
		assert.deepEqual(deletes, [["delete", FORKED]]);

		// A caller value that disagrees with the route is refused, not obeyed.
		write(FORKED, { provider: "pi-lead", labels: { "team.model-class": "LEAD_RECOVERY" }, runtimeInfo: onRoute });
		const echoed = await verifyFork(
			{ agentId: FORKED, model: "anthropic/haiku", keep: true },
			routedOptions(agentsRoot, []),
		);
		assert.equal(echoed.ok, false);
		assert.match(echoed.message, /FORK_MODEL_UNROUTABLE.*ROUTE_MODEL_MISMATCH/);

		// A fork with no class on it cannot be shown to be on any route.
		write(FORKED, { provider: "pi-lead", labels: {}, runtimeInfo: onRoute });
		const unlabelled = await verifyFork({ agentId: FORKED, keep: true }, routedOptions(agentsRoot, []));
		assert.equal(unlabelled.ok, false);
		assert.match(unlabelled.message, /ROUTE_CLASS_MISSING/);
	});
});

test("route gate, a class with several options: a fork must NAME one, and verify accepts any usable option but deletes a stray model", async () => {
	const multi = {
		...ROUTE_TABLE,
		routes: {
			...ROUTE_TABLE.routes,
			LEAD_RECOVERY: {
				paseoProvider: "pi-lead",
				model: "anthropic/claude-opus-5",
				thinking: "high",
				alternates: [{ paseoProvider: "pi-lead", model: "anthropic/claude-sonnet-5", thinking: "medium" }],
			},
		},
	};
	await withState(async ({ agentsRoot, write }) => {
		// no model named: nothing is chosen for the Lead
		await assert.rejects(forkAgent(leadFork({ modelClass: "LEAD_RECOVERY" }), routedOptions(agentsRoot, [], { routeTable: multi })), (error) => {
			assert.equal(error.code, "FORK_ROUTE_BLOCKED");
			assert.match(error.message, /ROUTE_OPTION_AMBIGUOUS.*nothing is chosen for you/);
			return true;
		});
		// naming one is a fork on that option
		const named = await forkAgent(leadFork({ modelClass: "LEAD_RECOVERY", model: "anthropic/claude-sonnet-5" }), routedOptions(agentsRoot, [], { routeTable: multi }));
		assert.deepEqual(named.nextAction.args.settings, { model: "anthropic/claude-sonnet-5", thinkingOptionId: "medium" });

		// verify: the fork runs ONE of the usable options => fine, whichever it is
		for (const [model, thinking] of [["anthropic/claude-opus-5", "high"], ["anthropic/claude-sonnet-5", "medium"]]) {
			write(FORKED, { provider: "pi-lead", labels: { "team.model-class": "LEAD_RECOVERY" }, runtimeInfo: { sessionId: "s", model, thinkingOptionId: thinking } });
			const ok = await verifyFork({ agentId: FORKED }, routedOptions(agentsRoot, [], { routeTable: multi }));
			assert.equal(ok.ok, true, `${model}: ${ok.message}`);
		}
		// ...but a model that is none of them is refused and deleted
		write(FORKED, { provider: "pi-lead", labels: { "team.model-class": "LEAD_RECOVERY" }, runtimeInfo: { sessionId: "s", model: "anthropic/haiku", thinkingOptionId: "high" } });
		const deletes = [];
		const stray = await verifyFork({ agentId: FORKED }, routedOptions(agentsRoot, deletes, { routeTable: multi }));
		assert.equal(stray.ok, false);
		assert.equal(stray.code, "FORK_MODEL_UNROUTABLE");
		assert.deepEqual(deletes, [["delete", FORKED]]);
	});
});

// ---------------------------------------------------------------------------
// The second door to the Supervisor's authority. team_fork is how a successor
// Lead can be put in place without create_agent, so the rule that a watch seat
// observes — and the rule that a Supervisor is only ever seated by create_agent,
// where its label and its count are checked — have to hold here too.
// ---------------------------------------------------------------------------

const WATCHER = "cccccccc-3333-4333-8333-333333333333";
const DECIDING = "dddddddd-4444-4444-8444-444444444444";
const GENERALIST = "eeeeeeee-5555-4555-8555-555555555555";

test("a watch seat may not fork a successor Lead; a seat that decides, or has no label, may", async () => {
	await withState(async ({ agentsRoot, home, write }) => {
		write(WATCHER, { provider: "pi-supervisor/anthropic/model", labels: { "team.watch": "liveness,cost" } });
		write(DECIDING, { provider: "pi-supervisor/anthropic/model", labels: { "team.watch": "decisions,process" } });
		write(GENERALIST, { provider: "pi-supervisor/anthropic/model", labels: {} });
		const calls = [];
		const as = (id) => ({
			role: "supervisor",
			agentsRoot,
			// The route gate is off for this file's mechanics; the watch rule is not
			// something it can switch off, which is the point of this test.
			env: { PASEO_AGENT_ID: id, PASEO_HOME: home, PASEO_TEAM_ROUTE_ENFORCE: "off" },
			runPaseo: async (args) => {
				calls.push(args);
				return { id: FORKED };
			},
		});
		const recovery = {
			agentId: SOURCE,
			reason: "takeover",
			disposition: "lead",
			scope: "src/auth",
			provider: "pi-lead/anthropic/claude-opus-5",
		};

		await assert.rejects(forkAgent(recovery, as(WATCHER)), (error) => {
			assert.equal(error.code, "RECOVERY_NOT_DELEGATED");
			assert.match(error.message, /watch seat \(team\.watch: liveness, cost\)/);
			return true;
		});
		assert.deepEqual(calls, [], "nothing was imported");
		// verify is the other half of the same act (and deletes a fork that is off route).
		await assert.rejects(verifyFork({ agentId: FORKED }, as(WATCHER)), /RECOVERY_NOT_DELEGATED/);
		assert.deepEqual(calls, []);

		for (const id of [DECIDING, GENERALIST]) {
			const result = await forkAgent(recovery, as(id));
			assert.equal(result.agentId, FORKED, `${id} may fork a successor Lead`);
		}
		assert.equal(calls.length, 2, "one import each");

		// A Lead forking is not a recovery and never asks.
		const lead = await forkAgent(recovery, { ...as(WATCHER), role: "lead" });
		assert.equal(lead.agentId, FORKED);
	});
});

test("a Supervisor seat is never the product of a fork, whatever the disposition says", async () => {
	await withState(async ({ agentsRoot }) => {
		for (const provider of [
			"pi-supervisor/anthropic/claude-opus-5",
			"claude-supervisor/claude-opus-5",
			"claude-supervisor-audit/claude-opus-5",
			"pi-supervisor",
		]) {
			const calls = [];
			await assert.rejects(
				forkAgent(
					{
						agentId: SOURCE,
						reason: "change-model",
						// Not one of the words the disposition scan knows: it is free text.
						disposition: "governance seat",
						provider,
						labels: { "team.watch": "decisions" },
					},
					{
						role: "lead",
						agentsRoot,
						runPaseo: async (args) => {
							calls.push(args);
							return { id: FORKED };
						},
					},
				),
				(error) => {
					assert.equal(error.code, "FORK_ROLE_MUST_BE_INDEPENDENT", provider);
					assert.match(error.message, /create_agent/);
					return true;
				},
				provider,
			);
			assert.deepEqual(calls, [], `no import for ${provider}`);
		}
	});
});

console.log("team-fork tests passed");
