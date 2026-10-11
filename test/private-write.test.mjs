import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "../scripts/lib-common.mjs";
import { atomicWrite } from "../cli/lib/config-walker.mjs";
import { writeJsonAtomic } from "../scripts/claude-setup.mjs";

// Config files this pack rewrites carry provider env blocks and MCP tokens and
// are often 0600. A write through a temp sibling + rename makes a NEW inode, so
// it used to get the process umask: 0600 came back 0644, readable by every
// other account on the host. POSIX modes only; Windows has none.
if (process.platform === "win32") {
	console.log("private-write tests skipped (no POSIX modes on Windows)");
} else {
	const modeOf = (path) => (statSync(path).mode & 0o777).toString(8);
	const leftovers = (dir) => readdirSync(dir).filter((name) => name.includes(".tmp"));
	const sandbox = mkdtempSync(join(tmpdir(), "pst-private-"));
	const realUmask = process.umask(0o022); // the common default that caused the regression
	try {
		// --- the shared helper ------------------------------------------------
		{
			const dir = join(sandbox, "helper");
			mkdirSync(dir);

			const secret = join(dir, "claude.json");
			writeFileSync(secret, "{}\n");
			chmodSync(secret, 0o600);
			writeFileAtomic(secret, '{"token":"x"}\n');
			assert.equal(modeOf(secret), "600", "a rewrite must not widen a 0600 file to the umask default");
			assert.equal(readFileSync(secret, "utf8"), '{"token":"x"}\n');

			// An owner's choice is kept in both directions: neither widened nor tightened.
			for (const mode of [0o640, 0o644, 0o400]) {
				const file = join(dir, `mode-${mode.toString(8)}`);
				writeFileSync(file, "old\n");
				chmodSync(file, mode);
				writeFileAtomic(file, "new\n");
				assert.equal(modeOf(file), mode.toString(8), `an existing ${mode.toString(8)} file keeps its mode`);
			}

			// The exact bits are restored, not just "whatever survives the umask": a
			// 0664 or 0775 file under umask 022, and a 0644 file under a hardened 077.
			for (const [mode, umask] of [[0o664, 0o022], [0o775, 0o022], [0o644, 0o077]]) {
				const file = join(dir, `exact-${mode.toString(8)}-${umask.toString(8)}`);
				writeFileSync(file, "old\n");
				chmodSync(file, mode);
				process.umask(umask);
				try {
					writeFileAtomic(file, "new\n");
				} finally {
					process.umask(0o022);
				}
				assert.equal(modeOf(file), mode.toString(8), `${mode.toString(8)} survives umask ${umask.toString(8)} unchanged`);
			}

			// A brand-new file starts private, whatever the umask.
			const fresh = join(dir, "fresh.json");
			writeFileAtomic(fresh, "{}\n");
			assert.equal(modeOf(fresh), "600");
			process.umask(0);
			const freshOpenUmask = join(dir, "fresh-open-umask.json");
			writeFileAtomic(freshOpenUmask, "{}\n");
			process.umask(0o022);
			assert.equal(modeOf(freshOpenUmask), "600", "umask 0 must not make a new credential file world-readable");

			assert.deepEqual(leftovers(dir), [], "no temp file is left behind");
		}

		// --- a planted file or symlink at the temp name is refused, not followed --
		{
			const dir = join(sandbox, "planted");
			mkdirSync(dir);
			const victim = join(dir, "victim");
			writeFileSync(victim, "keep\n");
			const target = join(dir, "config.json");
			const realNow = Date.now;
			Date.now = () => 1_700_000_000_000; // the temp name embeds pid and time; pin it so it can be pre-planted
			try {
				symlinkSync(victim, `${target}.tmp-${process.pid}-1700000000000`);
				assert.throws(() => writeFileAtomic(target, "attacker-controlled\n"), (error) => error.code === "EEXIST");
				assert.equal(readFileSync(victim, "utf8"), "keep\n", "the file behind the planted symlink is untouched");
				writeFileAtomic(target, "{}\n"); // the refusal cleaned up after itself: a retry works
				assert.equal(readFileSync(target, "utf8"), "{}\n");
			} finally {
				Date.now = realNow;
			}
		}

		// --- a failed swap cleans up its temp file ----------------------------
		{
			const dir = join(sandbox, "failure");
			mkdirSync(dir);
			const target = join(dir, "target");
			mkdirSync(target); // renaming a file over a directory fails
			assert.throws(() => writeFileAtomic(target, "x\n"));
			assert.deepEqual(leftovers(dir), [], "the temp sibling is removed when the rename fails");
		}

		// --- config-walker.atomicWrite (config write, WebUI saves, uninstall) --
		{
			const root = join(sandbox, "walker");
			const target = join(root, "newdir", "mcp.json");
			atomicWrite(target, "{}\n");
			assert.equal(modeOf(target), "600", "a new config file is private");
			assert.equal(modeOf(join(root, "newdir")), "700", "a directory created for it is private");

			chmodSync(target, 0o600);
			atomicWrite(target, '{"env":{"KEY":"secret"}}\n');
			assert.equal(modeOf(target), "600", "rewriting keeps 0600");
			const backups = readdirSync(join(root, "newdir")).filter((name) => name.includes(".bak-"));
			assert.equal(backups.length, 1);
			assert.equal(modeOf(join(root, "newdir", backups[0])), "600", "the backup of a private file is private too");

			// A directory the owner already had is not touched.
			const shared = join(root, "shared");
			mkdirSync(shared, { mode: 0o755 });
			chmodSync(shared, 0o755);
			atomicWrite(join(shared, "x.json"), "{}\n");
			assert.equal(modeOf(shared), "755", "an existing directory keeps its mode");
		}

		// --- claude-setup.writeJsonAtomic (install, apply, uninstall, ledger) --
		{
			const root = join(sandbox, "setup");
			const settings = join(root, ".claude", "settings.json");
			writeJsonAtomic(settings, { env: {} });
			assert.equal(modeOf(settings), "600", "a new settings file is private");
			assert.equal(modeOf(join(root, ".claude")), "700");

			const claudeJson = join(root, ".claude.json");
			writeFileSync(claudeJson, "{}\n");
			chmodSync(claudeJson, 0o600);
			writeJsonAtomic(claudeJson, { mcpServers: { s: { env: { TOKEN: "secret" } } } });
			assert.equal(modeOf(claudeJson), "600", "install/apply must not widen ~/.claude.json");
			assert.deepEqual(JSON.parse(readFileSync(claudeJson, "utf8")).mcpServers.s.env, { TOKEN: "secret" });
			assert.deepEqual(leftovers(root), [], "no temp file is left behind");
		}
	} finally {
		process.umask(realUmask);
		rmSync(sandbox, { recursive: true, force: true });
	}
	console.log("private-write tests passed");
}
