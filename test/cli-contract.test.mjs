import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "cli", "paseo-team.mjs");
const FAKE = join(HERE, "fixtures", "fake-paseo-live.mjs");

const sandbox = mkdtempSync(join(tmpdir(), "pst-cli-"));

/** Every run is pointed at a throwaway HOME so no test can touch a real config. */
function run(args, extraEnv = {}) {
	const result = spawnSync(process.execPath, [CLI, ...args], {
		encoding: "utf8",
		input: extraEnv.__stdin ?? "",
		env: {
			...process.env,
			PASEO_TEAM_PASEO_EXEC: `node "${FAKE}"`,
			PI_HOME: join(sandbox, "pi"),
			// Paseo's own home, so the graph never reads the developer's real
			// agent state — that difference is what let a bug reach CI green here
			// and red on every runner.
			PASEO_HOME: join(sandbox, "paseo"),
			PST_TEAM_CONFIG_DIR: join(sandbox, "team"),
			PASEO_CONFIG_JSON: join(sandbox, "paseo-config.json"),
			// The Claude half of the pack lives in two more user-owned files;
			// both are redirected so uninstall can never touch the real ones.
			CLAUDE_CONFIG_DIR: join(sandbox, "claude"),
			PASEO_TEAM_CLAUDE_USER_CONFIG: join(sandbox, "claude.json"),
			...extraEnv,
		},
	});
	let json = null;
	try {
		json = JSON.parse(result.stdout);
	} catch {
		/* not every command answers with JSON (help does not) */
	}
	return { ...result, json };
}

