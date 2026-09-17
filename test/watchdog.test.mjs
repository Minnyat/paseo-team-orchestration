import assert from "node:assert/strict";
import { classifyLeases, classifyParkedSeats, classifyStaleAgents, DEFAULT_COMMAND_TIMEOUT_MS, DEFAULT_GLOBAL_DEADLINE_MS, DEFAULT_INSPECT_CONCURRENCY } from "../scripts/watchdog.mjs";

const now = Date.parse("2026-08-08T12:00:00.000Z");
const result = classifyStaleAgents(
  [
    { id: "old", status: "running", updatedAt: "2026-08-08T11:50:00.000Z", inspectOk: true },
    { id: "recent", status: "running", updatedAt: "2026-08-08T11:59:50.000Z", inspectOk: true },
    { id: "idle", status: "idle", updatedAt: "2026-08-08T10:00:00.000Z" },
    { id: "invalid", status: "running", updatedAt: "not-a-date", inspectOk: true },
    { id: "unreachable", status: "running", updatedAt: "2026-08-08T11:00:00.000Z", inspectOk: false },
  ],
  { now, staleAfterMs: 5 * 60_000 },
);
assert.deepEqual(result.map((agent) => agent.id), ["old", "recent", "invalid", "unreachable"]);
assert.equal(result.find((agent) => agent.id === "old").stale, true);
assert.equal(result.find((agent) => agent.id === "recent").stale, false);
assert.equal(result.find((agent) => agent.id === "invalid").confidence, "unknown");
assert.equal(result.find((agent) => agent.id === "invalid").stale, false);
assert.equal(result.find((agent) => agent.id === "unreachable").confidence, "unknown");
assert.equal(result.find((agent) => agent.id === "unreachable").stale, false);
assert.equal(DEFAULT_INSPECT_CONCURRENCY, 6);
assert.equal(DEFAULT_GLOBAL_DEADLINE_MS, 60_000);

// --- the per-command budget must outlive a real `paseo ls` -------------------
// This started as a 5s budget, which was fine until a daemon held a few hundred
// agents: `paseo ls -g --json` then takes ~6s, every attempt was killed, and the
// watchdog reported `partial: true` forever — permanently observation-only, so
// no stale agent was ever reclaimed. The failure was silent in exactly the wrong
// way: a watchdog that reports nothing looks the same as a healthy fleet.
// The budget is asserted here rather than left inline so it cannot drift back
// under the latency it exists to tolerate.
assert.equal(DEFAULT_COMMAND_TIMEOUT_MS, 20_000);
assert.ok(
	DEFAULT_COMMAND_TIMEOUT_MS >= 15_000,
	"per-command budget must leave room for a multi-hundred-agent `paseo ls`",
);
assert.ok(
	DEFAULT_GLOBAL_DEADLINE_MS >= DEFAULT_COMMAND_TIMEOUT_MS * 2,
	"the global deadline must fit a slow list AND the inspect fan-out after it",
);

{
	// The constant is worthless if the default never reaches the transport, so
	// assert the value the spawn actually receives, not merely the export.
	const seen = [];
	const snapshot = await (await import("../scripts/watchdog.mjs")).collectWatchdogSnapshot({
		globalDeadlineMs: DEFAULT_GLOBAL_DEADLINE_MS,
		maxAttempts: 1,
		leases: false,
		runPaseoJson: async (args, timeoutMs) => {
			seen.push({ command: args[0], timeoutMs });
			return args[0] === "ls"
				? [{ id: "agent-0", status: "running" }]
				: { Status: "running", UpdatedAt: "2026-08-08T11:00:00.000Z", PendingPermissions: [] };
		},
		now,
	});
	assert.equal(snapshot.partial, false);
	const ls = seen.find((call) => call.command === "ls");
	const inspect = seen.find((call) => call.command === "inspect");
	assert.ok(ls.timeoutMs > 5_000, "the list call no longer inherits the old 5s budget");
	assert.ok(inspect.timeoutMs > 5_000, "the inspect fan-out gets the same widened budget");
}

