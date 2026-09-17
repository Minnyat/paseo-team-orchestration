// claude-team-mcp.test.mjs — the stdio MCP server that gives Claude the two
// team tools the Pi extension registers natively.
//
// The role gate is the point: peer_ask_lead must reach only a Peer's Lead, and
// team_watchdog must stay with Lead/Supervisor, whether or not the PreToolUse
// hook is installed. The transport is hand-rolled (zero deps), so the JSON-RPC
// framing is pinned here too.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { callTeamTool, handleMessage, TEAM_TOOLS, SERVER_NAME } from "../scripts/claude-team-mcp.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = join(root, "scripts", "claude-team-mcp.mjs");

// --- protocol -----------------------------------------------------------------

{
	const initialized = await handleMessage({
		jsonrpc: "2.0",
		id: 1,
		method: "initialize",
		params: { protocolVersion: "2025-06-18", capabilities: {} },
	});
	assert.equal(initialized.result.serverInfo.name, SERVER_NAME);
	assert.equal(initialized.result.protocolVersion, "2025-06-18");
	assert.ok(initialized.result.capabilities.tools);

	// Notifications carry no id and must never be answered.
	assert.equal(await handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" }), null);

	const listed = await handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" });
	// Parity with the Pi extension's registerTeamTools: a tool that exists on one
	// runtime and not the other is a capability the other runtime silently lacks.
	assert.deepEqual(
		listed.result.tools.map((tool) => tool.name).sort(),
		["lead_ask_supervisor", "peer_ask_lead", "team_fork", "team_lease", "team_watchdog"],
	);
	for (const tool of listed.result.tools) {
		assert.equal(tool.inputSchema.type, "object");
		assert.ok(tool.description.length > 0);
	}

	const unknown = await handleMessage({ jsonrpc: "2.0", id: 3, method: "does/not/exist" });
	assert.equal(unknown.error.code, -32601);
	const badCall = await handleMessage({ jsonrpc: "2.0", id: 4, method: "tools/call", params: {} });
	assert.equal(badCall.error.code, -32602);
	assert.equal(await handleMessage(null), null);
}

// --- role gate ----------------------------------------------------------------

{
	const peerOnly = await callTeamTool("peer_ask_lead", { kind: "question", message: "x" }, {
		PASEO_PI_ROLE: "lead",
	});
	assert.equal(peerOnly.isError, true);
	assert.match(peerOnly.content[0].text, /only to peer agents/);

	const leadOnly = await callTeamTool("team_watchdog", {}, { PASEO_PI_ROLE: "peer" });
	assert.equal(leadOnly.isError, true);
	assert.match(leadOnly.content[0].text, /only to lead or supervisor agents/);

	// No role at all is not a free pass.
	const unset = await callTeamTool("team_watchdog", {}, {});
	assert.equal(unset.isError, true);
	assert.match(unset.content[0].text, /PASEO_PI_ROLE=unset/);

	// The consult is the Lead's own channel: a Peer with it would route around
	// its Lead, and a Supervisor with it would be consulting itself.
	for (const role of ["peer", "supervisor"]) {
		const wrongRole = await callTeamTool(
			"lead_ask_supervisor",
			{ kind: "decision", question: "q", options: "a|b", evidence: "e", scope: "s", reversibility: "reversible" },
			{ PASEO_PI_ROLE: role },
		);
		assert.equal(wrongRole.isError, true);
		assert.match(wrongRole.content[0].text, /only to lead agents/i);
	}

	const unknownTool = await callTeamTool("rm_rf", {}, { PASEO_PI_ROLE: "lead" });
	assert.equal(unknownTool.isError, true);
	assert.match(unknownTool.content[0].text, /Unknown tool/);
}

// Every tool declares which roles may call it, and both are covered.
assert.deepEqual(
	TEAM_TOOLS.map((tool) => [tool.name, tool.roles]).sort(),
	[
		["lead_ask_supervisor", ["lead"]],
		["peer_ask_lead", ["peer"]],
		["team_fork", ["lead", "supervisor"]],
		["team_lease", ["lead", "supervisor"]],
		["team_watchdog", ["lead", "supervisor"]],
	],
);

// --- end to end over stdio ----------------------------------------------------

{
	const stdout = execFileSync(process.execPath, [serverPath], {
		encoding: "utf8",
		env: { ...process.env, PASEO_PI_ROLE: "peer" },
		input: [
			JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
			JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
			JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }),
			"not json at all",
			JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }),
			"",
		].join("\n"),
	});
	const messages = stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line));
	assert.deepEqual(messages.map((message) => message.id), [1, 2, null, 3]);
	assert.equal(messages[2].error.code, -32700, "a malformed line is answered, not fatal");
	assert.equal(messages[3].result.tools.length, TEAM_TOOLS.length);
}

