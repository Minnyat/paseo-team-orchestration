/**
 * jobs.mjs — named work presets: what a job is run WITH.
 *
 * A job lists one or more executors — a model class (whatever route that class
 * has on this host right now), an explicit route, or a CLI tool — so a Lead
 * can read "review = REVIEW_HIGH + claude" instead of re-deciding it per task.
 * It is a preset only: nothing here seats an agent, and the create_agent gate
 * still checks every seating against the route file, never against this one.
 *
 * Every ENABLED executor of a job is used. `run: "sequential"` means in the
 * listed order; it is NOT "try the next one when the previous failed" — this
 * pack never falls back to another model or host on its own (model-routing.mjs).
 *
 * Quick switches, all plain `enabled: false` / a name in `disabledTools`, all
 * kept in the file so switching back on restores exactly what was there:
 *   job.enabled, executor.enabled, disabledTools (a CLI tool, built-in or not),
 * and — in the route file, not here — route.enabled / disabledModels for a
 * model class or a model. An inactive step is SKIPPED, never replaced by another
 * one. The file is read on every `pteam jobs list|show|resolve`, so a switch is
 * live at once.
 *
 * File: <teamConfigDir>/jobs.local.json, example config/jobs.example.json.
 * Vocabulary (model classes, role providers, thinking levels, model shapes) is
 * imported from scripts/model-routing.mjs, never re-typed.
 */

import { join } from "node:path";
import {
	ALL_MODEL_CLASSES,
	ROLE_PROVIDERS,
	THINKING_LEVELS_BY_FAMILY,
	composeProviderModel,
	isModelDisabled,
	modelSwitchKey,
	providerFamily,
	providerRole,
	routeOptions,
} from "./model-routing.mjs";
import { teamConfigDir } from "./lib-common.mjs";

export const JOBS_SECTION = "jobs";

export function defaultJobsPath(env = process.env) {
	return join(teamConfigDir(env), "jobs.local.json");
}

/** Brief dispositions (templates/TASK_BRIEF_V3.md) a job may name. */
export const JOB_DISPOSITIONS = Object.freeze([
	"repository-scout",
	"documentation-researcher",
	"solution-architect",
	"engineer",
	"acceptance-verifier",
	"independent-reviewer",
]);

export const JOB_RUN_MODES = Object.freeze(["parallel", "sequential"]);
export const DEFAULT_RUN_MODE = "parallel";

export const EXECUTOR_KINDS = Object.freeze(["class", "route", "cli"]);

/** The keys each executor kind may carry; a key of another kind is refused. */
export const EXECUTOR_KEYS = Object.freeze({
	class: Object.freeze(["kind", "modelClass", "enabled"]),
	route: Object.freeze(["kind", "paseoProvider", "model", "thinking", "enabled"]),
	cli: Object.freeze(["kind", "tool", "args", "enabled"]),
});

/** CLI tools every host knows; `cliTools` adds others, it cannot redefine these. */
export const BUILTIN_CLI_TOOLS = Object.freeze({
	pi: Object.freeze({ command: "pi", args: Object.freeze([]) }),
	claude: Object.freeze({ command: "claude", args: Object.freeze([]) }),
});

/** Job ids and cliTools names: one path-safe token, no dots. */
export const JOB_NAME = /^[A-Za-z0-9_-]+$/;

/**
 * Names JOB_NAME lets through that are object internals, not keys. A job
 * called "__proto__" survives JSON.parse as an own key, but any code that
 * copies the map with `out[key] = value` sets a prototype instead — the form's
 * save does exactly that, so the job vanished from the file without a word.
 * Refused at the door, whatever reads the file next.
 */
export const RESERVED_NAMES = Object.freeze(["__proto__", "prototype", "constructor"]);

/** Why `name` cannot be a job id / cliTools name, or null. */
function nameProblem(name) {
	if (RESERVED_NAMES.includes(name)) {
		return `"${name}" is reserved (${RESERVED_NAMES.join(", ")} are JavaScript object internals) — pick another name`;
	}
	if (!JOB_NAME.test(name)) return `name must match ${JOB_NAME} (letters, digits, "_" and "-"; no dots)`;
	return null;
}

const TOP_LEVEL_KEYS = ["$comment", "version", "cliTools", "disabledTools", "jobs"];
const JOB_KEYS = ["label", "description", "disposition", "run", "enabled", "executors"];
const CLI_TOOL_KEYS = ["command", "args"];

