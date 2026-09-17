# Claude Code as a team runtime

The pack runs three roles — Supervisor, Lead, Peer. This document is about the
second runtime those roles execute on. Pi loads a policy extension; Claude Code
has no extension API, so the same rules are bound through user-level hooks and
one small MCP server. Nothing about the roles changes: same prompts, same V3
task brief, same authority gates, same Paseo control plane.

## Why it is possible at all

Paseo treats `claude` as a first-class provider and lets a derived provider
carry `env` and `disallowedTools`:

```jsonc
"claude-peer": {
  "extends": "claude",              // BUILTIN_PROVIDER_IDS includes "claude"
  "label": "Claude Peer",
  "env": { "PASEO_PI_ROLE": "peer" },
  "disallowedTools": ["Task", "Agent", "WebFetch", "WebSearch"]
}
```

A **seat** is that same shape with a name and a curated grant on top —
`claude-peer-researcher`, still `PASEO_PI_ROLE=peer`, plus
`PASEO_TEAM_EXTRA_TOOLS=WebFetch,WebSearch` and those two names removed from
`disallowedTools`. `pteam seats apply` generates it; the deny list is recomputed
by `claudeDisallowedTools(role)` **under the seat's own environment**, so the
static and dynamic layers can never disagree about a grant. See README, *Custom
seats*.

The daemon runs that provider through the Claude Agent SDK with
`settingSources: ["user", "project", "local"]`, so hooks configured in
`~/.claude/settings.json` are loaded, and with a `canUseTool` callback, so
Paseo's own permission flow (`list_pending_permissions` /
`respond_to_permission`) keeps working unchanged. It also injects its MCP
server under the name `paseo`, which is why Paseo tools appear to a Claude
agent as `mcp__paseo__<tool>`.

## Three layers, one rule set

```text
              extensions/paseo-team-core/policy-core.ts
              (briefs, authority, allowlists, git guard)
                        ▲                  ▲
        ┌───────────────┘                  └───────────────┐
extensions/paseo-team-policy.ts        extensions/paseo-team-core/claude-policy.ts
   pi extension API                             Claude tool dialect
   setActiveTools + tool_call                          ▲
                                            scripts/claude-hook.mjs
                                     SessionStart / UserPromptSubmit / PreToolUse
```

`policy-core.ts` imports nothing from any runtime. A rule that lives in only
one adapter is a rule the other runtime silently lacks, so both adapters route
every decision through the core — `test/ocr-integrity.test.mjs` asserts that
both import it.

The subdirectory is deliberate: pi discovers `~/.pi/agent/extensions/*.ts` as
extensions, and enters a subdirectory only when it carries an index or a `pi`
package.json. `paseo-team-core/` has neither, so the core stays invisible to
that scan while remaining plain `.ts` — which matters because the repo's own
OCR review harness only selects TypeScript sources, and files it cannot select
are files nobody reviews.

## Vocabulary translation

| | pi | Claude Code |
|---|---|---|
| read | `read` | `Read`, `Glob`, `Grep`, `NotebookRead` |
| write | `write` | `Write` |
| edit | `edit` | `Edit`, `MultiEdit`, `NotebookEdit` |
| shell | `bash` | `Bash`, `BashOutput`, `KillShell` |
| Paseo tools | `mcp({ tool, args })` proxy | `mcp__paseo__<tool>`, args are the tool input |
| team tools | registered by the extension | `mcp__paseo-team__*` (stdio MCP server) |
| deny mechanism | `setActiveTools` + `tool_call` block | provider `disallowedTools` + `PreToolUse` deny |

Two layers on the Claude side, mirroring pi's allowlist + backstop:

1. **Static** — `claudeDisallowedTools(role)` goes into the provider override,
   so the model never sees a tool the role can never use under any brief.
2. **Dynamic** — the `PreToolUse` hook decides per call, because peer write,
   browser and git authority are properties of the CURRENT brief.

## The per-turn brief across processes

The Pi extension keeps the parsed brief in memory and recomputes it on every
`before_agent_start`. Claude runs each hook in its own process, so the brief
travels through a file:

```text
UserPromptSubmit  parse the prompt → ~/.paseo-pi-team/claude-sessions/<id>.json
PreToolUse        read that file → decide → allow / deny
```

Fail-closed on every axis, exactly like an unbriefed pi peer:

- no state file, stale (>12h) or corrupt → read-only;
- state says nothing → fall back to the session transcript's last human
  message (tool results are skipped — they are user-role messages too);
