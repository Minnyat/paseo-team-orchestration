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
import { createInterface } from "node:readline";

const host = process.env.PASEO_LAB_HOST_ID ?? "unknown-host";
const role = process.env.PASEO_PI_ROLE ?? "unknown-role";
const family = process.env.PASEO_LAB_FAMILY ?? "unknown-family";
const delayMs = Number(process.env.PASEO_LAB_TURN_MS ?? 200);
// pi-shaped families carry a provider segment in the model id.
const modelId = process.env.PASEO_LAB_MODEL_ID ?? "lab-model";
let nextSession = 1;

const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
const reply = (id, result) => send({ id, result });

const handlers = {
	initialize: () => ({
		protocolVersion: 1,
		agentCapabilities: { loadSession: false, promptCapabilities: {} },
		authMethods: [],
	}),
	"session/new": () => ({
		sessionId: `lab-${host}-${nextSession++}`,
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
	}),
	"session/set_mode": () => ({}),
	"session/set_model": () => ({}),
	"session/cancel": () => ({}),
	"session/prompt": async (params) => {
		const text = (params?.prompt ?? [])
			.map((block) => block?.text ?? "")
			.join(" ")
			.replace(/\s+/g, " ")
			.slice(0, 80);
		await new Promise((r) => setTimeout(r, delayMs));
		send({
			method: "session/update",
			params: {
				sessionId: params?.sessionId,
				update: {
					sessionUpdate: "agent_message_chunk",
					content: { type: "text", text: `LAB_ACK host=${host} family=${family} role=${role} prompt="${text}"` },
				},
			},
		});
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