export class JobsConfigError extends Error {
	/**
	 * @param {string} message what is wrong, naming the job and executor
	 * @param {Record<string, unknown>} [details] machine-readable context
	 */
	constructor(message, details = {}) {
		super(`CONFIG_INVALID: ${message}`);
		this.name = "JobsConfigError";
		this.code = "CONFIG_INVALID";
		this.details = details;
	}
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isNonEmptyString = (value) => typeof value === "string" && value.trim() !== "";

function unknownKeys(object, allowed) {
	return Object.keys(object).filter((key) => !allowed.includes(key));
}

function checkStringArray(value, where, fail, details) {
	if (value === undefined) return;
	if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
		throw fail(`${where} must be an array of strings`, details);
	}
}

function validateCliTools(cliTools) {
	if (cliTools === undefined) return;
	const fail = (message, details) => new JobsConfigError(message, details);
	if (!isObject(cliTools)) throw fail("cliTools must be an object of name -> { command, args? }");
	for (const [name, tool] of Object.entries(cliTools)) {
		const details = { cliTool: name };
		const badName = nameProblem(name);
		if (badName) throw fail(`cliTools "${name}": ${badName}`, details);
		if (Object.hasOwn(BUILTIN_CLI_TOOLS, name)) {
			throw fail(`cliTools "${name}": "${name}" is a built-in tool and cannot be redefined (built-ins: ${Object.keys(BUILTIN_CLI_TOOLS).join(", ")})`, details);
		}
		if (!isObject(tool)) throw fail(`cliTools "${name}" must be an object { command, args? }`, details);
		const extra = unknownKeys(tool, CLI_TOOL_KEYS);
		if (extra.length > 0) {
			throw fail(`cliTools "${name}": unknown key(s) ${extra.join(", ")} (allowed: ${CLI_TOOL_KEYS.join(", ")})`, details);
		}
		if (!isNonEmptyString(tool.command)) throw fail(`cliTools "${name}": command must be a non-empty string`, details);
		checkStringArray(tool.args, `cliTools "${name}": args`, fail, details);
	}
}

function validateExecutor(executor, jobId, index, toolNames) {
	const where = `job "${jobId}" executor [${index}]`;
	const details = { jobId, executorIndex: index };
	const fail = (message, extra = {}) => new JobsConfigError(`${where}: ${message}`, { ...details, ...extra });
	if (!isObject(executor)) throw fail(`must be an object with a "kind" (${EXECUTOR_KINDS.join(" | ")})`);
	const { kind } = executor;
	if (!EXECUTOR_KINDS.includes(kind)) {
		throw fail(`kind ${JSON.stringify(kind)} is not one of ${EXECUTOR_KINDS.join(", ")}`, { kind });
	}
	const extra = unknownKeys(executor, EXECUTOR_KEYS[kind]);
	if (extra.length > 0) {
		throw fail(`kind "${kind}" does not take ${extra.join(", ")} (allowed: ${EXECUTOR_KEYS[kind].join(", ")})`, { kind });
	}
	if (executor.enabled !== undefined && typeof executor.enabled !== "boolean") {
		throw fail("enabled must be true or false", { kind });
	}
	if (kind === "class") {
		if (!ALL_MODEL_CLASSES.includes(executor.modelClass)) {
			throw fail(`modelClass ${JSON.stringify(executor.modelClass)} is not a MODEL_CLASS (${ALL_MODEL_CLASSES.join(", ")})`, { kind });
		}
		return;
	}
	if (kind === "route") {
		const { paseoProvider, model, thinking } = executor;
		if (!ROLE_PROVIDERS.includes(paseoProvider)) {
			throw fail(`paseoProvider ${JSON.stringify(paseoProvider)} is not one of the durable role profiles (${ROLE_PROVIDERS.join(", ")})`, { kind });
		}
		if (!isNonEmptyString(model)) throw fail("model must be a non-empty string", { kind });
		const family = providerFamily(paseoProvider);
		// The same check create_agent.provider is composed with, so a job whose
		// route validates here can always be described (and seated) as written.
		try {
			composeProviderModel(paseoProvider, model);
		} catch (error) {
			throw fail(String(error?.message ?? error).replace(/^CONFIG_INVALID: /, ""), { kind });
		}
		if (thinking !== undefined) {
			const levels = THINKING_LEVELS_BY_FAMILY[family];
			if (!levels.includes(thinking)) {
				throw fail(`thinking ${JSON.stringify(thinking)} is not a ${family} thinking level (${levels.join(", ")})`, { kind, family });
			}
		}
		return;
	}
	if (!isNonEmptyString(executor.tool)) throw fail("tool must be a non-empty string", { kind });
	if (!toolNames.includes(executor.tool)) {
		throw fail(`tool "${executor.tool}" is neither built in nor declared in cliTools (known: ${toolNames.join(", ")})`, { kind, tool: executor.tool });
	}
	checkStringArray(executor.args, "args", fail, { kind });
}

