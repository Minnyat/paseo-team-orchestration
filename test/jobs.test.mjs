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
	JOB_DISPOSITIONS,
	JOBS_SECTION,
	JobsConfigError,
	activeJobs,
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

// --- object internals are never names ----------------------------------------
// JSON.parse keeps "__proto__" as an own key, so the validator sees it — but the
// form's save copies maps with `out[key] = value`, which SETS A PROTOTYPE for
// that key: the job disappeared from the file on the next unchanged save. Built
// from JSON text on purpose: an object literal `{ __proto__: ... }` would not
// even create the key.
for (const name of ["__proto__", "prototype", "constructor"]) {
	const job = '{"executors":[{"kind":"cli","tool":"pi"}]}';
	const alone = JSON.parse(`{"version":1,"jobs":{${JSON.stringify(name)}:${job}}}`);
	assert.ok(Object.hasOwn(alone.jobs, name), `the fixture really carries an own "${name}" key`);
	refuses(alone, new RegExp(`job "${name}": id "${name}" is reserved`));
	refuses(JSON.parse(`{"version":1,"jobs":{${JSON.stringify(name)}:${job},"b":${job}}}`), new RegExp(`job "${name}"`));
	refuses(
		JSON.parse(`{"version":1,"cliTools":{${JSON.stringify(name)}:{"command":"x"}},"jobs":{}}`),
		new RegExp(`cliTools "${name}": "${name}" is reserved`),
	);
	// Nor can an executor reach one through the tool lookup.
	refuses(
		{ version: 1, jobs: { j: { executors: [{ kind: "cli", tool: name }] } } },
		new RegExp(`tool "${name}" is neither built in nor declared`),
	);
}
// Names that merely contain the word stay valid.
validateJobsConfig({ version: 1, cliTools: { my_constructor: { command: "x" } }, jobs: { "proto-type": { executors: [{ kind: "cli", tool: "my_constructor" }] } } });

// --- dispositions are the brief template's, not a second copy ----------------
{
	const template = readFileSync(join(HERE, "..", "templates", "TASK_BRIEF_V3.md"), "utf8");
	const line = /^DISPOSITION: (.+)$/m.exec(template);
	assert.ok(line, "templates/TASK_BRIEF_V3.md still declares the DISPOSITION line");
	assert.deepEqual(
		[...JOB_DISPOSITIONS],
		line[1].split("|").map((entry) => entry.trim()),
		"JOB_DISPOSITIONS must list exactly the brief template's dispositions, in order",
	);
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
		index: 0,
		enabled: true,
		active: true,
		inactiveReason: null,
		kind: "class",
		modelClass: "REVIEW_HIGH",
		route: { paseoProvider: "claude-peer", model: "claude-opus-5", thinking: "high", createAgentProvider: "claude-peer/claude-opus-5" },
		options: [
			{ index: 0, paseoProvider: "claude-peer", model: "claude-opus-5", thinking: "high", enabled: true, createAgentProvider: "claude-peer/claude-opus-5", usable: true },
		],
		seat: {
			provider: "claude-peer/claude-opus-5",
			settings: { thinkingOptionId: "high" },
			labels: { "team.model-class": "REVIEW_HIGH", "team.job": "review" },
		},
		seats: [
			{
				option: 0,
				paseoProvider: "claude-peer",
				model: "claude-opus-5",
				thinking: "high",
				createAgent: {
					provider: "claude-peer/claude-opus-5",
					settings: { thinkingOptionId: "high" },
					labels: { "team.model-class": "REVIEW_HIGH", "team.job": "review" },
				},
			},
		],
	});
	assert.equal(route.createAgentProvider, "pi-peer/Minnyat/gpt-5.5");
	assert.equal(bare.thinking, undefined, "an absent thinking level is not invented");
	const on = (index) => ({ index, enabled: true, active: true, inactiveReason: null });
	assert.deepEqual(builtin, { ...on(3), kind: "cli", tool: "claude", builtin: true, command: "claude", args: [], seat: null, seats: [] });
	assert.deepEqual(custom, { ...on(4), kind: "cli", tool: "codex", builtin: false, command: "codex", args: ["exec", "--full-auto"], seat: null, seats: [] });
	assert.equal(unset.route, null);
	assert.equal(unset.active, false, "a class with no route is not usable");
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

