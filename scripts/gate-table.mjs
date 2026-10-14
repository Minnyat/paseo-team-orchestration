/**
 * gate-table.mjs — the route table the create_agent gate reads, WITH the jobs.
 *
 * model-routing.mjs owns the route files and `gateRouteTable`; jobs.mjs owns the
 * jobs file and imports from model-routing.mjs. The gate needs both at once, and
 * neither can import the other's entry (a module cannot lazily import one that
 * is still evaluating it), so this small module sits above them. The Pi adapter
 * runs it as a subprocess (`node gate-table.mjs`, JSON on stdout, always exit 0:
 * a load failure is DATA the gate refuses on); the Claude hook imports
 * `gateTable` in-process. One function, so the two runtimes cannot read
 * different tables.
 */

import { existsSync, readFileSync } from "node:fs";
import { gateRouteTable, isMainModule } from "./model-routing.mjs";
import { defaultJobsPath, describeJobs, validateJobsConfig } from "./jobs.mjs";

/**
 * For every job: whether it can be seated from right now, and the (provider,
 * model, thinking) of each executor that can. This is all the gate needs of a
 * job, computed once per call from the same two files `pteam jobs` reads — so
 * what a Lead is shown and what the gate accepts cannot differ.
 */
export function gateJobSeats(doc, routeTable) {
	const out = {};
	for (const job of describeJobs(doc, routeTable)) {
		out[job.id] = {
			active: job.active,
			reason: job.inactiveReason,
			seats: job.active
				? job.executors.flatMap((executor) =>
						(executor.seats ?? []).map((seat) => ({
							index: executor.index,
							option: seat.option,
							paseoProvider: seat.paseoProvider,
							model: seat.model,
							thinking: seat.thinking,
							source: executor.kind,
						})),
					)
				: [],
		};
	}
	return out;
}

/**
 * The route table the create_agent gate reads, plus `jobs` (see gateJobSeats).
 * A jobs file that is missing is just no jobs; one that cannot be read is
 * `jobsProblem` — it refuses only the seatings that name a job, never the
 * ordinary class-route ones.
 */
export function gateTable(options = {}) {
	const table = gateRouteTable(options);
	if (!table.ok) return table;
	const env = options.env ?? process.env;
	const path = defaultJobsPath(env);
	if (!existsSync(path)) return { ...table, jobs: {} };
	try {
		const doc = JSON.parse(readFileSync(path, "utf8"));
		validateJobsConfig(doc);
		return { ...table, jobs: gateJobSeats(doc, table) };
	} catch (error) {
		return { ...table, jobsProblem: `${path}: ${String(error?.message ?? error).replace(/^CONFIG_INVALID: /, "")}` };
	}
}

if (isMainModule(process.argv[1], import.meta.url)) {
	process.stdout.write(`${JSON.stringify(gateTable())}\n`);
}
