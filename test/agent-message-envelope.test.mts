/**
 * Paseo 0.14 wraps every agent-to-agent prompt in a `<paseo-system
 * kind="agent-message">` envelope, so a Lead's V3 brief reached its Peer as
 * text whose first line is not the marker and the Peer ran read-only with
 * peer_ask_lead refused.
 *
 * Pinned here: exactly one shape is opened (the whole prompt, one envelope,
 * version 1, kind agent-message, Paseo's own escaping), only when the sender is
 * the Peer's own parent, and through the one core function both runtimes call.
 * Everything else stays the fail-closed null it was on 3.13.0, and a bare brief
 * (Paseo <= 0.13) parses exactly as before.
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import test, { after } from "node:test";

import {
	parseAgentMessageEnvelope,
	parseTaskBrief,
	parseTurnBrief,
	selfParentAgentId,
} from "../extensions/paseo-team-core/policy-core.ts";
import {
	BRIEF,
	LEAD,
	ORPHAN,
	OTHER_LEAD,
	PEER,
	SPICY_BRIEF,
	UNSTATED,
	envelopeHome,
	wrap,
} from "./fixtures/agent-message-envelope.mts";

const fromLead = () => LEAD;

/** The shape both adapters persist/act on — enough to call two parses "the same". */
function shape(brief: ReturnType<typeof parseTaskBrief>) {
	return brief && { version: brief.version, mode: brief.mode, malformed: brief.malformed, fields: [...brief.fields] };
}

// --- core: the one shape that opens ------------------------------------------------

test("an envelope from the parent Lead parses to exactly the bare brief", () => {
	const bare = parseTaskBrief(BRIEF);
	assert.ok(bare && bare.mode === "write");
	assert.deepEqual(shape(parseTurnBrief(wrap(BRIEF), fromLead)), shape(bare));
	// Optional attributes Paseo may add do not change the answer.
	assert.deepEqual(shape(parseTurnBrief(wrap(BRIEF, { server: "srv-1", title: "" }), fromLead)), shape(bare));
});

test("an escaped body unescapes exactly the way Paseo escaped it", () => {
	const bare = parseTaskBrief(SPICY_BRIEF);
	assert.ok(bare && bare.fields.get("EXCLUDED_SCOPE") === `it's "a & b" <c> &lt;d&gt; &amp;`);
	const wrapped = wrap(SPICY_BRIEF);
	assert.match(wrapped, /&amp;lt;d&amp;gt;/, "the fixture really carries a double-escaped entity");
	assert.equal(parseAgentMessageEnvelope(wrapped)?.body, SPICY_BRIEF);
	assert.deepEqual(shape(parseTurnBrief(wrapped, fromLead)), shape(bare));
});

test("a bare V3 brief is unchanged and never asks for the parent", () => {
	let asked = 0;
	const resolve = () => {
		asked += 1;
		return LEAD;
	};
	assert.deepEqual(shape(parseTurnBrief(BRIEF, resolve)), shape(parseTaskBrief(BRIEF)));
	assert.equal(parseTurnBrief("just chat", resolve), null);
	assert.equal(asked, 0, "only an agent-message envelope costs a parent lookup");
	parseTurnBrief(wrap(BRIEF), resolve);
	assert.equal(asked, 1);
});

// --- core: who sent it ------------------------------------------------------------------

test("a brief from anyone but the parent Lead grants nothing", () => {
	assert.equal(parseTurnBrief(wrap(BRIEF, { from: OTHER_LEAD }), fromLead), null, "wrong sender");
	assert.equal(parseTurnBrief(wrap(BRIEF), () => null), null, "parent unknown");
	assert.equal(parseTurnBrief(wrap(BRIEF), () => ""), null, "parent empty");
	// Case or whitespace near-misses are different ids, not the same one.
	assert.equal(parseTurnBrief(wrap(BRIEF, { from: LEAD.toUpperCase() }), fromLead), null);
	assert.equal(parseTurnBrief(wrap(BRIEF, { from: ` ${LEAD}` }), fromLead), null);
});

