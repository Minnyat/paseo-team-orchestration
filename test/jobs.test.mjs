// jobs.test.mjs — job presets: the validator both writers (WebUI, `pteam config
// write jobs`) run, and the read-only view `pteam jobs list|show` prints.
// Run: node test/jobs.test.mjs   (node >= 22)

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	BUILTIN_CLI_TOOLS,
	EXECUTOR_KEYS,
	EXECUTOR_KINDS,
	JOBS_SECTION,
	JobsConfigError,
	describeJobs,
	validateJobsConfig,
} from "../scripts/jobs.mjs";
import { ALL_MODEL_CLASSES } from "../scripts/model-routing.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

const valid = () => ({
	version: 1,
	cliTools: { codex: { command: "codex", args: ["exec"] } },
	jobs: {
		review: {
			label: "Review",
			description: "two reviewers",
			disposition: "independent-reviewer",
			run: "parallel",
			executors: [
				{ kind: "class", modelClass: "REVIEW_HIGH" },
				{ kind: "route", paseoProvider: "pi-peer", model: "Minnyat/gpt-5.5", thinking: "high" },
				{ kind: "route", paseoProvider: "claude-peer", model: "claude-opus-5" },
				{ kind: "cli", tool: "claude" },
				{ kind: "cli", tool: "codex", args: ["--full-auto"] },
			],
		},
		"scout_then-build": { run: "sequential", executors: [{ kind: "class", modelClass: "FAST_READ" }] },
	},
});

/** Expect a CONFIG_INVALID refusal whose message matches every pattern. */
function refuses(doc, ...patterns) {
	assert.throws(
		() => validateJobsConfig(doc),
		(error) => {
			assert.ok(error instanceof JobsConfigError, `expected JobsConfigError, got ${error?.name}: ${error?.message}`);
			assert.ok(error instanceof Error);
			assert.equal(error.code, "CONFIG_INVALID");
			assert.match(error.message, /^CONFIG_INVALID: /);
			for (const pattern of patterns) assert.match(error.message, pattern);
			return true;
		},
	);
}

function mutate(change) {
	const doc = valid();
	change(doc);
	return doc;
}

// --- the contract names ------------------------------------------------------
assert.equal(JOBS_SECTION, "jobs");
assert.deepEqual(Object.keys(BUILTIN_CLI_TOOLS), ["pi", "claude"], "the built-in CLI tools are exactly pi and claude");
assert.deepEqual([...EXECUTOR_KINDS], ["class", "route", "cli"]);

// --- a valid document comes back as itself ------------------------------------
{
	const doc = valid();
	assert.equal(validateJobsConfig(doc), doc, "a valid document is returned unchanged");
	assert.deepEqual(doc, valid(), "and not rewritten");
	// The minimum: a version and nothing else. The form drops empty objects on
	// save, so deleting the last job must leave a file that still loads.
	validateJobsConfig({ version: 1 });
	validateJobsConfig({ version: 1, jobs: {} });
	// Every MODEL_CLASS a route file may carry is a valid class executor.
	for (const modelClass of ALL_MODEL_CLASSES) {
		validateJobsConfig({ version: 1, jobs: { j: { executors: [{ kind: "class", modelClass }] } } });
	}
	// The shipped example is a valid document.
	validateJobsConfig(JSON.parse(readFileSync(join(HERE, "..", "config", "jobs.example.json"), "utf8")));
}

// --- document-level refusals -------------------------------------------------
refuses(null, /JSON object/);
refuses([], /JSON object/);
refuses({ jobs: {} }, /version must be 1/);
refuses({ version: 2, jobs: {} }, /version must be 1/);
refuses(mutate((d) => { d.routes = {}; }), /unknown top-level key\(s\) routes/);
refuses(mutate((d) => { d.jobs = []; }), /jobs must be an object/);