try {
	// --- help + fail-closed dispatch ---------------------------------------
	{
		const help = run(["--help"]);
		assert.equal(help.status, 0);
		for (const command of ["agents", "permits list", "graph", "web", "update", "uninstall", "models", "cost", "activity"]) {
			assert.ok(help.stdout.includes(command), `help documents '${command}'`);
		}

		const unknown = run(["teleport"]);
		assert.equal(unknown.status, 2, "an unknown command exits 2, it does not fall through to help");

		// Typos must never be silently ignored — that is how a --strict-shaped
		// flag ends up doing nothing while looking like it worked.
		const badFlag = run(["graph", "--with-logs"]);
		assert.notEqual(badFlag.status, 0);
		assert.match(badFlag.stderr, /unknown flag/);

		const badSub = run(["permits", "approve"]);
		assert.notEqual(badSub.status, 0);
		assert.match(badSub.stderr, /unknown subcommand/);
	}

	// --- env diagnostics identify host extras the policy will drop ----------
	{
		const env = run(["env", "list"], { PASEO_TEAM_EXTRA_TOOLS: " WebFetch, constructor, constructor, " });
		assert.equal(env.status, 0, "prototype names must not crash CLI diagnostics");
		assert.deepEqual(env.json.extraTools.accepted, {
			pi: { peer: [], lead: [], supervisor: [] },
			claude: { peer: ["WebFetch"], lead: ["WebFetch"], supervisor: [] },
		});
		assert.deepEqual(
			env.json.extraTools.dropped.map(({ tool, role, family, reason }) => ({ tool, role, family, reason })),
			[
				{ tool: "WebFetch", role: "peer", family: "pi", reason: "not available in the pi runtime" },
				{ tool: "WebFetch", role: "lead", family: "pi", reason: "not available in the pi runtime" },
				{ tool: "WebFetch", role: "supervisor", family: "pi", reason: "Supervisor cannot receive extra tools" },
				{ tool: "WebFetch", role: "supervisor", family: "claude", reason: "Supervisor cannot receive extra tools" },
				{ tool: "constructor", role: "peer", family: "pi", reason: "not a catalogued extra capability" },
				{ tool: "constructor", role: "lead", family: "pi", reason: "not a catalogued extra capability" },
				{ tool: "constructor", role: "supervisor", family: "pi", reason: "Supervisor cannot receive extra tools" },
				{ tool: "constructor", role: "peer", family: "claude", reason: "not a catalogued extra capability" },
				{ tool: "constructor", role: "lead", family: "claude", reason: "not a catalogued extra capability" },
				{ tool: "constructor", role: "supervisor", family: "claude", reason: "Supervisor cannot receive extra tools" },
			],
		);
	}

	// --- agents: role inference travels with the row -----------------------
	{
		const agents = run(["agents"]);
		assert.equal(agents.status, 0);
		assert.equal(agents.json.ok, true);
		assert.equal(agents.json.count, 3);
		assert.deepEqual(agents.json.agents.map((agent) => agent.role), ["supervisor", "lead", "peer"]);
	}

	// --- agent refs are validated before they reach argv --------------------
	{
		const bad = run(["agent", "inspect", "$(rm -rf /)"]);
		assert.notEqual(bad.status, 0);
		assert.match(bad.stderr, /invalid agent reference/);

		const good = run(["agent", "inspect", "22222222-2222-2222-2222-222222222222"]);
		assert.equal(good.status, 0);
		assert.equal(good.json.agent.ParentAgentId, "11111111-1111-1111-1111-111111111111");
	}

	// --- send: the prompt travels as a file, not as a command line ----------
	{
		const body = "x".repeat(20_000);
		const sent = run(["agent", "send", "33333333-3333-3333-3333-333333333333"], { __stdin: body });
		assert.equal(sent.status, 0, sent.stderr);
		assert.equal(sent.json.ok, true);
		assert.equal(sent.json.response.body, body, "a 20k prompt survives intact");
		assert.equal(sent.json.bytes, 20_000);
	}

	// --- permits -------------------------------------------------------------
	{
		const empty = run(["permits", "list"]);
		assert.equal(empty.json.count, 0);

		const listed = run(["permits", "list"], { FAKE_PERMITS: "1" });
		assert.equal(listed.json.permits.length, 1);
		assert.equal(listed.json.permits[0].tool, "write");
		// The row nothing could name is still shown — someone is blocked on it —
		// but it arrives in `unclassified`, where the UI cannot one-click it.
		assert.equal(listed.json.unclassified.length, 1);
		assert.equal(listed.json.count, 2);

		const decided = run(["permits", "allow", "33333333-3333-3333-3333-333333333333", "req-1"]);
		assert.equal(decided.status, 0, decided.stderr);
		assert.equal(decided.json.response.decided, "allow");

		// Approving a tool call is an authority act and leaves a record.
		const audit = join(sandbox, "team", "permit-audit.jsonl");
		assert.ok(existsSync(audit), "a permit decision is audited");
		const entry = JSON.parse(readFileSync(audit, "utf8").trim().split("\n").at(-1));
		assert.equal(entry.action, "allow");
		assert.equal(entry.requestId, "req-1");
		assert.equal(entry.agentId, "33333333-3333-3333-3333-333333333333");

		const malformed = run(["permits", "deny", "33333333-3333-3333-3333-333333333333", "req 1"]);
		assert.notEqual(malformed.status, 0);
	}

	// --- graph over a fake daemon -------------------------------------------
	{
		const graph = run(["graph"]);
		assert.equal(graph.status, 0, graph.stderr);
		assert.equal(graph.json.ok, true);
		assert.equal(graph.json.counts.agents, 3);
		assert.deepEqual(
			graph.json.edges.filter((edge) => edge.type === "spawn").map((edge) => `${edge.from.slice(0, 4)}->${edge.to.slice(0, 4)}`),
			["1111->2222", "2222->3333"],
		);
		assert.deepEqual(graph.json.degraded, []);

		// The cache lives in the throwaway team dir, not in the repo.
		assert.ok(existsSync(join(sandbox, "team", "graph-cache.json")));

		// Second run: the tree is already known, so no inspect is spent. This is
		// what makes polling affordable at ~3s per paseo call.
		const warm = run(["graph"]);
		assert.equal(warm.json.inspectSpent, 0);
		assert.equal(warm.json.pendingParents, 0);
		assert.equal(warm.json.counts.edges, 2);
	}

	// --- cost: one command for a whole cluster ------------------------------
	// `paseo ls` has no cost column and `paseo inspect` has one per agent, so a
	// fifteen-Peer project previously had to call inspect fifteen times and add
	// the numbers by hand. Cluster is the unit because it is already the pack's
	// authority boundary.
	{
		// Two of the three fake agents are labelled into one cluster; the third
		// carries a different one, so the filter has something to exclude.
		const stateDir = join(sandbox, "paseo", "agents", "w");
		mkdirSync(stateDir, { recursive: true });
		const clusters = {
			"11111111-1111-1111-1111-111111111111": "wks_alpha",
			"22222222-2222-2222-2222-222222222222": "wks_alpha",
			"33333333-3333-3333-3333-333333333333": "wks_beta",
		};
		for (const [id, cluster] of Object.entries(clusters)) {
			writeFileSync(
				join(stateDir, `${id}.json`),
				JSON.stringify({ id, cwd: "/w", labels: { "team.cluster": cluster } }),
			);
		}

		const all = run(["cost"]);
		assert.equal(all.status, 0, all.stderr);
		assert.equal(all.json.ok, true);
		assert.equal(all.json.agentCount, 3);
		// The third agent reports no usage at all. That is neither a failure nor
		// a zero, and a total that silently absorbed it would understate the bill.
		assert.equal(all.json.costedCount, 2);
		assert.equal(all.json.totals.costUsd, 3.75);
		assert.deepEqual(
			all.json.unavailable.map((row) => row.code),
			["USAGE_UNREPORTED"],
		);
		// Most expensive first: the point of the report is to find the seat to
		// look at, not to re-sort it by hand.
		assert.deepEqual(all.json.agents.map((agent) => agent.costUsd), [2.25, 1.5]);

		const alpha = run(["cost", "--cluster", "wks_alpha"]);
		assert.equal(alpha.json.agentCount, 2);
		assert.equal(alpha.json.costedCount, 2);
		assert.equal(alpha.json.totals.costUsd, 3.75);
		assert.equal(alpha.json.cluster, "wks_alpha");

		const beta = run(["cost", "--cluster", "wks_beta"]);
		assert.equal(beta.json.agentCount, 1);
		assert.equal(beta.json.costedCount, 0);
		assert.equal(beta.json.totals.costUsd, 0);

		// An `{ error }` body that paseo returns with exit 0 must never be read as
		// "this agent used nothing". A transport failure filed as a benign state
		// is how a total quietly loses a seat.
		const broken = run(["cost"], { FAKE_INSPECT: "envelope" });
		assert.equal(broken.json.costedCount, 0);
		assert.equal(broken.json.totals.costUsd, 0);
		assert.deepEqual(
			[...new Set(broken.json.unavailable.map((row) => row.code))],
			["UNKNOWN_ERROR"],
			"the daemon's own error code survives, it does not become USAGE_UNREPORTED",
		);

		assert.notEqual(run(["cost", "--concurrency", "abc"]).status, 0);
		// The message promises 1-16, so 0 and 99 must be refused rather than
		// silently clamped.
		assert.notEqual(run(["cost", "--concurrency", "0"]).status, 0);
		assert.notEqual(run(["cost", "--concurrency", "99"]).status, 0);
		assert.notEqual(run(["cost", "--with-everything"]).status, 0);
	}

	// --- agents: what a Supervisor watches is on the row --------------------
	// A long job has several Supervisors, and the operator needs to see which
	// one decides and what the others carry without opening each agent's state.
	{
		const stateDir = join(sandbox, "paseo", "agents", "w");
		mkdirSync(stateDir, { recursive: true });
		const sup = "11111111-1111-1111-1111-111111111111";
		writeFileSync(
			join(stateDir, `${sup}.json`),
			JSON.stringify({ id: sup, cwd: "/w", labels: { "team.cluster": "wks_alpha", "team.watch": "liveness,cost" } }),
		);
		const agents = run(["agents"]);
		assert.equal(agents.status, 0, agents.stderr);
		const byId = Object.fromEntries(agents.json.agents.map((agent) => [agent.id, agent]));
		assert.equal(byId[sup].watch, "liveness,cost", "the label is shown as written");
		assert.equal(byId["22222222-2222-2222-2222-222222222222"].watch, null, "a seat with no label shows none");
		// The graph carries it too, with the quiet failure of this shape named:
		// watch seats and nobody that decides.
		const graph = run(["graph"]);
		assert.equal(graph.status, 0, graph.stderr);
		assert.equal(graph.json.nodes.find((node) => node.id === sup).watch, "liveness,cost");
		assert.equal(graph.json.jurisdiction.undecided, true);
	}

	// --- activity: the cap is PER ENTRY, not per call -----------------------
	// A `limit` bounds how many entries come back and says nothing about how big
	// one is — and one entry can be a Peer's whole report, whose full text the
	// output contract already puts in a file. Four activities must not cost half
	// a megabyte.
	{
		const capped = run(["activity", "22222222-2222-2222-2222-222222222222", "--tail", "4", "--max-chars", "200"]);
		assert.equal(capped.status, 0, capped.stderr);
		assert.equal(capped.json.ok, true);
		assert.equal(capped.json.entryCount, 4);
		const big = capped.json.entries.find((entry) => entry.truncated);
		assert.ok(big, "the 5000-character entry is truncated");
		assert.ok(big.chars > 4000, "the ORIGINAL size is still reported");
		assert.ok(big.text.length < 500, "...but the text returned is bounded");
		assert.match(big.text, /withheld by --max-chars/);
		assert.ok(capped.json.withheldChars > 4000);
		// A short entry is returned whole — the cap must not blunt everything.
		const small = capped.json.entries.find((entry) => entry.kind === "Tool");
		assert.equal(small.truncated, false);

		assert.notEqual(run(["activity"]).status, 0);
		// `--tail 0` used to mean "no --tail at all", i.e. read the WHOLE
		// transcript — the exact opposite of the bound this command exists for.
		assert.notEqual(run(["activity", "22222222-2222-2222-2222-222222222222", "--tail", "0"]).status, 0);
		assert.notEqual(run(["activity", "$(rm -rf /)"]).status, 0);
		assert.notEqual(run(["activity", "22222222-2222-2222-2222-222222222222", "--filter", "everything"]).status, 0);
	}

	// --- config still round-trips through the sandbox ------------------------
	{
		const written = run(["config", "write", "routing"], { __stdin: '{"hostId":"box-1"}' });
		assert.equal(written.status, 0, written.stderr);
		const read = run(["config", "read", "routing"]);
		assert.equal(read.json.exists, true);
		assert.deepEqual(read.json.data, { hostId: "box-1" });
		assert.match(read.json.path, /model-routing\.local\.json$/);

		const invalid = run(["config", "write", "routing"], { __stdin: "{not json" });
		assert.notEqual(invalid.status, 0);
	}

	// --- every section carries the form schema the WebUI renders -------------
	{
		for (const section of ["providers", "routing", "cluster", "mcp", "paseo", "pi-settings", "jobs"]) {
			const read = run(["config", "read", section]);
			assert.equal(read.status, 0, `${section}: ${read.stderr}`);
			assert.ok(Array.isArray(read.json.schema?.groups), `${section} read carries a form schema`);
		}

		// pi-settings points at Pi's own settings file and works before it exists
		const pi = run(["config", "read", "pi-settings"]);
		assert.equal(pi.json.exists, false);
		assert.match(pi.json.path, /[\\/]settings\.json$/);
		const retryGroup = pi.json.schema.groups.find((group) => group.id === "retry");
		assert.ok(retryGroup, "the retry group is described even before any file exists");
		const preset = pi.json.schema.presets.find((entry) => entry.id === "unstable-provider");
		assert.equal(preset?.patch?.retry?.maxRetries, 6, "the unstable-provider preset ships its retry budget");

		// A save must never drop keys the form does not know about.
		const settingsPath = join(sandbox, "pi", "agent", "settings.json");
		mkdirSync(dirname(settingsPath), { recursive: true });
		writeFileSync(settingsPath, JSON.stringify({ packages: ["npm:pi-web-access"], theme: "dark" }));
		const saved = run(["config", "write", "pi-settings"], {
			__stdin: JSON.stringify({ packages: ["npm:pi-web-access"], theme: "dark", retry: { maxRetries: 6 } }),
		});
		assert.equal(saved.status, 0, saved.stderr);
		const after = JSON.parse(readFileSync(settingsPath, "utf8"));
		assert.equal(after.packages[0], "npm:pi-web-access", "alien keys survive the write");
		assert.equal(after.retry.maxRetries, 6);
		assert.ok(
			readdirSync(dirname(settingsPath)).some((file) => /^settings\.json\.bak-\d+$/.test(file)),
			"a pi-settings rewrite leaves a .bak-* sibling",
		);

		const help = run(["--help"]);
		assert.ok(help.stdout.includes("pi-settings"), "help lists the pi-settings section");

		const unknown = run(["config", "read", "pi"]);
		assert.notEqual(unknown.status, 0);
		assert.match(unknown.stderr, /unknown config section/);
	}

	// --- version + update -----------------------------------------------------
	{
		const pkg = JSON.parse(readFileSync(join(HERE, "..", "package.json"), "utf8"));
		const FAKE_GIT = join(HERE, "fixtures", "fake-git.mjs");
		const gitEnv = (tags, extra = {}) => ({
			PASEO_TEAM_GIT_EXEC: `node "${FAKE_GIT}"`,
			FAKE_GIT_TAGS: tags,
			...extra,
		});

		const v = run(["--version"]);
		assert.equal(v.status, 0);
		assert.equal(v.stdout.trim(), `pteam ${pkg.version}`);

		const status = run(["status"]);
		assert.equal(
			status.json.version,
			pkg.version,
			"status.version must read package.json (the old hardcoded drift bug)",
		);

		const helpUpdate = run(["--help"]);
		assert.ok(helpUpdate.stdout.includes("update"), "help documents 'update'");

		const newer = run(["update", "--check"], gitEnv("sha\trefs/tags/v99.0.0\n"));
		assert.equal(newer.status, 0);
		assert.equal(newer.json.latest, "v99.0.0");
		assert.equal(newer.json.updateAvailable, true);

		const older = run(["update", "--check"], gitEnv("sha\trefs/tags/v0.0.1\n"));
		assert.equal(older.status, 0);
		assert.equal(older.json.updateAvailable, false);
		assert.equal(older.json.upToDate, true);

		// an unreachable remote degrades to JSON + exit 0; it must not crash
		const down = run(["update", "--check"], gitEnv("", { FAKE_GIT_FAIL: "1" }));
		assert.equal(down.status, 0);
		assert.equal(down.json.updateAvailable, null);
		assert.ok(Array.isArray(down.json.degraded) && down.json.degraded.length === 1);

		// from the test sandbox the CLI lives in a checkout: an actual update
		// must hand the pull back to the user instead of spawning npm
		const manual = run(["update"], gitEnv("sha\trefs/tags/v99.0.0\n"));
		assert.equal(manual.status, 0);
		assert.equal(manual.json.action, "manual");

		// Upgrading the BINARY is only half an upgrade: the policy core, role
		// prompts and Lead skill are copies under ~/.pi/agent that `npm i -g`
		// never touches, so a user who stops at `update` runs a new CLI over the
		// previous release's rules with both halves reporting the new version.
		assert.ok(
			manual.json.nextSteps?.some((step) => step.includes("pteam install")),
			"an update must say the installed copies still need refreshing",
		);
		assert.equal(manual.json.mode, "checkout");

		const noop = run(["update"], gitEnv("sha\trefs/tags/v0.0.1\n"));
		assert.equal(noop.status, 0);
		assert.equal(noop.json.action, "none");

		const badUpdateFlag = run(["update", "--yes"]);
		assert.notEqual(badUpdateFlag.status, 0);
		assert.match(badUpdateFlag.stderr, /unknown flag/);
	}

	// --- uninstall ------------------------------------------------------------
	{
		// seed the exact footprint install leaves behind, inside the sandbox
		const agentRoot = join(sandbox, "pi", "agent");
		const mk = (rel, content) => {
			const p = join(agentRoot, rel);
			mkdirSync(dirname(p), { recursive: true });
			writeFileSync(p, content);
		};
		mk(join("extensions", "paseo-team-policy.ts"), "export {};");
		// The shared policy core installs next to the extension and must go with
		// it: left behind, it would keep a Claude hook working after the pack is
		// uninstalled.
		mk(join("extensions", "paseo-team-core", "policy-core.ts"), "export {};");
		mk(join("extensions", "paseo-team-core", "claude-policy.ts"), "export {};");
		for (const role of ["supervisor", "lead", "peer"]) {
			mk(join("extensions", "prompts", `${role}.md`), "prompt");
		}
		for (const skill of ["paseo-team-lead", "paseo-ocr-reviewer"]) {
			mk(join("skills", skill, "SKILL.md"), "skill");
		}
		mk(join("extensions", "paseo-team-scripts", "preflight.mjs"), "// support");
		const mcpPath = join(agentRoot, "mcp.json");
		writeFileSync(
			mcpPath,
			JSON.stringify({ mcpServers: { "agent-browser": { command: "x" }, "other-tool": { command: "y" } } }),
		);
		const teamDir = join(sandbox, "team");
		mkdirSync(teamDir, { recursive: true });
		writeFileSync(join(teamDir, "permit-audit.jsonl"), "{}\n");

		const out = run(["uninstall"]);
		assert.equal(out.status, 0);
		for (const t of out.json.targets) assert.equal(t.status, "removed", `${t.kind} must be removed`);
		assert.equal(out.json.mcp.status, "removed");
		// Nothing was installed for Claude in this sandbox, so the removal is a
		// clean no-op — reported, never a crash, and never a write.
		assert.equal(out.json.claude.status, "missing");
		assert.ok(!existsSync(join(sandbox, "claude", "settings.json")));
		const mcpAfter = JSON.parse(readFileSync(mcpPath, "utf8"));
		// The pack stopped installing this server, but uninstall must still clear
		// one an older version left behind, or an upgraded host keeps a dangling
		// entry pointing at a CLI nothing installs any more.
		assert.equal(mcpAfter.mcpServers["agent-browser"], undefined, "legacy MCP entry removed");
		assert.ok(mcpAfter.mcpServers["other-tool"], "other tools' MCP entries must survive");
		assert.ok(
			readdirSync(agentRoot).some((f) => /^mcp\.json\.bak-\d+$/.test(f)),
			"the mcp.json rewrite must leave a .bak-* sibling (recoverability claim)",
		);
		assert.ok(!existsSync(join(agentRoot, "extensions", "paseo-team-policy.ts")));
		assert.ok(!existsSync(join(agentRoot, "skills", "paseo-team-lead")));
		assert.ok(
			existsSync(join(agentRoot, "extensions", "prompts")),
			"the shared prompts dir itself must never be deleted",
		);
		assert.equal(out.json.teamData.status, "kept", "audit log survives without --purge");
		assert.ok(existsSync(join(teamDir, "permit-audit.jsonl")));

		// idempotent: a second run finds everything missing and still succeeds
		const again = run(["uninstall"]);
		assert.equal(again.status, 0);
		assert.ok(again.json.targets.every((t) => t.status === "missing"));
		assert.equal(again.json.mcp.status, "entry-missing");

		// --purge deletes the team dir including the audit log
		const purged = run(["uninstall", "--purge"]);
		assert.equal(purged.status, 0);
		assert.equal(purged.json.teamData.status, "removed");
		assert.ok(!existsSync(teamDir));

		// a present-but-corrupt mcp.json is reported and left byte-identical,
		// never conflated with "no config" and never rewritten
		writeFileSync(mcpPath, "{not json");
		const corrupt = run(["uninstall"]);
		assert.equal(corrupt.status, 0);
		assert.equal(corrupt.json.mcp.status, "mcp-config-unreadable");
		assert.ok(corrupt.json.mcp.error, "unreadable report carries the parse error");
		assert.equal(readFileSync(mcpPath, "utf8"), "{not json", "corrupt file must stay untouched");

		const badUninstallFlag = run(["uninstall", "--force"]);
		assert.notEqual(badUninstallFlag.status, 0);
	}
	// --- model inventory feeds the routing form ------------------------------
	{
		const listed = run(["models"]);
		assert.equal(listed.status, 0, listed.stderr);
		assert.deepEqual(listed.json.degraded, [], "a healthy daemon degrades nothing");
		// One `provider models` call per FAMILY, spread to that family's roles:
		// the three role profiles of a family extend the same base runtime.
		assert.deepEqual(listed.json.providers["pi-peer"], ["testprov/deep-large", "testprov/fast-small"]);
		assert.deepEqual(listed.json.providers["pi-lead"], listed.json.providers["pi-peer"]);
		assert.deepEqual(listed.json.providers["claude-peer"], ["claude-opus-5", "claude-sonnet-5"]);
		assert.deepEqual(
			listed.json.providers["claude-lead"],
			listed.json.providers["claude-peer"],
			"a family's model list reaches every role of that family, not just the one queried",
		);

		const named = run(["models", "--provider", "claude-peer"]);
		assert.equal(named.status, 0, named.stderr);
		assert.equal(named.json.family, "claude");
		assert.deepEqual(
			named.json.models.find((m) => m.id === "claude-opus-5").thinkingOptionIds,
			["off", "high", "ultracode"],
			"a named read carries the thinking options a route has to match",
		);

		const notARole = run(["models", "--provider", "pi"]);
		assert.notEqual(notARole.status, 0, "only the pack's role providers are addressable");
		assert.match(notARole.stderr, /--provider must be one of/);

		// A provider the resolver would reject must not be advertised by the form.
		for (const mode of ["claude-disabled", "claude-unhealthy"]) {
			const partial = run(["models"], { FAKE_PROVIDER_LS: mode });
			assert.equal(partial.status, 0, partial.stderr);
			assert.equal(partial.json.providers["claude-peer"], undefined, `${mode}: no suggestions from a provider preflight would reject`);
			assert.deepEqual(partial.json.providers["pi-peer"], ["testprov/deep-large", "testprov/fast-small"], `${mode}: the healthy family is unaffected`);
			assert.equal(partial.json.degraded.length, 1, `${mode}: the gap is reported, not hidden`);
			assert.match(partial.json.degraded[0].message, /claude/);
		}

		// paseo reports some daemon failures as a SUCCESSFUL body {"error": ...}.
		// Counting that as "zero models" would be a silent wrong answer.
		const envelope = run(["models"], { FAKE_PROVIDER_LS: "envelope" });
		assert.equal(envelope.status, 0, envelope.stderr);
		assert.deepEqual(envelope.json.providers, {});
		assert.equal(envelope.json.degraded[0].code, "UNKNOWN_ERROR");
		assert.match(envelope.json.degraded[0].message, /Connection timed out/);
	}

	// --- models refresh: the one command that is not a paseo spawn -----------
	// Paseo caches the provider catalog for the daemon's whole lifetime, so
	// editing models.json is invisible until the daemon is told. There is no
	// `paseo` subcommand for it, hence the SDK path and a second fake.
	{
		const CLIENT = join(HERE, "fixtures", "fake-paseo-client.mjs");
		const logPath = join(sandbox, "client-calls.log");
		const clientRun = (args, extra = {}) => {
			rmSync(logPath, { force: true });
			const result = run(args, { PASEO_TEAM_PASEO_CLIENT: CLIENT, PST_FAKE_CLIENT_LOG: logPath, ...extra });
			const calls = existsSync(logPath)
				? readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
				: [];
			return { ...result, calls };
		};

		const all = clientRun(["models", "refresh"]);
		assert.equal(all.status, 0, all.stderr);
		assert.equal(all.json.providers, "all");
		const refreshAll = all.calls.find((c) => c.event === "refresh");
		assert.deepEqual(refreshAll.payload, {}, "refreshing everything sends no provider filter");
		assert.ok(all.calls.some((c) => c.event === "close"), "the socket is closed, not leaked");

		const one = clientRun(["models", "refresh", "--provider", "pi-peer"]);
		assert.equal(one.status, 0, one.stderr);
		assert.deepEqual(one.json.providers, ["pi-peer"]);
		assert.deepEqual(
			one.calls.find((c) => c.event === "refresh").payload,
			{ providers: ["pi-peer"] },
			"a named provider reaches the daemon as a filter, not as a no-op",
		);

		// Same allowlist as `models --provider`: only the pack's role providers.
		const notARole = clientRun(["models", "refresh", "--provider", "pi"]);
		assert.notEqual(notARole.status, 0);
		assert.match(notARole.stderr, /--provider must be one of/);
		assert.equal(notARole.calls.length, 0, "a rejected argument never opens a connection");

		assert.notEqual(clientRun(["models", "refresh", "--bogus"]).status, 0, "unknown flags are a usage error here too");

		// Every failure must say the catalog is STILL STALE and name the cure.
		// Reporting success on a refresh that did not happen is the one outcome
		// that would quietly leave a dead model in the routing form.
		for (const [mode, code] of [
			["unreachable", "DAEMON_UNREACHABLE"],
			["old-daemon", "REFRESH_UNSUPPORTED"],
			["refresh-fails", "REFRESH_FAILED"],
		]) {
			const failed = clientRun(["models", "refresh"], { PST_FAKE_CLIENT_MODE: mode });
			assert.equal(failed.status, 3, `${mode}: a failed refresh exits non-zero`);
			assert.equal(failed.json.ok, false, `${mode}: and says so in the body`);
			assert.equal(failed.json.code, code);
			assert.match(failed.json.hint, /restart the daemon/, `${mode}: the hint names what actually fixes it`);
		}

		// A missing SDK is a configuration fault, not a crash.
		const noSdk = run(["models", "refresh"], { PASEO_TEAM_PASEO_CLIENT: join(sandbox, "nope", "client.js") });
		assert.equal(noSdk.status, 3, noSdk.stderr);
		assert.equal(noSdk.json.ok, false);
		assert.equal(noSdk.json.code, "PASEO_CLIENT_MISSING");

		// Paseo 0.10 made connectToDaemon's `target` mandatory; without one the
		// call dies on `options.target.kind` before any socket opens, and every
		// refresh reports DAEMON_UNREACHABLE while the daemon is perfectly up.
		// The SDK that needs the field ships selectDaemonTarget one file over —
		// when it is there, the target must reach the connect call; when it is
		// not (an older SDK), the call is made exactly as before.
		const clientV010 = join(HERE, "fixtures", "fake-paseo-client-0.10", "client.mjs");
		const withTarget = clientRun(["models", "refresh"], { PASEO_TEAM_PASEO_CLIENT: clientV010, PASEO_HOME: "/fake/paseo-home" });
		assert.equal(withTarget.status, 0, withTarget.stderr);
		const connectOptions = withTarget.calls.find((c) => c.event === "connect").options;
		assert.deepEqual(connectOptions.target, { kind: "instance", home: "/fake/paseo-home" }, "a 0.10 SDK gets a target, resolved the way the paseo CLI resolves its own");
		assert.ok(withTarget.calls.some((c) => c.event === "refresh"), "and the refresh itself still happens");
	}

	// --- models sync: fail closed before it can touch models.json ------------
	{
		const noConfig = run(["models", "sync", "--dry-run"]);
		assert.equal(noConfig.status, 2, "no endpoint configured is a usage fault, not a crash");
		assert.equal(noConfig.json.code, "CONFIG_MISSING");
		assert.match(noConfig.json.hint, /pi-models\.example\.json/, "the hint names the file to copy");

		const configPath = join(sandbox, "team", "pi-models.local.json");
		mkdirSync(dirname(configPath), { recursive: true });

		writeFileSync(configPath, JSON.stringify({ version: 1, providers: { testprov: {} } }));
		const noBaseUrl = run(["models", "sync", "--dry-run"]);
		assert.equal(noBaseUrl.status, 2);
		assert.equal(noBaseUrl.json.code, "CONFIG_INVALID");
		assert.match(noBaseUrl.json.problems.join(" "), /baseUrl/);

		// Every key is resolved BEFORE any request: a half-synced run would
		// rewrite one provider's catalog and leave the operator guessing about
		// the rest.
		writeFileSync(configPath, JSON.stringify({
			version: 1,
			providers: {
				testprov: { baseUrl: "http://127.0.0.1:1/v1", keyEnv: "PST_TEST_KEY", keyFile: join(sandbox, "absent.env") },
				second: { baseUrl: "http://127.0.0.1:1/v1", keyEnv: "PST_TEST_KEY_2", keyFile: join(sandbox, "absent.env") },
			},
		}));
		const noKey = run(["models", "sync", "--dry-run"]);
		assert.equal(noKey.status, 2);
		assert.equal(noKey.json.code, "API_KEY_MISSING");
		assert.equal(noKey.json.missing.length, 2, "every provider missing a key is named, not just the first");
		assert.equal(noKey.json.missing[0].tried.length, 2, "and each one says both places it looked");

		// --only addresses ONE endpoint; a name that is not configured must be
		// a usage error rather than a silent no-op run over nothing.
		const badOnly = run(["models", "sync", "--only", "khong-co"]);
		assert.notEqual(badOnly.status, 0);
		assert.match(badOnly.stderr, /is not configured \(have: /);

		assert.notEqual(run(["models", "sync", "--provider", "pi-peer"]).status, 0, "sync takes --only, not --provider; a typo must not be ignored");

		// The section is addressable by the config plumbing the WebUI uses.
		const section = run(["config", "read", "pi-models"]);
		assert.equal(section.status, 0, section.stderr);
		assert.deepEqual(Object.keys(section.json.data.providers).sort(), ["second", "testprov"]);
		assert.equal(section.json.schema.label, "Kho model Pi");
		assert.equal(section.json.schema.labelEn, "Pi model catalog");
		const map = section.json.schema.groups[0].fields[0];
		assert.equal(map.type, "map", "the form adds endpoints rather than editing a single hard-coded one");
		const itemFields = map.item.fields.map((f) => f.path);
		assert.ok(itemFields.includes("keyEnv") && itemFields.includes("keyFile"), "the form offers the key's LOCATION...");
		assert.ok(
			!itemFields.some((path) => /^(apiKey|key|secret|token)$/i.test(path)),
			"...and never a field to paste the secret into",
		);
	}

	// --- config read folds that inventory into the routing schema ------------
	{
		const routing = run(["config", "read", "routing"]);
		assert.equal(routing.status, 0, routing.stderr);
		const card = routing.json.schema.groups
			.flatMap((group) => group.fields)
			.find((field) => field.type === "map" && field.fixedKeys?.includes("REVIEW_HIGH"));
		const model = card.item.fields.find((field) => field.path === "model");
		assert.deepEqual(model.optionsBy.map["claude-peer"], ["claude-opus-5", "claude-sonnet-5"]);
		assert.equal(model.type, "enum", "the model field is a picker fed by the daemon");
		assert.deepEqual(
			card.item.fields.find((field) => field.path === "paseoProvider").enum,
			["pi-supervisor", "pi-lead", "pi-peer", "claude-supervisor", "claude-lead", "claude-peer"],
			"the form offers both runtime families, not pi alone",
		);
		assert.deepEqual(routing.json.inventory.degraded, []);

		// A section with no inventory must not pay for a daemon round trip.
		const mcp = run(["config", "read", "mcp"]);
		assert.equal(mcp.status, 0, mcp.stderr);
		assert.equal(mcp.json.inventory, undefined);

		// --no-discovery keeps a scripted read file-only.
		const offline = run(["config", "read", "routing", "--no-discovery"]);
		assert.equal(offline.status, 0, offline.stderr);
		assert.equal(offline.json.inventory, undefined);
		assert.deepEqual(
			offline.json.schema.groups
				.flatMap((group) => group.fields)
				.find((field) => field.type === "map" && field.fixedKeys?.includes("REVIEW_HIGH"))
				.item.fields.find((field) => field.path === "model").optionsBy.map,
			{},
		);

		const badFlag = run(["config", "read", "routing", "--nope"]);
		assert.notEqual(badFlag.status, 0, "a typo'd flag is never silently dropped");
		assert.match(badFlag.stderr, /unknown flag/);

		// A dead daemon degrades the form; it must never fail the read.
		const dead = run(["config", "read", "routing"], { FAKE_PROVIDER_LS: "envelope" });
		assert.equal(dead.status, 0, dead.stderr);
		assert.deepEqual(dead.json.inventory.providers, []);
		assert.equal(dead.json.inventory.degraded.length, 1);
		assert.ok(dead.json.schema, "the form still renders without any suggestions");
	}

	// --- `<subcommand> --help` must ANSWER, never ACT -----------------------
	// Regression: `--help` was only a TOP-LEVEL case in the dispatch switch, so
	// the flag fell straight through into the subcommand's own case. `pteam
	// install --help` ran the installer, and `pteam uninstall --help` REMOVED
	// the installed pack. The person typing --help is the one who does not yet
	// know what the command does; answering with the command itself is the
	// worst possible reply, and for `uninstall` it costs them their install.
	{
		const installHelp = run(["install", "--help"]);
		assert.equal(installHelp.status, 0, installHelp.stderr);
		assert.match(installHelp.stdout, /pteam install/);
		assert.ok(
			!installHelp.stdout.includes("Installed:"),
			"install --help must not run the installer",
		);

		const uninstallHelp = run(["uninstall", "--help"]);
		assert.equal(uninstallHelp.status, 0, uninstallHelp.stderr);
		assert.match(uninstallHelp.stdout, /pteam uninstall/);
		assert.equal(
			uninstallHelp.json?.targets,
			undefined,
			"uninstall --help must not remove anything",
		);

		// -h is the same question asked shorter.
		const shortForm = run(["uninstall", "-h"]);
		assert.equal(shortForm.status, 0);
		assert.match(shortForm.stdout, /pteam uninstall/);
		assert.equal(shortForm.json?.targets, undefined);

		// Scoped: it answers about THAT command, filtered from the same usage
		// text the top-level help prints, so there is no second copy to drift.
		const configHelp = run(["config", "--help"]);
		assert.equal(configHelp.status, 0);
		assert.match(configHelp.stdout, /pteam config read/);
		assert.match(configHelp.stdout, /pteam config write/);
		assert.ok(
			!configHelp.stdout.includes("pteam graph"),
			"scoped help does not dump the whole CLI back at the reader",
		);

		// A daemon-facing command must not reach the daemon just to print help.
		const graphHelp = run(["graph", "--help"]);
		assert.equal(graphHelp.status, 0);
		assert.match(graphHelp.stdout, /pteam graph/);

		// The interception must not swallow an ordinary run.
		const stillWorks = run(["agents"]);
		assert.equal(stillWorks.status, 0, stillWorks.stderr);
	}

	// --- seats: config section, generation, and provider ownership ----------
	{
		const seatsFile = join(sandbox, "team", "seat-profiles.local.json");
		const paseoConfig = join(sandbox, "paseo-config.json");

		// The section is readable before the file exists, and carries the form
		// schema — a WebUI opening this tab on a fresh machine must get a form,
		// not an error.
		const empty = run(["config", "read", "seats"]);
		assert.equal(empty.status, 0, empty.stderr);
		assert.equal(empty.json.exists, false);
		assert.ok(empty.json.schema, "the seats section ships a form schema");
		assert.equal(empty.json.path, seatsFile, "the seat file honours PST_TEAM_CONFIG_DIR");

		// Written the way the WebUI writes it: full JSON on stdin.
		const doc = {
			version: 1,
			seats: {
				researcher: { base: "claude-peer", label: "Claude Peer (Researcher)", capabilities: ["web-research"] },
				audit: { base: "pi-lead", capabilities: ["lead-write"] },
			},
		};
		const wrote = run(["config", "write", "seats"], { __stdin: JSON.stringify(doc) });
		assert.equal(wrote.status, 0, wrote.stderr);

		const listed = run(["seats", "list"]);
		assert.equal(listed.status, 0, listed.stderr);
		assert.equal(listed.json.ok, true, JSON.stringify(listed.json.errors));
		assert.ok(listed.json.catalog.length > 0, "the capability catalog travels with the answer");
		const generated = listed.json.providers;
		assert.deepEqual(Object.keys(generated).sort(), ["claude-peer-researcher", "pi-lead-audit"]);
		assert.equal(generated["claude-peer-researcher"].env.PASEO_PI_ROLE, "peer");
		assert.equal(generated["claude-peer-researcher"].env.PASEO_TEAM_EXTRA_TOOLS, "WebFetch,WebSearch");
		// The two policy layers must agree: the dynamic layer is opened by the env
		// above, so the static layer must no longer strip the same tools.
		const denied = generated["claude-peer-researcher"].disallowedTools ?? [];
		assert.ok(!denied.includes("WebFetch") && !denied.includes("WebSearch"), "a granted tool is not also statically denied");
		assert.ok(denied.includes("Task") && denied.includes("Agent"), "everything else the peer may never use stays denied");
		assert.equal("disallowedTools" in generated["pi-lead-audit"], false, "pi providers carry no deny list");

		// A dry run answers with the same plan and writes nothing.
		const before = existsSync(paseoConfig) ? readFileSync(paseoConfig, "utf8") : null;
		const dry = run(["seats", "apply", "--dry-run"]);
		assert.equal(dry.status, 0, dry.stderr);
		assert.equal(dry.json.dryRun, true);
		assert.deepEqual(dry.json.created.sort(), ["claude-peer-researcher", "pi-lead-audit"]);
		assert.equal(existsSync(paseoConfig) ? readFileSync(paseoConfig, "utf8") : null, before, "--dry-run writes nothing");

		const applied = run(["seats", "apply"]);
		assert.equal(applied.status, 0, applied.stderr);
		const config = JSON.parse(readFileSync(paseoConfig, "utf8"));
		assert.ok(config.agents.providers["claude-peer-researcher"], "the provider reached the Paseo config");

		// Removing the seat removes the provider it created, and only that one.
		config.agents.providers["hand-written"] = { extends: "claude", label: "not ours" };
		writeFileSync(paseoConfig, JSON.stringify(config, null, 2));
		delete doc.seats.researcher;
		run(["config", "write", "seats"], { __stdin: JSON.stringify(doc) });
		const reapplied = run(["seats", "apply"]);
		assert.deepEqual(reapplied.json.removed, ["claude-peer-researcher"]);
		const after = JSON.parse(readFileSync(paseoConfig, "utf8"));
		assert.equal("claude-peer-researcher" in after.agents.providers, false);
		assert.ok(after.agents.providers["hand-written"], "a provider this tool never created survives");
		assert.ok(after.agents.providers["pi-lead-audit"], "a seat that is still defined survives");

		// An invalid document is refused whole, with the reason, and changes nothing.
		run(["config", "write", "seats"], {
			__stdin: JSON.stringify({ seats: { bad: { base: "claude-supervisor", capabilities: ["web-research"] } } }),
		});
		const refused = run(["seats", "apply"]);
		assert.equal(refused.status, 1, "an invalid seat document is an error exit");
		assert.equal(refused.json.ok, false);
		assert.equal(refused.json.code, "SEATS_INVALID");
		assert.ok(refused.json.errors.length > 0);
		const untouched = JSON.parse(readFileSync(paseoConfig, "utf8"));
		assert.ok(untouched.agents.providers["pi-lead-audit"], "a refused apply leaves the previous providers alone");

		assert.equal(run(["seats", "nonsense"]).status, 2, "an unknown seats subcommand is a usage error");
	}

	// --- jobs: a validated config section and a read-only view for the Lead ---
	{
		// Its own config dir: the routing block above leaves a deliberately
		// incomplete route file in the shared one.
		const teamDir = join(sandbox, "team-jobs");
		const env = { PST_TEAM_CONFIG_DIR: teamDir };
		const jobsFile = join(teamDir, "jobs.local.json");

		const none = run(["jobs", "list"], env);
		assert.equal(none.status, 0, none.stderr);
		assert.equal(none.json.exists, false, "no file yet is 'no jobs', not an error");
		assert.deepEqual(none.json.jobs, []);
		assert.equal(none.json.path, jobsFile, "the jobs file honours PST_TEAM_CONFIG_DIR");
		assert.match(none.json.hint, /jobs\.example\.json/);
		const SHAPE = ["cliTools", "disabledTools", "exists", "hint", "inactive", "jobs", "ok", "path", "routeSource"];
		assert.deepEqual(Object.keys(none.json).sort(), SHAPE, "the same keys with or without a file");
		assert.equal(none.json.routeSource.ok, false);
		assert.equal(none.json.routeSource.hostId, null);

		const empty = run(["config", "read", "jobs", "--no-discovery"], env);
		assert.equal(empty.status, 0, empty.stderr);
		assert.equal(empty.json.path, jobsFile);
		assert.equal(empty.json.schema.label, "Công việc", "the section ships its form schema");
		const discovered = run(["config", "read", "jobs"], env);
		assert.ok(discovered.json.inventory, "a jobs read carries the model inventory its route executors pick from");

		// A refused write names the job and executor, and leaves the disk alone.
		const bad = {
			version: 1,
			jobs: { review: { executors: [{ kind: "class", modelClass: "REVIEW_HIGH" }, { kind: "cli", tool: "gemini" }] } },
		};
		const refused = run(["config", "write", "jobs"], { ...env, __stdin: JSON.stringify(bad) });
		assert.equal(refused.status, 1, refused.stderr);
		assert.match(refused.stderr, /CONFIG_INVALID: job "review" executor \[1\]: tool "gemini"/);
		assert.ok(!existsSync(jobsFile), "nothing is written when the document is refused");
		const dotted = run(["config", "write", "jobs"], {
			...env,
			__stdin: JSON.stringify({ version: 1, jobs: { "a.b": { executors: [{ kind: "cli", tool: "pi" }] } } }),
		});
		assert.equal(dotted.status, 1);
		assert.match(dotted.stderr, /job "a\.b"/);
		// "__proto__" survives JSON.parse as a key but not a later `out[key] =`
		// copy, so the job would vanish on the next save: refused at the door.
		const proto = run(["config", "write", "jobs"], {
			...env,
			__stdin: '{"version":1,"jobs":{"__proto__":{"executors":[{"kind":"cli","tool":"pi"}]},"b":{"executors":[{"kind":"cli","tool":"pi"}]}}}',
		});
		assert.equal(proto.status, 1, proto.stderr);
		assert.match(proto.stderr, /job "__proto__": id "__proto__" is reserved/);
		const notJson = run(["config", "write", "jobs"], { ...env, __stdin: "{nope" });
		assert.equal(notJson.status, 1);
		assert.match(notJson.stderr, /CONFIG_INVALID/);
		assert.ok(!existsSync(jobsFile));

		// The route a class executor stands for comes from the route file the gate reads.
		mkdirSync(teamDir, { recursive: true });
		const route = (paseoProvider, model, thinking) => ({ paseoProvider, model, thinking });
		writeFileSync(join(teamDir, "model-routing.local.json"), JSON.stringify({
			version: 1,
			hostId: "jobs-box",
			routes: {
				MONITOR_ECONOMY: route("pi-supervisor", "Minnyat/small", "low"),
				FAST_READ: route("pi-peer", "Minnyat/fast", "low"),
				CODING_MEDIUM: route("pi-peer", "Minnyat/gpt-5.5", "medium"),
				REASONING_HIGH: route("pi-peer", "Minnyat/deep", "high"),
				REVIEW_HIGH: route("claude-peer", "claude-opus-5", "high"),
			},
		}));
		const good = {
			version: 1,
			cliTools: { codex: { command: "codex", args: ["exec"] } },
			jobs: {
				review: {
					label: "Review",
					run: "sequential",
					executors: [
						{ kind: "class", modelClass: "REVIEW_HIGH" },
						{ kind: "route", paseoProvider: "pi-peer", model: "Minnyat/gpt-5.5" },
						{ kind: "cli", tool: "codex", args: ["--full-auto"] },
					],
				},
				build: { executors: [{ kind: "class", modelClass: "LEAD_RECOVERY" }] },
			},
		};
		const wrote = run(["config", "write", "jobs"], { ...env, __stdin: JSON.stringify(good) });
		assert.equal(wrote.status, 0, wrote.stderr);
		assert.deepEqual(JSON.parse(readFileSync(jobsFile, "utf8")), good);

		const listed = run(["jobs", "list"], env);
		assert.equal(listed.status, 0, listed.stderr);
		assert.equal(listed.json.routeSource.hostId, "jobs-box");
		assert.deepEqual(Object.keys(listed.json).sort(), SHAPE);
		assert.equal(listed.json.hint, null, "no hint once the file exists");
		assert.equal(listed.json.routeSource.code, null);
		// `build` has only a class whose route is not configured: nothing a Lead can
		// use right now, so it is named under `inactive` (with why) rather than offered.
		assert.deepEqual(listed.json.jobs.map((job) => job.id), ["review"]);
		assert.deepEqual(listed.json.inactive.map((entry) => entry.id), ["build"]);
		assert.match(listed.json.inactive[0].reason, /LEAD_RECOVERY is not configured/);
		const everything = run(["jobs", "list", "--all"], env);
		assert.equal(everything.status, 0, everything.stderr);
		assert.deepEqual(everything.json.jobs.map((job) => job.id), ["build", "review"]);
		assert.equal(everything.json.jobs[0].run, "parallel", "the default run mode is spelled out");
		assert.equal(everything.json.jobs[0].executors[0].route, null);
		assert.match(everything.json.jobs[0].executors[0].routeProblem, /LEAD_RECOVERY is not configured/);
		assert.equal(run(["jobs", "show", "build"], env).json.code, "JOB_INACTIVE");

		const shown = run(["jobs", "show", "review"], env);
		assert.equal(shown.status, 0, shown.stderr);
		assert.equal(shown.json.job.run, "sequential");
		assert.deepEqual(shown.json.job.executors[0].route, {
			paseoProvider: "claude-peer",
			model: "claude-opus-5",
			thinking: "high",
			createAgentProvider: "claude-peer/claude-opus-5",
		});
		assert.equal(shown.json.job.executors[1].createAgentProvider, "pi-peer/Minnyat/gpt-5.5");
		assert.deepEqual(shown.json.job.executors[2].args, ["exec", "--full-auto"]);

		const missing = run(["jobs", "show", "nope"], env);
		assert.equal(missing.status, 1);
		assert.equal(missing.json.code, "JOB_NOT_FOUND");
		assert.deepEqual(missing.json.known, ["build", "review"]);
		assert.equal(run(["jobs", "show"], env).status, 2, "a missing id is a usage error");
		assert.equal(run(["jobs", "nonsense"], env).status, 2, "an unknown jobs subcommand is a usage error");
		assert.notEqual(run(["jobs", "list", "--al"], env).status, 0, "a typo'd flag is never ignored");

		// A file edited by hand into an invalid shape is reported, never printed as a preset.
		writeFileSync(jobsFile, JSON.stringify({ version: 1, jobs: { review: { executors: [] } } }));
		const broken = run(["jobs", "list"], env);
		assert.equal(broken.status, 1);
		assert.equal(broken.json.code, "CONFIG_INVALID");
		assert.match(broken.json.message, /job "review": executors must be a non-empty array/);

		// pi-models: an override the sync would stop on is refused at save,
		// an old file with endpoint-level limits is not.
		const piModelsFile = join(teamDir, "pi-models.local.json");
		const overrides = (models) => JSON.stringify({ version: 1, providers: { Minnyat: { baseUrl: "https://example.test/v1", models } } });
		const fraction = run(["config", "write", "pi-models"], { ...env, __stdin: overrides({ "gpt-5.5": { contextWindow: 1.5 } }) });
		assert.equal(fraction.status, 1);
		assert.match(fraction.stderr, /CONFIG_INVALID: pi-models: provider "Minnyat": models\.gpt-5\.5\.contextWindow must be a positive integer/);
		const inverted = run(["config", "write", "pi-models"], { ...env, __stdin: overrides({ "gpt-5.5": { contextWindow: 1000, maxTokens: 2000 } }) });
		assert.equal(inverted.status, 1);
		assert.match(inverted.stderr, /models\.gpt-5\.5\.maxTokens \(2000\) exceeds its contextWindow/);
		const unknownKey = run(["config", "write", "pi-models"], { ...env, __stdin: overrides({ "gpt-5.5": { context: 1000 } }) });
		assert.equal(unknownKey.status, 1);
		assert.match(unknownKey.stderr, /models\.gpt-5\.5\.context is not an override/);
		assert.ok(!existsSync(piModelsFile), "a refused pi-models document is not written");
		// Only the overrides are checked at save. A card still being filled in —
		// no baseUrl yet, a plain-http one, a "/" in its name — saved before and
		// still does; the sync is where that fails, as it always was.
		for (const draft of [
			{ version: 1, providers: { Minnyat: {} } },
			{ version: 1, providers: { Minnyat: { models: { "gpt-5.5": { maxTokens: 128000 } } } } },
			{ version: 1, providers: { Minnyat: { baseUrl: "http://example.test/v1" } } },
			{ version: 1, providers: { "a/b": { baseUrl: "https://example.test/v1" } } },
		]) {
			const saved = run(["config", "write", "pi-models"], { ...env, __stdin: JSON.stringify(draft) });
			assert.equal(saved.status, 0, `${JSON.stringify(draft)}: ${saved.stderr}`);
		}
		const fine = run(["config", "write", "pi-models"], { ...env, __stdin: overrides({ "gpt-5.5": { contextWindow: 400000, maxTokens: 128000 } }) });
		assert.equal(fine.status, 0, fine.stderr);
		const legacy = JSON.stringify({ version: 1, providers: { Minnyat: { baseUrl: "https://example.test/v1", contextWindow: 200000, maxTokens: 32000 } } });
		assert.equal(run(["config", "write", "pi-models"], { ...env, __stdin: legacy }).status, 0, "legacy endpoint-level limits are a sync warning, not a save error");
		assert.equal(run(["config", "write", "pi-models"], { ...env, __stdin: '{"version":1,"providers":{}}' }).status, 0, "an empty catalog file (the form seed) saves");

		const help = run(["--help"]);
		assert.match(help.stdout, /pteam jobs list/);
		assert.match(help.stdout, /pteam jobs show <id>/);
		assert.match(help.stdout, /sections: .*\bjobs\b/);
	}

	// --- config read/write: the file as shown, the file as it is now ---------
	// Pi rewrites its own settings.json, and the form used to write its stale copy
	// straight over those changes; a corrupt file was reported as "does not exist".
	{
		const agentDir = join(sandbox, "pi", "agent");
		mkdirSync(agentDir, { recursive: true });
		const settings = join(agentDir, "settings.json");
		rmSync(settings, { force: true });

		const absent = run(["config", "read", "pi-settings"]);
		assert.equal(absent.status, 0, absent.stderr);
		assert.equal(absent.json.exists, false);
		assert.equal(absent.json.rev, "absent", "no file has a fingerprint of its own: 'absent'");

		// A write with the right rev lands, and hands back the new fingerprint.
		const first = run(["config", "write", "pi-settings", "--rev", absent.json.rev], { __stdin: '{"theme":"light","unknownKey":{"keep":"me"}}' });
		assert.equal(first.status, 0, first.stderr);
		assert.match(first.json.rev, /^[0-9a-f]{64}$/);

		const read = run(["config", "read", "pi-settings"]);
		assert.equal(read.json.rev, first.json.rev, "what a write returns is what the next read reports");
		assert.equal(read.json.invalid, undefined);

		// The file changes behind the form's back (Pi, or the user's editor).
		writeFileSync(settings, '{"theme":"dark","changedByPi":true}');
		const stale = run(["config", "write", "pi-settings", "--rev", read.json.rev], { __stdin: '{"theme":"light"}' });
		assert.notEqual(stale.status, 0, "a write over a file that changed since it was read is refused");
		assert.match(stale.stderr, /CONFIG_CHANGED/);
		assert.equal(readFileSync(settings, "utf8"), '{"theme":"dark","changedByPi":true}', "and the file is exactly as it was");

		// No --rev keeps the old, unconditional behaviour for scripts.
		const blind = run(["config", "write", "pi-settings"], { __stdin: '{"theme":"light"}' });
		assert.equal(blind.status, 0, blind.stderr);

		// A file that exists but does not parse is not "absent".
		writeFileSync(settings, '{"theme": "light",');
		const broken = run(["config", "read", "pi-settings"]);
		assert.equal(broken.status, 0, broken.stderr);
		assert.equal(broken.json.exists, true, "a corrupt file still exists");
		assert.match(broken.json.invalid.message, /JSON/);
		assert.equal(broken.json.raw, '{"theme": "light",', "its text is handed over so it can be repaired");
		assert.deepEqual(broken.json.data, {});
		assert.notEqual(broken.json.rev, "absent");

		assert.notEqual(run(["config", "write", "pi-settings", "--bogus", "x"], { __stdin: "{}" }).status, 0, "an unknown write flag is refused");
	}

	// --- pi-settings: the model fields offer what pi's own models.json has ----
	{
		const agentDir = join(sandbox, "pi", "agent");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), "{}");
		const models = join(agentDir, "models.json");

		rmSync(models, { force: true });
		assert.equal(run(["config", "read", "pi-models"]).json.catalog.status, "missing");
		const plain = run(["config", "read", "pi-settings"]);
		const plainFields = plain.json.schema.groups.flatMap((group) => group.fields);
		assert.equal(plainFields.find((f) => f.path === "defaultProvider").type, "string", "no models.json: still a text box");
		assert.equal(plainFields.find((f) => f.path === "defaultModel").type, "string");

		writeFileSync(
			models,
			JSON.stringify({
				providers: {
					Minnyat: { models: [{ id: "gpt-5.4" }, { id: "gpt-5.6-sol", name: "GPT 5.6 Sol", contextWindow: 1050000, maxTokens: 128000, reasoning: true, input: ["text", "image"], cost: { input: 1 } }, "plain-string-id", { name: "no id" }] },
					ollama: { models: [{ id: "llama3.1:8b" }] },
					empty: {},
				},
			}),
		);
		const received = run(["config", "read", "pi-models"]).json.catalog;
		assert.equal(received.status, "ready");
		assert.deepEqual(received.byProvider.Minnyat, ["gpt-5.4", "gpt-5.6-sol", "plain-string-id"]);
		assert.deepEqual(received.byProvider.empty, []);
		assert.deepEqual(received.detail.Minnyat["gpt-5.4"], {}, "an entry with no metadata stays empty, not malformed");
		assert.deepEqual(
			received.detail.Minnyat["gpt-5.6-sol"],
			{ name: "GPT 5.6 Sol", contextWindow: 1050000, maxTokens: 128000, reasoning: true, input: ["text", "image"] },
			"known metadata travels; unknown keys like cost do not",
		);
		const fed = run(["config", "read", "pi-settings"]);
		const fields = fed.json.schema.groups.flatMap((group) => group.fields);
		const provider = fields.find((f) => f.path === "defaultProvider");
		assert.equal(provider.type, "enum");
		assert.deepEqual(provider.enum, ["Minnyat", "empty", "ollama"], "every provider in the file, sorted");
		const model = fields.find((f) => f.path === "defaultModel");
		assert.equal(model.optionsBy.path, "defaultProvider");
		assert.equal(model.optionsBy.source, "pi-models", "runtime-sourced: never refused on save, text box when empty");
		assert.deepEqual(model.optionsBy.map.Minnyat, ["gpt-5.4", "gpt-5.6-sol", "plain-string-id"], "ids only; an entry with no id is skipped");
		assert.deepEqual(model.optionsBy.map.empty, []);

		// A corrupt models.json is an empty catalog, not a failed read.
		writeFileSync(models, "{ not json");
		assert.equal(run(["config", "read", "pi-models"]).json.catalog.status, "invalid");
		const corrupt = run(["config", "read", "pi-settings"]);
		assert.equal(corrupt.status, 0, corrupt.stderr);
		assert.equal(corrupt.json.schema.groups.flatMap((g) => g.fields).find((f) => f.path === "defaultProvider").type, "string");
	}
} finally {
	rmSync(sandbox, { recursive: true, force: true });
}

console.log("cli-contract tests passed");
