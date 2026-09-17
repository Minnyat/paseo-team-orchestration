/**
 * agent-state.test.mjs — Paseo writes everything the team graph needs into
 * `$PASEO_HOME/agents/<cwd-slug>/<agent-id>.json`: labels (including the parent
 * link), the resolved model, and the provider session id + file. Reading that
 * is a filesystem operation, so it is fixture-testable end to end — unlike the
 * `paseo inspect` fan-out it replaces, which costs ~3s per agent.
 *
 * The whole point of this module is that a missing or malformed state file is
 * DATA, not a crash: the graph must still render and say what it could not read.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AGENT_DOMAIN_LABEL,
	AGENT_PARENT_LABEL,
	buildStateIndex,
	normalizeAgentState,
	readAgentStates,
} from "../cli/lib/agent-state.mjs";

const root = mkdtempSync(join(tmpdir(), "pst-agent-state-"));
const agentsRoot = join(root, "agents");

function writeState(slug, id, body) {
	const dir = join(agentsRoot, slug);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, `${id}.json`), typeof body === "string" ? body : JSON.stringify(body), "utf8");
}

const FULL = "11111111-1111-4111-8111-111111111111";
const NO_RUNTIME = "22222222-2222-4222-8222-222222222222";
const CORRUPT = "33333333-3333-4333-8333-333333333333";
const BARE = "44444444-4444-4444-8444-444444444444";
const DRIFT = "55555555-5555-4555-8555-555555555555";
const MISSING = "66666666-6666-4666-8666-666666666666";

writeState("C-Users-x-project", FULL, {
	id: FULL,
	provider: "pi-lead",
	cwd: "C:\\Users\\x\\project",
	workspaceId: "wks_abc",
	title: "lead one",
	labels: { "team.domain": "payments", [AGENT_PARENT_LABEL]: "99999999-9999-4999-8999-999999999999" },
	config: { model: "Minnyat/glm-5.2" },
	runtimeInfo: { provider: "pi-lead", sessionId: "01a04613-e0d1-7a62-b524-ef4fa9027fe6", model: "Minnyat/glm-5.2", thinkingOptionId: "off" },
	persistence: {
		sessionId: "01a04613-e0d1-7a62-b524-ef4fa9027fe6",
		nativeHandle: "C:\\Users\\x\\.pi\\agent\\sessions\\--C--Users-x-project--\\2026-01-01T00-00-00-000Z_01a04613-e0d1-7a62-b524-ef4fa9027fe6.jsonl",
		// Stale by design: Paseo does not rewrite this after update_agent, so it
		// must never be used as a model source (measured 2026-08-28).
		metadata: { model: "Minnyat/claude-opus-5" },
	},
});

// A4 — an agent that was created but has not started yet has no runtimeInfo.
writeState("C-Users-x-project", NO_RUNTIME, {
	id: NO_RUNTIME,
	provider: "pi-peer",
	cwd: "C:\\Users\\x\\project",
	labels: { "team.domain": "payments" },
	config: { model: "Minnyat/deepseek-v4-flash" },
});

writeState("C-Users-x-project", CORRUPT, "{ not json");

// A5 — no labels at all.
writeState("C-Users-x-other", BARE, { id: BARE, provider: "pi-supervisor", cwd: "C:\\Users\\x\\other" });

// A8 — runtimeInfo and config disagree (a model change that has not been
// picked up, or picked up only at runtime).
writeState("C-Users-x-other", DRIFT, {
	id: DRIFT,
	provider: "pi-lead",
	cwd: "C:\\Users\\x\\other",
	config: { model: "Minnyat/claude-opus-5" },
	runtimeInfo: { model: "Minnyat/glm-5.2", thinkingOptionId: "high", sessionId: "s-drift" },
});

// Non-JSON files and nested junk must not enter the index.
mkdirSync(join(agentsRoot, "C-Users-x-other", "nested"), { recursive: true });
writeFileSync(join(agentsRoot, "C-Users-x-other", "notes.txt"), "ignore me", "utf8");

// --- index -----------------------------------------------------------------
{
	const { index, degraded } = buildStateIndex(agentsRoot);
	assert.equal(degraded.length, 0, "a healthy tree reports no faults");
	assert.ok(index[FULL], "an agent is indexed by id, regardless of its cwd slug");
	assert.ok(index[BARE], "agents under a different cwd slug are indexed too");
	assert.equal(index["notes"], undefined, "non-JSON files never enter the index");
	assert.equal(Object.keys(index).length, 5, "one entry per state file, no duplicates");
}

// A6 — the root is an argument, so a throwaway PASEO_HOME works in tests and
// a non-default PASEO_HOME works in production.
//
// A machine where Paseo has never written agent state has no root at all. That
// is an ABSENT enrichment, not a fault: reporting it would put a line in
// degraded[] on every snapshot taken on a fresh host and teach the operator to
// ignore the list. Only a root that exists and resists reading is a fault.
{
	const { index, degraded } = buildStateIndex(join(root, "does-not-exist"));
	assert.deepEqual(index, {}, "a missing agents root is empty, not a throw");
	assert.deepEqual(degraded, [], "and absent is not degraded");
}
{
	// A file where the directory should be: the data is unreachable for a reason
	// the operator can act on, so say so.
	const notADir = join(root, "agents-is-a-file");
	writeFileSync(notADir, "not a directory", "utf8");
	const { index, degraded } = buildStateIndex(notADir);
	assert.deepEqual(index, {});
	assert.equal(degraded.length, 1);
	assert.equal(degraded[0].reason, "AGENT_STATE_ROOT_UNREADABLE");
}

// --- normalization ---------------------------------------------------------
// A1 — the full shape.
{
	const { states } = readAgentStates([FULL], { root: agentsRoot });
	const s = states[FULL];
	assert.equal(s.agentId, FULL);
	assert.equal(s.domain, "payments");
	assert.equal(s.parentAgentId, "99999999-9999-4999-8999-999999999999", "the parent link comes from a label, not from `paseo inspect`");
	assert.equal(s.model, "Minnyat/glm-5.2");
	assert.equal(s.modelSource, "runtime");
	assert.equal(s.modelDrift, false);
	assert.equal(s.thinking, "off");
	assert.equal(s.sessionId, "01a04613-e0d1-7a62-b524-ef4fa9027fe6");
	assert.match(s.sessionFile, /\.jsonl$/, "the session file is the pi JSONL path");
	assert.equal(s.workspaceId, "wks_abc");
	assert.equal(s.title, "lead one");
}

// A9 — persistence.metadata.model is stale and must never win.
{
	const { states } = readAgentStates([FULL], { root: agentsRoot });
	assert.notEqual(states[FULL].model, "Minnyat/claude-opus-5", "persistence.metadata.model is a creation-time snapshot, not the live model");
}

// A8 — runtimeInfo wins over config, and the disagreement is reported.
{
	const { states } = readAgentStates([DRIFT], { root: agentsRoot });
	assert.equal(states[DRIFT].model, "Minnyat/glm-5.2", "runtimeInfo is what the agent actually runs");
	assert.equal(states[DRIFT].modelSource, "runtime");
	assert.equal(states[DRIFT].modelDrift, true, "a config/runtime mismatch is surfaced, not hidden");
}

// A4 — no runtimeInfo yet: fall back to config, and do not call it an error.
{
	const { states, degraded } = readAgentStates([NO_RUNTIME], { root: agentsRoot });
	const s = states[NO_RUNTIME];
	assert.equal(s.sessionId, null, "an agent that never started has no session");
	assert.equal(s.sessionFile, null);
	assert.equal(s.model, "Minnyat/deepseek-v4-flash");
	assert.equal(s.modelSource, "config");
	assert.equal(s.modelDrift, false);
	assert.equal(degraded.length, 0, "a not-yet-started agent is normal, not a fault");
}

// A5 — no labels: the node still renders.
{
	const { states } = readAgentStates([BARE], { root: agentsRoot });
	assert.equal(states[BARE].domain, null);
	assert.equal(states[BARE].parentAgentId, null);
	assert.deepEqual(states[BARE].labels, {});
	assert.equal(states[BARE].model, null);
	assert.equal(states[BARE].modelSource, null);
}

// A3 — corrupt JSON is a fault about ONE agent, not about the snapshot.
{
	const { states, degraded } = readAgentStates([CORRUPT, FULL], { root: agentsRoot });
	assert.equal(states[CORRUPT], undefined);
	assert.ok(states[FULL], "one bad file must not take the healthy ones down with it");
	assert.equal(degraded.length, 1);
	assert.equal(degraded[0].agentId, CORRUPT);
	assert.equal(degraded[0].reason, "AGENT_STATE_UNREADABLE");
}

// A2 — an id with no state file at all.
{
	const { states, degraded } = readAgentStates([MISSING], { root: agentsRoot });
	assert.equal(states[MISSING], undefined);
	assert.equal(degraded.length, 1);
	assert.equal(degraded[0].agentId, MISSING);
	assert.equal(degraded[0].reason, "AGENT_STATE_MISSING");
}

// A7 — a hostile id must not reach outside the agents root.
{
	for (const bad of ["../../etc/passwd", "a/b", "..", "", null, 42]) {
		const { states, degraded } = readAgentStates([bad], { root: agentsRoot });
		assert.equal(Object.keys(states).length, 0, `'${bad}' must resolve to nothing`);
		assert.equal(degraded[0]?.reason, "AGENT_STATE_ID_INVALID", `'${bad}' is rejected before any path is built`);
	}
}

// normalizeAgentState is pure and must survive junk without throwing.
assert.equal(normalizeAgentState(null, "x"), null);
assert.equal(normalizeAgentState("nope", "x"), null);
assert.equal(normalizeAgentState({ labels: "not-an-object" }, FULL).labels && Object.keys(normalizeAgentState({ labels: "not-an-object" }, FULL).labels).length, 0);
assert.equal(AGENT_DOMAIN_LABEL, "team.domain");
assert.equal(AGENT_PARENT_LABEL, "paseo.parent-agent-id");

// The permission mode reads the same way the model does, and for a measured
// reason: on 2026-09-07 a seat that had been running on "auto" for half an hour
// still carried persistence.metadata.modeId "default" — the creation-time
// snapshot Paseo never rewrites. A verifier that trusted it would keep a fork
// parked in the permission queue while reporting it healthy.
{
	const stale = normalizeAgentState(
		{
			id: FULL,
			provider: "claude-peer/claude-opus-5",
			config: { modeId: "default" },
			runtimeInfo: { modeId: "auto" },
			persistence: { metadata: { modeId: "default" } },
		},
		FULL,
	);
	assert.equal(stale.mode, "auto");
	assert.equal(stale.modeSource, "runtime");
	assert.equal(stale.modeDrift, true, "created on default, moved onto auto — a real disagreement");

	const created = normalizeAgentState({ id: FULL, config: { modeId: "auto" } }, FULL);
	assert.equal(created.mode, "auto");
	assert.equal(created.modeSource, "config");
	assert.equal(created.modeDrift, false, "not started yet is not drift");

	const unknown = normalizeAgentState({ id: FULL, persistence: { metadata: { modeId: "auto" } } }, FULL);
	assert.equal(unknown.mode, null, "metadata is never a mode source");
	assert.equal(unknown.modeSource, null);
}

rmSync(root, { recursive: true, force: true });
console.log("agent-state.test.mjs OK");