function validateJob(jobId, job, toolNames) {
	const fail = (message, details = {}) => new JobsConfigError(`job "${jobId}": ${message}`, { jobId, ...details });
	const badName = nameProblem(jobId);
	if (badName) throw new JobsConfigError(`job "${jobId}": id ${badName.replace(/^name /, "")}`, { jobId });
	if (!isObject(job)) throw fail("must be an object");
	const extra = unknownKeys(job, JOB_KEYS);
	if (extra.length > 0) throw fail(`unknown key(s) ${extra.join(", ")} (allowed: ${JOB_KEYS.join(", ")})`);
	for (const key of ["label", "description"]) {
		if (job[key] !== undefined && typeof job[key] !== "string") throw fail(`${key} must be a string`);
	}
	if (job.disposition !== undefined && !JOB_DISPOSITIONS.includes(job.disposition)) {
		throw fail(`disposition ${JSON.stringify(job.disposition)} is not one of ${JOB_DISPOSITIONS.join(", ")}`);
	}
	if (job.enabled !== undefined && typeof job.enabled !== "boolean") throw fail("enabled must be true or false");
	if (job.run !== undefined && !JOB_RUN_MODES.includes(job.run)) {
		throw fail(`run ${JSON.stringify(job.run)} is not one of ${JOB_RUN_MODES.join(", ")}`);
	}
	if (!Array.isArray(job.executors) || job.executors.length === 0) {
		throw fail("executors must be a non-empty array (a job needs at least one executor)");
	}
	job.executors.forEach((executor, index) => validateExecutor(executor, jobId, index, toolNames));
}

/**
 * Validate a parsed jobs document. Returns it unchanged when valid.
 *
 * A missing `jobs` object means "no jobs": the form drops empty objects on
 * save, so deleting the last job must still leave a file that loads.
 *
 * @throws {JobsConfigError} message "CONFIG_INVALID: ..." naming the job and,
 *   where it applies, the executor index (0-based).
 */
export function validateJobsConfig(doc) {
	if (!isObject(doc)) throw new JobsConfigError("jobs config must be a JSON object");
	if (doc.version !== 1) throw new JobsConfigError("jobs config version must be 1", { version: doc.version });
	const extra = unknownKeys(doc, TOP_LEVEL_KEYS);
	if (extra.length > 0) {
		throw new JobsConfigError(`unknown top-level key(s) ${extra.join(", ")} (allowed: ${TOP_LEVEL_KEYS.join(", ")})`);
	}
	validateCliTools(doc.cliTools);
	const toolNames = [...Object.keys(BUILTIN_CLI_TOOLS), ...Object.keys(doc.cliTools ?? {})];
	if (doc.disabledTools !== undefined) {
		if (!Array.isArray(doc.disabledTools) || doc.disabledTools.some((name) => typeof name !== "string")) {
			throw new JobsConfigError("disabledTools must be an array of tool names");
		}
		const unknown = doc.disabledTools.filter((name) => !toolNames.includes(name));
		if (unknown.length > 0) {
			throw new JobsConfigError(`disabledTools names unknown tool(s) ${unknown.join(", ")} (known: ${toolNames.join(", ")})`, { unknown });
		}
	}
	if (doc.jobs !== undefined) {
		if (!isObject(doc.jobs)) throw new JobsConfigError("jobs must be an object of job-id -> job");
		for (const [jobId, job] of Object.entries(doc.jobs)) validateJob(jobId, job, toolNames);
	}
	return doc;
}

/**
 * One executor as a Lead reads it: a class executor carries the options that
 * class has on this host now (or why it has none), a cli executor the command
 * line it stands for. `routeTable` is loadLocalRouteTable()'s answer.
 *
 * `active` is whether it will be used right now, `inactiveReason` why not:
 * the executor's own switch, a disabled tool, a switched-off or missing route.
 */
