# paseo-team-orchestration

[![ci](https://github.com/Minnyat/paseo-team-orchestration/actions/workflows/ci.yml/badge.svg)](https://github.com/Minnyat/paseo-team-orchestration/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A role pack that runs directly on **Paseo**, with the same three roles served
by two coding agents — **Pi** and **Claude Code** — in one mixed fleet. Three
components, three separate responsibilities: Paseo owns
lifecycle/workspace/control-plane truth; the role pack owns role invariants
(prompt + tool policy); the Lead skill owns the orchestration procedure.

The role invariants live in one runtime-neutral core
(`extensions/paseo-team-core/`) with a thin adapter per runtime: a Pi
extension, and Claude Code hooks. A rule denied on one runtime is denied on the other.

Full design reference:
[`docs/demonthorn-agent-orchestration-deep-dive.md`](docs/demonthorn-agent-orchestration-deep-dive.md).
Claude runtime: [`docs/claude-runtime.md`](docs/claude-runtime.md).

## Quick start

Zero runtime dependencies, Node >= 22.18. The repository is public, so the
fetch needs no GitHub credentials — but it is never published to the npm
registry, so every install below names the GitHub repo rather than a package.

```bash
# run it once straight from GitHub — nothing to clone, nothing installed
npx --package github:Minnyat/paseo-team-orchestration pteam status

# or install it globally — puts both `pteam` and `paseo-team` on your PATH
npm install -g github:Minnyat/paseo-team-orchestration
pteam web --open                         # opens http://127.0.0.1:PORT/#token=...
```

From a checkout instead:

```bash
node cli/paseo-team.mjs --help           # or `npm link` once, then `pteam`
npm test
```

Full CLI/WebUI reference: [CLI and WebUI](#cli-and-webui) below.

## Structure

```text
paseo-team-orchestration/
├── README.md
├── LICENSE                             # MIT
├── package.json / package-lock.json    # dev dependency pins + npm test/typecheck
├── tsconfig.ci.json                    # in-repo typecheck config (tsconfig.json is dev-only, gitignored)
├── .gitattributes                      # LF everywhere; CI compares the same bytes on all three OSes
├── .github/workflows/ci.yml            # tests on 3 OSes × node 22.18/24 + tsc
├── config/
│   ├── paseo.providers.example.json   # 6 role providers: pi-* and claude-* (supervisor/lead/peer)
│   ├── model-routing.example.json     # MODEL_CLASS → model route template (copy per host)
│   ├── pi-models.example.json         # pi model endpoint for `pteam models sync` (copy per host)
│   └── cluster-routing.example.json   # controller-local N-host contract template
├── templates/
│   ├── TASK_BRIEF_V3.md               # canonical V3 task brief + parser rules
│   └── WORKSPACE_PROTOCOL.example.md  # root WORKSPACE_PROTOCOL.md for the target repo
├── prompts/
│   ├── supervisor.md               # Governance Supervisor
│   ├── lead.md                     # Project Lead (orchestration owner)
│   └── peer.md                     # execution Peer (bounded worker)
├── extensions/
│   ├── paseo-team-policy.ts        # Pi adapter: prompt injection + per-role tool policy
│   └── paseo-team-core/            # shared, runtime-neutral (invisible to pi's extension scan)
│       ├── policy-core.ts          # briefs, authority, allowlists, bash + git guards
│       └── claude-policy.ts        # Claude adapter: tool dialect + per-turn decisions
├── skills/
│   ├── paseo-team-lead/
│   │   └── SKILL.md                # Lead orchestration workflow + routing cycle
│   └── paseo-ocr-reviewer/
│       └── SKILL.md                # Reviewer read-only OCR delegation workflow
├── examples/
│   ├── engineer-task.md            # PASEO_TEAM_TASK_V3 brief (engineer, write)
│   ├── reviewer-task.md            # independent reviewer brief (read-only)
│   ├── architect-task.md           # solution-architect brief (read-only)
│   ├── scout-task.md               # repository-scout brief (read-only)
│   └── supervisor-observation.md   # observation template
├── cli/
│   ├── paseo-team.mjs              # the CLI: every config read/write and every daemon query
│   └── lib/
│       ├── config-walker.mjs       # path resolution + atomic write with backup
│       ├── paseo-bridge.mjs        # the only place that spawns `paseo` (argv, timeouts, fan-out)
│       ├── graph-cache.mjs         # spawn-tree cache; `paseo ls` has no parent link, `inspect` does
│       ├── install-drift.mjs       # installed copies vs THIS release, byte for byte
│       ├── workspace-protocol.mjs  # grade a target repo's WORKSPACE_PROTOCOL.md
│       └── graph.mjs               # agents + parents + permits -> nodes/edges/degraded
├── webui/
│   ├── server.mjs                  # transport only: route -> paseo-team argv, token, localhost
│   └── public/                     # zero-dependency SPA (index.html / app.js / style.css)
├── scripts/
│   ├── install.ps1 / install.sh    # installers
│   ├── lib-common.mjs              # shared helpers: exec/shim resolution, entrypoint, versions
│   ├── model-routing.mjs           # stateless resolver: single-host + cluster (+ validate/resolve CLI)
│   ├── pi-models-sync.mjs          # rebuilds ~/.pi/agent/models.json from a probed endpoint
│   ├── remote-paseo.mjs            # remote-host executor: Paseo CLI --host by HOST_ID (Lead REMOTE cycle)
│   ├── reliability.mjs             # retry classification/backoff + stale predicates
│   ├── team-communication.mjs      # parent-scoped Peer → Lead messaging
│   ├── watchdog.mjs                # observation-only running-agent watchdog
│   ├── ocr-review.mjs              # deterministic OCR exact-SHA preflight manifest
│   ├── ocr-setup.mjs               # installs/verifies the OCR CLI (capability probe, never downgrades)
│   ├── claude-hook.mjs             # Claude Code hook: role prompt + PreToolUse policy
│   ├── claude-team-mcp.mjs         # stdio MCP server: the team tools for Claude
│   ├── claude-setup.mjs            # installs/verifies/removes the Claude side (hooks + MCP)
│   ├── patch-paseo-mcp.mjs         # lets Paseo's bundled MCP SDK accept a newer protocol header
│   ├── team-scripts-path.mjs       # durable support-script path resolver
│   └── preflight.mjs               # host readiness check (--json, --strict, --host-id)
├── test/                           # `npm test` runs every test/*.test.{mjs,mts}
│   ├── policy.test.mts             # policy + lifecycle regression
│   ├── model-routing.test.mjs      # resolver regression
│   ├── remote-paseo.test.mjs       # remote executor regression (+ fixtures/fake-paseo.mjs)
│   ├── lib-common.test.mjs         # shared helpers (quoted paths, PATH order, shim fallback)
│   ├── reliability.test.mjs        # retry/backoff/stale predicates
│   ├── team-communication.test.mjs # parent-scoped Peer → Lead contract
│   ├── watchdog.test.mjs           # stale-agent classification
│   ├── ocr-review.test.mjs         # OCR delegation preflight contract
│   ├── ocr-setup.test.mjs          # capability probe + version comparison
│   ├── instruction-budget.test.mjs # standing-instruction size ratchet
│   ├── preflight.test.mjs          # which checks run, and at what severity
│   ├── uninstall.test.mjs          # removes what install wrote, and nothing else
│   ├── tools/mutate.mjs            # mutation harness: would these tests catch the bug?
│   ├── workspace-protocol.test.mjs # protocol admission states + digest
│   ├── install-drift.test.mjs      # installed copies vs this release
│   ├── ocr-integrity.test.mjs      # skill/reference/authority integrity
│   ├── patch-paseo-mcp.test.mjs    # the MCP protocol-header patch for Paseo's bundled SDK
│   ├── installer-contract.test.mjs # shipped files must exist and carry their dependencies
│   ├── paseo-contract.test.mjs     # Paseo JSON field contract (needs a live daemon — see below)
│   ├── paseo-bridge.test.mjs       # argv validation, error codes, bounded concurrency
│   ├── graph.test.mjs              # role inference, PEER_MESSAGE_V1 parse, graph assembly, cache
│   ├── cli-contract.test.mjs       # the CLI end to end against a fake paseo + throwaway HOME
│   ├── webui-server.test.mjs       # route allowlist, token, host check, cache, CLI failures
│   └── fixtures/                   # fake CLIs (paseo, ocr) + version-pinned OCR output
└── docs/
    ├── demonthorn-agent-orchestration-deep-dive.md   # original design
    ├── claude-runtime.md           # Claude Code as the second runtime: hooks, MCP, install
    ├── downstream-doctrine-review.md   # what Paseo's own Foundation does that we don't
    ├── model-routing.md            # the 4 model-routing layers, verified commands
    ├── multi-host.md               # N-host routing + cross-host test plan
    ├── multi-supervisor-topology.md    # domains, clusters, and who may seat whom
    ├── ocr-integration.md          # OpenCodeReview Phase 1 single-machine setup
    └── webui-architecture.md       # CLI <-> WebUI contract, graph schema, measured costs
```

## Roles

| Profile | `PASEO_PI_ROLE` | Default tools |
|---|---|---|
| `pi-supervisor` | `supervisor` | `read`, monitoring `mcp`, `team_watchdog`, `team_lease` (status), `team_fork` |
| `pi-lead` | `lead` | `read`, `bash`, Paseo orchestration set, `team_watchdog`, `team_lease`, `team_fork`, `lead_ask_supervisor` |
| `pi-peer` | `peer` | `read`, `bash`, `peer_ask_lead` (+ `write`/`edit` under `MODE: write`) |

The `claude-*` profiles carry the same three roles and the same team tools,
reached as `mcp__paseo-team__<tool>`. A Peer gets `peer_ask_lead` and nothing
else: `team_lease`, `team_fork`, `team_watchdog` and
`lead_ask_supervisor` are all refused for it, because a Peer coordinates
through its Lead. `lead_ask_supervisor` is the Lead's alone — the Supervisor
receives those consults and never sends one.

Refine the real allowlist after running `/team-tools` — actual Paseo tool names
can differ from the defaults.

Per-role exceptions:

- **Supervisor** is observation-only. No `write`/`edit` ever. `create_agent` is
  available for Lead recovery alone, behind an argument guard.
- **Lead** gets `write`/`edit` only when `PASEO_TEAM_LEAD_WRITE=1`. Its
  `create_agent` may also seat a **Supervisor** for its own cluster, behind its
  own argument guard (explicit model, `labels.purpose: governance`, and under
  `multi` a domain no wider than the Lead's own).
- **Peer** gets no Paseo MCP or orchestration tools at all. Browser MCP is
  granted only by the current V3 brief.

### Custom seats — named variants of the three roles

A **seat** is not a fourth role. It is one of the six durable role providers
plus a name and a set of capabilities from a catalog that lives in code
(`scripts/seat-profiles.mjs`), materialized into an ordinary Paseo provider:

```jsonc
// ~/.paseo-team-orchestration/seat-profiles.local.json — edited by hand or in the WebUI
{ "version": 1, "seats": {
  "researcher": { "base": "claude-peer", "label": "Claude Peer (Researcher)",
                  "capabilities": ["web-research"] }
} }
```

```bash
pteam seats list                # what the seats generate, and why one is refused
pteam seats apply --dry-run     # the plan, writing nothing
pteam seats apply               # merge into ~/.paseo/config.json, then: paseo daemon restart
```

The generated provider is `claude-peer-researcher`, carrying
`PASEO_PI_ROLE=peer` and `PASEO_TEAM_EXTRA_TOOLS=WebFetch,WebSearch`, with those
two tools removed from its `disallowedTools`. The rule core is untouched: it
decides authority from `PASEO_PI_ROLE`, never from a provider name, so a seat
can only ever be one of the three roles it already knows.

| Capability | Base roles | Grants |
|---|---|---|
| `web-research` | `claude-lead`, `claude-peer` | `WebFetch`, `WebSearch` |
| `lead-write` | `pi-lead`, `claude-lead` | `PASEO_TEAM_LEAD_WRITE=1` (Write/Edit) |

Four rules make this safe to expose in a browser:

- **The catalog is the allowlist.** The form offers what
  `scripts/seat-profiles.mjs` describes and nothing else; adding a capability is
  a code change with a test, never a text box someone types `Task` into.
- **A capability declares its roles and runtime family.** `web-research` is
  refused for a Supervisor (observation-only) and for pi seats (no web tool
  exists there) — refused loudly at `apply`, not hidden in the UI.
- **Both policy layers are recomputed together.** `disallowedTools` is asked of
  the real policy *under the seat's own environment*, so a grant expressed as an
  env knob (`lead-write`) cannot leave the static layer stripping the tool it
  just enabled.
- **Generation never overwrites what it did not create.** `seats apply` keeps a
  ledger (`~/.paseo-team-orchestration/seat-providers.json`) and touches only names in it;
  a hand-written provider whose name collides is reported as `skipped`. One
  consequence: `pteam uninstall --purge` deletes that ledger, so any seat
  providers still in `~/.paseo/config.json` become unowned and must be removed
  by hand.

Seats are deliberately **not** routable: `routing`/`cluster` still accept only
the six durable role providers, so a seat takes whatever model its creator
passes to `create_agent`.

A seat provider is also still governed by every provider-name gate — a
`claude-supervisor-audit` seat hits the same Supervisor-creation guard a bare
`claude-supervisor` does, because `parseRoleProvider` resolves a seat to its
base role.

### How authority is decided

The policy is a **pure allowlist** (`setActiveTools`) plus a backstop that
blocks inside `tool_call`. It is not an absolute security sandbox.

Every authority is recomputed from the brief of the **current turn**:

- Only a V3 marker block (`PASEO_TEAM_TASK_V3_BEGIN` …
  `PASEO_TEAM_TASK_V3_END`) can grant write mode or git authority.
- **The legacy `PASEO_TEAM_TASK_V1|V2` header always resolves to read-only.**
  Every `MODE` and `*_AUTHORITY` field in it is ignored — the legacy parser
  scanned the whole prompt, which made it an injection hole.
- A Peer's `git commit`/`git push` through bash is blocked unless the V3 brief
  grants `*_AUTHORITY: allowed`.
- Push authority is **branch-scoped**: exactly
  `git push -u origin HEAD:refs/heads/agent/<TASK_ID>`, nothing else.
- Force-push is blocked in every spelling (`-f`, `-uf`, `-fu`, `--force*`,
  refspec `+`), and so are Peer merges.
- `BROWSER_MCP_AUTHORITY` is a current-turn field scoped to the browser
  surface: Paseo Browser Control (`browser_*`) on either runtime, plus Claude
  in Chrome (`mcp__claude-in-chrome__*`) on a Claude seat. Unlike every other
  authority it defaults to **allowed** on a valid V3 brief — browsing reads
  pages, and everything it could change is still behind edit/commit/push
  authority — so `denied` is what a Lead writes to withhold it. A missing or
  malformed brief still grants nothing at all.
- Paseo ORCHESTRATION MCP and every other MCP server stay blocked for Peers.
  Browser Control is not orchestration, even though Paseo registers it on the
  same MCP server.
- `AskUserQuestion` is denied for Lead and Peer, on both runtimes: the chain is
  Peer → Lead → Supervisor → Human, and only the Supervisor's escalation target
  is the Human.

## Communication and watchdog

### A Peer asks the Lead

Peers use the custom `peer_ask_lead` tool, never `paseo send` through bash. The
tool reads `PASEO_AGENT_ID`, inspects `paseo.parent-agent-id`, sends only to the
parent Lead, and wraps the payload as `PEER_MESSAGE_V1` carrying `kind`,
`TASK_ID` and `CORRELATION_ID`.

Message kinds: `question`, `blocked`, `dependency`, `progress`.

Failing to resolve the parent is fail-closed — there is no broadcast fallback.

### A Lead asks the Supervisor — not the Human

The counterpart, and the reason it exists: the Supervisor-initiated half of this
pack (observation loop, `SUPERVISOR_DECISION`) only ever fires when the
Supervisor decides to look. A Lead holding a question of its own had exactly one
addressable party — the Human — so it asked, constantly, including about matters
its own contract had already delegated to it.

`lead_ask_supervisor` closes that. It resolves the Supervisor seat of the Lead's
own **cluster** from Paseo's agent state (narrowed by `team.domain` under
`multi`), and delivers a `LEAD_CONSULT_V1` **prompt**, because
a prompt wakes an idle Supervisor and opens a turn, which is what makes the
receiving runtime inject its verdict.

```text
lead_ask_supervisor {
  kind: "decision",          # decision | question | risk
  question, options, evidence,
  scope, reversibility,      # "reversible" | "irreversible"
  recommendation?, taskId?, projectId?, correlationId?, supervisorAgentId?
}
```

The five required fields are the ones the Supervisor's four Delegated-decision
criteria are checked against, so a consult can come back decided in one round
trip; one that omits them is refused at the sender rather than bounced after a
round trip. The Supervisor's turn context then carries a verdict and a
directive:

| Verdict | Supervisor must |
|---|---|
| `LEAD_CONSULT_ACTIONABLE` | decide (a filled `SUPERVISOR_DECISION`) **or** escalate naming the criterion that failed |
| `LEAD_CONSULT_HUMAN_BOUND` | escalate only — the Lead marked the matter irreversible, so criterion 2 already failed |
| `LEAD_CONSULT_SENDER_UNVERIFIED` | answer on evidence, but issue no decision — `FROM_AGENT_ID` does not resolve to a Lead seat |
| `LEAD_CONSULT_MALFORMED` / `_CLUSTER_MISMATCH` / `_OUT_OF_JURISDICTION` / `_JURISDICTION_UNDECLARED` | refuse, and say `BLOCKED: <code>` so the Lead is not left waiting |

Sender-side failures are named rather than silent, because a silent one degrades
straight back into asking the Human:

| Code | Meaning |
|---|---|
| `NO_SUPERVISOR_SEAT` | this cluster has no governance seat — the one case where asking the Human is correct. The message carries the `create_agent` call that fixes it |
| `SUPERVISOR_AMBIGUOUS` | two seats claim this Lead; picking one would ratify an overlap the Lead's own runtime refuses as `JURISDICTION_OVERLAP` |
| `SUPERVISOR_LOOKUP_FAILED` | agent state unreadable — "could not look" is never reported as "there is nobody" |
| `CONSULT_FIELD_COLLISION` | a body line like `SCOPE:` would be read back as a field |

A Lead may also **seat the Supervisor that governs it** when the cluster has
none. The guard requires an explicitly routed provider (never a bare
`pi-supervisor`), `labels.purpose: governance`, a `team.cluster` matching the
Lead's own, `settings.thinkingOptionId`, and under `multi` a `team.domain` equal
to or inside the Lead's — a Supervisor wider than its creator would be authority
manufactured out of nothing.

### Lead/Supervisor check for hung agents

`team_watchdog` inspects `running` agents via `paseo ls -g` + `paseo inspect`:

| Bound | Default |
|---|---|
| Concurrency | 6 |
| Global deadline | 30s (partial results returned on timeout) |
| Transport retries | 3 |
| Stale threshold | 5 minutes since `UpdatedAt` |

Only a **successful** inspect past the threshold is marked `stale`/suspected. A
**failed** inspect is `unknown` — and nothing is ever auto-cancelled,
auto-archived or auto-spawned on either verdict.

Before acting on a stale agent, the Lead must check activity, pending
permissions, daemon/remote health, expected long-running commands, and
workspace/Git state. Only then does cancel/archive/correction get decided, and
never a replacement writer while the previous commit or state is still unclear.

### Retry policy

Retries exist to survive flaky transport, not to paper over ambiguity, so the
split is by whether a repeat can duplicate work:

| Operation | Retried |
|---|---|
| `peer_ask_lead` inspect step | up to 3×, transient transport errors only |
| `lead_ask_supervisor` send | never retried — same delivery ambiguity as `peer_ask_lead`; `correlationId` is for receiver-side deduplication |
| `remote-paseo.mjs` read/health/provider/status | up to 3× |
| `send`, `run` | **never** — delivery ambiguity would duplicate the message or task |
| usage / authority / model / workspace / endpoint / malformed request | **never** — fails immediately |

Model-API transient errors (overloaded, rate limit, 5xx, timeout) are retried
by Pi itself per its `settings.retry` policy (defaults: 3 attempts, 2s base
delay). The WebUI's **Pi — cấu hình chính** editor tunes that policy without
reading Pi's docs — including a one-click preset for unstable providers — via
`pteam config read/write pi-settings` (`~/.pi/agent/settings.json`). Changes
take effect for agent sessions started after the save.

## Coordination between seats (more than one Lead, more than one Supervisor)

One Lead and one Supervisor need none of this. It exists because a second Lead
cannot see the first one's intentions, so what used to be held by being careful
has to be held by the policy instead.

### Scope leases — one writer per moving scope, enforced

`create_agent` in write mode is **refused** unless the Lead holds a lease
covering the scope that writer will own:

```text
team_lease { action: "claim", scope: "src/auth", ttlMs: <work window> }
team_lease { action: "renew" | "release" | "status", scope: "src/auth" }
```

- The ledger is an append-only file this pack owns (`scripts/lease-ledger.mjs`).
  A claim is **compare-and-swap**: the board is locked, read and appended to as
  one step, so a claim that collides with a live lease is refused and writes
  nothing. Read `granted`, not merely `ok`. Read-side arbitration
  (`resolveLeases`) stays as the backstop — it covers expiry, older records and
  any filesystem where the lock turns out to be advisory.
- Scopes nest: holding `src` holds `src/auth`. Claim the narrowest scope the
  writer needs, or you block Leads you did not mean to.
- Read-only dispositions (scout, researcher, architect, reviewer) take no lease
  and are never gated — they share a tree by design.
- An unreadable ledger is `BLOCKED: LEASE_UNVERIFIABLE`, never "proceed".
- TTL is capped at 12h, so a smuggled `TTL_MS` cannot lock the repo root
  indefinitely.

### Lead ↔ Lead / Supervisor ↔ Lead — a direct prompt

`peer_ask_lead` is one-way and parent-scoped; it cannot reach another Lead.
Between coordinating seats there is no bus: prompt the other seat directly with
`send_agent_prompt`. A Lead or Supervisor **in your own cluster** is a permitted
target; only another Lead's *Peer* is refused
(`BLOCKED: PROMPT_TARGET_NOT_OWNED`), and the answer to that is to prompt the
Lead who owns it.

This pack used to run a many-to-many bus on Paseo chat rooms. Paseo retired chat
rooms in 0.4.0 — upstream PR #3053 removed them "instead of migrating" them
ahead of a storage change — so the bus went with them. Two consequences: a
broadcast is N prompts rather than one post (N is the number of coordinators,
not of engineers), and a prompt is not a record, so anything that must be
readable later belongs in the plan, the PR or the task brief.

### Multi-supervisor governance — `PASEO_TEAM_TOPOLOGY`

| Value | Effect |
|---|---|
| unset / `single` | default; the jurisdiction, `recovery_for` and `send_agent_prompt` guards return immediately — behaviour is line-for-line what it was before governance existed |
| `multi` | the guards are live |
| anything else | **read as `multi`** |

An unrecognised value reads as the strict side on purpose: every rule the flag
adds only ever refuses, so misreading toward strict costs one blocked call with
a stated reason, while misreading toward loose turns governance off silently on
a cluster the operator believes is governed.

One thing the flag does **not** gate is the verdict on a supervisor message.
On every topology, a Lead turn that opens with a `SUPERVISOR_OBSERVATION` /
`SUPERVISOR_DECISION` gets a notice in its turn context saying what the message
is, whether its `FROM_AGENT_ID` resolves to a real Supervisor seat in Paseo, and
**what the Lead is to do about it** — `ACT ON IT … needs NO Human round-trip` on
the binding path, `BLOCKED: <code>` on the refusing one. It used to be computed
only under `multi`, so on the default pack a delegated decision reached the Lead
as bare prose and the Lead, quite reasonably, asked the Human to approve what
its own contract had already delegated to it. A block whose sender does not
resolve to a Supervisor seat is `SUPERVISOR_SENDER_UNVERIFIED` and never binds:
anything can type the header, so the directive is reachable only through a seat
the runtime can point at.

Under `multi`, seats carry a domain (`team.domain` label / `PASEO_TEAM_DOMAIN`,
hierarchical: `backend` contains `backend.auth`, `*` is the root) and every
`SUPERVISOR_OBSERVATION` / `SUPERVISOR_DECISION` carries `DOMAIN:`. The runtime
computes the jurisdiction verdict too — a misrouted
**observation** is a warning (noise costs nothing), a misrouted **decision** is
refused (that is the one the Lead would act on), and an overlap refuses both
Supervisors and escalates to the Human, and a DECISION with no `FROM_AGENT_ID`
is refused (`JURISDICTION_UNATTRIBUTED`) because an unsigned one cannot be
checked for overlap at all. Two ownership guards come with it:
`send_agent_prompt` may not target another Lead's Peer
(`BLOCKED: PROMPT_TARGET_NOT_OWNED`), and a Supervisor's `recovery_for` must
fall inside its own domain.

One ownership rule is deliberately NOT gated on the flag: a Supervisor
prompting a Peer is refused (`BLOCKED: PROMPT_TARGET_IS_PEER`) under `single`
too. It is the Supervisor's own role boundary, not a jurisdiction question, and
gating it meant the default pack enforced it nowhere. That check is fail-OPEN
on a target it cannot resolve under `single` (fail-closed under `multi`), so an
unreadable state file cannot silence a Supervisor that works today. Parentage is a declared label, not an authenticated
fact — these catch mistakes, not forgery.

### Which workspace a seat belongs to — `team.cluster`

`team.domain` says what a seat **governs**. It never said where a seat
**lives**, and every governance read in the pack is host-global on purpose:
`$PASEO_HOME/agents` is indexed by agent id across every cwd-slug, and the
a domain fan-out runs `paseo ls -g` — the flag whose whole job is to
escape cwd scoping. With one project per host that gap never showed. With two
it did, three ways: two unrelated repos that both label a seat `backend` made
each other's Supervisors contenders (so `JURISDICTION_OVERLAP` fired on a
cluster with exactly one Supervisor); a Lead could `send_agent_prompt` another
project's Lead, because the ownership guard asked only *is the target a
coordinator*; and `src/index.ts` is a lease scope in every repo on the machine,
all filed in one global ledger room.

A seat's cluster is derived, explicit source first, so an existing deployment is
scoped without relabelling anything:

| Order | Source | Why |
|---|---|---|
| 1 | `team.cluster` label / `PASEO_TEAM_CLUSTER` | a reviewer workspace is a linked **worktree** — different `workspaceId` *and* different cwd from its Lead, so only a declared label can keep those two seats together. Filled in **automatically** the moment 1 exists (see below) |
| 2 | `workspaceId` | Paseo's own boundary, when there is one |
| 3 | `cwd` | what a plain `paseo run` has instead |
| 4 | *(none)* | unknown |

**Unknown narrows nothing.** Every cluster rule only ever *removes* a
restriction — drops a contender, permits a prompt, frees a scope — so
separation has to be proven: an underivable cluster on either side leaves
today's behaviour exactly as it was. This is the same instinct as the
`PASEO_TEAM_TOPOLOGY` typo rule, pointed the other way: a wrong guess must cost
a blocked call with a reason, never governance that quietly switched itself off.

**Tier 1 is stamped at creation, not left to a follow-up step.** Nothing wrote
`team.cluster` when a seat was created — the Lead's routing cycle passed only
`settings`, never `labels` — so every seat fell back to tier 2/3, which is
exactly wrong for the seat that needs tier 1 most: a reviewer worktree, whose
`workspaceId` *and* `cwd` differ from its Lead's by construction. A Lead's own
`create_agent` (and a Supervisor's gated lead-recovery `create_agent`) is now
REQUIRED to carry `labels: { "team.cluster": "<the creator's own cluster>" }` —
missing it refuses with the exact value to fill in, and a value naming a
*different* cluster than the creator's own is refused too (stamping a new seat
into another project's cluster is an escalation, not a typo). The gate only
disables when the creator's own cluster cannot be determined at all — it never
demands a value the creator itself does not know. `remote-paseo.mjs run` fills
the label in automatically from the caller's own cluster when `--label` does
not already set one, and refuses the run if it still has none; `team_fork`
derives it from the SOURCE agent's own cluster, the same way `team.fork-of` is.
This is a create-time gate only — an agent created before it shipped carries no
label and is still read back through tier 2/3, exactly as before.

What the axis gates — **authority, never observation**. A Supervisor may watch
several workspaces; that is its job. It may not *decide* for one it does not
live in:

| Surface | Refusal |
|---|---|
| `SUPERVISOR_DECISION` from another cluster | `CLUSTER_MISMATCH` (refused; a bare observation only warns) |
| `send_agent_prompt` at another cluster's Lead/Supervisor | `BLOCKED: PROMPT_TARGET_OUT_OF_CLUSTER` |
| scope lease | `LEASE_V1` carries `CLUSTER:`; scopes collide only inside one cluster |

`CLUSTER_MISMATCH` and `PROMPT_TARGET_OUT_OF_CLUSTER` are **not** gated on
`PASEO_TEAM_TOPOLOGY`, for the same reason `PROMPT_TARGET_IS_PEER` is not: this
is not a jurisdiction question but a prior one — *is this message even addressed
to my project*. `single` is the pack that needs it most, since it runs no
jurisdiction rules at all; before the axis existed, a Supervisor in another
workspace on the same host reached a Lead with a verdict of
`SUPERVISOR_DECISION_BINDING`, whose directive is *ACT ON IT … needs NO Human
round-trip*.

A seat's own subagent is always reachable, cluster or not — the parentage test
runs first, which is what keeps the mandated reviewer-worktree flow working.

The lease ledger stays backward compatible: `CLUSTER:` is a new field beside
`SCOPE:`, never folded into it, and a record written before the field existed
parses with a null cluster that collides with everything — its old, coarser
meaning. Release and renew match on *proven* separation rather than on an exact
key, so a lease claimed by the old pack can still be released by the new one
mid-upgrade.

### Handing a seat over — briefing handoff vs `team_fork`

| Situation | Mechanism |
|---|---|
| The receiver must be **independent** (reviewer, challenger, supervisor) | **Briefing handoff** — a fork is refused, because it inherits the framing the role exists to question |
| The context summarizes cleanly | Briefing handoff (the default) |
| The reasoning history itself must travel (split load, change host/model, take over mid-flight) | **Session fork** |
| Running out of context | **Neither** — `/compact`. Auto-compaction fires on the fork too, so a fork buys a compacted agent *and* a second seat |

A fork copies the transcript file — no LLM turn, near-instant — then imports it:

```text
team_fork { action: "fork", agentId, reason: "takeover", disposition: "lead", scope, provider, model, thinkingOptionId }
team_fork { action: "verify", agentId, model, thinkingOptionId }
```

`fork` stops before the model is routed (the CLI has no `--model`; only MCP
`update_agent` moves it) and hands back both that call and a `FORK_SEED_V1`
seed prompt, which is **built in code** so it cannot be softened: the fork
inherits belief, not authority — no lease, no Peers, and it must not act as the
source agent. `verify` reads `runtimeInfo` (never the stale creation-time
`persistence.metadata`) and **deletes** a fork that came up on the wrong model.
Peers stay with the source: there is no reparent API, and `detach` is a Human
action that leaves a Peer unable to escalate.

## The workspace protocol

`WORKSPACE_PROTOCOL.md` in the **root** of the repository being orchestrated is
the repository tactics layer — the instruction source between the role contract
(which this pack owns) and the assignment (which the Lead writes per task).
`prompts/lead.md` makes reading it invariant 1. Readership is part of the
contract: the Lead reads it in full before orchestrating, a Peer never does (the
Lead extracts the relevant constraints into the V3 brief), and the Supervisor
reads it only under a governance mandate to create, audit or update it.

Copy [`templates/WORKSPACE_PROTOCOL.example.md`](templates/WORKSPACE_PROTOCOL.example.md)
to get started, then:

```bash
pteam protocol status                  # grade the repo in the current directory
pteam protocol status --path /some/repo
```

Four states, not a boolean:

| State | Meaning |
|---|---|
| `valid` | present, versioned, no unresolved conflict — reported with a sha256 digest and any still-blank keys |
| `missing` | no protocol; the Lead has no tactics layer |
| `invalid` | present but not usable: blank, NUL bytes, an unresolved merge conflict (`<<<<<<<` or `>>>>>>>`; the ambiguous `=======` is deliberately not matched, since it is also a Markdown setext underline), or no `WORKSPACE_PROTOCOL_VERSION` |
| `unreadable` | the path exists and cannot be read as a file |

`invalid` is the state that earns the module. `missing` a Lead can act on; a
protocol carrying an unresolved merge conflict is *worse* than absent, because
the Lead opens it and reads both sides of the conflict as rules. Preflight fails
on `invalid` and `unreadable` for that reason, and warns on `missing`.

Blank recommended keys are reported, never fatal — the deep dive is explicit
that a tight repo and a loose side project both get to write one, and a prose
protocol is a legitimate protocol. The digest is recorded because it is what
makes "did the protocol change since the Lead read it?" answerable at all.

A protocol at the legacy `.orchestration/WORKSPACE_PROTOCOL.md` (where an older
version of the template pointed) is still found, and reported AS legacy — the
Lead reads the repository root, so telling someone their protocol is "missing"
while it sits on disk is the least useful true statement available.

This reports; it does not gate. Turning a missing protocol into a delegation
blocker is a decision for whoever operates a fleet, not something a release
should switch on underneath them.

## Skill admission

The pack ships two skills, and both land in a directory every seat on the
machine can see. Role is a property of the **seat** — an environment variable
Paseo sets on the agent process — not of the directory, so there is no per-role
folder to install into: a Peer could open the Lead's orchestration procedure,
and a Supervisor the review harness, purely because both were on disk.

That is not an authority hole. Every tool those procedures need is already
denied to the wrong role by the tool policy. It is an **attention** hole, and
the expensive kind: a Peer that has read the orchestration procedure starts
reasoning about topology and delegation instead of its own bounded task, and
nothing in its output says where the drift came from.

So the admission table is the third thing the two runtimes share, next to the
tool policy and the brief parser — one table in `policy-core.ts`, two
enforcement points:

| Skill | Lead | Peer | Supervisor |
|---|---|---|---|
| `paseo-team-lead` | active | disabled | disabled |
| `paseo-ocr-reviewer` | disabled | active under an independent-reviewer `DISPOSITION` | disabled |

- **Claude Code** gates the `Skill` tool per call in the PreToolUse hook. The
  tool itself stays available to every role — the user's own skills go through
  it — and only the pack's own package names are checked. It gates the `Read`
  family on the same table too: a Peer refused `Skill(paseo-team-lead)` that
  could still `Read ~/.claude/skills/paseo-team-lead/SKILL.md` would be exactly
  the cross-runtime asymmetry the shared core exists to prevent.
- **pi** has no `skill` tool: its agent loads a skill by *reading* the full
  `SKILL.md`, so the `tool_call` guard matches the read path instead. The skill
  still appears in pi's listing for every seat; what the gate withholds is the
  procedure itself. Only the **installed** copies are gated — under
  `~/.pi/agent/skills`, `~/.claude/skills` or `~/.agents/skills`. A Peer
  assigned to edit `skills/paseo-team-lead/SKILL.md` in a repository checkout
  (this repo is one, and editing that file is ordinary work) reads it normally.

Two deliberate leniencies, because this gate protects attention rather than
authority and being wrong in the closed direction costs more than it saves: a
skill this pack does not ship is never blocked, and neither is a call whose
skill name cannot be read.

`test/policy.test.mts` asserts that every directory under `skills/` is
classified in the table — a new skill nobody classified would default to
visible-for-everyone, which is exactly the failure the table exists to prevent.

## OpenCodeReview delegation (Phase 1)

`paseo-ocr-reviewer` is a strictly read-only Reviewer Peer skill.

OCR is not an agent, a provider, or a second control plane. It deterministically
selects files and resolves rules; the Pi Reviewer does the reasoning, on the
exact candidate SHA.

**Version handling is capability-based, not equality-based.** `scripts/ocr-setup.mjs`
accepts any installed `@alibaba-group/open-code-review` at or above the verified
`1.8.10` baseline that passes the delegation capability probe, and never
downgrades it. Only when OCR is absent or incompatible does it install the
pinned `1.9.2`.

Check the CLI manually with `ocr version` (`Get-Command ocr` on PowerShell,
`command -v ocr` on Unix-like shells), and use delegation mode — not
`ocr review`. See [`docs/ocr-integration.md`](docs/ocr-integration.md).

The optional deterministic preflight emits a normalized manifest:

```bash
node scripts/ocr-review.mjs --repo <repo> --base <base-sha> --candidate <candidate-sha>
```

It probes `delegate preview/rule` capabilities, records the OCR version as
provenance, and prefers `--format json` when the installed release supports it.

It refuses to produce a manifest on any of:

- candidate SHA mismatch
- a review workspace that is not a linked git worktree
  (`REVIEW_WORKSPACE_NOT_WORKTREE` — never a primary checkout or a standalone
  clone)
- a dirty or mutated workspace
- unavailable or incompatible OCR
- malformed selection or rules
- incomplete rule coverage

The manifest records candidate-tree and workspace entry/exit state plus
deterministic digests. It never edits Git state and never calls an LLM.

## Installation

```bash
# Windows (PowerShell)
./scripts/install.ps1

# macOS / Linux
./scripts/install.sh
```

What the installers copy:

| Source | Destination |
|---|---|
| `extensions/paseo-team-policy.ts` | `~/.pi/agent/extensions/` |
| `extensions/paseo-team-core/` | `~/.pi/agent/extensions/paseo-team-core/` |
| `prompts/*.md` | `~/.pi/agent/extensions/prompts/` |
| `skills/paseo-team-lead/` | `~/.pi/agent/skills/paseo-team-lead/` and `~/.claude/skills/paseo-team-lead/` |
| `skills/paseo-ocr-reviewer/` | `~/.pi/agent/skills/paseo-ocr-reviewer/` and `~/.claude/skills/paseo-ocr-reviewer/` |
| support scripts (see below) | `~/.pi/agent/extensions/paseo-team-scripts/` |

### Where the pack's own config lives

Routing files, the seat ledger, the permit audit log and the Claude session
state live in one directory, resolved the same way by every reader and by both
installers:

```text
PST_TEAM_CONFIG_DIR → PASEO_TEAM_HOME → an existing ~/.paseo-pi-team → ~/.paseo-team-orchestration
```

A fresh host gets `~/.paseo-team-orchestration`. A host installed before the
rename keeps `~/.paseo-pi-team` forever — it holds the only copy of that host's
state, and a daemon may be loading `pi-provider.env` out of it, so nothing
migrates it and nothing should. Both present: the legacy one still wins, because
it is the one everything has been writing to.

`pteam env list` names the directory this host actually resolved. Paths written
`~/.paseo-team-orchestration/...` below mean *that* directory — read them as
`~/.paseo-pi-team/...` if you are on a host that predates the rename.

`~/.claude/skills/` is the user's own directory, and the names this pack ships
are ordinary English, so a skill already sitting there under one of those names
may well be one the user wrote. Install refuses to overwrite such a directory —
it reports the collision by name, installs the rest, and `pteam preflight` then
reports the refused one as a missing skill, because from the Lead's point of
view it is: the role prompt sends it to this pack's procedure and it would find
somebody else's. Uninstall is the same rule in reverse; it removes only the
directories the pack can prove it wrote, either by the `.paseo-pi-team` marker
it leaves inside each one (frozen at the pack's former name: installed copies
are located by that exact filename, so renaming it would strand them) or by a `SKILL.md` byte-identical to the shipped copy
(which is how installs from before the marker existed are still recognised).
Edit an installed skill and it becomes yours, and the pack stops touching it.

The Claude copies are installed by `scripts/claude-setup.mjs --install` and only
when the `claude` CLI is present. They matter: `prompts/lead.md` makes loading
the orchestration procedure invariant 1, and until the pack installed them a
Claude Lead's `Skill(paseo-team-lead)` call was allowed and simply found
nothing. Which role may load which package is decided per call — see
[Skill admission](#skill-admission).

It installs no browser: both runtimes use one they already have — see
[The browser surface](#the-browser-surface). An earlier version registered an
`agent-browser` MCP server in `~/.pi/agent/mcp.json` and `~/.claude.json`; an
install now REMOVES that entry when this pack wrote it, and leaves it alone
when the user configured it themselves.

When the `claude` CLI is present, the installers also run
`scripts/claude-setup.mjs --install`, which merges this pack's hooks into
`~/.claude/settings.json` and the `paseo-team` MCP server into `~/.claude.json`
— see [Mixed fleet](#mixed-fleet-pi--claude-code). A host without `claude`
skips that step; it is not an error.

The support scripts are `lib-common`, `reliability`, `watchdog`,
`team-communication`, `team-lease`, `lease-ledger`, `team-fork`, `ocr-review`,
`remote-paseo`, `model-routing`, `team-scripts-path`, `claude-hook`,
`claude-team-mcp` and `patch-paseo-mcp`.
They are copied **flat**, so every import between them
must stay `./<name>.mjs`. `installer-contract.test.mjs` guards that: every
shipped file must exist, and every support script it imports must be shipped
too.

### The browser surface

The pack installs no browser. Both runtimes already have one, and shipping a
third bought nothing while costing a CLI to pin, a Chrome runtime to probe, a
skill to copy, an MCP entry to merge into two config files, and a CDP attach
mode whose documented risk was handing a Peer every logged-in session in a real
profile.

| Browser | Tool names | Available on |
|---|---|---|
| **Paseo Browser Control** | `browser_navigate`, `browser_click`, `browser_snapshot`, … | every seat, both runtimes — no extension, no flag |
| **Claude in Chrome** | `mcp__claude-in-chrome__*` | Claude seats, when the Chrome extension is connected **and** the provider sets `CLAUDE_CODE_ENABLE_CFC=1` |

Browser Control is the one that needs nothing: the daemon injects it, so it is
there on every seat of either runtime without an extension to install or a flag
to set.

Claude in Chrome needs the environment variable, and the `claude-lead` and
`claude-peer` provider blocks this pack generates set it. Without it a Paseo seat
gets **no** `mcp__claude-in-chrome__*` tools at all, no matter what
`~/.claude.json` says: a seat is non-interactive, and Claude Code's enablement
order turns the integration off for a non-interactive session *before* it ever
reads that config file. `CLAUDE_CODE_ENABLE_CFC` is checked above that gate,
which is what makes it work. The Supervisor is excluded on purpose — its policy
denies it the browser. See
[Why Claude in Chrome needs an env var on a seat](docs/claude-runtime.md#why-claude-in-chrome-needs-an-env-var-on-a-seat).

Paseo registers Browser Control on its own `/mcp/agents` server — the same one
that carries `create_agent` — gated on `daemon.browserTools.enabled` plus a
broker, never on the provider. The daemon injects that server into every agent
it starts, pi and Claude alike, so a pi seat reaches the browser through the
mcp proxy (`mcp({ tool: "browser_navigate" })`) exactly as it already reaches
`create_agent`.

That shared server is the one thing to be careful about, and the policy is
built around it: **the browser is classified by tool family, not by MCP
server.** Classifying by server is what used to switch a Peer's browser off
along with the orchestration wall. A Peer with the browser still cannot call
`create_agent` or any other Paseo tool on that server, and still cannot reach
an unrelated MCP server at all.

Because Browser Control rides the Paseo MCP server, it is also subject to
`paseo-mcp-protocol` (see [Preflight](#preflight)): when Paseo's bundled MCP
SDK refuses Claude Code's protocol header, the browser goes down with the rest
of the Paseo tool surface.

`daemon.browserTools.enabled: false` in `~/.paseo/config.json` removes the
browser from every seat on both runtimes; preflight reports that as a failure
rather than letting `BROWSER_MCP_AUTHORITY` silently grant nothing.

### Paseo inspect contract test

Because `peer_ask_lead` and the watchdog depend on JSON fields Paseo exposes,
the repo carries a contract test that runs against a live daemon. It stays out
of ordinary CI because it needs an existing agent; run it explicitly with a
chosen agent ID:

```bash
PASEO_CONTRACT_AGENT_ID=<real-agent-id> node test/paseo-contract.test.mjs
```

It verifies the agent appears in `paseo ls -g --json` and that `Id`, `Status`,
`UpdatedAt`, `PendingPermissions` and `ParentAgentId` are present in
`paseo inspect --json`. A missing field or a changed schema fails loudly.

### Required: pi-mcp-adapter (pinned)

Paseo tools reach the pi agent over MCP, and pi has no built-in MCP, so the
adapter must be installed at **the exact verified version**:

```bash
pi install npm:pi-mcp-adapter@2.19.0
```

Paseo then detects the adapter and passes `--mcp-config` when launching agents.
The Paseo MCP server lifecycle defaults to `lazy`, so tools are called through
the **`mcp` proxy tool**: `{ "connect": "paseo" }` → `{ "search": ... }` /
`{ "describe": ... }` → `{ "tool": "<name>", "args": { ... } }`. The role pack
policy already allows `mcp` for Lead/Supervisor and blocks it for Peers.

> If the machine ran an older experiment that left `paseo-role-bootstrap.ts` in
> `~/.pi/agent/extensions/`, delete it or rename it to `.disabled` — this
> extension replaces it, and both together inject duplicate prompts.

### Paseo configuration

The installers **do not merge** `~/.paseo/config.json` on their own — applying it
is a separate, explicit step, so that writing the file is always a decision you
made rather than a side effect of installing. Note that this controls *whether*
the change is written, not *when* it takes effect; see step 2:

1. Merge `config/paseo.providers.example.json` into `~/.paseo/config.json`
   (`agents.providers.pi-*` and `claude-*` + `daemon.mcp.injectIntoAgents: true`
   — required for agents to receive Paseo orchestration tools).
   For the `claude-*` half, `pteam claude-setup --apply` does that merge for you,
   generating the block from the code so the static tool policy in the config can
   never drift from the policy the hook enforces. It backs the file up, refuses
   to overwrite a provider you wrote, leaves an unparseable file alone, and does
   not reload anything. `--force` opts into overwriting, and records what it
   replaced so `--uninstall` can put your original back exactly **while the entry
   is still the one it wrote** — edit it afterwards and it is yours, so uninstall
   leaves your version in place instead of reverting it. The recorded original
   survives every later `--apply`, including ones that skip the name; uninstall
   then deletes the ledger along with the claim, so after it your entry is simply
   yours. `--print-providers` still prints the block if
   you would rather merge it yourself. The `pi-*` providers are not generated —
   copy those from the example file.
2. Reload the Paseo daemon. A reload is enough: `agents.providers` is reloadable
   and the registry is rebuilt live, so a full restart — which kills every
   running agent — is not needed. Providers do NOT appear in
   `paseo provider ls` until then, and because a seat reads its provider at
   spawn, only agents created *after* the reload pick the change up.

   Writing the file is the step you control; **when it takes effect is not.** A
   written-but-unloaded config is not dormant — it activates at the next reload
   *or restart*, whoever causes one, including an unattended restart or a crash
   recovery. Treat it as live from the moment you write it. See
   [the Install section](docs/claude-runtime.md#install) for the long form.
3. Run `/reload` in pi to load the new extension.

With no `PASEO_PI_ROLE`, both adapters are passive: they inject nothing and
restrict nothing, so the pack is safe to install globally on a machine that
also runs plain pi or plain Claude Code.

### Mixed fleet (Pi + Claude Code)

The same three roles run on either coding agent. The Paseo provider names the
family and the role — `pi-peer`, `claude-lead`, … — and one rule set covers
both: `extensions/paseo-team-core/` holds every decision, with a Pi extension
and a set of Claude Code hooks as adapters.

```bash
pteam claude-setup --install           # hooks + paseo-team MCP server
pteam claude-setup --print-providers   # the claude-* block for ~/.paseo/config.json
pteam claude-setup --verify --json     # exit 1 when incomplete
node scripts/preflight.mjs --runtime both
```

Practical differences to know when routing:

| | pi | Claude |
|---|---|---|
| model reference | `<pi-provider>/<model-id>` | bare id, e.g. `claude-opus-5` |
| thinking | `off\|minimal\|low\|medium\|high\|xhigh\|max` | `off\|low\|medium\|high\|xhigh\|max\|ultracode` |
| team tools | `peer_ask_lead`, `lead_ask_supervisor`, `team_watchdog`, … | `mcp__paseo-team__*` |
| Paseo tools | `mcp({ tool, args })` | `mcp__paseo__<tool>` |
| subagents | n/a | `Task` denied for every role — fan-out belongs to the Lead |

Mix Peers freely; keep one Lead per project on one family. Full architecture,
fail-closed behaviour and the install contract:
[`docs/claude-runtime.md`](docs/claude-runtime.md).

### Model routing (required for every create_agent)

For the 4-layer architecture and the no-silent-fallback mechanism see
[`docs/model-routing.md`](docs/model-routing.md). In short:

1. Per host (layer 1, never committed): pi + credentials + `~/.pi/agent/models.json`
   when using a custom provider. pi has no model discovery, so that file IS the
   catalog. For an OpenAI-compatible endpoint, copy
   `config/pi-models.example.json` → `~/.paseo-team-orchestration/pi-models.local.json` and
   run `pteam models sync`: it probes every model each endpoint lists, writes only
   the ones that answer, and derives each model's `reasoning` flag from that
   answer rather than from its name (`--no-probe`, or `probe: false` on one
   endpoint, skips all of that and keeps whatever an earlier run proved) — a wrong flag there makes Paseo report
   `thinkingOptions: "none"` and refuse every route above `thinking: off`. As many
   endpoints as you like can be configured under `providers`; they are written in
   one pass, and one whose endpoint is down keeps the models it already had
   instead of losing them (`--only <name>` syncs just one). The
   API key never enters that file: it names the env var and the file holding it.
   The daemon caches the catalog for its whole lifetime, so `models sync` ends by
   refreshing it; `pteam models refresh` does that step alone. A refresh that
   succeeds is what removes the need to restart the daemon — when it is skipped
   (`--dry-run`, `--no-refresh`) or fails, both commands say so and name the
   restart that finishes the job.
2. Copy `config/model-routing.example.json` →
   `~/.paseo-team-orchestration/model-routing.local.json` and fill in the host's REAL model
   IDs (5 classes: `MONITOR_ECONOMY`, `FAST_READ`, `CODING_MEDIUM`,
   `REASONING_HIGH`, `REVIEW_HIGH`). `pteam models` lists what every role
   provider on the host actually offers, both runtime families at once;
   `pteam models --provider <role-provider>` adds each model's thinking
   options. The WebUI routing form suggests the same list inline and narrows
   the thinking levels to the family of the provider you picked.
3. Cross-host: copy `config/cluster-routing.example.json` →
   `~/.paseo-team-orchestration/cluster-routing.local.json` on the CONTROLLER — a single
   file describing connection/required/capabilities/limits/routes for every
   host. Remote endpoints are referenced by **env var name** only, never by
   value. See [`docs/multi-host.md`](docs/multi-host.md). (The
   `hosts.local.json` host registry has been removed; the cluster file is the
   only source of hosts.)
4. The Lead passes an exact model into every `create_agent` as
   `pi-peer/<pi-provider>/<model-id>` + `settings.thinkingOptionId`, then checks
   it against `get_agent_status` runtimeInfo — any mismatch is
   `BLOCKED: MODEL_RESOLUTION_MISMATCH`, with no fallback. The Lead, not the
   Peer, owns observed routing evidence.
5. **Remote hosts** go through `remote-paseo.mjs`, never through MCP — see
   below.

**Which file is the source of truth.** Paseo ships its own
`~/.paseo/orchestration-preferences.json`, which picks a provider per task kind
(`impl`/`ui`/`research`/`planning`/`audit`). The pack does **not** read it and
never writes it. The split is by who creates the agent:

| Agent created by | Routed from |
|---|---|
| this pack (the Lead's routing cycle) | `cluster-routing.local.json` — the only source |
| Paseo's own orchestration skills (`paseo-committee`, `paseo-advisor`, `paseo-loop`, …) | `orchestration-preferences.json` — Paseo's business, left alone |

The two vocabularies are not a subset of each other: the pack routes by
MODEL_CLASS (task risk × disposition) **per host**, with a runtime family and a
verified thinking option, while Paseo's file has no host, no thinking level, no
capability filter and no family. Mapping between them would be lossy in both
directions, and reading both would give two ways to be wrong about which model
an agent is on — silently, which is the exact failure the routing cycle exists
to prevent. `pteam preflight` warns when `orchestration-preferences.json`
exists, so nobody edits the file the pack ignores.

### Reaching a remote host

The MCP injected into an agent always points at the LOCAL daemon: `--host` is a
CLI option, not an MCP argument. So every remote operation goes through

```text
<PASEO_TEAM_SCRIPTS_DIR>/remote-paseo.mjs
```

which reads the cluster file by HOST_ID, runs the Paseo CLI with `--host`,
never prints the endpoint, and returns a JSON envelope carrying `hostId`.

Covered operations: `health`, `providers`, `models`, `workspaces`,
`workspace-create`, `run`, `status`, `send`, `cancel`, `archive`.

`PASEO_TEAM_SCRIPTS_DIR` is an optional override — the installer's deterministic
default (`~/.pi/agent/extensions/paseo-team-scripts`) applies after a
shell/daemon restart. See [`docs/multi-host.md`](docs/multi-host.md) and the
Lead skill (LOCAL_CREATE_CYCLE vs REMOTE_CREATE_CYCLE).

### Compatibility matrix (verified 2026-08-04)

| Component | Version | Notes |
|---|---|---|
| Paseo CLI/daemon | 0.2.5 | `create_agent` schema, split-first-slash, runtimeInfo |
| Pi | 0.83.0 | `--model` (pattern), `--thinking` (7 levels), models.json |
| pi-mcp-adapter | 2.19.0 | **pinned**; lazy lifecycle, tool names prefixed `paseo_` |
| Node | ≥ 22.18 | type stripping on by default; CI runs 22.18 and 24 on ubuntu/windows/macos |

### Testing the tests

`npm test` answers "do the tests pass?". It cannot answer "would these tests
have caught the bug?", and on this repo the two came apart badly: a review of
one branch found nine real defects while all 139 tests were green.

```bash
npm run coverage    # which files does the suite never execute?
npm run mutate <mutations.json>   # break the code on purpose; does the suite notice?
```

Measured with both, the shape of the gap was consistent and is worth knowing
before adding a test here:

| Layer | Coverage when measured | Mutations killed |
|---|---|---|
| Rule modules (`policy-core`, `claude-policy`, `install-drift`, `workspace-protocol`) | 94–99% | 14 / 14 |
| Wiring (`paseo-team-policy.ts`, `preflight.mjs`, `uninstall.mjs`) | 0–48% | 6 / 12 |
| CLI error paths (`paseo-team.mjs`) | 82% line / **62% branch** | — |

Both wiring layers are covered now — `preflight.mjs` went from *never executed*
to ~80% including the whole N-host lane, `uninstall.mjs` from 0 to 94% — and 50
more defect-shaped mutations against them all die. Writing those tests turned up
four more defects of the same family, each one a place where two parts of the
pack answered the same question differently:

- preflight hardcoded `~/.pi/agent` while the installers honour
  `PI_HOME`/`PI_CODING_AGENT_DIR`, so an override made a correct install report
  three missing artifacts;
- `config-walker` read `PST_TEAM_CONFIG_DIR` while `model-routing.mjs` read
  `PASEO_TEAM_HOME`, so `pteam status` and `pteam preflight` could name
  different routing files on one host;
- the Pi adapter never asserted that the role prompt reaches the model at all;
- and preflight, whose own header says *"Never prints secret values"*, printed
  the remote pairing endpoint into the report whenever a remote daemon was
  unreachable — `execFileSync` puts the whole command line in its error
  message. `scripts/remote-paseo.mjs` already redacted exactly this; the second
  place running the same command with the same secret had not inherited it.

The CLI's own error paths were the last of it: 82% of lines but 62% of
branches, and almost every uncovered region an error path. `pteam models` with
the daemon down answered `{"ok": true}` and exit 0 — "unreachable" and "there
are no models" were the same answer — while `pteam models --provider X` failed
loudly on the same daemon. A bad role name printed a JavaScript stack trace. A
usage error exited 1 from most dispatchers and 2 from the top level and
`seats`. And the WebUI cache, which says it stores only successful answers,
keyed that on the exit code alone — so a graph taken while the daemon was down
was remembered for its whole window, which is the stale error the comment says
it avoids.

Every one of the nine defects was a **wiring** defect: a rule that exists, is
correct, is unit-tested, and is never called — or is called at the wrong
severity. Deleting preflight's whole workspace-protocol block, deleting its
whole install-drift block, and stopping the Pi adapter from injecting the role
prompt at all each passed the entire suite.

So when you add an enforcement rule here, the unit test for the rule is the
easy half. The half that has actually failed in this repo is the call site:
drive the real adapter or the real script, and assert the rule fires.

`npm run coverage` is a screen, not a verdict. `policy.test.mts` loads the Pi
adapter through a query-string specifier to get a fresh module per scenario,
and the reporter does not attribute that back to the base file — so lines that
demonstrably execute are still listed as uncovered there. Confirm with
`npm run mutate`, and do not put a coverage floor on that file.

### Preflight

```bash
node scripts/preflight.mjs            # human-readable
node scripts/preflight.mjs --json     # machine-readable, exit 1 when any check fails
node scripts/preflight.mjs --strict --host-id <host-id>
                                      # cross-host gate: missing cluster config,
                                      # missing required remote endpoint env, or
                                      # unverifiable thinking → FAIL (never warn-as-pass).
                                      # "Unverifiable" means the daemon said
                                      # NOTHING about thinking. A model that
                                      # reports it has none (thinkingSupported:
                                      # false, or an empty option list — how
                                      # claude-haiku-4-5 reports itself) is a
                                      # verified fact, and routes fine at
                                      # thinking: off. See docs/model-routing.md.
```

Checks: node/git/paseo + version pins, the daemon, the adapter (pin), the
extension, the shared policy modules, role prompts, the role providers of every
runtime in scope, **each healthy provider's model inventory**, routing config
(single-host + cluster contract), each route against the real inventory,
provider status, empty model segments, pi's per-model `thinkingLevelMap` (a
`null` level means the level gets clamped), endpoint env vars, **whether every
installed copy still matches this release** (`install-drift`), **the target
repository's protocol** (`workspace-protocol`), the pack's config directory
after the two-variable unification (`team-config-dir`), and repository state (a
writer host must be clean in strict mode).

No secret is ever printed. That is a real invariant and not a hope: an endpoint
is a pairing offer, it travels only inside argv, and `remoteExec` redacts it
from anything a failing subprocess hands back — `execFileSync` puts the whole
command line into its error message, which is how the value used to reach the
report on the single most likely failure of the remote lane.
`test/preflight.test.mjs` asserts the value appears nowhere in the JSON report,
on the healthy path and on the unreachable one.

**Upgrading the package is only half an upgrade.** The policy core, the role
prompts and the Lead skill are COPIED into `~/.pi/agent/` at install time, and
that copy is what a running agent loads. `pteam update` (or `npm i -g`)
replaces the binary and leaves those copies alone — so an upgrade that stops
there runs a new CLI over the previous release's rules, with both halves
reporting the new version number and nothing disagreeing out loud. Always
follow an update with:

```bash
pteam install     # refresh the copies under ~/.pi/agent
pteam preflight   # confirm they match this version
```

`pteam update` says this in its `nextSteps`, and on stderr when it upgrades.

The second line is a real check, not a hope. `install-drift` hashes every
installed artifact — the pi adapter, the shared policy core, the three role
prompts, both skills on both runtimes, and the support scripts — against the
package preflight is running from, and reports each file as `changed`,
`missing` or `unexpected`. That last one is the leftover case: a support script
or a built `.js` from an older release, still sitting in a directory this pack
replaces wholesale.

It has to be a byte comparison. The `policy-core` check above proves the
installed module loads and exports the policy API — which a core from three
releases ago does just as well, which is exactly how a half-upgraded host looks
healthy. `pteam prompts write` and `pteam skills write` deliberately edit the
installed copies; a difference there is still drift — the rules a running agent
enforces are not this release's — but the remedy line says that `pteam install`
will overwrite the edit, because a check that tells someone to destroy their own
customization without saying so is worse than one that says nothing.

Drift is a warning by default and a failure under `--strict`, because
"the rules a running agent enforces are not the rules this CLI reports" is the
unverifiable state `--strict` exists to reject. Two things are deliberately not
drift: an unknown file in `~/.pi/agent/extensions/prompts/`, which is a shared
directory, and a CRLF copy of otherwise identical content.

No manifest is written at install time. Upstream Paseo ships one
(`foundation/manifest.json`, a sha256 per distributed file) because the source
bytes are not on the target host; ours are, since preflight runs from the
package itself — so a manifest would be a third copy that can go stale on its
own.

The Claude half registers an ABSOLUTE node path in `~/.claude/settings.json`
(hooks) and `~/.claude.json` (MCP), because a hook may run without the user's
`PATH`. That path is chosen at install time and is the one thing the installer
references rather than writes, so it is also the one thing that can rot: under
a version manager, `process.execPath` is an exact patch directory
(`.../installs/node/22.23.2/bin/node`) and the next `mise upgrade node` deletes
it. The pack is fail-closed — a hook that cannot start DENIES — so a retired
node version would take every Claude seat on the host offline with no message
naming the cause.

Two things keep that from being silent. `--install` prefers the most durable
version-alias of the running interpreter that still satisfies `engines`
(`.../installs/node/22/bin/node`), never trading the major version away, and
`PASEO_TEAM_NODE_EXEC` overrides the choice outright. And `--verify` checks the
registered interpreter, not just the script — so `pteam preflight` reports
`missing interpreter:<path>` with the fix, instead of the host quietly denying
everything.

**A provider reporting `available` is not a promise that anything is routable
through it.** `available` describes the provider; the model inventory is a
separate question, and `list_models` can come back EMPTY on a provider that
passes every health check — observed on `pi-peer`. That is the same shape of
trap as a permission that looks granted while the daemon never registered the
tool. Preflight now calls `list_models` for every healthy role provider and
warns (fails under `--strict`) when the answer is empty, so always check the
inventory before routing to a provider — never the status alone.

`--runtime pi|claude|both` selects which families the host is expected to
serve; with no flag it detects them from the installed CLIs, so a Claude-only
host is not reported as a broken pi host. In Claude scope it also verifies the
three hooks and the `paseo-team` MCP registration.

Two of those checks are about the browser and the tool surface it shares:

- **`paseo-browser-tools`** — `daemon.browserTools.enabled` in
  `~/.paseo/config.json`. `false` means no seat has a browser on either
  runtime, so `BROWSER_MCP_AUTHORITY` grants nothing.
- **`paseo-mcp-protocol`** — Paseo injects its MCP server into every agent over
  HTTP, and its bundled `@modelcontextprotocol/sdk` rejects a protocol header
  newer than the revisions it knows. Claude Code sends its own latest rather
  than the negotiated version, so every post-handshake request 400s and a
  Claude seat loses `create_agent`, `send_agent_prompt`, `list_agents`,
  `respond_to_permission` and Browser Control at once — with nothing in the
  seat's transcript to explain it, only a line in `~/.paseo/daemon.log`. Fix:

  ```bash
  node scripts/patch-paseo-mcp.mjs --apply     # then restart the daemon
  node scripts/patch-paseo-mcp.mjs --verify    # exit 1 when unpatched
  node scripts/patch-paseo-mcp.mjs --revert
  ```

  It relaxes exactly one condition, in the two dist builds that carry it: a
  header version is still rejected unless it is a well-formed `YYYY-MM-DD`
  revision NEWER than everything the SDK knows. `SUPPORTED_PROTOCOL_VERSIONS`
  is untouched, so the handshake still negotiates the SDK's real latest — the
  server never claims a protocol it does not implement. A pristine backup is
  written beside each file on the first apply. **Re-run it after every
  `npm i -g @getpaseo/cli`**: an upgrade replaces `node_modules` and silently
  reverts the patch.

## CLI and WebUI

`pteam` (long alias: `paseo-team`) is the pack's CLI and the single writer for
everything the pack configures. The WebUI is an extension of that CLI, not an application beside
it: it maps an HTTP route onto a fixed `pteam` argv, spawns it, and renders
the JSON. It never touches a file and never calls `paseo` itself, so anything
you see in the browser can be reproduced in a terminal — the UI prints the exact
command behind every panel.

Install and quick start: see [Quick start](#quick-start) at the top of this
README.

```bash
node cli/paseo-team.mjs --help          # or `npm link` once, then `pteam`
pteam status                            # paths + presence, machine readable
pteam graph                             # agents, spawn tree, pending permits
pteam cost --cluster <id>               # per-agent + summed cost for one cluster
pteam activity <ref> --tail 5 --max-chars 2000
                                        # one agent's activity, capped PER ENTRY
pteam permits list
pteam seats list                        # custom seats + the providers they generate
pteam seats apply                       # write those providers into ~/.paseo/config.json
pteam models sync                       # rebuild pi's catalogs from their endpoints, then refresh
pteam models refresh                    # daemon re-reads the catalog, without a restart
pteam web --port 4321 --open            # prints http://127.0.0.1:PORT/#token=...
```

The web server binds `127.0.0.1`, requires a per-run bearer token (handed to the
page through the URL fragment so it never reaches a server log), and checks
`Origin`/`Host` against DNS rebinding. `--no-token` exists for a throwaway demo
and says so loudly: this UI can approve permission requests.

Two different things are called "permission", and the UI keeps them apart:

- **Runtime permit** — one tool call is blocked right now and a human has to
  answer: `paseo-team permits list|allow|deny`, delegating to `paseo permit`.
  Every decision is appended to `~/.paseo-team-orchestration/permit-audit.jsonl` *before*
  the daemon is asked, so a decision that was made stays visible even if the
  delegate call then fails.
- **Policy authority** — what a role may do at all: the allowlists in
  `extensions/paseo-team-policy.ts`, `PASEO_TEAM_LEAD_WRITE`,
  `PASEO_TEAM_EXTRA_TOOLS`, and the V3 brief authority fields. The UI renders
  this read-only, with one deliberate exception: the **Ghế tuỳ biến** tab builds
  seats (see [Custom seats](#custom-seats--named-variants-of-the-three-roles)),
  and a seat grants only capabilities from a catalog that lives in code. There
  is still no way to type a tool name into the browser and have it granted, and
  no "grant everything" button.

Three of those commands exist because Paseo's own surface answers the wrong
shape of question for a fifteen-Peer project:

- **`pteam cost`** — `list_agents` has no cost field and `get_agent_status`
  has one per agent, so the only way to total a project's spend was to call
  inspect once per seat and add the numbers by hand. `pteam cost --cluster <id>`
  does it in one command, sorted most expensive first. The cluster is the unit
  because it is already the pack's authority boundary. A seat Paseo reports no
  usage for is named in `unavailable`, never counted as zero — a total that
  silently omits a seat is worse than one that admits the gap. The numbers come
  from `paseo inspect → LastUsage` and are reported under that name rather than
  relabelled, because the daemon's own framing is the only thing the pack can
  vouch for.
- **`pteam models refresh`** (and the last step of `models sync`) — Paseo caches
  each provider's model list for the daemon's whole process lifetime. Rewrite
  `~/.pi/agent/models.json` and `paseo provider models pi-peer` keeps answering
  with the old list; `paseo reload` does not help either, because it reloads
  daemon config rather than the provider snapshot. The only documented cure was
  restarting the daemon, which drops every live agent connection over a
  read-only change. The daemon does accept a `refresh_providers_snapshot_request`
  (permission `daemon.read`) — the `paseo` CLI simply never exposed it. This is
  the one command in the pack that reaches Paseo through its client SDK instead
  of argv, and `cli/lib/paseo-bridge.mjs` still owns it so the rule that holds is
  "one place talks to Paseo", by any transport. It fails closed: an unreachable
  daemon, a missing SDK or a Paseo too old to know the message all report the
  catalog as still stale and name the restart that would finish the job.
- **`pteam activity`** — `get_agent_activity`'s `limit` bounds how many entries
  come back and says nothing about how big one is. One entry can be a Peer's
  whole `PEER_MESSAGE_V1` report, so `limit: 3` routinely returns hundreds of
  kilobytes of text that is usually already in a file on disk. `--max-chars`
  caps each entry INDEPENDENTLY, reports the original size and what it withheld,
  and leaves short entries whole. The other half of that fix is a convention,
  not a flag: a Peer's report points at its artifact instead of resending it
  (`prompts/peer.md`, and the Peer output contract in the Lead skill).

Cost note, because it shapes the whole design: every `paseo` invocation costs
~3s of process startup on Windows regardless of the query. `paseo-team graph`
therefore batches a whole snapshot per call, caches the spawn tree in
`~/.paseo-team-orchestration/graph-cache.json` (`paseo ls` does not carry the parent link —
only `inspect` does), and spends at most `--max-inspect` lookups per run. A cold
cache fills over a few polls; a warm one answers in ~3.8s. Anything that could
not be collected is reported in `degraded[]` rather than quietly missing.

See `docs/webui-architecture.md` for the full contract, the graph schema, and
what is still missing (agent-to-agent message edges, multi-host).

## Debug commands

| Command | Purpose |
|---|---|
| `/team-role` | Prints the current role, peerMode, and the allow/deny policy. |
| `/team-tools` | Prints the whole tool registry: name, source, active/inactive, role. Writes `~/.pi/team-tools.txt`. |

Use `/team-tools` to settle the real allowlist — actual Paseo tool names can
differ from the defaults. Extra per-profile tools can be added with
`PASEO_TEAM_EXTRA_TOOLS="tool-a,tool-b"`.

## Proof-of-concept (single machine, Windows first)

The POC scenario uses any scratch repo **outside** the role pack (the original
was a `calculator.py` + `test_calculator.py` with a deliberate bug). The role
pack ships no test repo — create an equivalent scratch repo anywhere.

| # | Test | Expected |
|---|---|---|
| 1 | `PASEO_PI_ROLE=lead pi`, ask it to list providers/models | Lead sees Paseo tools and reports which ones it used |
| 2 | `PASEO_PI_ROLE=peer pi`, ask "Create another agent to inspect the repository" | `create_agent` absent or blocked; Peer returns `DEPENDENCY_REQUEST` |
| 3 | Ask the Supervisor to fix `calculator.py` | Refuses, sends an observation instead |
| 4 | Lead creates a Scout: read-only Peer, same workspace | Lead receives the completion notification |
| 5 | Lead creates an Engineer with `--isolation worktree` | Engineer fixes the bug, runs tests, reports the SHA |
| 6 | Independent Reviewer: `MODE: read-only` + `DISPOSITION: independent-reviewer` | Verifies the exact SHA, returns a verdict, fixes nothing |
| 7 | Give the Lead a small reversible choice with evidence on both sides (e.g. retry a step that failed once) | Lead sends `lead_ask_supervisor` instead of asking you; the Supervisor replies with a filled `SUPERVISOR_DECISION`; the Lead acts on it without asking you to confirm |
| 8 | Same, but ask it to push the branch | Lead goes to you directly, and says the reason is that the matter is irreversible |
| 9 | Archive the Supervisor, then repeat test 7 | `lead_ask_supervisor` reports `NO_SUPERVISOR_SEAT`; the Lead either seats one or asks you **and says that is why** |

## First-release completion criteria

```text
[x] pi-supervisor receives the right prompt
[x] pi-lead receives the right prompt
[x] pi-peer receives the right prompt

[x] Lead sees Paseo orchestration tools (via the mcp proxy, 60 tools)
[x] Supervisor sees monitoring tools only (fail-closed allowlist)
[x] Peer cannot see or call orchestration tools

[x] Read-only Peer does not modify files
[x] Engineer Peer can write inside an isolated workspace
[x] Lead is notified when a Peer finishes
[x] Lead can send a correction with send_agent_prompt (verified supervisor → lead; same tool)
[x] Reviewer runs as a fresh, read-only session
[x] The workflow completes with Paseo + the Pi extension + the Lead skill alone
```

Result on Windows, 2026-08-04, model `Minnyat/deepseek-v4-flash` — all 6 passed:

- **T1** Lead listed providers/models through mcp.
- **T2** Peer refused to spawn an agent and returned `REOPEN_REQUEST`.
- **T3** Supervisor was blocked from editing code and routed the task to the
  Lead with `send_agent_prompt`. The first run exposed a terminal-bypass hole
  through mcp, since patched with a fail-closed allowlist.
- **T4** Scout ran read-only and sent a completion notification.
- **T5** Engineer fixed 2 bugs in a worktree, 3/3 tests passing, reported the
  SHA, and the Lead verified it.
- **T6** The independent reviewer REFUSED because the working tree was dirty,
  even though the SHA matched — protocol over convenience.

## Development

Dev dependencies are pinned in `package.json` + `package-lock.json`, and CI
installs exactly that lockfile with `npm ci`:

```bash
npm ci              # installs @earendil-works/pi-coding-agent, @types/node, typescript
npm test            # runs every test/*.test.{mjs,mts}
npm run typecheck   # tsc --noEmit -p tsconfig.ci.json
npm run check       # both
```

Node **22.18+ or 23.6+** runs `.ts`/`.mts` directly thanks to type stripping
being on by default. Run a single suite when narrowing something down:

```bash
node test/policy.test.mts          # policy + per-turn lifecycle regression
node test/model-routing.test.mjs   # routing resolver regression
node test/remote-paseo.test.mjs    # remote executor regression (fake CLI)
node test/lib-common.test.mjs      # shared helpers: exec resolution, shims, versions
```

The root `tsconfig.json` is dev-only and machine-specific, so it is gitignored;
CI and `npm run typecheck` use the in-repo `tsconfig.ci.json`.

Smoke-test extension loading without an LLM (prints the mode):

```bash
PASEO_PI_ROLE=lead pi -e ./extensions/paseo-team-policy.ts -p "/team-tools"
```

## Design principles (summarized from the deep dive)

- Paseo is the only control plane: agent/workspace state is always read from
  Paseo, including in multi-host setups.
- The git commit SHA is the anchor between writer and reviewer.
- A Peer is an independent co-worker, not a function call; a brief carries no
  disguised verdict, and the Peer may answer `REOPEN_REQUEST` /
  `DEPENDENCY_REQUEST` / `BLOCKED`.
- One writer per moving scope; worktree isolation whenever writers run in
  parallel.
- The Supervisor is a governance plane: it observes, never edits code, and never
  directs Peers.
- Model and workspace IDs must be inspected (`list_providers`, `list_models`),
  never guessed.

## Star history

<a href="https://star-history.com/#Minnyat/paseo-team-orchestration&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=Minnyat/paseo-team-orchestration&type=Date&theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=Minnyat/paseo-team-orchestration&type=Date" />
    <img alt="Star history chart for Minnyat/paseo-team-orchestration" src="https://api.star-history.com/svg?repos=Minnyat/paseo-team-orchestration&type=Date" width="640" />
  </picture>
</a>

## License

[MIT](LICENSE).

`package.json` keeps `"private": true` on purpose: this role pack installs via
`scripts/install.{sh,ps1}`, never through `npm install`, so the flag guards
against an accidental `npm publish`. It does not restrict use — the MIT license
governs that.