// --- core: every other shape stays null ------------------------------------------------

test("another version or kind is not opened", () => {
	assert.equal(parseTurnBrief(wrap(BRIEF, { version: "2" }), fromLead), null, "version 2");
	assert.equal(parseTurnBrief(wrap(BRIEF, { kind: "user-message" }), fromLead), null, "user-message");
	assert.equal(
		parseTurnBrief(wrap(BRIEF, { kind: "agent-notification", event: "finished" }), fromLead),
		null,
		"agent-notification",
	);
	assert.equal(parseTurnBrief(`<paseo-system>\n${BRIEF}\n</paseo-system>`, fromLead), null, "bare schedule form");
});

test("text around the envelope, or a batch of envelopes, is not opened", () => {
	const one = wrap(BRIEF);
	for (const [label, prompt] of [
		["prose before", `hi\n${one}`],
		["prose after", `${one}\nthanks`],
		["leading newline", `\n${one}`],
		["trailing newline", `${one}\n`],
		["two envelopes (Paseo's batched delivery)", `${one}\n\n${wrap("hello")}`],
		["two envelopes, brief second", `${wrap("hello")}\n\n${one}`],
	] as const) {
		assert.equal(parseTurnBrief(prompt, fromLead), null, label);
	}
	// A brief INSIDE an envelope that was itself sent as a body is opened once only.
	assert.equal(parseTurnBrief(wrap(one), fromLead), null, "nested envelope");
});

test("a malformed attribute or escape is rejected the way Paseo rejects it", () => {
	const good = wrap(BRIEF);
	const cases: Array<[string, string]> = [
		["raw < in body", good.replace("Fix the thing.", "Fix <the> thing.")],
		["unknown entity in body", good.replace("Fix the thing.", "Fix &nbsp; thing.")],
		["bare & in body", good.replace("Fix the thing.", "Fix & thing.")],
		["duplicate attribute", good.replace(' version="1"', ' version="1" version="1"')],
		["bad escape in attribute", good.replace('source-agent-title="', 'source-agent-title="&x;')],
		["empty title", good.replace(/source-agent-title="[^"]*"/, 'source-agent-title=""')],
		["empty server id", good.replace(" message-id=", ' source-server-id="" message-id=')],
		["missing message-id", good.replace(/ message-id="[^"]*"/, "")],
		["missing source-agent-id", good.replace(/ source-agent-id="[^"]*"/, "")],
		["uppercase attribute name", good.replace("version=", "VERSION=")],
		["CRLF framing", good.replace(/\n/g, "\r\n")],
	];
	for (const [label, prompt] of cases) {
		assert.equal(parseAgentMessageEnvelope(prompt), null, label);
		assert.equal(parseTurnBrief(prompt, fromLead), null, label);
	}
	// Paseo's schema strips attributes it does not know, so they do not reject.
	assert.ok(parseAgentMessageEnvelope(good.replace(' message-id=', ' x-extra="1" message-id=')));
});


// --- the parent, read from the Peer's own Paseo state ----------------------------------

const { home, cleanup } = envelopeHome();
after(cleanup);

test("selfParentAgentId reads paseo.parent-agent-id from this seat's own state file", () => {
	assert.equal(selfParentAgentId({ PASEO_HOME: home, PASEO_AGENT_ID: PEER }), LEAD);
	assert.equal(selfParentAgentId({ PASEO_HOME: home, PASEO_AGENT_ID: ORPHAN }), null, "no parent label");
	assert.equal(selfParentAgentId({ PASEO_HOME: home, PASEO_AGENT_ID: UNSTATED }), null, "no state file");
	assert.equal(selfParentAgentId({ PASEO_HOME: home, PASEO_AGENT_ID: "" }), null, "no agent id");
	assert.equal(selfParentAgentId({ PASEO_HOME: home, PASEO_AGENT_ID: "../x" }), null, "not an id");
	assert.equal(selfParentAgentId({ PASEO_HOME: join(home, "nope"), PASEO_AGENT_ID: PEER }), null, "no root");
});