- the hook itself throws → **deny**, with the reason naming the failure.

Authority is never inherited: a turn whose prompt carries no V3 brief drops
write mode even if the previous turn had it.

### The role contract across turns

The two runtimes do not inject the role prompt the same way, and the difference
is not cosmetic:

| | pi | Claude Code |
|---|---|---|
| where | the turn's **system prompt** | `additionalContext` — content of the **user turn** |
| when | rebuilt on **every** `before_agent_start` | **once** per session (`SessionStart`, or the first prompt when that hook never ran) |

A Lead fifty turns into a Claude session therefore had its authority contract
far behind it, outweighed by the model's own default posture of checking with
the human before anything consequential — which is exactly what a delegated
supervisor decision is not supposed to need. Re-sending the whole prompt every
turn would cost ~2.5k tokens a turn to say something that only sometimes
matters, so the hook splits it:

- **every** Lead turn carries a short standing-authority block (routing,
  delegation, correction and acceptance are the Lead's calls; only irreversible
  steps go to the Human);
- a turn that **opens with a supervisor message** re-injects the full role
  prompt, because that is the turn where the contract decides the answer.

### A supervisor message, on either runtime

`send_agent_prompt` has no channel of its own: a Supervisor's block arrives as
an ordinary user prompt, indistinguishable from the Human typing. So both
adapters run it through `policy-core.ts` and put one shared notice in the turn:

1. `parseSupervisorBlock` — is this actually a block, and is it a decision?
2. `supervisorAttribution` — does `FROM_AGENT_ID` resolve, in Paseo's own agent
   state, to a seat whose provider is a Supervisor role provider? Unresolvable
   or not-a-Supervisor ⇒ `SUPERVISOR_SENDER_UNVERIFIED`, and the message never
   binds. This is what stops the directive below from becoming a lever anything
   can pull by typing the header. It is not authentication — provider and
   parentage are declared labels — it catches mistakes, drift and stray text.
3. `supervisorTurnVerdict` — jurisdiction under `multi` (unchanged), then the
   sender check on both topologies.
4. `supervisorTurnNotice` — the verdict **and what to do about it**: `ACT ON IT
   … needs NO Human round-trip` on the binding path, `Do NOT act on it, reply
   BLOCKED: <code>` on the refusing one.

The notice is context, not a deny: nothing here blocks a tool.

## What Claude roles may do

| | Supervisor | Lead | Peer |
|---|---|---|---|
| Read/Glob/Grep | yes | yes | yes |
| Bash | no | yes | yes, guarded |
| Write/Edit | no | only with `PASEO_TEAM_LEAD_WRITE=1` | only with `MODE: write` + `EDIT_AUTHORITY: allowed` |
| `mcp__paseo__*` (orchestration) | monitoring + `create_heartbeat`/`delete_heartbeat` + gated lead-recovery `create_agent` | full Lead allowlist + permissions | none |
| `mcp__paseo-team__*` | `team_watchdog`, `team_fork`, `team_lease` (`status` only) — it RECEIVES `lead_ask_supervisor` consults, never sends one | those three with `team_lease` unrestricted, plus `lead_ask_supervisor` | `peer_ask_lead` only |
| `mcp__paseo__browser_*` (Browser Control) and `mcp__claude-in-chrome__*` | no | yes | yes, unless the brief says `BROWSER_MCP_AUTHORITY: denied` |
| `Task` (Claude subagents) | no | no | no |
| `AskUserQuestion` | yes | no | no |
| `Skill` | yes, minus the pack's own packages | yes, `paseo-team-lead` included | yes, `paseo-ocr-reviewer` under a reviewer brief |

`Task` is denied for every role on purpose: a Claude subagent runs outside
Paseo, so it carries no role prompt, no brief authority, and never appears in
the team graph. Fan-out belongs to the Lead, through Paseo.

`AskUserQuestion` is denied for the Lead and the Peer for the mirror-image
reason: the escalation chain is Peer → Lead → Supervisor → Human, and a
structured ask-the-user tool is the door that skips two links of it. pi never
exposed one to any role, so leaving it open on Claude was also a cross-runtime
authority asymmetry — a rule denied on one runtime denied on the other is the
whole point of the shared core. It removes the interrupt, not the voice: a
Lead's own turn output still reaches the Human it is talking to, which is where
the irreversible actions `lead.md` reserves for them belong.

