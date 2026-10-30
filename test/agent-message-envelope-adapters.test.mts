/**
 * The same envelope rule, through BOTH runtimes: the Claude hook
 * (user-prompt-submit, and the transcript fallback a tool call uses when the
 * state file is missing) and the Pi extension's before_agent_start. A brief the
 * Peer's own parent Lead sent through Paseo 0.14 grants exactly what the bare
 * brief grants; any other sender, an unresolvable parent, or any other shape
 * grants nothing. Core grammar cases live in agent-message-envelope.test.mts.
 *
 * Imports only what 3.13.0 already exported, so on that code these cases fail
 * by assertion (the wrapped brief is read-only there), not by import error.
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import test, { after } from "node:test";

// @ts-ignore — plain .mjs module, no declarations
import { handleEvent } from "../scripts/claude-hook.mjs";
import {
	BRIEF,
	ORPHAN,
	OTHER_LEAD,
	PEER,
	SPICY_BRIEF,
	UNSTATED,
	envelopeHome,
	wrap,
} from "./fixtures/agent-message-envelope.mts";

const { home, teamHome, cleanup } = envelopeHome();
after(cleanup);

// --- Claude hook adapter -----------------------------------------------------------------

const hookEnv = (self: string) => ({
	PASEO_TEAM_HOME: teamHome,
	PASEO_TEAM_ROUTE_ENFORCE: "off",
	PASEO_PI_ROLE: "peer",
	PASEO_HOME: home,
	PASEO_AGENT_ID: self,
});

async function hookTool(
	session: string,
	prompt: string,
	tool: string,
	input: Record<string, unknown>,
	self = PEER,
): Promise<"allow" | "deny"> {
	const env = hookEnv(self);
	await handleEvent("user-prompt-submit", { session_id: session, prompt }, env);
	const decision = await handleEvent("pre-tool-use", { session_id: session, tool_name: tool, tool_input: input }, env);
	return decision?.hookSpecificOutput?.permissionDecision === "deny" ? "deny" : "allow";
}

const hookWrite = (session: string, prompt: string, self = PEER) =>
	hookTool(session, prompt, "Write", { file_path: "a" }, self);

test("Claude hook: the parent Lead's wrapped brief grants what the bare one does, nothing else does", async () => {
	assert.equal(await hookWrite("env-bare", BRIEF), "allow", "bare brief unchanged");
	assert.equal(await hookWrite("env-parent", wrap(BRIEF)), "allow", "wrapped by the parent");
	assert.equal(await hookWrite("env-spicy", wrap(SPICY_BRIEF)), "allow", "escaped body");
	assert.equal(await hookWrite("env-wrong", wrap(BRIEF, { from: OTHER_LEAD })), "deny", "wrong sender");
	assert.equal(await hookWrite("env-orphan", wrap(BRIEF), ORPHAN), "deny", "no parent label");
	assert.equal(await hookWrite("env-unstated", wrap(BRIEF), UNSTATED), "deny", "no state file");
	assert.equal(await hookWrite("env-kind", wrap(BRIEF, { kind: "user-message" })), "deny", "user-message");
	assert.equal(await hookWrite("env-after", `${wrap(BRIEF)}\nok`), "deny", "text after");
	assert.equal(await hookWrite("env-two", `${wrap(BRIEF)}\n\n${wrap("x")}`), "deny", "two envelopes");
});

test("Claude hook: peer_ask_lead — the reported symptom — opens for the parent's envelope only", async () => {
	const ask = (session: string, prompt: string) =>
		hookTool(session, prompt, "mcp__paseo-team__peer_ask_lead", { kind: "progress", message: "x" });
	assert.equal(await ask("ask-parent", wrap(BRIEF)), "allow", "wrapped by the parent");
	assert.equal(await ask("ask-wrong", wrap(BRIEF, { from: OTHER_LEAD })), "deny", "wrong sender");
});

test("Claude hook: the transcript fallback opens the same envelope under the same rule", async () => {
	const transcript = (prompt: string) => {
		const path = join(teamHome, `transcript-${Math.random().toString(36).slice(2)}.jsonl`);
		writeFileSync(path, `${JSON.stringify({ type: "user", message: { role: "user", content: prompt } })}\n`);
		return path;
	};
	const write = async (prompt: string) =>
		(
			await handleEvent(
				"pre-tool-use",
				{
					session_id: `no-state-${Math.random().toString(36).slice(2)}`,
					transcript_path: transcript(prompt),
					tool_name: "Write",
					tool_input: { file_path: "a" },
				},
				hookEnv(PEER),
			)
		)?.hookSpecificOutput?.permissionDecision ?? "allow";
	assert.equal(await write(wrap(BRIEF)), "allow", "parent's envelope");
	assert.equal(await write(wrap(BRIEF, { from: OTHER_LEAD })), "deny", "wrong sender");
});

// --- Pi extension adapter ----------------------------------------------------------------

type PiHandler = (event: unknown) => Promise<unknown> | unknown;
let extensionTag = 0;

/** One turn on a fresh Pi Peer: the tools it gets, and whether peer_ask_lead is blocked. */
async function piTurn(prompt: string, self: string): Promise<{ active: string[]; askBlocked: boolean }> {
	const vars: Record<string, string> = {
		PASEO_PI_ROLE: "peer",
		PASEO_AGENT_ID: self,
		PASEO_HOME: home,
		PASEO_TEAM_ROUTE_ENFORCE: "off",
	};
	const previous: Record<string, string | undefined> = {};
	for (const [key, value] of Object.entries(vars)) {
		previous[key] = process.env[key];
		process.env[key] = value;
	}
	try {
		const handlers: Record<string, PiHandler[]> = {};
		let active: string[] = [];
		const pi = {
			on: (name: string, fn: PiHandler) => void (handlers[name] ??= []).push(fn),
			getAllTools: () => ["read", "write", "edit", "bash"].map((name) => ({ name })),
			setActiveTools: (names: string[]) => void (active = names),
			getActiveTools: () => active,
			registerCommand: () => {},
		};
		const mod: { default: (pi: unknown) => void } = await import(
			`../extensions/paseo-team-policy.ts?envelope=${(extensionTag += 1)}`
		);
		mod.default(pi);
		for (const fn of handlers.before_agent_start ?? []) await fn({ prompt, systemPrompt: "BASE" });
		const asked = (await handlers.tool_call?.[0]?.({ toolName: "peer_ask_lead", input: { kind: "progress", message: "x" } })) as
			| { block?: boolean }
			| undefined;
		return { active, askBlocked: asked?.block === true };
	} finally {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

test("Pi extension: the parent Lead's wrapped brief grants what the bare one does, nothing else does", async () => {
	const writes = async (prompt: string, self = PEER) => (await piTurn(prompt, self)).active.includes("write");
	assert.equal(await writes(BRIEF), true, "bare brief unchanged");
	assert.equal(await writes(wrap(BRIEF)), true, "wrapped by the parent");
	assert.equal(await writes(wrap(SPICY_BRIEF)), true, "escaped body");
	assert.equal(await writes(wrap(BRIEF, { from: OTHER_LEAD })), false, "wrong sender");
	assert.equal(await writes(wrap(BRIEF), ORPHAN), false, "no parent label");
	assert.equal(await writes(wrap(BRIEF), UNSTATED), false, "no state file");
	assert.equal(await writes(wrap(BRIEF, { version: "2" })), false, "version 2");
	assert.equal(await writes(`note\n${wrap(BRIEF)}`), false, "text before");
	assert.equal(await writes(`${wrap(BRIEF)}\n\n${wrap("x")}`), false, "two envelopes");
	// The reported symptom: peer_ask_lead refused for want of a V3 brief.
	assert.equal((await piTurn(wrap(BRIEF), PEER)).askBlocked, false, "peer_ask_lead open for the parent's envelope");
	assert.equal((await piTurn(wrap(BRIEF, { from: OTHER_LEAD }), PEER)).askBlocked, true, "and closed for anyone else");
});
