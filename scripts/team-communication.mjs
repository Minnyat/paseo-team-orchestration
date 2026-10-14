#!/usr/bin/env node
// Reliable, parent-scoped Peer -> Lead communication, and the Lead -> Supervisor
// consult that keeps a Lead's own question off the Human's desk (PR-H).
//
// The two directions share this file because they share the one thing that is
// hard about either: delivery. Both resolve a recipient from Paseo's own state
// rather than from the sender's belief, both wrap the payload in a versioned
// envelope so the receiving runtime can judge it, and both send with
// `--no-wait` and never retry, because `paseo send` has delivery ambiguity and
// no idempotency contract.
//
// What differs is how the recipient is found, and that difference is the whole
// design. A Peer has exactly one legitimate recipient — its parent — so
// `ParentAgentId` IS the routing table. A Lead has no parent; its Supervisor is
// a sibling seat found by role and cluster. That search can come back empty,
// and an empty answer is the interesting one: a cluster with no Supervisor is
// the only case where asking the Human is the correct behaviour, so it gets a
// named code (NO_SUPERVISOR_SEAT) carrying the exact call that fixes it,
// instead of a silent fallback the Lead cannot explain.
import { execFileSync } from "node:child_process";
import { importPolicyCore, isEntrypoint, resolvePaseoExec } from "./lib-common.mjs";
import { retryWithBackoff } from "./reliability.mjs";

// Mirrors policy-core's PEER_MESSAGE_KINDS, which is the source of truth; the
// two runtimes' tool schemas are the other two copies. This file is plain .mjs
// and cannot import the .ts core at module scope, so the list is duplicated and
// team-communication.test.mjs asserts all four never drift.
export const MESSAGE_KINDS = Object.freeze(["question", "blocked", "dependency", "reopen", "progress", "report"]);
const METADATA_TOKEN = /^[A-Za-z0-9._:-]{1,256}$/;

function metadataToken(name, value) {
  if (typeof value !== "string" || !METADATA_TOKEN.test(value)) {
    throw new Error(`${name} must be a single-line token matching [A-Za-z0-9._:-] (max 256 characters)`);
  }
  return value;
}

/**
 * The envelope's own field names, in the order sendPeerMessage() writes them.
 * policy-core.ts exports no equivalent constant for the peer envelope (its
 * parser is an allowlist-free `[A-Z][A-Z0-9_]*:` scan), so this is the one copy,
 * and it is the list the body guard below iterates — not a parallel description
 * of it. team-communication.test.mjs pins it against the body sendPeerMessage
 * actually writes, so adding a field to the envelope without adding it here
 * fails the suite rather than silently leaving that field unguarded.
 */
export const PEER_MESSAGE_FIELD_NAMES = Object.freeze([
  "KIND",
  "CORRELATION_ID",
  "TASK_ID",
  "FROM_AGENT_ID",
]);

/**
 * A body line the receiver would read back as a field with a DIFFERENT value.
 *
 * The receiver (policy-core `parsePeerBlock`) accepts a repetition that agrees
 * with the header and only refuses one that disagrees, so this guard is shaped
 * to match it exactly: `TASK_ID: T-4` inside a report whose header already says
 * `T-4` is ordinary prose and passes; `TASK_ID: T-9` in the same report is
 * refused HERE, one line away from the Peer that can reword it, instead of at
 * the receiver a full round trip later. `FROM_AGENT_ID` has no legitimate body
 * form at all — the sender fills it from Paseo, never from the Peer's text — so
 * any body line spelling it is a conflict by construction.
 *
 * Deliberately narrower than the consult channel's `assertNoFieldLines`, which
 * refuses a field-shaped line on NAME alone. There, the receiver refuses the
 * same way; here it no longer does, and a sender stricter than its receiver
 * would just move the same wasted round trip earlier.
 */