`Skill` stays available to every role, because the user's own skills go through
it and a pack that ate them would be a worse neighbour than the drift it is
preventing. What is gated is the PACKAGE, per call, against the admission table
in `policy-core.ts` — see [Skill admission](../README.md#skill-admission) for
the table and for how the same rule is enforced on pi, which has no `Skill`
tool. Until the installer wrote `~/.claude/skills/`, this was moot in the worst
way: the Lead prompt's invariant 1 says to load `paseo-team-lead`, the tool call
was allowed, and the skill was only ever copied to `~/.pi/agent/skills/`, which
Claude Code does not read. The Lead orchestrated without the procedure and
nothing said so.

Browser Control (`browser_*`) is registered by Paseo on the SAME MCP server as
`create_agent`. It is classified by tool family rather than by server, or the
Peer's orchestration wall takes the browser down with it — which is exactly
what it used to do.

The Peer bash guard is unchanged from pi: no Paseo CLI,
no commit/push without the matching authority, force-push and merge never, and
a granted push is branch-scoped to exactly
`git push -u origin HEAD:refs/heads/agent/<TASK_ID>`.

## Install

`scripts/install.{sh,ps1}` does this automatically when the `claude` CLI is
present. Manually:

```bash
node scripts/claude-setup.mjs --install          # hooks + the paseo-team MCP server
node scripts/claude-setup.mjs --apply            # the claude-* providers -> ~/.paseo/config.json
node scripts/claude-setup.mjs --verify           # exit 1 when incomplete
node scripts/claude-setup.mjs --print-providers  # print the block instead, for a manual merge
pteam claude-setup --verify --json               # same thing through the CLI
```

`--apply` merges the three `claude-*` providers into `~/.paseo/config.json`. It
follows the same ownership rule as the two files above:

- it backs the file up before writing, and writes atomically;
- a config it cannot parse is reported and left byte-for-byte alone — it is
  never treated as a fresh file and overwritten;
- a provider **you** wrote is reported as skipped, never overwritten;
- a provider we created and you then **deleted** stays deleted;
- `--force` opts into both of those, and additionally retires a provider this
  pack no longer generates even if you have edited it since — plain `--apply`
  leaves that one alone;
- `--force` records what it replaced, so `--uninstall` can put your original
  back exactly **while the entry is still the one we wrote**. Edit it afterwards
  and it becomes yours: `--uninstall` then leaves your version in place rather
  than reverting it. The record of your original survives every later `--apply`,
  including runs that skip the name because you now own it — but `--uninstall`
  deletes the ledger along with our claim, so the recorded original goes with it
  in the same call that decides to leave your version alone. Uninstall is
  terminal: after it, your entry is simply yours and there is nothing of ours
  left to revert to.

What it owns is tracked in `~/.paseo-pi-team/claude-provider-ledger.json` —
deliberately a different file from the seat ledger, so that `pteam seats apply`
and this command can never delete each other's providers.

`--apply` does NOT reload the daemon, on purpose: there is no flag that makes it,
because an installer that can reload is one an unattended script will eventually
run against a host full of live agents. Reload yourself when you are ready:

```bash
paseo daemon reload
```

A reload is enough — a restart is not required, and restarting kills every
running agent on the host. `agents.providers` is one of the server's
`RELOADABLE_PATHS`, so the provider registry is rebuilt live and the providers
then appear in `paseo provider ls`.

Reloading does not re-configure the agents already running. Providers are read
at SPAWN: a seat keeps whatever its provider said at the moment it was created,
so existing seats keep the old settings and only newly created seats pick up the
change. Nothing you do to this file reaches an agent that is already up.

**A written-but-unloaded config is not dormant.** It is tempting to read the
step above as "it takes effect when you decide to reload", and that is not what
the file means. It takes effect at the next reload **or restart**, whoever or
whatever causes one — an unattended restart, a second operator, a crash
recovery. This is not hypothetical: a daemon on the development host restarted
with nobody instructing it and took 9 of 16 live seats with it. So `--apply` is
not a staging step you can leave half-finished; treat the config as live from
the moment you write it, and if you are not ready for the change to take
effect, do not apply it yet.

One known race, stated rather than hidden: `~/.paseo/config.json` has a second
writer. The daemon persists config itself, and the app can edit providers while
it runs. `--apply` writes atomically — a rename over the destination, so no
reader ever sees a half-written file — but atomicity of the *write* is not
atomicity of the read-modify-write *sequence*. There is no lock and no
compare-and-swap in this path. `--apply` re-reads the file immediately before
writing and refuses if it changed underneath, which turns a silently lost daemon
write into a reported conflict you can re-run; it narrows the window to the
moment between that final read and the rename, and does not close it. A lockfile
would close it and buy a stale-lock failure mode on a daemon host, which is the
worse trade.

This is observed, not hypothesised. On 2026-09-09 at 08:48:56 the file changed
on the development host mid-task, flipping `daemon.relay.enabled` from `false`
to `true` — a live-reloadable network-posture setting, and the first entry in
the server's `RELOADABLE_PATHS`. The writer was the **Paseo app's own UI**,
acting on the operator's deliberate toggle.

That makes the case for the check stronger, not weaker. A daemon rewriting this
file spontaneously would be exotic and rare, and easy to dismiss as a corner
case. An operator running `--apply` in a terminal while their Paseo app sits
open in another window is an ordinary Tuesday — so the second writer is the
**common** case, not the unlucky one.

It is also the real argument against a lockfile. A lock held during `--apply`
would contend with the operator's own app, which is to say with the person
running the install: a worse failure than the silent lost update it was meant to
prevent, and worse again on a host running many seats where a stale lock strands
everything. If an apply ever reports `conflict`, re-running it is the correct
response.

Both target files belong to the user and already carry other tools' entries
(Paseo installs its own hooks in the same settings file), so every write
merges: our entries are tagged `paseo-team-role-policy`, and only tagged
entries are replaced or removed. A file that cannot be parsed is reported and
left byte-for-byte alone.

`~/.claude.json` gets exactly one server: `paseo-team`, which is ours and is
rewritten on every install.

It used to get a second, `agent-browser`, so that the browser rows in the table
above pointed at something the runtime had actually registered. That server is
gone — the browser a Claude seat uses is now one it already has (Claude in
Chrome, and Paseo Browser Control on the server the daemon injects), so there
is nothing left for this installer to register. What it does instead is
REMOVE an `agent-browser` entry a previous version of itself wrote, and leave
alone one the user configured, which is the same ownership rule the merge
always followed — dropping our integration is not a licence to delete theirs.

### Why Claude in Chrome needs an env var on a seat

`mcp__claude-in-chrome__*` is off in a Paseo seat unless the provider sets
`CLAUDE_CODE_ENABLE_CFC=1`, which is why the `claude-lead` and `claude-peer`
blocks carry it.

Claude Code decides the integration by walking a fixed list of tests and taking
the first that matches. Two of them are levers you can pull — `--chrome` and
`CLAUDE_CODE_ENABLE_CFC` — and both sit ABOVE this one:

> the session is NOT interactive → **off**

Below that sits the test that reads `claudeInChromeDefaultEnabled` from
`~/.claude.json`. That ordering is the whole problem. A human's terminal is
interactive, falls through the gate, reaches the config, and gets the browser.
**A Paseo seat is non-interactive by construction**: it dies at the gate and
never consults the config at all. Setting `claudeInChromeDefaultEnabled` on the
host is therefore not a fix — no seat ever reads it.

`CLAUDE_CODE_ENABLE_CFC` is evaluated above the gate, so it is the one lever a
non-interactive seat can actually pull. The other one, `--chrome`, would mean
overriding the provider's `command` array, which discards the absolute binary
path Paseo already resolved and re-exposes the spawn to a `PATH` lookup — so the
environment variable is the supported route.

The Supervisor deliberately does NOT get it: its tool policy denies every
browser surface (see the table above), and a seat that advertises tools its own
`disallowedTools` rejects on every call is a contradiction.

The enablement order and the fact that the string `"1"` coerces to true were
read from and measured against **Claude Code 2.1.263**. That is a fact about a
version, not a promised contract: if a later version reorders the tests or stops
coercing the string, seats lose Chrome silently, and this paragraph is the place
to start looking.

## Mixed-fleet routing

`paseoProvider` in a route names the family and the role. Both families can
serve the same host; only the reference shapes differ:

| | pi | Claude |
|---|---|---|
| provider | `pi-peer` | `claude-peer` |
| model | `<pi-provider>/<model-id>` (may contain more slashes) | bare id, e.g. `claude-opus-5` |
| thinking | `off\|minimal\|low\|medium\|high\|xhigh\|max` | `off\|low\|medium\|high\|xhigh\|max\|ultracode` |

`scripts/model-routing.mjs` validates the shape per family: a pi-shaped model
on a Claude route is a config error, not something to normalise. The graph
carries the family on every node (`family: "pi" \| "claude"`), so a mixed fleet
stays legible in `pteam graph` and the WebUI.

Rule of thumb: mix Peers freely, keep ONE Lead per project on ONE family for
the life of that project — the Lead is the deterministic part of the loop.

### Every Claude agent needs an explicit mode

A permission mode belongs to the provider and is never inherited across
providers. The check fires when the TARGET provider declares modes and its id
differs from the caller's — and the value being legal for the target does not
save it:

```text
cannot inherit mode 'auto' from caller (provider 'claude-lead') for new agent
(provider 'claude-peer'). Pass an explicit mode. Available modes for
'claude-peer': plan, default, acceptEdits, auto, bypassPermissions
```

`auto` is in that list and was still refused. This is not a cross-family rule:
`claude-lead` → `claude-peer` is one family and is rejected exactly the same.
What separates the two runtimes is that they declare different mode sets:

```text
pi-lead      Mode=default  AvailableModes=[]
claude-lead  Mode=auto     AvailableModes=[plan, default, acceptEdits, auto, bypassPermissions]
```

pi declares none, so nothing is required and `pi-lead` → `pi-peer` has always
worked. Claude declares five, and in this pack a Lead and a Peer are never the
same profile — so **every `claude-*` creation needs the mode passed in, from
either family.**

The parameter is `settings.modeId`, NOT a top-level `mode`. Paseo's own contract
is `create_agent { title, provider, initialPrompt, workspaceId?, settings?,
labels? }` with "initial runtime settings live under `settings`: `modeId`,
`thinkingOptionId`, features". A top-level `mode` is ignored and the create
fails with the message above:

```jsonc
create_agent({
  provider: "claude-peer/claude-opus-5",
  settings: { modeId: "auto", thinkingOptionId: "high" },
  // ...
})
```

The Paseo CLI spells the same thing `--mode` (`paseo run --mode default`), and
so does `remote-paseo.mjs run`, which never sends a `claude-*` route without one.

`modeId: "auto"` is the right answer for a Peer, and it is what
`remote-paseo.mjs run` fills in when `--mode` is omitted
(`CLAUDE_DEFAULT_MODE`).

**The provider default does NOT save a caller that stays quiet.** Measured
2026-09-07 on daemon 0.7.2 — this is the single fact behind every "why is this
seat not on auto" in this pack:

```text
paseo provider ls
  claude-lead   ... defaultMode=auto
  claude-peer   ... defaultMode=auto
```

…and the daemon applies that value **nowhere** at create time. It is catalog
metadata: the desktop and `paseo hub` use it to PRESELECT a mode in a picker
(`suggested`), and the seat itself is built by

```js
// @getpaseo/server .../agent/providers/claude/agent.js
this.currentMode = isPermissionMode(config.modeId) ? config.modeId : "default";
```

so anything that does not name a mode gets `"default"`. Reproduced end to end:

```text
paseo run --provider claude-peer/claude-haiku-4-5 --thinking low <prompt>
  -> paseo agent inspect  =>  Mode: default
paseo run --provider claude-peer/claude-haiku-4-5 --thinking low --mode auto <prompt>
  -> paseo agent inspect  =>  Mode: auto
```

The refusal quoted at the top of this section only fires when the create has a
PARENT agent on a different provider. A create with no parent — the CLI,
`paseo import`, a schedule whose provider differs from its caller's — is not
refused: it silently lands on `"default"`. So the rule is not "Paseo will stop
me if I forget"; it is **say the mode on every claude-\* creation, every time**.

Three paths in this pack close that hole, and between them they cover every way
the pack creates a seat:

- `create_agent` — the `PreToolUse` gate (`createAgentModeArgsBlockReason`)
  refuses a `claude-*` create with no `settings.modeId`, on BOTH runtimes, and
  names the value to pass. It also catches the top-level `mode` spelling, which
  Paseo ignores in silence.
- `remote-paseo.mjs run` — sends `--mode auto` when the caller passes none
  (`CLAUDE_DEFAULT_MODE`, pinned against the core's `CLAUDE_DEFAULT_SEAT_MODE`).
- `team-fork.mjs fork` — `paseo import` has NO `--mode` at all (its whole option
  set is `--provider`, `--cwd`, `--label`, `--json`, `--host`), so the fork is
  moved onto the mode with `paseo agent mode <id> <mode>` immediately after the
  import, and a fork that cannot be moved is deleted rather than handed over.
  `verify` re-checks it from `runtimeInfo.modeId` and deletes a fork still
  sitting on `"default"`.

`pteam watchdog` reports the seats already running that way, under `parked`,
with the `paseo agent mode <id> auto` that fixes each one where `auto` exists
(see below for where it does not — the row's `fixNote` says the same).

Two more mode facts worth knowing before you debug one:

- `persistence.metadata.modeId` is a **creation-time snapshot Paseo never
  rewrites** — the same trap as `persistence.metadata.model`. A seat that has
  been running on `auto` for an hour still reads `"default"` there. Read
  `runtimeInfo.modeId` (or `Mode` from `paseo agent inspect`).
- `auto` disappears entirely when Claude Code is pointed at Bedrock or Vertex:
  `claudeModeCatalog` drops it from the list and returns `defaultModeId:
  "default"` whenever `CLAUDE_CODE_USE_BEDROCK` / `CLAUDE_CODE_USE_VERTEX` is
  set in the provider env. There is also a per-model gate — `paseo agent mode
  <id> auto` on a model without it answers "auto mode unavailable for this
  model". If auto refuses to stick, check those two before the pack.

This used to say `"default"`, on the theory that every Peer tool call raising a
Paseo permission for the Lead to triage was the loop the pack is built around.
It is not: what bounds a Peer is the role policy plus its V3 brief, and both
are enforced in the `PreToolUse` hook, before Paseo's permission queue ever
sees the call. The queue only decides how often somebody is interrupted while
the Peer does already-bounded work — and on `"default"` the answer is "every
call", so the Peer sits in the queue looking hung while the Lead spends its
turn clicking instead of leading. The same trap the Lead's own seat hit (next
section), one level down.

Narrow it deliberately when you want that: `"plan"` for a seat that should
propose before acting, `"default"` for one you genuinely intend to watch call
by call. `"acceptEdits"` is the middle setting for a write Peer whose brief
already grants `EDIT_AUTHORITY`. Never `bypassPermissions` — the role policy
still applies, but Paseo's own guardrails outside it are gone too.

### …including the Lead's own seat

The rule above is about agents the Lead creates. The Lead's own seat is started
by the Human, and its mode is a separate decision the pack used to leave
unsaid — with real consequences, because **nobody triages the Lead's
permissions but the Human**:

```bash
paseo run --provider "claude-lead/<model>" --thinking high --mode auto "..."
```

`--mode auto` is the working default for a Lead. On `default`, every one of the
Lead's own tool calls parks in the pending-permission queue until the Human
clicks — so a Lead that correctly accepts a supervisor decision still cannot
carry it out, which looks from the outside exactly like a Lead that refused it.
A pi Lead never showed this: `pi-lead` declares no modes at all
(`Mode=default AvailableModes=[]`) and its tool calls simply run. If a Claude
Lead seems to be waiting on you for everything, check its mode before you
suspect the policy.

The Supervisor seat is the same story, started the same way:

```bash
paseo run --provider "claude-supervisor/<model>" --thinking high --mode auto "..."
```

Its tool surface is already the narrowest in the pack — no `Bash`, no `Write`,
no `Task`, from the provider's static `disallowedTools` — so `default` buys no
safety it does not already have. It only parks the reads and `mcp__paseo__*`
calls the Supervisor needs to answer a Lead's consult, and a consult left
unanswered parks the Lead, which escalates to the Human: exactly the round-trip
that channel exists to prevent.

## Verifying

```bash
node scripts/preflight.mjs --runtime claude    # or pi | both (default: detect)
```

Claude-specific checks: the `claude` CLI, the shared policy modules next to the
extension, the three hooks plus the MCP server registration, and the
`claude-*` role providers in the daemon.

## Uninstall

`pteam uninstall` removes the pi extension, the shared policy modules, the
prompts, the skills, the support scripts, and — through
`scripts/claude-setup.mjs --uninstall` — the tagged hooks, the `paseo-team`
MCP entry and the pack's packages under `~/.claude/skills/`. Removal never
creates a file it was asked to clean, and other tools' entries always survive:
a skill directory is removed only when it carries the name this pack ships AND
still looks like a skill package, so a same-named skill the user wrote is left
alone.