// --- quick switches: job, executor, tool, class route -------------------------
{
	const table = {
		ok: true,
		source: "routing",
		path: "/x/model-routing.local.json",
		hostId: "box",
		routes: {
			REVIEW_HIGH: { paseoProvider: "claude-peer", model: "claude-opus-5", thinking: "high" },
			FAST_READ: { paseoProvider: "pi-peer", model: "p/m", thinking: "low", enabled: false },
		},
	};
	const doc = {
		version: 1,
		cliTools: { codex: { command: "codex" } },
		disabledTools: ["codex"],
		jobs: {
			mixed: {
				run: "sequential",
				executors: [
					{ kind: "class", modelClass: "FAST_READ" },
					{ kind: "class", modelClass: "REVIEW_HIGH", enabled: false },
					{ kind: "cli", tool: "codex" },
					{ kind: "cli", tool: "claude" },
					{ kind: "route", paseoProvider: "pi-peer", model: "p/m" },
				],
			},
			off: { enabled: false, executors: [{ kind: "cli", tool: "pi" }] },
			allOff: { executors: [{ kind: "cli", tool: "pi", enabled: false }] },
		},
	};
	validateJobsConfig(doc);
	const described = describeJobs(doc, table);
	const mixed = described.find((job) => job.id === "mixed");
	assert.deepEqual(mixed.executors.map((e) => e.active), [false, false, false, true, true]);
	assert.match(mixed.executors[0].inactiveReason, /switched off in the route file.*routing enable FAST_READ/);
	assert.match(mixed.executors[1].inactiveReason, /executor switched off/);
	assert.match(mixed.executors[2].inactiveReason, /tool "codex" is switched off/);
	assert.equal(mixed.executors[0].route.enabled, false, "the class route's own switch is visible");

	const { jobs, inactive } = activeJobs(described);
	assert.deepEqual(jobs.map((job) => job.id), ["mixed"]);
	assert.deepEqual(jobs[0].executors.map((e) => e.index), [3, 4], "only active steps, original positions kept (order stays readable)");
	assert.deepEqual(jobs[0].skipped.map((e) => e.index), [0, 1, 2], "a skipped step is reported, never replaced");
	assert.deepEqual(inactive.map((entry) => entry.id).sort(), ["allOff", "off"]);
	assert.match(inactive.find((entry) => entry.id === "off").reason, /job switched off/);
	assert.match(inactive.find((entry) => entry.id === "allOff").reason, /no executor of this job is active — \[0\] executor switched off/);

	// Switching the LAST executor off must still be a savable file.
	validateJobsConfig({ version: 1, jobs: { j: { executors: [{ kind: "cli", tool: "pi", enabled: false }] } } });
	refuses(mutate((d) => { d.jobs.review.enabled = "no"; }), /job "review": enabled must be true or false/);
	refuses(mutate((d) => { d.jobs.review.executors[0].enabled = 0; }), /executor \[0\]: enabled must be true or false/);
	refuses(mutate((d) => { d.disabledTools = ["nope"]; }), /disabledTools names unknown tool\(s\) nope/);
	refuses(mutate((d) => { d.disabledTools = "pi"; }), /disabledTools must be an array/);
	validateJobsConfig(mutate((d) => { d.disabledTools = ["pi", "codex"]; }));
}

