#!/usr/bin/env node
// multihost-deep.mjs — the harder half of the multi-host test plan, against the
// daemons `multihost-lab.sh up` started (run by `multihost-lab.sh test`).
//
// Uses the fake ACP agent's directives (LAB_EXEC / LAB_MCP) so seats DO real
// work: a scripted Lead calls the daemon's MCP, an Engineer commits and pushes,
// a Reviewer on another host checks out the exact SHA. Prints PASS/FAIL/INFO
// lines and a JSON summary; exit 1 on any FAIL. INFO = a measured behaviour
// worth knowing that is not a defect of this pack.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACK = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const [root, controller, ...remotes] = process.argv.slice(2);
const [hostB, hostC = remotes[0]] = remotes;
const ctlHome = join(root, controller);
const clusterPath = join(ctlHome, ".paseo-team-orchestration", "cluster-routing.local.json");
const cluster = JSON.parse(readFileSync(clusterPath, "utf8"));
const envName = (id) => `PASEO_LAB_${id.toUpperCase().replace(/-/g, "_")}`;
const route = (h, cls) => cluster.hosts[h].routes[cls];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, detail = "") {
	results.push({ name, ok: Boolean(ok), detail });
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${String(detail).slice(0, 300)}` : ""}`);
}
function info(name, detail) {
	results.push({ name, ok: true, info: true, detail });
	console.log(`INFO  ${name}  — ${String(detail).slice(0, 400)}`);
}

