import assert from "node:assert/strict";
import {
  buildConsultBody,
  chooseSupervisor,
  CONSULT_KINDS,
  MESSAGE_KINDS,
  parentAgentIdFromInspect,
  PEER_MESSAGE_FIELD_NAMES,
  runPaseo,
  sendLeadConsult,
  sendPeerMessage,
  validateConsult,
  validatePeerMessage,
} from "../scripts/team-communication.mjs";
import * as core from "../extensions/paseo-team-core/policy-core.ts";
import { classifyRemoteFailure } from "../scripts/reliability.mjs";

// `report` is the completion channel. Without it the only way a Peer could
// push a finished report was to mislabel it `progress` — which is what the one
// Peer that ever did it actually had to do. A kind that names the thing is the
// difference between a channel a Peer can be told to use and a convention it
// has to invent.
assert.deepEqual([...MESSAGE_KINDS], ["question", "blocked", "dependency", "reopen", "progress", "report"]);

// `reopen` is a premise challenge, and it needs a kind of its own: sent as
// `blocked` or `question` it reads as routine friction and carries no
// obligation for the Lead to weigh the evidence. It goes through the same
// validation as every other kind, no extra envelope fields.
assert.equal(
  validatePeerMessage({ kind: "reopen", message: "The cache is invalidated on a different clock than the state it guards.", taskId: "T-9" }).kind,
  "reopen",
);

