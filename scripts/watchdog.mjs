#!/usr/bin/env node
import { execFile } from "node:child_process";
import { isEntrypoint, resolvePaseoExec } from "./lib-common.mjs";
import { retryWithBackoff } from "./reliability.mjs";

export const DEFAULT_STALE_AFTER_MS = 5 * 60_000;
export const DEFAULT_GLOBAL_DEADLINE_MS = 60_000;
export const DEFAULT_INSPECT_CONCURRENCY = 6;
// Budget for one `paseo` call. It is 20s rather than the 5s this started at
// because `paseo ls -g --json` scales with the size of the daemon's agent
// table: on a daemon holding a few hundred agents it takes ~6s, so every
// attempt was killed and the watchdog answered `partial: true` forever. That
// is the worst possible failure here — a watchdog that lists nothing is
// indistinguishable from a fleet with nothing wrong, and the observation-only
// verdict meant no stale agent was ever reclaimed. 20s matches the budget the
// rest of the pack already gives a paseo call (paseo-bridge, team-communication).
export const DEFAULT_COMMAND_TIMEOUT_MS = 20_000;

export function classifyStaleAgents(agents, options = {}) {
  const now = options.now ?? Date.now();
  const staleAfterMs = Math.max(1000, options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS);
  return agents
    .filter((agent) => agent?.status === "running")
    .map((agent) => {
      const inspected = agent.inspectOk === true;
      const updatedAtMs = inspected ? Date.parse(agent.updatedAt ?? "") : NaN;
      const ageMs = Number.isFinite(updatedAtMs) ? Math.max(0, now - updatedAtMs) : null;
      return {
        ...agent,
        ageMs,
        stale: inspected && ageMs !== null && ageMs >= staleAfterMs,
        confidence: inspected && ageMs !== null ? "suspected" : "unknown",
      };
    });
}

function paseoExec() {
  return resolvePaseoExec((reason) => {
    throw Object.assign(new Error(`PASEO_TEAM_PASEO_EXEC ${reason}`), {
      code: "PASEO_EXEC_INVALID",
    });
  });
}

function deadlineBound(promise, deadline) {
  const remaining = Math.max(1, deadline - Date.now());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(Object.assign(new Error("watchdog global deadline exceeded"), { code: "TIMEOUT" }));
    }, remaining);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

function runPaseoJson(args, timeoutMs, signal) {
  const [bin, ...prefix] = paseoExec();
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      [...prefix, ...args, "--json"],
      { encoding: "utf8", timeout: timeoutMs, signal, stdio: ["ignore", "pipe", "pipe"], env: process.env, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          const text = `${String(stderr ?? "").trim()} ${String(stdout ?? "").trim()} ${error.message}`.trim();
          reject(Object.assign(new Error(text), { code: error.code ?? "CLI_ERROR" }));
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch (parseError) {
          reject(new Error(`paseo returned invalid JSON: ${String(parseError?.message ?? parseError)}`));
        }
      },
    );
  });
}

async function inspectOne(agent, deadline, options) {
  const paseoJson = options.runPaseoJson ?? runPaseoJson;
  try {
    const detail = await deadlineBound(retryWithBackoff(
      () => paseoJson(["inspect", agent.id], Math.max(1, Math.min(options.commandTimeoutMs, deadline - Date.now())), options.signal),
      { maxAttempts: options.maxAttempts, baseMs: options.baseMs, jitter: 0, deadlineMs: deadline },
    ), deadline);
    return {
      ...agent,
      inspectOk: true,
      status: String(detail.Status ?? detail.status ?? agent.status).toLowerCase(),
      updatedAt: detail.UpdatedAt ?? detail.updatedAt ?? agent.updatedAt,
      parentAgentId: detail.ParentAgentId ?? detail.parentAgentId ?? null,
      pendingPermissions: detail.PendingPermissions ?? detail.pendingPermissions ?? [],
      mode: detail.Mode ?? detail.mode ?? null,
    };
  } catch (error) {
    return {
      ...agent,
      inspectOk: false,
      stale: false,
      confidence: "unknown",
      inspectError: String(error?.message ?? error),
    };
  }
}