// --- `pteam jobs list|show`: the Lead sees only what is usable, and a switch is live ---
{
	const { spawnSync } = await import("node:child_process");
	const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join: joinPath, dirname, resolve } = await import("node:path");
	const { fileURLToPath } = await import("node:url");
	const cli = resolve(dirname(fileURLToPath(import.meta.url)), "..", "cli", "paseo-team.mjs");
	const dir = mkdtempSync(joinPath(tmpdir(), "pteam-jobs-cli-"));
	try {
		const run = (...args) => {
			const env = { ...process.env, PST_TEAM_CONFIG_DIR: dir };
			for (const key of Object.keys(env)) if (key.startsWith("PASEO_TEAM_ROUTE")) delete env[key];
			const r = spawnSync(process.execPath, [cli, "jobs", ...args], { encoding: "utf8", env });
			let json = null;
			try { json = JSON.parse(r.stdout); } catch { /* error text */ }
			return { ...r, json };
		};
		const jobsFile = joinPath(dir, "jobs.local.json");
		const write = (doc) => writeFileSync(jobsFile, JSON.stringify(doc));
		const doc = {
			version: 1,
			jobs: {
				review: { run: "sequential", executors: [{ kind: "cli", tool: "pi" }, { kind: "cli", tool: "claude" }] },
				paused: { enabled: false, executors: [{ kind: "cli", tool: "pi" }] },
			},
		};
		write(doc);
		let list = run("list");
		assert.equal(list.status, 0, list.stderr);
		assert.deepEqual(list.json.jobs.map((job) => job.id), ["review"], "a switched-off job is not offered");
		assert.deepEqual(list.json.inactive.map((entry) => entry.id), ["paused"], "…but it is named, with why");
		assert.deepEqual(list.json.jobs[0].executors.map((e) => e.tool), ["pi", "claude"]);

		const shown = run("show", "paused");
		assert.equal(shown.status, 1);
		assert.equal(shown.json.code, "JOB_INACTIVE");
		assert.equal(run("show", "paused", "--all").status, 0, "--all reads it anyway");
		assert.equal(run("list", "--all").json.jobs.length, 2);

		// Switch a tool off in the FILE: the very next call sees it — no daemon, no restart.
		write({ ...doc, disabledTools: ["pi"] });
		list = run("list");
		assert.deepEqual(list.json.jobs[0].executors.map((e) => e.tool), ["claude"], "the disabled tool's step is skipped");
		assert.deepEqual(list.json.jobs[0].skipped.map((e) => e.index), [0], "and reported as skipped, not replaced");
		assert.deepEqual(list.json.disabledTools, ["pi"]);
		// `jobs resolve`: the reload a Lead runs right before seating. It prints the exact
		// create_agent arguments for what is usable NOW, and follows the files live.
		writeFileSync(joinPath(dir, "model-routing.local.json"), JSON.stringify({
			version: 1,
			hostId: "box",
			routes: {
				MONITOR_ECONOMY: { paseoProvider: "pi-supervisor", model: "Mx/cheap", thinking: "low" },
				FAST_READ: { paseoProvider: "pi-peer", model: "Mx/cheap", thinking: "low" },
				CODING_MEDIUM: { paseoProvider: "pi-peer", model: "Mx/mid", thinking: "medium" },
				REASONING_HIGH: { paseoProvider: "pi-peer", model: "Mx/deep", thinking: "high" },
				REVIEW_HIGH: { paseoProvider: "claude-peer", model: "claude-opus-5", thinking: "high" },
			},
		}));
		write({
			version: 1,
			jobs: {
				multi: {
					run: "parallel",
					executors: [
						{ kind: "class", modelClass: "REVIEW_HIGH" },
						{ kind: "route", paseoProvider: "pi-peer", model: "Mx/cheap", thinking: "high" },
						{ kind: "route", paseoProvider: "pi-peer", model: "Mx/mid", thinking: "high" },
						{ kind: "cli", tool: "claude" },
					],
				},
			},
		});
		const resolved = run("resolve", "multi");
		assert.equal(resolved.status, 0, resolved.stderr);
		assert.deepEqual(resolved.json.seats.map((s) => s.createAgent.provider), ["claude-peer/claude-opus-5", "pi-peer/Mx/cheap", "pi-peer/Mx/mid"], "the same tool (pi) on two models, plus another tool");
		assert.deepEqual(resolved.json.seats[1].createAgent, {
			provider: "pi-peer/Mx/cheap",
			settings: { thinkingOptionId: "high" },
			labels: { "team.model-class": "CODING_MEDIUM", "team.job": "multi" },
			note: resolved.json.seats[1].createAgent.note,
		});
		assert.deepEqual(resolved.json.cli.map((c) => c.tool), ["claude"]);
		assert.ok(resolved.json.resolvedAt);
		// A model goes out of credit: the very next resolve leaves its executors out, naming them.
		const routeFile = JSON.parse(readFileSync(joinPath(dir, "model-routing.local.json"), "utf8"));
		writeFileSync(joinPath(dir, "model-routing.local.json"), JSON.stringify({ ...routeFile, disabledModels: ["pi/Mx/cheap"] }));
		const after = run("resolve", "multi");
		assert.deepEqual(after.json.seats.map((s) => s.createAgent.provider), ["claude-peer/claude-opus-5", "pi-peer/Mx/mid"]);
		assert.deepEqual(after.json.skipped.map((s) => s.index), [1]);
		assert.match(after.json.skipped[0].reason, /model pi\/Mx\/cheap is switched off/);
		writeFileSync(joinPath(dir, "model-routing.local.json"), JSON.stringify({ ...routeFile, disabledModels: ["pi/*", "claude/*"] }));
		const cliOnly = run("resolve", "multi");
		assert.equal(cliOnly.status, 0, "the CLI step is still usable");
		assert.deepEqual(cliOnly.json.seats, []);
		assert.deepEqual(cliOnly.json.cli.map((c) => c.tool), ["claude"]);
		write({ ...JSON.parse(readFileSync(jobsFile, "utf8")), disabledTools: ["claude"] });
		const none = run("resolve", "multi");
		assert.equal(none.status, 1);
		assert.equal(none.json.code, "JOB_INACTIVE", "everything off: a code, not an empty list");
		write({ ...doc, disabledTools: ["pi", "claude"] });

		// Everything off: the job leaves the list instead of showing an empty step list.
		write({ ...doc, disabledTools: ["pi", "claude"] });
		assert.deepEqual(run("list").json.jobs, []);
		assert.equal(run("show", "review").json.code, "JOB_INACTIVE");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// --- model switch and seats ---------------------------------------------------------
{
	const table = {
		ok: true,
		source: "routing",
		path: "/x/model-routing.local.json",
		hostId: "box",
		disabledModels: ["pi/Other/model-b", "claude/*"],
		routes: {
			FAST_READ: { paseoProvider: "pi-peer", model: "Mx/cheap", thinking: "low" },
			REVIEW_HIGH: { paseoProvider: "claude-peer", model: "claude-opus-5", thinking: "high" },
		},
	};
	const doc = {
		version: 1,
		jobs: {
			j: {
				executors: [
					{ kind: "class", modelClass: "FAST_READ" },
					{ kind: "class", modelClass: "REVIEW_HIGH" },
					{ kind: "route", paseoProvider: "pi-peer", model: "Other/model-a", thinking: "medium" },
					{ kind: "route", paseoProvider: "pi-peer", model: "Other/model-b", thinking: "medium" },
					{ kind: "route", paseoProvider: "pi-peer", model: "Other/no-thinking" },
					{ kind: "cli", tool: "pi" },
				],
			},
		},
	};
	validateJobsConfig(doc);
	const [job] = describeJobs(doc, table);
	assert.deepEqual(job.executors.map((e) => e.active), [true, false, true, false, true, true], "a switched-off model skips its executors — class or route — and only those");
	assert.match(job.executors[1].inactiveReason, /model claude\/claude-opus-5 is switched off.*enable-model claude\/claude-opus-5/);
	assert.match(job.executors[3].inactiveReason, /model pi\/Other\/model-b is switched off/);
	// seats: the exact create_agent arguments the gate accepts
	assert.deepEqual(job.executors[0].seat, {
		provider: "pi-peer/Mx/cheap",
		settings: { thinkingOptionId: "low" },
		labels: { "team.model-class": "FAST_READ", "team.job": "j" },
	});
	assert.equal(job.executors[2].seat.provider, "pi-peer/Other/model-a");
	assert.equal(job.executors[2].seat.labels["team.model-class"], "CODING_MEDIUM", "a route executor's class label defaults by role (a flow label)");
	assert.match(job.executors[2].seat.note, /flow label/);
	assert.equal(job.executors[4].seat, null, "no thinking level: not seatable");
	assert.match(job.executors[4].seatProblem, /byte for byte/);
	assert.equal(job.executors[3].seat, null, "an inactive executor has no seat");
	assert.equal(job.executors[5].seat, null, "a CLI executor is never a seat");

	// what the gate is given
	const { gateJobSeats } = await import("../scripts/gate-table.mjs");
	const gate = gateJobSeats(doc, table);
	assert.deepEqual(gate.j.seats.map((s) => `${s.paseoProvider}/${s.model}@${s.thinking}`), ["pi-peer/Mx/cheap@low", "pi-peer/Other/model-a@medium"]);
	assert.equal(gate.j.active, true);
}

// --- a class executor whose class offers several options ----------------------------
{
	const routes = {
		FAST_READ: {
			paseoProvider: "pi-peer",
			model: "Mx/cheap",
			thinking: "low",
			alternates: [
				{ paseoProvider: "claude-peer", model: "claude-haiku-4-5", thinking: "off" },
				{ paseoProvider: "pi-peer", model: "Mx/other", thinking: "medium", enabled: false },
			],
		},
	};
	const doc = { version: 1, jobs: { scan: { executors: [{ kind: "class", modelClass: "FAST_READ" }] } } };
	validateJobsConfig(doc);
	const table = { ok: true, source: "routing", path: "/x/r.json", hostId: "box", disabledModels: [], routes };
	const [job] = describeJobs(doc, table);
	const [exec] = job.executors;
	assert.equal(exec.active, true);
	assert.deepEqual(exec.options.map((o) => [o.index, o.usable]), [[0, true], [1, true], [2, false]], "an option switched off is listed, not usable");
	assert.match(exec.options[2].inactiveReason, /option 2 of FAST_READ .* is switched off.*pteam routing enable FAST_READ --option 2/);
	assert.deepEqual(exec.seats.map((x) => [x.option, x.createAgent.provider]), [[0, "pi-peer/Mx/cheap"], [1, "claude-peer/claude-haiku-4-5"]]);
	assert.equal(exec.pickOne, true, "with several usable options the Lead seats ONE of them");
	assert.equal(exec.seat, null, "and no single seat is chosen for it");
	assert.ok(exec.seats.every((x) => x.createAgent.labels["team.job"] === "scan" && x.createAgent.labels["team.model-class"] === "FAST_READ"));

	// a model out of credit drops its option; one usable option left => it is the seat
	const off = { ...table, disabledModels: ["pi/Mx/cheap"] };
	const [offJob] = describeJobs(doc, off);
	assert.deepEqual(offJob.executors[0].options.map((o) => o.usable), [false, true, false]);
	assert.match(offJob.executors[0].options[0].inactiveReason, /model pi\/Mx\/cheap is switched off.*enable-model/);
	assert.equal(offJob.executors[0].pickOne, undefined);
	assert.equal(offJob.executors[0].seat.provider, "claude-peer/claude-haiku-4-5");

	// every option off: the executor (and so the job) is inactive, with each reason
	const none = { ...table, disabledModels: ["pi/*", "claude/*"] };
	const [noneJob] = describeJobs(doc, none);
	assert.equal(noneJob.executors[0].active, false);
	assert.match(noneJob.executors[0].inactiveReason, /no option of FAST_READ is usable/);
	assert.equal(noneJob.active, false);

	// what the gate is given: one entry per usable option, all under the executor's index
	const { gateJobSeats } = await import("../scripts/gate-table.mjs");
	assert.deepEqual(gateJobSeats(doc, table).scan.seats.map((x) => [x.index, x.option, x.paseoProvider, x.model]), [
		[0, 0, "pi-peer", "Mx/cheap"],
		[0, 1, "claude-peer", "claude-haiku-4-5"],
	]);
}

console.log("jobs tests passed");