{
  let active = 0;
  let peak = 0;
  const result = await (await import("../scripts/watchdog.mjs")).collectWatchdogSnapshot({
    concurrency: 2,
    globalDeadlineMs: 2_000,
    commandTimeoutMs: 500,
    maxAttempts: 1,
    runPaseoJson: async (args) => {
      if (args[0] === "ls") {
        return Array.from({ length: 6 }, (_, index) => ({ id: `agent-${index}`, status: "running" }));
      }
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 25));
      active -= 1;
      return { Status: "running", UpdatedAt: "2026-08-08T11:00:00.000Z", PendingPermissions: [] };
    },
    now,
  });
  assert.equal(peak, 2, "watchdog inspect concurrency is bounded");
  assert.equal(result.agents.length, 6);
  assert.equal(result.partial, false);

  const capped = await (await import("../scripts/watchdog.mjs")).collectWatchdogSnapshot({
    maxAgents: 2,
    globalDeadlineMs: 2_000,
    commandTimeoutMs: 500,
    maxAttempts: 1,
    runPaseoJson: async (args) => args[0] === "ls"
      ? Array.from({ length: 3 }, (_, index) => ({ id: `agent-${index}`, status: "running" }))
      : { Status: "running", UpdatedAt: "2026-08-08T11:00:00.000Z", PendingPermissions: [] },
    now,
  });
  assert.equal(capped.agents.length, 2);
  assert.equal(capped.partial, true, "maxAgents cap is reported as partial");
}

// --- lease board: the second way a scope gets stuck --------------------------
// A held scope blocks every other Lead, so the two ways it goes wrong deserve an
// operator's attention: the holder disappeared, or the lease lapsed under a
// holder that is still running. Neither is something the watchdog may fix —
// reclaiming ground from a Lead that might be mid-write is exactly how a second
// writer appears.
{
	const now = 10_000_000;
	const ALIVE = "aaaaaaaa-1111-4111-8111-111111111111";
	const GONE = "bbbbbbbb-2222-4222-8222-222222222222";
	const leases = new Map([
		["src/ok", { agentId: ALIVE, scope: "src/ok", claimedAt: now - 1000, expiresAt: now + 1000 }],
		["src/orphan", { agentId: GONE, scope: "src/orphan", claimedAt: now - 1000, expiresAt: now + 1000 }],
		["src/lapsed", { agentId: ALIVE, scope: "src/lapsed", claimedAt: now - 5000, expiresAt: now - 1 }],
	]);
	const rows = classifyLeases(leases, [{ id: ALIVE }], { now });

	assert.equal(rows.length, 2, "a healthy lease is not reported — noise would train the operator to skim");
	const orphan = rows.find((row) => row.scope === "src/orphan");
	assert.equal(orphan.holderListed, false);
	assert.equal(orphan.expired, false);
	assert.match(orphan.suspicion, /not in the agent listing/);

	const lapsed = rows.find((row) => row.scope === "src/lapsed");
	assert.equal(lapsed.holderListed, true);
	assert.equal(lapsed.expired, true);
	assert.match(lapsed.suspicion, /refused/, "the Lead is told what will happen, not merely that it is late");

	// Nothing to report, and nothing to throw, when the board is empty or absent.
	assert.deepEqual(classifyLeases(new Map(), [{ id: ALIVE }], { now }), []);
	assert.deepEqual(classifyLeases(null, null, { now }), []);
}

// A seat on "default" is a seat that answers nothing: measured 2026-09-07,
// Paseo applies no provider defaultMode at create time, so a claude-* seat
// created without settings.modeId comes up parking every tool call. The gate
// stops new ones; this is how the running ones become visible.
{
	const rows = classifyParkedSeats([
		{ id: "a", provider: "claude-peer/claude-opus-5", mode: "default", inspectOk: true, pendingPermissions: [1, 2] },
		{ id: "b", provider: "claude-lead/claude-opus-5", mode: "auto", inspectOk: true, pendingPermissions: [] },
		{ id: "c", provider: "claude-peer/claude-opus-5", mode: "plan", inspectOk: true, pendingPermissions: [] },
		{ id: "d", provider: "claude-peer/claude-opus-5", mode: "bypassPermissions", inspectOk: true, pendingPermissions: [] },
		// pi declares no modes at all, so its "default" means nothing.
		{ id: "e", provider: "pi-peer/Minnyat/gpt-5.6-sol", mode: "default", inspectOk: true, pendingPermissions: [] },
		// An agent that could not be inspected is unknown, not parked.
		{ id: "f", provider: "claude-peer/claude-opus-5", mode: "default", inspectOk: false },
	]);
	assert.deepEqual(rows.map((row) => row.agentId), ["a", "d"]);
	assert.equal(rows[0].pendingPermissions, 2);
	assert.match(rows[0].suspicion, /Always Ask/);
	assert.match(rows[0].suspicion, /2 already queued/);
	assert.equal(rows[0].fix, "paseo agent mode a auto");
	// The fix is conditional on auto existing for that seat, and the row says so.
	assert.match(rows[0].fixNote, /Bedrock\/Vertex/);
	assert.match(rows[0].fixNote, /never "bypassPermissions"/);
	assert.match(rows[1].suspicion, /guardrails/);
	assert.deepEqual(classifyParkedSeats(null), []);
}

console.log("watchdog tests passed");
