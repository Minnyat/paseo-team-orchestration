#!/usr/bin/env node
// multihost-scenario.mjs — the automated part of the multi-host test plan
// (docs/multi-host.md), run against the daemons `multihost-lab.sh up` started.
//
//   scripts/lab/multihost-lab.sh test        (sets HOME + endpoint env, then runs this)
//
// Every step drives the SHIPPED tools (remote-paseo.mjs, model-routing.mjs,
// preflight.mjs) — never the paseo CLI directly, except to break a host on
// purpose. Prints one line per check and a JSON summary; exit 1 on any FAIL.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACK = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const [root, controller, ...remotes] = process.argv.slice(2);
if (!root || !controller || remotes.length === 0) {
	console.error("usage: multihost-scenario.mjs <lab-root> <controller-id> <remote-id>...");
	process.exit(1);
}

const results = [];
function check(name, ok, detail = "") {
	results.push({ name, ok: Boolean(ok), detail });
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

function tool(script, args, env = {}) {
	const out = spawnSync(process.execPath, [join(PACK, "scripts", script), ...args], {
		encoding: "utf8",
		env: { ...process.env, ...env },
		timeout: 180000,
	});
	let json = null;
	try {
		json = JSON.parse(out.stdout);
	} catch {}
	return { status: out.status, json, stdout: out.stdout, stderr: out.stderr };
}
const remote = (args, env) => tool("remote-paseo.mjs", args, env);
const envName = (id) => `PASEO_LAB_${id.toUpperCase().replace(/-/g, "_")}`;
const routeOf = (cluster, hostId, cls) => cluster.hosts[hostId].routes[cls];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitIdle(ref, timeoutMs = 30000) {
	const until = Date.now() + timeoutMs;
	let last = null;
	while (Date.now() < until) {
		last = remote(["status", "--agent-ref", ref]).json;
		const status = last?.data?.Status ?? last?.data?.status;
		if (status && status !== "running" && status !== "initializing") return last;
		await sleep(500);
	}
	return last;
}

function lastMessage(hostId, agentId) {
	// `paseo logs` is not wrapped by remote-paseo.mjs (observation of output is
	// the agent's report, not the wrapper's job) — read it directly here.
	const endpoint = process.env[envName(hostId)];
	const hostArgs = endpoint ? ["--host", endpoint] : [];
	try {
		return execFileSync("paseo", ["logs", agentId, ...hostArgs], { encoding: "utf8", timeout: 30000 });
	} catch (error) {
		return String(error.stdout ?? error.message);
	}
}

const cluster = JSON.parse(
	execFileSync("cat", [join(root, controller, ".paseo-team-orchestration", "cluster-routing.local.json")], { encoding: "utf8" }),
);

// 1. The cluster file the lab generated passes the pack's own validator.
{
	const r = tool("model-routing.mjs", ["validate", "--cluster", "--json"]);
	check("cluster file validates", r.status === 0, r.status === 0 ? "" : (r.stdout || r.stderr).slice(0, 300));
}

// 2. Per remote host: reachable, sees its own providers, models from ITS inventory.
for (const id of remotes) {
	const h = remote(["health", "--host-id", id]);
	check(`${id}: health`, h.json?.ok === true, h.json?.code ?? "");
	const p = remote(["providers", "--host-id", id]);
	const names = (p.json?.data ?? []).map((x) => x.provider);
	const fam = routeOf(cluster, id, "CODING_MEDIUM").paseoProvider;
	check(`${id}: role provider ${fam} registered`, names.includes(fam), names.filter((n) => n.includes("-")).join(","));
	const m = remote(["models", "--host-id", id, "--provider", fam]);
	const want = routeOf(cluster, id, "CODING_MEDIUM").model;
	const ids = (m.json?.data ?? []).map((x) => x.id);
	check(`${id}: routed model ${want} is in that host's inventory`, ids.includes(want), ids.join(","));
	const pf = tool("preflight.mjs", ["--json", "--host-id", id]);
	const pfJson = pf.json;
	const remoteChecks = (pfJson?.checks ?? []).filter((c) => /remote|endpoint|cluster|host/i.test(c.name ?? c.id ?? ""));
	check(
		`${id}: preflight --host-id remote checks have no FAIL`,
		pfJson && remoteChecks.every((c) => (c.status ?? c.level) !== "fail"),
		remoteChecks.map((c) => `${c.name ?? c.id}=${c.status ?? c.level}`).join(" "),
	);
}

// 3. Multi-project on ONE remote host: two repos, two workspaces, reuse holds.
const [hostB, hostC = remotes[0]] = remotes;
const projB = join(root, hostB, "projects");
const second = join(projB, "demo2");
mkdirSync(second, { recursive: true });
execFileSync("git", ["init", "-q", "-b", "main"], { cwd: second });
writeFileSync(join(second, "README.md"), "# demo2\n");
const wsA = remote(["workspace-create", "--host-id", hostB, "--path", join(projB, "demo"), "--title", "demo"]);
const wsA2 = remote(["workspace-create", "--host-id", hostB, "--path", join(projB, "demo"), "--title", "demo"]);
const wsB = remote(["workspace-create", "--host-id", hostB, "--path", second, "--title", "demo2"]);
check(`${hostB}: workspace for project demo`, wsA.json?.ok === true, wsA.json?.code ?? "");
check(
	`${hostB}: second workspace-create on the same path reuses it`,
	wsA2.json?.reused === true && wsA2.json?.data?.workspaceId === wsA.json?.data?.workspaceId,
	JSON.stringify({ reused: wsA2.json?.reused }),
);
check(
	`${hostB}: second project gets its own workspace`,
	wsB.json?.ok === true && wsB.json?.data?.workspaceId !== wsA.json?.data?.workspaceId,
);

// 4. Run Peers on two remote hosts in parallel, each from that host's route.
function runPeer(hostId, workspace, cls, prompt) {
	const route = routeOf(cluster, hostId, cls);
	return remote([
		"run", "--host-id", hostId, "--workspace", workspace,
		"--provider", `${route.paseoProvider}/${route.model}`, "--thinking", route.thinking,
		"--title", `lab-${cls}`, "--label", `team.model-class=${cls}`, "--prompt", prompt,
	]);
}
const wsC = remote(["workspace-create", "--host-id", hostC, "--path", join(root, hostC, "projects", "demo"), "--title", "demo"]);
const runs = [
	[hostB, wsA.json?.data?.workspaceId, "CODING_MEDIUM", "project demo task"],
	[hostB, wsB.json?.data?.workspaceId, "FAST_READ", "project demo2 task"],
	[hostC, wsC.json?.data?.workspaceId, "REVIEW_HIGH", "review on another device"],
].map(([h, w, c, p]) => ({ h, c, p, r: runPeer(h, w, c, p) }));
for (const { h, c, r } of runs) {
	const detail = r.json?.ok ? r.json.agentRef : `${r.json?.code}: ${r.json?.message ?? ""}`.slice(0, 400);
	check(`${h}: run ${c} peer`, r.json?.ok === true && r.json?.agentRef?.startsWith(`${h}/`), detail);
}
for (const { h, c, p, r } of runs) {
	if (!r.json?.ok) continue;
	const ref = r.json.agentRef;
	await waitIdle(ref);
	const log = lastMessage(h, ref.split("/")[1]);
	check(`${h}: ${c} turn ran on THAT daemon`, log.includes(`host=${h}`) && log.includes(p.split(" ")[0]), log.split("\n").find((l) => l.includes("LAB_ACK")) ?? log.slice(0, 200));
}
// The agent of host B must not be visible as an agent of host C (no cross-talk).
{
	const onC = remote(["agents", "--host-id", hostC]).json?.data ?? [];
	const bIds = runs.filter((x) => x.h === hostB && x.r.json?.ok).map((x) => x.r.json.agentRef.split("/")[1]);
	check(`${hostC}: does not list ${hostB}'s agents`, bIds.every((id) => !JSON.stringify(onC).includes(id)));
}

// 5. Follow-up, cancel, archive by composite AGENT_REF.
const first = runs.find((x) => x.r.json?.ok);
if (first) {
	const ref = first.r.json.agentRef;
	const s = remote(["send", "--agent-ref", ref, "--prompt", "follow-up from lead", "--wait"]);
	check("send follow-up by AGENT_REF", s.json?.ok === true, s.json?.code ?? "");
	const c = remote(["cancel", "--agent-ref", ref]);
	check("cancel by AGENT_REF", c.json?.ok === true, c.json?.code ?? "");
	const a = remote(["archive", "--agent-ref", ref]);
	check("archive by AGENT_REF", a.json?.ok === true, a.json?.code ?? "");
	const wrong = remote(["status", "--agent-ref", `${hostC}/${ref.split("/")[1]}`]);
	check("an agent id asked of the WRONG host is not found there", wrong.json?.paseoError?.code === "AGENT_NOT_FOUND", wrong.json?.code ?? "");
}

// 6. Failure modes from the test plan.
{
	const r = remote(["health", "--host-id", hostB], { [envName(hostB)]: "" });
	check("endpoint env unset → ENDPOINT_ENV_MISSING (no fallback to local)", r.json?.code === "ENDPOINT_ENV_MISSING", r.json?.code ?? "");
	const u = remote(["health", "--host-id", "no-such-host"]);
	check("unknown host id is refused", u.json?.ok === false, u.json?.code ?? "");
	const l = remote(["health", "--host-id", controller]);
	check("controller host is refused by the remote wrapper (use MCP)", l.json?.code === "LOCAL_HOST_UNSUPPORTED", l.json?.code ?? "");
	// Kill one daemon mid-cluster: it must be reported, the others stay usable.
	execFileSync("paseo", ["daemon", "stop"], { env: { ...process.env, HOME: join(root, hostC) } });
	const dead = remote(["health", "--host-id", hostC]);
	check(`${hostC} down → HOST_ROUTE_UNAVAILABLE`, dead.json?.code === "HOST_ROUTE_UNAVAILABLE", `${dead.json?.code}: ${String(dead.json?.message ?? "").slice(0, 160)}`);
	const alive = remote(["health", "--host-id", hostB]);
	check(`${hostB} still healthy while ${hostC} is down`, alive.json?.ok === true);
	const bad = remote(["run", "--host-id", hostC, "--workspace", "wks_x", "--provider", `${routeOf(cluster, hostC, "FAST_READ").paseoProvider}/${routeOf(cluster, hostC, "FAST_READ").model}`, "--thinking", "off", "--prompt", "x"]);
	check(`run on a dead ${hostC} fails, never lands elsewhere`, bad.json?.code === "HOST_ROUTE_UNAVAILABLE" && bad.json?.hostId === hostC, bad.json?.code ?? "");
	execFileSync("paseo", ["daemon", "start", "--json"], { env: { ...process.env, HOME: join(root, hostC) } });
	const back = remote(["health", "--host-id", hostC]);
	check(`${hostC} back after restart`, back.json?.ok === true);
}

// 7. Error reason is surfaced (an invalid mode is a daemon-side refusal).
{
	const r = remote(["run", "--host-id", hostB, "--workspace", wsA.json?.data?.workspaceId ?? "x", "--provider", `${routeOf(cluster, hostB, "FAST_READ").paseoProvider}/${routeOf(cluster, hostB, "FAST_READ").model}`, "--thinking", "off", "--mode", "no-such-mode", "--prompt", "x"]);
	check("a daemon refusal carries the daemon's own reason", r.json?.ok === false && r.json?.paseoError?.code === "AGENT_CREATE_FAILED" && /Invalid mode/.test(r.json?.message ?? ""), String(r.json?.message ?? "").slice(0, 200));
}

const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({ total: results.length, passed: results.length - failed.length, failed: failed.map((f) => f.name) }, null, 2));
process.exit(failed.length ? 1 : 0);