function describeExecutor(executor, index, routeTable, cliTools, disabledTools, disabledModels) {
	const described = describeExecutorBody(executor, routeTable, cliTools);
	let inactiveReason = null;
	if (executor.enabled === false) inactiveReason = "executor switched off (enabled: false)";
	else if (executor.kind === "cli" && disabledTools.includes(executor.tool)) inactiveReason = `tool "${executor.tool}" is switched off (disabledTools)`;
	else if (executor.kind === "class" && described.route === null) inactiveReason = described.routeProblem;
	else if (executor.kind === "class") {
		// A class can offer several options (a tool running a model each); the executor
		// is active when ANY is usable, and the Lead seats ONE of the usable ones —
		// nothing here chooses.
		const options = described.options.map((option) => {
			const key = modelSwitchKey(option.paseoProvider, option.model);
			let why = null;
			if (!option.enabled) why = `${described.options.length === 1 ? `${executor.modelClass} is switched off in the route file` : `option ${option.index} of ${executor.modelClass} (${key}) is switched off`} (the Human switches it on: pteam routing enable ${executor.modelClass}${described.options.length === 1 ? "" : ` --option ${option.index}`})`;
			else if (isModelDisabled(disabledModels, option.paseoProvider, option.model)) why = `model ${key} is switched off (the Human switches it on: pteam routing enable-model ${key})`;
			return { ...option, usable: why === null, ...(why ? { inactiveReason: why } : {}) };
		});
		described.options = options;
		if (!options.some((option) => option.usable)) {
			inactiveReason = options.length === 1 ? options[0].inactiveReason : `no option of ${executor.modelClass} is usable: ${options.map((option) => option.inactiveReason).join("; ")}`;
		}
	} else if (executor.kind === "route" && isModelDisabled(disabledModels, executor.paseoProvider, executor.model)) {
		inactiveReason = `model ${modelSwitchKey(executor.paseoProvider, executor.model)} is switched off (the Human switches it on: pteam routing enable-model ${modelSwitchKey(executor.paseoProvider, executor.model)})`;
	}
	return { index, enabled: executor.enabled !== false, active: inactiveReason === null, inactiveReason, ...described };
}

function describeExecutorBody(executor, routeTable, cliTools) {
	if (executor.kind === "class") {
		const out = { kind: "class", modelClass: executor.modelClass };
		if (!routeTable?.ok) {
			return { ...out, route: null, routeProblem: `${routeTable?.code ?? "ROUTE_TABLE_UNAVAILABLE"}: ${routeTable?.message ?? "no route table"}` };
		}
		const route = routeTable.routes?.[executor.modelClass];
		if (!route) {
			return { ...out, route: null, routeProblem: `${executor.modelClass} is not configured in ${routeTable.path} (pteam routing set ${executor.modelClass} ...)` };
		}
		const options = routeOptions(route).map((option) => ({
			index: option.index,
			paseoProvider: option.paseoProvider,
			model: option.model,
			thinking: option.thinking,
			enabled: option.enabled,
			createAgentProvider: composeProviderModel(option.paseoProvider, option.model),
		}));
		return {
			...out,
			// `route` is the primary option, kept in its old shape for readers that predate options.
			route: {
				paseoProvider: route.paseoProvider,
				model: route.model,
				thinking: route.thinking,
				...(route.enabled === false ? { enabled: false } : {}),
				createAgentProvider: composeProviderModel(route.paseoProvider, route.model),
			},
			options,
		};
	}
	if (executor.kind === "route") {
		return {
			kind: "route",
			paseoProvider: executor.paseoProvider,
			model: executor.model,
			...(executor.thinking !== undefined ? { thinking: executor.thinking } : {}),
			createAgentProvider: composeProviderModel(executor.paseoProvider, executor.model),
		};
	}
	const builtin = Object.hasOwn(BUILTIN_CLI_TOOLS, executor.tool);
	const tool = builtin ? BUILTIN_CLI_TOOLS[executor.tool] : cliTools[executor.tool];
	const args = [...(tool.args ?? []), ...(executor.args ?? [])];
	return { kind: "cli", tool: executor.tool, builtin, command: tool.command, args };
}

/** The model class a job seating declares by default, by the role of the seat — a flow label, see seatInfo. */
const DEFAULT_SEAT_CLASS = Object.freeze({ peer: "CODING_MEDIUM", supervisor: "SUPERVISOR_GOVERNANCE", lead: "LEAD_RECOVERY" });

