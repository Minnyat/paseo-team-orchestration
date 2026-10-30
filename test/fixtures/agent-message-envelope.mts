/**
 * Shared fixtures for the Paseo 0.14 agent-message envelope tests: agent ids,
 * briefs, Paseo's own formatter, and a throwaway $PASEO_HOME whose Peer has a
 * parent Lead. Kept apart from the tests so the adapter file imports nothing
 * that 3.13.0 did not export — it has to fail on the old code by ASSERTION.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const LEAD = "aaaaaaaa-1111-4111-8111-11111111111f";
export const OTHER_LEAD = "22222222-2222-4222-8222-222222222222";
export const PEER = "33333333-3333-4333-8333-333333333333";
export const ORPHAN = "44444444-4444-4444-8444-444444444444";
export const UNSTATED = "55555555-5555-4555-8555-555555555555";

export const BRIEF = [
	"PASEO_TEAM_TASK_V3_BEGIN",
	"TASK_ID: T-ENV",
	"MODE: write",
	"EDIT_AUTHORITY: allowed",
	"COMMIT_AUTHORITY: allowed",
	"PASEO_TEAM_TASK_V3_END",
	"",
	"Fix the thing.",
].join("\n");

// Every character Paseo escapes, plus text that already LOOKS like an entity:
// a chained unescape would turn `&amp;lt;` into `<` instead of `&lt;`.
export const SPICY_BRIEF = [
	"PASEO_TEAM_TASK_V3_BEGIN",
	"TASK_ID: T-ENV",
	"MODE: write",
	"EDIT_AUTHORITY: allowed",
	`EXCLUDED_SCOPE: it's "a & b" <c> &lt;d&gt; &amp;`,
	"PASEO_TEAM_TASK_V3_END",
	"",
	`Don't touch <script> & "quotes".`,
].join("\n");

// --- Paseo 0.14.0's formatter (agent-messages/envelope.js), verbatim -------------

export function escapeXml(value: string): string {
	return value.replace(/[&<>"']/g, (character) => {
		switch (character) {
			case "&":
				return "&amp;";
			case "<":
				return "&lt;";
			case ">":
				return "&gt;";
			case '"':
				return "&quot;";
			default:
				return "&apos;";
		}
	});
}

export function wrap(
	text: string,
	{
		from = LEAD,
		kind = "agent-message",
		version = "1",
		id = "6b3f2c1e-0000-4000-8000-000000000001",
		title = "Lead — T-ENV",
		server,
		event,
	}: { from?: string; kind?: string; version?: string; id?: string; title?: string; server?: string; event?: string } = {},
): string {
	const attributes =
		kind === "user-message" ? 'kind="user-message"' : `kind="${kind}" source-agent-id="${escapeXml(from)}"`;
	const serverAttr = server ? ` source-server-id="${escapeXml(server)}"` : "";
	const titleAttr = title ? ` source-agent-title="${escapeXml(title)}"` : "";
	const eventAttr = event ? ` event="${event}"` : "";
	return `<paseo-system version="${version}" ${attributes} message-id="${escapeXml(id)}"${serverAttr}${titleAttr}${eventAttr}>\n${escapeXml(text)}\n</paseo-system>`;
}


/**
 * A throwaway $PASEO_HOME: PEER's parent is LEAD, ORPHAN has no parent label,
 * UNSTATED has no state file at all. `cleanup` removes it.
 */
export function envelopeHome(): { home: string; teamHome: string; cleanup: () => void } {
	const home = mkdtempSync(join(tmpdir(), "pteam-envelope-"));
	const teamHome = mkdtempSync(join(tmpdir(), "pteam-envelope-team-"));
	for (const [id, labels] of [
		[PEER, { "paseo.parent-agent-id": LEAD }],
		[ORPHAN, {}],
		[LEAD, {}],
	] as const) {
		const dir = join(home, "agents", `slug-${id.slice(0, 4)}`);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, `${id}.json`), JSON.stringify({ id, labels }));
	}
	return {
		home,
		teamHome,
		cleanup: () => {
			rmSync(home, { recursive: true, force: true });
			rmSync(teamHome, { recursive: true, force: true });
		},
	};
}