// The kind list exists in four places: policy-core (source of truth), this
// module, and one tool schema per runtime. A kind a Peer can send but cannot
// ASK for on one runtime is the drift that matters — it would make the pack's
// behaviour depend on which runtime happened to serve the seat.
{
	const { TEAM_TOOLS } = await import("../scripts/claude-team-mcp.mjs");
	const { readFileSync } = await import("node:fs");
	const { fileURLToPath } = await import("node:url");
	const { dirname, join } = await import("node:path");
	const root = join(dirname(fileURLToPath(import.meta.url)), "..");

	assert.deepEqual(
		[...MESSAGE_KINDS],
		[...core.PEER_MESSAGE_KINDS],
		"team-communication must not drift from the core list",
	);

	const claudeKinds =
		TEAM_TOOLS.find((tool) => tool.name === "peer_ask_lead").inputSchema.properties.kind.enum;
	assert.deepEqual([...claudeKinds], [...MESSAGE_KINDS], "the Claude tool schema must not drift");

	// The Pi schema lives inside the extension's default export, which needs a
	// live `pi` to reach, so it is pinned at the source level instead. A guard
	// that reads the actual bytes still catches the drift this is here for.
	const piSource = readFileSync(join(root, "extensions", "paseo-team-policy.ts"), "utf8");
	const piEnum = /kind: \{ type: "string", enum: \[([^\]]*)\] \}/.exec(piSource);
	assert.ok(piEnum, "the Pi peer_ask_lead schema must still declare a kind enum");
	assert.deepEqual(
		piEnum[1].split(",").map((entry) => entry.trim().replace(/"/g, "")),
		[...MESSAGE_KINDS],
		"the Pi tool schema must not drift",
	);
}
assert.deepEqual(
  validatePeerMessage({ kind: "report", message: "PEER_REPORT STATUS: done", taskId: "T-9" }).kind,
  "report",
);
assert.deepEqual(
  validatePeerMessage({ kind: "question", message: "Need clarification", taskId: "T-1", correlationId: "c-1" }),
  { kind: "question", message: "Need clarification", taskId: "T-1", correlationId: "c-1" },
);
assert.throws(() => validatePeerMessage({ kind: "broadcast", message: "x" }), /kind must be/);
assert.throws(() => validatePeerMessage({ kind: "blocked", message: "   " }), /non-empty/);
assert.throws(() => validatePeerMessage({ kind: "blocked", message: "x".repeat(12_001) }), /12000/);

// A body line that would be read back as a field with a DIFFERENT value gets
// the whole PEER_MESSAGE_V1 refused by the receiver, one round trip away from
// the Peer that could have reworded it. Refuse it here instead.
assert.throws(
  () => validatePeerMessage({ kind: "blocked", message: "TASK_ID: T-9\nsome context", taskId: "T-4" }),
  (error) => {
    assert.equal(error.code, "PEER_MESSAGE_FIELD_COLLISION");
    assert.match(error.message, /conflicting/);
    return true;
  },
);
// FROM_AGENT_ID is filled from Paseo, never from the Peer's text, so there is
// no body value that could legitimately agree with it.
assert.throws(
  () => validatePeerMessage({ kind: "report", message: "FROM_AGENT_ID: abc" }),
  (error) => {
    assert.equal(error.code, "PEER_MESSAGE_FIELD_COLLISION");
    return true;
  },
);
// A repetition that AGREES with the envelope is ordinary prose: the receiver
// now accepts it with a warning, so a sender that refused it would just move
// the same wasted round trip earlier.
assert.equal(
  validatePeerMessage({ kind: "report", message: "TASK_ID: T-4\ndone", taskId: "T-4" }).taskId,
  "T-4",
);
// Mentioning a field name mid-line was never a field and still is not.
assert.ok(validatePeerMessage({ kind: "blocked", message: "the TASK_ID was correct" }));
// The guard is only as good as its field list, so pin that list against the
// body sendPeerMessage actually writes rather than against a second hardcoded
// copy of it: a field added to the envelope and not to the list would otherwise
// go unguarded with every test still green.
{
  const previous = process.env.PASEO_AGENT_ID;
  process.env.PASEO_AGENT_ID = "peer-1";
  const sent = await sendPeerMessage(
    { kind: "report", message: "body text", taskId: "T-1", correlationId: "c-1" },
    {
      runPaseo: async (args) =>
        args[0] === "inspect"
          ? { ok: true, data: { ParentAgentId: "lead-1" } }
          : { ok: true, data: { body: args[args.indexOf("--prompt") + 1] } },
    },
  );
  const body = sent.response.body;
  const header = body.split(/\r?\n/).slice(1);
  const written = [];
  for (const line of header) {
    if (line.trim() === "") break;
    written.push(/^([A-Z][A-Z0-9_]*):/.exec(line)[1]);
  }
  assert.deepEqual(
    written,
    [...PEER_MESSAGE_FIELD_NAMES],
    "every field the envelope writes must be one the body guard checks",
  );
  // The sender refuses exactly what the receiver refuses. A sender stricter
  // than its receiver moves a wasted round trip earlier; a sender laxer than
  // its receiver lets one through to be refused at the far end — which is the
  // failure this whole change exists to remove.
  assert.deepEqual(
    [...PEER_MESSAGE_FIELD_NAMES].sort(),
    [...core.PEER_ENVELOPE_FIELDS].sort(),
    "sender guard and receiver parser must agree on which fields are the envelope",
  );
  if (previous === undefined) delete process.env.PASEO_AGENT_ID;
  else process.env.PASEO_AGENT_ID = previous;
}
for (const field of ["taskId", "correlationId"]) {
  assert.throws(
    () => validatePeerMessage({ kind: "question", message: "x", [field]: "bad\\nheader" }),
    new RegExp(`${field}.*token`),
  );
  assert.throws(
    () => validatePeerMessage({ kind: "question", message: "x", [field]: "x".repeat(257) }),
    new RegExp(`${field}.*token`),
  );
}

assert.equal(parentAgentIdFromInspect({ ParentAgentId: "lead-1" }), "lead-1");
assert.equal(parentAgentIdFromInspect({ parentAgentId: "lead-2" }), "lead-2");
assert.equal(parentAgentIdFromInspect({ labels: { "paseo.parent-agent-id": "lead-3" } }), "lead-3");
assert.equal(parentAgentIdFromInspect({ ParentAgentId: null }), null);

{
  const previousAgentId = process.env.PASEO_AGENT_ID;
  process.env.PASEO_AGENT_ID = "peer-1";
  const calls = [];
  await assert.rejects(
    sendPeerMessage(
      { kind: "blocked", message: "Lead needed", taskId: "T-1", correlationId: "c-1" },
      {
        maxAttempts: 3,
        baseMs: 0,
        runPaseo: async (args) => {
          calls.push(args);
          if (args[0] === "inspect") return { ok: true, data: { ParentAgentId: "lead-1" } };
          throw Object.assign(new Error("connection reset after delivery"), { code: "CLI_ERROR" });
        },
      },
    ),
    /connection reset after delivery/,
  );
  // self inspect, parent inspect (a read: is the Lead on this daemon?), one send.
  assert.deepEqual(calls.map((args) => args[0]), ["inspect", "inspect", "send"], "send mutation is never retried");
  if (previousAgentId === undefined) delete process.env.PASEO_AGENT_ID;
  else process.env.PASEO_AGENT_ID = previousAgentId;
}

// A Lead on another host (MCP create_agent with serverId): its id is not on
// this daemon. Refuse with PARENT_LEAD_REMOTE and NEVER attempt the send.
{
  const previousAgentId = process.env.PASEO_AGENT_ID;
  process.env.PASEO_AGENT_ID = "peer-1";
  const calls = [];
  await assert.rejects(
    sendPeerMessage(
      { kind: "question", message: "which file?", taskId: "T-9", correlationId: "c-9" },
      {
        maxAttempts: 1,
        baseMs: 0,
        runPaseo: async (args) => {
          calls.push(args);
          if (args[1] === "peer-1") return { ok: true, data: { ParentAgentId: "remote-lead" } };
          throw Object.assign(new Error("AGENT_NOT_FOUND: Agent not found: remote-lead"), { code: "CLI_ERROR", paseoCode: "AGENT_NOT_FOUND" });
        },
      },
    ),
    (error) => error.code === "PARENT_LEAD_REMOTE" && /FINAL reply/.test(error.message) && /c-9/.test(error.message),
  );
  assert.ok(!calls.some((args) => args[0] === "send"), "no send to a Lead that is not on this daemon");
  if (previousAgentId === undefined) delete process.env.PASEO_AGENT_ID;
  else process.env.PASEO_AGENT_ID = previousAgentId;
}

// A malformed PASEO_TEAM_PASEO_EXEC must fail before any spawn, with a code
// reliability.mjs treats as non-retryable — retrying a config fault only
// delays the operator seeing it.
{
  const previous = process.env.PASEO_TEAM_PASEO_EXEC;
  for (const [override, expected] of [
    ['""', /is set but empty/],
    ['"unclosed', /unterminated quote/],
  ]) {
    process.env.PASEO_TEAM_PASEO_EXEC = override;
    assert.throws(
      () => runPaseo(["inspect", "x"]),
      (error) => {
        assert.equal(error.code, "PASEO_EXEC_INVALID");
        assert.match(error.message, expected);
        assert.equal(classifyRemoteFailure(error), "non-retryable");
        return true;
      },
    );
  }
  if (previous === undefined) delete process.env.PASEO_TEAM_PASEO_EXEC;
  else process.env.PASEO_TEAM_PASEO_EXEC = previous;
}

// ---------------------------------------------------------------------------
// Lead -> Supervisor consult (PR-H)
//
// The routing is the interesting half. A Peer's recipient is a fact
// (ParentAgentId); a Lead's is a SEARCH, and the ways a search can come back
// wrong are the ways this channel silently degrades back into "ask the Human".
// ---------------------------------------------------------------------------

assert.deepEqual([...CONSULT_KINDS], ["decision", "question", "risk"]);
// The tool's kinds and the parser's must be the same set, or a Lead can ask for
// something the receiving runtime files as malformed.
assert.deepEqual([...CONSULT_KINDS].sort(), [...core.LEAD_CONSULT_KINDS].sort());

const CONSULT = {
  kind: "decision",
  question: "Retry the token refresh, or fail the step?",
  options: "a) retry once with backoff\nb) fail and report",
  evidence: "the run failed once with ECONNRESET; a manual rerun passed",
  scope: "src/auth/token.ts",
  reversibility: "reversible",
  taskId: "T-9",
};

{
  const valid = validateConsult(CONSULT, core.LEAD_CONSULT_FIELD_NAMES);
  assert.equal(valid.scope, "src/auth/token.ts");
  assert.match(valid.correlationId, /^consult-/);
  assert.equal(valid.text.RECOMMENDATION, undefined, "recommendation stays optional");

  // Every field a delegation criterion is checked against is required at the
  // SENDER, so an unanswerable consult never costs a round trip.
  for (const field of ["question", "options", "evidence", "scope"]) {
    assert.throws(
      () => validateConsult({ ...CONSULT, [field]: "  " }, core.LEAD_CONSULT_FIELD_NAMES),
      new RegExp(field),
    );
  }
  assert.throws(() => validateConsult({ ...CONSULT, kind: "escalation" }, core.LEAD_CONSULT_FIELD_NAMES), /kind must be/);
  assert.throws(() => validateConsult({ ...CONSULT, reversibility: "maybe" }, core.LEAD_CONSULT_FIELD_NAMES), /reversibility must be/);

  // A pasted log line that happens to be a real field name would come back as a
  // duplicate field and get the whole consult refused as malformed — one round
  // trip away from the text the Lead could have fixed. So it is refused here.
  assert.throws(
    () => validateConsult({ ...CONSULT, evidence: "SCOPE: src/other.ts" }, core.LEAD_CONSULT_FIELD_NAMES),
    /reads as a field/,
  );
  // An unknown ALLCAPS line is ordinary prose and must pass.
  assert.ok(validateConsult({ ...CONSULT, evidence: "ERROR: connection reset" }, core.LEAD_CONSULT_FIELD_NAMES));
}

// The envelope this sender writes must be the envelope the receiving runtime
// parses. Both halves are pinned here because they live in different languages
// and different processes.
{
  const valid = validateConsult(CONSULT, core.LEAD_CONSULT_FIELD_NAMES);
  const body = buildConsultBody(valid, {
    self: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    domain: "backend.auth",
    header: core.LEAD_CONSULT_HEADER,
  });
  const parsed = core.parseLeadConsultBlock(body);
  assert.ok(parsed, "the core must be able to parse what this script writes");
  assert.deepEqual(parsed.malformed, [], parsed.malformed.join("; "));
  assert.equal(parsed.kind, "decision");
  assert.equal(parsed.domain, "backend.auth");
  assert.equal(parsed.fields.get("SCOPE"), "src/auth/token.ts");
  assert.match(parsed.fields.get("OPTIONS"), /fail and report/);
}

// --- recipient resolution -----------------------------------------------------
{
  const seat = (agentId, domain = null) => ({ agentId, domain, cluster: "shop" });

  assert.equal(
    chooseSupervisor({ seats: [seat("s1")], topology: "single", leadDomain: null, domainCovers: core.domainCovers }).agentId,
    "s1",
  );

  // Zero is the ONLY case where asking the Human is correct, so it is named and
  // it carries the call that fixes it.
  assert.throws(
    () => chooseSupervisor({ seats: [], topology: "single", leadDomain: null, domainCovers: core.domainCovers }),
    (error) => {
      assert.equal(error.code, "NO_SUPERVISOR_SEAT");
      assert.match(error.message, /create_agent/);
      assert.match(error.message, /purpose/);
      return true;
    },
  );

  // Two claimants is a governance question the sender must not settle: the
  // Lead's own runtime refuses BOTH in that situation, so a guessed answer
  // would be thrown away on arrival.
  assert.throws(
    () => chooseSupervisor({ seats: [seat("s1"), seat("s2")], topology: "single", leadDomain: null, domainCovers: core.domainCovers }),
    (error) => {
      assert.equal(error.code, "SUPERVISOR_AMBIGUOUS");
      assert.match(error.message, /s1/);
      assert.match(error.message, /s2/);
      return true;
    },
  );

  // Under multi the candidates are narrowed by jurisdiction: a Supervisor that
  // could not issue a binding decision here is not an address.
  const seats = [seat("s-backend", "backend"), seat("s-frontend", "frontend")];
  assert.equal(
    chooseSupervisor({ seats, topology: "multi", leadDomain: "backend.auth", domainCovers: core.domainCovers }).agentId,
    "s-backend",
  );
  assert.throws(
    () => chooseSupervisor({ seats, topology: "multi", leadDomain: "payments", domainCovers: core.domainCovers }),
    (error) => {
      assert.equal(error.code, "NO_SUPERVISOR_SEAT");
      // "there are seats, none of them governs you" is a different fix from
      // "there are no seats", and the message must not conflate them.
      assert.match(error.message, /none carries a team\.domain/);
      return true;
    },
  );

  // An explicitly named seat still has to be eligible.
  assert.equal(
    chooseSupervisor({ seats, topology: "multi", leadDomain: "backend.auth", domainCovers: core.domainCovers, requested: "s-backend" }).agentId,
    "s-backend",
  );
  assert.throws(
    () => chooseSupervisor({ seats, topology: "multi", leadDomain: "backend.auth", domainCovers: core.domainCovers, requested: "s-frontend" }),
    (error) => {
      assert.equal(error.code, "SUPERVISOR_NOT_ELIGIBLE");
      return true;
    },
  );
}

// --- a long job has watch seats, and only a seat that decides is ever asked ---
{
  const decides = core.seatDecides;
  const seat = (agentId, domain = null, watch = null) => ({
    agentId,
    domain,
    cluster: "shop",
    watch: core.parseWatch(watch),
  });
  const choose = (extra) =>
    chooseSupervisor({ topology: "single", leadDomain: null, domainCovers: core.domainCovers, seatDecides: decides, ...extra });

  // The point of the feature: observers beside the deciding seat are NOT the
  // ambiguity that two Supervisors used to be.
  const crowd = [seat("watch-1", null, "liveness,cost"), seat("decider", null, "decisions,process"), seat("watch-2", null, "evidence")];
  assert.equal(choose({ seats: crowd }).agentId, "decider");
  // A seat with no label is the seat the pack has always had, and it decides.
  assert.equal(choose({ seats: [seat("watch-1", null, "liveness"), seat("solo")] }).agentId, "solo");

  // Two that DECIDE are still the ambiguity, and only they are named.
  assert.throws(
    () => choose({ seats: [...crowd, seat("second")] }),
    (error) => {
      assert.equal(error.code, "SUPERVISOR_AMBIGUOUS");
      assert.match(error.message, /decider/);
      assert.match(error.message, /second/);
      assert.ok(!/watch-1/.test(error.message), "an observer is not a claimant");
      return true;
    },
  );

  // Only observers: the cluster has no delegated decision path, and says so
  // in words that name the fix rather than "no Supervisor".
  assert.throws(
    () => choose({ seats: [seat("watch-1", null, "liveness"), seat("watch-2", null, "cost")] }),
    (error) => {
      assert.equal(error.code, "NO_SUPERVISOR_SEAT");
      assert.match(error.message, /every one is a watch seat/);
      assert.match(error.message, /decisions/);
      return true;
    },
  );

  // Naming an observer is not a way around it.
  assert.throws(
    () => choose({ seats: crowd, requested: "watch-1" }),
    (error) => {
      assert.equal(error.code, "SUPERVISOR_NOT_ELIGIBLE");
      assert.match(error.message, /watch seat \(team\.watch: liveness, cost\)/);
      assert.match(error.message, /decider/, "and points at the seat that can answer");
      return true;
    },
  );
  assert.equal(choose({ seats: crowd, requested: "decider" }).agentId, "decider");

  // An unreadable label decides nothing, so it is not an address either.
  assert.throws(
    () => choose({ seats: [seat("broken", null, "liveness,vibes")] }),
    (error) => error.code === "NO_SUPERVISOR_SEAT",
  );

  // Under multi the jurisdiction narrows the DECIDING seats only.
  const multi = [seat("w", "backend", "liveness"), seat("d-backend", "backend", "decisions"), seat("d-front", "frontend")];
  assert.equal(choose({ seats: multi, topology: "multi", leadDomain: "backend.auth" }).agentId, "d-backend");
  assert.throws(
    () => choose({ seats: [seat("w", "payments", "liveness"), seat("d", "frontend")], topology: "multi", leadDomain: "payments" }),
    (error) => {
      assert.equal(error.code, "NO_SUPERVISOR_SEAT");
      assert.match(error.message, /1 Supervisor seat\(s\) that decide, but none carries a team\.domain/);
      return true;
    },
  );

  // Without the injected rule every seat is a candidate, exactly as before
  // the watch existed — the old call sites in this file rely on it.
  assert.throws(
    () =>
      chooseSupervisor({ seats: crowd, topology: "single", leadDomain: null, domainCovers: core.domainCovers }),
    (error) => error.code === "SUPERVISOR_AMBIGUOUS",
  );
}

// --- end to end: the consult goes to the deciding seat, with the REAL core ----
{
  const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const home = mkdtempSync(join(tmpdir(), "pteam-consult-watch-"));
  try {
    const dir = join(home, "agents", "D--Code-shop");
    mkdirSync(dir, { recursive: true });
    const ids = {
      lead: "11111111-1111-4111-8111-111111111111",
      decider: "22222222-2222-4222-8222-222222222222",
      liveness: "33333333-3333-4333-8333-333333333333",
      process: "44444444-4444-4444-8444-444444444444",
    };
    const write = (id, provider, labels) =>
      writeFileSync(join(dir, `${id}.json`), JSON.stringify({ id, provider, labels: { "team.cluster": "shop", ...labels } }));
    write(ids.lead, "pi-lead/anthropic/model", {});
    write(ids.liveness, "pi-supervisor/Mx/cheap", { "team.watch": "liveness,cost" });
    write(ids.decider, "pi-supervisor/anthropic/model", { "team.watch": "decisions" });
    write(ids.process, "pi-supervisor/anthropic/model", { "team.watch": "process,evidence" });

    const env = { PASEO_AGENT_ID: ids.lead, PASEO_HOME: home, PASEO_TEAM_CLUSTER: "shop" };
    const calls = [];
    const send = (extra = {}) =>
      sendLeadConsult(
        { ...CONSULT, ...extra },
        { env, runPaseo: async (args) => (calls.push(args), { ok: true, data: { queued: true } }) },
      );

    const result = await send();
    assert.equal(result.recipient, ids.decider, "three Supervisors, one of them decides: no SUPERVISOR_AMBIGUOUS");
    assert.equal(calls[0][1], ids.decider);

await assert.rejects(send({ supervisorAgentId: ids.liveness }), (error) => error.code === "SUPERVISOR_NOT_ELIGIBLE");
assert.equal(calls.length, 1, "a refused consult sends nothing");

// Paseo archives by soft delete: the record of a replaced Supervisor stays on
// disk with archivedAt set. It is not a seat, so it is not a claimant either.
const archived = "55555555-5555-4555-8555-555555555555";
writeFileSync(
  join(dir, `${archived}.json`),
  JSON.stringify({
    id: archived,
    provider: "pi-supervisor/anthropic/model",
    archivedAt: "2026-10-06T10:00:00.000Z",
    labels: { "team.cluster": "shop", "team.watch": "decisions" },
  }),
);
assert.equal((await send()).recipient, ids.decider, "an archived deciding seat does not make the consult ambiguous");

// One torn record elsewhere does not stop a consult whose seat WAS found: it is
// routed to as it always was, so a broken file in another project cannot take
// consulting away from every Lead on the host.
const corrupt = "66666666-6666-4666-8666-666666666666";
writeFileSync(join(dir, `${corrupt}.json`), '{"id": "66666666-6666-4666-8666-666666666666", "provider": "pi-super');
assert.equal((await send()).recipient, ids.decider, "a seat that was found is routed to despite an unrelated torn record");

// Naming a seat the list does not hold is "not eligible" only when the list was
// complete: the record the scan could not read may be the very seat that was
// named. A seat that WAS found and is not eligible keeps the precise answer.
await assert.rejects(send({ supervisorAgentId: corrupt }), (error) => {
  assert.equal(error.code, "SUPERVISOR_LOOKUP_FAILED");
  assert.ok(error.message.includes(corrupt), "it names the record");
  return true;
});
await assert.rejects(send({ supervisorAgentId: ids.liveness }), (error) => error.code === "SUPERVISOR_NOT_ELIGIBLE");

// "Nobody" is the one answer a scan that could not read everything cannot give:
// the record it missed may be the seat being asked about. Without a seat to
// route to, a torn record is LOOKUP_FAILED — and with a clean scan the same
// consult is the honest NO_SUPERVISOR_SEAT.
const lonely = (withTornRecord) => {
  const alone = join(home, withTornRecord ? "alone-torn" : "alone-clean");
  const aloneDir = join(alone, "agents", "D--Code-shop");
  mkdirSync(aloneDir, { recursive: true });
  writeFileSync(
    join(aloneDir, `${ids.lead}.json`),
    JSON.stringify({ id: ids.lead, provider: "pi-lead/anthropic/model", labels: { "team.cluster": "shop" } }),
  );
  if (withTornRecord) writeFileSync(join(aloneDir, `${corrupt}.json`), '{"id": "66666666-6666');
  return sendLeadConsult(CONSULT, {
    env: { PASEO_AGENT_ID: ids.lead, PASEO_HOME: alone, PASEO_TEAM_CLUSTER: "shop" },
    runPaseo: async (args) => (calls.push(args), { ok: true, data: {} }),
  });
};
const callsBefore = calls.length;
await assert.rejects(lonely(false), (error) => error.code === "NO_SUPERVISOR_SEAT");
await assert.rejects(lonely(true), (error) => {
  assert.equal(error.code, "SUPERVISOR_LOOKUP_FAILED");
  assert.match(error.message, /AGENT_STATE_UNREADABLE/);
  assert.ok(error.message.includes(corrupt), "it names the record");
  return true;
});
assert.equal(calls.length, callsBefore, "and neither sends anything");

// The root itself unreadable is the same answer, not NO_SUPERVISOR_SEAT (which
// tells a Lead it may put the question to the Human).
const blocked = join(home, "blocked");
mkdirSync(blocked, { recursive: true });
writeFileSync(join(blocked, "agents"), "not a directory");
await assert.rejects(
  sendLeadConsult(CONSULT, {
    env: { PASEO_AGENT_ID: ids.lead, PASEO_HOME: blocked, PASEO_TEAM_CLUSTER: "shop" },
    runPaseo: async () => ({ ok: true, data: {} }),
  }),
  (error) => error.code === "SUPERVISOR_LOOKUP_FAILED",
);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

// --- end to end, with the core stubbed ----------------------------------------
{
  const stub = {
    ...core,
    supervisorSeats: () => [{ agentId: "sup-1", domain: "backend", cluster: "shop" }],
    selfCluster: () => "shop",
    teamTopology: () => "single",
  };
  const calls = [];
  const result = await sendLeadConsult(CONSULT, {
    core: stub,
    env: { PASEO_AGENT_ID: "lead-1" },
    runPaseo: async (args) => {
      calls.push(args);
      return { ok: true, data: { queued: true } };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.recipient, "sup-1");
  assert.match(result.awaiting, /SUPERVISOR_DECISION/);
  assert.deepEqual(calls.map((args) => args[0]), ["send"], "one send, never a retry");
  assert.equal(calls[0][1], "sup-1");
  assert.match(calls[0][3], new RegExp(`^${core.LEAD_CONSULT_HEADER}`, "m"));
  assert.match(calls[0][3], /FROM_AGENT_ID: lead-1/);
  assert.ok(calls[0].includes("--no-wait"));

  // "I could not look" must never be reported as "there is nobody" — that is
  // the difference between a Lead that retries and a Lead that asks the Human.
  await assert.rejects(
    sendLeadConsult(CONSULT, {
      core: { ...stub, supervisorSeats: () => { throw new Error("state unreadable"); } },
      env: { PASEO_AGENT_ID: "lead-1" },
      runPaseo: async () => ({ ok: true, data: {} }),
    }),
    (error) => {
      assert.equal(error.code, "SUPERVISOR_LOOKUP_FAILED");
      return true;
    },
  );

  await assert.rejects(
    sendLeadConsult(CONSULT, { core: stub, env: {}, runPaseo: async () => ({ ok: true, data: {} }) }),
    (error) => {
      assert.equal(error.code, "AGENT_ID_MISSING");
      return true;
    },
  );
}

console.log("team communication tests passed");
