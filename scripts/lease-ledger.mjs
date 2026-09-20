/**
 * lease-ledger.mjs — the append-only board the scope lease is arbitrated from.
 *
 * The lease used to be written into a Paseo chat room. Paseo removed chat rooms
 * in 0.4.0 (upstream PR #3053 retired them "instead of migrating" them ahead of
 * a storage change), so the one invariant that cannot lapse — one writer per
 * moving scope — can no longer rent its storage from the daemon. This file is
 * that storage, and deliberately nothing more.
 *
 * What did NOT move is the part that decides anything. Arbitration still runs
 * in policy-core's pure `resolveLeases()`, over rows of exactly
 * `{ author, createdAt, body }`. Keeping the decision pure and the storage dumb
 * is what let the daemon be swapped out underneath without re-testing a single
 * rule.
 *
 * Format is JSON Lines, one record per line, appended and never rewritten.
 * That is not a stylistic choice:
 *
 *   - `O_APPEND` makes a short line land whole even when several Leads on the
 *     same host write at the same instant, so no record is lost to a
 *     read-modify-write race. A JSON array would have to be re-serialised on
 *     every claim, and the last writer would silently erase the others.
 *   - File order is append order, which is the only total order available once
 *     the daemon's server-side timestamp is gone. Two claims inside the same
 *     millisecond sort equal by time; the tie is broken by who reached the file
 *     first, and that is the honest answer to "who won".
 *
 * The safety rule that governs every branch below: an answer this store is not
 * sure of must never come back looking empty. "Nobody holds this scope" and "I
 * could not read the board" send the guard in opposite directions, so anything
 * unparseable or unreadable throws instead of returning zero rows.
 */

import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { teamConfigDir } from "./lib-common.mjs";

/** Where the board lives when nothing overrides it. */
export const LEDGER_FILE_NAME = "lease-ledger.jsonl";

/**
 * How long a lock may be held before the next caller treats it as abandoned.
 *
 * A lock file outlives the process that made it, so a Lead killed mid-claim
 * would otherwise wedge the board for every other Lead until someone noticed
 * and deleted a file by hand. Ten seconds is far longer than a read-decide-
 * append takes and far shorter than a working session, so breaking it can only
 * happen to a writer that is already gone.
 */
export const DEFAULT_STALE_LOCK_MS = 10_000;
/** How long to wait for a live holder before giving up rather than writing anyway. */
export const DEFAULT_LOCK_TIMEOUT_MS = 5_000;

function bad(code, message) {
	return Object.assign(new Error(message), { code });
}

/**
 * Resolve the board's path.
 *
 * The env override is not a test affordance bolted on afterwards: two checkouts
 * on one host are two different trees, and a shared board would have one
 * project's `src` lock out the other's. Pointing each at its own file is the
 * cheap way to say "these are separate worlds" — the same thing the CLUSTER
 * field says inside a single board.
 */
export function defaultLedgerPath() {
	const override = process.env.PASEO_TEAM_LEASE_LEDGER?.trim();
	if (override) return override;
	// Delegated, not re-derived. This used to name the config directory by
	// literal, so a host that set PST_TEAM_CONFIG_DIR moved every pack file
	// EXCEPT the lease board — and the board is the one file whose whole job is
	// to be the single place two writers meet. Two boards is no board.
	return join(teamConfigDir(), LEDGER_FILE_NAME);
}

/**
 * Parse one stored line into the row shape arbitration consumes.
 *
 * A line that does not parse is a hard failure rather than a skipped row. The
 * tempting alternative — ignore the damaged line, keep the rest — reports a
 * scope as free whenever the damaged line happened to be the live claim on it,
 * which is precisely the two-writer outcome the lease exists to stop. Refusing
 * to answer costs a retry; answering wrongly costs a tangled working tree.
 */
function parseLine(line, lineNumber, path) {
	let record;
	try {
		record = JSON.parse(line);
	} catch {
		throw bad(
			"LEASE_LEDGER_CORRUPT",
			`line ${lineNumber} of ${path} is not valid JSON, so the board cannot be treated as complete`,
		);
	}
	const ok =
		record &&
		typeof record.author === "string" &&
		typeof record.createdAt === "string" &&
		typeof record.body === "string" &&
		Number.isFinite(Date.parse(record.createdAt));
	if (!ok) {
		throw bad(
			"LEASE_LEDGER_CORRUPT",
			`line ${lineNumber} of ${path} is missing author/createdAt/body, so the board cannot be treated as complete`,
		);
	}
	return { id: typeof record.id === "string" ? record.id : `line-${lineNumber}`, author: record.author, createdAt: record.createdAt, body: record.body };
}

/**
 * Open the board at `path` (default: {@link defaultLedgerPath}).
 *
 * Returned as an object rather than free functions so a caller — a test, or a
 * second cluster — can hold two boards at once without either of them reaching
 * for process state.
 */