// --- job-level refusals name the job -----------------------------------------
refuses(mutate((d) => { d.jobs["a.b"] = d.jobs.review; }), /job "a\.b"/, /no dots/);
refuses(mutate((d) => { d.jobs["has space"] = d.jobs.review; }), /job "has space"/);
refuses(mutate((d) => { d.jobs.review = "x"; }), /job "review": must be an object/);
refuses(mutate((d) => { d.jobs.review.executors = []; }), /job "review": executors must be a non-empty array/);
refuses(mutate((d) => { delete d.jobs.review.executors; }), /job "review": executors must be a non-empty array/);
refuses(mutate((d) => { d.jobs.review.executors = {}; }), /job "review": executors/);
refuses(mutate((d) => { d.jobs.review.run = "fallback"; }), /job "review": run "fallback"/, /parallel, sequential/);
refuses(mutate((d) => { d.jobs.review.disposition = "lead"; }), /job "review": disposition "lead"/);
refuses(mutate((d) => { d.jobs.review.label = 3; }), /job "review": label must be a string/);
refuses(mutate((d) => { d.jobs.review.fallback = true; }), /job "review": unknown key\(s\) fallback/);

// --- executor-level refusals name the job AND the executor index --------------
const at = (index) => new RegExp(`job "review" executor \\[${index}\\]`);
refuses(mutate((d) => { d.jobs.review.executors[1] = null; }), at(1), /must be an object/);
refuses(mutate((d) => { d.jobs.review.executors[1] = { modelClass: "FAST_READ" }; }), at(1), /kind undefined/);
refuses(mutate((d) => { d.jobs.review.executors[1].kind = "model"; }), at(1), /kind "model"/);
// class
refuses(mutate((d) => { d.jobs.review.executors[0].modelClass = "FAST"; }), at(0), /modelClass "FAST"/);
refuses(mutate((d) => { delete d.jobs.review.executors[0].modelClass; }), at(0), /modelClass undefined/);
// route — the routing module's own vocabulary and model-shape rules
refuses(mutate((d) => { d.jobs.review.executors[1].paseoProvider = "openai"; }), at(1), /paseoProvider "openai"/);
refuses(mutate((d) => { d.jobs.review.executors[1].model = ""; }), at(1), /model must be a non-empty string/);
refuses(mutate((d) => { d.jobs.review.executors[1].model = "gpt-5.5"; }), at(1), /<pi-provider>\/<model-id>|form/);
refuses(mutate((d) => { d.jobs.review.executors[1].model = "/gpt-5.5"; }), at(1), /must be <provider>\/<model>/);
refuses(mutate((d) => { d.jobs.review.executors[1].model = "Minnyat/gpt-5.5/"; }), at(1), /trailing segment/);
refuses(mutate((d) => { d.jobs.review.executors[2].model = "anthropic/claude-opus-5"; }), at(2), /bare/);
refuses(mutate((d) => { d.jobs.review.executors[1].thinking = "ultracode"; }), at(1), /thinking "ultracode" is not a pi thinking level/);
refuses(mutate((d) => { d.jobs.review.executors[2].thinking = "minimal"; }), at(2), /not a claude thinking level/);
// cli
refuses(mutate((d) => { d.jobs.review.executors[3].tool = "gemini"; }), at(3), /tool "gemini" is neither built in nor declared in cliTools/, /known: pi, claude, codex/);
refuses(mutate((d) => { delete d.cliTools; }), at(4), /tool "codex"/);
refuses(mutate((d) => { d.jobs.review.executors[3].tool = ""; }), at(3), /tool must be a non-empty string/);
refuses(mutate((d) => { d.jobs.review.executors[4].args = "--full-auto"; }), at(4), /args must be an array of strings/);
refuses(mutate((d) => { d.jobs.review.executors[4].args = [1]; }), at(4), /args must be an array of strings/);