/**
 * Seats whose permission mode makes them useless or unguarded.
 *
 * Measured 2026-09-07: Paseo applies no provider defaultMode at create time, so
 * a `claude-*` seat created without an explicit mode comes up on "default"
 * ("Always Ask") — every tool call parks in the pending-permission queue and the
 * seat looks hung from the outside while it waits for a human who was never
 * told. The create_agent gate stops NEW seats coming up that way; this is how
 * the ones already running become visible, including any created before the
 * gate shipped or by hand outside the pack.
 *
 * Only the two modes nobody chooses on purpose are reported: "default" (parks
 * everything) and "bypassPermissions" (drops Paseo's guardrails). "plan" and
 * "acceptEdits" are deliberate narrowings and say nothing about health. pi
 * seats read "default" and mean nothing by it — the family declares no modes —
 * so they are skipped entirely.
 *
 * Observation only, like everything else here: moving another seat's mode
 * mid-turn is a change to how it is allowed to act, which is the operator's
 * call and not a watchdog's.
 */
export function classifyParkedSeats(agents) {
  const rows = [];
  for (const agent of Array.isArray(agents) ? agents : []) {
    if (agent?.inspectOk !== true) continue;
    const provider = String(agent.provider ?? "");
    if (!provider.startsWith("claude-")) continue;
    const mode = typeof agent.mode === "string" ? agent.mode : null;
    if (mode !== "default" && mode !== "bypassPermissions") continue;
    const pending = Array.isArray(agent.pendingPermissions) ? agent.pendingPermissions.length : 0;
    rows.push({
      agentId: agent.id,
      provider,
      mode,
      pendingPermissions: pending,
      suspicion:
        mode === "default"
          ? `seat is on "default" (Always Ask): every tool call waits for a human${pending > 0 ? ` — ${pending} already queued` : ""}. Paseo does not apply the provider's defaultMode at create time, so a seat created without settings.modeId lands here.`
          : 'seat is on "bypassPermissions": Paseo\'s own guardrails are off, and the role policy does not replace them.',
      fix: `paseo agent mode ${agent.id} auto`,
      // `auto` is not always there to move to, and the command then fails
      // without correcting anything — say what to do instead of leaving the
      // operator to rediscover it.
      fixNote:
        '"auto" needs support from the seat\'s backend and model: it is absent under Bedrock/Vertex, and a model without it answers "auto mode unavailable for this model". Then pick another explicit mode the seat supports ("acceptEdits", "plan", or "default" if you mean to watch it) — never "bypassPermissions".',
    });
  }
  return rows;
}

/**
 * Cross the lease board with the agent list.
 *
 * Two situations deserve an operator's attention, and neither is something the
 * watchdog may fix: a scope held by an agent that is no longer listed (a Lead
 * died holding it, and it will block other Leads until the TTL runs out), and a
 * scope whose lease has already lapsed while its holder is still alive (the
 * Lead believes it owns ground the policy will no longer grant it).
 *
 * Observation only, like everything else here. Reclaiming a scope from a Lead
 * that might still be mid-write is exactly the move that produces the second
 * writer this whole mechanism exists to prevent.
 */
export function classifyLeases(leases, agents, { now }) {
  const alive = new Set(
    (Array.isArray(agents) ? agents : [])
      .map((agent) => agent?.id ?? agent?.Id)
      .filter((id) => typeof id === "string"),
  );
  const rows = [];
  for (const holder of leases?.values?.() ?? []) {
    const holderListed = alive.has(holder.agentId);
    const expired = holder.expiresAt <= now;
    if (holderListed && !expired) continue;
    rows.push({
      scope: holder.scope,
      agentId: holder.agentId,
      expiresAt: new Date(holder.expiresAt).toISOString(),
      holderListed,
      expired,
      suspicion: !holderListed
        ? "holder is not in the agent listing — the scope stays blocked until the lease expires"
        : "lease has lapsed while the holder is still running — its next create_agent will be refused",
    });
  }
  return rows;
}