function remote(args, env = {}) {
	const out = spawnSync(process.execPath, [join(PACK, "scripts/remote-paseo.mjs"), ...args], {
		encoding: "utf8",
		env: { ...process.env, ...env },
		timeout: 180000,
	});
	let json = null;
	try {
		json = JSON.parse(out.stdout);
	} catch {}
	return { status: out.status, json, stdout: out.stdout };
}
function remoteAsync(args) {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [join(PACK, "scripts/remote-paseo.mjs"), ...args], { env: process.env });
		let stdout = "";
		child.stdout.on("data", (d) => (stdout += d));
		child.on("close", (status) => {
			let json = null;
			try {
				json = JSON.parse(stdout);
			} catch {}
			resolve({ status, json, stdout });
		});
	});
}
/** paseo CLI as the controller (or another host's HOME for local ops). */
function paseo(args, { home = ctlHome, host } = {}) {
	const hostArgs = host ? ["--host", process.env[envName(host)]] : [];
	const r = spawnSync("paseo", [...args, ...hostArgs], { encoding: "utf8", env: { ...process.env, HOME: home }, timeout: 180000 });
	return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
function logsOf(agentId, host) {
	return paseo(["logs", agentId], host ? { host } : {}).stdout;
}
function labResults(log) {
	return log
		.split("\n")
		.filter((l) => l.startsWith("LAB_RESULT "))
		.map((l) => JSON.parse(l.slice(l.indexOf(" ", 11) + 1)));
}
async function waitIdle(agentId, host, timeoutMs = 60000) {
	const until = Date.now() + timeoutMs;
	let status = null;
	while (Date.now() < until) {
		const r = paseo(["inspect", agentId, "--json"], host ? { host } : {});
		try {
			status = JSON.parse(r.stdout).Status;
		} catch {
			status = null;
		}
		if (status && status !== "running" && status !== "initializing") return status;
		await sleep(400);
	}
	return status;
}
/** A seat on the CONTROLLER (local daemon), as a Human or a Lead would start it. */
function localRun(provider, prompt, { cwd, title, mode } = {}) {
	const args = ["run", "--provider", provider, "--cwd", cwd, "--title", title, "-d", "--json"];
	if (mode) args.push("--mode", mode);
	const r = paseo([...args, prompt]);
	return JSON.parse(r.stdout).agentId;
}
async function remoteSeat(hostId, workspace, cls, prompt, extra = []) {
	const r = route(hostId, cls);
	return remote([
		"run", "--host-id", hostId, "--workspace", workspace,
		"--provider", `${r.paseoProvider}/${r.model}`, "--thinking", r.thinking,
		"--title", `deep-${cls}`, "--label", `team.model-class=${cls}`, "--prompt", prompt, ...extra,
	]);
}
const workspaceOn = (hostId, path) =>
	remote(["workspace-create", "--host-id", hostId, "--path", path, "--title", "demo"]).json?.data?.workspaceId;

// --- D1. Daemon password on a remote host --------------------------------------
{
	const secured = remotes.find((id) => /password=/.test(process.env[envName(id)] ?? ""));
	if (!secured) info("D1 auth", "no host was started with --secure; skipped");
	else {
		const good = process.env[envName(secured)];
		const bare = good.replace(/\?password=[^&]*/, "");
		const wrong = good.replace(/password=[^&]*/, "password=not-it");
		const noPw = remote(["health", "--host-id", secured], { [envName(secured)]: bare });
		check(`D1 ${secured}: no password → HOST_AUTH_FAILED`, noPw.json?.code === "HOST_AUTH_FAILED", noPw.json?.message);
		const bad = remote(["health", "--host-id", secured], { [envName(secured)]: wrong });
		check(`D1 ${secured}: wrong password → HOST_AUTH_FAILED`, bad.json?.code === "HOST_AUTH_FAILED", bad.json?.message);
		check("D1 neither password is ever printed", !noPw.stdout.includes("lab-pw") && !bad.stdout.includes("not-it") && !bad.stdout.includes("lab-pw"));
		const ok = remote(["health", "--host-id", secured]);
		check(`D1 ${secured}: right password → healthy`, ok.json?.ok === true, ok.json?.code);
	}
}

// --- D2. Native Paseo host registry --------------------------------------------
let serverIdOf = {};
{
	let hosts = [];
	for (let i = 0; i < 20; i++) {
		hosts = JSON.parse(paseo(["host", "ls", "--json"]).stdout || "[]");
		if (remotes.every((id) => hosts.find((h) => h.label === id)?.status === "online")) break;
		await sleep(500);
	}
	for (const id of remotes) {
		const h = hosts.find((x) => x.label === id);
		check(`D2 registry: ${id} online with team.host-id meta`, h?.status === "online" && h?.metadata?.["team.host-id"] === id, h ? `${h.status} ${h.serverId}` : "missing");
		if (h?.serverId) serverIdOf[id] = h.serverId;
	}
}

// --- D3. A Lead on the controller seats a Peer on another host through MCP -----
{
	const ws = workspaceOn(hostB, join(root, hostB, "projects", "demo"));
	const before = JSON.parse(paseo(["ls", "--json"], { host: hostB }).stdout).length;
	const ask = `node --input-type=module -e 'const m=await import(${JSON.stringify(join(PACK, "scripts/team-communication.mjs"))}); try { await m.sendPeerMessage({kind:"question",message:"which file?",taskId:"T-D3"}); console.log("SENT") } catch (e) { console.log("ASK_CODE=" + e.code) }'`;
	const peerPrompt = `remote peer via MCP\nLAB_EXEC: echo MCP_PEER_RAN_AT=$(pwd)\nLAB_EXEC: ${ask}`;
	const leadPrompt = [
		"lead seats a remote peer",
		"LAB_MCP: list_hosts {}",
		`LAB_MCP: create_agent ${JSON.stringify({
			serverId: serverIdOf[hostB],
			title: "deep-mcp-peer",
			provider: `${route(hostB, "CODING_MEDIUM").paseoProvider}/${route(hostB, "CODING_MEDIUM").model}`,
			workspaceId: ws,
			initialPrompt: peerPrompt,
			settings: { modeId: "auto" },
			labels: { "team.model-class": "CODING_MEDIUM" },
		})}`,
		`LAB_MCP: list_workspaces ${JSON.stringify({ serverId: serverIdOf[hostB] })}`,
	].join("\n");
	const lead = localRun("claude-lead/lab-model", leadPrompt, { cwd: join(ctlHome, "projects", "demo"), title: "deep-lead", mode: "auto" });
	await waitIdle(lead);
	const [hostsOut, created] = labResults(logsOf(lead));
	check("D3 Lead sees the registry through MCP list_hosts", hostsOut?.ok && hostsOut.structured.hosts.length === remotes.length);
	check(`D3 MCP create_agent with serverId lands on ${hostB}`, created?.ok && created.structured?.serverId === serverIdOf[hostB], created?.text ?? JSON.stringify(created));
	if (created?.ok) {
		const peerId = created.structured.agentId;
		await waitIdle(peerId, hostB);
		const log = logsOf(peerId, hostB);
		check(
			"D3 peer_ask_lead from a cross-host Peer → PARENT_LEAD_REMOTE (never a blind local send)",
			log.includes("ASK_CODE=PARENT_LEAD_REMOTE"),
			log.split("\n").find((l) => l.includes("ASK_CODE") || l.includes("SENT")) ?? "",
		);
		check(`D3 that Peer's work ran on ${hostB}'s checkout`, log.includes(`MCP_PEER_RAN_AT=${join(root, hostB, "projects", "demo")}`), log.split("\n").find((l) => l.includes("MCP_PEER")) ?? "");
		const inspected = JSON.parse(paseo(["inspect", peerId, "--json"], { host: hostB }).stdout);
		const labels = inspected.Labels ?? inspected.labels ?? {};
		info("D3 remote child's parent link", `labels=${JSON.stringify(labels)} ParentAgentId=${inspected.ParentAgentId ?? "none"}`);
		check("D3 remote child is NOT on the controller", !JSON.parse(paseo(["ls", "-g", "--json"]).stdout).some((a) => a.id === peerId));
		const after = JSON.parse(paseo(["ls", "--json"], { host: hostB }).stdout).length;
		check(`D3 exactly one new agent on ${hostB}`, after === before + 1, `${before} → ${after}`);
	}
	// create_workspace over MCP on a path that already has one: measured, not ours.
	const dup = localRun(
		"claude-lead/lab-model",
		`dup check\nLAB_MCP: create_workspace ${JSON.stringify({ serverId: serverIdOf[hostB], isolation: "local", path: join(root, hostB, "projects", "demo") })}`,
		{ cwd: join(ctlHome, "projects", "demo"), title: "deep-dup", mode: "auto" },
	);
	await waitIdle(dup);
	const [dupOut] = labResults(logsOf(dup));
	if (dupOut?.ok && dupOut.structured.workspaceId !== ws) {
		info("D3 MCP create_workspace does NOT reuse", `a second workspace (${dupOut.structured.workspaceId}) was created on a path that already had ${ws}; remote-paseo.mjs workspace-create reuses — Leads must list_workspaces first`);
	} else check("D3 MCP create_workspace reuses the existing workspace", dupOut?.structured?.workspaceId === ws);
}

// --- D4. Cross-host review chain on ONE pushed SHA ------------------------------
{
	const engDir = join(ctlHome, "projects", "demo");
	const task = `T-LAB-${Date.now().toString(36)}`;
	const engineer = localRun(
		"pi-peer/lab/lab-model",
		[
			"engineer",
			`LAB_EXEC: git checkout -q -B agent/${task} origin/main && echo "v1 ${task}" > feature.txt && git add feature.txt && git commit -qm "feat: ${task} v1" && git rev-parse HEAD`,
			`LAB_EXEC: git push -q -u origin HEAD:refs/heads/agent/${task} && echo pushed`,
		].join("\n"),
		{ cwd: engDir, title: "deep-engineer" },
	);
	await waitIdle(engineer);
	const [commit, push] = labResults(logsOf(engineer));
	const sha1 = commit?.stdout?.trim();
	check("D4 Engineer (controller) commits and pushes the task branch", /^[0-9a-f]{40}$/.test(sha1 ?? "") && push?.stdout === "pushed", JSON.stringify(push));

	const revDir = join(root, hostC, "projects", "demo");
	const ws = workspaceOn(hostC, revDir);
	// One worktree per review, named by task+round; prune first, because a
	// worktree directory deleted by hand stays registered and makes the next
	// `worktree add` on that path fail ("missing but already registered").
	const review = (sha, tag) => [
		`reviewer ${tag}`,
		`LAB_EXEC: git worktree prune && git fetch -q origin agent/${task} && git worktree add -q --detach ../rev-${task}-${tag} ${sha} && cd ../rev-${task}-${tag} && test "$(git rev-parse HEAD)" = "${sha}" && echo "HEAD_OK $(git rev-parse HEAD)" && cat feature.txt`,
	].join("\n");
	const r1 = await remoteSeat(hostC, ws, "REVIEW_HIGH", review(sha1, "r1"));
	check(`D4 Reviewer seated on ${hostC} (password host)`, r1.json?.ok, r1.json?.message);
	if (r1.json?.ok) {
		const id = r1.json.agentRef.split("/")[1];
		await waitIdle(id, hostC);
		const [out] = labResults(logsOf(id, hostC));
		check(`D4 Reviewer on ${hostC} checks out EXACTLY the candidate SHA`, out?.ok && out.stdout.startsWith(`HEAD_OK ${sha1}`) && out.stdout.includes(`v1 ${task}`), out?.stdout ?? out?.stderr);
	}
	// Correction round: a new SHA; the old review must not be mistaken for it.
	const fix = localRun(
		"pi-peer/lab/lab-model",
		`engineer fix\nLAB_EXEC: echo "v2 ${task}" > feature.txt && git commit -qam "fix: ${task} v2" && git push -q origin HEAD:refs/heads/agent/${task} && git rev-parse HEAD`,
		{ cwd: engDir, title: "deep-engineer-fix" },
	);
	await waitIdle(fix);
	const sha2 = labResults(logsOf(fix))[0]?.stdout?.trim();
	check("D4 correction produces a new SHA", /^[0-9a-f]{40}$/.test(sha2 ?? "") && sha2 !== sha1);
	const r2 = await remoteSeat(hostC, ws, "REVIEW_HIGH", review(sha2, "r2"));
	if (r2.json?.ok) {
		const id = r2.json.agentRef.split("/")[1];
		await waitIdle(id, hostC);
		const [out] = labResults(logsOf(id, hostC));
		check("D4 re-review sees the corrected SHA and content", out?.ok && out.stdout.startsWith(`HEAD_OK ${sha2}`) && out.stdout.includes(`v2 ${task}`), out?.stdout ?? out?.stderr);
	}
	// A reviewer whose checkout is NOT the candidate must notice.
	const stale = await remoteSeat(hostC, ws, "REVIEW_HIGH", `stale reviewer\nLAB_EXEC: cd ../rev-${task}-r1 && test "$(git rev-parse HEAD)" = "${sha2}" && echo SHOULD_NOT_PASS`);
	if (stale.json?.ok) {
		const id = stale.json.agentRef.split("/")[1];
		await waitIdle(id, hostC);
		const [out] = labResults(logsOf(id, hostC));
		check("D4 a stale checkout fails the HEAD == CANDIDATE_SHA check", out && out.ok === false, JSON.stringify(out));
	}
}

// --- D5. Concurrency: 12 seats across two hosts at once --------------------------
{
	const wsB = workspaceOn(hostB, join(root, hostB, "projects", "demo"));
	const wsC = workspaceOn(hostC, join(root, hostC, "projects", "demo"));
	const jobs = Array.from({ length: 12 }, (_, i) => {
		const h = i % 2 ? hostC : hostB;
		const token = `TOK-${i}-${Math.random().toString(36).slice(2, 8)}`;
		const r = route(h, "FAST_READ");
		return { h, token, p: remoteAsync([
			"run", "--host-id", h, "--workspace", h === hostB ? wsB : wsC,
			"--provider", `${r.paseoProvider}/${r.model}`, "--thinking", r.thinking,
			"--title", `stress-${i}`, "--prompt", `stress ${token}`,
		]) };
	});
	const t0 = Date.now();
	const done = await Promise.all(jobs.map(async (j) => ({ ...j, r: await j.p })));
	const created = done.filter((j) => j.r.json?.ok);
	check("D5 12 parallel remote runs all created", created.length === 12, `${created.length}/12 in ${Date.now() - t0}ms; failures: ${done.filter((j) => !j.r.json?.ok).map((j) => j.r.json?.code).join(",")}`);
	let landed = 0;
	for (const j of created) {
		const id = j.r.json.agentRef.split("/")[1];
		await waitIdle(id, j.h);
		if (logsOf(id, j.h).includes(`host=${j.h} `) && logsOf(id, j.h).includes(j.token)) landed++;
	}
	check("D5 every run's turn ran on its own host with its own prompt", landed === created.length, `${landed}/${created.length}`);
	const onC = paseo(["ls", "--json"], { host: hostC }).stdout;
	check(`D5 no ${hostB} token leaked into ${hostC}'s agent list`, done.filter((j) => j.h === hostB).every((j) => !onC.includes(j.token)));
}

// --- D6. Prompt edge cases survive argv end to end -------------------------------
{
	const ws = workspaceOn(hostB, join(root, hostB, "projects", "demo"));
	const nasty = `Tiếng Việt có dấu ✓ 🚀 "quotes" 'single' $(echo PWNED) \`id\` ; && | > %PATH% !x`;
	const r = await remoteSeat(hostB, ws, "FAST_READ", nasty);
	if (r.json?.ok) {
		const id = r.json.agentRef.split("/")[1];
		await waitIdle(id, hostB);
		const log = logsOf(id, hostB);
		check("D6 unicode + shell metacharacters arrive literally (no shell expansion)", log.includes("Tiếng Việt có dấu ✓ 🚀") && log.includes("$(echo PWNED)") && !log.includes("prompt=\"Tiếng Việt có dấu ✓ 🚀 \"quotes\" 'single' PWNED"), log.split("\n").find((l) => l.startsWith("LAB_ACK")));
	} else check("D6 nasty prompt run", false, r.json?.message);
	const big = await remoteSeat(hostB, ws, "FAST_READ", "x".repeat(19000));
	check("D6 a 19 000-char prompt is accepted", big.json?.ok === true, big.json?.code);
	const tooBig = await remoteSeat(hostB, ws, "FAST_READ", "x".repeat(20001));
	check("D6 a 20 001-char prompt → PROMPT_TOO_LONG before any CLI call", tooBig.json?.code === "PROMPT_TOO_LONG", tooBig.json?.code);
	const briefFile = join(root, "brief.txt");
	writeFileSync(briefFile, "brief from file\nsecond line ✓\n");
	const rf = remote(["run", "--host-id", hostB, "--workspace", ws, "--provider", `${route(hostB, "FAST_READ").paseoProvider}/${route(hostB, "FAST_READ").model}`, "--thinking", "off", "--brief", briefFile]);
	if (rf.json?.ok) {
		const id = rf.json.agentRef.split("/")[1];
		await waitIdle(id, hostB);
		check("D6 --brief <file> delivers the file's text", logsOf(id, hostB).includes("brief from file"));
	} else check("D6 --brief run", false, rf.json?.message);
}

// --- D7. Daemon restart while a turn is running ----------------------------------
{
	const ws = workspaceOn(hostB, join(root, hostB, "projects", "demo"));
	const r = await remoteSeat(hostB, ws, "CODING_MEDIUM", "long turn\nLAB_EXEC: sleep 15 && echo LONG_DONE");
	if (r.json?.ok) {
		const id = r.json.agentRef.split("/")[1];
		await sleep(1500);
		const restart = paseo(["daemon", "restart", "--json"], { home: join(root, hostB) });
		check(`D7 ${hostB} daemon restart mid-turn succeeds`, restart.status === 0, restart.stderr);
		let health = null;
		for (let i = 0; i < 30 && !health?.ok; i++) {
			await sleep(500);
			health = remote(["health", "--host-id", hostB]).json;
		}
		check(`D7 ${hostB} answers again after restart`, health?.ok === true);
		const st = remote(["status", "--agent-ref", r.json.agentRef]).json;
		const status = st?.data?.Status;
		info("D7 the interrupted agent after restart", `status=${status}; log has LONG_DONE=${logsOf(id, hostB).includes("LONG_DONE")} — the pack never auto-respawns it (docs: check state, then decide)`);
		check("D7 the interrupted agent is still addressable by AGENT_REF", st?.ok === true, st?.code);
	}
}

// --- D8. Strict preflight with a required host down; route model missing --------
{
	paseo(["daemon", "stop"], { home: join(root, hostB) });
	const pf = spawnSync(process.execPath, [join(PACK, "scripts/preflight.mjs"), "--json", "--strict", "--host-id", hostB], { encoding: "utf8", env: process.env, timeout: 180000 });
	let rows = [];
	try {
		rows = JSON.parse(pf.stdout).checks ?? [];
	} catch {}
	const remoteRow = rows.find((c) => (c.name ?? c.id) === `cluster-remote:${hostB}`);
	check(`D8 strict preflight FAILS while required ${hostB} is down`, pf.status !== 0 && (remoteRow?.status ?? remoteRow?.level) === "fail", `${remoteRow?.status ?? remoteRow?.level}: ${remoteRow?.detail ?? ""}`);
	paseo(["daemon", "start", "--json"], { home: join(root, hostB) });
	await sleep(1500);

	const saved = readFileSync(clusterPath, "utf8");
	try {
		const edited = JSON.parse(saved);
		edited.hosts[hostB].routes.FAST_READ.model = route(hostB, "FAST_READ").model.includes("/") ? "lab/ghost-model" : "ghost-model";
		writeFileSync(clusterPath, JSON.stringify(edited, null, 2));
		const pf2 = spawnSync(process.execPath, [join(PACK, "scripts/preflight.mjs"), "--json", "--host-id", hostB], { encoding: "utf8", env: process.env, timeout: 180000 });
		const row = (JSON.parse(pf2.stdout).checks ?? []).find((c) => (c.name ?? c.id) === `cluster-remote:${hostB}:route:FAST_READ`);
		// Must fail for the RIGHT reason: the model, not a provider still loading.
		check(`D8 a route model missing from ${hostB}'s inventory is a FAIL for that host`, (row?.status ?? row?.level) === "fail" && /MODEL_UNAVAILABLE|ghost-model/.test(row?.detail ?? ""), row?.detail);
		const healthyRow = (JSON.parse(pf2.stdout).checks ?? []).find((c) => (c.name ?? c.id) === `cluster-remote:${hostB}:route:CODING_MEDIUM`);
		check(`D8 right after a restart, a healthy route on ${hostB} still passes (provider "loading" is waited out)`, (healthyRow?.status ?? healthyRow?.level) === "pass", healthyRow?.detail);
	} finally {
		writeFileSync(clusterPath, saved);
	}
}

const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({ total: results.length, passed: results.filter((r) => r.ok && !r.info).length, info: results.filter((r) => r.info).length, failed: failed.map((f) => f.name) }, null, 2));
process.exit(failed.length ? 1 : 0);