/**
 * What seating this executor looks like: the exact create_agent arguments that
 * the route gate accepts for it, or why it cannot be seated.
 *
 * A job seating names its job in labels["team.job"]; the gate then accepts the
 * provider/model/thinking of an ACTIVE executor of that job instead of the one
 * route of a class. The class label is still required — it decides the flow (a
 * Lead seats a Peer from a Peer class, never from a governance class) — and for
 * a class executor it is that class; for a route executor it is a flow label,
 * defaulting by the role of the provider. The thinking level must be spelled
 * out by the executor: the gate compares it byte for byte, and a level left to
 * the Lead would be a level nobody checked.
 */
function seatInfo(executor, jobId) {
	if (executor.kind === "cli") return { ...executor, seat: null, seats: [] };
	if (!executor.active) return { ...executor, seat: null, seats: [] };
	if (executor.kind === "class") {
		// One seat per USABLE option. With several, the Lead seats ONE of them
		// (`pickOne`) — this module never chooses, and a model that is off is simply
		// not in the list.
		const seats = executor.options
			.filter((option) => option.usable)
			.map((option) => ({
				option: option.index,
				paseoProvider: option.paseoProvider,
				model: option.model,
				thinking: option.thinking,
				createAgent: {
					provider: option.createAgentProvider,
					settings: { thinkingOptionId: option.thinking },
					labels: { "team.model-class": executor.modelClass, "team.job": jobId },
				},
			}));
		return { ...executor, seat: seats.length === 1 ? seats[0].createAgent : null, seats, ...(seats.length > 1 ? { pickOne: true } : {}) };
	}
	const thinking = executor.thinking;
	if (thinking === undefined) {
		return {
			...executor,
			seat: null,
			seats: [],
			seatProblem: "this route executor has no thinking level, and the gate compares thinking byte for byte — set one on the executor to make it seatable",
		};
	}
	const createAgent = {
		provider: executor.createAgentProvider ?? composeProviderModel(executor.paseoProvider, executor.model),
		settings: { thinkingOptionId: thinking },
		labels: { "team.model-class": DEFAULT_SEAT_CLASS[providerRole(executor.paseoProvider)], "team.job": jobId },
		note: `"team.model-class" is a flow label here; use another class valid for the seat's role if the task fits it better`,
	};
	return {
		...executor,
		seat: createAgent,
		seats: [{ option: 0, paseoProvider: executor.paseoProvider, model: executor.model, thinking, createAgent }],
	};
}

/**
 * A validated document's jobs, sorted by id, each executor described — ALL of
 * them, with `active` / `inactiveReason`. What a Lead is shown by default is
 * `activeJobs(...)` of this.
 */
export function describeJobs(doc, routeTable) {
	const cliTools = doc.cliTools ?? {};
	const disabledTools = doc.disabledTools ?? [];
	const disabledModels = routeTable?.ok ? (routeTable.disabledModels ?? []) : [];
	return Object.keys(doc.jobs ?? {})
		.sort()
		.map((id) => {
			const job = doc.jobs[id];
			const executors = job.executors.map((executor, index) => seatInfo(describeExecutor(executor, index, routeTable, cliTools, disabledTools, disabledModels), id));
			const enabled = job.enabled !== false;
			const anyActive = executors.some((executor) => executor.active);
			const inactiveReason = !enabled
				? "job switched off (enabled: false)"
				: anyActive
					? null
					: `no executor of this job is active — ${executors.map((executor) => `[${executor.index}] ${executor.inactiveReason}`).join("; ")}`;
			return {
				id,
				...(job.label !== undefined ? { label: job.label } : {}),
				...(job.description !== undefined ? { description: job.description } : {}),
				...(job.disposition !== undefined ? { disposition: job.disposition } : {}),
				run: job.run ?? DEFAULT_RUN_MODE,
				enabled,
				active: enabled && anyActive,
				inactiveReason,
				executors,
			};
		});
}

/**
 * What a Lead may use right now: jobs that are on and have at least one active
 * executor, trimmed to those executors (original `index` kept, so a sequential
 * order stays readable). Everything else is named in `inactive` with its reason
 * — a skipped step is reported, never silently replaced by another.
 */
export function activeJobs(jobs) {
	const usable = [];
	const inactive = [];
	for (const job of jobs) {
		if (!job.active) {
			inactive.push({ id: job.id, reason: job.inactiveReason });
			continue;
		}
		const skipped = job.executors.filter((executor) => !executor.active).map(({ index, inactiveReason }) => ({ index, reason: inactiveReason }));
		usable.push({ ...job, executors: job.executors.filter((executor) => executor.active), skipped });
	}
	return { jobs: usable, inactive };
}
