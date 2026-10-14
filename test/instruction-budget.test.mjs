// instruction-budget.test.mjs — a ratchet on the pack's standing instructions.
//
// The role prompts are the most expensive text this pack ships. On pi the whole
// role prompt is appended to the SYSTEM prompt on every `before_agent_start`
// (extensions/paseo-team-policy.ts), so its size is a per-turn tax for the life
// of the session; on Claude it goes in once as turn context, which is cheaper
// but also means the far end of a long contract is the part a model has drifted
// furthest from by turn fifty.
//
// Left alone, that text only grows. Every incident adds a paragraph and none of
// them removes one, because appending is always the smaller edit. The budgets
// below are NOT a runtime cap — no runtime this pack targets documents one for
// an appended system prompt, and inventing a number and calling it a cap would
// be worse than having none. They are set a little above today's largest file,
// so growth stops being free: crossing one is a decision somebody makes on
// purpose, by raising the number in the same commit and saying why, rather than
// something that happens over six months of reasonable-looking diffs.
//
// The remedy when a budget trips is almost never "raise the budget". It is the
// one upstream Paseo's own docs rules name: integrate, don't append — and state
// a fact once, with every other mention a link.

import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const KIB = 1024;

/**
 * Re-injected into the system prompt on every pi turn, so this is the budget
 * that costs on a per-turn basis rather than once per session.
 */
const ROLE_PROMPT_BUDGET = 24 * KIB;

/**
 * Loaded on demand, once, and only by the role admitted to it. Cheaper than a
 * role prompt per turn, but the Lead procedure is by far the largest single
 * document here and the same one-way ratchet applies.
 */
// 57 KiB: one short section, "Work that needs several models or tools", so a Lead
// actually reads `pteam jobs show` (the jobs feature had no mention in any skill,
// and a preset nobody is told about is not used).
const SKILL_BUDGET = 57 * KIB;

/** The brief template is quoted into every Peer prompt the Lead writes. */
const TEMPLATE_BUDGET = 12 * KIB;

const budgets = [
	["prompts/supervisor.md", ROLE_PROMPT_BUDGET],
	["prompts/lead.md", ROLE_PROMPT_BUDGET],
	["prompts/peer.md", ROLE_PROMPT_BUDGET],
	["skills/paseo-team-lead/SKILL.md", SKILL_BUDGET],
	["skills/paseo-ocr-reviewer/SKILL.md", SKILL_BUDGET],
	["templates/TASK_BRIEF_V3.md", TEMPLATE_BUDGET],
];

for (const [file, budget] of budgets) {
	const size = statSync(join(root, file)).size;
	assert.ok(
		size <= budget,
		`${file} is ${size} bytes, over its ${budget}-byte budget. This text is ` +
			"standing instruction — on pi the role prompt is re-appended to the " +
			"system prompt every turn. Integrate the new rule into a section that " +
			"already exists, or delete one that no longer applies, before raising " +
			"the number here.",
	);
}

// Every file with a budget must still be one of the files that actually reaches
// a model. A budget on a file nobody injects is a number that looks like a
// guard and guards nothing.
{
	const extension = readFileSync(join(root, "extensions", "paseo-team-policy.ts"), "utf8");
	assert.match(
		extension,
		/loadRolePrompt/,
		"the pi adapter must still inject the role prompt these budgets are about",
	);
	const hook = readFileSync(join(root, "scripts", "claude-hook.mjs"), "utf8");
	assert.match(hook, /loadRolePrompt/, "so must the Claude hook");
}

// The three role prompts are budgeted by name rather than by directory scan, so
// a fourth role would slip in unbudgeted. Fail instead.
{
	const { ROLE_PROMPTS } = await import("../cli/lib/config-walker.mjs");
	const budgeted = budgets
		.map(([file]) => file)
		.filter((file) => file.startsWith("prompts/"))
		.map((file) => file.slice("prompts/".length, -".md".length))
		.sort();
	assert.deepEqual(
		budgeted,
		[...ROLE_PROMPTS].sort(),
		"every role prompt the pack installs needs a budget here",
	);
}

console.log("instruction budget tests passed");