function assertNoConflictingFieldLines(name, value, known) {
  // Driven by the exported field list, so a field added to the envelope and to
  // that list but NOT to `known` resolves to undefined -> null -> "no body form
  // is legitimate". Fail-closed on the author's omission, not silently
  // unguarded. `Object.hasOwn` rather than `in`: a plain object literal also
  // answers `in` for inherited names.
  const guarded = new Map(
    PEER_MESSAGE_FIELD_NAMES.map((field) => [
      field,
      Object.hasOwn(known, field) ? known[field] : null,
    ]),
  );
  for (const line of value.split(/\r?\n/)) {
    const match = /^([A-Z][A-Z0-9_]*):\s*(.*)$/.exec(line.trim());
    if (!match) continue;
    const [, field, body] = match;
    if (!guarded.has(field)) continue;
    const envelope = guarded.get(field);
    if (envelope !== null && body.trim() === envelope) continue;
    throw Object.assign(
      new Error(
        envelope === null
          ? `${name} contains a line starting with "${field}:", which the peer-message parser reads as a field. That field is filled in from Paseo, never from your text — reword it or quote it, e.g. "> ${field}: ...".`
          : `${name} contains a line "${field}: ${body.trim()}", which the peer-message parser reads as a field conflicting with the envelope's "${field}: ${envelope}". Reword it or quote it, e.g. "> ${field}: ...".`,
      ),
      { code: "PEER_MESSAGE_FIELD_COLLISION" },
    );
  }
}