export function createLedger({
	path = defaultLedgerPath(),
	staleLockMs = DEFAULT_STALE_LOCK_MS,
	lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
} = {}) {
	const lockPath = `${path}.lock`;
	const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

	/**
	 * Take the board's lock, or fail rather than proceed without it.
	 *
	 * `wx` is the whole mechanism: an exclusive create is one syscall that both
	 * tests and takes, so two writers racing cannot both believe they won. The
	 * loser waits and retries; a lock old enough to be provably abandoned is
	 * broken instead of waited on.
	 */
	async function acquire() {
		const deadline = Date.now() + lockTimeoutMs;
		for (;;) {
			try {
				mkdirSync(dirname(lockPath), { recursive: true });
				const fd = openSync(lockPath, "wx");
				try {
					writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`);
				} finally {
					closeSync(fd);
				}
				return;
			} catch (error) {
				if (error?.code !== "EEXIST") {
					throw bad("LEASE_LEDGER_LOCK_FAILED", `could not lock ${path}: ${String(error?.message ?? error)}`);
				}
				let age = 0;
				try {
					age = Date.now() - statSync(lockPath).mtimeMs;
				} catch {
					// It vanished between the failed create and the stat: the holder
					// released it, so the next attempt is the one that wins.
					continue;
				}
				if (age >= staleLockMs) {
					// Break it, then loop. Unlink can lose its own race with the real
					// holder releasing; either way the next `wx` decides the winner.
					try {
						unlinkSync(lockPath);
					} catch {
						/* someone else broke it first */
					}
					continue;
				}
				if (Date.now() >= deadline) {
					throw bad(
						"LEASE_LEDGER_LOCK_TIMEOUT",
						`another writer has held ${lockPath} for ${age}ms — refusing to write to a board we could not lock`,
					);
				}
				await sleep(15);
			}
		}
	}

	function release() {
		try {
			unlinkSync(lockPath);
		} catch {
			/* already gone */
		}
	}
	/**
	 * Append one record and hand back exactly what was written.
	 *
	 * `now` is injected rather than read here so the caller's clock is the only
	 * clock in play: the guard compares a record's age against its own `now`,
	 * and a store that stamped records from a different source could make a live
	 * lease look expired.
	 */
	async function append({ author, body, now = Date.now() }) {
		if (typeof author !== "string" || author.length === 0) {
			throw bad("LEDGER_AUTHOR_INVALID", "a ledger record must carry the agent id that wrote it");
		}
		if (typeof body !== "string" || body.length === 0) {
			throw bad("LEDGER_BODY_INVALID", "a ledger record must carry a body");
		}
		const record = { id: randomUUID(), author, createdAt: new Date(now).toISOString(), body };
		try {
			mkdirSync(dirname(path), { recursive: true });
			// One write, one line, `a` for O_APPEND. Concurrent writers rely on
			// the kernel placing a short append whole at the end of the file;
			// that is why the record is serialised before the call and why
			// nothing here ever re-reads and rewrites the file.
			appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
		} catch (error) {
			throw bad("LEASE_LEDGER_UNWRITABLE", `could not append to ${path}: ${String(error?.message ?? error)}`);
		}
		return record;
	}

	/**
	 * Read the board back over a window, newest records kept.
	 *
	 * `limit` trims from the FRONT, not the back. The caller treats a full
	 * result as "this board may be incomplete" and refuses to act on it, and
	 * that check is only sound if what survived the trim is the recent end:
	 * dropping the newest records would hide the very claim about to be
	 * collided with, and would do it while reporting success.
	 */
	async function read({ since, limit = Number.POSITIVE_INFINITY } = {}) {
		let text;
		try {
			text = readFileSync(path, "utf8");
		} catch (error) {
			// A board that was never written is genuinely empty — the first claim
			// on a fresh machine has nothing to collide with. Every other failure
			// is a board we could not see, which is not the same thing.
			if (error?.code === "ENOENT") return { path, messages: [], count: 0 };
			throw bad("LEASE_LEDGER_UNREADABLE", `could not read ${path}: ${String(error?.message ?? error)}`);
		}

		const rows = [];
		const lines = text.split("\n");
		for (let index = 0; index < lines.length; index += 1) {
			const line = lines[index].trim();
			if (line === "") continue;
			rows.push(parseLine(line, index + 1, path));
		}

		const floor = since === undefined ? Number.NEGATIVE_INFINITY : Date.parse(since);
		if (!Number.isFinite(floor)) {
			throw bad("LEDGER_SINCE_INVALID", `since must be an ISO timestamp (got ${JSON.stringify(since)})`);
		}
		// File order is preserved on purpose — see the header. Filtering keeps it;
		// sorting here would destroy the only tie-break the board has.
		const windowed = rows.filter((row) => Date.parse(row.createdAt) >= floor);
		const messages = windowed.length > limit ? windowed.slice(windowed.length - limit) : windowed;
		return { path, messages, count: messages.length };
	}

	/**
	 * Run `fn` with the board locked, so a read and the append that depends on it
	 * cannot have another writer slip between them.
	 *
	 * This is what the chat room could not offer. There, every CLAIM succeeded —
	 * including the losing one — because a post could not be made conditional on
	 * what the board said a microsecond earlier; arbitration on read was the only
	 * honest answer available. Owning the file changes that: a claim can now
	 * decide and write as one step, so a scope that is already held is refused
	 * instead of contested.
	 *
	 * Read-side arbitration stays exactly where it was. It is the backstop for
	 * everything this lock cannot cover — a record written by an older build, a
	 * lease that expired since, a board reached over a filesystem where locking
	 * is advisory at best.
	 */
	async function transaction(fn) {
		await acquire();
		try {
			return await fn({ read, append, path });
		} finally {
			release();
		}
	}

	return { path, append, read, transaction };
}