// Every tool description is mirrored from policy-core: this file is plain .mjs
// and cannot import the .ts core, so drift between the two runtimes is exactly
// what this pack's parity tests exist to catch.
{
	// One description, two runtimes.
	const lease = TEAM_TOOLS.find((tool) => tool.name === "team_lease");
	const { teamLeaseToolDescription } = await import("../extensions/paseo-team-core/policy-core.ts");
	assert.equal(lease.description, teamLeaseToolDescription(), "the lease description must not drift");

	// Same parity rule for the fork tool, and one more for its reason set: the
	// enum in this schema is what a Claude Lead can even ASK for, so a reason
	// the core accepts but the schema omits is a capability this runtime lacks.
	const fork = TEAM_TOOLS.find((tool) => tool.name === "team_fork");
	const { teamForkToolDescription, FORK_REASONS } = await import("../extensions/paseo-team-core/policy-core.ts");
	assert.equal(fork.description, teamForkToolDescription(), "the fork description must not drift either");
	assert.deepEqual(
		[...fork.inputSchema.properties.reason.enum].sort(),
		[...FORK_REASONS].sort(),
		"the advertised fork reasons must be exactly the ones the core accepts",
	);

	// The fork schema must let a Lead SAY which mode the fork comes up in.
	// `paseo import` carries no mode and Paseo applies no provider default, so
	// team-fork.mjs moves the fork onto "auto" afterwards; a schema without this
	// field would make a deliberate narrowing ("plan" for a planning fork)
	// unreachable from this runtime while the Pi one has it.
	assert.equal(fork.inputSchema.properties.modeId.type, "string");

	// And for the consult tool. Its description is the one place a Lead is told
	// that the Supervisor — not the Human — is where an open question goes, so a
	// runtime carrying a weaker copy of that sentence is a runtime whose Lead
	// keeps interrupting the Human.
	const consult = TEAM_TOOLS.find((tool) => tool.name === "lead_ask_supervisor");
	const { leadAskSupervisorToolDescription, LEAD_CONSULT_KINDS, LEAD_CONSULT_TOOL } =
		await import("../extensions/paseo-team-core/policy-core.ts");
	assert.equal(consult.name, LEAD_CONSULT_TOOL, "the tool name comes from the core");
	assert.equal(
		consult.description,
		leadAskSupervisorToolDescription(),
		"the consult description must not drift between runtimes either",
	);
	assert.deepEqual(
		[...consult.inputSchema.properties.kind.enum].sort(),
		[...LEAD_CONSULT_KINDS].sort(),
		"the advertised consult kinds must be exactly the ones the parser accepts",
	);
	// The four Delegated-decision criteria are checked against these. A schema
	// that lets one be omitted produces consults the Supervisor must bounce.
	assert.deepEqual(
		[...consult.inputSchema.required].sort(),
		["evidence", "kind", "options", "question", "reversibility", "scope"],
		"a consult must carry everything the criteria are checked against",
	);
}

console.log("claude team mcp tests passed");
