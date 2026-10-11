/**
 * jobs.mjs — named work presets: what a job is run WITH.
 *
 * A job lists one or more executors — a model class (whatever route that class
 * has on this host right now), an explicit route, or a CLI tool — so a Lead
 * can read "review = REVIEW_HIGH + claude" instead of re-deciding it per task.
 * It is a preset only: nothing here seats an agent, and the create_agent gate
 * still checks every seating against the route file, never against this one.
 *
 * Every executor of a job is used. `run: "sequential"` means in the listed
 * order; it is NOT "try the next one when the previous failed" — this pack
 * never falls back to another model or host on its own (model-routing.mjs).
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
	providerFamily,
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
	class: Object.freeze(["kind", "modelClass"]),
	route: Object.freeze(["kind", "paseoProvider", "model", "thinking"]),
	cli: Object.freeze(["kind", "tool", "args"]),
});

/** CLI tools every host knows; `cliTools` adds others, it cannot redefine these. */
export const BUILTIN_CLI_TOOLS = Object.freeze({
	pi: Object.freeze({ command: "pi", args: Object.freeze([]) }),
	claude: Object.freeze({ command: "claude", args: Object.freeze([]) }),
});

/** Job ids and cliTools names: one path-safe token, no dots. */
export const JOB_NAME = /^[A-Za-z0-9_-]+$/;

const TOP_LEVEL_KEYS = ["$comment", "version", "cliTools", "jobs"];
const JOB_KEYS = ["label", "description", "disposition", "run", "executors"];
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
		if (!JOB_NAME.test(name)) {
			throw fail(`cliTools "${name}": name must match ${JOB_NAME} (letters, digits, "_" and "-"; no dots)`, details);
		}
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
	if (!JOB_NAME.test(jobId)) {
		throw new JobsConfigError(`job "${jobId}": id must match ${JOB_NAME} (letters, digits, "_" and "-"; no dots)`, { jobId });
	}
	if (!isObject(job)) throw fail("must be an object");
	const extra = unknownKeys(job, JOB_KEYS);
	if (extra.length > 0) throw fail(`unknown key(s) ${extra.join(", ")} (allowed: ${JOB_KEYS.join(", ")})`);
	for (const key of ["label", "description"]) {
		if (job[key] !== undefined && typeof job[key] !== "string") throw fail(`${key} must be a string`);
	}
	if (job.disposition !== undefined && !JOB_DISPOSITIONS.includes(job.disposition)) {
		throw fail(`disposition ${JSON.stringify(job.disposition)} is not one of ${JOB_DISPOSITIONS.join(", ")}`);
	}
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
	if (doc.jobs !== undefined) {
		if (!isObject(doc.jobs)) throw new JobsConfigError("jobs must be an object of job-id -> job");
		for (const [jobId, job] of Object.entries(doc.jobs)) validateJob(jobId, job, toolNames);
	}
	return doc;
}

/**
 * One executor as a Lead reads it: a class executor carries the route that
 * class has on this host now (or why it has none), a cli executor the command
 * line it stands for. `routeTable` is loadLocalRouteTable()'s answer.
 */
function describeExecutor(executor, routeTable, cliTools) {
	if (executor.kind === "class") {
		const out = { kind: "class", modelClass: executor.modelClass };
		if (!routeTable?.ok) {
			return { ...out, route: null, routeProblem: `${routeTable?.code ?? "ROUTE_TABLE_UNAVAILABLE"}: ${routeTable?.message ?? "no route table"}` };
		}
		const route = routeTable.routes?.[executor.modelClass];
		if (!route) {
			return { ...out, route: null, routeProblem: `${executor.modelClass} is not configured in ${routeTable.path} (pteam routing set ${executor.modelClass} ...)` };
		}
		return {
			...out,
			route: {
				paseoProvider: route.paseoProvider,
				model: route.model,
				thinking: route.thinking,
				createAgentProvider: composeProviderModel(route.paseoProvider, route.model),
			},
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

/** A validated document's jobs, sorted by id, each executor described. */
export function describeJobs(doc, routeTable) {
	const cliTools = doc.cliTools ?? {};
	return Object.keys(doc.jobs ?? {})
		.sort()
		.map((id) => {
			const job = doc.jobs[id];
			return {
				id,
				...(job.label !== undefined ? { label: job.label } : {}),
				...(job.description !== undefined ? { description: job.description } : {}),
				...(job.disposition !== undefined ? { disposition: job.disposition } : {}),
				run: job.run ?? DEFAULT_RUN_MODE,
				executors: job.executors.map((executor) => describeExecutor(executor, routeTable, cliTools)),
			};
		});
}