export function validatePeerMessage(input) {
  if (!input || typeof input !== "object") throw new Error("message must be an object");
  const { kind, message, taskId, correlationId } = input;
  if (!MESSAGE_KINDS.includes(kind)) throw new Error(`kind must be one of: ${MESSAGE_KINDS.join(", ")}`);
  if (typeof message !== "string" || message.trim().length === 0) throw new Error("message must be non-empty");
  if (message.length > 12_000) throw new Error("message exceeds 12000 characters");
  const resolved = {
    kind,
    message: message.trim(),
    taskId: taskId === undefined ? "unknown" : metadataToken("taskId", taskId),
    correlationId: correlationId === undefined
      ? `peer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      : metadataToken("correlationId", correlationId),
  };
  assertNoConflictingFieldLines("message", resolved.message, {
    KIND: resolved.kind,
    TASK_ID: resolved.taskId,
    CORRELATION_ID: resolved.correlationId,
    // null = "no body form of this field is ever legitimate".
    FROM_AGENT_ID: null,
  });
  return resolved;
}

export function runPaseo(args, timeoutMs = 20_000) {
  // A malformed PASEO_TEAM_PASEO_EXEC is a configuration fault, not a transport
  // fault: give it its own code so reliability.mjs never retries it and the
  // operator sees the real cause instead of a generic send failure.
  const [bin, ...prefix] = resolvePaseoExec((reason) => {
    throw Object.assign(new Error(`PASEO_TEAM_PASEO_EXEC ${reason}`), {
      code: "PASEO_EXEC_INVALID",
    });
  });
  try {
    return { ok: true, data: JSON.parse(execFileSync(bin, [...prefix, ...args, "--json"], {
      encoding: "utf8", timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"], env: process.env, windowsHide: true,
    })) };
  } catch (error) {
    const text = `${error?.stderr ?? ""}\n${error?.stdout ?? ""}\n${error?.message ?? error}`;
    const wrapped = Object.assign(new Error(text.split("\n")[0]), { code: "CLI_ERROR" });
    throw wrapped;
  }
}

export function parentAgentIdFromInspect(snapshot) {
  const parent = snapshot?.ParentAgentId ?? snapshot?.parentAgentId ?? snapshot?.labels?.["paseo.parent-agent-id"];
  return typeof parent === "string" && parent.trim() ? parent.trim() : null;
}

export async function sendPeerMessage(input, options = {}) {
  const message = validatePeerMessage(input);
  const rawSelf = process.env.PASEO_AGENT_ID?.trim();
  if (!rawSelf) throw Object.assign(new Error("PASEO_AGENT_ID is missing"), { code: "AGENT_ID_MISSING" });
  const self = metadataToken("fromAgentId", rawSelf);
  const paseo = options.runPaseo ?? runPaseo;
  const inspected = await retryWithBackoff(() => paseo(["inspect", self]), {
    maxAttempts: options.maxAttempts ?? 3, baseMs: options.baseMs ?? 250, jitter: 0,
  });
  const rawParent = parentAgentIdFromInspect(inspected.data);
  if (!rawParent) throw Object.assign(new Error("Paseo did not expose a parent Lead for this Peer"), { code: "PARENT_LEAD_UNAVAILABLE" });
  const parent = metadataToken("parentAgentId", rawParent);
  const body = [
    "PEER_MESSAGE_V1",
    `KIND: ${message.kind}`,
    `CORRELATION_ID: ${message.correlationId}`,
    `TASK_ID: ${message.taskId}`,
    `FROM_AGENT_ID: ${self}`,
    "",
    message.message,
  ].join("\n");
  // `send` is a mutation with delivery ambiguity: the daemon may accept it
  // before the response is lost. Never retry without a Paseo idempotency/ACK
  // contract; correlationId is for Lead-side deduplication, not transport.
  const sent = await paseo(["send", parent, "--prompt", body, "--no-wait"], options.sendTimeoutMs ?? 20_000);
  return { ok: true, recipient: parent, correlationId: message.correlationId, response: sent.data };
}

export const CONSULT_KINDS = Object.freeze(["decision", "question", "risk"]);
export const REVERSIBILITY_VALUES = Object.freeze(["reversible", "irreversible"]);

/** Free-text sections of the envelope, in the order they are written. */
const CONSULT_SECTIONS = Object.freeze([
  ["question", "QUESTION"],
  ["options", "OPTIONS"],
  ["evidence", "EVIDENCE"],
  ["recommendation", "RECOMMENDATION"],
]);

/**
 * A body line that would be read back as a field.
 *
 * The parser's allowlist already makes an unknown `WORD:` line prose, so this
 * only fires on the dozen names that ARE fields. Refusing here rather than at
 * the receiver is deliberate: a stray `SCOPE:` inside pasted evidence would
 * otherwise become a duplicate field, the consult would be refused as
 * malformed, and the Lead would learn about it one round trip away from the
 * text it could actually fix.
 */
function assertNoFieldLines(name, value, fieldNames) {
  const known = new Set(fieldNames);
  for (const line of value.split(/\r?\n/)) {
    const match = /^([A-Z][A-Z0-9_]*):/.exec(line.trim());
    if (match && known.has(match[1])) {
      throw Object.assign(
        new Error(
          `${name} contains a line starting with "${match[1]}:", which the consult parser reads as a field. Reword it or quote it, e.g. "> ${match[1]}: ...".`,
        ),
        { code: "CONSULT_FIELD_COLLISION" },
      );
    }
  }
}

export function validateConsult(input, fieldNames) {
  if (!input || typeof input !== "object") throw new Error("consult must be an object");
  const { kind, scope, reversibility, taskId, projectId, correlationId, supervisorAgentId } = input;
  if (!CONSULT_KINDS.includes(kind)) throw new Error(`kind must be one of: ${CONSULT_KINDS.join(", ")}`);
  if (!REVERSIBILITY_VALUES.includes(reversibility)) {
    throw new Error(`reversibility must be one of: ${REVERSIBILITY_VALUES.join(", ")}`);
  }
  const text = {};
  for (const [key, field] of CONSULT_SECTIONS) {
    const raw = input[key];
    // RECOMMENDATION is the one optional section: a Lead with no preference
    // between two equivalent options is asking an honest question, and forcing
    // it to invent a lean would bias the answer it came for.
    const required = key !== "recommendation";
    if (raw === undefined || raw === null || String(raw).trim() === "") {
      if (required) {
        throw new Error(`${key} is required — the Supervisor checks the delegation criteria against it`);
      }
      continue;
    }
    const value = String(raw).trim();
    if (value.length > 6000) throw new Error(`${key} exceeds 6000 characters`);
    assertNoFieldLines(key, value, fieldNames);
    text[field] = value;
  }
  const scopeText = typeof scope === "string" ? scope.trim() : "";
  if (scopeText === "") {
    throw new Error("scope is required — 'small scope' is the first delegation criterion and cannot be inferred");
  }
  if (scopeText.length > 512) throw new Error("scope exceeds 512 characters");
  assertNoFieldLines("scope", scopeText, fieldNames);
  return {
    kind,
    reversibility,
    scope: scopeText,
    text,
    taskId: taskId === undefined ? "unknown" : metadataToken("taskId", taskId),
    projectId: projectId === undefined ? null : metadataToken("projectId", projectId),
    supervisorAgentId:
      supervisorAgentId === undefined ? null : metadataToken("supervisorAgentId", supervisorAgentId),
    correlationId: correlationId === undefined
      ? `consult-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      : metadataToken("correlationId", correlationId),
  };
}

/**
 * Which Supervisor seat this consult belongs to.
 *
 * Cluster first, always: `supervisorSeats` is already cluster-scoped, so a
 * Supervisor in another project on the same host is never a candidate. Under
 * `multi` the survivors are narrowed to seats whose domain actually covers this
 * Lead — a Supervisor that could not issue a binding decision here is not an
 * address, it is a detour.
 *
 * Only a seat that DECIDES is ever a candidate. A watch seat (`team.watch`
 * without `decisions`) observes: a consult sent to one would come back refused
 * (LEAD_CONSULT_NOT_DECIDING), so listing it would turn "several Supervisors on
 * a long job" into SUPERVISOR_AMBIGUOUS for every question. `seatDecides` is
 * injected from the core, which owns the rule; without it every seat is a
 * candidate, exactly as before the watch existed.
 *
 * Both failure directions are named rather than guessed. Zero seats is the one
 * case that legitimises asking the Human, and it says so. More than one is a
 * governance question — which of them speaks for me? — that a sender must not
 * settle by picking the first, because the Lead's own runtime refuses BOTH
 * claimants in that situation (JURISDICTION_OVERLAP) and the answer would be
 * thrown away on arrival.
 */