// A key of another kind is refused, not kept as junk: the form hides fields
// by kind, and a stale modelClass under a cli executor would read as if it did
// something.
for (const [kind, sample] of [
	["class", { kind: "class", modelClass: "FAST_READ" }],
	["route", { kind: "route", paseoProvider: "pi-peer", model: "Minnyat/gpt-5.5" }],
	["cli", { kind: "cli", tool: "pi" }],
]) {
	const foreign = Object.values(EXECUTOR_KEYS).flat().filter((key) => !EXECUTOR_KEYS[kind].includes(key));
	assert.ok(foreign.length > 0);
	for (const key of foreign) {
		const executor = { ...sample, [key]: key === "args" ? [] : "FAST_READ" };
		refuses(
			{ version: 1, jobs: { j: { executors: [executor] } } },
			/job "j" executor \[0\]/,
			new RegExp(`kind "${kind}" does not take ${key}`),
		);
	}
}

// --- cliTools ------------------------------------------------------------------
refuses(mutate((d) => { d.cliTools = []; }), /cliTools must be an object/);
refuses(mutate((d) => { d.cliTools["co.dex"] = { command: "codex" }; }), /cliTools "co\.dex": name must match/);
refuses(mutate((d) => { d.cliTools.pi = { command: "/opt/pi" }; }), /cliTools "pi": "pi" is a built-in tool/);
refuses(mutate((d) => { d.cliTools.codex = { args: [] }; }), /cliTools "codex": command must be a non-empty string/);
refuses(mutate((d) => { d.cliTools.codex.args = "exec"; }), /cliTools "codex": args must be an array of strings/);
refuses(mutate((d) => { d.cliTools.codex.env = {}; }), /cliTools "codex": unknown key\(s\) env/);

// --- describeJobs: what `pteam jobs list|show` prints -------------------------
{
	const table = {
		ok: true,
		source: "routing",
		path: "/x/model-routing.local.json",
		hostId: "box",
		routes: { REVIEW_HIGH: { paseoProvider: "claude-peer", model: "claude-opus-5", thinking: "high" } },
	};
	const doc = valid();
	doc.jobs.review.executors.push({ kind: "class", modelClass: "LEAD_RECOVERY" });
	const jobs = describeJobs(validateJobsConfig(doc), table);
	assert.deepEqual(jobs.map((job) => job.id), ["review", "scout_then-build"], "sorted by id");
	assert.equal(jobs[1].run, "sequential");
	const [cls, route, bare, builtin, custom, unset] = jobs[0].executors;
	assert.deepEqual(cls, {
		kind: "class",
		modelClass: "REVIEW_HIGH",
		route: { paseoProvider: "claude-peer", model: "claude-opus-5", thinking: "high", createAgentProvider: "claude-peer/claude-opus-5" },
	});
	assert.equal(route.createAgentProvider, "pi-peer/Minnyat/gpt-5.5");
	assert.equal(bare.thinking, undefined, "an absent thinking level is not invented");
	assert.deepEqual(builtin, { kind: "cli", tool: "claude", builtin: true, command: "claude", args: [] });
	assert.deepEqual(custom, { kind: "cli", tool: "codex", builtin: false, command: "codex", args: ["exec", "--full-auto"] });
	assert.equal(unset.route, null);
	assert.match(unset.routeProblem, /LEAD_RECOVERY is not configured in \/x\/model-routing\.local\.json/);

	// No route table: the class executors say why instead of guessing a route.
	const offline = describeJobs(valid(), { ok: false, code: "ROUTE_FILE_MISSING", message: "no local route file" });
	assert.equal(offline[0].executors[0].route, null);
	assert.match(offline[0].executors[0].routeProblem, /^ROUTE_FILE_MISSING: no local route file/);

	// A job with no run says what the default is.
	const defaulted = describeJobs({ version: 1, jobs: { j: { executors: [{ kind: "cli", tool: "pi" }] } } }, table);
	assert.equal(defaulted[0].run, "parallel");
	assert.deepEqual(describeJobs({ version: 1 }, table), []);
}

console.log("jobs tests passed");
