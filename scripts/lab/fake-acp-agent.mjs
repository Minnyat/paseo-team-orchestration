#!/usr/bin/env node
// fake-acp-agent.mjs — a minimal Agent Client Protocol agent for the lab.
//
// Paseo lets a provider `extends: "acp"` with its own `command`, so the lab's
// role providers run this script instead of a real coding agent: no model, no
// API key, but the daemon still creates the agent, runs a turn, streams an
// update, goes idle, and answers inspect/stop/archive — the whole control
// plane the multi-host code drives.
//
// It answers every prompt with one line naming the host, the role env and the
// first words of the prompt, so a scenario can assert WHICH daemon ran it.
//
// Scripted directives make it a stand-in for a Lead or Peer that DOES things,
// one per prompt line, results reported as `LAB_RESULT <n> <json>` lines:
//   LAB_EXEC: <shell command>          run in the session cwd (a Peer's work)
//   LAB_MCP: <tool> <json-args>        call the daemon's injected Agent MCP as
//                                      this agent (a Lead's create_agent, ...)
// so a scenario can drive a whole orchestration flow without a model.
import { execSync } from "node:child_process";
import { createInterface } from "node:readline";

const host = process.env.PASEO_LAB_HOST_ID ?? "unknown-host";
const role = process.env.PASEO_PI_ROLE ?? "unknown-role";
const family = process.env.PASEO_LAB_FAMILY ?? "unknown-family";
const delayMs = Number(process.env.PASEO_LAB_TURN_MS ?? 200);
// pi-shaped families carry a provider segment in the model id.
const modelId = process.env.PASEO_LAB_MODEL_ID ?? "lab-model";
let nextSession = 1;
/** sessionId -> { cwd, mcp: { url, headers } | null } */
const sessions = new Map();

/** One JSON-RPC call against the daemon's stateless Streamable-HTTP MCP. */
async function mcpCall(mcp, method, params) {
	const response = await fetch(mcp.url, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			...mcp.headers,
		},
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
	});
	const text = await response.text();
	// SSE framing: take the last "data:" payload; plain JSON otherwise.
	const data = text.includes("data:")
		? text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).pop()
		: text;
	return JSON.parse(data);
}

async function runDirective(session, line) {
	const exec = /^LAB_EXEC:\s*(.+)$/.exec(line);
	if (exec) {
		try {
			const stdout = execSync(exec[1], { cwd: session.cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60000 });
			return { ok: true, stdout: stdout.trim() };
		} catch (error) {
			return { ok: false, status: error.status, stderr: String(error.stderr ?? error.message).trim() };
		}
	}
	const mcp = /^LAB_MCP:\s*(\S+)\s*(.*)$/.exec(line);
	if (mcp) {
		if (!session.mcp) return { ok: false, error: "no Paseo MCP server was injected into this agent" };
		const args = mcp[2] ? JSON.parse(mcp[2]) : {};
		const out = await mcpCall(session.mcp, "tools/call", { name: mcp[1], arguments: args });
		if (out.error) return { ok: false, error: out.error };
		const result = out.result ?? {};
		return { ok: !result.isError, structured: result.structuredContent ?? null, text: (result.content ?? []).map((c) => c.text).join("\n") };
	}
	return null;
}

const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
const reply = (id, result) => send({ id, result });

const handlers = {
	initialize: () => ({
		protocolVersion: 1,
		agentCapabilities: { loadSession: false, promptCapabilities: {} },
		authMethods: [],
	}),
	"session/new": (params) => {
		const sessionId = `lab-${host}-${nextSession++}`;
		const http = (params?.mcpServers ?? []).find((server) => server?.url);
		sessions.set(sessionId, {
			cwd: params?.cwd ?? process.cwd(),
			mcp: http
				? { url: http.url, headers: Object.fromEntries((http.headers ?? []).map((h) => [h.name, h.value])) }
				: null,
		});
		return {
		sessionId,
		// Every mode id a role seat may be created with on any family (claude
		// seats default to "auto"; opencode has build/plan), so the lab never
		// fails on a mode the real runtime would accept.
		modes: {
			currentModeId: "default",
			availableModes: ["default", "auto", "plan", "acceptEdits", "build"].map((id) => ({ id, name: id })),
		},
		models: {
			currentModelId: modelId,
			availableModels: [{ modelId, name: "Lab model" }],
		},
	};
	},
	"session/set_mode": () => ({}),
	"session/set_model": () => ({}),
	"session/cancel": () => ({}),
	"session/prompt": async (params) => {
		const full = (params?.prompt ?? []).map((block) => block?.text ?? "").join("\n");
		const text = full.replace(/\s+/g, " ").slice(0, 80);
		await new Promise((r) => setTimeout(r, delayMs));
		const say = (line) =>
			send({
				method: "session/update",
				params: {
					sessionId: params?.sessionId,
					update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `${line}\n` } },
				},
			});
		say(`LAB_ACK host=${host} family=${family} role=${role} prompt="${text}"`);
		const session = sessions.get(params?.sessionId) ?? { cwd: process.cwd(), mcp: null };
		let n = 0;
		for (const line of full.split("\n").map((l) => l.trim())) {
			let result;
			try {
				result = await runDirective(session, line);
			} catch (error) {
				result = { ok: false, error: String(error?.message ?? error) };
			}
			if (result !== null) say(`LAB_RESULT ${n++} ${JSON.stringify(result)}`);
		}
		return { stopReason: "end_turn" };
	},
};

createInterface({ input: process.stdin }).on("line", async (line) => {
	let msg;
	try {
		msg = JSON.parse(line);
	} catch {
		return;
	}
	if (msg.method === undefined) return; // a response to something we never sent
	const handler = handlers[msg.method];
	if (msg.id === undefined) return; // notification: nothing to answer
	if (!handler) {
		send({ id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } });
		return;
	}
	try {
		reply(msg.id, await handler(msg.params));
	} catch (error) {
		send({ id: msg.id, error: { code: -32000, message: String(error?.message ?? error) } });
	}
});