export function chooseSupervisor({ seats, topology, leadDomain, domainCovers, requested, seatDecides }) {
  const deciding = seatDecides ? seats.filter((seat) => seatDecides(seat.watch)) : seats;
  const candidates = topology === "multi"
    ? deciding.filter((seat) => seat.domain && leadDomain && domainCovers(seat.domain, leadDomain))
    : deciding;
  if (requested) {
    const match = candidates.find((seat) => seat.agentId === requested);
    if (match) return match;
    const asked = seats.find((seat) => seat.agentId === requested);
    if (seatDecides && asked && !seatDecides(asked.watch)) {
      throw Object.assign(
        new Error(
          `SUPERVISOR_NOT_ELIGIBLE: ${requested} is a watch seat (team.watch: ${asked.watch?.concerns?.join(", ") || "unreadable"}); it observes and cannot decide. Consult the seat that holds "decisions"${
            candidates.length ? ` (${candidates.map((seat) => seat.agentId).join(", ")})` : ""
          }.`,
        ),
        { code: "SUPERVISOR_NOT_ELIGIBLE" },
      );
    }
    const known = candidates.length
      ? ` (eligible: ${candidates.map((seat) => seat.agentId).join(", ")})`
      : " (this cluster has none)";
    throw Object.assign(
      new Error(`SUPERVISOR_NOT_ELIGIBLE: ${requested} is not a Supervisor seat that governs this Lead${known}`),
      { code: "SUPERVISOR_NOT_ELIGIBLE" },
    );
  }
  if (candidates.length === 0) {
    const reason = seatDecides && seats.length > 0 && deciding.length === 0
      ? `this cluster has ${seats.length} Supervisor seat(s), but every one is a watch seat — they observe and cannot decide, so the cluster still has no delegated decision path. Seat the governance seat with create_agent (a Supervisor with no labels["team.watch"], or one whose team.watch includes "decisions"), then consult it. If seating one is not possible, this is the reason you may put the question to the Human — say so explicitly.`
      : topology === "multi" && deciding.length > 0
        ? `this cluster has ${deciding.length} Supervisor seat(s) that decide, but none carries a team.domain covering "${leadDomain ?? "<this Lead has no team.domain>"}". Ask the Human to label the seats, or seat a Supervisor for your own domain.`
        : 'this cluster has no Supervisor seat, so it has no delegated decision path at all. Seat one with create_agent (provider "<family>-supervisor/<...>/<model-id>", labels.purpose "governance", labels["team.cluster"] set to your own cluster, settings.thinkingOptionId from the route the gate reads: pteam routing show), then consult it. If seating one is not possible, this is the reason you may put the question to the Human — say so explicitly.';
    throw Object.assign(new Error(`NO_SUPERVISOR_SEAT: ${reason}`), { code: "NO_SUPERVISOR_SEAT" });
  }
  if (candidates.length > 1) {
    const named = candidates
      .map((seat) => `${seat.agentId}${seat.domain ? ` [${seat.domain}]` : ""}`)
      .join(", ");
    throw Object.assign(
      new Error(
        `SUPERVISOR_AMBIGUOUS: ${candidates.length} Supervisor seats claim this Lead (${named}). Choosing one would ratify a governance overlap nobody resolved, and the answer would be refused on arrival anyway. Name one with supervisorAgentId only once the Human has resolved it.`,
      ),
      { code: "SUPERVISOR_AMBIGUOUS" },
    );
  }
  return candidates[0];
}

export function buildConsultBody(consult, { self, domain, header }) {
  const head = [
    header,
    `KIND: ${consult.kind}`,
    `CORRELATION_ID: ${consult.correlationId}`,
    `TASK_ID: ${consult.taskId}`,
    consult.projectId ? `PROJECT_ID: ${consult.projectId}` : null,
    `FROM_AGENT_ID: ${self}`,
    domain ? `DOMAIN: ${domain}` : null,
    `SCOPE: ${consult.scope}`,
    `REVERSIBILITY: ${consult.reversibility}`,
  ].filter(Boolean);
  const sections = [];
  for (const [, field] of CONSULT_SECTIONS) {
    const value = consult.text[field];
    if (value === undefined) continue;
    sections.push("", `${field}:`, value);
  }
  return [...head, ...sections].join("\n");
}