export async function collectWatchdogSnapshot(options = {}) {
  const globalDeadlineMs = Math.max(1000, options.globalDeadlineMs ?? DEFAULT_GLOBAL_DEADLINE_MS);
  const deadline = Date.now() + globalDeadlineMs;
  const commandTimeoutMs = Math.max(250, options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS);
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 3));
  const concurrency = Math.max(1, Math.min(16, Math.floor(options.concurrency ?? DEFAULT_INSPECT_CONCURRENCY)));
  const controller = new AbortController();
  const paseoJson = options.runPaseoJson ?? runPaseoJson;
  const timer = setTimeout(() => controller.abort(), globalDeadlineMs);
  let listed;
  try {
    listed = await deadlineBound(retryWithBackoff(
      () => paseoJson(["ls", "-g"], Math.max(1, Math.min(commandTimeoutMs, deadline - Date.now())), controller.signal),
      { maxAttempts, baseMs: options.baseMs ?? 100, jitter: 0, deadlineMs: deadline },
    ), deadline);
  } catch (error) {
    clearTimeout(timer);
    return {
      generatedAt: new Date(options.now ?? Date.now()).toISOString(),
      staleAfterMs: Math.max(1000, options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS),
      agents: [], stale: [], partial: true,
      error: String(error?.message ?? error),
      action: "observation-only: list failed; do not cancel/archive/spawn",
    };
  }

  const agents = Array.isArray(listed) ? listed : [];
  const allRunning = agents.filter((agent) => agent?.status === "running");
  const maxAgents = Math.max(1, Math.floor(options.maxAgents ?? 100));
  const running = allRunning.slice(0, maxAgents);
  const inspected = new Array(running.length);
  let cursor = 0;
  async function worker() {
    while (cursor < running.length && Date.now() < deadline) {
      const index = cursor++;
      inspected[index] = await inspectOne(running[index], deadline, {
        ...options, commandTimeoutMs, maxAttempts, signal: controller.signal,
      });
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, running.length) }, () => worker()));
  clearTimeout(timer);
  const complete = inspected.map((agent, index) => agent ?? {
    ...running[index],
    inspectOk: false,
    stale: false,
    confidence: "unknown",
    inspectError: "watchdog global deadline exceeded before inspect completed",
  });
  const classified = classifyStaleAgents(complete, options);
  const partial = allRunning.length > running.length || complete.some((agent) => agent.inspectOk !== true);
  const now = options.now ?? Date.now();
  // The lease board is a second, cheaper source of "something is stuck": one
  // room read, no per-agent fan-out. Its absence degrades the report rather
  // than failing it — an unreadable ledger is already fatal where it matters,
  // at the create_agent gate.
  let leaseRows = [];
  let leaseError = null;
  if (options.leases !== false) {
    try {
      const { fetchLeases } = options.leaseModule ?? (await import("./team-lease.mjs"));
      const fetched = await fetchLeases({ ...options, now });
      if (fetched.ok) leaseRows = classifyLeases(fetched.leases, allRunning, { now });
      else leaseError = fetched.code ?? "LEASE_LEDGER_UNREADABLE";
    } catch (error) {
      leaseError = String(error?.message ?? error);
    }
  }
  return {
    generatedAt: new Date(now).toISOString(),
    staleAfterMs: Math.max(1000, options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS),
    agents: classified,
    stale: classified.filter((agent) => agent.stale),
    parked: classifyParkedSeats(classified),
    leases: leaseRows,
    ...(leaseError ? { leaseError } : {}),
    partial,
    action: "observation-only: do not cancel/archive/spawn until status, activity and workspace state are reconciled",
  };
}

async function main() {
  let options = {};
  try { options = process.argv[2] ? JSON.parse(process.argv[2]) : {}; }
  catch (error) { throw new Error(`invalid watchdog options JSON: ${String(error?.message ?? error)}`); }
  console.log(JSON.stringify(await collectWatchdogSnapshot(options), null, 2));
}

export function isMainModule(entry = process.argv[1], moduleUrl = import.meta.url) {
  return isEntrypoint(moduleUrl, entry);
}

if (isMainModule()) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, code: "WATCHDOG_FAILED", message: String(error?.message ?? error) }));
    process.exit(2);
  });
}