/**
 * Send one consult. Mirrors sendPeerMessage: resolve, envelope, send once.
 *
 * `core` is injected so routing can be tested without a Paseo install;
 * production loads it lazily on this path only, so a Peer sending an ordinary
 * `ask-lead` never pays for a module it does not use and never fails on one it
 * does not need.
 */
export async function sendLeadConsult(input, options = {}) {
  const core = options.core ?? (await importPolicyCore());
  const env = options.env ?? process.env;
  const consult = validateConsult(input, core.LEAD_CONSULT_FIELD_NAMES);
  const rawSelf = env.PASEO_AGENT_ID?.trim();
  if (!rawSelf) throw Object.assign(new Error("PASEO_AGENT_ID is missing"), { code: "AGENT_ID_MISSING" });
  const self = metadataToken("fromAgentId", rawSelf);
  const topology = core.teamTopology(env);
  const cluster = core.selfCluster(env);
  const leadDomain = core.normalizeDomain(env.PASEO_TEAM_DOMAIN ?? null);
  // Fail-closed, and say which half failed: "I could not look" must never be
  // reported as "there is nobody", or the Lead concludes it may ask the Human.
  const lookupFailed = (error) =>
    Object.assign(
      new Error(
        `SUPERVISOR_LOOKUP_FAILED: Paseo agent state could not be read, so whether this cluster has a Supervisor is unknown: ${String(error?.message ?? error)}`,
      ),
      { code: "SUPERVISOR_LOOKUP_FAILED" },
    );
  const readSeats = (strict) => {
    try {
      return core.supervisorSeats(env, { cluster, strict });
    } catch (error) {
      throw lookupFailed(error);
    }
  };
  const seats = readSeats(false);
  let supervisor;
  try {
    supervisor = chooseSupervisor({
      seats,
      topology,
      leadDomain,
      domainCovers: core.domainCovers,
      seatDecides: core.seatDecides,
      requested: consult.supervisorAgentId,
    });
  } catch (error) {
    // "Nobody" — and "the seat you named is not one of ours" — are the answers a
    // scan that could not read part of the agent state cannot give: the record it
    // missed may be the seat being asked about. A seat that WAS found is routed to
    // as it always was, so one torn record in some other project does not stop
    // every Lead on the host from consulting.
    const namedButNotFound =
      error?.code === "SUPERVISOR_NOT_ELIGIBLE" &&
      !seats.some((seat) => seat.agentId === consult.supervisorAgentId);
    if (error?.code === "NO_SUPERVISOR_SEAT" || namedButNotFound) readSeats(true);
    throw error;
  }
  const body = buildConsultBody(consult, { self, domain: leadDomain, header: core.LEAD_CONSULT_HEADER });
  const paseo = options.runPaseo ?? runPaseo;
  // Same one-shot rule as sendPeerMessage: `send` is a mutation with delivery
  // ambiguity and no idempotency contract, so correlationId is for receiver-side
  // deduplication, never a licence to retry.
  const sent = await paseo(
    ["send", supervisor.agentId, "--prompt", body, "--no-wait"],
    options.sendTimeoutMs ?? 20_000,
  );
  return {
    ok: true,
    recipient: supervisor.agentId,
    supervisorDomain: supervisor.domain ?? null,
    correlationId: consult.correlationId,
    awaiting: "SUPERVISOR_DECISION, or HUMAN_DECISION_REQUIRED: yes naming the criterion that failed",
    response: sent.data,
  };
}

async function main() {
  const command = process.argv[2];
  if (command !== "ask-lead" && command !== "ask-supervisor") {
    throw new Error("usage: team-communication.mjs ask-lead|ask-supervisor '<json>'");
  }
  let input;
  try {
    input = JSON.parse(process.argv[3] ?? "{}");
  } catch (error) {
    throw new Error(`invalid JSON message: ${String(error?.message ?? error)}`);
  }
  const result = command === "ask-lead" ? await sendPeerMessage(input) : await sendLeadConsult(input);
  console.log(JSON.stringify(result, null, 2));
}

export function isMainModule(entry = process.argv[1], moduleUrl = import.meta.url) {
  return isEntrypoint(moduleUrl, entry);
}

if (isMainModule()) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, code: error.code ?? "TEAM_MESSAGE_FAILED", message: error.message }));
    process.exit(2);
  });
}
